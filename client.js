/**
 * Client half: extension install controls on this bundle's page.
 *
 * Chrome refuses to install an off-store extension from a page, so there is no
 * honest "one-click install" button. The host packs the extension on demand and
 * this serves the unpacked zip: download, unzip, Load unpacked.
 */

window.__ModuleLoader__.load({
  id: 'browser-bridge',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /*
     * One ramp, three text roles, one accent.
     *
     * The card lives inside the harness shell, so it takes the shell's own
     * foreground and only chooses how far to step it down. Two steps, not four:
     * the old code expressed "quiet" four different ways (0.65, 0.62, 0.62,
     * 0.50) and the differences were invisible until they sat side by side.
     */
    const HAIRLINE = '1px solid rgba(127,127,127,0.28)'
    const SURFACE = 'rgba(127,127,127,0.05)'
    const ACCENT = '#3964fe'
    const TEXT_SECONDARY = 0.66
    const TEXT_MUTED = 0.46

    const box = {
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
      padding: '20px',
      margin: '4px 0 12px',
      border: HAIRLINE,
      background: SURFACE,
      borderRadius: '14px',
      fontSize: '13px',
      lineHeight: 1.45,
    }
    const title = { fontWeight: 600, fontSize: '13px', margin: 0 }
    const muted = { opacity: TEXT_SECONDARY, fontSize: '12px', margin: 0 }
    const row = { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }

    // Blue for the action that moves the thing, grey fill for the secondary
    // ones. An outlined button on this surface disappears — the surface is
    // nearly the same value as the page, so a hairline alone carries no weight.
    const primary = {
      display: 'inline-block',
      padding: '7px 14px',
      borderRadius: '10px',
      background: ACCENT,
      color: '#fff',
      fontWeight: 500,
      fontSize: '12px',
      textDecoration: 'none',
      border: 0,
    }
    const filled = {
      ...primary,
      background: 'rgba(127,127,127,0.16)',
      color: 'inherit',
      fontWeight: 500,
      border: 0,
    }

    const line = {
      display: 'flex',
      gap: '12px',
      alignItems: 'center',
      padding: '12px',
      border: HAIRLINE,
      borderRadius: '10px',
    }
    const cell = { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px', lineHeight: 1.3 }
    const cellName = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '12px', fontWeight: 600 }
    const cellId = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: '11px', letterSpacing: '.01em', opacity: TEXT_MUTED }

    // The signature: a 6px lamp, no halo. Depth comes from the surface step, not
    // from a glow — the same lamp the extension popup uses.
    const lamp = (colour) => ({ width: '6px', height: '6px', borderRadius: '50%', flex: 'none', background: colour })
    const mark = (on) => lamp(on ? '#22c55e' : '#6b7280')

    const swap = { display: 'inline-grid' }

    // The endpoint row: same rhythm as a browser row, no box of its own.
    const endRow = { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', padding: '0 0 8px' }
    const endLabel = { fontSize: '12px', opacity: TEXT_MUTED, flex: 'none' }

    /**
     * Two keyframes, injected once.
     *
     * Same language as the extension popup: a failed action is felt as a shake
     * rather than described in a sentence. A stylesheet is the only way to get
     * @keyframes into a React tree, and the guard keeps StrictMode's double
     * apply from appending it twice.
     */
    function injectStyles() {
      const id = 'browser-bridge-keyframes'
      if (document.getElementById(id)) return
      const style = document.createElement('style')
      style.id = id
      style.textContent = [
        '@keyframes bb-shake{10%,90%{transform:translateX(-1px)}20%,80%{transform:translateX(2px)}30%,50%,70%{transform:translateX(-3px)}40%,60%{transform:translateX(3px)}}',
        '@keyframes bb-pop{0%{transform:scale(.7);opacity:0}55%{transform:scale(1.15)}100%{transform:scale(1);opacity:1}}',
        '@keyframes bb-pulse{0%,100%{box-shadow:0 0 0 2px rgba(245,158,11,.18)}50%{box-shadow:0 0 0 5px rgba(245,158,11,.30)}}',
        '@media (prefers-reduced-motion: reduce){.bb-anim{animation:none!important}}',
        // A port is typed, not nudged by ones. The native spinner is also drawn
        // at roughly the font size, which makes it the biggest thing in a 76px
        // field.
        '.bb-port::-webkit-outer-spin-button,.bb-port::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}',
        '.bb-port{-moz-appearance:textfield;appearance:textfield}',
      ].join('\n')
      document.head.append(style)
    }
    const swapLayer = (visible) => ({ gridArea: '1 / 1', visibility: visible ? 'visible' : 'hidden' })
    // A fast reply used to flip the label for one frame, which read as a glitch.
    const MIN_BUSY_MS = 350

    /**
     * Read one plugin API reply without assuming it has a body.
     *
     * The host answers JSON on success. An empty failure body has three very
     * different causes and they must not be conflated, because the wrong guess
     * sends the reader to the wrong place:
     *
     *   404 empty  — the route is not mounted (plugin half not loaded, host
     *                restarted mid-request, a proxy in between).
     *   400 empty  — the route IS mounted and threw before writing anything.
     *                The harness webserver answers that as a bare 400, so a
     *                contract change (e.g. a route shape the server no longer
     *                dispatches) shows up as this and not as a 404.
     *   other      — a status worth reporting verbatim.
     */
    async function readJson(response, what) {
      const text = await response.text()
      if (!response.ok) {
        if (text) throw new Error(`${what} answered ${response.status}: ${text.slice(0, 160)}`)
        const hint = response.status === 404
          ? 'the route is not mounted — reload the plugin bundle'
          : response.status === 400
            ? 'the route is mounted but failed before answering; the plugin half is probably built for a different harness version'
            : 'the response was empty'
        throw new Error(`${what} answered ${response.status} with an empty body — ${hint}`)
      }
      try {
        return JSON.parse(text)
      } catch {
        throw new Error(`${what} answered ${response.status} with a body that is not JSON`)
      }
    }

    /**
     * Ask the installed extension, from this page, to attach this browser.
     *
     * The page sends the endpoint its own plugin is actually listening on, which
     * it reads from `/browser-bridge/api/build`. It deliberately does NOT let the
     * extension guess by sweeping ports: with two dsh processes on one machine —
     * a Windows app beside a WSL one, or any instance on a non-default port — the
     * sweep found the *other* instance's bridge and attached to it, or reported
     * "no browser-bridge answered" while one was running fine two ports away.
     */
    async function connectBrowser(extensionId) {
      let pairing = ''
      let stopped = ''
      try {
        const response = await fetch('/browser-bridge/api/build', { cache: 'no-store' })
        if (response.ok) {
          const body = await response.json()
          const bridge = body?.bridge ?? {}
          if (bridge.pairing) pairing = String(bridge.pairing)
          else if (bridge.listening === false) {
            // The plugin is loaded but its endpoint never bound; say why here
            // instead of letting the extension report an unreachable port.
            stopped = [bridge.error, bridge.hint].filter(Boolean).join(' — ') || 'the plugin endpoint is not listening'
          }
        }
      } catch {}
      if (!pairing && stopped) return { ok: false, error: stopped }
      const endpoint = typeof location?.origin === 'string' ? location.origin : ''
      return new Promise((resolve) => {
        try {
          if (!globalThis.chrome?.runtime?.sendMessage) {
            resolve({ ok: false, error: 'This page is not running in a Chromium browser with the extension API.' })
            return
          }
          chrome.runtime.sendMessage(extensionId, { type: 'connect', endpoint: pairing, page: endpoint }, (response) => {
            const failure = chrome.runtime.lastError
            resolve(failure ? { ok: false, error: failure.message ?? String(failure) } : (response ?? { ok: false, error: 'no reply' }))
          })
        } catch (error) {
          resolve({ ok: false, error: error?.message ?? String(error) })
        }
      })
    }

    /** Turn any extension answer into something this panel can render. */
    function replyState(reply) {
      if (reply && typeof reply === 'object' && reply.ok) {
        const origin = typeof reply.origin === 'string' && reply.origin ? reply.origin : 'this browser'
        return { ok: true, origin }
      }
      const error = reply && typeof reply === 'object' && typeof reply.error === 'string' ? reply.error : ''
      return {
        ok: false,
        error: error || 'the extension did not answer — reload it from chrome://extensions, then press Connect again',
      }
    }

    function Install() {
      const [meta, setMeta] = React.useState(null)
      React.useEffect(() => {
        let alive = true
        let seen = localStorage.getItem('browser-bridge.version') ?? ''
        const tick = async () => {
          try {
            const response = await fetch('/browser-bridge/extension-meta.json', { cache: 'no-store' })
            if (!response.ok) return
            const value = await response.json()
            if (!alive) return
            setMeta(value)
            // New build on the server: ask the extension to re-read its folder.
            if (value?.devReload && value.version && seen && value.version !== seen) {
              localStorage.setItem('browser-bridge.version', value.version)
              chrome.runtime.sendMessage(value.id, { type: 'reload' }, () => { void chrome.runtime.lastError })
            }
            if (value?.devReload && value.version) {
              seen = value.version
              localStorage.setItem('browser-bridge.version', value.version)
            }
          } catch {}
        }
        void tick()
        const timer = setInterval(tick, 5000)
        return () => { alive = false; clearInterval(timer) }
      }, [])

      return h(
        'div',
        { style: box },
        h('p', { style: title }, 'Browser extension'),
        h(
          'p',
          { style: muted },
          'Unpacked build of this dsh’s extension.',
        ),
        meta && meta.id
          ? h('p', { style: muted }, `Extension ID ${meta.id} · v${meta.version}`)
          : null,
        h(
          'div',
          { style: row },
          h('a', { style: primary, href: '/browser-bridge/extension.zip', download: '' }, 'Download extension (.zip)'),
          meta?.devReload
            ? h('button', {
                style: { ...filled, padding: '7px 12px' },
                onClick: () => chrome.runtime.sendMessage(meta.id, { type: 'reload' }, () => { void chrome.runtime.lastError }),
              }, 'Reload extension')
            : null,
        ),
        h(
          'p',
          { style: muted },
          'The zip is packed from this install on download. Unzip it, then load the folder '
          + 'with Load unpacked on chrome://extensions. Full steps are in README.md.',
        ),
      )
    }

    /**
     * The bridge endpoint, folded into the Connected browsers card.
     *
     * It used to be its own card above this one, which meant the page opened
     * with a wall of port jargon before it said anything about browsers. The
     * state it reports is exactly the state that decides whether a browser can
     * connect, so it belongs in the same card — as one row, not a section.
     *
     * Interaction rules come from the extension popup, which earned them:
     * a failure is a property of the button (red, one shake, stays red until
     * the field changes), never a sentence to read. The one thing prose is used
     * for here is a blocked port's *reason*, because "port 8791 is held by
     * another dsh" cannot be shown by colour.
     */
    function EndpointBar({ bridge, onChanged }) {
      const [draft, setDraft] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [flash, setFlash] = React.useState('')   // '' | 'ok' | 'error'
      // A ref, not state: the poll must not close over a stale value, and the
      // flag never affects rendering.
      const dirtyRef = React.useRef(false)
      const timerRef = React.useRef(0)

      React.useEffect(() => {
        if (!dirtyRef.current) setDraft(String(bridge?.port ?? ''))
      }, [bridge?.port])

      React.useEffect(() => () => clearTimeout(timerRef.current), [])

      // First paint, before /api/build answers. Rendering the real row with an
      // empty field and a red dot would flash a failure that has not happened;
      // this keeps the height and says nothing.
      if (bridge === null) {
        return h('div', { style: endRow }, h('span', { style: { ...endLabel, opacity: 0.4 } }, 'Reading the endpoint…'))
      }

      const listening = bridge?.listening === true
      const source = bridge?.source ?? 'default'

      // The red stays until the field is touched — same contract as the popup.
      // The reason is logged, not printed: the popup learned that a sentence
      // under a failed action is read *instead* of the action.
      const fail = (reason) => {
        clearTimeout(timerRef.current)
        if (reason) console.warn('browser-bridge:', reason)
        setFlash('error')
      }

      const apply = async (body) => {
        const startedAt = Date.now()
        setBusy(true)
        setFlash('')
        try {
          const response = await fetch('/browser-bridge/api/port', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-browser-bridge': '1' },
            body: JSON.stringify(body),
          })
          const text = await response.text()
          let value = {}
          try { value = text ? JSON.parse(text) : {} } catch {}
          if (!response.ok || value.ok === false) throw new Error(value.error || `the plugin answered ${response.status}`)
          setFlash('ok')
          dirtyRef.current = false
          setDraft(String(value.port))
          clearTimeout(timerRef.current)
          timerRef.current = setTimeout(() => setFlash(''), 900)
          if (typeof onChanged === 'function') onChanged()
        } catch (error) {
          fail(error?.message ?? String(error))
        } finally {
          // Loopback answers in tens of milliseconds; without a floor the busy
          // state is one frame long and reads as a glitch.
          const left = MIN_BUSY_MS - (Date.now() - startedAt)
          if (left > 0) await new Promise((resolve) => setTimeout(resolve, left))
          setBusy(false)
        }
      }

      const field = {
        width: '76px',
        padding: '5px 8px',
        borderRadius: '10px',
        border: flash === 'error' ? '1px solid #ef4444' : HAIRLINE,
        background: SURFACE,
        color: 'inherit',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: '12px',
        transition: 'border-color 140ms ease, box-shadow 140ms ease',
      }

      const dotColor = busy ? '#f59e0b' : flash === 'error' ? '#ef4444' : (listening ? '#22c55e' : '#ef4444')

      return h(
        'div',
        { style: endRow },
        h('span', {
          style: {
            ...lamp(dotColor),
            // No shake and no halo: the button carries the refusal, and a lit
            // lamp reads without a ring around it.
            animation: busy ? 'bb-pulse 900ms ease-in-out infinite' : undefined,
          },
        }),
        h('span', { style: endLabel }, 'Port'),
        h('input', {
          type: 'number',
          min: 1024,
          max: 65535,
          value: draft,
          className: 'bb-port',
          style: field,
          disabled: busy,
          'aria-label': 'Bridge port',
          onChange: (event) => {
            dirtyRef.current = true
            setFlash('')
            setDraft(event.target.value)
          },
          onKeyDown: (event) => { if (event.key === 'Enter') void apply({ port: Number(draft) }) },
        }),
        bushy(busy, () => apply({ port: Number(draft) }), flash),
        source === 'settings'
          ? h('button', {
              type: 'button',
              style: { ...filled, padding: '6px 10px', opacity: busy ? 0.7 : 1 },
              disabled: busy,
              title: `Restore the port from cordis.patch.yml (${bridge.configuredPort})`,
              onClick: () => void apply({ reset: true }),
            }, `Reset to ${bridge.configuredPort}`)
          : null,
      )
    }

    /**
     * The Apply button, which is also the only feedback there is.
     *
     * Red + shake for a refusal, green for 900 ms for a success — the same two
     * states the extension popup settled on. No word, no line under the row: a
     * label that appears next to an action is read *instead of* the action, and
     * on a three-control row it also shifts them sideways every time.
     */
    function bushy(busy, onClick, flash) {
      const background = flash === 'error' ? '#dc2626' : flash === 'ok' ? '#16a34a' : ACCENT
      const color = '#fff'
      return h('button', {
        type: 'button',
        style: {
          ...primary,
          padding: '5px 12px',
          fontSize: '12px',
          cursor: busy ? 'progress' : 'pointer',
          opacity: busy ? 0.7 : 1,
          background,
          color,
          border: 0,
          transition: 'background-color 160ms ease, border-color 160ms ease, transform 90ms ease, opacity 120ms ease',
          animation: flash === 'error' ? 'bb-shake 420ms cubic-bezier(.36,.07,.19,.97)' : undefined,
          transform: flash === 'ok' ? 'scale(.97)' : undefined,
        },
        disabled: busy,
        onClick,
      }, 'Apply')
    }

    /**
     * Live list of browsers attached to this plugin, managed from here.
     *
     * Three things live in this one card, in the order the reader needs them:
     * the endpoint (can a browser connect at all), the browsers (who is
     * connected), and the two ways to add one — the extension handshake, which
     * only works when this page is inside Chrome, and a copied pairing link for
     * every case where it is not (a DSH desktop app, another machine, a browser
     * without the extension).
     */
    function Browsers() {
      const [state, setState] = React.useState({ browsers: [], active: null, error: null })
      const [bridge, setBridge] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [link, setLink] = React.useState(null)
      const [copied, setCopied] = React.useState(false)
      const [copyFailed, setCopyFailed] = React.useState(false)
      const [extId, setExtId] = React.useState('')

      const loadBridge = React.useCallback(async () => {
        try {
          const response = await fetch('/browser-bridge/api/build', { cache: 'no-store' })
          if (!response.ok) return
          const body = await response.json()
          setBridge(body?.bridge ?? null)
        } catch {}
      }, [])

      React.useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            const response = await fetch('/browser-bridge/api/browsers', { cache: 'no-store' })
            const body = await readJson(response, 'The browser list')
            if (alive) setState({ browsers: body.browsers ?? [], active: body.active ?? null, error: null })
          } catch (error) {
            if (alive) setState((prev) => ({ ...prev, error: error?.message ?? String(error) }))
          }
        }
        injectStyles()
        void load()
        void loadBridge()
        const timer = setInterval(() => { void load(); void loadBridge() }, 3000)
        return () => { alive = false; clearInterval(timer) }
      }, [loadBridge])

      // The extension id comes from the same manifest the Install card reads, so
      // the handshake knows who to message without hardcoding anything.
      React.useEffect(() => {
        let alive = true
        fetch('/browser-bridge/extension-meta.json', { cache: 'no-store' })
          .then((response) => (response.ok ? response.json() : null))
          .then((value) => { if (alive && value?.id) setExtId(String(value.id)) })
          .catch(() => {})
        return () => { alive = false }
      }, [])

      const drop = async (id) => {
        setBusy(id)
        setState((prev) => ({ ...prev, browsers: prev.browsers.filter((entry) => entry.id !== id) }))
        try {
          const response = await fetch(`/browser-bridge/api/disconnect?id=${encodeURIComponent(id)}`, { cache: 'no-store' })
          const body = await readJson(response, 'The detach request').catch(() => ({}))
          if (!body?.ok) throw new Error(body?.error ?? 'the plugin refused the detach')
        } catch (error) {
          setState((prev) => ({ ...prev, error: error?.message ?? String(error) }))
          try {
            const response = await fetch('/browser-bridge/api/browsers', { cache: 'no-store' })
            const body = await readJson(response, 'The browser list')
            setState({ browsers: body.browsers ?? [], active: body.active ?? null, error: null })
          } catch {}
        } finally {
          setBusy('')
        }
      }

      const connect = async () => {
        if (!extId || link?.busy) return
        const startedAt = Date.now()
        setLink({ busy: true })
        const reply = await connectBrowser(extId)
        const left = MIN_BUSY_MS - (Date.now() - startedAt)
        if (left > 0) await new Promise((resolve) => setTimeout(resolve, left))
        setLink({ busy: false, ...replyState(reply) })
        void loadBridge()
      }

      /**
       * Copy, on any origin.
       *
       * `navigator.clipboard` only exists in a secure context. This page is
       * reached over plain HTTP on the LAN by every browser that is not the
       * local one (http://192.168.1.20:3080), so on a remote browser the async
       * API is simply absent — and it used to report "Copied" regardless,
       * because the catch swallowed the miss and set the success state anyway.
       *
       * The fallback is the old synchronous path, which is not origin-gated:
       * a temporary textarea, select, execCommand. Deprecated, still the only
       * thing that works over http:// outside localhost.
       */
      const copyText = async (text) => {
        try {
          if (window.isSecureContext && navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text)
            return true
          }
        } catch {
          // Fall through to the synchronous path rather than claiming success.
        }
        try {
          const area = document.createElement('textarea')
          area.value = text
          area.setAttribute('readonly', '')
          area.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0'
          document.body.appendChild(area)
          area.select()
          area.setSelectionRange(0, text.length)
          const ok = document.execCommand('copy')
          document.body.removeChild(area)
          return ok
        } catch {
          return false
        }
      }

      const copyPairing = async () => {
        const url = bridge?.pairing ?? ''
        if (!url) return
        const ok = await copyText(url)
        setCopied(ok)
        setCopyFailed(!ok)
        setTimeout(() => { setCopied(false); setCopyFailed(false) }, ok ? 1400 : 700)
      }

      const count = state.browsers.length
      const pairing = bridge?.pairing ?? ''

      return h(
        'div',
        { style: box },
        h('p', { style: title }, `Connected browsers${count ? ` (${count})` : ''}`),
        h(EndpointBar, { bridge, onChanged: () => { void loadBridge() } }),
        state.error
          ? h('p', { style: muted }, `Could not read the browser list: ${state.error}`)
          : count === 0
            ? h('p', { style: muted }, 'No browsers yet. Connect below, or copy the pairing link into the extension popup.')
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                state.browsers.map((entry) => h(
                  'div',
                  { key: entry.id, style: line },
                  h('span', { style: mark(entry.connected) }),
                  h('span', { style: cell },
                    h('span', { style: cellName }, entry.label || 'Browser'),
                    h('span', { style: cellId },
                      `${entry.id}${entry.version ? ` · v${entry.version}` : ''}${typeof entry.lastSeenSec === 'number' ? ` · seen ${entry.lastSeenSec}s ago` : ''}`),
                  ),
                  h('button',
                    { style: { ...primary, padding: '4px 12px', fontSize: '11px', fontWeight: 500 }, disabled: busy === entry.id, onClick: () => drop(entry.id) },
                    busy === entry.id ? 'Detaching…' : 'Detach'),
                )),
              ),
        h(
          'div',
          { style: { ...row, gap: '8px', marginTop: '2px' } },
          h(connectButton, { extId, link, onConnect: connect }),
          h('button', {
            type: 'button',
            style: {
              ...filled,
              padding: '6px 12px',
              opacity: pairing ? 1 : 0.5,
              cursor: pairing ? 'pointer' : 'default',
              background: copyFailed ? '#dc2626' : 'rgba(127,127,127,0.16)',
              color: copyFailed ? '#fff' : 'inherit',
              transition: 'background-color 140ms ease',
              animation: copyFailed ? 'bb-shake 420ms cubic-bezier(.36,.07,.19,.97)' : undefined,
            },
            disabled: !pairing,
            title: pairing ? `Copy ${pairing}` : 'The endpoint is not listening yet',
            onClick: copyPairing,
          }, h('span', { style: swap },
            h('span', { style: swapLayer(!copied) }, 'Pairing link'),
            h('span', { style: swapLayer(copied) }, 'Copied'),
          )),
        ),
      )
    }

    /** “Connect this browser”, with the busy/ok/error states the popup taught. */
    function connectButton({ extId, link, onConnect }) {
      const busy = Boolean(link?.busy)
      const failed = Boolean(link && !link.busy && !link.ok)
      const settled = Boolean(link && !link.busy && link.ok)
      return h('button', {
        type: 'button',
        style: {
          ...primary,
          cursor: !extId || busy ? 'default' : 'pointer',
          opacity: !extId ? 0.5 : 1,
          background: failed ? '#dc2626' : (settled ? '#16a34a' : ACCENT),
          transition: 'background-color 160ms ease, transform 90ms ease',
          animation: failed ? 'bb-shake 420ms cubic-bezier(.36,.07,.19,.97)' : undefined,
        },
        disabled: !extId || busy,
        'aria-busy': busy ? 'true' : undefined,
        title: extId ? undefined : 'The extension manifest is not being served yet',
        onClick: onConnect,
      }, h('span', { style: swap },
        h('span', { style: swapLayer(!busy && !settled) }, 'Connect this browser'),
        h('span', { style: swapLayer(busy) }, 'Connecting…'),
        h('span', { style: swapLayer(settled) }, 'Connected'),
      ))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register(
            { name: 'plugins.bundle.config', key: 'browser-bridge' },
            (props) => (props && props.view === 'page' ? h(React.Fragment, null, h(Browsers), h(Install)) : null),
          ),
        )
      },
    }
  },
})
