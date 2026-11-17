/**
 * Port probing for the connect flow.
 *
 * This is the engine's only "discovery": the Web UI page already knows which host
 * dsh lives on (it was served from there), so the extension just needs to find
 * which port the bridge listens on. There is no LAN scanning, no subnet guessing,
 * and no UI — connecting is an explicit button press on that page.
 */

// The sweep window. Every port here costs one probe on Connect, and 21 ports in
// parallel is still a fraction of a second — worth it, because a second dsh on
// the same machine (Windows beside WSL under mirrored networking) commonly needs
// a port a few above the default. A port outside this range still works: the
// popup accepts a pasted pairing URL.
export const DEFAULT_PORTS = Array.from({ length: 21 }, (_, index) => 8791 + index)

const PROBE_TIMEOUT_MS = 1200

async function permitted(base) {
  try {
    if (!chrome?.permissions?.contains) return true
    // Match patterns carry no port, so drop it before asking.
    return await chrome.permissions.contains({ origins: [`${base.replace(/:\d+$/, '')}/*`] })
  } catch {
    return true
  }
}

async function probe(base) {
  if (!(await permitted(base))) return { origin: base, blocked: true }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(`${base}/discover`, { cache: 'no-store', signal: controller.signal })
    if (!response.ok) return undefined
    const body = await response.json()
    if (body?.name !== 'browser-bridge') return undefined
    if (typeof body.pairingUrl === 'string' && body.pairingUrl.length > 0) {
      return { origin: base, endpoint: body.pairingUrl.replace(/\/+$/, ''), version: String(body.version ?? '') }
    }
    return { origin: base, needsLink: true, version: String(body.version ?? '') }
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/** Probe `hosts` across the bridge port range; returns the answers. */
export async function discoverEndpoints({ hosts = [], ports = DEFAULT_PORTS } = {}) {
  const bases = []
  for (const host of hosts) for (const port of ports) bases.push(`http://${host}:${port}`)
  if (bases.length === 0) return []
  const results = await Promise.all(bases.map(probe))
  const unique = new Map()
  for (const found of results) {
    if (!found) continue
    const key = found.endpoint ?? found.origin
    if (!unique.has(key)) unique.set(key, found)
  }
  return [...unique.values()]
}
