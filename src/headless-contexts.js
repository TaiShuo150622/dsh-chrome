/**
 * BackendRouter-facing adapter that routes `backend:"headless"` calls to the
 * owning session's browser context. Contexts are created lazily with the
 * configured default preset and reused until idle/closed.
 */
export class HeadlessContextRouter {
  constructor({ manager, logger = null }) {
    if (!manager) throw new Error('HeadlessContextRouter requires a BrowserContextManager')
    this.manager = manager
    this.logger = logger
    this.lastBrowserVersion = null
  }

  get home() {
    return this.manager.home
  }

  get connected() {
    // H8: "connected" means at least one context's driver is ready. A context
    // whose browser crashed stays in the manager for status/restart but must
    // not make the headless backend look connected.
    return this.manager.driverStates().some((entry) => entry.state === 'ready')
  }

  /**
   * H8: driver state for chrome_status. Scoped to the calling owner when one is
   * provided (never expose another session's context id); otherwise reports
   * aggregate state counts. Never launches a browser.
   */
  info(owner = null) {
    const states = this.manager.driverStates()
    const active = owner != null ? this.manager.activeFor(owner) : null
    const activeState = active ? states.find((entry) => entry.contextId === active.contextId) || null : null
    const counts = { ready: 0, crashed: 0, closing: 0, dead: 0 }
    for (const entry of states) counts[entry.state] = (counts[entry.state] || 0) + 1
    const fallbackState = counts.ready
      ? 'ready'
      : counts.crashed
        ? 'crashed'
        : counts.closing
          ? 'closing'
          : 'dead'
    const state = activeState?.state ?? fallbackState
    return {
      state,
      deathReason: activeState?.deathReason ?? null,
      chromePid: activeState?.chromePid ?? null,
      activeContextId: active?.contextId ?? null,
      driverStates: counts,
    }
  }

  get browserVersion() {
    return this.lastBrowserVersion
  }

  /** Live tab/context limits for chrome_status (M4). */
  limits() {
    return typeof this.manager.limits === 'function' ? this.manager.limits() : null
  }

  async request(method, params = {}) {
    const owner = params?.owner || 'default'
    let ctx = this.manager.activeFor(owner)
    const created = !ctx
    if (!ctx) ctx = await this.manager.create({ owner })
    this.manager.touch(ctx.contextId)
    const driver = this.manager.driverFor(ctx.contextId)
    if (!driver) {
      if (created) await this.manager.close(ctx.contextId)
      throw Object.assign(new Error(`context ${ctx.contextId} has no driver`), { code: 'CONTEXT_NOT_FOUND' })
    }
    try {
      const result = await driver.request(method, params)
      if (driver.browserVersion) this.lastBrowserVersion = driver.browserVersion
      return result
    } catch (error) {
      // A failed first launch (e.g. configured Edge/Brave executable missing)
      // must not leave a phantom "running" context behind, and a driver that
      // merely disconnected without a terminal crash marker is closed as
      // before. H8: a driver that actually crashed (`dead`) is kept so the
      // crash stays visible in chrome_status/chrome_context and recovery is an
      // explicit restart — never a silent relaunch on the next request.
      const unavailable = driver.connected === false
      const crashed = driver.dead === true
      if (created || (unavailable && !crashed)) {
        try { await this.manager.close(ctx.contextId) } catch {}
      }
      throw error
    }
  }

  async close() {
    await this.manager.closeAll()
  }
}
