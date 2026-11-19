#!/usr/bin/env node
/**
 * Checks a release tag against package.json and CHANGELOG.md, then writes the
 * release body from the version's changelog section. The workflow runs this
 * before publishing, so a tag without a matching version or changelog entry
 * never reaches npm.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

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

// The release workflow publishes a rewritten npm copy: package name dsh-bsb,
// row name dsh-bsb, client id dsh-bsb. Check that copy before publish, because
// the 1.2.9 package was rejected by DSH for a row indentation slip.
const packageDir = arg('--package')
if (packageDir) {
  const dir = resolve(packageDir)
  const generated = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  if (generated.name !== 'dsh-bsb') fail(`the npm package name is ${generated.name}, not dsh-bsb`)
  if (generated.version !== version) fail(`the npm package version is ${generated.version}, not ${version}`)
  const lines = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8').split('\n')
  const idLine = lines.find((line) => line.includes('id: browser-bridge'))
  const nameLine = lines.find((line) => line.includes("name: 'dsh-bsb'"))
  if (!idLine || !/^    - id: browser-bridge$/.test(idLine)) {
    fail(`the generated overlay row id has the wrong indentation: ${JSON.stringify(idLine)}`)
  }
  if (!nameLine || !/^      name: 'dsh-bsb'$/.test(nameLine)) {
    fail(`the generated overlay row name has the wrong indentation: ${JSON.stringify(nameLine)}`)
  }
  const configLine = lines.find((line) => /^\s+config:$/.test(line))
  if (!configLine || !/^      config:$/.test(configLine)) {
    fail('the generated overlay config lost its indentation')
  }
  const client = readFileSync(join(dir, 'client.js'), 'utf8')
  if (!client.includes("id: 'dsh-bsb'")) fail('the generated client.js does not register dsh-bsb')
  console.log(`release-check: the ${version} npm package is valid`)
}

console.log(`release-check: ${tag} matches package.json ${pkg.version} and the ${version} changelog`)
