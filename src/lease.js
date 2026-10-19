/**
 * In-memory tab leases for shared-visible / collab sessions (I3 skeleton).
 *
 * A lease says "this session may use this tab in read or write mode until
 * expiresAt". A write lease is exclusive; read leases may be shared while no
 * write lease is active. Nothing here is persisted: the provider owns one
 * manager in memory and a restart drops every lease.
 *
 * The module is deliberately independent of tools.js, bridge.js and
 * contexts.js so it can be tested without Chrome and wired into the browser
 * action path later. Leases are currently advisory: acquiring one does not yet
 * gate chrome_* writes (see docs/LEASES.md).
 */
import { randomUUID } from 'node:crypto'

export const DEFAULT_LEASE_TTL_MS = 60_000
export const MAX_LEASE_TTL_MS = 15 * 60_000
export const LEASE_MODES = Object.freeze(['read', 'write'])

/**
 * Machine-readable lease failure. `code` is stable for tools/operation logs:
 * INVALID_ARGUMENT, LEASE_HELD, LEASE_NOT_FOUND, LEASE_EXPIRED,
 * LEASE_OWNER_MISMATCH, USER_TAKEOVER_REQUIRED.
 */
export class LeaseError extends Error {
  constructor(code, message, details = null) {
    super(message)
    this.name = 'LeaseError'
    this.code = code
    if (details != null) this.details = details
  }
}

function invalid(message) {
  return new LeaseError('INVALID_ARGUMENT', message)
}

function normalizeTabId(tabId) {
  const value = typeof tabId === 'string' && tabId.trim() !== '' ? Number(tabId) : tabId
  if (!Number.isInteger(value) || value < 0) {
    throw invalid(`tabId must be a non-negative integer, got ${JSON.stringify(tabId)}`)
  }
  return value
}

function normalizeOwner(owner) {
  const value = typeof owner === 'string' ? owner.trim() : ''
  if (!value) throw invalid('owner is required')
  if (value.length > 200) throw invalid('owner must be at most 200 characters')
  return value
}

function normalizeMode(mode) {
  const value = mode == null ? 'read' : String(mode)
  if (!LEASE_MODES.includes(value)) {
    throw invalid(`mode must be one of ${LEASE_MODES.join(', ')}, got ${JSON.stringify(mode)}`)
  }
  return value
}

function normalizeLeaseId(leaseId) {
  const value = typeof leaseId === 'string' ? leaseId.trim() : ''
  if (!value) throw invalid('leaseId is required')
  return value
}

function heldError(tabId, holders) {
  const first = holders[0]
  return new LeaseError(
    'LEASE_HELD',
    `tab ${tabId} is already held by ${first.owner} in ${first.mode} mode`,
    { tabId, holders: holders.map((lease) => ({ ...lease })) },
  )
}

export class BrowserLeaseManager {
  constructor({ now = () => Date.now(), defaultTtlMs = DEFAULT_LEASE_TTL_MS, maxTtlMs = MAX_LEASE_TTL_MS } = {}) {
    if (typeof now !== 'function') throw invalid('now must be a function')
    if (!Number.isFinite(defaultTtlMs) || defaultTtlMs < 1) throw invalid('defaultTtlMs must be a positive number')
    if (!Number.isFinite(maxTtlMs) || maxTtlMs < defaultTtlMs) throw invalid('maxTtlMs must be >= defaultTtlMs')
    this.now = now
    this.defaultTtlMs = Math.floor(defaultTtlMs)
    this.maxTtlMs = Math.floor(maxTtlMs)
    this.leases = new Map()
  }

  /**
   * Acquire a lease on a tab. Reads may share with other reads; a write needs
   * the tab to be completely idle and blocks every later acquire until it is
   * released or expires.
   */
  acquire({ tabId, owner, mode = 'read', ttlMs } = {}) {
    const target = normalizeTabId(tabId)
    const holder = normalizeOwner(owner)
    const leaseMode = normalizeMode(mode)
    const ttl = this.#ttl(ttlMs)
    const now = this.now()
    this.#sweep(now)

    const active = [...this.leases.values()].filter((lease) => lease.tabId === target)
    const write = active.find((lease) => lease.mode === 'write')
    if (leaseMode === 'write' && active.length > 0) throw heldError(target, active)
    if (leaseMode === 'read' && write) throw heldError(target, [write])

    const lease = {
      leaseId: randomUUID(),
      tabId: target,
      owner: holder,
      mode: leaseMode,
      createdAt: now,
      expiresAt: now + ttl,
    }
    this.leases.set(lease.leaseId, lease)
    return { ...lease }
  }

  /** Extend one lease from now. Expired leases are removed and reported. */
  renew(leaseId, { owner, ttlMs } = {}) {
    const id = normalizeLeaseId(leaseId)
    const ttl = this.#ttl(ttlMs)
    const now = this.now()
    const lease = this.leases.get(id)
    if (!lease) throw new LeaseError('LEASE_NOT_FOUND', `lease ${id} was not found`)
    if (lease.expiresAt <= now) {
      this.leases.delete(id)
      throw new LeaseError('LEASE_EXPIRED', `lease ${id} expired at ${new Date(lease.expiresAt).toISOString()}`)
    }
    this.#assertOwner(lease, owner)
    lease.expiresAt = now + ttl
    return { ...lease }
  }

  /** Release one lease. The returned lease is the last known view. */
  release(leaseId, { owner } = {}) {
    const id = normalizeLeaseId(leaseId)
    const now = this.now()
    const lease = this.leases.get(id)
    if (!lease) throw new LeaseError('LEASE_NOT_FOUND', `lease ${id} was not found`)
    if (lease.expiresAt <= now) {
      this.leases.delete(id)
      throw new LeaseError('LEASE_EXPIRED', `lease ${id} expired at ${new Date(lease.expiresAt).toISOString()}`)
    }
    this.#assertOwner(lease, owner)
    this.leases.delete(id)
    return { ...lease }
  }

  /**
   * Heartbeat helper: extend every active lease owned by `owner` (or only the
   * explicitly listed leaseIds) in one call. Returns the renewed leases.
   */
  heartbeat(owner, { ttlMs, leaseIds } = {}) {
    const holder = normalizeOwner(owner)
    const ttl = this.#ttl(ttlMs)
    const now = this.now()
    this.#sweep(now)

    let targets
    if (leaseIds != null) {
      if (!Array.isArray(leaseIds)) throw invalid('leaseIds must be an array')
      targets = leaseIds.map((leaseId) => {
        const id = normalizeLeaseId(leaseId)
        const lease = this.leases.get(id)
        if (!lease) throw new LeaseError('LEASE_NOT_FOUND', `lease ${id} was not found`)
        this.#assertOwner(lease, holder)
        return lease
      })
    } else {
      targets = [...this.leases.values()].filter((lease) => lease.owner === holder)
    }

    for (const lease of targets) lease.expiresAt = now + ttl
    return targets.map((lease) => ({ ...lease }))
  }

  /** List active leases, optionally filtered by tabId/owner/mode. */
  list(filter = {}) {
    const target = filter?.tabId == null ? null : normalizeTabId(filter.tabId)
    const owner = filter?.owner == null ? null : normalizeOwner(filter.owner)
    const mode = filter?.mode == null ? null : normalizeMode(filter.mode)
    this.#sweep()
    return [...this.leases.values()]
      .filter((lease) => target == null || lease.tabId === target)
      .filter((lease) => owner == null || lease.owner === owner)
      .filter((lease) => mode == null || lease.mode === mode)
      .map((lease) => ({ ...lease }))
  }

  /** Cross-owner view of one tab: who holds it and in which mode. */
  status(tabId) {
    const target = normalizeTabId(tabId)
    this.#sweep()
    const active = [...this.leases.values()].filter((lease) => lease.tabId === target)
    const write = active.find((lease) => lease.mode === 'write') || null
    return {
      tabId: target,
      active: active.length > 0,
      count: active.length,
      holders: [...new Set(active.map((lease) => lease.owner))],
      write: write ? { ...write } : null,
      read: active.filter((lease) => lease.mode === 'read').map((lease) => ({ ...lease })),
      leases: active.map((lease) => ({ ...lease })),
    }
  }

  /**
   * Explicit user takeover: revoke every agent lease on a tab. There is no
   * implicit path to this method; callers must pass by:"user". (Until the
   * action gate is wired, a later acquire can still succeed; see LEASES.md.)
   */
  takeover(tabId, { by } = {}) {
    const target = normalizeTabId(tabId)
    if (by !== 'user') {
      throw new LeaseError('USER_TAKEOVER_REQUIRED', 'takeover requires an explicit by:"user"')
    }
    this.#sweep()
    const revoked = [...this.leases.values()].filter((lease) => lease.tabId === target)
    for (const lease of revoked) this.leases.delete(lease.leaseId)
    return {
      tabId: target,
      by: 'user',
      revoked: revoked.map((lease) => ({ ...lease })),
      revokedCount: revoked.length,
    }
  }

  /**
   * Drop every lease on a tab. The integration point for tab close/navigation
   * events; callers may pass a reason for logs.
   */
  releaseTab(tabId, { reason = null } = {}) {
    const target = normalizeTabId(tabId)
    this.#sweep()
    const revoked = [...this.leases.values()].filter((lease) => lease.tabId === target)
    for (const lease of revoked) this.leases.delete(lease.leaseId)
    return {
      tabId: target,
      reason,
      revoked: revoked.map((lease) => ({ ...lease })),
      revokedCount: revoked.length,
    }
  }

  /** Drop all leases (provider shutdown / tests). */
  clear() {
    const count = this.leases.size
    this.leases.clear()
    return count
  }

  get size() {
    this.#sweep()
    return this.leases.size
  }

  #ttl(ttlMs) {
    const value = ttlMs == null ? this.defaultTtlMs : Number(ttlMs)
    if (!Number.isFinite(value) || value < 1) throw invalid('ttlMs must be a positive number of milliseconds')
    if (value > this.maxTtlMs) throw invalid(`ttlMs must be <= ${this.maxTtlMs}`)
    return Math.floor(value)
  }

  #assertOwner(lease, owner) {
    if (owner == null) return
    const holder = normalizeOwner(owner)
    if (lease.owner !== holder) {
      throw new LeaseError(
        'LEASE_OWNER_MISMATCH',
        `lease ${lease.leaseId} belongs to ${lease.owner}, not ${holder}`,
      )
    }
  }

  #sweep(now = this.now()) {
    for (const [leaseId, lease] of this.leases) {
      if (lease.expiresAt <= now) this.leases.delete(leaseId)
    }
  }
}
