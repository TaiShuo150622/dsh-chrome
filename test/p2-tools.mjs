/**
 * P2 tool test — chrome_find, clip screenshots and backend capability gating.
 * No Chrome required.
 */
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { BridgeServer } from '../src/bridge.js'
import { chromeTools } from '../src/tools.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-chrome-p2-'))
process.env.DSH_HOME = home
const bridge = new BridgeServer({ home })

// The provider passes a BackendRouter as `bridge`; its supports() answers for the
// backend carried by AsyncLocalStorage. This fake starts with the full
// desktop-equivalent set and individual checks narrow it.
const supportedCapabilities = new Set([
  'frames',
  'shadow',
  'capture',
  'upload',
  'download',
  'pick',
  'screencast',
  'tabs',
  'pause',
  'evaluate',
])
const supportChecks = []
bridge.supports = (capability) => {
  supportChecks.push(capability)
  return supportedCapabilities.has(capability)
}

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
let fakeScreencastActive = true
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
      'tab.goto': { tabId: 7, url: String(message.params?.url || ''), title: 'Navigated', loadState: 'complete' },
      'tab.screenshot': { dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' },
      'tab.hover': { ok: true, tag: 'button', label: 'Menu', tabId: 7 },
      'tab.click': { ok: true, tag: 'button', label: 'Submit', tabId: 7, dialogs: [{ type: 'confirm', message: 'ok?', accepted: true }] },
      'tab.tabs': { claimed: true, tabId: 7, url: 'https://example.com/', title: 'Example Domain', remaining: 0 },
      'tab.claim': { tabId: 7, url: 'https://example.com/', title: 'Example Domain', claimed: true },
      'tab.upload': { ok: true, ref: 5, files: 1 },
      'browser.downloads': { items: [{ id: 1, filename: '/tmp/report.pdf', url: 'https://example.com/report.pdf', state: 'complete', bytesReceived: 1024, totalBytes: 1024, startTime: '2026-10-17T09:00:00.000Z' }] },
      'tab.select': { ok: true, tag: 'input', value: 'checked' },
      'tab.screencast_start': { active: true, alreadyActive: false, tabId: 7, format: 'jpeg' },
      'tab.screencast_stop': { active: false, tabId: 7, frames: 12, elapsedMs: 3000 },
      'tab.screencast_status': { active: fakeScreencastActive, tabId: 7, frames: 12, startedAt: '2026-10-17T10:00:00.000Z', lastAt: '2026-10-17T10:00:03.000Z', format: 'jpeg' },
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
    if (message.method === 'browser.site') {
      // R-01: the fake answers for the *requested* tab, so a policy decision
      // can be tied to the target object rather than the active page.
      const tabId = Number.isFinite(message.params?.tabId) ? message.params.tabId : 7
      const site =
        tabId === 8
          ? { tabId: 8, url: 'https://blocked.example/', title: 'Blocked', origin: 'https://blocked.example' }
          : tabId === 9
            ? { tabId: 9, url: 'https://allowed.example/', title: 'Allowed', origin: 'https://allowed.example' }
            : { tabId: 7, url: 'http://127.0.0.1:8765/', title: 'DSH Test', origin: 'http://127.0.0.1:8765' }
      host.stdin.write(encodeNative({ id: message.id, result: site }))
      return
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
const uploadConfirmations = []
const sessionContext = () => ({
  sessions: { get: () => ({ header: { cwd: home } }) },
})
const tools = chromeTools({
  bridge,
  attachments: () => null,
  assets: () => ({ extensionId: 'test', extensionDir: '/tmp/ext', nativeManifestPath: '/tmp/nm', instructionsPath: '/tmp/i.md' }),
  approval: () => ({ request: async (request) => (approvalCalls.push(request), 'allowed-once') }),
  sessionContext,
  userQuestions: () => ({
    async ask(request) {
      uploadConfirmations.push(request)
      return { answers: [{ id: 'confirm', selected: ['允许一次'] }] }
    },
  }),
})
const byName = Object.fromEntries(tools.map((definition) => [definition.name, definition]))
check('forty-five tools registered', tools.length === 45, tools.map((t) => t.name).join(', '))
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
const lastUploadConfirm = uploadConfirmations.at(-1)
check(
  'R-04 upload always asks a hard confirmation that names the file and the site',
  String(lastUploadConfirm?.questions?.[0]?.header || '').includes('上传') &&
    String(lastUploadConfirm?.questions?.[0]?.question || '').includes(uploadPath) &&
    String(lastUploadConfirm?.questions?.[0]?.question || '').includes('127.0.0.1:8765'),
  JSON.stringify(lastUploadConfirm?.questions?.[0]?.question || ''),
)

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

// P1-4: headless screenshots live under cache/dsh-chrome/headless/screenshots;
// chrome_shots scans both roots for list and read.
const headlessShotsDir = path.join(home, 'cache', 'dsh-chrome', 'headless', 'screenshots')
await fsp.mkdir(headlessShotsDir, { recursive: true })
const headlessShotFile = path.join(headlessShotsDir, 'headless-shot.png')
await fsp.writeFile(headlessShotFile, tinyPng)
const mergedShots = await byName.chrome_shots.execute({ op: 'list', limit: 10 }, exec())
check(
  'chrome_shots lists desktop and headless screenshots',
  mergedShots?.entries?.some((entry) => entry.path === shotFile) &&
    mergedShots?.entries?.some((entry) => entry.path === headlessShotFile),
)
const headlessShotRead = await byName.chrome_shots.execute({ op: 'read', path: headlessShotFile }, exec())
check('chrome_shots reads a headless screenshot', headlessShotRead?.bytes === tinyPng.length && headlessShotRead?.width === 1)

// P1-1: the headless driver returns { path, bytes } for an already-written PDF.
let pdfSeq = 0
const pdfSources = []
const pdfBridge = {
  async call(method) {
    if (method === 'tab.pdf') {
      pdfSeq += 1
      const file = path.join(home, `driver-pdf-${pdfSeq}.pdf`)
      await fsp.writeFile(file, Buffer.from(`%PDF-1.4\n%%EOF\n${pdfSeq}\n`))
      pdfSources.push(file)
      return { path: file, bytes: (await fsp.stat(file)).size }
    }
    throw new Error(`pdf fake does not implement ${method}`)
  },
}
const pdfTools = chromeTools({
  bridge: pdfBridge,
  attachments: () => null,
  assets: () => ({}),
  approval: () => null,
  sessionContext: () => ({ sessions: { get: () => ({ header: { cwd: home } }) } }),
  userQuestions: () => ({ ask: async () => ({ answers: [{ id: 'confirm', selected: ['允许一次'] }] }) }),
})
const pdfTool = pdfTools.find((definition) => definition.name === 'chrome_pdf')
const requestedPdf = path.join(home, 'pdfs', 'requested.pdf')
const pdfMoved = await pdfTool.execute({ path: requestedPdf }, exec())
check('chrome_pdf accepts the headless { path, bytes } envelope', pdfMoved?.path === requestedPdf && fs.existsSync(requestedPdf))
check('chrome_pdf moves the driver PDF to the requested path', !fs.existsSync(pdfSources[0]))
check('chrome_pdf reports the copied byte count', pdfMoved?.bytes === fs.statSync(requestedPdf).size)
const defaultPdf = await pdfTool.execute({}, exec())
check(
  'chrome_pdf default path lives in the pdfs cache',
  defaultPdf?.path?.includes(path.join('cache', 'dsh-chrome', 'pdfs')) && fs.existsSync(defaultPdf.path),
)

// P1-2: a non-BridgeError driver code is preserved; Node system errors stay INTERNAL.
const codedBridge = {
  async call(method) {
    if (method === 'browser.site') return { origin: 'http://127.0.0.1:8765', url: 'http://127.0.0.1:8765/', title: 'P2', tabId: 7 }
    const error = new Error('no element for ref 999999')
    error.code = 'REF_NOT_FOUND'
    throw error
  },
}
const codedTools = chromeTools({
  bridge: codedBridge,
  attachments: () => null,
  assets: () => ({}),
  approval: () => ({ request: async () => 'allowed-once' }),
})
let codedClickCode = null
try {
  await codedTools.find((definition) => definition.name === 'chrome_click').execute({ ref: 999999 }, exec())
} catch (error) {
  codedClickCode = error?.code
}
check('driver error code survives the tool layer', codedClickCode === 'REF_NOT_FOUND')

const systemErrorBridge = {
  async call(method) {
    if (method === 'browser.site') return { origin: 'http://127.0.0.1:8765', url: 'http://127.0.0.1:8765/', title: 'P2', tabId: 7 }
    const error = new Error('ENOENT: no such file or directory')
    error.code = 'ENOENT'
    error.errno = -2
    error.syscall = 'open'
    throw error
  },
}
const systemErrorTools = chromeTools({
  bridge: systemErrorBridge,
  attachments: () => null,
  assets: () => ({}),
  approval: () => ({ request: async () => 'allowed-once' }),
})
let systemErrorCode = null
try {
  await systemErrorTools.find((definition) => definition.name === 'chrome_click').execute({ ref: 1 }, exec())
} catch (error) {
  systemErrorCode = error?.code
}
check('node system errors still map to INTERNAL', systemErrorCode === 'INTERNAL')

// P1-3: start's hard confirmation must not resolve browser.site, because that
// lookup lazily creates an about:blank tab on the headless driver and loginStart
// refuses while any tab is open.
let loginSiteCalls = 0
const loginDriverStub = {
  loginProfile: '/tmp/p2-login-profile',
  loginStart: async () => ({ running: true, alreadyRunning: false, pid: 4242, profile: '/tmp/p2-login-profile' }),
  loginFinish: async () => ({ stopped: true, running: false }),
  loginStatus: () => ({ running: false, profile: '/tmp/p2-login-profile' }),
}
const loginBridgeStub = {
  headless: loginDriverStub,
  async call(method) {
    loginSiteCalls += 1
    throw new Error(`login fake does not implement ${method}`)
  },
}
const loginTools = chromeTools({
  bridge: loginBridgeStub,
  attachments: () => null,
  assets: () => ({}),
  approval: () => null,
  userQuestions: () => ({ ask: async () => ({ answers: [{ id: 'confirm', selected: ['允许一次'] }] }) }),
  config: () => ({ evaluateConfirmTimeoutMs: 5000 }),
})
const loginStarted = await loginTools
  .find((definition) => definition.name === 'chrome_headless_login')
  .execute({ op: 'start' }, exec())
check('headless login start skips browser.site', loginSiteCalls === 0 && loginStarted?.running === true)

// D3: chrome_resume dispatches to the extension
const resumeValue = await byName.chrome_resume.execute({}, exec())
check('chrome_resume resumes the session', resumeValue?.ok === true && resumeValue?.tabId === 7)
check('resume reaches the extension', requests.at(-1)?.method === 'tab.resume')

// D2: chrome_pick returns a usable ref and can be canceled
const pickValue = await byName.chrome_pick.execute({ timeoutMs: 3000 }, exec())
check('chrome_pick returns ref/selector/text', pickValue?.ref === 3 && pickValue?.selector === '#greet' && pickValue?.text === 'Greet')
check('chrome_pick starts pick mode in the extension', requests.some((request) => request.method === 'tab.pick_start'))
check('chrome_pick consults the capability contract', supportChecks.includes('pick'))

const cancelValue = await byName.chrome_pick.execute({ cancel: true }, exec())
check('chrome_pick cancel returns canceled', cancelValue?.canceled === true)
check('chrome_pick cancel reaches the extension', requests.at(-1)?.method === 'tab.pick_cancel')

// Capability gate: a backend without `pick` is rejected before any backend call.
const pickRequestsBeforeUnsupported = requests.length
supportedCapabilities.delete('pick')
let unsupportedPickError = null
try {
  await byName.chrome_pick.execute({ poll: true }, exec())
} catch (error) {
  unsupportedPickError = error
} finally {
  supportedCapabilities.add('pick')
}
check('chrome_pick rejects a backend without pick', unsupportedPickError?.code === 'UNSUPPORTED_BACKEND')
check(
  'unsupported pick suggests desktop or snapshot+selector',
  /backend:"desktop"/.test(String(unsupportedPickError?.message || '')) && /chrome_snapshot/.test(String(unsupportedPickError?.message || '')),
)
check('unsupported pick never reaches the extension', requests.length === pickRequestsBeforeUnsupported)

// Compatibility: a bridge without supports() (older provider / test double)
// keeps the historical behavior instead of failing closed.
const legacyBridge = {
  connected: true,
  async call(method) {
    if (method === 'tab.pick_status') {
      return {
        available: true,
        done: true,
        canceled: false,
        result: { ref: 11, selector: '#legacy', text: 'Legacy', tag: 'a', box: [0, 0, 1, 1] },
      }
    }
    return {}
  },
}
const legacyByName = Object.fromEntries(
  chromeTools({ bridge: legacyBridge, attachments: () => null, assets: () => ({}) }).map((definition) => [definition.name, definition]),
)
const legacyPick = await legacyByName.chrome_pick.execute({ poll: true }, exec())
check('bridge without supports() keeps pick available', legacyPick?.ref === 11 && legacyPick?.selector === '#legacy')

// F1: chrome_screencast start/status/stop
const screencastStart = await byName.chrome_screencast.execute({ op: 'start', quality: 50, everyNthFrame: 3 }, exec())
check('chrome_screencast start activates', screencastStart?.active === true && screencastStart?.format === 'jpeg')
check('screencast params reach the extension', requests.at(-2)?.method === 'tab.screencast_start' || requests.slice(-3).some((request) => request.method === 'tab.screencast_start'))
const screencastStatus = await byName.chrome_screencast.execute({ op: 'status' }, exec())
check('chrome_screencast status reports frames', screencastStatus?.frames === 12 && screencastStatus?.active === true)
const screencastStop = await byName.chrome_screencast.execute({ op: 'stop' }, exec())
check('chrome_screencast stop returns frame count', screencastStop?.active === false && screencastStop?.frames === 12)
check('chrome_screencast consults the capability contract', supportChecks.includes('screencast'))

// Capability gate: screencast is declared by desktop and headless today, but a
// backend without it must fail before touching the driver.
const screencastRequestsBeforeUnsupported = requests.length
supportedCapabilities.delete('screencast')
let unsupportedScreencastError = null
try {
  await byName.chrome_screencast.execute({ op: 'status' }, exec())
} catch (error) {
  unsupportedScreencastError = error
} finally {
  supportedCapabilities.add('screencast')
}
check('chrome_screencast rejects a backend without screencast', unsupportedScreencastError?.code === 'UNSUPPORTED_BACKEND')
check('unsupported screencast never reaches the extension', requests.length === screencastRequestsBeforeUnsupported)

// F4: capture start has no config escape hatch
const bypassTools = chromeTools({
  bridge,
  attachments: () => null,
  assets: () => ({ extensionId: 'test', extensionDir: '/tmp/ext', nativeManifestPath: '/tmp/nm', instructionsPath: '/tmp/i.md' }),
  config: () => ({ captureConfirm: 'follow-dsh' }),
})
const bypassByName = Object.fromEntries(bypassTools.map((definition) => [definition.name, definition]))
let bypassCode = null
try {
  await bypassByName.chrome_capture_start.execute({ maxEntries: 5 }, exec())
} catch (error) {
  bypassCode = error?.code
}
check('capture start ignores the retired follow-dsh escape hatch', bypassCode === 'APPROVAL_DENIED')

// D2: pick nowait/poll and capture body render
const pickStartNowait = await byName.chrome_pick.execute({ nowait: true }, exec())
check('chrome_pick nowait returns started', pickStartNowait?.started === true)
check('pick nowait starts pick mode', requests.at(-1)?.method === 'tab.pick_start')

const pickPoll = await byName.chrome_pick.execute({ poll: true }, exec())
check('chrome_pick poll returns the finished pick', pickPoll?.ref === 3 && pickPoll?.selector === '#greet')

const captureRender = byName.chrome_capture_requests.output.render(
  {},
  {
    captureId: 'cap-1',
    active: false,
    entries: [
      {
        method: 'POST',
        url: 'https://api.test/x',
        status: 200,
        mimeType: 'application/json',
        resourceType: 'fetch',
        requestBody: '{"token":"«redacted»"}',
        responseBody: '{"ok":true}',
      },
    ],
    total: 1,
  },
)
check(
  'capture render includes request/response bodies',
  /request:/.test(captureRender[0]?.text || '') && /response:/.test(captureRender[0]?.text || ''),
)

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

// F3: chrome_config + invalid policy reporting
const configFile = path.join(policyDir, 'config.json')
await fsp.writeFile(configFile, JSON.stringify({ allowEvaluate: true, captureConfirm: 'follow-dsh' }))
const configValue = await byName.chrome_config.execute({}, exec())
check('chrome_config reports allowEvaluate', configValue?.config?.allowEvaluate === true && configValue?.error === null)
check('chrome_config path points at the cache file', configValue?.path === configFile)

await fsp.writeFile(policyFile, JSON.stringify({ origins: { 'http://127.0.0.1:8765': 'allow', 'https://bad.test': 'nope' } }))
const invalidPolicy = await byName.chrome_policy.execute({ origin: 'https://bad.test' }, exec())
check('chrome_policy reports invalid policy modes', invalidPolicy?.invalid?.length === 1 && invalidPolicy.invalid[0].origin === 'https://bad.test')
await fsp.writeFile(policyFile, JSON.stringify({ origins: { 'http://127.0.0.1:8765': 'allow' } }))

// C2a: capture tools are always registered; start is hard-confirmed
check('chrome_capture_start registered', Boolean(byName.chrome_capture_start))
const noConfirmTools = chromeTools({
  bridge,
  attachments: () => null,
  assets: () => ({ extensionId: 'test', extensionDir: '/tmp/ext', nativeManifestPath: '/tmp/nm', instructionsPath: '/tmp/i.md' }),
})
let captureStartCode = null
try {
  await noConfirmTools.find((definition) => definition.name === 'chrome_capture_start').execute({ maxEntries: 10 }, exec())
} catch (error) {
  captureStartCode = error?.code
}
check('capture start fails closed without a confirmation service', captureStartCode === 'APPROVAL_DENIED', String(captureStartCode))

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
check('capture start defaults storeBodies to false', requests.at(-1)?.params?.storeBodies === false)
const captureStartWithBodies = await captureByName.chrome_capture_start.execute({ maxEntries: 10, storeBodies: true }, exec())
check(
  'capture start forwards an explicit storeBodies:true',
  captureStartWithBodies?.captureId === 'cap-1' && requests.at(-1)?.params?.storeBodies === true,
)

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
check('enabling allowEvaluate registers chrome_evaluate', allowTools.length === 46 && Boolean(allowByName.chrome_evaluate))
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

// ============================================================ security top 5
const securityAssets = () => ({ extensionId: 'test', extensionDir: '/tmp/ext', nativeManifestPath: '/tmp/nm', instructionsPath: '/tmp/i.md' })
const allowApproval = () => ({ request: async (request) => (approvalCalls.push(request), 'allowed-once') })

// R-01 / R-02: the policy decision follows the target object (tabId / URL),
// never the session's currently active page.
await fsp.writeFile(
  policyFile,
  JSON.stringify({
    origins: {
      'http://127.0.0.1:8765': 'allow',
      'https://allowed.example': 'allow',
      'https://blocked.example': 'block',
    },
  }),
)
const targetTools = chromeTools({
  bridge,
  attachments: () => null,
  assets: securityAssets,
  approval: allowApproval,
  sessionContext,
})
const targetByName = Object.fromEntries(targetTools.map((definition) => [definition.name, definition]))

let targetBlockedCode = null
const beforeTargetClick = requests.length
try {
  await targetByName.chrome_click.execute({ ref: 1, tabId: 8 }, exec())
} catch (error) {
  targetBlockedCode = error?.code
}
check('R-01 click on a blocked target tab returns SITE_BLOCKED', targetBlockedCode === 'SITE_BLOCKED', String(targetBlockedCode))
check(
  'R-01 guard looked up the requested tab id',
  requests.slice(beforeTargetClick).some((request) => request.method === 'browser.site' && request.params?.tabId === 8),
)
check(
  'R-01 blocked target never reaches the action',
  requests.slice(beforeTargetClick).every((request) => request.method === 'browser.site'),
)

const beforeAllowedClick = requests.length
await targetByName.chrome_click.execute({ ref: 1, tabId: 9 }, exec())
check(
  'R-01 click on an allowed target tab executes',
  requests.slice(beforeAllowedClick).some((request) => request.method === 'tab.click' && request.params?.tabId === 9),
)

let targetTypeCode = null
try {
  await targetByName.chrome_type.execute({ ref: 2, text: 'x', tabId: 8 }, exec())
} catch (error) {
  targetTypeCode = error?.code
}
check('R-01 type on a blocked target tab is refused', targetTypeCode === 'SITE_BLOCKED', String(targetTypeCode))

const beforeBlockedGoto = requests.length
let gotoBlockedCode = null
try {
  await targetByName.chrome_goto.execute({ url: 'https://blocked.example/login' }, exec())
} catch (error) {
  gotoBlockedCode = error?.code
}
check('R-02 chrome_goto judges the destination URL', gotoBlockedCode === 'SITE_BLOCKED', String(gotoBlockedCode))
check('R-02 blocked goto performs no lookup or navigation', requests.length === beforeBlockedGoto)

await targetByName.chrome_goto.execute({ url: 'https://allowed.example/page' }, exec())
check(
  'R-02 allowed goto still navigates',
  requests.at(-1)?.method === 'tab.goto' && requests.at(-1)?.params?.url === 'https://allowed.example/page',
)

const beforeBlockedTabsNew = requests.length
let tabsNewBlockedCode = null
try {
  await targetByName.chrome_tabs.execute({ op: 'new', url: 'https://blocked.example/x' }, exec())
} catch (error) {
  tabsNewBlockedCode = error?.code
}
check('R-02 chrome_tabs new judges the destination URL', tabsNewBlockedCode === 'SITE_BLOCKED', String(tabsNewBlockedCode))
check('R-02 blocked tabs new creates no tab', requests.length === beforeBlockedTabsNew)

await targetByName.chrome_tabs.execute({ op: 'new', url: 'https://allowed.example/x' }, exec())
check(
  'R-02 allowed tabs new reaches the extension',
  requests.at(-1)?.method === 'tab.tabs' &&
    requests.at(-1)?.params?.op === 'new' &&
    requests.at(-1)?.params?.url === 'https://allowed.example/x',
)

let tabFileCode = null
try {
  await targetByName.chrome_tabs.execute({ op: 'new', url: 'file:///etc/hosts' }, exec())
} catch (error) {
  tabFileCode = error?.code
}
check('R-05 chrome_tabs new refuses file:// at the tool layer', tabFileCode === 'PROTECTED_PAGE', String(tabFileCode))

const targetAudit = await targetByName.chrome_audit.execute({ limit: 100 }, exec())
const blockedClickAudit = targetAudit.entries.find(
  (entry) => entry.tool === 'chrome_click' && entry.decision === 'denied' && entry.origin === 'https://blocked.example',
)
check('R-01 audit records the target origin and tabId', blockedClickAudit?.tabId === 8, JSON.stringify(blockedClickAudit))
const targetPolicy = await targetByName.chrome_policy.execute({ tabId: 9 }, exec())
check(
  'chrome_policy resolves an explicit tabId',
  targetPolicy?.origin === 'https://allowed.example' && targetPolicy?.mode === 'allow',
  JSON.stringify(targetPolicy),
)

// R-03: missing approval service / agent and failed site lookup all fail closed.
// Use a default-policy site: an explicit "allow" legitimately skips approval.
await fsp.writeFile(policyFile, JSON.stringify({ origins: { 'https://blocked.example': 'block' } }))
const noApprovalTools = chromeTools({ bridge, attachments: () => null, assets: securityAssets, sessionContext })
const beforeNoApproval = requests.length
let noApprovalCode = null
try {
  await noApprovalTools.find((definition) => definition.name === 'chrome_click').execute({ ref: 1 }, exec())
} catch (error) {
  noApprovalCode = error?.code
}
check('R-03 missing approval service fails closed', noApprovalCode === 'APPROVAL_DENIED', String(noApprovalCode))
check(
  'R-03 missing approval service never reaches the action',
  requests.slice(beforeNoApproval).every((request) => request.method === 'browser.site'),
)

const noAgentTools = chromeTools({ bridge, attachments: () => null, assets: securityAssets, approval: allowApproval })
const beforeNoAgent = requests.length
let noAgentCode = null
try {
  await noAgentTools.find((definition) => definition.name === 'chrome_click').execute({ ref: 1 }, { callId: 'no-agent' })
} catch (error) {
  noAgentCode = error?.code
}
check('R-03 missing exec.agent fails closed', noAgentCode === 'APPROVAL_DENIED', String(noAgentCode))
check('R-03 missing exec.agent performs no lookup', requests.length === beforeNoAgent)

let siteFailActions = 0
const siteFailTools = chromeTools({
  bridge: {
    async call(method) {
      if (method === 'browser.site') {
        const error = new Error('site lookup timed out')
        error.code = 'TIMEOUT'
        throw error
      }
      if (method === 'tab.click') {
        siteFailActions += 1
        return { ok: true }
      }
      return {}
    },
  },
  attachments: () => null,
  assets: securityAssets,
  approval: allowApproval,
})
let siteFailCode = null
try {
  await siteFailTools.find((definition) => definition.name === 'chrome_click').execute({ ref: 1 }, exec())
} catch (error) {
  siteFailCode = error?.code
}
check('R-03 failed site lookup fails closed', siteFailCode === 'APPROVAL_DENIED' && siteFailActions === 0, String(siteFailCode))
const siteFailAudit = await targetByName.chrome_audit.execute({ limit: 30 }, exec())
check(
  'R-03 failed site lookup writes a denied audit entry',
  siteFailAudit.entries.some(
    (entry) => entry.tool === 'chrome_click' && entry.decision === 'denied' && entry.reason === 'site-unavailable',
  ),
)

// policy.json ask: the human asked to be asked, so danger-full-access must not
// silently allow it.
await fsp.writeFile(policyFile, JSON.stringify({ origins: { 'http://127.0.0.1:8765': 'ask' } }))
const dangerSessionContext = () => ({
  sessions: { get: () => ({ header: { cwd: home } }) },
  sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
})
const askCalls = []
const askTools = chromeTools({
  bridge,
  attachments: () => null,
  assets: securityAssets,
  sessionContext: dangerSessionContext,
  approval: () => ({ request: async (request) => (askCalls.push(request), 'allowed-once') }),
})
const beforeAskClick = requests.length
await askTools.find((definition) => definition.name === 'chrome_click').execute({ ref: 1 }, exec())
check('policy ask forces approval under danger-full-access', askCalls.length === 1)
check(
  'policy ask executes only after approval',
  requests.slice(beforeAskClick).some((request) => request.method === 'tab.click'),
)
const askNoApprovalTools = chromeTools({
  bridge,
  attachments: () => null,
  assets: securityAssets,
  sessionContext: dangerSessionContext,
})
let askNoApprovalCode = null
try {
  await askNoApprovalTools.find((definition) => definition.name === 'chrome_click').execute({ ref: 1 }, exec())
} catch (error) {
  askNoApprovalCode = error?.code
}
check('policy ask without an approval service fails closed', askNoApprovalCode === 'APPROVAL_DENIED', String(askNoApprovalCode))
await fsp.writeFile(policyFile, JSON.stringify({ origins: { 'http://127.0.0.1:8765': 'allow' } }))

// R-04: hard confirmation is mandatory; the path allowlist is independent.
const noConfirmUploadTools = chromeTools({ bridge, attachments: () => null, assets: securityAssets, sessionContext, approval: allowApproval })
const beforeNoConfirmUpload = requests.length
let noConfirmUploadCode = null
try {
  await noConfirmUploadTools.find((definition) => definition.name === 'chrome_upload').execute({ ref: 5, files: [uploadPath] }, exec())
} catch (error) {
  noConfirmUploadCode = error?.code
}
check('R-04 upload without a confirmation service fails closed', noConfirmUploadCode === 'APPROVAL_DENIED', String(noConfirmUploadCode))
check(
  'R-04 refused upload never reaches the extension',
  requests.slice(beforeNoConfirmUpload).every((request) => request.method !== 'tab.upload'),
)

const deniedUploadTools = chromeTools({
  bridge,
  attachments: () => null,
  assets: securityAssets,
  sessionContext,
  approval: allowApproval,
  userQuestions: () => ({ ask: async () => ({ answers: [{ id: 'confirm', selected: ['拒绝'] }] }) }),
})
const beforeDeniedUpload = requests.length
let deniedUploadCode = null
try {
  await deniedUploadTools.find((definition) => definition.name === 'chrome_upload').execute({ ref: 5, files: [uploadPath] }, exec())
} catch (error) {
  deniedUploadCode = error?.code
}
check('R-04 a denied hard confirmation returns APPROVAL_DENIED', deniedUploadCode === 'APPROVAL_DENIED', String(deniedUploadCode))
check(
  'R-04 denied upload never reaches the extension',
  requests.slice(beforeDeniedUpload).every((request) => request.method !== 'tab.upload'),
)

const outsideDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-chrome-p2-outside-'))
const outsideFile = path.join(outsideDir, 'secret.txt')
await fsp.writeFile(outsideFile, 'outside the workspace')
const confirmsBeforeOutside = uploadConfirmations.length
const requestsBeforeOutside = requests.length
let outsideUploadCode = null
try {
  await byName.chrome_upload.execute({ ref: 5, files: [outsideFile] }, exec())
} catch (error) {
  outsideUploadCode = error?.code
}
check('R-04 upload outside the allowed roots is refused', outsideUploadCode === 'INVALID_ARGUMENT', String(outsideUploadCode))
check('R-04 outside-root upload never prompts', uploadConfirmations.length === confirmsBeforeOutside)
check(
  'R-04 outside-root upload never reaches the extension',
  requests.slice(requestsBeforeOutside).every((request) => request.method !== 'tab.upload'),
)
await fsp.rm(outsideDir, { recursive: true, force: true })

// R-06: screencast frames and screenshots are not shared across sessions.
const screencastDir = path.join(home, 'cache', 'dsh-chrome', 'screencast')
await fsp.mkdir(screencastDir, { recursive: true })
const castFrame = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
const castFile = path.join(screencastDir, 'latest.jpg')
const castMeta = path.join(screencastDir, 'meta.json')
await fsp.writeFile(castFile, castFrame)
await fsp.writeFile(castMeta, JSON.stringify({ updatedAt: Date.now(), format: 'jpg', bytes: castFrame.length, frames: 1, owner: 'other-session' }))
await targetByName.chrome_screencast.execute({ op: 'start' }, exec())
const foreignFrameStatus = await targetByName.chrome_screencast.execute({ op: 'status' }, exec())
check(
  'R-06 screencast status withholds a frame owned by another session',
  foreignFrameStatus.bytes == null && foreignFrameStatus.frameOwner === 'other-session',
  JSON.stringify({ bytes: foreignFrameStatus.bytes, frameOwner: foreignFrameStatus.frameOwner }),
)
await fsp.writeFile(castMeta, JSON.stringify({ updatedAt: Date.now(), format: 'jpg', bytes: castFrame.length, frames: 1, owner: 'session-p2' }))
const ownFrameStatus = await targetByName.chrome_screencast.execute({ op: 'status' }, exec())
check(
  'R-06 the session that started the stream still gets its frame',
  ownFrameStatus.bytes === castFrame.length && ownFrameStatus.frameOwner === 'session-p2',
  JSON.stringify({ bytes: ownFrameStatus.bytes, frameOwner: ownFrameStatus.frameOwner }),
)
fakeScreencastActive = false
const inactiveFrameStatus = await targetByName.chrome_screencast.execute({ op: 'status' }, exec())
check('R-06 an inactive stream never reads the global frame', inactiveFrameStatus.bytes == null)
fakeScreencastActive = true
const freshScreencastTools = chromeTools({ bridge, attachments: () => null, assets: securityAssets })
const freshScreencastStatus = await freshScreencastTools
  .find((definition) => definition.name === 'chrome_screencast')
  .execute({ op: 'status' }, exec())
check(
  'R-06 a provider that never started a stream returns no global frame',
  freshScreencastStatus.bytes == null,
  JSON.stringify({ bytes: freshScreencastStatus.bytes }),
)
await targetByName.chrome_screencast.execute({ op: 'stop' }, exec())

const shotOwnersFile = path.join(home, 'cache', 'dsh-chrome', 'shot-owners.json')
await fsp.writeFile(shotOwnersFile, JSON.stringify({ [path.resolve(shotFile)]: 'other-session' }))
const foreignShots = await targetByName.chrome_shots.execute({ op: 'list', limit: 50 }, exec())
check(
  "R-06 shots list hides another session's screenshot",
  !foreignShots.entries.some((entry) => entry.path === shotFile),
)
let foreignShotReadCode = null
try {
  await targetByName.chrome_shots.execute({ op: 'read', path: shotFile }, exec())
} catch (error) {
  foreignShotReadCode = error?.code
}
check("R-06 shots read refuses another session's screenshot", foreignShotReadCode === 'INVALID_ARGUMENT', String(foreignShotReadCode))
await fsp.writeFile(shotOwnersFile, JSON.stringify({ [path.resolve(shotFile)]: 'session-p2' }))
const ownShots = await targetByName.chrome_shots.execute({ op: 'list', limit: 50 }, exec())
check(
  "R-06 shots list keeps this session's own screenshot visible",
  ownShots.entries.some((entry) => entry.path === shotFile),
)
const ownShotRead = await targetByName.chrome_shots.execute({ op: 'read', path: shotFile }, exec())
check("R-06 shots read allows this session's own screenshot", ownShotRead.bytes === tinyPng.length)

host.kill('SIGTERM')
await bridge.stop()
await fsp.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {})

console.log(failures === 0 ? '\nP2 TOOLS TEST: PASS' : `\nP2 TOOLS TEST: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
