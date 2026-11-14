# Security

## Reporting a vulnerability

Use the repository's private vulnerability reporting form (Security tab, "Report a vulnerability"). Do not open a public issue for a security problem.

## What this plugin can do

browser-bridge exposes ten tools that drive a real, signed-in Chromium browser over the DevTools Protocol. The host listens on loopback by default and pairs with one extension through a token. A page the tools touch is untrusted input: prompts, uploads, navigation, and script evaluation can reach whatever that browser session can reach.

## Supported versions

Only the latest `main` is supported. The extension is installed unpacked, so update it from the plugin page rather than an extension store.

## Never commit

- pairing tokens, `settings.json`, or browser storage
- the extension private key
- cookies, page data, or captured evidence that contains personal information
