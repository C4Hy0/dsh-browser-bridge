<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/banner-dark.svg">
    <img src="docs/images/banner-light.svg" width="400" height="88" alt="Browser Bridge">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/C4Hy0/dsh-browser-bridge/actions/workflows/ci.yml"><img src="https://github.com/C4Hy0/dsh-browser-bridge/actions/workflows/ci.yml/badge.svg" alt="tests"></a>
</p>

Browser Bridge is a DeepSeek Harness plugin and a Chromium extension. It lets an
agent drive the browser you are already signed into: open a tab, read it, and act
on it over the DevTools Protocol. It does not start a second browser or copy
cookies.

The host plugin provides the plugin page cards and the extension download. Ten
tools cover reading, input, waiting, screenshots, pixel sampling, network and
console observation, and script evaluation.

## Requirements

- DeepSeek Harness 0.2.x.
- Chrome or Edge 116 or newer. Other Chromium browsers work; Firefox does not.
- The extension is loaded unpacked. There is no store listing.

## Install

### 1. Add the plugin

Replace `web` with your DSH profile name.

```sh
dsh plugin --profile web add /absolute/path/to/dsh-browser-bridge
```

The published package is also available:

```sh
dsh plugin --profile web add dsh-bsb
```

### 2. Install the extension

- Open the DSH Plugins panel, select Browser Bridge, and download the zip from
  the Browser extension card.
- Unzip it. `manifest.json` must be at the top level of the folder.
- Open `chrome://extensions` (or `edge://extensions`), turn on Developer mode,
  choose Load unpacked, and select the folder.
- Open the extension popup. It scans `127.0.0.1` ports 8791-8811 and connects to
  the first host that answers. For a host on another port or machine, paste the
  pairing link from the plugin page into the popup and press Pair.

### 3. Check

Run `bsb_browsers`. It lists connected browsers with their product and build, for
example `Chrome/157.0.8103.38`.

## Tools

| Tool | Does |
| --- | --- |
| `bsb_browsers` | Lists connected browsers and the default target. |
| `bsb_open` | Opens a URL and makes it the tracked tab. |
| `bsb_tabs` | Lists, adopts, reloads, or closes tabs. |
| `bsb_read` | Reads text, elements with `@eN` refs, structured rows, or HTML. |
| `bsb_act` | Runs one input action, such as click, type, key, scroll, drag, drop, upload, or canvas steering. |
| `bsb_wait_for` | Waits for a selector, text, URL, JS expression, network request, or delay. |
| `bsb_capture` | Saves screenshots, contact sheets, or recordings. |
| `bsb_pixels` | Reads colours as a grid or at exact points. |
| `bsb_observe` | Records network requests, console messages, or an element timeline. |
| `bsb_eval` | Runs JavaScript, read-only unless the call opts into the page world. |

Tools that address a page accept `browser` and `tabId`; the tools that support
child documents also accept `frame`. Only `bsb_open` and `bsb_tabs use` change the
tracked tab, so two agents can drive two tabs without moving each other.

A bundled skill, `browser-bridge`, covers the workflow: tool choice, the read,
act, and wait loop, frames, canvas pages, network debugging, and recovery.

## Updating

Host changes: toggle the bundle or restart DSH, then check
`/browser-bridge/api/build`. Extension changes: replace the files in the unpacked
folder; the worker reloads itself when the served version differs.

## Configuration

| Key | Default | Effect |
| --- | --- | --- |
| `port` | 8791 | Listener port. The extension probes 8791-8811. |
| `bind` | `0.0.0.0` | Address to listen on. Use `127.0.0.1` for this machine only. |
| `advertise` | auto | Address in the pairing URL when `bind` is a wildcard; defaults to the first private IPv4. |

Port changes from the plugin page are stored in
`<dsh home>/browser-bridge/settings.json` and override the row.

## Troubleshooting

- The extension reports a manifest error: select the folder that contains
  `manifest.json`, not its parent.
- Pairing fails: check the pairing link and the port, and allow the port through
  the firewall for a LAN browser.
- `bsb_browsers` is empty: reload the extension and check its card for errors.
- A dev route returns 404: the plugin is not loaded or the port is wrong; check
  `/browser-bridge/api/build`.

## License

MIT. See [LICENSE](LICENSE).
