# browser-bridge

A DeepSeek Harness plugin and a Chromium extension that let an agent drive the
browser you are already signed into. The agent opens a tab, reads it, and acts on
it through the DevTools Protocol. It does not start a second browser, copy
cookies, or ask you to paste a token by hand: the extension discovers the local
host plugin and pairs with it.

Ten tools cover reading, input, waiting, screenshots, pixel sampling, network and
console observation, and script evaluation. The host plugin listens on one local
port and serves the extension zip and a small dashboard on the plugin page.

## Requirements

- DeepSeek Harness with plugin rows. Both webserver route contracts used by DSH
  0.2.x are supported.
- Chrome or Edge 116 or newer. Other Chromium forks work; Firefox does not.
- The extension is loaded unpacked. There is no store listing and no `.crx`.

## Install

### 1. Add the plugin

```sh
dsh plugin --profile web add /absolute/path/to/browser-bridge
```

The row is host-only. It listens on `127.0.0.1:8791` by default and registers the
ten tools.

### 2. Install the extension

1. Open the plugin page in the DSH web UI. The Browser extension card has a
   download button. The host packs the zip from `extension/` when you click, so
   there is no build step.
2. Unzip the download. The folder must contain `manifest.json` at its top level.
3. Open `chrome://extensions` (or `edge://extensions`), turn on Developer mode,
   choose Load unpacked, and select that folder.
4. Pair. The popup scans `127.0.0.1` ports 8791-8811 and connects to the first
   host that answers. For a host on another port, paste the pairing link from the
   plugin page into the popup field and press Pair.

`bsb_browsers` then lists the browser. The label is the product token from the
user agent plus the full build, for example `Chrome/157.0.8103.38`.

## Updating

Extension changes: replace the files in the folder you loaded and press reload on
the card in `chrome://extensions`. Host changes: toggle the bundle or restart
DSH, then check `/browser-bridge/api/build`, which reports the build that is
actually running.

## Tools

| Tool | What it does |
|---|---|
| `bsb_browsers` | Lists connected browsers, the default target, and whether each one is polling. Start here when a call reports no browser. |
| `bsb_open` | Opens a URL and makes it the tracked tab. The new tab stays in the background unless `activate: true`. |
| `bsb_tabs` | Lists, adopts, reloads, or closes tabs. |
| `bsb_read` | Reads the page. `mode: "text"` returns visible text, interactive elements with `@eN` refs, and viewport data; `"rows"` returns selector matches as structured rows; `"html"` returns one element's `outerHTML`. |
| `bsb_act` | Performs one input action: click, hover, type, set, select, key, scroll, drag, drop, upload, or `drive` for canvas steering. It also has `forceActive` and `releaseActive` for pages whose frame clock has stopped. |
| `bsb_wait_for` | Waits for a selector, text, URL, enabled control, settled box, JS expression, network request, or a fixed delay. |
| `bsb_capture` | Saves screenshots, selector contact sheets, or a recording to disk and returns file paths for `read_image`. |
| `bsb_pixels` | Samples an element as a colour grid or at exact points. Reads only; useful for canvas boards and maps that a DOM query cannot address. |
| `bsb_observe` | Records the page's own network requests, console messages and exceptions, or samples an element over time. |
| `bsb_eval` | Evaluates JavaScript and returns the value. Runs in a read-only isolated world by default; `world: "main"` opts into the page's own world. |

Every page tool accepts `frame` (a frame id, URL substring, or index) and
`browser` (a browser id, id prefix, or label substring). `bsb_act` performs one
action per call. The tool schemas carry the full parameter lists.

A bundled skill, `bsb-browser`, holds the workflow playbook: tool choice, the
read/act/wait loop, canvas and WebGL pages, iframes, network debugging, and
recovery. It registers from the skill catalog when the plugin loads, so there is
no project skill file to copy.

## How a command reaches the browser

The extension polls `http://<host>:8791/p/<token>/poll`. The host keeps one queue
per browser, so two browsers never consume each other's commands, and a long poll
doubles as the liveness signal. The extension executes the command with
`chrome.debugger` in the tracked tab and posts the result back. Nothing dials into
the browser, so the pair works through NAT.

The pairing token is 32 random bytes in hex, stored at
`<dsh home>/browser-bridge/token` with mode 0600.

## Safety model

- Page neutrality. The extension has no content scripts and injects no DOM node,
  style, or class. It does not override focus, visibility, viewport, or device
  metrics. A background tab stays throttled and the tools report the frame rate
  they measure. The one exception, `forceActive`, must be requested by name and
  the reply states what was forced.
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
  non-extension Origin and withholds the token from non-loopback peers unless
  `allowRemotePairing` is true. With it on, any device on the network can pair and
  drive that browser profile.
- File uploads use paths on the machine that runs the browser.

## Configuration

The row in `cordis.patch.yml`:

```yaml
config:
  port: 8791
  bind: '0.0.0.0'
  # advertise: '192.168.1.20'
  allowRemotePairing: true
  devReload: true
```

| Key | Default | Effect |
|---|---|---|
| `port` | 8791 | Listener port. The extension probes 8791-8811 on connect. A port outside that range still works when the pairing link is pasted. |
| `bind` | `0.0.0.0` | Address to listen on. Use `127.0.0.1` for this machine only. |
| `advertise` | auto | Address written into the pairing URL. Defaults to the first private IPv4. |
| `allowRemotePairing` | false | Whether `/discover` hands the token to a non-loopback peer. |
| `devReload` | false | Registers the dev routes: fixture pages, the arcade page, the dev command channel, and extension reload support. |

Port changes made from the plugin page are stored in
`<dsh home>/browser-bridge/settings.json` and outrank the profile config. Reset
removes the override.

## Remote browser

A remote browser does not find the host on its own: the sweep only probes
`127.0.0.1`. Paste the pairing link into the popup instead. Get the link from the
plugin page, which rewrites the host to the address you used to open it, or from
`curl http://<host>:8791/discover`.

With WSL mirrored networking, open the port in both firewall layers: the Windows
inbound rule and the Hyper-V/WSL rule. If `http://<host>:8791/discover` answers in
a tab, the network path is fine and the remaining problem is in the extension.

## The plugin page

The bundle page has three cards.

- Endpoint: listener state, the bind error if there is one, the port control, and
  the pairing URL.
- Browser extension: download of the unpacked zip, and a reload button when
  `devReload` is on.
- Connected browsers: the attached browsers, with a disconnect button for each.

The desktop app runs an Electron window, where `chrome.runtime` is unavailable,
so the page cannot reach the extension. Pair from the extension popup in that
case.

## Development

```sh
node scripts/pack-extension.mjs   # write dist/browser-bridge-extension.zip without a download
node tests/selftest.mjs           # transport, routing, guards, packaging
node tests/compat-webserver.mjs   # every route under both harness webserver contracts
node tests/e2e.mjs                # every tool against tests/fixture.html (needs devReload and a browser)
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
extension/        MV3 worker, popup, discovery, identity
scripts/          zip packer and the extension public key
skill/            bundled bsb-browser playbook
tests/            selftest, e2e, webserver compatibility, fixtures
```

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| "Manifest file is missing or unreadable" | You selected a folder above the one that contains `manifest.json`. |
| "Pairing failed. Check the link and try again." | The link did not reach a bridge. Open `/discover` in a tab, check the port, and for a LAN peer check `allowRemotePairing` and the firewall. The extension service worker console shows the specific error. |
| Remote browser cannot find the bridge | Expected. The sweep only probes `127.0.0.1`; paste the pairing link. |
| `bsb_browsers` is empty | No extension is polling. Reload the extension and check its card for errors. |
| "browser is not connected" | The worker was suspended or the browser closed. It reconnects on the next alarm or when the popup opens. |
| Dev routes return 404 | `devReload` is off in the row config. |

## Compatibility

- DSH 0.2.x. Both known webserver route contracts are covered and tested.
- Chrome or Edge 116 or newer. The extension uses Manifest V3 and
  `chrome.debugger`.
- Unpacked install only. Chrome rejects off-store `.crx` files with
  `CRX_REQUIRED_PROOF_MISSING`, so the plugin does not produce one.
