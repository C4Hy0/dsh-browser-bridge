#!/usr/bin/env node
/**
 * Contract test for the friction validator (`friction/check.mjs`).
 *
 * The validator is the enforcement mechanism for the whole ticket protocol: it
 * is what makes "only the reporter closes" and "confirm the named build" real
 * rather than aspirational. It had no tests, so a refactor could have silently
 * turned it into a no-op and every ticket would still look fine.
 *
 * Each case builds a throwaway ticket tree, points `FRICTION_ROOT` at it, runs
 * the real validator, and asserts the exit code and the message.
 *
 * The friction ledger is workspace-only and is not exported, so this test skips
 * cleanly when the validator is absent (for example in the public repo's CI).
 *
 * Run: node tests/friction-contract.mjs
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const checkPath = fileURLToPath(new URL('../friction/check.mjs', import.meta.url))
if (!existsSync(checkPath)) {
  console.log('ok  friction contract skipped (friction/ is workspace-only and not exported)')
  process.exit(0)
}

const FIX_BUILD = 'host 1.1.280 / extension 1.0.270'
const roots = []
let cases = 0

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'bsb-friction-'))
  roots.push(root)
  return root
}

function writeTicket(root, directory, name, text) {
  const path = join(root, directory)
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, name), text)
}

function ticket({
  id,
  status,
  extra = {},
  sections = {},
  confirmation = null,
  omit = [],
}) {
  const fields = {
    id,
    title: 'A ticket that names the friction',
    status,
    reporter: 'reporter',
    reporter_session: 'session',
    reporter_via: 'self',
    created: '2026-11-15T10:00:00+07:00',
    updated: '2026-11-15T10:00:00+07:00',
    bsb_build: '1.1.280',
    extension_build: '1.0.270',
    browser: 'abc / Chrome 157',
    severity: 'friction',
    affected_tools: 'bsb_read',
    ...extra,
  }
  for (const key of omit) delete fields[key]
  const body = Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join('\n')
  const text = {
    'What happened': 'A call did something surprising.',
    Reproduction: '1. Run the call.',
    Expected: 'It should be clear.',
    Actual: 'It was not.',
    'What "solved" means': 'Re-run step 1 and the reply is clear.',
    ...sections,
  }
  const parts = [`---\n${body}\n---`, '']
  for (const [title, value] of Object.entries(text)) parts.push(`## ${title}\n\n${value}\n`)
  if (confirmation) {
    const block = Object.entries(confirmation).map(([key, value]) => `${key}: ${value}`).join('\n')
    parts.push(`## Sender confirmation (reporter only)\n\n${block}\n`)
  }
  return parts.join('\n')
}

const solved = {
  result: 'solved',
  confirmed_by: 'reporter',
  confirmed_at: '2026-11-16T09:00:00+07:00',
  build_tested: FIX_BUILD,
  notes: 'Re-ran the reproduction.',
}

function validate(root) {
  const run = spawnSync(process.execPath, [checkPath], {
    env: { ...process.env, FRICTION_ROOT: root },
    encoding: 'utf8',
  })
  return { code: run.status, out: `${run.stdout}${run.stderr}` }
}

function expect(name, build, { code, includes = [], excludes = [] }) {
  const root = makeRoot()
  build(root)
  const result = validate(root)
  assert.equal(result.code, code, `${name}: exit ${result.code}, expected ${code}\n${result.out}`)
  for (const needle of includes) {
    assert.ok(result.out.includes(needle), `${name}: output is missing ${JSON.stringify(needle)}\n${result.out}`)
  }
  for (const needle of excludes) {
    assert.ok(!result.out.includes(needle), `${name}: output should not contain ${JSON.stringify(needle)}\n${result.out}`)
  }
  cases += 1
  console.log(`ok  ${name}`)
}

// A clean tree: one open inbox ticket, one awaiting-confirmation ticket, one
// closed ticket with a valid confirmation. This is the shape the protocol
// promises, and it must pass.
expect('valid tree passes', (root) => {
  writeTicket(root, 'inbox', 'BSB-20261116-0900-open-ticket.md', ticket({
    id: 'BSB-20261116-0900-open-ticket',
    status: 'open',
  }))
  writeTicket(root, 'active', 'BSB-20261116-0901-waiting.md', ticket({
    id: 'BSB-20261116-0901-waiting',
    status: 'awaiting-confirmation',
    extra: { owner: 'lead', fix_build: FIX_BUILD },
    sections: { 'Verification requested': `Build: ${FIX_BUILD}. Re-run step 1.` },
  }))
  writeTicket(root, 'closed', 'BSB-20261116-0902-done.md', ticket({
    id: 'BSB-20261116-0902-done',
    status: 'closed',
    extra: { owner: 'lead', fix_build: FIX_BUILD, resolution: 'fixed', confirmed_via: 'self' },
    sections: { 'Verification requested': `Build: ${FIX_BUILD}.` },
    confirmation: solved,
  }))
}, { code: 0, includes: ['no invalid closures'] })

// The cardinal rule: a closed ticket without the reporter's confirmation is an
// invalid closure, even when every other field is present.
expect('closed ticket without a confirmation fails', (root) => {
  writeTicket(root, 'closed', 'BSB-20261116-0903-noconfirm.md', ticket({
    id: 'BSB-20261116-0903-noconfirm',
    status: 'closed',
    extra: { owner: 'lead', fix_build: FIX_BUILD, resolution: 'fixed', confirmed_via: 'self' },
  }))
}, { code: 1, includes: ['no valid sender confirmation'] })

// A solved confirmation from another build is not a confirmation of this fix.
expect('build mismatch fails', (root) => {
  writeTicket(root, 'closed', 'BSB-20261116-0904-mismatch.md', ticket({
    id: 'BSB-20261116-0904-mismatch',
    status: 'closed',
    extra: { owner: 'lead', fix_build: FIX_BUILD, resolution: 'fixed', confirmed_via: 'self' },
    confirmation: { ...solved, build_tested: 'host 1.1.279 / extension 1.0.269' },
  }))
}, { code: 1, includes: ['does not contain fix_build'] })

// A solved result with no attribution is not a confirmation either.
expect('confirmation without confirmed_by fails', (root) => {
  writeTicket(root, 'closed', 'BSB-20261116-0905-anon.md', ticket({
    id: 'BSB-20261116-0905-anon',
    status: 'closed',
    extra: { owner: 'lead', fix_build: FIX_BUILD, resolution: 'fixed', confirmed_via: 'self' },
    confirmation: { ...solved, confirmed_by: '' },
  }))
}, { code: 1, includes: ['missing confirmed_by'] })

// The filename stem is the id; a mismatch makes the ticket unfindable.
expect('filename and id mismatch fails', (root) => {
  writeTicket(root, 'inbox', 'BSB-20261116-0906-wrong-name.md', ticket({
    id: 'BSB-20261116-0906-other-name',
    status: 'open',
  }))
}, { code: 1, includes: ['filename stem must equal id'] })

// An untouched section is an empty report.
expect('empty section fails', (root) => {
  writeTicket(root, 'inbox', 'BSB-20261116-0907-empty.md', ticket({
    id: 'BSB-20261116-0907-empty',
    status: 'open',
    sections: { Expected: '' },
  }))
}, { code: 1, includes: ['section "Expected" is empty'] })

// One id, one ticket: a copy left behind after triage is a second ticket.
expect('duplicate id across directories fails', (root) => {
  const text = ticket({ id: 'BSB-20261116-0908-dup', status: 'open' })
  writeTicket(root, 'inbox', 'BSB-20261116-0908-dup.md', text)
  writeTicket(root, 'active', 'BSB-20261116-0908-dup.md', ticket({
    id: 'BSB-20261116-0908-dup',
    status: 'triaged',
    extra: { owner: 'lead' },
  }))
}, { code: 1, includes: ['is already used by'] })

// fix_build is copied verbatim by reporters, so it must be a build pair.
expect('malformed fix_build fails', (root) => {
  writeTicket(root, 'active', 'BSB-20261116-0909-badbuild.md', ticket({
    id: 'BSB-20261116-0909-badbuild',
    status: 'triaged',
    extra: { owner: 'lead', fix_build: '1.1.280' },
  }))
}, { code: 1, includes: ['fix_build must look like'] })

// Warnings do not fail the run, but they must be visible: an
// awaiting-confirmation ticket without a verification request asks for a
// confirmation with no stated build.
expect('missing verification request warns', (root) => {
  writeTicket(root, 'active', 'BSB-20261116-0910-noverify.md', ticket({
    id: 'BSB-20261116-0910-noverify',
    status: 'awaiting-confirmation',
    extra: { owner: 'lead', fix_build: FIX_BUILD },
  }))
}, { code: 0, includes: ['awaiting-confirmation without a "## Verification requested"'] })

// needs-info without a question is a dead end.
expect('needs-info without a question warns', (root) => {
  writeTicket(root, 'active', 'BSB-20261116-0911-noquestion.md', ticket({
    id: 'BSB-20261116-0911-noquestion',
    status: 'needs-info',
    extra: { owner: 'lead' },
  }))
}, { code: 0, includes: ['needs-info without a "## Question for the reporter"'] })

// A missing evidence path is a broken citation, not a broken ticket.
expect('missing evidence path warns', (root) => {
  writeTicket(root, 'inbox', 'BSB-20261116-0912-noevidence.md', ticket({
    id: 'BSB-20261116-0912-noevidence',
    status: 'open',
    sections: { Evidence: 'friction/evidence/BSB-20261116-0912-noevidence/shot.png' },
  }))
}, { code: 0, includes: ['evidence path friction/evidence/BSB-20261116-0912-noevidence/shot.png does not exist'] })

// A withdrawn closure needs the reporter's withdrawal, not a maintainer note.
expect('withdrawn closure without the reporter fails', (root) => {
  writeTicket(root, 'closed', 'BSB-20261116-0913-withdrawn.md', ticket({
    id: 'BSB-20261116-0913-withdrawn',
    status: 'closed',
    extra: { owner: 'lead', resolution: 'withdrawn', confirmed_via: 'self' },
    confirmation: { ...solved, result: 'solved' },
  }))
}, { code: 1, includes: ['withdrawn closure requires result: withdrawn'] })

// A superseded confirmation kept below the current one is history. It must not
// overwrite the current result, or a solved ticket reads still-broken.
expect('superseded confirmation below the current one is ignored', (root) => {
  const text = ticket({
    id: 'BSB-20261116-0916-superseded',
    status: 'closed',
    extra: { owner: 'lead', fix_build: FIX_BUILD, resolution: 'fixed', confirmed_via: 'self' },
    confirmation: solved,
  })
  const old = ticket({
    id: 'BSB-20261116-0916-superseded',
    status: 'closed',
    extra: { owner: 'lead', fix_build: FIX_BUILD, resolution: 'fixed', confirmed_via: 'self' },
    confirmation: { ...solved, result: 'still-broken', build_tested: 'host 1.1.280 / extension 1.0.270' },
  })
  const superseded = old.slice(old.indexOf('## Sender confirmation')).replace('## Sender confirmation', '## Sender confirmation (superseded, 1.1.280)')
  writeTicket(root, 'closed', 'BSB-20261116-0916-superseded.md', `${text}\n${superseded}`)
}, { code: 0, includes: ['no invalid closures'] })

// Timestamps are how a reader orders a ticket against a build.
expect('non-ISO timestamp fails', (root) => {
  writeTicket(root, 'inbox', 'BSB-20261116-0914-baddate.md', ticket({
    id: 'BSB-20261116-0914-baddate',
    status: 'open',
    extra: { created: '16 November 2026' },
  }))
}, { code: 1, includes: ['created must be an ISO timestamp'] })

expect('updated before created fails', (root) => {
  writeTicket(root, 'inbox', 'BSB-20261116-0915-backwards.md', ticket({
    id: 'BSB-20261116-0915-backwards',
    status: 'open',
    extra: { created: '2026-11-16T10:00:00+07:00', updated: '2026-11-15T10:00:00+07:00' },
  }))
}, { code: 1, includes: ['updated is earlier than created'] })

for (const root of roots) rmSync(root, { recursive: true, force: true })
console.log(`\nfriction contract passed (${cases} cases)`)
