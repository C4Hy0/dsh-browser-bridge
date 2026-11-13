/**
 * The two model-facing surfaces must ship together: `tools.js` carries the
 * trigger-first routing and the skill carries the workflow playbook. This test
 * registers the real tool definitions and fails when the skill drops a tool,
 * documents a removed tool, or misses a primary routing enum.
 *
 * Run directly or through `tests/selftest.mjs`.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { registerTools } from '../tools.js'

const skill = await readFile(new URL('../skill/bsb-browser/SKILL.md', import.meta.url), 'utf8')
const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(skill)
assert.ok(frontmatter, 'bsb-browser skill has no frontmatter')
assert.match(frontmatter[1], /^name: bsb-browser$/m, 'skill name must be bsb-browser')
assert.match(frontmatter[1], /^description: Use when .+$/m, 'skill description must say when to use it')

const tools = new Map()
registerTools({
  tools: { register: (definition) => tools.set(definition.name, definition) },
  effect: (run) => run(),
}, { send: async () => null })

const routing = skill.slice(skill.indexOf('## Tool selection'), skill.indexOf('## Normal workflow'))
assert.ok(routing.length > 0, 'skill has no Tool selection table')
for (const name of tools.keys()) {
  assert.ok(routing.includes('`' + name + '`'), `skill routing table is missing ${name}`)
}

const removed = ['bsb_sheet', 'bsb_image', 'bsb_frames']
for (const name of removed) {
  assert.ok(!skill.includes(name), `skill still references removed tool ${name}`)
  for (const [tool, definition] of tools) {
    assert.ok(!definition.description.includes(name), `${tool} description still references removed tool ${name}`)
  }
}

const primary = {
  bsb_act: 'action',
  bsb_capture: 'kind',
  bsb_read: 'mode',
  bsb_observe: 'kind',
  bsb_eval: 'world',
}
for (const [tool, parameter] of Object.entries(primary)) {
  const definition = tools.get(tool)
  assert.ok(definition, `missing tool ${tool}`)
  const values = definition.parameters.properties?.[parameter]?.enum ?? []
  assert.ok(values.length > 0, `${tool}.${parameter} has no enum`)
  for (const value of values) {
    const pattern = new RegExp('\\b' + value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b')
    assert.match(skill, pattern, `skill does not document ${tool}.${parameter} value "${value}"`)
  }
}

for (const [name, definition] of tools) {
  assert.match(definition.description, /\bUse\b/, `${name} description has no use cue`)
}
assert.match(tools.get('bsb_browsers').description, /bsb-browser skill/, 'bsb_browsers must point at the skill')

console.log(`ok  the bsb-browser skill covers ${tools.size} tools and their routing enums`)
