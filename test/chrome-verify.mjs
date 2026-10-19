import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { chromeTools } from '../src/tools.js'
import { ArtifactStore } from '../src/artifact-store.js'

const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verify-'))
const artifactStore = new ArtifactStore({ root: artifactDir, retentionRuns: 50 })
const calls = []
const typed = []
const driver = {
  async request(method, params) {
    calls.push({ method, params })
    if (method === 'tab.goto') return { url: params.url || 'https://example.com/' }
    if (method === 'tab.wait') return { ok: true }
    if (method === 'tab.click') return { ok: true }
    if (method === 'tab.type') {
      // H5: a password target refuses until the provider retries with the
      // per-call approval flag obtained through hard confirmation.
      if (params.selector === '#password' && params.sensitiveApproved !== true) {
        const error = new Error('target is a sensitive password field')
        error.code = 'SENSITIVE_FIELD'
        throw error
      }
      typed.push({ selector: params.selector, text: params.text, approved: params.sensitiveApproved === true })
      return { ok: true, sensitive: params.selector === '#password' ? 'password' : undefined }
    }
    if (method === 'tab.snapshot') return { url: 'https://example.com/success', title: 'Verify OK', text: '完成提交' }
    if (method === 'tab.evaluate') return { value: { exists: true, visible: true, text: '完成' } }
    if (method === 'tab.console') return { entries: [] }
    if (method === 'tab.network') return { entries: [{ url: 'https://example.com/api', status: 200, transferSize: 10 }] }
    if (method === 'tab.screenshot') return { path: path.join(artifactDir, 'shot.png'), bytes: 1000 }
    return {}
  },
}
let confirmMode = 'allowed'
const confirmations = []
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
  userQuestions: () => ({
    ask: async (request) => {
      const question = request?.questions?.[0] || {}
      confirmations.push({
        header: String(question.header || ''),
        question: String(question.question || ''),
        detail: String(question.detail || ''),
      })
      return { answers: [{ id: 'confirm', selected: [confirmMode === 'allowed' ? '允许一次' : '拒绝'] }] }
    },
  }),
  config: () => ({ evaluateConfirmTimeoutMs: 5000 }),
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

  // H5: verify.type on a password field is refused by the driver, then retried
  // once after the hard confirmation. The step text never enters the card or
  // the result; a denied confirmation types nothing.
  const SENTINEL = 'DSH_SENTINEL_VERIFY_PASSWORD_DO_NOT_USE'
  const confirmationsBefore = confirmations.length
  const approved = await verify.execute({
    steps: [
      { action: 'navigate', url: 'https://example.com/login' },
      { action: 'type', selector: '#password', text: SENTINEL },
    ],
  }, exec)
  assert.equal(approved.ok, true, JSON.stringify(approved))
  assert.equal(confirmations.length, confirmationsBefore + 1)
  assert.ok(confirmations.at(-1).header.includes('敏感字段'))
  assert.ok(confirmations.at(-1).question.includes('https://example.com'))
  assert.equal(JSON.stringify(confirmations.at(-1)).includes(SENTINEL), false)
  assert.equal(JSON.stringify(approved).includes(SENTINEL), false)
  const sensitiveCalls = calls.filter((call) => call.method === 'tab.type' && call.params.selector === '#password')
  assert.equal(sensitiveCalls.length, 2, JSON.stringify(sensitiveCalls.map((call) => call.params.sensitiveApproved)))
  assert.notEqual(sensitiveCalls[0].params.sensitiveApproved, true)
  assert.equal(sensitiveCalls[1].params.sensitiveApproved, true)
  assert.deepEqual(typed.filter((entry) => entry.selector === '#password').map((entry) => entry.text), [SENTINEL])

  confirmMode = 'denied'
  const beforeDeniedCalls = calls.length
  const denied = await verify.execute({
    steps: [
      { action: 'navigate', url: 'https://example.com/login' },
      { action: 'type', selector: '#password', text: SENTINEL },
    ],
  }, exec)
  assert.equal(denied.ok, false)
  assert.ok(
    denied.checks.some((check) => check.ok === false && /not approved|APPROVAL_DENIED|confirmation/i.test(String(check.message || ''))),
    JSON.stringify(denied.checks),
  )
  assert.equal(JSON.stringify(denied).includes(SENTINEL), false)
  const deniedTypeCalls = calls
    .slice(beforeDeniedCalls)
    .filter((call) => call.method === 'tab.type' && call.params.selector === '#password')
  assert.equal(deniedTypeCalls.length, 1, 'a denied confirmation must not retry')
  assert.notEqual(deniedTypeCalls[0].params.sensitiveApproved, true)
  assert.deepEqual(typed.filter((entry) => entry.selector === '#password').map((entry) => entry.text), [SENTINEL])
  confirmMode = 'allowed'

  console.log('CHROME VERIFY TEST: PASS')
} finally {
  fs.rmSync(artifactDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
