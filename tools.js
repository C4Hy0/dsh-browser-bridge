/**
 * The agent-facing tools.
 *
 * Registration is raw (`ctx.tools.register`), so every `parameters` value is a
 * complete JSON Schema with a root `type: 'object'` — a shorthand object would
 * reach strict providers without a root type and be rejected. Browser actions
 * are deliberately not concurrency-safe: each browser has one stateful tab.
 *
 * @module browser-bridge/tools
 */

import { dirname } from 'node:path'

/** Replace unpaired surrogates so a string can round-trip through JSON. */
const lossless = (value) => String(value).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')


const MAX_CHARS = 30000
const MAX_ELEMENTS = 200
const TIMEOUT_MS = 45000

const input = (properties, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})

const textBlock = (text) => ({ type: 'text', text })

const jsonRender = (value) => [textBlock(JSON.stringify(value, null, 2))]

const clampInt = (value, fallback, min, max) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value), min), max) : fallback

/**
 * Read a string argument, tolerating a number.
 *
 * Browser ids are hex — `46365621028d` — so a bare token looks numeric and gets
 * emitted unquoted, which is invalid JSON before this code ever runs. Accepting
 * a number does not repair that parse, but it keeps a caller that guessed
 * `463656` (a value JSON can carry) working instead of being told the browser
 * does not exist.
 */
const stringArg = (args, key) => {
  const value = args?.[key]
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

const browserProperty = {
  type: 'string',
  description:
    'Which connected browser to act on: an id, an id prefix, or part of its label. Defaults to the browser that was active most recently. Use bsb_browsers to list them. '
    + 'Ids are hex strings and MUST be quoted — "browser": "46365621028d", never browser: 46365621028d, which is not valid JSON.',
}

/** Compact one-line header view bounded so a captured request cannot flood the context. */
const formatHeaders = (headers, max) => {
  if (!headers || typeof headers !== 'object') return ''
  return Object.entries(headers)
    .slice(0, max)
    .map(([name, value]) => `${name}: ${String(value).slice(0, 120)}`)
    .join(' | ')
}

const browserOutput = {
  type: 'object',
  properties: {
    url: { type: 'string' },
    title: { type: 'string' },
  },
  required: ['url', 'title'],
}

/** Render a read result for the model: text first, then the element list. */
function renderRead(_args, value) {
  const elements = Array.isArray(value?.elements) ? value.elements : []
  const box = (el) => (typeof el.x === 'number' ? ` @ (${Math.round(el.x)},${Math.round(el.y)} ${Math.round(el.width)}×${Math.round(el.height)})` : '')
  const vp = value?.viewport
  const viewportLine = vp
    ? `viewport: ${vp.width}×${vp.height} css @ ${vp.dpr}x (scroll ${vp.scrollX},${vp.scrollY})`
    : undefined
  const lines = [
    `url: ${value?.url ?? ''}`,
    `title: ${value?.title ?? ''}`,
    ...(viewportLine ? [viewportLine] : []),
    ...(value?.dialog ? [`dialog (auto-dismissed): ${JSON.stringify(value.dialog)}`] : []),
    value?.truncated ? 'text: (truncated)' : 'text:',
    String(value?.text ?? '').trim(),
    '',
    `elements (${elements.length}):`,
    ...elements.map((el) => `${el.ref} ${el.role}${el.shadow ? ' (shadow)' : ''} ${JSON.stringify(el.name ?? '')}${box(el)} → ${el.selector}`),
    ...(Array.isArray(value?.probes) && value.probes.length > 0
      ? [
          `probes (${value.probes.filter((probe) => probe.found).length}/${value.probes.length} found):`,
          ...value.probes.map((probe) => probe.found
            ? `${probe.role} ${probe.selector} @ (${Math.round(probe.box?.x ?? 0)},${Math.round(probe.box?.y ?? 0)} ${Math.round(probe.box?.width ?? 0)}×${Math.round(probe.box?.height ?? 0)})`
            : `(missing) ${probe.selector}`),
        ]
      : []),
  ]
  return [textBlock(lines.join('\n'))]
}

// Every capture is written to disk; the rendered text must carry the paths so the
// next call can read them with read_image (the store ref alone is not enough).
function fileListing(value, header) {
  const files = Array.isArray(value?.files) ? value.files.filter((p) => typeof p === 'string' && p) : []
  return textBlock(files.length ? header + '\nfiles (open with read_image):\n' + files.map((p) => '- ' + p).join('\n') : header)
}

/**
 * Turn the worker's bare NO_FRAMES failure into a reason and a way out.
 *
 * Screencast only receives paints while the tab is visible in its window: a
 * hidden tab yields exactly zero frames and no error of its own, so the only
 * signal was "the recording captured no frames" — which reads like a broken
 * tool rather than a backgrounded page.
 */
function explainRecordFailure(error, action, mode) {
  const message = String(error?.message ?? error)
  if (!/captured no frames/i.test(message)) return error
  const hint = mode === 'screencast'
    ? 'screencast only receives frames while the tab is visible in its window — make it the active tab with bsb_tabs action:"use", or record with mode:"shots" / "interval"'
    : `nothing arrived before action:"${action}" — arm with maxMs, act, then stop while the recording is still running`
  return new Error(`${message} — ${hint}`)
}

function renderCapture(_args, value) {
  const frames = typeof value?.frames === 'number' ? value.frames : 0
  const armed = value?.armed === true
  const isRecord = value?.mode !== undefined || frames > 1
  const scaleNote = typeof value?.scale === 'number' && Number.isFinite(value.scale)
    ? ` @${Number(value.scale.toFixed(3))}x`
    : ''
  const size = value?.width && value?.height ? ` ${value.width}x${value.height}${scaleNote}` : ''
  if (armed) {
    // An armed recording legitimately has zero frames. Saying just "0 frames"
    // reads as a failure, so state the mode, the cadence and the next step.
    const every = typeof value?.intervalMs === 'number' ? ` · every ~${value.intervalMs}ms` : ''
    const cap = typeof value?.maxFrames === 'number' ? ` · max ${value.maxFrames} frames` : ''
    const bound = typeof value?.maxMs === 'number' ? ` · auto-stops at ${value.maxMs}ms` : ''
    // The click taken at arm time used to be invisible in the reply, so the
    // caller could not tell "it pressed the button" from "waiting for me".
    const pressed = typeof value?.clickedText === 'string' && value.clickedText ? `\npressed ${value.clickedText}` : ''
    const missed = typeof value?.clickError === 'string' && value.clickError ? `\nwarning: the click at arm time failed: ${value.clickError}` : ''
    const next = pressed
      ? 'the recording is running — call action:"stop" when the moment is over'
      : (value?.next ?? 'act, then call action:"stop"')
    const header = `capture(record) armed · mode ${value?.mode ?? 'shots'}${every}${cap}${bound}${pressed}${missed}
${next}`
    return [fileListing(value, header)]
  }
  if (isRecord) {
    const span = value?.spanMs > 0 ? ` over ${value.spanMs}ms` : ''
    const cadence = typeof value?.actualIntervalMs === 'number' ? ` (~${value.actualIntervalMs}ms/frame)` : ''
    const dropped = value?.skipped > 0 ? `, ${value.skipped} unchanged dropped` : ''
    const grid = value?.sheetColumns ? ` · sheet ${value.sheetColumns}x${value.sheetRows}` : ''
    const clicked = value?.clickedText ? ` · pressed ${value.clickedText}` : ''
    let header = `capture(record) ${value?.url ?? ''}${size} · ${frames} frames${span}${cadence}${dropped}${grid}${clicked}`
    // The commonest surprise: an element capture costs far more than the
    // requested interval, so the recording silently under-samples.
    if (typeof value?.intervalMs === 'number' && typeof value?.actualIntervalMs === 'number' && value.actualIntervalMs > value.intervalMs * 3) {
      header += `
note: asked for ~${value.intervalMs}ms but frames landed ${value.actualIntervalMs}ms apart — capture is slower than the interval; raise intervalMs or record a smaller region`
    }
    if (value?.autoStopped) header += '\nnote: the recording stopped itself at maxMs'
    if (value?.error) header += `\nwarning: capture error: ${value.error}`
    if (Array.isArray(value?.frameTimes) && value.frameTimes.length > 0 && value.frameTimes.length <= 12) {
      header += `\nframes at ms: ${value.frameTimes.join(', ')}`
    }
    return [fileListing(value, header)]
  }
  const header = `capture ${value?.url ?? ''}${size} · ${frames || 1} frame(s)`
  return [fileListing(value, header)]
}

function renderSheet(_args, value) {
  const tiles = Array.isArray(value?.tiles) ? value.tiles.length : 0
  const header = `sheet ${value?.url ?? ''} · selector ${JSON.stringify(value?.selector ?? '')} · ${tiles} tiles · ${value?.tileWidth ?? '?'}x${value?.tileHeight ?? '?'} each`
  return [fileListing(value, header)]
}

function renderBrowsers(_args, value) {
  const rows = (value?.browsers ?? []).map((entry) => {
    const mark = entry.active ? '*' : ' '
    const state = entry.connected ? 'connected' : 'not polling'
    const version = entry.version ? `, extension ${entry.version}` : ''
    return `${mark} ${entry.id}  ${entry.label || '(unnamed)'}  — ${state}${version}, last poll ${entry.lastSeenSec}s ago`
  })
  return [textBlock(['(* = default target)', ...rows].join('\n'))]
}

/**
 * Register the tools on `ctx`.
 *
 * @param ctx - needs `tools`.
 * @param bridge - transport shared by every tool.
 */
export function registerTools(ctx, bridge) {
  // The worker answers "No page is open; call bsb_open first" whenever nothing is
  // tracked — even when tabs are open and only need adopting. That advice sent an
  // agent hunting for a new page instead of running bsb_tabs action:"use".
  // Wrapping send here (through a proxy, so the live getters survive) gives every
  // tool the same correct recovery path without editing 21 call sites.
  const rawSend = bridge.send.bind(bridge)
  bridge = new Proxy(bridge, {
    get(target, prop) {
      if (prop === 'send') {
        return async (method, params, options) => {
          try {
            return await rawSend(method, params, options)
          } catch (error) {
            if (/no page is open/i.test(String(error?.message ?? error))) {
              throw new Error('No page is tracked — run bsb_tabs action:"list", then action:"use" with a tabId, or bsb_open to open one.')
            }
            throw error
          }
        }
      }
      // Reflect.get with receiver = proxy runs a getter with `this` = proxy, so
      // every `#private` read inside it throws (#browsers did). Read against the
      // target: getters keep their own instance, methods get bound to it.
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const register = (definition) => {
    ctx.effect(() => ctx.tools.register(definition), `browser-bridge: ${definition.name}`)
  }

  register({
    name: 'bsb_browsers',
    description:
      'List the browsers connected to this harness, the default target, and whether each responds. Use first when a tool reports no browser, or before targeting a specific browser. The bsb-browser skill has the full workflow playbook.',
    parameters: input({}),
    output: {
      schema: {
        type: 'object',
        properties: {
          active: { type: 'string' },
          browsers: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                version: { type: 'string' },
                connected: { type: 'boolean' },
                lastSeenSec: { type: 'number' },
                active: { type: 'boolean' },
              },
              required: ['id', 'connected', 'active'],
            },
          },
        },
        required: ['browsers'],
      },
      render: renderBrowsers,
    },
    async execute() {
      return { active: bridge.activeBrowserId ?? '', browsers: bridge.browsers() }
    },
  })



  register({
    name: 'bsb_tabs',
    description:
      'List, adopt, reload, or close tabs. Use when the user says a page is already open, when a command needs a different tab, or to avoid opening a duplicate. action use makes a tab the tracked page; activate:false adopts it in the background.',
    parameters: input({
      action: { type: 'string', enum: ['list', 'use', 'reload', 'close'], description: 'Defaults to list.' },
      tabId: { type: 'number', description: 'Required for action use/close; optional for reload (defaults to the tracked tab).' },
      activate: { type: 'boolean', description: 'use: bring the tab to the front (default true).' },
      browser: browserProperty,
    }),
    output: {
      schema: {
        type: 'object',
        properties: {
          tabs: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                tabId: { type: 'number' },
                title: { type: 'string' },
                url: { type: 'string' },
                active: { type: 'boolean' },
                current: { type: 'boolean' },
              },
              required: ['tabId', 'url'],
            },
          },
          tabId: { type: 'number' },
          title: { type: 'string' },
          url: { type: 'string' },
          closed: { type: 'boolean' },
        },
      },
      render: (_args, value) => value?.tabs
        ? [textBlock([
          '(* = active in its window)',
          ...(value.tabs ?? []).map((tab) => `${tab.active ? '*' : ' '} ${tab.tabId}${tab.current ? ' (tracked)' : ''}  ${tab.title || '(untitled)'} — ${tab.url}`),
        ].join('\n'))]
        : [textBlock(JSON.stringify(value, null, 2))],
    },
    timeoutMs: TIMEOUT_MS,
    async execute(args) {
      const action = stringArg(args, 'action') ?? 'list'
      const browser = stringArg(args, 'browser')
      const activate = args?.activate
      if (action === 'list') return bridge.send('tabs', {}, { browser, timeoutMs: TIMEOUT_MS })
      const tabId = args?.tabId
      // reload defaults to the tracked page in the worker; demanding an id here
      // made the documented default unreachable (the schema still says optional).
      if (action === 'reload') {
        const params = { action: 'reload' }
        if (typeof tabId === 'number') params.tabId = tabId
        return bridge.send('tabs', params, { browser, timeoutMs: TIMEOUT_MS })
      }
      if (typeof tabId !== 'number') throw new Error('tabId is required for action ' + action)
      if (action === 'use') {
        const params = { tabId }
        if (activate === false) params.activate = false
        return bridge.send('use', params, { browser, timeoutMs: TIMEOUT_MS })
      }
      return bridge.send('closeTab', { tabId }, { browser, timeoutMs: TIMEOUT_MS })
    },
  })






  register({
    name: 'bsb_eval',
    description:
      'Evaluate JavaScript in the tracked page (or a child frame) and return the value. Use when bsb_read cannot describe the state: canvas/WebGL, geometry or computed style, a page-authenticated fetch, or framework internals. The isolated world (default) is read-only over DOM and page HTTP; world "main" sees Vue __vue__, React fibers and closures, and can write. If the expression returns a Promise, pass awaitPromise:true; without it the call fails with PROMISE_RESULT instead of silently returning {}.',
    parameters: input({
      expression: { type: 'string', description: 'Expression to evaluate, e.g. "document.title".' },
      awaitPromise: { type: 'boolean', description: 'Await a returned promise. Required for promise-valued expressions; without it the call fails with PROMISE_RESULT instead of returning {}.' },
      frame: { type: 'string', description: 'Child frame: id/prefix, URL substring, or index.' },
      world: { type: 'string', enum: ['isolated', 'main'], description: '"isolated" (default, read-only) or "main" (page world, can read and write page state).' },
      tabId: { type: 'number', description: 'Read a specific tab instead of the tracked one, so a second tab can be read while the first is driven.' },
      saveTo: { type: 'string', description: 'Write the result JSON to this path and return a short receipt. Large results spill to /tmp/bsb-eval-<stamp>.json automatically.' },
      browser: browserProperty,
    }, ['expression']),    output: {
      schema: { type: 'object', properties: { result: {}, world: { type: 'string' }, frameId: { type: 'string' }, url: { type: 'string' }, saved: { type: 'string' }, bytes: { type: 'number' }, preview: { type: 'string' } } },
      render: (_a, v) => (v?.saved
        ? [textBlock('eval result saved (' + v.bytes + ' bytes) → ' + v.saved + '\nopen it with read, or narrow the expression to get it inline.\npreview: ' + String(v.preview ?? '').slice(0, 400))]
        : jsonRender(v)),
    },
    timeoutMs: TIMEOUT_MS,
    async execute(args) {
      const expression = stringArg(args, 'expression')
      if (!expression) throw new Error('expression is required')
      const tabId = typeof args?.tabId === 'number' ? args.tabId : undefined
      const raw = await bridge.send(
        'eval',
        { expression, awaitPromise: args?.awaitPromise === true, frame: stringArg(args, 'frame'), world: stringArg(args, 'world'), tabId },
        { browser: stringArg(args, 'browser'), timeoutMs: TIMEOUT_MS },
      )
      // A DOM dump, a script body or a serialized framework state can be hundreds
      // of kilobytes. Returning that inline burns the whole context window for
      // one call, so above a threshold it goes to a file and the reply carries a
      // receipt the model can decide to open.
      const inline = JSON.stringify(raw)
      const explicit = stringArg(args, 'saveTo')
      const SPILL_AT = 12000
      if (!explicit && inline.length <= SPILL_AT) return raw
      const { mkdir, writeFile } = await import('node:fs/promises')
      const target = explicit || '/tmp/bsb-eval-' + Date.now().toString(36) + '.json'
      await mkdir(dirname(target), { recursive: true }).catch(() => undefined)
      const body = raw && typeof raw.result === 'string' ? raw.result : inline
      await writeFile(target, body)
      // Only defined keys: an `undefined` property is dropped by JSON.stringify,
      // so the value no longer round-trips and the host rejects the whole reply
      // as "not lossless JSON".
      const receipt = {
        saved: target,
        bytes: Buffer.byteLength(body),
        // Slice by code point: a plain .slice() can cut a surrogate pair in half,
        // and a lone surrogate cannot be encoded, so the reply would be rejected.
        preview: Array.from(lossless(body)).slice(0, 400).join(''),
      }
      if (typeof raw?.world === 'string') receipt.world = raw.world
      if (typeof raw?.url === 'string') receipt.url = raw.url
      return receipt
    },
  })


  register({
    name: 'bsb_open',
    description:
      'Open a URL and make it the tracked page. Use for a URL the user gives you; the tracked tab is reused unless newTab:true, and a new tab opens in the background unless activate:true. If the page is already open, adopt it with bsb_tabs instead of opening another.',
    parameters: input({
      url: { type: 'string', description: 'Absolute http(s) URL to load.' },
      newTab: { type: 'boolean', description: 'Open a separate tab instead of reusing the browser’s tracked one. Defaults to false.' },
      activate: { type: 'boolean', description: 'Bring the opened tab forward. Defaults to false: a page opened for automation must not raise the window or steal the active tab.' },
      browser: browserProperty,
    }, ['url']),
    output: {
      schema: {
        type: 'object',
        properties: {
          tabId: { type: 'number' },
          url: { type: 'string' },
          title: { type: 'string' },
        },
        required: ['url', 'title'],
      },
      render: (_args, value) => jsonRender(value),
    },
    timeoutMs: TIMEOUT_MS,
    async execute(args) {
      const url = stringArg(args, 'url')
      if (!url) throw new Error('url is required')
      if (!/^https?:\/\//i.test(url)) throw new Error('url must start with http:// or https://')
      return bridge.send(
        'open',
        { url, newTab: args?.newTab === true, activate: args?.activate === true },
        { browser: stringArg(args, 'browser'), timeoutMs: TIMEOUT_MS },
      )
    },
  })

  register({
    name: 'bsb_capture',
    description:
      'See the page as images on disk (open with read_image). Use for layout, images, canvas/game frames, or change over time; prefer it to shell screenshot tools. kind shot (default): one PNG, with selector/rect crop, fullPage, frames+intervalMs burst, native for image bytes, preprocess. kind record: action start, act, action stop for one labelled contact sheet; status/probe. kind sheet: tile selector matches into one image for grids and image options. Hidden tabs render without activation; recording and shots install no viewport or window override. Files go to saveDir.',
    parameters: input({
      kind: { type: 'string', enum: ['shot', 'record', 'sheet'], description: '"shot" (default) stills; "record" frames across calls; "sheet" one contact sheet of selector matches.' },
      action: { type: 'string', enum: ['start', 'stop', 'status', 'probe'], description: 'record only: arm, finish and build the sheet, report progress, or measure cadence.' },
      selector: { type: 'string', description: 'Capture only this element (shot), the items to tile (sheet), or the recorded region (record).' },
      offset: { type: 'number', description: 'sheet: skip this many matches first, 0-1000. Defaults to 0.' },
      limit: { type: 'number', description: 'sheet: how many matches to tile, 1-144. Defaults to 24.' },
      rect: {
        type: 'object',
        description: 'shot: crop a region. With selector: a slice of that element — all four values ≤1 are fractions of its box (bottom-right quarter = {x:0.5,y:0.5,width:0.5,height:0.5}), larger values are CSS px from its top-left. Without selector: viewport CSS px.',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
        },
        required: ['x', 'y', 'width', 'height'],
        additionalProperties: false,
      },
      preprocess: {
        type: 'object',
        description: 'shot: transform pixels before saving — fixes mirrored, tiny, rotated or low-contrast text.',
        properties: {
          flipH: { type: 'boolean', description: 'Mirror horizontally.' },
          flipV: { type: 'boolean', description: 'Mirror vertically.' },
          rotate: { type: 'number', description: '90, 180 or 270 degrees.' },
          scale: { type: 'number', description: 'Upscale factor 1-8.' },
          gray: { type: 'boolean', description: 'Grayscale.' },
          invert: { type: 'boolean', description: 'Invert (light text on dark).' },
          contrast: { type: 'number', description: 'Contrast multiplier, 1 = unchanged.' },
          threshold: { type: 'number', description: 'Binarize at this luminance 0-255.' },
        },
        additionalProperties: false,
      },
      scale: { type: 'number', description: 'Zoom for cropped captures, 1-6 (selector default 2, bare rect default 1). The reply reports the image px per CSS px.' },
      frame: { type: 'string', description: 'Element inside this child frame.' },
      native: { type: 'boolean', description: 'shot: save the element image data, not a rendered screenshot.' },
      fullPage: { type: 'boolean', description: 'shot: whole scrollable page.' },
      frames: { type: 'number', description: 'shot: burst count 1-24.' },
      intervalMs: { type: 'number', description: 'Between burst frames, ms.' },
      mode: { type: 'string', enum: ['shots', 'screencast', 'interval'], description: 'record frame source (default shots).' },
      maxFrames: { type: 'number', description: 'record: stop after N frames, 2-400.' },
      threshold: { type: 'number', description: 'record/screencast: change needed to keep a frame, 0-80.' },
      quality: { type: 'number', description: 'record/screencast: JPEG quality 10-100.' },
      maxWidth: { type: 'number', description: 'record/screencast: widest frame, 160-1920.' },
      maxHeight: { type: 'number', description: 'record/screencast: tallest frame, 160-1920.' },
      force: { type: 'boolean', description: 'record: discard an armed recording and restart.' },
      click: { type: 'string', description: 'record: press this element right after arming.' },
      delayMs: { type: 'number', description: 'record: wait before that click, 0-5000.' },
      beyond: { type: 'boolean', description: 'record: render past the viewport.' },
      surface: { type: 'boolean', description: 'record: capture from the compositor (default) or renderer.' },
      columns: { type: 'number', description: 'record: tiles per sheet row; set at start or stop.' },
      maxMs: { type: 'number', description: 'record: auto-stop after N ms (500-600000) so a forgotten recording ends itself.' },
      maxStrip: { type: 'number', description: 'record: frames drawn into the sheet, 4-400.' },
      keep: { type: 'string', enum: ['first', 'last'], description: 'record: which end of the recording to keep.' },
      tileScale: { type: 'number', description: 'record: sheet tile scale 0.1-1.' },
      saveDir: { type: 'string', description: 'Output directory (default /tmp/bsb-shots).' },
      browser: browserProperty,
    }),
    output: {
      schema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
          width: { type: 'number' },
          height: { type: 'number' },
          scale: { type: 'number' },
          frames: { type: 'number' },
          intervalMs: { type: 'number' },
          spanMs: { type: 'number' },
          skipped: { type: 'number' },
          fastestMs: { type: 'number' },
          medianMs: { type: 'number' },
          slowestMs: { type: 'number' },
          frameMs: { type: 'number' },
          fps: { type: 'number' },
          bytes: { type: 'number' },
          frameWidth: { type: 'number' },
          frameHeight: { type: 'number' },
          received: { type: 'number' },
          mode: { type: 'string' },
          window: { type: 'object' },
          clicked: { type: 'object' },
          clickedText: { type: 'string' },
          clickError: { type: 'string' },
          shown: { type: 'number' },
          stripped: { type: 'number' },
          sheetColumns: { type: 'number' },
          sheetRows: { type: 'number' },
          selector: { type: 'string' },
          offset: { type: 'number' },
          count: { type: 'number' },
          columns: { type: 'number' },
          tileWidth: { type: 'number' },
          tileHeight: { type: 'number' },
          tiles: { type: 'array' },
          files: { type: 'array', items: { type: 'string' } },
        },
        required: ['files'],
      },
      render: (args, value) => (args?.kind === 'sheet' || Array.isArray(value?.tiles) ? renderSheet(args, value) : renderCapture(args, value)),
    },
    timeoutMs: TIMEOUT_MS,
    async execute(args) {
      const { mkdir, writeFile } = await import('node:fs/promises')
      const dir = (stringArg(args, 'saveDir') || '/tmp/bsb-shots').replace(/\/+$/, '')
      await mkdir(dir, { recursive: true })
      const stamp = Date.now().toString(36)
      const browser = stringArg(args, 'browser')
      const kind = stringArg(args, 'kind') || 'shot'
      if (kind === 'record') {
        const recordAction = stringArg(args, 'action') ?? 'start'
        const recordMode = stringArg(args, 'mode')
        let raw
        try {
          raw = await bridge.send(
            'record',
            {
              action: recordAction,
              selector: stringArg(args, 'selector'),
              scale: args?.scale,
              frame: stringArg(args, 'frame'),
              mode: recordMode,
              intervalMs: args?.intervalMs,
              maxFrames: args?.maxFrames,
              threshold: args?.threshold,
              force: args?.force,
              click: stringArg(args, 'click'),
              delayMs: args?.delayMs,
              quality: args?.quality,
              maxWidth: args?.maxWidth,
              maxHeight: args?.maxHeight,
              surface: args?.surface,
              beyond: args?.beyond,
              columns: args?.columns,
              maxStrip: args?.maxStrip,
              maxMs: args?.maxMs,
              keep: stringArg(args, 'keep'),
              tileScale: args?.tileScale,
            },
            { browser, timeoutMs: TIMEOUT_MS },
          )
        } catch (error) {
          throw explainRecordFailure(error, recordAction, recordMode)
        }
        const files = []
        const record = { frames: typeof raw?.frames === 'number' ? raw.frames : 0, files }
        // Every field the renderer or the model may need has to be listed here:
        // this loop is a whitelist, so a new reply field that is not added here
        // is silently dropped between the extension and the tool result.
        for (const key of ['intervalMs', 'spanMs', 'skipped', 'received', 'mode', 'frameMs', 'fastestMs', 'medianMs', 'slowestMs', 'fps', 'bytes', 'frameWidth', 'frameHeight', 'shown', 'stripped', 'sheetColumns', 'sheetRows', 'maxFrames', 'maxStrip', 'maxMs', 'columns', 'remainingMs', 'actualIntervalMs', 'autoStopped', 'error', 'warning', 'next', 'clickedText', 'clickError']) {
          if (raw?.[key] !== undefined) record[key] = raw[key]
        }
        if (typeof raw?.url === 'string' && raw.url) record.url = raw.url
        if (raw?.window && typeof raw.window === 'object') record.window = raw.window
        if (raw?.clicked && typeof raw.clicked === 'object') record.clicked = raw.clicked
        if (raw?.recording === true) record.recording = true
        if (raw?.armed === true) record.armed = true
        if (Array.isArray(raw?.frameTimes)) record.frameTimes = raw.frameTimes
        const data = Buffer.from(String(raw?.pngBase64 ?? ''), 'base64')
        if (data.length > 0) {
          const file = dir + '/record-' + stamp + '.png'
          await writeFile(file, data)
          files.push(file)
          if (typeof raw?.width === 'number') record.width = raw.width
          if (typeof raw?.height === 'number') record.height = raw.height
        }
        return record
      }
      if (kind === 'sheet') {
        const raw = await bridge.send(
          'sheet',
          {
            selector: stringArg(args, 'selector'),
            offset: args?.offset,
            limit: args?.limit,
            columns: args?.columns,
            scale: args?.scale,
          },
          { browser, timeoutMs: TIMEOUT_MS },
        )
        const data = Buffer.from(String(raw?.pngBase64 ?? ''), 'base64')
        if (data.length === 0) throw new Error('the browser returned no image data')
        const file = dir + '/sheet-' + stamp + '.png'
        await writeFile(file, data)
        return {
          url: raw?.url ?? '',
          selector: raw?.selector ?? '',
          offset: raw?.offset ?? 0,
          count: raw?.count ?? 0,
          columns: raw?.columns ?? 0,
          tileWidth: raw?.tileWidth ?? 0,
          tileHeight: raw?.tileHeight ?? 0,
          tiles: Array.isArray(raw?.tiles) ? raw.tiles : [],
          files: [file],
        }
      }
      if (args?.native === true && stringArg(args, 'selector')) {
        const raw = await bridge.send('imageSource', { selector: stringArg(args, 'selector'), frame: stringArg(args, 'frame') }, { browser, timeoutMs: TIMEOUT_MS })
        const bytes = Buffer.from(String(raw?.base64 ?? raw?.pngBase64 ?? ''), 'base64')
        if (bytes.length === 0) throw new Error('the browser returned no image data')
        const mime = String(raw?.mime ?? '').match(/^image\/[a-z0-9.+-]+$/) ? String(raw.mime) : 'image/png'
        const ext = mime.split('/')[1] === 'jpeg' ? 'jpg' : mime.split('/')[1]
        const file = dir + '/native-' + stamp + '.' + ext
        await writeFile(file, bytes)
        const record = { url: raw?.url ?? '', title: raw?.title ?? '', frames: 1, files: [file] }
        const width = typeof raw?.width === 'number' ? raw.width : undefined
        const height = typeof raw?.height === 'number' ? raw.height : undefined
        if (typeof width === 'number') record.width = width
        if (typeof height === 'number') record.height = height
        return record
      }
      const count = clampInt(args?.frames, 1, 1, 24)
      const interval = clampInt(args?.intervalMs, 150, 0, 2000)
      const files = []
      let last
      for (let i = 0; i < count; i++) {
        if (i > 0 && interval > 0) await new Promise((resolve) => setTimeout(resolve, interval))
        last = await bridge.send(
          'screenshot',
          {
            fullPage: args?.fullPage === true,
            selector: stringArg(args, 'selector'),
            rect: args?.rect && typeof args.rect === 'object' ? args.rect : undefined,
            scale: args?.scale,
            frame: stringArg(args, 'frame'),
            columns: args?.columns,
            maxStrip: args?.maxStrip,
            keep: stringArg(args, 'keep'),
            tileScale: args?.tileScale,
            preprocess: args?.preprocess && typeof args.preprocess === 'object' ? args.preprocess : undefined,
          },
          { browser, timeoutMs: TIMEOUT_MS },
        )
        const bytes = Buffer.from(String(last?.pngBase64 ?? ''), 'base64')
        if (bytes.length === 0) throw new Error('the browser returned no image data')
        const file = dir + '/shot-' + stamp + '-' + i + '.png'
        await writeFile(file, bytes)
        files.push(file)
      }
      const record = { url: last?.url ?? '', title: last?.title ?? '', frames: count, intervalMs: interval, files }
      if (typeof last?.width === 'number') record.width = last.width
      if (typeof last?.height === 'number') record.height = last.height
      if (typeof last?.frameId === 'string') record.frameId = last.frameId
      if (typeof last?.scale === 'number') record.scale = last.scale
      return record
    },
  })


  register({
    name: 'bsb_wait_for',
    description:
      'Wait for a page condition instead of sleeping. Use after a click that loads or animates, when a control enables late, or when the page shows a loading state. One condition: selector (exists, or gone:true; enabled/stable), text, url, expression, network (after bsb_observe network start), or ms. Returns matched:false on timeout rather than failing. firstSelector/firstText press before the wait; clickSelector/clickText press the moment it matches.',
    parameters: input({
      selector: { type: 'string', description: 'Selector that must exist (or be gone).' },
      text: { type: 'string', description: 'Substring the page text must contain.' },
      url: { type: 'string', description: 'Substring the URL must contain.' },
      expression: { type: 'string', description: 'Read-only JS expression; succeeds when truthy.' },
      network: { type: 'string', description: 'Completed request URL substring or /regex/.' },
      ms: { type: 'number', description: 'Plain delay in ms; no page read. Cheapest way to let time pass.' },
      gone: { type: 'boolean', description: 'Invert the selector test.' },
      enabled: { type: 'boolean', description: 'selector: also require it enabled.' },
      stable: { type: 'boolean', description: 'selector: also require the box to stop moving.' },
      stableMs: { type: 'number', description: 'stable: how long it must hold still (default 400).' },
      timeoutMs: { type: 'number', description: 'Max wait, 200-25000 (default 10000).' },
      pollMs: { type: 'number', description: 'Re-check interval, 10-1000 (default 150).' },
      firstSelector: { type: 'string', description: 'Press this selector before waiting.' },
      firstText: { type: 'string', description: 'Press this visible text before waiting.' },
      firstX: { type: 'number', description: 'Press this x before waiting.' },
      firstY: { type: 'number', description: 'Press this y before waiting.' },
      firstFrame: { type: 'string', description: 'Frame for the first press.' },
      clickSelector: { type: 'string', description: 'Click this selector when the wait matches.' },
      clickText: { type: 'string', description: 'Click this visible text when the wait matches.' },
      clickX: { type: 'number', description: 'Click this x when the wait matches.' },
      clickY: { type: 'number', description: 'Click this y when the wait matches.' },
      clickFrame: { type: 'string', description: 'Frame for the follow-up click.' },
      browser: browserProperty,
    }),    output: {
      schema: {
        type: 'object',
        properties: {
          matched: { type: 'boolean' },
          elapsedMs: { type: 'number' },
          pollMs: { type: 'number' },
          url: { type: 'string' },
          title: { type: 'string' },
          text: { type: 'string' },
          box: {
            type: 'object',
            properties: {
              x: { type: 'number' },
              y: { type: 'number' },
              width: { type: 'number' },
              height: { type: 'number' },
            },
          },
          settled: { type: 'boolean' },
          expressionValue: { type: 'string' },
          pressedFirst: { type: 'object', additionalProperties: true },
          firstClickError: { type: 'string' },
          clicked: { type: 'object', additionalProperties: true },
          clickedAfterMs: { type: 'number' },
          clickError: { type: 'string' },
          network: {
            type: 'object',
            properties: {
              method: { type: 'string' },
              url: { type: 'string' },
              status: { type: 'number' },
              mime: { type: 'string' },
              requestBody: { type: 'string' },
              requestHeaders: { type: 'object', additionalProperties: true },
              responseHeaders: { type: 'object', additionalProperties: true },
              body: { type: 'string' },
            },
            required: ['method', 'url', 'status'],
          },
        },
        required: ['matched', 'elapsedMs'],
      },
      render: (_args, value) => {
        if (value && value.network && typeof value.network === 'object') {
          const net = value.network
          const head = `${net.status} ${net.method} ${net.url}${net.mime ? ` (${net.mime})` : ''}`
          const body = net.body ? `\n  body: ${net.body}` : ''
          const sent = net.requestBody ? `\n  request: ${net.requestBody}` : ''
          const headers = formatHeaders(net.requestHeaders, 8)
          const sentHeaders = headers ? `\n  headers: ${headers}` : ''
          return [textBlock(`matched after ${value.elapsedMs}ms\n${head}${sent}${sentHeaders}${body}`)]
        }
        const armed = value.pressedFirst ? '\n  first press: yes' : value.firstClickError ? `\n  first press failed: ${value.firstClickError}` : ''
        const pressed = value.clicked
          ? `\nthen clicked in the same call (clickedAt ${Math.round(value.clicked.clickedAt?.x ?? 0)},${Math.round(value.clicked.clickedAt?.y ?? 0)})`
          : value.clickError ? `\nthen click failed: ${value.clickError}` : ''
        return [textBlock(`${value.matched ? 'matched' : 'not matched'} after ${value.elapsedMs}ms${value.expressionValue !== undefined ? `\nexpression: ${value.expressionValue}` : ''}${armed}${pressed}`)]
      },
    },
    timeoutMs: TIMEOUT_MS,
    async execute(args) {
      // A plain delay needs no page traffic at all: time-gated pages (idle
      // games, countdowns, autosave) are the common case, and polling them
      // costs a round trip per tick for nothing.
      const delayMs = Number(args?.ms)
      const hasCondition = ['selector', 'text', 'url', 'network', 'expression', 'firstSelector', 'firstText', 'clickSelector', 'clickText']
        .some((key) => typeof args?.[key] === 'string' && args[key].length > 0)
      if (Number.isFinite(delayMs) && delayMs > 0 && !hasCondition) {
        const capped = Math.min(delayMs, 25000)
        const started = Date.now()
        await new Promise((resolve) => setTimeout(resolve, capped))
        return { matched: true, elapsedMs: Date.now() - started, pollMs: 0, sleptMs: capped }
      }
      return bridge.send(
        'waitFor',
        {
          selector: stringArg(args, 'selector'),
          text: stringArg(args, 'text'),
          url: stringArg(args, 'url'),
          network: stringArg(args, 'network'),
          gone: args?.gone === true,
          expression: stringArg(args, 'expression'),
          enabled: args?.enabled === true,
          stable: args?.stable === true,
          stableMs: args?.stableMs,
          timeoutMs: args?.timeoutMs,
          pollMs: args?.pollMs,
          firstSelector: stringArg(args, 'firstSelector'),
          firstText: stringArg(args, 'firstText'),
          firstX: args?.firstX,
          firstY: args?.firstY,
          firstFrame: stringArg(args, 'firstFrame'),
          clickSelector: stringArg(args, 'clickSelector'),
          clickText: stringArg(args, 'clickText'),
          clickX: args?.clickX,
          clickY: args?.clickY,
          clickFrame: stringArg(args, 'clickFrame'),
        },
        { browser: stringArg(args, 'browser'), timeoutMs: TIMEOUT_MS },
      )
    },
  })

  register({
    name: 'bsb_pixels',
    description:
      'Sample an element as colours without decoding an image. Use when you need numbers rather than a picture: which cell is lit, did a region change, where is the red piece, or positions on a hex/isometric board. grid (default) returns r, g, b, luminance and bright share per cell; points samples exact element-local CSS px (up to 4096, optional radius) for layouts a grid cannot address. Prefer this to a screenshot plus decoder.',
    parameters: input({
      selector: {
        type: 'string',
        description: 'CSS selector for the element to sample, e.g. "#cv", "img", "div.chart".',
      },
      grid: {
        type: 'number',
        description: 'Cells across the element, 1-32 (default 8). Rows follow the element aspect ratio. Ignored when points is set.',
      },
      points: {
        type: 'array',
        description:
          'Exact sample points as [x, y] in CSS pixels relative to the element box — the mode for isometric or hex layouts, where a rectangular grid cannot line up with the cells. Compute them from the page geometry (label positions, data attributes, a projection basis) and pass up to 4096.',
        items: { type: 'array', items: { type: 'number' } },
      },
      radius: {
        type: 'number',
        description: 'Points mode: average a square of this half-size around each point, 0-8 (default 0). Use 1-2 for anti-aliased art, 0 to read one exact pixel.',
      },
      scale: { type: 'number', description: 'Capture zoom before sampling, 0.5-4 (default 1).' },
      browser: browserProperty,
    }, ['selector']),
    output: {
      schema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          selector: { type: 'string' },
          width: { type: 'number' },
          height: { type: 'number' },
          cols: { type: 'number' },
          rows: { type: 'number' },
          points: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                x: { type: 'number' },
                y: { type: 'number' },
                off: { type: 'boolean' },
                r: { type: 'number' },
                g: { type: 'number' },
                b: { type: 'number' },
                lum: { type: 'number' },
                bright: { type: 'number' },
              },
              required: ['x', 'y'],
            },
          },
          cells: {
            type: 'array',
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  r: { type: 'number' },
                  g: { type: 'number' },
                  b: { type: 'number' },
                  lum: { type: 'number' },
                  bright: { type: 'number' },
                },
                required: ['r', 'g', 'b', 'lum'],
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (Array.isArray(value?.points)) {
          const rows = value.points.map(
            (point) =>
              `${point.off ? 'off' : `${point.r},${point.g},${point.b}`.padEnd(11)} @ ${String(point.x).padStart(6)},${String(point.y).padStart(6)}`,
          )
          return [textBlock(`pixels "${value?.selector ?? ''}" — ${value.points.length} points\n${rows.join('\n')}`)]
        }
        const ramp = ' .:-=+*#%@'
        const cells = Array.isArray(value?.cells) ? value.cells : []
        const art = cells
          .map((row) => row.map((cell) => ramp[Math.min(ramp.length - 1, Math.max(0, Math.floor((cell.lum / 256) * ramp.length)))]).join(''))
          .join('\n')
        const flat = cells.flat()
        const mean = flat.length ? Math.round(flat.reduce((sum, cell) => sum + cell.lum, 0) / flat.length) : 0
        const bright = flat.length ? Math.round((flat.reduce((sum, cell) => sum + (cell.bright ?? 0), 0) / flat.length) * 100) / 100 : 0
        return [
          textBlock(
            `pixels "${value?.selector ?? ''}" — ${value?.cols ?? 0}x${value?.rows ?? 0} cells of ${value?.width ?? 0}x${value?.height ?? 0}\n${art}\nmean luminance ${mean} · bright share ${bright}`,
          ),
        ]
      },
    },
    timeoutMs: TIMEOUT_MS,
    async execute(args) {
      return bridge.send(
        'pixels',
        { selector: stringArg(args, 'selector'), grid: args?.grid, scale: args?.scale, points: args?.points, radius: args?.radius },
        { browser: stringArg(args, 'browser'), timeoutMs: TIMEOUT_MS },
      )
    },
  })


  register({
    name: 'bsb_act',
    description:
      'Perform ONE input action. Use for every click, keystroke, drag, slider, scroll, file upload and canvas-game input. click: target|@eN|text|x,y (+count, all, targets, button). hover: target|text|x,y. type: target+text (+submit). set: target+value|checked (sliders, framework-bound inputs). select: target+value|label|index. key: key|keys+modifiers (+holdMs, steps for timed UIs, measure/settle for canvas state). drive: x,y in GAME coordinates or route[] - closed-loop steering of a canvas sprite. measure: read-only canvas sprite state. forceActive: opt-in wake of a hidden or paused page; hold with mode "hold" until releaseActive. scroll, drag (+path), drop, upload. x/y are viewport CSS px unless the action says game coordinates.',
    parameters: input({
      action: {
        type: 'string',
        enum: ['click', 'hover', 'type', 'set', 'select', 'key', 'drive', 'measure', 'scroll', 'drag', 'drop', 'upload', 'forceActive', 'releaseActive'],
        description: 'Which input action to perform.',
      },
      target: { type: 'string', description: '@eN from bsb_read, or a CSS selector.' },
      text: { type: 'string', description: 'Visible label (click/hover), or the text to type.' },
      x: { type: 'number', description: 'Viewport CSS x (game coordinate for drive).' },
      y: { type: 'number', description: 'Viewport CSS y (game coordinate for drive).' },
      toTarget: { type: 'string', description: 'drag: drop target.' },
      toX: { type: 'number', description: 'drag: drop x.' },
      toY: { type: 'number', description: 'drag: drop y.' },
      count: { type: 'number', description: 'click: taps, 1-200. key: repeats.' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'click: mouse button (default left).' },
      all: { type: 'boolean', description: 'click: press every match.' },
      targets: {
        type: 'array',
        description: 'click: batch of selectors and/or {x,y} points (max 500), pressed in order.',
        items: { anyOf: [{ type: 'string' }, { type: 'object', additionalProperties: true }] },
      },
      submit: { type: 'boolean', description: 'type: press Enter afterwards.' },
      value: { type: 'string', description: 'set/select: value to apply.' },
      checked: { type: 'boolean', description: 'set: wanted checked state.' },
      label: { type: 'string', description: 'select: option label.' },
      index: { type: 'number', description: 'select: option index.' },
      selector: { type: 'string', description: 'scroll: element to bring into view.' },
      key: { type: 'string', description: 'key: "Enter", "ArrowRight", "Escape", or one letter/digit.' },
      keys: { type: 'array', items: { type: 'string' }, description: 'key: keys held together.' },
      modifiers: { type: 'array', items: { type: 'string' }, description: 'key: Alt, Control, Meta, Shift.' },
      holdMs: { type: 'number', description: 'key/click/drag: hold time in ms, 0-10000. On click it keeps the button down (hold-to-mine); ignored for count>1.' },
      path: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: 'drag: [[x,y],…] press, glide, release (circles, signatures).' },
      instant: { type: 'boolean', description: 'drag path: stream moves without waiting (stroke timers).' },
      steps: {
        type: 'array',
        description: 'key: gesture script [{keys?, key?, holdMs?, waitMs?, until?, untilMeasure?, click?},…]. until/untilMeasure hold the keys until a read-only condition is truthy; click presses an element the instant the step ends.',
        items: { type: 'object', additionalProperties: true },
      },
      mode: { type: 'string', enum: ['call', 'hold'], description: 'forceActive: "call" (default, clears itself) or "hold" (stays until releaseActive).' },
      forceActive: {
        type: 'boolean',
        description:
          'Escape hatch for a page whose frame clock has stopped: a sleeping display leaves the tab reporting hidden, so requestAnimationFrame pauses and input queues silently. Passing true wakes the lifecycle for THIS call only and the reply reports what was forced. Off by default because it breaks page neutrality — the page then believes it is on screen, and screenshots or sampled pixels can be stale. To keep the page awake across many calls (watching a run), use bsb_act action "forceActive" with mode "hold", then "releaseActive".',
      },
      measure: { type: 'boolean', description: 'key: also return canvas measurement.' },
      settle: { type: 'boolean', description: 'key/measure: wait for the canvas to stop moving.' },
      tol: { type: 'number', description: 'drive: arrival tolerance in game units (default 12).' },
      timeoutMs: { type: 'number', description: 'drive: give up after this many ms (default 20000).' },
      maxSpeed: { type: 'number', description: 'drive: cruise speed cap, game units/s (default 90).' },
      untilMeasure: { type: 'string', description: 'drive: stop when this expression over the measurement m is truthy.' },
      confirm: { type: 'string', description: 'drive: element pressed once the sprite has stopped.' },
      route: {
        type: 'array',
        description: 'drive: waypoints [{x, y, tol?, maxSpeed?, untilMeasure?},…] driven in one call; the sprite is braked between legs.',
        items: { type: 'object', additionalProperties: true },
      },
      files: { type: 'array', items: { type: 'string' }, description: 'drop/upload: file paths on the browser machine.' },
      mimeType: { type: 'string', description: 'drop: MIME type of dropped text (default text/plain).' },
      frame: { type: 'string', description: 'Act inside this child frame: id/prefix, URL substring, or index.' },
      browser: browserProperty,
    }, ['action']),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => jsonRender(value),
    },
    timeoutMs: TIMEOUT_MS,
    async execute(args) {
      const action = stringArg(args, 'action')
      const browser = stringArg(args, 'browser')
      const frame = stringArg(args, 'frame')
      const send = (command, payload) => bridge.send(command, payload, { browser, timeoutMs: TIMEOUT_MS })
      if (action === 'click') {
        const target = stringArg(args, 'target')
        const text = stringArg(args, 'text')
        const count = typeof args?.count === 'number' ? args.count : undefined
        const button = args?.button === 'right' || args?.button === 'middle' ? args.button : undefined
        const targets = Array.isArray(args?.targets) ? args.targets : undefined
        // holdMs travels with every click shape: a hold-to-mine press is the
        // whole point of passing it, and dropping it silently made the tool
        // report success while the page never saw a held button.
        const holdMs = typeof args?.holdMs === 'number' ? args.holdMs : undefined
        if (targets && targets.length) return send('click', { targets, forceActive: args?.forceActive === true })
        if (args?.all === true && target) return send('click', { target, all: true })
        if (frame) return send('click', { target, text, frame, count, button, holdMs, forceActive: args?.forceActive === true })
        if (typeof args?.x === 'number' && typeof args?.y === 'number') return send('click', { x: args.x, y: args.y, count, button, holdMs, forceActive: args?.forceActive === true })
        if (text) return send('click', { text, count, button, holdMs, forceActive: args?.forceActive === true })
        if (!target) throw new Error('click needs target, text, or x/y')
        return send('click', { target, count, button, holdMs, forceActive: args?.forceActive === true })
      }
      if (action === 'hover') return send('hover', { target: stringArg(args, 'target'), text: stringArg(args, 'text'), x: args?.x, y: args?.y, frame })
      if (action === 'type') {
        const target = stringArg(args, 'target')
        if (!target) throw new Error('type needs target')
        if (typeof args?.text !== 'string') throw new Error('type needs text')
        return send('type', { target, text: args.text, submit: args?.submit === true, frame })
      }
      if (action === 'set') return send('set', { target: stringArg(args, 'target'), value: args?.value == null ? undefined : String(args.value), checked: typeof args?.checked === 'boolean' ? args.checked : undefined, frame })
      if (action === 'select') return send('select', { target: stringArg(args, 'target'), value: args?.value == null ? undefined : String(args.value), label: stringArg(args, 'label'), index: args?.index, frame })
      if (action === 'scroll') return send('scroll', { selector: stringArg(args, 'selector') ?? stringArg(args, 'target'), x: args?.x, y: args?.y, frame })
      if (action === 'drag') return send('drag', { target: stringArg(args, 'target'), x: args?.x, y: args?.y, toTarget: stringArg(args, 'toTarget'), toX: args?.toX, toY: args?.toY, steps: args?.steps ? undefined : args?.count, holdMs: args?.holdMs, path: Array.isArray(args?.path) ? args.path : undefined, instant: args?.instant === true, frame })
      if (action === 'drop') {
        const target = stringArg(args, 'target')
        const files = Array.isArray(args?.files) ? args.files.map((f) => String(f)) : []
        const text = typeof args?.text === 'string' ? args.text : undefined
        const hasPoint = typeof args?.x === 'number' && typeof args?.y === 'number'
        if (!target && !hasPoint) throw new Error('drop needs target or x/y')
        if (!files.length && text === undefined) throw new Error('drop needs files or text')
        return send('drop', { target, files, text, x: args?.x, y: args?.y, mimeType: stringArg(args, 'mimeType'), frame })
      }
      if (action === 'upload') return send('upload', { target: stringArg(args, 'target'), files: Array.isArray(args?.files) ? args.files : undefined, frame })
      if (action === 'key') {
        const keys = Array.isArray(args?.keys) ? args.keys : undefined
        return send('key', {
          key: stringArg(args, 'key'),
          keys,
          steps: args?.steps,
          count: args?.count,
          holdMs: args?.holdMs,
          forceActive: args?.forceActive === true,
          measure: Boolean(args?.measure),
          settle: Boolean(args?.settle),
          target: stringArg(args, 'target'),
          modifiers: Array.isArray(args?.modifiers) ? args.modifiers : undefined,
        })
      }
      if (action === 'forceActive') return send('forceActive', { mode: args?.mode === 'hold' ? 'hold' : 'call' })
      if (action === 'releaseActive') return send('releaseActive', {})
      if (action === 'measure') return send('measure', { settle: Boolean(args?.settle) })
      if (action === 'drive') {
        const hasRoute = Array.isArray(args?.route) && args.route.length > 0
        if (!hasRoute && (typeof args?.x !== 'number' || typeof args?.y !== 'number')) throw new Error('drive needs numeric x and y (game coordinates), or a route')
        return send('drive', {
          x: args?.x,
          y: args?.y,
          route: hasRoute ? args.route : undefined,
          tol: args?.tol,
          timeoutMs: args?.timeoutMs,
          maxSpeed: args?.maxSpeed,
          untilMeasure: stringArg(args, 'untilMeasure'),
          click: stringArg(args, 'confirm'),
          keys: args?.keys && typeof args.keys === 'object' && !Array.isArray(args.keys) ? args.keys : undefined,
        })
      }
      throw new Error('bsb_act needs action: click | hover | type | set | select | key | drive | scroll | drag | drop | upload')
    },
  })

  register({
    name: 'bsb_read',
    description:
      'Read the tracked page, read-only. Use before acting to see what is on the page and what can be clicked. mode text (default): visible text, viewport, and interactive elements with @eN refs for bsb_act. mode rows: selector matches as structured rows for tables, cards, lists and grids - scrape with this, not raw HTML. mode html: one element\'s outerHTML.',
    parameters: input({
      mode: { type: 'string', enum: ['text', 'rows', 'html'], description: 'What to return (default text).' },
      maxChars: { type: 'number', description: 'text/html: cap the reply length.' },
      maxElements: { type: 'number', description: 'text: max interactive elements (default 60, max 200).' },
      probe: { type: 'array', items: { type: 'string' }, description: 'text: extra selectors whose box you need (canvas, map), max 20.' },
      selector: { type: 'string', description: 'rows: elements to read. html: element to dump.' },
      limit: { type: 'number', description: 'rows: max rows (default 50).' },
      offset: { type: 'number', description: 'rows: skip this many (paging).' },
      text: { type: 'boolean', description: 'rows: include visible text (default true).' },
      href: { type: 'boolean', description: 'rows: include resolved link.' },
      image: { type: 'boolean', description: 'rows: include image source.' },
      state: { type: 'boolean', description: 'rows: include form state, id, name, class.' },
      browser: browserProperty,
    }),    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => (stringArg(args, 'mode') === 'text' || !stringArg(args, 'mode') ? renderRead(args, value) : jsonRender(value)),
    },
    timeoutMs: TIMEOUT_MS,
    async execute(args) {
      const mode = stringArg(args, 'mode') || 'text'
      const browser = stringArg(args, 'browser')
      const opts = { browser, timeoutMs: TIMEOUT_MS }
      if (mode === 'rows') {
        return bridge.send('inspect', {
          selector: stringArg(args, 'selector'),
          limit: args?.limit,
          offset: args?.offset,
          text: args?.text,
          href: args?.href,
          image: args?.image,
          state: args?.state,
        }, opts)
      }
      if (mode === 'html') {
        return bridge.send('html', { selector: stringArg(args, 'selector'), maxChars: args?.maxChars }, opts)
      }
      return bridge.send('read', {
        maxChars: clampInt(args?.maxChars, 6000, 200, MAX_CHARS),
        maxElements: clampInt(args?.maxElements, 60, 1, MAX_ELEMENTS),
        probe: Array.isArray(args?.probe) ? args.probe.filter((value) => typeof value === 'string').slice(0, 20) : undefined,
      }, opts)
    },
  })

  register({
    name: 'bsb_observe',
    description:
      'Observe the page over time without injecting. Use when the UI does something unexplained: kind network shows the page\'s own fetch/XHR (find the API, auth headers, or why a spinner spins); kind console shows messages and uncaught exceptions; kind timeline samples an element\'s box and, for a canvas, a coarse colour grid and fps. Network logs are brief by default; detail "full" or fields add headers and bodies when needed.',
    parameters: input({
      kind: { type: 'string', enum: ['network', 'console', 'timeline'], description: 'What to observe.' },
      action: { type: 'string', enum: ['start', 'log', 'stop', 'clear'], description: 'network/console: capture control (timeline ignores it).' },
      limit: { type: 'number', description: 'network/console: entries kept or returned.' },
      filter: { type: 'string', description: 'network log: only URLs containing this.' },
      detail: { type: 'string', enum: ['brief', 'full'], description: 'network log: "brief" (default) gives url/method/status/mime plus body sizes; "full" adds headers and bodies.' },
      fields: { type: 'array', items: { type: 'string' }, description: 'network log: return only these entry keys, e.g. ["url","status","body"].' },
      selector: { type: 'string', description: 'timeline: element to sample (default body; prefer the canvas or sprite).' },
      durationMs: { type: 'number', description: 'timeline: sample window, 100-10000 ms.' },
      intervalMs: { type: 'number', description: 'timeline: tick spacing, 16-1000 ms.' },
      grid: { type: 'number', description: 'timeline: colour grid cells per axis, 1-8.' },
      raf: { type: 'boolean', description: 'timeline: count frames for fps (default true).' },
      frame: { type: 'string', description: 'timeline: sample inside this child frame.' },
      browser: browserProperty,
    }, ['kind']),    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => {
        if (stringArg(args, 'kind') !== 'timeline' || !Array.isArray(value?.samples)) return jsonRender(value)
        const samples = value.samples
        const first = samples[0]?.box
        const last = samples[samples.length - 1]?.box
        const moved = first && last ? { dx: Math.round((last.x - first.x) * 10) / 10, dy: Math.round((last.y - first.y) * 10) / 10 } : null
        const coloured = samples.filter((sample) => Array.isArray(sample.colour))
        const summary = coloured.length ? ` · canvas ${coloured[0].colour.length} cells/axis` : ''
        return [
          textBlock(
            `timeline "${value.selector}" — ${samples.length} samples / ${value.elapsed} ms · ${value.fps ?? '?'} fps${summary}` +
              (moved ? `\nbox ${first.x},${first.y} ${first.w}x${first.h} → ${last.x},${last.y} ${last.w}x${last.h} (Δ ${moved.dx},${moved.dy})` : '') +
              `\n${JSON.stringify(samples.slice(0, 40), null, 0)}`,
          ),
        ]
      },
    },
    timeoutMs: TIMEOUT_MS,
    async execute(args) {
      const kind = stringArg(args, 'kind')
      const browser = stringArg(args, 'browser')
      const opts = { browser, timeoutMs: TIMEOUT_MS }
      if (kind === 'timeline') {
        return bridge.send('timeline', {
          selector: stringArg(args, 'selector'),
          durationMs: args?.durationMs,
          intervalMs: args?.intervalMs,
          grid: args?.grid,
          raf: args?.raf,
          frame: stringArg(args, 'frame'),
        }, opts)
      }
      const action = stringArg(args, 'action') || 'log'
      if (kind === 'network') {
        return bridge.send('network', {
          action,
          limit: args?.limit,
          filter: stringArg(args, 'filter'),
          detail: stringArg(args, 'detail'),
          fields: Array.isArray(args?.fields) ? args.fields.map(String) : undefined,
        }, opts)
      }
      if (kind === 'console') return bridge.send('console', { action, limit: args?.limit }, opts)
      throw new Error('bsb_observe needs kind: network | console | timeline')
    },
  })

}
