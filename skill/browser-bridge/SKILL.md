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
| Read text / find controls / scrape rows / DOM | `bsb_read` (`text`/`rows`/`html`/`feed`) |
| Collect a virtualized feed once | `bsb_read` (`feed`, `scroll:true`) |
| Click, type, paste, key, wheel, slider, drag, upload, game input | `bsb_act` |
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
   `targets` batch; `all`; `verify:true` for a page fingerprint before and
   after), `hover`, `type` (+`submit`), `set` (sliders, framework-bound
   inputs), `select`, `key` (`holdMs`, `keys` as a real chord, `text` to send
   one real key event per character, `steps` for timed sequences,
   `measure`/`settle` for canvas games), `scroll`, `wheel`, `drag` (with
   `path` for sliders/maps), `drop`, `upload` (a file input, or `x,y` over
   the control that opens the chooser), `paste` (clipboard-backed, see Forms),
   `drive`/`measure` (canvas steering/state), `forceActive`/`releaseActive`
   (page-lifecycle override).
4. **Wait properly.** After a click that loads or animates, use `bsb_wait_for`
   (`selector`, `text`, `url`, `expression`, `network`), never `sleep`. For
   timed UIs, `firstSelector` presses then waits; `clickSelector` presses the
   moment it matches. `visible:true` makes a selector wait ignore zero-height,
   `display:none`/`visibility:hidden` and `aria-hidden` nodes.
5. **Verify.** Re-read, `bsb_eval` the state, or `bsb_capture` the region. Do not
   assume a click landed just because no error came back. `bsb_read` returns a
   `state:` line and a `hint:` for an error page, an interstitial or a splash
   skeleton. For a menu, grid or canvas control, pass `verify:true` to the click:
   the reply then carries `pageChanged` and, when nothing moved, a `hint` that
   the press may not have landed. When `click {text:"..."}` finds no hittable
   node it fails `TEXT_NOT_CLICKABLE` with a `reason` and up to five
   `candidates:[{selector, tag, box, visible, pointerEvents, ariaHidden}]`, which
   is how a string returned by `bsb_read` but painted by a zero-size,
   `pointer-events:none` or `aria-hidden` node stays clickable: press a candidate
   box with `click x,y` or the nearest clickable ancestor.

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
- The navigation error is per-tab and is the **last** navigation, not a
  history: a later successful navigation in the same tab replaces it. So a
  `hint: navigation failed ...` line is only printed while the current document
  really is a failed one (`chrome-error:`, a 4xx/5xx document). If the reply
  shows `state: complete`, `HTTP 200` and a real body, there is no stale failed
  navigation behind it; do not re-open the URL because of an old error.
- No content verdict is asserted before `readyState` is `complete`: while a
  document is `loading` or `interactive` the hint says
  `document still loading ... no content verdict yet` instead of calling 0
  chars and 0 elements an interstitial. At `complete`, the WAF/empty-shell hint
  (for example 14 chars, 15 elements, HTTP 200) still fires. Read again when the
  state line says `complete`.

## Eval targeting

- `bsb_eval` replies echo `tabId`, `url`, `world` (`isolated`|`main`) and
  `visibility`, so a reply says which tab and world answered. Keep them when
  several tabs are open: a value without a target cannot be trusted.
- An expression that returns `undefined` reports `result: null` with
  `undefined: true`, never a bare `{}`. `{}` means the expression really
  produced an empty object.
- An explicit `tabId` must be an open, scriptable tab. A missing or
  `chrome://` target fails with `TAB_NOT_EVALUABLE` naming the tab; a hidden
  tab whose page cannot be evaluated fails with `TAB_NOT_VISIBLE`. Both name
  the recovery: `bsb_tabs {action:"use", tabId:<id>}` to re-attach or bring it
  forward, or `forceActive:true` (or `bsb_act forceActive mode:"hold"`) when
  the page only needs a live frame clock.
- `frame` plus `world:"main"` is refused with `UNSUPPORTED`: the main world is
  only addressable for the top frame. Use the default read-only isolated world
  for a frame, or `bsb_open` the frame URL directly.
- The default isolated world is guarded before the expression runs; if the
  read-only guard cannot be installed, the call fails instead of evaluating
  unguarded.

## Feeds and redirect resolution

- `bsb_read {mode:"feed", selector:"[role=article]", maxItems:20, scroll:true,
  dedupeBy:"auto", until:"...", forceActive:true}` collects a virtualized list
  in one call. Each item carries a stable `key` (the href when there is one,
  otherwise the normalized text, cut at 240 characters), `keySource`, `text`,
  `href`, `visible` and `box`. With `scroll:true` it drives the page's own
  scroller (the window, or the nearest scrollable element at or above the first
  match) by 0.8 of a viewport, waits 500-700 ms, and re-reads. Items are
  deduplicated across steps and re-renders; collection stops at `maxItems`
  (default 20, max 200), on a truthy `until` expression, after 3 consecutive
  steps with no new items, or at the end of the scroller. `dedupeBy:"href"` or
  `"text"` forces that key preference and falls back to the other.
- The feed reply carries `items`, `count` (the items actually returned),
  `scrolls`, `duplicatesDropped`, `recycled` (distinct collected keys that later
  vanished from the DOM), `reason` (`max-items`, `until`, `no-growth`,
  `end-of-scroll`), `matched` (elements matched on the final read), `unkeyed`
  (matches with neither href nor visible text, so not items), and
  `visibility`/`hidden`. `items: 0` with `unkeyed` above zero is placeholders or
  a shell, not an empty feed; the reply adds a `hint` for that and for a hidden
  tab. A non-scrolling read reports `reason:"no-growth"` after its single pass.
- On a hidden tab feed mode forces nothing: it reads what the hidden page
  renders and reports `hidden:true`. Pass `forceActive:true` to hold the page
  lifecycle for the collection; the hold is released before the reply returns
  (an existing hold is left alone) and `forced` reports `applied`, `reused`,
  `released` and `cleared`.
- `bsb_read {mode:"rows", href:true, resolve:true}` decodes a known redirector
  href without navigating: `google.<tld>/url?q=` or `?url=`,
  `google.<tld>/goto?url=<base64>` (standard or URL-safe, padded or not) and
  `l.facebook.com/l.php?u=`. A decoded row gains `resolved:true`,
  `hrefResolved` and `resolvableBy:"decoded"`; a known redirector that cannot be
  decoded without following it (t.co, an opaque or non-URL payload) gains
  `resolved:false` and `resolvableBy:"navigation"` with no invented URL. `href`
  is unchanged. A row without those fields was not a known redirector, so its
  `href` is already the target. Resolution is pure string decoding: no
  navigation, no network request, no DOM change. `resolve` implies `href:true`.

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
  chooses an option; `drop` handles drag-drop zones. JS dialogs during a read
  are auto-dismissed and reported.
- `upload` takes local file paths. Pass `target` when the file input itself is
  in the top document, or `frame` plus `target` when it is in a frame the tab
  can read. When the input sits in a cross-origin frame the tab cannot read,
  pass `x,y` over the control that opens the chooser (or a top-document
  `target` that opens it) and no `frame`: the worker arms
  `Page.setInterceptFileChooserDialog`, presses for real, and attaches the
  files with the `backendNodeId` reported by `Page.fileChooserOpened`. The
  reply says `via:"fileChooser"`. This route dispatches a real press, so it
  needs a visible tab (`forceActive:true` when hidden). The `frame`+`target`
  path still works when the frame document is reachable, and its error tells
  you to switch to `x,y` or a top-document trigger when it is not.
- `paste` inserts text into the focused element in one call. By default it
  writes the text to the OS clipboard (the extension holds `clipboardWrite`)
  and sends a real Ctrl+V/Command+V whose key event carries Blink's `paste`
  edit command, so Sheets explodes a TSV into cells and Docs takes a long
  block in one shot. That replaces the clipboard contents. If the clipboard is
  unavailable (older Chrome, no permission) it falls back to one CDP
  `Input.insertText` run and reports `mode:"insertText"` with a note: that is
  not a native paste, does not fire the page's paste handler, and does not
  explode TSV. The reply carries `chars`, `truncated` (above 100000
  characters), `mode` and `applied`. Click the field or cell first (or pass
  `target`); to paste inside a frame, click the editor there first, the paste
  goes to whatever is focused. `key` text mode stops at 1000 keys; paste does
  not.

## Canvas and key-driven pages

- `type` writes into inputs, textareas and contenteditable elements; it refuses a
  canvas with `NOT_EDITABLE`. It also refuses a zero-size, offscreen,
  `display:none` or `visibility:hidden` target with `NOT_VISIBLE` and its box, so
  an offscreen measurer that happens to be `document.activeElement` (for example
  a Sheets `#waffle-rich-text-editor` parked at y=-9998) is not typed into: focus
  the visible editor first by clicking the cell. After focusing the target it
  checks that `document.activeElement` really is that element or a descendant and
  otherwise fails with `NOT_FOCUSED`, naming the element that holds focus (tag,
  id, role, aria-label) and the target, so a name box that hands focus back to
  the grid is visible immediately. After typing it reads the value back, fails
  with `TYPE_NOT_APPLIED` when the write did not land, and the reply carries
  `activeElement` and `valueAfter` (plus `activeElementAfter` with `submit:true`)
  so the caller can see where the next keystroke will go.
- Use `bsb_act action:"key" text:"..."` (one real keydown per character,
  `keyDelayMs` between them) for engines that read keys; `\t` is sent as Tab and
  `\n`/`\r` as Enter (the reply counts `tabs` and `enters`), while any other
  control character fails with `BAD_ARGUMENT` instead of being silently dropped.
  A text run sends at most 5000 characters and reports `requestedKeys`,
  `sentKeys`, `truncated` and `droppedKeys`, so a cut run is never mistaken for a
  complete one. When the focused element is an input, textarea, contenteditable
  or `role=textbox` editor, the run is verified against the visible document
  text: a reply carries `textLenBefore`/`textLenAfter`, a run whose typed prefix
  is absent fails `TEXT_NOT_APPLIED`, and a run that leaves the document shorter
  fails `EDITOR_LOST_TEXT` even when the prefix is present (a replaced selection
  is not reported as success). A canvas game whose active element is body, and a
  hidden or offscreen key shim, are never subject to that check.
- `keys:[...]` is a real chord: a modifier name in the list (`ControlLeft`,
  `AltLeft`, `ShiftLeft`, `MetaLeft`, or the bare `Control`, `Alt`, `Shift`,
  `Meta`) is held while the other keys fire, and the reply's `modifiers` reports
  the mask that was applied. `modifiers:["Control","Alt"]` with a single `key`
  still works and produces the same mask, so either spelling delivers
  Ctrl+Alt+1.
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
- `paste` replaces the OS clipboard with the text you pass; do not leave secrets
  on the user's clipboard without saying so. `upload` with `x,y` presses for
  real, so it needs a visible tab like every other input action.
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
| `bsb_read` hint says `navigation failed` but the state line is a healthy page | the cached error is stale; the hint is only for a failed current document, so trust `state` and do not retry the URL |
| `bsb_read` hint says `document still loading` | no verdict yet; wait for `readyState: complete` (`bsb_wait_for` or read again) before judging the page |
| `bsb_eval` on another tab returns no value / a typed target error | read `tabId`, `url`, `world`, `visibility` in the reply (or `TAB_NOT_EVALUABLE`/`TAB_NOT_VISIBLE`); `bsb_tabs use` the tab, or pass `forceActive:true` for a paused page, then retry |
| `bsb_eval` keeps returning `{}` after an update | `undefined` is reported as `undefined:true`; a bare `{}` means an old extension worker answered, update the extension or re-eval with an explicit `tabId` |
| Page hidden / input refused (`TAB_NOT_VISIBLE`) | `bsb_act forceActive` (`hold` for a session, or `forceActive:true` for one action), then retry; release after |
| `activate:true` did not make the page visible | read `reason`; a minimized window stays hidden, restore it yourself |
| Element not found | `bsb_read` text, check shadow/iframe, wait for it (`bsb_wait_for`) |
| Wait matched a hidden node | prefer `visible:true`; read `matchedVisibility`/`matchedBox` |
| Click did nothing | enable/stable wait, scroll into view, try `@eN`, check overlay/iframe; retry with `verify:true` and read `pageChanged`/`hint` |
| Click by text says the text is absent | read `reason` and `candidates`: a zero-size, `pointer-events:none` or `aria-hidden` node holds the text. Press a candidate box or its nearest clickable ancestor |
| Typing lost / `TYPE_NOT_APPLIED` | read the value back; check the target is the visible editor, not an offscreen measurer; `submit`; check masks/framework setter |
| `NOT_FOCUSED` on type | read `activeElement`: the page moved focus elsewhere (a name box handing focus to the grid, an overlay, a disabled field). Click the target again and check it is not covered |
| Key text absent or `EDITOR_LOST_TEXT` | read `textLenBefore`/`textLenAfter`, `textSource` and the excerpt: the run did not land or the editor ate the selection. `textSource:"document-mirror"` means a canvas editor (Google Docs) was measured through its text mirror. Re-read the page before retrying |
| `textVerified:false` on a key text run | the focused element was not a measurable editor (a canvas game, an iframe target). The note says why; confirm the result with `bsb_read` or `bsb_capture` |
| Long `key text` run lost its tail | read `truncated`/`droppedKeys`: the cap is 5000 characters per call. Send the rest in a second call |
| `keys:[...]` shortcut did not fire | read `modifiers` in the reply; a chord that was not delivered reports `modifiers:0`. Use `keys` with modifier names or `key` plus `modifiers:["Control"]` |
| Paste inserted nothing | click the field or cell first (or pass `target`); read `mode` and the note: `insertText` is not a native paste; front the tab so the browser paste command is enabled |
| `upload` cannot reach the frame | a same-origin picker iframe (Drive/Sheets import) works with `frame` + `target:"input[type=file]"`; a cross-site out-of-process frame fails with `FRAME_NOT_READABLE`. Set files on a top-document input, or use the frame route. The native chooser route is disabled (it crashed the renderer) |
| Canvas has no text | `bsb_eval`, `bsb_pixels`, `bsb_capture`; map canvas coordinates |
| Feed read returns few or 0 items | read `reason`, `matched` and `unkeyed`; a hidden tab needs `forceActive:true`, placeholders need a better selector, and `scroll:true` is what collects beyond one viewport |
| Result links are `/goto?url=`, `/url?q=` or `t.co` | `bsb_read rows resolve:true`; `resolvableBy:"navigation"` means open the link to learn its target |
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
