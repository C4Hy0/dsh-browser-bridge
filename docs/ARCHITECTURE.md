# Architecture

The browser bridge is split in two halves that only talk over a narrow JSON
protocol, so the part that touches a page can be reasoned about — and audited —
on its own.

```
DSH host (Node)                          Chrome (the user's real window)
┌─────────────────────────┐   HTTP/SSE  ┌──────────────────────────────────┐
│ bridge.js               │◄───────────►│ extension/  (MV3 service worker) │
│  - tab registry         │  /dev/cmd   │  - chrome.debugger attach per tab│
│  - command transport    │             │  - CDP: Page, Runtime, Input,    │
│  - screenshot encode    │             │         Network, Console, DOM    │
│ tools.js                │             │  - worker command table          │
│  - model-facing tools   │             │  - guarded evaluation world      │
└─────────────────────────┘             └──────────────────────────────────┘
```

## Layers

1. **Extension service worker** (`extension/sw.js`) — the only code that holds
   a debugging session. It speaks CDP to Chrome, exposes a command table
   (`open`, `read`, `click`, `type`, `eval`, `waitFor`, …) and never talks to
   the model.
2. **Host bridge** (`bridge.js`) — pairs browsers, routes commands, converts
   captured frames into attachments and keeps per-tab state. It has no page
   access of its own.
3. **Tools** (`tools.js`) — the model-facing surface. Each tool is a thin
   validator + renderer over one or two worker commands.
4. **Skill** (`skill/bsb-browser/SKILL.md`) — the routing and workflow playbook,
   registered on load into the skill catalog. It is part of the model-facing
   surface: changes to `tools.js` and the skill ship together, enforced by
   `tests/skill-align.mjs`.
5. **Tests** (`tests/selftest.mjs`, `tests/e2e.mjs`) — selftest checks the host
   and worker agree on commands, that documentation matches the surface, and
   that the skill covers every tool and primary routing enum; e2e drives a real
   Chrome through the raw worker protocol against `tests/fixture.html`, including the
   read-only contract.

## The read-only invariant

The plugin is an **inspector and an input device**, not a page editor:

| Category | Tools | What they may do |
| --- | --- | --- |
| Inspect | `read`, `inspect`, `html`, `screenshot`, `sheet`, `pixels`, `network`, `console`, `tabs`, `frames`, `wait_for`, `eval` | Read the DOM, geometry, pixels, network and console. No writes. |
| Input | `click`, `type`, `key`, `scroll`, `drag`, `drop`, `hover`, `upload`, `open`, `tabs` | Trusted CDP input events, i.e. what a person at the keyboard/mouse produces. |
| Form helpers | `set`, `select` | Set a form control's value and fire `input`/`change`, as typing into it would. They cannot alter markup, styles or content. |
| Browser state | `browsers`, `tabs` | Read or focus tabs; never change the window's size or position. |

Guarantees this repository enforces:

- **No window or viewport changes.** The worker never calls
  `chrome.windows.update` with a size or state, never uses
  `Emulation.setDeviceMetricsOverride`, `Page.setDeviceMetricsOverride` or page
  zoom. `chrome.windows.update` is only ever sent `{focused:true}`: no `state`
  is ever written, because `state:'normal'` un-maximizes a maximized window
  (and un-fullscreens a fullscreen one) — a silent resize of the user's window.
  A minimized window therefore stays minimized; the tool reports
  `TAB_NOT_VISIBLE` and never restores it.
- **No page-state emulation.** The worker never installs
  `Emulation.setFocusEmulationEnabled` and never forces
  `Page.setWebLifecycleState`. A tab keeps the focus, visibility and lifecycle
  state the browser gave it. A background or minimized tab runs slower, and the
  tools report that measured frame rate (for example in `bsb_eval` after a
  `requestAnimationFrame` sample) instead of overriding it. Changing those
  states would change how the site behaves — the frontend the user sees — which
  is outside the input-device role.
- **No page edits from evaluation.** `bsb_eval` and the `expression`
  option of `bsb_wait_for` run model-supplied JavaScript in an isolated
  world whose DOM write surface (`appendChild`/`insertBefore`/`remove`, setters
  for `innerHTML`, `outerHTML`, `textContent`, `value`, `checked`, `style`,
  `classList`, `dataset`, `setAttribute`, CSSOM rules, `document.write`, …) is
  wrapped to throw for any node connected to the document. Detached nodes stay
  writable, so analysis that builds its own canvas still works. The page's own
  scripts live in the main world and are unaffected.
- **No main-world escape hatch.** The `world: "main"` option was removed; the
  worker rejects it with `READ_ONLY_ARCHITECTURE`. Anything requiring the
  page's own JavaScript must go through its HTTP API (`fetch` from the guarded
  world) or normal input.

The guard is installed per evaluation world by `guardedContext()`
(`extension/sw.js`), and `evaluateProgram()` turns a `READ_ONLY:` rejection
into a tool error instead of a silent value.

## Why not a sandbox instead of a guard?

A separate renderer/isolated frame cannot see the live DOM, cookies or the
site's HTTP API context, which is exactly what inspection needs; keeping that
access and forbidding writes is the only combination that serves both "look at
the page" and "do not touch the page". The guard therefore lives inside the
isolated world, close to the thing it protects, and is exercised by the e2e
suite (mutations are attempted and must be rejected, and the fixture's DOM and
text must be byte-identical afterwards).

## Deliberate non-goals

- Editing a page's markup, CSS or content on behalf of the model.
- Reading or writing the page's own JS globals.
- Changing the browser window, its size, zoom or DPI.
