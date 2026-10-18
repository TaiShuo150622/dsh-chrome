/**
 * Auto-stop a screencast when nobody has fetched a frame for a while.
 * Pure timer logic so it can be unit tested with a fake clock.
 */
export function createScreencastGuard({
  idleMs = 5 * 60 * 1000,
  intervalMs = 30 * 1000,
  now = () => Date.now(),
  lastViewerAt = () => 0,
  stop,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  let timer = null
  let startedAt = 0
  let active = false
  let stopped = false

  const clear = () => {
    if (timer) {
      clearIntervalFn(timer)
      timer = null
    }
  }

  const check = () => {
    if (!active || stopped) return false
    const last = Math.max(startedAt, Number(lastViewerAt()) || 0)
    if (now() - last < idleMs) return false
    active = false
    stopped = true
    clear()
    try {
      Promise.resolve(stop?.()).catch(() => {})
    } catch {
      // best effort
    }
    return true
  }

  return {
    arm() {
      clear()
      startedAt = now()
      active = true
      stopped = false
      timer = setIntervalFn(check, intervalMs)
      timer?.unref?.()
      return this
    },
    disarm() {
      active = false
      clear()
    },
    check,
    get active() {
      return active
    },
    get stopped() {
      return stopped
    },
  }
}
