# dsh-browser-bridge — specification v0.4

Normative contract for the host plugin and the companion Chromium extension.

## 1. Row

```yaml
- insert:
    - id: browser-bridge
      name: 'browser-bridge'
      config: { port: 8791, bind: '0.0.0.0', allowRemotePairing: true }
```

`inject: ['tools', 'attachments']`. No Config schema: `port`, `bind`, `advertise`,
`allowRemotePairing` are read leniently with defaults.

## 2. Endpoint

- Listener `http://<bind>:<port>`; token 32 random bytes, hex, `$DSH_HOME/browser-bridge/token` (`0600`).
- `pairingUrl = http://<advertise|bind|127.0.0.1>:<port>/p/<token>`; `advertise`
  auto-detects the first private IPv4 on a wildcard bind.
- Routes under `/p/<token>/`; a wrong token is `404`.

## 3. Discovery

`GET /discover` (no token) → `{ok, name, protocol, version, pairingUrl}`.

- An `Origin` that is not `chrome-extension://…` → `403`.
- A **non-loopback** peer gets `{needsLink: true}` instead of the token unless
  `allowRemotePairing` is on. This keeps a LAN discovery from becoming a
  LAN-wide takeover of the browser profile unless the operator opts in.
- The extension probes `127.0.0.1`, `localhost`, and any host the user added,
  over ports 8791–8801 in parallel, 1.2 s abort. It never asks for a link.

## 4. HTTP protocol (v2)

All JSON. `POST` uses `text/plain` to stay a simple request.

| Route | Meaning |
| --- | --- |
| `GET /hello` | identity + protocol |
| `GET /state` | `{active, browsers:[{id,label,connected,lastSeenSec,active}]}` |
| `GET /poll?waitMs&id&label` | long poll for **that browser**; `200 {id,method,params}` or `204` |
| `POST /result` | `{id, browser, ok, result\|error}` → `200`; unknown id `409` |
| `GET /status` | aggregate liveness |

`id` is a 4–64 char browser identity; a poll without it is `400`. Commands are
addressed and never broadcast: each browser has its own queue and waiter.

## 5. Multi-browser semantics

- The extension generates a stable `browserId` once and a label such as
  `Chrome on Windows`; both travel on every poll.
- Commands are serialized per browser, so two browsers work in parallel.
- The default target is the live browser that most recently received a command,
  then the most recently seen live browser. Web tools accept `browser` (id, id
  prefix, or label substring) to override it; an unknown value is
  `UNKNOWN_BROWSER`, never a silent redirect.
- Browsers not seen for an hour and holding no work are forgotten.

## 6. Commands

| method | params | result |
| --- | --- | --- |
| `frames` | `{}` | `{url,title,frames[]}` |
| `open` | `{url, newTab?, activate?}` — background by default; `activate` brings the new tab forward | `{tabId,url,title}` |
| `read` | `{maxChars?, maxElements?}` | `{tabId,url,title,text,elements,viewport,truncated,dialog?}` |
   - Elements inside open shadow roots are listed with `shadow: true`; selector clicks/typing resolve them root-locally.
| `click` | `{target?, text?, x?, y?}` | `{url,title,matchedText?,clickedAt?,dialog?}` |
| `type` | `{target,text,submit?}` | `{url,title}` |
| `key` | `{key?,keys?,steps?,count?,holdMs?,modifiers?,target?}` — `steps` is an array of `{key|keys,holdMs,waitMs}` executed in one call | `{url,title,key,times,modifiers,steps}` |
| `hover` | `{target?,text?,x?,y?,frame?}` | `{url,title,at,frameId?,scrolled?,dialog?}` |
| `upload` | `{target, files[]}` | `{url,title,count,files[]}` |
| `set` | `{target, value?, checked?}` | `{url,title,selector,tag,type,value,checked,dialog?}` |
| `select` | `{target, value?, label?, index?, frame?}` | `{url,title,selector,value,label,count,frameId?,dialog?}` |
| `drag` | `{target?,x?,y?,toTarget?,toX?,toY?,steps?,holdMs?}` | `{url,title,from,to,steps}` |
| `scroll` | `{selector?, x?, y?, frame?}` | `{scrollX,scrollY,pageHeight?,frameId?,pageX?,pageY?}` |
| `console` | `{action:"start"|"log"|"clear", limit?}` | `{tabId,capturing,total,entries}` |
| `network` | `{action,limit}` | `{started|stopped|capturing,total,entries:[{at,method,url,type,status,mime,requestBody,requestHeaders,responseHeaders,body,error}]}` — headers are captured per entry, capped at 24 names and 400 chars per value |
| `waitFor` | `{selector?, text?, url?, network?, gone?, timeoutMs?}` | `{matched,elapsedMs,url,title,text}` or `{matched,network:{method,url,status,mime,requestBody,requestHeaders,responseHeaders,body}}` |
| `screenshot` | `{fullPage?, selector?, scale?, native?}` | `{url,title,width,height,pngBase64,dialog?}` |
| `html` | `{selector?, maxChars?}` | `{url,html,length,truncated}` |
| `imageSource` | `{selector?}` | `{url,title,mime,base64,source,width,height}` — `bsb_capture native:true` writes the bytes to a file |
| `close` | `{}` | `{closed}` |
| `tabs` | `{action:"list"}` | `{tabs}` |
| `tabs` | `{action:"use", tabId}` | `{tabId,url,title}` |
| `tabs` | `{action:"close", tabId?, discard?}` | `{closed}` |
| `eval` | `{expression, awaitPromise?}` | `{result,url,title}` |

Errors carry `NO_TAB | NOT_ATTACHED | TARGET_NOT_FOUND | NAV_TIMEOUT | CDP_ERROR`.

## 7. Extension

- MV3, `chrome.debugger` (no content scripts), `host_permissions: ["http://*/*"]`
  — match patterns have no CIDR, so a `/16` entry would silently grant nothing.
- One tracked tab per browser; attach on demand, detach after 5 min idle or close.
- The worker keeps an alarm every 30 s so a suspended worker resumes polling.
- Page-neutral by construction: attach enables only `Page` events. Outside the
  explicit `forceActive` hatch, the worker never calls
  `Emulation.setFocusEmulationEnabled`, never forces `Page.setWebLifecycleState`,
  never installs a device-metrics override, and injects nothing into the DOM. A background tab
  therefore stays hidden and throttled exactly as a person would see it; the
  agent cannot raise the window: `forceActive` only makes the page believe it is
  visible, and captures render a hidden tab with `captureBeyondViewport`.
- Dashboard popup: servers list (connect/disconnect, add LAN host) and the
  browsers attached to the active server. No pairing-link field.

## 8. Tools

`bsb_browsers`, `bsb_tabs`, `bsb_open`, `bsb_read`,
`bsb_act`, `bsb_eval`, `bsb_wait_for`, `bsb_observe`, `bsb_capture`, `bsb_pixels`. Root `type: 'object'` schemas, not
concurrency-safe, 45 s timeout. `bsb_observe` kind `timeline` samples an element (box, canvas colour grid, rAF fps) for at most 10 s, and `bsb_act` key with `measure:true` returns a canvas/car read after the gesture, and `settle:true` makes that read wait until the canvas stops changing (a coasting sprite comes to rest) for at most ~3.5 s. `bsb_act` action `drive` is a closed-loop controller that lives in the extension: every ~70 ms it measures the player sprite (centroid, AABB, velocity from consecutive centroids), compares the velocity heading with the bearing to the requested game coordinate, and holds accelerate/steer/brake keys itself until the sprite is within `tol` at low speed — reversing for 650 ms when the sprite is pinned (speed 0 with a wall ahead) — brakes to rest (a coasting sprite otherwise drifts into a wall while the model thinks), then optionally presses `confirm` (a selector). A `route` array of waypoints runs several legs in one call with a short settle between them. `x`/`y` are GAME units (the measurement's coordinate space), not viewport pixels. `bsb_read` (text mode) reports each element's viewport box
and the page's viewport/DPR so coordinate work needs no guessing; JS dialogs
opened during a read are auto-dismissed and returned as `dialog`.
Open shadow roots are pierced by the selector and text paths (click, hover, type,
set); closed shadow roots are not addressable.
`bsb_capture` `kind:"sheet"` tiles every match of a selector into one labelled contact sheet (`offset`, `limit`, `columns`, `scale`) and returns per-tile colour stats. `bsb_capture` (recording) installs no device-metrics override: frames are captured at
the page's real viewport and device pixel ratio, so recording cannot reflow or
"change the resolution" of the page. Window handling never raises, focuses or
writes geometry; a minimized window that still reports a 0x0 viewport is
reported as `TAB_NOT_VISIBLE` rather than resized or restored. Recording needs
a visible tab; the tool never activates or raises one, so the caller brings it
forward with `tabs` action `use`.
Downloads are not observable: Chrome refuses browser-level CDP commands from a
tab-scoped debugger, and the `downloads` extension permission would change the
waitFor` also accepts `enabled` (control not disabled) and `stable`/`stableMs`
(box unchanged for that long) with a selector.
install fingerprint. Track the download request with `bsb_wait_for {network}`, or
verify the file afterwards on the browser machine.
`bsb_act` and `bsb_eval` accept `frame` (frame id, unique
prefix, URL substring, or index; nested frames resolve through the frame tree): the point is resolved
inside the frame's isolated world and offset by the frame element's box, so
pointer input lands on the real control even when it sits below the fold.
`bsb_eval` defaults to a guarded isolated world whose DOM write surface throws
for any node connected to the document (`READ_ONLY: …`). `world: "main"` is an
explicit opt-in that evaluates in the page's own world instead: it can read
framework instances and closures, and it can also write. Detached nodes remain
writable in the isolated world so analysis canvases work. The eval tool returns
`{result, world|frameId, url}`; a guard rejection surfaces as a tool error.
Page state changes only through input tools (`click`, `type`, `key`, `scroll`,
`drag`, `drop`, `set`, `select`). See ARCHITECTURE.md for the full contract.

## 9. Security

- Loopback by default; wildcard bind is explicit.
- `/discover` withholds the token from remote peers unless opted in; a web page
  can never read it (no CORS headers, `no-cors` is opaque).
- The agent only reaches pages it opened; the extension never borrows user tabs.
- No file upload/download crosses the browser boundary.
