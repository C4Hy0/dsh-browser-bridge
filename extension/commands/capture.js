// Browser Bridge worker: commands/capture.js.
// Keep the module boundaries in docs/SPEC.md in sync.
import { clickPage } from './input/click.js'
import { requirePage } from './tabs.js'
import { evaluate, evaluateInContext, frameContext, frameOrigin, pageMeta, rawSend, send, windowInfo } from '../lib/cdp.js'
import { deepFindExpr } from '../lib/page.js'
import { pageVisibility } from '../lib/page-state.js'
import { shared } from '../lib/state.js'
import { clampInt, composeFilmstrip, cropPng, delay, fail, frameSignature, frameSize, imageStats, pngSize, preprocessPng, signatureDistance } from '../lib/util.js'

/**
 * Measure the capture target once so a burst can reuse it.
 */
export async function prepareShot({ fullPage, selector, scale, frame, tabId: hint, rect }) {
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
export async function captureShot(prep, { hidden = false } = {}) {
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
 * Mirror the live override list into session storage.
 *
 * An MV3 worker can be recycled between two commands. The override it installed
 * lives in the renderer, not in the worker, so without a persisted list a later
 * worker cannot know which tab is still emulated — the page would keep its
 * emulated size until a reload. The list is tiny and only ever names tabs.
 */
export const rememberMetrics = () => {
  try {
    void Promise.resolve(chrome.storage.session.set({ metricsTabs: [...shared.metricsTabs] })).catch(() => undefined)
  } catch {
    // Session storage is unavailable on very old builds; the in-memory set is
    // still correct for the life of this worker.
  }
}

export const forgetMetrics = (tabId) => {
  if (shared.metricsTabs.delete(tabId)) rememberMetrics()
}

/** Drop one metrics override, tolerating a tab that navigated or closed. */
export const clearMetrics = async (tabId) => {
  forgetMetrics(tabId)
  await rawSend(tabId, 'Emulation.clearDeviceMetricsOverride', {}).catch(() => undefined)
}

export const restoreViewport = async (tabId, realView) => {
  const want = Number(realView?.w) || 0
  const trace = { at: Date.now(), tabId, want, steps: [] }
  shared.lastRestore = trace
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
export const sweepMetrics = async (keepTabId = null) => {
  try {
    const stored = await chrome.storage.session.get('metricsTabs')
    for (const tabId of Array.isArray(stored?.metricsTabs) ? stored.metricsTabs : []) {
      if (Number.isFinite(tabId)) shared.metricsTabs.add(tabId)
    }
  } catch {
    // No persisted list: sweep what this worker knows about.
  }
  for (const tabId of [...shared.metricsTabs]) {
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
export const captureClipFrame = async (prep, { fromSurface = true, quality = 80, beyond = false } = {}) => {
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

/**
 * Crop one screencast frame (a full-viewport image) down to the recorded box.
 */
export const cropToTarget = async (prep, data, mime = 'image/png', outScale = prep.zoom) => {
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
export function screencastFrame(tabId, params) {
  const state = shared.screencast
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
export async function drainRaw(state) {
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

export async function ingestFrame(state, data) {
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
export async function finishRecording(state, columns) {
  clearTimeout(state.timer)
  state.closing = true
  try {
  if (state.rawTimer) { clearTimeout(state.rawTimer); state.rawTimer = null }
  while (state.raw.length > 0) await ingestFrame(state, state.raw.shift())
  if (state.queue) await state.queue
  state.done = true
  while (state.pending) await delay(15)
  if (shared.screencast === state) {
    shared.screencast = null
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
  shared.lastRecording = { at: Date.now(), frames: shots.length, mode: state.mode, spanMs, autoStopped: state.maxMs > 0 }
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
    if (state.metricsSet || shared.metricsTabs.has(state.tabId)) {
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
export async function recordPage(params = {}) {
  if (params.action === 'debug') {
    let stored = null
    try { stored = (await chrome.storage.session.get('metricsTabs'))?.metricsTabs ?? null } catch {}
    let probeTab = shared.recorder?.tabId ?? null
    if (!probeTab) {
      try { probeTab = await requirePage() } catch { probeTab = null }
    }
    return {
      metricsTabs: [...shared.metricsTabs],
      lastRestore: shared.lastRestore,
      stored,
      recorder: shared.recorder ? {
        tabId: shared.recorder.tabId,
        mode: shared.recorder.mode,
        metricsSet: shared.recorder.metricsSet,
        realView: shared.recorder.realView ?? null,
        frames: shared.recorder.shots?.length ?? 0,
        done: shared.recorder.done,
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
    if (!shared.recorder) return { recording: false, done: true, frames: 0, last: shared.lastRecording ?? null }
    return {
      recording: shared.recorder.done !== true,
      done: shared.recorder.done === true,
      armedAt: shared.recorder.startedAt,
      maxMs: shared.recorder.maxMs,
      last: shared.lastRecording ?? null,
      frames: shared.recorder.shots.length,
      skipped: shared.recorder.skipped,
      received: shared.recorder.received,
      mode: shared.recorder.mode,
      maxFrames: shared.recorder.maxFrames,
      maxStrip: shared.recorder.maxStrip,
      // A finished recording must not keep counting: report the window it ran.
      elapsedMs: Math.min(Date.now() - shared.recorder.startedAt, shared.recorder.maxMs > 0 ? shared.recorder.maxMs : Number.MAX_SAFE_INTEGER),
      remainingMs: shared.recorder.maxMs > 0 ? Math.max(0, shared.recorder.maxMs - (Date.now() - shared.recorder.startedAt)) : null,
      next: 'call bsb_capture with action:"stop" when the moment has passed',
      window: await windowInfo(shared.recorder.tabId),
      warning: shared.recorder.warning,
      error: shared.recorder.error,
      done: shared.recorder.done,
    }
  }
  if (action === 'stop') {
    const state = shared.recorder
    if (!state) throw fail('NOT_RECORDING', 'no recording is running')
    shared.recorder = null
    return finishRecording(state, params.columns)
  }
  // A previous recording may have died between "override set" and "override
  // cleared" (worker recycled, reply lost). Clear its override before a new one
  // is installed, so no tab keeps an emulated viewport.
  await sweepMetrics(shared.recorder?.tabId ?? null)
  if (shared.recorder) {
    // A recording that outlived its agent (a stale worker instance, a lost
    // reply) must not lock the tool out forever: force starts a new one.
    if (params.force !== true) throw fail('ALREADY_RECORDING', 'a recording is already running; stop it first')
    const stale = shared.recorder
    shared.recorder = null
    if (shared.screencast === stale) shared.screencast = null
    rawSend(stale.tabId, 'Page.stopScreencast', {}).catch(() => undefined)
    clearTimeout(stale.timer)
    stale.done = true
    stale.closing = true
    if (stale.metricsSet || shared.metricsTabs.has(stale.tabId)) {
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
  shared.recorder = state
  if (mode === 'screencast') {
    shared.screencast = state
    try {
      await send(state.tabId, 'Page.startScreencast', { format: 'jpeg', quality: state.quality, maxWidth: state.maxWidth, maxHeight: state.maxHeight, everyNthFrame: 1 })
    } catch (error) {
      shared.screencast = null
      shared.recorder = null
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
export async function armedRecording(state, params) {
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

export async function screenshotPage({ fullPage, selector, rect, scale, frame, tabId: hint, frames, intervalMs, columns, preprocess }) {
  // Capture the scroll position before prepareShot: cropping an off-screen
  // element scrolls it into view, and the page must be put back exactly where
  // the user had it once the shot exists.
  const tabId = await requirePage(hint)
  // A recycled worker must not leave some other tab emulated: clean up before
  // measuring anything here.
  await sweepMetrics(shared.recorder?.tabId ?? null)
  const origin = await evaluate(tabId, '({ x: Math.round(window.scrollX), y: Math.round(window.scrollY) })').catch(() => null)
  // A hidden tab normally keeps a real layout viewport (innerWidth/innerHeight
  // stay 1912x970 for a minimized window), and that is exactly the case this
  // capture path renders off-screen without activating anything. A genuinely
  // 0x0 layout viewport has no pixels to render, so it fails rather than
  // returning a blank or invented image.
  const layoutView = await evaluate(tabId, '({ width: window.innerWidth, height: window.innerHeight })').catch(() => null)
  if (!layoutView || !(Number(layoutView.width) > 0) || !(Number(layoutView.height) > 0)) {
    throw fail('TAB_NOT_VISIBLE', 'capture needs a laid-out viewport, but the page reports a 0x0 layout (the window is minimized or not laid out). Restore the window and retry. A hidden tab with a normal layout viewport is captured off-screen without activation.')
  }
  const visibility = await pageVisibility(tabId)
  const hidden = visibility === 'hidden'
  const prep = await prepareShot({ fullPage, selector, rect, scale, frame, tabId })
  // A capture never activates a tab or raises a window. A hidden page is shot
  // through captureBeyondViewport instead, which renders it without a compositor
  // frame and without changing what the user sees. `hidden` and `visibility` are
  // reported so a caller can tell a background render from an on-screen one.
  const meta = await pageMeta(prep.tabId)
  try {
  const count = Math.min(Math.max(Math.trunc(Number(frames)) || 1, 1), 24)
  if (count === 1) {
    const raw = await captureShot(prep, { hidden })
    const png = await preprocessPng(raw, preprocess)
    const size = pngSize(png)
    const scale = prep.target && prep.target.width > 0 ? size.width / prep.target.width : undefined
    return { url: meta?.url ?? '', title: meta?.title ?? '', width: size.width, height: size.height, scale, pngBase64: png, frameId: prep.frameId, preprocessed: png !== raw || undefined, hidden, visibility }
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
    hidden,
    visibility,
  }
  } finally {
    if (origin) {
      await evaluate(prep.tabId, '(() => { window.scrollTo(' + origin.x + ', ' + origin.y + '); })()').catch(() => undefined)
    }
  }
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
export async function sheetPage({ selector, offset, limit, scale, columns, tabId: hint }) {
  const tabId = await requirePage(hint)
  await sweepMetrics(shared.recorder?.tabId ?? null)
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
  // Every tile must be painted, including matches below the fold. One full-page
  // capture (captureBeyondViewport) covers the whole document, so each tile is a
  // crop from it: one screenshot instead of one per tile, which kept the call
  // inside the tool timeout on a long page.
  const scroll = await evaluate(tabId, '({ x: scrollX, y: scrollY })').catch(() => ({ x: 0, y: 0 }))
  const view = await evaluate(tabId, '({ w: innerWidth, h: innerHeight })').catch(() => ({ w: 0, h: 0 }))
  let pageShot = null
  let pageRatio = 1
  try {
    // captureBeyondViewport only reaches past the fold when a clip is given, so
    // ask for the whole document explicitly. A very tall page is left to the
    // per-tile fallback, because Chrome caps a single capture.
    const pageSize = await evaluate(tabId, '({ w: innerWidth, h: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) })').catch(() => null)
    if (pageSize && pageSize.w > 0 && pageSize.h > 0 && pageSize.h <= 16000) {
      const full = await send(tabId, 'Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: pageSize.w, height: pageSize.h, scale: 1 },
      })
      if (full?.data) {
        const dims = pngSize(full.data)
        pageShot = full.data
        pageRatio = dims.width > 0 ? dims.width / pageSize.w : 1
      }
    }
  } catch {}
  const shots = []
  const tiles = []
  let blank = 0
  for (let index = 0; index < list.length; index += 1) {
    const box = list[index]
    let data = null
    if (pageShot) {
      const pageX = (box.x + (scroll?.x ?? 0)) * pageRatio
      const pageY = (box.y + (scroll?.y ?? 0)) * pageRatio
      try {
        data = await cropPng(pageShot, pageX, pageY, box.width * pageRatio, box.height * pageRatio, zoom)
      } catch { data = null }
    }
    if (!data) {
      // Fallback for a page too tall to capture in one shot. Use the page
      // coordinates collected up front instead of re-querying by index: the DOM
      // can change between collection and capture, and a shifted index produced
      // 1x1 tiles from whatever element landed there.
      const pageX = box.x + (scroll?.x ?? 0)
      const pageY = box.y + (scroll?.y ?? 0)
      await evaluate(tabId, `window.scrollTo(${pageX} - innerWidth / 2, ${pageY} - innerHeight / 2)`).catch(() => null)
      await delay(160)
      const nowScroll = await evaluate(tabId, '({ x: scrollX, y: scrollY })').catch(() => ({ x: 0, y: 0 }))
      const full2 = await send(tabId, 'Page.captureScreenshot', { format: 'png' })
      if (full2?.data) {
        const dims2 = pngSize(full2.data)
        const ratio2 = view && view.w > 0 && dims2.width > 0 ? dims2.width / view.w : 1
        const vx = pageX - (nowScroll?.x ?? 0)
        const vy = pageY - (nowScroll?.y ?? 0)
        try {
          data = await cropPng(full2.data, vx * ratio2, vy * ratio2, box.width * ratio2, box.height * ratio2, zoom)
        } catch { data = null }
      }
    }
    if (!data) { blank += 1; continue }
    shots.push({ data })
    tiles.push(await imageStats(data, 'image/png'))
  }
  if (shots.length === 0) throw fail('NO_FRAME', 'no match could be captured')
  const cols = Math.min(Math.max(Number(columns) || Math.ceil(Math.sqrt(shots.length)), 1), 20)
  const png = await composeFilmstrip(shots.map((shot) => shot.data), cols, "image/png", { maxTiles: 144 })
  const size = await frameSize(shots[0].data, "image/png")
  return {
    url: (await pageMeta(tabId))?.url ?? '',
    selector: sel,
    offset: skip,
    count: shots.length,
    blank: blank > 0 ? blank : undefined,
    columns: cols,
    tileWidth: size?.width ?? 0,
    tileHeight: size?.height ?? 0,
    tiles: tiles.map((stat, index) => ({ i: index + 1 + skip, ...stat })),
    pngBase64: png?.data ?? png,
  }
}

/** Mean colour of every cell of an element, so a caller can reason about a picture
 *  (brightness, hue, saturation) without ever decoding it by hand. Read-only. */
export async function pixelsPage({ selector, grid, scale, points: wanted, radius, tabId: hint }) {
  const tabId = await requirePage(hint)
  await sweepMetrics(shared.recorder?.tabId ?? null)
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
  const inViewport = (b) => Boolean(b) && b.width > 0 && b.height > 0
    && b.x + b.width > 0 && b.y + b.height > 0 && b.x < (view?.w ?? 0) && b.y < (view?.h ?? 0)
  if (!inViewport(box)) {
    // A screenshot of a region that is not painted comes back black, which is
    // indistinguishable from a genuinely black element. Scroll it in first.
    await evaluate(tabId, `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (el) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); return true })()`).catch(() => null)
    await delay(180)
    const again = await evaluate(tabId, `(() => {
      const el = document.querySelector(${JSON.stringify(sel)})
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    })()`)
    if (again) { box.x = again.x; box.y = again.y; box.width = again.width; box.height = again.height }
    if (!inViewport(box)) {
      return {
        url: (await pageMeta(tabId))?.url ?? '',
        selector: sel,
        inViewport: false,
        painted: false,
        hint: 'the element is outside the viewport and stayed there after scrolling, so its pixels were not painted; scroll the region yourself with bsb_act scroll or capture it with bsb_capture',
      }
    }
  }
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

/** Native image data for one element (img/canvas), so text is read at its real resolution. */
/**
 * Fetch image bytes from the extension's own context.
 *
 * CORS-exempt for any origin the manifest grants host permission to, which
 * covers the public-image case the page-context fetch cannot reach.
 */
export async function fetchBytesDirect(url) {
  const res = await fetch(url, { cache: 'force-cache' })
  if (!res.ok) throw fail('FETCH_FAILED', 'HTTP ' + res.status)
  const buf = new Uint8Array(await res.arrayBuffer())
  let bin = ''
  for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 8192))
  return { mime: res.headers.get('content-type') || '', base64: btoa(bin) }
}

export async function imageSource({ selector }) {
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
