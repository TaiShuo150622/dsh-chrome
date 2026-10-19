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
    this.maxContexts = config.browser.maxContexts
    this.idleTimeoutMs = config.browser.idleTimeoutMs
    this.profilesRoot = config.browser.profilesDir || path.join(home, 'cache', 'dsh-chrome', 'profiles')
    this.reaper = null
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
    if (this.contexts.size >= this.maxContexts) throw new ContextError('CONTEXT_LIMIT', `too many browser contexts (max ${this.maxContexts})`)
    const mode = presetToMode(preset || this.config.browser.preset)
    if (mode.isolation === 'shared') {
      throw new ContextError('UNSUPPORTED_MODE', 'shared contexts require tab/window leases (I3); use sandbox/sandbox-persistent/debug')
    }
    const contextId = randomUUID()
    const named = mode.isolation === 'named'
    const profileId = named ? safeName(profileName || `${owner}-${Date.now()}`) : `ephemeral-${contextId}`
    if (named && [...this.contexts.values()].some((ctx) => ctx.profileId === profileId)) {
      throw new ContextError('PROFILE_IN_USE', `named profile ${profileId} is already used by another context`)
    }
    const profileDir = path.join(this.profilesRoot, profileId)
    fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 })
    const driver = await this.createDriver({ contextId, owner, profileDir, visible: mode.visible, isolation: mode.isolation, cwd })
    const ctx = {
      contextId,
      owner,
      preset: preset || this.config.browser.preset,
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

  stats() {
    return { active: this.contexts.size, max: this.maxContexts, sessions: [...this.contexts.values()].map((ctx) => ({ contextId: ctx.contextId, owner: ctx.owner, preset: ctx.preset, visible: ctx.visible, isolation: ctx.isolation })) }
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
