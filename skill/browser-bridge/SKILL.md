---
name: browser-bridge
description: Use when a task needs a real browser — open or adopt pages, click/type/scrape rendered content, solve CAPTCHAs, play canvas or WebGL games, take screenshots/recordings, inspect iframes, or debug a page's network/console. The bsb_* toolset's workflows, tool choices, and failure recovery.
---

# Browser Bridge (bsb) playbook

A real Chrome is already connected. If the task needs JavaScript-rendered
content, a logged-in session, canvas/WebGL, keyboard input, or a visual check,
use these tools instead of curl, a headless library, or shell screenshots.

Start with the tracked page. If the user says a page is already open, **adopt it**
(`bsb_tabs use`); never open a duplicate.

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
   moment it matches.
5. **Verify.** Re-read, `bsb_eval` the state, or `bsb_capture` the region. Do not
   assume a click landed just because no error came back.

## Visual work

- `bsb_capture kind:"shot"` writes a PNG and returns the path; open it with
  `read_image`. `selector` crops one element; `rect` crops a region (fractions
  of an element, or CSS px); `scale` zooms; `preprocess` fixes mirrored, tiny,
  rotated, low-contrast, grayscale or thresholded pixels.
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
- If the tab is hidden the frame clock pauses: `bsb_act forceActive` with
  `mode:"hold"` makes the page believe it is visible (no window raise), and
  `releaseActive` drops it. The reply reports the visibility the page then saw.
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
  canvas with `NOT_EDITABLE`. Use `bsb_act action:"key" text:"..."` (one real
  keydown per character, `keyDelayMs` between them) for engines that read keys.
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
  A minimized 0×0 window is reported as `TAB_NOT_VISIBLE`; restore it yourself
  rather than expecting the tool to do it.
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
| Page hidden / input queued | `bsb_act forceActive` (`hold` for a session); release after |
| Element not found | `bsb_read` text, check shadow/iframe, wait for it (`bsb_wait_for`) |
| Click did nothing | enable/stable wait, scroll into view, try `@eN`, check overlay/iframe |
| Typing lost | read the value back; `submit`; check masks/framework setter |
| Canvas has no text | `bsb_eval`, `bsb_pixels`, `bsb_capture`; map canvas coordinates |
| CAPTCHA / image puzzle | capture or pixels, solve, then click cells; verify before submit |
| Network request fails | repeat it with `bsb_eval` fetch inside the page (cookies) |
| 0×0 viewport / minimized | restore the window; tools will not raise it |

## Reference

- Tool definitions and parameter rules: the installed browser-bridge package's
  `README.md`.
- Live source in that package: `tools.js` (schemas/renderers) and
  `extension/sw.js` (worker commands).
- Version matters: `bsb_browsers` reports the extension version and connection;
  `/browser-bridge/api/build` reports the host, tools and extension builds.
  Re-check after a plugin toggle.
