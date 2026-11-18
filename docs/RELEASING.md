# Releasing

These rules keep the history readable, the changelog complete, and the release
notes consistent. They apply from 1.2.0 on.

## Commit messages

- Imperative subject, at most 72 characters, no trailing period.
- The subject states the effect, not the activity: "Split the worker into modules
  by domain", not "Working on modules".
- No chat phrasing, no second person, no "this commit". A subject is a change,
  not a reply.
- One logical change per commit. A fix and a refactor are two commits.
- Body: why the change was needed, what changed at the boundaries, and the ticket
  id when one exists. Wrap at 72 characters.
- Release commits use `Release X.Y.Z: <headline>`.
- Good: "Fail upload with FILE_NOT_READABLE on a 0-byte file".
- Bad: "Fixed the thing", "More changes", "Address review comments".

## Tags

- Annotated tag `vX.Y.Z`, where X.Y.Z is the plugin version.
- Tag message: subject `vX.Y.Z`; body names the pair (`plugin X.Y.Z, extension
  A.B.C`), the headline, the changelog section, and the CI run.
- Tag the release commit after CI is green. Never move or reuse a tag.
- The changelog anchor is the version heading, for example
  `CHANGELOG.md#120---2026-11-17`.

## Changelog

- `CHANGELOG.md` follows Keep a Changelog.
- Every change a user can notice adds a line under `## [Unreleased]` in the same
  commit.
- On release, move those lines under `## [X.Y.Z] - YYYY-MM-DD`, in the order
  Added, Changed, Fixed, Removed.
- The entry names both versions on its second line: `Plugin X.Y.Z, extension
  A.B.C.`
- The release notes are copied from that entry, not rewritten from memory.
- The release headings are the only source of dates, so a tag without a heading
  is an incomplete release.

## Release notes

- Title: `X.Y.Z`.
- First line: `Plugin X.Y.Z, extension A.B.C.`
- Body: the version changelog entry, copied from `CHANGELOG.md` exactly. The
  release notes are the changelog for that version, not a separate summary.
- A release note with no matching changelog entry is an incomplete release.

The body reads like the changelog: plain sentences, sentence-case headings,
straight quotes.

## Versioning

- The plugin and the extension version move independently; every release states
  both.
- The tag is the plugin version. The extension version is the manifest version
  and appears in the release notes.
- Patch for fixes, minor for features, major for a breaking change to the tool
  surface or the wire protocol.

## Publishing to npm

- The repository package stays `browser-bridge`. That name is what the DSH plugin
  metadata resolver checks for the icon and locale files, and what the local row
  specifier uses.
- The npm package is `dsh-bsb`. Before publishing, `.github/workflows/release.yml`
  copies the tree to a temporary directory, sets `name` to `dsh-bsb`, and rewrites
  the row's `name` specifier to `dsh-bsb`. The row id stays `browser-bridge`.
  Publishing the repository tree directly would ship a package whose metadata
  does not resolve.
- Pushing the release tag runs the workflow. It checks the tag against
  `package.json` and `CHANGELOG.md`, then packs and publishes the dsh-bsb copy
  with provenance.
- The workflow uses trusted publishing: npm verifies the GitHub Actions run
  through OIDC and no token is stored. The package's trusted publisher must name
  repository `C4Hy0/dsh-browser-bridge` and workflow `release.yml`.
- The first package, 1.2.0, was published by hand to create the package; it
  predates the name rewrite and should be treated as a bootstrap version. Later
  tags use trusted publishing and the rewritten package.
- The workflow publishes only the package. It does not create a GitHub release.

## Release procedure

1. Run `npm test`.
2. Update `CHANGELOG.md`: move Unreleased under the new version heading.
3. Bump `package.json`, `bridge.js`, `index.js` (`HOST_BUILD` and `TOOLS_BUILD`),
   and `extension/manifest.json`.
4. Sync `extension/` to both unpacked copies, removing stale files when the
   layout moved.
5. Export, commit with the release rule, push, and wait for CI.
6. Create the tag `vX.Y.Z` with the tag message and push it. The release
   workflow publishes the npm package.
7. Create the GitHub release with the version changelog entry as the body.
8. Toggle the bundle, verify `/browser-bridge/api/build`, and smoke the release.

Tags and GitHub releases are created only on an explicit release request. The
release workflow reacts to a tag; it never creates one.

## Where the rules live

- This file is the public source of truth for the process.
- The maintainer snapshot in Mnemon points here; do not copy the rules into a
  second place.
- The changelog is at the repository root and ships with the plugin.
