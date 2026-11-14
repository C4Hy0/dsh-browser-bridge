/**
 * browser-bridge — extension service worker.
 *
 * The plugin cannot reach the browser, so this worker polls it and executes one
 * command at a time over the DevTools Protocol (`chrome.debugger`). The worker
 * holds no settings beyond the pairing endpoint; everything else is derived.
 *
 * Wire format: see README.md in the plugin.
 */

const WAIT_MS = 20000
const KEEPALIVE_ALARM = 'browser-bridge-keepalive'
const DETACH_IDLE_MS = 5 * 60 * 1000

import { discoverEndpoints } from './discovery.js'
import { whoami } from './identity.js'

const attached = new Set()
let looping = false
let backoff = 0
let refs = new Map()
let detachTimer

/**
 * A JS dialog (alert/confirm/prompt/beforeunload) blocks every later CDP call on
 * the tab, which reads to the agent as "the browser stopped responding". Dismiss
 * it immediately and remember the text so the caller can report what happened.
 * Accepting would be a guess; dismissing is the recoverable default.
 */
const dialogs = new Map()
/** Document-start scripts registered on the tab, keyed by tab id. */
const injectedScripts = new Map()
const netCaptures = new Map()
const NET_BODY_CHARS = 4000
const NET_HEADER_MAX = 24
const NET_HEADER_CHARS = 400
const netCapture = (tabId) => netCaptures.get(tabId)

/** CDP headers are plain objects (or name/value arrays in some events); keep a bounded copy. */
function netHeaders(headers) {
  const out = {}
  if (!headers || typeof headers !== 'object') return out
  const pairs = Array.isArray(headers) ? headers.map((h) => [h?.name, h?.value]) : Object.entries(headers)
  let count = 0
  for (const [name, value] of pairs) {
    if (count >= NET_HEADER_MAX) break
    const key = String(name ?? '').trim()
    if (!key || key.startsWith(':')) continue
    out[key] = String(value ?? '').slice(0, NET_HEADER_CHARS)
    count += 1
  }
  return out
}

function netOnRequest(tabId, params) {
  const capture = netCapture(tabId)
  if (!capture) return
  const requestId = params?.requestId
  if (!requestId) return
  const request = params.request || {}
  const url = String(request.url || '')
  if (!/^https?:/i.test(url)) return
  const entry = {
    requestId,
    at: Date.now(),
    method: String(request.method || 'GET'),
    url,
    type: String(params.type || ''),
    status: null,
    mime: '',
    requestBody: request.postData ? String(request.postData).slice(0, NET_BODY_CHARS) : undefined,
    requestHeaders: netHeaders(request.headers),
    body: undefined,
  }
  capture.entries.set(requestId, entry)
  capture.order.push(requestId)
  while (capture.order.length > capture.limit) {
    const oldest = capture.order.shift()
    capture.entries.delete(oldest)
  }
}

function netOnResponse(tabId, params) {
  const capture = netCapture(tabId)
  const entry = capture?.entries.get(params?.requestId)
  if (!entry) return
  entry.status = params?.response?.status ?? null
  entry.mime = String(params?.response?.mimeType || '')
  entry.responseHeaders = netHeaders(params?.response?.headers)
}

async function netOnFinished(tabId, params) {
  const capture = netCapture(tabId)
  const entry = capture?.entries.get(params?.requestId)
  if (!entry || entry.body != null) return
  try {
    const result = await rawSend(tabId, 'Network.getResponseBody', { requestId: entry.requestId })
    if (typeof result?.body === 'string') {
      entry.body = result.base64Encoded === true ? '(binary body)' : result.body.slice(0, NET_BODY_CHARS)
    }
  } catch {
    // Bodies of redirects and aborted loads are not always retrievable.
  }
}

// Console entries per tab. Runtime/Log events arrive for every attached tab
// once enabled, so the capture only records while `active` (bsb_console start).
const consoleCaptures = new Map()

function consoleCapture(tabId) {
  let capture = consoleCaptures.get(tabId)
  if (!capture) {
    capture = { active: false, limit: 100, entries: [] }
    consoleCaptures.set(tabId, capture)
  }
  return capture
}

function consolePush(tabId, entry) {
  const capture = consoleCapture(tabId)
  if (!capture.active) return
  capture.entries.push(entry)
  if (capture.entries.length > capture.limit) capture.entries.splice(0, capture.entries.length - capture.limit)
}

/** RemoteObjects are not JSON-serialisable; keep a readable one-liner. */
function consoleArg(arg) {
  if (arg == null) return String(arg)
  if ('value' in arg && arg.value !== undefined) {
    if (typeof arg.value === 'object' && arg.value !== null) {
      try { return JSON.stringify(arg.value).slice(0, 300) } catch { return String(arg.value) }
    }
    if (typeof arg.value === 'string') return arg.value.slice(0, 300)
    return String(arg.value)
  }
  if (arg.unserializableValue) return String(arg.unserializableValue)
  if (arg.description) return String(arg.description).split('\n')[0].slice(0, 300)
  return String(arg.type || 'unknown')
}

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
      if (entry) entry.error = String(params?.errorText || 'loading failed')
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
  dialogs.set(source.tabId, { type: params.type, message: params.message, at: Date.now() })
  rawSend(source.tabId, 'Page.handleJavaScriptDialog', { accept: false }).catch(() => undefined)
})

const recentDialog = (tabId) => {
  const dialog = dialogs.get(tabId)
  return dialog && Date.now() - dialog.at < 15000 ? dialog.message : undefined
}

// ---------------------------------------------------------------------------
// Pairing state
// ---------------------------------------------------------------------------

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
  if (looping) return
  looping = true
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
          backoff = 0
          continue
        }
        if (!response.ok) throw new Error(`poll failed with ${response.status}`)
        const command = await response.json()
        backoff = 0
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
          backoff = 0
          continue
        }
        backoff = backoff === 0 ? 500 : Math.min(backoff * 2, 5000)
        await delay(backoff)
      }
    }
  } finally {
    looping = false
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

const fail = (code, message) => Object.assign(new Error(message), { code })

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

/**
 * Attach files to an <input type="file">.
 *
 * Chrome opens the paths itself, so they must be paths the browser machine can
 * see (a Windows path when Chrome runs on Windows), not WSL paths.
 */
async function uploadPage({ target, files, frame, tabId: hint }) {
  const tabId = await requirePage(hint)
  if (!target) throw fail('BAD_ARGUMENT', 'upload needs a target selector')
  const list = Array.isArray(files)
    ? files.filter((f) => typeof f === 'string' && f.trim()).map((f) => f.trim())
    : []
  if (!list.length) throw fail('BAD_ARGUMENT', 'upload needs at least one file path')
  const selector = resolveTarget(target)
  await send(tabId, 'DOM.enable').catch(() => undefined)
  let rootNodeId
  let frameId
  if (frame) {
    const hit = resolveFrameArg(await frameList(tabId), frame)
    if (!hit) throw fail('FRAME_NOT_FOUND', `no child frame matches ${frame}`)
    const owner = await send(tabId, 'DOM.getFrameOwner', { frameId: hit.frameId })
    const described = await send(tabId, 'DOM.describeNode', { backendNodeId: owner?.backendNodeId })
    rootNodeId = described?.node?.contentDocument?.nodeId
    if (!rootNodeId) throw fail('FRAME_NOT_FOUND', 'the frame document is not reachable from the tab')
    frameId = hit.frameId
  } else {
    const root = await send(tabId, 'DOM.getDocument', { depth: 0, pierce: false })
    rootNodeId = root.root.nodeId
  }
  const found = await send(tabId, 'DOM.querySelector', { nodeId: rootNodeId, selector })
  if (!found?.nodeId) throw fail('TARGET_NOT_FOUND', `no element matches ${selector}`)
  const describedNode = await send(tabId, 'DOM.describeNode', { nodeId: found.nodeId })
  const node = describedNode?.node ?? {}
  const attrs = {}
  for (let i = 0; i + 1 < (node.attributes?.length ?? 0); i += 2) attrs[node.attributes[i]] = node.attributes[i + 1]
  if (node.nodeName !== 'INPUT' || String(attrs.type ?? '').toLowerCase() !== 'file') {
    throw fail('NOT_A_FILE_INPUT', `${selector} is not an <input type="file">`)
  }
  await send(tabId, 'DOM.setFileInputFiles', { nodeId: found.nodeId, files: list })
  await delay(150)
  const meta = await pageMeta(tabId)
  return {
    url: meta?.url ?? '',
    title: meta?.title ?? '',
    count: list.length,
    files: list.map((f) => f.split(/[\\/]/).pop()),
    ...(frameId ? { frameId } : {}),
  }
}

async function wheelPage({ x, y, deltaX, deltaY, modifiers, tabId: hint }) {
  const tabId = await requirePage(hint)
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
    if (error?.code === 'TAB_NOT_VISIBLE') throw error
    throw error
  }
  const meta = await pageMeta(tabId)
  return { url: meta?.url ?? '', title: meta?.title ?? '', at: { x: px, y: py }, deltaX: dx, deltaY: dy, modifiers: mask }
}

/** Register a script that runs before any page script in every new document. */
async function evalInstall({ expression, tabId: hint }) {
  const tabId = await requirePage(hint)
  const source = String(expression ?? '')
  if (!source.trim()) throw fail('BAD_ARGUMENT', 'installOnNewDocument needs an expression')
  const added = await send(tabId, 'Page.addScriptToEvaluateOnNewDocument', { source })
  const identifier = added?.identifier
  if (!identifier) throw fail('CDP_ERROR', 'the script was not registered')
  if (!injectedScripts.has(tabId)) injectedScripts.set(tabId, new Map())
  injectedScripts.get(tabId).set(identifier, source)
  const meta = await pageMeta(tabId)
  return {
    url: meta?.url ?? '',
    title: meta?.title ?? '',
    installed: true,
    scriptId: identifier,
    bytes: source.length,
    note: 'runs before any page script in every new document of this tab, across reloads, until removed or the debugger detaches',
  }
}

async function evalRemove({ id, tabId: hint }) {
  const tabId = await requirePage(hint)
  const identifier = String(id ?? '')
  if (!identifier) throw fail('BAD_ARGUMENT', 'removeOnNewDocument needs the scriptId returned by the install call')
  const stored = injectedScripts.get(tabId)
  let removed = false
  try {
    await send(tabId, 'Page.removeScriptToEvaluateOnNewDocument', { identifier })
    removed = true
  } catch {
    removed = false
  }
  const known = stored ? stored.delete(identifier) : false
  const meta = await pageMeta(tabId)
  return { url: meta?.url ?? '', title: meta?.title ?? '', removed: removed || known, scriptId: identifier }
}

async function evalList({ tabId: hint }) {
  const tabId = await requirePage(hint)
  const stored = injectedScripts.get(tabId)
  const scripts = stored ? [...stored].map(([id, source]) => ({ id, bytes: source.length })) : []
  const meta = await pageMeta(tabId)
  return { url: meta?.url ?? '', title: meta?.title ?? '', count: scripts.length, scripts }
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

// ---------------------------------------------------------------------------
// DevTools Protocol plumbing
// ---------------------------------------------------------------------------

function rawSend(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      const error = chrome.runtime.lastError
      if (error) reject(fail('CDP_ERROR', error.message ?? String(error)))
      else resolve(result)
    })
  })
}

async function attach(tabId) {
  // Attaching twice is not an error: "Already attached" means we own it.
  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      const message = chrome.runtime.lastError?.message
      if (message && !/already attached/i.test(message)) reject(fail('CDP_ERROR', message))
      else resolve()
    })
  })
  attached.add(tabId)
  scheduleDetach(tabId)
  // Page events are what make dialog suppression and waits work; enabling this
  // is idempotent and cheap, and a page can navigate away and back at any time.
  // PAGE-NEUTRAL: no Emulation.* override is installed on attach. The bridge
  // observes and drives the page, it never changes what the page believes about
  // itself (focus, viewport, lifecycle, visibility). An earlier build forced
  // focus emulation here to keep timing-sensitive pages alive; that is exactly
  // the kind of silent frontend change the plugin now promises not to make.
  // The single exception is an override the user explicitly held: that is
  // restored below, and only when heldForced already contains this tab.
  await rawSend(tabId, 'Page.enable').catch(() => undefined)
  // A hold is the user's opt-in, not a default: after a detach or a worker
  // restart, re-attaching must not silently leave the page frozen. forceActive
  // re-reads the page first, so a tab that is already visible is left alone.
  await heldReady
  if (heldForced.has(tabId)) await forceActive(tabId, { mode: 'hold' })
}

/**
 * Attach, recovering from a tab parked on a Chrome error page.
 *
 * A certificate interstitial, a crashed renderer or `chrome://` leaves the tab
 * on a target DevTools refuses to attach to ("Cannot attach to this target").
 * The tab is still navigable, so parking it on about:blank and retrying makes
 * the next bsb_open work instead of failing before it can navigate anywhere.
 */
async function attachTab(tabId, { recover = false } = {}) {
  try {
    await attach(tabId)
    return { recovered: false }
  } catch (error) {
    const message = String(error?.message ?? error)
    if (!recover || !/cannot attach|not attached|no target/i.test(message)) throw error
    const tab = await chrome.tabs.get(tabId).catch(() => undefined)
    const parked = /^(chrome-error|chrome|devtools|edge|about):/i.test(String(tab?.url ?? ''))
    if (!parked) throw error
    await chrome.tabs.update(tabId, { url: 'about:blank' }).catch(() => undefined)
    await delay(250)
    await attach(tabId)
    return { recovered: true, was: String(tab?.url ?? '') }
  }
}

function detach(tabId) {
  attached.delete(tabId)
  injectedScripts.delete(tabId)
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      void chrome.runtime.lastError
      resolve()
    })
  })
}

function scheduleDetach(tabId) {
  if (detachTimer) clearTimeout(detachTimer)
  detachTimer = setTimeout(() => {
    detachTimer = undefined
    // A recording owns the session: detaching would stop the screencast feed
    // in the middle of the animation it is watching. A live network capture owns
    // it too — detaching disables Network.enable and silently stops collecting.
    if ((recorder && recorder.tabId === tabId) || netCaptures.has(tabId)) {
      scheduleDetach(tabId)
      return
    }
    if (attached.has(tabId)) void detach(tabId)
  }, DETACH_IDLE_MS)
}

function waitEvent(tabId, method, timeoutMs) {
  return new Promise((resolve, reject) => {
    const listener = (source, eventMethod, params) => {
      if (source.tabId !== tabId || eventMethod !== method) return
      cleanup()
      resolve(params)
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(fail('NAV_TIMEOUT', `timed out waiting for ${method}`))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      chrome.debugger.onEvent.removeListener(listener)
    }
    chrome.debugger.onEvent.addListener(listener)
  })
}

async function evaluate(tabId, expression) {
  const result = await send(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (result?.exceptionDetails) {
    const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluation failed'
    throw fail('CDP_ERROR', String(text).split('\n')[0])
  }
  return result?.result?.value
}

const pageMeta = (tabId) => evaluate(tabId, '(() => ({ url: location.href, title: document.title }))()')

/**
 * Bring the window that holds a tab to the front.
 *
 * A browser window that sits behind another one paints only about once a
 * second, and every screenshot then waits for that paint — a foreground window
 * is what makes a fast frame cadence possible.
 */
const windowInfo = async (tabId) => {
  try {
    const tab = await chrome.tabs.get(tabId)
    if (typeof tab?.windowId !== 'number') return null
    const window = await chrome.windows.get(tab.windowId)
    return { state: window?.state ?? 'unknown', focused: Boolean(window?.focused) }
  } catch {
    return null
  }
}

/**
 * Opt-in escape hatch for a page whose frame clock is paused.
 *
 * A sleeping display (or an occluded window on some platforms) leaves the tab
 * reporting `visibilityState: "hidden"`, and a page that animates on
 * requestAnimationFrame then stops advancing while input queues silently. The
 * bridge's contract is to never change what the page believes about itself, so
 * this is NOT installed on attach: a caller has to ask for it, by name, for one
 * action. When it is used the reply says so, because a screen the user cannot
 * see is producing the frames.
 */
const FORCE_ACTIVE_NOTE =
  'forced the page lifecycle to active for this call (it may not be on screen); '
  + 'screenshots and sampled pixels can be stale'

const FORCE_HOLD_NOTE =
  'holding the page lifecycle active until it is released; the page believes it is on screen, '
  + 'so it animates and accepts input while the display may be off'

/**
 * Tabs whose lifecycle override is being held, so a second call can extend it
 * instead of re-applying (and so release knows what to undo).
 */
const heldForced = new Set()

/**
 * A hold has to outlive this worker, not just this call.
 *
 * MV3 restarts the service worker whenever it idles, which used to silently drop
 * both the CDP override and the Set that knew about it: the next call re-attached
 * to a frozen page with no idea the user had asked for it to stay awake. The tab
 * ids are mirrored into chrome.storage.session — it survives a worker restart and
 * an extension reload, and dies with the browser session — so attach can restore
 * the hold instead of rediscovering the problem. A closed tab's id is harmless:
 * nothing attaches to it again within the session.
 */
const HELD_KEY = 'heldTabs'
const heldReady = (async () => {
  try {
    const stored = await chrome.storage.session.get(HELD_KEY)
    const list = stored?.[HELD_KEY]
    if (Array.isArray(list)) for (const id of list) if (Number.isFinite(id)) heldForced.add(id)
  } catch {}
})()

async function persistHeld() {
  try { await chrome.storage.session.set({ [HELD_KEY]: [...heldForced] }) } catch {}
}

/**
 * `mode: 'hold'` keeps the override until `releaseActive` is called.
 *
 * The per-call form is enough to land an input, but it clears itself before the
 * frame the user would be looking at is drawn — the window wakes, takes one
 * keystroke, and drops back. A held override is what makes the behaviour
 * observable, which is the only reason to have the hatch at all.
 */
async function forceActive(tabId, { mode = 'call' } = {}) {
  await heldReady
  const held = mode === 'hold'
  if (heldForced.has(tabId)) {
    // A held override does not survive a navigation: the tab keeps its id, but the
    // new document starts hidden again, so the CDP session that carried the override
    // is gone. Trusting this Set made a stale hold answer `reused` while the frame
    // clock was still stopped — the failure mode the hatch exists to prevent, now
    // reporting success. Re-read the page before claiming the override is in force.
    const visibility = await evaluate(tabId, 'document.visibilityState').catch(() => null)
    if (visibility === 'visible') {
      return { applied: ['focus', 'lifecycle'], held: true, reused: true, visibility, note: FORCE_HOLD_NOTE }
    }
    heldForced.delete(tabId)
    await persistHeld()
  }
  const applied = []
  const applyOverrides = async () => {
    try {
      await rawSend(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true })
      applied.push('focus')
    } catch {}
    try {
      await rawSend(tabId, 'Page.setWebLifecycleState', { state: 'active' })
      applied.push('lifecycle')
    } catch {}
  }
  await applyOverrides()
  if (!applied.length) {
    // The first call after a long idle gap has been seen to have a session that
    // refuses both overrides even though the tab is attached; re-attaching once
    // recovers it. This is still the opt-in hatch, never a default behaviour.
    await attachTab(tabId).catch(() => undefined)
    await applyOverrides()
  }
  if (!applied.length) {
    throw fail('FORCE_FAILED', 'the browser refused both focus emulation and a lifecycle override, so a paused page cannot be woken this way')
  }
  if (held) {
    heldForced.add(tabId)
    await persistHeld()
  }
  // Report what the page observed, not only what was requested: a CDP call that
  // "succeeded" while the tab still reports hidden is exactly the case a caller
  // cannot distinguish from a working hatch otherwise.
  const visibility = await evaluate(tabId, 'document.visibilityState').catch(() => null)
  return { applied, held, visibility: visibility ?? undefined, note: held ? FORCE_HOLD_NOTE : FORCE_ACTIVE_NOTE }
}

/**
 * Drop a held override. Safe to call when nothing is held.
 *
 * The lifecycle override cannot be "restored" — CDP has no auto value — so
 * release re-reads the truth: the tab is left as the browser now reports it.
 */
async function releaseActive(tabId) {
  await heldReady
  const wasHeld = heldForced.delete(tabId)
  if (!wasHeld) return { released: false }
  await persistHeld()
  await rawSend(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => undefined)
  const visibility = await evaluate(tabId, 'document.visibilityState').catch(() => null)
  return { released: true, visibility: visibility ?? undefined }
}

async function clearForced(tabId, forced) {
  if (!forced) return
  // A held override outlives the call that started it.
  if (forced.held || heldForced.has(tabId)) return
  // The focus override is symmetric, so it is always removed.
  if (forced.applied.includes('focus')) {
    await rawSend(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => undefined)
  }
  // The lifecycle override is not: CDP has no "let the browser decide" value, so
  // there is nothing to restore. It is dropped on detach instead, where the page
  // stops being ours; forcing it back to `active` would be a second silent lie.
}

/**
 * Explicit control of the escape hatch, for a caller that wants the page to stay
 * awake across many calls (watching a run, or a game that needs a live clock).
 */
async function forcePage({ mode, tabId: hint }) {
  const tabId = await requirePage(hint)
  const held = mode === 'hold'
  const forced = await forceActive(tabId, { mode: held ? 'hold' : 'call' })
  return { url: (await pageMeta(tabId))?.url ?? '', ...forced }
}

async function releasePage({ tabId: hint }) {
  const tabId = await requirePage(hint)
  return { url: (await pageMeta(tabId))?.url ?? '', ...(await releaseActive(tabId)) }
}

/**
 * Pointer input is only meaningful in a laid-out viewport: a minimised Chrome
 * window reports a 0x0 layout viewport, which collapses every measured box into
 * negative coordinates. This plugin never raises a window to repair that — the
 * caller restores it — because forceActive cannot invent layout and a silent
 * raise takes over the desktop.
 */
async function ensureLayout(tabId, { forceActive: wanted = false } = {}) {
  let size = await evaluate(tabId, '({ w: innerWidth, h: innerHeight })').catch(() => null)
  // A paused page still has a layout viewport, so a 0x0 check cannot see the
  // difference — but pointer input into a page whose frame clock has stopped is
  // the same dead end, so the opt-in is honoured here too.
  let forced
  if (wanted) {
    const painted = await evaluate(tabId, 'document.visibilityState').catch(() => null)
    if (painted === 'hidden') forced = await forceActive(tabId)
  }
  if (size && Number(size.w) > 0 && Number(size.h) > 0) return { restored: false, view: size, forced }
  await delay(400)
  const after = await evaluate(tabId, '({ w: innerWidth, h: innerHeight })').catch(() => null)
  if (!after || !(Number(after.w) > 0) || !(Number(after.h) > 0)) {
    throw fail('TAB_NOT_VISIBLE', 'the browser window is minimised; restore it so the page can be laid out. This plugin no longer raises windows.')
  }
  return { restored: false, view: after, forced }
}

async function waitReady(tabId, timeoutMs) {
  const started = Date.now()
  for (;;) {
    try {
      const state = await evaluate(tabId, 'document.readyState')
      if (state === 'complete') return
    } catch {
      // A navigation in flight can reject evaluation; keep polling.
    }
    if (Date.now() - started > timeoutMs) return
    await delay(200)
  }
}

// ---------------------------------------------------------------------------
// Page functions (serialized into the page; no outer-scope references)
// ---------------------------------------------------------------------------

function snapshotPage(maxChars, maxElements) {
  const text = (document.body ? document.body.innerText : '') || ''

  const cssPath = (el) => {
    // Inside a shadow root a path is relative to that root: `deepFindExpr` tries
    // every open root with the same selector, so a root-local path resolves.
    const root = el.getRootNode()
    if (el.id && root.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + CSS.escape(el.id)
    const parts = []
    let current = el
    while (current && current.nodeType === 1 && parts.length < 8) {
      let selector = current.tagName.toLowerCase()
      const parent = current.parentElement
      if (parent) {
        const siblings = Array.prototype.filter.call(parent.children, (child) => child.tagName === current.tagName)
        if (siblings.length > 1) selector += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')'
      }
      parts.unshift(selector)
      const candidate = parts.join(' > ')
      if (root.querySelectorAll(candidate).length === 1) return candidate
      current = parent
    }
    return parts.join(' > ')
  }
  const query = 'a,button,input,textarea,select,label,summary,img[alt],[role],[tabindex],[contenteditable="true"],[onclick]'
  const roots = [document]
  const shadowText = []
  for (let index = 0; index < roots.length && roots.length < 24; index++) {
    const root = roots[index]
    if (root !== document) shadowText.push((root.textContent || '').replace(/\s+/g, ' ').trim())
    for (const el of Array.prototype.slice.call(root.querySelectorAll('*'))) {
      if (el.shadowRoot) roots.push(el.shadowRoot)
    }
  }
  const inShadow = new Set()
  const candidates = []
  for (const root of roots) {
    for (const el of Array.prototype.slice.call(root.querySelectorAll(query))) {
      if (root !== document) inShadow.add(el)
      candidates.push(el)
    }
    // Widgets built from plain divs (custom checkboxes, canvas overlays) have no
    // semantic tag; a pointer cursor is the only reliable signal that they act.
    for (const el of Array.prototype.slice.call(root.querySelectorAll('div,span,li,img,canvas'))) {
      if (candidates.length > 4000) break
      if (el.closest('a,button,label,summary')) continue
      const style = getComputedStyle(el)
      if (style.cursor === 'pointer' || el.hasAttribute('onclick')) {
        if (root !== document) inShadow.add(el)
        candidates.push(el)
      }
    }
  }
  const elements = []
  for (const el of candidates) {
    if (elements.length >= maxElements) break
    const rect = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    if (rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.display === 'none') continue
    const label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || (el.innerText || '').trim() || el.value || el.getAttribute('name') || ''
    elements.push({
      ref: '@e' + (elements.length + 1),
      selector: cssPath(el),
      role: el.getAttribute('role') || el.tagName.toLowerCase(),
      name: String(label).replace(/\s+/g, ' ').slice(0, 80),
      // Anything inside an open shadow root cannot be reached by a plain
      // document.querySelector in page-space tools, so say where it lives.
      ...(inShadow.has(el) ? { shadow: true } : {}),
      // Viewport CSS-pixel box: lets the caller click a precise point inside a
      // widget even when no element is a suitable click target.
      x: Math.round(rect.left * 10) / 10,
      y: Math.round(rect.top * 10) / 10,
      width: Math.round(rect.width * 10) / 10,
      height: Math.round(rect.height * 10) / 10,
    })
  }
  // Shadow content is invisible to body.innerText; append a compact digest so
  // the sample text still describes what a shadow-heavy page shows.
  const shadowDigest = shadowText.filter(Boolean).join(' ¶ ').slice(0, 1500)
  const full = shadowDigest ? text + '\n--- shadow ---\n' + shadowDigest : text
  const truncated = full.length > maxChars
  return {
    url: location.href,
    title: document.title,
    text: truncated ? full.slice(0, maxChars) : full,
    truncated,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio,
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
    },
    elements,
  }
}

function deepFindExpr(selector) {
  return `(() => {
    const walk = (sel, root) => {
      const direct = root.querySelector(sel);
      if (direct) return direct;
      for (const el of root.querySelectorAll('*')) {
        if (!el.shadowRoot) continue;
        const inner = walk(sel, el.shadowRoot);
        if (inner) return inner;
      }
      return null;
    };
    return walk(${JSON.stringify(String(selector))}, document);
  })()`
}

function boxOf(selector) {
  const el = document.querySelector(selector) ?? (() => {
    const walk = (sel, root) => {
      const direct = root.querySelector(sel);
      if (direct) return direct;
      for (const node of root.querySelectorAll('*')) {
        if (!node.shadowRoot) continue;
        const inner = walk(sel, node.shadowRoot);
        if (inner) return inner;
      }
      return null;
    };
    return walk(selector, document);
  })()
  if (!el) return null
  // `behavior: 'instant'` is not a nicety. Pages that set
  // `html { scroll-behavior: smooth }` turn a plain scrollIntoView into an
  // animation that returns immediately, so the rect measured on the next line is
  // still the pre-scroll one and the press lands offscreen — silently, because a
  // click outside the viewport is a no-op rather than an error.
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  let rect = el.getBoundingClientRect()
  if (rect.bottom > innerHeight || rect.top < 0 || rect.right > innerWidth || rect.left < 0) {
    // Belt and braces for a container that swallowed the scroll: move the window
    // to the element ourselves, then re-measure.
    window.scrollBy(0, rect.top - innerHeight / 2 + rect.height / 2)
    rect = el.getBoundingClientRect()
  }
  if (rect.width <= 0 || rect.height <= 0) return null
  // If it still is not visible, say so instead of pressing empty space: a click
  // outside the viewport is a silent no-op, which reads as "the page ignored me".
  const offscreen = rect.top < 0 || rect.bottom > innerHeight || rect.left < 0 || rect.right > innerWidth
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, offscreen }
}

const pngSize = (base64) => {
  try {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    const view = new DataView(bytes.buffer)
    return { width: view.getUint32(16), height: view.getUint32(20) }
  } catch {
    return { width: 0, height: 0 }
  }
}

/**
 * Crop a region out of a PNG and scale it up.
 *
 * Chrome interprets Page.captureScreenshot clip coordinates in the zoomed
 * screen space, so an element's getBoundingClientRect rect lands elsewhere on
 * the page when the page zoom is not 100%. Cropping from a plain viewport shot
 * in device pixels avoids that mismatch.
 */
const cropPng = async (base64, sx, sy, sw, sh, outScale, mime = 'image/png') => {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }))
  const width = Math.max(1, Math.round(sw * outScale))
  const height = Math.max(1, Math.round(sh * outScale))
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(bitmap, sx, sy, sw, sh, 0, 0, width, height)
  bitmap.close?.()
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  const out = new Uint8Array(await blob.arrayBuffer())
  let text = ''
  for (let i = 0; i < out.length; i += 0x8000) {
    text += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000))
  }
  return btoa(text)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The tab this browser is driving, if any. */
const getTrackedId = async () => {
  // local, not session: a reload wipes session storage and would orphan the tab
  const { tabId } = await chrome.storage.local.get('tabId')
  return typeof tabId === 'number' ? tabId : undefined
}

const trackId = (id) => chrome.storage.local.set({ tabId: id })

async function trackedTab() {
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
async function openExtensionPage({ path }) {
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
async function openUrl({ url, active = true }) {
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

async function openPage({ url, newTab, activate, tabId: hint }) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw fail('BAD_ARGUMENT', 'url must be an absolute http(s) URL')
  // Never borrow a tab the user is on: an earlier same-origin adoption rule
  // navigated the dashboard's own tab. Reuse only the tab this session tracks,
  // or the tab explicitly named by the caller; otherwise create one.
  let tab = newTab ? undefined : await trackedTab()
  if (!tab && typeof hint === 'number') {
    tab = await chrome.tabs.get(hint).catch(() => undefined)
  }
  // Background by default: opening a page for automation must not raise the
  // window or steal the active tab. activate:true is the explicit opt-in.
  if (!tab) tab = await chrome.tabs.create({ url: 'about:blank', active: activate === true })
  await trackId(tab.id)
  refs = new Map()
  const recovered = await attachTab(tab.id, { recover: true })
  await send(tab.id, 'Page.enable')
  // PAGE-NEUTRAL: the tab keeps the lifecycle and focus state the browser gives
  // it. Background/minimized tabs run slower — the tools report that measured
  // frame rate instead of overriding it, because forcing `active`/focus would
  // change site behaviour the user did not ask us to change.
  const loaded = waitEvent(tab.id, 'Page.loadEventFired', 20000).catch(() => undefined)
  await send(tab.id, 'Page.navigate', { url })
  await loaded
  await waitReady(tab.id, 8000)
  await delay(600)
  const meta = await pageMeta(tab.id)
  const out = { tabId: tab.id, url: meta?.url ?? url, title: meta?.title ?? '' }
  if (recovered?.recovered) out.recoveredFrom = recovered.was
  return out
}

async function requirePage(hint) {
  if (typeof hint === 'number') {
    try {
      const tab = await chrome.tabs.get(hint)
      if (tab) { await trackId(tab.id); return tab.id }
    } catch {}
  }
  const tab = await trackedTab()
  if (!tab) throw fail('NO_TAB', 'No page is open; call bsb_open first.')
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

async function readPage({ maxChars, maxElements, probe, frame, tabId: hint }) {
  const tabId = await requirePage(hint)
  let frameHit
  let contextId
  if (frame !== undefined && frame !== null && String(frame).trim() !== '') {
    try {
      const resolved = await frameContext(tabId, frame)
      frameHit = resolved.frame
      contextId = resolved.contextId
    } catch (error) {
      throw fail(
        'FRAME_NOT_READABLE',
        `bsb_read could not read frame ${JSON.stringify(String(frame))}: ${error?.message ?? 'the frame is not inspectable'}. A cross-origin frame cannot be read from the tab target; open it at its own URL or read the frame element instead.`,
      )
    }
  }
  const readIn = (source) => (contextId === undefined
    ? evaluate(tabId, source)
    : evaluateInContext(tabId, contextId, source))
  const value = await readIn(`(${snapshotPage.toString()})(${Number(maxChars) || 6000}, ${Number(maxElements) || 60})`)
  if (!value || typeof value !== 'object') throw fail('CDP_ERROR', 'the page could not be read')
  const wanted = (Array.isArray(probe) ? probe : [])
    .filter((selector) => typeof selector === 'string' && selector.length > 0 && selector.length <= 400)
    .slice(0, 20)
  if (wanted.length > 0) {
    value.probes = await readIn(`(() => {
      const out = [];
      for (const selector of ${JSON.stringify(wanted)}) {
        const el = document.querySelector(selector);
        if (!el) { out.push({ selector, found: false }); continue; }
        const rect = el.getBoundingClientRect();
        out.push({
          selector,
          found: true,
          role: (el.tagName || '').toLowerCase(),
          box: {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            width: rect.width,
            height: rect.height,
          },
        });
      }
      return out;
    })()`)
  }
  refs = new Map(value.elements.map((element) => [element.ref, element.selector]))
  const dialog = recentDialog(tabId)
  if (dialog) {
    value.dialog = dialog
    dialogs.delete(tabId)
  }
  if (frameHit) {
    value.frameId = frameHit.frameId
    if (frameHit.url) value.frameUrl = frameHit.url
  }
  return value
}

const resolveTarget = (target) => {
  if (typeof target !== 'string' || target.length === 0) throw fail('BAD_ARGUMENT', 'target is required')
  if (!target.startsWith('@')) return target
  const selector = refs.get(target)
  if (!selector) throw fail('TARGET_NOT_FOUND', `${target} is no longer valid; call bsb_read again`)
  return selector
}

/**
 * Locate a clickable point by visible text.
 *
 * Refs go stale on every re-render and selectors assume the page's markup, but
 * a human picking a button by its label is stable: exact matches win over
 * substrings, and the smallest box wins over a container that merely contains
 * the text.
 */
async function findTextPoint(tabId, text) {
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
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: best.text, scrolled, matches: out.length };
  })()`)
  if (!found) throw fail('TARGET_NOT_FOUND', `no visible element contains the text ${JSON.stringify(wanted)}`)
  return found
}

// A human tapping the same control several times is one gesture; repeating the
// tool call instead costs a model round trip and trips harness repeat warnings.
async function pressAt(tabId, point, count, button = 'left', holdMs = 0) {
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
 * Resolve the image-map <area> under a viewport point, if any.
 *
 * A synthetic press lands on the <img>, but the browser's own image-map
 * navigation is not reliably triggered by it, so a page whose only links are
 * <area href> looks completely inert. The caller presses normally first and
 * follows the area's href itself only when the URL has not moved.
 */
function mapAreaAt(x, y) {
  const hit = document.elementFromPoint(x, y);
  if (!hit || hit.tagName !== 'IMG' || !hit.useMap) return null;
  const map = document.querySelector(hit.useMap);
  if (!map) return null;
  const rect = hit.getBoundingClientRect();
  const sx = hit.naturalWidth ? hit.naturalWidth / (rect.width || 1) : 1;
  const sy = hit.naturalHeight ? hit.naturalHeight / (rect.height || 1) : 1;
  const ix = (x - rect.left) * sx;
  const iy = (y - rect.top) * sy;
  for (const area of map.querySelectorAll('area')) {
    const href = area.getAttribute('href');
    // Same-document and script hrefs are not navigations; following them would
    // either do nothing or hand Page.navigate a javascript: URL it rejects.
    if (!href || href.charAt(0) === '#' || /^\s*(javascript|mailto|tel):/i.test(href)) continue;
    const coords = String(area.getAttribute('coords') || '').split(',').map(Number);
    const shape = String(area.getAttribute('shape') || 'rect').toLowerCase();
    if (shape === 'rect' && coords.length >= 4) {
      if (ix >= coords[0] && ix <= coords[2] && iy >= coords[1] && iy <= coords[3]) return { href: href, shape: shape };
    } else if (shape === 'circle' && coords.length >= 3) {
      const dx = ix - coords[0], dy = iy - coords[1];
      if (dx * dx + dy * dy <= coords[2] * coords[2]) return { href: href, shape: shape };
    } else if (shape === 'poly' && coords.length >= 6) {
      let inside = false;
      for (let i = 0, j = coords.length - 2; i < coords.length; j = i, i += 2) {
        const xi = coords[i], yi = coords[i + 1], xj = coords[j], yj = coords[j + 1];
        if ((yi > iy) !== (yj > iy) && ix < ((xj - xi) * (iy - yi)) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) return { href: href, shape: shape };
    } else if (shape === 'default') {
      return { href: href, shape: shape };
    }
  }
  return null;
}

/**
 * Follow an image-map <area href> when a synthetic press did not navigate.
 * Returns the URL it navigated to, or null when nothing was followed.
 */
async function followMapArea(tabId, x, y, beforeUrl, afterUrl) {
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

async function clickPage({ target, text, x, y, frame, count, targets, all, button, holdMs, forceActive: forceWanted, tabId: hint }) {
  const tabId = await requirePage(hint)
  const layout = await ensureLayout(tabId, { forceActive: forceWanted })
  const forced = layout?.forced
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
    return { url: batchMeta?.url ?? '', title: batchMeta?.title ?? '', clicked, clicks: clicked.length, windowRestored: layout.restored, dialog: recentDialog(tabId) }
  }
  // Coordinate clicks: many widgets (canvas maps, custom controls) expose no
  // usable selector, but the agent can still see where to press.
  if (Number.isFinite(Number(x)) && Number.isFinite(Number(y))) {
    const px = Number(x), py = Number(y)
    const before = await pageMeta(tabId)
    const taps = await pressAt(tabId, { x: px, y: py }, count, button, holdMs)
    await delay(150)
    let meta = await pageMeta(tabId)
    const followed = await followMapArea(tabId, px, py, before?.url, meta?.url)
    if (followed) meta = (await pageMeta(tabId)) ?? meta
    return { url: meta?.url ?? '', title: meta?.title ?? '', clickedAt: { x: px, y: py }, clicks: taps, windowRestored: layout.restored, dialog: recentDialog(tabId), followed }
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
    const taps = await pressAt(tabId, { x: px, y: py }, count, button, holdMs)
    await delay(400)
    const meta = await pageMeta(tabId)
    return { url: meta?.url ?? '', title: meta?.title ?? '', frameId: hit.frameId, clickedAt: { x: px, y: py }, clicks: taps, windowRestored: layout.restored, dialog: recentDialog(tabId) }
  }
  // Text targeting: the label survives re-renders that invalidate @eN refs, and
  // needs no knowledge of the page's markup.
  if (text) {
    const hit = await findTextPoint(tabId, text)
    if (hit.scrolled) await delay(180)
    const taps = await pressAt(tabId, { x: hit.x, y: hit.y }, count, button, holdMs)
    await delay(400)
    const meta = await pageMeta(tabId)
    return { url: meta?.url ?? '', title: meta?.title ?? '', matchedText: hit.text, matchedCount: hit.matches, clickedAt: { x: hit.x, y: hit.y }, clicks: taps, windowRestored: layout.restored, dialog: recentDialog(tabId) }
  }
  const selector = resolveTarget(target)
  // Press every match in one call: dense grids of checkboxes otherwise cost one
  // tool round trip per tile.
  if (all === true) {
    const points = await evaluate(tabId, `(() => { const out = []; const nodes = document.querySelectorAll(${JSON.stringify(selector)}); for (const el of nodes) { const r = el.getBoundingClientRect(); if (r.width > 0 && r.height > 0) out.push({ x: r.left + r.width / 2, y: r.top + r.height / 2 }); } return out; })()`)
    if (!points || !points.length) throw fail('TARGET_NOT_FOUND', `no clickable element matches ${selector}`)
    const pressed = []
    for (const point of points) {
      await pressAt(tabId, point, 1, button)
      pressed.push(point)
      await delay(50)
    }
    await delay(200)
    const allMeta = await pageMeta(tabId)
    return { url: allMeta?.url ?? '', title: allMeta?.title ?? '', clicked: pressed, clicks: pressed.length, matchedCount: points.length, windowRestored: layout.restored, dialog: recentDialog(tabId) }
  }
  const box = await evaluate(tabId, `(${boxOf.toString()})(${JSON.stringify(selector)})`)
  if (!box) throw fail('TARGET_NOT_FOUND', `no clickable element matches ${selector}`)
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
  const taps = await pressAt(tabId, { x: box.x, y: box.y }, count, button)
  await delay(400)
  let meta = await pageMeta(tabId)
  const followed = await followMapArea(tabId, box.x, box.y, beforeClick?.url, meta?.url)
  if (followed) meta = (await pageMeta(tabId)) ?? meta
  const described = await evaluate(tabId, `(() => { try { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; return { tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 40), id: el.id || undefined, name: el.getAttribute?.('name') || undefined }; } catch { return null } })()`)
  const hidden = await pageHidden(tabId)
  if (forced) await clearForced(tabId, forced)
  return {
    url: meta?.url ?? '', title: meta?.title ?? '', matchedCount: matched, element: described ?? undefined,
    clickedAt: { x: box.x, y: box.y }, clicks: taps, windowRestored: layout.restored,
    dialog: recentDialog(tabId), followed, hidden, hint: hidden && !forced ? HIDDEN_HINT : undefined,
    forced: forced ? { ...forced, cleared: true } : undefined,
  }
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
async function clearAndType(tabId, text) {
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
 * it does not contain the text the value is set through the prototype setter
 * and announced with input/change so v-model-style bindings still fire.
 */
async function ensureTyped(tabId, selector, text, contextId) {
  const wanted = String(text ?? '')
  const find = deepFindExpr(selector)
  const read = `(() => { const el = ${find}; if (!el) return null;
    const raw = el.value !== undefined ? el.value : el.textContent;
    return String(raw || ''); })()`
  const run = (source) => (contextId === undefined
    ? evaluate(tabId, source)
    : evaluateInContext(tabId, contextId, source)).catch(() => null)
  const value = await run(read)
  if (typeof value === 'string' && value.includes(wanted)) return { value, forced: false }
  const write = `(() => { const el = ${find}; if (!el) return null;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    const next = ${JSON.stringify(wanted)};
    if (setter) setter.call(el, next); else el.value = next;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    const raw = el.value !== undefined ? el.value : el.textContent;
    return String(raw || ''); })()`
  const forced = await run(write)
  return { value: forced ?? value, forced: true }
}

const editableInfoExpr = (selector) => `(() => {
  const el = ${deepFindExpr(selector)};
  if (!el) return null;
  const tag = (el.tagName || '').toLowerCase();
  const type = (el.getAttribute('type') || '').toLowerCase();
  const textInput = tag === 'input' && !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'range', 'color'].includes(type);
  return { tag, type, editable: textInput || tag === 'textarea' || el.isContentEditable === true };
})()`

async function typePage({ target, text, submit, frame, tabId: hint }) {
  const tabId = await requirePage(hint)
  await ensureLayout(tabId)
  if (frame) {
    const { frame: hit, contextId } = await frameContext(tabId, frame)
    const selector = resolveTarget(target)
    const focused = await evaluateInContext(tabId, contextId, `(() => {
      const el = ${deepFindExpr(selector)};
      if (!el) return false;
      el.focus();
      return true;
    })()`)
    if (!focused) throw fail('TARGET_NOT_FOUND', `no field matches ${selector} in frame ${hit.url || hit.frameId}`)
    const info = await evaluateInContext(tabId, contextId, editableInfoExpr(selector))
    if (!info) throw fail('TARGET_NOT_FOUND', `no field matches ${selector} in frame ${hit.url || hit.frameId}`)
    if (!info.editable) {
      throw fail('NOT_EDITABLE', `type cannot write into <${info.tag}${info.type ? ' type=' + info.type : ''}>: it holds no text value. Use action "key" with text for a canvas or key-driven field, or set/select for a form control.`)
    }
    await clearAndType(tabId, text)
    const frameTyped = await ensureTyped(tabId, selector, text, contextId)
    if (submit === true) {
      const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
      await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...key })
      await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...key })
    }
    await delay(300)
    const frameMeta = await pageMeta(tabId)
    return { url: frameMeta?.url ?? '', title: frameMeta?.title ?? '', frameId: hit.frameId, typed: frameTyped.value ?? undefined, forced: frameTyped.forced }
  }
  const selector = resolveTarget(target)
  const focused = await evaluate(tabId, `(() => {
    const el = ${deepFindExpr(selector)};
    if (!el) return false;
    el.focus();
    return true;
  })()`)
  if (!focused) throw fail('TARGET_NOT_FOUND', `no field matches ${selector}`)
  const info = await evaluate(tabId, editableInfoExpr(selector))
  if (!info) throw fail('TARGET_NOT_FOUND', `no field matches ${selector}`)
  if (!info.editable) {
    throw fail('NOT_EDITABLE', `type cannot write into <${info.tag}${info.type ? ' type=' + info.type : ''}>: it holds no text value. Use action "key" with text for a canvas or key-driven field, or set/select for a form control.`)
  }
  // Insert as real input so every keystroke goes through the page's handlers.
  await clearAndType(tabId, text)
  const landed = await ensureTyped(tabId, selector, text)
  if (submit === true) {
    const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...key })
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...key })
  }
  await delay(300)
  const meta = await pageMeta(tabId)
  return { url: meta?.url ?? '', title: meta?.title ?? '', typed: landed.value ?? undefined, forced: landed.forced }
}

/** Resolve a click/drag endpoint from either a target/selector or a coordinate. */
async function pagePoint(tabId, target, px, py) {
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
async function dragPage({ target, toTarget, x, y, toX, toY, frame, steps, holdMs, path, instant, tabId: hint }) {
  const tabId = await requirePage(hint)
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
      return { url: metaInstant?.url ?? '', title: metaInstant?.title ?? '', from: capped[0], to: lastInstant, points: capped.length, instant: true, dialog: recentDialog(tabId) }
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
    return { url: meta?.url ?? '', title: meta?.title ?? '', from: capped[0], to: last, points: capped.length, dialog: recentDialog(tabId) }
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
  return { url: meta?.url ?? '', title: meta?.title ?? '', from, to, steps: count, ...(frameId ? { frameId } : {}), dialog: recentDialog(tabId) }
}

/**
 * Move the pointer over an element (or point) without clicking.
 *
 * Menus, tooltips and reveal-on-hover controls only open on a real pointer
 * move; keeping the pointer there is enough to read the revealed content.
 */
async function hoverPage({ target, text, x, y, frame, tabId: hint }) {
  const tabId = await requirePage(hint)
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
  const result = { url: meta?.url ?? '', title: meta?.title ?? '', at: point, scrolled, dialog: recentDialog(tabId) }
  if (typeof frameId === 'string' && frameId) result.frameId = frameId
  return result
}

/**
 * Choose an option in a <select> by value, visible label or zero-based index.
 *
 * Native dropdowns render outside the page, so a click opens an OS menu that
 * CDP cannot address; setting the option and firing input/change is the
 * reliable path. The result reports the value that actually stuck.
 */
async function selectOption({ target, value, label, index, frame, tabId: hint }) {
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
async function setControl({ target, value, checked, frame, tabId: hint }) {
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


const KEY_MAP = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
}

/**
 * Dispatch a named key (`Enter`, `Tab`, `Escape`, arrows, `Space`, …) N times.
 *
 * Key handlers that ignore synthetic `.click()` still receive a real key event,
 * and some widgets only advance on `ArrowRight`/`Space`.
 */
/**
 * Physical-key names games actually listen for, as `event.code` values.
 *
 * A game binds `keydown` to codes like KeyW / Digit4 / ShiftLeft, not to the
 * printable character. Refusing those forced a caller to dispatch synthetic
 * KeyboardEvents by hand, which is exactly the work a browser tool exists to
 * remove, so the resolver now accepts real codes as well as friendly names.
 */
const CODE_VK = {
  Shift: 16, Control: 17, Alt: 18, Meta: 91, CapsLock: 20,
  Backquote: 192, Minus: 189, Equal: 187, BracketLeft: 219, BracketRight: 221,
  Backslash: 220, Semicolon: 186, Quote: 222, Comma: 188, Period: 190, Slash: 191,
  Insert: 45, ContextMenu: 93, PrintScreen: 44, ScrollLock: 145, Pause: 19,
  NumLock: 144, NumpadAdd: 107, NumpadSubtract: 109, NumpadMultiply: 106,
  NumpadDivide: 111, NumpadDecimal: 110, NumpadEnter: 13,
}
const MODIFIER_CODES = { ShiftLeft: 'Shift', ShiftRight: 'Shift', ControlLeft: 'Control', ControlRight: 'Control', AltLeft: 'Alt', AltRight: 'Alt', MetaLeft: 'Meta', MetaRight: 'Meta' }
const PUNCT_KEYS = {
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
}
const CODE_NAME = /^(Key[A-Z]|Digit[0-9]|Numpad[0-9]|F([1-9]|1[0-2])|(Shift|Control|Alt|Meta)(Left|Right)|CapsLock|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Insert|ContextMenu|PrintScreen|ScrollLock|Pause|NumLock|NumpadAdd|NumpadSubtract|NumpadMultiply|NumpadDivide|NumpadDecimal|NumpadEnter)$/

const specForCode = (code) => {
  if (MODIFIER_CODES[code]) return { key: MODIFIER_CODES[code], code, vk: CODE_VK[MODIFIER_CODES[code]] }
  if (/^Key[A-Z]$/.test(code)) {
    const letter = code.slice(3)
    return { key: letter.toLowerCase(), code, vk: letter.charCodeAt(0), text: letter.toLowerCase() }
  }
  if (/^Digit[0-9]$/.test(code)) {
    const digit = code.slice(5)
    return { key: digit, code, vk: digit.charCodeAt(0), text: digit }
  }
  if (/^Numpad[0-9]$/.test(code)) {
    const digit = code.slice(6)
    return { key: digit, code, vk: 96 + Number(digit), text: digit }
  }
  if (/^F([1-9]|1[0-2])$/.test(code)) return { key: code, code, vk: 111 + Number(code.slice(1)) }
  if (PUNCT_KEYS[code]) return { key: PUNCT_KEYS[code], code, vk: CODE_VK[code], text: PUNCT_KEYS[code] }
  if (CODE_VK[code] !== undefined) return { key: code, code, vk: CODE_VK[code] }
  return null
}

const keySpec = (raw) => {
  const name = String(raw ?? '').trim()
  if (!name) return null
  const friendly = KEY_MAP[name]
  if (friendly) return friendly
  // A single character is the printable key itself; a letter or digit given as
  // a word ("KeyW", "Digit4") is the physical key.
  if (/^[a-zA-Z0-9]$/.test(name)) {
    return { key: name, code: 'Key' + name.toUpperCase(), vk: name.toUpperCase().charCodeAt(0), text: name }
  }
  return CODE_NAME.test(name) ? specForCode(name) : null
}


/** Read the parking-game canvas as structured data: the tracked car box and the background. */
// A cheap fingerprint of the biggest canvas on the page: enough to tell
// "still animating" from "settled" without touching the frame buffer twice.
const CANVAS_SIGNATURE_EXPR = `(() => {
  const list = [...document.querySelectorAll('canvas')]
  const c = list.sort((a, b) => b.width * b.height - a.width * a.height)[0]
  if (!c || !c.getContext) return null
  const g = c.getContext('2d', { willReadFrequently: true })
  if (!g) return null
  const w = Math.min(c.width, 96), h = Math.min(c.height, 96)
  let d
  try { d = g.getImageData(0, 0, w, h).data } catch { return null }
  let hash = 0
  for (let i = 0; i < d.length; i += 13) hash = (hash * 31 + d[i] + d[i + 3] * 7) | 0
  return hash
})()`

const lastCarPose = new Map()
/** Attach the sprite's velocity (game units/s) to a measurement. */
const withVelocity = (tabId, measurement) => {
  // Continuity: a scene can hold several bright-neutral sprites (the player, the
  // traffic art cars). Sticking to the component closest to the pose seen on the
  // previous tick stops the controller from chasing a passing car.
  if (measurement && measurement.car) {
    const prev = lastCarPose.get(tabId)
    if (prev && Date.now() - prev.t < 3000) {
      const all = [measurement.car, ...(measurement.others || [])]
      // Shape/colour gate: a traffic sprite can sit nearer than the player one
      // tick, so only candidates matching the previous sprite's brightness and
      // pixel area are eligible for the continuity re-pick.
      const near = (p) => {
        if (prev.b != null && p.b != null && Math.abs(p.b - prev.b) > 22) return false
        if (prev.n && p.n && (p.n > prev.n * 1.7 || p.n < prev.n * 0.55)) return false
        return true
      }
      let best = null, bestD = Infinity
      for (const p of all) {
        if (!near(p)) continue
        const d = Math.hypot(p.cx - prev.cx, p.cy - prev.cy)
        if (d < bestD) { bestD = d; best = p }
      }
      if (best && bestD <= 120 && best !== measurement.car) {
        measurement.car = best
        measurement.others = all.filter((p) => p !== best).slice(0, 4)
      }
    }
  }
  const car = measurement && measurement.car
  if (!car) return measurement
  const now = Date.now()
  const prev = lastCarPose.get(tabId)
  if (prev && now > prev.t && now - prev.t < 4000 && (prev.b == null || car.b == null || Math.abs(car.b - prev.b) <= 26)) {
    const dt = (now - prev.t) / 1000
    car.vx = Math.round(((car.cx - prev.cx) / dt) * 10) / 10
    car.vy = Math.round(((car.cy - prev.cy) / dt) * 10) / 10
  }
  lastCarPose.set(tabId, { cx: car.cx, cy: car.cy, t: now, b: car.b, n: car.n })
  return measurement
}

const CAR_MEASURE_EXPR = `(() => {
  const c = document.querySelector('#park-canvas');
  if (!c) return null;
  const g = c.getContext('2d');
  const w = c.width, h = c.height, d = g.getImageData(0, 0, w, h).data, S = w / 400;
  const R = (v) => +v.toFixed(1);
  const seen = new Uint8Array(w * h);
  // A canvas game's player sprite is normally the brightest NEUTRAL blob (the
  // Waymo is grey-white, traffic is tinted). Every component above the noise
  // floor is measured, then the neutral-bright one with the most pixels wins.
  // Only near-opaque pixels count: smoke, dust and sparkle particles a game draws
  // after a crash are semi-transparent, and they used to be picked as the sprite
  // (the pose then appeared to teleport for a few frames).
  // Each measurement carries its centroid and major-axis angle (from second
  // moments) as well as the AABB, because the AABB alone cannot recover a
  // rotated sprite's heading.
  const isCarColour = (r, gg, b) => {
    const lo = Math.min(r, gg, b), hi = Math.max(r, gg, b);
    return lo >= 150 && hi - lo <= 40;
  };
  const parts = [];
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
    const p = y * w + x;
    if (seen[p] || d[p * 4 + 3] < 200) continue;
    const q = [[x, y]]; seen[p] = 1;
    let a = x, b = y, cc = x, dd = y, cnt = 0, sr = 0, sg = 0, sb = 0;
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    while (q.length) {
      const [cx, cy] = q.pop(); cnt++;
      const i = (cy * w + cx) * 4; sr += d[i]; sg += d[i + 1]; sb += d[i + 2];
      sx += cx; sy += cy; sxx += cx * cx; syy += cy * cy; sxy += cx * cy;
      if (cx < a) a = cx; if (cx > cc) cc = cx; if (cy < b) b = cy; if (cy > dd) dd = cy;
      for (let dy = -2; dy <= 2; dy += 2) for (let dx = -2; dx <= 2; dx += 2) {
        if (!dx && !dy) continue;
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const np = ny * w + nx;
        if (seen[np] || d[np * 4 + 3] < 200) continue;
        seen[np] = 1; q.push([nx, ny]);
      }
    }
    if (cnt < 300) continue;
    const mx = sx / cnt, my = sy / cnt;
    const uxx = sxx / cnt - mx * mx, uyy = syy / cnt - my * my, uxy = sxy / cnt - mx * my;
    const angle = (0.5 * Math.atan2(2 * uxy, uxx - uyy)) * 180 / Math.PI;
    parts.push({ n: cnt, r: Math.round(sr / cnt), g: Math.round(sg / cnt), b: Math.round(sb / cnt),
      x: R(a / S), y: R(b / S), w: R((cc - a + 1) / S), h: R((dd - b + 1) / S),
      cx: R(mx / S), cy: R(my / S), angle: R(angle) });
  }
  parts.sort((p, q) => q.n - p.n);
  const neutral = parts.filter((p) => isCarColour(p.r, p.g, p.b));
  const car = neutral[0] || parts[0] || null;
  return { car, others: parts.filter((p) => p !== car).slice(0, 4), bg: getComputedStyle(c).backgroundImage };
})()`

/**
 * True when the tab cannot run: its window is minimized or another tab is in
 * front. Pages with a requestAnimationFrame game loop stop advancing entirely,
 * and input sits in a queue — which from the outside looks like the page
 * ignoring the agent. The plugin never forces visibility (that would change what
 * the page believes about itself), so it reports the condition instead.
 */
async function pageHidden(tabId) {
  try {
    return (await evaluate(tabId, 'document.visibilityState === "hidden"')) === true
  } catch {
    return false
  }
}

const HIDDEN_HINT =
  "the tab is not visible (its window is minimized or another tab is in front), so the page's "
  + 'animation frames are paused; this input is queued and nothing will advance until it is shown'

async function keyPage({ key, keys, text, keyDelayMs, steps, count, holdMs, target, modifiers, forceActive: forceWanted, measure, settle, tabId: hint }) {
  const tabId = await requirePage(hint)
  // forceActive:true is the escape hatch for a page whose frame clock has
  // stopped (a sleeping display leaves the tab "hidden" and rAF paused, so
  // input queues and nothing advances). It is never installed on attach and it
  // never happens silently: the reply carries what was forced and the caveat.
  let forced
  if (forceWanted) {
    const visibility = await evaluate(tabId, 'document.visibilityState').catch(() => null)
    if (visibility === 'hidden') forced = await forceActive(tabId)
  }
  // Text mode: one real key event per character. Canvas games read keydown and
  // cannot be typed into by assigning value, so expanding a string into steps
  // by hand costs one JSON object per character.
  if (typeof text === 'string' && text.length > 0
      && !key && !(Array.isArray(keys) && keys.length) && !(Array.isArray(steps) && steps.length)) {
    if (target) {
      const selector = resolveTarget(target)
      const focused = await evaluate(tabId, `(() => { const el = ${deepFindExpr(selector)}; if (!el) return false; el.focus(); return true })()`)
      if (!focused) throw fail('TARGET_NOT_FOUND', `no element matches ${selector}`)
    }
    const chars = Array.from(text).slice(0, 1000)
    const gap = Math.min(Math.max(Number(keyDelayMs) || 40, 8), 500)
    for (const ch of chars) {
      const spec = keySpec(ch)
      const name = spec?.key ?? ch
      const base = {
        key: name,
        ...(spec?.code ? { code: spec.code } : {}),
        ...(Number.isFinite(spec?.vk) ? { windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk } : {}),
      }
      await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: ch, unmodifiedText: ch })
      await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base })
      await delay(gap)
    }
    const meta = await pageMeta(tabId)
    return { url: meta?.url ?? '', title: meta?.title ?? '', key: 'text', times: chars.length, sentKeys: chars.length, modifiers: [] }
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
  const eventFor = (item, type) => ({
    type,
    key: item.key,
    code: item.code,
    windowsVirtualKeyCode: item.vk,
    nativeVirtualKeyCode: item.vk,
    modifiers: mask,
    ...(withText && item.text && mask === 0 ? { text: item.text } : {}),
  })
  // Releasing a key is the one event a game can never recover from losing: a
  // stuck keyDown drives the avatar until it crashes. Every path that raises a
  // key therefore releases it in a finally block, retrying the release because a
  // renderer that just hung ("not responding") still receives it on recovery.
  const releaseKey = async (item, tries = 4) => {
    for (let i = 0; i < tries; i += 1) {
      try {
        await send(tabId, 'Input.dispatchKeyEvent', eventFor(item, 'keyUp'))
        return true
      } catch {
        await delay(150)
      }
    }
    return false
  }
  const press = async (list, holdFor) => {
    try {
      for (const item of list) await send(tabId, 'Input.dispatchKeyEvent', eventFor(item, 'keyDown'))
      if (holdFor > 0) await delay(holdFor)
    } finally {
      for (const item of list) await releaseKey(item)
      // A throttled page can drop the keyUp even when the send resolves; the
      // repeat is idempotent for normal pages and repairs the lost event.
      await delay(24)
      for (const item of list) await releaseKey(item)
    }
  }
  // until: hold the keys until a READ-ONLY page expression turns truthy. This is
  // the closed-loop counterpart of holdMs: a steering burst that ends on "the
  // car passed x=200" is exact where a 1200 ms hold is a guess. The expression
  // runs in the same guarded world as every other read, so it can inspect but
  // never modify the page.
  const pressUntil = async (list, expression, deadline, contextId) => {
    try {
      for (const item of list) await send(tabId, 'Input.dispatchKeyEvent', eventFor(item, 'keyDown'))
      while (Date.now() < deadline) {
        await delay(55)
        try {
          if (await evaluateProgram(tabId, expression, { contextId })) return true
        } catch {}
      }
      return false
    } finally {
      for (const item of list) await releaseKey(item)
      await delay(24)
      for (const item of list) await releaseKey(item)
    }
  }
  const pressUntilMeasure = async (list, expression, deadline, contextId) => {
    // The condition is evaluated in the page against the measurement, not in the
    // service worker: an MV3 extension may not use eval/new Function (CSP), while
    // a CDP Runtime.evaluate is allowed to run the caller's expression.
    try {
      for (const item of list) await send(tabId, 'Input.dispatchKeyEvent', eventFor(item, 'keyDown'))
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
      for (const item of list) await releaseKey(item)
      await delay(24)
      for (const item of list) await releaseKey(item)
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
      const stepHold = Math.min(Math.max(Number(step.holdMs) || 0, 0), 10000)
      const stepUntil = typeof step.until === "string" && step.until.trim() ? step.until.trim() : ""
      const stepUntilMeasure = typeof step.untilMeasure === "string" && step.untilMeasure.trim() ? step.untilMeasure.trim() : ""
      if (stepUntilMeasure) {
        const cap = Math.min(Math.max(Number(step.timeoutMs) || 6000, 100), 60000)
        const startedAt = Date.now()
        const contextId = await guardedContext(tabId)
        const ok = await pressUntilMeasure(list, stepUntilMeasure, startedAt + cap, contextId)
        untilResults.push({ index: untilResults.length, ok, ms: Date.now() - startedAt, on: "measure" })
      } else if (stepUntil) {
        const cap = Math.min(Math.max(Number(step.timeoutMs) || 6000, 100), 60000)
        const startedAt = Date.now()
        const contextId = await guardedContext(tabId)
        const ok = await pressUntil(list, stepUntil, startedAt + cap, contextId)
        untilResults.push({ index: untilResults.length, ok, ms: Date.now() - startedAt })
      } else {
        await press(list, stepHold)
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
    await press(specs, hold)
  } else {
    // Large repeats run at a lower interval: a 644-step slider sweep cost four calls
    for (let i = 0; i < times; i += 1) {
      await press(specs, 0)
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
  const hidden = await pageHidden(tabId)
  if (forced) await clearForced(tabId, forced)
  return {
    url: meta?.url ?? '', title: meta?.title ?? '', key: label, times, modifiers: mask, steps: stepList.length,
    measure: measurement, until: untilResults.length ? untilResults : undefined, dialog: recentDialog(tabId),
    hidden, hint: hidden && !forced ? HIDDEN_HINT : undefined,
    forced: forced ? { ...forced, cleared: true } : undefined,
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
async function drivePage({ x, y, tol, timeoutMs, maxSpeed, untilMeasure, click, keys, route, tabId: hint }) {
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
async function measurePage({ settle, tabId: hint } = {}) {
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

/**
 * Block until a page condition holds instead of sleeping a fixed time.
 *
 * Any subset of selector / text / url may be given; `gone: true` inverts the
 * selector test. Returns `matched: false` on timeout rather than throwing, so
 * the caller can decide whether absence is an error.
 */
/** Turn a network wait pattern into a URL test: /regex/ or a plain substring. */
const networkTest = (pattern) => {
  if (/^\/.*\/$/.test(pattern)) {
    const body = pattern.slice(1, -1)
    try {
      const re = new RegExp(body)
      return (url) => re.test(url)
    } catch {
      throw fail('BAD_ARGUMENT', 'network pattern is not a valid regular expression: ' + body)
    }
  }
  return (url) => url.includes(pattern)
}

async function waitForCore({ selector, text, url, network, expression, gone, enabled, stable, stableMs, timeoutMs, pollMs, tabId: hint }) {
  const tabId = await requirePage(hint)
  const limit = Math.min(Math.max(Number(timeoutMs) || 10000, 200), 25000)
  const poll = Math.min(Math.max(Number(pollMs) || 150, 10), 1000)
  const started = Date.now()
  if (typeof network === 'string' && network.length > 0) {
    const capture = netCaptures.get(tabId)
    if (!capture) throw fail('NOT_CAPTURING', 'network capture is not running; call bsb_network with action "start" first')
    const matches = networkTest(network)
    for (;;) {
      const hit = capture.order
        .map((requestId) => capture.entries.get(requestId))
        .find((entry) => entry && typeof entry.url === 'string' && entry.status >= 100 && matches(entry.url))
      // A response is only useful once its body (or its failure) is known: a match at
      // responseReceived time would race Network.getResponseBody and return no body.
      if (hit && (hit.body != null || hit.error != null || Date.now() - started > 1500)) {
        return {
          matched: true,
          elapsedMs: Date.now() - started,
          network: {
            method: hit.method,
            url: hit.url,
            status: hit.status,
            mime: hit.mime,
            requestBody: hit.requestBody,
            requestHeaders: hit.requestHeaders,
            responseHeaders: hit.responseHeaders,
            body: hit.body,
          },
          dialog: recentDialog(tabId),
        }
      }
      if (Date.now() - started >= limit) return { matched: false, elapsedMs: Date.now() - started, dialog: recentDialog(tabId) }
      await delay(poll)
    }
  }
  const probe = `(() => {
    const selector = ${JSON.stringify(typeof selector === 'string' ? selector : '')};
    const text = ${JSON.stringify(typeof text === 'string' ? text : '')};
    const url = ${JSON.stringify(typeof url === 'string' ? url : '')};
    const gone = ${gone === true ? 'true' : 'false'};
    const wantEnabled = ${enabled === true ? 'true' : 'false'};
    let exprOk = true;
    let exprValue = '';
    ${typeof expression === 'string' && expression.trim() ? `try { const v = (${expression}); exprOk = !!v; exprValue = (typeof v === 'object' ? JSON.stringify(v) : String(v)).slice(0, 300); } catch (e) { exprOk = false; exprValue = String((e && e.message) || e).slice(0, 300); }` : ''}
    const walk = (sel, root) => {
      const direct = root.querySelector(sel);
      if (direct) return direct;
      for (const node of root.querySelectorAll('*')) {
        if (!node.shadowRoot) continue;
        const inner = walk(sel, node.shadowRoot);
        if (inner) return inner;
      }
      return null;
    };
    const el = selector ? walk(selector, document) : null;
    const hit = selector ? !!el : true;
    const selectorOk = gone ? !hit : hit;
    const textOk = text ? (((document.body && document.body.innerText) || '').includes(text)) : true;
    const urlOk = url ? location.href.includes(url) : true;
    const disabled = !!(el && (el.disabled === true || el.getAttribute('aria-disabled') === 'true'));
    const enabledOk = wantEnabled ? (hit && !disabled) : true;
    const box = el ? (() => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })() : null;
    return {
      ok: selectorOk && textOk && urlOk && enabledOk && exprOk,
      url: location.href,
      title: document.title,
      sample: (((document.body && document.body.innerText) || '').slice(0, 400)),
      box,
      disabled,
      exprValue,
    };
  })()`
  const settleMs = Math.max(0, Math.min(10000, Number(stableMs) || 400))
  let probeContext = await guardedContext(tabId).catch(() => null)
  let lastBox = null
  let boxSince = 0
  for (;;) {
    let state = null
    try {
      if (probeContext === null) probeContext = await guardedContext(tabId)
      state = await evaluateInContext(tabId, probeContext, probe)
    } catch {
      // Navigation in flight: the isolated world is destroyed; rebuild it.
      probeContext = null
    }
    if (state?.ok) {
      if (stable === true) {
        const box = state.box
        const same = box && lastBox &&
          Math.abs(box.x - lastBox.x) < 0.5 && Math.abs(box.y - lastBox.y) < 0.5 &&
          Math.abs(box.width - lastBox.width) < 0.5 && Math.abs(box.height - lastBox.height) < 0.5
        if (!same) {
          lastBox = box
          boxSince = Date.now()
        } else if (Date.now() - boxSince >= settleMs) {
          return {
            matched: true,
            elapsedMs: Date.now() - started,
            url: state.url,
            title: state.title,
            text: state.sample,
            box,
            settled: true,
            expressionValue: state.exprValue,
            dialog: recentDialog(tabId),
          }
        }
      } else {
        return { matched: true, elapsedMs: Date.now() - started, url: state.url, title: state.title, text: state.sample, ...(state.box ? { box: state.box } : {}), expressionValue: state.exprValue, dialog: recentDialog(tabId) }
      }
    }
    if (Date.now() - started >= limit) {
      return {
        matched: false,
        elapsedMs: Date.now() - started,
        url: state?.url ?? '',
        title: state?.title ?? '',
        text: state?.sample ?? '',
        dialog: recentDialog(tabId),
      }
    }
    await delay(poll)
  }
}

/** Resolve the optional click a wait fires the moment its condition matches. */
function followUpClick(params) {
  const hasPoint = Number.isFinite(Number(params.clickX)) && Number.isFinite(Number(params.clickY))
  const hasTarget = typeof params.clickSelector === 'string' && params.clickSelector.length > 0
  const hasText = typeof params.clickText === 'string' && params.clickText.length > 0
  if (!hasPoint && !hasTarget && !hasText) return null
  return {
    ...(hasTarget ? { target: params.clickSelector } : {}),
    ...(hasText ? { text: params.clickText } : {}),
    ...(hasPoint ? { x: Number(params.clickX), y: Number(params.clickY) } : {}),
    ...(params.clickFrame ? { frame: params.clickFrame } : {}),
  }
}

/**
 * Wait for a page condition and, optionally, click the instant it becomes true.
 * The click happens inside this one call, so timed UIs (a dot that turns green,
 * a button that exists for 600 ms) can be driven without a round trip.
 */
async function waitForPage(params) {
  // A "first" click arms the widget that will later satisfy the condition (a
  // Start button that begins a 5-15 s countdown). Pressing it here keeps the
  // whole start-wait-press sequence inside one call, with no think time between.
  const first = followUpClick({
    clickSelector: params.firstSelector,
    clickText: params.firstText,
    clickX: params.firstX,
    clickY: params.firstY,
    clickFrame: params.firstFrame,
  })
  let pressedBefore
  if (first) {
    try {
      pressedBefore = await clickPage({ ...first, tabId: params.tabId })
    } catch (error) {
      return { matched: false, elapsedMs: 0, firstClickError: String((error && error.message) || error) }
    }
  }
  const result = await waitForCore(params)
  if (pressedBefore) result.pressedFirst = pressedBefore
  const follow = followUpClick(params)
  if (result && result.matched && follow) {
    try {
      result.clicked = await clickPage({ ...follow, tabId: params.tabId })
      result.clickedAfterMs = result.elapsedMs
    } catch (error) {
      result.clickError = String((error && error.message) || error)
    }
  }
  return result
}

/** Scroll the page to x/y, or bring a selector into view. */
async function scrollPage({ selector, x, y, frame, tabId: hint }) {
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

/**
 * Measure the capture target once so a burst can reuse it.
 */
async function prepareShot({ fullPage, selector, scale, frame, tabId: hint, rect }) {
  const tabId = await requirePage(hint)
  let target = null
  let frameId = null
  // A raw rect (viewport CSS px) crops anywhere on the page, not just to an
  // element: the caller may want one glyph of a canvas, a region of a chart, or
  // a slice of a long table that has no element of its own.
  const view = await evaluate(tabId, '({ width: window.innerWidth, height: window.innerHeight })')
  const hasSelector = typeof selector === 'string' && selector.length > 0
  const hasRect = rect !== null && typeof rect === 'object'
  const requestedZoom = Number(scale)
  // A bare rect maps CSS px to image px at the device scale by default; a
  // selector crop keeps the historical 2x zoom. An explicit `scale` wins.
  const zoom = requestedZoom ? Math.min(Math.max(requestedZoom, 1), 6) : (hasSelector ? 2 : 1)
  if (hasSelector) {
    const measure = `(() => {
      const el = ${deepFindExpr(selector)};
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()`
    const ctx = frame ? await frameContext(tabId, frame) : null
    const read = ctx ? () => evaluateInContext(tabId, ctx.contextId, measure) : () => evaluate(tabId, measure)
    const onScreen = (box, originX, originY) =>
      box && box.width > 0 && box.height > 0 &&
      box.x + originX + box.width > 0 && box.y + originY + box.height > 0 &&
      box.x + originX < view.width && box.y + originY < view.height
    let box = await read()
    if (!box || box.width <= 0 || box.height <= 0) throw fail('TARGET_NOT_FOUND', 'no visible element matches ' + selector)
    let origin = ctx ? await frameOrigin(tabId, ctx.frame.frameId) : { x: 0, y: 0 }
    if (!onScreen(box, origin.x, origin.y)) {
      // Cropping needs the element inside the viewport, so bring it there and
      // re-measure instead of failing on a stale scroll position.
      if (ctx) {
        await evaluate(tabId, `(() => { window.scrollBy(0, ${Math.round(origin.y + box.y + box.height / 2 - view.height / 2)}); })()`)
        await delay(150)
        origin = await frameOrigin(tabId, ctx.frame.frameId)
      } else {
        await evaluate(tabId, `(() => { const el = ${deepFindExpr(selector)}; if (el) el.scrollIntoView({ block: 'center', inline: 'center' }); })()`)
        await delay(150)
        box = await read()
      }
      if (!onScreen(box, origin.x, origin.y)) throw fail('TARGET_NOT_FOUND', selector + ' could not be scrolled into view')
    }
    let x = box.x + origin.x
    let y = box.y + origin.y
    let width = box.width
    let height = box.height
    if (hasRect) {
      // rect with a selector addresses a slice OF that element: all four values
      // at or below 1 are fractions of its box ("the bottom-right quarter"),
      // anything larger is CSS pixels measured from its top-left. Measuring a
      // region by hand cost two round trips before this existed.
      const values = [rect.x, rect.y, rect.width, rect.height].map((v) => Number(v) || 0)
      const fractional = values.every((v) => v <= 1)
      const rx = fractional ? values[0] * width : values[0]
      const ry = fractional ? values[1] * height : values[1]
      const rw = fractional ? values[2] * width : values[2]
      const rh = fractional ? values[3] * height : values[3]
      if (!(rw >= 2) || !(rh >= 2)) throw fail('BAD_ARGUMENT', 'rect inside an element needs at least 2x2 CSS pixels')
      x += rx
      y += ry
      width = rw
      height = rh
    }
    target = { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height), viewWidth: view.width, viewHeight: view.height }
    frameId = ctx?.frame.frameId ?? null
  } else if (hasRect) {
    // A bare rect (viewport CSS px) crops anywhere on the page, not just to an
    // element: one glyph of a canvas, a region of a chart, a slice of a table.
    const width = Math.round(Number(rect.width) || 0)
    const height = Math.round(Number(rect.height) || 0)
    if (!(width >= 2) || !(height >= 2)) {
      throw fail('BAD_ARGUMENT', 'rect needs a width and height of at least 2 CSS pixels')
    }
    target = {
      x: Math.round(Number(rect.x) || 0),
      y: Math.round(Number(rect.y) || 0),
      width,
      height,
      viewWidth: view.width,
      viewHeight: view.height,
    }
  }
  return { tabId, zoom, target, frameId, fullPage: fullPage === true }
}

/** One PNG of a prepared shot: cropped to the target, or the viewport/page. */
/**
 * Bring a tab forward before capturing it.
 *
 * A backgrounded tab produces no compositor frames, so Page.captureScreenshot
 * waits for a frame that never arrives — the call burns its full timeout and the
 * browser looks dead afterwards. Activating the tab is the fix, and it changes no
 * page state, only which tab the user sees. Recording already did this; capture
 * did not, which is why capturing a live game tab stranded browsers.
 */
async function captureShot(prep, { hidden = false } = {}) {
  const { tabId, zoom, target } = prep
  let params = { format: 'png' }
  // A selector target is cropped out of the screenshot, and a viewport shot
  // silently cut the bottom off an element taller than the viewport (a canvas,
  // a long card). When the target does not fit, capture the whole document and
  // crop from that instead; the element then arrives at its full height.
  let documentCrop = null
  if (target === null && prep.fullPage) {
    const metrics = await send(tabId, 'Page.getLayoutMetrics')
    const size = metrics?.cssContentSize ?? metrics?.contentSize
    if (size && size.width > 0 && size.height > 0) {
      params = {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 },
      }
    }
  } else if (target !== null) {
    const fits = target.x >= -1 && target.y >= -1 &&
      target.x + target.width <= target.viewWidth + 1 &&
      target.y + target.height <= target.viewHeight + 1
    if (!fits) {
      const scroll = await evaluate(tabId, '({ x: window.scrollX, y: window.scrollY })').catch(() => ({ x: 0, y: 0 }))
      const metrics = await send(tabId, 'Page.getLayoutMetrics').catch(() => null)
      const size = metrics?.cssContentSize ?? metrics?.contentSize
      if (size && size.width > 0 && size.height > 0) {
        params = {
          format: 'png',
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 },
        }
        documentCrop = { scroll, width: size.width, height: size.height }
      }
    }
  }
  // A hidden tab produces no compositor frame; captureBeyondViewport renders it
  // synchronously instead. This replaces the old tab activation entirely.
  if (hidden && !documentCrop && !(target === null && prep.fullPage)) {
    const metrics = await send(tabId, 'Page.getLayoutMetrics').catch(() => null)
    const view = metrics?.cssVisualViewport ?? metrics?.cssLayoutViewport
    const width = view?.clientWidth || view?.width || 0
    const height = view?.clientHeight || view?.height || 0
    if (width > 0 && height > 0) {
      params = {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: view.clientX ?? 0, y: view.clientY ?? 0, width, height, scale: 1 },
      }
    }
  }
  let shot
  try {
    shot = await Promise.race([
      send(tabId, 'Page.captureScreenshot', params),
      delay(12000).then(() => { throw fail('TIMEOUT', 'the screenshot timed out') }),
    ])
  } catch (error) {
    // A minimized window produces no compositor frame. captureBeyondViewport
    // forces Chrome to render synchronously instead of waiting for one.
    const metrics = await send(tabId, 'Page.getLayoutMetrics').catch(() => null)
    const view = metrics?.cssVisualViewport ?? metrics?.cssLayoutViewport ?? { clientWidth: 1280, clientHeight: 800, clientX: 0, clientY: 0 }
    const width = view.clientWidth || view.width || 1280
    const height = view.clientHeight || view.height || 800
    const clip = params.clip ?? { x: view.clientX ?? 0, y: view.clientY ?? 0, width, height, scale: 1 }
    shot = await Promise.race([
      send(tabId, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip }),
      delay(15000).then(() => { throw error }),
    ])
  }
  if (typeof shot?.data !== 'string') throw fail('CDP_ERROR', 'the browser returned no image data')
  if (target === null) return shot.data
  // Crop the element out; see cropPng for why. A document crop starts at the
  // document origin, so the viewport-relative target must be moved by the scroll
  // offset — and its ratio comes from the full document width, not the viewport.
  const full = pngSize(shot.data)
  // One surface, one ratio. The old code clamped x/y and width/height
  // independently to the image, so a rect crossing an edge silently became a
  // completely different (narrow) crop instead of an error or a full-size one.
  const surface = documentCrop
    ? { x: documentCrop.scroll.x, y: documentCrop.scroll.y, width: documentCrop.width, height: documentCrop.height, label: 'page' }
    : params.clip
      ? { x: 0, y: 0, width: params.clip.width, height: params.clip.height, label: 'viewport' }
      : { x: 0, y: 0, width: target.viewWidth, height: target.viewHeight, label: 'viewport' }
  const left = target.x + surface.x
  const top = target.y + surface.y
  if (left < -0.5 || top < -0.5 ||
      left + target.width > surface.width + 0.5 ||
      top + target.height > surface.height + 0.5) {
    throw fail(
      'BAD_ARGUMENT',
      `rect ${target.x},${target.y} ${target.width}x${target.height} extends beyond the ${surface.label} ` +
      `(${surface.width}x${surface.height} CSS px); choose a rect inside it or capture the whole page`,
    )
  }
  const ratio = full.width > 0 && surface.width > 0 ? full.width / surface.width : 1
  const sx = Math.round(left * ratio)
  const sy = Math.round(top * ratio)
  const sw = Math.round(target.width * ratio)
  const sh = Math.round(target.height * ratio)
  if (sx < 0 || sy < 0 || sw < 1 || sh < 1 || sx + sw > full.width + 1 || sy + sh > full.height + 1) {
    throw fail(
      'BAD_ARGUMENT',
      `rect maps outside the captured image (${full.width}x${full.height}); ` +
      `capture area ${surface.width}x${surface.height} CSS px`,
    )
  }
  // Rounding at the far edge can overshoot by one device pixel; trim that,
  // never a meaningful part of the requested rect.
  const cropWidth = Math.min(sw, full.width - sx)
  const cropHeight = Math.min(sh, full.height - sy)
  return cropPng(shot.data, sx, sy, cropWidth, cropHeight, zoom)
}

/**
 * Tile a burst of PNGs into one labelled contact sheet.
 *
 * Watching motion is the agent's eyes, not a DOM hint: a highlight that lasts
 * 350 ms cannot be caught by one screenshot per tool call, so the strip keeps
 * the whole motion in a single image the model can read.
 */
const composeFilmstrip = async (shots, columns, mime = 'image/png', options = {}) => {
  const maxTiles = Math.min(Math.max(Math.trunc(Number(options.maxTiles)) || 64, 1), 400)
  let picked = shots
  let stripped = 0
  if (shots.length > maxTiles) {
    // Big piles must not stall the worker; callers that care about the first
    // moments of a run (armed recordings) keep the earliest frames.
    picked = options.keep === 'last' ? shots.slice(shots.length - maxTiles) : shots.slice(0, maxTiles)
    stripped = shots.length - picked.length
  }
  const bitmaps = []
  for (const shot of picked) {
    const binary = atob(shot)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    bitmaps.push(await createImageBitmap(new Blob([bytes], { type: mime })))
  }
  const count = bitmaps.length
  const tileW = Math.max(...bitmaps.map((bitmap) => bitmap.width))
  const tileH = Math.max(...bitmaps.map((bitmap) => bitmap.height))
  const asked = Number(options.tileScale)
  const scale = asked > 0 ? Math.min(Math.max(asked, 0.1), 1) : (count > 36 ? 0.5 : 1)
  const cellW = Math.max(1, Math.round(tileW * scale))
  const cellH = Math.max(1, Math.round(tileH * scale))
  const cols = Math.min(Math.max(Math.trunc(Number(columns)) || Math.ceil(Math.sqrt(count)), 1), count)
  const rows = Math.ceil(count / cols)
  const gap = 3
  const label = 18
  const width = cols * cellW + (cols + 1) * gap
  const height = rows * (cellH + label) + (rows + 1) * gap
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')
  context.fillStyle = '#111111'
  context.fillRect(0, 0, width, height)
  for (let index = 0; index < count; index += 1) {
    const row = Math.floor(index / cols)
    const col = index % cols
    const x = gap + col * (cellW + gap)
    const y = gap + row * (cellH + label + gap)
    context.fillStyle = '#000000'
    context.fillRect(x, y, cellW, label)
    context.fillStyle = '#88aaff'
    context.font = '13px monospace'
    context.textBaseline = 'middle'
    context.fillText('#' + (index + 1), x + 5, y + label / 2 + 1)
    context.drawImage(bitmaps[index], x, y + label, cellW, cellH)
  }
  for (const bitmap of bitmaps) bitmap.close?.()
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  const out = new Uint8Array(await blob.arrayBuffer())
  let text = ''
  for (let i = 0; i < out.length; i += 0x8000) text += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000))
  return { data: btoa(text), stripped, count, tileWidth: cellW, tileHeight: cellH, columns: cols, rows }
}

/** Coarse 8x8 luminance fingerprint of a frame, used to notice real changes. */
const frameSignature = async (data, mime = 'image/png') => {
  const bytes = Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0))
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }))
  const canvas = new OffscreenCanvas(8, 8)
  const context = canvas.getContext('2d')
  context.drawImage(bitmap, 0, 0, 8, 8)
  bitmap.close?.()
  const pixels = context.getImageData(0, 0, 8, 8).data
  const signature = new Uint8Array(64)
  for (let index = 0; index < 64; index += 1) {
    const offset = index * 4
    signature[index] = Math.round(pixels[offset] * 0.299 + pixels[offset + 1] * 0.587 + pixels[offset + 2] * 0.114)
  }
  return signature
}

/** Largest per-cell difference between two fingerprints, 0-255. */
const signatureDistance = (a, b) => {
  let worst = 0
  for (let index = 0; index < a.length; index += 1) {
    const delta = Math.abs(a[index] - b[index])
    if (delta > worst) worst = delta
  }
  return worst
}

/** Integer parameter with a fallback, clamped into range. */
const clampInt = (value, min, max, fallback) => {
  const number = Math.trunc(Number(value))
  if (!Number.isFinite(number)) return fallback
  return Math.min(Math.max(number, min), max)
}

let recorder = null
let screencast = null
/**
 * Tabs a recording previously emulated a viewport on.
 *
 * This build never installs a metrics override itself (recording captures the
 * tab at its real viewport); the set only exists so a clear left behind by an
 * older build, or by a recording that never reached finishRecording, is cleaned
 * up on the next request instead of sticking to the page.
 */
const metricsTabs = new Set()

/**
 * Mirror the live override list into session storage.
 *
 * An MV3 worker can be recycled between two commands. The override it installed
 * lives in the renderer, not in the worker, so without a persisted list a later
 * worker cannot know which tab is still emulated — the page would keep its
 * emulated size until a reload. The list is tiny and only ever names tabs.
 */
const rememberMetrics = () => {
  try {
    void Promise.resolve(chrome.storage.session.set({ metricsTabs: [...metricsTabs] })).catch(() => undefined)
  } catch {
    // Session storage is unavailable on very old builds; the in-memory set is
    // still correct for the life of this worker.
  }
}

const forgetMetrics = (tabId) => {
  if (metricsTabs.delete(tabId)) rememberMetrics()
}

/** Drop one metrics override, tolerating a tab that navigated or closed. */
const clearMetrics = async (tabId) => {
  forgetMetrics(tabId)
  await rawSend(tabId, 'Emulation.clearDeviceMetricsOverride', {}).catch(() => undefined)
}

/**
 * Put a tab back at its real viewport and prove it.
 *
 * A clear can miss: the override belongs to the target, and a debugger session
 * that was recycled no longer owns it. So re-attach through send (which retries
 * after attaching), read the layout viewport, and only then trust the clear.
 * This build installs no override itself, so the routine only exists to clean
 * up after tabs an older build emulated; it never emulates a box of its own.
 */
let lastRestore = null
const restoreViewport = async (tabId, realView) => {
  const want = Number(realView?.w) || 0
  const trace = { at: Date.now(), tabId, want, steps: [] }
  lastRestore = trace
  forgetMetrics(tabId)
  const step = async (label, run) => {
    try {
      const value = await run()
      trace.steps.push([label, 'ok', value ?? null])
      return value
    } catch (error) {
      trace.steps.push([label, 'error', String(error?.message ?? error)])
      return undefined
    }
  }
  await step('clear-raw', () => rawSend(tabId, 'Emulation.clearDeviceMetricsOverride', {}))
  if (!(want > 0)) return
  const close = (width) => typeof width === 'number' && Math.abs(width - want) <= 2
  const first = await step('width-1', () => evaluate(tabId, 'innerWidth'))
  if (close(first)) return
  await step('clear-send', () => send(tabId, 'Emulation.clearDeviceMetricsOverride', {}))
  const second = await step('width-2', () => evaluate(tabId, 'innerWidth'))
  if (close(second)) return
  // Never emulate the measured "real" box as a fallback: installing any
  // device-metrics override is itself a page-layout change, which this plugin
  // promises not to make. The clear attempts above are the whole repair.
  await step('width-final', () => evaluate(tabId, 'innerWidth'))
}

/** Clear overrides left behind by any recording except the one passed in. */
const sweepMetrics = async (keepTabId = null) => {
  try {
    const stored = await chrome.storage.session.get('metricsTabs')
    for (const tabId of Array.isArray(stored?.metricsTabs) ? stored.metricsTabs : []) {
      if (Number.isFinite(tabId)) metricsTabs.add(tabId)
    }
  } catch {
    // No persisted list: sweep what this worker knows about.
  }
  for (const tabId of [...metricsTabs]) {
    if (tabId !== keepTabId) await restoreViewport(tabId, null)
  }
}

/**
 * Take one frame of the recorded box as a GPU-cropped JPEG.
 *
 * The clip is applied by the browser while it encodes, so the worker keeps no
 * image data between frames: a 60 ms cadence stays possible because nothing is
 * decoded or re-encoded here. JPEG bytes are also directly comparable, which
 * makes "has this box changed at all" a string check.
 */
const captureClipFrame = async (prep, { fromSurface = true, quality = 80, beyond = false } = {}) => {
  const target = prep.target
  // A CDP clip is measured from the top of the document, while the measured box
  // is viewport-relative: without the scroll offset a scrolled page returns the
  // wrong part of the screen (or black beyond the surface).
  let scroll = { x: 0, y: 0 }
  if (target !== null && prep.frameId === null) {
    scroll = await evaluate(prep.tabId, '({ x: Math.round(window.scrollX), y: Math.round(window.scrollY) })')
      .catch(() => ({ x: 0, y: 0 }))
  }
  const clip = target === null
    ? undefined
    : {
      x: target.x + (scroll?.x ?? 0),
      y: target.y + (scroll?.y ?? 0),
      width: Math.max(1, target.width),
      height: Math.max(1, target.height),
      scale: prep.zoom,
    }
  const shot = await send(prep.tabId, 'Page.captureScreenshot', {
    format: 'jpeg',
    quality,
    fromSurface,
    captureBeyondViewport: beyond,
    ...(clip ? { clip } : {}),
  })
  const data = String(shot?.data ?? '')
  if (!data) throw fail('NO_FRAME', 'the page returned an empty screenshot')
  return data
}

/** Mean colour and bright share of a whole encoded image, for grid triage. */
const imageStats = async (data, mime = 'image/png') => {
  const bytes = Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0))
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }))
  const width = bitmap.width
  const height = bitmap.height
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')
  context.drawImage(bitmap, 0, 0)
  bitmap.close?.()
  const pixels = context.getImageData(0, 0, width, height).data
  const count = Math.max(1, width * height)
  let r = 0
  let g = 0
  let b = 0
  let bright = 0
  for (let i = 0; i < pixels.length; i += 4) {
    r += pixels[i]
    g += pixels[i + 1]
    b += pixels[i + 2]
    if (0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2] > 200) bright += 1
  }
  const R = r / count
  const G = g / count
  const B = b / count
  return {
    width,
    height,
    r: Math.round(R),
    g: Math.round(G),
    b: Math.round(B),
    lum: Math.round(0.2126 * R + 0.7152 * G + 0.0722 * B),
    bright: Math.round((bright / count) * 100) / 100,
  }
}

/** Pixel size of an encoded frame, whatever its format. */
const frameSize = async (data, mime) => {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }))
  const size = { width: bitmap.width, height: bitmap.height }
  bitmap.close()
  return size
}

/**
 * Crop one screencast frame (a full-viewport image) down to the recorded box.
 */
const cropToTarget = async (prep, data, mime = 'image/png', outScale = prep.zoom) => {
  const target = prep.target
  if (target === null) return data
  const full = mime === 'image/png' ? pngSize(data) : await frameSize(data, mime)
  const ratio = full.width > 0 && target.viewWidth > 0 ? full.width / target.viewWidth : 1
  const sx = Math.max(0, Math.min(full.width - 1, Math.round(target.x * ratio)))
  const sy = Math.max(0, Math.min(full.height - 1, Math.round(target.y * ratio)))
  const sw = Math.max(1, Math.min(full.width - sx, Math.round(target.width * ratio)))
  const sh = Math.max(1, Math.min(full.height - sy, Math.round(target.height * ratio)))
  return cropPng(data, sx, sy, sw, sh, outScale, mime)
}

/**
 * Paint-driven frames from Page.startScreencast.
 *
 * A repeating screenshot is limited by the round trip (one frame every ~600 ms
 * on a busy page), which is slower than a 350 ms highlight. The screencast feed
 * is pushed by the compositor as the page repaints, so it catches every visual
 * change without asking the page anything.
 */
function screencastFrame(tabId, params) {
  const state = screencast
  const sessionId = params?.sessionId
  rawSend(tabId, 'Page.screencastFrameAck', { sessionId }).catch(() => undefined)
  if (!state || state.tabId !== tabId || state.done || state.closing) return
  const data = String(params?.data ?? '')
  state.received += 1
  // The ack above must go out before any work happens: while a frame is
  // unacknowledged the compositor holds the next paint, so decoding inline
  // would silently drop exactly the short flashes a recording exists to catch.
  state.raw.push(data)
  if (state.raw.length > 400) {
    state.raw.shift()
    state.skipped += 1
  }
  if (!state.rawTimer) {
    state.rawTimer = setTimeout(() => {
      state.rawTimer = null
      drainRaw(state).catch((error) => { state.error = String(error?.message ?? error) })
    }, 0)
  }
}

/**
 * Keep a frame only when the recorded box actually looks different.
 *
 * Pages repaint constantly for reasons that have nothing to do with the thing
 * being watched (spinners, carets, video elsewhere), so every screencast frame
 * arrives with slightly different bytes. Cropping first and comparing a coarse
 * luminance fingerprint means a still box costs one frame no matter how long the
 * recording stays armed, which is what lets the recording span the wait between
 * tool calls.
 */
async function drainRaw(state) {
  if (state.draining) return
  state.draining = true
  try {
    while (state.raw.length > 0 && !state.done && !state.closing) {
      const data = state.raw.shift()
      await ingestFrame(state, data)
      await delay(0)
    }
  } finally {
    state.draining = false
  }
}

async function ingestFrame(state, data) {
  if (state.done || state.closing) return
  if (state.shots.length >= state.maxFrames) {
    state.done = true
    rawSend(state.tabId, 'Page.stopScreencast', {}).catch(() => undefined)
    return
  }
  // Threshold 0 means "keep every distinct push": comparing the JPEG bytes is
  // free, while decoding each frame to fingerprint it throttles the push rate to
  // about 5 fps — too slow to catch a 350 ms flash.
  if (state.threshold <= 0) {
    if (data === state.lastData) {
      state.skipped += 1
      return
    }
    state.lastData = data
    state.shots.push({ data })
    state.times.push(Date.now() - state.startedAt)
    if (state.shots.length >= state.maxFrames) {
      state.done = true
      rawSend(state.tabId, 'Page.stopScreencast', {}).catch(() => undefined)
    }
    return
  }
  let signature
  try {
    signature = await frameSignature(data, state.frameMime)
  } catch {
    signature = null
  }
  const previous = state.signatures[state.signatures.length - 1]
  if (signature && previous && signatureDistance(previous, signature) <= state.threshold) {
    state.skipped += 1
    return
  }
  if (signature) {
    state.signatures.push(signature)
    if (state.signatures.length > 4) state.signatures.shift()
  }
  state.shots.push({ data })
  state.times.push(Date.now() - state.startedAt)
  if (state.shots.length >= state.maxFrames) {
    state.done = true
    rawSend(state.tabId, 'Page.stopScreencast', {}).catch(() => undefined)
  }
}

/** Assemble the recording into one labelled contact sheet. */
async function finishRecording(state, columns) {
  clearTimeout(state.timer)
  state.closing = true
  try {
  if (state.rawTimer) { clearTimeout(state.rawTimer); state.rawTimer = null }
  while (state.raw.length > 0) await ingestFrame(state, state.raw.shift())
  if (state.queue) await state.queue
  state.done = true
  while (state.pending) await delay(15)
  if (screencast === state) {
    screencast = null
    await rawSend(state.tabId, 'Page.stopScreencast', {}).catch(() => undefined)
  }
  const frames = state.shots
  if (frames.length === 0) {
    throw fail('NO_FRAMES', 'the recording captured no frames' + (state.error ? ': ' + state.error : ''))
  }
  const shots = []
  let mime = 'image/png'
  if (state.mode === 'screencast') {
    // Decode and crop once, here, instead of on every pushed paint.
    for (const frame of frames) shots.push(await cropToTarget(state.prep, frame.data, state.frameMime, 1))
  }
  else if (state.mode === 'shots') {
    for (const frame of frames) shots.push(frame.data)
    mime = 'image/jpeg'
  } else for (const frame of frames) shots.push(await cropToTarget(state.prep, frame.data))
  const wantedColumns = Number(columns) > 0 ? columns : state.columns
  const composite = await composeFilmstrip(shots, wantedColumns, mime, { maxTiles: state.maxStrip, keep: state.keep, tileScale: state.tileScale })
  const size = pngSize(composite.data)
  const first = await frameSize(shots[0], mime)
  const times = state.times
  const spanMs = times.length > 1 ? times[times.length - 1] - times[0] : 0
  return {
    url: state.url,
    title: state.title,
    width: size.width,
    height: size.height,
    pngBase64: composite.data,
    frames: shots.length,
    shown: composite.count,
    stripped: composite.stripped,
    sheetColumns: composite.columns,
    sheetRows: composite.rows,
    sheetCellWidth: composite.tileWidth,
    sheetCellHeight: composite.tileHeight,
    mode: state.mode,
    intervalMs: state.intervalMs,
    frameWidth: first.width,
    frameHeight: first.height,
    spanMs,
    frameTimes: times,
    skipped: state.skipped,
    received: state.received,
    // The cadence an agent asked for is rarely the cadence it gets: an element
    // capture costs far more than the interval. Report the truth so the next
    // recording can pick a realistic interval instead of silently under-sampling.
    actualIntervalMs: times.length > 1 ? Math.round(spanMs / (times.length - 1)) : null,
    autoStopped: state.maxMs > 0 && state.done && Date.now() - state.startedAt >= state.maxMs,
    error: state.error ?? undefined,
  }
  } finally {
    // A metrics override left running is the ruined view: the page keeps
    // rendering at an emulated size long after the recording ended. Remove it
    // on every exit path, including NO_FRAMES and a failed compositing step.
    if (state.metricsSet || metricsTabs.has(state.tabId)) {
      state.metricsSet = false
      await restoreViewport(state.tabId, state.realView)
    }
  }
}

/**
 * Record a region across tool calls: start, act, stop.
 *
 * One screenshot call is slower than a 350 ms flash, so watching an animation
 * needs the camera to keep rolling while the agent clicks. mode 'screencast'
 * (the default) takes paint frames from the compositor; mode 'interval'
 * repeats screenshots, which also works on pages that never repaint.
 */
async function recordPage(params = {}) {
  if (params.action === 'debug') {
    let stored = null
    try { stored = (await chrome.storage.session.get('metricsTabs'))?.metricsTabs ?? null } catch {}
    let probeTab = recorder?.tabId ?? null
    if (!probeTab) {
      try { probeTab = await requirePage() } catch { probeTab = null }
    }
    return {
      metricsTabs: [...metricsTabs],
      lastRestore,
      stored,
      recorder: recorder ? {
        tabId: recorder.tabId,
        mode: recorder.mode,
        metricsSet: recorder.metricsSet,
        realView: recorder.realView ?? null,
        frames: recorder.shots?.length ?? 0,
        done: recorder.done,
      } : null,
      view: probeTab === null ? null : await evaluate(probeTab, '({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })').catch((error) => ({ error: String(error?.message ?? error) })),
    }
  }
  const action = typeof params.action === 'string' ? params.action : 'start'
  if (action === 'probe') {
    // Measure how fast this browser can hand back frames of the given box, so
    // the cadence can be chosen from numbers instead of a guess.
    const prep = await prepareShot(params)
    const count = clampInt(params.maxFrames, 1, 20, 5)
    const fromSurface = params.surface !== false
    const beyond = params.beyond === true
    const started = Date.now()
    const timings = []
    let bytes = 0
    let width = 0
    let height = 0
    for (let index = 0; index < count; index += 1) {
      const at = Date.now()
      const data = await captureClipFrame(prep, { fromSurface, beyond })
      timings.push(Date.now() - at)
      bytes += data.length
      if (index === 0) {
        const size = await frameSize(data, 'image/jpeg')
        width = size.width
        height = size.height
      }
    }
    const elapsedMs = Date.now() - started
    const sorted = [...timings].sort((a, b) => a - b)
    const window = await windowInfo(prep.tabId)
    return {
      recording: false,
      frames: count,
      mode: 'probe',
      surface: fromSurface,
      beyond,
      frameMs: Math.round(elapsedMs / count),
      fps: Math.round((count / Math.max(1, elapsedMs)) * 1000),
      fastestMs: sorted[0] ?? 0,
      medianMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
      slowestMs: sorted[sorted.length - 1] ?? 0,
      bytes: Math.round(bytes / count),
      frameWidth: width,
      frameHeight: height,
      elapsedMs,
      window,
    }
  }
  if (action === 'status') {
    if (!recorder) return { recording: false, frames: 0 }
    return {
      recording: true,
      frames: recorder.shots.length,
      skipped: recorder.skipped,
      received: recorder.received,
      mode: recorder.mode,
      maxFrames: recorder.maxFrames,
      maxStrip: recorder.maxStrip,
      elapsedMs: Date.now() - recorder.startedAt,
      remainingMs: recorder.maxMs > 0 ? Math.max(0, recorder.maxMs - (Date.now() - recorder.startedAt)) : null,
      next: 'call bsb_capture with action:"stop" when the moment has passed',
      window: await windowInfo(recorder.tabId),
      warning: recorder.warning,
      error: recorder.error,
      done: recorder.done,
    }
  }
  if (action === 'stop') {
    const state = recorder
    if (!state) throw fail('NOT_RECORDING', 'no recording is running')
    recorder = null
    return finishRecording(state, params.columns)
  }
  // A previous recording may have died between "override set" and "override
  // cleared" (worker recycled, reply lost). Clear its override before a new one
  // is installed, so no tab keeps an emulated viewport.
  await sweepMetrics(recorder?.tabId ?? null)
  if (recorder) {
    // A recording that outlived its agent (a stale worker instance, a lost
    // reply) must not lock the tool out forever: force starts a new one.
    if (params.force !== true) throw fail('ALREADY_RECORDING', 'a recording is already running; stop it first')
    const stale = recorder
    recorder = null
    if (screencast === stale) screencast = null
    rawSend(stale.tabId, 'Page.stopScreencast', {}).catch(() => undefined)
    clearTimeout(stale.timer)
    stale.done = true
    stale.closing = true
    if (stale.metricsSet || metricsTabs.has(stale.tabId)) {
      stale.metricsSet = false
      await restoreViewport(stale.tabId, stale.realView)
    }
  }
  let prep = await prepareShot(params)
  // Recording never raises a tab. Paint frames only exist for a pane the window
  // is actually showing, so a hidden tab will produce none; the caller brings it
  // forward with bsb_tabs use when recording, rather than the tool doing it.
  const meta = await pageMeta(prep.tabId)
  // This plugin never changes the page viewport or the device pixel ratio: an
  // emulated viewport visibly reflows the page, and a lost reply could leave it
  // behind. Recording therefore runs at the exact size the user sees; any
  // override an older build left on a tab is swept at the start of recordPage.
  const metricsSet = false
  const realView = null
  const requested = typeof params.mode === 'string' ? params.mode : ''
  const mode = requested === 'screencast' || requested === 'interval' ? requested : 'shots'
  const state = {
    prep,
    mode,
    tabId: prep.tabId,
    intervalMs: clampInt(params.intervalMs, mode === 'shots' ? 20 : 60, 2000, mode === 'shots' ? 60 : 150),
    fromSurface: params.surface !== false,
    metricsSet,
    realView,
    beyond: params.beyond === true,
    lastData: '',
    frameMime: mode === 'screencast' ? 'image/jpeg' : 'image/png',
    quality: clampInt(params.quality, 10, 100, 72),
    maxWidth: clampInt(params.maxWidth, 160, 1920, 720),
    maxHeight: clampInt(params.maxHeight, 160, 1920, 900),
    backlog: 0,
    raw: [],
    rawTimer: null,
    draining: false,
    maxFrames: clampInt(params.maxFrames, 2, 400, 40),
    // The sheet layout belongs to the recording, not to the stop call: an agent
    // that passes columns at start should not have to repeat it at stop.
    columns: clampInt(params.columns, 1, 400, 0),
    // A recording nobody stops keeps the worker and the tab busy forever.
    // maxMs bounds it so a forgotten recording ends on its own.
    maxMs: clampInt(params.maxMs, 500, 600000, 0),
    // A contact sheet of every frame gets huge fast; a bounded, scaled sheet
    // keeps stop fast enough to answer before the tool times out.
    maxStrip: clampInt(params.maxStrip, 4, 400, 48),
    keep: params.keep === 'last' ? 'last' : 'first',
    tileScale: Number(params.tileScale) > 0 ? Math.min(Math.max(Number(params.tileScale), 0.1), 1) : 0,
    startedAt: Date.now(),
    shots: [],
    times: [],
    signatures: [],
    skipped: 0,
    received: 0,
    threshold: clampInt(params.threshold, 0, 80, 3),
    queue: Promise.resolve(),
    closing: false,
    error: null,
    timer: null,
    pending: null,
    done: false,
    url: meta?.url ?? '',
    title: meta?.title ?? '',
  }
  // Surface frames only arrive while the window is composited. Warn up front
  // instead of silently returning a one-frame strip.
  state.window = await windowInfo(state.tabId)
  state.warning = state.window && state.window.focused === false
    ? 'the browser window is not focused, so capture frames may stall. Pass focus:true to raise it.'
    : undefined
  recorder = state
  if (mode === 'screencast') {
    screencast = state
    try {
      await send(state.tabId, 'Page.startScreencast', { format: 'jpeg', quality: state.quality, maxWidth: state.maxWidth, maxHeight: state.maxHeight, everyNthFrame: 1 })
    } catch (error) {
      screencast = null
      recorder = null
      if (state.metricsSet) {
        state.metricsSet = false
        await restoreViewport(state.tabId, state.realView)
      }
      throw error
    }
    return armedRecording(state, params)
  }
  const tick = async () => {
    if (state.done || state.closing) return
    if (state.maxMs > 0 && Date.now() - state.startedAt >= state.maxMs) {
      state.done = true
      return
    }
    const capture = mode === 'shots' ? captureClipFrame(state.prep, { fromSurface: state.fromSurface, beyond: state.beyond }) : captureShot(state.prep)
    state.pending = capture
    const startedCaptureAt = Date.now()
    try {
      const data = await capture
      state.received += 1
      // Identical JPEG bytes mean the box did not change: a still page costs
      // one frame however long the recording stays armed.
      if (mode === 'shots' && data === state.lastData) {
        state.skipped += 1
      } else {
        state.lastData = data
        state.shots.push({ data })
        state.times.push(Date.now() - state.startedAt)
      }
    } catch (error) {
      state.error = String(error?.message ?? error)
    } finally {
      state.pending = null
    }
    if (state.done || state.closing) return
    if (state.shots.length >= state.maxFrames) {
      state.done = true
      return
    }
    const spent = Date.now() - startedCaptureAt
    state.timer = setTimeout(tick, Math.max(0, state.intervalMs - spent))
  }
  state.timer = setTimeout(tick, 0)
  return armedRecording(state, params)
}

/**
 * Report a started recording, optionally pressing something at once.
 *
 * The point of taking the first click here is latency: an agent's next tool call
 * can arrive a minute later, and by then a three second animation is long over.
 * Pressing the button inside the same round trip makes the capture start on the
 * animation instead of on an idle page.
 */
async function armedRecording(state, params) {
  const mode = state.mode
  const out = {
    recording: true,
    armed: true,
    frames: 0,
    mode,
    maxFrames: state.maxFrames,
    window: await windowInfo(state.tabId),
    // "0 frames" alone reads like a failure. State what the agent should do next.
    next: 'act now (click, type, drag), then call bsb_capture with action:"stop" to build the sheet',
  }
  if (state.warning) out.warning = state.warning
  if (mode !== 'screencast') out.intervalMs = state.intervalMs
  if (state.maxMs > 0) out.maxMs = state.maxMs
  if (state.columns > 0) out.columns = state.columns
  const click = typeof params.click === 'string' ? params.click.trim() : ''
  if (click) {
    await delay(clampInt(params.delayMs, 0, 5000, 150))
    let hit
    let problem
    // A plain string may be a selector or a visible label; try the selector first
    // and fall back to the label, so callers do not need to know which it is.
    try {
      hit = await clickPage({ target: click, tabId: state.tabId })
    } catch (error) {
      problem = error
      try {
        hit = await clickPage({ text: click, tabId: state.tabId })
        problem = null
      } catch (fallbackError) { problem = fallbackError }
    }
    if (hit) {
      out.clicked = hit?.clickedAt ?? null
      if (hit?.matchedText) out.clickedText = hit.matchedText
    } else {
      out.clickError = String(problem?.message ?? problem)
    }
  }
  return out
}

/**
 * Apply visual preprocessing to a captured PNG before it leaves the browser.
 *
 * A screenshot the model cannot read is worth nothing: text that is tiny,
 * mirrored, inverted, low-contrast or rotated is a common failure. Doing the
 * transform here keeps the pipeline one call instead of capture → shell out →
 * convert → read.
 *
 * ops: { flipH, flipV, rotate: 0|90|180|270, scale: 1-8, gray, invert,
 *        contrast: number (1 = none), threshold: 0-255 }
 */
async function preprocessPng(base64, ops) {
  if (!ops || typeof ops !== 'object') return base64
  const rotate = Number(ops.rotate) || 0
  const scale = Math.min(Math.max(Number(ops.scale) || 1, 1), 8)
  const wantsPixels = ops.gray === true || ops.invert === true || Number(ops.contrast) > 0 || Number.isFinite(Number(ops.threshold))
  if (!wantsPixels && rotate === 0 && scale === 1 && ops.flipH !== true && ops.flipV !== true) return base64
  const blob = await (await fetch('data:image/png;base64,' + base64)).blob()
  const bitmap = await createImageBitmap(blob)
  const swap = rotate === 90 || rotate === 270
  const drawW = Math.round(bitmap.width * scale)
  const drawH = Math.round(bitmap.height * scale)
  const canvas = new OffscreenCanvas(swap ? drawH : drawW, swap ? drawW : drawH)
  const ctx = canvas.getContext('2d')
  ctx.save()
  ctx.translate(canvas.width / 2, canvas.height / 2)
  if (rotate) ctx.rotate((rotate * Math.PI) / 180)
  if (ops.flipH === true || ops.flipV === true) ctx.scale(ops.flipH === true ? -1 : 1, ops.flipV === true ? -1 : 1)
  ctx.imageSmoothingEnabled = scale > 1
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, -drawW / 2, -drawH / 2, drawW, drawH)
  ctx.restore()
  bitmap.close?.()
  if (wantsPixels) {
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const data = image.data
    const contrast = Math.max(0, Number(ops.contrast) || 1)
    const threshold = Number.isFinite(Number(ops.threshold)) ? Number(ops.threshold) : NaN
    for (let i = 0; i < data.length; i += 4) {
      let r = data[i], g = data[i + 1], b = data[i + 2]
      if (ops.gray === true) { const l = r * 0.299 + g * 0.587 + b * 0.114; r = l; g = l; b = l }
      if (ops.invert === true) { r = 255 - r; g = 255 - g; b = 255 - b }
      if (contrast !== 1) {
        r = (r - 128) * contrast + 128
        g = (g - 128) * contrast + 128
        b = (b - 128) * contrast + 128
      }
      if (Number.isFinite(threshold)) {
        const l = r * 0.299 + g * 0.587 + b * 0.114
        r = g = b = l >= threshold ? 255 : 0
      }
      data[i] = r < 0 ? 0 : r > 255 ? 255 : r
      data[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g
      data[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b
    }
    ctx.putImageData(image, 0, 0)
  }
  const out = await canvas.convertToBlob({ type: 'image/png' })
  const bytes = new Uint8Array(await out.arrayBuffer())
  let text = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    text += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
  }
  return btoa(text)
}

async function screenshotPage({ fullPage, selector, rect, scale, frame, tabId: hint, frames, intervalMs, columns, preprocess }) {
  // Capture the scroll position before prepareShot: cropping an off-screen
  // element scrolls it into view, and the page must be put back exactly where
  // the user had it once the shot exists.
  const tabId = await requirePage(hint)
  // A recycled worker must not leave some other tab emulated: clean up before
  // measuring anything here.
  await sweepMetrics(recorder?.tabId ?? null)
  const origin = await evaluate(tabId, '({ x: Math.round(window.scrollX), y: Math.round(window.scrollY) })').catch(() => null)
  const prep = await prepareShot({ fullPage, selector, rect, scale, frame, tabId })
  // A capture never activates a tab or raises a window. A hidden page is shot
  // through captureBeyondViewport instead, which renders it without a compositor
  // frame and without changing what the user sees.
  const hidden = (await evaluate(prep.tabId, 'document.visibilityState').catch(() => null)) === 'hidden'
  const meta = await pageMeta(prep.tabId)
  try {
  const count = Math.min(Math.max(Math.trunc(Number(frames)) || 1, 1), 24)
  if (count === 1) {
    const raw = await captureShot(prep, { hidden })
    const png = await preprocessPng(raw, preprocess)
    const size = pngSize(png)
    const scale = prep.target && prep.target.width > 0 ? size.width / prep.target.width : undefined
    return { url: meta?.url ?? '', title: meta?.title ?? '', width: size.width, height: size.height, scale, pngBase64: png, frameId: prep.frameId, preprocessed: png !== raw || undefined }
  }
  const gap = Math.min(Math.max(Math.trunc(Number(intervalMs)) || 150, 0), 2000)
  const shots = []
  for (let index = 0; index < count; index += 1) {
    const started = Date.now()
    shots.push(await captureShot(prep, { hidden }))
    if (index < count - 1) await delay(Math.max(0, gap - (Date.now() - started)))
  }
  const composite = await composeFilmstrip(shots, columns)
  const finalData = await preprocessPng(composite.data, preprocess)
  const first = pngSize(shots[0])
  const size = pngSize(finalData)
  return {
    url: meta?.url ?? '',
    title: meta?.title ?? '',
    width: size.width,
    height: size.height,
    pngBase64: finalData,
    frameId: prep.frameId,
    frames: count,
    intervalMs: gap,
    frameWidth: first.width,
    frameHeight: first.height,
  }
  } finally {
    if (origin) {
      await evaluate(prep.tabId, '(() => { window.scrollTo(' + origin.x + ', ' + origin.y + '); })()').catch(() => undefined)
    }
  }
}

/**
 * Evaluate an expression in the page and return its JSON value.
 *
 * This is the agent's direct line into the page: read framework state, call the
 * site's own APIs, or inspect what a widget really contains. It runs with the
 * page's privileges on a tab the user paired, so it is deliberately explicit.
 */
async function frameList(tabId) {
  const tree = await send(tabId, 'Page.getFrameTree')
  const frames = []
  const walk = (node, depth) => {
    const f = node?.frame
    if (f) frames.push({ frameId: f.id, url: f.url || '', name: f.name || '', parentId: f.parentId || null, depth })
    for (const child of node?.childFrames ?? []) walk(child, depth + 1)
  }
  walk(tree?.frameTree, 0)
  return frames
}

function resolveFrameArg(frames, arg) {
  const want = String(arg ?? '').trim()
  if (!want) return null
  const children = frames.filter((f) => f.parentId !== null)
  if (/^\d+$/.test(want)) {
    const index = Number(want)
    if (index < children.length) return children[index]
  }
  return (
    frames.find((f) => f.frameId === want) ||
    frames.find((f) => f.parentId !== null && f.frameId.startsWith(want)) ||
    frames.find((f) => f.parentId !== null && f.url && f.url.includes(want)) ||
    null
  )
}

/** Same-origin path: walk window.frameElement up and sum viewport rects. */
async function absoluteFramePoint(tabId, contextId, selector) {
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

async function frameContext(tabId, frame) {
  const hit = resolveFrameArg(await frameList(tabId), frame)
  if (!hit) throw fail('FRAME_NOT_FOUND', `no frame matches ${JSON.stringify(String(frame))}`)
  const world = await send(tabId, 'Page.createIsolatedWorld', {
    frameId: hit.frameId,
    worldName: `dsh-bridge-${hit.frameId.slice(0, 8)}`,
  })
  return { frame: hit, contextId: world.executionContextId }
}

async function evaluateInContext(tabId, contextId, expression) {
  const response = await send(tabId, 'Runtime.evaluate', { expression, contextId, returnByValue: true })
  if (response?.exceptionDetails) throw fail('EVAL_FAILED', response.exceptionDetails.text ?? 'frame evaluation failed')
  return response?.result?.value
}

/** Where the frame's content box sits inside its own parent, in CSS px. */
async function frameOwnerOrigin(tabId, frameId) {
  await send(tabId, 'DOM.enable').catch(() => undefined)
  const owner = await send(tabId, 'DOM.getFrameOwner', { frameId })
  const model = await send(tabId, 'DOM.getBoxModel', { backendNodeId: owner?.backendNodeId })
  const quad = model?.model?.content ?? model?.model?.border ?? []
  if (quad.length < 8) throw fail('FRAME_NOT_FOUND', 'could not measure the frame element')
  return { x: quad[0], y: quad[1] }
}

async function contextForFrame(tabId, frameId) {
  const world = await send(tabId, 'Page.createIsolatedWorld', {
    frameId,
    worldName: `dsh-bridge-ctx-${frameId.slice(0, 8)}`,
  })
  return world.executionContextId
}

function ownerRectExpr(frame) {
  return `(() => {
    const want = ${JSON.stringify(frame.url ?? '')};
    const name = ${JSON.stringify(frame.name ?? '')};
    const list = Array.from(document.querySelectorAll('iframe, frame'));
    const hit = list.find((el) => {
      if (name && el.name === name) return true;
      const raw = el.getAttribute('src');
      if (!raw) return false;
      try { return new URL(raw, location.href).href === want } catch { return false }
    });
    if (!hit) return null;
    hit.scrollIntoView({ block: 'center', inline: 'center' });
    const r = hit.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })()`
}

/** Scroll the frame's boxes into view in every ancestor document, then sum their offsets. */
async function revealFramePath(tabId, frameId, { scroll = true } = {}) {
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

/** Frame ids from the root document down to the given frame. */
async function frameChain(tabId, frameId) {
  const frames = await frameList(tabId)
  const byId = new Map(frames.map((f) => [f.frameId, f]))
  const chain = []
  const seen = new Set()
  let current = frameId
  while (current && byId.has(current) && !seen.has(current)) {
    seen.add(current)
    chain.unshift(byId.get(current))
    current = byId.get(current).parentId
  }
  return chain
}

/** Where the frame's content box sits in the top-level viewport, accumulating nesting. */
async function frameOrigin(tabId, frameId) {
  const frames = await frameList(tabId)
  const byId = new Map(frames.map((f) => [f.frameId, f]))
  const origin = { x: 0, y: 0 }
  const seen = new Set()
  let current = frameId
  while (current && byId.get(current)?.parentId) {
    if (seen.has(current)) break
    seen.add(current)
    const local = await frameOwnerOrigin(tabId, current)
    origin.x += local.x
    origin.y += local.y
    current = byId.get(current).parentId
  }
  return origin
}

/** Resolve a selector or visible text to a point inside a child frame. */
async function framePoint(tabId, contextId, { target, text }) {
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
async function dropAt(tabId, point, files, text, mimeType, frameId) {
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

async function dropPage({ target, x, y, files, text, mimeType, frame, tabId: hint }) {
  const tabId = await requirePage(hint)
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
  return await dropAt(tabId, point, files, text, mimeType)

}

/**
 * List child frames. Most real pages put their interesting UI in an iframe;
 * bsb_eval with `frame` can read and drive it, while pointer tools stay on the
 * top document (they would need parent-space coordinates).
 */
async function framesPage() {
  const tabId = await requirePage()
  const frames = await frameList(tabId)
  const meta = await pageMeta(tabId)
  return { url: meta?.url ?? '', title: meta?.title ?? '', frames: frames.filter((f) => f.parentId !== null) }
}

/**
 * Read-only guard for model-supplied expressions.
 *
 * The bridge is an inspector and an input device: it may read the DOM, and it
 * may drive the page with trusted CDP input events, but it must never edit the
 * page's own markup, styles or form state behind the site's back. Chrome's
 * isolated worlds share the DOM with the page, so "read state" and "write
 * state" are the same object graph; the only way to keep them apart is to run
 * the expression in a world where the write surface throws for any node that
 * is connected to the document.
 *
 * The page's own scripts live in the main world and are untouched; a detached
 * subtree is free to mutate, so analysis that builds its own canvas or nodes
 * still works.
 */
const READ_ONLY_PRELUDE = `(() => {
  if (globalThis.__dshReadOnly) return 'installed'
  const deny = (what) => { throw new Error('READ_ONLY: the bridge may inspect the page but never edit it (' + what + ')') }
  const live = (node) => !!(node && node.isConnected)
  const patch = (proto, names, test) => {
    if (!proto) return
    for (const name of names) {
      const desc = Object.getOwnPropertyDescriptor(proto, name)
      if (!desc || typeof desc.value !== 'function' || !desc.configurable) continue
      const original = desc.value
      Object.defineProperty(proto, name, {
        configurable: true,
        writable: true,
        value: function () {
          if (test(this)) deny(name)
          return original.apply(this, arguments)
        },
      })
    }
  }
  const patchSet = (proto, names, test) => {
    if (!proto) return
    for (const name of names) {
      const desc = Object.getOwnPropertyDescriptor(proto, name)
      if (!desc || typeof desc.set !== 'function' || !desc.configurable) continue
      Object.defineProperty(proto, name, {
        configurable: true,
        get: desc.get,
        set: function (value) {
          if (test(this, value)) deny(name)
          desc.set.call(this, value)
        },
      })
    }
  }
  const guardList = (self, list, blocked, label) => {
    if (!live(self)) return list
    return new Proxy(list, {
      get(target, key) {
        const value = Reflect.get(target, key)
        if (typeof value !== 'function') return value
        if (blocked.indexOf(String(key)) === -1) return value.bind(target)
        return function () { deny(label + '.' + String(key)) }
      },
      set() { deny(label); return true },
    })
  }
  patch(Node.prototype, ['appendChild', 'insertBefore', 'removeChild', 'replaceChild'], live)
  patch(Element.prototype, ['append', 'prepend', 'after', 'before', 'replaceWith', 'replaceChildren', 'remove', 'insertAdjacentElement', 'insertAdjacentHTML', 'insertAdjacentText', 'setAttribute', 'setAttributeNS', 'removeAttribute', 'removeAttributeNS', 'toggleAttribute', 'attachShadow', 'animate'], live)
  patch(Document.prototype, ['write', 'writeln', 'execCommand', 'append', 'prepend'], () => true)
  patch(CSSStyleSheet.prototype, ['insertRule', 'deleteRule', 'addRule'], () => true)
  patch(NamedNodeMap.prototype, ['setNamedItem', 'setNamedItemNS', 'removeNamedItem', 'removeNamedItemNS'], () => true)
  patchSet(Element.prototype, ['innerHTML', 'outerHTML', 'className', 'id'], live)
  patchSet(Node.prototype, ['textContent', 'nodeValue'], live)
  patchSet(CharacterData.prototype, ['data'], live)
  patchSet(HTMLElement.prototype, ['innerText', 'outerText', 'hidden'], live)
  patchSet(HTMLInputElement.prototype, ['value', 'checked'], live)
  patchSet(HTMLTextAreaElement.prototype, ['value'], live)
  patchSet(HTMLSelectElement.prototype, ['value', 'selectedIndex'], live)
  patchSet(Document.prototype, ['title', 'cookie', 'adoptedStyleSheets'], () => true)
  const classListDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'classList')
  if (classListDesc && classListDesc.get) {
    Object.defineProperty(Element.prototype, 'classList', {
      configurable: true,
      get: function () { return guardList(this, classListDesc.get.call(this), ['add', 'remove', 'toggle', 'replace'], 'classList') },
    })
  }
  const datasetDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'dataset')
  if (datasetDesc && datasetDesc.get) {
    Object.defineProperty(HTMLElement.prototype, 'dataset', {
      configurable: true,
      get: function () {
        const set = datasetDesc.get.call(this)
        if (!live(this)) return set
        return new Proxy(set, {
          get(target, key) { const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value },
          set() { deny('dataset'); return true },
        })
      },
    })
  }
  const styleDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'style')
  if (styleDesc && styleDesc.get) {
    Object.defineProperty(HTMLElement.prototype, 'style', {
      configurable: true,
      get: function () { return guardList(this, styleDesc.get.call(this), ['setProperty', 'removeProperty'], 'style') },
    })
  }
  Object.defineProperty(globalThis, '__dshReadOnly', { value: true })
  return 'installed'
})()`

/** Create (or reuse) the guarded isolated world a model expression runs in. */
async function guardedContext(tabId, frameId) {
  let target = frameId
  if (!target) {
    const tree = await send(tabId, 'Page.getFrameTree')
    target = tree?.frameTree?.frame?.id
  }
  if (!target) throw fail('EVAL_FAILED', 'could not resolve the top frame')
  const world = await send(tabId, 'Page.createIsolatedWorld', {
    frameId: target,
    worldName: 'dsh-bridge-readonly',
  })
  const contextId = world?.executionContextId
  if (typeof contextId !== 'number') throw fail('EVAL_FAILED', 'could not create the guarded evaluation world')
  await send(tabId, 'Runtime.evaluate', { expression: READ_ONLY_PRELUDE, contextId, returnByValue: true })
  return contextId
}

/**
 * Sample a page over time — the dynamic counterpart of bsb_read/bsb_pixels.
 *
 * A static read cannot answer "is this animation running?", "where is the
 * sprite at t=0.4 s?" or "did the frame rate collapse?" (an occluded Chrome
 * window throttles requestAnimationFrame to ~1 fps). This runs a bounded,
 * read-only sampling loop in the guarded isolated world: every interval it
 * records the element's box and, when the element is a canvas, a coarse
 * colour grid of its pixels; it also counts animation frames. Every API used
 * (getBoundingClientRect, getImageData, performance.now, requestAnimationFrame)
 * is a read, so the page is never modified.
 */
async function timelinePage({ selector, durationMs, intervalMs, grid, raf, frame } = {}) {
  const tabId = await requirePage()
  const sel = typeof selector === 'string' && selector.trim() ? selector.trim() : 'body'
  const duration = Math.min(Math.max(Math.round(Number(durationMs) || 1000), 100), 10000)
  const interval = Math.min(Math.max(Math.round(Number(intervalMs) || 50), 16), 1000)
  const cells = Math.min(Math.max(Math.round(Number(grid) || 4), 1), 8)
  const countFrames = raf !== false
  let contextId
  if (frame) {
    const hit = resolveFrameArg(await frameList(tabId), frame)
    if (!hit) throw fail('FRAME_NOT_FOUND', `no frame matches ${JSON.stringify(String(frame))}`)
    contextId = await guardedContext(tabId, hit.frameId)
  } else {
    contextId = await guardedContext(tabId)
  }
  const program = `(async () => {
    const SEL = ${JSON.stringify(sel)}
    const DURATION = ${duration}
    const INTERVAL = ${interval}
    const CELLS = ${cells}
    const COUNT = ${countFrames ? 'true' : 'false'}
    const el = document.querySelector(SEL)
    if (!el) return { error: 'no element matches ' + SEL }
    const samples = []
    const t0 = performance.now()
    let rafs = 0
    let running = true
    if (COUNT) {
      const tick = () => { if (!running) return; rafs += 1; requestAnimationFrame(tick) }
      requestAnimationFrame(tick)
    }
    while (true) {
      if (performance.now() - t0 >= DURATION) break
      let box = null
      try {
        const r = el.getBoundingClientRect()
        box = {
          x: Math.round(r.x * 10) / 10,
          y: Math.round(r.y * 10) / 10,
          w: Math.round(r.width * 10) / 10,
          h: Math.round(r.height * 10) / 10,
        }
      } catch {}
      let colour = null
      try {
        const ctx = typeof el.getContext === 'function' ? el.getContext('2d') : null
        if (ctx && el.width > 0 && el.height > 0) {
          const data = ctx.getImageData(0, 0, el.width, el.height).data
          const cw = el.width / CELLS
          const ch = el.height / CELLS
          const rows = []
          for (let cy = 0; cy < CELLS; cy += 1) {
            const row = []
            for (let cx = 0; cx < CELLS; cx += 1) {
              let r = 0
              let g = 0
              let b = 0
              let n = 0
              const x0 = Math.floor(cx * cw)
              const x1 = Math.min(el.width, Math.floor((cx + 1) * cw))
              const y0 = Math.floor(cy * ch)
              const y1 = Math.min(el.height, Math.floor((cy + 1) * ch))
              for (let y = y0; y < y1; y += 3) {
                for (let x = x0; x < x1; x += 3) {
                  const i = (y * el.width + x) * 4
                  if (data[i + 3] < 8) continue
                  r += data[i]
                  g += data[i + 1]
                  b += data[i + 2]
                  n += 1
                }
              }
              row.push(n ? [Math.round(r / n), Math.round(g / n), Math.round(b / n), n] : null)
            }
            rows.push(row)
          }
          colour = rows
        }
      } catch {}
      let text = null
      try {
        if (el.tagName !== 'CANVAS') text = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120)
      } catch {}
      samples.push({ t: Math.round(performance.now() - t0), box, colour, text, frames: rafs })
      await new Promise((resolve) => setTimeout(resolve, INTERVAL))
    }
    running = false
    const elapsed = Math.max(1, performance.now() - t0)
    return { selector: SEL, samples, fps: Math.round((rafs / elapsed) * 10000) / 10, elapsed: Math.round(elapsed) }
  })()`
  const value = await evaluateProgram(tabId, program, { contextId, awaitPromise: true })
  if (!value || value.error) throw fail('NO_MATCH', String(value?.error || 'timeline returned nothing'))
  return value
}

async function evalPage({ expression, awaitPromise, frame, world, tabId: hint }) {
  // The tab hint is what makes multi-tab work possible: without it every eval
  // lands on the tracked tab, so a second tab can never be read while the first
  // one is being driven.
  const tabId = await requirePage(hint)
  if (typeof expression !== 'string' || expression.trim().length === 0) throw fail('BAD_ARGUMENT', 'expression is required')
  // world:'main' evaluates in the page's own world (Runtime.evaluate with no
  // contextId). It is opt-in per call: the default stays the guarded isolated
  // world, but the caller may ask for the real one when it needs page state
  // (framework instances, closures) that the isolated world cannot see.
  const useMain = String(world || 'isolated') === 'main'
  let contextId
  let extra = { world: useMain ? 'main' : 'isolated' }
  if (frame) {
    const hit = resolveFrameArg(await frameList(tabId), frame)
    if (!hit) throw fail('FRAME_NOT_FOUND', `no frame matches ${JSON.stringify(String(frame))}`)
    if (!useMain) contextId = await guardedContext(tabId, hit.frameId)
    extra = { frameId: hit.frameId, url: hit.url, world: extra.world }
  } else if (!useMain) {
    contextId = await guardedContext(tabId)
  }
  const value = await evaluateProgram(tabId, expression, { contextId, awaitPromise: awaitPromise === true })
  return { result: value === undefined ? null : value, ...extra }
}

/** Evaluate a value expression, or a statement list when the expression does not parse. */
async function evaluateProgram(tabId, expression, { contextId, awaitPromise = false } = {}) {
  // returnByValue serializes a Promise to {}, losing the RemoteObject subtype,
  // so detect the thenable inside the page while it is still live.
  const first = awaitPromise
    ? `(() => { try { return (${expression}) } catch (error) { return { __error: String((error && error.message) || error) } } })()`
    : `(() => { try { const __v = (${expression}); if (__v && typeof __v.then === 'function') return { __promise: true }; return __v } catch (error) { return { __error: String((error && error.message) || error) } } })()`
  const attempts = [
    first,
    `(() => { try { ${expression}
    } catch (error) { return { __error: String((error && error.message) || error) } } })()`,
  ]
  let last = null
  for (const source of attempts) {
    const params = { expression: source, returnByValue: true, awaitPromise }
    if (contextId !== undefined) params.contextId = contextId
    const response = await send(tabId, 'Runtime.evaluate', params)
    if (!response?.exceptionDetails) {
      const remote = response?.result
      const value = remote?.value
      if (value && typeof value === 'object' && value.__promise === true) {
        throw fail('PROMISE_RESULT', 'the expression returned a Promise; pass awaitPromise:true, or await it inside the expression')
      }
      // Fallback for the un-serialized RemoteObject shape.
      if (!awaitPromise && remote && (remote.subtype === 'promise' || remote.className === 'Promise' || /^Promise\b/.test(String(remote.description || '')))) {
        throw fail('PROMISE_RESULT', 'the expression returned a Promise; pass awaitPromise:true, or await it inside the expression')
      }
      if (value && typeof value === 'object' && typeof value.__error === 'string') {
        throw fail(value.__error.startsWith('READ_ONLY') ? 'READ_ONLY_ARCHITECTURE' : 'EVAL_FAILED', value.__error)
      }
      return value
    }
    last = response.exceptionDetails
    const description = String(last?.exception?.description || last?.text || '')
    if (!/SyntaxError/i.test(description)) break
  }
  throw fail('EVAL_FAILED', String(last?.exception?.description || last?.text || 'evaluation failed').slice(0, 300))
}

/**
 * Observe the page's own network traffic (fetch/XHR/beacons) through CDP.
 *
 * action=start begins a capture for the tracked tab, action=log returns what was
 * seen (newest last, bodies truncated), action=stop ends it. Reading the site's
 * real requests is often enough to understand a puzzle without touching the page.
 */
/**
 * Read a list of elements as structured data: one call returns every match with
 * its text, links, image source and form state, which is what a scraper or a
 * crawler wants before it decides where to click next.
 */
/**
 * Render every match of a selector as one labelled contact sheet.
 *
 * A grid of forty thumbnails is a single picture a reader can judge at a glance,
 * which is what tile and list pages need before any click is spent on them.
 */
async function sheetPage({ selector, offset, limit, scale, columns, tabId: hint }) {
  const tabId = await requirePage(hint)
  await sweepMetrics(recorder?.tabId ?? null)
  const sel = typeof selector === 'string' ? selector.trim() : ''
  if (!sel) throw fail('NO_SELECTOR', 'pass a CSS selector whose matches should be tiled, e.g. "label.tile"')
  const cap = Math.min(Math.max(Number(limit) || 24, 1), 144)
  const skip = Math.min(Math.max(Number(offset) || 0, 0), 1000)
  const zoom = Math.min(Math.max(Number(scale) || 2, 0.5), 6)
  const boxes = await evaluate(tabId, `(() => {
    const out = []
    for (const el of Array.from(document.querySelectorAll(${JSON.stringify(sel)})).slice(${skip}, ${skip + cap})) {
      const r = el.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) continue
      out.push({ x: r.x, y: r.y, width: r.width, height: r.height })
    }
    return out
  })()`)
  const list = Array.isArray(boxes) ? boxes : []
  if (list.length === 0) throw fail('NO_MATCH', `no visible element matches ${sel}`)
  // A CDP clip is measured in layout pixels but rendered through the surface own
  // device ratio, so on a zoomed profile it captures a slightly wider region than the
  // box (tiles bled into their neighbours). Take one plain surface shot and crop every
  // tile out of it with the same ratio maths the screenshot tool already uses.
  const view = await evaluate(tabId, "({ w: window.innerWidth, h: window.innerHeight })").catch(() => ({ w: 0, h: 0 }))
  const full = await send(tabId, "Page.captureScreenshot", { format: "png" })
  if (!full || !full.data) throw fail("NO_FRAME", "the page returned an empty screenshot")
  const dims = pngSize(full.data)
  const ratio = view && view.w > 0 && dims.width > 0 ? dims.width / view.w : 1
  const shots = []
  const tiles = []
  for (const box of list) {
    const data = await cropPng(full.data, box.x * ratio, box.y * ratio, box.width * ratio, box.height * ratio, zoom)
    shots.push({ data })
    tiles.push(await imageStats(data, 'image/png'))
  }
  const cols = Math.min(Math.max(Number(columns) || Math.ceil(Math.sqrt(shots.length)), 1), 20)
  const png = await composeFilmstrip(shots.map((shot) => shot.data), cols, "image/png", { maxTiles: 144 })
  const size = await frameSize(shots[0].data, "image/png")
  return {
    url: (await pageMeta(tabId))?.url ?? '',
    selector: sel,
    offset: skip,
    count: shots.length,
    columns: cols,
    tileWidth: size?.width ?? 0,
    tileHeight: size?.height ?? 0,
    tiles: tiles.map((stat, index) => ({ i: index + 1 + skip, ...stat })),
    pngBase64: png?.data ?? png,
  }
}

/** Mean colour of every cell of an element, so a caller can reason about a picture
 *  (brightness, hue, saturation) without ever decoding it by hand. Read-only. */
async function pixelsPage({ selector, grid, scale, points: wanted, radius, tabId: hint }) {
  const tabId = await requirePage(hint)
  await sweepMetrics(recorder?.tabId ?? null)
  const sel = typeof selector === 'string' ? selector.trim() : ''
  if (!sel) throw fail('NO_SELECTOR', 'pass a CSS selector for the element to sample, e.g. "#cv" or "img"')
  const cols = Math.min(Math.max(Math.round(Number(grid) || 8), 1), 32)
  const zoom = Math.min(Math.max(Number(scale) || 1, 0.5), 4)
  const box = await evaluate(tabId, `(() => {
    const el = document.querySelector(${JSON.stringify(sel)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })()`)
  if (!box || box.width < 2 || box.height < 2) throw fail('NO_MATCH', `no visible element matches ${sel}`)
  const view = await evaluate(tabId, '({ w: window.innerWidth, h: window.innerHeight })').catch(() => ({ w: 0, h: 0 }))
  const full = await send(tabId, 'Page.captureScreenshot', { format: 'png' })
  if (!full || !full.data) throw fail('NO_FRAME', 'the page returned an empty screenshot')
  const dims = pngSize(full.data)
  const ratio = view && view.w > 0 && dims.width > 0 ? dims.width / view.w : 1
  const data = await cropPng(full.data, box.x * ratio, box.y * ratio, box.width * ratio, box.height * ratio, zoom)
  const bytes = Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0))
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
  const width = bitmap.width
  const height = bitmap.height
  const rows = Math.min(Math.max(Math.round(cols * (height / Math.max(1, width))), 1), 32)
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')
  context.drawImage(bitmap, 0, 0)
  bitmap.close?.()
  const pixels = context.getImageData(0, 0, width, height).data
  /*
   * Exact points, for layouts a uniform grid cannot address: an isometric board,
   * a hex map, a sprite sheet. Points are element-local CSS pixels, so the caller
   * can compute them from the page's own geometry (label positions, data
   * attributes) instead of guessing a grid that lines up by accident.
   */
  if (Array.isArray(wanted) && wanted.length) {
    const sx = width / box.width
    const sy = height / box.height
    const rad = Math.min(Math.max(Math.round(Number(radius) || 0), 0), 8)
    const sampled = []
    for (const point of wanted.slice(0, 4096)) {
      const px = Number(point?.[0])
      const py = Number(point?.[1])
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue
      const cx = Math.round(px * sx)
      const cy = Math.round(py * sy)
      if (cx < 0 || cy < 0 || cx >= width || cy >= height) {
        sampled.push({ x: px, y: py, off: true })
        continue
      }
      let r = 0, g = 0, b = 0, n = 0, bright = 0
      for (let y = Math.max(0, cy - rad); y <= Math.min(height - 1, cy + rad); y += 1) {
        for (let x = Math.max(0, cx - rad); x <= Math.min(width - 1, cx + rad); x += 1) {
          const i = (y * width + x) * 4
          r += pixels[i]; g += pixels[i + 1]; b += pixels[i + 2]
          if (0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2] > 200) bright += 1
          n += 1
        }
      }
      sampled.push({
        x: Math.round(px * 10) / 10,
        y: Math.round(py * 10) / 10,
        r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n),
        lum: Math.round((0.2126 * r + 0.7152 * g + 0.0722 * b) / n),
        bright: Math.round((bright / n) * 100) / 100,
      })
    }
    return { url: (await pageMeta(tabId))?.url ?? '', selector: sel, width, height, points: sampled }
  }
  const cells = []
  for (let ry = 0; ry < rows; ry += 1) {
    const row = []
    const y0 = Math.floor((ry * height) / rows)
    const y1 = Math.max(y0 + 1, Math.floor(((ry + 1) * height) / rows))
    for (let cx = 0; cx < cols; cx += 1) {
      const x0 = Math.floor((cx * width) / cols)
      const x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * width) / cols))
      let r = 0
      let g = 0
      let b = 0
      let bright = 0
      let n = 0
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const i = (y * width + x) * 4
          r += pixels[i]
          g += pixels[i + 1]
          b += pixels[i + 2]
          if (0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2] > 200) bright += 1
          n += 1
        }
      }
      row.push({
        r: Math.round(r / n),
        g: Math.round(g / n),
        b: Math.round(b / n),
        lum: Math.round((0.2126 * r + 0.7152 * g + 0.0722 * b) / n),
        bright: Math.round((bright / n) * 100) / 100,
      })
    }
    cells.push(row)
  }
  return { url: (await pageMeta(tabId))?.url ?? '', selector: sel, width, height, cols, rows, cells }
}

async function inspectPage({ selector, offset, limit, text: withText, href: withHref, image: withImage, state: withState, tabId: hint }) {
  const tabId = await requirePage(hint)
  const sel = typeof selector === 'string' ? selector.trim() : ''
  if (!sel) throw fail('NO_SELECTOR', 'pass a CSS selector such as "a", "table tr" or "div.card"')
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 500)
  const skip = Math.min(Math.max(Number(offset) || 0, 0), 1000)
  const want = {
    text: withText !== false,
    href: Boolean(withHref),
    image: Boolean(withImage),
    state: Boolean(withState),
  }
  const expression = `(() => {
    const nodes = Array.from(document.querySelectorAll(${JSON.stringify(sel)}))
    const out = []
    for (const el of nodes.slice(${skip}, ${skip + cap})) {
      const r = el.getBoundingClientRect()
      const rec = { i: out.length + 1, tag: el.tagName.toLowerCase(), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
      if (${want.text}) { const t = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim(); if (t) rec.text = t.slice(0, 240) }
      if (${want.href}) { const h = el.getAttribute('href'); if (h) rec.href = el.href }
      if (${want.image}) { const im = el.matches('img') ? el : el.querySelector('img'); if (im) rec.image = im.currentSrc || im.src || im.getAttribute('src') || '' }
      if (${want.state}) {
        const control = el.matches('input,select,textarea,option') ? el : el.querySelector('input,select,textarea')
        if (control) {
          rec.kind = String(control.type || control.tagName).toLowerCase()
          if (control.value !== undefined) rec.value = String(control.value).slice(0, 120)
          if ('checked' in control) rec.checked = Boolean(control.checked)
        }
        const id = el.getAttribute('id'); if (id) rec.id = id
        const nm = el.getAttribute('name'); if (nm) rec.name = nm
        const cls = el.getAttribute('class'); if (cls) rec.class = cls.slice(0, 120)
      }
      out.push(rec)
    }
    return { count: nodes.length, shown: out.length, offset: ${skip}, items: out }
  })()`
  const value = await evaluate(tabId, expression)
  return { url: (await pageMeta(tabId))?.url ?? '', selector: sel, ...(value || { count: 0, shown: 0, items: [] }) }
}

async function networkPage({ action, limit, filter, detail, fields, tabId: hint }) {
  const tabId = await requirePage(hint)
  const mode = String(action || 'log')
  if (mode === 'start') {
    const cap = Math.min(Math.max(Number(limit) || 100, 1), 500)
    netCaptures.set(tabId, { limit: cap, entries: new Map(), order: [] })
    await send(tabId, 'Network.enable', { maxTotalBufferSize: 50000000, maxResourceBufferSize: 10000000 })
    return { started: true, tabId, limit: cap, url: (await pageMeta(tabId))?.url ?? '' }
  }
  if (mode === 'stop') {
    const capture = netCaptures.get(tabId)
    netCaptures.delete(tabId)
    await send(tabId, 'Network.disable').catch(() => undefined)
    return { stopped: true, tabId, captured: capture ? capture.order.length : 0 }
  }
  if (mode !== 'log') throw fail('BAD_ARGUMENT', 'action must be start, log or stop')
  const capture = netCaptures.get(tabId)
  if (!capture) throw fail('NOT_CAPTURING', 'network capture is not running; call bsb_network with action "start" first')
  const cap = Math.min(Math.max(Number(limit) || 40, 1), 200)
  const needle = typeof filter === 'string' && filter.length > 0 ? filter.toLowerCase() : ''
  const all = capture.order.map((requestId) => capture.entries.get(requestId)).filter(Boolean)
  const entries = needle ? all.filter((entry) => String(entry?.url ?? '').toLowerCase().includes(needle)) : all
  // A raw entry carries full request and response headers plus both bodies: a
  // dozen of them is tens of kilobytes and almost all of it is noise. Default to
  // a projection an agent can actually read, and let a caller ask for the rest.
  const level = String(detail || 'brief') === 'full' ? 'full' : 'brief'
  const wanted = Array.isArray(fields) && fields.length > 0 ? fields.map(String) : null
  const project = (entry) => {
    if (wanted) {
      const out = {}
      for (const key of wanted) if (entry[key] !== undefined) out[key] = entry[key]
      return out
    }
    if (level === 'full') return entry
    const out = {}
    for (const key of ['at', 'method', 'url', 'type', 'status', 'mime', 'error']) {
      if (entry[key] !== undefined) out[key] = entry[key]
    }
    // Body sizes matter more than bodies: they say whether a payload is worth
    // asking for with detail:"full".
    if (typeof entry.body === 'string') out.bodyBytes = entry.body.length
    if (typeof entry.requestBody === 'string') out.requestBytes = entry.requestBody.length
    return out
  }
  return {
    tabId,
    capturing: true,
    total: all.length,
    matched: entries.length,
    filter: needle || undefined,
    detail: level,
    hint: level === 'brief' ? 'pass detail:"full" (or fields:["responseHeaders"]) for headers and bodies' : undefined,
    entries: entries.slice(-cap).map(project),
  }
}

/**
 * Console + uncaught-exception capture.
 *
 * A page whose UI stops updating usually says why on the console; without this
 * the failure is invisible to an agent that can only see the DOM.
 */
async function consolePage({ action, limit, tabId: hint }) {
  const tabId = await requirePage(hint)
  const capture = consoleCapture(tabId)
  const mode = action ?? 'log'
  if (mode === 'start') {
    capture.entries = []
    capture.limit = Math.min(Math.max(Number(limit) || 100, 1), 500)
    capture.active = true
    await send(tabId, 'Runtime.enable').catch(() => undefined)
    await send(tabId, 'Log.enable').catch(() => undefined)
    return { tabId, capturing: true, count: 0 }
  }
  if (mode === 'clear') {
    capture.entries = []
    return { tabId, capturing: capture.active, cleared: true }
  }
  if (mode !== 'log') throw fail('BAD_ARGUMENT', 'action must be start, log or clear')
  const cap = Math.min(Math.max(Number(limit) || 60, 1), 500)
  return { tabId, capturing: capture.active, total: capture.entries.length, entries: capture.entries.slice(-cap) }
}

/** Native image data for one element (img/canvas), so text is read at its real resolution. */
/**
 * Fetch image bytes from the extension's own context.
 *
 * CORS-exempt for any origin the manifest grants host permission to, which
 * covers the public-image case the page-context fetch cannot reach.
 */
async function fetchBytesDirect(url) {
  const res = await fetch(url, { cache: 'force-cache' })
  if (!res.ok) throw fail('FETCH_FAILED', 'HTTP ' + res.status)
  const buf = new Uint8Array(await res.arrayBuffer())
  let bin = ''
  for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 8192))
  return { mime: res.headers.get('content-type') || '', base64: btoa(bin) }
}

async function imageSource({ selector }) {
  const tabId = await requirePage()
  const meta = await pageMeta(tabId)
  const sel = String(selector ?? 'img')
  const src = await evaluate(tabId, '(() => { const el = document.querySelector(' + JSON.stringify(sel) + '); if (!el) return null; if (el.tagName === "CANVAS") { try { return el.toDataURL("image/png") } catch { return null } } return el.currentSrc || el.src || null })()')
  if (typeof src !== 'string' || src.length === 0) throw fail('TARGET_NOT_FOUND', 'no image matches ' + sel)
  const match = /^data:(image\/[a-z+]+);base64,(.*)$/i.exec(src)
  if (match) {
    return {
      url: meta?.url ?? '',
      title: meta?.title ?? '',
      mime: match[1],
      base64: match[2],
      source: 'data:' + match[1] + ';base64,…',
      width: await evaluate(tabId, '(() => { const el = document.querySelector(' + JSON.stringify(sel) + '); return el ? el.naturalWidth || el.width : 0 })()'),
      height: await evaluate(tabId, '(() => { const el = document.querySelector(' + JSON.stringify(sel) + '); return el ? el.naturalHeight || el.height : 0 })()'),
    }
  }
  if (!/^https?:/.test(src)) throw fail('BAD_ARGUMENT', 'image has no usable source (got ' + src + ')')
  // The page-context fetch is what carries the page's cookies and Referer, but a
  // cross-origin <img> served without CORS headers rejects it outright (the
  // browser throws "Failed to fetch" rather than returning a status). Catch that
  // and fall back to the extension's own fetch, which is CORS-exempt for origins
  // the manifest grants host permission to.
  const fetched = await evaluate(tabId, `(async () => {
    try {
      const res = await fetch(${JSON.stringify(src)}, { credentials: 'include' })
      if (!res.ok) return { error: 'HTTP ' + res.status }
      const buf = new Uint8Array(await res.arrayBuffer())
      let bin = ''
      for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 8192))
      return { mime: res.headers.get('content-type') || '', base64: btoa(bin) }
    } catch (error) {
      return { error: String((error && error.message) || error) }
    }
  })()`, true)
  let bytes = fetched
  let via = 'page'
  if (!bytes || typeof bytes.base64 !== 'string' || bytes.base64.length === 0) {
    const direct = await fetchBytesDirect(src).catch(() => null)
    if (direct) { bytes = direct; via = 'extension' }
  }
  if (!bytes || typeof bytes.base64 !== 'string' || bytes.base64.length === 0) {
    const why = fetched && fetched.error ? fetched.error : 'no bytes returned'
    throw fail('FETCH_FAILED', 'could not read image bytes from ' + src + ' (' + why + '). Cross-origin images without CORS headers need bsb_capture instead.')
  }
  const fetchedMime = bytes.mime
  return {
    url: meta?.url ?? '',
    title: meta?.title ?? '',
    mime: String(fetchedMime).split(';')[0].trim(),
    base64: bytes.base64,
    source: src,
    via,
    width: await evaluate(tabId, '(() => { const el = document.querySelector(' + JSON.stringify(sel) + '); return el ? el.naturalWidth || el.width : 0 })()'),
    height: await evaluate(tabId, '(() => { const el = document.querySelector(' + JSON.stringify(sel) + '); return el ? el.naturalHeight || el.height : 0 })()'),
  }
}

/** Close one tab by id — for cleaning up tabs an earlier session left behind. */
async function closeTab({ tabId }) {
  const id = Number(tabId)
  if (!Number.isInteger(id)) throw fail('BAD_ARGUMENT', 'tabId must be a number')
  const tracked = await getTrackedId()
  await chrome.tabs.remove(id)
  if (tracked === id) await chrome.storage.local.remove('tabId')
  return { tabId: id, closed: true }
}

/** Bounded markup of the whole document or one selector. */
async function readHtml({ selector, maxChars, tabId: hint }) {
  const tabId = await requirePage(hint)
  const cap = Math.min(Math.max(Number(maxChars) || 12000, 200), 200000)
  const expression = selector
    ? '(() => { const el = document.querySelector(' + JSON.stringify(String(selector)) + '); return el ? el.outerHTML : null })()'
    : '(() => (document.body ? document.body.outerHTML : ""))()'
  const html = await evaluate(tabId, expression)
  if (typeof html !== 'string') throw fail('TARGET_NOT_FOUND', 'no element matches ' + String(selector))
  return {
    url: (await pageMeta(tabId))?.url ?? '',
    html: html.slice(0, cap),
    truncated: html.length > cap,
    length: html.length,
  }
}

/** Tabs the user already has, so a task can target one they are looking at. */
async function listTabs({ action, tabId: hint } = {}) {
  // F5 is a browser-level accelerator: a key event dispatched to the renderer
  // never reaches it, so "reload this page" had no working primitive. Page.reload
  // is the real thing, and it is what a dev loop needs after every edit.
  if (action === 'reload') {
    const id = typeof hint === 'number' ? hint : await requirePage()
    await send(id, 'Page.reload', { ignoreCache: true })
    await waitReady(id, 8000).catch(() => undefined)
    await delay(200)
    const meta = await pageMeta(id)
    return { reloaded: true, tabId: id, url: meta?.url ?? '', title: meta?.title ?? '' }
  }
  const tabs = await chrome.tabs.query({})
  const tracked = await getTrackedId()
  return {
    tabs: tabs
      .filter((tab) => typeof tab.id === 'number')
      .map((tab) => ({
        tabId: tab.id,
        title: tab.title ?? '',
        url: tab.url ?? '',
        active: tab.active === true,
        current: tab.id === tracked,
      }))
      .slice(0, 200),
  }
}

/** Adopt an existing tab instead of opening one. */
async function useExistingTab({ tabId, activate }) {
  const id = Number(tabId)
  if (!Number.isInteger(id)) throw fail('BAD_ARGUMENT', 'tabId must be a number')
  const tab = await chrome.tabs.get(id).catch(() => undefined)
  if (!tab) throw fail('NO_TAB', `no tab with id ${id}`)
  if (activate !== false) await chrome.tabs.update(tab.id, { active: true }).catch(() => undefined)
  // Attach BEFORE tracking. Adopting a tab the debugger cannot reach — chrome://,
  // another extension's page — used to set the tracked slot first and throw on
  // the attach afterwards, so the browser was left pointing at an unreadable page
  // and every later command failed with "Cannot access a chrome:// URL" until
  // some other tab was adopted. A refused adoption must change nothing.
  await attach(tab.id)
  await trackId(tab.id)
  refs = new Map()
  const meta = await pageMeta(tab.id)
  return { tabId: tab.id, url: meta?.url ?? tab.url ?? '', title: meta?.title ?? tab.title ?? '' }
}

async function closePage() {
  const tab = await trackedTab()
  if (!tab) return { closed: false }
  await detach(tab.id)
  try { await chrome.tabs.remove(tab.id) } catch {}
  await chrome.storage.local.remove('tabId')
  refs = new Map()
  return { closed: true }
}

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
  attached.delete(tabId)
  if (detachTimer) {
    clearTimeout(detachTimer)
    detachTimer = undefined
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

const ensureAlarm = () => {
  try {
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 })
  } catch {
    // Older builds clamp the period; the alarm still exists, just less often.
    try { chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 }) } catch {}
  }
}

void ensureAlarm()
void startLoop()

/** CDP call that survives a dropped debugger session (a reload detaches it). */
async function send(tabId, method, params = {}) {
  try {
    return await rawSend(tabId, method, params)
  } catch (error) {
    if (!/not attached|no tab with given id|detached/i.test(String(error?.message ?? error))) throw error
    await attach(tabId)
    return rawSend(tabId, method, params)
  }
}
