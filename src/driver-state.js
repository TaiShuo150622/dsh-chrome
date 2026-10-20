/**
 * Visible driver state for headless contexts (H8).
 *
 * A crashed browser used to be indistinguishable from a running one in status
 * output until the next request failed. These helpers turn the driver's own
 * terminal markers into the four states the tools expose; no launch is started
 * here, so asking for state can never silently restart a crashed context.
 *
 *   ready    — the context has a driver that can serve requests (it may still
 *              be lazily starting; the first request launches Chrome)
 *   closing  — an intentional close is in flight
 *   crashed  — the browser exited unexpectedly (`dead` + `deathReason`)
 *   dead     — there is no driver at all
 */

export const DRIVER_STATES = ['ready', 'crashed', 'closing', 'dead']

export function driverState(driver) {
  if (!driver) return 'dead'
  // Closing wins over crashed: an intentional teardown is not a crash.
  if (driver.closing === true || driver.closePromise) return 'closing'
  if (driver.dead === true) return 'crashed'
  return 'ready'
}

/** Model-facing summary for chrome_status / chrome_context. */
export function driverInfo(driver) {
  return {
    state: driverState(driver),
    deathReason: driver?.deathReason ?? null,
    chromePid: driver?.chrome?.pid ?? driver?.loginProcess?.pid ?? null,
  }
}
