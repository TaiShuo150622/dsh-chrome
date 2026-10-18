/**
 * P2 tool test — chrome_find + clip screenshots. No Chrome required.
 */
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { BridgeServer } from '../src/bridge.js'
import { chromeTools } from '../src/tools.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-chrome-p2-'))
process.env.DSH_HOME = home
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
    requests.push({ method: message.method, params: message.params })
    const replies = {
      'browser.status': { extensionVersion: 'p2-fake', connected: true },
      'browser.site': { tabId: 7, url: 'http://127.0.0.1:8765/', title: 'DSH Test', origin: 'http://127.0.0.1:8765' },
      'tab.screenshot': { dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' },
      'tab.hover': { ok: true, tag: 'button', label: 'Menu', tabId: 7 },
      'tab.click': { ok: true, tag: 'button', label: 'Submit', tabId: 7, dialogs: [{ type: 'confirm', message: 'ok?', accepted: true }] },
      'tab.tabs': { claimed: true, tabId: 7, url: 'https://example.com/', title: 'Example Domain', remaining: 0 },
      'tab.claim': { tabId: 7, url: 'https://example.com/', title: 'Example Domain', claimed: true },
      'tab.upload': { ok: true, ref: 5, files: 1 },
      'browser.downloads': { items: [{ id: 1, filename: '/tmp/report.pdf', url: 'https://example.com/report.pdf', state: 'complete', bytesReceived: 1024, totalBytes: 1024, startTime: '2026-10-17T09:00:00.000Z' }] },
      'tab.select': { ok: true, tag: 'input', value: 'checked' },
      'tab.resume': { ok: true, tabId: 7 },
      'tab.pick_start': { started: true, alreadyActive: false, tabId: 7 },
      'tab.pick_status': { available: true, active: false, done: true, canceled: false, result: { ref: 3, selector: '#greet', text: 'Greet', tag: 'button', box: [1, 2, 3, 4] } },
      'tab.pick_cancel': { ok: true, wasActive: false },
      'tab.capture_start': { captureId: 'cap-1', tabId: 7, startedAt: '2026-10-17T10:00:00.000Z', active: true, maxEntries: 300, resourceTypes: ['xhr', 'fetch', 'document'] },
      'tab.capture_stop': { captureId: 'cap-1', tabId: 7, startedAt: '2026-10-17T10:00:00.000Z', endedAt: '2026-10-17T10:00:12.000Z', durationMs: 12000, requests: 1, dropped: 0, bodiesDropped: 0, active: false, endedReason: 'stopped' },
      'tab.capture_requests': { available: true, lost: false, active: true, captureId: 'cap-1', tabId: 7, entries: [{ id: 'r1', method: 'POST', url: 'https://api.test/x?access_token=«redacted»', status: 200, mimeType: 'application/json', resourceType: 'Fetch', durationMs: 5, requestBody: '{"token":"«redacted»"}', responseBody: '{"token":"«redacted»"}', redacted: true }], total: 1, truncated: false, dropped: 0, bodiesDropped: 0 },
      'tab.evaluate': { ok: true, value: 2, type: 'number' },
      'tab.frames': { tabId: 7, frames: [{ frameId: 'main', parentFrameId: null, url: 'http://127.0.0.1:8765/iframe.html' }] },
      'tab.selection': { found: true, text: 'selected paragraph', url: 'http://127.0.0.1:8765/selection.html', title: 'DSH Selection Test Page', truncated: false, source: 'page' },
      'tab.html': { found: true, mode: 'simplified', html: '<div id="api" value="••••">x</div>', truncated: false, length: 42 },
      'tab.clickAt': { ok: true, x: 50, y: 60, tag: 'canvas', label: '' },
      'tab.storage': { ok: true, scope: 'local', value: 'hello' },
      'tab.drag': { ok: true, from: 1, to: 2, tabId: 7 },
      'tab.emulate': { width: 375, height: 800, applied: true },
      'tab.pdf': { dataBase64: Buffer.from('%PDF-1.4\n%%EOF\n').toString('base64') },
      'tab.a11y': { total: 2, truncated: false, nodes: [{ role: 'button', name: 'Submit' }, { role: 'textbox', name: 'Name' }] },
      'tab.get_text': { found: true, text: 'Example Domain body', truncated: false },
      'tab.console': { available: true, entries: [{ level: 'error', text: 'boom', time: 1 }] },
      'tab.network': { available: true, entries: [{ url: 'https://example.com/a.js', type: 'script', durationMs: 12, transferSize: 340, status: 200 }] },
      'tab.find': {
        query: String(message.params?.query || ''),
        matches: [
          { ref: 901, text: 'Example Domain', tag: 'h1', x: 120, y: 48 },
          { ref: 902, text: 'This domain is for use in illustrative examples', tag: 'p', x: 200, y: 96 },
        ],
        truncated: false,
      },
    }
    const result = replies[message.method]
    host.stdin.write(
      encodeNative(
        result
          ? { id: message.id, result }
          : { id: message.id, error: { code: 'UNSUPPORTED', message: `p2 fake: ${message.method}` } },
      ),
    )
  }),
)
await waitFor(() => bridge.connected, 5000, 'host authentication')

const approvalCalls = []
const tools = chromeTools({
  bridge,
  attachments: () => null,
  assets: () => ({ extensionId: 'test', extensionDir: '/tmp/ext', nativeManifestPath: '/tmp/nm', instructionsPath: '/tmp/i.md' }),
  approval: () => ({ request: async (request) => (approvalCalls.push(request), 'allowed-once') }),
})
const byName = Object.fromEntries(tools.map((definition) => [definition.name, definition]))
check('thirty-seven tools registered', tools.length === 37, tools.map((t) => t.name).join(', '))
check('chrome_find registered', Boolean(byName.chrome_find))

const exec = () => ({ agent: { id: 'session-p2' }, callId: 'call-1', signal: new AbortController().signal })

const found = await byName.chrome_find.execute({ query: 'Example', maxResults: 5 }, exec())
check('chrome_find executes', Array.isArray(found.matches) && found.matches.length === 2)
check('find query reaches the extension', requests.at(-1)?.method === 'tab.find' && requests.at(-1)?.params?.query === 'Example')
check('find maxResults reaches the extension', requests.at(-1)?.params?.maxResults === 5)
const rendered = byName.chrome_find.output.render({ query: 'Example' }, found)
check('find render lists matches', /ref 901/.test(rendered[0]?.text || ''))

const shot = await byName.chrome_screenshot.execute({ clip: { x: 10, y: 20, width: 300, height: 200 } }, exec())
check('clip screenshot executes', Boolean(shot?.path))
check('clip envelope reaches the extension', requests.at(-1)?.method === 'tab.screenshot' && requests.at(-1)?.params?.clip?.width === 300)

const hovered = await byName.chrome_hover.execute({ ref: 2 }, exec())
check('chrome_hover executes', hovered.ok === true && hovered.tag === 'button')
check('hover params reach the extension', requests.at(-1)?.method === 'tab.hover' && requests.at(-1)?.params?.ref === 2)

const clickWithDialog = await byName.chrome_click.execute({ ref: 1, dialog: { accept: true } }, exec())
check('click dialog option reaches the extension', requests.at(-1)?.params?.dialog?.accept === true)
check('click returns captured dialogs', clickWithDialog.dialogs?.[0]?.type === 'confirm')

let emptyUploadRejected = false
try {
  await byName.chrome_upload.execute({ ref: 5, files: [] }, exec())
} catch (error) {
  emptyUploadRejected = error?.code === 'INVALID_ARGUMENT'
}
check('upload rejects empty file list', emptyUploadRejected)

let missingUploadRejected = false
try {
  await byName.chrome_upload.execute({ ref: 5, files: [path.join(home, 'missing.bin')] }, exec())
} catch (error) {
  missingUploadRejected = error?.code === 'INVALID_ARGUMENT'
}
check('upload rejects missing local file', missingUploadRejected)

const uploadPath = path.join(home, 'upload.txt')
await fsp.writeFile(uploadPath, 'hello')
const uploadValue = await byName.chrome_upload.execute({ ref: 5, files: [uploadPath] }, exec())
check('chrome_upload executes', uploadValue.ok === true && uploadValue.files === 1)
check('upload params reach the extension', requests.at(-1)?.method === 'tab.upload' && requests.at(-1)?.params?.ref === 5)

const downloadValue = await byName.chrome_download.execute({ limit: 5 })
check('chrome_download executes', downloadValue.items?.[0]?.filename === '/tmp/report.pdf')
check('downloads limit reaches the extension', requests.at(-1)?.method === 'browser.downloads' && requests.at(-1)?.params?.limit === 5)

const claimValue = await byName.chrome_tabs.execute({ op: 'claim', tabId: 7 }, exec())
check('chrome_tabs claim executes', claimValue.claimed === true && claimValue.tabId === 7)
check('claim params reach the extension', requests.at(-1)?.method === 'tab.tabs' && requests.at(-1)?.params?.op === 'claim')

const selectValue = await byName.chrome_select.execute({ ref: 4, checked: true }, exec())
check('chrome_select executes', selectValue.ok === true && selectValue.value === 'checked')
check('select params reach the extension', requests.at(-1)?.method === 'tab.select' && requests.at(-1)?.params?.checked === true)

const framesValue = await byName.chrome_frames.execute({ probe: true }, exec())
check('chrome_frames lists frames', Array.isArray(framesValue?.frames) && framesValue.frames.length === 1)
check('frames params reach the extension', requests.at(-1)?.method === 'tab.frames' && requests.at(-1)?.params?.probe === true)

const selectionValue = await byName.chrome_selection.execute({}, exec())
check('chrome_selection reads a selection', selectionValue?.found === true && selectionValue.text.includes('selected'))
check('selection params reach the extension', requests.at(-1)?.method === 'tab.selection')

const htmlValue = await byName.chrome_html.execute({ selector: '#api', mode: 'simplified' }, exec())
check('chrome_html executes', htmlValue?.found === true && htmlValue.html.includes('api'))
check('html params reach the extension', requests.at(-1)?.method === 'tab.html' && requests.at(-1)?.params?.mode === 'simplified')

const clickAtValue = await byName.chrome_click_at.execute({ x: 50, y: 60 }, exec())
check('chrome_click_at executes', clickAtValue?.ok === true && clickAtValue?.x === 50)
check('click_at params reach the extension', requests.at(-1)?.method === 'tab.clickAt' && requests.at(-1)?.params?.y === 60)

const storageValue = await byName.chrome_storage.execute({ op: 'get', key: 'k' }, exec())
check('chrome_storage get executes', storageValue.value === 'hello')
check('storage params reach the extension', requests.at(-1)?.method === 'tab.storage' && requests.at(-1)?.params?.op === 'get')

const dragValue = await byName.chrome_drag.execute({ fromRef: 1, toRef: 2 }, exec())
check('chrome_drag executes', dragValue.ok === true)
check('drag params reach the extension', requests.at(-1)?.method === 'tab.drag' && requests.at(-1)?.params?.fromRef === 1)

const emulateValue = await byName.chrome_emulate.execute({ width: 375, height: 800 }, exec())
check('chrome_emulate executes', emulateValue.applied === true && emulateValue.width === 375)
check('emulate params reach the extension', requests.at(-1)?.method === 'tab.emulate' && requests.at(-1)?.params?.height === 800)

const pdfPath = path.join(home, 'page.pdf')
const pdfValue = await byName.chrome_pdf.execute({ path: pdfPath }, exec())
check('chrome_pdf writes a pdf file', pdfValue?.path === pdfPath && pdfValue.bytes > 0)
check('pdf path reaches the extension', requests.at(-1)?.method === 'tab.pdf')

const a11yValue = await byName.chrome_a11y.execute({ limit: 100 }, exec())
check('chrome_a11y executes', a11yValue.nodes?.[0]?.role === 'button')
check('a11y limit reaches the extension', requests.at(-1)?.method === 'tab.a11y' && requests.at(-1)?.params?.limit === 100)

const textValue = await byName.chrome_get_text.execute({ selector: 'main', maxChars: 1000 }, exec())
check('chrome_get_text executes', textValue.found === true && textValue.text === 'Example Domain body')
check('get_text selector reaches the extension', requests.at(-1)?.method === 'tab.get_text' && requests.at(-1)?.params?.selector === 'main')

const consoleValue = await byName.chrome_console.execute({ level: 'error', limit: 10, filter: 'boom' }, exec())
check('chrome_console executes', consoleValue.available === true && consoleValue.entries?.[0]?.text === 'boom')
check('console level/filter reach the extension', requests.at(-1)?.method === 'tab.console' && requests.at(-1)?.params?.level === 'error' && requests.at(-1)?.params?.filter === 'boom')
const consoleRender = byName.chrome_console.output.render({}, consoleValue)
check('console render lists entries', /\[error\] boom/.test(consoleRender[0]?.text || ''))

const networkValue = await byName.chrome_network.execute({ filter: 'a.js', limit: 5 }, exec())
check('network status is returned', networkValue.entries?.[0]?.status === 200)
check('chrome_network executes', networkValue.entries?.[0]?.url === 'https://example.com/a.js')
check('network filter reaches the extension', requests.at(-1)?.params?.filter === 'a.js')

// D4: screenshot history is filesystem-backed
const shotsDir = path.join(home, 'cache', 'dsh-chrome', 'screenshots')
await fsp.mkdir(shotsDir, { recursive: true })
const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const shotFile = path.join(shotsDir, 'test-shot.png')
await fsp.writeFile(shotFile, tinyPng)
const shotsList = await byName.chrome_shots.execute({ op: 'list', limit: 5 }, exec())
check('chrome_shots lists saved screenshots', shotsList?.entries?.some((entry) => entry.path === shotFile))
const listed = shotsList.entries.find((entry) => entry.path === shotFile)
check('chrome_shots parses PNG dimensions', listed?.width === 1 && listed?.height === 1)
const shotRead = await byName.chrome_shots.execute({ op: 'read', path: shotFile }, exec())
check('chrome_shots reads a screenshot', shotRead?.bytes === tinyPng.length && shotRead?.width === 1)
let outsideCode = null
try {
  await byName.chrome_shots.execute({ op: 'read', path: '/tmp/not-a-shot.txt' }, exec())
} catch (error) {
  outsideCode = error?.code
}
check('chrome_shots rejects paths outside the screenshots dir', outsideCode === 'INVALID_ARGUMENT')

// D3: chrome_resume dispatches to the extension
const resumeValue = await byName.chrome_resume.execute({}, exec())
check('chrome_resume resumes the session', resumeValue?.ok === true && resumeValue?.tabId === 7)
check('resume reaches the extension', requests.at(-1)?.method === 'tab.resume')

// D2: chrome_pick returns a usable ref and can be canceled
const pickValue = await byName.chrome_pick.execute({ timeoutMs: 3000 }, exec())
check('chrome_pick returns ref/selector/text', pickValue?.ref === 3 && pickValue?.selector === '#greet' && pickValue?.text === 'Greet')
check('chrome_pick starts pick mode in the extension', requests.some((request) => request.method === 'tab.pick_start'))

const cancelValue = await byName.chrome_pick.execute({ cancel: true }, exec())
check('chrome_pick cancel returns canceled', cancelValue?.canceled === true)
check('chrome_pick cancel reaches the extension', requests.at(-1)?.method === 'tab.pick_cancel')

// D1: site policy allow/block + audit
const policyDir = path.join(home, 'cache', 'dsh-chrome')
await fsp.mkdir(policyDir, { recursive: true })
const policyFile = path.join(policyDir, 'policy.json')
const auditFile = path.join(policyDir, 'audit.jsonl')
await fsp.writeFile(
  policyFile,
  JSON.stringify({ origins: { 'http://127.0.0.1:8765': 'allow' } }),
)
const policyTools = chromeTools({
  bridge,
  attachments: () => null,
  assets: () => ({ extensionId: 'test', extensionDir: '/tmp/ext', nativeManifestPath: '/tmp/nm', instructionsPath: '/tmp/i.md' }),
  approval: () => ({ request: async (request) => (approvalCalls.push(request), 'allowed-once') }),
})
const policyByName = Object.fromEntries(policyTools.map((definition) => [definition.name, definition]))
const approvalsBeforeAllow = approvalCalls.length
const requestsBeforeAllow = requests.length
await policyByName.chrome_click.execute({ ref: 1 }, exec())
check('allowed site skips session approval', approvalCalls.length === approvalsBeforeAllow)
check(
  'allowed site still reaches the extension',
  requests.slice(requestsBeforeAllow).some((request) => request.method === 'tab.click'),
)
const auditText = await fsp.readFile(auditFile, 'utf8')
check('allowed site writes an audit entry', auditText.includes('site-allow') && auditText.includes('127.0.0.1:8765'))

const policyValue = await policyByName.chrome_policy.execute({}, exec())
check('chrome_policy reports the effective mode', policyValue?.mode === 'allow' && policyValue?.source === 'policy.json')
const auditValue = await policyByName.chrome_audit.execute({ limit: 5 }, exec())
check('chrome_audit returns recent decisions', auditValue?.entries?.length >= 1 && auditValue.entries[0].decision === 'allowed')

await fsp.writeFile(policyFile, JSON.stringify({ origins: { 'http://127.0.0.1:8765': 'block' } }))
const blockedTools = chromeTools({
  bridge,
  attachments: () => null,
  assets: () => ({ extensionId: 'test', extensionDir: '/tmp/ext', nativeManifestPath: '/tmp/nm', instructionsPath: '/tmp/i.md' }),
  approval: () => ({ request: async (request) => (approvalCalls.push(request), 'allowed-once') }),
})
const blockedByName = Object.fromEntries(blockedTools.map((definition) => [definition.name, definition]))
const requestsBeforeBlocked = requests.length
let blockedCode = null
try {
  await blockedByName.chrome_click.execute({ ref: 1 }, exec())
} catch (error) {
  blockedCode = error?.code
}
check('blocked site returns SITE_BLOCKED', blockedCode === 'SITE_BLOCKED')
check(
  'blocked site never reaches the extension',
  requests.slice(requestsBeforeBlocked).every((request) => request.method === 'browser.site'),
)

// C2a: capture tools are always registered; start is hard-confirmed
check('chrome_capture_start registered', Boolean(byName.chrome_capture_start))
let captureStartCode = null
try {
  await byName.chrome_capture_start.execute({ maxEntries: 10 }, exec())
} catch (error) {
  captureStartCode = error?.code
}
check('capture start fails closed without a confirmation service', captureStartCode === 'APPROVAL_DENIED')

const captureTools = chromeTools({
  bridge,
  attachments: () => null,
  assets: () => ({ extensionId: 'test', extensionDir: '/tmp/ext', nativeManifestPath: '/tmp/nm', instructionsPath: '/tmp/i.md' }),
  userQuestions: () => ({ ask: async () => ({ answers: [{ id: 'confirm', selected: ['允许一次'] }] }) }),
  config: () => ({ captureConfirm: 'hard', captureConfirmTimeoutMs: 5000 }),
})
const captureByName = Object.fromEntries(captureTools.map((definition) => [definition.name, definition]))
const captureStart = await captureByName.chrome_capture_start.execute({ maxEntries: 10 }, exec())
check('capture start executes after confirmation', captureStart?.captureId === 'cap-1' && captureStart?.active === true)
check('capture start params reach the extension', requests.at(-1)?.method === 'tab.capture_start' && requests.at(-1)?.params?.maxEntries === 10)

const captureStop = await captureByName.chrome_capture_stop.execute({}, exec())
check('capture stop freezes the buffer', captureStop?.active === false && captureStop?.requests === 1)
check('capture stop reaches the extension', requests.at(-1)?.method === 'tab.capture_stop')

const captureRequests = await captureByName.chrome_capture_requests.execute({ limit: 5, filter: 'api', includeBodies: false, maxBodyChars: 256 }, exec())
check('capture requests returns metadata entries', captureRequests?.entries?.[0]?.method === 'POST' && captureRequests?.entries?.[0]?.status === 200)
check(
  'capture filter/limit/body params reach the extension',
  requests.at(-1)?.method === 'tab.capture_requests' &&
    requests.at(-1)?.params?.limit === 5 &&
    requests.at(-1)?.params?.filter === 'api' &&
    requests.at(-1)?.params?.includeBodies === false &&
    requests.at(-1)?.params?.maxBodyChars === 256,
)

// C1: chrome_evaluate is gated by config and hard-confirmed every call
const evalTools = (config, questions) =>
  chromeTools({
    bridge,
    attachments: () => null,
    assets: () => ({ extensionId: 'test', extensionDir: '/tmp/ext', nativeManifestPath: '/tmp/nm', instructionsPath: '/tmp/i.md' }),
    userQuestions: () => questions,
    config: () => config,
  })

const gatedTools = evalTools({ allowEvaluate: false }, null)
check('evaluate is not registered by default', !gatedTools.some((definition) => definition.name === 'chrome_evaluate'))

const allowTools = evalTools(
  { allowEvaluate: true, evaluateConfirmTimeoutMs: 5000 },
  { ask: async () => ({ answers: [{ id: 'confirm', selected: ['允许一次'] }] }) },
)
const allowByName = Object.fromEntries(allowTools.map((definition) => [definition.name, definition]))
check('enabling allowEvaluate registers chrome_evaluate', allowTools.length === 38 && Boolean(allowByName.chrome_evaluate))
const evalValue = await allowByName.chrome_evaluate.execute({ expression: '1 + 1' }, exec())
check('evaluate returns the CDP value', evalValue?.value === 2 && evalValue?.type === 'number')
check('evaluate params reach the extension', requests.at(-1)?.method === 'tab.evaluate' && requests.at(-1)?.params?.expression === '1 + 1')

const denyTools = evalTools(
  { allowEvaluate: true, evaluateConfirmTimeoutMs: 5000 },
  { ask: async () => ({ answers: [{ id: 'confirm', selected: ['拒绝'] }] }) },
)
const denyByName = Object.fromEntries(denyTools.map((definition) => [definition.name, definition]))
let denyCode = null
try {
  await denyByName.chrome_evaluate.execute({ expression: 'document.title' }, exec())
} catch (error) {
  denyCode = error?.code
}
check('denied confirmation returns APPROVAL_DENIED', denyCode === 'APPROVAL_DENIED')

const noServiceByName = Object.fromEntries(
  evalTools({ allowEvaluate: true }, null).map((definition) => [definition.name, definition]),
)
let noServiceCode = null
try {
  await noServiceByName.chrome_evaluate.execute({ expression: '1' }, exec())
} catch (error) {
  noServiceCode = error?.code
}
check('missing confirmation service fails closed', noServiceCode === 'APPROVAL_DENIED')

const delegatedTools = evalTools(
  { allowEvaluate: true, evaluateConfirmTimeoutMs: 5000 },
  {
    ask: async () => {
      const error = new Error('delegated')
      error.code = 'DELEGATED_CALLER'
      throw error
    },
  },
)
const delegatedByName = Object.fromEntries(delegatedTools.map((definition) => [definition.name, definition]))
let delegatedCode = null
try {
  await delegatedByName.chrome_evaluate.execute({ expression: '1' }, exec())
} catch (error) {
  delegatedCode = error?.code
}
check('delegated caller is rejected explicitly', delegatedCode === 'DELEGATED_CALLER')

host.kill('SIGTERM')
await bridge.stop()
await fsp.rm(home, { recursive: true, force: true })

console.log(failures === 0 ? '\nP2 TOOLS TEST: PASS' : `\nP2 TOOLS TEST: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
