# Changelog

All notable changes to browser-bridge. The format follows Keep a Changelog, and
each release names both versions: the plugin version is the tag, the extension
version is the manifest version.

## [Unreleased]

### Added

- `docs/RELEASING.md` with the commit, tag, release-note and changelog rules.
- This changelog, so the release notes are derived from the history instead of
  from memory.
- The plugin is published to npm as `dsh-bsb`. Pushing a `v*` tag publishes it
  with provenance through trusted publishing. The first package, 1.2.0, was
  published by hand.

### Changed

- Release notes are the version changelog entry itself, in the changelog voice.
  The separate Upgrade section is gone.

## [1.2.0] - 2026-11-17

Plugin 1.2.0, extension 1.1.0.

### Added

- The extension icons and fonts are grouped under `assets/`.
- A sheet capture that returns only the viewport is rejected, so a scrolled page
  falls back to per-tile captures instead of painting black tiles.

### Changed

- The extension worker is split by domain. `sw.js` is the entry; the rest lives
  in `lib/`, `commands/` and `commands/input/`.
- LAN pairing and the dev routes are host behaviour, not options. The row config
  carries only `port` and `bind`.
- The plugin page has no reload button. Reload the extension from
  `chrome://extensions`.
- README keeps the product surface; the safety model, remote pairing, plugin
  page, development and command path moved to `docs/SPEC.md`. Screenshots moved
  to `docs/images/`.
- Package metadata and the LICENSE copyright point at C4Hy0.

### Fixed

- A rejected upload no longer crashes the DSH host.
- A framed key run probes its own frame and reports `validity.badInput`.
- Upload fails `FILE_NOT_READABLE` when the page receives a 0-byte file.
- Record status reports liveness (`recording`, `done`, `armedAt`, `maxMs`,
  `elapsedMs`, `last`).
- Timeline reports `BAD_SELECTOR` and states its sample truncation.
- Pixels, feed, download, PDF and wait-hint replies tell the truth about what
  the page returned.

### Removed

- The `allowRemotePairing` and `devReload` options.
- The plugin page reload button.
- `design/` and the top-level `images/` directory.

## [1.1.273] - 2026-11-14

Plugin 1.1.273, extension 1.0.263.

Initial public tag. Ten `bsb_*` tools over the DevTools Protocol, popup pairing,
a read-only isolated eval world with a `world: "main"` opt-in, `forceActive`, and
the friction ledger used to maintain it.
