# browser-bridge

**Browser Bridge**

Drive the Chrome you are already logged into, from DeepSeek Harness. A host
plugin exposes thirteen tools; a small Chromium extension pairs with it and executes
them over the DevTools Protocol in a tab the agent opens.

No separate browser profile, no second browser window to babysit, no token to
copy: the extension discovers a running plugin and connects.

## Install

Two pieces: the host plugin (this bundle) and a browser extension that lives in
the browser you want the agent to drive.

### 1. Plugin (usually already done)

```sh
dsh plugin --profile web add /absolute/path/to/browser-bridge
```

The row is host-only. It listens on `8791` and registers the tools; nothing else
to configure for a single-machine setup.

### 2. Extension, in the browser that should be driven

**a. Download the zip.** Use the **Download .zip (unpacked)** button on this
bundle’s page in the Web UI, or take `dist/browser-bridge-extension.zip`.
(A `.crx` is built too, but Chrome refuses off-Store CRX installs with
`CRX_REQUIRED_PROOF_MISSING` — ignore it and use the unpacked build.)

**b. Unzip it.** Right-click → Extract All on Windows. You must end up with a
folder whose **top level contains `manifest.json`**:

```
browser-bridge-extension/
  manifest.json
  sw.js
  popup.html
  popup.js
  discovery.js
  identity.js
```

If unzipping produced `browser-bridge-extension/browser-bridge-extension/`, go
one level down. Selecting the wrong level is the usual "Manifest file is missing
or unreadable" error.

**c. Load it.** Open `chrome://extensions` (or `edge://extensions`):

1. Turn on **Developer mode** (top-right).
2. Click **Load unpacked**.
3. Select the folder that directly contains `manifest.json`.
4. The card appears with the name **browser-bridge**; make sure its toggle is on.

**d. Connect.** Click the extension icon. The popup finds the plugin and shows
`Found dsh at http://…:8791. Paired.` Nothing to paste — discovery supplies the
credential. If the server is on another machine, type its host in **Add** first
(e.g. `192.168.1.20`) and press Add.

**e. Verify.** In the Web UI, open Plugins → Web bridge, or run this from a
session: the `bsb_browsers` tool should list one entry labelled like
`Chrome on Windows 11` and marked live.

## Updating the extension

Replace the files in the folder you loaded (or download and unzip a fresh copy
over it), then press the **reload** arrow on the extension card in
`chrome://extensions`. Content scripts aside, there is no restart step for the
browser; the worker starts polling immediately.

## Remote browser (LAN)

The plugin advertises its first private IPv4 when `bind` is `0.0.0.0` (default),
and `allowRemotePairing: true` hands the token to LAN peers on `/discover`.

**A remote browser never finds the bridge by itself.** The popup's pairing field
is manual, and the worker's background sweep only probes `127.0.0.1` — this
machine. So on the remote browser: paste the pairing link, press **Pair**.

Get the link from either place:

- the **Pairing link** button on the DSH plugin page opened at `http://<host>:3080` — it
  rewrites the host to whatever you used to reach it, so it is always dialable;
- or `curl http://<host>:8791/discover` and take `pairingUrl`.

Two firewall layers matter when the plugin runs in WSL with mirrored networking:
the normal Windows inbound rule **and** the Hyper-V/WSL rule for the bridge port.
The browser must be able to open `http://<host>:8791/discover` in a tab. If that
page shows JSON, the network path is fine and any remaining problem is in the
extension; if it times out, fix binding or firewall first.

The release loop deploys the packed extension to a stable local directory
outside this repository; remote machines can use a shared directory instead.

## The browser label

Each browser labels itself with the token it puts in its own user agent plus the
full build number:

```
Chrome/157.0.8103.38      Edg/156.0.4314.58      OPR/121.0.0.0
```

The token is read from the UA (`Edg`, `OPR`, `SamsungBrowser`… are checked before
`Chrome`, because every Chromium descendant also contains `Chrome/`), and the
version comes from User-Agent Client Hints, which is the only place the full
build is stated — the UA carries the reduced `157.0.0.0` form.

Nothing here names a vendor or a platform. An earlier build printed a friendly
"Chrome on Windows 11", which was a guess: Chromium forks report `Google Chrome`
in their brand list whatever they are, so an Edge browser was announced as
Chrome. The token cannot be wrong in that way — Edge says `Edg`, and it says so
in its own string.

The label is a hint for humans picking a target, not an identity: two browsers
built alike produce the same string, so tools disambiguate by appending the id.
The popup no longer shows it at all — it opens on the action, and the raw user
agent sits as a `title` on the Browser ID row for whoever wants the whole story.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `CRX_REQUIRED_PROOF_MISSING` | You installed the `.crx`. Chrome only accepts Web Store or policy installs; use the unpacked zip. |
| “Manifest file is missing or unreadable” | You selected the folder above the one containing `manifest.json`. |
| Popup: “Pairing failed. Check the link and try again.” | The link did not reach a bridge. Check the port (`/discover` in a tab), that `allowRemotePairing` is true for a LAN peer, and that the firewall allows the port. The specific cause is in the console (`chrome://extensions` → the extension → **service worker**). |
| Remote browser cannot find the bridge | Expected: the sweep only probes `127.0.0.1`. Paste the pairing link instead. |
| `bsb_browsers` is empty | No extension is polling: reload it, or check its card for errors. |
| Tools say “browser is not connected” | The worker was suspended or the browser was closed; it reconnects on the next alarm or when the popup opens. |

## Tools

| Tool | Does |
| --- | --- |
| `bsb_browsers` | list connected browsers, which is the default target |
| `bsb_tabs` | list, adopt or close tabs |
| `bsb_open` | open a URL; becomes the tracked page. The new tab opens in the background by default; `activate:true` brings it forward (the only tab-activation the open path performs) |
| `bsb_read` | one read tool, three `mode`s: `"text"` (default) returns URL, title, visible text (incl. a shadow-root digest), the interactive elements with `@eN` refs and viewport boxes, viewport/DPR and auto-dismissed dialogs; `"rows"` turns every match of a selector into structured rows (text, link, image source, form state, id/name/class, box) — the scraping primitive; `"html"` returns the `outerHTML` of one element (or the body), capped by `maxChars` |
| `bsb_act` | ONE input action, chosen by `action`: `click` (target/`@eN`, text, x/y, `count` taps, `targets` batch, `all`), `hover`, `type` (+`submit`), `set` (+`checked` for checkbox/radio/slider), `select` (value/label/index), `key` (`count`, `modifiers`, `holdMs`/`keys` for held-key games, `steps` gesture scripts with `until`/`untilMeasure`/`click` phases, `measure` for screen/canvas feedback after the gesture), `forceActive` (opt-in wake of a paused page: `mode` `"call"` or `"hold"`, the reply says what was forced and the `visibility` the page then reported), `releaseActive` (drops a held override), `drive` (closed-loop steering: x/y are GAME units on the biggest canvas — the extension reads the sprite every tick and holds the arrow keys itself until it arrives, braking as it nears; `tol`, `maxSpeed`, `timeoutMs`, a `route` of waypoints driven in ONE call (braked between legs and after the last), optional `untilMeasure` and a `confirm` selector pressed once the sprite has arrived and stopped), `scroll`, `drag` (target→`toTarget` or x/y→`toX`/`toY`), `drop` (files/text) and `upload` (file inputs). `frame` works inside an iframe for every action |
| `bsb_eval` | evaluate an expression in the page and return JSON. Default world is the guarded isolated world: it sees the DOM but throws on every DOM/CSS/form write, and the page's own JS globals are not exposed. `world:"main"` opts into the page's own world (framework instances such as Vue `__vue__`, page closures, and writes) |
| `bsb_wait_for` | wait for a selector/text/URL, an enabled control, settled geometry, a JS expression, a matching network request, or a plain `ms` delay; with `firstSelector`/`firstText` it presses first, then clicks the moment it matches (`clickSelector`/`clickText`) |
| `bsb_observe` | observe over time without injecting: `kind:"network"` records the page's own fetch/XHR (`action` start/log/stop, optional URL `filter`; entries include method, URL, status, bodies and bounded headers); `kind:"console"` records console messages and uncaught exceptions (start/log/clear); `kind:"timeline"` samples an element for `durationMs` at `intervalMs` — box per tick plus, for a `<canvas>`, a coarse colour grid and the animation `fps` (a sprite tracker, an animation watch, or a frame-rate check) |
| `bsb_capture` | screenshot and recording in ONE tool: `kind:"shot"` (default) saves one PNG — `frames` 2-24 + `intervalMs` for a burst — from the viewport, the full page or a `selector` (`native` for img/canvas bytes); `kind:"record"` captures across tool calls (`action:"start"` arms, you act, `action:"stop"` writes one labelled contact sheet; `status`/`probe` report progress and frame cadence). A shot may also carry `preprocess` (`flipH`, `flipV`, `rotate`, `scale`, `gray`, `invert`, `contrast`, `threshold`) so mirrored, tiny, rotated or low-contrast pixels become readable without leaving the tool. Every capture is written to `saveDir` (default `/tmp/bsb-shots`) and the reply lists the file paths to open with `read_image`; nothing is returned as an inline attachment; `kind:"sheet"` tiles every match of `selector` into one labelled contact sheet (`offset`, `limit`, `columns`, `scale`) and `native:true` saves an element's image bytes instead of a rendered screenshot; recording installs no viewport emulation |
| `bsb_pixels` | sample an element as colours: a uniform `grid` (r, g, b, luminance, bright share per cell) or exact `points` in element-local CSS px (up to 4096, optional `radius` average) for layouts a rectangular grid cannot address — an isometric board, a hex map, marker positions; reads only |


`frame` accepts a frame id/prefix, a URL substring, or an index. Iframes are rare; list them with `bsb_eval` (`document.querySelectorAll('iframe')`) rather than carrying a dedicated discovery tool.

### Workflow skill

`skill/bsb-browser/SKILL.md` ships inside the plugin and `index.js` registers it
with `ctx.skills.register`, so installing or enabling browser-bridge puts
`bsb-browser` in the skill catalog -- no standalone project skill file to copy.
It carries the full bsb playbook: tool selection, the read/act/wait loop, canvas
and WebGL games, iframes, network/console debugging, safety rules and failure
recovery. The tool descriptions stay trigger-first; load the skill when starting
a browser task. Registration is skipped only when the host has no `skills`
service.

The skill and the tool schemas are co-developed: changing a tool name, action,
mode or primary enum means updating the routing table/playbook in the same
change. `tests/skill-align.mjs` (run by `tests/selftest.mjs`) fails when a tool
is missing from the skill, a removed tool survives, or a primary enum is not
documented.

### Window and viewport safety

The plugin never raises, focuses, resizes, restores down or moves the browser
window, and never activates a tab unless you explicitly ask (`bsb_tabs use`, or
`bsb_open activate:true`). A hidden tab is captured with `captureBeyondViewport`
instead of being brought forward, and recording installs no device-metrics
override, so the page keeps the exact viewport, device pixel ratio and layout
the user sees. `forceActive` is the opt-in page-visibility override — it keeps
the page's frame clock alive without touching the window. A minimized window
that still reports a 0×0 viewport cannot be laid out by any page override; the
plugin refuses with `TAB_NOT_VISIBLE` and leaves restoring it to the user rather
than taking over the desktop. Recording is the one operation that needs a pane
that is actually showing; bring the tab forward with `bsb_tabs use` — the
recorder will not raise it. Screenshots that must scroll an off-screen element
into view put the scroll position back afterwards.

### Page neutrality

The plugin never changes what the page believes about itself. No content
script, no injected DOM node, style or class, and no focus, lifecycle or
viewport override is installed on attach: the extension has no
`content_scripts` and never evaluates in the page's main world. A tab keeps
the focus, visibility and lifecycle state the browser gives it, so a
background tab is throttled exactly as a person would see, and the tools report
that measured frame rate rather than overriding it. The one exception is an
explicit `forceActive` call, which a caller must ask for by name and which the
reply reports; it changes what the page believes, never the window. Page state
otherwise changes only through the site's own controls driven by the input tools.

The single exception is opt-in, named and reported. `bsb_act`
`action:"forceActive"` wakes a page whose frame clock has stopped (a sleeping
display leaves the tab reporting `hidden`, which silently queues input).
`mode:"call"` applies it to that one action; `mode:"hold"` keeps it until
`releaseActive`. It is never installed on attach, the reply says what was
forced and what visibility the page then reported, a held override is re-read
from the page before a later call claims it is still in force, and the hold is
mirrored into session storage so a service-worker restart re-applies it when the
tab is next attached.

### Read-only inspection

Inspection can look but not touch. `bsb_eval` and the `expression` option
of `bsb_wait_for` run model-supplied JavaScript in a guarded isolated
world where any write to a node connected to the document throws
(`READ_ONLY: …`): no `appendChild`, no `innerHTML`/`textContent`/`value`/
`checked` setters, no `style`/`classList`/`dataset` changes, no
`setAttribute`, no CSSOM, no `document.write`. A detached subtree stays
writable, so analysis that builds its own canvas still works. The page's own
scripts (main world) are untouched by default: `world: "main"` is an explicit
opt-in for reading framework state the isolated world cannot see, and it does
expose page writes, so treat it as a deliberate escape hatch. Without it the
only way to change page state is through the site's own controls via the input
tools (`click`, `type`, `key`, `scroll`, `drag`, `set`, `select`). That is the full host/extension contract.

Every page tool takes an optional `browser` (id, id-prefix, or label substring)
so several browsers can be driven side by side. Without it, the browser that most
recently received work is used.

## How it works

```
agent tool call → host plugin ──queue per browser──▶ extension (long poll)
                        ▲                                   │
                        └────── result {id, browser} ◀──────┘
```

- The extension polls `http://<host>:8791/p/<token>/poll?id=…`, so no inbound
  connection to the browser is needed and it works through NAT.
- Commands are addressed per browser; two browsers never consume each other’s
  work. A long poll is itself the liveness signal.
- Elements are addressed by the CSS path `bsb_read` returns; refs are rebuilt on
  every read and expire on navigation.

## Configuration

```yaml
config:
  port: 8791            # 8791–8801 is what the extension probes
  bind: '0.0.0.0'       # 127.0.0.1 for this machine only
  # advertise: '192.168.1.20'   # override the auto-detected LAN address
  allowRemotePairing: true      # hand the token to LAN peers on /discover
```

`allowRemotePairing: true` means any device on the network can pair and drive the
paired browser profile. Set it to `false` on untrusted networks; the browser then
reports “needs remote pairing enabled” and cannot pair until you paste a link.

## Security

- Loopback bind unless you opt into LAN; token auth on every command route.
- `/discover` withholds the token from non-loopback peers by default and refuses
  a non-extension `Origin`.
- The extension only reaches pages the agent opened; it never borrows your tabs.
- No file upload or download crosses the browser boundary.
- Page content is untrusted: the agent reads it as data, never as instructions.

## Layout

```
index.js          host: endpoint, tools, extension download route
bridge.js         transport: token, per-browser queues, long poll
http-adapter.js   adapts Fetch-style resources to Node handlers (version-proof routes)
tools.js          thirteen tool definitions
client.js         Web UI: install button on the bundle page
extension/        MV3 worker, popup dashboard, discovery, identity
dist/*.zip        packed extension (generated by scripts/pack-extension.mjs; not committed)
tests/selftest.mjs   transport test with simulated browsers
tests/compat-webserver.mjs  every route under both harness webserver contracts
tests/e2e.mjs        drives a real browser through every tool on tests/fixture.html
```

## Benchmark: World's Hardest CAPTCHA

The site is the reference workload: canvas-backed puzzles, hidden answers, drag/slider
input, network state and short-lived tokens. Driven through the tools above plus the public
`/api/next` + `/api/solve` contract, the plugin reached **milestone 22 (73.3 %)** in one run
started from the stage-1 gate, with a single life lost along the way:

| Stage | What the tools did |
| --- | --- |
| tiles | `bsb_read` labels + `bsb_act` on chair tiles; the 4x4 keyword variant ("fruit") needed the botanical set |
| words | `bsb_capture {selector:"img", native:true}` to read glyphs; the server ships the answer as alphabet-image UUIDs, so each UUID was rendered through a contact sheet and the exact misspelling typed |
| simonsays | `bsb_observe` captured the seed, the pattern PRNG (xfnv1a + sfc32) was replayed in node, then `bsb_act` on the same buttons |
| slide | flood fill found the hole; `x` variant: `bsb_act` on the bound `input[type=range]`; `xy` variant: white-square scan + edge-continuity gave the hole centre (0.915, 0.819) |
| geraldo | template match of the target against each grid cell, `bsb_act` on the best cell — hard variant scored 8x10 cells (MSE 260 vs 1886 for the runner-up) |
| rotate | easy: rotation arrows; hard: minimal-bounding-box sweep gave 328° |
| reaction | armed a MutationObserver for the easy variant; medium was solved headlessly by seeding the same PRNG and submitting at `delay + 120 ms` |
| cubes / audio / button / math | clicks inside a range, typed answers, a 57-click counter and the glyph sheet for equations |
| geo | country from the lat/lng pair shipped in the stage data |
| chess | decoded the column-major board from the bundle, ran a mate search in node, then submitted the board string (lowercase = white) to `/api/solve` because the client rendered an empty board |
| text/foreign | glyph sheet resolved `façade` (including `ç`), typed the exact string |
| tiles (knowledge) | nine planet crops contact-sheeted and read visually; "third largest planet" → Uranus → tile `1-2` |
| tiles (abstract) | riddle "vast, yet never land": the two ocean tiles were submitted (`1-2`, `2-0`) and rejected, ending the run with lives 0 — the expected set appears to include the sky image as well |

The run ended at the abstract-riddle tile variant, which is a semantic guess rather than a
tooling limit: every stage whose answer could be observed, computed or read from the network
was cleared. The two generic additions this run produced were `bsb_act` for
framework-bound controls and `bsb_capture` auto-scrolling a selector into view before
cropping it.


## The plugin page

The bundle page carries three cards.

**Endpoint** answers the two questions that used to need a log file and a text
editor. It shows whether the listener is actually up — a green dot and the port,
or a red one with the bind error and the usual cause (another dsh instance, or
WSL and Windows sharing a port namespace) — and it lets you move the port
without touching `cordis.patch.yml`. Applying rebinds in place: the new listener
binds before the old one is disposed, in-flight commands drain first, and the
choice is stored in `<dsh home>/browser-bridge/settings.json` where it outranks
the profile config. `Reset` drops the override. A move outside `8791–8811`
leaves the extension unable to auto-discover, so the card also shows the pairing
URL to paste into the popup.

**Browser extension** downloads the unpacked build and pairs this browser when
the page is in Chrome.

**Connected browsers** lists what is attached and lets you detach one.

The desktop app is the exception worth knowing: its window is Electron, so
`chrome.runtime` does not exist there and the page's Connect button cannot reach
the extension. Pair from the **extension popup** instead — it carries one field:
paste the pairing link **Pairing link** copies, press **Pair**. That works for
any port, including ones the extension never sweeps.

Type is two bundled faces and nothing else: **Outfit** for interface prose and
**Azeret Mono** for the serial and `host:port`, both latin subsets, both
`font-display: swap`.

The popup reports outcomes with the button, not with prose: a failed pairing
turns it red and shakes it once (staying red until the field changes), a
successful one flashes green, and pressing Pair with an empty field just focuses
it. There is no message line at all — the flash is the message.

The status light is 6 px, the weight of the word beside it: green with a static
glow when connected, amber when reconnecting, grey otherwise. Its rings play as
an event — when the popup opens and after a pairing succeeds — rather than
looping forever, and the state re-reads every five seconds so it never shows a
stale one.

## Development

```sh
node scripts/pack-extension.mjs   # rebuild dist/*.zip
node tests/selftest.mjs           # transport + multi-browser routing
node tests/compat-webserver.mjs   # routes on both harness webserver contracts
node tests/e2e.mjs                # every tool against tests/fixture.html (needs devReload + a connected browser)
```

### Harness version compatibility

The plugin registers **every web route as a Node `handler`**, never as a bare `{ resource }`.
That matters across harness releases: `dsh-host-webserver` accepted either shape up to 0.2.2-alpha.2
(dispatching on `'resource' in responder`), while 0.2.1-rc.5 dispatches `route.handler(req, res)`
unconditionally. A resource-only route registers on the older server and then throws on first use,
which the server answers as an **empty-bodied 400** — identical to "route missing" in a browser panel.
`http-adapter.js` converts the ergonomic Fetch-style resources into handlers, so the same build runs on
both. `tests/compat-webserver.mjs` proves it by serving the plugin's own route table under a
handler-only dispatcher and under an alpha.2-style dual dispatcher.

With `devReload: true` the host also serves `/browser-bridge/dev/command?method=…&params=<json>`,
`/browser-bridge/dev/fixture`, and `/browser-bridge/dev/arcade`; all three disappear when the flag is
off, and they never expose the pairing token. The arcade is a four-card interaction benchmark
(sustained press, slider drag with feedback, visual odd-one-out, reading a canvas) that a model
can attempt using only the tools above.
