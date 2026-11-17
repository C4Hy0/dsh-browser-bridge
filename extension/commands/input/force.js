// Browser Bridge worker: commands/input/force.js.
// Keep the module boundaries in docs/SPEC.md in sync.
import { requirePage } from '../tabs.js'
import { forceActive, pageMeta, releaseActive } from '../../lib/cdp.js'

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
