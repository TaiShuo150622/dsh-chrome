import assert from 'node:assert/strict'
import path from 'node:path'

import { bridgeSocketPath } from '../src/bridge.js'

const win = bridgeSocketPath({ home: 'C:\\Users\\Workq', platform: 'win32', pid: 4321 })
assert.match(win, /^\\\\\.\\pipe\\dsh-chrome-[a-f0-9]{16}-4321$/, win)
assert.equal(win.includes('bridge.sock'), false)
const other = bridgeSocketPath({ home: 'C:\\Users\\Workq', platform: 'win32', pid: 9999 })
assert.notEqual(win, other, 'pid must make stale pipes collision-free')
assert.match(other, /-9999$/)

const posix = bridgeSocketPath({ home: '/Users/workq', platform: 'darwin', pid: 1 })
assert.equal(posix, path.join('/Users/workq', 'cache', 'dsh-chrome', 'bridge.sock'))
console.log('BRIDGE WINDOWS TEST: PASS')

// A failed listen must be recorded for chrome_status.bridgeError.
import fs from 'node:fs'
import os from 'node:os'
import { BridgeServer } from '../src/bridge.js'
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-fail-'))
try {
  fs.mkdirSync(path.join(home, 'cache', 'dsh-chrome', 'bridge.sock'), { recursive: true })
  const failing = new BridgeServer({ home, platform: 'darwin', pid: 1 })
  await assert.rejects(() => failing.start())
  assert.ok(failing.lastError instanceof Error, 'start failure must be recorded')
  assert.match(String(failing.lastError.code || failing.lastError.message), /EISDIR|ENOTDIR|EPERM|ERR/)
} finally {
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
console.log('BRIDGE FAILURE RECORD TEST: PASS')
