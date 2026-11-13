/**
 * Version-compatibility test for the plugin's web routes.
 *
 * The harness webserver's route contract has differed across releases:
 *
 *   0.2.2-alpha.2 and earlier — accepts `{ handler }` OR `{ resource }`,
 *                               dispatching on `'resource' in responder`.
 *   0.2.1-rc.5 and earlier    — dispatches `route.handler(req, res)` only.
 *
 * A resource-only route therefore works on one and 400s (empty body) on the
 * other, because the missing handler throws inside the server's dispatch and
 * its last-resort guard answers 400. That cost a real debugging round when the
 * harness was downgraded, so this file pins both directions by actually running
 * the plugin's routes under each dispatch strategy.
 *
 * Run with `node tests/compat-webserver.mjs`.
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROUTE_PORT = 18792

/**
 * Minimal stand-in for the host webserver service: records what the plugin
 * registers and nothing else.
 */
function fakeWebServer() {
  const routes = new Map()
  const service = {
    getOrigin: () => `http://127.0.0.1:${ROUTE_PORT}`,
    register(route) {
      if (!route || typeof route.path !== 'string' || typeof route.kind !== 'string') {
        throw new Error('register() received a malformed route')
      }
      if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
  return { service, routes }
}

/** A ctx shaped just enough for apply(): effect, logger, inject, tools. */
function fakeCtx(webServer, tools) {
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    effect(fn) {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    get: () => undefined,
    inject(deps, run) {
      if (Array.isArray(deps) && deps.includes('webServer')) run({ webServer, logger: ctx.logger })
    },
    tools: { register: (definition) => tools.set(definition.name, definition) },
    attachments: { store: async () => ({ ref: 'stub' }) },
  }
  return ctx
}

const { apply } = await import('../index.js')

const { service: webServer, routes } = fakeWebServer()
const tools = new Map()
const ctx = fakeCtx(webServer, tools)
// apply() writes <dsh home>/browser-bridge/pairing.txt with the URL of the
// bridge it just started. Pointing DSH_HOME at a scratch directory keeps this
// test from overwriting the user's real pairing link with a fake one — an
// earlier version of this file did exactly that.
const scratchHome = await mkdtemp(join(tmpdir(), 'bsb-compat-'))
process.env.DSH_HOME = scratchHome
// devReload:true registers the fixture/dev routes too, so the probe covers the
// full surface a running profile actually mounts.
apply(ctx, { port: ROUTE_PORT + 100, bind: '127.0.0.1', devReload: true })
await new Promise((resolve) => setTimeout(resolve, 300))

try {
  // 1. Shape: every route must carry a real handler, whatever its body style.
  //    This is the invariant that makes the plugin version-independent — a
  //    `resource`-only registration is invisible to a handler-only server.
  assert.ok(routes.size >= 6, `expected several routes, got ${routes.size}`)
  const resourceOnly = [...routes.values()].filter((route) => typeof route.handler !== 'function')
  assert.deepEqual(resourceOnly.map((route) => route.path), [], 'a route registered without a handler')
  assert.deepEqual(
    [...routes.values()].filter((route) => 'resource' in route).map((route) => route.path),
    [],
    'a route still carries a Fetch-style resource, which older servers ignore',
  )
  console.log(`ok  all ${routes.size} routes register as handlers`)

  // 2. Dispatch exactly like a handler-only server (0.2.1-rc.5): no reflection
  //    on the route shape, just call it. Every GET route must answer something
  //    that is not the server's anonymous 400.
  const handlerOnly = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    const route = routes.get(path)
    if (route === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    Promise.resolve(route.handler(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(400)
      res.end()
    })
  })
  await new Promise((resolve) => handlerOnly.listen(ROUTE_PORT, '127.0.0.1', resolve))
  try {
    // Routes that validate their query string on purpose. Give each the minimum
    // it needs so the probe measures dispatch, not that validation.
    const probeQuery = (path) => {
      if (path.endsWith('/api/disconnect')) return '?id=probe'
      if (path.endsWith('/dev/command')) return '?method=tabs'
      return ''
    }
    const results = []
    for (const path of routes.keys()) {
      const response = await fetch(`http://127.0.0.1:${ROUTE_PORT}${path}${probeQuery(path)}`)
      const body = Buffer.from(await response.arrayBuffer())
      results.push({ path, status: response.status, bytes: body.length })
    }
    // The failure being guarded against is the server's ANONYMOUS 400: route
    // mounted, handler missing, guard answered with nothing. A response with a
    // body came from our code, so it is healthy whatever its status means
    // (dev/command legitimately answers 502 with no browser paired).
    const anonymousFailures = results.filter((row) => row.status === 400 && row.bytes === 0)
    assert.deepEqual(
      anonymousFailures.map((row) => row.path),
      [],
      `the harness guard answered instead of the route: ${JSON.stringify(anonymousFailures)}`,
    )
    assert.deepEqual(results.filter((row) => row.bytes === 0).map((row) => row.path), [], 'a route answered with no body')
    // The routes the dashboard depends on must be plain 200s; the dev-only
    // command channel is allowed to report "no browser" instead.
    const essential = results.filter((row) => !row.path.includes('/dev/'))
    const notOk = essential.filter((row) => row.status !== 200)
    assert.deepEqual(
      notOk.map((row) => `${row.path} → ${row.status}`),
      [],
      'an essential route stopped answering 200 under handler-only dispatch',
    )
    console.log(`ok  every route answers with a body under handler-only dispatch (${results.length} routes, ${essential.length} essential)`)

    // 2b. A bound endpoint must leave a machine-readable status behind. When the
    //     bind fails the only trace used to be a log line, so "pairing.txt is
    //     missing" gave no reason — the failure that cost a round when a Windows
    //     desktop instance collided with a WSL one on the same port.
    const status = JSON.parse(await readFile(join(scratchHome, 'browser-bridge', 'status.json'), 'utf8'))
    assert.equal(status.listening, true, 'status.json does not report a listening endpoint')
    assert.equal(typeof status.port, 'number', 'status.json lost the port')
    assert.match(String(status.pairing), /\/p\/[0-9a-f]{64}$/i, 'status.json lost the pairing URL')
    const build = await fetch(`http://127.0.0.1:${ROUTE_PORT}/browser-bridge/api/build`).then((r) => r.json())
    assert.equal(build.bridge?.listening, true, 'api/build does not expose the bridge state')
    assert.match(String(build.bridge?.pairing), /\/p\/[0-9a-f]{64}$/i, 'api/build does not expose the pairing URL the page needs to send')
    // It must name the BRIDGE port, not the port the page was served from: a
    // page on the web server's port asking for a hand-out used to receive a URL
    // pointing at the web server, where no bridge route exists.
    assert.equal(build.bridge?.port, ROUTE_PORT + 100, 'status lost the bridge port')
    assert.ok(
      String(build.bridge?.pairing).includes(`:${ROUTE_PORT + 100}/`),
      `pairing URL does not use the bridge port: ${build.bridge?.pairing}`,
    )
    console.log('ok  the bridge state and pairing URL are machine-readable')

    // 3. The plugin's own validation must still be reachable. A missing id is a
    //    client error the route writes itself, so the body names it — unlike the
    //    server's empty 400, which is what a contract mismatch looks like.
    const noId = await fetch(`http://127.0.0.1:${ROUTE_PORT}/browser-bridge/api/disconnect`)
    assert.equal(noId.status, 400, 'api/disconnect no longer validates its id')
    const noIdBody = await noId.json()
    assert.equal(noIdBody.error, 'id required', 'the rejection does not name the missing field')
    const noMethod = await fetch(`http://127.0.0.1:${ROUTE_PORT}/browser-bridge/dev/command`)
    assert.equal(noMethod.status, 400, 'dev/command no longer validates its method')
    assert.equal((await noMethod.json()).error, 'method required', 'dev/command rejection is unnamed')
    console.log('ok  route-authored errors still reach the caller')

    // 4. And the same routes must answer a method the resource contract would
    //    have refused with 405, rather than dying.
    const posted = await fetch(`http://127.0.0.1:${ROUTE_PORT}/browser-bridge/api/build`, { method: 'POST' })
    assert.equal(posted.status, 405, 'a non-GET request to an API route should be a client error')
    console.log('ok  non-GET requests are refused, not crashed')

    // 5. The endpoint route. Changing the port from the page is the feature that
    //    replaces hand-editing cordis.patch.yml, so its failure modes matter:
    //    a taken port must leave the working endpoint serving, an unauthenticated
    //    caller must be refused, and the happy path must move the listener.
    const portUrl = `http://127.0.0.1:${ROUTE_PORT}/browser-bridge/api/port`
    const postPort = (body, headers = { 'content-type': 'application/json', 'x-browser-bridge': '1' }) =>
      fetch(portUrl, { method: 'POST', headers, body: JSON.stringify(body) })

    const readPort = await fetch(portUrl).then((r) => r.json())
    assert.equal(readPort.port, ROUTE_PORT + 100, 'the endpoint route disagrees with the listening port')
    assert.equal(readPort.listening, true, 'the endpoint route lost the listening flag')

    const unauthorised = await postPort({ port: 9000 }, { 'content-type': 'application/json' })
    assert.equal(unauthorised.status, 403, 'the port route accepts an unauthenticated caller')

    const bad = await postPort({ port: 80 })
    assert.equal(bad.status, 400, 'the port route accepts a privileged port')

    // A genuinely occupied port: this test's own listener.
    const squatter = createServer((_req, res) => { res.writeHead(204); res.end() })
    await new Promise((resolve) => squatter.listen(ROUTE_PORT + 2, '127.0.0.1', resolve))
    try {
      const busy = await postPort({ port: ROUTE_PORT + 2 })
      assert.equal(busy.status, 409, 'moving onto a taken port was not reported as a conflict')
      assert.equal((await busy.json()).ok, false, 'a failed move reported success')
      const still = await fetch(`http://127.0.0.1:${ROUTE_PORT}/browser-bridge/api/build`).then((r) => r.json())
      assert.equal(still.bridge?.port, ROUTE_PORT + 100, 'a refused port change still moved the endpoint')
      assert.equal(still.bridge?.listening, true, 'a refused port change left no endpoint listening')
    } finally {
      await new Promise((resolve) => squatter.close(resolve))
    }

    const moved = await postPort({ port: ROUTE_PORT + 3 })
    const movedBody = await moved.json()
    assert.equal(moved.status, 200, `moving to a free port failed (${moved.status}): ${JSON.stringify(movedBody)}`)
    assert.equal(movedBody.port, ROUTE_PORT + 3, 'the move did not report the new port')
    assert.equal(movedBody.source, 'settings', 'the move was not recorded as a page setting')
    const afterMove = await fetch(`http://127.0.0.1:${ROUTE_PORT}/browser-bridge/api/build`).then((r) => r.json())
    assert.equal(afterMove.bridge?.port, ROUTE_PORT + 3, 'api/build did not follow the move')
    assert.match(String(afterMove.bridge?.pairing), new RegExp(`:${ROUTE_PORT + 3}/p/`), 'the pairing URL did not follow the move')
    // The tools must keep working through the facade after the instance swap.
    assert.equal(typeof (await import('../index.js')).apply, 'function', 'index.js lost its apply export')

    const reset = await postPort({ reset: true })
    const resetBody = await reset.json()
    assert.equal(reset.status, 200, `resetting the port failed: ${JSON.stringify(resetBody)}`)
    assert.equal(resetBody.port, ROUTE_PORT + 100, 'reset did not return to the profile port')
    // This test passes port in the profile config, so reset lands on 'config',
    // not 'default' — the point is that the page override is gone.
    assert.equal(resetBody.source, 'config', 'reset did not clear the page override')
    assert.equal((await fetch(portUrl).then((r) => r.json())).source, 'config', 'the cleared override came back')
    console.log('ok  the endpoint port can be read, moved, refused and reset')
  } finally {
    await new Promise((resolve) => handlerOnly.close(resolve))
  }

  // 4. And under an alpha.2-style dispatcher, which prefers `resource` when it
  //    exists and otherwise calls `handler`. Since no route has `resource`, the
  //    handler branch runs — the same bytes as above.
  const dual = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    const responder = routes.get(path)
    if (responder === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    const run = typeof responder === 'function'
      ? responder
      : 'resource' in responder
        ? () => { res.writeHead(500); res.end('resource branch: not used by this plugin') }
        : responder.handler
    Promise.resolve(run(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(400)
      res.end()
    })
  })
  await new Promise((resolve) => dual.listen(ROUTE_PORT + 1, '127.0.0.1', resolve))
  try {
    const response = await fetch(`http://127.0.0.1:${ROUTE_PORT + 1}/browser-bridge/api/build`)
    assert.equal(response.status, 200, 'the plugin fails on a dispatcher that prefers `resource`')
    const body = await response.json()
    assert.equal(body.ok, true, 'api/build answered 200 without its payload')
    console.log('ok  same routes answer under alpha.2-style dual dispatch')
  } finally {
    await new Promise((resolve) => dual.close(resolve))
  }

  // 6. A listener that failed to start must be recoverable from the page.
  //
  //    This is the shape of the real Windows/WSL port clash: the plugin comes up
  //    with its port already taken, so nothing is bound and no pairing link
  //    exists. Applying that same port must retry the bind — an earlier version
  //    short-circuited on "same port" and claimed success with no listener, which
  //    is the worst possible answer to "is my port open?".
  {
    const BLOCKED_PORT = ROUTE_PORT + 40
    const squatter = createServer((_req, res) => { res.writeHead(204); res.end() })
    await new Promise((resolve) => squatter.listen(BLOCKED_PORT, '127.0.0.1', resolve))

    const { service: ws2, routes: routes2 } = fakeWebServer()
    const ctx2 = fakeCtx(ws2, new Map())
    apply(ctx2, { port: BLOCKED_PORT, bind: '127.0.0.1' })
    await new Promise((resolve) => setTimeout(resolve, 400))

    // Serve this second instance's routes on a probe port, the way the host does.
    const dispatcher = createServer((req, res) => {
      const route = routes2.get(new URL(req.url ?? '/', 'http://x').pathname)
      if (route === undefined) { res.writeHead(404); res.end(); return }
      Promise.resolve(route.handler(req, res)).catch(() => { if (!res.headersSent) res.writeHead(400); res.end() })
    })
    await new Promise((resolve) => dispatcher.listen(BLOCKED_PORT + 1, '127.0.0.1', resolve))
    try {
      const base = `http://127.0.0.1:${BLOCKED_PORT + 1}`
      const blocked = await fetch(`${base}/browser-bridge/api/build`).then((r) => r.json())
      assert.equal(blocked.bridge?.listening, false, 'a port clash was reported as listening')
      assert.equal(blocked.bridge?.error, `port ${BLOCKED_PORT} is already in use`, 'the clash is no longer named')
      assert.match(String(blocked.bridge?.hint), /another browser-bridge already holds/, 'the clash hint is gone')

      // Free the port, then recover through the same page control.
      await new Promise((resolve) => squatter.close(resolve))
      const recover = await fetch(`${base}/browser-bridge/api/port`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-browser-bridge': '1' },
        body: JSON.stringify({ port: BLOCKED_PORT }),
      })
      const recoverBody = await recover.json()
      assert.equal(recover.status, 200, `recovering the same port failed: ${JSON.stringify(recoverBody)}`)

      // The claim must be true: something has to answer on that port now.
      const hello = await fetch(`http://127.0.0.1:${BLOCKED_PORT}/p/${'0'.repeat(64)}/hello`).then((r) => r.status).catch(() => 0)
      assert.ok(hello > 0, 'the plugin reported success but nothing is listening')
      const after = await fetch(`${base}/browser-bridge/api/build`).then((r) => r.json())
      assert.equal(after.bridge?.listening, true, 'the recovered endpoint is still reported blocked')
      console.log('ok  a blocked start is visible and recoverable from the page')
    } finally {
      await new Promise((resolve) => dispatcher.close(resolve)).catch(() => {})
    }
  }

  console.log('\ncompat test passed — the plugin runs on both webserver contracts')
} finally {
  // Never leave a scratch home behind (and never touch the real one).
  await rm(scratchHome, { recursive: true, force: true }).catch(() => {})
  // apply() started a real Bridge listener; let the process exit on its own.
  setTimeout(() => process.exit(0), 100).unref?.()
}
