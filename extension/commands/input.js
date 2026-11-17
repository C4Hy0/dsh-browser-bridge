// Browser Bridge worker: input.
// Split from extension/sw.js; keep the module boundaries in docs/SPEC.md in sync.
import { clearForced, contextForFrame, ensureLayout, evaluate, evaluateInContext, evaluateProgram, forceActive, frameChain, frameContext, frameList, frameOrigin, guardedContext, pageMeta, releaseActive, resolveFrameArg, send, waitEvent, waitReady } from '../cdp.js'
import { CLICK_UNCHANGED_HINT, FILE_CHOOSER_WAIT_MS, HIDDEN_HINT, KEY_TEXT_CAP, OFFSCREEN_EDITOR_HINT, PASTE_MAX_CHARS, PASTE_OFFSCREEN_HINT } from '../constants.js'
import { ACTIVE_ELEMENT_EXPR, CANVAS_SIGNATURE_EXPR, CAR_MEASURE_EXPR, PAGE_FINGERPRINT_EXPR, boxOf, deepFindExpr, editableTargetExpr, keyTextProbeExpr, mapAreaAt, ownerRectExpr, textCandidatesExpr } from '../page.js'
import { pageVisibility } from '../page-state.js'
import { requirePage } from './tabs.js'
import { KEY_MAP, chordPlan, delay, describePage, fail, inputSuccess, isFileInputNode, keySpec, keyTextPrefix, recentCreatedTab, recentDialog, resolveTarget, withVelocity } from '../util.js'

/**
 * Attach files to an <input type="file">.
 *
 * Chrome opens the paths itself, so they must be paths the browser machine can
 * see (a Windows path when Chrome runs on Windows), not WSL paths.
 *
 * Three routes, strongest first:
 * - a selector that already IS the file input in the top document: set it
 *   directly (no click, so it works on a hidden tab);
 * - `frame`: the same direct set inside a frame whose document the tab can
 *   reach (same-origin or same-process);
 * - otherwise a real press at `x,y` (or on a top-document trigger) with
 *   `Page.setInterceptFileChooserDialog` armed, then `DOM.setFileInputFiles`
 *   with the `backendNodeId` the chooser event reports. This needs no script
 *   access to the frame document, which is what makes a cross-origin picker
 *   reachable at all.
 */
/** Fail when the page received a file it cannot read (0 bytes). */
export async function assertFilesReadable(tabId, selector, contextId) {
  const expression = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el || !el.files) return null;
    return Array.from(el.files).map((f) => ({ name: f.name, size: f.size }));
  })()`
  const read = contextId === undefined
    ? await evaluate(tabId, expression).catch(() => null)
    : await evaluateInContext(tabId, contextId, expression).catch(() => null)
  if (!Array.isArray(read) || read.length === 0) return
  const empty = read.filter((file) => Number(file.size) === 0)
  if (empty.length > 0) {
    throw fail(
      'FILE_NOT_READABLE',
      `the page received ${empty.map((file) => file.name).join(', ')} with 0 bytes: the browser could not read the file path. `
      + 'On a remote browser, pass a path that exists on that machine, or serve the file over http and download it there. Nothing usable was attached.',
    )
  }
}

export async function uploadPage({ target, files, frame, x, y, forceActive: forceWanted, tabId: hint }) {
  const tabId = await requirePage(hint)
  const list = Array.isArray(files)
    ? files.filter((f) => typeof f === 'string' && f.trim()).map((f) => f.trim())
    : []
  if (!list.length) throw fail('BAD_ARGUMENT', 'upload needs at least one file path')
  const hasPoint = Number.isFinite(Number(x)) && Number.isFinite(Number(y))
  if (!target && !frame && !hasPoint) {
    throw fail('BAD_ARGUMENT', 'upload needs a target selector, a frame, or x and y that open the file chooser')
  }
  const names = list.map((f) => f.split(/[\\/]/).pop())
  await send(tabId, 'DOM.enable').catch(() => undefined)
  if (frame && (target || !hasPoint)) {
    const hit = resolveFrameArg(await frameList(tabId), frame)
    if (!hit) throw fail('FRAME_NOT_FOUND', `no child frame matches ${frame}`)
    if (!target) throw fail('BAD_ARGUMENT', 'upload with frame needs a target selector inside that frame, or x and y instead')
    // The frame's document is a node in the tab's DOM tree only when the frame
    // runs in the same process. `getFrameOwner` + `describeNode` alone misses it
    // for a same-origin picker iframe (the Google Picker is same-origin and was
    // still reported unreachable), so walk the pierced tree instead: it carries
    // every same-process iframe as a `contentDocument` child.
    const root = await send(tabId, 'DOM.getDocument', { depth: -1, pierce: true })
    const findFrameDocument = (node) => {
      if (!node) return null
      if (node.frameId === hit.frameId && node.contentDocument) return node.contentDocument
      for (const child of node.children ?? []) {
        const found = findFrameDocument(child)
        if (found) return found
      }
      return node.contentDocument ? findFrameDocument(node.contentDocument) : null
    }
    const frameDocument = findFrameDocument(root?.root)
    const rootNodeId = frameDocument?.nodeId
    if (!rootNodeId) {
      // A cross-site out-of-process frame is not part of this tab's DOM tree, so
      // no selector can resolve inside it. Say so instead of guessing.
      throw fail(
        'FRAME_NOT_READABLE',
        `the frame document is not part of the tab's DOM tree (a cross-site out-of-process frame): ${hit.url || hit.frameId}. `
        + 'Upload through a top-document target (a button, label, or the iframe element) or a top-document file input, '
        + 'or press the control that opens the chooser with x,y. A same-origin frame is reachable and should not hit this error.',
      )
    }
    const selector = resolveTarget(target)
    const found = await send(tabId, 'DOM.querySelector', { nodeId: rootNodeId, selector })
    if (!found?.nodeId) throw fail('TARGET_NOT_FOUND', `no element matches ${selector} in frame ${hit.url || hit.frameId}`)
    const node = (await send(tabId, 'DOM.describeNode', { nodeId: found.nodeId }))?.node ?? {}
    if (!isFileInputNode(node)) {
      throw fail(
        'NOT_A_FILE_INPUT',
        `${selector} is not an <input type="file">. If it is a control that opens the chooser, call upload without frame using x,y or a top-document target.`,
      )
    }
    await send(tabId, 'DOM.setFileInputFiles', { nodeId: found.nodeId, files: list })
    await delay(150)
    const context = await guardedContext(tabId, hit.frameId).catch(() => undefined)
    await assertFilesReadable(tabId, selector, context)
    const meta = await pageMeta(tabId)
    return { url: meta?.url ?? '', title: meta?.title ?? '', count: list.length, files: names, via: 'frame', nodeId: found.nodeId, frameId: hit.frameId }
  }
  // A target that is itself the file input needs no press: this keeps the old
  // top-document path, including its behavior on a hidden tab.
  if (target) {
    const selector = resolveTarget(target)
    const root = await send(tabId, 'DOM.getDocument', { depth: 0, pierce: false })
    const found = await send(tabId, 'DOM.querySelector', { nodeId: root.root.nodeId, selector })
    if (found?.nodeId) {
      const node = (await send(tabId, 'DOM.describeNode', { nodeId: found.nodeId }))?.node ?? {}
      if (isFileInputNode(node)) {
        await send(tabId, 'DOM.setFileInputFiles', { nodeId: found.nodeId, files: list })
        await delay(150)
        await assertFilesReadable(tabId, selector)
        const meta = await pageMeta(tabId)
        return { url: meta?.url ?? '', title: meta?.title ?? '', count: list.length, files: names, via: 'input', nodeId: found.nodeId }
      }
    }
  }
  // The chooser-interception route crashed the fixture renderer twice on live
  // tests (a modal native chooser plus the debugger session). It is withdrawn
  // until it can be validated without a renderer crash. A top-document input or
  // a reachable frame input still works; nothing is pressed here.
  throw fail(
    'UNSUPPORTED',
    'cross-origin file-chooser upload is disabled in this build: the interception route crashed the renderer on live tests. '
    + 'Set files on a top-document <input type="file"> with target, or on a reachable frame input. Nothing was pressed.',
  )
}

/**
 * Set files on a file input through the browser's own chooser.
 *
 * The press is real input at a viewport point, so the tab must be visible. The
 * interception is armed for this command only: leaving it on would swallow
 * every later chooser on the tab. The returned `backendNodeId` comes from
 * Chrome, so no selector is resolved inside the (possibly cross-origin) frame
 * document.
 */
export async function fileChooserUpload(tabId, { list, names, target, x, y, forceWanted }) {
  const { visibility, forced } = await requireInputVisibility(tabId, 'upload', forceWanted)
  let point
  if (Number.isFinite(Number(x)) && Number.isFinite(Number(y))) {
    point = { x: Number(x), y: Number(y) }
  } else if (target) {
    const selector = resolveTarget(target)
    const box = await evaluate(tabId, `(${boxOf.toString()})(${JSON.stringify(selector)})`)
    if (!box) throw fail('TARGET_NOT_FOUND', `no element matches ${selector}`)
    if (box.offscreen) {
      throw fail('TARGET_OFFSCREEN', `${selector} stays outside the viewport after scrolling to it, so the press that opens the file chooser cannot land. Scroll it into view or pass x,y.`)
    }
    point = { x: box.x, y: box.y }
  } else {
    throw fail('BAD_ARGUMENT', 'upload needs x and y, or a top-document target, to open the file chooser')
  }
  // An explicit x,y outside the layout viewport used to reach pressAt and crash
  // the renderer on a hidden tab. Refuse it before any input is dispatched: a
  // press outside the viewport cannot open a chooser anyway.
  const viewport = await evaluate(tabId, '({ width: window.innerWidth, height: window.innerHeight })').catch(() => null)
  if (viewport && (point.x < 0 || point.y < 0 || point.x >= viewport.width || point.y >= viewport.height)) {
    throw fail(
      'TARGET_OFFSCREEN',
      `the press point (${Math.round(point.x)},${Math.round(point.y)}) is outside the ${Math.round(viewport.width)}x${Math.round(viewport.height)} viewport, so no file chooser can open there. `
      + 'Scroll the control into view with bsb_act scroll, or pass in-view x,y. Nothing was pressed.',
    )
  }
  const opened = waitEvent(tabId, 'Page.fileChooserOpened', FILE_CHOOSER_WAIT_MS)
  // The event may never arrive (a press that opens nothing). Mark the promise
  // handled so a failure before the await cannot surface as an unhandled rejection.
  opened.catch(() => undefined)
  let handled = false
  try {
    try {
      await send(tabId, 'Page.setInterceptFileChooserDialog', { enabled: true })
    } catch (error) {
      throw fail('FILE_CHOOSER_UNSUPPORTED', `this browser cannot intercept a file chooser (${error?.message ?? error}); pass a top-document <input type="file"> selector instead.`)
    }
    await pressAt(tabId, point, 1, 'left')
    let event
    try {
      event = await opened
    } catch {
      throw fail(
        'FILE_CHOOSER_NOT_OPENED',
        `no file chooser opened after pressing (${Math.round(point.x)},${Math.round(point.y)}). The press must land on an <input type="file">, its label, or a control that opens one. `
        + 'If the input lives in a cross-origin iframe, press the control itself with x,y: a frame that runs in another process cannot be intercepted from the tab.',
      )
    }
    if (!event?.backendNodeId) {
      throw fail(
        'FILE_INPUT_NOT_FOUND',
        'the file chooser opened but Chrome did not report an input node (only an <input type="file"> reports one; showOpenFilePicker() does not), so the files cannot be attached.',
      )
    }
    await send(tabId, 'DOM.setFileInputFiles', { backendNodeId: event.backendNodeId, files: list })
    handled = true
    await delay(200)
    const meta = await pageMeta(tabId)
    return {
      url: meta?.url ?? '',
      title: meta?.title ?? '',
      count: list.length,
      files: names,
      via: 'fileChooser',
      backendNodeId: event.backendNodeId,
      ...(event.frameId ? { frameId: event.frameId } : {}),
      ...inputSuccess(visibility, forced),
    }
  } finally {
    // Disable interception even when the press opened nothing. `cancel` releases
    // a chooser that is still pending because it reported no input node.
    await send(tabId, 'Page.setInterceptFileChooserDialog', handled ? { enabled: false } : { enabled: false, cancel: true })
      .catch(() => send(tabId, 'Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => undefined))
    if (forced) await clearForced(tabId, forced)
  }
}

export async function wheelPage({ x, y, deltaX, deltaY, modifiers, forceActive: forceWanted, tabId: hint }) {
  const tabId = await requirePage(hint)
  const { visibility, forced } = await requireInputVisibility(tabId, 'wheel', forceWanted)
  const px = Number(x)
  const py = Number(y)
  if (!Number.isFinite(px) || !Number.isFinite(py)) throw fail('BAD_ARGUMENT', 'wheel needs numeric x and y')
  const dx = Number(deltaX) || 0
  const dy = Number(deltaY) || 0
  if (dx === 0 && dy === 0) throw fail('BAD_ARGUMENT', 'wheel needs deltaX or deltaY')
  const bits = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 }
  const mask = (Array.isArray(modifiers) ? modifiers : [])
    .map((name) => bits[String(name).toLowerCase()])
    .filter((bit) => typeof bit === 'number')
    .reduce((all, bit) => all | bit, 0)
  // A hidden tab never acks a wheel event (the compositor owns it), which used
  // to hang the command until the 30 s worker timeout. Fail in 1.5 s with the
  // recovery step instead.
  const dispatched = send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: px, y: py, deltaX: dx, deltaY: dy, modifiers: mask })
  const hidden = new Promise((_, reject) => setTimeout(
    () => reject(fail('TAB_NOT_VISIBLE', 'wheel needs the tab in front; bring it forward with bsb_tabs use, then retry')),
    1500,
  ))
  try {
    await Promise.race([dispatched, hidden])
  } catch (error) {
    if (forced) await clearForced(tabId, forced)
    throw error
  }
  const meta = await pageMeta(tabId)
  if (forced) await clearForced(tabId, forced)
  return { url: meta?.url ?? '', title: meta?.title ?? '', at: { x: px, y: py }, deltaX: dx, deltaY: dy, modifiers: mask, ...inputSuccess(visibility, forced) }
}

/**
 * Explicit control of the escape hatch, for a caller that wants the page to stay
 * awake across many calls (watching a run, or a game that needs a live clock).
 */
export async function forcePage({ mode, tabId: hint }) {
  const tabId = await requirePage(hint)
  const held = mode === 'hold'
  const forced = await forceActive(tabId, { mode: held ? 'hold' : 'call' })
  return { url: (await pageMeta(tabId))?.url ?? '', ...forced }
}

export async function releasePage({ tabId: hint }) {
  const tabId = await requirePage(hint)
  return { url: (await pageMeta(tabId))?.url ?? '', ...(await releaseActive(tabId)) }
}

/**
 * Locate a clickable point by visible text.
 *
 * Refs go stale on every re-render and selectors assume the page's markup, but
 * a human picking a button by its label is stable: exact matches win over
 * substrings, and the smallest box wins over a container that merely contains
 * the text.
 */
export async function findTextPoint(tabId, text) {
  const wanted = String(text ?? '').trim()
  if (!wanted) throw fail('BAD_ARGUMENT', 'text must not be empty')
  const found = await evaluate(tabId, `(() => {
    const want = ${JSON.stringify(wanted)}.toLowerCase();
    const collect = (root, out) => {
      out.push(...root.querySelectorAll('button, a, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], input[type="submit"], input[type="button"], input[type="reset"], label, summary, li, span, p, div, td, th, dt, dd, strong, em, b, i, h1, h2, h3, h4, h5, h6'));
      for (const host of root.querySelectorAll('*')) if (host.shadowRoot) collect(host.shadowRoot, out);
      return out;
    };
    const nodes = collect(document, []);
    // Generic containers are matched only when they are leaf-like: a section that
    // merely wraps the real control must never win over the control itself.
    const generic = new Set(['DIV', 'P', 'LI', 'SPAN', 'TD', 'TH', 'DT', 'DD', 'STRONG', 'EM', 'B', 'I', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
    const out = [];
    for (const el of nodes) {
      if (el.getClientRects().length === 0 && getComputedStyle(el).position !== 'fixed') continue;
      const raw = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
      if (!raw) continue;
      if (generic.has(el.tagName) && (raw.length > 160 || el.querySelector('button, a, input, select, textarea, [role="button"]'))) continue;
      const lower = raw.toLowerCase();
      if (lower !== want && !lower.includes(want)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      out.push({ el, text: raw.slice(0, 80), area: r.width * r.height, exact: lower === want, visible: r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth });
    }
    if (!out.length) return null;
    out.sort((a, b) => (b.exact - a.exact) || (b.visible - a.visible) || (a.area - b.area));
    const best = out[0];
    let r = best.el.getBoundingClientRect();
    let scrolled = false;
    if (!best.visible) {
      best.el.scrollIntoView({ block: 'center', inline: 'center' });
      r = best.el.getBoundingClientRect();
      scrolled = true;
    }
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    let hit = null;
    try {
      const at = document.elementFromPoint(x, y);
      hit = Boolean(at) && (at === best.el || best.el.contains(at) || at.contains(best.el));
    } catch {}
    return { x, y, text: best.text, scrolled, matches: out.length, hit };
  })()`)
  if (!found) throw textNotClickable(await evaluate(tabId, textCandidatesExpr(wanted)).catch(() => null), wanted)
  return found
}

/** Build the typed failure for a text click that found no hittable node. */
export function textNotClickable(report, wanted) {
  const candidates = Array.isArray(report?.candidates) ? report.candidates.slice(0, 5) : []
  const reason = candidates.length
    ? `the text is present in ${Number(report?.matched) || candidates.length} node(s) but none is hittable (zero-size, aria-hidden or pointer-events:none)`
    : 'no node text contains the string, even hidden or zero-size ones, so the page may have re-rendered since the read'
  const hint = candidates.length
    ? 'click a coordinate inside a candidate box with bsb_act click x,y, or click the nearest clickable ancestor selector. A selector that crosses a shadow boundary is written host >> inner.'
    : 're-read the page with bsb_read to confirm the text is still there, then click by @eN, selector or coordinates.'
  return fail(
    'TEXT_NOT_CLICKABLE',
    `click text ${JSON.stringify(wanted)} found no hittable element. reason: ${reason}. `
    + `candidates: ${JSON.stringify(candidates)}. hint: ${hint}`,
  )
}

// A human tapping the same control several times is one gesture; repeating the
// tool call instead costs a model round trip and trips harness repeat warnings.
export async function pressAt(tabId, point, count, button = 'left', holdMs = 0) {
  const taps = Math.min(Math.max(Math.trunc(Number(count) || 1), 1), 200)
  const gap = taps > 50 ? 25 : 60
  const btn = button === 'right' ? 'right' : button === 'middle' ? 'middle' : 'left'
  const buttons = btn === 'right' ? 2 : btn === 'middle' ? 4 : 1
  // A held press is a different gesture from a tap: a game mines by accumulating
  // mousedown duration across frames, so a down/up pair inside one tick mines
  // nothing. holdMs keeps the button down; it is ignored for repeated taps
  // because holding one of fifty taps is never what the caller meant.
  const hold = taps === 1 ? Math.min(Math.max(Number(holdMs) || 0, 0), 10000) : 0
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
  for (let i = 0; i < taps; i += 1) {
    const at = { x: point.x, y: point.y, button: btn, buttons, clickCount: 1 }
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...at })
    if (hold > 0) await delay(hold)
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...at })
    if (i < taps - 1) await delay(gap)
  }
  return taps
}

/**
 * Follow an image-map <area href> when a synthetic press did not navigate.
 * Returns the URL it navigated to, or null when nothing was followed.
 */
export async function followMapArea(tabId, x, y, beforeUrl, afterUrl) {
  if (!beforeUrl || beforeUrl !== afterUrl) return null
  const area = await evaluate(tabId, '(' + mapAreaAt.toString() + ')(' + Number(x) + ', ' + Number(y) + ')').catch(() => null)
  if (!area || !area.href) return null
  let target
  try { target = new URL(area.href, afterUrl).href } catch { return null }
  await send(tabId, 'Page.navigate', { url: target })
  await waitEvent(tabId, 'Page.loadEventFired', 10000).catch(() => undefined)
  await waitReady(tabId, 4000).catch(() => undefined)
  await delay(250)
  return target
}

export const pageFingerprint = (tabId) => evaluate(tabId, PAGE_FINGERPRINT_EXPR).catch(() => null)

/** Did anything in the fingerprint move? null when either snapshot is missing. */
export const fingerprintChanged = (before, after) => {
  if (!before || !after) return null
  return before.url !== after.url
    || before.title !== after.title
    || before.elementCount !== after.elementCount
    || before.textLen !== after.textLen
    || before.active !== after.active
}

export async function clickPage({ target, text, x, y, frame, count, targets, all, button, holdMs, verify, forceActive: forceWanted, tabId: hint }) {
  const tabId = await requirePage(hint)
  // Refuse before measuring or dispatching: input into a hidden page is held by
  // the browser and replayed later, which is worse than an error.
  const { visibility, forced } = await requireInputVisibility(tabId, 'click', forceWanted)
  const layout = await ensureLayout(tabId)
  // verify:true is opt-in. The fingerprint is read before the press and again
  // after the existing settle delay; there is no extra wait and no DOM write.
  const wantsVerify = verify === true
  const snapshotBefore = async () => (wantsVerify ? pageFingerprint(tabId) : undefined)
  const finish = async (reply, beforePrint) => {
    let merged = reply
    if (wantsVerify) {
      const afterPrint = await pageFingerprint(tabId)
      const changed = fingerprintChanged(beforePrint, afterPrint)
      if (changed !== null) {
        merged = { ...reply, pageChanged: changed }
        if (!changed) {
          // "applied" means the press had the effect the caller asked for. A
          // verified no-op is a dispatched press with no effect, and the two
          // fields must not contradict each other.
          merged = { ...merged, applied: false, dispatched: true, hint: CLICK_UNCHANGED_HINT }
        }
      }
    }
    if (forced) await clearForced(tabId, forced)
    return { ...merged, ...inputSuccess(visibility, forced) }
  }
  // Batch mode: a grid of tiles needs dozens of presses; one call keeps the
  // sequence tight and lets a single "select all these" request stay human-paced.
  if (Array.isArray(targets) && targets.length) {
    const picks = []
    for (const item of targets.slice(0, 500)) {
      if (item && Number.isFinite(Number(item.x)) && Number.isFinite(Number(item.y))) {
        picks.push({ x: Number(item.x), y: Number(item.y) })
        continue
      }
      if (typeof item !== 'string' && typeof item !== 'number') continue
      // Selector points are measured at press time, not up front: scrolling one
      // tile into view shifts every later tile, so a pre-computed coordinate can
      // land on a neighbour (the site under test auto-scrolls as it re-renders).
      picks.push({ selector: resolveTarget(item) })
    }
    if (!picks.length) throw fail('TARGET_NOT_FOUND', 'targets resolved to no clickable points')
    const beforePrint = await snapshotBefore()
    const clicked = []
    for (const pick of picks) {
      let point = pick
      if (pick.selector) {
        const box = await evaluate(tabId, `(${boxOf.toString()})(${JSON.stringify(pick.selector)})`)
        if (!box) throw fail('TARGET_NOT_FOUND', `no clickable element matches ${pick.selector}`)
        point = { x: box.x, y: box.y }
      }
      await pressAt(tabId, point, 1, button, holdMs)
      clicked.push(point)
      await delay(60)
    }
    await delay(200)
    const batchMeta = await pageMeta(tabId)
    return finish({ url: batchMeta?.url ?? '', title: batchMeta?.title ?? '', clicked, clicks: clicked.length, windowRestored: layout.restored, dialog: recentDialog(tabId) }, beforePrint)
  }
  // Coordinate clicks: many widgets (canvas maps, custom controls) expose no
  // usable selector, but the agent can still see where to press.
  if (Number.isFinite(Number(x)) && Number.isFinite(Number(y))) {
    const px = Number(x), py = Number(y)
    const before = await pageMeta(tabId)
    const beforePrint = await snapshotBefore()
    const taps = await pressAt(tabId, { x: px, y: py }, count, button, holdMs)
    await delay(150)
    let meta = await pageMeta(tabId)
    const followed = await followMapArea(tabId, px, py, before?.url, meta?.url)
    if (followed) meta = (await pageMeta(tabId)) ?? meta
    return finish({ url: meta?.url ?? '', title: meta?.title ?? '', clickedAt: { x: px, y: py }, clicks: taps, windowRestored: layout.restored, dialog: recentDialog(tabId), followed }, beforePrint)
  }
  // Frames: the element lives in a child document, but the pointer is global —
  // resolve the point locally, then offset it by the frame's box in this page.
  if (frame) {
    const { frame: hit, contextId } = await frameContext(tabId, frame)
    let px, py
    if (target) {
      // Same-origin frames can be resolved in one pass: scroll every level, then
      // sum each frame element's viewport rect. This is exact for nested frames.
      const direct = await absoluteFramePoint(tabId, contextId, resolveTarget(target))
      if (direct) { px = direct.x; py = direct.y }
    }
    if (px === undefined) {
      const local = await framePoint(tabId, contextId, { target, text })
      if (!local) throw fail('TARGET_NOT_FOUND', `nothing matches ${JSON.stringify(String(target ?? text))} in frame ${hit.url || hit.frameId}`)
      // Cross-origin or text lookup: fall back to CDP frame boxes, revealing each
      // ancestor document first because nested frames clip their children.
      let origin = await revealFramePath(tabId, hit.frameId)
      px = origin.x + local.x, py = origin.y + local.y
      const view = await evaluate(tabId, '({ w: innerWidth, h: innerHeight })')
      if (px < 0 || py < 0 || px > (view?.w ?? 0) || py > (view?.h ?? 0)) {
        await evaluate(tabId, `window.scrollBy(0, ${py} - innerHeight / 2)`)
        await delay(180)
        origin = await revealFramePath(tabId, hit.frameId, { scroll: false })
        px = origin.x + local.x, py = origin.y + local.y
      }
    }
    const beforePrint = await snapshotBefore()
    const taps = await pressAt(tabId, { x: px, y: py }, count, button, holdMs)
    await delay(400)
    const meta = await pageMeta(tabId)
    return finish({ url: meta?.url ?? '', title: meta?.title ?? '', frameId: hit.frameId, clickedAt: { x: px, y: py }, clicks: taps, windowRestored: layout.restored, dialog: recentDialog(tabId) }, beforePrint)
  }
  // Text targeting: the label survives re-renders that invalidate @eN refs, and
  // needs no knowledge of the page's markup.
  if (text) {
    const hit = await findTextPoint(tabId, text)
    const openedSince = Date.now()
    if (hit.hit === false) {
      throw fail(
        'TARGET_COVERED',
        `the text ${JSON.stringify(hit.text)} is at (${Math.round(hit.x)},${Math.round(hit.y)}) but another element covers that point, so the press was not dispatched. `
        + 'Scroll it clear of the overlay or click the cover explicitly.',
      )
    }
    if (hit.scrolled) await delay(180)
    const beforePrint = await snapshotBefore()
    const taps = await pressAt(tabId, { x: hit.x, y: hit.y }, count, button, holdMs)
    await delay(400)
    const meta = await pageMeta(tabId)
    const opened = recentCreatedTab(tabId, openedSince)
    return finish({
      url: meta?.url ?? '', title: meta?.title ?? '', matchedText: hit.text, matchedCount: hit.matches,
      clickedAt: { x: hit.x, y: hit.y }, clicks: taps, windowRestored: layout.restored, dialog: recentDialog(tabId),
      ...(opened ? { newTabId: opened.id, newTabUrl: opened.url || undefined, hint: 'the click opened a new tab; it is not tracked. Use bsb_tabs use with newTabId to adopt it.' } : {}),
    }, beforePrint)
  }
  const selector = resolveTarget(target)
  // Press every match in one call: dense grids of checkboxes otherwise cost one
  // tool round trip per tile.
  if (all === true) {
    const points = await evaluate(tabId, `(() => { const out = []; const nodes = document.querySelectorAll(${JSON.stringify(selector)}); for (const el of nodes) { const r = el.getBoundingClientRect(); if (r.width > 0 && r.height > 0) out.push({ x: r.left + r.width / 2, y: r.top + r.height / 2 }); } return out; })()`)
    if (!points || !points.length) throw fail('TARGET_NOT_FOUND', `no clickable element matches ${selector}`)
    const beforePrint = await snapshotBefore()
    const pressed = []
    for (const point of points) {
      await pressAt(tabId, point, 1, button)
      pressed.push(point)
      await delay(50)
    }
    await delay(200)
    const allMeta = await pageMeta(tabId)
    return finish({ url: allMeta?.url ?? '', title: allMeta?.title ?? '', clicked: pressed, clicks: pressed.length, matchedCount: points.length, windowRestored: layout.restored, dialog: recentDialog(tabId) }, beforePrint)
  }
  let box = await evaluate(tabId, `(${boxOf.toString()})(${JSON.stringify(selector)})`)
  if (!box) throw fail('TARGET_NOT_FOUND', `no clickable element matches ${selector}`)
  if (box.hit === false) {
    // The page moved between the measurement and the press (a sticky header, an
    // auto-scroll, a re-render). Re-measure once, then refuse.
    await delay(150)
    box = await evaluate(tabId, `(${boxOf.toString()})(${JSON.stringify(selector)})`)
  }
  if (box.hit === false) {
    const at = box.hit && typeof box.hit === 'object' ? box.hit : null
    throw fail(
      'TARGET_COVERED',
      `${selector} is at (${Math.round(box.x)},${Math.round(box.y)}) but the element at that point is `
      + `${at ? `${at.tag}${at.id ? '#' + at.id : ''}` : 'something else'}. The press was not dispatched, because it would land on the cover. `
      + 'Scroll the element clear of the overlay, close the menu or cookie banner, or click the cover explicitly.',
    )
  }
  if (box.offscreen) {
    throw fail(
      'TARGET_OFFSCREEN',
      `${selector} exists but stayed outside the viewport after scrolling to it `
      + `(page scrollY ${Math.round(await evaluate(tabId, 'scrollY').catch(() => 0) || 0)}). `
      + 'Something is pinning or clipping it. Scroll the region yourself with bsb_act scroll, then retry.',
    )
  }
  // Ambiguity is a real trap on dense pages (a bare "button" hits the wrong one);
  // surface how many elements the selector matched so the caller can narrow it.
  const matched = await evaluate(tabId, `(() => { try { return document.querySelectorAll(${JSON.stringify(selector)}).length } catch { return 1 } })()`)
  const beforeClick = await pageMeta(tabId)
  const beforePrint = await snapshotBefore()
  const openedSince = Date.now()
  const taps = await pressAt(tabId, { x: box.x, y: box.y }, count, button)
  await delay(400)
  let meta = await pageMeta(tabId)
  const followed = await followMapArea(tabId, box.x, box.y, beforeClick?.url, meta?.url)
  if (followed) meta = (await pageMeta(tabId)) ?? meta
  const opened = recentCreatedTab(tabId, openedSince)
  const described = await evaluate(tabId, `(() => { try { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; return { tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 40), id: el.id || undefined, name: el.getAttribute?.('name') || undefined }; } catch { return null } })()`)
  return finish({
    url: meta?.url ?? '', title: meta?.title ?? '', matchedCount: matched, element: described ?? undefined,
    clickedAt: { x: box.x, y: box.y }, clicks: taps, windowRestored: layout.restored,
    dialog: recentDialog(tabId), followed,
    ...(opened ? { newTabId: opened.id, newTabUrl: opened.url || undefined, hint: 'the click opened a new tab; it is not tracked. Use bsb_tabs use with newTabId to adopt it.' } : {}),
  }, beforePrint)
}

/**
 * Clear a focused field and type into it using real key events only.
 *
 * Earlier revisions cleared the value with `el.value = ''` and pasted the text with
 * Input.insertText, which some pages treat as scripted manipulation and which never
 * produced keydown/keypress listeners. Ctrl+A + Backspace and a key event per
 * character keep the effect identical for the page but indistinguishable from a
 * person typing.
 */
export async function clearAndType(tabId, text) {
  const stroke = async (key, code, vk, modifiers = 0) => {
    const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...base })
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }
  await stroke('a', 'KeyA', 65, 2)
  await stroke('Backspace', 'Backspace', 8)
  for (const ch of Array.from(String(text ?? ''))) {
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch })
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
    await delay(12)
  }
}

/**
 * Make sure the text actually reached the field.
 *
 * Real key events are the right default, but some pages cancel them (a keydown
 * handler that returns false), run an input mask that drops characters, or
 * re-render the node mid-type. The typed value is therefore read back, and when
 * it does not contain the text an input/textarea value is set through the
 * prototype setter and announced with input/change so v-model bindings still
 * fire. A contenteditable node is never written directly: a scripted DOM edit of
 * a rich editor is page injection, so a write that did not land there is an
 * error for the caller, not something to fake.
 */
export async function ensureTyped(tabId, selector, text, contextId) {
  const wanted = String(text ?? '')
  const find = deepFindExpr(selector)
  const read = `(() => { const el = ${find}; if (!el) return null;
    const raw = el.value !== undefined ? el.value : (el.innerText || el.textContent);
    return String(raw || ''); })()`
  const run = (source) => (contextId === undefined
    ? evaluate(tabId, source)
    : evaluateInContext(tabId, contextId, source)).catch(() => null)
  const value = await run(read)
  if (typeof value === 'string' && value.includes(wanted)) return { value, forced: false }
  const write = `(() => { const el = ${find}; if (!el) return null;
    const tag = (el.tagName || '').toLowerCase();
    if (tag !== 'input' && tag !== 'textarea') return null;
    const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    const next = ${JSON.stringify(wanted)};
    if (setter) setter.call(el, next); else el.value = next;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    const raw = el.value !== undefined ? el.value : (el.innerText || el.textContent);
    return String(raw || ''); })()`
  const written = await run(write)
  return { value: typeof written === 'string' ? written : value, forced: typeof written === 'string' }
}

export function describeEditableTarget(selector, state) {
  const id = state?.id ? ` id "${state.id}"` : ''
  const tag = state?.tag ?? 'element'
  const size = state ? `${state.width}x${state.height} at (${state.x},${state.y})` : 'an unmeasured box'
  const view = state?.viewport ? ` in a ${state.viewport.width}x${state.viewport.height} viewport` : ''
  const style = state ? ` (display "${state.display}", visibility "${state.visibility}")` : ''
  return `${selector} (${tag}${id}) measures ${size}${view}${style}`
}

/** Name the element that really holds focus: tag, id, role and aria-label. */
export function describeActiveElement(info) {
  if (!info) return 'no element (focus is on the document)'
  const parts = [info.tag || 'element']
  if (info.id) parts.push(`id "${info.id}"`)
  if (info.role) parts.push(`role "${info.role}"`)
  if (info.ariaLabel) parts.push(`aria-label "${info.ariaLabel}"`)
  return `<${parts.join(' ')}>`
}

export async function readActiveElement(tabId, contextId) {
  try {
    return contextId === undefined
      ? await evaluate(tabId, ACTIVE_ELEMENT_EXPR)
      : await evaluateInContext(tabId, contextId, ACTIVE_ELEMENT_EXPR)
  } catch {
    return null
  }
}

export async function requireEditableTarget(tabId, selector, contextId, where, action = 'type') {
  const source = editableTargetExpr(selector)
  const state = contextId === undefined
    ? await evaluate(tabId, source).catch(() => null)
    : await evaluateInContext(tabId, contextId, source).catch(() => null)
  if (!state) throw fail('TARGET_NOT_FOUND', `no field matches ${selector}${where ? ' in ' + where : ''}`)
  const described = describeEditableTarget(selector, state)
  const hint = action === 'paste' ? PASTE_OFFSCREEN_HINT : OFFSCREEN_EDITOR_HINT
  if (state.display === 'none') {
    throw fail('NOT_VISIBLE', `${action} cannot write into ${described}: display is "none", so nothing is rendered and nothing was typed.`)
  }
  if (state.visibility === 'hidden') {
    throw fail('NOT_VISIBLE', `${action} cannot write into ${described}: visibility is "hidden", so nothing is shown and nothing was typed.`)
  }
  if (state.width <= 0 || state.height <= 0) {
    throw fail('NOT_VISIBLE', `${action} cannot write into ${described}: the box has zero area, so no real input can land. ${hint}.`)
  }
  if (state.offscreen) {
    throw fail('NOT_VISIBLE', `${action} cannot write into ${described}: it stays outside the viewport after scrolling to it, so no real input can land. ${hint}.`)
  }
  if (!state.editable) {
    throw fail('NOT_EDITABLE', `${action} cannot write into ${described}: it holds no text value. Use action "key" with text for a canvas or key-driven field, or set/select for a form control.`)
  }
  if (!state.focused) {
    throw fail(
      'NOT_FOCUSED',
      `${action} cannot write into ${described}: after focusing it, document.activeElement is ${describeActiveElement(state.active)} instead, `
      + 'so a keystroke would go to another control. Click the target again, check that it is enabled and not covered by an overlay, then retry. '
      + 'Do not assume the text went where you asked: nothing was typed.',
    )
  }
  return state
}

export function typedValueDidNotLand(selector, wanted, observed) {
  const seen = typeof observed === 'string' ? JSON.stringify(observed.slice(0, 80)) : 'nothing readable'
  return `type did not land in ${selector}: after typing ${JSON.stringify(wanted.slice(0, 80))} the field still reads ${seen}. `
    + 'The page may have cancelled the key events or re-rendered the node; the write did not land, so this is not reported as success. '
    + 'Check that the target is the visible editor and is enabled, or use bsb_act action "key" text for a key-driven editor.'
}

export async function typePage({ target, text, submit, frame, forceActive: forceWanted, tabId: hint }) {
  const tabId = await requirePage(hint)
  const { visibility, forced } = await requireInputVisibility(tabId, 'type', forceWanted)
  await ensureLayout(tabId)
  const wanted = String(text ?? '')
  const finish = async (reply) => {
    if (forced) await clearForced(tabId, forced)
    return { ...reply, ...inputSuccess(visibility, forced) }
  }
  if (frame) {
    const { frame: hit, contextId } = await frameContext(tabId, frame)
    const selector = resolveTarget(target)
    const where = `frame ${hit.url || hit.frameId}`
    await requireEditableTarget(tabId, selector, contextId, where)
    await clearAndType(tabId, text)
    const frameTyped = await ensureTyped(tabId, selector, text, contextId)
    if (wanted.length && (typeof frameTyped.value !== 'string' || !frameTyped.value.includes(wanted))) {
      throw fail('TYPE_NOT_APPLIED', typedValueDidNotLand(selector, wanted, frameTyped.value))
    }
    const activeElement = await readActiveElement(tabId, contextId)
    if (submit === true) {
      const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
      await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...key })
      await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...key })
    }
    await delay(300)
    const frameMeta = await pageMeta(tabId)
    const activeElementAfter = submit === true ? await readActiveElement(tabId, contextId) : undefined
    return finish({
      url: frameMeta?.url ?? '', title: frameMeta?.title ?? '', frameId: hit.frameId,
      typed: frameTyped.value ?? undefined, valueAfter: frameTyped.value ?? undefined, valueForced: frameTyped.forced,
      activeElement: activeElement ?? undefined, ...(submit === true ? { activeElementAfter: activeElementAfter ?? undefined } : {}),
    })
  }
  const selector = resolveTarget(target)
  await requireEditableTarget(tabId, selector)
  // Insert as real input so every keystroke goes through the page's handlers.
  await clearAndType(tabId, text)
  const landed = await ensureTyped(tabId, selector, text)
  if (wanted.length && (typeof landed.value !== 'string' || !landed.value.includes(wanted))) {
    throw fail('TYPE_NOT_APPLIED', typedValueDidNotLand(selector, wanted, landed.value))
  }
  const activeElement = await readActiveElement(tabId)
  if (submit === true) {
    const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...key })
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...key })
  }
  await delay(300)
  const meta = await pageMeta(tabId)
  const activeElementAfter = submit === true ? await readActiveElement(tabId) : undefined
  return finish({
    url: meta?.url ?? '', title: meta?.title ?? '',
    typed: landed.value ?? undefined, valueAfter: landed.value ?? undefined, valueForced: landed.forced,
    activeElement: activeElement ?? undefined, ...(submit === true ? { activeElementAfter: activeElementAfter ?? undefined } : {}),
  })
}

/**
 * Put text on the OS clipboard from the extension service worker.
 *
 * Chrome 157 lets an extension worker holding the `clipboardWrite` permission
 * call `navigator.clipboard.writeText` directly; older builds expose no
 * clipboard API in a worker. The write is bounded because a clipboard call that
 * never settles used to look like a hung browser.
 */
export async function writeClipboardText(text) {
  const clipboard = globalThis.navigator?.clipboard
  if (!clipboard || typeof clipboard.writeText !== 'function') {
    return { ok: false, reason: 'navigator.clipboard is not available in this worker' }
  }
  try {
    await Promise.race([
      clipboard.writeText(text),
      new Promise((_, reject) => setTimeout(() => reject(fail('CLIPBOARD_TIMEOUT', 'the clipboard write did not settle in 3 s')), 3000)),
    ])
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) }
  }
}

/** Ctrl on Windows/Linux, Command on macOS. */
export async function pasteModifier() {
  try {
    const info = await chrome.runtime.getPlatformInfo()
    return info?.os === 'mac' ? 4 : 2
  } catch {
    return 2
  }
}

/**
 * Insert text as a paste, without DOM injection.
 *
 * Preferred route: write the text to the OS clipboard and send a real Ctrl+V
 * whose key event carries Blink's `paste` edit command. That is the browser's
 * own paste path, so a spreadsheet explodes TSV into cells and a rich editor
 * receives one paste instead of hundreds of keystrokes. When the clipboard
 * write is unavailable, the honest fallback is CDP `Input.insertText`: one real
 * browser-level insertion at the caret, reported as `mode:"insertText"` because
 * it is not a native paste and does not trigger the page's paste handler.
 *
 * `key` text mode stops at 1000 keys; paste has a much higher cap and says so
 * when it truncates.
 */
export async function pastePage({ text, target, forceActive: forceWanted, tabId: hint }) {
  const tabId = await requirePage(hint)
  if (typeof text !== 'string' || text.length === 0) throw fail('BAD_ARGUMENT', 'paste needs text')
  const { visibility, forced } = await requireInputVisibility(tabId, 'paste', forceWanted)
  const finish = async (reply) => {
    if (forced) await clearForced(tabId, forced)
    return { ...reply, ...inputSuccess(visibility, forced) }
  }
  if (target) {
    const selector = resolveTarget(target)
    await requireEditableTarget(tabId, selector, undefined, undefined, 'paste')
  } else {
    // With no target the insertion goes to the focused element; if the page has
    // no focused element at all, nothing can receive it.
    const focused = await evaluate(tabId, '(() => { const el = document.activeElement; return !!el && el !== document.body && el !== document.documentElement })()').catch(() => false)
    if (!focused) {
      throw fail('NOT_EDITABLE', 'paste needs a focused element: click the field or cell first, or pass target. Nothing was inserted.')
    }
  }
  const points = Array.from(text)
  const truncated = points.length > PASTE_MAX_CHARS
  const body = truncated ? points.slice(0, PASTE_MAX_CHARS).join('') : text
  const chars = truncated ? PASTE_MAX_CHARS : points.length
  const meta = await pageMeta(tabId)
  const clipboard = await writeClipboardText(body)
  if (clipboard.ok) {
    const modifiers = await pasteModifier()
    const key = { key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86, modifiers }
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key, commands: ['paste'] })
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...key })
    await delay(150)
    return finish({
      url: meta?.url ?? '',
      title: meta?.title ?? '',
      chars,
      truncated,
      mode: 'clipboard',
      note: 'clipboard paste: the text was written to the OS clipboard and the browser paste edit command was sent with a real Ctrl+V key event, so the clipboard now holds this text and a spreadsheet can explode TSV into cells. '
        + 'Read the target back to confirm it landed; if nothing arrived, front the tab with bsb_tabs use so the page has focus and retry.',
    })
  }
  await send(tabId, 'Input.insertText', { text: body })
  await delay(150)
  return finish({
    url: meta?.url ?? '',
    title: meta?.title ?? '',
    chars,
    truncated,
    mode: 'insertText',
    note: 'not a native clipboard paste: the clipboard was not written and the text was inserted with CDP Input.insertText as one run at the caret. '
      + 'It does not fire the page paste handler and does not explode TSV into spreadsheet cells. '
      + `The clipboard write failed because ${clipboard.reason}.`,
  })
}

/** Resolve a click/drag endpoint from either a target/selector or a coordinate. */
export async function pagePoint(tabId, target, px, py) {
  if (Number.isFinite(Number(px)) && Number.isFinite(Number(py))) return { x: Number(px), y: Number(py) }
  if (!target) return null
  const selector = resolveTarget(target)
  const box = await evaluate(tabId, `(${boxOf.toString()})(${JSON.stringify(selector)})`)
  if (!box) throw fail('TARGET_NOT_FOUND', `no element matches ${selector}`)
  return box
}

/**
 * Press and drag from one point to another with real subdivided pointer moves.
 *
 * Sliders, jigsaw pieces and map panes only react to a pointer stream
 * (mousedown → mousemove* → mouseup); a click at the destination does nothing.
 */
export async function dragPage({ target, toTarget, x, y, toX, toY, frame, steps, holdMs, path, instant, forceActive: forceWanted, tabId: hint }) {
  const tabId = await requirePage(hint)
  const { visibility, forced } = await requireInputVisibility(tabId, 'drag', forceWanted)
  const finish = async (reply) => {
    if (forced) await clearForced(tabId, forced)
    return { ...reply, ...inputSuccess(visibility, forced) }
  }
  // A free-form path (press at the first point, glide through the rest, release
  // at the last) draws arcs, circles and signatures that a straight drag cannot.
  if (Array.isArray(path)) {
    const points = path
      .map((p) => (Array.isArray(p) ? { x: Number(p[0]), y: Number(p[1]) } : { x: Number(p?.x), y: Number(p?.y) }))
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    if (points.length < 2) throw fail('BAD_ARGUMENT', 'drag path needs at least two finite points')
    const capped = points.length > 240 ? points.filter((_, i) => i % Math.ceil(points.length / 240) === 0) : points
    const press = { type: 'mouseMoved', x: capped[0].x, y: capped[0].y }
    const down = { type: 'mousePressed', x: capped[0].x, y: capped[0].y, button: 'left', buttons: 1, clickCount: 1 }
    if (instant) {
      // Fire-and-forget: one CDP session processes messages in order, so the
      // pointer stream stays ordered without a round trip per move. Long
      // strokes then finish well inside page-side deadlines (stroke timers).
      await send(tabId, 'Input.dispatchMouseEvent', press)
      await send(tabId, 'Input.dispatchMouseEvent', down)
      for (let i = 1; i < capped.length; i += 1) {
        void send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: capped[i].x, y: capped[i].y, button: 'left', buttons: 1 }).catch(() => {})
      }
      const holdInstant = Math.min(Math.max(Number(holdMs) || 0, 0), 3000)
      if (holdInstant > 0) await delay(holdInstant)
      const lastInstant = capped[capped.length - 1]
      await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: lastInstant.x, y: lastInstant.y, button: 'left', buttons: 0, clickCount: 1 })
      await delay(250)
      const metaInstant = await pageMeta(tabId)
      return finish({ url: metaInstant?.url ?? '', title: metaInstant?.title ?? '', from: capped[0], to: lastInstant, points: capped.length, instant: true, dialog: recentDialog(tabId) })
    }
    await send(tabId, 'Input.dispatchMouseEvent', press)
    await send(tabId, 'Input.dispatchMouseEvent', down)
    for (let i = 1; i < capped.length; i += 1) {
      await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: capped[i].x, y: capped[i].y, button: 'left', buttons: 1 })
      await delay(8)
    }
    const hold = Math.min(Math.max(Number(holdMs) || 0, 0), 3000)
    if (hold > 0) await delay(hold)
    const last = capped[capped.length - 1]
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: last.x, y: last.y, button: 'left', buttons: 0, clickCount: 1 })
    await delay(250)
    const meta = await pageMeta(tabId)
    return finish({ url: meta?.url ?? '', title: meta?.title ?? '', from: capped[0], to: last, points: capped.length, dialog: recentDialog(tabId) })
  }
  let from = null
  let to = null
  let frameId = null
  if (frame) {
    const hit = await frameContext(tabId, frame)
    if (!target || !toTarget) throw fail('BAD_ARGUMENT', 'drag inside a frame needs target and toTarget selectors')
    // Resolve the destination first: scrolling it into view can move the start.
    to = await absoluteFramePoint(tabId, hit.contextId, resolveTarget(toTarget))
    from = await absoluteFramePoint(tabId, hit.contextId, resolveTarget(target))
    frameId = hit.frame.frameId
  } else {
  from = await pagePoint(tabId, target, x, y)
  if (toTarget) {
    to = await pagePoint(tabId, toTarget)
  } else if (Number.isFinite(Number(toX)) || Number.isFinite(Number(toY))) {
    // A single axis is enough for sliders: keep the other coordinate in place.
    to = {
      x: Number.isFinite(Number(toX)) ? Number(toX) : from?.x,
      y: Number.isFinite(Number(toY)) ? Number(toY) : from?.y,
    }
  }
  }
  if (!from || !to || !Number.isFinite(to.x) || !Number.isFinite(to.y)) {
    throw fail('BAD_ARGUMENT', 'drag needs a start (target or x/y) and an end (toTarget or toX and/or toY)')
  }
  const count = Math.min(Math.max(Math.trunc(Number(steps) || 14), 2), 120)
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y })
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 })
  for (let i = 1; i <= count; i += 1) {
    const pointX = from.x + ((to.x - from.x) * i) / count
    const pointY = from.y + ((to.y - from.y) * i) / count
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: pointX, y: pointY, button: 'left', buttons: 1 })
    await delay(16)
  }
  const hold = Math.min(Math.max(Number(holdMs) || 0, 0), 3000)
  if (hold > 0) await delay(hold)
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 })
  await delay(250)
  const meta = await pageMeta(tabId)
  return finish({ url: meta?.url ?? '', title: meta?.title ?? '', from, to, steps: count, ...(frameId ? { frameId } : {}), dialog: recentDialog(tabId) })
}

/**
 * Move the pointer over an element (or point) without clicking.
 *
 * Menus, tooltips and reveal-on-hover controls only open on a real pointer
 * move; keeping the pointer there is enough to read the revealed content.
 */
export async function hoverPage({ target, text, x, y, frame, forceActive: forceWanted, tabId: hint }) {
  const tabId = await requirePage(hint)
  const { visibility, forced } = await requireInputVisibility(tabId, 'hover', forceWanted)
  let point = null
  let frameId = null
  let scrolled = false
  if (frame) {
    const ctx = await frameContext(tabId, frame)
    const hasPoint = Number.isFinite(Number(x)) && Number.isFinite(Number(y))
    const local = hasPoint ? { x: Number(x), y: Number(y) } : await framePoint(tabId, ctx.contextId, { target, text })
    if (!local) throw fail('TARGET_NOT_FOUND', `nothing matched inside frame ${JSON.stringify(String(frame))}`)
    const origin = await frameOrigin(tabId, ctx.frame.frameId)
    point = { x: origin.x + local.x, y: origin.y + local.y }
    frameId = ctx.frame.frameId
  } else if (text) {
    const hit = await findTextPoint(tabId, text)
    scrolled = hit.scrolled === true
    if (scrolled) await delay(180)
    point = { x: hit.x, y: hit.y }
  } else {
    point = await pagePoint(tabId, target, x, y)
  }
  if (!point) throw fail('BAD_ARGUMENT', 'hover needs a target selector, text, or x/y')
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
  await delay(180)
  const meta = await pageMeta(tabId)
  // A null frameId is not a string, so the host tool's output schema would
  // reject the whole result. Leave the key out when the page document was hit.
  const result = { url: meta?.url ?? '', title: meta?.title ?? '', at: point, scrolled, dialog: recentDialog(tabId), ...inputSuccess(visibility, forced) }
  if (typeof frameId === 'string' && frameId) result.frameId = frameId
  if (forced) await clearForced(tabId, forced)
  return result
}

/**
 * Choose an option in a <select> by value, visible label or zero-based index.
 *
 * Native dropdowns render outside the page, so a click opens an OS menu that
 * CDP cannot address; setting the option and firing input/change is the
 * reliable path. The result reports the value that actually stuck.
 */
export async function selectOption({ target, value, label, index, frame, tabId: hint }) {
  const tabId = await requirePage(hint)
  if (!target) throw fail('BAD_ARGUMENT', 'select needs a target selector')
  const selector = resolveTarget(target)
  const ctx = frame ? await frameContext(tabId, frame) : null
  const run = ctx
    ? (expression) => evaluateInContext(tabId, ctx.contextId, expression)
    : (expression) => evaluate(tabId, expression)
  const arg = JSON.stringify({
    selector,
    value: value == null ? null : String(value),
    label: label == null ? null : String(label),
    index: index == null || index === '' ? null : Number(index),
  })
  const result = await run(`(() => {
    const arg = ${arg};
    const el = document.querySelector(arg.selector);
    if (!el) return { error: 'TARGET_NOT_FOUND' };
    if (String(el.tagName).toUpperCase() !== 'SELECT') return { error: 'NOT_A_SELECT', tag: el.tagName };
    const options = Array.from(el.options);
    let option = null;
    if (arg.index != null) option = options[arg.index] ?? null;
    else if (arg.value != null) option = options.find((o) => o.value === arg.value) ?? null;
    else if (arg.label != null) option = options.find((o) => (o.label || o.textContent || '').trim() === arg.label) ?? null;
    if (!option) return { error: 'NO_OPTION', options: options.map((o) => ({ value: o.value, label: o.label })) };
    el.value = option.value;
    option.selected = true;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { value: el.value, label: option.label, count: options.length };
  })()`)
  if (result?.error === 'TARGET_NOT_FOUND') throw fail('TARGET_NOT_FOUND', `no element matches ${selector}`)
  if (result?.error === 'NOT_A_SELECT') throw fail('NOT_A_SELECT', `${selector} is a ${result.tag}, not a <select>`)
  if (result?.error === 'NO_OPTION') {
    const available = (result.options || []).map((o) => `${o.value} (${o.label})`).join(', ')
    throw fail('NO_OPTION', `no option matches; available: ${available || '(none)'}`)
  }
  const meta = await pageMeta(tabId)
  const frameId = ctx?.frame?.frameId
  return { url: meta?.url ?? '', title: meta?.title ?? '', selector, ...(frameId ? { frameId } : {}), ...result, dialog: recentDialog(tabId) }
}

/**
 * Set a form control's value without a pointer: text inputs, textareas,
 * ranges, numbers and checkboxes/radios.
 *
 * Typing through CDP goes through the real keyboard path, which is right for
 * text a user would type but useless for a slider (no key moves a range
 * reliably) or a checkbox bound to a framework. This sets the value through
 * the prototype setter (React and Svelte store their own copy of the value, so
 * assigning `el.value` can be ignored) and fires `input` + `change`.
 */
export async function setControl({ target, value, checked, frame, tabId: hint }) {
  const tabId = await requirePage(hint)
  if (!target) throw fail('BAD_ARGUMENT', 'set needs a target selector')
  const selector = resolveTarget(target)
  const arg = JSON.stringify({
    selector,
    value: value == null ? '' : String(value),
    checked: typeof checked === 'boolean' ? checked : null,
  })
  const source = `(() => {
    const arg = ${arg};
    const walk = (sel, root) => {
      const direct = root.querySelector(sel);
      if (direct) return direct;
      for (const node of root.querySelectorAll("*")) {
        if (!node.shadowRoot) continue;
        const inner = walk(sel, node.shadowRoot);
        if (inner) return inner;
      }
      return null;
    };
    const el = walk(arg.selector, document);
    if (!el) return { error: 'TARGET_NOT_FOUND' };
    el.focus && el.focus();
    const tag = String(el.tagName).toUpperCase();
    const type = (el.type || '').toLowerCase();
    if (type === 'checkbox' || type === 'radio') {
      const want = arg.checked == null ? arg.value !== 'false' && arg.value !== '' : arg.checked;
      if (el.checked !== want) el.click();
      return { tag, type, value: el.value, checked: el.checked };
    }
    if (tag === 'TEXTAREA' || (tag === 'INPUT' && type !== 'file')) {
      const proto = tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, arg.value); else el.value = arg.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { tag, type, value: el.value, checked: false };
    }
    if (el.isContentEditable) {
      el.textContent = arg.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return { tag, type: 'contenteditable', value: el.textContent, checked: false };
    }
    return { error: 'NOT_A_CONTROL', tag, type };
  })()`
  let result
  let frameId
  if (frame) {
    const hit = await frameContext(tabId, frame)
    result = await evaluateInContext(tabId, hit.contextId, source)
    frameId = hit.frame.frameId
  } else {
    result = await evaluate(tabId, source)
  }
  if (result?.error === 'TARGET_NOT_FOUND') throw fail('TARGET_NOT_FOUND', `no element matches ${selector}`)
  if (result?.error === 'NOT_A_CONTROL') throw fail('NOT_A_CONTROL', `${selector} is a <${result.tag}${result.type ? ' type="' + result.type + '"' : ''}>, which this tool cannot set`)
  const meta = await pageMeta(tabId)
  return { url: meta?.url ?? '', title: meta?.title ?? '', selector, ...result, ...(frameId ? { frameId } : {}), dialog: recentDialog(tabId) }
}

/**
 * Input is only meaningful while the page believes it is visible.
 *
 * A hidden tab does not drop trusted input: the browser holds it and delivers it
 * when the tab is surfaced, possibly against a DOM that has moved on since the
 * call returned. That made a click report `clicks: 1` while nothing happened,
 * then fire seconds later on a different page state. Every input action
 * therefore asks this first, and a refusal is a typed error that says nothing
 * was applied. The per-action `forceActive:true` opt-in still works: it wakes
 * the page for this call only, and the reply reports what was forced and the
 * visibility the page then observed.
 */
export async function requireInputVisibility(tabId, action, forceWanted) {
  let visibility = await pageVisibility(tabId)
  let forced
  let forceError
  if (visibility === 'hidden' && forceWanted) {
    try {
      forced = await forceActive(tabId)
    } catch (error) {
      forceError = String(error?.message || error)
    }
    visibility = await pageVisibility(tabId)
  }
  if (visibility !== 'hidden') return { visibility, forced }
  const meta = await pageMeta(tabId).catch(() => null)
  let message =
    `${action} was not applied: ${describePage(meta)} is hidden (document.visibilityState is "hidden"; `
    + 'its window is minimized or another tab is in front), and the browser holds pointer and key input '
    + `for hidden pages. ${HIDDEN_HINT}.`
  if (forceError) message += ` The per-action forceActive attempt failed: ${forceError}.`
  throw fail('TAB_NOT_VISIBLE', message)
}

/**
 * Decide whether a key text run really landed.
 *
 * A reply may not say "applied" while the visible document text is shorter than
 * it was and nothing landed: that is the shape of a run that ate existing text
 * (the Docs report: 5662 -> 5103 characters, nothing inserted). The counts and a
 * short excerpt are in the error because an Error carries only a code and a
 * message across the bridge.
 */
export function keyTextVerification(before, after, prefix, sent) {
  // Without a readable page there is no claim to make: report the before length
  // and say the check could not finish, rather than implying nothing changed.
  if (!after) {
    return { textLenBefore: before.textLen, textVerified: false, textVerifyNote: 'the page could not be read after the run' }
  }
  const fields = { textLenBefore: before.textLen, textLenAfter: after.textLen, textSource: before.source || 'editor' }
  if (after.url !== before.url) {
    return { ...fields, textVerified: false, textVerifyNote: 'the page navigated during the run, so the text was delivered before it changed' }
  }
  const excerpt = after.excerpt ? JSON.stringify(after.excerpt) : '""'
  const counts = `textLenBefore: ${before.textLen}, textLenAfter: ${after.textLen}, excerpt: ${excerpt}`
  // A shorter document is never a success shape, even when the typed prefix is
  // present: that is the one symptom the Docs report had, and only the caller
  // can decide whether a replaced selection was intended.
  if (after.textLen < before.textLen) {
    throw fail(
      'EDITOR_LOST_TEXT',
      `key text left the document shorter: ${sent} key(s) were sent and the visible document text went ${before.textLen} -> ${after.textLen} characters. `
      + `${counts}. The typed prefix ${JSON.stringify(prefix)} was ${after.landed ? 'found' : 'absent'}. A success reply is not returned while the document `
      + 'is shorter than before: the editor may have replaced a selection, eaten existing text, or lost its caret. Re-read the page with bsb_read to see what remains.',
    )
  }
  if (after.badInput) {
    throw fail(
      'TEXT_NOT_APPLIED',
      `key text left the control in an invalid state: ${sent} key(s) were sent and the field reports validity.badInput with value ${JSON.stringify(after.value ?? '')}. `
      + `${counts}. A date, time or number input needs its own format (for example 2024-02-29 for a date); the keystrokes did not produce a valid value.`,
    )
  }
  if (after.landed) return { ...fields, textVerified: true }
  throw fail(
    'TEXT_NOT_APPLIED',
    `key text did not land: ${sent} key(s) were sent but the typed prefix ${JSON.stringify(prefix)} is absent from the editor text `
    + `(${before.textLen} -> ${after.textLen} characters). ${counts}. Nothing is reported as applied: the page may have cancelled the key events, `
    + 'moved the caret, or focused another control. Re-read the page, click the editor to place the caret, then retry.',
  )
}

export async function keyPage({ key, keys, text, keyDelayMs, steps, count, holdMs, target, modifiers, frame, forceActive: forceWanted, measure, settle, tabId: hint }) {
  const tabId = await requirePage(hint)
  // A framed key run lands in the frame's document, so the probe must read that
  // document; the top page's activeElement is body and looks unmeasurable.
  // The local must not be named `frameContext`: a `let` of that name shadows the
  // helper function, so the call throws and the catch silently falls back to the
  // top document, where a framed key run looks unmeasurable.
  let frameContextId
  let frameId
  if (frame !== undefined && frame !== null && String(frame).trim() !== '') {
    try {
      const hit = await frameContext(tabId, frame)
      frameContextId = hit.contextId
      frameId = hit.frame?.frameId
    } catch {}
  }
  const probeIn = async (expression) => (frameContextId === undefined
    ? evaluate(tabId, expression)
    : evaluateInContext(tabId, frameContextId, expression))
  // forceActive:true is the escape hatch for a page whose frame clock has
  // stopped (a sleeping display leaves the tab "hidden" and rAF paused, so
  // input would be held). It is never installed on attach and it never happens
  // silently: the reply carries what was forced and the visibility observed.
  const { visibility, forced } = await requireInputVisibility(tabId, 'key', forceWanted)
  // Text mode: one real key event per character. Canvas games read keydown and
  // cannot be typed into by assigning value, so expanding a string into steps
  // by hand costs one JSON object per character.
  if (typeof text === 'string' && text.length > 0
      && !key && !(Array.isArray(keys) && keys.length) && !(Array.isArray(steps) && steps.length)) {
    if (target) {
      const selector = resolveTarget(target)
      const focused = await probeIn(`(() => { const el = ${deepFindExpr(selector)}; if (!el) return false; el.focus(); return true })()`)
      if (!focused) throw fail('TARGET_NOT_FOUND', `no element matches ${selector}`)
    }
    // A long run used to be cut at 1000 keys with no marker, so a 1200-character
    // write lost its tail behind an `applied:true` reply. The cap is higher now
    // and the cut is always reported: requestedKeys, sentKeys, droppedKeys and
    // truncated travel with every text reply.
    const requested = Array.from(text)
    const chars = requested.slice(0, KEY_TEXT_CAP)
    const truncated = chars.length < requested.length
    const prefix = keyTextPrefix(text)
    // Verification only means something when the focused element is an editor
    // that owns visible text. On a canvas game (or any page whose active element
    // is body) there is no document text to compare, so the probe stays off.
    const probe = prefix ? await probeIn(keyTextProbeExpr(prefix)).catch(() => null) : null
    // A long run of per-character CDP key events is slow enough to hit the tool
    // timeout and, on at least one live fixture, crash the renderer. When the
    // focused element owns editable text and the run is long, insert the block
    // in one real input event instead. Canvas/key-driven pages keep the keydown
    // path; the reply says which path ran.
    const editableActive = await evaluate(tabId, `(() => {
      const el = document.activeElement;
      if (!el) return false;
      const tag = String(el.tagName || '').toLowerCase();
      return tag === 'input' || tag === 'textarea' || el.isContentEditable === true || el.getAttribute('role') === 'textbox';
    })()`).catch(() => false)
    let bulk = false
    if (chars.length > 200 && editableActive) {
      try {
        await send(tabId, 'Input.insertText', { text: chars.join('') })
        bulk = true
      } catch {}
    }
    const gap = Math.min(Math.max(Number(keyDelayMs) || 40, 8), 500)
    let tabs = 0
    let enters = 0
    if (!bulk) for (const ch of chars) {
      // A tab or newline in the text is a navigation key, not a printable
      // character: spreadsheet-style editing needs real Tab/Enter keydowns and a
      // keyUp for each. Anything else in the C0/DEL range has no honest mapping,
      // so it is refused instead of typed as a control character that no page
      // treats as a key.
      let control = null
      if (ch === '\t') {
        control = KEY_MAP.Tab
        tabs += 1
      } else if (ch === '\n' || ch === '\r') {
        control = KEY_MAP.Enter
        enters += 1
      } else if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(ch)) {
        const point = 'U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')
        throw fail('BAD_ARGUMENT', `key text cannot map control character ${point}: use "\\t" for Tab, "\\n" or "\\r" for Enter, or pass the key by name`)
      }
      const spec = control ?? keySpec(ch)
      const base = {
        key: spec?.key ?? ch,
        ...(spec?.code ? { code: spec.code } : {}),
        ...(Number.isFinite(spec?.vk) ? { windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk } : {}),
      }
      const printable = spec?.text ?? (control ? undefined : ch)
      const textPayload = printable !== undefined ? { text: printable, unmodifiedText: printable } : {}
      await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...textPayload })
      await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base })
      await delay(gap)
    }
    const meta = await pageMeta(tabId)
    // A canvas editor paints its text mirror on the next render tick, so reading
    // it in the same task would compare against the pre-run state.
    if (probe?.source === 'document-mirror') await delay(250)
    const after = probe?.applies === true
      ? await probeIn(keyTextProbeExpr(prefix)).catch(() => null)
      : null
    if (forced) await clearForced(tabId, forced)
    const verification = probe?.applies === true
      ? keyTextVerification(probe, after, prefix, chars.length)
      // No measurable text is not a silent omission: say the run could not be
      // checked, so a caller never mistakes an absent field for a pass.
      : {
          textVerified: false,
          textVerifyNote: probe
            ? 'the focused element is not a text editor and the page exposes no document text mirror, so the run could not be measured; confirm the result with bsb_read or bsb_capture'
            : 'the page could not be read, so the run could not be measured',
        }
    return {
      url: meta?.url ?? '', title: meta?.title ?? '', key: 'text', times: chars.length, sentKeys: chars.length,
      requestedKeys: requested.length, truncated, droppedKeys: requested.length - chars.length,
      tabs, enters, mode: bulk ? 'insertText' : 'keys', keySemantics: bulk ? 'insertText' : 'keydown-keyup',
      modifiers: [], ...(frameId ? { frameId } : {}), ...(verification ?? {}), ...inputSuccess(visibility, forced),
    }
  }
  const specFor = (raw) => {
    const name = String(raw ?? '').trim()
    const spec = keySpec(name)
    if (!spec) throw fail('BAD_ARGUMENT', `unsupported key: ${name || '(empty)'}; use a single character, a friendly name (${Object.keys(KEY_MAP).join(', ')}) or a physical event.code (KeyW, Digit4, ShiftLeft, F5, Numpad8)`)
    return spec
  }
  const stepList = Array.isArray(steps) ? steps.filter((step) => step && typeof step === 'object') : []
  const names = (Array.isArray(keys) && keys.length ? keys : [key])
    .map((raw) => String(raw ?? '').trim())
    .filter((name) => name !== '')
  const specs = names.map(specFor)
  const spec = specs[0]
  if (target) {
    const selector = resolveTarget(target)
    const focused = await evaluate(tabId, `(() => { const el = ${deepFindExpr(selector)}; if (!el) return false; el.focus(); return true })()`)
    if (!focused) throw fail('TARGET_NOT_FOUND', `no element matches ${selector}`)
  }
  const MODIFIER_BITS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 }
  const mask = (Array.isArray(modifiers) ? modifiers : [])
    .map((name) => MODIFIER_BITS[String(name).toLowerCase()])
    .filter((bit) => typeof bit === 'number')
    .reduce((all, bit) => all | bit, 0)
  const times = Math.min(Math.max(Math.trunc(Number(count) || 1), 1), 1000)
  // A held key is a different gesture from a tap: games read key-down state on
  // animation frames, so a down/up pair inside one tick never moves them. With
  // hold, the key stays down for holdMs (one press, no repeats).
  const hold = Math.min(Math.max(Number(holdMs) || 0, 0), 10000)
  const withText = specs.length === 1
  // Every key list becomes a plan: which spec, and the modifier mask its own
  // event carries. A modifier named in `keys` now sets its bit on the main key,
  // so Ctrl+Alt+1 is delivered as a chord instead of three bare keys.
  const { plan, mask: chordMask } = chordPlan(specs, mask)
  const eventFor = (item, type, eventMask = mask) => ({
    type,
    key: item.key,
    code: item.code,
    windowsVirtualKeyCode: item.vk,
    nativeVirtualKeyCode: item.vk,
    modifiers: eventMask,
    ...(withText && item.text && eventMask === 0 ? { text: item.text } : {}),
  })
  // Releasing a key is the one event a game can never recover from losing: a
  // stuck keyDown drives the avatar until it crashes. Every path that raises a
  // key therefore releases it in a finally block, retrying the release because a
  // renderer that just hung ("not responding") still receives it on recovery.
  const releaseKey = async (item, eventMask, tries = 4) => {
    for (let i = 0; i < tries; i += 1) {
      try {
        await send(tabId, 'Input.dispatchKeyEvent', eventFor(item, 'keyUp', eventMask))
        return true
      } catch {
        await delay(150)
      }
    }
    return false
  }
  const press = async (steps, holdFor) => {
    try {
      for (const step of steps) await send(tabId, 'Input.dispatchKeyEvent', eventFor(step.spec, 'keyDown', step.mask))
      if (holdFor > 0) await delay(holdFor)
    } finally {
      // Release in reverse: the key comes up before the modifiers that held it,
      // like a real chord, and each release keeps the mask its press carried.
      for (let i = steps.length - 1; i >= 0; i -= 1) await releaseKey(steps[i].spec, steps[i].upMask)
      // A throttled page can drop the keyUp even when the send resolves; the
      // repeat is idempotent for normal pages and repairs the lost event.
      await delay(24)
      for (let i = steps.length - 1; i >= 0; i -= 1) await releaseKey(steps[i].spec, steps[i].upMask)
    }
  }
  // until: hold the keys until a READ-ONLY page expression turns truthy. This is
  // the closed-loop counterpart of holdMs: a steering burst that ends on "the
  // car passed x=200" is exact where a 1200 ms hold is a guess. The expression
  // runs in the same guarded world as every other read, so it can inspect but
  // never modify the page.
  const pressUntil = async (steps, expression, deadline, contextId) => {
    try {
      for (const step of steps) await send(tabId, 'Input.dispatchKeyEvent', eventFor(step.spec, 'keyDown', step.mask))
      while (Date.now() < deadline) {
        await delay(55)
        try {
          if (await evaluateProgram(tabId, expression, { contextId })) return true
        } catch {}
      }
      return false
    } finally {
      for (let i = steps.length - 1; i >= 0; i -= 1) await releaseKey(steps[i].spec, steps[i].upMask)
      await delay(24)
      for (let i = steps.length - 1; i >= 0; i -= 1) await releaseKey(steps[i].spec, steps[i].upMask)
    }
  }
  const pressUntilMeasure = async (steps, expression, deadline, contextId) => {
    // The condition is evaluated in the page against the measurement, not in the
    // service worker: an MV3 extension may not use eval/new Function (CSP), while
    // a CDP Runtime.evaluate is allowed to run the caller's expression.
    try {
      for (const step of steps) await send(tabId, 'Input.dispatchKeyEvent', eventFor(step.spec, 'keyDown', step.mask))
      while (Date.now() < deadline) {
        await delay(90)
        try {
          const m = withVelocity(tabId, await evaluateProgram(tabId, CAR_MEASURE_EXPR, { contextId }))
          if (!m) continue
          const source = '(() => { const m = ' + JSON.stringify(m) + '; try { return Boolean(' + expression + ') } catch { return false } })()'
          if (await evaluateProgram(tabId, source, { contextId })) return true
        } catch {}
      }
      return false
    } finally {
      for (let i = steps.length - 1; i >= 0; i -= 1) await releaseKey(steps[i].spec, steps[i].upMask)
      await delay(24)
      for (let i = steps.length - 1; i >= 0; i -= 1) await releaseKey(steps[i].spec, steps[i].upMask)
    }
  }
  // Clear keys a previous call may have left down (its own hold timed out).
  // Releasing a key that was never pressed is a no-op for the page.
  for (const name of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'w', 'a', 's', 'd']) {
    try { await send(tabId, 'Input.dispatchKeyEvent', eventFor(specFor(name), 'keyUp')) } catch {}
  }
  // A recorded gesture: several press/hold/wait phases executed back-to-back in
  // ONE call. Games that steer only while accelerating need the phases to be
  // continuous — a model round trip between phases lets the car coast to a stop.
  const untilResults = []
  if (stepList.length) {
    for (const step of stepList) {
      // A step may be a pure pause ({ waitMs }) — it presses nothing.
      const raw = Array.isArray(step.keys) && step.keys.length
        ? step.keys.map((name) => String(name ?? "").trim()).filter((name) => name !== "")
        : (step.key == null || String(step.key).trim() === "" ? [] : [String(step.key).trim()])
      const list = raw.map(specFor)
      const { plan: stepPlan } = chordPlan(list, mask)
      const stepHold = Math.min(Math.max(Number(step.holdMs) || 0, 0), 10000)
      const stepUntil = typeof step.until === "string" && step.until.trim() ? step.until.trim() : ""
      const stepUntilMeasure = typeof step.untilMeasure === "string" && step.untilMeasure.trim() ? step.untilMeasure.trim() : ""
      if (stepUntilMeasure) {
        const cap = Math.min(Math.max(Number(step.timeoutMs) || 6000, 100), 60000)
        const startedAt = Date.now()
        const contextId = await guardedContext(tabId)
        const ok = await pressUntilMeasure(stepPlan, stepUntilMeasure, startedAt + cap, contextId)
        untilResults.push({ index: untilResults.length, ok, ms: Date.now() - startedAt, on: "measure" })
      } else if (stepUntil) {
        const cap = Math.min(Math.max(Number(step.timeoutMs) || 6000, 100), 60000)
        const startedAt = Date.now()
        const contextId = await guardedContext(tabId)
        const ok = await pressUntil(stepPlan, stepUntil, startedAt + cap, contextId)
        untilResults.push({ index: untilResults.length, ok, ms: Date.now() - startedAt })
      } else {
        await press(stepPlan, stepHold)
      }
      const wait = Math.min(Math.max(Number(step.waitMs) || 0, 0), 10000)
      if (wait > 0) await delay(wait)
      // A step may end with a press. The gesture's last release is the freshest
      // thing the page has done, and some UIs only accept the confirmation in
      // that instant (a car parks for two seconds before its own reset), so the
      // click has to land here instead of a model round trip later.
      const stepClick = typeof step.click === "string" && step.click.trim() ? step.click.trim() : ""
      if (stepClick) {
        try { await clickPage({ target: stepClick, tabId: hint }) } catch {}
      }
    }
  } else if (hold > 0) {
    if (!specs.length) throw fail("BAD_ARGUMENT", "key needs key or keys")
    // Several keys can be down at once: a game that drives with one key and
    // steers with another only sees the combined gesture.
    await press(plan, hold)
  } else {
    // Large repeats run at a lower interval: a 644-step slider sweep cost four calls
    for (let i = 0; i < times; i += 1) {
      await press(plan, 0)
      await delay(times > 200 ? 10 : 30)
    }
  }
  await delay(200)
  const meta = await pageMeta(tabId)
  const label = specs.map((item) => item.key).join('+')
  // measure:true is the closed-loop primitive for pixel games: one call = one
  // gesture plus a read of what changed on the canvas, so a driver never spends
  // a second round trip on a separate inspection call.
  let measurement = null
  if (measure) {
    // settle:true waits for the canvas to stop changing before reading it. A car
    // keeps coasting for seconds after the key is released, so a measurement
    // taken immediately describes a pose the next decision would already be too
    // late for. Two identical signatures 120 ms apart mean the world is still.
    if (settle) {
      try {
        const sk = await guardedContext(tabId)
        let prev; let still = 0
        for (let i = 0; i < 30 && still < 2; i += 1) {
          const sig = await evaluateProgram(tabId, CANVAS_SIGNATURE_EXPR, { contextId: sk })
          if (sig !== null && sig === prev) still += 1
          else still = 0
          prev = sig
          if (still >= 2) break
          await delay(120)
        }
      } catch {}
    }
    try {
      const contextId = await guardedContext(tabId)
      measurement = withVelocity(tabId, await evaluateProgram(tabId, CAR_MEASURE_EXPR, { contextId }))
    } catch (error) {
      measurement = { error: String(error?.message || error) }
    }
  }
  if (forced) await clearForced(tabId, forced)
  return {
    url: meta?.url ?? '', title: meta?.title ?? '', key: label, times, modifiers: chordMask, steps: stepList.length,
    measure: measurement, until: untilResults.length ? untilResults : undefined, dialog: recentDialog(tabId),
    ...inputSuccess(visibility, forced),
  }
}

/**
 * Drive a canvas game sprite to a point: a closed-loop steering controller.
 *
 * A held key is a guess: while the model is deciding, the sprite keeps moving
 * (a parking-game car coasts 300 units in one round trip). This action keeps
 * the whole loop inside the extension — every tick it reads the canvas, compares
 * the sprite's velocity heading with the bearing to (x, y) and holds exactly the
 * keys the physics needs (accelerate, steer, brake). It is game-agnostic: any
 * sprite driven with arrow keys can be steered to a coordinate, and `keys` lets
 * the caller rebind the four directions (wasd, etc.).
 */
export async function drivePage({ x, y, tol, timeoutMs, maxSpeed, untilMeasure, click, keys, route, tabId: hint }) {
  const tabId = await requirePage(hint)
  const legs = []
  if (Array.isArray(route) && route.length) {
    for (const step of route) {
      const lx = Number(step && step.x)
      const ly = Number(step && step.y)
      if (!Number.isFinite(lx) || !Number.isFinite(ly)) throw fail('BAD_ARGUMENT', 'route legs need numeric x and y')
      legs.push({ x: lx, y: ly, tol: step.tol, maxSpeed: step.maxSpeed, untilMeasure: step.untilMeasure })
    }
  } else {
    const tx0 = Number(x)
    const ty0 = Number(y)
    if (!Number.isFinite(tx0) || !Number.isFinite(ty0)) throw fail('BAD_ARGUMENT', 'drive needs numeric x and y (or a route)')
    legs.push({ x: tx0, y: ty0, tol, maxSpeed, untilMeasure })
  }
  const fallbackTol = Number(tol)
  const fallbackCap = Number(maxSpeed)
  const bind = (input, fallback) => {
    const name = String(input ?? fallback).trim()
    if (!keySpec(name)) throw fail('BAD_ARGUMENT', 'unsupported key: ' + name)
    return name
  }
  const bindKeys = keys && typeof keys === 'object' ? keys : {}
  const K = {
    up: bind(bindKeys.up, 'ArrowUp'),
    down: bind(bindKeys.down, 'ArrowDown'),
    left: bind(bindKeys.left, 'ArrowLeft'),
    right: bind(bindKeys.right, 'ArrowRight'),
  }
  const contextId = await guardedContext(tabId)
  const held = new Map()
  const keyDown = async (name) => {
    if (held.has(name)) return
    const s = keySpec(name)
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: s.key, code: s.code, windowsVirtualKeyCode: s.vk, nativeVirtualKeyCode: s.vk, modifiers: 0 })
    held.set(name, s)
  }
  const keyUp = async (name) => {
    if (!held.has(name)) return
    const s = held.get(name)
    held.delete(name)
    try { await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: s.key, code: s.code, windowsVirtualKeyCode: s.vk, nativeVirtualKeyCode: s.vk, modifiers: 0 }) } catch {}
  }
  // A stuck keyUp is unrecoverable (the sprite drives until it crashes), so every
  // exit path releases twice with a delay between, like the gesture presser.
  const releaseAll = async () => {
    for (const name of [...held.keys()]) await keyUp(name)
    await delay(24)
    for (const name of [...held.keys()]) await keyUp(name)
  }
  const wrap = (a) => {
    while (a > Math.PI) a -= Math.PI * 2
    while (a < -Math.PI) a += Math.PI * 2
    return a
  }
  // Friction alone leaves a long coast and a coasting sprite eventually drifts
  // into a wall (which resets the level) while the model thinks. Braking by
  // reverse thrust also accelerates the sprite backwards once it has stopped, so
  // the direction is verified from the measured speed and flipped when wrong.
  const readSpeed = async () => {
    try {
      const m = withVelocity(tabId, await evaluateProgram(tabId, CAR_MEASURE_EXPR, { contextId }))
      const c = m && m.car
      return c ? Math.hypot(Number(c.vx) || 0, Number(c.vy) || 0) : 0
    } catch {
      return 0
    }
  }
  // Stop a coasting sprite without launching it the other way.
  //
  // Reverse thrust is a real brake only while the sprite is fast. Held
  // continuously it decelerates through zero and then accelerates the sprite
  // backwards — which is how a freshly parked car got reversed straight back
  // out of the bay it had just reached. So: coast on friction first (most
  // sprites stop in a few frames), and pulse the brake only above 25 u/s.
  const bringToRest = async (budgetMs) => {
    const deadline = Date.now() + (budgetMs || 1500)
    await releaseAll()
    let prev = await readSpeed()
    while (Date.now() < deadline && prev >= 4) {
      if (prev > 25) {
        await keyDown(K.down)
        await delay(70)
        await keyUp(K.down)
      } else {
        await delay(110)
      }
      const now = await readSpeed()
      // Speed climbing while braking means the thrust is pushing the sprite the
      // wrong way; stop braking and let friction finish.
      if (now > prev + 3) break
      prev = now
    }
    await releaseAll()
  }
  const startedAt = Date.now()
  const trace = []
  const legsReport = []
  let ticks = 0
  let car = null
  let ok = false
  let reason = 'timeout'
  try {
    for (let li = 0; li < legs.length; li++) {
      const leg = legs[li]
      const tx = leg.x
      const ty = leg.y
      const tolerance = Math.min(Math.max(Number(leg.tol) || fallbackTol || 12, 2), 200)
      const globalCap = Math.min(Math.max(Number(leg.maxSpeed) || fallbackCap || 90, 10), 400)
      const cap = Math.min(Math.max(Number(timeoutMs) || 20000, 500), 120000)
      const legStart = Date.now()
      let heading = null
      let stuckTicks = 0
      let prevPos = null
      let movingCommanded = false
      let brakeKey = K.down
      let lastSpeed = 0
      let braking = false
      let prevBrakeSpeed = 0
      let escapeUntil = 0
      let escapeTurn = null
      let legOk = false
      let legReason = 'timeout'
      while (Date.now() - legStart < cap) {
        ticks += 1
        try {
          const m = withVelocity(tabId, await evaluateProgram(tabId, CAR_MEASURE_EXPR, { contextId }))
          car = m && m.car ? m.car : null
        } catch {
          car = null
        }
        if (!car) { legReason = 'no-sprite'; break }
        const vx = Number(car.vx) || 0
        const vy = Number(car.vy) || 0
        const speed = Math.hypot(vx, vy)
        // Track the heading down to walking pace: a slow final approach used to
        // keep whatever heading was last sampled above 20 u/s, so the controller
        // steered against a stale bearing and drifted sideways into the wall it
        // was trying to park beside. Low-pass it because a centroid velocity at
        // creep speed is noisy.
        if (speed > 4) {
          const sampled = Math.atan2(vy, vx)
          heading = heading == null ? sampled : heading + wrap(sampled - heading) * 0.45
        }
        const dx = tx - car.cx
        const dy = ty - car.cy
        const dist = Math.hypot(dx, dy)
        const err = heading == null ? 0 : wrap(Math.atan2(dy, dx) - heading)
        if (ticks <= 10 || ticks % 10 === 0) {
          trace.push({ t: Date.now() - startedAt, leg: li, cx: car.cx, cy: car.cy, dist: Math.round(dist), speed: Math.round(speed), err: Math.round((err * 180) / Math.PI) })
        }
        if (leg.untilMeasure) {
          try {
            const source = '(() => { const m = ' + JSON.stringify({ car }) + '; try { return Boolean(' + leg.untilMeasure + ') } catch { return false } })()'
            if (await evaluateProgram(tabId, source, { contextId })) { legOk = true; legReason = 'until-measure'; break }
          } catch {}
        }
        if (dist <= tolerance && speed <= 34) { legOk = true; legReason = 'arrived'; break }
        // Brake early: the sprite coasts, and a full-speed arrival overshoots the
        // point by the distance it needs to shed. Near the target the cap drops so
        // the last metres are slow enough to stop inside a parking bay.
        const align = Math.cos(err)
        const aimCap = align < 0.9 ? globalCap * (0.3 + 0.6 * Math.max(0, align)) : globalCap
        const localCap = Math.min(globalCap, 8 + dist * 0.45, aimCap)
        const stopping = (speed * speed) / (2 * 30)
        // Reverse thrust brakes a forward-moving sprite but accelerates one that
        // is already reversing, which turns into a runaway (>120 u/s). Watch the
        // speed across a brake tick and flip the brake key when it climbs.
        if (braking && speed > 25 && speed > prevBrakeSpeed + 3) brakeKey = brakeKey === K.down ? K.up : K.down
        prevBrakeSpeed = speed
        braking = false
        const wanted = new Set()
        // Stuck recovery: a sprite pinned against a wall has speed 0 while the
        // accelerator is held, and no amount of steering helps — reversing out is
        // the only way free. Detect that as "commanded to accelerate but not
        // moving", NOT as "slow": a low maxSpeed legitimately holds the sprite
        // under 12 u/s, and treating slowness as stuck made the controller
        // reverse out of a perfectly good slow approach (the sprite then
        // wandered off and finally crashed into a wall).
        const moved = prevPos === null ? 99 : Math.hypot(car.cx - prevPos.x, car.cy - prevPos.y)
        prevPos = { x: car.cx, y: car.cy }
        if (movingCommanded && moved < 0.6 && dist > tolerance) stuckTicks += 1
        else stuckTicks = 0
        if (stuckTicks >= 6) {
          escapeUntil = Date.now() + 650
          escapeTurn = err >= 0 ? K.right : K.left
          stuckTicks = 0
        }
        if (Date.now() < escapeUntil) {
          wanted.add(K.down)
          wanted.add(escapeTurn)
        } else if (align < 0.55) {
          // Car-like sprites only rotate while they move, so slowing down to turn
          // deadlocks (no speed -> no rotation -> no alignment). Keep the
          // accelerator down and steer — but cap the turn speed, because an
          // unbraked circle at full speed has too wide a radius to ever align.
          const turnCap = Math.min(globalCap, 45)
          if (speed > turnCap) { wanted.add(brakeKey); braking = true }
          else wanted.add(K.up)
          if (err > 0) wanted.add(K.right)
          else wanted.add(K.left)
        } else if (speed > localCap + 6 && dist < 220) { wanted.add(brakeKey); braking = true }
        else if (speed > localCap + 1.5) {
          // Between the cap and the brake threshold: coast on friction and keep
          // steering. Braking here overshoots the other way, so the sprite
          // shudders around the cap instead of holding a steady creep.
          if (err > 0.1) wanted.add(K.right)
          else if (err < -0.1) wanted.add(K.left)
        } else if (speed > 34 && dist < stopping) { wanted.add(brakeKey); braking = true }
        else {
          wanted.add(K.up)
          if (err > 0.1) wanted.add(K.right)
          else if (err < -0.1) wanted.add(K.left)
        }
        for (const name of [...held.keys()]) if (!wanted.has(name)) await keyUp(name)
        for (const name of wanted) await keyDown(name)
        movingCommanded = wanted.has(K.up)
        await delay(35)
      }
      await releaseAll()
      legsReport.push({ leg: li, x: tx, y: ty, ok: legOk, reason: legReason, ms: Date.now() - legStart })
      if (!legOk) { reason = 'leg-' + li + '-' + legReason; break }
      ok = true
      reason = legs.length > 1 ? 'route' : legReason
      // Settle between legs: the controller hands back a coasting sprite, so shed
      // the remaining speed while the next leg is being set up.
      if (li < legs.length - 1) await bringToRest(1200)
    }
  } finally {
    await releaseAll()
  }
  // Friction alone leaves a long coast, and a coasting sprite drifts into walls
  // while the model thinks. Bring the speed down before anything else happens.
  if (ok) await bringToRest(2000)
  let pressed = null
  if (ok && click) {
    try { await clickPage({ target: click, tabId: hint }); pressed = click } catch {}
  }
  const last = legs[legs.length - 1]
  return {
    ok,
    reason,
    ms: Date.now() - startedAt,
    ticks,
    tol: Math.min(Math.max(Number(last.tol) || fallbackTol || 12, 2), 200),
    target: { x: last.x, y: last.y },
    car,
    legs: legsReport,
    trace,
    click: pressed,
  }
}

/**
 * Read the canvas-game measurement without sending any input.
 *
 * `drive` and `key {measure:true}` report the sprite after a gesture, but an
 * interactive game loop also needs a pure observation between gestures ("where
 * did the sprite end up after that burst?"). Sending a key just to read the
 * state perturbs exactly the thing being measured, so this is the read-only
 * counterpart: same measurement, no key events, optional settle.
 */
export async function measurePage({ settle, tabId: hint } = {}) {
  const tabId = await requirePage(hint)
  const contextId = await guardedContext(tabId)
  if (settle) {
    // Poll the raw measurement until the sprite stops moving (or ~3.5 s pass),
    // then take one withVelocity read so vx/vy describe the resting pose.
    const started = Date.now()
    let prev = ''
    let calm = 0
    while (Date.now() - started < 3500) {
      const m = await evaluateProgram(tabId, CAR_MEASURE_EXPR, { contextId })
      const car = m && m.car
      const sig = car ? `${Math.round(car.cx * 2)},${Math.round(car.cy * 2)}` : ''
      if (sig && sig === prev) { if (++calm >= 2) break } else calm = 0
      prev = sig
      await delay(110)
    }
  }
  return withVelocity(tabId, await evaluateProgram(tabId, CAR_MEASURE_EXPR, { contextId }))
}

/** Scroll the page to x/y, or bring a selector into view. */
export async function scrollPage({ selector, x, y, frame, tabId: hint }) {
  const tabId = await requirePage(hint)
  const pointX = Number.isFinite(Number(x)) ? Number(x) : null
  const pointY = Number.isFinite(Number(y)) ? Number(y) : null
  if (frame) {
    const ctx = await frameContext(tabId, frame)
    if (typeof selector === 'string' && selector.length > 0) {
      const sel = resolveTarget(selector)
      const box = await evaluateInContext(tabId, ctx.contextId, `(() => {
        const el = document.querySelector(${JSON.stringify(sel)});
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY), pageHeight: document.documentElement.scrollHeight };
      })()`)
      if (!box) throw fail('TARGET_NOT_FOUND', `no element matches ${selector} inside the frame`)
      const origin = await frameOrigin(tabId, ctx.frame.frameId)
      return { frameId: ctx.frame.frameId, ...box, pageX: origin.x + box.x, pageY: origin.y + box.y }
    }
    const pos = await evaluateInContext(tabId, ctx.contextId, `(() => {
      window.scrollTo(${pointX ?? 'window.scrollX'}, ${pointY ?? 'window.scrollY'});
      return { scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY), pageHeight: document.documentElement.scrollHeight };
    })()`)
    await delay(100)
    return { frameId: ctx.frame.frameId, ...pos }
  }
  if (typeof selector === 'string' && selector.length > 0) {
    const box = await evaluate(tabId, `(() => {
      const el = ${deepFindExpr(selector)};
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY) };
    })()`)
    if (!box) throw fail('TARGET_NOT_FOUND', `no element matches ${selector}`)
    return box
  }
  const pos = await evaluate(tabId, `(() => {
    window.scrollTo(${pointX ?? 'window.scrollX'}, ${pointY ?? 'window.scrollY'});
    return { scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY), pageHeight: document.documentElement.scrollHeight };
  })()`)
  await delay(100)
  return pos
}

/** Same-origin path: walk window.frameElement up and sum viewport rects. */
export async function absoluteFramePoint(tabId, contextId, selector) {
  return evaluateInContext(tabId, contextId, `(() => {
    const el = (${deepFindExpr(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const chain = [];
    let w = window;
    while (w !== w.parent) {
      let fe = null;
      try { fe = w.frameElement } catch { return null }
      if (!fe) return null;
      chain.push(fe);
      w = fe.ownerDocument.defaultView;
      if (chain.length > 8) return null;
    }
    for (const fe of chain) fe.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    let x = r.left + r.width / 2, y = r.top + r.height / 2;
    for (const fe of chain) {
      const fr = fe.getBoundingClientRect();
      const cs = fe.ownerDocument.defaultView.getComputedStyle(fe);
      x += fr.left + (parseFloat(cs.borderLeftWidth) || 0);
      y += fr.top + (parseFloat(cs.borderTopWidth) || 0);
    }
    return { x, y, depth: chain.length };
  })()`)
}

/** Scroll the frame's boxes into view in every ancestor document, then sum their offsets. */
export async function revealFramePath(tabId, frameId, { scroll = true } = {}) {
  const chain = await frameChain(tabId, frameId)
  if (scroll) {
    for (let i = chain.length - 2; i >= 0; i -= 1) {
      const ctx = await contextForFrame(tabId, chain[i].frameId)
      await evaluateInContext(tabId, ctx, ownerRectExpr(chain[i + 1]))
      await delay(120)
    }
  }
  const offset = { x: 0, y: 0 }
  for (let i = 0; i < chain.length - 1; i += 1) {
    const ctx = await contextForFrame(tabId, chain[i].frameId)
    const rect = await evaluateInContext(tabId, ctx, ownerRectExpr(chain[i + 1]))
    if (!rect) throw fail('FRAME_NOT_FOUND', 'could not locate the frame element')
    offset.x += rect.x
    offset.y += rect.y
  }
  return offset
}

/** Resolve a selector or visible text to a point inside a child frame. */
export async function framePoint(tabId, contextId, { target, text }) {
  if (target) {
    const selector = resolveTarget(target)
    const box = await evaluateInContext(tabId, contextId, `(${boxOf.toString()})(${JSON.stringify(selector)})`)
    return box ? { x: box.x, y: box.y } : null
  }
  if (text) {
    const hit = await evaluateInContext(tabId, contextId, `(() => {
      const want = ${JSON.stringify(String(text))}.toLowerCase();
      const nodes = document.querySelectorAll('button, a, input[type="submit"], input[type="button"], label, span, p, div, li, td, th, h1, h2, h3');
      const hits = [];
      for (const el of nodes) {
        if (!el.offsetParent) continue;
        const raw = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
        if (!raw) continue;
        if (raw.length > 160 && el.tagName !== 'BUTTON') continue;
        if (el.querySelector && el.querySelector('button, a, input, select, textarea')) continue;
        const lower = raw.toLowerCase();
        if (lower !== want && !lower.includes(want)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        hits.push({ el, area: r.width * r.height, exact: lower === want });
      }
      if (!hits.length) return null;
      hits.sort((a, b) => (b.exact - a.exact) || (a.area - b.area));
      const chosen = hits[0].el;
      chosen.scrollIntoView({ block: 'center', inline: 'center' });
      const r = chosen.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`)
    return hit ? { x: hit.x, y: hit.y } : null
  }
  throw fail('BAD_ARGUMENT', 'frame targeting needs target or text')
}

/**
 * Drop files (or text) onto a target the way a drag-and-drop zone expects:
 * dragEnter → dragOver → drop with real drag data. Mouse-based drags cannot
 * reach zones that listen only to HTML5 DnD events.
 */
export async function dropAt(tabId, point, files, text, mimeType, frameId) {
  const list = Array.isArray(files) ? files.map(String).filter(Boolean) : []
  const payload = {
    items: [{
      mimeType: String(mimeType || (text ? 'text/plain' : 'application/octet-stream')),
      data: String(text ?? ''),
      title: '',
    }],
    dragOperationsMask: 1,
  }
  if (list.length) payload.files = list
  const base = { x: point.x, y: point.y, data: payload }
  await send(tabId, 'Input.dispatchDragEvent', { type: 'dragEnter', ...base })
  await send(tabId, 'Input.dispatchDragEvent', { type: 'dragOver', ...base })
  await delay(120)
  await send(tabId, 'Input.dispatchDragEvent', { type: 'drop', ...base })
  await delay(300)
  const meta = await pageMeta(tabId)
  return {
    url: meta?.url ?? '',
    title: meta?.title ?? '',
    dropped: { x: point.x, y: point.y, files: list, text: text ?? null },
    dialog: recentDialog(tabId),
  }}

export async function dropPage({ target, x, y, files, text, mimeType, frame, forceActive: forceWanted, tabId: hint }) {
  const tabId = await requirePage(hint)
  const { visibility, forced } = await requireInputVisibility(tabId, 'drop', forceWanted)
  let frameId
  if (frame) {
    throw fail('UNSUPPORTED', 'drag-and-drop into a child frame is not supported: Chrome DevTools drag events are dispatched to the top-level renderer and do not enter subframes')
  }
  let point = null
  if (Number.isFinite(Number(x)) && Number.isFinite(Number(y))) {
    point = { x: Number(x), y: Number(y) }
  } else if (target) {
    const selector = resolveTarget(target)
    const box = await evaluate(tabId, `(${boxOf.toString()})(${JSON.stringify(selector)})`)
    if (!box) throw fail('TARGET_NOT_FOUND', `no element matches ${selector}`)
    point = { x: box.x, y: box.y }
  } else {
    throw fail('BAD_ARGUMENT', 'drop needs a target or x/y')
  }
  const dropped = await dropAt(tabId, point, files, text, mimeType)
  if (forced) await clearForced(tabId, forced)
  return { ...dropped, ...inputSuccess(visibility, forced) }
}
