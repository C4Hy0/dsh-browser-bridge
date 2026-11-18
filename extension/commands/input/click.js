// Browser Bridge worker: commands/input/click.js.
// Keep the module boundaries in docs/SPEC.md in sync.
import { absoluteFramePoint, findTextPoint, fingerprintChanged, followMapArea, framePoint, pageFingerprint, pagePoint, pressAt, requireInputVisibility, revealFramePath } from './shared.js'
import { requirePage } from '../tabs.js'
import { clearForced, ensureLayout, evaluate, frameContext, frameOrigin, pageMeta, send } from '../../lib/cdp.js'
import { CLICK_UNCHANGED_HINT } from '../../lib/constants.js'
import { boxOf } from '../../lib/page.js'
import { delay, fail, inputSuccess, recentCreatedTab, recentDialog, resolveTarget } from '../../lib/util.js'

export async function clickPage({ target, text, x, y, frame, count, targets, all, button, holdMs, verify, forceActive: forceWanted, tabId: hint }) {
  const tabId = await requirePage(hint)
  // Only a dialog that opens during this call is part of this reply; an older
  // auto-dismissed dialog must not be echoed as if this click caused it.
  const startedAt = Date.now()
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
      picks.push({ selector: resolveTarget(item, tabId) })
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
    return finish({ url: batchMeta?.url ?? '', title: batchMeta?.title ?? '', clicked, clicks: clicked.length, windowRestored: layout.restored, dialog: recentDialog(tabId, startedAt) }, beforePrint)
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
    return finish({ url: meta?.url ?? '', title: meta?.title ?? '', clickedAt: { x: px, y: py }, clicks: taps, windowRestored: layout.restored, dialog: recentDialog(tabId, startedAt), followed }, beforePrint)
  }
  // Frames: the element lives in a child document, but the pointer is global —
  // resolve the point locally, then offset it by the frame's box in this page.
  if (frame) {
    const { frame: hit, contextId } = await frameContext(tabId, frame)
    let px, py
    if (target) {
      // Same-origin frames can be resolved in one pass: scroll every level, then
      // sum each frame element's viewport rect. This is exact for nested frames.
      const direct = await absoluteFramePoint(tabId, contextId, resolveTarget(target, tabId))
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
    return finish({ url: meta?.url ?? '', title: meta?.title ?? '', frameId: hit.frameId, clickedAt: { x: px, y: py }, clicks: taps, windowRestored: layout.restored, dialog: recentDialog(tabId, startedAt) }, beforePrint)
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
      clickedAt: { x: hit.x, y: hit.y }, clicks: taps, windowRestored: layout.restored, dialog: recentDialog(tabId, startedAt),
      ...(opened ? { newTabId: opened.id, newTabUrl: opened.url || undefined, hint: 'the click opened a new tab; it is not tracked. Use bsb_tabs use with newTabId to adopt it.' } : {}),
    }, beforePrint)
  }
  const selector = resolveTarget(target, tabId)
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
    return finish({ url: allMeta?.url ?? '', title: allMeta?.title ?? '', clicked: pressed, clicks: pressed.length, matchedCount: points.length, windowRestored: layout.restored, dialog: recentDialog(tabId, startedAt) }, beforePrint)
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
    dialog: recentDialog(tabId, startedAt), followed,
    ...(opened ? { newTabId: opened.id, newTabUrl: opened.url || undefined, hint: 'the click opened a new tab; it is not tracked. Use bsb_tabs use with newTabId to adopt it.' } : {}),
  }, beforePrint)
}

/**
 * Move the pointer over an element (or point) without clicking.
 *
 * Menus, tooltips and reveal-on-hover controls only open on a real pointer
 * move; keeping the pointer there is enough to read the revealed content.
 */
export async function hoverPage({ target, text, x, y, frame, forceActive: forceWanted, tabId: hint }) {
  const tabId = await requirePage(hint)
  const startedAt = Date.now()
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
  const result = { url: meta?.url ?? '', title: meta?.title ?? '', at: point, scrolled, dialog: recentDialog(tabId, startedAt), ...inputSuccess(visibility, forced) }
  if (typeof frameId === 'string' && frameId) result.frameId = frameId
  if (forced) await clearForced(tabId, forced)
  return result
}
