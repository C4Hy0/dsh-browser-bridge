// Browser Bridge worker: shared mutable state.
// One object, because an ES module let cannot be reassigned across modules.
import { HELD_KEY } from './constants.js'

export const shared = {
  attached: new Set(),
  looping: false,
  backoff: 0,
  refs: new Map(),
  detachTimer: undefined,
  dialogs: new Map(),
  tabOwners: new Map(),
  injectedScripts: new Map(),
  netCaptures: new Map(),
  consoleCaptures: new Map(),
  createdTabs: new Map(),
  navOutcomes: new Map(),
  heldForced: new Set(),
  recorder: null,
  lastRecording: null,
  screencast: null,
  metricsTabs: new Set(),
  lastRestore: null,
  lastCarPose: new Map(),
}

export const heldReady = (async () => {
  try {
    const stored = await chrome.storage.session.get(HELD_KEY)
    const list = stored?.[HELD_KEY]
    if (Array.isArray(list)) for (const id of list) if (Number.isFinite(id)) shared.heldForced.add(id)
  } catch {}
})()
