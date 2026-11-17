// Browser Bridge worker: feed.
// Split from extension/sw.js; keep the module boundaries in docs/SPEC.md in sync.
import { evaluate, forceActive, pageMeta, releaseActive } from '../cdp.js'
import { FEED_HIDDEN_HINT, FEED_UNKEYED_HINT } from '../constants.js'
import { feedCollect, feedScroll } from '../page.js'
import { pageVisibility } from '../page-state.js'
import { shared } from '../state.js'
import { requirePage } from './tabs.js'
import { delay, fail } from '../util.js'

/**
 * Fold one DOM read into the feed collection.
 *
 * Dedupe happens on the item key, so a virtualized list that recycles nodes
 * across scroll steps returns each key once. `recycled` counts distinct keys
 * that were collected and then disappeared from a later DOM read: it tells the
 * caller whether the surface is smaller than the list it stands for.
 */
export function feedMerge(state, read) {
  const items = Array.isArray(read && read.items) ? read.items : []
  state.skippedHidden = (state.skippedHidden ?? 0) + (Number(read?.skippedHidden) || 0)
  const current = new Set()
  let added = 0
  for (const item of items) {
    if (!item || typeof item.key !== 'string' || !item.key) continue
    current.add(item.key)
    if (state.keys.has(item.key)) {
      state.duplicatesDropped += 1
      continue
    }
    // The cap is a hard bound on the reply, so extra keys in the same read are
    // dropped rather than collected past it.
    if (state.items.length >= state.cap) continue
    state.keys.add(item.key)
    state.items.push(item)
    added += 1
  }
  for (const key of state.previousKeys) {
    if (current.has(key)) continue
    if (!state.keys.has(key) || state.recycledKeys.has(key)) continue
    state.recycledKeys.add(key)
    state.recycled += 1
  }
  state.previousKeys = current
  return added
}

/**
 * Scroll-and-collect a virtualized list, in one call, without a caller loop.
 *
 * Read-only: it scrolls the page's own scroller and reads the DOM, nothing else.
 * A hidden tab is not woken unless the caller asks with forceActive:true, and a
 * hold started here is released before the reply is returned. The reply always
 * carries `count`, `reason`, `scrolls`, `duplicatesDropped` and `recycled`, so a
 * caller can tell an empty feed from one that never rendered.
 */
export async function feedPage({ selector, maxItems, scroll, dedupeBy, until, forceActive: forceWanted, tabId: hint }) {
  const tabId = await requirePage(hint)
  const sel = typeof selector === 'string' ? selector.trim() : ''
  if (!sel) throw fail('NO_SELECTOR', 'pass a CSS selector such as "[role=article]", "div.post" or "li.result"')
  const cap = Math.min(Math.max(Math.trunc(Number(maxItems)) || 20, 1), 200)
  const wantScroll = scroll === true
  const keyMode = dedupeBy === undefined || dedupeBy === null || dedupeBy === '' ? 'auto' : String(dedupeBy)
  if (keyMode !== 'auto' && keyMode !== 'href' && keyMode !== 'text') {
    throw fail('BAD_ARGUMENT', 'dedupeBy must be "auto", "href" or "text"')
  }
  const untilExpr = typeof until === 'string' && until.trim() ? until.trim() : ''
  let visibility = await pageVisibility(tabId)
  let forced
  let forcedError = ''
  let wasHeld = false
  if (visibility === 'hidden' && forceWanted) {
    await shared.heldReady
    wasHeld = shared.heldForced.has(tabId)
    try {
      forced = await forceActive(tabId, { mode: 'hold' })
    } catch (error) {
      // A refused wake is not fatal for a read: report it and read what is there.
      forced = null
      forcedError = String(error && error.message ? error.message : error)
    }
    visibility = await pageVisibility(tabId)
  }
  const state = {
    items: [],
    keys: new Set(),
    previousKeys: new Set(),
    recycledKeys: new Set(),
    duplicatesDropped: 0,
    recycled: 0,
    skippedHidden: 0,
    cap,
  }
  let scrolls = 0
  let noGrowth = 0
  let stalled = 0
  let lastMatched = 0
  let lastUnkeyed = 0
  let untilError = ''
  let reason = ''
  let released = false

  const readOnce = async () => {
    const read = await evaluate(tabId, `(${feedCollect.toString()})(${JSON.stringify(sel)}, ${JSON.stringify(keyMode)})`)
    if (!read || typeof read !== 'object') throw fail('CDP_ERROR', 'the feed could not be read')
    lastMatched = Math.max(0, Math.trunc(Number(read.matched)) || 0)
    lastUnkeyed = Math.max(0, Math.trunc(Number(read.unkeyed)) || 0)
    return feedMerge(state, read)
  }

  const untilHit = async () => {
    if (!untilExpr) return false
    let result
    try {
      result = await evaluate(tabId, `(() => { try { return { ok: true, hit: Boolean(${untilExpr}) } } catch (error) { return { ok: false, error: String((error && error.message) || error) } } })()`)
    } catch (error) {
      result = { ok: false, error: String(error && error.message ? error.message : error) }
    }
    if (!result || result.ok !== true) {
      if (!untilError) untilError = String((result && result.error) || 'the until expression could not be evaluated')
      return false
    }
    return result.hit === true
  }

  try {
    await readOnce()
    if (await untilHit()) reason = 'until'
    else if (state.items.length >= cap) reason = 'max-items'
    else if (!wantScroll) reason = 'no-growth'
    else {
      for (;;) {
        const moved = await evaluate(tabId, `(${feedScroll.toString()})(${JSON.stringify(sel)})`)
        scrolls += 1
        // A feed that loads on scroll needs the page's own frame clock to paint
        // the next batch, so this is a real pause, not a tight loop.
        await delay(500 + Math.floor(Math.random() * 200))
        const added = await readOnce()
        if (await untilHit()) { reason = 'until'; break }
        if (state.items.length >= cap) { reason = 'max-items'; break }
        if (added > 0) {
          noGrowth = 0
          stalled = 0
          continue
        }
        noGrowth += 1
        // A scroller that moved is not at its end, even when this step found
        // nothing new; only a step that could not move counts towards it.
        if (moved && moved.scrolled === true) stalled = 0
        else stalled += 1
        if (stalled >= 2) { reason = 'end-of-scroll'; break }
        if (noGrowth >= 3) { reason = 'no-growth'; break }
      }
    }
  } finally {
    if (forced && !wasHeld) {
      const release = await releaseActive(tabId).catch(() => null)
      released = Boolean(release && release.released)
    }
  }

  const meta = await pageMeta(tabId).catch(() => null)
  const reply = {
    url: meta?.url ?? '',
    selector: sel,
    count: state.items.length,
    items: state.items,
    scrolls,
    duplicatesDropped: state.duplicatesDropped,
    recycled: state.recycled,
    reason,
    matched: lastMatched,
    unkeyed: lastUnkeyed,
    skipped: state.skippedHidden,
    maxItems: cap,
    dedupeBy: keyMode,
    scroll: wantScroll,
    visibility,
    hidden: visibility === 'hidden',
  }
  if (untilExpr) reply.until = untilExpr
  if (untilError) reply.untilError = untilError
  if (forced) reply.forced = { applied: forced.applied, held: true, reused: Boolean(forced.reused), released, cleared: released }
  else if (forcedError) reply.forceActiveError = forcedError
  if (state.skippedHidden > 0) {
    reply.hint = `skipped ${state.skippedHidden} matched node(s) with no box: they are stale DOM from a previous view, not items of this feed`
  }
  if (state.items.length === 0) {
    if (visibility === 'hidden' && !forcedError) reply.hint = FEED_HIDDEN_HINT
    else if (visibility !== 'hidden' && lastUnkeyed > 0) reply.hint = FEED_UNKEYED_HINT
  }
  return reply
}
