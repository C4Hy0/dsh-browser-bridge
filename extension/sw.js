// Browser Bridge worker entry: listeners, keepalive, dispatcher.
// The command handlers live in ./commands/; shared state in ./lib/state.js.
import { discoverEndpoints } from './lib/discovery.js'
import { whoami } from './lib/identity.js'
import { imageSource, pixelsPage, recordPage, screencastFrame, screenshotPage, sheetPage } from './commands/capture.js'
import { feedPage } from './commands/feed.js'
import { clickPage, hoverPage } from './commands/input/click.js'
import { dragPage, dropPage } from './commands/input/drag.js'
import { drivePage, measurePage } from './commands/input/drive.js'
import { forcePage, releasePage } from './commands/input/force.js'
import { keyPage } from './commands/input/key.js'
import { pastePage } from './commands/input/paste.js'
import { scrollPage, wheelPage } from './commands/input/scroll.js'
import { selectOption, setControl } from './commands/input/set.js'
import { typePage } from './commands/input/type.js'
import { uploadPage } from './commands/input/upload.js'
import { consoleArg, consolePage, consolePush, netCapture, netOnFinished, netOnRequest, netOnResponse, networkPage, timelinePage } from './commands/observe.js'
import { evalInstall, evalList, evalPage, evalRemove, framesPage, inspectPage, readHtml, readPage } from './commands/read.js'
import { closePage, closeTab, listTabs, openExtensionPage, openPage, openUrl, useExistingTab } from './commands/tabs.js'
import { waitForPage } from './commands/wait.js'
import { rawSend } from './lib/cdp.js'
import { KEEPALIVE_ALARM, WAIT_MS } from './lib/constants.js'
import { shared } from './lib/state.js'
import { delay, fail } from './lib/util.js'

const getEndpoint = async () => {
  const { endpoint } = await chrome.storage.local.get('endpoint')
  return typeof endpoint === 'string' && endpoint.length > 0 ? endpoint.replace(/\/+$/, '') : undefined
}

/**
 * Find a plugin we have not paired with yet.
 *
 * Runs once per poll-loop restart: a fresh dsh appears within one alarm period
 * (30 s) without the user pasting anything. More than one candidate is left to
 * the popup, because silently choosing a browser's plugin would be wrong.
 */
/**
 * Background LAN sweep, at most once per ten minutes and never in the popup:
 * opening the popup used to trigger a 2,800-request sweep every time.
 */
/** Re-attach to a plugin on this machine after the endpoint was lost. */
async function resumeLoopback() {
  try {
    const found = await discoverEndpoints({ hosts: ['127.0.0.1'] })
    const hit = found.find((entry) => entry.endpoint)
    if (!hit) return undefined
    await chrome.storage.local.set({ endpoint: hit.endpoint })
    return hit.endpoint
  } catch {
    return undefined
  }
}

async function startLoop() {
  if (shared.looping) return
  shared.looping = true
  let failures = 0
  try {
    for (;;) {
      // Cheap insurance: an MV3 worker with no alarm has no way back after
      // suspension, and creating an existing alarm is a no-op.
      ensureAlarm()
      // Connecting is an explicit action from the Web UI; the worker only keeps
      // an existing attachment alive and never discovers on its own.
      // A reload can leave the worker with no stored endpoint (storage cleared or
      // the extension reinstalled). Resume against loopback only: that covers the
      // machine running dsh without bringing back LAN scanning or a UI.
      const endpoint = (await getEndpoint()) ?? await resumeLoopback()
      if (endpoint) {
        // Self-update: the plugin publishes the version it ships; when it differs
        // from the running one, re-read the folder. This is the dev loop's whole
        // point, and it needs no page, click, or chrome://extensions trip.
        try {
          const served = await fetch(endpoint + '/version', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null))
          const running = chrome.runtime.getManifest().version
          if (served?.version && served.version !== running) {
            // Chrome throttles runtime.reload(): once per version, and never more
            // often than every few minutes, or it flags the extension.
            const { selfUpdate = {} } = await chrome.storage.local.get('selfUpdate')
            // One attempt per served version is not enough: if the reload did not
            // actually swap the files (throttled, folder out of sync) the worker
            // keeps running the old build forever. Retry at most every 10 minutes.
            const already = selfUpdate.version === served.version && Date.now() - (selfUpdate.at ?? 0) < 10 * 60 * 1000
            const tooSoon = Date.now() - (selfUpdate.at ?? 0) < 30 * 1000
            if (!already && !tooSoon) {
              await chrome.storage.local.set({ selfUpdate: { version: served.version, at: Date.now() } })
              await delay(50)
              chrome.runtime.reload()
              return
            }
          }
        } catch {}
      }
      if (!endpoint) break
      try {
        const me = await whoami()
        const query = `waitMs=${WAIT_MS}&id=${encodeURIComponent(me.id)}&label=${encodeURIComponent(me.label)}&v=${encodeURIComponent(chrome.runtime.getManifest().version)}`
        const response = await fetch(`${endpoint}/poll?${query}`, { cache: 'no-store' })
        if (response.status === 410) {
          // Detached from the dashboard: stop polling until the page re-connects us.
          await chrome.storage.local.remove('endpoint')
          break
        }
        if (response.status === 204) {
          shared.backoff = 0
          continue
        }
        if (!response.ok) throw new Error(`poll failed with ${response.status}`)
        const command = await response.json()
        shared.backoff = 0
        failures = 0
        // Never let one wedged command (a stuck screenshot) starve the loop.
        const settled = await Promise.race([
          runCommand(command),
          delay(45000).then(() => ({ ok: false, error: { code: 'TIMEOUT', message: 'the command timed out' } })),
        ])
        await postResult(endpoint, command.id, { ...settled, browser: (await whoami()).id })
      } catch {
        failures += 1
        // A saved URL from an older pairing (wrong host or rotated token) never
        // recovers on its own; after a few tries, forget it and rediscover.
        if (failures >= 5) {
          failures = 0
          await chrome.storage.local.remove('endpoint')
          shared.backoff = 0
          continue
        }
        shared.backoff = shared.backoff === 0 ? 500 : Math.min(shared.backoff * 2, 5000)
        await delay(shared.backoff)
      }
    }
  } finally {
    shared.looping = false
  }
}

async function postResult(endpoint, id, settled) {
  try {
    await fetch(`${endpoint}/result`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ id, ...settled }),
    })
  } catch {
    // The plugin times the command out; a failed post needs no local retry.
  }
}

async function runCommand(command) {
  try {
    // A single CDP call that never settles must not stall the whole loop.
    const result = await Promise.race([
      execute(command.method, command.params ?? {}),
      new Promise((_, reject) => setTimeout(() => reject(fail('TIMEOUT', 'the browser did not answer in time')), 30000)),
    ])
    return { ok: true, result }
  } catch (error) {
    return {
      ok: false,
      error: {
        message: error?.message ?? String(error),
        code: typeof error?.code === 'string' ? error.code : 'BROWSER_ERROR',
      },
    }
  }
}

async function execute(method, params) {
  switch (method) {
    case 'open': return openPage(params)
    case 'openUrl': return openUrl(params)
    case 'read': return readPage(params)
    case 'click': return clickPage(params)
    case 'drag': return dragPage(params)
    case 'hover': return hoverPage(params)
    case 'select': return selectOption(params)
    case 'set': return setControl(params)
    case 'upload': return uploadPage(params)
    case 'key': return keyPage(params)
    case 'wheel': return wheelPage(params)
    case 'evalInstall': return evalInstall(params)
    case 'evalRemove': return evalRemove(params)
    case 'evalList': return evalList(params)
    case 'forceActive': return forcePage(params)
    case 'releaseActive': return releasePage(params)
    case 'drive': return drivePage(params)
    case 'measure': return measurePage(params)
    case 'waitFor': return waitForPage(params)
    case 'scroll': return scrollPage(params)
    case 'type': return typePage(params)
    case 'paste': return pastePage(params)
    case 'screenshot': return screenshotPage(params)
    case 'record': return recordPage(params)
    case 'close': return closePage()
    case 'tabs': return listTabs(params)
    case 'openExtensionPage': return openExtensionPage(params)
    case 'html': return readHtml(params)
    case 'imageSource': return imageSource(params)
    case 'frames': return framesPage(params)
    case 'network': return networkPage(params)
    case 'inspect': return inspectPage(params)
    case 'feed': return feedPage(params)
    case 'pixels': return pixelsPage(params)
    case 'sheet': return sheetPage(params)
    case 'console': return consolePage(params)
    case 'timeline': return timelinePage(params)
    case 'drop': return dropPage(params)
    case 'eval': return evalPage(params)
    case 'closeTab': return closeTab(params)
    case 'use': return useExistingTab(params)
    default: throw fail('UNKNOWN_METHOD', `unknown method: ${method}`)
  }
}

const ensureAlarm = () => {
  try {
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 })
  } catch {
    // Older builds clamp the period; the alarm still exists, just less often.
    try { chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 }) } catch {}
  }
}

/**
 * browser-bridge — extension service worker.
 *
 * The plugin cannot reach the browser, so this worker polls it and executes one
 * command at a time over the DevTools Protocol (`chrome.debugger`). The worker
 * holds no settings beyond the pairing endpoint; everything else is derived.
 *
 * Wire format: see README.md in the plugin.
 */

try {
  chrome.tabs.onCreated.addListener((tab) => {
    if (typeof tab?.openerTabId !== 'number' || typeof tab.id !== 'number') return
    shared.createdTabs.set(tab.openerTabId, { id: tab.id, at: Date.now(), url: tab.pendingUrl || tab.url || '' })
    while (shared.createdTabs.size > 50) shared.createdTabs.delete(shared.createdTabs.keys().next().value)
  })
} catch {}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source?.tabId
  if (tabId != null) {
    if (method === 'Page.screencastFrame') { screencastFrame(tabId, params); return }
    if (method === 'Network.requestWillBeSent') { netOnRequest(tabId, params); return }
    if (method === 'Network.responseReceived') { netOnResponse(tabId, params); return }
    if (method === 'Network.loadingFinished') { void netOnFinished(tabId, params); return }
    if (method === 'Network.loadingFailed') {
      const capture = netCapture(tabId)
      const entry = capture?.entries.get(params?.requestId)
      if (entry) {
        const error = String(params?.errorText || 'loading failed')
        // ERR_ABORTED on a 2xx response is how Chrome ends a navigation that
        // became a download. Recording it as an error makes a success look like
        // a failure; mark the download and keep the status.
        if (/ERR_ABORTED/i.test(error) && Number(entry.status) >= 200 && Number(entry.status) < 400) {
          entry.download = true
          entry.note = 'the response became a download (ERR_ABORTED is Chrome ending the navigation, not a failure)'
        } else {
          entry.error = error
        }
      }
      return
    }
    if (method === 'Runtime.consoleAPICalled') {
      consolePush(tabId, {
        at: Date.now(),
        level: String(params?.type || 'log'),
        text: (params?.args || []).map(consoleArg).join(' ').slice(0, 800),
      })
      return
    }
    if (method === 'Runtime.exceptionThrown') {
      const details = params?.exceptionDetails || {}
      const exception = details.exception || {}
      consolePush(tabId, {
        at: Date.now(),
        level: 'exception',
        text: String(exception.description || details.text || 'uncaught exception').split('\n').slice(0, 4).join(' ').slice(0, 800),
      })
      return
    }
    if (method === 'Log.entryAdded') {
      const entry = params?.entry || {}
      consolePush(tabId, {
        at: Date.now(),
        level: String(entry.level || 'info'),
        text: String(entry.text || '').slice(0, 500) + (entry.url ? ' (' + entry.url + ')' : ''),
      })
      return
    }
  }
  if (method !== 'Page.javascriptDialogOpening' || tabId == null) return
  shared.dialogs.set(source.tabId, { type: params.type, message: params.message, at: Date.now() })
  rawSend(source.tabId, 'Page.handleJavaScriptDialog', { accept: false }).catch(() => undefined)
})

// ---------------------------------------------------------------------------
// Pairing state
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// DevTools Protocol plumbing
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Page functions (serialized into the page; no outer-scope references)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.endpoint) void startLoop()
})

chrome.alarms.onAlarm.addListener(() => { void startLoop() })

chrome.runtime.onStartup.addListener(() => { void startLoop() })
chrome.runtime.onInstalled.addListener(() => { void startLoop() })

chrome.tabs.onRemoved.addListener((tabId) => {
  shared.attached.delete(tabId)
  shared.navOutcomes.delete(tabId)
  if (shared.detachTimer) {
    clearTimeout(shared.detachTimer)
    shared.detachTimer = undefined
  }
})

chrome.tabs.onActivated.addListener(() => { void startLoop() })

/**
 * A dsh page asking this browser to attach.
 *
 * The page knows where dsh lives (it was served from there), so its host is the
 * best possible discovery seed — better than any subnet guess. We probe that one
 * host across the plugin's port range and pair on the first answer.
 */
chrome.runtime.onMessageExternal.addListener((message, sender, respond) => {
  if (message?.type === 'reload') {
    const origin = sender?.origin ?? ''
    ;(async () => {
      try {
        const check = await fetch(origin + '/browser-bridge/api/dev/status', { cache: 'no-store' })
        const body = await check.json()
        if (body?.devReload !== true) { respond({ ok: false, error: 'devReload is off' }); return }
        respond({ ok: true })
        setTimeout(() => chrome.runtime.reload(), 80)
      } catch (error) {
        respond({ ok: false, error: String(error?.message ?? error) })
      }
    })()
    return true
  }
  if (message?.type !== 'connect') return false
  const origin = sender?.origin ?? message?.origin ?? ''
  let host = ''
  try { host = new URL(origin).hostname } catch { host = '' }
  if (!host) { respond({ ok: false, error: 'unknown page origin' }); return true }

  ;(async () => {
    try {
      // The page knows the exact bridge URL — it asks its own plugin for it — so
      // verify that endpoint directly instead of sweeping the port range. The
      // sweep was the multi-instance bug: with two dsh processes on one machine
      // (a Windows app beside a WSL one, or any non-default port) it found the
      // *other* instance's bridge and attached to it while reporting success.
      const explicit = typeof message?.endpoint === 'string' ? message.endpoint.trim().replace(/\/+$/, '') : ''
      let hit
      if (explicit && /^https?:\/\/[^/]+\/p\/[0-9a-f]{64}$/i.test(explicit)) {
        try {
          const hello = await fetch(`${explicit}/hello`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null))
          if (hello?.name === 'browser-bridge') {
            const parsed = new URL(explicit)
            hit = { origin: parsed.origin, endpoint: explicit, version: String(hello.version ?? '') }
          }
        } catch {
          hit = undefined
        }
      }
      if (!hit) {
        // Fall back to the port sweep only when the page gave nothing usable.
        const found = await discoverEndpoints({ hosts: [host] })
        hit = found.find((entry) => entry.endpoint)
      }
      if (!hit) {
        respond({
          ok: false,
          error: explicit
            ? `no browser-bridge answered at ${explicit}. Is that dsh instance still running?`
            : `no browser-bridge answered on ${host}`,
        })
        return
      }
      const me = await whoami()
      // A browser detached from the dashboard is blocked server-side; the page's
      // Connect button is exactly the intent that lifts it.
      try { await fetch(`${hit.endpoint}/allow?id=${encodeURIComponent(me.id)}`, { cache: 'no-store' }) } catch {}
      const { servers = [] } = await chrome.storage.local.get('servers')
      const next = (Array.isArray(servers) ? servers : []).filter((server) => server.origin !== hit.origin)
      next.push({ origin: hit.origin, endpoint: hit.endpoint })
      await chrome.storage.local.set({ servers: next, endpoint: hit.endpoint })
      void startLoop()
      respond({ ok: true, origin: hit.origin, version: hit.version })
    } catch (error) {
      respond({ ok: false, error: String(error?.message ?? error) })
    }
  })()
  return true
})

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type === 'refresh') {
    void startLoop()
    respond({ ok: true })
  }
  return true
})

void ensureAlarm()
void startLoop()
