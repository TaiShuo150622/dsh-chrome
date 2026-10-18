import assert from 'node:assert/strict'
import { createScreencastGuard } from '../src/screencast-guard.js'

let now = 0
let viewerAt = 0
let stopped = 0
let tick = null
const guard = createScreencastGuard({
  idleMs: 5 * 60 * 1000,
  intervalMs: 1000,
  now: () => now,
  lastViewerAt: () => viewerAt,
  stop: () => {
    stopped += 1
  },
  setIntervalFn: (fn) => {
    tick = fn
    return { unref() {} }
  },
  clearIntervalFn: () => {
    tick = null
  },
})

guard.arm()
now = 4 * 60 * 1000
viewerAt = 1
assert.equal(guard.check(), false, 'recent viewer activity keeps the stream alive')
now = 5 * 60 * 1000
assert.equal(guard.check(), false, 'exactly idleMs is not yet timed out')
now += 1
assert.equal(guard.check(), true, 'idle past the threshold stops the stream')
assert.equal(stopped, 1)
assert.equal(guard.active, false)

const guard2 = createScreencastGuard({
  idleMs: 1000,
  now: () => now,
  lastViewerAt: () => 0,
  stop: () => {
    stopped += 1
  },
  setIntervalFn: () => ({ unref() {} }),
  clearIntervalFn: () => {},
})
now = 0
guard2.arm()
now = 999
assert.equal(guard2.check(), false)
guard2.disarm()
now = 5000
assert.equal(guard2.check(), false, 'disarmed guard never stops')
assert.equal(stopped, 1)

console.log('SCREENCAST GUARD TEST: PASS')
