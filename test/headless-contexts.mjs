import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { DEFAULT_CONFIG } from '../src/config.js'
import { BrowserContextManager } from '../src/contexts.js'
import { HeadlessContextRouter } from '../src/headless-contexts.js'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-headless-contexts-'))
const config = {
  ...DEFAULT_CONFIG,
  browser: { ...DEFAULT_CONFIG.browser, preset: 'sandbox', maxContexts: 2, idleTimeoutMs: 60_000 },
}
const calls = []
const manager = new BrowserContextManager({
  config,
  home,
  createDriver: async ({ contextId, profileDir }) => ({
    contextId,
    profileDir,
    browserVersion: 'test-1',
    async request(method, params) {
      calls.push({ contextId, method, params })
      return { ok: true, method, owner: params.owner }
    },
    async close() {},
  }),
})
const router = new HeadlessContextRouter({ manager })
try {
  assert.equal(router.connected, false)
  const first = await router.request('tab.goto', { owner: 'a', url: 'https://example.com' })
  assert.equal(first.ok, true)
  assert.equal(router.connected, true)
  assert.equal(calls.length, 1)
  assert.ok(calls[0].params.owner === 'a')
  const activeA = manager.activeFor('a')
  assert.ok(activeA)
  assert.equal(manager.view(activeA.contextId).owner, 'a')

  const second = await router.request('tab.snapshot', { owner: 'a' })
  assert.equal(calls.length, 2)
  assert.equal(calls[1].contextId, calls[0].contextId, 'same owner must reuse the active context')

  await router.request('tab.goto', { owner: 'b', url: 'https://example.org' })
  assert.notEqual(calls[2].contextId, calls[0].contextId, 'different owners get isolated contexts')
  assert.equal(manager.stats().active, 2)

  await manager.close(activeA.contextId)
  assert.equal(manager.activeFor('a'), null)
  assert.equal(manager.driverFor(activeA.contextId), null)

  await router.close()
  assert.equal(manager.stats().active, 0)
  console.log('HEADLESS CONTEXTS TEST: PASS')
} finally {
  await router.close()
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
