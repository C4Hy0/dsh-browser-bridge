#!/usr/bin/env node
/**
 * Tool contract test: the model-facing layer.
 *
 * e2e drives the worker directly, and the selftest greps the source, so a
 * schema that stops forwarding a parameter, or an action wired to the wrong
 * worker command, used to pass every check. This test registers the real tools
 * against a recording bridge and asserts the exact command and parameters each
 * action sends.
 *
 * Run: node tests/tool-contract.mjs
 */

import assert from 'node:assert/strict'

import { registerTools } from '../tools.js'

const calls = []
const bridge = {
  activeBrowserId: 'test-browser',
  browsers: () => [],
  dropBrowser: () => {},
  send: async (method, params, options) => {
    calls.push({ method, params: params ?? {}, options: options ?? {} })
    // A capture tool validates the image it received, so the fake answers with
    // a minimal one instead of failing before the call is inspected.
    return method === 'screenshot' || method === 'sheet' ? { pngBase64: 'AAAA' } : {}
  },
}

const tools = new Map()
const ctx = {
  effect: (fn) => fn(),
  tools: { register: (definition) => tools.set(definition.name, definition) },
}
registerTools(ctx, bridge)

const EXPECTED_TOOLS = [
  'bsb_browsers', 'bsb_tabs', 'bsb_eval', 'bsb_open', 'bsb_capture',
  'bsb_wait_for', 'bsb_pixels', 'bsb_act', 'bsb_read', 'bsb_observe',
]
assert.deepEqual([...tools.keys()].sort(), [...EXPECTED_TOOLS].sort(), 'the tool surface changed')

for (const [name, tool] of tools) {
  assert.equal(typeof tool.execute, 'function', `${name} has no execute`)
  assert.ok(tool.parameters && typeof tool.parameters === 'object', `${name} has no parameter schema`)
}

let cases = 0
const failures = []

/** Run one tool action and assert the worker command and parameters it sends. */
async function expectCall(name, args, method, check = () => {}) {
  calls.length = 0
  try {
    await tools.get(name).execute(args)
    assert.equal(calls.length, 1, `sent ${calls.length} commands, expected 1`)
    const call = calls[0]
    assert.equal(call.method, method, `sent "${call.method}", expected "${method}"`)
    check(call.params, call)
    cases += 1
  } catch (error) {
    failures.push(`${name} ${JSON.stringify(args)}: ${error.message}`)
  }
}

// bsb_browsers answers from the bridge directly, with no command.
{
  const value = await tools.get('bsb_browsers').execute({})
  assert.equal(value.active, 'test-browser', 'bsb_browsers lost the active browser')
  assert.ok(Array.isArray(value.browsers), 'bsb_browsers lost the browser list')
  cases += 1
}

await expectCall('bsb_open', { url: 'https://example.com/', newTab: true }, 'open', (p) => {
  assert.equal(p.url, 'https://example.com/')
  assert.equal(p.newTab, true)
})
await expectCall('bsb_tabs', { action: 'list' }, 'tabs', (p) => assert.deepEqual(p, {}))
await expectCall('bsb_tabs', { action: 'use', tabId: 5, activate: false }, 'use', (p) => {
  assert.equal(p.tabId, 5)
  assert.equal(p.activate, false)
})
await expectCall('bsb_tabs', { action: 'reload', tabId: 5 }, 'tabs', (p) => {
  assert.equal(p.action, 'reload')
  assert.equal(p.tabId, 5)
})
await expectCall('bsb_tabs', { action: 'close', tabId: 5 }, 'closeTab', (p) => assert.equal(p.tabId, 5))

await expectCall('bsb_read', { mode: 'text', maxChars: 500, normalize: true }, 'read', (p) => {
  assert.equal(p.maxChars, 500)
  assert.equal(p.normalize, true)
})
await expectCall('bsb_read', { mode: 'rows', selector: 'div.x', limit: 5, resolve: true }, 'inspect', (p) => {
  assert.equal(p.selector, 'div.x')
  assert.equal(p.limit, 5)
  assert.equal(p.resolve, true)
})
await expectCall('bsb_read', { mode: 'html', selector: '#x' }, 'html', (p) => assert.equal(p.selector, '#x'))
await expectCall('bsb_read', { mode: 'feed', selector: '[role=article]', maxItems: 5, scroll: true, dedupeBy: 'href' }, 'feed', (p) => {
  assert.equal(p.selector, '[role=article]')
  assert.equal(p.maxItems, 5)
  assert.equal(p.scroll, true)
  assert.equal(p.dedupeBy, 'href')
})

await expectCall('bsb_eval', { expression: '1 + 1', awaitPromise: true, world: 'main' }, 'eval', (p) => {
  assert.equal(p.expression, '1 + 1')
  assert.equal(p.awaitPromise, true)
  assert.equal(p.world, 'main')
})
await expectCall('bsb_wait_for', { text: 'ready', visible: true }, 'waitFor', (p) => {
  assert.equal(p.text, 'ready')
  assert.equal(p.visible, true)
})

await expectCall('bsb_act', { action: 'click', text: 'Save', verify: true }, 'click', (p) => {
  assert.equal(p.text, 'Save')
  assert.equal(p.verify, true)
})
await expectCall('bsb_act', { action: 'click', target: '#go', count: 2 }, 'click', (p) => {
  assert.equal(p.target, '#go')
  assert.equal(p.count, 2)
})
await expectCall('bsb_act', { action: 'type', target: '#name', text: 'Ada', submit: true }, 'type', (p) => {
  assert.equal(p.target, '#name')
  assert.equal(p.text, 'Ada')
  assert.equal(p.submit, true)
})
await expectCall('bsb_act', { action: 'key', text: 'a\tb' }, 'key', (p) => assert.equal(p.text, 'a\tb'))
await expectCall('bsb_act', { action: 'key', keys: ['ControlLeft', 'KeyA'] }, 'key', (p) => {
  assert.deepEqual(p.keys, ['ControlLeft', 'KeyA'])
})
await expectCall('bsb_act', { action: 'paste', text: 'a\tb\nc\td' }, 'paste', (p) => assert.equal(p.text, 'a\tb\nc\td'))
await expectCall('bsb_act', { action: 'upload', target: '#file', files: ['/tmp/a.csv'] }, 'upload', (p) => {
  assert.equal(p.target, '#file')
  assert.deepEqual(p.files, ['/tmp/a.csv'])
})
await expectCall('bsb_act', { action: 'set', target: '#range', value: '50' }, 'set', (p) => {
  assert.equal(p.target, '#range')
  assert.equal(p.value, '50')
})
await expectCall('bsb_act', { action: 'select', target: '#pick', label: 'beta' }, 'select', (p) => {
  assert.equal(p.target, '#pick')
  assert.equal(p.label, 'beta')
})
await expectCall('bsb_act', { action: 'scroll', selector: '#x' }, 'scroll', (p) => assert.equal(p.selector, '#x'))
await expectCall('bsb_act', { action: 'drag', target: '#a', toTarget: '#b' }, 'drag', (p) => {
  assert.equal(p.target, '#a')
  assert.equal(p.toTarget, '#b')
})
await expectCall('bsb_act', { action: 'drop', target: '#zone', text: 'hi' }, 'drop', (p) => {
  assert.equal(p.target, '#zone')
  assert.equal(p.text, 'hi')
})
await expectCall('bsb_act', { action: 'wheel', x: 10, y: 20, deltaY: -100 }, 'wheel', (p) => {
  assert.equal(p.x, 10)
  assert.equal(p.y, 20)
  assert.equal(p.deltaY, -100)
})
await expectCall('bsb_act', { action: 'hover', text: 'Menu' }, 'hover', (p) => assert.equal(p.text, 'Menu'))
await expectCall('bsb_act', { action: 'drive', x: 100, y: 200 }, 'drive', (p) => {
  assert.equal(p.x, 100)
  assert.equal(p.y, 200)
})
await expectCall('bsb_act', { action: 'measure', settle: true }, 'measure', (p) => assert.equal(p.settle, true))
await expectCall('bsb_act', { action: 'forceActive', mode: 'hold' }, 'forceActive', (p) => assert.equal(p.mode, 'hold'))
await expectCall('bsb_act', { action: 'releaseActive' }, 'releaseActive')

await expectCall('bsb_capture', { kind: 'shot', selector: '#cv', scale: 2 }, 'screenshot', (p) => {
  assert.equal(p.selector, '#cv')
  assert.equal(p.scale, 2)
})
await expectCall('bsb_capture', { kind: 'record', action: 'start', selector: '#cv' }, 'record', (p) => {
  assert.equal(p.action, 'start')
  assert.equal(p.selector, '#cv')
})
await expectCall('bsb_capture', { kind: 'sheet', selector: 'li', limit: 4 }, 'sheet', (p) => {
  assert.equal(p.selector, 'li')
  assert.equal(p.limit, 4)
})

await expectCall('bsb_pixels', { selector: '#cv', grid: 4 }, 'pixels', (p) => {
  assert.equal(p.selector, '#cv')
  assert.equal(p.grid, 4)
})

await expectCall('bsb_observe', { kind: 'network', action: 'start' }, 'network', (p) => assert.equal(p.action, 'start'))
await expectCall('bsb_observe', { kind: 'console', action: 'log' }, 'console', (p) => assert.equal(p.action, 'log'))
await expectCall('bsb_observe', { kind: 'timeline', selector: '#cv' }, 'timeline', (p) => assert.equal(p.selector, '#cv'))

if (failures.length > 0) {
  for (const failure of failures) console.error(`error ${failure}`)
  console.error(`\ntool contract: ${failures.length} failure(s)`)
  process.exitCode = 1
} else {
  console.log(`ok  tool contract pinned (${cases} actions across ${tools.size} tools)`)
}
