// Browser Bridge worker: cdp.
// Split from extension/sw.js; keep the module boundaries in docs/SPEC.md in sync.
import { DETACH_IDLE_MS, FORCE_ACTIVE_NOTE, FORCE_HOLD_NOTE, HELD_KEY, READ_ONLY_PRELUDE } from './constants.js'
import { shared } from './state.js'
import { delay, fail } from './util.js'

export function rawSend(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      const error = chrome.runtime.lastError
      if (error) reject(fail('CDP_ERROR', error.message ?? String(error)))
      else resolve(result)
    })
  })
}

export async function attach(tabId) {
  // Attaching twice is not an error: "Already attached" means we own it.
  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      const message = chrome.runtime.lastError?.message
      if (message && !/already attached/i.test(message)) reject(fail('CDP_ERROR', message))
      else resolve()
    })
  })
  shared.attached.add(tabId)
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
  await shared.heldReady
  if (shared.heldForced.has(tabId)) await forceActive(tabId, { mode: 'hold' })
}

/**
 * Attach, recovering from a tab parked on a Chrome error page.
 *
 * A certificate interstitial, a crashed renderer or `chrome://` leaves the tab
 * on a target DevTools refuses to attach to ("Cannot attach to this target").
 * The tab is still navigable, so parking it on about:blank and retrying makes
 * the next bsb_open work instead of failing before it can navigate anywhere.
 */
export async function attachTab(tabId, { recover = false } = {}) {
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

export function detach(tabId) {
  shared.attached.delete(tabId)
  shared.injectedScripts.delete(tabId)
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      void chrome.runtime.lastError
      resolve()
    })
  })
}

export function scheduleDetach(tabId) {
  if (shared.detachTimer) clearTimeout(shared.detachTimer)
  shared.detachTimer = setTimeout(() => {
    shared.detachTimer = undefined
    // A recording owns the session: detaching would stop the screencast feed
    // in the middle of the animation it is watching. A live network capture owns
    // it too — detaching disables Network.enable and silently stops collecting.
    if ((shared.recorder && shared.recorder.tabId === tabId) || shared.netCaptures.has(tabId)) {
      scheduleDetach(tabId)
      return
    }
    if (shared.attached.has(tabId)) void detach(tabId)
  }, DETACH_IDLE_MS)
}

export function waitEvent(tabId, method, timeoutMs) {
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

export async function evaluate(tabId, expression) {
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

export const pageMeta = (tabId) => evaluate(tabId, '(() => ({ url: location.href, title: document.title }))()')

/**
 * Bring the window that holds a tab to the front.
 *
 * A browser window that sits behind another one paints only about once a
 * second, and every screenshot then waits for that paint — a foreground window
 * is what makes a fast frame cadence possible.
 */
export const windowInfo = async (tabId) => {
  try {
    const tab = await chrome.tabs.get(tabId)
    if (typeof tab?.windowId !== 'number') return null
    const window = await chrome.windows.get(tab.windowId)
    return { state: window?.state ?? 'unknown', focused: Boolean(window?.focused) }
  } catch {
    return null
  }
}

export async function persistHeld() {
  try { await chrome.storage.session.set({ [HELD_KEY]: [...shared.heldForced] }) } catch {}
}

/**
 * `mode: 'hold'` keeps the override until `releaseActive` is called.
 *
 * The per-call form is enough to land an input, but it clears itself before the
 * frame the user would be looking at is drawn — the window wakes, takes one
 * keystroke, and drops back. A held override is what makes the behaviour
 * observable, which is the only reason to have the hatch at all.
 */
export async function forceActive(tabId, { mode = 'call' } = {}) {
  await shared.heldReady
  const held = mode === 'hold'
  if (shared.heldForced.has(tabId)) {
    // A held override does not survive a navigation: the tab keeps its id, but the
    // new document starts hidden again, so the CDP session that carried the override
    // is gone. Trusting this Set made a stale hold answer `reused` while the frame
    // clock was still stopped — the failure mode the hatch exists to prevent, now
    // reporting success. Re-read the page before claiming the override is in force.
    const visibility = await evaluate(tabId, 'document.visibilityState').catch(() => null)
    if (visibility === 'visible') {
      return { applied: ['focus', 'lifecycle'], held: true, reused: true, visibility, note: FORCE_HOLD_NOTE }
    }
    shared.heldForced.delete(tabId)
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
    shared.heldForced.add(tabId)
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
export async function releaseActive(tabId) {
  await shared.heldReady
  const wasHeld = shared.heldForced.delete(tabId)
  if (!wasHeld) return { released: false }
  await persistHeld()
  await rawSend(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => undefined)
  const visibility = await evaluate(tabId, 'document.visibilityState').catch(() => null)
  return { released: true, visibility: visibility ?? undefined }
}

export async function clearForced(tabId, forced) {
  if (!forced) return
  // A held override outlives the call that started it.
  if (forced.held || shared.heldForced.has(tabId)) return
  // The focus override is symmetric, so it is always removed.
  if (forced.applied.includes('focus')) {
    await rawSend(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => undefined)
  }
  // The lifecycle override is not: CDP has no "let the browser decide" value, so
  // there is nothing to restore. It is dropped on detach instead, where the page
  // stops being ours; forcing it back to `active` would be a second silent lie.
}

/**
 * Pointer input is only meaningful in a laid-out viewport: a minimised Chrome
 * window reports a 0x0 layout viewport, which collapses every measured box into
 * negative coordinates. This plugin never raises a window to repair that — the
 * caller restores it — because forceActive cannot invent layout and a silent
 * raise takes over the desktop.
 */
export async function ensureLayout(tabId, { forceActive: wanted = false } = {}) {
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

export async function waitReady(tabId, timeoutMs) {
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

/**
 * Evaluate an expression in the page and return its JSON value.
 *
 * This is the agent's direct line into the page: read framework state, call the
 * site's own APIs, or inspect what a widget really contains. It runs with the
 * page's privileges on a tab the user paired, so it is deliberately explicit.
 */
export async function frameList(tabId) {
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

export function resolveFrameArg(frames, arg) {
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
    // A srcdoc frame has no URL at all, so its name is the only stable handle.
    frames.find((f) => f.parentId !== null && f.name && f.name === want) ||
    frames.find((f) => f.parentId !== null && f.url && f.url.includes(want)) ||
    null
  )
}

export async function frameContext(tabId, frame) {
  const hit = resolveFrameArg(await frameList(tabId), frame)
  if (!hit) throw fail('FRAME_NOT_FOUND', `no frame matches ${JSON.stringify(String(frame))}`)
  const world = await send(tabId, 'Page.createIsolatedWorld', {
    frameId: hit.frameId,
    worldName: `dsh-bridge-${hit.frameId.slice(0, 8)}`,
  })
  return { frame: hit, contextId: world.executionContextId }
}

export async function evaluateInContext(tabId, contextId, expression) {
  const response = await send(tabId, 'Runtime.evaluate', { expression, contextId, returnByValue: true })
  if (response?.exceptionDetails) throw fail('EVAL_FAILED', response.exceptionDetails.text ?? 'frame evaluation failed')
  return response?.result?.value
}

/** Where the frame's content box sits inside its own parent, in CSS px. */
export async function frameOwnerOrigin(tabId, frameId) {
  await send(tabId, 'DOM.enable').catch(() => undefined)
  const owner = await send(tabId, 'DOM.getFrameOwner', { frameId })
  const model = await send(tabId, 'DOM.getBoxModel', { backendNodeId: owner?.backendNodeId })
  const quad = model?.model?.content ?? model?.model?.border ?? []
  if (quad.length < 8) throw fail('FRAME_NOT_FOUND', 'could not measure the frame element')
  return { x: quad[0], y: quad[1] }
}

export async function contextForFrame(tabId, frameId) {
  const world = await send(tabId, 'Page.createIsolatedWorld', {
    frameId,
    worldName: `dsh-bridge-ctx-${frameId.slice(0, 8)}`,
  })
  return world.executionContextId
}

/** Frame ids from the root document down to the given frame. */
export async function frameChain(tabId, frameId) {
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
export async function frameOrigin(tabId, frameId) {
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

/** Create the guarded isolated world a model expression runs in. */
export async function guardedContext(tabId, frameId) {
  let target = frameId
  if (!target) {
    let tree
    try {
      tree = await send(tabId, 'Page.getFrameTree')
    } catch (error) {
      throw fail('TAB_NOT_EVALUABLE', 'TAB_NOT_EVALUABLE: tab ' + tabId + ' has no reachable frame (' + String(error?.message ?? error).slice(0, 200) + '); ' + evalRecovery(tabId, undefined))
    }
    target = tree?.frameTree?.frame?.id
  }
  if (!target) {
    throw fail('TAB_NOT_EVALUABLE', 'TAB_NOT_EVALUABLE: tab ' + tabId + ' has no top frame to evaluate in; ' + evalRecovery(tabId, undefined))
  }
  // Creating the world is not enough: the read-only guard is what makes this
  // world safe, and installing it can fail (a context destroyed by a
  // navigation, an unresponsive renderer). Ignoring that exception used to run
  // the caller's expression unguarded, and a dead context surfaced later as an
  // empty result. Retry once with a fresh world, then fail by name.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const world = await send(tabId, 'Page.createIsolatedWorld', {
      frameId: target,
      worldName: 'dsh-bridge-readonly',
    })
    const contextId = world?.executionContextId
    if (typeof contextId !== 'number') continue
    const installed = await send(tabId, 'Runtime.evaluate', {
      expression: READ_ONLY_PRELUDE,
      contextId,
      returnByValue: true,
    })
    if (!installed?.exceptionDetails) return contextId
  }
  throw fail('TAB_NOT_EVALUABLE', 'TAB_NOT_EVALUABLE: the read-only evaluation world could not be installed on tab ' + tabId + '; ' + evalRecovery(tabId, undefined))
}

/**
 * The way out of a tab that refused evaluation, naming the tab.
 *
 * A background tab, a paused page and a detached debugger all look the same to
 * a caller that only gets "it failed": the recovery step differs, so say both
 * routes by name (bsb_tabs use, forceActive).
 */
export function evalRecovery(tabId, hidden) {
  const use = 'bsb_tabs {action:"use", tabId:' + tabId + '}'
  const force = 'forceActive:true (or bsb_act action:"forceActive" mode:"hold" for a session)'
  return hidden === true
    ? 'tab ' + tabId + ' is hidden, so its page may be paused: bring it forward with ' + use + ' or pass ' + force + ', then retry'
    : 're-attach the target with ' + use + ', or pass ' + force + ', then retry'
}

/**
 * Turn "the expression did not run on this tab" into a typed failure.
 *
 * TAB_NOT_VISIBLE when the tab is hidden and therefore may be paused,
 * TAB_NOT_EVALUABLE otherwise. Both name the tab, the original CDP reason and
 * the two recovery routes, instead of collapsing into an empty result that is
 * indistinguishable from a page with no data (BSB-20261115-2215).
 */
export async function evalUnavailable(tabId, detail) {
  const message = String(detail ?? 'evaluation failed').slice(0, 300)
  const view = await readVisibility(tabId).catch(() => null)
  const hidden = view ? view.visibility !== 'visible' : undefined
  const code = hidden === true ? 'TAB_NOT_VISIBLE' : 'TAB_NOT_EVALUABLE'
  const tab = await chrome.tabs.get(tabId).catch(() => undefined)
  const where = 'tab ' + tabId + (tab?.url ? ' (' + String(tab.url) + ')' : '')
  return fail(code, code + ': could not evaluate on ' + where + ': ' + message + '. ' + evalRecovery(tabId, hidden))
}

/** Evaluate a value expression, or a statement list when the expression does not parse. */
export async function evaluateProgram(tabId, expression, { contextId, awaitPromise = false } = {}) {
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
      // Runtime.evaluate always answers with a RemoteObject. No result means the
      // evaluation never ran (a destroyed isolated-world context, a detached
      // target); returning undefined here used to collapse "could not evaluate"
      // into the same shape as a legitimate undefined value.
      if (!remote || typeof remote.type !== 'string') {
        throw fail('TAB_NOT_EVALUABLE', 'TAB_NOT_EVALUABLE: tab ' + tabId + ' returned no evaluation result (the target may have navigated or detached). Re-adopt it with bsb_tabs {action:"use", tabId:' + tabId + '}, or pass forceActive:true, then retry.')
      }
      const value = remote.value
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
 * What the page reports about its own visibility and window box. Read-only: a
 * minimized window is reported here, never restored by this plugin.
 */
export const readVisibility = (tabId) => evaluate(
  tabId,
  '({ visibility: document.visibilityState, hidden: document.hidden === true, outer: { width: outerWidth || 0, height: outerHeight || 0 } })',
).catch(() => null)

/** CDP call that survives a dropped debugger session (a reload detaches it). */
export async function send(tabId, method, params = {}) {
  try {
    return await rawSend(tabId, method, params)
  } catch (error) {
    if (!/not attached|no tab with given id|detached/i.test(String(error?.message ?? error))) throw error
    await attach(tabId)
    return rawSend(tabId, method, params)
  }
}
