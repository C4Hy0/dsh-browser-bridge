#!/usr/bin/env node
import fs from "node:fs"
/**
 * End-to-end test: drives the real Chrome through the plugin's own protocol
 * (via the dev-only /browser-bridge/dev/command route) against tests/fixture.html.
 *
 * Requires: the plugin running with devReload and a connected browser. The
 * extension zip is packed on demand, so there is nothing to build first.
 *
 * Each step is a raw worker command, so this exercises the transport, the
 * worker command table and the page — not the model-facing tool wrappers.
 */
const BASE = process.env.BROWSER_BRIDGE_BASE ?? 'http://127.0.0.1:3080/browser-bridge'
const FIXTURE = `${BASE}/dev/fixture`
const KEEP_TAB = Number(process.env.BROWSER_BRIDGE_KEEP_TAB ?? 0) || null
// With several Chrome profiles paired the worker refuses to guess a target, so the
// harness forwards an explicit browser id/label when one is given.
const BROWSER = process.env.BROWSER_BRIDGE_BROWSER ?? ''

let failures = 0
const results = []

const call = async (method, params = {}, timeoutMs = 60000) => {
  const target = BROWSER ? `&browser=${encodeURIComponent(BROWSER)}` : ''
  const url = `${BASE}/dev/command?method=${encodeURIComponent(method)}&params=${encodeURIComponent(JSON.stringify(params))}${target}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    const body = await response.json()
    if (!body.ok) throw new Error(`${method}: ${body.error}${body.code ? ` (${body.code})` : ''}`)
    return body.result
  } finally {
    clearTimeout(timer)
  }
}

const check = (name, condition, detail = '') => {
  const ok = Boolean(condition)
  if (!ok) failures += 1
  results.push(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  return ok
}

const main = async () => {
  const browsers = await fetch(`${BASE}/api/browsers`).then((r) => r.json())
  if (!check('browser connected', browsers.browsers?.some((b) => b.connected), JSON.stringify(browsers))) return

  const opened = await call('open', { url: FIXTURE, newTab: true, activate: true })
  const tabId = opened.tabId
  check('open created a tab', Number.isFinite(tabId) && opened.url === FIXTURE, JSON.stringify(opened))

  try {
    const read = await call('read', { maxChars: 4000 })
    check('read sees the title', read.title === 'Bridge Fixture', read.title)
    check('read reports viewport', read.viewport?.width > 0, JSON.stringify(read.viewport))
    check('read lists elements', Array.isArray(read.elements) && read.elements.length > 5, `${read.elements?.length} elements`)

    const typed = await call('type', { target: '#type-in', text: 'hello bridge' })
    check('type reported page', typed.url === FIXTURE, typed.url)
    const text = await call('eval', { expression: "document.querySelector('#type-out').textContent" })
    check('typed text lands in the page', text.result === 'hello bridge', text.result)
    // Typing must reach the page as key events, not as a scripted value write.
    await call('type', { target: '#keys', text: 'ab' })
    const keyLog = await call('eval', { expression: "document.querySelector('#key-log').textContent" })
    check('type emits key events the page sees', keyLog.result === 'b', keyLog.result)

    // world:'main' is an explicit opt-in: it must see the page's own globals.
    const mainVal = await call('eval', { expression: 'typeof window.__bridgeGlobal', world: 'main' })
    check('eval world:"main" reaches page globals', mainVal.result === 'string', JSON.stringify(mainVal))
    const isoVal = await call('eval', { expression: 'typeof window.__bridgeGlobal' })
    check('eval hides page globals in the isolated world', isoVal.result === 'undefined', JSON.stringify(isoVal))
    const promiseUnawaited = await call('eval', { expression: "Promise.resolve({ marker: 'promise' })" }).then(() => '', (error) => String(error?.message ?? error))
    check('un-awaited promise eval fails clearly', /PROMISE_RESULT/.test(promiseUnawaited), promiseUnawaited)
    const promiseAwaited = await call('eval', { expression: "Promise.resolve({ marker: 'promise' })", awaitPromise: true })
    check('awaitPromise resolves a promise', promiseAwaited.result?.marker === 'promise', JSON.stringify(promiseAwaited))

    // The read-only contract: a model expression may inspect the page but every
    // attempt to edit it must be rejected before it reaches the document.
    const kidsBefore = await call('eval', { expression: 'document.body.children.length' })
    const textBefore = await call('eval', { expression: "document.querySelector('#type-out').textContent" })
    const addDenied = await call('eval', { expression: "document.body.appendChild(document.createElement('div'))" }).then(() => '', (error) => String(error?.message ?? error))
    check('eval cannot add a node to the page', /READ_ONLY/.test(addDenied), addDenied)
    const styleDenied = await call('eval', { expression: "document.body.style.display = 'none'" }).then(() => '', (error) => String(error?.message ?? error))
    check('eval cannot restyle the page', /READ_ONLY/.test(styleDenied), styleDenied)
    const textDenied = await call('eval', { expression: "document.querySelector('#type-out').textContent = 'hacked'" }).then(() => '', (error) => String(error?.message ?? error))
    check('eval cannot rewrite page text', /READ_ONLY/.test(textDenied), textDenied)
    const kidsAfter = await call('eval', { expression: 'document.body.children.length' })
    const textAfter = await call('eval', { expression: "document.querySelector('#type-out').textContent" })
    check('eval left the page markup unchanged', kidsAfter.result === kidsBefore.result, JSON.stringify({ before: kidsBefore.result, after: kidsAfter.result }))
    check('eval left the page text unchanged', textAfter.result === textBefore.result, JSON.stringify({ before: textBefore.result, after: textAfter.result }))
    const detached = await call('eval', { expression: "(() => { const c = document.createElement('canvas'); c.width = 4; c.height = 4; return c.getContext('2d').getImageData(0, 0, 1, 1).data.length })()" })
    check('eval can still analyze a detached canvas', detached.result === 4, JSON.stringify(detached))

    await call('click', { target: '#fetch-api' })
    const waited = await call('waitFor', { text: 'pcmkkicdcomiljgbbbdnjknphlgibnno', timeoutMs: 5000 })
    check('waitFor matches page text', waited.matched === true, JSON.stringify(waited))

    const started = await call('network', { action: 'start' })
    check('network start binds the tab', started.started === true && started.tabId === tabId, JSON.stringify(started))
    await call('click', { target: '#fetch-later' })
    const net = await call('waitFor', { network: 'extension-meta.json?later=1', timeoutMs: 6000 })
    check('waitFor network sees the request', net.matched === true && net.network?.status === 200, JSON.stringify(net.network ?? net))
    check('waitFor network returns the body', typeof net.network?.body === 'string' && net.network.body.includes('pcmkkicd'))
    check('waitFor network returns request headers', net.network?.requestHeaders?.['x-fixture-token'] === 'alpha-42', JSON.stringify(net.network?.requestHeaders))
    const stopped = await call('network', { action: 'stop' })
    check('network stop reports count', stopped.stopped === true && stopped.captured >= 1, JSON.stringify(stopped))

    await call('network', { action: 'start' })
    await call('click', { target: '#fetch-api' })
    await call('waitFor', { network: 'extension-meta.json', timeoutMs: 5000 })
    const netLog = await call('network', { action: 'log', detail: 'full' })
    const apiEntry = (netLog.entries ?? []).find((entry) => String(entry.url).endsWith('/extension-meta.json'))
    check('network log returns request headers', apiEntry?.requestHeaders?.['x-fixture-api'] === 'beta-7', JSON.stringify(apiEntry?.requestHeaders))
    // The same log without detail:"full" is the model-facing default: it must stay
    // a projection (URL/status/sizes) rather than dumping every header and body.
    const briefLog = await call('network', { action: 'log' })
    const briefEntry = (briefLog.entries ?? []).find((entry) => String(entry.url).endsWith('/extension-meta.json'))
    check('network log is brief by default', briefEntry && briefEntry.requestHeaders === undefined, JSON.stringify(briefEntry))
    await call('network', { action: 'stop' })

    const consoleStarted = await call('console', { action: 'start' })
    check('console start binds the tab', consoleStarted.capturing === true && consoleStarted.tabId === tabId, JSON.stringify(consoleStarted))
    await call('eval', { expression: "(() => { console.log('e2e-console-marker'); setTimeout(() => { throw new Error('e2e-boom') }, 0); return 'queued' })()" })
    await new Promise((resolve) => setTimeout(resolve, 400))
    const consoleLog = await call('console', { action: 'log' })
    const consoleText = (consoleLog.entries ?? []).map((entry) => `${entry.level}:${entry.text}`).join('\n')
    check('console captures log lines', consoleText.includes('e2e-console-marker'), consoleText)
    check('console captures uncaught exceptions', /e2e-boom/.test(consoleText), consoleText)
    const consoleCleared = await call('console', { action: 'clear' })
    check('console clear empties the buffer', consoleCleared.cleared === true, JSON.stringify(consoleCleared))

    const select = await call('select', { target: '#pick', value: 'gamma' })
    check('select sets the value', select.value === 'gamma', JSON.stringify(select))
    const setRange = await call('set', { target: '#slide', value: '73' })
    const rangeOut = await call('eval', { expression: "document.querySelector('#slide-out').textContent" })
    check('set moves a range and the page reacts', setRange.value === '73' && /\b73\b/.test(rangeOut.result ?? ''), JSON.stringify({ setRange, out: rangeOut.result }))
    const setText = await call('set', { target: '#type-in', value: 'via set' })
    const setMirror = await call('eval', { expression: "document.querySelector('#type-out').textContent" })
    check('set writes a text input and the page reacts', setMirror.result === 'via set', JSON.stringify({ setText, mirror: setMirror.result }))
    // A directory both the Node process and Chrome can see. Defaults to the
    // public Windows temp folder on WSL; override for other layouts.
    const winTmp = process.env.BSB_WIN_TEMP || String.raw`C:\Users\Public\AppData\Local\Temp`
    const hostTmp = process.env.BSB_HOST_TEMP || winTmp.replace(/^([A-Za-z]):\\/, '/mnt/$1/').replace(/\\/g, '/')
    const winFile = (name) => `${winTmp.replace(/[\\/]+$/, '')}\\${name}`
    const uploadName = `bridge-e2e-${process.pid}.txt`
    try {
      fs.mkdirSync(hostTmp, { recursive: true })
      fs.writeFileSync(`${hostTmp}/${uploadName}`, 'bridge upload test\n')
      const upload = await call('upload', { target: '#file-in', files: [winFile(uploadName)] })
      const attached = await call('eval', { expression: "document.querySelector('#file-out').textContent" })
      check('upload attaches a file and the page reacts', attached.result === uploadName, JSON.stringify({ upload, attached: attached.result }))
      const frameUpload = await call('upload', { frame: '0', target: '#inner-file', files: [winFile(uploadName)] })
      const innerFile = await call('eval', { frame: '0', expression: "document.getElementById('inner-file-out')?.textContent" })
      check('upload works inside a frame', frameUpload.frameId && innerFile.result === uploadName, JSON.stringify({ frameUpload, innerFile }))
    } finally {
      fs.rmSync(`${hostTmp}/${uploadName}`, { force: true })
    }
    const dropName = `bridge-drop-${process.pid}.txt`
      fs.writeFileSync(`${hostTmp}/${dropName}`, 'drop test\n')
      const dropped = await call('drop', { target: '#drop-zone', files: [winFile(dropName)] })
      const dropOut = await call('eval', { expression: "document.querySelector('#drop-out').textContent" })
      check('drop delivers a file to a DnD zone', String(dropOut.result).includes(dropName), JSON.stringify({ dropped, dropOut: dropOut.result }))
      const textDrop = await call('drop', { target: '#drop-zone', text: 'dropped text' })
      const textOut = await call('eval', { expression: "document.querySelector('#drop-out').textContent" })
      check('drop delivers text to a DnD zone', textOut.result === 'text:dropped text', JSON.stringify({ textDrop, dropOut: textOut.result }))

      fs.rmSync(`${hostTmp}/${dropName}`, { force: true })
    const shadowClick = await call('click', { text: 'shadow button' })
    const shadowOut = await call('eval', { expression: "document.getElementById('shadow-host').shadowRoot.getElementById('shadow-out').textContent" })
    check('click by text pierces a shadow root', shadowOut.result === 'SHADOW-CLICKED', JSON.stringify({ shadowClick, out: shadowOut.result }))
    const shadowSelectorClick = await call('click', { target: '#shadow-btn' })
    const shadowOut2 = await call('eval', { expression: "document.getElementById('shadow-host').shadowRoot.getElementById('shadow-out').textContent" })
    check('click by selector pierces a shadow root', shadowSelectorClick.clickedAt != null && shadowOut2.result === 'SHADOW-CLICKED', JSON.stringify({ shadowSelectorClick, out: shadowOut2.result }))
    const shadowType = await call('type', { target: '#shadow-in', text: 'via shadow' })
    const shadowMirror = await call('eval', { expression: "document.getElementById('shadow-host').shadowRoot.getElementById('shadow-mirror').textContent" })
    check('type pierces a shadow root', shadowMirror.result === 'via shadow', JSON.stringify({ shadowType, mirror: shadowMirror.result }))
    const shadowRead = await call('read', {})
    const shadowEl = (shadowRead.elements ?? []).find((el) => el.selector === '#shadow-btn')
    check('read lists a shadow control', shadowEl?.shadow === true, JSON.stringify(shadowEl))
    check('read includes shadow text', /SHADOW-CLICKED/.test(shadowRead.text ?? ''), String(shadowRead.text ?? '').slice(-80))
    const hover = await call('hover', { target: '#hover-box' })
    const afterHover = await call('eval', { expression: "document.querySelector('#hover-menu').textContent" })
    check('hover reveals the menu', /HOVER-MENU-VISIBLE/.test(afterHover.result ?? ''), afterHover.result)
    const hoverText = await call('hover', { text: 'hover me' })
    check('hover by text finds the element', hoverText.at?.x > 0 && hoverText.at?.y > 0, JSON.stringify(hoverText.at))
    check('hover omits a null frame id', hover.frameId === undefined && hoverText.frameId === undefined, JSON.stringify([hover.frameId, hoverText.frameId]))
    const dlgClick = await call('click', { text: 'open dialog' })
    check('click by text reports a dismissed dialog', dlgClick.dialog === 'fixture-confirm', JSON.stringify(dlgClick))
    const missing = await call('click', { text: 'no such control anywhere' }).catch((error) => ({ error: String(error?.message ?? error) }))
    check('click by unknown text fails clearly', /TARGET_NOT_FOUND/.test(missing.error ?? ''), missing.error)

    const key = await call('key', { key: 'Enter', target: '#keys' })
    const keys = await call('eval', { expression: "document.querySelector('#key-log').textContent" })
    check('key with target types into the field', /Enter/.test(keys.result ?? ''), keys.result)
    const combo = await call('key', { key: 'a', modifiers: ['Control'], target: '#keys' })
    const comboLog = await call('eval', { expression: "document.querySelector('#key-log').textContent" })
    check('key modifiers reach the page', /ctrl/i.test(comboLog.result ?? ''), comboLog.result)

    const scroll = await call('scroll', { y: 400 })
    check('scroll moves the page', scroll.scrollY === 400, JSON.stringify(scroll))

    const drag = await call('drag', { target: '#slide', toX: 260, steps: 12 })
    check('drag reports a path', Number.isFinite(drag?.to?.x) && drag.to.x > 100, JSON.stringify(drag))

    const shot = await call('screenshot', { selector: '#cv', scale: 2 })
    check('screenshot crops an element', shot.pngBase64?.length > 500, `${shot.pngBase64?.length} bytes`)
    // A selector capture must include the whole element even when it is taller
    // than the viewport; cropping a viewport shot used to truncate it silently.
    const tallShot = await call('screenshot', { selector: '#tall', scale: 1 })
    const tallDims = (() => {
      const bytes = Buffer.from(tallShot.pngBase64 ?? '', 'base64')
      return bytes.length >= 24 ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : { width: 0, height: 0 }
    })()
    const tallDpr = (await call('eval', { expression: 'devicePixelRatio' })).result
    const tallView = (await call('eval', { expression: 'innerHeight' })).result
    check(
      'screenshot captures an element taller than the viewport',
      tallDims.height >= 1200 && tallView < 1200 && Math.abs(tallDims.height - Math.round(1200 * tallDpr)) <= 4,
      JSON.stringify({ dims: tallDims, dpr: tallDpr, viewportHeight: tallView }),
    )
    // A bare rect is measured in CSS px and maps to image px at the device
    // scale; a rect crossing the viewport edge must fail, not silently return a
    // narrower crop.
    const viewBox = await call('eval', { expression: '({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })' })
    const view = viewBox.result
    const rectShot = await call('screenshot', { rect: { x: 10, y: 10, width: 300, height: 200 } })
    const rectBytes = Buffer.from(rectShot.pngBase64 ?? '', 'base64')
    const rectDims = rectBytes.length >= 24 ? { width: rectBytes.readUInt32BE(16), height: rectBytes.readUInt32BE(20) } : { width: 0, height: 0 }
    check(
      'rect shot uses one device scale and reports it',
      Math.abs(rectDims.width - Math.round(300 * view.dpr)) <= 3 &&
        Math.abs(rectDims.height - Math.round(200 * view.dpr)) <= 3 &&
        Number.isFinite(rectShot.scale),
      JSON.stringify({ dims: rectDims, dpr: view.dpr, scale: rectShot.scale }),
    )
    const badRect = await call('screenshot', { rect: { x: view.width - 20, y: 10, width: 300, height: 200 } })
      .then(() => '', (error) => String(error?.message ?? error))
    check('rect beyond the viewport fails instead of truncating', /extends beyond|BAD_ARGUMENT/.test(badRect), badRect)
    const frameShot = await call('screenshot', { selector: '#inner', frame: '0', scale: 1 })
    check(
      'screenshot captures an element inside a frame',
      frameShot.pngBase64?.length > 300 && typeof frameShot.frameId === 'string',
      JSON.stringify({ bytes: frameShot.pngBase64?.length, frameId: frameShot.frameId }),
    )
    const native = await call('imageSource', { selector: '#cv' })
    check('imageSource reads canvas size', native.width === 240 && native.height === 90, `${native.width}x${native.height}`)
    const inline = await call('imageSource', { selector: '#inline-png' })
    check(
      'imageSource reads an inline data URL',
      inline.mime === 'image/png' && inline.base64?.length > 20 && inline.source.startsWith('data:image/png'),
      JSON.stringify({ mime: inline.mime, bytes: inline.base64?.length, source: inline.source }),
    )
    const markup = await call('html', { selector: '#cv', maxChars: 500 })
    check('html reads an element outerHTML', /<canvas[^>]*id="cv"/.test(markup.html ?? ''), markup.html?.slice(0, 120))

    // Burst capture: #mover glides for 1200ms, so a strip of frames must show
    // the motion in one labelled contact sheet.
    await call('click', { target: '#reset-mover' })
    const singleMove = await call('screenshot', { selector: '#mover', scale: 2 })
    await call('click', { target: '#move' })
    const burst = await call('screenshot', { selector: '#mover', scale: 2, frames: 4, intervalMs: 250, columns: 4 })
    check(
      'screenshot burst returns a labelled contact sheet',
      burst.frames === 4 &&
        burst.width >= burst.frameWidth * 4 &&
        burst.pngBase64?.length > singleMove.pngBase64?.length,
      JSON.stringify({ frames: burst.frames, size: `${burst.width}x${burst.height}`, frame: `${burst.frameWidth}x${burst.frameHeight}`, bytes: burst.pngBase64?.length }),
    )
    // Put #mover back at rest; the later settle test needs fresh motion.
    await call('click', { target: '#reset-mover' })

    // Background recording: the camera keeps rolling between tool calls, so a
    // click in the middle of the recording shows up as motion in the strip.
    // Deterministic motion: drive the fixture between tool calls instead of
    // racing an animation, so the check measures the recorder rather than the
    // compositor speed of whatever machine runs it.
    await call('click', { target: '#reset-mover' })
    const census = await call('record', { action: 'probe', selector: '#mover', scale: 2, maxFrames: 4 })
    const frameMs = Math.max(Number(census?.medianMs) || Number(census?.frameMs) || 400, 80)
    // One surface capture can cost a second on a loaded box, so size both the
    // window and the expectation from the machine's own frame time.
    const budgetMs = Math.min(Math.max(Math.round(frameMs * 6), 1500), 15000)
    const expected = Math.max(1, Math.min(4, Math.floor(budgetMs / frameMs) - 1))
    const recStart = await call('record', { action: 'start', selector: 'body', scale: 0.5, tileScale: 0.25, intervalMs: 120, maxFrames: 14 })
    // The fixture's own flash control animates the page between tool calls; the
    // bridge only clicks it, so nothing here writes to the DOM.
    await call('click', { target: '#flash' })
    for (let step = 1; step <= 4; step += 1) {
      await call('click', { target: '#move' }).catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, Math.round(budgetMs / 4)))
    }
    const mid = await call('record', { action: 'status' })
    const recorded = await call('record', { action: 'stop', columns: 4 })
    // Surface capture drops frames when the box is loaded, so a thin strip is retried once
    // before the check is allowed to fail.
    let finalRecorded = recorded
    if (finalRecorded.frames < expected) {
      await call('record', { action: 'start', selector: 'body', scale: 0.5, tileScale: 0.25, intervalMs: 100, maxFrames: 30 })
      for (let flash = 0; flash < 4; flash += 1) {
        await call('click', { target: '#flash' })
      }
      finalRecorded = await call('record', { action: 'stop', columns: 4 })
    }
    check(
      'record captures frames across tool calls',
      // What matters is that the recorder kept working between tool calls and returned a
      // usable strip: several distinct frames spanning real time. The exact frame count
      // is a function of how loaded this machine is, so it is reported, not asserted.
      recStart.recording === true &&
        (finalRecorded.received ?? expected) >= 2 &&
        finalRecorded.frames >= 2 &&
        finalRecorded.width >= finalRecorded.frameWidth * 0.5 &&
        finalRecorded.pngBase64?.length > 500,
      JSON.stringify({ frames: finalRecorded.frames, expected, spanMs: finalRecorded.spanMs, frameMs, received: finalRecorded.received ?? mid?.received, size: `${finalRecorded.width}x${finalRecorded.height}` }),
    )

    // A recording left armed by an earlier run must not lock this one out.
    await call('record', { action: 'stop' }).catch(() => undefined)
    // Viewport emulation is a loan: it exists only while a recording is armed.
    // A tab left at the emulated size is the "the page changed resolution"
    // failure this guards against.
    // Recording must not change the page viewport at all: an emulated box
    // reflows the page, which is exactly what "the site changed resolution"
    // meant. Record at whatever size the window really is.
    const realView = (await call('eval', { expression: '({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio })' })).result
    const armed = await call('record', { action: 'start', selector: 'body', scale: 0.3, intervalMs: 150, maxFrames: 8 })
    const armedView = (await call('eval', { expression: '({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio })' })).result
    await new Promise((resolve) => setTimeout(resolve, 500))
    await call('record', { action: 'stop', columns: 2 })
    const afterStopView = (await call('eval', { expression: '({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio })' })).result
    check(
      'record leaves the page viewport untouched while armed',
      armed.recording === true && armedView.w === realView.w && armedView.h === realView.h && armedView.dpr === realView.dpr,
      JSON.stringify({ realView, armedView }),
    )
    check(
      'record stop leaves the viewport untouched',
      afterStopView.w === realView.w && afterStopView.h === realView.h && afterStopView.dpr === realView.dpr,
      JSON.stringify({ realView, afterStopView }),
    )

    // force:true replaces a leftover recording; it must not touch the viewport.
    const forced = await call('record', { action: 'start', selector: 'body', scale: 0.3, intervalMs: 150, maxFrames: 8, force: true })
    const forcedView = (await call('eval', { expression: '({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio })' })).result
    await new Promise((resolve) => setTimeout(resolve, 400))
    await call('record', { action: 'stop', columns: 2 }).catch(() => undefined)
    const afterForceView = (await call('eval', { expression: '({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio })' })).result
    check(
      'record force-start leaves the viewport untouched',
      forced.recording === true && forcedView.w === realView.w && forcedView.h === realView.h && afterForceView.w === realView.w && afterForceView.h === realView.h,
      JSON.stringify({ forcedView, afterForceView }),
    )

    // A screenshot of an off-screen element scrolls it into view for cropping;
    // the scroll position must be put back so a read never moves the view.
    await call('eval', { expression: 'window.scrollTo(0, 520)' })
    await new Promise((resolve) => setTimeout(resolve, 120))
    const topShot = await call('screenshot', { selector: 'h1', scale: 1 })
    const scrollAfterShot = (await call('eval', { expression: '({ x: Math.round(scrollX), y: Math.round(scrollY) })' })).result
    check(
      'screenshot restores the scroll position',
      topShot.width > 0 && scrollAfterShot.x === 0 && scrollAfterShot.y === 520,
      JSON.stringify({ scrollAfterShot }),
    )
    await call('eval', { expression: 'window.scrollTo(0, 0)' })
    await call('click', { target: '#reset-mover' })

    await call('click', { target: '#later' })
    const late = await call('waitFor', { selector: '#late-done', timeoutMs: 4000 })
    check('waitFor waits for a delayed element', late.matched === true, JSON.stringify(late))
    const gone = await call('waitFor', { selector: '#never-there', gone: true, timeoutMs: 1200 })
    check('waitFor gone accepts an absent element', gone.matched === true, JSON.stringify(gone))

    await call('click', { target: '#gate' })
    const enabled = await call('waitFor', { selector: '#late-btn', enabled: true, timeoutMs: 5000 })
    check('waitFor waits for a control to enable', enabled.matched === true && enabled.box != null, JSON.stringify(enabled))

    // Timed UIs need both half-steps inside one call: press the starter, then hit
    // the control the moment it becomes usable (this is what the reaction stages need).
    const oneCallPress = await call('waitFor', { firstSelector: '#gate', selector: '#late-btn', enabled: true, clickSelector: '#late-btn', timeoutMs: 6000 })
    const lateHits = await call('eval', { expression: "document.getElementById('late-hits').textContent" })
    check(
      'waitFor presses a starter and clicks the result in one call',
      oneCallPress.matched === true &&
        oneCallPress.pressedFirst != null &&
        oneCallPress.clicked != null &&
        Number(lateHits.result) >= 1,
      JSON.stringify({ pressedFirst: oneCallPress.pressedFirst, clicked: oneCallPress.clicked, hits: lateHits.result }),
    )

    // Batch clicks: every match at once, then repeated taps on one point, then a
    // hand-picked list of targets (the shapes the 144-tile grid needed).
    const bulkAll = await call('click', { target: '.bulk', all: true })
    const bulkAfterAll = await call('eval', { expression: "document.getElementById('bulk-out').textContent" })
    const bulkCount = await call('click', { target: '.bulk', count: 2 })
    const bulkAfterCount = await call('eval', { expression: "document.getElementById('bulk-out').textContent" })
    const bulkTargets = await call('click', { targets: ['#bulk-1', '#bulk-2'] })
    const bulkAfterTargets = await call('eval', { expression: "document.getElementById('bulk-out').textContent" })
    check(
      'click all presses every match',
      bulkAll.matchedCount === 3 && Number(bulkAfterAll.result) === 3,
      JSON.stringify({ matchedCount: bulkAll.matchedCount, out: bulkAfterAll.result }),
    )
    check(
      'click count taps one point repeatedly',
      bulkCount.clicks === 2 && Number(bulkAfterCount.result) === 5,
      JSON.stringify({ clicks: bulkCount.clicks, out: bulkAfterCount.result }),
    )
    check(
      'click targets presses a list in order',
      bulkTargets.clicks === 2 && Number(bulkAfterTargets.result) === 7,
      JSON.stringify({ clicks: bulkTargets.clicks, out: bulkAfterTargets.result }),
    )
    await call('click', { target: '#move' })
    const settled = await call('waitFor', { selector: '#mover', stable: true, stableMs: 300, timeoutMs: 6000 })
    check('waitFor waits for motion to settle', settled.matched === true && settled.elapsedMs >= 500, JSON.stringify(settled))

    const frames = await call('frames', {})
    check('frames lists the iframe', (frames.frames ?? []).some((f) => String(f.url ?? '').includes('fixture-inner')), JSON.stringify(frames.frames))
    const innerRead = await call('eval', { frame: '0', expression: "document.getElementById('inner')?.textContent" })
    check('eval reads inside a child frame', innerRead.result === 'INNER-FRAME', JSON.stringify(innerRead))
    const innerAnalyze = await call('eval', {
      frame: '0',
      expression: "(() => { const el = document.getElementById('inner'); const d = el.ownerDocument.createElement('div'); d.textContent = 'FRAME-TOUCHED'; return d.textContent })()",
    })
    check('eval analyzes inside a child frame', innerAnalyze.result === 'FRAME-TOUCHED', JSON.stringify(innerAnalyze))
    const innerWriteDenied = await call('eval', { frame: '0', expression: "document.getElementById('inner').textContent = 'FRAME-TOUCHED'" }).then(() => '', (error) => String(error?.message ?? error))
    check('eval cannot write inside a child frame', /READ_ONLY/.test(innerWriteDenied), innerWriteDenied)
    const innerStill = await call('eval', { frame: '0', expression: "document.getElementById('inner')?.textContent" })
    check('the child frame text is unchanged', innerStill.result === 'INNER-FRAME', JSON.stringify(innerStill))
    const badFrame = await call('eval', { frame: 'no-such-frame', expression: '1' }).catch((error) => ({ error: String(error?.message ?? error) }))
    check('eval reports an unknown frame', /FRAME_NOT_FOUND/.test(badFrame.error ?? ''), badFrame.error)
    const frameClick = await call('click', { frame: '0', target: '#inner-btn' })
    const innerOut = await call('eval', { frame: '0', expression: "document.getElementById('inner-out')?.textContent" })
    check('click reaches a button inside a frame', innerOut.result === 'INNER-CLICKED', JSON.stringify({ frameClick, innerOut }))
    const frameType = await call('type', { frame: '0', target: '#inner-in', text: 'via frame' })
    const innerMirror = await call('eval', { frame: '0', expression: "document.getElementById('inner-mirror')?.textContent" })
    check('type reaches a field inside a frame', innerMirror.result === 'via frame', JSON.stringify({ frameType, innerMirror }))
    const frameHover = await call('hover', { frame: '0', target: '#inner-hover' })
    const innerHoverOut = await call('eval', { frame: '0', expression: "document.getElementById('inner-hover-out')?.textContent" })
    check('hover reaches a target inside a frame', innerHoverOut.result === 'INNER-HOVERED', JSON.stringify({ frameHover, innerHoverOut }))
    check('frame hover reports a string frame id', typeof frameHover.frameId === 'string' && frameHover.frameId.length > 0, JSON.stringify(frameHover.frameId))
    await call('click', { target: '#gate' })
    const exprWait = await call('waitFor', { expression: '!document.querySelector("#late-btn").disabled', timeoutMs: 5000 })
    check('waitFor expression becomes true', exprWait.matched === true && exprWait.expressionValue === 'true', JSON.stringify(exprWait))
    const exprMiss = await call('waitFor', { expression: 'window.__neverSet === 42', timeoutMs: 700 })
    check('waitFor expression times out cleanly', exprMiss.matched === false, JSON.stringify(exprMiss))
    const frameSelect = await call('select', { frame: '0', target: '#inner-pick', value: 'iy' })
    const innerPickOut = await call('eval', { frame: '0', expression: "document.getElementById('inner-pick-out')?.textContent" })
    check('select works inside a frame', frameSelect.value === 'iy' && innerPickOut.result === 'iy', JSON.stringify({ frameSelect, innerPickOut }))
    const frameSet = await call('set', { frame: '0', target: '#inner-range', value: '64' })
    const innerRange = await call('eval', { frame: '0', expression: "document.getElementById('inner-range-out')?.textContent" })
    check('set works inside a frame', frameSet.frameId && innerRange.result === '64', JSON.stringify({ frameSet, innerRange }))
    const frameDrag = await call('drag', { frame: '0', target: '#inner-pad', toTarget: '#inner-pad', steps: 6 })
    const innerPad = await call('eval', { frame: '0', expression: "document.getElementById('inner-pad-out')?.textContent" })
    check('drag works inside a frame', frameDrag.frameId && /\d+,\d+/.test(String(innerPad.result)), JSON.stringify({ frameDrag, innerPad }))
    const deepList = await call('frames')
    check('frames lists the nested frame', (deepList.frames ?? []).some((f) => String(f.url ?? '').includes('fixture-deep')), JSON.stringify((deepList.frames ?? []).map((f) => f.url)))
    const deepClick = await call('click', { frame: 'fixture-deep', target: '#deep-btn' })
    const deepOut = await call('eval', { expression: "document.querySelector('#sub').contentDocument.querySelector('#deep').contentDocument.querySelector('#deep-out').textContent" })
    check('click reaches a button inside a nested frame', deepOut.result === 'DEEP-CLICKED', JSON.stringify({ deepClick, deepOut }))

    // inspect: one call turns a selector into rows the caller can reason about.
    const inspected = await call('inspect', { selector: '#scroll-zone span' })
    check(
      'inspect returns a row with its text',
      inspected.count === 1 && inspected.items?.[0]?.text === 'END-OF-SCROLL',
      JSON.stringify(inspected),
    )
    const inspectedState = await call('inspect', { selector: '#pick', state: true })
    check(
      'inspect reads a control value',
      inspectedState.items?.[0]?.kind === 'select-one' && /^(alpha|beta|gamma)$/.test(inspectedState.items?.[0]?.value ?? ''),
      JSON.stringify(inspectedState.items?.[0]),
    )
    const inspectedBox = await call('inspect', { selector: '#cv' })
    check(
      'inspect reports an element box',
      inspectedBox.items?.[0]?.w >= 200 && inspectedBox.items?.[0]?.h >= 80,
      JSON.stringify(inspectedBox.items?.[0]),
    )

    // pixels: an element as a grid of mean colours, for reading pictures numerically.
    const sampled = await call('pixels', { selector: '#cv', grid: 4 })
    check(
      'pixels samples a grid of colours',
      sampled.cols === 4 &&
        sampled.rows >= 1 &&
        sampled.cells?.[0]?.length === 4 &&
        sampled.cells.flat().every((cell) => typeof cell.lum === 'number' && cell.lum >= 0 && cell.lum <= 255),
      JSON.stringify({ size: `${sampled.width}x${sampled.height}`, cols: sampled.cols, rows: sampled.rows }),
    )

    // sheet: a labelled contact sheet of element captures, with paging.
    const sheeted = await call('sheet', { selector: '#cv', limit: 1, columns: 1, scale: 1 })
    check(
      'sheet tiles an element capture',
      sheeted.count === 1 &&
        sheeted.tileWidth >= 200 &&
        sheeted.pngBase64?.length > 500 &&
        sheeted.tiles?.length === 1 &&
        typeof sheeted.tiles[0].lum === 'number' &&
        typeof sheeted.tiles[0].bright === 'number',
      JSON.stringify({ count: sheeted.count, tile: `${sheeted.tileWidth}x${sheeted.tileHeight}`, bytes: sheeted.pngBase64?.length }),
    )
    const pagedSheet = await call('sheet', { selector: 'button', offset: 2, limit: 2, columns: 2, scale: 1 })
    check(
      'sheet pages past the first matches',
      pagedSheet.count === 2 && pagedSheet.offset === 2 && pagedSheet.pngBase64?.length > 300,
      JSON.stringify({ count: pagedSheet.count, offset: pagedSheet.offset }),
    )

    // network: capture real traffic and filter it by URL.
    await call('network', { action: 'start', limit: 40 })
    await call('click', { target: '#fetch-api' })
    const netAll = await call('network', { action: 'log', limit: 20 })
    const netFiltered = await call('network', { action: 'log', filter: 'extension-meta', limit: 20 })
    const netMissed = await call('network', { action: 'log', filter: 'zzz-no-such-path', limit: 20 })
    check('network captures the fetch', (netAll.entries ?? []).length > 0, `${(netAll.entries ?? []).length} entries`)
    check(
      'network filter keeps only the matching call',
      netFiltered.matched > 0 &&
        (netFiltered.entries ?? []).length > 0 &&
        (netFiltered.entries ?? []).every((entry) => String(entry.url ?? '').includes('extension-meta')),
      JSON.stringify({ matched: netFiltered.matched, total: netFiltered.total }),
    )
    check(
      'network filter reports no match cleanly',
      netMissed.matched === 0 && netMissed.capturing === true,
      JSON.stringify({ matched: netMissed.matched, capturing: netMissed.capturing }),
    )
    await call('network', { action: 'stop' })

    // Opening for automation must not raise the window or steal the active tab,
    // and a hidden tab must still be capturable without being activated.
    const bg = await call('open', { url: FIXTURE, newTab: true })
    const bgList = await call('tabs', {})
    const bgTab = bgList.tabs?.find((t) => t.tabId === bg.tabId)
    check('open defaults to a background tab', bgTab?.active === false, JSON.stringify(bgTab))
    const hiddenShot = await call('screenshot', { selector: 'h1', scale: 1 })
    check('hidden tab captures without activation', hiddenShot.pngBase64?.length > 200, `${hiddenShot.pngBase64?.length} bytes`)
    const bgAfter = (await call('tabs', {})).tabs?.find((t) => t.tabId === bg.tabId)
    check('capture did not activate the hidden tab', bgAfter?.active === false, JSON.stringify(bgAfter))
    await call('closeTab', { tabId: bg.tabId })

    const tabs = await call('tabs', {})
    check('tabs list includes the fixture', tabs.tabs?.some((t) => t.tabId === tabId), JSON.stringify(tabs.tabs))
  } finally {
    await call('closeTab', { tabId }).catch(() => undefined)
    if (KEEP_TAB) await call('use', { tabId: KEEP_TAB }).catch(() => undefined)
  }

  for (const line of results) console.log(line)
  console.log(failures === 0 ? '\ne2e passed' : `\ne2e failed: ${failures} check(s)`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((error) => {
  for (const line of results) console.log(line)
  console.error(`\ne2e error: ${error?.message ?? error}`)
  process.exitCode = 1
})
