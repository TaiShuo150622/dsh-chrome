/**
 * Operation-log tests (src/operation-log.js).
 *
 * Self-contained: temporary DSH_HOME, no browser, no ports, no network.
 * Run directly:
 *
 *   node test/operation-log.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { BackendRouter, wrapToolsForBackend } from '../src/backend.js'
import {
  APPEND_REFRESH_APPENDS,
  DEFAULT_MAX_BYTES,
  MAX_RECORD_BYTES,
  OPERATION_LOG_FILE,
  OPERATION_RECORD_FIELDS,
  appendOperation,
  operationLogPath,
  readOperationStats,
  wrapToolsForOperationLog,
} from '../src/operation-log.js'

let checks = 0
let failures = 0
async function check(name, fn) {
  try {
    await fn()
    checks += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${name}: ${error?.stack || error}`)
  }
}

const originalHome = process.env.DSH_HOME
const originalEnabled = process.env.DSH_OPERATION_LOG
const originalMaxBytes = process.env.DSH_OPERATION_LOG_MAX_BYTES
const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-chrome-oplog-'))
let home = null

function useFreshHome(label) {
  home = fs.mkdtempSync(path.join(root, `${label}-`))
  process.env.DSH_HOME = home
  return home
}

function readEntries(file = operationLogPath()) {
  const raw = fs.readFileSync(file, 'utf8')
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
}

// Used to prove the cached append handle does not leak a descriptor per
// rotation. Returns null when the platform has no usable fd table.
function openFdCount() {
  try {
    return fs.readdirSync(process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd').length
  } catch {
    return null
  }
}

function assertRecordShape(entry) {
  for (const key of Object.keys(entry)) {
    assert.ok(OPERATION_RECORD_FIELDS.includes(key), `unexpected record field ${key}`)
  }
  assert.equal(entry.v, 1)
  assert.equal(typeof entry.startedAt, 'string')
  assert.ok(Number.isFinite(Date.parse(entry.startedAt)), 'startedAt is ISO time')
  assert.equal(typeof entry.tool, 'string')
  assert.ok(entry.backend === 'desktop' || entry.backend === 'headless')
  assert.ok(Number.isInteger(entry.durationMs) && entry.durationMs >= 0)
  assert.equal(typeof entry.ok, 'boolean')
  assert.ok(entry.errorCode === null || typeof entry.errorCode === 'string')
  assert.equal(typeof entry.args, 'object')
  assert.equal(typeof entry.result, 'object')
}

// Tests run with logging enabled unless a case explicitly disables it.
delete process.env.DSH_OPERATION_LOG
delete process.env.DSH_OPERATION_LOG_MAX_BYTES

await check('writes one bounded JSONL line with whitelisted fields and mode 0600', () => {
  useFreshHome('write')
  const startedAt = '2026-10-17T21:30:00.000Z'
  assert.equal(
    appendOperation({
      tool: 'chrome_goto',
      backend: 'desktop',
      startedAt,
      durationMs: 12,
      ok: true,
      errorCode: null,
      args: { url: 'https://example.com/' },
      result: { tabId: 7, url: 'https://example.com/', title: 'Example' },
      // Not part of the record whitelist: must be dropped.
      password: 'hunter2',
      extra: 'ignored',
    }),
    true,
  )

  const file = operationLogPath()
  assert.equal(path.basename(file), OPERATION_LOG_FILE)
  assert.ok(fs.existsSync(file), 'log file exists')
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'log file is 0600')
  }

  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  assert.equal(lines.length, 1)
  assert.ok(Buffer.byteLength(lines[0], 'utf8') + 1 <= MAX_RECORD_BYTES)

  const entry = JSON.parse(lines[0])
  assertRecordShape(entry)
  assert.equal(entry.tool, 'chrome_goto')
  assert.equal(entry.backend, 'desktop')
  assert.equal(entry.startedAt, startedAt)
  assert.equal(entry.durationMs, 12)
  assert.equal(entry.ok, true)
  assert.equal(entry.errorCode, null)
  assert.equal(entry.args.url, 'https://example.com/')
  assert.equal(entry.result.tabId, 7)
  assert.equal(entry.result.title, 'Example')
  assert.equal(entry.password, undefined)
  assert.equal(entry.extra, undefined)
})

await check('redacts URL userinfo/secret queries, password fields and inline secrets', () => {
  useFreshHome('redact')
  assert.equal(
    appendOperation({
      tool: 'chrome_type',
      backend: 'headless',
      startedAt: '2026-10-17T21:31:00.000Z',
      durationMs: 3,
      ok: true,
      args: {
        url: 'https://user:pass@example.com/path?token=SUPERSECRET&ok=1&access=VIEWERCAP#access_token=FRAGMENT',
        password: 'hunter2',
        text: 'hello '.repeat(100),
        nested: { apiKey: 'k-12345', note: 'token=abc123 keep' },
        html: '<div>secret page</div>'.repeat(10),
        dataBase64: 'A'.repeat(5000),
      },
      result: {
        tabId: 9,
        url: 'https://example.com/?secret=RESULT',
        title: 'T',
        text: 'page text '.repeat(100),
        dataBase64: 'B'.repeat(5000),
        visible: true,
      },
    }),
    true,
  )

  const entry = readEntries()[0]
  assertRecordShape(entry)

  assert.equal(entry.args.password, '«redacted»')
  assert.equal(entry.args.nested.apiKey, '«redacted»')
  assert.equal(entry.args.url.includes('user:pass'), false)
  assert.equal(entry.args.url.includes('SUPERSECRET'), false)
  assert.equal(entry.args.url.includes('FRAGMENT'), false)
  assert.ok(entry.args.url.startsWith('https://example.com/path?'), entry.args.url)
  assert.ok(entry.args.url.includes('token=«redacted»'), entry.args.url)
  assert.ok(entry.args.url.includes('ok=1'), entry.args.url)
  assert.ok(entry.args.url.includes('access=«redacted»'), entry.args.url)
  assert.equal(entry.args.url.includes('VIEWERCAP'), false, 'viewer access capability is a secret query value')
  assert.ok(entry.args.url.includes('access_token=«redacted»'), entry.args.url)

  assert.equal(entry.args.text, '«redacted»', 'chrome_type input is never logged')
  assert.ok(entry.args.html.startsWith('[omitted '), 'HTML content is replaced by a length')
  assert.ok(entry.args.dataBase64.startsWith('[omitted '), 'base64 content is replaced by a length')
  assert.equal(entry.args.nested.note.includes('abc123'), false, 'inline token is redacted')

  assert.equal(entry.result.text, undefined, 'result page text is not recorded')
  assert.equal(entry.result.textLength, 1000)
  assert.equal(entry.result.dataBase64, undefined, 'result base64 is not recorded')
  assert.equal(entry.result.dataBase64Length, 5000)
  assert.equal(entry.result.url.includes('RESULT'), false)
  assert.ok(entry.result.url.includes('secret=«redacted»'), entry.result.url)
  assert.equal(entry.result.visible, true)

  const serialized = JSON.stringify(entry)
  for (const secret of ['hunter2', 'SUPERSECRET', 'FRAGMENT', 'k-12345', 'abc123', 'RESULT']) {
    assert.equal(serialized.includes(secret), false, `does not leak ${secret}`)
  }
})

await check('chrome_verify step text never reaches the log', () => {
  useFreshHome('verify-redact')
  const sentinel = 'DSH_SENTINEL_VERIFY_TEXT_DO_NOT_USE'
  assert.equal(
    appendOperation({
      tool: 'chrome_verify',
      backend: 'headless',
      startedAt: '2026-10-17T21:31:30.000Z',
      durationMs: 5,
      ok: true,
      args: {
        contextId: 'ctx-1',
        steps: [
          { action: 'navigate', url: 'https://example.com/login' },
          { action: 'type', selector: '#pw', text: sentinel, replace: true },
          { action: 'assert', checks: [{ type: 'text', contains: 'Welcome' }] },
        ],
      },
      result: { ok: true, checks: [{ id: 'check-1', ok: true }] },
    }),
    true,
  )
  const entry = readEntries()[0]
  assertRecordShape(entry)
  assert.equal(entry.args.steps[1].text, '«redacted»')
  assert.equal(entry.args.steps[1].selector, '#pw', 'the step shape stays auditable')
  assert.equal(entry.args.steps[0].action, 'navigate')
  assert.equal(JSON.stringify(entry).includes(sentinel), false, 'chrome_verify step text must never be logged')
})

await check('keeps a single record with huge args/results under 2 KiB and drops binary content', () => {
  useFreshHome('size')
  const huge = 'A1b2C3d4'.repeat(30000)
  const page = 'D'.repeat(200000)
  const binary = 'E'.repeat(200000)
  assert.equal(
    appendOperation({
      tool: 'chrome_evaluate',
      backend: 'desktop',
      startedAt: '2026-10-17T21:32:00.000Z',
      durationMs: 1000,
      ok: true,
      args: {
        expression: huge,
        data: `data:image/png;base64,${binary}`,
        body: page,
        headers: { Authorization: 'Bearer abcdef123456' },
      },
      result: { tabId: 1, text: page, dataBase64: binary, html: page, truncated: true },
    }),
    true,
  )

  const line = fs.readFileSync(operationLogPath(), 'utf8').split('\n').filter(Boolean)[0]
  assert.ok(Buffer.byteLength(line, 'utf8') + 1 <= MAX_RECORD_BYTES, `line was ${Buffer.byteLength(line)} bytes`)
  assert.equal(line.includes(huge.slice(0, 5000)), false, 'oversized arg is not recorded')
  assert.equal(line.includes(page.slice(0, 5000)), false, 'page body is not recorded')
  assert.equal(line.includes(binary.slice(0, 5000)), false, 'base64 payload is not recorded')
  assert.equal(line.includes('abcdef123456'), false, 'authorization header is redacted')

  const entry = JSON.parse(line)
  assertRecordShape(entry)
  assert.equal(entry.result.text, undefined)
  assert.equal(entry.result.textLength, page.length)
  assert.equal(entry.result.html, undefined)
  assert.equal(entry.result.htmlLength, page.length)
  assert.equal(entry.result.dataBase64, undefined)
  assert.equal(entry.result.dataBase64Length, binary.length)
  assert.equal(entry.result.truncated, true)
})

await check('rotates to operations.jsonl.1 at the configured size and bounds the active file', () => {
  useFreshHome('rotate')
  process.env.DSH_OPERATION_LOG_MAX_BYTES = '600'
  try {
    for (let index = 0; index < 12; index += 1) {
      assert.equal(
        appendOperation({
          tool: 'chrome_status',
          backend: 'desktop',
          startedAt: new Date(Date.UTC(2026, 9, 17, 21, 30, index)).toISOString(),
          durationMs: index,
          ok: true,
          args: { op: 'status' },
          result: { connected: true },
        }),
        true,
      )
    }

    const file = operationLogPath()
    const rotated = `${file}.1`
    assert.ok(fs.existsSync(rotated), 'rotated file exists')
    assert.ok(fs.statSync(file).size <= 600, `active file is ${fs.statSync(file).size} bytes`)
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600)
      assert.equal(fs.statSync(rotated).mode & 0o777, 0o600)
    }

    const active = readEntries(file)
    const older = readEntries(rotated)
    assert.ok(active.length > 0)
    assert.ok(older.length > 0)
    assert.equal(active.at(-1).durationMs, 11, 'newest record lives in the active file')
    for (const entry of [...older, ...active]) assertRecordShape(entry)

    const stats = readOperationStats({ limit: 100 })
    assert.equal(stats.maxBytes, 600)
    assert.equal(stats.entries, active.length)
    assert.equal(stats.rotatedEntries, older.length)
    assert.equal(stats.totalEntries, active.length + older.length)
    assert.equal(stats.bytes, fs.statSync(file).size)
    assert.equal(stats.rotatedBytes, fs.statSync(rotated).size)
    assert.equal(stats.totalBytes, stats.bytes + stats.rotatedBytes)
    assert.equal(stats.recent[0].durationMs, 11, 'recent is newest-first across both files')
  } finally {
    delete process.env.DSH_OPERATION_LOG_MAX_BYTES
  }
})

await check('cached append handle keeps rotation bounded over a longer burst', () => {
  useFreshHome('rotate-burst')
  process.env.DSH_OPERATION_LOG_MAX_BYTES = '4096'
  try {
    const total = 200
    const fdsBefore = openFdCount()
    const record = (index) => ({
      tool: 'chrome_status',
      backend: 'desktop',
      startedAt: new Date(Date.UTC(2026, 9, 17, 21, 40, 0) + index * 1000).toISOString(),
      durationMs: index,
      ok: true,
      args: { op: 'status' },
      result: { connected: true },
    })
    for (let index = 0; index < total; index += 1) {
      assert.equal(appendOperation(record(index)), true)
    }

    const file = operationLogPath()
    assert.ok(fs.statSync(file).size <= 4096, `active file is ${fs.statSync(file).size} bytes`)
    // readEntries() throws on a partial/unparseable line, so this also proves
    // the cached fd never splits a record across a rotation.
    const active = readEntries(file)
    const older = readEntries(`${file}.1`)
    assert.ok(older.length > 0, 'at least one rotation happened')
    assert.ok(active.length >= 2, 'rotation is not triggered on every append (size is reset)')
    assert.equal(active.at(-1).durationMs, total - 1, 'newest record is in the active file')
    assert.equal(
      older.at(-1).durationMs + active.length,
      total - 1,
      'records are contiguous across the rotation boundary',
    )
    for (const entry of [...older, ...active]) assertRecordShape(entry)

    // ~14 rotations happened above; a cached handle that is not closed before
    // the rename would leak one descriptor per rotation.
    const fdsAfter = openFdCount()
    if (fdsBefore !== null && fdsAfter !== null) {
      assert.ok(fdsAfter - fdsBefore <= 2, `open descriptors grew by ${fdsAfter - fdsBefore}`)
    }
  } finally {
    delete process.env.DSH_OPERATION_LOG_MAX_BYTES
  }
})

await check('repairs the mode of a pre-existing log file to 0600', () => {
  useFreshHome('mode-repair')
  const file = operationLogPath()
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, '{"v":1,"legacy":true}\n', { mode: 0o644 })
  if (process.platform !== 'win32') fs.chmodSync(file, 0o644)

  assert.equal(
    appendOperation({
      tool: 'chrome_status',
      backend: 'desktop',
      startedAt: '2026-10-17T21:41:00.000Z',
      durationMs: 1,
      ok: true,
      args: {},
      result: {},
    }),
    true,
  )
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'mode is repaired on first append')
  }
  assert.equal(readEntries(file).length, 2, 'the pre-existing line is preserved')
  assert.equal(readEntries(file).at(-1).tool, 'chrome_status')
})

await check('reopens the log after the file is deleted externally', () => {
  useFreshHome('external-delete')
  const file = operationLogPath()
  const record = (index) => ({
    tool: 'chrome_status',
    backend: 'desktop',
    startedAt: new Date(Date.UTC(2026, 9, 17, 21, 42, 0) + index * 1000).toISOString(),
    durationMs: index,
    ok: true,
    args: {},
    result: {},
  })

  assert.equal(appendOperation(record(0)), true)
  assert.ok(fs.existsSync(file))
  fs.rmSync(file)

  // The cached handle revalidates at least every APPEND_REFRESH_APPENDS
  // records, so the recreated file appears within that window.
  let reopenedAt = null
  for (let index = 1; index <= APPEND_REFRESH_APPENDS; index += 1) {
    assert.equal(appendOperation(record(index)), true)
    if (fs.existsSync(file)) {
      reopenedAt = index
      break
    }
  }
  assert.ok(reopenedAt !== null && reopenedAt <= APPEND_REFRESH_APPENDS, 'file is recreated')
  const entries = readEntries(file)
  assert.equal(entries.at(-1).durationMs, reopenedAt, 'the record that reopened the file is on disk')
})

await check('DSH_OPERATION_LOG=0 disables writes without affecting callers', () => {
  useFreshHome('disabled')
  process.env.DSH_OPERATION_LOG = '0'
  try {
    assert.equal(
      appendOperation({
        tool: 'chrome_status',
        backend: 'desktop',
        startedAt: '2026-10-17T21:33:00.000Z',
        durationMs: 1,
        ok: true,
        args: {},
        result: {},
      }),
      false,
    )
    assert.equal(fs.existsSync(operationLogPath()), false, 'nothing was written')
    const stats = readOperationStats()
    assert.equal(stats.enabled, false)
    assert.equal(stats.entries, 0)
    assert.equal(stats.recent.length, 0)
  } finally {
    delete process.env.DSH_OPERATION_LOG
  }
})

await check('a failed write returns false and never throws', () => {
  useFreshHome('blocked')
  const blocker = path.join(root, 'not-a-directory')
  fs.writeFileSync(blocker, 'file, not a directory')
  process.env.DSH_HOME = path.join(blocker, 'home')
  let result = null
  assert.doesNotThrow(() => {
    result = appendOperation({
      tool: 'chrome_status',
      backend: 'desktop',
      startedAt: '2026-10-17T21:34:00.000Z',
      durationMs: 1,
      ok: true,
      args: {},
      result: {},
    })
  })
  assert.equal(result, false)
  const stats = readOperationStats()
  assert.equal(stats.entries, 0)
  assert.equal(stats.recent.length, 0)
})

await check('a failed log write does not change the wrapped tool output', async () => {
  useFreshHome('wrapped-blocked')
  const blocker = path.join(root, 'not-a-directory-for-wrapper')
  fs.writeFileSync(blocker, 'file, not a directory')
  process.env.DSH_HOME = path.join(blocker, 'home')
  const tool = {
    name: 'chrome_status',
    async execute() {
      return { connected: true, tabId: 3 }
    },
  }
  const [wrapped] = wrapToolsForOperationLog([tool])
  const result = await wrapped.execute({})
  assert.deepEqual(result, { connected: true, tabId: 3 })
})

await check('readOperationStats reports empty state, counts, bytes and newest N', () => {
  useFreshHome('stats')
  const empty = readOperationStats({ limit: 5 })
  assert.equal(empty.path, operationLogPath())
  assert.equal(empty.enabled, true)
  assert.equal(empty.maxBytes, DEFAULT_MAX_BYTES)
  assert.equal(empty.bytes, 0)
  assert.equal(empty.entries, 0)
  assert.equal(empty.totalBytes, 0)
  assert.deepEqual(empty.recent, [])

  for (let index = 0; index < 5; index += 1) {
    assert.equal(
      appendOperation({
        tool: 'chrome_status',
        backend: 'desktop',
        startedAt: new Date(Date.UTC(2026, 9, 17, 21, 35, index)).toISOString(),
        durationMs: index,
        ok: true,
        args: {},
        result: {},
      }),
      true,
    )
  }

  const file = operationLogPath()
  const stats = readOperationStats({ limit: 2 })
  assert.equal(stats.enabled, true)
  assert.equal(stats.maxBytes, DEFAULT_MAX_BYTES)
  assert.equal(stats.entries, 5)
  assert.equal(stats.bytes, fs.statSync(file).size)
  assert.equal(stats.totalEntries, 5)
  assert.equal(stats.totalBytes, stats.bytes)
  assert.equal(stats.recent.length, 2)
  assert.equal(stats.recent[0].durationMs, 4)
  assert.equal(stats.recent[1].durationMs, 3)
  assert.equal(readOperationStats(2).recent.length, 2, 'numeric shorthand for limit')
})

await check('wrapper logs success/error/backend without changing behavior, output or errors', async () => {
  useFreshHome('wrap')
  let received = null
  const tool = {
    name: 'chrome_goto',
    description: 'test tool',
    parameters: { type: 'object', properties: {} },
    async execute(args, exec) {
      received = { args, exec }
      return {
        tabId: 5,
        url: 'https://example.com/?token=WRAPPEDSECRET',
        title: 'Example',
        text: 'page body '.repeat(100),
      }
    },
  }

  const wrapped = wrapToolsForOperationLog([tool], { defaultBackend: () => 'desktop' })
  assert.equal(wrapped.length, 1)
  assert.notEqual(wrapped[0], tool)
  assert.equal(wrapped[0].name, tool.name)
  assert.equal(wrapped[0].description, tool.description)

  const args = { url: 'https://example.com/', backend: 'headless' }
  const result = await wrapped[0].execute(args, { callId: 'c1' })
  assert.equal(received.args, args, 'the underlying tool receives the same args object')
  assert.equal(result.tabId, 5)
  assert.equal(result.text, 'page body '.repeat(100), 'output is returned unchanged')

  let entries = readEntries()
  assert.equal(entries.length, 1)
  assertRecordShape(entries[0])
  assert.equal(entries[0].tool, 'chrome_goto')
  assert.equal(entries[0].backend, 'headless')
  assert.equal(entries[0].ok, true)
  assert.equal(entries[0].errorCode, null)
  assert.equal(entries[0].result.tabId, 5)
  assert.equal(entries[0].result.text, undefined)
  assert.equal(entries[0].result.textLength, 1000)
  assert.equal(JSON.stringify(entries[0]).includes('WRAPPEDSECRET'), false)

  await wrapped[0].execute({ url: 'https://example.com/' }, { callId: 'c2' })
  entries = readEntries()
  assert.equal(entries.at(-1).backend, 'desktop', 'default backend is used when args.backend is absent')

  const twice = wrapToolsForOperationLog(wrapped, { defaultBackend: () => 'desktop' })
  assert.equal(twice[0], wrapped[0], 'double wrapping is a no-op')
  await twice[0].execute({ url: 'https://example.com/', backend: 'desktop' }, { callId: 'c3' })
  assert.equal(readEntries().length, 3, 'each call is recorded exactly once')

  const thrown = new Error('boom')
  thrown.code = 'APPROVAL_DENIED'
  const failing = wrapToolsForOperationLog([
    {
      name: 'chrome_click',
      async execute() {
        throw thrown
      },
    },
  ])
  let caught = null
  try {
    await failing[0].execute({ ref: 1 }, {})
  } catch (error) {
    caught = error
  }
  assert.equal(caught, thrown, 'the original error object is rethrown')
  entries = readEntries()
  assert.equal(entries.at(-1).tool, 'chrome_click')
  assert.equal(entries.at(-1).ok, false)
  assert.equal(entries.at(-1).errorCode, 'APPROVAL_DENIED')
  assert.deepEqual(entries.at(-1).result, {})
  assert.ok(entries.at(-1).durationMs >= 0)
})

await check('wrapper composes after wrapToolsForBackend exactly like index.js', async () => {
  useFreshHome('compose')
  const calls = []
  const router = new BackendRouter({
    desktop: {
      connected: true,
      async call(method, params) {
        calls.push({ backend: 'desktop', method, params })
        return { connected: true }
      },
    },
    headless: {
      connected: true,
      async request(method, params) {
        calls.push({ backend: 'headless', method, params })
        return { connected: true }
      },
    },
    headlessSupported: true,
  })
  let seenArgs = null
  const definitions = wrapToolsForBackend(
    [
      {
        name: 'chrome_status',
        description: 'test',
        parameters: { type: 'object', properties: {} },
        async execute(args) {
          seenArgs = args
          return { connected: await router.call('browser.status', {}).then((value) => value.connected) }
        },
      },
    ],
    router,
  )
  const routed = wrapToolsForOperationLog(definitions, { defaultBackend: () => router.backend })

  const routedArgs = { backend: 'headless', foo: 'bar' }
  const result = await routed[0].execute(routedArgs, {})
  assert.deepEqual(seenArgs, { foo: 'bar' }, 'backend is stripped by wrapToolsForBackend, not the log layer')
  assert.deepEqual(result, { connected: true })
  assert.deepEqual(calls, [{ backend: 'headless', method: 'browser.status', params: {} }])

  const entry = readEntries().at(-1)
  assert.equal(entry.tool, 'chrome_status')
  assert.equal(entry.backend, 'headless')
  assert.equal(entry.ok, true)
  assert.equal(entry.args.foo, 'bar')
})

// Restore the caller's environment.
if (originalHome === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = originalHome
if (originalEnabled === undefined) delete process.env.DSH_OPERATION_LOG
else process.env.DSH_OPERATION_LOG = originalEnabled
if (originalMaxBytes === undefined) delete process.env.DSH_OPERATION_LOG_MAX_BYTES
else process.env.DSH_OPERATION_LOG_MAX_BYTES = originalMaxBytes

console.log(`\n${checks} checks passed, ${failures} failed`)
if (failures > 0) process.exitCode = 1
