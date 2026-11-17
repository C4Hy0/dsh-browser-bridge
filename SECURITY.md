# Security

## Reporting a vulnerability

Use the repository's private vulnerability reporting form (Security tab, "Report a vulnerability"). Do not open a public issue for a security problem.

## What this plugin can do

browser-bridge exposes ten tools that drive a real, signed-in Chromium browser over the DevTools Protocol. The host listens on loopback by default and pairs with one extension through a token. A page the tools touch is untrusted input: prompts, uploads, navigation, and script evaluation can reach whatever that browser session can reach.

## Supported versions

One development line, `main`. Fixes, including security fixes, land there and are not backported to older commits, tags, or forks. The latest commit on `main` is the only supported version. The `v1.2.0` tag is a snapshot, not a maintained branch.

There is no fixed support window. If you run an older copy, update first:

- Host: update the source, toggle the bundle or restart DSH, then read `/browser-bridge/api/build`. It names the host, tools, and extension builds that are actually running.
- Extension: replace the files in the unpacked folder, then press reload on the extension card in `chrome://extensions`.
- Compare both builds. A host and extension mismatch is the first thing to check when something misbehaves.

## Never commit

- pairing tokens, `settings.json`, or browser storage
- the extension private key
- cookies, page data, or captured evidence that contains personal information
