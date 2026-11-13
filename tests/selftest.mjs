/**
 * Transport self-test: plays one or two extensions with plain HTTP.
 *
 * Covers the parts that break without a browser: long-poll delivery, per-browser
 * routing, result matching, discovery and its origin gate, and liveness.
 * Run with `node tests/selftest.mjs`.
 */

import assert from 'node:assert/strict'
import { networkInterfaces } from 'node:os'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

import { Bridge } from '../bridge.js'
import { detectLabel } from '../extension/identity.js'

const PORT = 18791
const TOKEN = 'a'.repeat(64)
const BASE = `http://127.0.0.1:${PORT}/p/${TOKEN}`

const poll = (id, label = id, waitMs = 3000) =>
  fetch(`${BASE}/poll?waitMs=${waitMs}&id=${encodeURIComponent(id)}&label=${encodeURIComponent(label)}`)
const state = async () => (await fetch(`${BASE}/state`)).json()

const bridge = new Bridge({ port: PORT, token: TOKEN })
await bridge.start()

try {
  // 1. Nothing paired yet.
  await assert.rejects(() => bridge.send('read', {}, { timeoutMs: 1000 }), (error) => error.code === 'NO_BROWSER')
  console.log('ok  not-connected fails fast')

  // 1b. The tool layer wraps the bridge in a Proxy (to translate one worker
  // message). A property read through a proxy runs getters with `this` = proxy,
  // and every `#private` read inside throws — which is exactly how bsb_browsers
  // shipped broken once. Static greps cannot see this, so call the tool.
  {
    const { registerTools } = await import('../tools.js')
    const registered = new Map()
    const ctx = {
      effect: (fn) => fn(),
      tools: { register: (definition) => registered.set(definition.name, definition) },
    }
    registerTools(ctx, bridge)
    const browsers = registered.get('bsb_browsers')
    assert.ok(browsers, 'registerTools registered nothing')
    const value = await browsers.execute({})
    assert.equal(value.active, '', 'bsb_browsers lost the active-browser getter')
    assert.ok(Array.isArray(value.browsers), 'bsb_browsers lost the browser list method')
    console.log('ok  tools reach the bridge through its proxy')
  }

  // 2. Wrong token is indistinguishable from a missing route.
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/p/${'b'.repeat(64)}/hello`)).status, 404)
  console.log('ok  wrong token → 404')

  // 2b. The route adapter must produce what BOTH harness webserver generations
  // dispatch. 0.2.2+ accepted `{ resource }`; 0.2.1-rc.5 calls
  // `route.handler(req, res)` unconditionally, so a resource-only route
  // registers and then throws on first request — the server's guard answers an
  // empty 400 that looks like "not serving its web routes". Drive a real
  // handler against a fake Node response and assert the bytes.
  {
    const { toHandler } = await import('../http-adapter.js')
    const call = async (resource, { method = 'GET', url = '/x', headers = {} } = {}) => {
      const seen = { headers: {}, body: null, status: null, destroyed: false }
      const res = {
        headersSent: false,
        setHeader(name, value) { seen.headers[name.toLowerCase()] = value },
        writeHead(status) { seen.status = status; this.headersSent = true },
        end(body) { seen.body = body ?? null },
        destroy() { seen.destroyed = true },
      }
      await toHandler(resource, 'test')({ method, url, headers }, res)
      return seen
    }
    const json = await call(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    assert.equal(json.status, 200, 'adapter lost the status')
    assert.equal(json.headers['content-type'], 'application/json', 'adapter lost a response header')
    assert.deepEqual(JSON.parse(String(json.body)), { ok: true }, 'adapter lost the body')

    // A throwing route must name itself instead of falling through to the
    // server's anonymous 400.
    const broken = await call(async () => { throw new Error('boom') })
    assert.equal(broken.status, 500, 'a failing route is no longer distinguishable')
    assert.match(String(broken.body), /"route":"test"/, 'the failure does not name the route')

    // Web resources are GET/HEAD only; anything else is a client error.
    const posted = await call(async () => new Response('nope'), { method: 'POST' })
    assert.equal(posted.status, 405, 'adapter accepts methods it should reject')
    console.log('ok  routes register as handlers every webserver version dispatches')
  }

  // 3. Identity and discovery.
  const hello = await (await fetch(`${BASE}/hello`)).json()
  assert.equal(hello.name, 'browser-bridge')
  const discovered = await (await fetch(`http://127.0.0.1:${PORT}/discover`)).json()
  assert.equal(discovered.pairingUrl, BASE)
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/discover`, { headers: { origin: 'https://example.com' } })).status, 403)
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/discover`, { headers: { origin: 'chrome-extension://abc' } })).status, 200)
  console.log('ok  discovery + origin gate')

  // 4. A poll without an id is rejected: commands are addressed, never broadcast.
  assert.equal((await fetch(`${BASE}/poll?waitMs=1000`)).status, 400)
  console.log('ok  poll requires a browser id')

  // 5. Two browsers attach; a command for A never reaches B.
  const pollA = poll('browser-a', 'Chrome on Windows').then((response) => response.json())
  const pollB = poll('browser-b', 'Edge on Windows', 800).then((response) => response.status)
  await new Promise((resolve) => setTimeout(resolve, 150))
  const commandA = bridge.send('click', { target: '#go' }, { browser: 'browser-a', timeoutMs: 5000 })
  const deliveredA = await pollA
  assert.equal(deliveredA.method, 'click')
  console.log('ok  commands route to the addressed browser')

  // 6. State lists both, with A active.
  const snapshot = await state()
  assert.equal(snapshot.browsers.length, 2)
  assert.equal(snapshot.active, 'browser-a')
  assert.equal(snapshot.browsers.find((b) => b.id === 'browser-b').label, 'Edge on Windows')
  console.log('ok  state lists both browsers')

  // 7. Result settles the call it belongs to.
  await fetch(`${BASE}/result`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ id: deliveredA.id, browser: 'browser-a', ok: true, result: { url: 'https://example.com', title: 'Example' } }),
  })
  assert.equal((await commandA).title, 'Example')
  assert.equal(await pollB, 204, 'B must not receive A command')
  console.log('ok  result settles the call; B never saw it')

  // 8. An unknown browser is a coded error, not a silent redirect.
  await assert.rejects(
    () => bridge.send('read', {}, { browser: 'nope', timeoutMs: 1000 }),
    (error) => error.code === 'UNKNOWN_BROWSER',
  )
  console.log('ok  unknown browser rejected')

  // 9. Browser-side errors keep their code.
  const pollAgain = poll('browser-a').then((response) => response.json())
  await new Promise((resolve) => setTimeout(resolve, 150))
  const failing = bridge.send('click', { target: '#missing' }, { browser: 'browser-a', timeoutMs: 2000 })
  const second = await pollAgain
  await fetch(`${BASE}/result`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ id: second.id, browser: 'browser-a', ok: false, error: { code: 'TARGET_NOT_FOUND', message: 'no element' } }),
  })
  await assert.rejects(() => failing, (error) => error.code === 'TARGET_NOT_FOUND' && error.message === 'no element')
  console.log('ok  browser error keeps its code')

  // 10. A parked long poll counts as connected.
  const held = poll('browser-c', 'Firefox on Linux', 8000)
  await new Promise((resolve) => setTimeout(resolve, 5100))
  assert.equal(bridge.connected, true, 'an open poll means connected')
  assert.equal((await state()).browsers.find((b) => b.id === 'browser-c').connected, true)
  await held
  console.log('ok  open poll keeps the connection alive')

  // 11. Idle poll → 204, and the browser stays listed as not connected.
  assert.equal((await fetch(`${BASE}/poll?waitMs=1000&id=browser-a`)).status, 204)
  console.log('ok  idle poll → 204')

  // 12. LAN discovery: the token is withheld from remote peers unless opted in.
  const lan = Object.values(networkInterfaces()).flat().find((entry) => entry && entry.family === 'IPv4' && !entry.internal)
  if (lan) {
    const strict = new Bridge({ host: '0.0.0.0', port: PORT + 1, token: TOKEN, advertise: lan.address })
    await strict.start()
    try {
      const remote = await (await fetch(`http://${lan.address}:${PORT + 1}/discover`)).json()
      assert.equal(remote.needsLink, true)
      assert.equal(remote.pairingUrl, undefined)
      console.log('ok  LAN discovery withholds the token by default')
    } finally {
      strict.dispose()
    }

    const open = new Bridge({ host: '0.0.0.0', port: PORT + 2, token: TOKEN, advertise: lan.address, allowRemotePairing: true })
    await open.start()
    try {
      const remote = await (await fetch(`http://${lan.address}:${PORT + 2}/discover`)).json()
      assert.equal(remote.pairingUrl, `http://${lan.address}:${PORT + 2}/p/${TOKEN}`)
      console.log('ok  LAN discovery hands out the advertised address when opted in')
    } finally {
      open.dispose()
    }
  } else {
    console.log('skip LAN checks: no non-loopback IPv4')
  }

  // The host and the extension must agree on command names; a typo here shows up
  // as "unknown method" only when a real browser runs the command.
  const toolsSource = await readFile(new URL('../tools.js', import.meta.url), 'utf8')
  const workerSource = await readFile(new URL('../extension/sw.js', import.meta.url), 'utf8')
  const bridgeSource = await readFile(new URL('../bridge.js', import.meta.url), 'utf8')
  const sent = new Set([...toolsSource.matchAll(/bridge\.send\(\s*'([a-zA-Z]+)'/g)].map((match) => match[1]))
  const handled = new Set([...workerSource.matchAll(/case '([a-zA-Z]+)':\s*return/g)].map((match) => match[1]))
  const missing = [...sent].filter((method) => !handled.has(method))
  assert.deepEqual(missing, [], `tools call commands the worker does not handle: ${missing.join(', ')}`)
  assert.ok(handled.has('drag') && handled.has('key') && handled.has('waitFor') && handled.has('scroll'))
  console.log(`ok  all ${sent.size} tool commands are handled by the worker`)

  // Documentation drift guard: every registered tool must be listed in both the
  // README table and the SPEC command list, otherwise the repo claims less than
  // the plugin can do.
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
  const specPath = new URL('../docs/SPEC.md', import.meta.url)
  const spec = existsSync(specPath) ? await readFile(specPath, 'utf8') : null
  const toolNames = [...toolsSource.matchAll(/name: '(bsb_[a-z_]+)'/g)].map((match) => match[1])
  const undocumented = toolNames.filter((name) => !readme.includes(name) || (spec && !spec.includes(name)))
  assert.deepEqual(undocumented, [], `tools missing from README${spec ? '/SPEC' : ''}: ${undocumented.join(', ')}`)
  console.log(`ok  all ${toolNames.length} tools are listed in README${spec ? ' and SPEC' : ''}`)

  // Web-route guard: the dashboard routes (/browser-bridge/api/browsers and the
  // extension artifacts) must be registered through `ctx.inject`, which waits
  // for the webserver service to exist. A one-shot `ctx.get('webServer')` races
  // plugin startup: while the webserver fiber is not ACTIVE, `get` returns
  // undefined, the whole registration block is skipped, and every route 404s —
  // which the panel showed as "Unexpected end of JSON input" on an empty body.
  const hostSource = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(hostSource, /ctx\.inject\(\['webServer'\]/,
    "index.js must register its web routes through ctx.inject(['webServer'])")
  assert.doesNotMatch(hostSource, /ctx\.get\??\.\(\s*'webServer'\s*\)/,
    'index.js reads webServer with a one-shot ctx.get, which races startup')
  assert.ok(hostSource.includes("'/browser-bridge/api/browsers'"), 'index.js lost the /browser-bridge/api/browsers route')
  console.log('ok  web routes register through ctx.inject (no startup race)')

  // Architecture guard: model-supplied JavaScript runs in the guarded isolated
  // world by default; the page's own world is reachable only when the caller
  // explicitly asks for world:'main' (needed to read framework state such as a
  // Vue instance, which the isolated world cannot see).
  assert.ok(/const READ_ONLY_PRELUDE =/.test(workerSource), 'extension/sw.js has no read-only guard prelude')
  assert.ok(/async function guardedContext\(/.test(workerSource), 'extension/sw.js has no guarded context helper')
  const evalBody = workerSource.slice(workerSource.indexOf('async function evalPage'), workerSource.indexOf('async function evaluateProgram'))
  assert.ok(/guardedContext\(tabId/.test(evalBody), 'evalPage does not evaluate inside the guarded world')
  assert.ok(/useMain/.test(evalBody), 'evalPage has no opt-in main-world branch')
  assert.ok(/String\(world \|\| 'isolated'\) === 'main'/.test(evalBody), 'evalPage main world is not opt-in via world:"main"')
  const waitBody = workerSource.slice(workerSource.indexOf('async function waitForCore'), workerSource.indexOf('/** Resolve the optional click a wait fires'))
  assert.ok(/evaluateInContext\(tabId, probeContext, probe\)/.test(waitBody), 'waitForCore does not probe inside the guarded world')
  assert.ok(!/state = await evaluate\(tabId, probe\)/.test(waitBody), 'waitForCore still probes the main world')
  assert.ok(/enum: \['isolated', 'main'\]/.test(toolsSource), 'bsb_eval does not advertise the opt-in main world')
  console.log('ok  read-only architecture guard is wired into eval and waitFor')

  // Behaviour guards for the failures found while driving real pages. Each of
  // these was a silent failure — the tool reported success and the page simply
  // did not move — so they are pinned here rather than left to memory.
  assert.ok(/async function attachTab\(/.test(workerSource), 'sw.js lost the error-page attach recovery')
  assert.ok(/chrome-error/.test(workerSource), 'sw.js no longer recognises a parked error tab')
  assert.ok(/function mapAreaAt\(/.test(workerSource), 'sw.js lost the image-map area resolver')
  assert.ok(/function followMapArea\(/.test(workerSource), 'sw.js lost the image-map navigation fallback')
  assert.ok(/async function ensureTyped\(/.test(workerSource), 'sw.js lost the typed-value verification')
  assert.ok(/async function preprocessPng\(/.test(workerSource), 'sw.js lost capture preprocessing')
  assert.ok(/preprocess: args\?\.preprocess/.test(toolsSource), 'bsb_capture does not forward preprocess')
  assert.ok(/preprocess: \{/.test(toolsSource), 'bsb_capture does not document preprocess')
  console.log('ok  page-driving failure guards are pinned (attach, image maps, typing, preprocessing)')

  // Recording guards. A recording that under-samples, ignores the sheet layout
  // or never says what to do next wastes a whole tool call and misleads the
  // model, so each of those is pinned to the code that fixed it.
  assert.ok(/armed: true/.test(workerSource), 'armedRecording no longer marks the reply as armed')
  assert.ok(/next: 'act now/.test(workerSource), 'armedRecording does not say what to do next')
  assert.ok(/columns: clampInt\(params\.columns/.test(workerSource), 'recording no longer remembers the sheet layout from start')
  assert.ok(/wantedColumns/.test(workerSource), 'finishRecording ignores the remembered sheet layout')
  assert.ok(/maxMs: clampInt\(params\.maxMs/.test(workerSource), 'recording has no self-stop bound')
  assert.ok(/actualIntervalMs/.test(workerSource), 'recording no longer reports the cadence it actually achieved')
  assert.ok(/error: state\.error/.test(workerSource), 'recording no longer surfaces capture errors')
  assert.ok(/value\?\.armed === true/.test(toolsSource), 'renderCapture does not special-case the armed reply')
  assert.ok(/maxMs: \{ type: 'number'/.test(toolsSource), 'bsb_capture does not expose maxMs')
  console.log('ok  recording guards are pinned (armed reply, sheet layout, self-stop, cadence, errors)')

  // Forwarding guard: bsb_capture builds the record params from an explicit
  // list, so a documented parameter that is not in that list reaches the schema
  // and then vanishes. maxMs shipped broken exactly this way, and the same trap
  // exists on the reply side (the result whitelist). Assert both directions.
  {
    const schemaKeys = ['action', 'selector', 'scale', 'frame', 'mode', 'intervalMs', 'maxFrames', 'threshold', 'force', 'click', 'delayMs', 'quality', 'maxWidth', 'maxHeight', 'surface', 'beyond', 'columns', 'maxStrip', 'maxMs', 'keep', 'tileScale']
    const start = toolsSource.indexOf("'record',")
    const end = toolsSource.indexOf('{ browser, timeoutMs: TIMEOUT_MS }', start)
    const sendBlock = start >= 0 && end > start ? toolsSource.slice(start, end) : ''
    const missing = schemaKeys.filter((key) => sendBlock.indexOf(key + ':') === -1)
    assert.deepEqual(missing, [], 'bsb_capture documents record params it never forwards: ' + missing.join(', '))
    // The reply whitelist is an array of quoted names; armed is set separately.
    for (const key of ['next', 'actualIntervalMs', 'autoStopped', 'maxMs', 'columns', 'error', 'warning']) {
      assert.ok(toolsSource.indexOf("'" + key + "'") !== -1, 'bsb_capture reply whitelist lost ' + key)
    }
    assert.ok(/record\.armed = true/.test(toolsSource), 'bsb_capture drops the armed flag from the reply')
  }
  console.log('ok  record params and reply fields are all forwarded')

  // Friction guards for the second round of fixes. Each pins a capability that
  // was added because its absence cost a workaround.
  assert.ok(/tabId: hint/.test(workerSource), 'evalPage lost the tab hint')
  assert.ok(/detail, fields, tabId: hint/.test(workerSource), 'networkPage lost the brief projection inputs')
  assert.ok(/pass detail:"full"/.test(workerSource), 'network log no longer tells the caller how to get full detail')
  assert.ok(/saveTo/.test(toolsSource), 'bsb_eval lost saveTo')
  assert.ok(/PROMISE_RESULT/.test(workerSource), 'eval no longer rejects an un-awaited promise')
  assert.ok(/subtype === 'promise'/.test(workerSource), 'eval does not detect a promise RemoteObject')
  assert.ok(/awaitPromise:true/.test(toolsSource), 'bsb_eval does not tell callers to set awaitPromise')
  assert.ok(/SPILL_AT/.test(toolsSource), 'bsb_eval no longer spills large results to a file')
  assert.ok(/detail: \{ type: 'string', enum: \['brief', 'full'\]/.test(toolsSource), 'bsb_observe does not document detail')
  assert.ok(/fields: \{ type: 'array'/.test(toolsSource), 'bsb_observe does not document fields')
  console.log('ok  eval tab targeting, result spilling and network projection are pinned')

  // The friction ledger belongs to the maintainer workspace, not the public
  // plugin. Check it when present so both layouts pass.
  if (existsSync(new URL('../docs/FRICTION.md', import.meta.url))) console.log('ok  friction ledger present')

  // Every @font-face URL must resolve to a file that actually ships, and every
  // family the CSS references must be declared. A stale font reference is silent:
  // the popup still renders, just in the fallback face.
  {
    const html = await readFile(new URL('../extension/popup.html', import.meta.url), 'utf8')
    const referenced = [...html.matchAll(/url\('fonts\/([^']+)'\)/g)].map((m) => m[1])
    assert.ok(referenced.length > 0, 'popup declares no bundled font')
    for (const file of referenced) {
      assert.ok(
        existsSync(new URL(`../extension/fonts/${file}`, import.meta.url)),
        'popup references a font that is not bundled: fonts/' + file,
      )
    }
    const families = [...html.matchAll(/font-family: '([^']+)'/g)].map((m) => m[1])
    for (const family of new Set(families)) {
      assert.ok(
        html.includes(`var(--${family.toLowerCase().includes('serif') ? 'display' : 'sans'})`) || html.includes(family),
        'font-family ' + family + ' is declared but used nowhere',
      )
    }
  }
  console.log('ok  bundled fonts resolve and are wired')

  // Friction guards from the web-trobs build: physical key codes (games bind
  // event.code, not characters) and a diagnostic that names the likely cause.
  assert.ok(/specForCode/.test(workerSource), 'key resolver no longer understands physical event.code names')
  assert.ok(/MODIFIER_CODES/.test(workerSource), 'key resolver lost modifier keys')
  assert.ok(/has not polled for/.test(bridgeSource), 'the not-responding error lost its cause hint')
  console.log('ok  physical key codes and busy-browser diagnostics are pinned')

  // Captures no longer raise anything. A hidden tab is rendered with
  // captureBeyondViewport; forceActive is the only way to keep it animating, and
  // even that never touches the window.
  assert.ok(!/ensureVisible/.test(workerSource), 'capture still activates its tab')
  assert.ok(/captureBeyondViewport: true[\s\S]{0,240}hidden|hidden && !documentCrop/.test(workerSource), 'capture has no hidden-page path')
  assert.ok(!/chrome\.windows\.update\([^)]*focused/.test(workerSource), 'a window can still be raised')
  assert.ok(!/focusWindow/.test(workerSource), 'the focusWindow helper still exists')
  assert.ok(/TAB_NOT_VISIBLE', 'the browser window is minimised/.test(workerSource), 'a 0x0 viewport no longer asks the user to restore the window')
  console.log('ok  capture renders hidden tabs without raising a window')

  // Hold-to-mine: a click with holdMs must keep the button down, and every
  // click shape must forward it, or the tool reports success on a dead page.
  assert.ok(/async function pressAt\(tabId, point, count, button = 'left', holdMs = 0\)/.test(workerSource), 'pressAt lost holdMs')
  assert.ok(/if \(hold > 0\) await delay\(hold\)/.test(workerSource), 'pressAt no longer holds the button')
  assert.ok(/const holdMs = typeof args\?\.holdMs === 'number'/.test(toolsSource), 'bsb_act does not forward holdMs on click')
  console.log('ok  click honours holdMs (hold-to-mine)')

  // An agent editing extension UI must be able to see it: bsb_open rejects
  // chrome-extension://, so the worker exposes a path-scoped page opener.
  assert.ok(/async function openExtensionPage\(/.test(workerSource), 'worker lost the extension page opener')
  assert.ok(/chrome\.runtime\.getURL\(rel\)/.test(workerSource), 'extension page opener no longer resolves through getURL')
  assert.ok(/rel\.includes\('\.\.'\)/.test(workerSource), 'extension page opener lost its path traversal guard')
  console.log('ok  extension pages can be opened for inspection')

  // F5 never reaches the renderer, so reload needs a real primitive.
  assert.ok(/action === 'reload'/.test(workerSource), 'worker lost the tabs reload action')
  // Existence is not wiring: the handler can be perfect while the dispatcher
  // still calls it with no arguments, which is exactly how reload shipped dead.
  assert.ok(/case 'tabs': return listTabs\(params\)/.test(workerSource), 'tabs dispatcher does not forward params')
  assert.ok(/action === 'reload'/.test(toolsSource), 'bsb_tabs lost the reload action')
  // The schema promises tabId is optional for reload, and the worker honours that
  // by falling back to the tracked page; an early throw in the host made the
  // documented default unreachable.
  assert.ok(/if \(action === 'reload'\) \{\n\s*const params = \{ action: 'reload' \}/.test(toolsSource), 'bsb_tabs requires tabId for reload again')
  console.log('ok  tabs can be reloaded')

  // Replies must say what happens next, not just what happened. Three failures
  // in one session came from replies that were technically true: an armed
  // recording whose click was invisible, a zero-frame screencast with no reason,
  // and "call bsb_open first" when a tab was open but untracked.
  assert.ok(/value\?\.clickedText/.test(toolsSource), 'armed recording reply no longer reports the click it took')
  assert.ok(/explainRecordFailure\(/.test(toolsSource), 'capture lost the zero-frame explanation')
  assert.ok(/screencast only receives frames while the tab is visible/.test(toolsSource), 'zero-frame hint no longer names the visibility cause')
  assert.ok(/No page is tracked — run bsb_tabs action:"list"/.test(toolsSource), 'page-less failures no longer name the recovery path')
  console.log('ok  failures name the recovery path')

  // The bundle page's Connect button cannot reach the extension when dsh runs as
  // a desktop (Electron) app: that window has no chrome.runtime. The popup must
  // therefore carry its own pairing path, or a desktop user has no way at all.
  const popupSource = await readFile(new URL('../extension/popup.js', import.meta.url), 'utf8')
  const popupHtml = await readFile(new URL('../extension/popup.html', import.meta.url), 'utf8')
  // Internal pages cannot be driven (CDP refuses chrome://), so opening one is a
  // separate tab-strip-only path that must never adopt the tab.
  const sw = await readFile(new URL('../extension/sw.js', import.meta.url), 'utf8')
  assert.ok(/case 'openUrl'/.test(sw), 'the worker lost its internal-URL opener')
  // Smooth-scrolling sites broke every element-targeted press: scrollIntoView
  // animates, the rect beside it is stale, and the click lands offscreen as a
  // silent no-op.
  assert.ok(/behavior: 'instant'/.test(sw), 'boxOf lost its instant scroll')
  assert.ok(/TARGET_OFFSCREEN/.test(sw), 'an offscreen press is silent again')
  // A minimized window pauses the page's clock; input then queues silently.
  assert.ok(/async function pageHidden/.test(sw), 'the worker stopped reporting hidden tabs')
  // The opt-in escape hatch: off by default, never silent, and restorable.
  assert.ok(/async function forceActive/.test(sw), 'the forceActive escape hatch is gone')
  assert.ok(/setFocusEmulationEnabled\', \{ enabled: true \}/.test(sw), 'forceActive no longer enables focus emulation')
  assert.ok(/setWebLifecycleState\', \{ state: 'active' \}/.test(sw), 'forceActive no longer wakes the lifecycle')
  assert.ok(/FORCE_ACTIVE_NOTE/.test(sw), 'a forced call no longer says so')
  assert.ok(/async function clearForced/.test(sw), 'the focus override is no longer cleared')
  // Hold mode: the override must survive a call so the behaviour is observable,
  // and a per-call clear must never undo a held one.
  assert.ok(/async function releaseActive/.test(sw), 'hold mode cannot be released')
  assert.ok(/heldForced\.add/.test(sw) && /heldForced\.has\(tabId\)\) return/.test(sw), 'a per-call clear now cancels a held override')
  assert.ok(/case 'forceActive'/.test(sw) && /case 'releaseActive'/.test(sw), 'the hold actions left the command surface')
  // A hold is not a property of the browser: navigation drops the override while
  // the tab id survives, so reuse has to be checked against the page, and the
  // reply has to report the visibility it observed rather than the one it asked for.
  const stickyBody = sw.slice(sw.indexOf('async function forceActive'), sw.indexOf('async function releaseActive'))
  assert.ok(/heldForced\.has\(tabId\)/.test(stickyBody) && /document\.visibilityState/.test(stickyBody), 'a held override is trusted without reading the page')
  assert.ok(/heldForced\.delete\(tabId\)/.test(stickyBody), 'a stale hold is never dropped before re-applying')
  assert.ok(/visibility: visibility \?\? undefined/.test(stickyBody), 'a force reply stopped reporting the observed visibility')
  // A session that sat idle for hours can refuse both overrides once; a single
  // re-attach retry is what makes the hatch usable after that gap.
  assert.ok(/if \(!applied\.length\) \{[\s\S]{0,400}attachTab\(tabId\)/.test(stickyBody), 'a refused force has no re-attach retry')
  // A hold has to outlive the worker: MV3 restarts it, which used to drop both the
  // CDP override and this Set. The ids are mirrored into session storage and read
  // back before a hold is trusted.
  assert.ok(/chrome\.storage\.session\.set\(\{ \[HELD_KEY\]/.test(sw), 'held tabs are not persisted')
  assert.ok(/chrome\.storage\.session\.get\(HELD_KEY\)/.test(sw), 'a persisted hold is never restored')
  assert.ok(/await persistHeld\(\)/.test(sw), 'hold changes are not persisted')
  assert.ok(/enum: \['call', 'hold'\]/.test(toolsSource), 'bsb_act no longer offers hold mode')
  assert.ok(/args\?\.mode === 'hold' \? 'hold' : 'call'/.test(toolsSource), 'bsb_act stopped forwarding the hold mode')
    assert.ok(/forceActive: args\?\.forceActive === true/.test(toolsSource), 'forceActive is no longer forwarded')
  // The default has to stay neutral: attach must not force anything.
  assert.ok(/PAGE-NEUTRAL: no Emulation\.\* override is installed on attach/.test(sw), 'the page-neutrality note is gone')
  const attachBody = sw.slice(sw.indexOf('async function attach(tabId)'), sw.indexOf('async function attachTab'))
  assert.ok(!/setFocusEmulationEnabled|setWebLifecycleState/.test(attachBody), 'attach forces visibility again')
  assert.ok(/heldForced\.has\(tabId\)[\s\S]{0,120}forceActive\(tabId/.test(attachBody), 're-attaching to a held tab leaves the page frozen')
  // Reading a canvas by writing a PNG decoder is the friction this prevents: the
  // grid cannot address an isometric board, so the tool now takes exact points.
  assert.ok(/points: wanted/.test(sw) && /radius/.test(sw), 'bsb_pixels lost point sampling')
  assert.ok(/points: \{/.test(toolsSource), 'the bsb_pixels schema stopped advertising points')
  // A hex browser id written bare is invalid JSON, so the schema has to say it,
  // and the reader has to survive a numeric one.
  assert.ok(/MUST be quoted/.test(toolsSource), 'the browser argument stopped warning about quoting')
  assert.ok(/typeof value === 'number'/.test(toolsSource), 'stringArg no longer tolerates a numeric browser')
  // The schema accepting `points` is useless if execute drops it on the way out.
  assert.ok(/points: args\?\.points/.test(toolsSource), 'bsb_pixels accepts points but no longer forwards them')
  assert.ok(/HIDDEN_HINT/.test(sw), 'a queued-input hint is gone')
  assert.ok(/async function openUrl/.test(sw), 'openUrl is not implemented')
  // A refused adoption must not leave the tracked slot pointing at a page the
  // debugger cannot reach.
  {
    const fn = sw.slice(sw.indexOf('async function useExistingTab'), sw.indexOf('async function closePage'))
    assert.ok(fn.indexOf('await attach(tab.id)') < fn.indexOf('await trackId(tab.id)'), 'tab adoption tracks before it can attach')
  }
  assert.ok(/browser-internal scheme/.test(sw), 'openUrl stopped restricting schemes')
  assert.ok(/id="url"/.test(popupHtml), 'the popup lost its pairing field')
  assert.ok(/id="pair"/.test(popupHtml), 'the popup lost its Pair button')
  assert.ok(/type: 'refresh'/.test(popupSource), 'pairing from the popup no longer restarts the poll loop')
  // The design is one paste field, not a sweep with a list: Connect/Forget were
  // removed so the popup stays a badge with one action.
  assert.ok(!/id="discover"/.test(popupHtml) && !/id="forget"/.test(popupHtml), 'the removed Connect/Forget buttons came back')
  // One universal failure line plus a success line: the note must never go back
  // to per-cause sentences, and it must stay next to the field it reports on
  // rather than at the bottom of the section.
  // Failure is a state on the button, not a sentence to read; success still
  // speaks, because "it worked" has nothing visual to show.
  assert.ok(/failPairing/.test(popupSource), 'the popup lost its failure state')
  // The label is the build string and nothing else. Vendor and OS names were
  // removed on purpose: forks report "Google Chrome" whatever they are.
  {
    const real = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    const stub = (value) => Object.defineProperty(globalThis, 'navigator', { value, configurable: true })
    try {
      stub({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36', userAgentData: { brands: [], getHighEntropyValues: async () => ({ uaFullVersion: '157.0.8103.38' }) } })
      assert.equal(await detectLabel(), 'Chrome/157.0.8103.38', 'the exact build is not the label')
      stub({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36', userAgentData: { brands: [{ brand: 'Not-A.Brand', version: '99.0.0.0' }, { brand: 'Chromium', version: '157.0.8103.38' }], getHighEntropyValues: async () => ({}) } })
      assert.equal(await detectLabel(), 'Chrome/157.0.8103.38', 'a decoy brand leaked its fake version')
      stub({ userAgent: 'Mozilla/5.0 Chrome/157.0.0.0 Safari/537.36', userAgentData: undefined })
      assert.equal(await detectLabel(), 'Chrome/157.0.0.0', 'the UA fallback is gone')
      // The name is the browser's own token, so Edge does not get called Chrome
      // and does not borrow Chrome's version out of the same UA string.
      stub({ userAgent: 'Mozilla/5.0 Chrome/156.0.0.0 Safari/537.36 Edg/156.0.4314.58', userAgentData: undefined })
      assert.equal(await detectLabel(), 'Edg/156.0.4314.58', 'Edge is mislabelled')
      stub({ userAgent: 'Mozilla/5.0 Chrome/155.0.0.0 Safari/537.36 OPR/121.0.0.0', userAgentData: undefined })
      assert.equal(await detectLabel(), 'OPR/121.0.0.0', 'Opera is mislabelled')
      // A browser the code has never heard of must still be named by its own
      // token — no allowlist, no "Browser" fallback while a token exists.
      stub({ userAgent: 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 FooBrowser/2.1.3', userAgentData: undefined })
      assert.equal(await detectLabel(), 'FooBrowser/2.1.3', 'an unknown browser was not named from its token')
      stub({ userAgent: 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Vivaldi/6.8', userAgentData: undefined })
      assert.equal(await detectLabel(), 'Vivaldi/6.8', 'a Chromium fork was called Chrome')
    } finally {
      if (real) Object.defineProperty(globalThis, 'navigator', real)
      else delete globalThis.navigator
    }
  }
  assert.ok(/\.classList\.add\('is-error'\)/.test(popupSource), 'a failed pairing no longer marks the button')
  assert.ok(/@keyframes shake/.test(popupHtml), 'the shake keyframes are gone')
  assert.ok(/\.pair-row button\.is-error/.test(popupHtml), 'the red error state is unstyled')
  // Success is the flash alone now: no line, no tone, nothing to read.
  assert.ok(!/id="note"/.test(popupHtml), 'the success line came back')
  // The popup opens on the action: no masthead, no divider above it.
  assert.ok(!/id="who"/.test(popupHtml), 'the browser-name headline came back')
  assert.ok(!/^\s*\.name \{/m.test(popupHtml), 'the masthead style is still defined')
  assert.ok(/\.is-ok:hover/.test(popupHtml), 'hover can still repaint the success flash')
  // The light animates on demand, not forever.
  assert.ok(/pulseLamp/.test(popupSource), 'the light lost its burst trigger')
  assert.ok(/classList\.toggle\('live'/.test(popupSource), 'a status refresh can clobber the pulse again')
  assert.ok(!/animation: breathe 2\.8s[^;]*infinite/.test(popupHtml), 'the status light pulses forever again')
  // A stray `}` in a stylesheet is not a local typo: Chrome discards every rule
  // after it, so one dangling brace silently dropped the whole id band (and its
  // background) while the markup still looked fine. Assert balance instead.
  {
    const styleBody = popupHtml.slice(popupHtml.indexOf('<style>'), popupHtml.indexOf('</style>'))
    const withoutComments = styleBody.replace(/\/\*[\s\S]*?\*\//g, '')
    let depth = 0
    let broke = false
    for (const ch of withoutComments) {
      if (ch === '{') depth += 1
      else if (ch === '}') { depth -= 1; if (depth < 0) { broke = true; break } }
    }
    assert.equal(broke, false, 'popup.css has a stray closing brace — every rule after it is dropped')
    assert.equal(depth, 0, 'popup.css has an unclosed rule')
  }
  assert.ok(/\.band \{[^}]*background: var\(--band\)/.test(popupHtml), 'the id band lost its background')
  // The status light must animate only while something is happening.
  assert.ok(/@keyframes breathe/.test(popupHtml) && /@keyframes ping/.test(popupHtml), 'the status light lost its motion')
  assert.ok(/classList\.toggle\('warn'/.test(popupSource), 'the lamp lost its reconnecting state')
  assert.ok(/refreshStatus/.test(popupSource), 'the status light stopped refreshing')
  // And the page must send the exact endpoint, not let the extension guess a port.
  const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  assert.ok(/type: 'connect', endpoint/.test(clientSource), 'the page stopped sending the exact bridge endpoint')
  assert.ok(/message\?\.endpoint/.test(workerSource), 'the worker ignores the endpoint the page sends')
  console.log('ok  pairing works from the popup too, and the page sends an exact endpoint')

  // The endpoint panel exists so a blocked port is visible and changeable without
  // hand-editing a profile patch. Guard the wiring: the route, the page control,
  // and the rebind that keeps the old listener alive when the new port is taken.
  assert.ok(/path: '\/browser-bridge\/api\/port'/.test(hostSource), 'the host lost the port route')
  assert.ok(/methods: \['GET', 'POST'\]/.test(hostSource), 'the port route no longer accepts a POST')
  assert.ok(/x-browser-bridge/.test(hostSource), 'the port route lost its same-origin guard')
  assert.ok(/const setPort = async/.test(hostSource), 'the host lost the live rebind')
  // Ordering invariant: the replacement must be listening before the old one is
  // torn down, otherwise a failed move leaves the user with no endpoint at all.
  assert.ok(
    hostSource.indexOf('await next.start()') >= 0
      && hostSource.indexOf('await next.start()') < hostSource.indexOf('previous.dispose('),
    'the rebind disposes the old listener before the new one binds',
  )
  assert.ok(/readSettings\(/.test(hostSource), 'page settings are no longer read on start')
  const clientForPort = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  assert.ok(/api\/port/.test(clientForPort), 'the plugin page lost the port control')
  assert.ok(/x-browser-bridge/.test(clientForPort), 'the page does not send the same-origin header')
  // The endpoint moved inside the Connected browsers card: one row, not a
  // section of its own, so the page does not open on port jargon.
  assert.ok(/function EndpointBar\(/.test(clientForPort), 'the endpoint row is gone')
  assert.ok(!/h\(Endpoint\)/.test(clientForPort), 'a separate Endpoint card came back')
  // The pairing link is the manual route for a DSH desktop app, where the page
  // has no chrome.runtime to hand an extension anything.
  assert.ok(/Pairing link/.test(clientForPort), 'the manual pairing-link button is gone')
  // A promise that was not kept: the handler used to set "Copied" after a failed
  // clipboard write, and navigator.clipboard does not exist off localhost.
  assert.ok(/isSecureContext/.test(clientForPort), 'copy no longer checks for a secure context')
  assert.ok(/execCommand\('copy'\)/.test(clientForPort), 'the synchronous copy fallback is gone')
  assert.ok(/setCopied\(ok\)/.test(clientForPort), 'copy reports success unconditionally again')
  assert.ok(/copyFailed/.test(clientForPort), 'a failed copy is silent again')
  // One connect control, not two: it lives in the browser card, next to the
  // pairing link it is the alternative to. The Install card only hands out the
  // build.
  {
    const install = clientForPort.slice(clientForPort.indexOf('function Install('), clientForPort.indexOf('function EndpointBar('))
    assert.ok(!/Connect this browser/.test(install), 'the Install card grew a second connect button')
  }
  // And no failure prose: red + shake is the message, the reason goes to the console.
  {
    const card = clientForPort.slice(clientForPort.indexOf('function Browsers('), clientForPort.indexOf('function connectButton('))
    assert.ok(!/Could not connect/.test(card), 'a connect error sentence came back')
    assert.ok(!/is not open\./.test(card), 'a blocked-port sentence came back')
    assert.ok(!/'Applied'/.test(card), 'the Applied message came back')
    const applyButton = clientForPort.slice(clientForPort.indexOf('function bushy('), clientForPort.indexOf('function Browsers('))
    assert.ok(/#16a34a/.test(applyButton), 'the Apply button lost its success flash')
    assert.ok(!/Applying…/.test(card), 'the busy label came back and will blink')
    // The rule is about the status dot, not about buttons: Apply and the pairing
    // copy both use the same red-and-shake refusal language on purpose.
    const endpointBar = clientForPort.slice(clientForPort.indexOf('function EndpointBar('), clientForPort.indexOf('function bushy('))
    assert.ok(!/bb-shake/.test(endpointBar), 'the endpoint dot shakes again')
    assert.ok(/bb-pulse/.test(endpointBar), 'the endpoint dot stopped pulsing while busy')
  }
  const discovery = await readFile(new URL('../extension/discovery.js', import.meta.url), 'utf8')
  assert.ok(/8791 \+ index|8791, 8792/.test(discovery), 'extension discovery no longer sweeps the default window')
  assert.ok(/pairWithUrl/.test(popupSource), 'the popup lost the pasted pairing URL path')
  // The unslop pass: grid rhythm, weight, one data size, a flat lamp ring, and
  // no invented barcode on an unpaired popup.
  assert.ok(/padding: 12px 16px/.test(popupHtml), 'the popup header left the 4px grid')
  assert.ok(!/margin: 0 -1px/.test(popupHtml), 'the -1px overhang is back')
  assert.ok(/gap: 8px/.test(popupHtml), 'the data rows left the 4px grid')
  assert.ok(!/0 0 8px var\(--ok-glow\)/.test(popupHtml), 'the lamp glow is back')
  assert.ok(!/ok-glow/.test(popupHtml), 'an unused glow token came back')
  assert.ok(!/font: 500 12px\/1\.55/.test(popupHtml), 'body weight is doing hierarchy again')
  assert.ok(/is-empty/.test(popupHtml) && /is-empty/.test(popupSource), 'the empty band draws invented bars again')
  // A port move disposes the old listener; it must not report that as a plugin
  // unload, and it must let dispatched commands settle first.
  assert.ok(/await previous\.drain\(/.test(hostSource), 'the rebind no longer drains in-flight commands')
  assert.ok(/code: 'REBOUND'/.test(hostSource), 'the rebind no longer names its reason')
  assert.ok(/async drain\(ms = 1500\)/.test(bridgeSource), 'the transport lost its drain')
  assert.ok(/dispose\(reason = \{\}\)/.test(bridgeSource), 'dispose no longer takes a reason')
  console.log('ok  a port move drains in-flight commands and names the real reason')

  // Naming guard: the plugin was renamed from dsh-web-bridge. A stale name in
  // the source means a route, env var or artifact that no longer resolves.
  // The only allowed mention is the one-time token migration, which has to name
  // the old directory to find an existing pairing token.
  const stale = []
  const sources = [['index.js', hostSource], ['client.js', await readFile(new URL('../client.js', import.meta.url), 'utf8')], ['bridge.js', await readFile(new URL('../bridge.js', import.meta.url), 'utf8')], ['tools.js', toolsSource], ['extension/sw.js', workerSource]]
  for (const [label, source] of sources) {
    const offenders = source.split('\n').filter((line) => /web-bridge/i.test(line) && !/legacy/i.test(line))
    if (offenders.length) stale.push(label + ': ' + offenders[0].trim().slice(0, 60))
  }
  assert.deepEqual(stale, [], `stale web-bridge references in: ${stale.join(', ')}`)
  assert.ok(/legacy/.test(await readFile(new URL('../bridge.js', import.meta.url), 'utf8')), 'bridge.js lost the legacy token migration')
  console.log('ok  no stale web-bridge references in source')


  // Page-neutrality guard: the bridge must not change what the page believes
  // about itself. An earlier build forced focus emulation plus an "active" web
  // lifecycle so timing-sensitive pages kept running in background tabs; that
  // silently altered site behaviour (visibility, focus, animation cadence) and
  // is exactly what the frontend-neutral contract forbids.
  //
  // Two of those calls now exist again, but only inside the named forceActive
  // escape hatch, which a caller has to ask for by name for one call. The rule
  // is therefore positional: these names must not appear anywhere else, and the
  // attach path in particular must never reach them.
  const FORBIDDEN_ANYWHERE = [
    'addScriptToEvaluateOnNewDocument',
    'Page.addStyleTag',
    'DOM.setOuterHTML',
    'DOM.setAttributeValue',
  ]
  const regressions = FORBIDDEN_ANYWHERE.filter((needle) => workerSource.includes(needle))
  assert.deepEqual(regressions, [], `extension/sw.js changes page state: ${regressions.join(', ')}`)
  const GATED = ['setFocusEmulationEnabled', 'setWebLifecycleState']
  const forceStart = workerSource.indexOf('async function forceActive')
  // clearForced also touches these, and it is part of the same hatch: the region
  // allowed to name them runs from forceActive to the end of clearForced.
  const forceEnd = workerSource.indexOf('async function ensureLayout')
  assert.ok(forceStart > 0 && forceEnd > forceStart, 'the forceActive escape hatch is gone')
  const outside = workerSource.slice(0, forceStart) + workerSource.slice(forceEnd)
  const escaped = GATED.filter((needle) => outside.includes(needle))
  assert.deepEqual(escaped, [], `these calls escaped the opt-in hatch: ${escaped.join(', ')}`)
  const attachRegion = workerSource.slice(
    workerSource.indexOf('async function attach(tabId)'),
    workerSource.indexOf('async function attach(tabId)') + 1600,
  )
  assert.ok(!GATED.some((needle) => attachRegion.includes(needle)), 'attach forces page visibility again')
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'))
  assert.ok(!manifest.content_scripts, 'the extension must not register content scripts')
  assert.ok(!manifest.web_accessible_resources, 'the extension must not expose web-accessible resources')
  assert.ok(!('scripting' in (manifest.permissions ?? [])), 'the extension must not hold the scripting permission')
  console.log('ok  page-neutrality guard: no focus/lifecycle/viewport emulation, no content scripts')

  // CDP allowlist: the surface the worker may reach is reviewed explicitly, so a
  // new domain/method cannot appear without someone deciding it is safe. Methods
  // that mutate page state, inject scripts/CSS or emulate the environment are
  // absent by construction; input and observation are the only categories left.
  const CDP_ALLOWED = new Set([
    'DOM.describeNode', 'DOM.enable', 'DOM.getBoxModel', 'DOM.getDocument', 'DOM.getFrameOwner',
    'DOM.querySelector', 'DOM.setFileInputFiles',
    'Emulation.clearDeviceMetricsOverride',
    'Input.dispatchDragEvent', 'Input.dispatchKeyEvent', 'Input.dispatchMouseEvent',
    'Log.enable', 'Log.entryAdded',
    'Network.disable', 'Network.enable', 'Network.getResponseBody',
    'Network.loadingFailed', 'Network.loadingFinished', 'Network.requestWillBeSent', 'Network.responseReceived',
    'Page.bringToFront', 'Page.captureScreenshot', 'Page.createIsolatedWorld', 'Page.enable',
    'Page.getFrameTree', 'Page.getLayoutMetrics', 'Page.handleJavaScriptDialog',
    // Page.reload re-fetches the current document. It changes no page state a
    // navigation would not, and it is the only way to reload an extension page
    // (F5 is a browser accelerator that never reaches the renderer).
    'Page.javascriptDialogOpening', 'Page.loadEventFired', 'Page.navigate', 'Page.reload',
    'Page.screencastFrame', 'Page.screencastFrameAck', 'Page.startScreencast', 'Page.stopScreencast',
    'Runtime.consoleAPICalled', 'Runtime.enable', 'Runtime.evaluate', 'Runtime.exceptionThrown',
    // Reviewed for the forceActive escape hatch. They are the two overrides the
    // page-neutrality contract names, and they may only be reached from that
    // hatch, which the positional guard above enforces. A caller has to ask for
    // them by name, for one call, and the reply reports that it happened.
    'Emulation.setFocusEmulationEnabled', 'Page.setWebLifecycleState',
  ])
  const used = [...new Set([...workerSource.matchAll(/'(?:Page|Emulation|Runtime|Input|DOM|Network|Log|Target|Browser|Overlay|Security|Fetch|Storage|Tracing|Animation|Profiler|HeapProfiler)\.[A-Za-z]+'/g)].map((m) => m[0].slice(1, -1)))]
  const unreviewed = used.filter((method) => !CDP_ALLOWED.has(method))
  assert.deepEqual(unreviewed, [], `unreviewed CDP surface: ${unreviewed.join(', ')}`)
  console.log(`ok  CDP allowlist: ${used.length} reviewed methods, nothing that mutates page state`)

  // Host-side wiring: the tool catalog stays small. Visual capture (including
  // grids) lives in bsb_capture; image bytes are capture.native; the old
  // bsb_sheet/bsb_image/bsb_frames entries are deleted rather than left unused.
  const { registerTools } = await import('../tools.js')
  const registered = new Map()
  const fakeCtx = {
    tools: { register: (definition) => registered.set(definition.name, definition) },
    effect: (run) => run(),
  }
  let lastSend = null
  let sendResponse = null
  registerTools(fakeCtx, {
    send: async (method, params) => {
      lastSend = { method, params }
      return sendResponse
    },
  })
  for (const gone of ['bsb_sheet', 'bsb_image', 'bsb_frames']) {
    assert.ok(!registered.has(gone), gone + ' should be deleted, not left in the catalog')
  }
  const capture = registered.get('bsb_capture')
  assert.ok(capture, 'bsb_capture is registered')
  assert.ok(capture.parameters.properties.kind.enum.includes('sheet'), 'bsb_capture does not offer kind:"sheet"')
  assert.match(capture.parameters.properties.selector.description, /sheet/i)
  const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  const { mkdtemp, readFile: readFileAgain } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'bsb-sheet-'))
  sendResponse = {
    url: 'https://example.com/page',
    selector: 'label.tile',
    offset: 2,
    count: 3,
    columns: 2,
    tileWidth: 10,
    tileHeight: 8,
    tiles: [{ i: 3 }, { i: 4 }, { i: 5 }],
    pngBase64: pngBytes.toString('base64'),
  }
  const sheet = await capture.execute({ kind: 'sheet', selector: 'label.tile', offset: 2, limit: 3, columns: 2, saveDir: dir })
  assert.equal(lastSend.method, 'sheet')
  assert.equal(lastSend.params.selector, 'label.tile')
  assert.equal(lastSend.params.offset, 2)
  assert.equal(lastSend.params.limit, 3)
  assert.equal(lastSend.params.columns, 2)
  assert.equal(sheet.count, 3)
  assert.equal(sheet.tiles.length, 3)
  assert.match(sheet.files[0], /sheet-.*\.png$/)
  assert.deepEqual(await readFileAgain(sheet.files[0]), pngBytes)
  const sheetText = capture.output.render({ kind: 'sheet' }, sheet).map((block) => block.text ?? '').join('\n')
  assert.match(sheetText, /sheet .*3 tiles/)
  console.log('ok  bsb_capture absorbed the contact sheet and the old tools are gone')

  // A selector taller than the viewport used to be cropped from a viewport shot
  // and arrive truncated. The worker must switch to a full-document shot when the
  // measured target does not fit, and crop with the scroll offset.
  assert.ok(/const fits = target\.x >= -1/.test(workerSource), 'element capture no longer checks whether the target fits the viewport')
  assert.ok(/documentCrop = \{ scroll, width: size\.width/.test(workerSource), 'element capture has no full-document fallback')
  assert.ok(/documentCrop\.scroll\.x/.test(workerSource) && /target\.x \+ surface\.x/.test(workerSource), 'full-document crop ignores the scroll offset')
  console.log('ok  an element taller than the viewport is captured whole')

  // A rect crossing the capture edge used to be clamped into a completely
  // different crop. It must fail with the bounds, and a bare rect must default
  // to 1x zoom and report the resulting px/CSS scale.
  assert.ok(/extends beyond the/.test(workerSource), 'rect capture no longer rejects out-of-bounds rects')
  assert.ok(/const scale = prep\.target && prep\.target\.width > 0/.test(workerSource), 'rect capture does not report its px/CSS scale')
  assert.ok(/hasSelector \? 2 : 1/.test(workerSource), 'bare-rect captures no longer default to 1x zoom')
  assert.ok(/scale: \{ type: 'number' \}/.test(toolsSource), 'bsb_capture output schema does not carry scale')
  console.log('ok  rect captures validate bounds and report their scale')

  // The playbook must ship inside the plugin: installing the bundle registers
  // `bsb-browser` into the skill catalog, with no project skill file to copy.
  const skillUrl = new URL('../skill/bsb-browser/SKILL.md', import.meta.url)
  assert.ok(existsSync(skillUrl), 'bundled bsb-browser skill is missing')
  const skillText = await readFile(skillUrl, 'utf8')
  assert.match(skillText, /^---\r?\n[\s\S]*?name: bsb-browser/, 'bundled skill has no bsb-browser frontmatter')
  const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  assert.ok(/readBundledSkill\(join\(here, 'skill', 'bsb-browser', 'SKILL\.md'\)\)/.test(indexSource), 'plugin does not load the bundled skill')
  assert.ok(/ctx\.inject\(\['skills'\]/.test(indexSource), 'plugin does not wait for the skill service')
  assert.ok(/skills\.register\(\{/.test(indexSource), 'plugin does not register the bundled skill')
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(packageJson.files.includes('skill/**'), 'package files omit the bundled skill')
  console.log('ok  the bsb-browser skill ships in the plugin and registers at load')

  // The dev fixtures live under tests/ and the host serves them from there.
  // A move back to the plugin root would break every dev/e2e route silently.
  {
    const fixtures = ['fixture.html', 'fixture-inner.html', 'fixture-deep.html', 'arcade.html']
    for (const file of fixtures) {
      assert.ok(existsSync(new URL(`../tests/${file}`, import.meta.url)), `dev fixture missing: tests/${file}`)
      assert.ok(packageJson.files.includes(`tests/${file}`), `package files omit tests/${file}`)
      assert.ok(indexSource.includes(`join(here, 'tests', '${file}')`), `index.js does not serve tests/${file}`)
    }
  }
  console.log('ok  dev fixtures live in tests/ and are served from there')

  // The skill and the tool surface are one model-facing contract.
  await import('./skill-align.mjs')

  console.log('\nself-test passed')
} finally {
  bridge.dispose()
}
