/**
 * Adapt Fetch-style route resources to plain Node request handlers.
 *
 * The plugin's routes are written as `async (request: Request) => Response`,
 * which is the ergonomic shape: build a Response and forget about writeHead,
 * chunking and body encoding. But the harness webserver's route contract has
 * changed over its life:
 *
 *   - 0.2.2-alpha.2 and earlier accepted EITHER `{ resource }` (Fetch shape) or
 *     `{ handler }` (Node shape), dispatching on `'resource' in responder`.
 *   - 0.2.1-rc.5 accepts only `{ handler }` and calls `route.handler(req, res)`
 *     unconditionally.
 *
 * A resource-only route therefore registers fine and then fails on the first
 * request: `route.handler` is undefined, the call throws, and the server's
 * last-resort guard answers 400 with an empty body. That is a confusing
 * symptom — it reads like "the plugin is not serving its web routes" when the
 * routes are in fact registered — so the plugin now always registers a real
 * `handler`, which every version dispatches correctly.
 */

/** Methods a resource may answer. Anything else is a client error, not a crash. */
export const RESOURCE_METHODS = 'GET, HEAD'

/** Upper bound on a resource body, so a runaway route cannot exhaust memory. */
const MAX_BODY_BYTES = 64 * 1024 * 1024

function headersOf(req) {
  const headers = new Headers()
  const source = req?.headers
  if (!source || typeof source !== 'object') return headers
  for (const [name, value] of Object.entries(source)) {
    for (const item of typeof value === 'string' ? [value] : Array.isArray(value) ? value : []) {
      try {
        headers.append(name, item)
      } catch {
        // Node may surface an invalid header name from a malformed request; a
        // route should not die because a client sent junk.
      }
    }
  }
  return headers
}

/** Read a request body, refusing anything larger than the route ceiling. */
async function bodyOf(req) {
  if (req?.method === 'GET' || req?.method === 'HEAD') return undefined
  const declared = Number(req?.headers?.['content-length'] ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw Object.assign(new Error(`request body is ${declared} bytes, over the ${MAX_BODY_BYTES}-byte limit`), { status: 413 })
  }
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) {
      throw Object.assign(new Error(`request body exceeded the ${MAX_BODY_BYTES}-byte limit`), { status: 413 })
    }
    chunks.push(chunk)
  }
  if (chunks.length === 0) return undefined
  return new Uint8Array(Buffer.concat(chunks))
}

/**
 * Wrap a `Request → Response` resource as a Node `(req, res)` handler.
 *
 * @param resource - Fetch-shaped route body.
 * @param label - route name, used in the error text.
 * @param options - `methods` names the verbs this route accepts (default
 *   GET/HEAD). A route that takes a body must opt in, because the Fetch shape
 *   carries no body for GET by design.
 * @returns a handler owning the full response lifecycle.
 */
export function toHandler(resource, label = 'route', { methods = ['GET', 'HEAD'] } = {}) {
  const allowed = [...new Set(methods.map((method) => String(method).toUpperCase()))]
  const allow = allowed.join(', ')
  return async (req, res) => {
    const method = typeof req?.method === 'string' ? req.method.toUpperCase() : 'GET'
    try {
      if (!allowed.includes(method)) {
        res.writeHead(405, { allow, 'content-type': 'text/plain; charset=utf-8' })
        res.end(`method ${method} not allowed; ${allow} only`)
        return
      }
      const target = new URL(req?.url ?? '/', 'http://localhost')
      const init = { method, headers: headersOf(req) }
      const requestBody = await bodyOf(req)
      if (requestBody !== undefined) init.body = requestBody
      const request = new Request(target, init)
      const response = await resource(request)
      if (!response || typeof response !== 'object' || typeof response.arrayBuffer !== 'function') {
        throw new Error(`route ${label} returned ${typeof response} instead of a Response`)
      }
      const declared = Number(response.headers.get('content-length') ?? Number.NaN)
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        throw new Error(`route ${label} announced ${declared} bytes, over the ${MAX_BODY_BYTES}-byte limit`)
      }
      for (const [name, value] of response.headers) {
        // setHeader throws on a bad name or on set-cookie repetition; neither
        // should take the response down.
        try {
          res.setHeader(name, value)
        } catch {}
      }
      const body = method === 'HEAD' ? null : Buffer.from(await response.arrayBuffer())
      res.writeHead(response.status)
      res.end(body ?? undefined)
    } catch (error) {
      // Say which route failed and why. A bare 400 from the server guard is the
      // single least useful failure this plugin can produce.
      const message = String(error?.message ?? error)
      // A route may refuse a request with a specific client-error status by
      // tagging the error; anything untagged is a genuine server fault.
      const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 500
      if (res.headersSent) {
        res.destroy()
        return
      }
      try {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: false, route: label, error: message }))
      } catch {
        res.destroy?.()
      }
    }
  }
}
