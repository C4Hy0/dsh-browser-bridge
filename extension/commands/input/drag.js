// Browser Bridge worker: commands/input/drag.js.
// Keep the module boundaries in docs/SPEC.md in sync.
import { absoluteFramePoint, dropAt, pagePoint, requireInputVisibility } from './shared.js'
import { requirePage } from '../tabs.js'
import { clearForced, evaluate, frameContext, pageMeta, send } from '../../lib/cdp.js'
import { boxOf } from '../../lib/page.js'
import { delay, fail, inputSuccess, recentDialog, resolveTarget } from '../../lib/util.js'

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
