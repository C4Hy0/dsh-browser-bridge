// Browser Bridge worker: commands/input/shared.js.
// Keep the module boundaries in docs/SPEC.md in sync.
import { contextForFrame, evaluate, evaluateInContext, forceActive, frameChain, pageMeta, send, waitEvent, waitReady } from '../../lib/cdp.js'
import { HIDDEN_HINT, OFFSCREEN_EDITOR_HINT, PASTE_OFFSCREEN_HINT } from '../../lib/constants.js'
import { ACTIVE_ELEMENT_EXPR, PAGE_FINGERPRINT_EXPR, boxOf, deepFindExpr, editableTargetExpr, mapAreaAt, ownerRectExpr, textCandidatesExpr } from '../../lib/page.js'
import { pageVisibility } from '../../lib/page-state.js'
import { delay, describePage, fail, recentDialog, resolveTarget } from '../../lib/util.js'

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

/** Resolve a click/drag endpoint from either a target/selector or a coordinate. */
export async function pagePoint(tabId, target, px, py) {
  if (Number.isFinite(Number(px)) && Number.isFinite(Number(py))) return { x: Number(px), y: Number(py) }
  if (!target) return null
  const selector = resolveTarget(target, tabId)
  const box = await evaluate(tabId, `(${boxOf.toString()})(${JSON.stringify(selector)})`)
  if (!box) throw fail('TARGET_NOT_FOUND', `no element matches ${selector}`)
  return box
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
    const selector = resolveTarget(target, tabId)
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
