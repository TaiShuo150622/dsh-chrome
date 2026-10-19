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

  async request(method, params = {}) {
    const owner = params?.owner || 'default'
    let ctx = this.manager.activeFor(owner)
    if (!ctx) ctx = await this.manager.create({ owner })
    this.manager.touch(ctx.contextId)
    const driver = this.manager.driverFor(ctx.contextId)
    if (!driver) throw Object.assign(new Error(`context ${ctx.contextId} has no driver`), { code: 'CONTEXT_NOT_FOUND' })
    const result = await driver.request(method, params)
    if (driver.browserVersion) this.lastBrowserVersion = driver.browserVersion
    return result
  }

  async close() {
    await this.manager.closeAll()
  }
}
