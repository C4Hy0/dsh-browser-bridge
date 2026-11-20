// Browser Bridge worker: commands/input/scroll.js.
// Keep the module boundaries in docs/SPEC.md in sync.
import { requireInputVisibility } from './shared.js'
import { requirePage } from '../tabs.js'
import { clearForced, evaluate, evaluateInContext, frameContext, frameOrigin, pageMeta, send } from '../../lib/cdp.js'
import { delay, fail, inputSuccess, resolveTarget } from '../../lib/util.js'

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
  const positionExpr = `(() => {
    const at = document.elementFromPoint(${px}, ${py});
    let node = at;
    while (node && node !== document.scrollingElement) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 2) {
        return { y: node.scrollTop, x: node.scrollLeft, kind: 'element' };
      }
      node = node.parentElement;
    }
    return { y: scrollY, x: scrollX, kind: 'window' };
  })()`
  const before = await evaluate(tabId, positionExpr).catch(() => null)
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
  // A wheel event is dispatched before the renderer applies its scroll; a single
  // read after a short delay reports the previous position and marks a moving
  // page as unscrollable. Poll until the position changes, then settle.
  let after = null
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await delay(100)
    const pos = await evaluate(tabId, positionExpr).catch(() => null)
    if (pos && before && (pos.x !== before.x || pos.y !== before.y)) {
      await delay(80)
      after = await evaluate(tabId, positionExpr).catch(() => pos) ?? pos
      break
    }
    after = pos
  }
  const scrolled = Boolean(before && after && (before.x !== after.x || before.y !== after.y))
  const meta = await pageMeta(tabId)
  if (forced) await clearForced(tabId, forced)
  return {
    url: meta?.url ?? '', title: meta?.title ?? '', at: { x: px, y: py }, deltaX: dx, deltaY: dy, modifiers: mask,
    before, after, scrolled, ...inputSuccess(visibility, forced), applied: scrolled,
    ...(scrolled ? {} : { reason: 'no scrollable target moved at that point; the wheel event was dispatched but nothing scrolled (a fixed overlay or a non-scrollable region)' }),
  }
}

/** Scroll the page to x/y, or bring a selector into view. */
export async function scrollPage({ selector, x, y, frame, tabId: hint }) {
  const tabId = await requirePage(hint)
  const pointX = Number.isFinite(Number(x)) ? Number(x) : null
  const pointY = Number.isFinite(Number(y)) ? Number(y) : null
  const targetExpr = (sel) => `(() => {
    const matches = [];
    const collect = (root) => {
      for (const el of root.querySelectorAll(${JSON.stringify(sel)})) matches.push(el);
      for (const host of root.querySelectorAll('*')) if (host.shadowRoot) collect(host.shadowRoot);
    };
    try { collect(document) } catch { return { matchedCount: 0, rendered: 0 }; }
    const rendered = matches.map((el) => ({ el, r: el.getBoundingClientRect() })).filter((entry) => entry.r.width >= 2 && entry.r.height >= 2);
    if (!rendered.length) return { matchedCount: matches.length, rendered: 0, scrolled: false, reason: 'all matches are zero-size or hidden' };
    const visible = rendered.find(({ r }) => r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth);
    const pick = visible || rendered[0];
    const before = { x: Math.round(scrollX), y: Math.round(scrollY) };
    pick.el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = pick.el.getBoundingClientRect();
    return {
      matchedCount: matches.length, rendered: rendered.length, before,
      scrollX: Math.round(scrollX), scrollY: Math.round(scrollY),
      x: r.left + r.width / 2, y: r.top + r.height / 2,
      scrolled: before.x !== Math.round(scrollX) || before.y !== Math.round(scrollY),
      pageHeight: document.documentElement.scrollHeight,
    };
  })()`
  if (frame) {
    const ctx = await frameContext(tabId, frame)
    if (typeof selector === 'string' && selector.length > 0) {
      const sel = resolveTarget(selector, tabId)
      const box = await evaluateInContext(tabId, ctx.contextId, targetExpr(sel))
      if (!box || box.matchedCount === 0) throw fail('TARGET_NOT_FOUND', `no element matches ${selector} inside the frame`)
      if (box.rendered === 0) return { frameId: ctx.frame.frameId, ...box }
      const origin = await frameOrigin(tabId, ctx.frame.frameId)
      return { frameId: ctx.frame.frameId, ...box, pageX: origin.x + box.x, pageY: origin.y + box.y }
    }
    const before = await evaluateInContext(tabId, ctx.contextId, '({ x: Math.round(window.scrollX), y: Math.round(window.scrollY) })')
    const pos = await evaluateInContext(tabId, ctx.contextId, `(() => {
      window.scrollTo(${pointX ?? 'window.scrollX'}, ${pointY ?? 'window.scrollY'});
      return { x: Math.round(window.scrollX), y: Math.round(window.scrollY), pageHeight: document.documentElement.scrollHeight };
    })()`)
    await delay(100)
    const after = await evaluateInContext(tabId, ctx.contextId, '({ x: Math.round(window.scrollX), y: Math.round(window.scrollY) })')
    return { frameId: ctx.frame.frameId, before, after, scrollX: after.x, scrollY: after.y, moved: before.x !== after.x || before.y !== after.y, pageHeight: pos.pageHeight }
  }
  if (typeof selector === 'string' && selector.length > 0) {
    const sel = resolveTarget(selector, tabId)
    const box = await evaluate(tabId, targetExpr(sel))
    if (!box || box.matchedCount === 0) throw fail('TARGET_NOT_FOUND', `no element matches ${selector}`)
    return box
  }
  const before = await evaluate(tabId, '({ x: Math.round(window.scrollX), y: Math.round(window.scrollY) })')
  const pos = await evaluate(tabId, `(() => {
    window.scrollTo(${pointX ?? 'window.scrollX'}, ${pointY ?? 'window.scrollY'});
    return { x: Math.round(window.scrollX), y: Math.round(window.scrollY), pageHeight: document.documentElement.scrollHeight };
  })()`)
  await delay(100)
  const after = await evaluate(tabId, '({ x: Math.round(window.scrollX), y: Math.round(window.scrollY) })')
  return { before, after, scrollX: after.x, scrollY: after.y, moved: before.x !== after.x || before.y !== after.y, pageHeight: pos.pageHeight }
}
