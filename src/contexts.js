/**
 * Per-session browser context manager (I1 skeleton).
 *
 * A context owns one headless Chromium profile/process. The manager enforces
 * the configured concurrency cap, idle reaping, profile naming and visible-mode
 * gating. It is driver-agnostic: `createDriver` is injected so tests can run
 * without Chrome and the provider can swap in HeadlessDriver later.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { presetToMode } from './config.js'
import { DRIVER_COUNT_FIELDS, emptyContextStats } from './memory-stats.js'

export class ContextError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ContextError'
    this.code = code
  }
}

const safeName = (value) => String(value || '').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 64) || 'default'

export class BrowserContextManager {
  constructor({ config, createDriver, logger = null, now = () => Date.now(), home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh') }) {
    if (!config) throw new ContextError('INVALID_CONFIG', 'config is required')
    if (typeof createDriver !== 'function') throw new ContextError('INVALID_FACTORY', 'createDriver is required')
    this.config = config
    this.createDriver = createDriver
    this.logger = logger
    this.now = now
    this.home = home
    this.contexts = new Map()
    this.activeByOwner = new Map()
    // Slot reservations for creates that are still awaiting createDriver().
    // They count against maxContexts so concurrent creates cannot overshoot.
    this.pending = 0
    // owner -> in-flight create promise; one creating context per owner.
    this.creatingByOwner = new Map()
    // profileId -> reservation while a named profile's driver is being created.
    this.reservedProfiles = new Set()
    this.profilesRoot = config.browser.profilesDir || path.join(home, 'cache', 'dsh-chrome', 'profiles')
    this.reaper = null
  }

  // Read limits from the current effective config rather than caching them at
  // construction: the settings MVP can update these volatile fields in place
  // after a DSH settings edit (index.js adopts the new config object).
  get maxContexts() {
    return this.config.browser.maxContexts
  }

  get idleTimeoutMs() {
    return this.config.browser.idleTimeoutMs
  }

  list() {
    return [...this.contexts.values()].map((ctx) => this.#view(ctx))
  }

  get(contextId) {
    const ctx = this.contexts.get(contextId)
    return ctx ? this.#view(ctx) : null
  }

  /**
   * Owner-aware lookup: another session must not learn whether a context ID
   * exists, so both "not found" and "owned by someone else" return null.
   */
  getOwned(contextId, owner) {
    const ctx = this.contexts.get(contextId)
    return ctx && ctx.owner === owner ? this.#view(ctx) : null
  }

  listFor(owner) {
    return [...this.contexts.values()].filter((ctx) => ctx.owner === owner).map((ctx) => this.#view(ctx))
  }

  async create({ owner = 'default', preset, profileName, cwd = process.cwd() } = {}) {
    // A concurrent create for the same owner reuses the one in flight instead
    // of starting a second browser: both requests must land on one context.
    // This is checked before the limit because reuse consumes no new slot.
    const creating = this.creatingByOwner.get(owner)
    if (creating) return creating
    if (this.contexts.size + this.pending >= this.maxContexts) {
      throw new ContextError('CONTEXT_LIMIT', `too many browser contexts (max ${this.maxContexts})`)
    }
    const selectedPreset = preset || this.config.browser.preset
    const mode = presetToMode(selectedPreset)
    if (mode.isolation === 'shared') {
      throw new ContextError('UNSUPPORTED_MODE', 'shared contexts require tab/window leases (I3); use sandbox/sandbox-persistent/debug')
    }
    const contextId = randomUUID()
    const named = mode.isolation === 'named'
    const profileId = named ? safeName(profileName || `${owner}-${Date.now()}`) : `ephemeral-${contextId}`
    if (named) {
      // Reserve the name synchronously: two concurrent creates must not both
      // reach the filesystem and open the same profile.
      const inUse = this.reservedProfiles.has(profileId) ||
        [...this.contexts.values()].some((ctx) => ctx.profileId === profileId)
      if (inUse) {
        throw new ContextError('PROFILE_IN_USE', `named profile ${profileId} is already used by another context`)
      }
      this.reservedProfiles.add(profileId)
    }
    this.pending += 1
    const promise = this.#createContext({
      contextId,
      owner,
      preset: selectedPreset,
      mode,
      named,
      profileId,
      cwd,
    })
    this.creatingByOwner.set(owner, promise)
    // Clear after settlement (not inside #createContext) so even a synchronous
    // createDriver() throw cannot leave a rejected promise cached for the owner.
    const clear = () => {
      if (this.creatingByOwner.get(owner) === promise) this.creatingByOwner.delete(owner)
    }
    promise.then(clear, clear)
    return promise
  }

  async #createContext({ contextId, owner, preset, mode, named, profileId, cwd }) {
    const profileDir = path.join(this.profilesRoot, profileId)
    let driver = null
    try {
      fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 })
      driver = await this.createDriver({ contextId, owner, profileDir, visible: mode.visible, isolation: mode.isolation, cwd })
      const ctx = {
        contextId,
        owner,
        preset,
        isolation: mode.isolation,
        visible: mode.visible,
        profileId,
        profileDir,
        ephemeral: !named,
        createdAt: this.now(),
        lastUsedAt: this.now(),
        driver,
      }
      this.contexts.set(contextId, ctx)
      this.activeByOwner.set(owner, contextId)
      this.#startReaper()
      return this.#view(ctx)
    } catch (error) {
      // A failed launch must not leak the reserved slot, a half-started driver
      // or an ephemeral profile directory (C7).
      try {
        await driver?.close?.()
      } catch {}
      if (!named) {
        try {
          fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
        } catch (cleanupError) {
          this.logger?.warn?.('ephemeral profile cleanup failed: %s', cleanupError?.message || String(cleanupError))
        }
      }
      throw error
    } finally {
      this.pending -= 1
      if (named) this.reservedProfiles.delete(profileId)
    }
  }

  async close(contextId, { keepProfile = false } = {}) {
    const ctx = this.contexts.get(contextId)
    if (!ctx) return false
    this.contexts.delete(contextId)
    if (this.activeByOwner.get(ctx.owner) === contextId) this.activeByOwner.delete(ctx.owner)
    try {
      await ctx.driver?.close?.()
    } catch (error) {
      this.logger?.warn?.('browser context close failed: %s', error?.message || String(error))
    }
    if (ctx.ephemeral && !keepProfile) {
      try {
        fs.rmSync(ctx.profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      } catch (error) {
        this.logger?.warn?.('ephemeral profile cleanup failed: %s', error?.message || String(error))
      }
    }
    if (this.contexts.size === 0) this.#stopReaper()
    return true
  }

  async closeOwned(contextId, owner, options = {}) {
    const ctx = this.contexts.get(contextId)
    if (!ctx || ctx.owner !== owner) return false
    return this.close(contextId, options)
  }

  async closeAll() {
    for (const id of [...this.contexts.keys()]) await this.close(id)
  }

  activeFor(owner) {
    const contextId = this.activeByOwner.get(owner)
    return contextId ? this.contexts.get(contextId) || null : null
  }

  setActive(owner, contextId) {
    const ctx = this.contexts.get(contextId)
    if (!ctx || ctx.owner !== owner) throw new ContextError('CONTEXT_NOT_FOUND', `context ${contextId} is not owned by ${owner}`)
    this.activeByOwner.set(owner, contextId)
    return this.#view(ctx)
  }

  driverFor(contextId) {
    return this.contexts.get(contextId)?.driver || null
  }

  driverForOwned(contextId, owner) {
    const ctx = this.contexts.get(contextId)
    return ctx && ctx.owner === owner ? ctx.driver || null : null
  }

  view(contextId) {
    const ctx = this.contexts.get(contextId)
    return ctx ? this.#view(ctx) : null
  }

  touch(contextId) {
    const ctx = this.contexts.get(contextId)
    if (ctx) ctx.lastUsedAt = this.now()
  }

  async reapIdle() {
    const now = this.now()
    const idle = []
    for (const ctx of this.contexts.values()) {
      if (ctx.visible) continue // visible windows belong to the user; close explicitly
      if (now - ctx.lastUsedAt >= this.idleTimeoutMs) idle.push(ctx.contextId)
    }
    for (const id of idle) await this.close(id)
    return idle
  }

  /**
   * M4 status view: effective limits plus current usage across every context
   * managed here. `maxTabs` comes from the first live driver (all contexts
   * share the provider setting) and falls back to the configured value before
   * any browser exists.
   */
  limits() {
    let tabs = 0
    let pendingTabs = 0
    let maxTabs = this.config.browser.maxTabs
    for (const ctx of this.contexts.values()) {
      const driver = ctx.driver
      if (Number.isFinite(driver?.tabCount)) tabs += driver.tabCount
      else if (Number.isFinite(driver?.tabs?.size)) tabs += driver.tabs.size
      if (Number.isFinite(driver?.pendingTabs)) pendingTabs += driver.pendingTabs
      if (Number.isFinite(driver?.maxTabs)) maxTabs = driver.maxTabs
    }
    return {
      maxTabs,
      tabs,
      pendingTabs,
      maxContexts: this.maxContexts,
      contexts: this.contexts.size,
      pendingContexts: this.pending,
    }
  }

  stats() {
    return { active: this.contexts.size, max: this.maxContexts, sessions: [...this.contexts.values()].map((ctx) => ({ contextId: ctx.contextId, owner: ctx.owner, preset: ctx.preset, visible: ctx.visible, isolation: ctx.isolation })) }
  }

  /**
   * M6: aggregate the driver retention counters over every context. A driver's
   * `memoryStats()` is best-effort — a driver without the method or one that
   * throws contributes a null detail and zeros to the totals, never an error.
   */
  memoryStats() {
    const snapshot = emptyContextStats()
    snapshot.contexts = this.contexts.size
    snapshot.pending = this.pending
    snapshot.maxContexts = this.maxContexts
    for (const ctx of this.contexts.values()) {
      let driverStats = null
      try {
        driverStats = typeof ctx.driver?.memoryStats === 'function' ? ctx.driver.memoryStats() : null
      } catch {
        driverStats = null
      }
      if (driverStats && typeof driverStats === 'object') {
        for (const field of DRIVER_COUNT_FIELDS) {
          const value = driverStats[field]
          if (Number.isFinite(value) && value > 0) snapshot.totals[field] += Math.round(value)
        }
        if (driverStats.idleTimer) snapshot.totals.idleTimers += 1
        if (driverStats.visible) snapshot.totals.visibleDrivers += 1
      } else {
        driverStats = null
      }
      snapshot.drivers.push({
        contextId: ctx.contextId,
        owner: ctx.owner,
        preset: ctx.preset,
        visible: ctx.visible,
        connected: typeof ctx.driver?.connected === 'boolean' ? ctx.driver.connected : false,
        stats: driverStats,
      })
    }
    return snapshot
  }

  #view(ctx) {
    return {
      contextId: ctx.contextId,
      owner: ctx.owner,
      preset: ctx.preset,
      isolation: ctx.isolation,
      visible: ctx.visible,
      profileId: ctx.profileId,
      createdAt: ctx.createdAt,
      lastUsedAt: ctx.lastUsedAt,
    }
  }

  #startReaper() {
    if (this.reaper) return
    const interval = Math.max(1000, Math.min(30_000, Math.floor(this.idleTimeoutMs / 2)))
    this.reaper = setInterval(() => { void this.reapIdle() }, interval)
    this.reaper.unref?.()
  }

  #stopReaper() {
    if (!this.reaper) return
    clearInterval(this.reaper)
    this.reaper = null
  }
}
