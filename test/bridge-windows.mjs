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
