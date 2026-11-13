# Architecture

The plugin has two halves that share no process state. The host runs inside DSH
on Node. The extension runs in Chrome and is the only part that holds a debugger
session. They exchange JSON over HTTP: the extension polls the host, and the host
answers with one command or an empty response.

```
agent tool call
  -> tools.js           validate, render
  -> bridge.js          per-browser queue
  -> extension/sw.js    long poll, chrome.debugger
  -> tracked tab        CDP: Page, Runtime, Input, Network, Console, DOM
  <- result             POST /p/<token>/result
```

## Layers

1. Extension worker (`extension/sw.js`). Holds the debugger session, speaks CDP,
   exposes the worker command table, and runs the guarded evaluation world. It
   never talks to the model.
2. Transport (`bridge.js`). Owns the token, one queue per browser, the long poll
   and result matching. It has no page access of its own.
3. Tools (`tools.js`). Registers the ten `bsb_*` tools: validation, defaults and
   result rendering. A call becomes one worker command or a short sequence of
   them.
4. Host routes (`index.js`, `http-adapter.js`). Serves the dashboard endpoints,
   packs the extension zip on download, and reports the running build. The
   adapter wraps Fetch-style resources as Node handlers, which is the shape
   every DSH webserver release dispatches.
5. Skill (`skill/bsb-browser/SKILL.md`). Registered into the skill catalog when
   the plugin loads. `tests/skill-align.mjs` fails when the tools and the skill
   drift apart.
6. Tests. `tests/selftest.mjs` covers transport, routing, guards and packaging;
   `tests/compat-webserver.mjs` covers both route contracts; `tests/e2e.mjs`
   drives a real browser through the fixture pages.

## The read-only invariant

The plugin inspects pages and sends input. It does not edit them.

- Evaluation is read-only by default. `bsb_eval` and the `expression` form of
  `bsb_wait_for` run in an isolated world. Writes to any node connected to the
  document throw `READ_ONLY`: no `appendChild` or `remove`, no setter for
  `innerHTML`, `textContent`, `value`, `checked`, `style` or `className`, no
  `setAttribute`, no CSSOM, no `document.write`. A detached subtree stays
  writable, so analysis that builds its own canvas works.
- `world: "main"` is an explicit opt-in. It evaluates in the page's own world,
  where framework instances and closures are visible, and where writes are
  possible. Callers must name it; nothing selects it by default.
- Input tools send CDP input events, the same events a person at the keyboard
  produces. `set` and `select` assign a control's value and fire `input` and
  `change`, which is what typing or choosing an option would do.
- No window or viewport changes. The worker never writes a window size or state
  (`chrome.windows.update` only ever receives `{focused:true}`), never installs a
  device-metrics override, and never changes page zoom. A minimized window stays
  minimized and the tool reports `TAB_NOT_VISIBLE`.
- No focus or lifecycle emulation. `Emulation.setFocusEmulationEnabled` and a
  forced `Page.setWebLifecycleState` are never sent. A background tab stays
  throttled, and the tools report the frame rate they measure.
- `forceActive` is the only visibility override. It must be requested by name,
  the reply states what was forced and the visibility the page then reported,
  and a held override is mirrored into session storage so a worker restart
  re-applies it.
- No DOM injection. The extension has no content scripts and adds no node, style
  or class to a page.
- The worker sends only CDP methods on a reviewed allowlist.

## Why a guard instead of a sandbox

A separate renderer or frame cannot see the live DOM, the cookies, or the page's
fetch context, so it cannot do the inspection the tools exist for. Keeping that
access while forbidding writes is what fits the job. The guard therefore lives
inside the isolated world, next to the nodes it protects.

## Non-goals

- Editing a page's markup, CSS or content.
- Exposing page globals without an explicit `world: "main"` call.
- Resizing, zooming, restoring or raising the browser window.
- Observing downloads. A tab-scoped debugger receives no browser-level download
  events, so the tools cannot see them.
