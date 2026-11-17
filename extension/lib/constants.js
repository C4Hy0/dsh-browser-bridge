// Browser Bridge worker: lib/constants.js.
// Keep the module boundaries in docs/SPEC.md in sync.

export const WAIT_MS = 20000

export const KEEPALIVE_ALARM = 'browser-bridge-keepalive'

export const DETACH_IDLE_MS = 5 * 60 * 1000

/** How long a triggered file chooser may take to reach `Page.fileChooserOpened`. */
export const FILE_CHOOSER_WAIT_MS = 5000

/** Paste inserts one run of text; this cap is far above key text mode's 1000 keys. */
export const PASTE_MAX_CHARS = 100000

export const NET_BODY_CHARS = 4000

export const NET_HEADER_MAX = 24

export const NET_HEADER_CHARS = 400

/**
 * Opt-in escape hatch for a page whose frame clock is paused.
 *
 * A sleeping display (or an occluded window on some platforms) leaves the tab
 * reporting `visibilityState: "hidden"`, and a page that animates on
 * requestAnimationFrame then stops advancing while input queues silently. The
 * bridge's contract is to never change what the page believes about itself, so
 * this is NOT installed on attach: a caller has to ask for it, by name, for one
 * action. When it is used the reply says so, because a screen the user cannot
 * see is producing the frames.
 */
export const FORCE_ACTIVE_NOTE =
  'forced the page lifecycle to active for this call (it may not be on screen); '
  + 'screenshots and sampled pixels can be stale'

export const FORCE_HOLD_NOTE =
  'holding the page lifecycle active until it is released; the page believes it is on screen, '
  + 'so it animates and accepts input while the display may be off'

/**
 * A hold has to outlive this worker, not just this call.
 *
 * MV3 restarts the service worker whenever it idles, which used to silently drop
 * both the CDP override and the Set that knew about it: the next call re-attached
 * to a frozen page with no idea the user had asked for it to stay awake. The tab
 * ids are mirrored into chrome.storage.session — it survives a worker restart and
 * an extension reload, and dies with the browser session — so attach can restore
 * the hold instead of rediscovering the problem. A closed tab's id is harmless:
 * nothing attaches to it again within the session.
 */
export const HELD_KEY = 'heldTabs'

export const NAV_OUTCOME_MAX = 32

export const CLICK_UNCHANGED_HINT =
  'click verify:true found no page change: the URL, title, element count, body text length and focused element are all identical. '
  + 'A menu item or grid cell that changed nothing may not have received the press: check for an overlay or a hover-only control, '
  + 'wait for the menu to settle with bsb_wait_for, then press again with fresh coordinates. Do not assume the click applied.'

export const OFFSCREEN_EDITOR_HINT =
  'the target is most likely an offscreen measurer or focus proxy, not the editor the page displays; '
  + 'focus the visible editor first (for example click the cell or press Enter on it), then retry. '
  + 'Clipboard paste and DOM injection are not used: this tool sends real input only'

export const PASTE_OFFSCREEN_HINT =
  'the target is most likely an offscreen measurer or focus proxy, not the editor the page displays; '
  + 'click the visible editor first (for example click the cell or press Enter on it), then retry.'

export const HIDDEN_HINT =
  'input is delivered only while the page is visible: nothing was sent and nothing will replay. '
  + 'Use bsb_act {action:"forceActive", mode:"hold"} to wake the page for the call, or '
  + 'bsb_tabs {action:"use", activate:true} (which may report that it cannot unminimize the window), then retry'

// The most characters one `key text` call sends. It was 1000 and the cut was
// silent, so a long write lost its tail while the reply looked successful.
export const KEY_TEXT_CAP = 5000

// How much of the typed text is used to prove the run landed. A prefix survives
// the whitespace normalisation a rich editor applies to the whole paragraph.
export const KEY_TEXT_PREFIX_CHARS = 40

/**
 * Read-only guard for model-supplied expressions.
 *
 * The bridge is an inspector and an input device: it may read the DOM, and it
 * may drive the page with trusted CDP input events, but it must never edit the
 * page's own markup, styles or form state behind the site's back. Chrome's
 * isolated worlds share the DOM with the page, so "read state" and "write
 * state" are the same object graph; the only way to keep them apart is to run
 * the expression in a world where the write surface throws for any node that
 * is connected to the document.
 *
 * The page's own scripts live in the main world and are untouched; a detached
 * subtree is free to mutate, so analysis that builds its own canvas or nodes
 * still works.
 */
export const READ_ONLY_PRELUDE = `(() => {
  if (globalThis.__dshReadOnly) return 'installed'
  const deny = (what) => { throw new Error('READ_ONLY: the bridge may inspect the page but never edit it (' + what + ')') }
  const live = (node) => !!(node && node.isConnected)
  const patch = (proto, names, test) => {
    if (!proto) return
    for (const name of names) {
      const desc = Object.getOwnPropertyDescriptor(proto, name)
      if (!desc || typeof desc.value !== 'function' || !desc.configurable) continue
      const original = desc.value
      Object.defineProperty(proto, name, {
        configurable: true,
        writable: true,
        value: function () {
          if (test(this)) deny(name)
          return original.apply(this, arguments)
        },
      })
    }
  }
  const patchSet = (proto, names, test) => {
    if (!proto) return
    for (const name of names) {
      const desc = Object.getOwnPropertyDescriptor(proto, name)
      if (!desc || typeof desc.set !== 'function' || !desc.configurable) continue
      Object.defineProperty(proto, name, {
        configurable: true,
        get: desc.get,
        set: function (value) {
          if (test(this, value)) deny(name)
          desc.set.call(this, value)
        },
      })
    }
  }
  const guardList = (self, list, blocked, label) => {
    if (!live(self)) return list
    return new Proxy(list, {
      get(target, key) {
        const value = Reflect.get(target, key)
        if (typeof value !== 'function') return value
        if (blocked.indexOf(String(key)) === -1) return value.bind(target)
        return function () { deny(label + '.' + String(key)) }
      },
      set() { deny(label); return true },
    })
  }
  patch(Node.prototype, ['appendChild', 'insertBefore', 'removeChild', 'replaceChild'], live)
  patch(Element.prototype, ['append', 'prepend', 'after', 'before', 'replaceWith', 'replaceChildren', 'remove', 'insertAdjacentElement', 'insertAdjacentHTML', 'insertAdjacentText', 'setAttribute', 'setAttributeNS', 'removeAttribute', 'removeAttributeNS', 'toggleAttribute', 'attachShadow', 'animate'], live)
  patch(Document.prototype, ['write', 'writeln', 'execCommand', 'append', 'prepend'], () => true)
  patch(CSSStyleSheet.prototype, ['insertRule', 'deleteRule', 'addRule'], () => true)
  patch(NamedNodeMap.prototype, ['setNamedItem', 'setNamedItemNS', 'removeNamedItem', 'removeNamedItemNS'], () => true)
  patchSet(Element.prototype, ['innerHTML', 'outerHTML', 'className', 'id'], live)
  patchSet(Node.prototype, ['textContent', 'nodeValue'], live)
  patchSet(CharacterData.prototype, ['data'], live)
  patchSet(HTMLElement.prototype, ['innerText', 'outerText', 'hidden'], live)
  patchSet(HTMLInputElement.prototype, ['value', 'checked'], live)
  patchSet(HTMLTextAreaElement.prototype, ['value'], live)
  patchSet(HTMLSelectElement.prototype, ['value', 'selectedIndex'], live)
  patchSet(Document.prototype, ['title', 'cookie', 'adoptedStyleSheets'], () => true)
  const classListDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'classList')
  if (classListDesc && classListDesc.get) {
    Object.defineProperty(Element.prototype, 'classList', {
      configurable: true,
      get: function () { return guardList(this, classListDesc.get.call(this), ['add', 'remove', 'toggle', 'replace'], 'classList') },
    })
  }
  const datasetDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'dataset')
  if (datasetDesc && datasetDesc.get) {
    Object.defineProperty(HTMLElement.prototype, 'dataset', {
      configurable: true,
      get: function () {
        const set = datasetDesc.get.call(this)
        if (!live(this)) return set
        return new Proxy(set, {
          get(target, key) { const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value },
          set() { deny('dataset'); return true },
        })
      },
    })
  }
  const styleDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'style')
  if (styleDesc && styleDesc.get) {
    Object.defineProperty(HTMLElement.prototype, 'style', {
      configurable: true,
      get: function () { return guardList(this, styleDesc.get.call(this), ['setProperty', 'removeProperty'], 'style') },
    })
  }
  Object.defineProperty(globalThis, '__dshReadOnly', { value: true })
  return 'installed'
})()`

export const FEED_HIDDEN_HINT =
  'the tab is hidden, so a surface that renders only while visible can read as a shell; '
  + 'pass forceActive:true to hold the page lifecycle for the collection (it is released afterwards), then retry'

export const FEED_UNKEYED_HINT =
  'elements matched but none had an href or visible text, so they are placeholders or wrappers, not items: '
  + 'the feed probably did not render (scroll and retry, or forceActive:true on a hidden tab)'
