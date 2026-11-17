/**
 * Transport for browser-bridge.
 *
 * The browser cannot accept inbound connections, so each extension instance
 * polls this server and identifies itself (`id` + `label`). Commands are queued
 * per browser and delivered to that browser's open poll, so several browsers can
 * be attached at once without stealing each other's work.
 *
 * Wire format and routes are specified in README.md. Nothing here knows what a
 * browser is: it moves `{method, params}` out and results back.
 *
 * @module browser-bridge/bridge
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const PROTOCOL = 2
export const VERSION = '1.1.296'

/** Messages this class throws carry a stable code the tools pass through. */
/**
 * Translate a host file path for a browser that runs on another platform.
 *
 * The bridge runs in WSL and the browser often runs on Windows. A Linux path
 * that the host can read does not exist for the browser, and Chrome accepts it
 * anyway: `DOM.setFileInputFiles` attaches a file entry with the right name and
 * zero bytes, so an import reports "Success!" over an empty sheet. Translate at
 * the transport boundary, where the browser's user agent is known.
 */
export function translateFilePath(file, userAgent = '', distro = '') {
  if (typeof file !== 'string' || file.length === 0) return file
  if (!/windows/i.test(String(userAgent))) return file
  const path = file.trim()
  if (!path.startsWith('/')) return path
  const drive = /^\/mnt\/([a-z])\/(.*)$/i.exec(path)
  if (drive) return `${drive[1].toUpperCase()}:\\${drive[2].replace(/\//g, '\\')}`
  const name = distro || process.env.WSL_DISTRO_NAME || ''
  if (!name) return path
  return `\\\\wsl.localhost\\${name}${path.replace(/\//g, '\\')}`
}

export class BridgeError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
  }
}

const CONNECTED_WINDOW_MS = 12000
const MAX_BODY_BYTES = 16 * 1024 * 1024
const MAX_QUEUE = 64
const FORGET_AFTER_MS = 60 * 60 * 1000
const NO_BROWSER =
  'No browser is connected. Open the browser-bridge extension and press Connect on a dsh server. If it was connected, the extension is reconnecting; retry in a few seconds.'

const sha256 = (value) => createHash('sha256').update(value).digest()

/** Constant-time token comparison that does not leak the token's length. */
function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0) return false
  return timingSafeEqual(sha256(a), sha256(b))
}

/** Persist a token once; `0600`, created with a private directory. */
export function loadToken(dshHome) {
  const file = join(dshHome, 'browser-bridge', 'token')
  // The plugin was renamed from its old dsh-web-bridge name; carry the legacy pairing token
  // across so an already-connected extension is not silently logged out.
  const legacy = join(dshHome, 'web-bridge', 'token')
  try {
    const existing = readFileSync(file, 'utf8').trim()
    if (/^[0-9a-f]{64}$/.test(existing)) return { token: existing, file }
  } catch {}
  try {
    const previous = readFileSync(legacy, 'utf8').trim()
    if (/^[0-9a-f]{64}$/.test(previous)) {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      writeFileSync(file, `${previous}\n`, { mode: 0o600 })
      try { chmodSync(file, 0o600) } catch {}
      return { token: previous, file }
    }
  } catch {}
  const token = randomBytes(32).toString('hex')
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, `${token}\n`, { mode: 0o600 })
  try { chmodSync(file, 0o600) } catch {}
  return { token, file }
}

export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return join(homedir(), '.dsh')
}

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function empty(res, status) {
  res.writeHead(status, { 'cache-control': 'no-store' })
  res.end()
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new BridgeError('BODY_TOO_LARGE', 'request body exceeds the limit'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export class Bridge {
  #server
  #pending = new Map()
  #browsers = new Map()
  #chains = new Map()
  #blocked = new Set()
  #seq = 0
  #disposed = false
  #log

  constructor({ host = '127.0.0.1', port = 8791, token, advertise, allowRemotePairing = false, log } = {}) {
    this.host = host
    this.port = port
    this.token = token
    /** Address the extension should dial; defaults to the bind address when routable. */
    this.advertise = advertise
    /** Whether a non-loopback peer may receive the token from /discover. */
    this.allowRemotePairing = allowRemotePairing === true
    this.#log = log
  }

  /** Dialable URL; the extension obtains it from /discover, never by hand. */
  get pairingUrl() {
    const wildcard = this.host === '0.0.0.0' || this.host === '::'
    const host = this.advertise || (wildcard ? '127.0.0.1' : this.host)
    return `http://${host}:${this.port}/p/${this.token}`
  }

  /**
   * Default target for a tool call.
   *
   * Prefers the live browser that most recently *received* a command, so an idle
   * browser polling in the background never takes over as the default. Falls
   * back to the most recently seen live browser, then to anything known.
   */
  get activeBrowserId() {
    const live = [...this.#browsers.values()].filter((entry) => this.#isLive(entry))
    const byCommand = live.filter((entry) => entry.lastCommandAt > 0)
    if (byCommand.length > 0) {
      return byCommand.reduce((best, entry) => (entry.lastCommandAt > best.lastCommandAt ? entry : best)).id
    }
    if (live.length > 0) {
      return live.reduce((best, entry) => (entry.lastSeenAt > best.lastSeenAt ? entry : best)).id
    }
    let best
    let bestAt = -1
    for (const entry of this.#browsers.values()) {
      if (entry.lastSeenAt > bestAt) {
        best = entry
        bestAt = entry.lastSeenAt
      }
    }
    return best?.id
  }

  get connected() {
    for (const entry of this.#browsers.values()) if (this.#isLive(entry)) return true
    return false
  }

  get lastSeenSec() {
    let latest = -1
    for (const entry of this.#browsers.values()) latest = Math.max(latest, entry.lastSeenAt)
    return latest < 0 ? -1 : Math.round((Date.now() - latest) / 1000)
  }

  /** Snapshot for tools and the dashboard. */
  browsers() {
    const active = this.activeBrowserId
    return [...this.#browsers.values()]
      .map((entry) => ({
        id: entry.id,
        label: entry.label,
        connected: this.#isLive(entry),
        version: entry.extensionVersion ?? '',
        lastSeenSec: Math.round((Date.now() - entry.lastSeenAt) / 1000),
        active: entry.id === active,
      }))
      .sort((a, b) => Number(b.active) - Number(a.active) || a.lastSeenSec - b.lastSeenSec)
  }

  async start() {
    this.#server = createServer((req, res) => {
      this.#route(req, res).catch((error) => {
        this.#log?.warn?.(`browser-bridge: request failed: ${error?.message ?? error}`)
        if (!res.headersSent) json(res, 500, { ok: false, error: { message: 'internal error' } })
      })
    })
    this.#server.keepAliveTimeout = 5000
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.#server?.off('error', onError)
        reject(error)
      }
      this.#server.once('error', onError)
      this.#server.listen(this.port, this.host, () => {
        this.#server?.off('error', onError)
        resolve()
      })
    })
    return this.pairingUrl
  }

  /**
   * Wait briefly for in-flight commands to settle.
   *
   * Moving the listener disposes this instance, and a disposal fails every
   * pending command — which reads to the caller as "the plugin was unloaded"
   * even though the click they asked for did run. Draining first lets those
   * results land before the swap, so the common case keeps its answer.
   *
   * @param ms - longest wait, in milliseconds.
   * @returns the number of commands still pending when the wait ended.
   */
  async drain(ms = 1500) {
    const deadline = Date.now() + ms
    while (this.#pending.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return this.#pending.size
  }

  dispose(reason = {}) {
    this.#disposed = true
    for (const entry of this.#browsers.values()) {
      if (entry.waiter) {
        clearTimeout(entry.waiter.timer)
        try { empty(entry.waiter.res, 204) } catch {}
        entry.waiter = undefined
      }
    }
    // A port move is not an unload: name the real reason so the caller knows to
    // retry rather than to go looking for a crashed plugin.
    const code = typeof reason.code === 'string' && reason.code ? reason.code : 'CLOSED'
    const message = typeof reason.message === 'string' && reason.message
      ? reason.message
      : 'the browser-bridge plugin was unloaded'
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new BridgeError(code, message))
    }
    this.#pending.clear()
    this.#browsers.clear()
    try { this.#server?.close() } catch {}
    this.#server = undefined
  }

  /**
   * Send one command to one browser.
   *
   * Serialized per browser: each is a single stateful tab, so two calls must not
   * interleave there, while two different browsers may work in parallel.
   */
  send(method, params = {}, { browser, timeoutMs = 30000 } = {}) {
    const run = async () => {
      if (this.#disposed) throw new BridgeError('CLOSED', 'the browser-bridge plugin was unloaded')
      const id = this.#resolveBrowser(browser)
      const entry = this.#browsers.get(id)
      if (!entry) throw new BridgeError('UNKNOWN_BROWSER', `no browser named "${browser}" is connected`)
      // A page that is busy painting (a canvas game, a long recording) can
      // make the extension miss a poll or two. Wait briefly for the next one
      // instead of failing a command the browser would have handled a moment
      // later — transient gaps are the common case, a closed tab is not.
      if (!this.#isLive(entry) && !(await this.#waitLive(id, 6000))) {
        // Name the likely cause. A Vite full reload, a chunk-generation burst or
        // a long recording makes the worker miss polls, and the bare "not
        // responding" reads like a dead browser when it is usually just busy.
        const silence = Math.round((Date.now() - (entry.lastSeenAt ?? Date.now())) / 1000)
        throw new BridgeError(
          'NO_BROWSER',
          `${entry.label || id} has not polled for ${silence}s; the page is probably reloading or busy (a dev-server reload, heavy canvas work, a long recording). Retry in a few seconds — if it persists, check that the tab is open.`,
        )
      }
      if (entry.queue.length >= MAX_QUEUE) throw new BridgeError('BUSY', 'the browser is behind on commands; retry')
      // Validate BEFORE creating the command promise. A throw after the promise
      // exists orphans it: its timeout timer then rejects with no handler, and
      // Node exits the whole host on an unhandled rejection. A remote-browser
      // upload hit exactly that and took DSH down.
      const enriched = { ...params }
      // Tab identity lives on the host too: extension storage can be wiped by a
      // reload between two tool calls, which would orphan the page.
      if (enriched.tabId === undefined && entry.lastTabId !== undefined && method !== 'open' && method !== 'tabs') {
        enriched.tabId = entry.lastTabId
      }
      // A file path from this host may not exist on the browser's machine.
      if ((method === 'upload' || method === 'drop') && Array.isArray(enriched.files) && enriched.files.length > 0) {
        const loopback = !entry.remoteAddress || /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(entry.remoteAddress)
        const hostPath = enriched.files.find((file) => typeof file === 'string' && file.trim().startsWith('/'))
        if (!loopback && hostPath) {
          // A remote browser cannot read this host's file system. Chrome accepts
          // the path and attaches a zero-byte file, so the failure would look like
          // a successful upload with unreadable content.
          throw new BridgeError(
            'FILE_NOT_ON_BROWSER',
            `browser ${entry.label || id} is remote (${entry.remoteAddress}), so the host path ${JSON.stringify(hostPath)} does not exist on its machine. `
            + 'Pass a path that exists on the browser (for example C:\\... on a Windows browser), or serve the file over http and download it there.',
          )
        }
        enriched.files = enriched.files.map((file) => translateFilePath(file, entry.userAgent))
      }
      const commandId = String(++this.#seq)
      const result = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.#pending.delete(commandId)
          reject(new BridgeError('TIMEOUT', `the browser did not answer "${method}" within ${Math.round(timeoutMs / 1000)}s`))
        }, timeoutMs)
        this.#pending.set(commandId, { resolve, reject, timer, method, browser: id })
      })
      // Belt and braces: even if a later line throws, the promise is handled.
      result.catch(() => {})
      entry.lastCommandAt = Date.now()
      entry.queue.push({ id: commandId, method, params: enriched })
      this.#deliver(entry)
      return result
    }
    const key = browser ?? 'auto'
    const chain = (this.#chains.get(key) ?? Promise.resolve()).then(run, run)
    // A caller that stops waiting (a cancelled tool call, a fire-and-forget
    // path) must not turn a browser timeout into an unhandled rejection. Node
    // exits the whole process on those, so a slow browser could take the host
    // down. Mark the promise handled here; callers that await it still get the
    // rejection.
    chain.catch(() => {})
    this.#chains.set(key, chain.then(() => {}, () => {}))
    return chain
  }

  async #waitLive(id, waitMs) {
    const started = Date.now()
    while (Date.now() - started < waitMs) {
      const entry = this.#browsers.get(id)
      if (entry && this.#isLive(entry)) return entry
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return undefined
  }

  #resolveBrowser(browser) {
    if (typeof browser !== 'string' || browser.length === 0) {
      const live = [...this.#browsers.values()].filter((entry) => this.#isLive(entry))
      if (live.length > 1) {
        // A live tracked target wins over a fresh connection: the active browser
        // is the one that last received work, so continuing there is what the
        // caller already meant. Only ask for a choice when no target is active.
        const tracked = this.activeBrowserId
        if (tracked !== undefined && live.some((entry) => entry.id === tracked)) return tracked
        const choices = live.map((entry) => {
          const tab = entry.lastTabId === undefined ? '' : `, tab ${entry.lastTabId}`
          return `${entry.label || entry.id} (${entry.id}${tab})`
        }).join(', ')
        throw new BridgeError(
          'AMBIGUOUS_BROWSER',
          `${live.length} browsers are connected: ${choices}. None holds an active tracked tab; pass browser with an id.`,
        )
      }
      const active = this.activeBrowserId
      if (active === undefined) throw new BridgeError('NO_BROWSER', NO_BROWSER)
      return active
    }
    const needle = browser.toLowerCase()
    if (this.#browsers.has(browser)) return browser
    for (const entry of this.#browsers.values()) if (entry.id.startsWith(needle)) return entry.id
    for (const entry of this.#browsers.values()) {
      if (entry.label.toLowerCase().includes(needle)) return entry.id
    }
    throw new BridgeError('UNKNOWN_BROWSER', `no browser matches "${browser}"; call bsb_browsers to list them`)
  }

  #isLive(entry) {
    return entry.waiter !== undefined || Date.now() - entry.lastSeenAt < CONNECTED_WINDOW_MS
  }

  /** Detach one browser: fail its in-flight command and forget it. */
  dropBrowser(id) {
    // Mark it blocked, otherwise the worker re-polls immediately and re-registers.
    this.#blocked.add(id)
    const entry = this.#browsers.get(id)
    if (!entry) return false
    if (entry.waiter) {
      clearTimeout(entry.waiter.timer)
      try { empty(entry.waiter.res, 204) } catch {}
      entry.waiter = undefined
    }
    this.#browsers.delete(id)
    for (const [commandId, pending] of this.#pending) {
      if (pending.browser !== id) continue
      clearTimeout(pending.timer)
      this.#pending.delete(commandId)
      pending.reject(new BridgeError('DISCONNECTED', 'the browser was detached from the dashboard'))
    }
    return true
  }

  /** Let a detached browser back in (the page's Connect button calls this). */
  allowBrowser(id) {
    this.#blocked.delete(id)
    return true
  }

  /** Hand the next queued command to this browser's waiting poll, if any. */
  #deliver(entry) {
    if (!entry.waiter) return
    const command = entry.queue.shift()
    if (!command) return
    const waiter = entry.waiter
    entry.waiter = undefined
    clearTimeout(waiter.timer)
    try { json(waiter.res, 200, command) } catch {}
  }

  #touch(id, label, userAgent, remoteAddress) {
    let entry = this.#browsers.get(id)
    if (!entry) {
      entry = { id, label: '', lastSeenAt: 0, lastCommandAt: 0, waiter: undefined, queue: [], userAgent: '', remoteAddress: '' }
      this.#browsers.set(id, entry)
    }
    entry.lastSeenAt = Date.now()
    if (typeof label === 'string' && label.trim().length > 0) entry.label = label.trim().slice(0, 64)
    if (typeof userAgent === 'string' && userAgent.length > 0) entry.userAgent = userAgent.slice(0, 200)
    if (typeof remoteAddress === 'string' && remoteAddress.length > 0) entry.remoteAddress = remoteAddress
    return entry
  }

  #prune() {
    const cutoff = Date.now() - FORGET_AFTER_MS
    for (const [id, entry] of this.#browsers) {
      if (!entry.waiter && entry.queue.length === 0 && entry.lastSeenAt < cutoff) this.#browsers.delete(id)
    }
  }

  /**
   * Answer discovery probes from the extension.
   *
   * The caller has no token yet, so this route cannot require one. Across a LAN
   * the token is only handed out when the operator opted in: otherwise any
   * device on the network could take over a paired browser.
   */
  #discover(req, res) {
    const origin = req.headers.origin
    if (typeof origin === 'string' && origin.length > 0 && !origin.startsWith('chrome-extension://')) {
      return empty(res, 403)
    }
    const remote = req.socket.remoteAddress ?? ''
    const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
    const base = { ok: true, name: 'browser-bridge', protocol: PROTOCOL, version: VERSION }
    // Answer with the address the caller actually reached us on. Handing out the
    // advertised LAN address to a client that connected over loopback makes that
    // client dial a hairpin it cannot route, which times out forever.
    const host = req.headers.host
    const pairingUrl = typeof host === 'string' && host.length > 0
      ? `http://${host}/p/${this.token}`
      : this.pairingUrl
    if (loopback || this.allowRemotePairing) {
      return json(res, 200, { ...base, pairingUrl })
    }
    return json(res, 200, { ...base, needsLink: true })
  }

  async #route(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.method === 'GET' && url.pathname === '/discover') return this.#discover(req, res)

    const segments = url.pathname.split('/').filter(Boolean)
    if (segments.length !== 3 || segments[0] !== 'p' || !sameToken(segments[1], this.token)) {
      return empty(res, 404)
    }
    const action = segments[2]
    const method = req.method ?? 'GET'

    if (method === 'GET' && action === 'hello') {
      return json(res, 200, { ok: true, name: 'browser-bridge', protocol: PROTOCOL, version: VERSION })
    }

    if (method === 'GET' && action === 'version') {
      return json(res, 200, { ok: true, version: this.extensionVersion ?? '' })
    }

    if (method === 'GET' && action === 'allow') {
      const id = url.searchParams.get('id') ?? ''
      return json(res, 200, { ok: id.length > 0 && this.allowBrowser(id) })
    }

    if (method === 'GET' && action === 'state') {
      return json(res, 200, {
        ok: true,
        version: VERSION,
        active: this.activeBrowserId ?? null,
        pending: this.#pending.size,
        browsers: this.browsers(),
      })
    }

    if (method === 'GET' && action === 'status') {
      return json(res, 200, {
        ok: true,
        connected: this.connected,
        lastSeenSec: this.lastSeenSec,
        pending: this.#pending.size,
        browsers: this.browsers(),
      })
    }

    if (method === 'GET' && action === 'poll') {
      const id = url.searchParams.get('id')
      if (typeof id !== 'string' || !/^[0-9a-zA-Z_-]{4,64}$/.test(id)) {
        return json(res, 400, { ok: false, error: 'id is required' })
      }
      if (this.#blocked.has(id)) {
        return json(res, 410, { ok: false, blocked: true })
      }
      this.#prune()
      const entry = this.#touch(id, url.searchParams.get('label') ?? '', req.headers['user-agent'] ?? '', req.socket.remoteAddress ?? '')
      entry.extensionVersion = url.searchParams.get('v') ?? entry.extensionVersion ?? ''
      if (entry.waiter) return empty(res, 204) // one poll per browser
      const command = entry.queue.shift()
      if (command) return json(res, 200, command)
      const requested = Number(url.searchParams.get('waitMs') ?? 20000)
      const waitMs = Number.isFinite(requested) ? Math.min(Math.max(requested, 1000), 30000) : 20000
      const waiter = { res, timer: undefined }
      waiter.timer = setTimeout(() => {
        if (entry.waiter === waiter) {
          entry.waiter = undefined
          try { empty(res, 204) } catch {}
        }
      }, waitMs)
      entry.waiter = waiter
      req.on('close', () => {
        if (entry.waiter === waiter) {
          clearTimeout(waiter.timer)
          entry.waiter = undefined
        }
      })
      return undefined
    }

    if (method === 'POST' && action === 'result') {
      const raw = await readBody(req, MAX_BODY_BYTES)
      let body
      try { body = JSON.parse(raw) } catch { return json(res, 400, { ok: false }) }
      const pending = this.#pending.get(String(body?.id))
      if (!pending) return json(res, 409, { ok: false, error: 'unknown command id' })
      this.#pending.delete(String(body.id))
      clearTimeout(pending.timer)
      const entry = this.#browsers.get(pending.browser)
      if (entry) {
        entry.lastSeenAt = Date.now()
        const tabId = body?.result?.tabId
        if (typeof tabId === 'number') entry.lastTabId = tabId
      } // a result is proof of life between polls
      if (body.ok === true) {
        pending.resolve(body.result ?? null)
      } else {
        const message = typeof body?.error?.message === 'string' && body.error.message
          ? body.error.message
          : 'the browser reported a failure'
        const code = typeof body?.error?.code === 'string' && body.error.code ? body.error.code : 'BROWSER_ERROR'
        pending.reject(new BridgeError(code, message))
      }
      return json(res, 200, { ok: true })
    }

    return empty(res, 404)
  }
}

export { NO_BROWSER }
