// Browser Bridge worker: commands/observe.js.
// Keep the module boundaries in docs/SPEC.md in sync.
import { requirePage } from './tabs.js'
import { evaluateProgram, frameList, guardedContext, pageMeta, rawSend, resolveFrameArg, send } from '../lib/cdp.js'
import { NET_BODY_CHARS, NET_HEADER_CHARS, NET_HEADER_MAX } from '../lib/constants.js'
import { shared } from '../lib/state.js'
import { fail } from '../lib/util.js'

export const netCapture = (tabId) => shared.netCaptures.get(tabId)

/** CDP headers are plain objects (or name/value arrays in some events); keep a bounded copy. */
export function netHeaders(headers) {
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

export function netOnRequest(tabId, params) {
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

export function netOnResponse(tabId, params) {
  const capture = netCapture(tabId)
  const entry = capture?.entries.get(params?.requestId)
  if (!entry) return
  entry.status = params?.response?.status ?? null
  entry.mime = String(params?.response?.mimeType || '')
  entry.responseHeaders = netHeaders(params?.response?.headers)
  const disposition = (params?.response?.headers || {})['content-disposition']
    || (params?.response?.headers || {})['Content-Disposition'] || ''
  // A download is a normal outcome. Chrome reports the navigation as aborted
  // because the body never became a document, which reads as a failure in the
  // network log and in bsb_open.
  if (/attachment/i.test(String(disposition))) entry.download = true
  if (/^(application\/octet-stream|application\/pdf|application\/zip|binary\/octet-stream)$/i.test(entry.mime) && String(params?.type || '') === 'Document') {
    entry.download = true
  }
}

export async function netOnFinished(tabId, params) {
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

export function consoleCapture(tabId) {
  let capture = shared.consoleCaptures.get(tabId)
  if (!capture) {
    capture = { active: false, limit: 100, entries: [] }
    shared.consoleCaptures.set(tabId, capture)
  }
  return capture
}

export function consolePush(tabId, entry) {
  const capture = consoleCapture(tabId)
  if (!capture.active) return
  capture.entries.push(entry)
  if (capture.entries.length > capture.limit) capture.entries.splice(0, capture.entries.length - capture.limit)
}

/** RemoteObjects are not JSON-serialisable; keep a readable one-liner. */
export function consoleArg(arg) {
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
export async function timelinePage({ selector, durationMs, intervalMs, grid, raf, frame } = {}) {
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
    let el = null
    try { el = document.querySelector(SEL) } catch (error) {
      return { error: 'invalid selector: ' + String((error && error.message) || error), badSelector: true }
    }
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
    return { selector: SEL, samples, samplesCollected: samples.length, observedMs: Math.round(elapsed), fps: Math.round((rafs / elapsed) * 10000) / 10, elapsed: Math.round(elapsed) }
  })()`
  const value = await evaluateProgram(tabId, program, { contextId, awaitPromise: true })
  if (!value || value.error) {
    if (value?.badSelector) throw fail('BAD_SELECTOR', String(value.error))
    throw fail('NO_MATCH', String(value?.error || 'timeline returned nothing'))
  }
  return value
}

export async function networkPage({ action, limit, filter, detail, fields, tabId: hint }) {
  const tabId = await requirePage(hint)
  const mode = String(action || 'log')
  if (mode === 'start') {
    const cap = Math.min(Math.max(Number(limit) || 100, 1), 500)
    shared.netCaptures.set(tabId, { limit: cap, entries: new Map(), order: [] })
    await send(tabId, 'Network.enable', { maxTotalBufferSize: 50000000, maxResourceBufferSize: 10000000 })
    return { started: true, tabId, limit: cap, url: (await pageMeta(tabId))?.url ?? '' }
  }
  if (mode === 'stop') {
    const capture = shared.netCaptures.get(tabId)
    shared.netCaptures.delete(tabId)
    await send(tabId, 'Network.disable').catch(() => undefined)
    return { stopped: true, tabId, captured: capture ? capture.order.length : 0 }
  }
  if (mode !== 'log') throw fail('BAD_ARGUMENT', 'action must be start, log or stop')
  const capture = shared.netCaptures.get(tabId)
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
    for (const key of ['at', 'method', 'url', 'type', 'status', 'mime', 'error', 'download', 'note']) {
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
export async function consolePage({ action, limit, tabId: hint }) {
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
