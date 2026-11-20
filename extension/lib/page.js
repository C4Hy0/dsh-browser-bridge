// Browser Bridge worker: lib/page.js.
// Keep the module boundaries in docs/SPEC.md in sync.

export function snapshotPage(maxChars, maxElements, normalize) {
  const rawSource = (document.body ? document.body.innerText : '') || ''

  // innerText follows the layout tree, not the paint clip: text rendered inside
  // an overflow:hidden box is included even when the box shows only one line of
  // it. Anti-scrape timestamps use exactly that shape (60 single-character
  // spans, 58 of them parked below a 16px clip). Under normalize, replace each
  // small clipped run with the characters actually inside the clip box, ordered
  // by their painted position, so the reader gets "5h" instead of a column of
  // fragments. Larger clipped containers are left alone; this is a timestamp
  // and badge fix, not a full reimplementation of innerText.
  const visibleClippedText = (el) => {
    const box = el.getBoundingClientRect();
    const format = /[\u034F\u200B-\u200F\u202A-\u202E\uFEFF]/;
    const parts = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const value = node.textContent || '';
      for (let index = 0; index < value.length; index += 1) {
        const ch = value[index];
        if (format.test(ch)) continue;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + 1);
        const rects = Array.from(range.getClientRects());
        range.detach?.();
        const rect = rects.find((r) => r.width > 0 && r.height > 0
          && r.right > box.left + 0.5 && r.left < box.right - 0.5
          && r.bottom > box.top + 0.5 && r.top < box.bottom - 0.5);
        if (rect) parts.push({ ch, x: rect.left, y: rect.top, w: rect.width });
      }
    }
    if (!parts.length) return '';
    parts.sort((a, b) => (Math.abs(a.y - b.y) < 4 ? a.x - b.x : a.y - b.y));
    let out = '';
    let last = null;
    for (const part of parts) {
      if (last && Math.abs(part.y - last.y) >= 4) out += '\n';
      else if (last && part.x - (last.x + last.w) > 1.5 && !/\s$/.test(out)) out += ' ';
      out += part.ch;
      last = part;
    }
    return out.replace(/[ \t]+/g, ' ').trim();
  };
  const replaceClippedRuns = (value) => {
    let out = value;
    let candidates = 0;
    for (const el of document.getElementsByTagName('*')) {
      if (candidates >= 40) break;
      if (el.clientWidth <= 0 || el.clientHeight <= 0) continue;
      if (el.scrollHeight <= el.clientHeight + 1) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width > 600 || rect.height > 120) continue;
      const raw = (el.innerText || '').trim();
      if (raw.length < 2 || raw.length > 800) continue;
      const style = getComputedStyle(el);
      if (style.overflow !== 'hidden' && style.overflow !== 'clip') continue;
      candidates += 1;
      const visible = visibleClippedText(el);
      if (visible && visible !== raw && out.includes(raw)) out = out.replace(raw, visible);
    }
    return out;
  };
  const source = normalize === true ? replaceClippedRuns(rawSource) : rawSource;

  // Anti-scrape markup renders a timestamp as block spans of one character each,
  // padded with zero-width format characters, so innerText returns a vertical
  // column instead of the string a human reads. The opt-in `normalize` strips the
  // invisible characters and joins a run of one-character lines back into one
  // line before the maxChars cut. Blank lines still separate paragraphs, and a
  // whitespace-only line inside a run is the word space between its characters.
  const normalizeText = (value) => {
    const plain = String(value ?? '').replace(/[\u034F\u200B-\u200F\u202A-\u202E\uFEFF]/g, '')
    const out = []
    let run = ''
    const flush = () => {
      if (!run) return
      out.push(run.replace(/[ \t\u00A0]+/g, ' ').trim())
      run = ''
    }
    for (const line of plain.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed && line) {
        if (run) { run += ' '; continue }
        out.push('')
        continue
      }
      if (!trimmed) { flush(); out.push(''); continue }
      if (trimmed.length === 1) { run += trimmed; continue }
      flush()
      out.push(line)
    }
    flush()
    return out.join('\n')
  }

  const cssPath = (el) => {
    // Inside a shadow root a path is relative to that root: `deepFindExpr` tries
    // every open root with the same selector, so a root-local path resolves.
    const root = el.getRootNode()
    if (el.id && root.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + CSS.escape(el.id)
    const parts = []
    let current = el
    while (current && current.nodeType === 1 && parts.length < 8) {
      let selector = current.tagName.toLowerCase()
      const parent = current.parentElement
      if (parent) {
        const siblings = Array.prototype.filter.call(parent.children, (child) => child.tagName === current.tagName)
        if (siblings.length > 1) selector += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')'
      }
      parts.unshift(selector)
      const candidate = parts.join(' > ')
      if (root.querySelectorAll(candidate).length === 1) return candidate
      current = parent
    }
    return parts.join(' > ')
  }
  const query = 'a,button,input,textarea,select,label,summary,img[alt],[role],[tabindex],[contenteditable="true"],[onclick]'
  const roots = [document]
  const shadowText = []
  for (let index = 0; index < roots.length && roots.length < 24; index++) {
    const root = roots[index]
    if (root !== document) shadowText.push((root.textContent || '').replace(/\s+/g, ' ').trim())
    for (const el of Array.prototype.slice.call(root.querySelectorAll('*'))) {
      if (el.shadowRoot) roots.push(el.shadowRoot)
    }
  }
  const inShadow = new Set()
  const candidates = []
  for (const root of roots) {
    for (const el of Array.prototype.slice.call(root.querySelectorAll(query))) {
      if (root !== document) inShadow.add(el)
      candidates.push(el)
    }
    // Widgets built from plain divs (custom checkboxes, canvas overlays) have no
    // semantic tag; a pointer cursor is the only reliable signal that they act.
    for (const el of Array.prototype.slice.call(root.querySelectorAll('div,span,li,img,canvas'))) {
      if (candidates.length > 4000) break
      if (el.closest('a,button,label,summary')) continue
      const style = getComputedStyle(el)
      if (style.cursor === 'pointer' || el.hasAttribute('onclick')) {
        if (root !== document) inShadow.add(el)
        candidates.push(el)
      }
    }
  }
  const elements = []
  for (const el of candidates) {
    if (elements.length >= maxElements) break
    const rect = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    if (rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.display === 'none') continue
    const label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || (el.innerText || '').trim() || el.value || el.getAttribute('name') || ''
    elements.push({
      ref: '@e' + (elements.length + 1),
      selector: cssPath(el),
      role: el.getAttribute('role') || el.tagName.toLowerCase(),
      name: String(label).replace(/\s+/g, ' ').slice(0, 80),
      // Anything inside an open shadow root cannot be reached by a plain
      // document.querySelector in page-space tools, so say where it lives.
      ...(inShadow.has(el) ? { shadow: true } : {}),
      // Viewport CSS-pixel box: lets the caller click a precise point inside a
      // widget even when no element is a suitable click target.
      x: Math.round(rect.left * 10) / 10,
      y: Math.round(rect.top * 10) / 10,
      width: Math.round(rect.width * 10) / 10,
      height: Math.round(rect.height * 10) / 10,
    })
  }
  // Shadow content is invisible to body.innerText; append a compact digest so
  // the sample text still describes what a shadow-heavy page shows.
  const shadowDigest = shadowText.filter(Boolean).join(' ¶ ').slice(0, 1500)
  const full = shadowDigest ? source + '\n--- shadow ---\n' + shadowDigest : source
  // Normalizing before the cut is what puts the clipped tail of a timestamp on
  // one line; truncating first would leave the caller a column of fragments.
  const normalized = normalize === true ? normalizeText(full) : full
  const truncated = normalized.length > maxChars
  return {
    url: location.href,
    title: document.title,
    text: truncated ? normalized.slice(0, maxChars) : normalized,
    truncated,
    ...(normalize === true ? { normalized: true } : {}),
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio,
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
    },
    elements,
  }
}

export function deepFindExpr(selector) {
  return `(() => {
    const walk = (sel, root) => {
      const direct = root.querySelector(sel);
      if (direct) return direct;
      for (const el of root.querySelectorAll('*')) {
        if (!el.shadowRoot) continue;
        const inner = walk(sel, el.shadowRoot);
        if (inner) return inner;
      }
      return null;
    };
    return walk(${JSON.stringify(String(selector))}, document);
  })()`
}

export function boxOf(selector) {
  const matches = []
  const collect = (root) => {
    const found = root.querySelectorAll(selector)
    for (const node of found) matches.push(node)
    for (const node of root.querySelectorAll('*')) {
      if (node.shadowRoot) collect(node.shadowRoot)
    }
  }
  try { collect(document) } catch { return null }
  if (!matches.length) return null
  const rendered = []
  for (const el of matches) {
    const r = el.getBoundingClientRect()
    if (r.width >= 2 && r.height >= 2) rendered.push({ el, r })
  }
  // Zero-size duplicates are common in responsive controls: pick the rendered
  // one, not the first DOM match.
  if (!rendered.length) return { matchedCount: matches.length, rendered: 0 }
  const px = Math.round(window.scrollX)
  const py = Math.round(window.scrollY)
  const visible = rendered.find(({ r }) => r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth)
  const pick = visible || rendered[0]
  pick.el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  let rect = pick.el.getBoundingClientRect()
  if (rect.bottom > innerHeight || rect.top < 0 || rect.right > innerWidth || rect.left < 0) {
    window.scrollBy(0, rect.top - innerHeight / 2 + rect.height / 2)
    rect = pick.el.getBoundingClientRect()
  }
  if (rect.width <= 0 || rect.height <= 0) return { matchedCount: matches.length, rendered: rendered.length }
  const offscreen = rect.top < 0 || rect.bottom > innerHeight || rect.left < 0 || rect.right > innerWidth
  const x = rect.left + rect.width / 2
  const y = rect.top + rect.height / 2
  let hit = null
  try {
    const at = document.elementFromPoint(x, y)
    hit = Boolean(at) && (at === pick.el || pick.el.contains(at))
    if (!hit && at) hit = { tag: at.tagName, id: at.id || undefined, cls: String(at.className || '').slice(0, 40) }
  } catch {}
  const moved = px !== Math.round(window.scrollX) || py !== Math.round(window.scrollY)
    || pick.r.top !== rect.top || pick.r.left !== rect.left
  return { x, y, offscreen, hit, matchedCount: matches.length, rendered: rendered.length, scrolled: moved }
}

/**
 * Pick the element for a click by text.
 *
 * The rendered text is normalized across child blocks, the accessible name
 * (aria-label, aria-labelledby, title, alt) is a match as well, the element is
 * scrolled with an instant scroll before the point is measured, and a hit on a
 * sibling inside a matching wrapper (the control's own icon) counts as the
 * target. Returns the post-scroll viewport centre.
 */
export function textPoint(wantedRaw) {
  const norm = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
  const want = norm(wantedRaw).toLowerCase()
  const skip = new Set(['HTML', 'BODY', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'TITLE'])
  const generic = new Set(['DIV', 'P', 'LI', 'SPAN', 'TD', 'TH', 'DT', 'DD', 'STRONG', 'EM', 'B', 'I', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'])
  const collect = (root, out) => {
    out.push(...root.querySelectorAll('button, a, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], [role="menuitem"], [role="option"], input[type="submit"], input[type="button"], input[type="reset"], label, summary, li, span, p, div, td, th, dt, dd, strong, em, b, i, h1, h2, h3, h4, h5, h6'))
    for (const host of root.querySelectorAll('*')) if (host.shadowRoot) collect(host.shadowRoot, out)
    return out
  }
  const labelOf = (el) => {
    const aria = el.getAttribute && el.getAttribute('aria-label')
    if (aria) return norm(aria)
    const labelled = el.getAttribute && el.getAttribute('aria-labelledby')
    if (labelled) {
      const text = labelled.split(/\s+/).map((id) => {
        const node = document.getElementById(id)
        return node ? norm(node.innerText || node.textContent) : ''
      }).join(' ')
      if (text) return norm(text)
    }
    const title = el.getAttribute && el.getAttribute('title')
    if (title) return norm(title)
    if (el.tagName === 'IMG' && el.alt) return norm(el.alt)
    return ''
  }
  const visible = (r) => r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth
  const nodes = collect(document, [])
  const out = []
  for (const el of nodes) {
    if (skip.has(el.tagName)) continue
    const text = norm(el.innerText || '')
    const label = labelOf(el)
    const value = el.value == null ? '' : norm(el.value)
    const byText = text.toLowerCase().includes(want)
    const byLabel = label !== '' && label.toLowerCase().includes(want)
    const byValue = value !== '' && value.toLowerCase().includes(want)
    if (!byText && !byLabel && !byValue) continue
    if (generic.has(el.tagName) && (text.length > 160 || el.querySelector('button, a, input, select, textarea, [role="button"], [role="link"]'))) continue
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) continue
    out.push({
      el, text, label, byLabel, byText, byValue,
      area: r.width * r.height,
      exact: text.toLowerCase() === want || label.toLowerCase() === want || value.toLowerCase() === want,
      visible: visible(r),
    })
  }
  if (!out.length) return null
  out.sort((a, b) => (b.exact - a.exact) || (b.visible - a.visible) || (a.area - b.area))
  const best = out[0]
  let r = best.el.getBoundingClientRect()
  let scrolled = false
  if (!best.visible) {
    best.el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    r = best.el.getBoundingClientRect()
    scrolled = true
  }
  const x = r.left + r.width / 2
  const y = r.top + r.height / 2
  let hit = false
  let viaAncestor = false
  let cover = null
  try {
    const at = document.elementFromPoint(x, y)
    hit = Boolean(at) && (at === best.el || best.el.contains(at))
    if (!hit && at) {
      let node = best.el.parentElement
      while (node && node !== document.body && node !== document.documentElement) {
        const nodeText = norm(node.innerText || '').toLowerCase()
        const nodeLabel = labelOf(node).toLowerCase()
        if ((nodeText.includes(want) || (nodeLabel && nodeLabel.includes(want))) && node.contains(at)) {
          hit = true
          viaAncestor = true
          break
        }
        node = node.parentElement
      }
    }
    if (!hit) cover = at ? { tag: at.tagName, id: at.id || undefined, cls: String(at.className || '').slice(0, 40) } : null
  } catch {}
  return {
    x, y,
    text: (best.text || best.label || '').slice(0, 80),
    scrolled,
    matches: out.length,
    hit,
    matchedBy: best.byLabel ? 'label' : (best.byText ? 'text' : 'value'),
    ...(viaAncestor ? { viaAncestor: true } : {}),
    ...(cover ? { cover } : {}),
  }
}

export const textPointExpr = (wanted) => `(${textPoint.toString()})(${JSON.stringify(String(wanted ?? ''))})`

/**
 * Collect the nodes that DO contain the text when no hittable hit was found.
 *
 * `bsb_read` extracts text that the click hit-test cannot press: a node can be
 * zero-height while its text is painted, sit under `pointer-events:none`, or be
 * inside an `aria-hidden` overlay. Reporting "no visible element contains the
 * text" for a string the caller just read contradicts the read, so the failure
 * names the candidates and their geometry instead.
 */
export const textCandidatesExpr = (wanted) => `(() => {
  const want = ${JSON.stringify(String(wanted ?? ''))}.toLowerCase();
  const skip = new Set(['HTML', 'BODY', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'TITLE']);
  const pathOf = (el) => {
    const parts = [];
    let node = el;
    let host = null;
    for (let depth = 0; node && node.nodeType === 1 && depth < 6; depth += 1) {
      const tag = (node.tagName || '').toLowerCase();
      const id = node.id && /^[A-Za-z][\\w-]*$/.test(node.id) ? '#' + node.id : '';
      let part = id ? tag + id : tag;
      if (!id && node.parentElement) {
        const same = [...node.parentElement.children].filter((child) => child.tagName === node.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      if (id) break;
      if (!node.parentElement) {
        const root = node.getRootNode && node.getRootNode();
        host = root && root.host ? root.host : null;
        break;
      }
      node = node.parentElement;
    }
    return { path: parts.join(' > '), host };
  };
  const selectorOf = (el) => {
    const own = pathOf(el);
    if (!own.host) return own.path;
    const parent = selectorOf(own.host);
    return parent + ' >> ' + own.path;
  };
  const ariaHidden = (el) => {
    for (let node = el; node;) {
      if (node.nodeType === 1 && node.getAttribute && node.getAttribute('aria-hidden') === 'true') return true;
      if (node.parentElement) { node = node.parentElement; continue; }
      const root = node.getRootNode && node.getRootNode();
      node = root && root.host ? root.host : null;
    }
    return false;
  };
  const nodes = [];
  const collect = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (nodes.length >= 12000) return;
      nodes.push(el);
      if (el.shadowRoot) collect(el.shadowRoot);
    }
  };
  collect(document);
  const found = [];
  let matched = 0;
  for (const el of nodes) {
    if (skip.has(el.tagName)) continue;
    const label = el.getAttribute ? String(el.getAttribute('aria-label') || '') : '';
    const title = el.getAttribute ? String(el.getAttribute('title') || '') : '';
    const hay = String(el.textContent || '') + ' ' + label + ' ' + title + ' ' + (el.value == null ? '' : String(el.value));
    if (hay.toLowerCase().indexOf(want) === -1) continue;
    matched += 1;
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const hidden = ariaHidden(el);
    const box = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
    const pointerEvents = style.pointerEvents || 'auto';
    found.push({
      selector: selectorOf(el),
      tag: (el.tagName || '').toLowerCase(),
      box,
      visible: box.width >= 2 && box.height >= 2 && style.display !== 'none' && style.visibility !== 'hidden' && pointerEvents !== 'none' && !hidden,
      pointerEvents,
      ariaHidden: hidden,
      ownText: [...el.childNodes].some((child) => child.nodeType === 3 && String(child.textContent || '').toLowerCase().indexOf(want) !== -1),
      area: box.width * box.height,
    });
  }
  // The node that holds the text itself explains the miss better than a huge
  // ancestor that merely contains it, so own text wins, then the smallest box.
  found.sort((a, b) => (b.ownText - a.ownText) || (a.area - b.area));
  return { matched, candidates: found.slice(0, 5).map(({ ownText, area, ...rest }) => rest) };
})()`

/**
 * Resolve the image-map <area> under a viewport point, if any.
 *
 * A synthetic press lands on the <img>, but the browser's own image-map
 * navigation is not reliably triggered by it, so a page whose only links are
 * <area href> looks completely inert. The caller presses normally first and
 * follows the area's href itself only when the URL has not moved.
 */
export function mapAreaAt(x, y) {
  const hit = document.elementFromPoint(x, y);
  if (!hit || hit.tagName !== 'IMG' || !hit.useMap) return null;
  const map = document.querySelector(hit.useMap);
  if (!map) return null;
  const rect = hit.getBoundingClientRect();
  const sx = hit.naturalWidth ? hit.naturalWidth / (rect.width || 1) : 1;
  const sy = hit.naturalHeight ? hit.naturalHeight / (rect.height || 1) : 1;
  const ix = (x - rect.left) * sx;
  const iy = (y - rect.top) * sy;
  for (const area of map.querySelectorAll('area')) {
    const href = area.getAttribute('href');
    // Same-document and script hrefs are not navigations; following them would
    // either do nothing or hand Page.navigate a javascript: URL it rejects.
    if (!href || href.charAt(0) === '#' || /^\s*(javascript|mailto|tel):/i.test(href)) continue;
    const coords = String(area.getAttribute('coords') || '').split(',').map(Number);
    const shape = String(area.getAttribute('shape') || 'rect').toLowerCase();
    if (shape === 'rect' && coords.length >= 4) {
      if (ix >= coords[0] && ix <= coords[2] && iy >= coords[1] && iy <= coords[3]) return { href: href, shape: shape };
    } else if (shape === 'circle' && coords.length >= 3) {
      const dx = ix - coords[0], dy = iy - coords[1];
      if (dx * dx + dy * dy <= coords[2] * coords[2]) return { href: href, shape: shape };
    } else if (shape === 'poly' && coords.length >= 6) {
      let inside = false;
      for (let i = 0, j = coords.length - 2; i < coords.length; j = i, i += 2) {
        const xi = coords[i], yi = coords[i + 1], xj = coords[j], yj = coords[j + 1];
        if ((yi > iy) !== (yj > iy) && ix < ((xj - xi) * (iy - yi)) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) return { href: href, shape: shape };
    } else if (shape === 'default') {
      return { href: href, shape: shape };
    }
  }
  return null;
}

/**
 * A cheap fingerprint of what the page looks like right now.
 *
 * A menu item, a grid cell or a custom control can absorb a press and change
 * nothing, and the old reply still looked like a success. Five read-only values
 * are enough to tell "something happened" from "nothing did", and none of them
 * costs a DOM write or a poll loop.
 */
export const PAGE_FINGERPRINT_EXPR = `(() => {
  let active = document.activeElement;
  while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
  const part = (el) => el ? [String(el.tagName || '').toLowerCase(), el.id || '',
    el.getAttribute ? String(el.getAttribute('role') || '') : '',
    el.getAttribute ? String(el.getAttribute('aria-label') || '') : ''].join('|') : '';
  const body = document.body;
  return {
    url: location.href,
    title: document.title,
    elementCount: document.getElementsByTagName('*').length,
    textLen: body ? String(typeof body.innerText === 'string' ? body.innerText : body.textContent || '').length : 0,
    active: part(active),
  };
})()`

/**
 * Measure an editable target and take focus, refusing a target that cannot take
 * input. `boxOf` alone cannot describe a zero-size element or a hidden one, and
 * a silent `focus()` on an offscreen measurer used to send the whole text into
 * whatever was focused before it.
 *
 * The box is measured before and after scrolling it into view, because an
 * offscreen input that CAN be scrolled to is a normal form field, while one that
 * stays outside the viewport (a measurer parked at y=-9998, a proxy node) cannot
 * receive a real keystroke no matter what is typed.
 */
export const editableTargetExpr = (selector) => `(() => {
  const el = ${deepFindExpr(selector)};
  if (!el) return null;
  const read = () => {
    const style = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const tag = (el.tagName || '').toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const textInput = tag === 'input' && !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'range', 'color'].includes(type);
    return {
      tag, type,
      id: el.id || undefined,
      role: el.getAttribute('role') || undefined,
      ariaLabel: el.getAttribute('aria-label') || undefined,
      className: typeof el.className === 'string' && el.className ? el.className.slice(0, 80) : undefined,
      editable: textInput || tag === 'textarea' || el.isContentEditable === true,
      width: Math.round(r.width), height: Math.round(r.height),
      x: Math.round(r.x), y: Math.round(r.y),
      display: style.display, visibility: style.visibility,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  };
  const first = read();
  const zero = first.width <= 0 || first.height <= 0;
  const blocked = first.display === 'none' || first.visibility === 'hidden';
  if (!zero && !blocked) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const state = zero || blocked ? first : read();
  state.offscreen = state.width > 0 && state.height > 0
    && (state.x + state.width <= 0 || state.y + state.height <= 0
      || state.x >= state.viewport.width || state.y >= state.viewport.height);
  // Do not focus a target that is about to be refused: focus alone can move
  // page state (and an editor's own caret), which is exactly what an offscreen
  // measurer must not cause.
  if (zero || blocked || state.offscreen || !state.editable) return state;
  el.focus();
  // The deep walk matters: a focusable control can live inside an open shadow
  // root, where document.activeElement is only its host.
  let active = document.activeElement;
  while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
  state.focused = active === el || el.contains(active);
  state.active = active ? {
    tag: (active.tagName || '').toLowerCase(),
    id: active.id || undefined,
    role: active.getAttribute ? active.getAttribute('role') || undefined : undefined,
    ariaLabel: active.getAttribute ? active.getAttribute('aria-label') || undefined : undefined,
  } : null;
  return state;
})()`

/**
 * Read the focused element after a type call, so the reply says which control
 * actually received the text. The Sheets name box is the case that matters: the
 * text lands in the box, Enter moves focus to the grid, and only the descriptor
 * shows that the caller's next keystroke will go somewhere else.
 */
export const ACTIVE_ELEMENT_EXPR = `(() => {
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  if (!el) return null;
  return {
    tag: (el.tagName || '').toLowerCase(),
    id: el.id || undefined,
    role: el.getAttribute ? el.getAttribute('role') || undefined : undefined,
    ariaLabel: el.getAttribute ? el.getAttribute('aria-label') || undefined : undefined,
  };
})()`

/** Read the parking-game canvas as structured data: the tracked car box and the background. */
// A cheap fingerprint of the biggest canvas on the page: enough to tell
// "still animating" from "settled" without touching the frame buffer twice.
export const CANVAS_SIGNATURE_EXPR = `(() => {
  const list = [...document.querySelectorAll('canvas')]
  const c = list.sort((a, b) => b.width * b.height - a.width * a.height)[0]
  if (!c || !c.getContext) return null
  const g = c.getContext('2d', { willReadFrequently: true })
  if (!g) return null
  const w = Math.min(c.width, 96), h = Math.min(c.height, 96)
  let d
  try { d = g.getImageData(0, 0, w, h).data } catch { return null }
  let hash = 0
  for (let i = 0; i < d.length; i += 13) hash = (hash * 31 + d[i] + d[i + 3] * 7) | 0
  return hash
})()`

export const CAR_MEASURE_EXPR = `(() => {
  const c = document.querySelector('#park-canvas');
  if (!c) return null;
  const g = c.getContext('2d');
  const w = c.width, h = c.height, d = g.getImageData(0, 0, w, h).data, S = w / 400;
  const R = (v) => +v.toFixed(1);
  const seen = new Uint8Array(w * h);
  // A canvas game's player sprite is normally the brightest NEUTRAL blob (the
  // Waymo is grey-white, traffic is tinted). Every component above the noise
  // floor is measured, then the neutral-bright one with the most pixels wins.
  // Only near-opaque pixels count: smoke, dust and sparkle particles a game draws
  // after a crash are semi-transparent, and they used to be picked as the sprite
  // (the pose then appeared to teleport for a few frames).
  // Each measurement carries its centroid and major-axis angle (from second
  // moments) as well as the AABB, because the AABB alone cannot recover a
  // rotated sprite's heading.
  const isCarColour = (r, gg, b) => {
    const lo = Math.min(r, gg, b), hi = Math.max(r, gg, b);
    return lo >= 150 && hi - lo <= 40;
  };
  const parts = [];
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
    const p = y * w + x;
    if (seen[p] || d[p * 4 + 3] < 200) continue;
    const q = [[x, y]]; seen[p] = 1;
    let a = x, b = y, cc = x, dd = y, cnt = 0, sr = 0, sg = 0, sb = 0;
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    while (q.length) {
      const [cx, cy] = q.pop(); cnt++;
      const i = (cy * w + cx) * 4; sr += d[i]; sg += d[i + 1]; sb += d[i + 2];
      sx += cx; sy += cy; sxx += cx * cx; syy += cy * cy; sxy += cx * cy;
      if (cx < a) a = cx; if (cx > cc) cc = cx; if (cy < b) b = cy; if (cy > dd) dd = cy;
      for (let dy = -2; dy <= 2; dy += 2) for (let dx = -2; dx <= 2; dx += 2) {
        if (!dx && !dy) continue;
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const np = ny * w + nx;
        if (seen[np] || d[np * 4 + 3] < 200) continue;
        seen[np] = 1; q.push([nx, ny]);
      }
    }
    if (cnt < 300) continue;
    const mx = sx / cnt, my = sy / cnt;
    const uxx = sxx / cnt - mx * mx, uyy = syy / cnt - my * my, uxy = sxy / cnt - mx * my;
    const angle = (0.5 * Math.atan2(2 * uxy, uxx - uyy)) * 180 / Math.PI;
    parts.push({ n: cnt, r: Math.round(sr / cnt), g: Math.round(sg / cnt), b: Math.round(sb / cnt),
      x: R(a / S), y: R(b / S), w: R((cc - a + 1) / S), h: R((dd - b + 1) / S),
      cx: R(mx / S), cy: R(my / S), angle: R(angle) });
  }
  parts.sort((p, q) => q.n - p.n);
  const neutral = parts.filter((p) => isCarColour(p.r, p.g, p.b));
  const car = neutral[0] || parts[0] || null;
  return { car, others: parts.filter((p) => p !== car).slice(0, 4), bg: getComputedStyle(c).backgroundImage };
})()`

/**
 * Read the editor a key text run is going into: does it own visible text, how
 * long is that text, and does it already contain the typed prefix.
 *
 * `applies` is false for a page whose active element is body (a canvas game),
 * anything that is not an input, textarea, contenteditable or role=textbox, and
 * a zero-size or offscreen focused node (the key shim a canvas app forwards
 * keystrokes through), so the check never runs where there is no visible editor
 * text to compare.
 */
export const keyTextProbeExpr = (prefix) => `(() => {
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  const tag = el ? String(el.tagName || '').toLowerCase() : '';
  const type = el && el.getAttribute ? String(el.getAttribute('type') || '').toLowerCase() : '';
  const textInput = tag === 'input' && ['button','submit','reset','checkbox','radio','file','image','range','color','hidden'].indexOf(type) === -1;
  const role = el && el.getAttribute ? String(el.getAttribute('role') || '').toLowerCase() : '';
  const body = document.body;
  const text = body ? String(typeof body.innerText === 'string' ? body.innerText : body.textContent || '') : '';
  const own = el && (textInput || tag === 'textarea')
    ? String(el.value == null ? '' : el.value)
    : (el && el.isContentEditable === true ? String(el.innerText || el.textContent || '') : '');
  const wanted = ${JSON.stringify(prefix)};
  const squash = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const flat = squash(text);
  // A hidden input parked offscreen is a key shim (a canvas app forwards keys
  // through it), not an editor whose visible text can be compared, so it is not
  // verified either: claiming "did not land" there would be wrong.
  const rect = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
  const style = el && getComputedStyle ? getComputedStyle(el) : null;
  const inView = Boolean(rect) && rect.width >= 2 && rect.height >= 2
    && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth
    && (!style || (style.display !== 'none' && style.visibility !== 'hidden'));
  const editorApplies = inView && (tag === 'textarea' || textInput || (el && el.isContentEditable === true) || role === 'textbox') && tag !== 'body' && tag !== 'html';
  // A canvas editor renders its text to a canvas and parks focus in an offscreen
  // iframe, so there is no editor element to measure. Google Docs keeps a live
  // text mirror in the navigation panel; older builds used a word layer. Read it
  // only when the focused element is not a measurable editor, so a normal input
  // is never second-guessed by page chrome that happens to share the class.
  let mirror = null;
  if (!editorApplies) {
    let mirrorText = '';
    for (const node of document.querySelectorAll('.navigation-item-content, .kix-wordhtmlgenerator-word')) {
      mirrorText += String(node.textContent || '');
    }
    if (mirrorText.length > 0) mirror = mirrorText;
  }
  const measured = mirror === null ? text : mirror;
  return {
    applies: editorApplies || mirror !== null,
    source: mirror === null ? 'editor' : 'document-mirror',
    tag,
    url: location.href,
    textLen: measured.length,
    ownLen: own.length,
    landed: wanted.length > 0 && (squash(measured).indexOf(wanted) !== -1 || squash(own).indexOf(wanted) !== -1),
    badInput: Boolean(el && el.validity && el.validity.badInput),
    value: String(own || '').slice(0, 80),
    excerpt: squash(measured).slice(0, 120),
  };
})()`

export function ownerRectExpr(frame) {
  return `(() => {
    const want = ${JSON.stringify(frame.url ?? '')};
    const name = ${JSON.stringify(frame.name ?? '')};
    const list = Array.from(document.querySelectorAll('iframe, frame'));
    const hit = list.find((el) => {
      if (name && el.name === name) return true;
      const raw = el.getAttribute('src');
      if (!raw) return false;
      try { return new URL(raw, location.href).href === want } catch { return false }
    });
    if (!hit) return null;
    hit.scrollIntoView({ block: 'center', inline: 'center' });
    const r = hit.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })()`
}

/**
 * Decode a known redirector href into its final target, without navigating.
 *
 * This is the page-side half of bsb_read {mode:"rows", resolve:true}. It is
 * serialized into the page, so it must stay self-contained: no outer
 * references, no network, no navigation and no DOM writes. It decodes only what
 * is mechanically decodable; everything else is reported as
 * resolvableBy:"navigation" instead of a guessed URL.
 *
 * Recognized shapes:
 *   google.<tld>/url?q=<url> or ?url=<url>
 *   google.<tld>/goto?url=<base64>  (standard or URL-safe, padded or not)
 *   l.facebook.com/l.php?u=<url>    (also lm.facebook.com)
 *   t.co/<token>                    (recognized, never decodable)
 */
export function resolveRedirectHref(href) {
  const raw = String(href == null ? '' : href).trim()
  if (!raw) return null
  let url
  try { url = new URL(raw) } catch { return null }
  const host = url.hostname.toLowerCase()
  const path = url.pathname.toLowerCase()
  const search = url.search || ''

  // Read a parameter from the raw query string. URLSearchParams turns a literal
  // '+' into a space, which corrupts a standard-base64 payload, so the raw value
  // is percent-decoded instead.
  const param = (name) => {
    const match = new RegExp('[?&]' + name + '=([^&]*)', 'i').exec(search)
    if (!match) return ''
    try { return decodeURIComponent(match[1]) } catch { return match[1] }
  }

  // Only an absolute http(s) target counts as decoded. A relative path or a
  // javascript: payload is not a final target and must not be presented as one.
  // A redirector occasionally percent-encodes its target twice, so try a few
  // decode rounds before giving up.
  const finalTarget = (value) => {
    let text = String(value == null ? '' : value).trim()
    if (!text) return ''
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (/^https?:\/\//i.test(text)) {
        try { return new URL(text).href } catch { return '' }
      }
      try { text = decodeURIComponent(text) } catch { return '' }
    }
    return ''
  }

  const decoded = (value) => {
    const target = finalTarget(value)
    return target ? { resolved: true, hrefResolved: target, resolvableBy: 'decoded' } : null
  }
  const byNavigation = { resolved: false, resolvableBy: 'navigation' }

  const base64Target = (payload) => {
    let text = String(payload == null ? '' : payload).replace(/\s+/g, '')
    if (!text) return ''
    // URL-safe alphabet and missing padding are both common in the wild.
    text = text.replace(/-/g, '+').replace(/_/g, '/')
    const remainder = text.length % 4
    if (remainder === 1) return ''
    if (remainder) text += new Array(5 - remainder).join('=')
    let binary = ''
    try { binary = atob(text) } catch { return '' }
    if (typeof TextDecoder === 'function') {
      try {
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
        return new TextDecoder('utf-8').decode(bytes)
      } catch {}
    }
    return binary
  }

  // t.co paths are opaque tokens: the target is only obtainable by following the
  // redirect, so it is named rather than guessed.
  if (host === 't.co' || host.endsWith('.t.co')) return byNavigation

  const google = /(^|\.)google\.[a-z]{2,}(\.[a-z]{2,})?$/.test(host)
  if (google && (path === '/url' || path === '/url/')) {
    return decoded(param('q')) || decoded(param('url')) || byNavigation
  }
  if (google && (path === '/goto' || path === '/goto/')) {
    return decoded(base64Target(param('url'))) || byNavigation
  }
  if ((host === 'l.facebook.com' || host === 'lm.facebook.com') && (path === '/l.php' || path === '/l.php/')) {
    return decoded(param('u')) || byNavigation
  }
  return null
}

/**
 * Read one DOM snapshot of a feed. Page-side, read-only.
 *
 * An item key is the link when the surface gives one, otherwise the visible
 * text, normalized and cut at 240 characters so a long post cannot flood the
 * reply. A matched node with neither is a placeholder or a wrapper, not an
 * item: it is counted in `unkeyed` instead of being given a positional key that
 * could not survive recycling.
 */
export function feedCollect(selector, dedupeBy) {
  const nodes = Array.from(document.querySelectorAll(selector))
  const preferText = dedupeBy === 'text'
  const out = []
  let unkeyed = 0
  let skippedHidden = 0
  for (const el of nodes) {
    const r = el.getBoundingClientRect()
    const rendered = r.width > 0 && r.height > 0
    // A node with no box is stale DOM left by a previous view (Gmail keeps the
    // old inbox rows as display:none). It is not an item of the current feed,
    // and counting it inflates the result with rows that do not match.
    if (!rendered) { skippedHidden += 1; continue }
    const inView = r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth
    let href = ''
    if (el.matches('a[href]')) {
      const own = typeof el.href === 'string' ? el.href : (el.getAttribute('href') || '')
      if (/^https?:/i.test(own)) href = own
    }
    if (!href) {
      for (const link of el.querySelectorAll('a[href]')) {
        const url = typeof link.href === 'string' ? link.href : (link.getAttribute('href') || '')
        if (/^https?:/i.test(url)) { href = url; break }
      }
    }
    const full = (typeof el.innerText === 'string' ? el.innerText : '').replace(/\s+/g, ' ').trim()
    const text = full.slice(0, 240)
    const key = preferText ? (text || href) : (href || text)
    if (!key) { unkeyed += 1; continue }
    const keySource = preferText ? (text ? 'text' : 'href') : (href ? 'href' : 'text')
    const item = {
      key,
      keySource,
      text,
      href,
      visible: inView,
      box: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    }
    if (full.length > 240) item.textTruncated = true
    out.push(item)
  }
  return { matched: nodes.length, unkeyed, skippedHidden, items: out }
}

/**
 * Scroll the feed's own scroller by 0.8 of a viewport. Page-side, read-only.
 *
 * The document scroller is the default. A surface that scrolls inside a panel
 * is driven through the nearest scrollable element at or above the first match,
 * so the page's own layout and listeners do the work: no container is created
 * and no scroll position is invented.
 */
export function feedScroll(selector) {
  let scroller = null
  const first = document.querySelector(selector)
  if (first) {
    let node = first.parentElement
    while (node && node !== document.documentElement) {
      const style = getComputedStyle(node)
      const overflow = style ? style.overflowY : ''
      if ((overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') && node.scrollHeight > node.clientHeight + 4) {
        scroller = node
        break
      }
      node = node.parentElement
    }
  }
  const readTop = () => (scroller ? scroller.scrollTop : (window.scrollY || document.documentElement.scrollTop || 0))
  const before = readTop()
  const step = scroller ? scroller.clientHeight * 0.8 : innerHeight * 0.8
  if (scroller) scroller.scrollBy(0, step)
  else window.scrollBy(0, step)
  const after = readTop()
  const max = Math.max(0, scroller
    ? scroller.scrollHeight - scroller.clientHeight
    : document.documentElement.scrollHeight - innerHeight)
  return {
    scroller: scroller ? 'ancestor' : 'window',
    before: Math.round(before),
    after: Math.round(after),
    max: Math.round(max),
    step: Math.round(step),
    scrolled: after > before + 1,
    atEnd: after >= max - 1,
  }
}
