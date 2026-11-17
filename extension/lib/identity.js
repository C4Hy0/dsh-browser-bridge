/**
 * This browser's identity, shared by the worker and the popup.
 *
 * The id is generated once and kept in `storage.local`; regenerating it would
 * orphan any queued command the plugin still attributes to the old one.
 *
 * The label is the browser's own product token and its full build, written the
 * way the browser itself writes it — `Chrome/157.0.8103.38`,
 * `Edg/156.0.4314.58`. Nothing here names a vendor or a platform: Chromium
 * forks report "Google Chrome" whatever they are, so any friendly name would be
 * a guess. The token is in the UA and cannot lie about itself.
 */

let cached

/** Escape a token before it goes into a RegExp. */
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Tokens that are never the browser itself: the engine, platform and grammar
 * words every UA carries in front of its product token. Everything that is not
 * one of these *is* a product token, which is what lets a browser the plugin has
 * never heard of be named without listing it anywhere.
 */
const NOT_A_BROWSER = /^(mozilla|applewebkit|gecko|khtml|like|safari|version|mobile|windows|macintosh|linux|x11|rv)$/i

/**
 * The product token this browser puts in its UA.
 *
 * There is no list of browser names. Chromium descendants all carry `Chrome/`
 * and then append their own token, so the LAST product token is the browser:
 * `Chrome` for Chrome, `Edg` for Edge, `OPR` for Opera, `Vivaldi` for Vivaldi,
 * and whatever an unknown fork calls itself. A hardcoded preference order was
 * tried first and was wrong the moment a fork shipped — `Chrome/` matched
 * before its own token was ever looked at.
 */
export function productName(ua = '') {
  const found = [...ua.matchAll(/([A-Za-z][\w.-]*)\/[\d.]+/g)]
    .map((match) => match[1])
    .filter((token) => !NOT_A_BROWSER.test(token))
  if (found.length > 0) return found[found.length - 1]
  // A UA with no product token at all — a stub, or a client that withholds it.
  return 'Browser'
}

/**
 * The full build string ("157.0.8103.38").
 *
 * Client hints carry it exactly; the UA string is the fallback for browsers that
 * do not implement them, where it is the reduced `157.0.0.0` form.
 */
async function buildVersion() {
  const uaData = typeof navigator === 'undefined' ? undefined : navigator.userAgentData
  if (uaData) {
    try {
      const hints = await Promise.race([
        uaData.getHighEntropyValues(['uaFullVersion', 'fullVersionList']),
        new Promise((resolve) => setTimeout(() => resolve(null), 400)),
      ])
      if (hints?.uaFullVersion) return String(hints.uaFullVersion)
      // Decoys ship a fake "99" version, so skip anything that is not a real
      // brand name before trusting its number.
      const real = (hints?.fullVersionList ?? uaData.brands ?? [])
        .filter((entry) => entry && typeof entry.version === 'string' && !/not.?a.?brand/i.test(entry.brand))
      if (real.length > 0) return String(real[0].version)
    } catch {
      // Withheld by policy: fall through to the UA string.
    }
  }
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  // Read the version off the browser's OWN token, not Chrome/: an Edge UA
  // contains both, and Chrome/'s number there is not Edge's version.
  const match = new RegExp(`${escapeRe(productName(ua))}/([\\d.]+)`).exec(ua)
  return match ? match[1] : ''
}

/** The label every surface shows for this browser: `token/version`. */
export async function detectLabel() {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  const version = await buildVersion()
  const name = productName(ua)
  return version ? `${name}/${version}` : name
}

export async function whoami() {
  if (cached) return cached
  const { browserId } = await chrome.storage.local.get('browserId')
  let id = browserId
  if (typeof id !== 'string' || !/^[0-9a-zA-Z_-]{4,64}$/.test(id)) {
    id = crypto.randomUUID().replace(/-/g, '').slice(0, 12)
    await chrome.storage.local.set({ browserId: id })
  }
  cached = {
    id,
    label: await detectLabel(),
    // The untouched UA string, for the popup's hover detail: no parsing, no
    // claims — just what the browser says about itself.
    detail: typeof navigator === 'undefined' ? '' : navigator.userAgent,
  }
  return cached
}
