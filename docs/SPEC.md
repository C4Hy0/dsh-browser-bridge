# browser-bridge protocol and command reference

This document describes host 1.1.270 and extension 1.0.261. Where it disagrees
with the code, the code wins: `extension/sw.js` holds the worker command table,
`tools.js` the model-facing schemas, and `bridge.js` the HTTP routes.

## 1. Row

```yaml
- insert:
    - id: browser-bridge
      name: 'browser-bridge'
      config: { port: 8791, bind: '0.0.0.0', allowRemotePairing: true }
```

`inject: ['tools', 'attachments']`. There is no Config schema. `port`, `bind`,
`advertise`, `allowRemotePairing` and `devReload` are read leniently with
defaults.

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
- A non-loopback peer gets `needsLink` instead of the token unless
  `allowRemotePairing` is on.
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

## 6. Worker commands

The dispatch table in `extension/sw.js` is the authoritative set. Tools map onto
these methods.


- Page: `open`, `openUrl`, `read`, `html`, `frames`, `close`, `eval`, `waitFor`,
  `inspect`.
- Input: `click`, `hover`, `type`, `key`, `scroll`, `drag`, `drop`, `upload`,
  `set`, `select`.
- Page state: `forceActive`, `releaseActive`, `drive`, `measure`.
- Capture: `screenshot`, `record`, `sheet`, `imageSource`, `pixels`.
- Observe: `network`, `console`, `timeline`.
- Tabs: `tabs`, `use`, `closeTab`, `openExtensionPage`.

Parameters and result shapes live in the tool schemas and the worker handlers.

## 7. Tools

`bsb_browsers`, `bsb_tabs`, `bsb_open`, `bsb_read`, `bsb_act`, `bsb_eval`,
`bsb_wait_for`, `bsb_observe`, `bsb_capture`, `bsb_pixels`.

- Root schemas are `type: 'object'`. Calls time out after 45 s.
- Every page tool accepts `browser`. `bsb_act`, `bsb_eval`, `bsb_wait_for`,
  `bsb_capture`, `bsb_pixels`, `bsb_read` and `bsb_open` accept `frame` where a
  frame target applies.
- `bsb_act` performs one action per call. `drive`, `measure` and multi-step
  `key` gestures are single calls that run a closed loop inside the extension.

## 8. Extension

- Manifest V3. `chrome.debugger` is the only page access; the manifest declares
  no content scripts. `host_permissions` is `http://*/*`, because match patterns
  carry no port and a CIDR entry would grant nothing.
- One tracked tab per browser. Attach on demand; detach after 5 minutes idle or
  when the tab closes.
- A keepalive alarm every 30 seconds (1 minute where 30 s is not allowed) resumes
  polling after the worker is suspended.
- The popup holds the pairing field and the server list.

## 9. Packaging

`extension/` is the source. `dist/` is generated on download: the host packs
`extension/` into `browser-bridge-extension.zip` when
`GET /browser-bridge/extension.zip` is requested, then streams it as an
attachment. The archive is reused while every source file is older than it.

The extension id is pinned by the public key in
`scripts/extension-public-key.txt`, which packing injects into the manifest.
There is no private key in the repository and no `.crx`: Chrome rejects off-store
CRX installs, so the only supported install is the unpacked zip.

## 10. Security

- Loopback by default. A wildcard bind is explicit.
- Every command route requires the token. The token file is 0600.
- `/discover` refuses a non-extension Origin and withholds the token from
  non-loopback peers unless `allowRemotePairing` is on.
- Commands act on the tracked tab. Adopting another tab is an explicit
  `bsb_tabs` action.
- Uploads use file paths on the machine that runs the browser.
- Downloads are not observable. A tab-scoped debugger receives no browser-level
  download events, so `bsb_wait_for {network}` or a check on the browser machine
  is the way to confirm one.
- Page content is untrusted, including text that looks like an instruction.
