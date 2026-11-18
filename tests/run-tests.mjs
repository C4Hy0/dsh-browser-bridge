#!/usr/bin/env node
/**
 * Runs the test suite. The friction ledger is workspace-only, so its contract
 * test lives in `friction/` and runs only when that directory is present. The
 * public repository still gets one `npm test` command.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const run = (file) => {
  const result = spawnSync(process.execPath, [file], { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

for (const file of ['selftest.mjs', 'compat-webserver.mjs', 'tool-contract.mjs']) {
  run(fileURLToPath(new URL('./' + file, import.meta.url)))
}

const frictionContract = fileURLToPath(new URL('../friction/friction-contract.mjs', import.meta.url))
if (existsSync(frictionContract)) run(frictionContract)
else console.log('skip  friction contract (workspace-only)')

console.log('\nsuite passed')
