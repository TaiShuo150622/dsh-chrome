import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { chromeTools } from '../src/tools.js'
import { ArtifactStore } from '../src/artifact-store.js'

const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verify-'))
const artifactStore = new ArtifactStore({ root: artifactDir, retentionRuns: 50 })
const calls = []
const driver = {
  async request(method, params) {
    calls.push({ method, params })
    if (method === 'tab.goto') return { url: params.url || 'https://example.com/' }
    if (method === 'tab.wait') return { ok: true }
    if (method === 'tab.click') return { ok: true }
    if (method === 'tab.type') return { ok: true }
    if (method === 'tab.snapshot') return { url: 'https://example.com/success', title: 'Verify OK', text: '完成提交' }
    if (method === 'tab.evaluate') return { value: { exists: true, visible: true, text: '完成' } }
    if (method === 'tab.console') return { entries: [] }
    if (method === 'tab.network') return { entries: [{ url: 'https://example.com/api', status: 200, transferSize: 10 }] }
    if (method === 'tab.screenshot') return { path: path.join(artifactDir, 'shot.png'), bytes: 1000 }
    return {}
  },
}
const context = { contextId: 'ctx-test', owner: 'session-a' }
const contexts = {
  activeFor(owner) { return owner === 'session-a' ? context : null },
  get(contextId) { return contextId === 'ctx-test' ? context : null },
  getOwned(contextId, owner) { return contextId === 'ctx-test' && owner === 'session-a' ? context : null },
  create: async () => context,
  driverFor() { return driver },
  driverForOwned(contextId, owner) { return contextId === 'ctx-test' && owner === 'session-a' ? driver : null },
}
const tools = chromeTools({
  bridge: { call: async () => ({}), runWithBackend: (_mode, fn) => fn() },
  attachments: () => null,
  assets: () => ({}),
  approval: () => null,
  sessionContext: () => ({}),
  userQuestions: () => null,
  config: () => ({}),
  contexts,
  artifactStore,
})
const verify = tools.find((tool) => tool.name === 'chrome_verify')
assert.ok(verify, 'chrome_verify must be registered')

try {
  const exec = { agent: { id: 'session-a' } }
  const ok = await verify.execute({
    steps: [
      { action: 'navigate', url: 'https://example.com/' },
      { action: 'waitFor', selector: '#ready' },
      { action: 'click', selector: '#submit' },
      { action: 'assert', checks: [
        { type: 'url', contains: '/success' },
        { type: 'title', contains: 'Verify' },
        { type: 'text', contains: '完成提交' },
        { type: 'element', selector: '#status', state: 'visible', contains: '完成' },
        { type: 'console', maxErrors: 0 },
        { type: 'network', maxFailures: 0 },
      ] },
    ],
  }, exec)
  assert.equal(ok.ok, true, JSON.stringify(ok))
  assert.equal(ok.contextId, 'ctx-test')
  assert.equal(ok.checks.length, 6)
  assert.equal(ok.checks.every((check) => check.ok), true)
  assert.ok(ok.artifacts.some((item) => item.type === 'report'))
  assert.ok(fs.readdirSync(artifactDir).some((name) => name.startsWith('verify-')))

  const failing = await verify.execute({
    steps: [{ action: 'assert', checks: [{ type: 'text', contains: '不存在的文本' }] }],
    options: { screenshotOnFailure: true },
  }, exec)
  assert.equal(failing.ok, false)
  assert.equal(failing.checks[0].ok, false)
  assert.ok(failing.artifacts.some((item) => item.type === 'screenshot'), JSON.stringify(failing.artifacts))
  console.log('CHROME VERIFY TEST: PASS')
} finally {
  fs.rmSync(artifactDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
