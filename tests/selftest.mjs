/**
 * Transport self-test: plays one or two extensions with plain HTTP.
 *
 * Covers the parts that break without a browser: long-poll delivery, per-browser
 * routing, result matching, discovery and its origin gate, and liveness.
 * Run with `node tests/selftest.mjs`.
 */

import assert from 'node:assert/strict'
import { homedir, networkInterfaces } from 'node:os'
import { join as joinPath } from 'node:path'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

import { Bridge, translateFilePath } from '../bridge.js'
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

  // A host path is not a browser path. The bridge runs in WSL and the browser
  // often runs on Windows; Chrome accepts a Linux path and attaches a zero-byte
  // file, so an import reports success over an empty sheet.
  {
    const windows = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    const linux = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'
    assert.equal(translateFilePath('/mnt/c/Users/HP Laptop/a.csv', windows), 'C:\\Users\\HP Laptop\\a.csv')
    assert.equal(translateFilePath('/tmp/a.csv', windows, 'Debian'), '\\\\wsl.localhost\\Debian\\tmp\\a.csv')
    assert.equal(translateFilePath('/tmp/a.csv', linux), '/tmp/a.csv')
    assert.equal(translateFilePath('C:\\Users\\a.csv', windows), 'C:\\Users\\a.csv')
    console.log('ok  host file paths are translated for a Windows browser')
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

  // 7b. A command whose caller stops waiting must not crash the host. Node
  // exits on an unhandled rejection, so a slow browser could take DSH down with
  // it. This test fires the send without awaiting it: if the rejection leaks,
  // the process dies before the assertion.
  {
    const pollT = poll('browser-timeout', 'Chrome on Windows', 3000)
    await new Promise((resolve) => setTimeout(resolve, 120))
    const orphan = bridge.send('upload', { target: '#x', files: ['/tmp/x.csv'] }, { browser: 'browser-timeout', timeoutMs: 150 })
    const delivered = await pollT.then((response) => response.json())
    assert.equal(delivered.method, 'upload')
    await new Promise((resolve) => setTimeout(resolve, 400))
    await orphan.catch(() => {})
    console.log('ok  an ignored timeout does not crash the host')
  }

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

  // 12. LAN discovery: a browser on another machine has to be able to pair, so
  // discovery hands out the pairing URL to any caller that passes the Origin
  // gate. There is no opt-in flag.
  const lan = Object.values(networkInterfaces()).flat().find((entry) => entry && entry.family === 'IPv4' && !entry.internal)
  if (lan) {
    const open = new Bridge({ host: '0.0.0.0', port: PORT + 2, token: TOKEN, advertise: lan.address })
    await open.start()
    try {
      const remote = await (await fetch(`http://${lan.address}:${PORT + 2}/discover`)).json()
      assert.equal(remote.pairingUrl, `http://${lan.address}:${PORT + 2}/p/${TOKEN}`)
      assert.equal(remote.needsLink, undefined)
      const page = await fetch(`http://${lan.address}:${PORT + 2}/discover`, { headers: { origin: 'https://example.com' } })
      assert.equal(page.status, 403)
      console.log('ok  LAN discovery hands out the pairing URL; the Origin gate still applies')
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

  // Packaging guard: the extension is ONE zip, packed on demand from extension/.
  // A .crx, an update manifest or a policy route would mean the packaging
  // contract regressed; a drifting id would orphan pairing and storage.
  {
    const { packExtension, ZIP_NAME } = await import('../scripts/pack-extension.mjs')
    const { mkdtempSync, readdirSync, readFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join: joinPath } = await import('node:path')
    const tmp = mkdtempSync(joinPath(tmpdir(), 'bsb-pack-'))
    try {
      const info = packExtension({ dist: tmp })
      assert.equal(info.id, 'pcmkkicdcomiljgbbbdnjknphlgibnno', 'the pinned extension id changed')
      assert.ok(info.rebuilt, 'the first pack did not build a zip')
      const zip = readFileSync(joinPath(tmp, ZIP_NAME))
      assert.equal(zip.subarray(0, 4).toString('hex'), '504b0304', 'the download is not a zip')
      for (const name of ['manifest.json', 'popup.html', 'sw.js', 'icons/icon16.png']) {
        assert.ok(zip.includes(Buffer.from(name)), `zip is missing ${name}`)
      }
      assert.ok(zip.includes(Buffer.from('"key"')), 'packed manifest lost the pinned public key')
      assert.deepEqual(readdirSync(tmp).sort(), [ZIP_NAME], 'packing left extra artifacts (crx/temp/meta)')
      assert.equal(packExtension({ dist: tmp }).rebuilt, false, 'a fresh zip is repacked on every call')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
    assert.ok(/packExtension\(\{ src: extensionDir, dist: dirname\(EXTENSION_ZIP\) \}\)/.test(hostSource),
      'index.js no longer packs the extension on download')
    assert.ok(!hostSource.includes('/browser-bridge/extension.crx'), 'index.js still serves a .crx route')
    assert.ok(!hostSource.includes('/browser-bridge/updates.xml'), 'index.js still serves an update manifest')
    assert.ok(!hostSource.includes('/browser-bridge/install-policy.reg'), 'index.js still serves the crx policy installer')
    console.log('ok  the extension ships as an on-demand zip (no crx, pinned id)')
  }

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

  // Navigation-state guards (BSB-20261115-2112 / 2205). A per-tab navigation
  // error is the LAST navigation, not a history: it must be replaced by a later
  // success, never merged forward, and it may only be reported against a
  // document that is actually failed. A document still parsing must not be
  // judged as an interstitial, because 0 chars/0 elements is its normal state.
  {
    const hintBody = workerSource.slice(workerSource.indexOf('function documentHint'), workerSource.indexOf('// Page functions'))
    assert.ok(/function documentIsHealthy\(state, requestedUrl\)/.test(workerSource), 'sw.js lost the healthy-document test')
    assert.ok(/function documentIsFailed\(state\)/.test(workerSource), 'sw.js lost the failed-document test')
    assert.ok(/documentIsHealthy\(state, requestedUrl\)/.test(hintBody), 'documentHint reports a cached failure against a healthy document')
    assert.ok(/if \(documentIsHealthy\(state, requestedUrl\)\) return undefined/.test(hintBody), 'documentHint no longer suppresses a stale navigation error')
    assert.ok(/readyState !== 'complete'/.test(hintBody), 'documentHint asserts a content verdict before readyState is complete')
    assert.ok(/no content verdict yet/.test(hintBody), 'documentHint has no loading-specific state')
    assert.ok(/state\.hasSplash === true/.test(hintBody) && /empty shell or interstitial/.test(hintBody), 'documentHint lost the complete-document splash/interstitial verdicts')
    const rememberBody = workerSource.slice(workerSource.indexOf('function rememberNav'), workerSource.indexOf('const navOutcome = (tabId)'))
    assert.ok(!/\.\.\.previous/.test(rememberBody), 'rememberNav merges the previous navigation outcome forward again')
    assert.ok(/navOutcomes\.set\(tabId, \{/.test(rememberBody), 'rememberNav no longer stores a per-tab outcome')
    const readBody = workerSource.slice(workerSource.indexOf('async function readPage'), workerSource.indexOf('const resolveTarget'))
    assert.ok(/documentIsHealthy\(state, outcome\.requestedUrl\)/.test(readBody), 'readPage no longer clears a stale cached navigation error')
    assert.ok(/documentIsFailed\(state\)/.test(readBody), 'readPage passes a cached navigationError without checking the current document')
    assert.ok(/navigationError: currentFailed \? outcome\?\.navigationError : undefined/.test(readBody), 'readPage forwards the cached error even when the document is healthy')
  }
  console.log('ok  nav-error clearing and the loading/no-verdict state are pinned')

  // Eval-target guards (BSB-20261115-2215). A reply must name the tab, world,
  // URL and visibility it answered for; undefined gets its own flag; a target
  // that cannot be evaluated fails with a typed error and a recovery route.
  {
    assert.ok(/function evalRecovery\(tabId, hidden\)/.test(workerSource), 'sw.js lost the eval recovery hint')
    assert.ok(/function evalUnavailable\(tabId, detail\)/.test(workerSource), 'sw.js lost the typed eval failure')
    assert.ok(/TAB_NOT_EVALUABLE/.test(workerSource) && /TAB_NOT_VISIBLE/.test(workerSource), 'eval failures lost their typed codes')
    assert.ok(/bsb_tabs \{action:"use", tabId/.test(workerSource), 'the eval failure no longer names bsb_tabs use with the tab')
    assert.ok(/forceActive:true/.test(workerSource), 'the eval failure no longer names forceActive')
    assert.ok(/if \(value === undefined\) return \{ \.\.\.extra, result: null, undefined: true \}/.test(evalBody), 'evalPage no longer marks an undefined result')
    assert.ok(/tabId,/.test(evalBody) && /visibility: String\(probe\.visibility/.test(evalBody), 'evalPage does not echo tabId/visibility')
    assert.ok(/world: useMain \? 'main' : 'isolated'/.test(evalBody), 'evalPage no longer echoes the world that answered')
    assert.ok(/frame && useMain/.test(evalBody) && /UNSUPPORTED/.test(evalBody), 'evalPage silently answers a frame-targeted main-world eval from the top frame')
    const programBody = workerSource.slice(workerSource.indexOf('async function evaluateProgram'), workerSource.indexOf('async function sheetPage'))
    assert.ok(/typeof remote\.type !== 'string'/.test(programBody), 'evaluateProgram still collapses "no evaluation result" into undefined')
    const guardedBody = workerSource.slice(workerSource.indexOf('async function guardedContext'), workerSource.indexOf('async function timelinePage'))
    assert.ok(/installed\?\.exceptionDetails/.test(guardedBody), 'guardedContext ignores a failed read-only prelude install')
    assert.ok(/READ_ONLY_PRELUDE/.test(guardedBody), 'guardedContext no longer installs the read-only prelude')
    const evalTools = toolsSource.slice(toolsSource.indexOf("name: 'bsb_eval'"), toolsSource.indexOf("name: 'bsb_open'"))
    assert.ok(/tabId: \{ type: 'number' \}/.test(evalTools), 'bsb_eval schema lost the tabId echo')
    assert.ok(/visibility: \{ type: 'string' \}/.test(evalTools), 'bsb_eval schema lost the visibility echo')
    assert.ok(/undefined: \{ type: 'boolean' \}/.test(evalTools), 'bsb_eval schema lost the undefined flag')
    assert.ok(/receipt\.visibility = raw\.visibility/.test(evalTools) && /receipt\.undefined = true/.test(evalTools), 'the bsb_eval spill receipt drops the target fields')
    const skillSource = await readFile(new URL('../skill/browser-bridge/SKILL.md', import.meta.url), 'utf8')
    assert.ok(/undefined:true/.test(skillSource), 'SKILL.md no longer documents the undefined eval result')
    assert.ok(/still loading/.test(skillSource), 'SKILL.md no longer documents the loading state')
    assert.ok(/stale/.test(skillSource), 'SKILL.md no longer documents cache clearing on a successful navigation')
  }
  console.log('ok  eval target echo, typed failures and the docs are pinned')

  // Reading guards from the SERP, Facebook timestamp and Sheets canvas tickets.
  // The rows reply used to leak inline script as text, drop every descendant
  // link, cut text without a marker and read a canvas app as an empty page; text
  // mode returned an anti-scrape timestamp as a column of one-character lines.
  {
    const inspectBody = workerSource.slice(workerSource.indexOf('async function inspectPage'), workerSource.indexOf('async function networkPage'))
    const snapshotBody = workerSource.slice(workerSource.indexOf('function snapshotPage'), workerSource.indexOf('function deepFindExpr'))
    assert.ok(/typeof el\.innerText === 'string'/.test(inspectBody), 'rows text still falls back past innerText')
    assert.ok(!/\.textContent/.test(inspectBody), 'rows text reads textContent again')
    assert.ok(/rec\.textTruncated = true/.test(inspectBody), 'a cut row text is unmarked again')
    assert.ok(/rec\.visible = false/.test(inspectBody), 'a zero-size row is not marked invisible')
    assert.ok(/el\.matches\('a\[href\]'\)/.test(inspectBody), 'rows href stopped keeping an anchor row own link')
    assert.ok(/querySelectorAll\('a\[href\]'\)/.test(inspectBody), 'rows href stopped resolving descendant anchors')
    assert.ok(/hrefSource = 'descendant'/.test(inspectBody), 'rows href stopped saying it came from a descendant')
    assert.ok(/reply\.canvasCount = canvases\.length/.test(inspectBody), 'a canvas-only page no longer reports its canvas count')
    assert.ok(/bsb_capture or bsb_pixels/.test(inspectBody), 'the empty rows hint no longer says how to read a canvas')
    assert.ok(/function snapshotPage\(maxChars, maxElements, normalize\)/.test(workerSource), 'snapshotPage lost the normalize argument')
    assert.ok(/\\u034F\\u200B-\\u200F\\u202A-\\u202E\\uFEFF/.test(snapshotBody), 'normalize stopped stripping the zero-width character set')
    assert.ok(/trimmed\.length === 1/.test(snapshotBody), 'normalize stopped joining one-character block lines')
    assert.ok(/const normalized = normalize === true \? normalizeText\(full\) : full/.test(snapshotBody), 'normalize no longer runs on the full text')
    assert.ok(/const truncated = normalized\.length > maxChars/.test(snapshotBody), 'normalize now runs after the maxChars cut')
    assert.ok(/normalized: true/.test(snapshotBody), 'a normalized reply is not marked')
    assert.ok(/normalize: \{ type: 'boolean'/.test(toolsSource), 'bsb_read does not document normalize')
    assert.ok(/normalize: args\?\.normalize === true/.test(toolsSource), 'bsb_read accepts normalize but no longer forwards it')
  }
  console.log('ok  read extraction guards pinned (descendant href, innerText only, truncation, canvas hint, normalize)')

  // Feed collection and redirect-resolution guards (tickets 2148/2149). Feed
  // mode exists so a caller stops hand-rolling scroll + wait + dedupe against a
  // virtualized list; resolve exists so a SERP harvest does not need one
  // navigation per result. Both are read-only: no DOM writes, no navigation, no
  // network request. The self-contained helpers are exercised in a VM; the
  // two that read a page get a small stub DOM instead of a browser.
  {
    const sourceOf = (name) => {
      const start = workerSource.indexOf('function ' + name + '(')
      assert.ok(start >= 0, 'extension/sw.js lost ' + name)
      const stop = workerSource.slice(start + 1).search(/\n(?:async )?function |\nconst |\n\/\*\*/)
      return workerSource.slice(start, stop > 0 ? start + 1 + stop : workerSource.length)
    }
    const resolverSrc = sourceOf('resolveRedirectHref')
    const collectSrc = sourceOf('feedCollect')
    const scrollSrc = sourceOf('feedScroll')
    const mergeSrc = sourceOf('feedMerge')
    const feedBody = sourceOf('feedPage')
    const load = (src) => new Function('return (' + src + ')')()
    const resolver = load(resolverSrc)

    // Redirect resolution: decode what is mechanically decodable, mark the rest
    // for navigation, never invent a target.
    assert.equal(resolver('https://example.com/post/1'), null, 'a plain href is treated as a redirector')
    assert.deepEqual(
      resolver('https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Fpost%3Fid%3D7&sa=t'),
      { resolved: true, hrefResolved: 'https://example.com/post?id=7', resolvableBy: 'decoded' },
      'google /url?q= is not decoded',
    )
    assert.equal(
      resolver('https://www.google.co.id/url?sa=t&url=https%3A%2F%2Fexample.org%2Fx')?.hrefResolved,
      'https://example.org/x',
      'google /url?url= is not decoded',
    )
    const payload = Buffer.from('https://example.net/a?b=>?', 'utf8').toString('base64')
    assert.equal(
      resolver('https://www.google.com/goto?url=' + encodeURIComponent(payload))?.hrefResolved,
      'https://example.net/a?b=%3E?',
      'google /goto standard base64 is not decoded',
    )
    const urlSafe = payload.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    assert.equal(
      resolver('https://www.google.com/goto?url=' + urlSafe)?.hrefResolved,
      'https://example.net/a?b=%3E?',
      'google /goto URL-safe unpadded base64 is not decoded',
    )
    assert.equal(
      resolver('https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.org%2Fp%2F9&h=AT0')?.hrefResolved,
      'https://example.org/p/9',
      'l.facebook.com/l.php is not decoded',
    )
    assert.deepEqual(resolver('https://t.co/AbCdEf123'), { resolved: false, resolvableBy: 'navigation' }, 't.co is given a guessed target')
    assert.deepEqual(resolver('https://www.google.com/goto?url=not-base64!!'), { resolved: false, resolvableBy: 'navigation' }, 'an undecodable goto payload is not marked for navigation')
    assert.deepEqual(resolver('https://www.google.com/url?q=javascript%3Aalert(1)'), { resolved: false, resolvableBy: 'navigation' }, 'a non-http payload is presented as a target')
    for (const [name, src] of [['resolveRedirectHref', resolverSrc], ['feedCollect', collectSrc], ['feedScroll', scrollSrc]]) {
      assert.ok(!/innerHTML|outerHTML\s*=|insertAdjacentHTML|appendChild|createElement|\.style\./.test(src), name + ' writes to the DOM')
      assert.ok(!/\.click\(|Page\.navigate|fetch\(|XMLHttpRequest/.test(src), name + ' navigates or touches the network')
    }

    // Feed: stable keys, one key once, recycled keys counted, cap honoured.
    const merge = load(mergeSrc)
    const state = {
      items: [],
      keys: new Set(),
      previousKeys: new Set(),
      recycledKeys: new Set(),
      duplicatesDropped: 0,
      recycled: 0,
      cap: 3,
    }
    assert.equal(merge(state, { items: [{ key: 'a' }, { key: 'b' }, { key: 'a' }] }), 2, 'feed merge did not collect two distinct keys')
    assert.equal(state.duplicatesDropped, 1, 'feed merge did not count an in-read duplicate')
    assert.equal(merge(state, { items: [{ key: 'b' }, { key: 'c' }] }), 1, 'feed merge did not add the new key')
    assert.equal(state.recycled, 1, 'feed merge did not report a key that vanished from the DOM')
    assert.equal(merge(state, { items: [{ key: 'd' }] }), 0, 'feed merge collected past the cap')
    assert.equal(state.items.length, 3, 'feed merge exceeded the cap')

    // Stub DOM: bind the page globals as closure parameters instead of faking a
    // whole browser. This pins key choice, placeholder skipping, viewport
    // visibility, the item box and nested-scroller discovery.
    const withPage = (src, scope) => {
      const names = Object.keys(scope)
      return new Function(...names, 'return (' + src + ')')(...names.map((key) => scope[key]))
    }
    const rect = (top) => ({ x: 0, y: top, width: 300, height: 100, top, bottom: top + 100, left: 0, right: 300 })
    const card = ({ text = '', href = '', links = [], top = 0 } = {}) => ({
      innerText: text,
      href,
      getAttribute: (name) => (name === 'href' ? href : null),
      matches: (selector) => selector === 'a[href]' && Boolean(href),
      querySelectorAll: (selector) => (selector === 'a[href]' ? links : []),
      getBoundingClientRect: () => rect(top),
      parentElement: null,
    })
    const cards = [
      card({ text: 'post one', href: 'https://example.com/p/1' }),
      card({ text: 'post two' }),
      card({ text: '' }),
      card({ text: 'post four', links: [card({ href: 'https://example.com/p/4' })] }),
      card({ text: 'below', href: 'https://example.com/p/5', top: 2000 }),
    ]
    const collect = withPage(collectSrc, {
      document: { querySelectorAll: () => cards },
      innerHeight: 800,
      innerWidth: 1200,
    })
    const snapshot = collect('[data-card]', 'auto')
    assert.equal(snapshot.matched, 5, 'feed collect lost a matched element')
    assert.equal(snapshot.unkeyed, 1, 'feed collect did not skip an unkeyed placeholder')
    assert.deepEqual(
      snapshot.items.map((item) => item.key),
      ['https://example.com/p/1', 'post two', 'https://example.com/p/4', 'https://example.com/p/5'],
      'feed collect keys are not href-else-text',
    )
    assert.deepEqual(snapshot.items.map((item) => item.visible), [true, true, true, false], 'feed collect visibility is not viewport-based')
    assert.deepEqual(snapshot.items[0].box, { x: 0, y: 0, width: 300, height: 100 }, 'feed collect lost the item box')
    assert.equal(collect('[data-card]', 'text').items[0].keySource, 'text', 'dedupeBy:"text" did not prefer text')
    const scroller = { clientHeight: 400, scrollHeight: 2000, scrollTop: 0, scrollBy: (_x, y) => { scroller.scrollTop += y } }
    const nestedCard = card({ text: 'nested' })
    nestedCard.parentElement = scroller
    const scroll = withPage(scrollSrc, {
      window: { scrollY: 0, scrollBy: () => { throw new Error('window scroller used for a nested feed') } },
      document: { documentElement: { scrollHeight: 5000, scrollTop: 0 }, querySelector: () => nestedCard },
      innerHeight: 800,
      getComputedStyle: (node) => ({ overflowY: node === scroller ? 'auto' : 'visible' }),
    })
    const moved = scroll('[data-card]')
    assert.equal(moved.scroller, 'ancestor', 'feed scroll did not find the nested scroller')
    assert.equal(moved.step, 320, 'feed scroll did not step 0.8 of the scroller height')
    assert.equal(moved.scrolled, true, 'feed scroll did not move the nested scroller')
    assert.ok(!/\.textContent/.test(collectSrc), 'feed text falls back past innerText')
    assert.ok(/keySource/.test(collectSrc) && /visible: inView/.test(collectSrc) && /box: \{ x: Math\.round/.test(collectSrc), 'feed items lost key/text/visible/box')
    assert.ok(/window\.scrollBy\(0,/.test(scrollSrc) && /innerHeight \* 0\.8/.test(scrollSrc), 'feed scroll no longer steps 0.8 of a viewport through the page scroller')
    assert.ok(/scrollTop/.test(scrollSrc) && /scrollHeight/.test(scrollSrc), 'feed scroll cannot find a nested scroller')
    assert.ok(/duplicatesDropped/.test(mergeSrc) && /recycled/.test(mergeSrc) && /previousKeys/.test(mergeSrc), 'feed merge lost its dedupe/recycle counters')
    assert.ok(/forceActive\(tabId, \{ mode: 'hold' \}\)/.test(feedBody), 'feed no longer holds the lifecycle for a hidden tab on request')
    assert.ok(/releaseActive\(tabId\)/.test(feedBody) && /!wasHeld/.test(feedBody), 'feed can release a hold it did not start')
    assert.ok(/await delay\(500 \+ Math\.floor\(Math\.random\(\) \* 200\)\)/.test(feedBody), 'feed no longer waits 500-700 ms per scroll step')
    assert.ok(/'max-items'/.test(feedBody) && /'until'/.test(feedBody) && /'no-growth'/.test(feedBody) && /'end-of-scroll'/.test(feedBody), 'the feed reason set is incomplete')
    assert.ok(/count: state\.items\.length/.test(feedBody), 'feed count is no longer the returned item count')
    assert.ok(/noGrowth >= 3/.test(feedBody), 'feed no longer stops after 3 steps with no new items')
    assert.ok(/scrolls \+= 1/.test(feedBody), 'feed no longer counts scroll steps')
    assert.ok(/dedupeBy must be "auto", "href" or "text"/.test(feedBody), 'feed no longer rejects an unknown dedupeBy')

    // Wiring: dispatcher, schema, forwarding and the embedded page-side resolver.
    assert.ok(/case 'feed': return feedPage\(params\)/.test(workerSource), 'the worker dispatcher lost the feed command')
    assert.ok(/resolveRedirectHref\.toString\(\)/.test(workerSource), 'rows mode no longer embeds the redirect resolver')
    assert.ok(/bridge\.send\('feed'/.test(toolsSource), 'bsb_read no longer sends the feed command')
    assert.ok(/enum: \['text', 'rows', 'html', 'feed'\]/.test(toolsSource), 'bsb_read does not offer the feed mode')
    assert.ok(
      /maxItems: \{ type: 'number'/.test(toolsSource)
      && /scroll: \{ type: 'boolean'/.test(toolsSource)
      && /dedupeBy: \{ type: 'string', enum: \['auto', 'href', 'text'\]/.test(toolsSource),
      'bsb_read feed schema lost maxItems/scroll/dedupeBy',
    )
    assert.ok(/until: \{ type: 'string'/.test(toolsSource) && /forceActive: \{ type: 'boolean'/.test(toolsSource), 'bsb_read feed schema lost until/forceActive')
    assert.ok(/resolve: \{ type: 'boolean'/.test(toolsSource) && /resolve: args\?\.resolve === true/.test(toolsSource), 'bsb_read rows schema lost resolve or stops forwarding it')
    assert.ok(/renderFeed/.test(toolsSource), 'bsb_read feed mode lost its renderer')
    const feedSkill = await readFile(new URL('../skill/browser-bridge/SKILL.md', import.meta.url), 'utf8')
    assert.ok(
      /mode:"feed"/.test(feedSkill) && /resolve:true/.test(feedSkill) && /resolvableBy/.test(feedSkill),
      'the skill no longer documents feed mode and redirect resolution',
    )
  }
  console.log('ok  feed collection and redirect-resolution guards pinned (dedupe, recycle, cap, reasons, decode, navigation marker)')

  // The friction ledger belongs to the maintainer workspace, not the public
  // plugin. Check it when present so both layouts pass.
  if (existsSync(new URL('../friction/FRICTION.md', import.meta.url))) console.log('ok  friction ledger present')

  // The reporter protocol has one source of truth: COPY_AGENTS.md. The
  // profile-local skill only triggers the habit and points at it, so the two
  // cannot drift into two different protocols. Checked only in the maintainer
  // workspace, because friction/ is not exported.
  if (existsSync(new URL('../friction/COPY_AGENTS.md', import.meta.url))) {
    const copyAgents = await readFile(new URL('../friction/COPY_AGENTS.md', import.meta.url), 'utf8')
    for (const status of ['open', 'triaged', 'fixing', 'needs-info', 'duplicate', 'awaiting-confirmation', 'closed']) {
      assert.ok(copyAgents.includes('`' + status + '`'), `COPY_AGENTS.md no longer documents the ${status} status`)
    }
    for (const field of ['result', 'confirmed_by', 'confirmed_at', 'build_tested']) {
      assert.ok(copyAgents.includes(field + ':'), `COPY_AGENTS.md no longer shows the ${field} confirmation field`)
    }
    assert.ok(/only you|Only you/u.test(copyAgents), 'COPY_AGENTS.md lost the reporter-only closure rule')
    assert.ok(/Verification requested/u.test(copyAgents), 'COPY_AGENTS.md lost the verification-request rule')
    assert.ok(!/\u2014/u.test(copyAgents), 'COPY_AGENTS.md contains an em dash')
    // Built from the home directory, not a literal path: the exporter rejects
    // absolute home paths in exported files.
    const skillPath = joinPath(homedir(), '.agents', 'skills', 'bsb-friction', 'SKILL.md')
    if (existsSync(skillPath)) {
      const skill = await readFile(skillPath, 'utf8')
      assert.ok(/friction\/COPY_AGENTS\.md/u.test(skill), 'the reporter skill no longer points at COPY_AGENTS.md')
      assert.ok(/only you|Only you/u.test(skill), 'the reporter skill lost the reporter-only closure rule')
      assert.ok(!/## Your ticket's life/u.test(skill), 'the reporter skill duplicates the lifecycle table instead of pointing at COPY_AGENTS.md')
    }
    console.log('ok  reporter protocol has one source of truth (COPY_AGENTS.md, skill points at it)')
  }

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

  // Hidden-page input guard. A background tab used to accept a click behind a
  // success-shaped reply: the browser held the event and replayed it later
  // against a DOM the caller had never seen. Every input action must now refuse
  // before dispatching, and a successful action must say where it was applied.
  {
    const bodyOf = (name) => {
      const start = workerSource.indexOf('async function ' + name + '(')
      assert.ok(start > 0, 'extension/sw.js lost ' + name)
      const next = workerSource.indexOf('\nasync function ', start + 1)
      return workerSource.slice(start, next > start ? next : workerSource.length)
    }
    for (const name of ['clickPage', 'hoverPage', 'keyPage', 'typePage', 'dragPage', 'dropPage', 'wheelPage']) {
      assert.ok(
        /requireInputVisibility\(tabId, '/.test(bodyOf(name)),
        name + ' can still dispatch input into a hidden page',
      )
    }
    const guard = bodyOf('requireInputVisibility')
    assert.ok(/fail\('TAB_NOT_VISIBLE'/.test(guard), 'a hidden page no longer fails with TAB_NOT_VISIBLE')
    assert.ok(/was not applied/.test(guard), 'a hidden refusal does not say nothing was applied')
    const hintBlock = workerSource.slice(
      workerSource.indexOf('const HIDDEN_HINT'),
      workerSource.indexOf('async function requireInputVisibility'),
    )
    assert.ok(
      /forceActive/.test(guard) && /mode:"hold"/.test(hintBlock) && /activate:true/.test(hintBlock),
      'a hidden refusal does not name the forceActive hold and bsb_tabs activate recovery paths',
    )
    assert.ok(/describePage/.test(guard) && /pageMeta/.test(guard), 'a hidden refusal does not name the page')
    assert.ok(/nothing will replay/.test(hintBlock), 'the hidden hint does not promise that input will not replay')
    assert.ok(!/is queued/.test(hintBlock), 'the hidden hint still describes input as queued')
    assert.ok(
      /applied: true/.test(workerSource) && /visibility === 'hidden'/.test(workerSource),
      'successful input replies no longer report applied/visibility',
    )
    assert.ok(
      (workerSource.match(/\.\.\.inputSuccess\(/g) ?? []).length >= 7,
      'an input action reply dropped its applied/visibility fields',
    )

    // type: validate the target, then verify the value actually changed.
    const typeBody = bodyOf('typePage')
    assert.ok(/requireEditableTarget\(/.test(typeBody), 'type no longer validates the target before typing')
    assert.ok(/TYPE_NOT_APPLIED/.test(typeBody), 'type no longer fails when the write did not land')
    const editable = bodyOf('requireEditableTarget')
    assert.ok(/NOT_VISIBLE/.test(editable) && /NOT_EDITABLE/.test(editable), 'target validation lost its typed errors')
    const offscreenHint = workerSource.slice(
      workerSource.indexOf('const OFFSCREEN_EDITOR_HINT'),
      workerSource.indexOf('async function requireEditableTarget'),
    )
    assert.ok(/offscreen measurer/.test(offscreenHint), 'the offscreen-target error does not name an offscreen measurer')
    assert.ok(/focus the visible editor first/.test(offscreenHint), 'the offscreen-target error does not tell the caller to focus the visible editor')
    assert.ok(
      /display is "none"/.test(editable) && /visibility is "hidden"/.test(editable),
      'target validation no longer distinguishes display:none and visibility:hidden',
    )
    assert.ok(/width <= 0 \|\| state\.height <= 0/.test(editable), 'target validation no longer rejects a zero-size box')

    // key text: tab/newline become real navigation keys and are counted.
    const keyBody = bodyOf('keyPage')
    assert.ok(
      /KEY_MAP\.Tab/.test(keyBody) && /KEY_MAP\.Enter/.test(keyBody),
      'key text no longer maps tab and newline to real key events',
    )
    assert.ok(/\btabs \+= 1/.test(keyBody) && /\benters \+= 1/.test(keyBody), 'key text no longer counts tabs and enters')
    assert.ok(
      /BAD_ARGUMENT/.test(keyBody) && /control character/.test(keyBody),
      'an unmappable control character is silently dropped again',
    )
    assert.ok(
      /rawTextArg/.test(toolsSource) && /text: rawTextArg\(args, 'text'\)/.test(toolsSource),
      'key text is trimmed before control characters can be mapped',
    )
    // The per-action opt-in has to reach the worker for every input action.
    for (const call of ["send('hover'", "send('type'", "send('drag'", "send('drop'", "send('wheel'"]) {
      const line = toolsSource.split('\n').find((text) => text.includes(call)) ?? ''
      assert.ok(
        /forceActive: args\?\.forceActive === true/.test(line),
        call + ') cannot opt into forceActive for one action',
      )
    }

    // capture: hidden tabs stay capturable, the reply says which state it saw,
    // and only a genuine 0x0 layout viewport fails.
    const shotBody = bodyOf('screenshotPage')
    assert.ok(/const hidden = visibility === 'hidden'/.test(shotBody), 'capture no longer reports the visibility it observed')
    assert.ok(/hidden, visibility/.test(shotBody), 'capture reply lost hidden/visibility')
    assert.ok(/0x0 layout/.test(shotBody), 'capture no longer fails a genuinely 0x0 layout viewport')
    assert.ok(
      /hidden: \{ type: 'boolean' \}/.test(toolsSource) && /visibility: \{ type: 'string' \}/.test(toolsSource),
      'bsb_capture schema lost hidden/visibility',
    )
    assert.ok(
      /record\.hidden = last\.hidden/.test(toolsSource) && /record\.visibility = last\.visibility/.test(toolsSource),
      'bsb_capture drops hidden/visibility before the reply',
    )

    const skillText = await readFile(new URL('../skill/browser-bridge/SKILL.md', import.meta.url), 'utf8')
    assert.ok(
      !/minimized 0×0 window is reported as `TAB_NOT_VISIBLE`/.test(skillText),
      'the skill still claims a minimized window capture fails',
    )
    assert.match(skillText, /hidden, background or minimized tab still captures/, 'the skill no longer documents hidden capture')
    assert.match(skillText, /TYPE_NOT_APPLIED/, 'the skill no longer documents the type verification failure')
  }
  console.log('ok  input refuses hidden pages and type/key/capture report what landed')

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

  // Navigation-truth guards. A failed navigation used to read as a loaded page:
  // bsb_open returned a success shape for a chrome-error document (HTTP 429),
  // bsb_tabs list advertised the requested URL, reload said reloaded:true on an
  // error page, and a wait burned its full timeout on a tab that could never
  // load. The fix is one outcome shape (requested vs document URL, HTTP status,
  // net error) plus a per-tab cache, carried by every navigation-reporting tool.
  assert.ok(/const navOutcomes = new Map\(\)/.test(workerSource), 'worker lost its per-tab navigation outcome cache')
  assert.ok(/function rememberNav\(tabId, outcome\)/.test(workerSource), 'navigation outcomes are no longer remembered')
  assert.ok(/const navOutcome = \(tabId\) =>/.test(workerSource), 'navigation outcomes are no longer readable per tab')
  assert.ok(/const isInternalUrl = \(url\) =>/.test(workerSource), 'worker no longer recognises browser-internal pages')
  assert.ok(/async function pageState\(tabId\)/.test(workerSource), 'worker lost the shared page-state probe')
  assert.ok(/function documentHint\(state,/.test(workerSource), 'worker lost the shell/error hint')
  assert.ok(/function stateSummary\(state\)/.test(workerSource), 'bsb_read state is not shaped from the probe')
  assert.ok(/navigated\?\.errorText/.test(workerSource), 'bsb_open drops the Page.navigate errorText')
  assert.ok(/autoNewTabReason/.test(workerSource), 'bsb_open does not report why it opened a new tab')
  assert.ok(/out\.autoNewTab = true/.test(workerSource), 'bsb_open no longer flags the automatic new tab')
  assert.ok(/requestedUrl: url,\n\s*documentUrl/.test(workerSource), 'bsb_open reply does not separate requested and document URLs')
  assert.ok(/readyState: state\?\.readyState \?\? 'unknown'/.test(workerSource), 'bsb_open reply lost readyState')
  assert.ok(/bodyTextLen: Number\(state\?\.bodyTextLen\)/.test(workerSource), 'bsb_open reply lost bodyTextLen')
  assert.ok(/elementCount: Number\(state\?\.elementCount\)/.test(workerSource), 'bsb_open reply lost elementCount')
  assert.ok(/const state = await pageState\(tabId\)\.catch/.test(workerSource), 'readPage does not probe the page state')
  assert.ok(/value\.state = stateSummary\(state\)/.test(workerSource), 'readPage replies lost the state block')
  assert.ok(/if \(hint\) value\.hint = hint/.test(workerSource), 'readPage replies lost the hint')
  // bsb_tabs: the real document URL and the failure markers, reload truth.
  assert.ok(/url: documentUrl,/.test(workerSource), 'tab rows no longer report the real document URL')
  assert.ok(/scriptable: !internal,/.test(workerSource), 'tab rows lost scriptable')
  assert.ok(/navigationFailed: true/.test(workerSource), 'a chrome-error tab is no longer marked as failed')
  assert.ok(/const reloaded = Boolean\(state\) && !failedDocument && !reloadError/.test(workerSource), 'reload no longer verifies the resulting document')
  assert.ok(/TAB_NOT_SCRIPTABLE/.test(workerSource), 'a browser-internal tab no longer fails with a typed error')
  // bsb_tabs use {activate:true} reports what the page saw.
  assert.ok(/const activated = activate !== false && !hidden/.test(workerSource), 'use no longer reports whether the page became visible')
  assert.ok(/visibility: view\?\.visibility \?\? 'unknown'/.test(workerSource), 'use no longer reports document visibility')
  assert.ok(/out\.window = \{ state: info\?\.state/.test(workerSource), 'use no longer reports the window state when activation failed')
  assert.ok(/out\.reason = minimized/.test(workerSource), 'use no longer says why a minimized window stayed hidden')
  // bsb_wait_for: cached URL matching, visibility condition, fast failure.
  assert.ok(/const wantVisible = \$\{visible === true \? 'true' : 'false'\};/.test(workerSource), 'waitForCore lost the visible condition')
  assert.ok(/matchedVisibility = el \?/.test(workerSource), 'waitForCore no longer measures match visibility')
  assert.ok(/const cachedUrlHit =/.test(workerSource), 'waitForCore does not compare the requested/document URL')
  assert.ok(/document\.title\.includes\(url\)/.test(workerSource), 'waitForCore no longer matches the page title')
  assert.ok(/failedAt >= 1200/.test(workerSource), 'waitForCore no longer fails fast on a known navigation error')
  assert.ok(/navigationError: errorNow/.test(workerSource), 'waitForCore fast failure does not carry the navigation error')
  // The tool surface must offer and render the new fields, not only the worker.
  assert.ok(/matchedVisibility: \{ type: 'string', enum: \['visible', 'hidden'\] \}/.test(toolsSource), 'bsb_wait_for output schema lost matchedVisibility')
  assert.ok(/visible: \{ type: 'boolean'/.test(toolsSource), 'bsb_wait_for does not document visible')
  assert.ok(/visible: args\?\.visible === true/.test(toolsSource), 'bsb_wait_for does not forward visible')
  assert.ok(/autoNewTab: \{ type: 'boolean' \}/.test(toolsSource), 'bsb_open output schema lost autoNewTab')
  assert.ok(/scriptable: \{ type: 'boolean' \}/.test(toolsSource), 'bsb_tabs row schema lost scriptable')
  assert.ok(/navigationError: \{ type: 'string' \}/.test(toolsSource), 'a tool output schema lost navigationError')
  assert.ok(/function renderTabs\(/.test(toolsSource), 'bsb_tabs lost its readable list renderer')
  assert.ok(/state: \$\{state\.readyState/.test(toolsSource), 'renderRead no longer shows the state line')
  assert.ok(/hint: \$\{value\.hint\}/.test(toolsSource), 'renderRead no longer shows the hint')
  assert.ok(/match visibility: \$\{value\.matchedVisibility\}/.test(toolsSource), 'bsb_wait_for render lost matchedVisibility')
  assert.ok(/navigation failed/.test(toolsSource), 'bsb_tabs render no longer marks a failed navigation')
  const navSkill = await readFile(new URL('../skill/browser-bridge/SKILL.md', import.meta.url), 'utf8')
  for (const field of ['requestedUrl', 'documentUrl', 'httpStatus', 'navigationError', 'autoNewTab', 'scriptable', 'activated', 'matchedVisibility', 'matchedBox', 'reloaded:false']) {
    assert.ok(navSkill.includes(field), 'the skill does not document ' + field)
  }
  assert.ok(/visible:true/.test(navSkill), 'the skill does not document the visible wait condition')
  console.log('ok  navigation truth is pinned (requested/document URL, HTTP status, net error, reload, visibility)')

  // Post-merge runtime fixes: a shadowed reload hint, a wait that could match a
  // failed document, and clip-aware text for anti-scrape timestamps.
  assert.ok(/let reloadHint/.test(workerSource) && !/let hint\n    if \(!reloaded\)/.test(workerSource),
    'bsb_tabs reload shadows the tabId hint again')
  assert.ok(/const documentFailed = state\?\.failedDocument/.test(workerSource)
    && /const okNow = !documentFailed && state\?\.selectorOk/.test(workerSource),
    'bsb_wait_for can report a failed document as matched')
  assert.ok(/visibleClippedText/.test(workerSource) && /replaceClippedRuns/.test(workerSource),
    'normalize lost clip-aware text extraction')
  console.log('ok  post-merge guards pinned (reload hint, failed wait, clip-aware normalize)')

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
    'Page.addStyleTag',
    'DOM.setOuterHTML',
    'DOM.setAttributeValue',
  ]
  const regressions = FORBIDDEN_ANYWHERE.filter((needle) => workerSource.includes(needle))
  assert.deepEqual(regressions, [], `extension/sw.js changes page state: ${regressions.join(', ')}`)
  // Document-start scripts are a second named escape hatch: a caller asks for
  // one explicitly, it runs in every new document, and it is page code by
  // design. It is allowed only inside evalInstall/evalRemove, never on attach.
  const INJECTION = ['addScriptToEvaluateOnNewDocument', 'removeScriptToEvaluateOnNewDocument']
  const injectStart = workerSource.indexOf('async function evalInstall')
  const injectEnd = workerSource.indexOf('async function execute(')
  assert.ok(injectStart > 0 && injectEnd > injectStart, 'the document-start escape hatch is gone')
  const outsideInjection = workerSource.slice(0, injectStart) + workerSource.slice(injectEnd)
  const escapedInjection = INJECTION.filter((needle) => outsideInjection.includes(needle))
  assert.deepEqual(escapedInjection, [], `document-start calls escaped their hatch: ${escapedInjection.join(', ')}`)
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
    'Input.dispatchDragEvent', 'Input.dispatchKeyEvent', 'Input.dispatchMouseEvent', 'Input.insertText',
    'Log.enable', 'Log.entryAdded',
    'Network.disable', 'Network.enable', 'Network.getResponseBody',
    'Network.loadingFailed', 'Network.loadingFinished', 'Network.requestWillBeSent', 'Network.responseReceived',
    'Page.bringToFront', 'Page.captureScreenshot', 'Page.createIsolatedWorld', 'Page.enable',
    'Page.getFrameTree', 'Page.getLayoutMetrics', 'Page.handleJavaScriptDialog',
    // Page.reload re-fetches the current document. It changes no page state a
    // navigation would not, and it is the only way to reload an extension page
    // (F5 is a browser accelerator that never reaches the renderer).
    'Page.javascriptDialogOpening', 'Page.loadEventFired', 'Page.navigate', 'Page.reload',
    // File-chooser interception is how upload reaches an input whose frame
    // document the tab cannot read: the browser reports the input's backend node
    // id, so no selector ever runs inside that document.
    'Page.fileChooserOpened', 'Page.setInterceptFileChooserDialog',
    'Page.screencastFrame', 'Page.screencastFrameAck', 'Page.startScreencast', 'Page.stopScreencast',
    'Runtime.consoleAPICalled', 'Runtime.enable', 'Runtime.evaluate', 'Runtime.exceptionThrown',
    // Reviewed for the forceActive escape hatch. They are the two overrides the
    // page-neutrality contract names, and they may only be reached from that
    // hatch, which the positional guard above enforces. A caller has to ask for
    // them by name, for one call, and the reply reports that it happened.
    'Emulation.setFocusEmulationEnabled', 'Page.setWebLifecycleState',
    // Document-start injection is the second named hatch. Only evalInstall and
    // evalRemove call these; the positional guard above keeps them there.
    'Page.addScriptToEvaluateOnNewDocument', 'Page.removeScriptToEvaluateOnNewDocument',
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
  // `browser-bridge` into the skill catalog, with no project skill file to copy.
  const skillUrl = new URL('../skill/browser-bridge/SKILL.md', import.meta.url)
  assert.ok(existsSync(skillUrl), 'bundled browser-bridge skill is missing')
  const skillText = await readFile(skillUrl, 'utf8')
  assert.match(skillText, /^---\r?\n[\s\S]*?name: browser-bridge/, 'bundled skill has no browser-bridge frontmatter')
  const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  assert.ok(/readBundledSkill\(join\(here, 'skill', 'browser-bridge', 'SKILL\.md'\)\)/.test(indexSource), 'plugin does not load the bundled skill')
  assert.ok(/ctx\.inject\(\['skills'\]/.test(indexSource), 'plugin does not wait for the skill service')
  assert.ok(/skills\.register\(\{/.test(indexSource), 'plugin does not register the bundled skill')
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(packageJson.files.includes('skill/**'), 'package files omit the bundled skill')
  console.log('ok  the browser-bridge skill ships in the plugin and registers at load')

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

  // An explicit tabId addresses a tab for one call. Adopting it silently moved
  // the tracked tab, so reading a second tab while driving the first retargeted
  // every later call (and would let one agent steal another's target).
  {
    const body = workerSource.slice(
      workerSource.indexOf('async function requirePage('),
      workerSource.indexOf('async function ', workerSource.indexOf('async function requirePage(') + 10),
    )
    assert.ok(body.length > 0, 'extension/sw.js lost requirePage')
    assert.ok(!/trackId\(/u.test(body), 'requirePage adopts an explicit tabId instead of addressing it for one call')
    console.log('ok  an explicit tabId does not move the tracked tab')
  }

  // Guards from the 2026-11-17 fleet batch. Each one is a reply that looked
  // successful while the page did something else.
  {
    assert.ok(/hit = Boolean\(at\) && \(at === el/.test(workerSource), 'boxOf no longer reports whether the point hits the element')
    assert.ok(/TARGET_COVERED/.test(workerSource) && /if \(box\.hit === false\)/.test(workerSource), 'a covered click no longer fails loudly')
    assert.ok(/applied: false, dispatched: true/.test(workerSource), 'a verified no-op still reports applied:true')
    assert.ok(/nextTracked/.test(workerSource) && /candidates\.find\(\(tab\) => tab\.active\)/.test(workerSource), 'closing the tracked tab no longer falls back to another tab')
    assert.ok(/inViewport: false/.test(workerSource) && /painted: false/.test(workerSource), 'pixels still returns a zero grid for an unpainted element')
    assert.ok(/skippedHidden/.test(workerSource) && /if \(!rendered\) \{ skippedHidden \+= 1; continue \}/.test(workerSource), 'feed still counts stale zero-size rows as items')
    assert.ok(/entry\.download = true/.test(workerSource) && /ERR_ABORTED/.test(workerSource), 'a download is still recorded as a failed request')
    assert.ok(/contentType: document\.contentType/.test(workerSource) && /rendered by a browser viewer/.test(workerSource), 'a PDF is still called an empty shell')
    assert.ok(/visible === true/.test(workerSource) && /is present but hidden/.test(workerSource), 'the wait hint still recommends visible:true to a caller who passed it')
    assert.ok(/frameContext\(tabId, frame\)/.test(workerSource) && /badInput/.test(workerSource), 'a framed key run is not probed in its frame, or badInput is not reported')
    assert.ok(/f\.name && f\.name === want/.test(workerSource), 'a srcdoc frame can no longer be resolved by name')
    assert.ok(/FILE_NOT_ON_BROWSER/.test(bridgeSource), 'a host path is still accepted for a remote browser')
    // A throw after the command promise is created orphans it; its timeout then
    // rejects with no handler and Node exits the whole host.
    {
      const sendBody = bridgeSource.slice(bridgeSource.indexOf('send(method'), bridgeSource.indexOf('async #waitLive'))
      const fileAt = sendBody.indexOf('FILE_NOT_ON_BROWSER')
      const resultAt = sendBody.indexOf('const result = new Promise')
      assert.ok(fileAt > 0 && resultAt > 0 && fileAt < resultAt, 'a validation throw can orphan the command promise and crash the host')
      assert.ok(/result\.catch\(\(\) => \{\}\)/.test(sendBody), 'the command promise is not marked handled')
    }
    console.log('ok  fleet-batch guards pinned (covered clicks, tracking fallback, pixels, feed skip, download, PDF, wait hint, frame key, remote paths)')
  }

  // Guards from the 2026-11-17 evening batch.
  {
    assert.ok(/badSelector/.test(workerSource) && /BAD_SELECTOR/.test(workerSource), 'a malformed timeline selector is still reported as no data')
    assert.ok(/samplesCollected/.test(workerSource) && /observedMs/.test(workerSource), 'timeline no longer reports the collected count and observed window')
    assert.ok(/showing \$\{shown\} of \$\{samples\.length\}/.test(toolsSource), 'the timeline renderer still hides its truncation')
    assert.ok(/recording: recorder\.done !== true/.test(workerSource) && /lastRecording/.test(workerSource), 'record status still reports a finished recording as live')
    assert.ok(/capture\(record\) \$\{state\}/.test(toolsSource), 'the record status line still omits liveness')
    assert.ok(/captureBeyondViewport: true/.test(workerSource) && /blank: blank > 0/.test(workerSource), 'sheet still crops black tiles for offscreen matches')
    assert.ok(/assertFilesReadable/.test(workerSource) && /FILE_NOT_READABLE/.test(workerSource), 'upload still accepts a 0-byte attachment')
    assert.ok(/frameContextId/.test(workerSource) && !/let frameContext[^I]/.test(workerSource), 'the key frame probe still shadows frameContext')
    console.log('ok  evening-batch guards pinned (timeline, record status, sheet tiles, upload size, frame probe)')
  }

  // LAN pairing and the dev routes are part of the host, not switches, and the
  // docs layout is part of the product.
  {
    const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8')
    const bridgeSource = await readFile(new URL('../bridge.js', import.meta.url), 'utf8')
    assert.ok(!/allowRemotePairing/.test(indexSource) && !/allowRemotePairing/.test(bridgeSource), 'LAN pairing is a flag again')
    assert.ok(!/devReload/.test(indexSource), 'the dev routes are a flag again')
    assert.ok(!/if \(devReload\)/.test(indexSource), 'the dev routes are still behind a condition')
    assert.ok(/\/browser-bridge\/api\/dev\/status/.test(indexSource), 'the dev status route is gone')
    assert.ok(!/Reload extension/.test(clientSource), 'the plugin page still has a reload button')
    assert.ok(!/chrome\.runtime\.sendMessage\([^)]*type: 'reload'/.test(clientSource), 'the plugin page still asks the extension to reload')
    assert.ok(existsSync(new URL('../docs/images', import.meta.url)), 'images/ is not under docs/')
    assert.ok(!existsSync(new URL('../images', import.meta.url)), 'a top-level images/ directory still exists')
    assert.ok(!existsSync(new URL('../design', import.meta.url)), 'design/ still exists')
    const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    assert.ok(!/allowRemotePairing|devReload/.test(patch), 'cordis.patch.yml still carries the fixed options')
    const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
    const spec = await readFile(new URL('../docs/SPEC.md', import.meta.url), 'utf8')
    assert.ok(!/^## How a command reaches the browser/m.test(readme), 'the command path is still in README')
    assert.ok(/^## 15\. Command path/m.test(spec), 'the command path is not in SPEC')
    assert.ok(!/docs\/SPEC\.md/.test(readme), 'README links to SPEC.md again')
    assert.ok(/github\.com\/C4Hy0\/dsh-browser-bridge/.test(readme), 'the CI badge does not point at the repository')
    console.log('ok  host behaviour, plugin page and docs layout pinned')
  }

  // Guards from the CaptchaWare run. Each of these was a silent failure or a
  // missing primitive that cost a workaround, so pin the contract: wheel input,
  // key-driven text, cross-origin frame reads, non-editable type targets,
  // document-start injection, and the tracked-browser default.
  assert.ok(/'wheel'/.test(toolsSource) && /mouseWheel/.test(workerSource), 'bsb_act lost wheel input')
  assert.ok(/sentKeys/.test(workerSource) && /keyDelayMs/.test(toolsSource), 'key text mode lost its report or delay')
  assert.ok(/FRAME_NOT_READABLE/.test(workerSource), 'bsb_read no longer fails loudly on a cross-origin frame')
  assert.ok(/cross-origin or out-of-process/.test(workerSource) && /frames this tab can read/.test(workerSource), 'frame read no longer distinguishes an unreachable frame from a missing one')
  assert.ok(/NOT_EDITABLE/.test(workerSource), 'type no longer refuses a non-editable target')
  assert.ok(/installOnNewDocument/.test(toolsSource) && /addScriptToEvaluateOnNewDocument/.test(workerSource), 'bsb_eval lost document-start injection')
  assert.ok(/const tracked = this\.activeBrowserId/.test(bridgeSource), 'browser resolution no longer prefers the tracked target')
  console.log('ok  CaptchaWare-run guards pinned (wheel, key text, frames, type, injection, browser default)')

  // Input-truth guards from the Docs, Sheets and Facebook tickets. Each field
  // below exists because its absence let a reply say "applied" while nothing
  // landed: text was cut at a silent cap, focus drifted to another control, a
  // chord lost its modifiers, or a text click contradicted the read that had
  // just returned the same string.
  {
    const bodyFrom = (name) => {
      const start = workerSource.indexOf('async function ' + name + '(')
      assert.ok(start > 0, 'extension/sw.js lost ' + name)
      const next = workerSource.indexOf('\nasync function ', start + 1)
      return workerSource.slice(start, next > start ? next : workerSource.length)
    }
    // 2202: the cap is higher, a cut run is marked, and a run into an editor is
    // verified against the document text it was supposed to change.
    assert.ok(/const KEY_TEXT_CAP = 5000/.test(workerSource), 'key text cap is not 5000 characters')
    const keyBody = bodyFrom('keyPage')
    for (const field of ['requestedKeys', 'sentKeys', 'droppedKeys', 'truncated']) {
      assert.ok(keyBody.includes(field), 'key text reply lost ' + field)
    }
    assert.ok(
      /keyTextVerification/.test(keyBody) && /EDITOR_LOST_TEXT/.test(workerSource) && /TEXT_NOT_APPLIED/.test(workerSource),
      'key text is no longer verified against the editor text',
    )
    assert.ok(
      /textLenBefore/.test(workerSource) && /textLenAfter/.test(workerSource) && /excerpt/.test(workerSource),
      'key text verification lost its before/after lengths or the excerpt',
    )
    assert.ok(
      /document\.activeElement/.test(workerSource) && /tag !== 'body'/.test(workerSource),
      'key text verification no longer keys off the focused element and skips a body/canvas page',
    )
    // 2202 follow-up: a canvas editor parks focus in an offscreen iframe, so the
    // editor probe never applies there. Google Docs keeps a live text mirror in
    // the navigation panel; measure it instead of returning no verification.
    assert.ok(
      /\.navigation-item-content/.test(workerSource) && /\.kix-wordhtmlgenerator-word/.test(workerSource),
      'key text verification lost the canvas-editor document mirror',
    )
    assert.ok(
      /source: mirror === null \? 'editor' : 'document-mirror'/.test(workerSource),
      'key text verification no longer names the measured source',
    )
    assert.ok(
      /textSource: before\.source/.test(workerSource) && /textVerified: false/.test(workerSource),
      'key text verification lost textSource or the unmeasurable-run note',
    )
    assert.ok(/const inView = Boolean\(rect\)/.test(workerSource), 'key text verification no longer skips an offscreen key shim')
    // 2212: a modifier named in keys is a real chord, not three bare keys.
    assert.ok(/function chordPlan/.test(workerSource) && /MODIFIER_KEY_BITS/.test(workerSource), 'keys:[...] lost its chord planner')
    assert.ok(/Control: \{ key: 'Control', code: 'ControlLeft'/.test(workerSource), 'bare modifier names are refused again')
    assert.ok(/modifiers: chordMask/.test(keyBody), 'a key reply does not report the chord mask')
    assert.ok(/eventFor\(step\.spec, 'keyDown', step\.mask\)/.test(workerSource), 'a chord key event lost its mask')
    // 2210: type names the element that actually holds focus and reports what
    // the field and the focus were after the write.
    const typeBody = bodyFrom('typePage')
    const editable = workerSource.slice(
      workerSource.indexOf('async function requireEditableTarget'),
      workerSource.indexOf('function typedValueDidNotLand'),
    )
    assert.ok(/NOT_FOCUSED/.test(editable), 'type no longer fails NOT_FOCUSED when focus lands elsewhere')
    assert.ok(/describeActiveElement/.test(editable), 'the NOT_FOCUSED error does not name the active element')
    for (const field of ['activeElement', 'valueAfter', 'activeElementAfter']) {
      assert.ok(typeBody.includes(field), 'type reply lost ' + field)
    }
    // 2216: a text click that finds no hittable node names its candidates.
    const findBody = workerSource.slice(
      workerSource.indexOf('async function findTextPoint'),
      workerSource.indexOf('async function pressAt'),
    )
    assert.ok(/TEXT_NOT_CLICKABLE/.test(workerSource), 'click by text no longer fails with TEXT_NOT_CLICKABLE')
    assert.ok(/textCandidatesExpr/.test(findBody), 'click by text does not gather candidates on a miss')
    for (const field of ['candidates', 'pointerEvents', 'ariaHidden']) {
      assert.ok(workerSource.includes(field), 'click candidate diagnostics lost ' + field)
    }
    // 2213: an opt-in click postcondition says whether anything changed.
    const clickBody = bodyFrom('clickPage')
    assert.ok(/PAGE_FINGERPRINT_EXPR/.test(workerSource) && /pageChanged/.test(clickBody), 'click verify lost its page fingerprint')
    assert.ok(/CLICK_UNCHANGED_HINT/.test(clickBody), 'a verified click that changed nothing lost its hint')
    assert.ok(/const verify = args\?\.verify === true/.test(toolsSource), 'bsb_act does not accept verify')
    assert.ok(/verify, forceActive/.test(toolsSource), 'bsb_act does not forward verify on click')
    assert.ok(/verify: \{ type: 'boolean'/.test(toolsSource), 'bsb_act does not document verify')
    // The skill documents every new field and error.
    const skillText = await readFile(new URL('../skill/browser-bridge/SKILL.md', import.meta.url), 'utf8')
    for (const needle of ['TEXT_NOT_APPLIED', 'EDITOR_LOST_TEXT', 'NOT_FOCUSED', 'TEXT_NOT_CLICKABLE', 'pageChanged', 'requestedKeys', 'droppedKeys', 'activeElement']) {
      assert.ok(skillText.includes(needle), 'the skill does not document ' + needle)
    }
  }
  console.log('ok  input-truth guards pinned (key text cap/verify, chords, type focus, click candidates/verify)')
  // Transfer features from the 2155/2147 tickets. Upload must be able to attach
  // files to a chooser whose frame document it never reads; paste must be a real
  // clipboard paste or an honest Input.insertText, never a synthetic event or
  // DOM injection. These are static guards only: the live behavior needs a real
  // Chrome with the patched extension loaded.
  {
    assert.ok(/async function fileChooserUpload\(/.test(workerSource), 'sw.js lost the file-chooser upload route')
    assert.ok(/Page\.setInterceptFileChooserDialog/.test(workerSource), 'upload no longer arms chooser interception')
    assert.ok(/Page\.fileChooserOpened/.test(workerSource), 'upload no longer waits for the chooser event')
    assert.ok(/DOM\.setFileInputFiles', \{ backendNodeId: event\.backendNodeId/.test(workerSource),
      'upload no longer sets files by the reported backendNodeId')
    assert.ok(/via: 'fileChooser'/.test(workerSource), 'upload no longer reports via:"fileChooser"')
    const frameUploadError = workerSource.slice(
      workerSource.indexOf('if (!rootNodeId) {'),
      workerSource.indexOf('const selector = resolveTarget(target)', workerSource.indexOf('if (!rootNodeId) {')),
    )
    assert.ok(/x,y/.test(frameUploadError) && /top-document target/.test(frameUploadError),
      'the unreachable-frame error no longer names the x,y / top-document trigger route')
    assert.ok(/let handled = false/.test(workerSource) && /cancel: true/.test(workerSource),
      'upload can leave file chooser interception armed')
    assert.ok(/async function pastePage\(/.test(workerSource), 'sw.js lost the paste action')
    assert.ok(/navigator\.clipboard/.test(workerSource) && /writeText/.test(workerSource), 'paste no longer writes the clipboard')
    assert.ok(/commands: \['paste'\]/.test(workerSource), 'paste no longer sends the browser paste edit command')
    assert.ok(/Input\.insertText/.test(workerSource), 'paste lost the Input.insertText fallback')
    assert.ok(/mode: 'clipboard'/.test(workerSource) && /mode: 'insertText'/.test(workerSource),
      'paste does not report which mode it actually used')
    // A same-origin frame can still be absent from getFrameOwner's describeNode
    // (the Google Picker was), so the upload path must walk the pierced tree.
    assert.ok(
      /depth: -1, pierce: true/.test(workerSource) && /findFrameDocument/.test(workerSource),
      'upload no longer finds a same-origin frame document through the pierced DOM tree',
    )
    assert.ok(/FRAME_NOT_READABLE/.test(workerSource), 'upload no longer names an out-of-process frame')
    assert.ok(/truncated/.test(workerSource) && /PASTE_MAX_CHARS/.test(workerSource), 'paste no longer reports truncation')
    assert.ok(!/ClipboardEvent/.test(workerSource), 'paste dispatches a synthetic ClipboardEvent instead of real input')
    assert.ok(/clipboardWrite/.test(JSON.stringify(manifest.permissions)), 'the extension cannot write the clipboard')
    assert.ok(/enum: \[[^\]]*'paste'/.test(toolsSource), 'bsb_act does not offer the paste action')
    assert.ok(/action === 'paste'/.test(toolsSource) && /action === 'upload'/.test(toolsSource), 'bsb_act lost an execute branch')
    assert.ok(/chars, truncated, mode and applied/.test(toolsSource), 'bsb_act does not document the paste report')
  }
  console.log('ok  upload chooser and paste guards pinned (clipboard write, insertText fallback, no synthetic events)')

  // The skill and the tool surface are one model-facing contract.
  await import('./skill-align.mjs')

  console.log('\nself-test passed')
} finally {
  bridge.dispose()
}
