/**
 * P1 tool-layer test — no Chrome required.
 *
 * Exercises the 12 chrome_* tools against the real bridge + native host with a
 * fake extension and a fake approval service. Verifies owner propagation and
 * that mutating tools go through approval.
 */
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { BridgeServer } from '../src/bridge.js'
import { chromeTools } from '../src/tools.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-chrome-p1-'))
const bridge = new BridgeServer({ home })

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`)
  else {
    failures += 1
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
function encodeNative(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length, 0)
  return Buffer.concat([header, body])
}
function frameReader(onMessage) {
  let buffer = Buffer.alloc(0)
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      if (buffer.length < 4) return
      const length = buffer.readUInt32LE(0)
      if (buffer.length < 4 + length) return
      const body = buffer.subarray(4, 4 + length)
      buffer = buffer.subarray(4 + length)
      onMessage(JSON.parse(body.toString('utf8')))
    }
  }
}
async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

const requests = []
// H5 fake backend: ref 42 (typing) and key "X" (pressing) model a password
// field. They refuse until the provider retries with `sensitiveApproved`, so
// the test can assert the confirmation boundary rather than a typed result.
const sensitiveTyped = []
let sensitivePressed = 0
await bridge.start()
const host = spawn(process.execPath, [path.join(root, 'host', 'host.mjs')], {
  env: { ...process.env, DSH_HOME: home },
  stdio: ['pipe', 'pipe', 'inherit'],
})
host.stdout.on(
  'data',
  frameReader((message) => {
    if (message.id == null) return
    const { method, params } = message
    requests.push({ method, params })
    const replies = {
      'browser.status': { extensionVersion: 'p1-fake', connected: true },
      'browser.site': { tabId: 7, url: 'https://example.com/', title: 'Example Domain', origin: 'https://example.com' },
      'tab.goto': { tabId: 7, url: params?.url || '', title: 'Example Domain', loadState: 'complete' },
      'tab.snapshot': {
        title: 'Example Domain',
        url: 'https://example.com/',
        controls: [{ ref: 1, tag: 'a', kind: 'link', label: 'Learn more' }],
        text: 'Example Domain body',
        truncated: false,
      },
      'tab.screenshot': { dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' },
      'tab.click': { ok: true, tag: 'button', label: 'Submit', tabId: 7 },
      'tab.type': { ok: true, value: 'hello', submitted: true, tabId: 7 },
      'tab.press': { ok: true, key: 'Enter', target: 'input' },
      'tab.scroll': { ok: true, y: 600, viewportHeight: 800, documentHeight: 2000 },
      'tab.history': { tabId: 7, url: 'https://example.com/', title: 'Example Domain', loadState: 'complete' },
      'tab.wait': { tabId: 7, url: 'https://example.com/', title: 'Example Domain', loadState: 'complete' },
      'tab.console': { available: true, entries: [{ level: 'error', text: 'boom', time: 1 }] },
      'tab.network': { available: true, entries: [{ url: 'https://example.com/a.js', type: 'script', durationMs: 12, transferSize: 340 }] },
      'tab.find': { query: String(params?.query || ''), matches: [{ ref: 1, text: 'Example Domain', tag: 'h1', x: 10, y: 20 }], truncated: false },
      'tab.close_session': { closed: 2 },
    }
    let result = replies[method]
    if (method === 'tab.tabs') {
      if (params?.op === 'list') result = { tabs: [{ tabId: 7, title: 'Example Domain', url: 'https://example.com/', active: true }], groupId: 5 }
      else if (params?.op === 'new') result = { tabId: 9, url: params.url || 'about:blank', title: 'New tab' }
      else result = { closed: params.tabId ?? 9, remaining: 0 }
    }
    if (method === 'tab.type' && params?.ref === 42) {
      if (params?.sensitiveApproved !== true) {
        host.stdin.write(
          encodeNative({
            id: message.id,
            error: { code: 'SENSITIVE_FIELD', message: 'target is a sensitive password field' },
          }),
        )
        return
      }
      sensitiveTyped.push(String(params.text ?? ''))
      result = { ok: true, submitted: false, tabId: 7, sensitive: 'password' }
    }
    if (method === 'tab.press' && params?.key === 'X') {
      if (params?.sensitiveApproved !== true) {
        host.stdin.write(
          encodeNative({
            id: message.id,
            error: { code: 'SENSITIVE_FIELD', message: 'key press targets a sensitive password field' },
          }),
        )
        return
      }
      sensitivePressed += 1
      result = { ok: true, key: 'X', target: 'input', sensitive: 'password' }
    }
    host.stdin.write(
      encodeNative(
        result
          ? { id: message.id, result }
          : { id: message.id, error: { code: 'UNSUPPORTED', message: `p1 fake: ${method}` } },
      ),
    )
  }),
)
await waitFor(() => bridge.connected, 5000, 'host authentication')

let approvalMode = 'allowed-once'
const approvalCalls = []
const approvalService = {
  request: async (request) => {
    approvalCalls.push(request)
    return approvalMode
  },
}

// H5 hard confirmation. Its card must never echo the text being typed.
let confirmMode = 'allowed'
const confirmations = []
const userQuestions = () => ({
  ask: async (request) => {
    const question = request?.questions?.[0] || {}
    confirmations.push({
      header: String(question.header || ''),
      question: String(question.question || ''),
      detail: String(question.detail || ''),
    })
    return { answers: [{ id: 'confirm', selected: [confirmMode === 'allowed' ? '允许一次' : '拒绝'] }] }
  },
})

const tools = chromeTools({
  bridge,
  attachments: () => null,
  assets: () => ({ extensionId: 'test', extensionDir: '/tmp/ext', nativeManifestPath: '/tmp/nm', instructionsPath: '/tmp/i.md' }),
  approval: () => approvalService,
  userQuestions,
  config: () => ({ evaluateConfirmTimeoutMs: 5000 }),
})
const byName = Object.fromEntries(tools.map((definition) => [definition.name, definition]))
check('forty-six tools registered', tools.length === 46, tools.map((t) => t.name).join(', '))

const sessionId = 'session-test-abcdef'
const exec = () => ({
  agent: { id: sessionId },
  callId: 'call-1',
  signal: new AbortController().signal,
})

const click = await byName.chrome_click.execute({ ref: 1 }, exec())
check('chrome_click executes', click.ok === true && click.tag === 'button')
check('owner propagates to the extension', requests.at(-1)?.params?.owner === sessionId)
check('click went through approval', approvalCalls.at(-1)?.toolName === 'chrome_click')

const type = await byName.chrome_type.execute({ ref: 2, text: 'hello', replace: true, submit: true }, exec())
check('chrome_type executes', type.submitted === true)
check('chrome_type never returns the field value', !Object.hasOwn(type, 'value'), JSON.stringify(type))
check('type params reach the extension', requests.at(-1)?.params?.text === 'hello' && requests.at(-1)?.params?.submit === true)

const press = await byName.chrome_press.execute({ key: 'Enter' }, exec())
check('chrome_press executes', press.key === 'Enter')

// Sensitive field: one hard confirmation, then a retry carrying the per-call
// approval flag. The typed text is never echoed in the result or the card.
const SENTINEL = 'DSH_SENTINEL_PASSWORD_DO_NOT_USE'
const beforeSensitive = requests.length
const confirmationsBefore = confirmations.length
const sensitive = await byName.chrome_type.execute({ ref: 42, text: SENTINEL, replace: true }, exec())
check('sensitive type asks exactly one hard confirmation', confirmations.length === confirmationsBefore + 1)
const sensitiveCard = confirmations.at(-1)
check(
  'sensitive confirmation names the field class and target origin',
  sensitiveCard.header.includes('敏感字段') &&
    sensitiveCard.question.includes('https://example.com') &&
    sensitiveCard.question.includes('密码/OTP/支付'),
  JSON.stringify(sensitiveCard),
)
check(
  'sensitive confirmation and result never echo the typed text',
  JSON.stringify(sensitiveCard).includes(SENTINEL) === false &&
    JSON.stringify(sensitive).includes(SENTINEL) === false,
)
const sensitiveRequests = requests.slice(beforeSensitive).filter((request) => request.method === 'tab.type')
check(
  'sensitive type first refuses then retries with sensitiveApproved',
  sensitiveRequests.length === 2 &&
    sensitiveRequests[0].params.sensitiveApproved !== true &&
    sensitiveRequests[1].params.sensitiveApproved === true,
  JSON.stringify(sensitiveRequests.map((request) => request.params?.sensitiveApproved)),
)
check('only the approved retry reaches the fake password field', sensitiveTyped.length === 1 && sensitiveTyped[0] === SENTINEL)
check('sensitive type result carries no field value', sensitive.sensitive === 'password' && !Object.hasOwn(sensitive, 'value'))

confirmMode = 'denied'
const deniedTypedBefore = sensitiveTyped.length
const deniedRequestsBefore = requests.length
let sensitiveDenied = null
try {
  await byName.chrome_type.execute({ ref: 42, text: SENTINEL, replace: true }, exec())
} catch (error) {
  sensitiveDenied = error
}
check('a denied sensitive confirmation fails closed', sensitiveDenied?.code === 'APPROVAL_DENIED', String(sensitiveDenied?.code))
check(
  'a denied sensitive confirmation never retries with approval',
  requests
    .slice(deniedRequestsBefore)
    .filter((request) => request.method === 'tab.type')
    .every((request) => request.params.sensitiveApproved !== true),
)
check('a denied sensitive confirmation types nothing', sensitiveTyped.length === deniedTypedBefore)
check('the denial error never echoes the typed text', String(sensitiveDenied?.message || '').includes(SENTINEL) === false)
confirmMode = 'allowed'

const confirmationsBeforePress = confirmations.length
const sensitivePress = await byName.chrome_press.execute({ key: 'X' }, exec())
check(
  'sensitive press confirms once and retries with approval',
  confirmations.length === confirmationsBeforePress + 1 && sensitivePress.sensitive === 'password' && sensitivePressed === 1,
  JSON.stringify(sensitivePress),
)

const scroll = await byName.chrome_scroll.execute({ direction: 'down', amount: 500 }, exec())
check('chrome_scroll executes', scroll.y === 600)

const history = await byName.chrome_history.execute({ op: 'back' }, exec())
check('chrome_history executes', history.url === 'https://example.com/')

const tabsList = await byName.chrome_tabs.execute({ op: 'list' }, exec())
check('chrome_tabs list executes', Array.isArray(tabsList.tabs) && tabsList.tabs[0].tabId === 7)
const tabsNew = await byName.chrome_tabs.execute({ op: 'new', url: 'https://example.com/' }, exec())
check('chrome_tabs new executes', tabsNew.tabId === 9)
const tabsClose = await byName.chrome_tabs.execute({ op: 'close', tabId: 9 }, exec())
check('chrome_tabs close executes', tabsClose.closed === 9)

const wait = await byName.chrome_wait.execute({ until: 'text', text: 'Example' }, exec())
check('chrome_wait executes', wait.loadState === 'complete')

const closed = await byName.chrome_close_session.execute({}, exec())
check('chrome_close_session executes', closed.closed === 2)

// Approval denial must fail closed and must not reach the extension.
approvalMode = 'rejected'
const before = requests.length
let denied = false
try {
  await byName.chrome_click.execute({ ref: 3 }, exec())
} catch (error) {
  denied = error?.code === 'APPROVAL_DENIED'
}
check('approval rejection fails closed', denied)
check(
  'rejected action never reaches the extension',
  requests.slice(before).every((request) => request.method === 'browser.site'),
)

host.kill('SIGTERM')
await bridge.stop()
await fsp.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {})

console.log(failures === 0 ? '\nP1 TOOLS TEST: PASS' : `\nP1 TOOLS TEST: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
