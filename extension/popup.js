/**
 * The badge's data: who this browser is, which host issued it, and whether it
 * is attached right now — plus one action, pairing.
 *
 * Pairing normally happens on the dsh Web UI page ("Connect this browser"). That
 * cannot work when dsh runs as a desktop (Electron) app: the window has no
 * chrome.runtime, so the extension is unreachable from it. The popup therefore
 * takes the pairing link itself. It is a paste field rather than a discovery
 * sweep on purpose: the plugin page already shows the exact link, so pasting is
 * both cheaper (no probing) and complete (any port). Opening the popup still
 * makes exactly one call, to `/state`.
 */

import { whoami } from './identity.js'

const $ = (id) => document.getElementById(id)

/**
 * Encode a browser id as the machine-readable band.
 *
 * This is the badge's signature, so it has to be a real encoding rather than
 * decoration: each character drives one bar's width and height, which means two
 * browsers never wear the same band and the same browser always does.
 */
function drawBand(id) {
  const host = $('bars')
  if (!host) return
  const chars = String(id ?? '').replace(/-/g, '')
  // No id, no stripe. Encoding zeros drew a pattern that looked like data and
  // carried none; the stylesheet turns the empty band into one quiet rule.
  host.classList.toggle('is-empty', chars.length === 0)
  if (chars.length === 0) {
    host.replaceChildren()
    return
  }
  const source = chars
  const fragment = document.createDocumentFragment()
  // Two bars per character: one from the character code, one from its
  // position, which fills the strip edge to edge and keeps the pattern stable
  // for a given id.
  let order = 0
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index)
    for (const mixed of [code, code * 7 + index * 31]) {
      const bar = document.createElement('i')
      bar.style.width = `${2 + (mixed % 2)}px`
      bar.style.height = `${7 + (mixed % 5) * 2}px`
      bar.style.setProperty('--i', String(order))
      fragment.append(bar)
      order += 1
    }
  }
  host.replaceChildren(fragment)
}

/**
 * Paint one status: the word, and a light that moves only when something is
 * happening. `live` breathes green, `warn` pulses amber, anything else sits
 * still and grey — stillness itself means "nothing to report", so a still dot
 * is a statement rather than a missing animation.
 */
function setStatus(text, tone) {
  const state = $('state')
  const lamp = $('lamp')
  if (state) state.textContent = text
  if (!lamp) return
  const live = tone === true || tone === 'live'
  // Toggle the two state classes instead of replacing className: a refresh lands
  // every 5 s and used to wipe an in-flight `pulse`, cutting the burst short.
  lamp.classList.toggle('live', live)
  lamp.classList.toggle('warn', !live && tone === 'warn')
}

function setIssuer(endpoint) {
  const issuer = $('issuer')
  if (!issuer) return
  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    issuer.textContent = '—'
    return
  }
  try {
    issuer.textContent = new URL(endpoint).host
  } catch {
    issuer.textContent = '—'
  }
}

/**
 * The one line under the pairing field.
 *
 * Every failure says the same thing on purpose: the causes are different
 * (mistyped link, nothing listening, refused by the bridge, no extension API)
 * but the reader's next move is identical — check the link and try again —
 * and a per-cause sentence was both longer and easier to get wrong than right.
 * The specific reason still lands in the console for debugging.
 */
/**
 * Fail the action instead of describing the failure.
 *
 * The button turns red and shakes once, then stays red until the field changes.
 * The cause still reaches the console, so nothing is lost for debugging; what
 * the reader loses is a sentence to parse before knowing the paste did not work.
 */
const failPairing = (reason) => {
  if (reason) console.warn('browser-bridge:', reason)
  const button = $('pair')
  if (!button) return
  button.classList.remove('is-error')
  // Force a reflow so a repeat failure replays the shake instead of being
  // deduplicated by the class already being present.
  void button.offsetWidth
  button.classList.add('is-error')
}

/**
 * Play the light's burst once.
 *
 * Called when the popup opens and when a pairing succeeds — never on a loop.
 * The rings are 900 ms × 2, so the class is dropped just after they finish; the
 * reflow between remove and add lets a second call restart the animation
 * instead of being ignored because the class was already there.
 */
let pulseTimer
const pulseLamp = () => {
  const lamp = $('lamp')
  if (!lamp) return
  clearTimeout(pulseTimer)
  lamp.classList.remove('pulse')
  void lamp.offsetWidth
  lamp.classList.add('pulse')
  pulseTimer = setTimeout(() => lamp.classList.remove('pulse'), 2000)
}

/** Ask one endpoint who it is; resolves to its hello body, or null. */
async function helloAt(endpoint) {
  try {
    const body = await fetch(`${endpoint}/hello`, { cache: 'no-store' }).then((response) => (response.ok ? response.json() : null))
    return body?.name === 'browser-bridge' ? body : null
  } catch {
    return null
  }
}

/**
 * Pair from a pasted link.
 *
 * The link carries everything needed, including which port the bridge is on, so
 * pasting is both the fallback and the exact answer — no probing, no guessing.
 */
async function pairWithUrl(raw) {
  const endpoint = String(raw ?? '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\/[^/]+\/p\/[0-9a-f]{64}$/i.test(endpoint)) {
    failPairing('not a pairing link: ' + endpoint)
    return
  }
  let parsed
  try {
    parsed = new URL(endpoint)
  } catch {
    failPairing('unparsable pairing link: ' + endpoint)
    return
  }
  $('pair')?.classList.remove('is-error')
  let target = endpoint
  let hello = await helloAt(endpoint)
  if (!hello) {
    // The same bridge can be announced on an address this browser cannot route
    // to — WSL advertises its LAN address while Chrome on Windows can only see
    // loopback (mirrored networking), and a link copied between machines does
    // the same. The token is the authority, not the hostname, so the same port
    // on loopback is worth one probe before declaring failure.
    const loopback = `http://127.0.0.1:${parsed.port || (parsed.protocol === 'https:' ? 443 : 80)}${parsed.pathname}`
    if (loopback !== endpoint) {
      hello = await helloAt(loopback)
      if (hello) target = loopback
    }
  }
  if (!hello) {
    failPairing('nothing answered at ' + parsed.host)
    return
  }
  await pairWith({ origin: new URL(target).origin, endpoint: target })
}

async function pairWith(entry) {
  try {
    const me = await whoami()
    // A browser detached from a dashboard is blocked server-side; pairing is
    // exactly the intent that lifts the block.
    try { await fetch(`${entry.endpoint}/allow?id=${encodeURIComponent(me.id)}`, { cache: 'no-store' }) } catch {}
    const { servers = [] } = await chrome.storage.local.get('servers')
    const next = (Array.isArray(servers) ? servers : []).filter((server) => server.origin !== entry.origin)
    next.push({ origin: entry.origin, endpoint: entry.endpoint })
    await chrome.storage.local.set({ servers: next, endpoint: entry.endpoint })
    chrome.runtime.sendMessage({ type: 'refresh' }, () => void chrome.runtime.lastError)
    setIssuer(entry.endpoint)
    setStatus('Connected', true)
    const button = $('pair')
    if (button) {
      button.classList.remove('is-error')
      button.classList.add('is-ok')
      // Matches the shake's weight: long enough to be seen, short enough that the
      // button is neutral again before the next attempt.
      setTimeout(() => button.classList.remove('is-ok'), 900)
    }
    pulseLamp()
    const input = $('url')
    if (input) input.value = ''
  } catch (error) {
    setStatus('Not connected', false)
    failPairing(error)
  }
}

$('pair')?.addEventListener('click', async () => {
  const button = $('pair')
  const input = $('url')
  // Nothing to pair is not a failure: put the cursor where the answer goes
  // instead of flashing red at someone who just pressed the only button.
  if (!String(input?.value ?? '').trim()) {
    input?.focus()
    return
  }
  if (button) button.disabled = true
  try {
    await pairWithUrl(input?.value ?? '')
  } finally {
    if (button) button.disabled = false
  }
})

$('url')?.addEventListener('input', () => $('pair')?.classList.remove('is-error'))

$('url')?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault()
    void pairWithUrl($('url')?.value ?? '')
  }
})

try {
  const me = await whoami()
  // No headline any more: the popup opens on the action. The exact build the
  // browser reports still travels with the id, as a hover detail — invisible
  // until asked for, which is the point of this layout.
  if (me.detail && $('ident')) $('ident').title = me.detail
  if ($('ident')) $('ident').textContent = me.id
  drawBand(me.id)

  /**
   * Read the pairing state once and paint it.
   *
   * Called again on a slow timer while the popup is open: the light is the only
   * thing here that can change without the user doing anything, so a single
   * snapshot made it lie whenever the page was opened during a reconnect (it
   * said "Reconnecting" for as long as you kept looking). Five seconds is a
   * single request against a loopback endpoint, and the interval dies with the
   * popup, which closes on blur.
   */
  const refreshStatus = async () => {
    const { endpoint } = await chrome.storage.local.get('endpoint')
    setIssuer(endpoint)
    if (typeof endpoint !== 'string' || endpoint.length === 0) {
      setStatus('Not connected', false)
      return
    }
    try {
      const body = await fetch(`${endpoint.replace(/\/+$/, '')}/state`, { cache: 'no-store' }).then((r) => r.json())
      const live = (body.browsers ?? []).find((entry) => entry.id === me.id)
      setStatus(live?.connected ? 'Connected' : 'Reconnecting', live?.connected ? 'live' : 'warn')
    } catch {
      setStatus('Reconnecting', 'warn')
    }
  }

  await refreshStatus()
  pulseLamp()
  // The first read can land mid-reconnect (the worker restarts on self-update);
  // one quick re-read settles it without waiting a whole interval.
  setTimeout(() => { void refreshStatus() }, 1200)
  const statusTimer = setInterval(() => { void refreshStatus() }, 5000)
  addEventListener('pagehide', () => clearInterval(statusTimer), { once: true })
} catch {
  // Opened outside the extension (local preview): keep the badge readable.
  drawBand('preview000000')
  setStatus('Not connected', false)
}
