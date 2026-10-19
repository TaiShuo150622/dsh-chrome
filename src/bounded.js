/**
 * Bounded-wait primitives for browser teardown (H7).
 *
 * A wedged CDP socket or a child that ignores SIGTERM must never hold provider
 * unload open: every teardown step gets an explicit deadline and the next,
 * harder step runs when it expires. These helpers are pure (no timers left
 * behind) so fake-CDP/fake-child tests can pin the budget without Chrome.
 */

// Browser.close gets this long before the child is signalled.
export const BROWSER_CLOSE_TIMEOUT_MS = 2000
// SIGTERM gets this long before SIGKILL.
export const CHILD_TERM_TIMEOUT_MS = 1000
// BrowserContextManager waits this long for one driver.close() before it
// continues with profile cleanup (a driver-level close has its own 3s budget).
export const CONTEXT_CLOSE_TIMEOUT_MS = 5000

/**
 * Settle one promise within a deadline without throwing.
 *
 * Resolves `{ status: 'fulfilled', value }`, `{ status: 'rejected', error }` or
 * `{ status: 'timeout' }`. Callers decide whether a rejection is expected
 * (most teardown steps are best-effort) and log the deadline case explicitly.
 */
export function settleWithin(promise, timeoutMs) {
  const limit = Number.isFinite(timeoutMs) ? Math.max(0, Number(timeoutMs)) : 0
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve({ status: 'timeout' })
    }, limit)
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ status: 'fulfilled', value })
      },
      (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ status: 'rejected', error })
      },
    )
  })
}

/** Resolve with the promise value, or `fallback` on timeout/rejection. */
export async function withTimeout(promise, timeoutMs, fallback = null) {
  const outcome = await settleWithin(promise, timeoutMs)
  return outcome.status === 'fulfilled' ? outcome.value : fallback
}

/**
 * Wait for a child `exit` event, bounded. Resolves true when the process has
 * already exited (`exitCode`/`signalCode` set) or emits `exit` in time, false
 * on the deadline. Fake children without `.once()` count as not exited so the
 * caller still escalates to SIGKILL.
 */
export function waitForExit(child, timeoutMs) {
  if (!child) return Promise.resolve(false)
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve(true)
  if (typeof child.once !== 'function') return Promise.resolve(false)
  return new Promise((resolve) => {
    let settled = false
    let timer = null
    const finish = (value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      try {
        child.removeListener?.('exit', onExit)
      } catch {
        // fake child without removeListener
      }
      resolve(value)
    }
    const onExit = () => finish(true)
    timer = setTimeout(() => finish(false), Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 0)
    try {
      child.once('exit', onExit)
    } catch {
      finish(true)
    }
    if (settled) clearTimeout(timer)
  })
}
