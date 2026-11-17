// Browser Bridge worker: wait.
// Split from extension/sw.js; keep the module boundaries in docs/SPEC.md in sync.
import { evaluateInContext, guardedContext } from '../cdp.js'
import { clickPage } from './input.js'
import { documentHint, navOutcome } from '../page-state.js'
import { shared } from '../state.js'
import { requirePage } from './tabs.js'
import { delay, fail, recentDialog } from '../util.js'

/**
 * Block until a page condition holds instead of sleeping a fixed time.
 *
 * Any subset of selector / text / url may be given; `gone: true` inverts the
 * selector test. Returns `matched: false` on timeout rather than throwing, so
 * the caller can decide whether absence is an error.
 */
/** Turn a network wait pattern into a URL test: /regex/ or a plain substring. */
export const networkTest = (pattern) => {
  if (/^\/.*\/$/.test(pattern)) {
    const body = pattern.slice(1, -1)
    try {
      const re = new RegExp(body)
      return (url) => re.test(url)
    } catch {
      throw fail('BAD_ARGUMENT', 'network pattern is not a valid regular expression: ' + body)
    }
  }
  return (url) => url.includes(pattern)
}

export async function waitForCore({ selector, text, url, network, expression, gone, enabled, visible, stable, stableMs, timeoutMs, pollMs, tabId: hint }) {
  const tabId = await requirePage(hint)
  const limit = Math.min(Math.max(Number(timeoutMs) || 10000, 200), 25000)
  const poll = Math.min(Math.max(Number(pollMs) || 150, 10), 1000)
  const started = Date.now()
  if (typeof network === 'string' && network.length > 0) {
    const capture = shared.netCaptures.get(tabId)
    if (!capture) throw fail('NOT_CAPTURING', 'network capture is not running; call bsb_network with action "start" first')
    const matches = networkTest(network)
    for (;;) {
      const hit = capture.order
        .map((requestId) => capture.entries.get(requestId))
        .find((entry) => entry && typeof entry.url === 'string' && entry.status >= 100 && matches(entry.url))
      // A response is only useful once its body (or its failure) is known: a match at
      // responseReceived time would race Network.getResponseBody and return no body.
      if (hit && (hit.body != null || hit.error != null || Date.now() - started > 1500)) {
        return {
          matched: true,
          elapsedMs: Date.now() - started,
          network: {
            method: hit.method,
            url: hit.url,
            status: hit.status,
            mime: hit.mime,
            requestBody: hit.requestBody,
            requestHeaders: hit.requestHeaders,
            responseHeaders: hit.responseHeaders,
            body: hit.body,
          },
          dialog: recentDialog(tabId),
        }
      }
      if (Date.now() - started >= limit) return { matched: false, elapsedMs: Date.now() - started, dialog: recentDialog(tabId) }
      await delay(poll)
    }
  }
  const cached = navOutcome(tabId)
  const askedUrl = typeof cached?.requestedUrl === 'string' ? cached.requestedUrl : ''
  const askedDocument = typeof cached?.documentUrl === 'string' ? cached.documentUrl : ''
  const cachedUrlHit = typeof url === 'string' && url.length > 0 && (
    (askedUrl.length > 0 && askedUrl.includes(url)) || (askedDocument.length > 0 && askedDocument.includes(url))
  )
  let navigationError = String(cached?.navigationError ?? '')
  let failedAt = navigationError.length > 0 ? started : 0
  const probe = `(() => {
    const selector = ${JSON.stringify(typeof selector === 'string' ? selector : '')};
    const text = ${JSON.stringify(typeof text === 'string' ? text : '')};
    const url = ${JSON.stringify(typeof url === 'string' ? url : '')};
    const gone = ${gone === true ? 'true' : 'false'};
    const wantEnabled = ${enabled === true ? 'true' : 'false'};
    const wantVisible = ${visible === true ? 'true' : 'false'};
    let exprOk = true;
    let exprValue = '';
    ${typeof expression === 'string' && expression.trim() ? `try { const v = (${expression}); exprOk = !!v; exprValue = (typeof v === 'object' ? JSON.stringify(v) : String(v)).slice(0, 300); } catch (e) { exprOk = false; exprValue = String((e && e.message) || e).slice(0, 300); }` : ''}
    const walk = (sel, root) => {
      const direct = root.querySelector(sel);
      if (direct) return direct;
      for (const node of root.querySelectorAll('*')) {
        if (!node.shadowRoot) continue;
        const inner = walk(sel, node.shadowRoot);
        if (inner) return inner;
      }
      return null;
    };
    const el = selector ? walk(selector, document) : null;
    const hit = selector ? !!el : true;
    const box = el ? (() => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })() : null;
    // A node can exist and still be invisible: zero-size box, display:none or
    // visibility:hidden on itself or an ancestor, or inside an aria-hidden root.
    // A wait that ignores that matches a splash skeleton the caller cannot use.
    const ariaHidden = el ? !!el.closest('[aria-hidden="true"]') : false;
    let styleHidden = false;
    if (el) {
      let node = el;
      while (node && node.nodeType === 1) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') { styleHidden = true; break; }
        node = node.parentElement;
      }
    }
    const boxVisible = !!box && box.width > 0 && box.height > 0;
    const matchedVisibility = el ? ((boxVisible && !styleHidden && !ariaHidden) ? 'visible' : 'hidden') : undefined;
    const visibleOk = wantVisible ? (hit && matchedVisibility === 'visible') : true;
    const selectorOk = gone ? !hit : (hit && visibleOk);
    const sample = (((document.body && document.body.innerText) || '').slice(0, 400));
    const textOk = text ? (((document.body && document.body.innerText) || '').includes(text)) : true;
    const urlOk = url ? (location.href.includes(url) || document.title.includes(url)) : true;
    const disabled = !!(el && (el.disabled === true || el.getAttribute('aria-disabled') === 'true'));
    const enabledOk = wantEnabled ? (hit && !disabled) : true;
    const printed = /\\bHTTP ERROR\\s+(\\d{3})\\b/i.exec(sample);
    const errorCode = /\\b(ERR_[A-Z0-9_]+)\\b/.exec(sample);
    const failedDocument = /^chrome-error:/i.test(location.href);
    const printedStatus = printed ? Number(printed[1]) : 0;
    return {
      ok: selectorOk && textOk && urlOk && enabledOk && exprOk,
      selectorOk,
      textOk,
      urlOk,
      enabledOk,
      exprOk,
      url: location.href,
      title: document.title,
      sample,
      box,
      matchedVisibility,
      ariaHidden,
      disabled,
      exprValue,
      failedDocument,
      httpStatus: (() => {
        if (failedDocument && printedStatus) return printedStatus;
        const entry = performance.getEntriesByType('navigation')[0];
        const measured = Number(entry && entry.responseStatus) || 0;
        return measured || printedStatus;
      })(),
      errorCode: errorCode ? errorCode[1] : '',
    };
  })()`
  const settleMs = Math.max(0, Math.min(10000, Number(stableMs) || 400))
  let probeContext = await guardedContext(tabId).catch(() => null)
  let lastBox = null
  let boxSince = 0
  for (;;) {
    let state = null
    try {
      if (probeContext === null) probeContext = await guardedContext(tabId)
      state = await evaluateInContext(tabId, probeContext, probe)
    } catch {
      // Navigation in flight: the isolated world is destroyed; rebuild it.
      probeContext = null
    }
    // A navigation that already failed can never satisfy the wait. From the
    // moment the failure is visible (cached outcome, or the committed
    // chrome-error document), give the page a short grace and then answer with
    // the error instead of burning the full timeout.
    if (navigationError && state?.url && state.failedDocument !== true && state.url !== askedDocument) {
      // The tab navigated away from the failed document since the error was
      // cached (a manual reload, or another tool recovered it). The old error
      // must not fail this wait.
      navigationError = ''
      failedAt = 0
    }
    if (!failedAt && (state?.failedDocument === true || /^chrome-error:/i.test(String(state?.url ?? '')))) {
      failedAt = Date.now()
    }
    // A failed document must never satisfy a wait. A chrome-error page keeps the
    // requested host in its title, so url: would otherwise match the URL that
    // just failed and hide the navigation error behind a success shape.
    const documentFailed = state?.failedDocument === true
      || /^chrome-error:/i.test(String(state?.url ?? ''))
      || Boolean(navigationError)
    const cacheOk = cachedUrlHit && !navigationError && state?.failedDocument !== true
    const okNow = !documentFailed && state?.selectorOk && state?.textOk && (state?.urlOk || cacheOk) && state?.enabledOk && state?.exprOk
    if (okNow) {
      const matchBox = state.box ? { matchedBox: state.box } : {}
      const matchVisibility = selector ? { matchedVisibility: state.matchedVisibility } : {}
      const ariaHidden = state.ariaHidden ? { ariaHidden: true } : {}
      if (stable === true) {
        const box = state.box
        const same = box && lastBox &&
          Math.abs(box.x - lastBox.x) < 0.5 && Math.abs(box.y - lastBox.y) < 0.5 &&
          Math.abs(box.width - lastBox.width) < 0.5 && Math.abs(box.height - lastBox.height) < 0.5
        if (!same) {
          lastBox = box
          boxSince = Date.now()
        } else if (Date.now() - boxSince >= settleMs) {
          return {
            matched: true,
            elapsedMs: Date.now() - started,
            url: state.url,
            title: state.title,
            text: state.sample,
            ...(state.box ? { box: state.box } : {}),
            ...matchBox,
            ...matchVisibility,
            ...ariaHidden,
            settled: true,
            expressionValue: state.exprValue,
            dialog: recentDialog(tabId),
          }
        }
      } else {
        return {
          matched: true,
          elapsedMs: Date.now() - started,
          url: state.url,
          title: state.title,
          text: state.sample,
          ...(state.box ? { box: state.box } : {}),
          ...matchBox,
          ...matchVisibility,
          ...ariaHidden,
          expressionValue: state.exprValue,
          dialog: recentDialog(tabId),
        }
      }
    }
    const status = Number(state?.httpStatus) > 0
      ? Number(state.httpStatus)
      : Number(cached?.httpStatus) > 0 ? Number(cached.httpStatus) : 0
    const documentUrl = String(state?.url ?? cached?.documentUrl ?? '')
    const errorNow = navigationError || state?.errorCode || (status > 0 && (state?.failedDocument === true) ? 'HTTP ' + status : '')
    const failedNow = Boolean(errorNow) || state?.failedDocument === true || /^chrome-error:/i.test(documentUrl)
    if (Date.now() - started >= limit || (failedAt > 0 && Date.now() - failedAt >= 1200)) {
      const missing = failedNow || (failedAt > 0)
      const hint = missing
        ? documentHint(
            {
              url: documentUrl,
              title: state?.title ?? '',
              httpStatus: status,
              errorCode: state?.errorCode ?? '',
              failedDocument: state?.failedDocument === true || /^chrome-error:/i.test(documentUrl),
            },
            { requestedUrl: askedUrl || cached?.requestedUrl, navigationError: errorNow },
          )
        : state?.matchedVisibility === 'hidden'
          ? (visible === true
            ? 'selector ' + JSON.stringify(String(selector)) + ' is present but hidden (zero-size box or aria-hidden ancestor). It may be revealed by hover or click, or by a state change; trigger that, then wait again.'
            : 'selector ' + JSON.stringify(String(selector)) + ' matched a hidden node (zero-size box or aria-hidden ancestor). Pass visible:true to require a visible match, or wait for the content to render.')
          : undefined
      const out = {
        matched: false,
        elapsedMs: Date.now() - started,
        url: documentUrl,
        title: state?.title ?? '',
        text: state?.sample ?? '',
        ...(documentUrl ? { documentUrl } : {}),
        ...(state?.matchedVisibility ? { matchedVisibility: state.matchedVisibility } : {}),
        ...(state?.box ? { matchedBox: state.box } : {}),
        ...(state?.ariaHidden ? { ariaHidden: true } : {}),
        ...(errorNow ? { navigationError: errorNow } : {}),
        ...(status > 0 ? { httpStatus: status } : {}),
        ...(state?.expressionValue !== undefined ? { expressionValue: state.exprValue } : {}),
        ...(hint ? { hint } : {}),
        dialog: recentDialog(tabId),
      }
      return out
    }
    await delay(poll)
  }
}

/** Resolve the optional click a wait fires the moment its condition matches. */
export function followUpClick(params) {
  const hasPoint = Number.isFinite(Number(params.clickX)) && Number.isFinite(Number(params.clickY))
  const hasTarget = typeof params.clickSelector === 'string' && params.clickSelector.length > 0
  const hasText = typeof params.clickText === 'string' && params.clickText.length > 0
  if (!hasPoint && !hasTarget && !hasText) return null
  return {
    ...(hasTarget ? { target: params.clickSelector } : {}),
    ...(hasText ? { text: params.clickText } : {}),
    ...(hasPoint ? { x: Number(params.clickX), y: Number(params.clickY) } : {}),
    ...(params.clickFrame ? { frame: params.clickFrame } : {}),
  }
}

/**
 * Wait for a page condition and, optionally, click the instant it becomes true.
 * The click happens inside this one call, so timed UIs (a dot that turns green,
 * a button that exists for 600 ms) can be driven without a round trip.
 */
export async function waitForPage(params) {
  // A "first" click arms the widget that will later satisfy the condition (a
  // Start button that begins a 5-15 s countdown). Pressing it here keeps the
  // whole start-wait-press sequence inside one call, with no think time between.
  const first = followUpClick({
    clickSelector: params.firstSelector,
    clickText: params.firstText,
    clickX: params.firstX,
    clickY: params.firstY,
    clickFrame: params.firstFrame,
  })
  let pressedBefore
  if (first) {
    try {
      pressedBefore = await clickPage({ ...first, tabId: params.tabId })
    } catch (error) {
      return { matched: false, elapsedMs: 0, firstClickError: String((error && error.message) || error) }
    }
  }
  const result = await waitForCore(params)
  if (pressedBefore) result.pressedFirst = pressedBefore
  const follow = followUpClick(params)
  if (result && result.matched && follow) {
    try {
      result.clicked = await clickPage({ ...follow, tabId: params.tabId })
      result.clickedAfterMs = result.elapsedMs
    } catch (error) {
      result.clickError = String((error && error.message) || error)
    }
  }
  return result
}
