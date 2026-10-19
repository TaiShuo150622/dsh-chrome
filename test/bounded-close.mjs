/**
 * H7: bounded teardown with fake CDP / fake child (no Chrome required).
 *
 * A wedged CDP socket must not hold `HeadlessDriver.close()` open: Browser.close
 * gets 2s, then SIGTERM gets 1s, then SIGKILL. The context manager adds its own
 * deadline so a driver that never answers cannot stall provider unload, and a
 * failed create still rolls back a half-started driver within that budget.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { BROWSER_CLOSE_TIMEOUT_MS, CHILD_TERM_TIMEOUT_MS, waitForExit, withTimeout } from '../src/bounded.js'
import { DEFAULT_CONFIG } from '../src/config.js'
import { BrowserContextManager } from '../src/contexts.js'
import { HeadlessDriver } from '../src/headless.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bounded-close-'))
const home = path.join(root, 'home')
fs.mkdirSync(home, { recursive: true })

function bareDriver() {
  return new HeadlessDriver({ home, spawnImpl: () => { throw new Error('fake spawn must not run') } })
}

function fakeChild({ exitOnTerm = false } = {}) {
  const child = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  child.signals = []
  child.kill = (signal) => {
    child.signals.push(signal)
    if (signal === 'SIGTERM' && exitOnTerm) {
      child.exitCode = 0
      setImmediate(() => child.emit('exit', 0))
    }
    return true
  }
  return child
}

function wedgedCdp() {
  const cdp = {
    calls: [],
    closed: false,
    send(method) {
      cdp.calls.push(method)
      return new Promise(() => {}) // never answers
    },
    close() {
      cdp.closed = true
    },
  }
  return cdp
}

try {
  // Primitives: deadline, rejection and already-exited child.
  const fast = await withTimeout(Promise.resolve('ok'), 50, 'fallback')
  assert.equal(fast, 'ok')
  const timedOut = await withTimeout(new Promise(() => {}), 30, 'fallback')
  assert.equal(timedOut, 'fallback')
  const rejected = await withTimeout(Promise.reject(new Error('boom')), 50, 'fallback')
  assert.equal(rejected, 'fallback')
  const exitedChild = fakeChild()
  exitedChild.exitCode = 1
  assert.equal(await waitForExit(exitedChild, 50), true, 'an already-exited child counts as exited')
  const ignoringChild = fakeChild()
  const startedWait = Date.now()
  assert.equal(await waitForExit(ignoringChild, 40), false, 'a child that never emits exit times out')
  assert.ok(Date.now() - startedWait >= 30, 'waitForExit must actually wait')

  // Wedged Browser.close + child that ignores SIGTERM: close returns inside the
  // advertised budget and escalates Browser.close -> SIGTERM -> SIGKILL.
  const driver = bareDriver()
  const cdp = wedgedCdp()
  const child = fakeChild()
  driver.cdp = cdp
  driver.chrome = child
  const startedAt = Date.now()
  await driver.close()
  const elapsed = Date.now() - startedAt
  assert.deepEqual(cdp.calls, ['Browser.close'], 'Browser.close must be attempted once')
  assert.equal(cdp.closed, true, 'the CDP client is closed even when Browser.close is wedged')
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL'], JSON.stringify(child.signals))
  assert.ok(
    elapsed >= BROWSER_CLOSE_TIMEOUT_MS + CHILD_TERM_TIMEOUT_MS - 150,
    `close returned before its budget (${elapsed}ms)`,
  )
  assert.ok(
    elapsed < BROWSER_CLOSE_TIMEOUT_MS + CHILD_TERM_TIMEOUT_MS + 1500,
    `close exceeded its budget (${elapsed}ms)`,
  )
  assert.equal(driver.closePromise, null, 'the in-flight close is cleared after it settles')
  assert.equal(driver.cdp, null)
  assert.equal(driver.chrome, null)
  assert.equal(driver.dead, false, 'an intentional close is not a crash')
  assert.equal(driver.deathReason, null)

  // A child that exits on SIGTERM is not SIGKILLed.
  const termDriver = bareDriver()
  termDriver.cdp = wedgedCdp()
  const termChild = fakeChild({ exitOnTerm: true })
  termDriver.chrome = termChild
  const termStarted = Date.now()
  await termDriver.close()
  assert.deepEqual(termChild.signals, ['SIGTERM'], 'an exiting child must not receive SIGKILL')
  assert.equal(termDriver.chrome, null)
  assert.ok(Date.now() - termStarted < BROWSER_CLOSE_TIMEOUT_MS + 1000, 'SIGTERM exit must not wait the full 1s')

  // No browser: close is immediate and idempotent.
  const idleDriver = bareDriver()
  const idleStarted = Date.now()
  await idleDriver.close()
  await idleDriver.close()
  assert.ok(Date.now() - idleStarted < 250, 'a dead driver must close immediately')

  // Concurrent closes share one in-flight close (one Browser.close attempt).
  const sharedDriver = bareDriver()
  const sharedCdp = wedgedCdp()
  sharedDriver.cdp = sharedCdp
  const first = sharedDriver.close()
  const second = sharedDriver.close()
  assert.equal(first, second, 'concurrent close() calls must share the closePromise')
  await Promise.all([first, second])
  assert.deepEqual(sharedCdp.calls, ['Browser.close'])
  assert.equal(sharedDriver.closePromise, null)

  // Manager: closeAll closes contexts concurrently (one deadline, not N).
  const events = []
  const config = {
    ...DEFAULT_CONFIG,
    browser: { ...DEFAULT_CONFIG.browser, preset: 'sandbox', maxContexts: 2, idleTimeoutMs: 60_000 },
  }
  const parallel = new BrowserContextManager({
    config,
    home,
    closeTimeoutMs: 1000,
    createDriver: async () => ({
      close: () =>
        new Promise((resolve) => {
          events.push('start')
          setTimeout(() => {
            events.push('finish')
            resolve()
          }, 100)
        }),
    }),
  })
  await parallel.create({ owner: 'owner-a' })
  await parallel.create({ owner: 'owner-b' })
  await parallel.closeAll()
  assert.equal(parallel.contexts.size, 0)
  assert.deepEqual(events.slice(0, 2), ['start', 'start'], `closeAll must close concurrently: ${events}`)
  await parallel.closeAll()

  // Manager: a hanging driver is bounded; the context/profile is still cleaned.
  const hanging = new BrowserContextManager({
    config,
    home,
    closeTimeoutMs: 80,
    createDriver: async () => ({ close: () => new Promise(() => {}) }),
  })
  const hangingContext = await hanging.create({ owner: 'hanging' })
  const hangingStarted = Date.now()
  await hanging.close(hangingContext.contextId)
  const hangingElapsed = Date.now() - hangingStarted
  assert.ok(hangingElapsed < 1000, `manager close must be bounded (${hangingElapsed}ms)`)
  assert.equal(hanging.contexts.size, 0)
  assert.equal(hanging.reservedProfiles.size, 0)
  assert.equal(
    fs.existsSync(path.join(home, 'cache', 'dsh-chrome', 'profiles', hangingContext.profileId)),
    false,
    'the ephemeral profile is removed even when the driver close hangs',
  )

  // Manager: a failed create rolls back a half-started driver within the same
  // budget (the injected clock fails after createDriver resolved).
  let clockCalls = 0
  let cleanupClosed = 0
  const failing = new BrowserContextManager({
    config,
    home,
    closeTimeoutMs: 80,
    now: () => {
      clockCalls += 1
      if (clockCalls === 2) throw new Error('clock exploded')
      return Date.now()
    },
    createDriver: async () => ({
      close: () => {
        cleanupClosed += 1
        return new Promise(() => {})
      },
    }),
  })
  const failingStarted = Date.now()
  await assert.rejects(() => failing.create({ owner: 'failing' }), /clock exploded/)
  const failingElapsed = Date.now() - failingStarted
  assert.equal(cleanupClosed, 1, 'the half-started driver gets one bounded close attempt')
  assert.ok(failingElapsed < 1000, `startup cleanup must be bounded (${failingElapsed}ms)`)
  assert.equal(failing.contexts.size, 0)
  assert.equal(failing.pending, 0)

  console.log('BOUNDED CLOSE TEST: PASS')
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
