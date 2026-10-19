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
    return this.manager.stats().active > 0
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
      // must not leave a phantom "running" context behind. The same applies to
      // an existing context whose browser went away: when the request failure
      // left the driver disconnected (failed restart / crashed browser), close
      // the context instead of reporting it as usable on the next request.
      const unavailable = driver.connected === false
      if (created || unavailable) {
        try { await this.manager.close(ctx.contextId) } catch {}
      }
      throw error
    }
  }

  async close() {
    await this.manager.closeAll()
  }
}
