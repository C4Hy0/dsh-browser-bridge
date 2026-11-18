// Browser Bridge worker: commands/tabs.js.
// Keep the module boundaries in docs/SPEC.md in sync.
import { attach, attachTab, detach, pageMeta, readVisibility, scheduleDetach, send, waitEvent, waitReady, windowInfo } from '../lib/cdp.js'
import { documentHint, navOutcome, pageState, rememberNav } from '../lib/page-state.js'
import { shared } from '../lib/state.js'
import { delay, fail, isInternalUrl } from '../lib/util.js'

/** The tab this browser is driving, if any. */
export const getTrackedId = async () => {
  // local, not session: a reload wipes session storage and would orphan the tab
  const { tabId } = await chrome.storage.local.get('tabId')
  return typeof tabId === 'number' ? tabId : undefined
}

export const trackId = (id) => chrome.storage.local.set({ tabId: id })

export async function trackedTab() {
  const id = await getTrackedId()
  if (id === undefined) return undefined
  try {
    return await chrome.tabs.get(id)
  } catch {
    return undefined
  }
}

/**
 * Open one of this extension's own pages in a tab.
 *
 * bsb_open only accepts http(s), so an agent working ON the extension could not
 * look at its own popup, options or panel: the one surface it was editing was
 * the one surface it could not see. The path is resolved through
 * chrome.runtime.getURL, so it can only ever point inside the package — a
 * caller cannot steer this at an arbitrary origin.
 */
export async function openExtensionPage({ path }) {
  const rel = typeof path === 'string' ? path.trim().replace(/^\/+/, '') : ''
  if (!rel || rel.includes('..') || /^[a-z]+:/i.test(rel)) {
    throw fail('BAD_ARGUMENT', 'path must be a page inside the extension, e.g. "popup.html"')
  }
  const url = chrome.runtime.getURL(rel)
  const tab = await chrome.tabs.create({ url, active: true })
  await chrome.storage.local.set({ tabId: tab.id })
  await delay(250)
  const meta = await pageMeta(tab.id).catch(() => null)
  return { tabId: tab.id, url: meta?.url ?? url, title: meta?.title ?? '' }
}

/**
 * Show a tab at any URL the browser itself can display.
 *
 * `openPage` below is the page driver: it attaches over CDP, navigates and reads
 * the result — all of which Chrome refuses on internal pages ("Cannot access a
 * chrome:// URL"). This one only asks the tab strip to show a URL, so it works
 * exactly where CDP cannot, and it deliberately does NOT adopt the tab: the
 * tracked page is left untouched, and nothing about the new tab can be read
 * afterwards. It is for looking, not driving.
 */
export async function openUrl({ url, active = true }) {
  if (typeof url !== 'string' || url.length === 0) throw fail('BAD_ARGUMENT', 'url is required')
  if (!/^(https?|chrome|edge|brave|about|view-source|chrome-extension):/i.test(url)) {
    throw fail('BAD_ARGUMENT', 'url must be http(s) or a browser-internal scheme, got ' + url)
  }
  const created = await chrome.tabs.create({ url, active: active !== false })
  // The title arrives with the load, one beat after creation.
  await delay(700)
  const tab = await chrome.tabs.get(created.id).catch(() => created)
  return { tabId: tab.id, url: tab.url ?? url, title: tab.title ?? '', status: tab.status ?? '' }
}

export async function openPage({ url, newTab, activate, tabId: hint, owner }) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw fail('BAD_ARGUMENT', 'url must be an absolute http(s) URL')
  // An explicit tabId wins over the tracked tab: the call navigates that tab for
  // this command and leaves the tracker where it was, so one agent's open cannot
  // move the page another agent is reading (BSB-20261118-2315).
  const explicit = typeof hint === 'number' ? hint : null
  let tab
  if (explicit !== null) {
    tab = await chrome.tabs.get(explicit).catch(() => undefined)
    if (!tab) throw fail('TAB_NOT_FOUND', 'tab ' + explicit + ' is not open, so it cannot be navigated; run bsb_tabs {action:"list"} or open a new tab.')
    if (isInternalUrl(tab.url)) {
      throw fail('TAB_NOT_SCRIPTABLE', 'tab ' + explicit + ' is ' + String(tab.url ?? '') + ', a browser-internal page bsb cannot script; open the http(s) URL with newTab:true.')
    }
  } else {
    // Never borrow a tab the user is on: an earlier same-origin adoption rule
    // navigated the dashboard's own tab. Reuse only the tab this session tracks,
    // or open one.
    tab = newTab ? undefined : await trackedTab()
  }
  // A browser-internal tracked tab (chrome://newtab/ is the only tab on a fresh
  // profile) cannot be attached to, so reusing it made the first bsb_open of a
  // session fail with a chrome:// error that blamed the requested http(s) URL.
  // Open a tab for the caller and say which tab was blocked, instead of making
  // them discover newTab:true.
  let autoNewTab
  if (tab && isInternalUrl(tab.url)) {
    autoNewTab = {
      tabId: tab.id,
      url: String(tab.url ?? ''),
      reason: 'tracked tab ' + tab.id + ' is ' + String(tab.url ?? '') + ' (a browser-internal page bsb cannot script); opened a new tab for ' + url,
    }
    tab = undefined
  }
  // Background by default: opening a page for automation must not raise the
  // window or steal the active tab. activate:true is the explicit opt-in.
  const created = !tab
  if (created) tab = await chrome.tabs.create({ url: 'about:blank', active: activate === true })
  if (explicit === null) await trackId(tab.id)
  // Only a tab this call created gets an owner. A reused tracked tab is shared
  // by design, and an explicit tabId keeps the owner it already has.
  if (created && typeof owner === 'string' && owner) shared.tabOwners.set(tab.id, owner)
  shared.refs = new Map()
  const recovered = await attachTab(tab.id, { recover: true })
  await send(tab.id, 'Page.enable')
  // PAGE-NEUTRAL: the tab keeps the lifecycle and focus state the browser gives
  // it. Background/minimized tabs run slower — the tools report that measured
  // frame rate instead of overriding it, because forcing `active`/focus would
  // change site behaviour the user did not ask us to change.
  const loaded = waitEvent(tab.id, 'Page.loadEventFired', 20000).catch(() => undefined)
  // Page.navigate's errorText is the only in-band reason for a failed
  // navigation: Chrome then commits a chrome-error:// document whose title is
  // the host and whose body is a human-readable page. Keep the reason.
  let navigationError
  try {
    const navigated = await send(tab.id, 'Page.navigate', { url })
    if (typeof navigated?.errorText === 'string' && navigated.errorText) navigationError = navigated.errorText
  } catch (error) {
    const message = String(error?.message ?? error)
    if (!/net::|ERR_[A-Z]|blocked|cannot navigate/i.test(message)) throw error
    navigationError = message
  }
  // A committed error page still fires loadEventFired, but a navigation that
  // never committed can leave it pending; do not spend the full load timeout
  // when Page.navigate already named the failure.
  await (navigationError ? Promise.race([loaded, delay(1500)]) : loaded)
  await waitReady(tab.id, navigationError ? 4000 : 8000)
  await delay(navigationError ? 400 : 600)
  const state = await pageState(tab.id).catch(() => null)
  const meta = await pageMeta(tab.id).catch(() => null)
  const documentUrl = String(state?.url ?? meta?.url ?? '')
  const outcome = {
    requestedUrl: url,
    documentUrl,
    title: String(state?.title ?? meta?.title ?? ''),
    ...(Number(state?.httpStatus) > 0 ? { httpStatus: Number(state.httpStatus) } : {}),
    ...(navigationError ? { navigationError } : {}),
  }
  rememberNav(tab.id, outcome)
  const outcomeHint = documentHint(state, { requestedUrl: url, navigationError })
  const out = {
    tabId: tab.id,
    url: documentUrl || url,
    title: outcome.title,
    requestedUrl: url,
    documentUrl: documentUrl || url,
    readyState: state?.readyState ?? 'unknown',
    bodyTextLen: Number(state?.bodyTextLen) || 0,
    elementCount: Number(state?.elementCount) || 0,
    ...(outcome.httpStatus ? { httpStatus: outcome.httpStatus } : {}),
    ...(outcome.navigationError ? { navigationError: outcome.navigationError } : {}),
    ...(outcomeHint ? { hint: outcomeHint } : {}),
  }
  if (recovered?.recovered) out.recoveredFrom = recovered.was
  if (autoNewTab) {
    out.autoNewTab = true
    out.blockedTabId = autoNewTab.tabId
    out.autoNewTabReason = autoNewTab.reason
  }
  return out
}

export async function requirePage(hint) {
  if (typeof hint === 'number') {
    try {
      const tab = await chrome.tabs.get(hint)
      // An explicit tabId addresses that tab for this call only. Adopting it
      // silently moved the tracked tab, so reading a second tab while driving
      // the first retargeted every later call. Only bsb_open and bsb_tabs use
      // change the tracked tab.
      if (tab) return tab.id
    } catch {}
  }
  const tab = await trackedTab()
  if (!tab) throw fail('NO_TAB', 'No page is open; call bsb_open first.')
  // A browser-internal page is refused by the debugger, and the raw error names
  // no tab and no way out. Name both.
  if (isInternalUrl(tab.url)) {
    throw fail(
      'TAB_NOT_SCRIPTABLE',
      'the tracked tab ' + tab.id + ' is ' + String(tab.url ?? '') + ', a browser-internal page bsb cannot script; call bsb_open with the http(s) URL (newTab:true also opens a fresh tab).',
    )
  }
  // A tab left on an error page cannot be attached to; say so plainly instead of
  // surfacing DevTools' opaque 'Cannot attach to this target'.
  await attachTab(tab.id, { recover: false }).catch((error) => {
    const parked = /^(chrome-error|chrome|devtools|edge|about):/i.test(String(tab.url ?? ''))
    if (!parked) throw error
    throw fail('ERROR_PAGE', 'The tracked tab is showing a browser error page (' + tab.url + '). Call bsb_open with the target URL to recover.')
  })
  scheduleDetach(tab.id)
  return tab.id
}

/** Close one tab by id — for cleaning up tabs an earlier session left behind. */
export async function closeTab({ tabId }) {
  const id = Number(tabId)
  if (!Number.isInteger(id)) throw fail('BAD_ARGUMENT', 'tabId must be a number')
  const tracked = await getTrackedId()
  await chrome.tabs.remove(id)
  if (tracked !== id) return { tabId: id, closed: true, tracked: false }
  // Closing the tracked tab used to leave no page tracked, so the documented
  // housekeeping action broke every later call. Fall back to a scriptable tab.
  const tabs = await chrome.tabs.query({}).catch(() => [])
  const candidates = (tabs ?? []).filter((tab) => tab.id !== id && !isInternalUrl(tab.url))
  const next = candidates.find((tab) => tab.active) ?? candidates[0]
  if (next) {
    await trackId(next.id)
    return { tabId: id, closed: true, tracked: true, nextTracked: next.id }
  }
  await chrome.storage.local.remove('tabId')
  return {
    tabId: id, closed: true, tracked: true, nextTracked: null,
    hint: 'the tracked tab was closed and no scriptable tab remains; call bsb_open to open one',
  }
}

/** Tabs the user already has, so a task can target one they are looking at. */
export async function listTabs({ action, tabId: hint } = {}) {
  // F5 is a browser-level accelerator: a key event dispatched to the renderer
  // never reaches it, so "reload this page" had no working primitive. Page.reload
  // is the real thing, and it is what a dev loop needs after every edit.
  if (action === 'reload') {
    const id = typeof hint === 'number' ? hint : await requirePage()
    const tab = await chrome.tabs.get(id).catch(() => undefined)
    if (!tab) throw fail('NO_TAB', 'no tab with id ' + id)
    if (isInternalUrl(tab.url)) {
      throw fail('TAB_NOT_SCRIPTABLE', 'tab ' + id + ' is ' + String(tab.url ?? '') + ', a browser-internal page bsb cannot reload; call bsb_open with the http(s) URL (newTab:true also opens a fresh tab).')
    }
    const before = navOutcome(id) ?? {}
    const requestedUrl = typeof before.requestedUrl === 'string' ? before.requestedUrl : ''
    let reloadError = ''
    try {
      await send(id, 'Page.reload', { ignoreCache: true })
    } catch (error) {
      reloadError = String(error?.message ?? error)
    }
    if (!reloadError) {
      await waitReady(id, 8000).catch(() => undefined)
      await delay(200)
    }
    const state = await pageState(id).catch(() => null)
    const meta = await pageMeta(id).catch(() => null)
    const documentUrl = String(state?.url ?? meta?.url ?? tab.url ?? '')
    const failedDocument = state?.failedDocument === true || /^chrome-error:/i.test(documentUrl)
    const status = Number(state?.httpStatus) > 0
      ? Number(state.httpStatus)
      : Number(before.httpStatus) > 0 ? Number(before.httpStatus) : 0
    // Page.reload returns no navigation outcome of its own, so on an error page
    // the document's own ERR_/HTTP status is the freshest reason; the cached one
    // from the navigation that failed is the fallback.
    const navigationError = failedDocument
      ? String(state?.errorCode || before.navigationError || reloadError || '')
      : reloadError
    // "reloaded" means a real document is now in the tab: a chrome-error page or
    // a refused reload is a failure, even though Page.reload itself succeeded.
    const reloaded = Boolean(state) && !failedDocument && !reloadError
    if (documentUrl || navigationError) {
      rememberNav(id, {
        ...(requestedUrl ? { requestedUrl } : {}),
        documentUrl,
        ...(status > 0 ? { httpStatus: status } : {}),
        ...(navigationError ? { navigationError } : {}),
      })
    }
    let reloadHint
    if (!reloaded) {
      reloadHint = failedDocument
        ? documentHint(
            { url: documentUrl, title: state?.title ?? '', httpStatus: status, failedDocument: true, errorCode: state?.errorCode ?? '' },
            { requestedUrl, navigationError: navigationError || reloadError },
          )
        : 'reload failed' + (reloadError ? ': ' + reloadError : '') + '. No readable document loaded; call bsb_open with the URL to recover the tab.'
    } else {
      reloadHint = documentHint(state, { requestedUrl, navigationError: '' })
    }
    return {
      reloaded,
      tabId: id,
      url: documentUrl,
      title: String(state?.title ?? meta?.title ?? ''),
      ...(requestedUrl ? { requestedUrl } : {}),
      ...(documentUrl ? { documentUrl } : {}),
      ...(status > 0 ? { httpStatus: status } : {}),
      ...(navigationError ? { navigationError } : {}),
      ...(state?.readyState ? { readyState: state.readyState } : {}),
      ...(reloadHint ? { hint: reloadHint } : {}),
    }
  }
  const tabs = await chrome.tabs.query({})
  const tracked = await getTrackedId()
  const rows = []
  for (const tab of tabs) {
    if (typeof tab.id !== 'number') continue
    const cached = navOutcome(tab.id) ?? {}
    let state = null
    // Only the tracked tab is read live: attaching to every tab would be
    // invasive, and a background tab's own url is already its document URL.
    if (tab.id === tracked && !isInternalUrl(tab.url)) {
      state = await pageState(tab.id).catch(() => null)
    }
    const documentUrl = String(state?.url ?? tab.url ?? '')
    // A cached failure describes the last navigation this worker drove, so it is
    // trusted only while the document still is that error page: a manual reload
    // or a navigation from elsewhere makes it stale.
    const failedDocument = state?.failedDocument === true
      || /^chrome-error:/i.test(documentUrl)
      || (!state && /^chrome-error:/i.test(String(cached.documentUrl ?? '')))
    const navigationError = String(state?.errorCode ?? (failedDocument ? cached.navigationError ?? '' : ''))
    const requestedUrl = typeof cached.requestedUrl === 'string' ? cached.requestedUrl : ''
    const status = Number(state?.httpStatus) > 0
      ? Number(state.httpStatus)
      : Number(cached.httpStatus) > 0 ? Number(cached.httpStatus) : 0
    const internal = isInternalUrl(documentUrl)
    rows.push({
      tabId: tab.id,
      title: String(state?.title ?? tab.title ?? ''),
      // The real document URL, not the URL that was requested for it.
      url: documentUrl,
      active: tab.active === true,
      current: tab.id === tracked,
      scriptable: !internal,
      documentUrl,
      ...(requestedUrl && requestedUrl !== documentUrl ? { requestedUrl } : {}),
      ...(navigationError ? { navigationError } : {}),
      ...(status > 0 ? { httpStatus: status } : {}),
      ...(failedDocument ? { navigationFailed: true } : {}),
      ...(internal ? { notScriptable: true } : {}),
    })
  }
  return { tabs: rows.slice(0, 200) }
}

/** Adopt an existing tab instead of opening one. */
export async function useExistingTab({ tabId, activate }) {
  const id = Number(tabId)
  if (!Number.isInteger(id)) throw fail('BAD_ARGUMENT', 'tabId must be a number')
  const tab = await chrome.tabs.get(id).catch(() => undefined)
  if (!tab) throw fail('NO_TAB', `no tab with id ${id}`)
  // A browser-internal tab cannot be attached to. Name the offending tab and the
  // one parameter that works, instead of surfacing DevTools' string with no tab
  // id, which reads like the caller's own URL was refused.
  if (isInternalUrl(tab.url)) {
    throw fail('TAB_NOT_SCRIPTABLE', 'tab ' + id + ' is ' + String(tab.url ?? '') + ', a browser-internal page bsb cannot script; call bsb_open with the http(s) URL and newTab:true to open a scriptable tab.')
  }
  // Attach BEFORE tracking or activating. Adopting a tab the debugger cannot
  // reach used to set the tracked slot first and throw on the attach afterwards,
  // so the browser was left pointing at an unreadable page and every later
  // command failed with "Cannot access a chrome:// URL" until some other tab was
  // adopted. A refused adoption must change nothing.
  try {
    await attach(tab.id)
  } catch (error) {
    if (/^chrome-error:/i.test(String(tab.url ?? ''))) {
      throw fail('ERROR_PAGE', 'tab ' + id + ' is showing a Chrome error page (' + tab.url + '); call bsb_open with the target URL to recover it.')
    }
    throw error
  }
  await trackId(tab.id)
  shared.refs = new Map()
  let view = await readVisibility(tab.id)
  // activate defaults to true. Report what the page saw, not only what was
  // asked: a minimized window keeps document.visibilityState hidden even after
  // the tab is made active, and this tool never restores or raises windows.
  if (activate !== false) {
    await chrome.tabs.update(tab.id, { active: true }).catch(() => undefined)
    const until = Date.now() + 1200
    for (;;) {
      view = await readVisibility(tab.id)
      if (view?.visibility === 'visible' || Date.now() >= until) break
      await delay(100)
    }
  }
  const state = await pageState(tab.id).catch(() => null)
  const meta = await pageMeta(tab.id).catch(() => null)
  const documentUrl = String(state?.url ?? meta?.url ?? tab.url ?? '')
  const cached = navOutcome(tab.id) ?? {}
  const failedDocument = state?.failedDocument === true || /^chrome-error:/i.test(documentUrl)
  const navigationError = String(state?.errorCode ?? (failedDocument ? cached.navigationError ?? '' : ''))
  const status = Number(state?.httpStatus) > 0 ? Number(state.httpStatus) : 0
  const hidden = view?.visibility !== 'visible'
  const activated = activate !== false && !hidden
  const out = {
    tabId: tab.id,
    url: documentUrl,
    title: String(state?.title ?? meta?.title ?? tab.title ?? ''),
    documentUrl,
    scriptable: true,
    activated,
    visibility: view?.visibility ?? 'unknown',
    hidden,
    ...(cached.requestedUrl ? { requestedUrl: String(cached.requestedUrl) } : {}),
    ...(navigationError ? { navigationError } : {}),
    ...(status > 0 ? { httpStatus: status } : {}),
  }
  if (!activated) {
    if (activate === false) {
      out.reason = 'activate:false was passed, so the tab was adopted in the background'
    } else {
      const info = await windowInfo(tab.id)
      const outer = view?.outer ?? { width: 0, height: 0 }
      const width = Number(outer.width) || 0
      const height = Number(outer.height) || 0
      out.window = { state: info?.state ?? 'unknown', focused: info?.focused === true, width, height }
      const minimized = info?.state === 'minimized' || (width === 0 && height === 0)
      out.reason = minimized
        ? 'the window is minimized (outer ' + width + 'x' + height + ') so the page stayed hidden after activation; bsb does not restore or raise windows. Restore the window yourself, or use bsb_act forceActive mode:"hold" when the page only needs a live frame clock.'
        : 'document.visibilityState stayed ' + (view?.visibility ?? 'unknown') + ' after activating the tab; the page did not become visible.'
    }
  }
  return out
}

export async function closePage() {
  const tab = await trackedTab()
  if (!tab) return { closed: false }
  await detach(tab.id)
  try { await chrome.tabs.remove(tab.id) } catch {}
  await chrome.storage.local.remove('tabId')
  shared.refs = new Map()
  return { closed: true }
}
