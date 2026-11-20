// Browser Bridge worker: commands/read.js.
// Keep the module boundaries in docs/SPEC.md in sync.
import { requirePage } from './tabs.js'
import { evalUnavailable, evaluate, evaluateInContext, evaluateProgram, frameContext, frameList, guardedContext, pageMeta, resolveFrameArg, send } from '../lib/cdp.js'
import { resolveRedirectHref, snapshotPage } from '../lib/page.js'
import { documentHint, navOutcome, pageState, rememberNav } from '../lib/page-state.js'
import { shared } from '../lib/state.js'
import { documentIsFailed, documentIsHealthy, fail, isInternalUrl, recentDialog, stateSummary } from '../lib/util.js'

/** Register a script that runs before any page script in every new document. */
export async function evalInstall({ expression, tabId: hint }) {
  const tabId = await requirePage(hint)
  const source = String(expression ?? '')
  if (!source.trim()) throw fail('BAD_ARGUMENT', 'installOnNewDocument needs an expression')
  const added = await send(tabId, 'Page.addScriptToEvaluateOnNewDocument', { source })
  const identifier = added?.identifier
  if (!identifier) throw fail('CDP_ERROR', 'the script was not registered')
  if (!shared.injectedScripts.has(tabId)) shared.injectedScripts.set(tabId, new Map())
  shared.injectedScripts.get(tabId).set(identifier, source)
  const meta = await pageMeta(tabId)
  return {
    url: meta?.url ?? '',
    title: meta?.title ?? '',
    installed: true,
    scriptId: identifier,
    bytes: source.length,
    note: 'runs before any page script in every new document of this tab, across reloads, until removed or the debugger detaches',
  }
}

export async function evalRemove({ id, tabId: hint }) {
  const tabId = await requirePage(hint)
  const identifier = String(id ?? '')
  if (!identifier) throw fail('BAD_ARGUMENT', 'removeOnNewDocument needs the scriptId returned by the install call')
  const stored = shared.injectedScripts.get(tabId)
  let removed = false
  try {
    await send(tabId, 'Page.removeScriptToEvaluateOnNewDocument', { identifier })
    removed = true
  } catch {
    removed = false
  }
  const known = stored ? stored.delete(identifier) : false
  const meta = await pageMeta(tabId)
  return { url: meta?.url ?? '', title: meta?.title ?? '', removed: removed || known, scriptId: identifier }
}

export async function evalList({ tabId: hint }) {
  const tabId = await requirePage(hint)
  const stored = shared.injectedScripts.get(tabId)
  const scripts = stored ? [...stored].map(([id, source]) => ({ id, bytes: source.length })) : []
  const meta = await pageMeta(tabId)
  return { url: meta?.url ?? '', title: meta?.title ?? '', count: scripts.length, scripts }
}

export async function readPage({ maxChars, maxElements, probe, frame, normalize, tabId: hint }) {
  const tabId = await requirePage(hint)
  let frameHit
  let contextId
  if (frame !== undefined && frame !== null && String(frame).trim() !== '') {
    try {
      const resolved = await frameContext(tabId, frame)
      frameHit = resolved.frame
      contextId = resolved.contextId
    } catch (error) {
      // Page.getFrameTree omits out-of-process frames, so a real cross-origin
      // frame looks exactly like a typo. Ask the DOM what the frame is: if an
      // iframe with that id, name or src exists, it is a readable-looking frame
      // the tab target cannot reach, not a missing one.
      const probe = await evaluate(tabId, `(() => {
        const want = ${JSON.stringify(String(frame))};
        const list = Array.from(document.querySelectorAll('iframe, frame'));
        const hit = list.find((el) => el.id === want || el.name === want || (el.src && el.src.includes(want)));
        return hit ? { url: hit.src || '', name: hit.id || hit.name || '' } : null;
      })()`).catch(() => null)
      if (probe) {
        throw fail(
          'FRAME_NOT_READABLE',
          `frame ${JSON.stringify(String(frame))}${probe.url ? ' (' + probe.url + ')' : ' (no url, a srcdoc or scripted frame)'} is cross-origin or out-of-process, so the tab target cannot read it: `
          + (probe.url ? `open ${probe.url} at its own URL, ` : '')
          + 'or read the frame element with bsb_eval. It was not silently replaced by the parent page.',
        )
      }
      const visible = await frameList(tabId)
        .then((frames) => frames.map((entry) => entry.url || entry.frameId).filter(Boolean))
        .catch(() => [])
      throw fail(
        'FRAME_NOT_FOUND',
        `no frame matches ${JSON.stringify(String(frame))}; frames this tab can read: ${visible.join(', ') || '(none)'}`,
      )
    }
  }
  const readIn = (source) => (contextId === undefined
    ? evaluate(tabId, source)
    : evaluateInContext(tabId, contextId, source))
  const value = await readIn(`(${snapshotPage.toString()})(${Number(maxChars) || 6000}, ${Number(maxElements) || 60}, ${normalize === true})`)
  if (!value || typeof value !== 'object') throw fail('CDP_ERROR', 'the page could not be read')
  const wanted = (Array.isArray(probe) ? probe : [])
    .filter((selector) => typeof selector === 'string' && selector.length > 0 && selector.length <= 400)
    .slice(0, 20)
  if (wanted.length > 0) {
    value.probes = await readIn(`(() => {
      const out = [];
      for (const selector of ${JSON.stringify(wanted)}) {
        const el = document.querySelector(selector);
        if (!el) { out.push({ selector, found: false }); continue; }
        const rect = el.getBoundingClientRect();
        out.push({
          selector,
          found: true,
          role: (el.tagName || '').toLowerCase(),
          box: {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            width: rect.width,
            height: rect.height,
          },
        });
      }
      return out;
    })()`)
  }
  shared.refs.set(tabId, new Map(value.elements.map((element) => [element.ref, element.selector])))
  // A read that returns empty text is not the same as a page with nothing to
  // say: the document may be an error page, a bot-check interstitial or a
  // splash skeleton. The state block and its hint are what separate them.
  // A frame read must describe the frame, not the parent document: the state
  // line is what tells the caller how big the document is and whether it has a
  // canvas. Probe the same context the snapshot came from.
  const state = await pageState(tabId, contextId).catch(() => null)
  if (state) {
    value.state = stateSummary(state)
    let outcome = navOutcome(tabId)
    // The cached outcome describes the last navigation this worker drove, not
    // the document that is in the tab now. A later navigation in the same tab
    // (or a manual reload) can commit a healthy page; the old error must be
    // cleared, never merged forward into this read (BSB-20261115-2112).
    if (outcome?.navigationError && documentIsHealthy(state, outcome.requestedUrl)) {
      rememberNav(tabId, { ...outcome, navigationError: '' })
      outcome = navOutcome(tabId)
    }
    // A cached navigation error may only be passed on when the CURRENT document
    // is actually a failed one; otherwise the hint would contradict the state
    // line in the same reply.
    const currentFailed = documentIsFailed(state)
    const hint = documentHint(state, {
      requestedUrl: outcome?.requestedUrl,
      navigationError: currentFailed ? outcome?.navigationError : undefined,
    })
    if (hint) value.hint = hint
  }
  const dialog = recentDialog(tabId)
  // Keep the record for its 15 s window: a read must not consume the only copy,
  // or the next Enter looks like it reached a live dialog (BSB-20261118-2345).
  if (dialog) value.dialog = dialog
  if (frameHit) {
    value.frameId = frameHit.frameId
    if (frameHit.url) value.frameUrl = frameHit.url
  }
  return value
}

/**
 * List child frames. Most real pages put their interesting UI in an iframe;
 * bsb_eval with `frame` can read and drive it, while pointer tools stay on the
 * top document (they would need parent-space coordinates).
 */
export async function framesPage() {
  const tabId = await requirePage()
  const frames = await frameList(tabId)
  const meta = await pageMeta(tabId)
  return { url: meta?.url ?? '', title: meta?.title ?? '', frames: frames.filter((f) => f.parentId !== null) }
}

export async function evalPage({ expression, awaitPromise, frame, world, tabId: hint }) {
  // The tab hint is what makes multi-tab work possible: without it every eval
  // lands on the tracked tab, so a second tab can never be read while the first
  // one is being driven.
  if (typeof hint === 'number') {
    // An explicit tabId must never fall back to the tracked tab: a reply that
    // cannot say which tab answered is indistinguishable from the wrong target
    // answering (BSB-20261115-2215).
    const target = await chrome.tabs.get(hint).catch(() => undefined)
    if (!target) {
      throw fail('TAB_NOT_EVALUABLE', 'TAB_NOT_EVALUABLE: tab ' + hint + ' is not open, so the expression cannot run there. Run bsb_tabs {action:"list"}, then bsb_tabs {action:"use", tabId:<id>} to target an open tab, or bsb_open to load the URL in a new one.')
    }
    if (isInternalUrl(target.url)) {
      throw fail('TAB_NOT_EVALUABLE', 'TAB_NOT_EVALUABLE: tab ' + hint + ' is ' + String(target.url ?? '') + ', a browser-internal page bsb cannot script. Run bsb_tabs {action:"list"}, then bsb_tabs {action:"use", tabId:<id>} for a scriptable tab, or bsb_open the http(s) URL with newTab:true.')
    }
  }
  const tabId = await requirePage(hint)
  if (typeof expression !== 'string' || expression.trim().length === 0) throw fail('BAD_ARGUMENT', 'expression is required')
  // world:'main' evaluates in the page's own world (Runtime.evaluate with no
  // contextId). It is opt-in per call: the default stays the guarded isolated
  // world, but the caller may ask for the real one when it needs page state
  // (framework instances, closures) that the isolated world cannot see.
  const useMain = String(world || 'isolated') === 'main'
  if (frame && useMain) {
    // Runtime.evaluate without a contextId only ever lands in the TOP frame's
    // main world. Running a frame-targeted expression there while echoing the
    // frame id would answer for the wrong document, so refuse by name.
    throw fail('UNSUPPORTED', 'frame + world:"main" is not supported: the main world is only addressable for the top frame. Read the frame with the default isolated world, or bsb_open the frame URL directly.')
  }
  // Name the target before evaluating: tab id, document URL and the visibility
  // the page reports. A reply that carries none of these cannot be attributed
  // to a tab when several are open.
  const probe = await evaluate(tabId, '({ url: location.href, visibility: document.visibilityState })').catch(() => null)
  if (!probe) throw await evalUnavailable(tabId, 'the tab did not answer a read-only probe')
  const extra = {
    tabId,
    url: String(probe.url ?? ''),
    world: useMain ? 'main' : 'isolated',
    visibility: String(probe.visibility ?? 'unknown'),
  }
  let contextId
  let value
  try {
    if (frame) {
      const hit = resolveFrameArg(await frameList(tabId), frame)
      if (!hit) throw fail('FRAME_NOT_FOUND', `no frame matches ${JSON.stringify(String(frame))}`)
      contextId = await guardedContext(tabId, hit.frameId)
      extra.frameId = hit.frameId
      if (hit.url) extra.url = hit.url
    } else if (!useMain) {
      contextId = await guardedContext(tabId)
    }
    value = await evaluateProgram(tabId, expression, { contextId, awaitPromise: awaitPromise === true })
  } catch (error) {
    const code = String(error?.code ?? '')
    // A page error, a Promise result, a read-only violation and a typed target
    // failure are the caller's own findings and keep their code and message.
    // Only an untyped/CDP transport failure is retyped as "this tab could not
    // be evaluated".
    if (code !== '' && code !== 'CDP_ERROR') throw error
    throw await evalUnavailable(tabId, error?.message ?? error)
  }
  // `result: null` alone cannot distinguish null from undefined; the explicit
  // flag keeps a legitimate empty object ({}) meaning only that.
  if (value === undefined) return { ...extra, result: null, undefined: true }
  return { ...extra, result: value }
}

export async function inspectPage({ selector, offset, limit, text: withText, href: withHref, image: withImage, state: withState, resolve: withResolve, attrs, textMaxChars, tabId: hint }) {
  const tabId = await requirePage(hint)
  const sel = typeof selector === 'string' ? selector.trim() : ''
  if (!sel) throw fail('NO_SELECTOR', 'pass a CSS selector such as "a", "table tr" or "div.card"')
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 500)
  const skip = Math.min(Math.max(Number(offset) || 0, 0), 1000)
  const textCap = Math.min(Math.max(Math.trunc(Number(textMaxChars)) || 240, 40), 4000)
  const attrNames = Array.isArray(attrs)
    ? attrs.filter((name) => typeof name === 'string' && name.trim()).map((name) => name.trim()).slice(0, 8)
    : []
  const want = {
    text: withText !== false,
    // resolve is about a link, so asking for it implies the href field.
    href: Boolean(withHref) || Boolean(withResolve),
    image: Boolean(withImage),
    state: Boolean(withState),
    resolve: Boolean(withResolve),
  }
  // The resolver runs inside the page, next to the href it decodes. Embedding
  // its source keeps the row loop single-round-trip and adds no DOM or network
  // work: it is pure string decoding.
  const resolveExpr = want.resolve
    ? 'if (rec.href) { const res = (' + resolveRedirectHref.toString() + ')(rec.href); if (res) { rec.resolved = res.resolved; if (res.hrefResolved) rec.hrefResolved = res.hrefResolved; if (res.resolvableBy) rec.resolvableBy = res.resolvableBy } }'
    : ''
  const expression = `(() => {
    const nodes = Array.from(document.querySelectorAll(${JSON.stringify(sel)}))
    const out = []
    for (const el of nodes.slice(${skip}, ${skip + cap})) {
      const r = el.getBoundingClientRect()
      const rec = { i: out.length + 1, tag: el.tagName.toLowerCase(), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
      // Zero-size wrappers are real matches that the page does not paint. Say so
      // with the element's own box instead of reading text or another row's box.
      const rendered = r.width > 0 && r.height > 0
      if (!rendered) rec.visible = false
      if (rendered && ${want.text}) {
        // innerText is the visible text. textContent would emit inline <script>
        // and <style> source from wrappers whose innerText is empty.
        const t = (typeof el.innerText === 'string' ? el.innerText : '').replace(/\\s+/g, ' ').trim()
        if (t) { rec.text = t.slice(0, ${textCap}); if (t.length > ${textCap}) rec.textTruncated = true }
      }
      if (${want.href}) {
        if (el.matches('a[href]')) {
          // An anchor row keeps its own resolved href, whatever scheme it uses.
          const own = typeof el.href === 'string' ? el.href : el.getAttribute('href')
          if (own) rec.href = own
        } else {
          // A card wrapper owns no href; the first descendant http(s) link is the
          // row's destination (SERP result blocks look exactly like this).
          let mail = ''
          for (const link of el.querySelectorAll('a[href]')) {
            const url = typeof link.href === 'string' ? link.href : (link.getAttribute('href') || '')
            if (/^https?:/i.test(url)) { rec.href = url; rec.hrefSource = 'descendant'; break }
            if (!mail && /^mailto:/i.test(url)) mail = url
          }
          if (!rec.href && mail) { rec.href = mail; rec.hrefSource = 'descendant' }
        }
      }
      ${resolveExpr}
      if (${want.image}) { const im = el.matches('img') ? el : el.querySelector('img'); if (im) rec.image = im.currentSrc || im.src || im.getAttribute('src') || '' }
      const rowAttrs = ${JSON.stringify(attrNames)}
      if (rowAttrs.length) {
        const map = {}
        for (const name of rowAttrs) {
          const value = el.getAttribute(name)
          if (value !== null) map[name] = value.length > 240 ? value.slice(0, 240) : value
        }
        if (Object.keys(map).length) rec.attrs = map
      }
      if (${want.state}) {
        const control = el.matches('input,select,textarea,option') ? el : el.querySelector('input,select,textarea')
        if (control) {
          rec.kind = String(control.type || control.tagName).toLowerCase()
          if (control.value !== undefined) rec.value = String(control.value).slice(0, 120)
          if ('checked' in control) rec.checked = Boolean(control.checked)
        }
        const id = el.getAttribute('id'); if (id) rec.id = id
        const nm = el.getAttribute('name'); if (nm) rec.name = nm
        const cls = el.getAttribute('class'); if (cls) rec.class = cls.slice(0, 120)
      }
      out.push(rec)
    }
    const reply = { count: nodes.length, shown: out.length, offset: ${skip}, items: out }
    // An empty rows reply on a canvas app reads as "empty content". Name the
    // canvas instead so a caller switches to capture or pixel sampling.
    if (nodes.length === 0) {
      const canvases = document.querySelectorAll('canvas')
      if (canvases.length > 0) {
        reply.canvas = true
        reply.canvasCount = canvases.length
        reply.hint = 'no DOM rows matched, but the page contains a canvas, so it is probably canvas-rendered; an empty rows reply does not mean the content is empty. Use bsb_capture or bsb_pixels to read it.'
      }
    }
    return reply
  })()`
  const value = await evaluate(tabId, expression)
  return { url: (await pageMeta(tabId))?.url ?? '', selector: sel, ...(value || { count: 0, shown: 0, items: [] }) }
}

/** Bounded markup of the whole document or one selector. */
export async function readHtml({ selector, maxChars, tabId: hint }) {
  const tabId = await requirePage(hint)
  const cap = Math.min(Math.max(Number(maxChars) || 12000, 200), 200000)
  const expression = selector
    ? '(() => { const el = document.querySelector(' + JSON.stringify(String(selector)) + '); return el ? el.outerHTML : null })()'
    : '(() => (document.body ? document.body.outerHTML : ""))()'
  const html = await evaluate(tabId, expression)
  if (typeof html !== 'string') throw fail('TARGET_NOT_FOUND', 'no element matches ' + String(selector))
  return {
    url: (await pageMeta(tabId))?.url ?? '',
    html: html.slice(0, cap),
    truncated: html.length > cap,
    length: html.length,
  }
}
