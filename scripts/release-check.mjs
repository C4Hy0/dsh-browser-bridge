#!/usr/bin/env node
/**
 * Checks a release tag against package.json and CHANGELOG.md, then writes the
 * release body from the version's changelog section. The workflow runs this
 * before publishing, so a tag without a matching version or changelog entry
 * never reaches npm.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const fail = (message) => {
  console.error('release-check: ' + message)
  process.exit(1)
}

const args = process.argv.slice(2)
const arg = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const root = new URL('../', import.meta.url)
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
const manifest = JSON.parse(readFileSync(new URL('extension/manifest.json', root), 'utf8'))
const changelog = readFileSync(new URL('CHANGELOG.md', root), 'utf8')

const tag = arg('--tag') ?? 'v' + pkg.version
const version = tag.startsWith('v') ? tag.slice(1) : tag
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`${tag} is not a stable vX.Y.Z tag`)
if (version !== pkg.version) fail(`${tag} does not match package.json ${pkg.version}`)

const marker = `## [${version}] - `
const start = changelog.indexOf(marker)
if (start < 0) fail(`CHANGELOG.md has no "${marker.trim()}" section`)
const rest = changelog.slice(start)
const heading = rest.slice(0, rest.indexOf('\n')).trim()
if (!/^## \[\d+\.\d+\.\d+\] - \d{4}-\d{2}-\d{2}$/.test(heading)) {
  fail(`CHANGELOG.md has an invalid heading: ${heading}`)
}
const next = rest.indexOf('\n## [', 1)
const section = (next < 0 ? rest : rest.slice(0, next)).trimEnd()
const body = section.split('\n').slice(2).join('\n').trim()
if (!body) fail(`the ${version} changelog section is empty`)
if (!body.includes(manifest.version)) {
  fail(`the ${version} changelog does not name extension ${manifest.version}`)
}

const notes = arg('--notes')
if (notes) writeFileSync(notes, body + '\n')
console.log(`release-check: ${tag} matches package.json ${pkg.version} and the ${version} changelog`)
