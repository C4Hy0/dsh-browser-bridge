// Browser Bridge worker: lib/util.js.
// Keep the module boundaries in docs/SPEC.md in sync.
import { KEY_TEXT_PREFIX_CHARS } from './constants.js'
import { shared } from './state.js'

/** The tab a click opened, if it opened one after `since`. */
export function recentCreatedTab(tabId, since) {
  const hit = shared.createdTabs.get(tabId)
  if (!hit || hit.at < since) return null
  return hit
}

export const recentDialog = (tabId, since = 0) => {
  const dialog = shared.dialogs.get(tabId)
  if (!dialog || dialog.at < since) return undefined
  return Date.now() - dialog.at < 15000 ? dialog.message : undefined
}

export const fail = (code, message) => Object.assign(new Error(message), { code })

/** The attributes of a `DOM.describeNode` node as a plain map (CDP sends name/value pairs). */
export function nodeAttrs(node) {
  const attrs = {}
  const list = node?.attributes ?? []
  for (let i = 0; i + 1 < list.length; i += 2) attrs[list[i]] = list[i + 1]
  return attrs
}

/** True when a `DOM.describeNode` node is an `<input type="file">`. */
export function isFileInputNode(node) {
  return node?.nodeName === 'INPUT' && String(nodeAttrs(node).type ?? '').toLowerCase() === 'file'
}

/** The subset of `pageState` a read reply carries, so its state block stays small. */
export function stateSummary(state) {
  return {
    readyState: state.readyState,
    httpStatus: Number(state.httpStatus) || 0,
    bodyTextLen: Number(state.bodyTextLen) || 0,
    elementCount: Number(state.elementCount) || 0,
    interactiveCount: Number(state.interactiveCount) || 0,
    canvasCount: Number(state.canvasCount) || 0,
    visibility: state.visibility,
    hidden: state.hidden,
    hasSplash: state.hasSplash,
    splashHeight: Number(state.splashHeight) || 0,
  }
}

/**
 * Whether a `pageState` sample describes a healthy, committed document.
 *
 * A cached navigation outcome names the last navigation this worker drove; it
 * does not describe the document that is in the tab now. Before a failure is
 * reported, the current document has to be able to contradict it: Chrome's
 * error document, a 4xx/5xx status, or a page that has not finished parsing.
 * A complete 2xx/3xx document is healthy even when its URL is not the one that
 * was requested (a redirect target, or a tab that recovered to another page).
 */
export function documentIsHealthy(state, requestedUrl) {
  if (!state || typeof state !== 'object') return false
  const documentUrl = String(state.url ?? '')
  if (state.failedDocument === true || /^chrome-error:/i.test(documentUrl)) return false
  if (String(state.readyState ?? '') !== 'complete') return false
  const status = Number(state.httpStatus) || 0
  if (status < 200 || status >= 400) return false
  const asked = String(requestedUrl ?? '')
  if (!asked || asked === documentUrl) return true
  // A different URL is still a normal page when it painted real content; a tab
  // that never committed the requested document is what the failure hint is
  // for, and only the reply's own state block can tell the two apart.
  return (Number(state.bodyTextLen) || 0) > 0
}

/** Whether the CURRENT document (not a cached outcome) looks like a failed one. */
export function documentIsFailed(state) {
  if (!state || typeof state !== 'object') return false
  if (state.failedDocument === true) return true
  if (/^chrome-error:/i.test(String(state.url ?? ''))) return true
  return Number(state.httpStatus) >= 400
}

export const pngSize = (base64) => {
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
export const cropPng = async (base64, sx, sy, sw, sh, outScale, mime = 'image/png') => {
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

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Pages Chrome's debugger refuses to script: chrome://, edge://, devtools://,
 * about: and view-source. `chrome-error://` is deliberately absent, because a
 * committed error document can be read and reported.
 */
export const isInternalUrl = (url) => /^(chrome|edge|brave|devtools|about|view-source):/i.test(String(url ?? ''))

export const resolveTarget = (target, tabId) => {
  if (typeof target !== 'string' || target.length === 0) throw fail('BAD_ARGUMENT', 'target is required')
  if (!target.startsWith('@')) return target
  // Refs belong to the read that produced them, and a second agent reading its
  // own tab must not overwrite @eN for everyone else. Key the table by tab.
  const table = tabId === undefined ? undefined : shared.refs.get(tabId)
  const selector = table
    ? table.get(target)
    : [...shared.refs.values()].map((refs) => refs.get(target)).find(Boolean)
  if (!selector) throw fail('TARGET_NOT_FOUND', `${target} is no longer valid; call bsb_read again`)
  return selector
}

export const KEY_MAP = {
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
  // A bare modifier name is a real key as well as a chord member: `key:"Control"`
  // taps Control, and `keys:["Control","Alt","Digit1"]` is the Ctrl+Alt+1 chord
  // every formatting shortcut uses. Refusing the bare names forced the caller to
  // spell ControlLeft and to guess which spelling a chord accepted.
  Shift: { key: 'Shift', code: 'ShiftLeft', vk: 16 },
  Control: { key: 'Control', code: 'ControlLeft', vk: 17 },
  Alt: { key: 'Alt', code: 'AltLeft', vk: 18 },
  Meta: { key: 'Meta', code: 'MetaLeft', vk: 91 },
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
export const CODE_VK = {
  Shift: 16, Control: 17, Alt: 18, Meta: 91, CapsLock: 20,
  Backquote: 192, Minus: 189, Equal: 187, BracketLeft: 219, BracketRight: 221,
  Backslash: 220, Semicolon: 186, Quote: 222, Comma: 188, Period: 190, Slash: 191,
  Insert: 45, ContextMenu: 93, PrintScreen: 44, ScrollLock: 145, Pause: 19,
  NumLock: 144, NumpadAdd: 107, NumpadSubtract: 109, NumpadMultiply: 106,
  NumpadDivide: 111, NumpadDecimal: 110, NumpadEnter: 13,
}

export const MODIFIER_CODES = { ShiftLeft: 'Shift', ShiftRight: 'Shift', ControlLeft: 'Control', ControlRight: 'Control', AltLeft: 'Alt', AltRight: 'Alt', MetaLeft: 'Meta', MetaRight: 'Meta' }

export const PUNCT_KEYS = {
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
}

export const CODE_NAME = /^(Key[A-Z]|Digit[0-9]|Numpad[0-9]|F([1-9]|1[0-2])|(Shift|Control|Alt|Meta)(Left|Right)|CapsLock|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Insert|ContextMenu|PrintScreen|ScrollLock|Pause|NumLock|NumpadAdd|NumpadSubtract|NumpadMultiply|NumpadDivide|NumpadDecimal|NumpadEnter)$/

export const specForCode = (code) => {
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

export const keySpec = (raw) => {
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

/**
 * The CDP modifier bit each modifier key stands for (Alt=1, Ctrl=2, Meta=4,
 * Shift=8). A spec's `key` is the logical name, so ControlLeft and Control both
 * resolve to "Control" and both set the same bit.
 */
export const MODIFIER_KEY_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }

export const modifierBitOf = (spec) => MODIFIER_KEY_BITS[spec?.key] ?? 0

/**
 * Order a key list as a real chord and give every event its modifier mask.
 *
 * `keys:["ControlLeft","AltLeft","Digit1"]` used to send three ordinary keys with
 * `modifiers: 0`, so the page saw a bare "1": the shortcut never fired and the
 * reply still said `applied:true`. A modifier in the list now presses first, its
 * own bit is set on its own event, and the main key carries the whole mask. The
 * explicit `modifiers` parameter is OR-ed in, so both spellings agree.
 */
export function chordPlan(specs, baseMask = 0) {
  let chordMask = baseMask
  for (const spec of specs) chordMask |= modifierBitOf(spec)
  let running = baseMask
  const plan = []
  for (const spec of specs) {
    const bit = modifierBitOf(spec)
    const heldBefore = running
    if (bit) running |= bit
    plan.push({
      spec,
      // The key down carries every modifier held at that instant; a modifier's
      // key up carries only the modifiers still held when it is released last,
      // like a real keyboard does.
      mask: bit ? running : chordMask,
      upMask: bit ? heldBefore : chordMask,
    })
  }
  // Stable sort: modifiers go down before the key they modify.
  plan.sort((a, b) => (modifierBitOf(b.spec) ? 1 : 0) - (modifierBitOf(a.spec) ? 1 : 0))
  return { plan, mask: chordMask }
}

/** Name the page in a refusal, so the caller knows which tab it was. */
export function describePage(meta) {
  const title = String(meta?.title ?? '').trim().slice(0, 120)
  const url = String(meta?.url ?? '').trim()
  if (title && url) return `"${title}" (${url})`
  return url || (title ? `"${title}"` : 'the tracked page')
}

/** Success fields every applied input action now carries. */
export const inputSuccess = (visibility, forced) => ({
  applied: true,
  visibility,
  hidden: visibility === 'hidden',
  ...(forced ? { forced: { ...forced, cleared: true } } : {}),
})

/** The whitespace-collapsed prefix a key text run must leave in the editor. */
export const keyTextPrefix = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, KEY_TEXT_PREFIX_CHARS)

/**
 * Tile a burst of PNGs into one labelled contact sheet.
 *
 * Watching motion is the agent's eyes, not a DOM hint: a highlight that lasts
 * 350 ms cannot be caught by one screenshot per tool call, so the strip keeps
 * the whole motion in a single image the model can read.
 */
export const composeFilmstrip = async (shots, columns, mime = 'image/png', options = {}) => {
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
export const frameSignature = async (data, mime = 'image/png') => {
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
export const signatureDistance = (a, b) => {
  let worst = 0
  for (let index = 0; index < a.length; index += 1) {
    const delta = Math.abs(a[index] - b[index])
    if (delta > worst) worst = delta
  }
  return worst
}

/** Integer parameter with a fallback, clamped into range. */
export const clampInt = (value, min, max, fallback) => {
  const number = Math.trunc(Number(value))
  if (!Number.isFinite(number)) return fallback
  return Math.min(Math.max(number, min), max)
}

/** Mean colour and bright share of a whole encoded image, for grid triage. */
export const imageStats = async (data, mime = 'image/png') => {
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
export const frameSize = async (data, mime) => {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }))
  const size = { width: bitmap.width, height: bitmap.height }
  bitmap.close()
  return size
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
export async function preprocessPng(base64, ops) {
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
