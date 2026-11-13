/**
 * browser-bridge — the host half.
 *
 * Starts one loopback endpoint and registers twenty-one tools. That is the entire
 * plugin: no client row, no settings panel, no panel or sidebar. The user-facing
 * surface is the extension popup and `bsb_browsers` reports the connection.
 *
 * @module browser-bridge
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Bridge, loadToken, resolveDshHome } from './bridge.js'
import { toHandler } from './http-adapter.js'

// tools.js is loaded dynamically with a cache-busting query on purpose.
//
// The release procedure is "toggle the bundle off/on". That re-imports this
// entry file, but a STATIC import of ./tools.js resolves to the same URL and is
// served from Node's ESM cache, so edits to the tool schemas and renderers
// silently never ship — the extension updates, the tool surface does not, and
// the mismatch looks like a bug in the extension. A unique query forces a fresh
// module instance on every reload, which is what "toggle the bundle" promises.
const toolModuleUrl = new URL('./tools.js', import.meta.url)
const TOOLS_BUILD = '1.1.269'
toolModuleUrl.searchParams.set('reload', String(Date.now()))
const { registerTools } = await import(toolModuleUrl.href)

export const name = 'browser-bridge'

export const inject = ['tools', 'attachments']

const here = dirname(fileURLToPath(import.meta.url))
/** Bumped by the release script; proves which host code is live. */
const HOST_BUILD = '1.1.269'
const EXTENSION_ZIP = join(here, 'dist', 'browser-bridge-extension.zip')

/**
 * Read a SKILL.md bundled with the plugin and validate the fields the skill
 * registry needs. Keeping the file as the source means the playbook is edited
 * like any other Markdown skill, not as a string inside this module.
 */
function readBundledSkill(file) {
  const raw = readFileSync(file, 'utf8')
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (frontmatter?.[1] === undefined) throw new Error(`${file} has no frontmatter`)
  const field = (key) => {
    const match = new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(frontmatter[1])
    return match?.[1]?.trim() ?? ''
  }
  const name = field('name')
  const description = field('description')
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error(`${file} has an invalid name`)
  if (!description) throw new Error(`${file} has no description`)
  return { name, description, content: raw.slice(frontmatter[0].length).trim() }
}

const DEFAULT_PORT = 8791
const DEFAULT_HOST = '127.0.0.1'

const readPort = (value) => {
  const port = typeof value === 'string' ? Number(value) : value
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT
}

const readHost = (value) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : DEFAULT_HOST)

const isWildcard = (host) => host === '0.0.0.0' || host === '::'

/**
 * Read the UI-managed settings beside the pairing link.
 *
 * A corrupt or unreadable file must never stop the plugin: the port falls back
 * to the profile config, which is exactly where it came from before this file
 * existed.
 */
function readSettings(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const port = Number(parsed?.port)
    return Number.isInteger(port) && port > 0 && port < 65536 ? { port } : {}
  } catch {
    return {}
  }
}

/** Persist settings atomically enough: a torn file would only lose an override. */
function writeSettings(file, settings) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/**
 * Address a browser on another machine should dial.
 *
 * Only meaningful for a wildcard bind: with a specific bind the plugin already
 * knows the address. Private ranges are preferred so a stray VPN adapter does
 * not become the advertised address.
 */
function detectAdvertiseHost(bind) {
  if (!isWildcard(bind)) return undefined
  const candidates = []
  for (const addresses of Object.values(networkInterfaces())) {
    for (const entry of addresses ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) candidates.push(entry.address)
    }
  }
  const pick = (pattern) => candidates.find((address) => pattern.test(address))
  return pick(/^192\.168\./) ?? pick(/^10\./) ?? pick(/^172\.(1[6-9]|2[0-9]|3[01])\./) ?? candidates[0]
}

export function apply(ctx, config = {}) {
  const host = readHost(config?.bind)
  const configuredPort = readPort(config?.port)
  const dshHome = resolveDshHome()
  const { token, file: tokenFile } = loadToken(dshHome)
  // A port chosen from the plugin page is stored here and outranks the profile
  // config, so the UI can change it without anyone hand-editing cordis.patch.yml.
  // Reset (null) drops the override and the profile value wins again.
  const settingsFile = join(dshHome, 'browser-bridge', 'settings.json')
  const settings = readSettings(settingsFile)
  let port = settings.port ?? configuredPort
  const advertise = typeof config?.advertise === 'string' && config.advertise.trim().length > 0
    ? config.advertise.trim()
    : detectAdvertiseHost(host)
  const allowRemotePairing = config?.allowRemotePairing === true
  // TEMPORARY dev hook: lets the page ask the extension to reload itself.
  // Off unless the row sets it. Remove this flag to drop the feature entirely.
  const devReload = config?.devReload === true

  const extensionVersion = (() => {
    try {
      return JSON.parse(readFileSync(join(here, 'extension', 'manifest.json'), 'utf8')).version
    } catch {
      return undefined
    }
  })()

  const spawnBridge = (listenPort) => {
    const instance = new Bridge({ host, port: listenPort, token, advertise, allowRemotePairing, log: ctx.logger })
    // Publish the shipped extension version so the worker can self-update on poll.
    if (extensionVersion) instance.extensionVersion = extensionVersion
    return instance
  }

  // The live listener. Tools bind to the facade below, not to this instance, so a
  // port change can replace the instance without re-registering the tool surface.
  // Keep this in sync with what the routes and tools actually call — a missing
  // member becomes a 500 at request time, not at load time.
  let current = spawnBridge(port)
  const bridge = {
    get activeBrowserId() { return current.activeBrowserId },
    browsers: () => current.browsers(),
    dropBrowser: (id) => current.dropBrowser(id),
    send: (method, params, options) => current.send(method, params, options),
  }

  // Whether the endpoint is actually listening, and why not when it is not.
  //
  // A failed bind used to leave only a log line: no pairing.txt appeared, and
  // "the file is missing" says nothing about the cause. The commonest cause by
  // far is a port clash — two dsh instances on one machine, or WSL and Windows
  // under mirrored networking sharing a port namespace — so record the reason
  // somewhere both a human and a tool can read it.
  const bridgeState = {
    listening: false,
    host,
    port,
    error: null,
    code: null,
    hint: null,
    pairing: null,
    updatedAt: Date.now(),
  }
  const recordBridgeState = (patch) => {
    Object.assign(bridgeState, patch, { updatedAt: Date.now() })
    try {
      const dir = join(dshHome, 'browser-bridge')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'status.json'), `${JSON.stringify(bridgeState, null, 2)}\n`, { mode: 0o600 })
    } catch {}
  }

  /** Where the port in force came from, so the page can explain itself. */
  const portSource = () => (settings.port !== undefined ? 'settings' : (config?.port !== undefined ? 'config' : 'default'))

  const writePairingFile = (url) => {
    try {
      const dir = join(dshHome, 'browser-bridge')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'pairing.txt'), `${url}\n`, { mode: 0o600 })
    } catch {}
  }

  ctx.effect(() => {
    let disposed = false
    current.start().then((url) => {
      if (disposed) return
      writePairingFile(url)
      recordBridgeState({ listening: true, port: current.port, error: null, code: null, hint: null, pairing: url })
      const scope = isWildcard(host) ? 'all interfaces' : host
      const remote = isWildcard(host)
        ? (allowRemotePairing ? 'LAN pairing allowed' : 'LAN pairing returns needsLink; paste the link once')
        : 'loopback only'
      ctx.logger?.info?.(`browser-bridge: listening on ${host}:${current.port} (${scope}; ${remote}) — ${url} (token ${tokenFile})`)
    }).catch((error) => {
      const code = error?.code ?? ''
      const reason = code === 'EADDRINUSE'
        ? `port ${current.port} is already in use`
        : String(error?.message ?? error)
      // Name the usual culprit instead of making the reader derive it.
      const hint = code === 'EADDRINUSE'
        ? `another browser-bridge already holds ${host}:${current.port} — a second dsh instance, or WSL and Windows sharing a port namespace (WSL2 mirrored networking shares localhost). Pick another port on this page.`
        : null
      recordBridgeState({ listening: false, port: current.port, error: reason, code: code || null, hint, pairing: null })
      ctx.logger?.warn?.(`browser-bridge: could not start (${reason}). Browser tools will report no pairing until this is fixed.`)
    })
    return () => {
      disposed = true
      current.dispose()
    }
  }, 'browser-bridge: endpoint')

  /**
   * Move the listener to another port, without ever leaving the user with none.
   *
   * The new instance binds first; only when it is listening is the old one
   * disposed. A port that is taken therefore fails harmlessly and the working
   * endpoint keeps serving — which matters because the failure this feature
   * exists to fix IS a taken port.
   */
  const setPort = async (nextPort) => {
    // "Same port" is only a no-op when something is actually listening on it.
    // After a failed start the instance still carries the requested port while
    // nothing is bound, so applying that same port has to retry the bind — a
    // short-circuit here used to report success without a listener behind it.
    const changing = nextPort !== current.port || bridgeState.listening !== true
    if (changing) {
      const next = spawnBridge(nextPort)
      try {
        await next.start()
      } catch (error) {
        next.dispose()
        const code = error?.code ?? 'BIND_FAILED'
        return {
          ok: false,
          status: code === 'EADDRINUSE' ? 409 : 400,
          code,
          error: code === 'EADDRINUSE'
            ? `port ${nextPort} is already in use`
            : String(error?.message ?? error),
        }
      }
      // Let commands already dispatched settle before the old listener goes, so
      // a click that triggered this very port change still reports its result.
      const previous = current
      await previous.drain(1500)
      current = next
      previous.dispose({
        code: 'REBOUND',
        message: 'the browser-bridge endpoint moved to another port while this command was in flight; retry it',
      })
      port = nextPort
    }
    // Persist only after the socket is up, so a rejected port never sticks.
    settings.port = nextPort === configuredPort ? undefined : nextPort
    if (settings.port === undefined) delete settings.port
    writeSettings(settingsFile, settings)
    const url = `http://${advertise || (isWildcard(host) ? '127.0.0.1' : host)}:${port}/p/${token}`
    writePairingFile(url)
    recordBridgeState({ listening: true, port, error: null, code: null, hint: null, pairing: url })
    ctx.logger?.info?.(`browser-bridge: listening on ${host}:${port} — ${url}`)
    return { ok: true, port, pairing: url, source: portSource(), changed: changing }
  }

  /** Drop the UI override and go back to the profile's value. */
  const resetPort = async () => {
    // Even with no override there can be nothing listening (a blocked start), so
    // reset still has to try the bind rather than answer "already fine".
    if (settings.port === undefined && bridgeState.listening === true) {
      return { ok: true, port, pairing: bridgeState.pairing, source: portSource(), changed: false }
    }
    return setPort(configuredPort)
  }

  // The dashboard links here, same origin as the Web UI, so the browser needs
  // no host, port, or token to fetch these.
  //
  // `ctx.inject`, not `ctx.get`: the webserver service is provided by a fiber
  // that can still be activating when this plugin applies, and `ctx.get` only
  // returns providers whose fiber is already ACTIVE. Reading it once here raced
  // on startup and silently skipped every route below — the panel then fetched
  // a zero-byte 404 and died on `response.json()` with "Unexpected end of JSON
  // input". Injection re-runs this block as soon as the service exists.
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.webServer
    // Register every route as a plain Node handler, never as a `{ resource }`.
    //
    // The harness webserver changed its route contract between releases: 0.2.2
    // and earlier dispatched on `'resource' in responder` (Fetch shape allowed),
    // while 0.2.1-rc.5 calls `route.handler(req, res)` unconditionally. A
    // resource-only route registers fine, then throws on first use and the
    // server's last-resort guard answers 400 with an empty body — which reads
    // like "the plugin is not serving its web routes". `handler` is the shape
    // every version dispatches, so the adapter below is version-independent.
    const registerRoute = ({ kind = 'exact', path, resource, methods }) => webServer.register({
      kind,
      path,
      handler: toHandler(resource, path, methods ? { methods } : undefined),
    })
    const served = {
      '/browser-bridge/extension.zip': ['browser-bridge-extension.zip', 'application/zip', 'browser-bridge-extension.zip'],
      '/browser-bridge/extension.crx': ['browser-bridge-extension.crx', 'application/x-chrome-extension', 'browser-bridge-extension.crx'],
      '/browser-bridge/updates.xml': ['updates.xml', 'application/xml', undefined],
    }
    const baseOf = (request) => {
      const host = request?.headers?.get?.('host')
      return host ? `http://${host}` : webServer.getOrigin()
    }
    for (const [routePath, [file, type, download]] of Object.entries(served)) {
      ctx.effect(() => registerRoute({
        kind: 'exact',
        path: routePath,
        resource: async (request) => {
          try {
            let body = readFileSync(join(here, 'dist', file))
            if (file === 'updates.xml') body = Buffer.from(body.toString('utf8').replaceAll('__BASE__', baseOf(request)))
            return new Response(body, {
              headers: {
                'content-type': type,
                'cache-control': 'no-store',
                ...(download ? { 'content-disposition': `attachment; filename="${download}"` } : {}),
              },
            })
          } catch {
            return new Response('not built: run scripts/pack-extension.mjs', { status: 404 })
          }
        },
      }), `browser-bridge: ${routePath}`)
    }

    // The only automatic install Chrome honours: an enterprise policy entry that
    // points at the update manifest above. Written per-user, so no admin needed.
    ctx.effect(() => registerRoute({
      kind: 'exact',
      path: '/browser-bridge/install-policy.reg',
      resource: async (request) => {
        let id = ''
        try { id = JSON.parse(readFileSync(join(here, 'dist', 'extension-meta.json'), 'utf8')).id } catch {}
        const body = [
          'Windows Registry Editor Version 5.00',
          '',
          '[HKEY_CURRENT_USER\\Software\\Policies\\Google\\Chrome\\ExtensionInstallForcelist]',
          `"1"="${id};${baseOf(request)}/browser-bridge/updates.xml"`,
          '',
        ].join('\r\n')
        return new Response(body, {
          headers: {
            'content-type': 'application/octet-stream',
            'content-disposition': 'attachment; filename="browser-bridge-policy.reg"',
          },
        })
      },
    }), 'browser-bridge: policy')

    const apiJson = (value, status = 200) => new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    })

    // Live browser list for the plugin page.
    ctx.effect(() => registerRoute({
      kind: 'exact',
      path: '/browser-bridge/api/browsers',
      resource: async () => apiJson({ ok: true, active: bridge.activeBrowserId ?? null, browsers: bridge.browsers() }),
    }), 'browser-bridge: api browsers')

    // Which build of the host code is actually running.
    //
    // A bundle toggle updates the config and the extension, but host modules
    // loaded by the running DSH process are only re-evaluated when that process
    // restarts. Without a way to ask "which code am I running", a stale host
    // looks exactly like a bug in the tool. This route answers that question.
    ctx.effect(() => registerRoute({
      kind: 'exact',
      path: '/browser-bridge/api/build',
      resource: async (request) => {
        // Hand out a pairing URL the requesting page can actually dial.
        //
        // The bridge listens on its OWN port, which is not the web server's, but
        // its preferred host may be an advertised LAN address. So keep the bridge
        // port and take only the *hostname* the page used: a page at
        // 127.0.0.1:3080 asks for 127.0.0.1:<bridgePort>, never 3080.
        const pairPort = bridgeState.port
        let reachable = bridgeState.pairing ?? null
        if (bridgeState.listening) {
          const pageHost = request?.headers?.get?.('host')
          let hostname = ''
          try {
            hostname = typeof pageHost === 'string' ? new URL(`http://${pageHost}`).hostname : ''
          } catch {
            hostname = ''
          }
          if (hostname) reachable = `http://${hostname}:${pairPort}/p/${token}`
        }
        return apiJson({
          ok: true,
          build: HOST_BUILD,
          tools: TOOLS_BUILD,
          extension: extensionVersion ?? null,
          // The panel and any agent debugging a pairing can see whether the
          // endpoint is actually up, and why not — without reading logs.
          bridge: {
            ...bridgeState,
            pairing: reachable,
            // Where the port in force came from: a UI setting, the profile
            // config, or the built-in default. The page shows this so "why is it
            // on 8801" always has an answer.
            source: portSource(),
            configuredPort,
          },
        })
      },
    }), 'browser-bridge: api build')

    /**
     * Change, or reset, the listening port from the plugin page.
     *
     * POST with a JSON body, not a GET with a query: this mutates the endpoint,
     * and a GET is exactly what a stray prefetch or an <img> tag can fire. The
     * route additionally refuses cross-origin callers, which the page never is.
     */
    ctx.effect(() => registerRoute({
      kind: 'exact',
      path: '/browser-bridge/api/port',
      methods: ['GET', 'POST'],
      resource: async (request) => {
        if ((request.method ?? 'GET').toUpperCase() === 'GET') {
          return apiJson({
            ok: true,
            port: bridgeState.port,
            listening: bridgeState.listening,
            source: portSource(),
            configuredPort,
            pairing: bridgeState.pairing,
            error: bridgeState.error,
          })
        }
        // Cross-origin form posts cannot set this header without a preflight,
        // so requiring it keeps the mutation same-origin only.
        if (request.headers.get('x-browser-bridge') !== '1') {
          return apiJson({ ok: false, error: 'missing x-browser-bridge header' }, 403)
        }
        let body
        try {
          body = await request.json()
        } catch {
          return apiJson({ ok: false, error: 'body must be JSON' }, 400)
        }
        if (body?.reset === true) {
          const result = await resetPort()
          return apiJson(result, result.ok ? 200 : 400)
        }
        const next = Number(body?.port)
        if (!Number.isInteger(next) || next < 1024 || next > 65535) {
          return apiJson({ ok: false, error: 'port must be an integer between 1024 and 65535' }, 400)
        }
        if (next === bridgeState.port && bridgeState.listening) {
          return apiJson({ ok: true, port: next, pairing: bridgeState.pairing, source: portSource(), changed: false })
        }
        const result = await setPort(next)
        return apiJson(result, result.ok ? 200 : (result.status ?? 400))
      },
    }), 'browser-bridge: api port')

    // Detach one browser from the dashboard.
    ctx.effect(() => registerRoute({
      kind: 'exact',
      path: '/browser-bridge/api/disconnect',
      // Web resources are GET/HEAD only; the id travels in the query string.
      resource: async (request) => {
        const id = new URL(request.url, 'http://localhost').searchParams.get('id') ?? ''
        if (!id) return apiJson({ ok: false, error: 'id required' }, 400)
        return apiJson({ ok: bridge.dropBrowser(id) })
      },
    }), 'browser-bridge: api disconnect')

    if (devReload) {
      ctx.effect(() => registerRoute({
        kind: 'exact',
        path: '/browser-bridge/api/dev/status',
        resource: async () => apiJson({ ok: true, devReload: true }),
      }), 'browser-bridge: dev status')

      // Deterministic page for exercising the tools end to end.
      ctx.effect(() => registerRoute({
        kind: 'exact',
        path: '/browser-bridge/dev/fixture',
        resource: async () => new Response(readFileSync(join(here, 'tests', 'fixture.html')), {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        }),
      }), 'browser-bridge: dev fixture')

      // Child document for the fixture's iframe, so frame targeting has real content.
      ctx.effect(() => registerRoute({
        kind: 'exact',
        path: '/browser-bridge/dev/fixture-inner',
        resource: async () => new Response(readFileSync(join(here, 'tests', 'fixture-inner.html')), {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        }),
      }), 'browser-bridge: dev fixture inner')

      // Second-level child document, for nested-frame targeting.
      ctx.effect(() => registerRoute({
        kind: 'exact',
        path: '/browser-bridge/dev/fixture-deep',
        resource: async () => new Response(readFileSync(join(here, 'tests', 'fixture-deep.html')), {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        }),
      }), 'browser-bridge: dev fixture deep')

      // Small interaction benchmark: four mechanics, one word.
      ctx.effect(() => registerRoute({
        kind: 'exact',
        path: '/browser-bridge/dev/arcade',
        resource: async () => new Response(readFileSync(join(here, 'tests', 'arcade.html')), {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        }),
      }), 'browser-bridge: dev arcade')

      // Dev-only command channel so the end-to-end test can drive the browser
      // without a model in the loop. GET with the method and JSON params.
      ctx.effect(() => registerRoute({
        kind: 'exact',
        path: '/browser-bridge/dev/command',
        resource: async (request) => {
          const url = new URL(request.url, 'http://localhost')
          const method = url.searchParams.get('method') ?? ''
          if (!method) return apiJson({ ok: false, error: 'method required' }, 400)
          const raw = url.searchParams.get('params')
          let params = {}
          if (raw) {
            try {
              params = JSON.parse(raw)
            } catch {
              return apiJson({ ok: false, error: 'params must be JSON' }, 400)
            }
          }
          // With several paired profiles the worker refuses to guess, so the dev route
          // accepts an explicit browser (query or params) and routes the command there.
          const browser = url.searchParams.get('browser') ?? (typeof params.browser === 'string' ? params.browser : '')
          if (browser) delete params.browser
          try {
            const result = await bridge.send(method, params, { browser: browser || undefined, timeoutMs: 60000 })
            return apiJson({ ok: true, result })
          } catch (error) {
            return apiJson({ ok: false, error: String(error?.message ?? error), code: error?.code ?? null }, 502)
          }
        },
      }), 'browser-bridge: dev command')

    }

    // What the dashboard reads to show the pinned id and version.
    ctx.effect(() => registerRoute({
      kind: 'exact',
      path: '/browser-bridge/extension-meta.json',
      resource: async () => {
        try {
          const meta = JSON.parse(readFileSync(join(here, 'dist', 'extension-meta.json'), 'utf8'))
          return apiJson({ ...meta, devReload })
        } catch {
          return apiJson({ devReload })
        }
      },
    }), 'browser-bridge: extension meta')
  })

  // Ship the workflow playbook with the plugin: any profile that installs
  // browser-bridge gets `bsb-browser` in its skill catalog, with no project
  // skill file to copy. `inject` waits for the skill service, and the effect is
  // tied to that injected scope so disabling the plugin removes the entry.
  try {
    const bundledSkill = readBundledSkill(join(here, 'skill', 'bsb-browser', 'SKILL.md'))
    ctx.inject(['skills'], (skillCtx) => {
      skillCtx.effect(() => skillCtx.skills.register({
        ...bundledSkill,
        source: 'browser-bridge',
        path: join(here, 'skill', 'bsb-browser', 'SKILL.md'),
        metadata: { owner: 'browser-bridge' },
      }), 'browser-bridge: bsb-browser skill')
    })
  } catch (error) {
    ctx.logger.warn(`browser-bridge: bundled skill unavailable: ${error?.message ?? error}`)
  }

  registerTools(ctx, bridge)
}
