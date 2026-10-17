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

const tools = chromeTools({
  bridge,
  attachments: () => null,
  assets: () => ({ extensionId: 'test', extensionDir: '/tmp/ext', nativeManifestPath: '/tmp/nm', instructionsPath: '/tmp/i.md' }),
  approval: () => approvalService,
})
const byName = Object.fromEntries(tools.map((definition) => [definition.name, definition]))
check('twenty-two tools registered', tools.length === 22, tools.map((t) => t.name).join(', '))

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
check('chrome_type executes', type.value === 'hello' && type.submitted === true)
check('type params reach the extension', requests.at(-1)?.params?.text === 'hello' && requests.at(-1)?.params?.submit === true)

const press = await byName.chrome_press.execute({ key: 'Enter' }, exec())
check('chrome_press executes', press.key === 'Enter')

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
check('rejected action never reaches the extension', requests.length === before)

host.kill('SIGTERM')
await bridge.stop()
await fsp.rm(home, { recursive: true, force: true })

console.log(failures === 0 ? '\nP1 TOOLS TEST: PASS' : `\nP1 TOOLS TEST: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
