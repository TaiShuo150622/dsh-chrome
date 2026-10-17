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
      'tab.screenshot': { dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' },
      'tab.select': { ok: true, tag: 'input', value: 'checked' },
      'tab.get_text': { found: true, text: 'Example Domain body', truncated: false },
      'tab.console': { available: true, entries: [{ level: 'error', text: 'boom', time: 1 }] },
      'tab.network': { available: true, entries: [{ url: 'https://example.com/a.js', type: 'script', durationMs: 12, transferSize: 340 }] },
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
check('seventeen tools registered', tools.length === 17, tools.map((t) => t.name).join(', '))
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

const selectValue = await byName.chrome_select.execute({ ref: 4, checked: true }, exec())
check('chrome_select executes', selectValue.ok === true && selectValue.value === 'checked')
check('select params reach the extension', requests.at(-1)?.method === 'tab.select' && requests.at(-1)?.params?.checked === true)

const textValue = await byName.chrome_get_text.execute({ selector: 'main', maxChars: 1000 }, exec())
check('chrome_get_text executes', textValue.found === true && textValue.text === 'Example Domain body')
check('get_text selector reaches the extension', requests.at(-1)?.method === 'tab.get_text' && requests.at(-1)?.params?.selector === 'main')

const consoleValue = await byName.chrome_console.execute({ level: 'error', limit: 10 }, exec())
check('chrome_console executes', consoleValue.available === true && consoleValue.entries?.[0]?.text === 'boom')
check('console level reaches the extension', requests.at(-1)?.method === 'tab.console' && requests.at(-1)?.params?.level === 'error')
const consoleRender = byName.chrome_console.output.render({}, consoleValue)
check('console render lists entries', /\[error\] boom/.test(consoleRender[0]?.text || ''))

const networkValue = await byName.chrome_network.execute({ filter: 'a.js', limit: 5 }, exec())
check('chrome_network executes', networkValue.entries?.[0]?.url === 'https://example.com/a.js')
check('network filter reaches the extension', requests.at(-1)?.params?.filter === 'a.js')

host.kill('SIGTERM')
await bridge.stop()
await fsp.rm(home, { recursive: true, force: true })

console.log(failures === 0 ? '\nP2 TOOLS TEST: PASS' : `\nP2 TOOLS TEST: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
