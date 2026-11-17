// Browser Bridge worker: commands/input/scroll.js.
// Keep the module boundaries in docs/SPEC.md in sync.
import { requireInputVisibility } from './shared.js'
import { requirePage } from '../tabs.js'
import { clearForced, evaluate, evaluateInContext, frameContext, frameOrigin, pageMeta, send } from '../../lib/cdp.js'
import { deepFindExpr } from '../../lib/page.js'
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
