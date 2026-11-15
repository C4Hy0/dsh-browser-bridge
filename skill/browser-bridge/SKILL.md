---
name: browser-bridge
description: Use when a task needs a real browser — open or adopt pages, click/type/scrape rendered content, solve CAPTCHAs, play canvas or WebGL games, take screenshots/recordings, inspect iframes, or debug a page's network/console. The bsb_* toolset's workflows, tool choices, and failure recovery.
---

# Browser Bridge (bsb) playbook

A real Chrome is already connected. If the task needs JavaScript-rendered
content, a logged-in session, canvas/WebGL, keyboard input, or a visual check,
use these tools instead of curl, a headless library, or shell screenshots.

Start with the tracked page. If the user says a page is already open, **adopt it**
(`bsb_tabs use`); never open a duplicate. A fresh profile's only tab is
`chrome://newtab/`, which bsb cannot script; `bsb_open` opens a new tab for the
http(s) URL and reports `autoNewTab` instead of failing.

## Tool selection

| Need | Tool |
| --- | --- |
| Which browser/target | `bsb_browsers` |
| Already-open page, reload, close | `bsb_tabs` (`list`/`use`/`reload`/`close`) |
| New URL | `bsb_open` (background by default; `activate:true` to show) |
| Read text / find controls / scrape rows / DOM | `bsb_read` (`text`/`rows`/`html`) |
| Click, type, key, wheel, slider, drag, upload, game input | `bsb_act` |
| Page state, canvas, geometry, authenticated fetch | `bsb_eval` |
| Wait for load/enable/network/URL | `bsb_wait_for` |
| Screenshot, burst, contact sheet, recording | `bsb_capture` |
| Numeric pixels/colours, cell positions | `bsb_pixels` |
| Network or console evidence | `bsb_observe` |

## Normal workflow

1. **Target.** `bsb_browsers` if the target is ambiguous. `bsb_tabs list`, then
   `bsb_tabs use` for an existing tab (`activate:false` adopts in the
   background). `bsb_open` only for a URL you must load.
2. **Look before touching.** `bsb_read` text gives the visible text, viewport,
   and interactive elements with `@eN` refs. Use `@eN` for clicks/typing; prefer
   it over guessing coordinates. `bsb_read rows` is the scraper: give it a
   selector and get text/link/image/state/box per match. Use `html` for one
   element; avoid regex over raw HTML.
3. **Act.** `bsb_act` does one action: `click` (`target`/`@eN`/`text`/`x,y`;
   `targets` batch; `all`), `hover`, `type` (+`submit`), `set` (sliders,
   framework-bound inputs), `select`, `key` (`holdMs`, `keys`, `text` to send
   one real key event per character, `steps` for timed sequences,
   `measure`/`settle` for canvas games), `scroll`, `wheel`, `drag` (with
   `path` for sliders/maps), `drop`, `upload`, `drive`/`measure` (canvas
   steering/state), `forceActive`/`releaseActive` (page-lifecycle override).
4. **Wait properly.** After a click that loads or animates, use `bsb_wait_for`
   (`selector`, `text`, `url`, `expression`, `network`), never `sleep`. For
   timed UIs, `firstSelector` presses then waits; `clickSelector` presses the
   moment it matches. `visible:true` makes a selector wait ignore zero-height,
   `display:none`/`visibility:hidden` and `aria-hidden` nodes.
5. **Verify.** Re-read, `bsb_eval` the state, or `bsb_capture` the region. Do not
   assume a click landed just because no error came back. `bsb_read` returns a
   `state:` line and a `hint:` for an error page, an interstitial or a splash
   skeleton.

## Navigation truth and page state

Chrome reports very different outcomes with the same success shape: a normal
document, a committed `chrome-error://` page (HTTP 429, a blocked host,
`ERR_CONNECTION_RESET`), a 200 bot-check interstitial, and a full-page splash
whose app never booted. The replies now carry that difference.

- `bsb_open` returns `requestedUrl` (what you asked for), `documentUrl` (what
  the tab really shows), `httpStatus` (from navigation timing, or read off
  Chrome's own error page), `navigationError` (the `net::ERR_*` from the
  navigation), `readyState`, `bodyTextLen`, `elementCount`, and a `hint` when
  the document is a chrome-error page, an empty shell/interstitial, or a
  full-page splash. A 429 is named in `httpStatus` with no `bsb_observe`
  network capture armed first.
- A browser-internal tracked tab (`chrome://newtab/` on a fresh profile) no
  longer blocks the first `bsb_open`: the worker opens a tab, sets
  `autoNewTab:true`, `blockedTabId` and `autoNewTabReason`, and tracks it. You
  do not need to pass `newTab:true` for that case.
- `bsb_tabs list` shows the real document URL, `scriptable` and, when known,
  `requestedUrl`, `documentUrl`, `navigationError`, `httpStatus`. A row whose
  document failed is marked `navigation failed`; a `chrome://` row is marked
  `not scriptable`.
- `bsb_tabs reload` answers `reloaded:false` with `navigationError` and
  `documentUrl` when the reload landed on a Chrome error page, instead of the
  old always-true success shape. `reloaded:true` means a document loaded.
- `bsb_tabs use {activate:true}` reports `activated`, `visibility`, `hidden`
  and, when the page stayed hidden, a `reason`. A minimized window reports
  outer `0x0` and `activated:false`; nothing raises or unminimizes the window.
- `bsb_wait_for {url:"..."}` matches the document URL, the page title, and the
  URL that was requested for the tab. On a tab with a known navigation error it
  answers `matched:false` in about a second with `navigationError`,
  `documentUrl` and a `hint` naming the error, instead of burning the timeout.
- `bsb_wait_for {selector:"...", visible:true}` only matches a node that is
  really visible: a non-zero box, not `display:none`/`visibility:hidden`, and
  no `aria-hidden` ancestor. Selector replies carry `matchedVisibility`
  (`visible`|`hidden`) and `matchedBox`, plus `ariaHidden` when that is the
  reason. A splash skeleton's zero-height nodes no longer count as content.
- `bsb_read` text returns a `state:` line before the text: `readyState`,
  `httpStatus`, `bodyTextLen`, `elementCount`, `interactiveCount`,
  `canvasCount`, `visibility`, and `hasSplash`/`splashHeight`, plus a `hint`
  when the empty text is really an error page, an interstitial or an unrendered
  splash. Empty text with a large DOM or a full-viewport splash is a render
  problem, not an empty page.

## Visual work

- `bsb_capture kind:"shot"` writes a PNG and returns the path; open it with
  `read_image`. `selector` crops one element; `rect` crops a region (fractions
  of an element, or CSS px); `scale` zooms; `preprocess` fixes mirrored, tiny,
  rotated, low-contrast, grayscale or thresholded pixels.
- A hidden, background or minimized tab still captures: shots render
  off-screen through `captureBeyondViewport` without activating the tab or
  raising the window. The reply carries `hidden` and `visibility`, so read
  those before trusting a frame as what the user sees. Only a genuinely 0×0
  layout viewport fails with `TAB_NOT_VISIBLE`.
- `frames`+`intervalMs` gives a burst; `fullPage` the scrollable page;
  `native:true` the element's image bytes.
- `kind:"sheet"` tiles every match of a selector into one labelled contact
  sheet — use it for grids of cards, thumbnails or image options instead of one
  capture per item (`offset`, `limit`, `columns`, `scale`).
- `kind:"record"`: `action:"start"`, act, `action:"stop"` returns one labelled
  contact sheet; `status`/`probe` report progress and cadence. Modes are `shots`
  (default), `screencast` and `interval`. Recording needs a visible tab; it does
  not raise one, so `bsb_tabs use` first if needed.
- `bsb_pixels` is cheaper than a screenshot when you only need numbers: a grid of
  r/g/b/luminance/bright share, or exact `points` in element-local CSS px for
  hex boards, sprite sheets and marker positions. Prefer it to writing a PNG
  decoder.
- Page tools take `frame` (frame id/prefix, URL substring, or index):
  `bsb_read`, `bsb_act`, `bsb_eval`, `bsb_wait_for`, `bsb_capture`,
  `bsb_pixels` and `bsb_observe`. List them with `bsb_eval`:
  `document.querySelectorAll('iframe')`. Open shadow roots are pierced by
  selectors; closed ones are not.

## Canvas and WebGL games

- The canvas has no DOM text. Use `bsb_eval` for game/framework state in
  `world:"main"` when available (the default `isolated` world is read-only),
  and `bsb_pixels`/`bsb_capture` for the picture.
- If the tab is hidden the frame clock pauses and the browser holds input:
  `click`, `hover`, `type`, `key`, `drag`, `drop` and `wheel` fail with
  `TAB_NOT_VISIBLE` before anything is sent, and nothing is queued or replayed.
  Wake the page with `bsb_act forceActive` and `mode:"hold"` (or pass
  `forceActive:true` for one action), then retry; `releaseActive` drops a hold.
  The reply reports the visibility the page then saw. `set`, `select` and
  `scroll` still work hidden because they do not dispatch input.
- Hold keys with `holdMs`; press combinations with `keys`; use `steps` for
  scripts with waits. Prefer physical `event.code` names (`KeyW`, `ArrowUp`,
  `Space`, `ControlLeft`).
- `bsb_act drive` steers a canvas sprite by game coordinates (closed loop,
  `route` for waypoints, `confirm` at the end); `measure` reads the sprite
  state. Calibrate coordinates from the canvas element box, not the screenshot.
- Canvas UIs often have hitboxes that do not line up with their labels. Try the
  label centre, then offset until the screen changes; instrument with a capture
  or a read-only `bsb_eval` listener if a click seems to vanish.
- Happy Wheels-style menus are canvas-only: map screenshot pixels to viewport
  CSS with the iframe/canvas box, click, and verify with a fresh capture.

## Network and console

- `bsb_observe kind:"network" action:"start"` before the action; `action:"log"`
  returns url/method/status/mime and body sizes; `detail:"full"` or `fields`
  adds headers/bodies. Stop with `action:"stop"`.
- `bsb_observe kind:"console"` for uncaught errors and `console.log` when the UI
  stops updating. `kind:"timeline"` samples an element's box (and canvas colour
  grid/fps) over time.
- For an authenticated API, `bsb_eval` a `fetch` inside the page so the page's
  cookies, Referer and CORS context apply. `curl` loses them and 403s.
- Downloads are not observable; track the request and verify the file on the
  browser machine.

## Forms, files, dialogs

- `type` targets an input and verifies the value landed; `submit:true` presses
  Enter. `set` handles sliders/checkboxes and framework-bound inputs; `select`
  chooses an option. `upload` takes local file paths; `drop` handles drag-drop
  zones. JS dialogs during a read are auto-dismissed and reported.

## Canvas and key-driven pages

- `type` writes into inputs, textareas and contenteditable elements; it refuses a
  canvas with `NOT_EDITABLE`. It also refuses a zero-size, offscreen,
  `display:none` or `visibility:hidden` target with `NOT_VISIBLE` and its box, so
  an offscreen measurer that happens to be `document.activeElement` (for example
  a Sheets `#waffle-rich-text-editor` parked at y=-9998) is not typed into: focus
  the visible editor first by clicking the cell. After typing it reads the value
  back and fails with `TYPE_NOT_APPLIED` when the write did not land. Use
  `bsb_act action:"key" text:"..."` (one real keydown per character,
  `keyDelayMs` between them) for engines that read keys; `\t` is sent as Tab and
  `\n`/`\r` as Enter (the reply counts `tabs` and `enters`), while any other
  control character fails with `BAD_ARGUMENT` instead of being silently dropped.
- `bsb_act action:"wheel"` sends a real wheel event at x/y for maps, zoom and
  panels that listen to `wheel` rather than `scroll`.
- To run code before a page's own scripts (hook WebAssembly or fetch, patch a
  loader, seed state on every load), install a document-start script with
  `bsb_eval {installOnNewDocument:true, expression:"..."}`. List it with
  `listOnNewDocument`, remove it with `removeOnNewDocument` and the returned
  `scriptId`. It runs in every new document of the tab, including reloads, until
  removed or the debugger detaches. This is page code, not the read-only world.
- A cross-origin iframe cannot be read from the tab target. `bsb_read` with
  `frame:` fails with `FRAME_NOT_READABLE` naming the frame; open that URL
  directly or read the frame element instead.

## Safety and neutrality

- Real accounts are production: navigate and read only. Never follow, like,
  comment, post, purchase, or save on the user's behalf unless explicitly asked.
- `forceActive` is opt-in and never installed by default; release it when done.
  No tool raises, focuses, resizes or moves the browser window. `bsb_open` is
  background by default; `bsb_tabs use` fronts the tab unless `activate:false`.
  Input actions refuse a hidden page with `TAB_NOT_VISIBLE` instead of queueing,
  so nothing is sent and nothing replays. `bsb_capture` still renders a hidden
  or minimized tab off-screen without raising anything and reports
  `hidden`/`visibility`; only a genuinely 0×0 layout viewport fails with
  `TAB_NOT_VISIBLE`.
- Drive pages through their own controls. Do not inject DOM/CSS or patch page
  state except inside the guarded `bsb_eval` read paths, and only when the task
  is a benchmark/demo target where that is allowed.
- Leave the tracked page and tabs as the user had them; close only tabs you
  opened for the task.

## Token discipline

- Text/rows before screenshots; a screenshot costs an image read.
- Bound reads with `maxChars`/`maxElements`, network with `limit`/`detail`/`fields`,
  and `bsb_eval saveTo` for large JSON.
- One contact sheet beats N captures; `bsb_pixels` beats screenshot + decoder;
  don't fetch every search result when one page settles the question.

## Troubleshooting

| Symptom | Do |
| --- | --- |
| "No page is tracked" | `bsb_tabs list`, then `use`; or `bsb_open` |
| `bsb_open` succeeded but the page is blank / 429 | read `documentUrl`, `httpStatus`, `navigationError`, `hint`; treat a chrome-error page as a failed navigation |
| Page hidden / input refused (`TAB_NOT_VISIBLE`) | `bsb_act forceActive` (`hold` for a session, or `forceActive:true` for one action), then retry; release after |
| `activate:true` did not make the page visible | read `reason`; a minimized window stays hidden, restore it yourself |
| Element not found | `bsb_read` text, check shadow/iframe, wait for it (`bsb_wait_for`) |
| Wait matched a hidden node | prefer `visible:true`; read `matchedVisibility`/`matchedBox` |
| Click did nothing | enable/stable wait, scroll into view, try `@eN`, check overlay/iframe |
| Typing lost / `TYPE_NOT_APPLIED` | read the value back; check the target is the visible editor, not an offscreen measurer; `submit`; check masks/framework setter |
| Canvas has no text | `bsb_eval`, `bsb_pixels`, `bsb_capture`; map canvas coordinates |
| CAPTCHA / image puzzle | capture or pixels, solve, then click cells; verify before submit |
| Network request fails | repeat it with `bsb_eval` fetch inside the page (cookies) |
| 0×0 layout viewport | restore the window; tools will not raise it. A minimized window with a normal layout viewport still captures and reports `hidden` |

## Reference

- Tool definitions and parameter rules: the installed browser-bridge package's
  `README.md`.
- Live source in that package: `tools.js` (schemas/renderers) and
  `extension/sw.js` (worker commands).
- Version matters: `bsb_browsers` reports the extension version and connection;
  `/browser-bridge/api/build` reports the host, tools and extension builds.
  Re-check after a plugin toggle.
