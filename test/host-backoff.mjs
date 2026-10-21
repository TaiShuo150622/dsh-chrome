/**
 * P5: native-host reconnect backoff.
 *
 * During an extension auto-reload the provider socket can be absent for a
 * short while. The host must retry with exponential backoff instead of
 * spinning: otherwise a reload produces a burst of failed connects and makes
 * the "two hosts at once" window worse. The host has no provider here; it
 * keeps retrying until a discovery file appears.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-host-backoff-'))
const logPath = path.join(home, 'cache', 'dsh-chrome', 'host.log')
fs.mkdirSync(path.dirname(logPath), { recursive: true })

const host = spawn(process.execPath, [path.join(root, 'host', 'host.mjs')], {
  env: {
    ...process.env,
    DSH_HOME: home,
    DSH_HOST_RETRY_BASE_MS: '50',
    DSH_HOST_RETRY_MAX_MS: '400',
    DSH_UPDATE_POLL_MS: '100000',
  },
  stdio: ['pipe', 'pipe', 'inherit'],
})
host.stdout.on('data', () => {})

function readLog() {
  try {
    return fs.readFileSync(logPath, 'utf8')
  } catch {
    return ''
  }
}

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate(readLog())) return readLog()
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  throw new Error(`timed out waiting for ${label}; host.log:\n${readLog()}`)
}

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`)
  else {
    failures += 1
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

try {
  const log = await waitFor(
    (text) => /will reconnect in 400ms/.test(text),
    5000,
    'retry backoff to reach 400ms',
  )
  const delays = [...log.matchAll(/will reconnect in (\d+)ms/g)].map((match) => Number(match[1]))
  const firstFour = delays.slice(0, 4)
  check(
    'host backs off exponentially while the provider is absent',
    JSON.stringify(firstFour) === JSON.stringify([50, 100, 200, 400]),
    JSON.stringify(firstFour),
  )
  check('host caps the retry delay', delays.every((delay) => delay <= 400), JSON.stringify(delays))
  const retryCount = delays.length
  await new Promise((resolve) => setTimeout(resolve, 600))
  check(
    'host keeps retrying instead of exiting',
    host.exitCode === null && readLog().match(/will reconnect in/g)?.length > retryCount,
    `exit=${host.exitCode}`,
  )
} finally {
  host.kill('SIGTERM')
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2000)
    host.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

console.log(failures === 0 ? '\nHOST BACKOFF TEST: PASS' : `\nHOST BACKOFF TEST: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
