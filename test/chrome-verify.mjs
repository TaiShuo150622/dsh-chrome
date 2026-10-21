import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { chromeTools } from '../src/tools.js'
import { ArtifactStore } from '../src/artifact-store.js'
import { classifyTarget, targetAllowedByAllowlist } from '../src/verify-targets.js'

const previousHome = process.env.DSH_HOME
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verify-home-'))
process.env.DSH_HOME = home

const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verify-'))
const artifactStore = new ArtifactStore({ root: artifactDir, retentionRuns: 50 })
const calls = []
const typed = []
const SENTINEL = 'DSH_SENTINEL_VERIFY_PASSWORD_DO_NOT_USE'
const REDACT_SENTINEL = 'DSH_SENTINEL_VERIFY_ARTIFACT_DO_NOT_USE'

let siteUrl = 'https://example.com/'
let redirectUrl = null
let consoleEntries = []
let networkEntries = [{ url: 'https://example.com/api', status: 200, transferSize: 10 }]

function originOf(raw) {
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null
  } catch {
    return null
  }
}

const driver = {
  async request(method, params) {
    calls.push({ method, params })
    if (method === 'tab.goto') {
      const url = redirectUrl || params.url || 'https://example.com/'
      redirectUrl = null
      siteUrl = url
      return { url }
    }
    if (method === 'tab.wait') return { ok: true }
    if (method === 'tab.click') return { ok: true }
    if (method === 'browser.site') return { origin: originOf(siteUrl), url: siteUrl, title: 'Verify', tabId: 7 }
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
    if (method === 'tab.console') return { entries: consoleEntries }
    if (method === 'tab.network') return { entries: networkEntries }
    if (method === 'tab.screenshot') return { path: path.join(artifactDir, 'shot.png'), bytes: 1000 }
    return {}
  },
}

let confirmMode = 'allowed'
const confirmations = []
const approvalMode = 'allowed'
let currentApprovalMode = approvalMode
const approvals = []
const approval = () => ({
  async request(request) {
    approvals.push({ toolName: request.toolName, reason: request.reason })
    return currentApprovalMode === 'allowed' ? 'allowed-once' : 'denied'
  },
})

const context = { contextId: 'ctx-test', owner: 'session-a' }
const contexts = {
  activeFor(owner) { return owner === 'session-a' ? context : null },
  get(contextId) { return contextId === 'ctx-test' ? context : null },
  getOwned(contextId, owner) { return contextId === 'ctx-test' && owner === 'session-a' ? context : null },
  create: async () => context,
  driverFor() { return driver },
  driverForOwned(contextId, owner) { return contextId === 'ctx-test' && owner === 'session-a' ? driver : null },
}

function makeTools(extra = {}) {
  return chromeTools({
    bridge: { call: async () => ({}), runWithBackend: (_mode, fn) => fn() },
    attachments: () => null,
    assets: () => ({}),
    approval,
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
    ...extra,
  })
}

function auditEntries() {
  try {
    return fs
      .readFileSync(path.join(home, 'cache', 'dsh-chrome', 'audit.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

const tools = makeTools()
const verify = tools.find((tool) => tool.name === 'chrome_verify')
assert.ok(verify, 'chrome_verify must be registered')

// P7: a failure without checks/duration (early return or thrown before the run
// starts) must show the reason instead of the old "undefinedms, 0 checks".
const earlyFailureRender = verify.output.render({}, { ok: false, error: 'STEPS_REQUIRED' })[0]?.text || ''
assert.match(earlyFailureRender, /STEPS_REQUIRED/, earlyFailureRender)
assert.doesNotMatch(earlyFailureRender, /undefinedms/, earlyFailureRender)
const failedRunRender = verify.output.render(
  {},
  { ok: false, durationMs: 12, checks: [{ id: 'c1', type: 'url', ok: false, message: 'url was about:blank' }], artifacts: [], error: 'PROTECTED_PAGE' },
)[0]?.text || ''
assert.match(failedRunRender, /PROTECTED_PAGE/, failedRunRender)
assert.match(failedRunRender, /12ms/, failedRunRender)

try {
  // H6 target classifier: normalizations WHATWG URL already performs, plus the
  // literal ranges and local-name suffixes the guard must refuse by default.
  assert.equal(classifyTarget('https://example.com/').reason, null)
  assert.equal(classifyTarget('http://127.0.0.1/').reason, 'loopback')
  assert.equal(classifyTarget('http://127.1/').reason, 'loopback')
  assert.equal(classifyTarget('http://2130706433/').reason, 'loopback')
  assert.equal(classifyTarget('http://localhost./').reason, 'loopback')
  assert.equal(classifyTarget('http://app.localhost/').reason, 'loopback')
  assert.equal(classifyTarget('http://10.0.0.1/').reason, 'private')
  assert.equal(classifyTarget('http://172.31.255.254/').reason, 'private')
  assert.equal(classifyTarget('http://192.168.1.1/').reason, 'private')
  assert.equal(classifyTarget('http://100.64.0.1/').reason, 'private')
  assert.equal(classifyTarget('http://169.254.169.254/').reason, 'link-local')
  assert.equal(classifyTarget('http://[::1]/').reason, 'loopback')
  assert.equal(classifyTarget('http://[::ffff:127.0.0.1]/').reason, 'loopback')
  assert.equal(classifyTarget('http://[fe80::1]/').reason, 'link-local')
  assert.equal(classifyTarget('http://[fd00::1]/').reason, 'private')
  assert.equal(classifyTarget('http://nas.local/').reason, 'local-hostname')
  assert.equal(classifyTarget('http://intranet/').reason, 'local-hostname')
  assert.equal(classifyTarget('file:///etc/passwd').http, false)
  assert.equal(targetAllowedByAllowlist(classifyTarget('http://127.0.0.1:8765/'), ['127.0.0.1:8765']), true)
  assert.equal(targetAllowedByAllowlist(classifyTarget('http://127.0.0.1:8766/'), ['127.0.0.1:8765']), false)
  assert.equal(targetAllowedByAllowlist(classifyTarget('http://127.0.0.1:8766/'), ['127.0.0.1']), true)
  assert.equal(targetAllowedByAllowlist(classifyTarget('http://[::1]:8765/'), ['[::1]:8765']), true)

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

  // H6: navigate/click/type each go through the site guard (approval) and the
  // audit log. The actions are labelled with the origin/page being touched.
  const approvalsBefore = approvals.length
  const guarded = await verify.execute({
    steps: [
      { action: 'navigate', url: 'https://example.com/guard' },
      { action: 'click', selector: '#go' },
      { action: 'type', selector: '#name', text: 'Alice' },
    ],
  }, exec)
  assert.equal(guarded.ok, true, JSON.stringify(guarded))
  const guardedApprovals = approvals.slice(approvalsBefore).map((entry) => entry.reason)
  assert.ok(
    guardedApprovals.some((reason) => reason.includes('navigate to https://example.com/guard')),
    JSON.stringify(guardedApprovals),
  )
  assert.ok(
    guardedApprovals.some((reason) => reason.includes('click on https://example.com/guard')),
    JSON.stringify(guardedApprovals),
  )
  assert.ok(
    guardedApprovals.some((reason) => reason.includes('type into https://example.com/guard')),
    JSON.stringify(guardedApprovals),
  )
  const guardedAudit = auditEntries().filter((entry) => entry.tool === 'chrome_verify')
  for (const fragment of ['navigate to https://example.com/guard', 'click on https://example.com/guard', 'type into https://example.com/guard']) {
    assert.ok(
      guardedAudit.some((entry) => String(entry.action).includes(fragment) && entry.decision === 'allowed' && entry.session),
      `missing audit entry for ${fragment}: ${JSON.stringify(guardedAudit.slice(-5))}`,
    )
  }

  // A denied approval must stop the step before the driver sees it.
  currentApprovalMode = 'denied'
  const deniedNavigateBefore = calls.length
  const deniedNavigate = await verify.execute({
    steps: [{ action: 'navigate', url: 'https://example.com/denied' }],
  }, exec)
  assert.equal(deniedNavigate.ok, false)
  assert.equal(deniedNavigate.error, 'APPROVAL_DENIED', JSON.stringify(deniedNavigate))
  assert.equal(calls.slice(deniedNavigateBefore).some((call) => call.method === 'tab.goto'), false)
  assert.ok(auditEntries().some((entry) => entry.decision === 'denied' && entry.reason === 'approval-denied'))
  currentApprovalMode = 'allowed'

  // H6: loopback/link-local/private targets are refused by default, before any
  // navigation and without asking for approval.
  const privateTargets = [
    'http://127.0.0.1:8765/',
    'http://localhost:3000/',
    'http://[::1]:8080/',
    'http://10.1.2.3/',
    'http://172.20.0.1/',
    'http://192.168.1.5/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[fe80::1]/',
    'http://[fd00::1]/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://nas.local/',
    'http://intranet/',
    'http://192.0.2.10/',
  ]
  for (const url of privateTargets) {
    const approvalsInLoop = approvals.length
    const before = calls.length
    const result = await verify.execute({ steps: [{ action: 'navigate', url }] }, exec)
    assert.equal(result.ok, false, `${url} -> ${JSON.stringify(result)}`)
    assert.equal(result.error, 'PROTECTED_PAGE', `${url} -> ${JSON.stringify(result)}`)
    assert.ok(
      result.checks.some((check) => !check.ok && /private|loopback|link-local|local-hostname|reserved|unspecified/.test(String(check.message || ''))),
      `${url} -> ${JSON.stringify(result.checks)}`,
    )
    assert.equal(calls.slice(before).some((call) => call.method === 'tab.goto'), false, url)
    assert.equal(approvals.length, approvalsInLoop, `${url} must be refused before approval`)
  }
  const privateDenied = auditEntries().filter((entry) => String(entry.reason || '').startsWith('private-target:'))
  assert.ok(privateDenied.length >= privateTargets.length, JSON.stringify(privateDenied))

  const fileResult = await verify.execute({ steps: [{ action: 'navigate', url: 'file:///etc/passwd' }] }, exec)
  assert.equal(fileResult.ok, false)
  assert.equal(fileResult.error, 'PROTECTED_PAGE')

  // The allowlist is injected by tests only; it is matched by host and, when a
  // port is present, by the effective port.
  const allowVerify = makeTools({ verifyPrivateAllowlist: ['127.0.0.1:8765'] }).find(
    (tool) => tool.name === 'chrome_verify',
  )
  const allowedPrivate = await allowVerify.execute({
    steps: [{ action: 'navigate', url: 'http://127.0.0.1:8765/' }],
  }, exec)
  assert.equal(allowedPrivate.ok, true, JSON.stringify(allowedPrivate))
  const otherPort = await allowVerify.execute({
    steps: [{ action: 'navigate', url: 'http://127.0.0.1:8766/' }],
  }, exec)
  assert.equal(otherPort.ok, false, JSON.stringify(otherPort))
  assert.equal(otherPort.error, 'PROTECTED_PAGE')

  // A private page that was reached some other way is still refused for
  // click/type: the guard resolves the page from this context's own driver.
  siteUrl = 'http://127.0.0.1:8765/'
  const privateClickBefore = calls.length
  const privateClick = await verify.execute({ steps: [{ action: 'click', selector: '#x' }] }, exec)
  assert.equal(privateClick.ok, false)
  assert.equal(privateClick.error, 'PROTECTED_PAGE')
  assert.equal(calls.slice(privateClickBefore).some((call) => call.method === 'tab.click'), false)
  const privateTypeBefore = calls.length
  const privateType = await verify.execute({ steps: [{ action: 'type', selector: '#y', text: 'secret' }] }, exec)
  assert.equal(privateType.ok, false)
  assert.equal(privateType.error, 'PROTECTED_PAGE')
  assert.equal(calls.slice(privateTypeBefore).some((call) => call.method === 'tab.type'), false)

  // A public URL approved by the guard that redirects to a private one must not
  // become a post-approval local read; the run stops and leaves the page.
  siteUrl = 'https://example.com/'
  redirectUrl = 'http://169.254.169.254/latest/meta-data/'
  const redirectBefore = calls.length
  const redirected = await verify.execute({
    steps: [
      { action: 'navigate', url: 'https://example.com/redirect-me' },
      { action: 'click', selector: '#never' },
    ],
  }, exec)
  assert.equal(redirected.ok, false, JSON.stringify(redirected))
  assert.equal(redirected.error, 'PROTECTED_PAGE')
  const redirectCalls = calls.slice(redirectBefore)
  assert.ok(redirectCalls.some((call) => call.method === 'tab.goto' && call.params.url === 'https://example.com/redirect-me'))
  assert.ok(redirectCalls.some((call) => call.method === 'tab.goto' && call.params.url === 'about:blank'))
  assert.equal(redirectCalls.some((call) => call.method === 'tab.click'), false)

  // H6: console/network entries persisted into the verify report are redacted.
  siteUrl = 'https://example.com/'
  consoleEntries = [
    { level: 'error', text: `password=${REDACT_SENTINEL}` },
    { level: 'error', text: `Authorization: Bearer ${REDACT_SENTINEL}` },
  ]
  networkEntries = [
    { url: `https://example.com/api?token=${REDACT_SENTINEL}&page=1`, status: 200, transferSize: 10 },
    { url: 'https://example.com/ok?page=1', status: 200, transferSize: 10 },
  ]
  const redactionRun = await verify.execute({
    steps: [{ action: 'assert', checks: [{ type: 'text', contains: '完成提交' }] }],
  }, exec)
  assert.equal(redactionRun.ok, true, JSON.stringify(redactionRun))
  const reportPath = redactionRun.artifacts.find((artifact) => artifact.type === 'report')?.path
  assert.ok(reportPath)
  const reportText = fs.readFileSync(reportPath, 'utf8')
  assert.equal(reportText.includes(REDACT_SENTINEL), false, 'verify artifact leaked a secret')
  const report = JSON.parse(reportText)
  assert.ok(report.console.some((entry) => String(entry.text).includes('«redacted»')), reportText)
  assert.ok(report.network.some((entry) => String(entry.url).includes('token=«redacted»')), reportText)
  assert.ok(report.network.some((entry) => String(entry.url).includes('page=1')), reportText)

  console.log('CHROME VERIFY TEST: PASS')
} finally {
  fs.rmSync(artifactDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
}
