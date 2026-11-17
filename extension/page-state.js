// Browser Bridge worker: page-state.
// Split from extension/sw.js; keep the module boundaries in docs/SPEC.md in sync.
import { evaluate } from './cdp.js'
import { NAV_OUTCOME_MAX } from './constants.js'
import { shared } from './state.js'
import { documentIsHealthy } from './util.js'

/**
 * The document as the browser reports it, read-only.
 *
 * One probe shared by every navigation-reporting tool, so bsb_open, bsb_read,
 * bsb_tabs and bsb_wait_for cannot disagree about the same document. It also
 * names a splash or shell: a page whose DOM exists but which paints no content
 * is otherwise indistinguishable from a loaded empty page.
 *
 * `httpStatus` comes from the navigation timing entry and falls back to the
 * status Chrome prints on its own error page, so a 429 is named without a
 * network capture armed before the navigation.
 */
export async function pageState(tabId) {
  return evaluate(tabId, `(() => {
    const body = document.body;
    const text = ((body ? body.innerText : '') || '').trim();
    const sample = text.replace(/\\s+/g, ' ');
    const count = (selector) => document.querySelectorAll(selector).length;
    const nav = performance.getEntriesByType('navigation')[0] || {};
    const measured = Number(nav.responseStatus) || 0;
    const printed = /\\bHTTP ERROR\\s+(\\d{3})\\b/i.exec(sample);
    const printedStatus = printed ? Number(printed[1]) : 0;
    const failedDocument = /^chrome-error:/i.test(location.href);
    const errorCode = /\\b(ERR_[A-Z0-9_]+)\\b/.exec(sample);
    const nodeCount = document.getElementsByTagName('*').length;
    // A full-page splash or skeleton paints over the app while it boots. Only
    // nodes that name themselves as one are considered, and only when they
    // cover most of the viewport and carry no text of their own.
    let splashHeight = 0;
    let splashText = 0;
    for (const el of document.querySelectorAll('[id*="splash" i],[class*="splash" i],[id*="skeleton" i],[class*="skeleton" i],[data-testid*="splash" i],[data-testid*="skeleton" i],[id*="app-loading" i],[class*="app-loading" i]')) {
      if (splashHeight > 0) break;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
      const rect = el.getBoundingClientRect();
      if (rect.height <= 0) continue;
      splashHeight = Math.round(rect.height);
      splashText = ((el.innerText || '').trim()).length;
    }
    return {
      url: location.href,
      title: document.title,
      contentType: document.contentType || '',
      readyState: document.readyState,
      // On a Chrome error page the status printed on the page is the response
      // status that failed; the navigation timing entry describes the error
      // document itself and must not win.
      httpStatus: failedDocument && printedStatus ? printedStatus : (measured || printedStatus),
      bodyTextLen: text.length,
      elementCount: nodeCount,
      interactiveCount: count('a,button,input,textarea,select,label,summary,[role],[tabindex],[contenteditable="true"],[onclick]'),
      canvasCount: count('canvas'),
      visibility: document.visibilityState,
      hidden: document.hidden === true,
      viewportHeight: window.innerHeight || 0,
      hasSplash: splashHeight > 0 && splashHeight >= (window.innerHeight || 0) * 0.6 && splashText < 40 && text.length < 200,
      splashHeight,
      failedDocument,
      errorCode: errorCode ? errorCode[1] : '',
      outer: { width: window.outerWidth || 0, height: window.outerHeight || 0 },
    };
  })()`)
}

/**
 * One sentence naming why a document is not the page the caller asked for.
 *
 * Chrome has three quiet failure shapes: a committed error document, a 200
 * interstitial or empty shell, and a full-page splash whose app never booted.
 * Each looks like a finished load, so this hint is the only place the
 * difference is visible without a follow-up read or eval.
 *
 * Two guards keep the hint about the document in front of the caller:
 * a cached navigation error is never reported against a healthy document (the
 * stale-hint loop from BSB-20261115-2112), and no content verdict is asserted
 * before `readyState` is complete, when 0 chars and 0 elements are simply the
 * pre-parse state rather than evidence of an interstitial
 * (BSB-20261115-2205).
 */
export function documentHint(state, { requestedUrl, navigationError } = {}) {
  if (!state || typeof state !== 'object') return undefined
  const documentUrl = String(state.url ?? '')
  const error = String(navigationError ?? state.errorCode ?? '')
  const status = Number(state.httpStatus) > 0 ? Number(state.httpStatus) : 0
  if (state.failedDocument === true || /^chrome-error:/i.test(documentUrl)) {
    const code = error || (status > 0 ? 'HTTP ' + status + ' response' : 'the navigation did not complete')
    const suffix = error && status > 0 ? ' (HTTP ' + status + ')' : ''
    const asked = requestedUrl && requestedUrl !== documentUrl ? ' for ' + requestedUrl : ''
    return 'navigation failed' + asked + ': ' + code + suffix + '. The document is a Chrome error page, not the requested page; call bsb_open with the URL again to retry.'
  }
  const contentType = String(state.contentType ?? '')
  if (contentType && !/^text\/html/i.test(contentType) && !/^application\/xhtml/i.test(contentType)) {
    // A PDF or image document renders in a browser viewer, not the DOM. Judging
    // it by body text and element count calls a rendered document an empty shell.
    return 'the document is ' + contentType + '; its content is rendered by a browser viewer, not the page DOM, so body text and element counts do not describe it. Use bsb_capture to read it.'
  }
  if (/ERR_ABORTED/i.test(String(navigationError ?? ''))) {
    return 'the navigation was aborted (net::ERR_ABORTED). If the URL was a download, the file went to the browser downloads list, which bsb does not expose; the tab still shows the previous page.'
  }
  if (error) {
    // The navigation named a failure but committed no error document (for
    // example ERR_ABORTED): the tab still shows whatever was there before.
    // When that document is healthy, the failure is an older navigation this
    // tab has since recovered from, and the reply's own state line would
    // contradict the hint. Clear the stale wording instead of contradicting.
    if (documentIsHealthy(state, requestedUrl)) return undefined
    return 'navigation failed: ' + error + '. The tab did not commit the requested document' + (documentUrl ? ' (it still shows ' + documentUrl + ')' : '') + '; call bsb_open with the URL again to retry.'
  }
  // A content verdict needs a finished document. Before `readyState` is
  // complete the body may not exist yet, so 0 chars and 0 elements are the
  // normal pre-parse state, not evidence of an interstitial.
  const readyState = String(state.readyState ?? '')
  if (readyState !== 'complete') {
    if (readyState === 'loading' || readyState === 'interactive') {
      return 'document still loading (readyState ' + readyState + '); no content verdict yet. Read it again when it finishes loading.'
    }
    return undefined
  }
  const title = String(state.title ?? '')
  const textLen = Number(state.bodyTextLen) || 0
  const elementCount = Number(state.elementCount) || 0
  const interactive = Number(state.interactiveCount) || 0
  if (state.hasSplash === true) {
    return 'document is a full-page splash or skeleton (' + (Number(state.splashHeight) || 0) + 'px of a ' + (Number(state.viewportHeight) || 0) + 'px viewport, ' + textLen + ' chars of body text). The app has not rendered its content yet; wait for real content or read it again later.'
  }
  const short = textLen < 160
  if (short && (elementCount >= 200 || (interactive === 0 && (title === '' || elementCount < 60)))) {
    const measured = status > 0 ? ', HTTP ' + status : ''
    return 'document looks like an empty shell or interstitial (title ' + JSON.stringify(title) + ', ' + textLen + ' chars of body text, ' + elementCount + ' elements, ' + interactive + ' interactive' + measured + '). This is not a rendered page.'
  }
  return undefined
}

export function rememberNav(tabId, outcome) {
  if (typeof tabId !== 'number') return
  shared.navOutcomes.set(tabId, { ...(outcome ?? {}) })
  while (shared.navOutcomes.size > NAV_OUTCOME_MAX) {
    const oldest = shared.navOutcomes.keys().next().value
    shared.navOutcomes.delete(oldest)
  }
}

export const navOutcome = (tabId) => (typeof tabId === 'number' ? shared.navOutcomes.get(tabId) : undefined)

/**
 * The page's own visibility, or `unknown` when it cannot be read yet.
 *
 * `document.visibilityState` is the page's belief, not a guess about window
 * focus: a background tab and a minimized window both report `hidden`, and both
 * stop delivering pointer and key input. The bridge never changes that state on
 * its own; forceActive is the named opt-in hatch.
 */
export async function pageVisibility(tabId) {
  try {
    const state = await evaluate(tabId, 'document.visibilityState')
    return typeof state === 'string' ? state : 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * True when the tab cannot run: its window is minimized or another tab is in
 * front. Pages with a requestAnimationFrame game loop stop advancing entirely,
 * and input sits in a queue, which from the outside looks like the page ignoring
 * the agent. The plugin never forces visibility by default, so this is used to
 * refuse input rather than to silently queue it.
 */
export async function pageHidden(tabId) {
  return (await pageVisibility(tabId)) === 'hidden'
}
