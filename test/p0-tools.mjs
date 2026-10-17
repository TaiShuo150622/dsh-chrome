/**
 * P0 tool-layer test — no Chrome required.
 *
 * Exercises the real chrome_* tool definitions against the real bridge and
 * native host, with a fake extension and a fake attachment service.
 */
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { BridgeServer } from '../src/bridge.js'
import { chromeTools } from '../src/tools.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-chrome-tools-'))
const bridge = new BridgeServer({ home })

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`)
  else {
    failures += 1
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function tinyPng() {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
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

await bridge.start()
const host = spawn(process.execPath, [path.join(root, 'host', 'host.mjs')], {
  env: { ...process.env, DSH_HOME: home },
  stdio: ['pipe', 'pipe', 'inherit'],
})
host.stdout.on(
  'data',
  frameReader((message) => {
    if (message.id == null) return
    const table = {
      'browser.status': { extensionVersion: 'p0-fake', connected: true },
      'tab.goto': { tabId: 7, url: 'https://example.com/', title: 'Example Domain', loadState: 'complete' },
      'tab.snapshot': {
        title: 'Example Domain',
        url: 'https://example.com/',
        controls: [{ ref: 1, tag: 'a', kind: 'link', label: 'More information...' }],
        text: 'Example Domain body text',
        truncated: false,
      },
      'tab.screenshot': { dataBase64: tinyPng().toString('base64') },
    }
    const result = table[message.method]
    host.stdin.write(
      encodeNative(
        result
          ? { id: message.id, result }
          : { id: message.id, error: { code: 'UNSUPPORTED', message: 'p0 fake' } },
      ),
    )
  }),
)
await waitFor(() => bridge.connected, 5000, 'host authentication')

const tools = chromeTools({
  bridge,
  attachments: () => ({
    saveImage: async (input) => ({
      attachmentId: 'att-test-1',
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
      name: input.name,
    }),
  }),
  assets: () => ({
    extensionId: 'test-extension-id',
    extensionDir: '/tmp/extension',
    nativeManifestPath: '/tmp/native.json',
    instructionsPath: '/tmp/INSTALL.md',
  }),
})
const byName = Object.fromEntries(tools.map((definition) => [definition.name, definition]))
check('seventeen tools registered', tools.length === 17, tools.map((t) => t.name).join(', '))
for (const definition of tools) {
  check(`${definition.name} has output schema and render`, Boolean(definition.output?.schema && definition.output?.render))
}

const status = await byName.chrome_status.execute({})
check('chrome_status executes and reports connected', status.connected === true, JSON.stringify({ connected: status.connected }))
check('chrome_status resolves extension version', status.extensionVersion === 'p0-fake')
const statusRender = byName.chrome_status.output.render({}, status)
check('chrome_status render is a text block', statusRender[0]?.type === 'text' && statusRender[0].text.includes('CONNECTED'))

const goto = await byName.chrome_goto.execute({ url: 'https://example.com/' })
check('chrome_goto executes', goto.title === 'Example Domain' && goto.tabId === 7)
const gotoRender = byName.chrome_goto.output.render({}, goto)
check('chrome_goto render mentions title', gotoRender[0]?.text?.includes('Example Domain'))

const snapshot = await byName.chrome_snapshot.execute({})
check('chrome_snapshot executes', snapshot.controls?.[0]?.ref === 1)
const snapshotRender = byName.chrome_snapshot.output.render({}, snapshot)
check('chrome_snapshot render lists the control', snapshotRender[0]?.text?.includes('[1] a (link) "More information..."'))

const shot = await byName.chrome_screenshot.execute({})
check('chrome_screenshot executes and returns attachment', shot.image?.attachmentId === 'att-test-1')
const shotRender = byName.chrome_screenshot.output.render({}, shot)
check('chrome_screenshot render returns an image block', shotRender[0]?.type === 'image')
check('chrome_screenshot render includes a text fallback', shotRender[1]?.type === 'text')

let rejected = false
try {
  await byName.chrome_goto.execute({ url: 'chrome://settings' })
} catch (error) {
  rejected = error.code === 'PROTECTED_PAGE'
}
check('chrome_goto rejects non-http(s) URLs', rejected)

host.kill('SIGTERM')
await bridge.stop()
await fsp.rm(home, { recursive: true, force: true })

console.log(failures === 0 ? '\nP0 TOOLS TEST: PASS' : `\nP0 TOOLS TEST: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
