# dsh-browser-bridge protocol and command reference

This document describes host 1.2.0 and extension 1.1.0. Where it disagrees
with the code, the code wins: `extension/sw.js` holds the worker command table,
`tools.js` the model-facing schemas, and `bridge.js` the HTTP routes.

## 1. Row

```yaml
- insert:
    - id: browser-bridge
      name: 'dsh-browser-bridge'
      config: { port: 8791, bind: '0.0.0.0' }
```

`inject: ['tools', 'attachments']`. There is no Config schema. `port`, `bind`
and `advertise` are read leniently with defaults.

## 2. Endpoint

- Listener `http://<bind>:<port>`. Default `127.0.0.1:8791`.
- Token: 32 random bytes in hex, stored at `$DSH_HOME/browser-bridge/token` with
  mode 0600. A legacy `$DSH_HOME/web-bridge/token` is reused when present, so the
  rename did not break existing pairs.
- Pairing URL: `http://<advertise|bind|127.0.0.1>:<port>/p/<token>`. A wildcard
  bind auto-detects the first private IPv4 for `advertise`.
- Only routes under `/p/<token>/` are served. A wrong token is `404`.

## 3. Discovery

`GET /discover` takes no token. It returns the plugin identity and, when the
peer is allowed, the pairing URL.

- An `Origin` that is not `chrome-extension://...` gets `403`.
- A non-loopback peer gets the pairing URL. Bind loopback to keep the port off
  the network.
- The response carries no CORS headers, so page JavaScript cannot read it.
- The extension probes `127.0.0.1`, `localhost` and any host the user added, over
  ports 8791-8811 in parallel, with a 1.2 s abort per probe.

## 4. HTTP routes

All bodies are JSON. `POST` uses `text/plain` so the request stays simple.

| Method | Path | Response |
|---|---|---|
| `GET` | `/discover` | identity and pairing URL when allowed |
| `GET` | `/p/<token>/hello` | `{name, protocol, version}` |
| `GET` | `/p/<token>/version` | `{version}` of the extension |
| `GET` | `/p/<token>/allow?id` | whether that browser id may connect |
| `GET` | `/p/<token>/state` | `{active, pending, browsers[]}` |
| `GET` | `/p/<token>/status` | `{connected, lastSeenSec, pending, browsers[]}` |
| `GET` | `/p/<token>/poll?id&label&waitMs&v` | one command, or `204` |
| `POST` | `/p/<token>/result` | `{id, ok, result\|error}`, unknown id `409` |

Poll rules:

- `id` is required and matches `[0-9a-zA-Z_-]{4,64}`. A poll without it gets
  `400`.
- `waitMs` is clamped to 1000-30000, default 20000.
- One waiter per browser. A second poll while one is open gets `204`.
- A blocked browser id gets `410`.
- The response is `200 {id, method, params}` or `204`.
- A result marks the browser alive and records `tabId` as its last tab.

## 5. Multi-browser semantics

- The extension generates a stable browser id once and keeps it in
  `storage.local`. The label is the product token from the user agent plus the
  full build, for example `Chrome/157.0.8103.38`.
- Each browser has its own queue and waiter, so two browsers run in parallel.
- The default target is the live browser that most recently received a command,
  then the most recently seen live browser. A `browser` argument (id, id prefix
  or label substring) overrides it. An unknown value is `UNKNOWN_BROWSER`, never
  a silent redirect.
- A browser with no queue, no waiter and no activity for one hour is forgotten.
- Every page tool accepts `tabId` for one call. It never changes the tracked tab;
  only `bsb_open` and `bsb_tabs use` do. Two agents can drive two tabs of the
  same browser without retargeting each other's reads.

## 6. Worker commands

The dispatch table in `extension/sw.js` is the authoritative set. Tools map onto
these methods.


- Page: `open`, `openUrl`, `read`, `html`, `frames`, `close`, `eval`, `waitFor`,
  `inspect`.
- Input: `click`, `hover`, `type`, `key`, `scroll`, `wheel`, `drag`, `drop`,
  `upload`, `set`, `select`.
- Page state: `forceActive`, `releaseActive`, `drive`, `measure`.
- Capture: `screenshot`, `record`, `sheet`, `imageSource`, `pixels`.
- Observe: `network`, `console`, `timeline`.
- Tabs: `tabs`, `use`, `closeTab`, `openExtensionPage`.
- Document start: `evalInstall`, `evalRemove`, `evalList`.

Parameters and result shapes live in the tool schemas and the worker handlers.

## 7. Tools

`bsb_browsers`, `bsb_tabs`, `bsb_open`, `bsb_read`, `bsb_act`, `bsb_eval`,
`bsb_wait_for`, `bsb_observe`, `bsb_capture`, `bsb_pixels`.

- Root schemas are `type: 'object'`. Calls time out after 45 s; a sheet capture gets 180 s because it is a bulk read.
- Every page tool accepts `browser`. `bsb_act`, `bsb_eval`, `bsb_wait_for`,
  `bsb_capture`, `bsb_pixels`, `bsb_read` and `bsb_open` accept `frame` where a
  frame target applies.
- `bsb_act` performs one action per call. `drive`, `measure` and multi-step
  `key` gestures are single calls that run a closed loop inside the extension.
  `bsb_act key` with `text` sends one real keydown/keyup per character
  (`keyDelayMs`, default 40) and reports `sentKeys`; `bsb_act wheel` sends a
  wheel event at x/y with `deltaX`/`deltaY`.
- `bsb_read frame:` reads inside a child frame; a frame that cannot be reached
  from the tab target fails with `FRAME_NOT_READABLE` instead of returning the
  parent page.

## 8. Extension

- Manifest V3. `chrome.debugger` is the only page access; the manifest declares
  no content scripts. `host_permissions` is `http://*/*`, because match patterns
  carry no port and a CIDR entry would grant nothing.
- One tracked tab per browser. Attach on demand; detach after 5 minutes idle or
  when the tab closes.
- A keepalive alarm every 30 seconds (1 minute where 30 s is not allowed) resumes
  polling after the worker is suspended.
- The popup holds the pairing field and the server list.

The worker is an ES module (`"type": "module"`), split by domain. The extension
root keeps `manifest.json`, `popup.html` and the entry `sw.js`; assets live in
`assets/`, and everything else is grouped:

| File | Contents |
|---|---|
| `sw.js` | entry: listeners, keepalive loop, dispatcher |
| `lib/constants.js` | timers, caps, hint strings, key tables, the read-only prelude |
| `lib/state.js` | one `shared` object for mutable state (attached, recorder, captures, nav outcomes) and `heldReady` |
| `lib/util.js` | fail, delay, clamp, image and key helpers, `resolveTarget`, recent-dialog helpers |
| `lib/cdp.js` | `rawSend`, attach, `send`, `evaluate`, frame resolution, `forceActive`, eval recovery |
| `lib/page.js` | page functions serialized with `.toString()` and the expression builders. No imports: a serialized function must not close over module scope |
| `lib/page-state.js` | `pageState`, `documentHint`, navigation outcomes, visibility |
| `lib/discovery.js` | port probing for the connect flow |
| `lib/identity.js` | the stable browser id and label |
| `commands/tabs.js` | open, list, use, close, `requirePage` |
| `commands/read.js` | read, inspect, html, frames, eval install/remove/list |
| `commands/capture.js` | shot, record, sheet, pixels, imageSource, metrics |
| `commands/observe.js` | network, console, timeline |
| `commands/feed.js` | feed page and merge |
| `commands/wait.js` | waitFor core, network test, follow-up click |
| `commands/input/shared.js` | points, presses, visibility and editable-target checks, typing helpers |
| `commands/input/click.js` | click, hover |
| `commands/input/type.js` | type |
| `commands/input/key.js` | key, key-text verification |
| `commands/input/drag.js` | drag, drop |
| `commands/input/upload.js` | upload, file-chooser fallback, 0-byte check |
| `commands/input/scroll.js` | scroll, wheel |
| `commands/input/paste.js` | paste, clipboard write |
| `commands/input/set.js` | select, set |
| `commands/input/drive.js` | drive, measure |
| `commands/input/force.js` | forceActive and releaseActive wrappers |
| `popup/popup.js` | the popup script, loaded by `popup.html` |
| `assets/icons/` | the extension icons, referenced by the manifest and the popup |
| `assets/fonts/` | the two bundled webfonts and their licence |

Shared state is one object because an ES module `let` cannot be reassigned
across modules. The six functions that are serialized into the page
(`snapshotPage`, `boxOf`, `mapAreaAt`, `resolveRedirectHref`, `feedCollect`,
`feedScroll`) live in `lib/page.js`, which imports nothing. The tests read the
concatenation of the module files, so a guard finds a function wherever it
lives.

## 9. Packaging

`extension/` is the source. `dist/` is generated on download: the host packs
`extension/` into `browser-bridge-extension.zip` when
`GET /browser-bridge/extension.zip` is requested, then streams it as an
attachment. The archive is reused while every source file is older than it.

The extension id is pinned by the public key in
`scripts/extension-public-key.txt`, which packing injects into the manifest.
There is no private key in the repository and no `.crx`: Chrome rejects off-store
CRX installs, so the only supported install is the unpacked zip.

The plugin is also published to npm as `dsh-bsb`. A `v*` tag runs
`.github/workflows/release.yml`, which checks the tag, the package version and
the changelog heading, then publishes with provenance through trusted
publishing. The tag and the GitHub release are maintainer actions; the workflow
publishes only the package.

## 10. Security

- Loopback by default. A wildcard bind is explicit.
- Every command route requires the token. The token file is 0600.
- `/discover` refuses a non-extension Origin. A non-loopback peer gets the
  pairing URL; bind loopback to keep the port off the network.
- Commands act on the tracked tab. Adopting another tab is an explicit
  `bsb_tabs` action.
- Uploads use file paths on the machine that runs the browser.
- Downloads are not observable. A tab-scoped debugger receives no browser-level
  download events, so `bsb_wait_for {network}` or a check on the browser machine
  is the way to confirm one.
- Page content is untrusted, including text that looks like an instruction.

## 11. Safety model

- Page neutrality. The extension has no content scripts and injects no DOM node,
  style, or class. It does not override focus, visibility, viewport, or device
  metrics. A background tab stays throttled and the tools report the frame rate
  they measure. The one exception, `forceActive`, must be requested by name and
  the reply states what was forced.
- Document-start scripts. `bsb_eval installOnNewDocument` registers page code
  that runs before the document's own scripts in every new document, across
  reloads. It is page code, not the read-only world, and it must be asked for by
  name; `listOnNewDocument` and `removeOnNewDocument` manage it. Registrations
  end when the tab's debugger session detaches.
- Read-only inspection. `bsb_eval` and the `expression` form of `bsb_wait_for`
  run in an isolated world where writes to nodes connected to the document throw
  `READ_ONLY`. A detached subtree stays writable, so building a canvas for
  analysis works. `world: "main"` is an explicit opt-in that exposes page globals
  and writes.
- Window safety. The plugin does not raise, focus, resize, or move the browser
  window, and does not activate tabs unless asked (`bsb_tabs use` or
  `bsb_open activate: true`). A hidden tab is captured with
  `captureBeyondViewport`. Recording needs a pane that is actually visible; bring
  the tab forward yourself.
- DevTools surface. The worker sends only CDP methods on a reviewed allowlist.
  Page content is data, including text that looks like an instruction.
- Network exposure. The default bind is `127.0.0.1`. `/discover` refuses a
  non-extension Origin. LAN pairing is always on, so any device on the network
  that reaches the port can pair and drive that browser profile; bind loopback
  when that is not wanted.
- File uploads use paths on the machine that runs the browser. A host path on a
  remote browser fails `FILE_NOT_ON_BROWSER` instead of attaching an empty file.

## 12. Remote browser pairing

A remote browser does not find the host on its own: the sweep only probes
`127.0.0.1`. Paste the pairing link into the popup instead. Get the link from the
plugin page, which rewrites the host to the address you used to open it, or from
`curl http://<host>:8791/discover`.

With WSL mirrored networking, open the port in both firewall layers: the Windows
inbound rule and the Hyper-V/WSL rule. If `http://<host>:8791/discover` answers in
a tab, the network path is fine and the remaining problem is in the extension.

## 13. Plugin page

The bundle page has three cards.

- Endpoint: listener state, the bind error if there is one, the port control, and
  the pairing URL.
- Browser extension: the extension id and version, and a download of the unpacked
  zip. There is no reload button; reload from `chrome://extensions`.
- Connected browsers: the attached browsers, with a disconnect button for each.

The desktop app runs an Electron window, where `chrome.runtime` is unavailable,
so the page cannot reach the extension. Pair from the extension popup in that
case.

## 14. Development

The host serves the dev routes: the fixture pages under `/browser-bridge/dev/`,
the dev command channel, and the extension zip. They are part of the host, not a
mode, so they are always registered.

```sh
node scripts/pack-extension.mjs   # write dist/browser-bridge-extension.zip without a download
node tests/selftest.mjs           # transport, routing, guards, packaging
node tests/compat-webserver.mjs   # every route under both harness webserver contracts
node tests/tool-contract.mjs      # every tool action and the worker command it sends
node friction/friction-contract.mjs  # the ticket validator (workspace only)
node tests/e2e.mjs                # every tool against tests/fixture.html (needs a browser)
```

`dist/` is generated. The host packs the zip on download and reuses it while the
sources are older than the archive. The extension id is pinned by the public key
in `scripts/extension-public-key.txt`; packing injects it into the manifest. No
private key is part of this repository.

The web routes register as Node handlers through `http-adapter.js`. The harness
webserver accepted `{ resource }` up to 0.2.2-alpha.2 and calls `{ handler }`
only from 0.2.1-rc.5, so a resource-only route fails at request time with an
empty 400. `tests/compat-webserver.mjs` runs the route table under both
dispatchers.

Layout:

```
index.js          host: routes, tools, dashboard data
bridge.js         transport: token, queues, long poll
tools.js          ten bsb_* tool definitions
http-adapter.js   Node handler adapter for the web routes
client.js         plugin page cards
extension/        MV3 manifest, popup.html and the worker entry sw.js
extension/lib/    worker infrastructure (state, cdp, page functions, discovery)
extension/commands/  command domains, with input/ split by action
extension/popup/  the popup script
extension/assets/ icons and fonts
scripts/          zip packer and the extension public key
skill/            bundled browser-bridge playbook
docs/images/      screenshots used by the README
tests/            selftest, e2e, webserver compatibility, fixtures
```

## 15. Command path

The extension polls `http://<host>:8791/p/<token>/poll`. The host keeps one queue
per browser, so two browsers never consume each other's commands, and a long poll
doubles as the liveness signal. The extension executes the command with
`chrome.debugger` in the tracked tab and posts the result back. Nothing dials into
the browser, so the pair works through NAT.

The pairing token is 32 random bytes in hex, stored at
`<dsh home>/browser-bridge/token` with mode 0600.
