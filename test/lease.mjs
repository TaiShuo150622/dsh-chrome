/**
 * Lease foundation tests (src/lease.js + chrome_lease) — no Chrome required.
 *
 * Covers the I3 minimum: one writer per tab, shared readers, TTL expiry,
 * renew/heartbeat, release, user takeover, releaseTab, stable error codes and
 * the tool wrapper (including LEASES_UNAVAILABLE when no manager is wired).
 *
 * Run directly:
 *
 *   node test/lease.mjs
 */
import assert from 'node:assert/strict'

import { BrowserLeaseManager, DEFAULT_LEASE_TTL_MS, MAX_LEASE_TTL_MS } from '../src/lease.js'
import { chromeTools } from '../src/tools.js'

let checks = 0
let failures = 0
async function check(name, fn) {
  try {
    await fn()
    checks += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${name}: ${error?.stack || error}`)
  }
}

function isCode(code) {
  return (error) => error?.code === code
}

const now = 1_000_000
let clock = now
const manager = new BrowserLeaseManager({ now: () => clock })

try {
  await check('read leases are shared across owners', () => {
    const readA = manager.acquire({ tabId: 7, owner: 'session-a', mode: 'read', ttlMs: 5000 })
    const readB = manager.acquire({ tabId: 7, owner: 'session-b', mode: 'read', ttlMs: 5000 })
    assert.equal(readA.mode, 'read')
    assert.equal(readB.mode, 'read')
    assert.notEqual(readA.leaseId, readB.leaseId)
    const status = manager.status(7)
    assert.equal(status.active, true)
    assert.equal(status.count, 2)
    assert.deepEqual(status.holders, ['session-a', 'session-b'])
    assert.equal(status.write, null)
    assert.equal(status.read.length, 2)
    assert.deepEqual(manager.list({ tabId: 7 }).map((lease) => lease.owner), ['session-a', 'session-b'])
    assert.equal(manager.list({ owner: 'session-a' }).length, 1)
    assert.equal(manager.list({ mode: 'write' }).length, 0)
    assert.equal(manager.release(readA.leaseId, { owner: 'session-a' }).leaseId, readA.leaseId)
    assert.equal(manager.release(readB.leaseId, { owner: 'session-b' }).leaseId, readB.leaseId)
    assert.equal(manager.status(7).active, false)
  })

  await check('write leases are exclusive', () => {
    const keepA = manager.acquire({ tabId: 7, owner: 'session-a', mode: 'read' })
    const keepB = manager.acquire({ tabId: 7, owner: 'session-b', mode: 'read' })
    assert.throws(() => manager.acquire({ tabId: 7, owner: 'session-c', mode: 'write' }), (error) => {
      assert.equal(error.code, 'LEASE_HELD')
      assert.equal(error.details.tabId, 7)
      assert.equal(error.details.holders.length, 2)
      return true
    })
    manager.release(keepA.leaseId)
    manager.release(keepB.leaseId)

    const write = manager.acquire({ tabId: 7, owner: 'session-c', mode: 'write' })
    assert.equal(write.mode, 'write')
    assert.throws(() => manager.acquire({ tabId: 7, owner: 'session-d', mode: 'write' }), isCode('LEASE_HELD'))
    assert.throws(() => manager.acquire({ tabId: 7, owner: 'session-d', mode: 'read' }), isCode('LEASE_HELD'))
    manager.release(write.leaseId, { owner: 'session-c' })

    const after = manager.acquire({ tabId: 7, owner: 'session-d', mode: 'read' })
    assert.equal(after.mode, 'read')
    manager.release(after.leaseId)
  })

  await check('concurrent write attempts produce exactly one writer', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        Promise.resolve().then(() => manager.acquire({ tabId: 16, owner: `writer-${index}`, mode: 'write' })),
      ),
    )
    const winners = results.filter((result) => result.status === 'fulfilled')
    const losers = results.filter((result) => result.status === 'rejected')
    assert.equal(winners.length, 1)
    assert.equal(losers.length, 7)
    assert.ok(losers.every((result) => result.reason.code === 'LEASE_HELD'))
    manager.releaseTab(16)
  })

  await check('renew extends one lease and enforces ownership', () => {
    const lease = manager.acquire({ tabId: 8, owner: 'owner-a', mode: 'read', ttlMs: 1000 })
    assert.equal(lease.expiresAt, clock + 1000)
    clock += 400
    const renewed = manager.renew(lease.leaseId, { owner: 'owner-a', ttlMs: 2000 })
    assert.equal(renewed.expiresAt, clock + 2000)
    assert.throws(() => manager.renew(lease.leaseId, { owner: 'owner-b' }), isCode('LEASE_OWNER_MISMATCH'))
    assert.throws(() => manager.renew('missing-lease'), isCode('LEASE_NOT_FOUND'))
    assert.throws(() => manager.renew(lease.leaseId, { ttlMs: 0 }), isCode('INVALID_ARGUMENT'))
    manager.release(lease.leaseId, { owner: 'owner-a' })
  })

  await check('release enforces ownership and is not idempotent', () => {
    const lease = manager.acquire({ tabId: 8, owner: 'owner-a', mode: 'read' })
    assert.throws(() => manager.release(lease.leaseId, { owner: 'owner-b' }), isCode('LEASE_OWNER_MISMATCH'))
    const released = manager.release(lease.leaseId, { owner: 'owner-a' })
    assert.equal(released.leaseId, lease.leaseId)
    assert.throws(() => manager.release(lease.leaseId), isCode('LEASE_NOT_FOUND'))
  })

  await check('TTL expiry invalidates leases lazily', () => {
    const forRenew = manager.acquire({ tabId: 9, owner: 'owner-a', mode: 'read', ttlMs: 1000 })
    const forRelease = manager.acquire({ tabId: 9, owner: 'owner-b', mode: 'read', ttlMs: 1000 })
    clock += 1000
    assert.throws(() => manager.renew(forRenew.leaseId), isCode('LEASE_EXPIRED'))
    assert.throws(() => manager.release(forRelease.leaseId), isCode('LEASE_EXPIRED'))
    assert.equal(manager.list({ tabId: 9 }).length, 0)
    assert.equal(manager.status(9).active, false)
    const reused = manager.acquire({ tabId: 9, owner: 'owner-c', mode: 'write' })
    assert.equal(reused.mode, 'write')
    manager.release(reused.leaseId)
  })

  await check('heartbeat renews every lease owned by one session', () => {
    const first = manager.acquire({ tabId: 11, owner: 'heartbeat', mode: 'read', ttlMs: 1000 })
    const second = manager.acquire({ tabId: 12, owner: 'heartbeat', mode: 'read', ttlMs: 1000 })
    const other = manager.acquire({ tabId: 11, owner: 'other', mode: 'read', ttlMs: 1000 })
    const otherExpiry = other.expiresAt
    clock += 500
    const renewed = manager.heartbeat('heartbeat', { ttlMs: 3000 })
    assert.equal(renewed.length, 2)
    assert.deepEqual(renewed.map((lease) => lease.leaseId).sort(), [first.leaseId, second.leaseId].sort())
    assert.ok(renewed.every((lease) => lease.expiresAt === clock + 3000))
    const untouched = manager.status(11).leases.find((lease) => lease.owner === 'other')
    assert.equal(untouched.expiresAt, otherExpiry)
    assert.throws(() => manager.heartbeat('heartbeat', { leaseIds: [other.leaseId] }), isCode('LEASE_OWNER_MISMATCH'))
    assert.throws(() => manager.heartbeat('heartbeat', { leaseIds: ['missing-lease'] }), isCode('LEASE_NOT_FOUND'))
    manager.releaseTab(11, { reason: 'tab-closed' })
    manager.release(second.leaseId, { owner: 'heartbeat' })
  })

  await check('releaseTab drops every lease on the tab', () => {
    const first = manager.acquire({ tabId: 13, owner: 'owner-a', mode: 'read' })
    const second = manager.acquire({ tabId: 13, owner: 'owner-b', mode: 'read' })
    const result = manager.releaseTab(13, { reason: 'navigation' })
    assert.equal(result.tabId, 13)
    assert.equal(result.reason, 'navigation')
    assert.equal(result.revokedCount, 2)
    assert.deepEqual(result.revoked.map((lease) => lease.leaseId).sort(), [first.leaseId, second.leaseId].sort())
    assert.equal(manager.status(13).active, false)
    assert.equal(manager.releaseTab(13).revokedCount, 0)
  })

  await check('user takeover is explicit and revokes agent leases', () => {
    manager.acquire({ tabId: 14, owner: 'owner-a', mode: 'read' })
    manager.acquire({ tabId: 14, owner: 'owner-b', mode: 'read' })
    assert.throws(() => manager.takeover(14, { by: 'agent' }), isCode('USER_TAKEOVER_REQUIRED'))
    assert.throws(() => manager.takeover(14), isCode('USER_TAKEOVER_REQUIRED'))
    const taken = manager.takeover(14, { by: 'user' })
    assert.equal(taken.by, 'user')
    assert.equal(taken.revokedCount, 2)
    assert.deepEqual(taken.revoked.map((lease) => lease.owner).sort(), ['owner-a', 'owner-b'])
    assert.equal(manager.status(14).active, false)
  })

  await check('invalid arguments and TTL bounds use INVALID_ARGUMENT', () => {
    assert.throws(() => manager.acquire({ owner: 'owner-a' }), isCode('INVALID_ARGUMENT'))
    assert.throws(() => manager.acquire({ tabId: 1, owner: '' }), isCode('INVALID_ARGUMENT'))
    assert.throws(() => manager.acquire({ tabId: 1, owner: 'owner-a', mode: 'admin' }), isCode('INVALID_ARGUMENT'))
    assert.throws(() => manager.acquire({ tabId: 1, owner: 'owner-a', ttlMs: -1 }), isCode('INVALID_ARGUMENT'))
    assert.throws(() => manager.acquire({ tabId: 1, owner: 'owner-a', ttlMs: MAX_LEASE_TTL_MS + 1 }), isCode('INVALID_ARGUMENT'))
    assert.equal(DEFAULT_LEASE_TTL_MS, 60_000)
    assert.equal(MAX_LEASE_TTL_MS, 900_000)
    const defaulted = manager.acquire({ tabId: 15, owner: 'owner-a' })
    assert.equal(defaulted.expiresAt, clock + DEFAULT_LEASE_TTL_MS)
    manager.release(defaulted.leaseId)
  })

  await check('all leases are in memory only', () => {
    const fresh = new BrowserLeaseManager()
    assert.equal(fresh.list().length, 0)
    assert.equal(manager.clear(), 0)
  })

  await check('chrome_lease tool maps manager operations and owner', async () => {
    const toolManager = new BrowserLeaseManager({ now: () => clock })
    const tools = chromeTools({
      bridge: {},
      attachments: () => null,
      assets: () => ({}),
      approval: () => null,
      leases: toolManager,
    })
    assert.equal(tools.length, 45)
    const leaseTool = tools.find((tool) => tool.name === 'chrome_lease')
    assert.ok(leaseTool)
    const exec = (id) => ({ agent: { id }, callId: 'lease-call', signal: new AbortController().signal })

    const acquired = await leaseTool.execute({ op: 'acquire', tabId: 21, mode: 'read', ttlMs: 2000 }, exec('tool-a'))
    assert.equal(acquired.ok, true)
    assert.equal(acquired.lease.owner, 'tool-a')
    assert.equal(acquired.lease.tabId, 21)

    const listed = await leaseTool.execute({ op: 'list', tabId: 21 }, exec('tool-b'))
    assert.equal(listed.leases.length, 1)
    const rendered = leaseTool.output.render({ op: 'list' }, listed)
    assert.ok(rendered[0].text.includes('tool-a'))

    const status = await leaseTool.execute({ op: 'status', tabId: 21 }, exec('tool-b'))
    assert.equal(status.status.count, 1)
    assert.deepEqual(status.status.holders, ['tool-a'])

    const renewed = await leaseTool.execute(
      { op: 'renew', leaseId: acquired.lease.leaseId, ttlMs: 3000 },
      exec('tool-a'),
    )
    assert.equal(renewed.lease.expiresAt, clock + 3000)
    await assert.rejects(
      () => leaseTool.execute({ op: 'renew', leaseId: acquired.lease.leaseId }, exec('tool-b')),
      isCode('LEASE_OWNER_MISMATCH'),
    )
    await assert.rejects(
      () => leaseTool.execute({ op: 'acquire', tabId: 21, mode: 'write' }, exec('tool-b')),
      isCode('LEASE_HELD'),
    )

    const heartbeat = await leaseTool.execute({ op: 'renew', ttlMs: 4000 }, exec('tool-a'))
    assert.equal(heartbeat.heartbeat, true)
    assert.equal(heartbeat.leases.length, 1)
    assert.equal(heartbeat.leases[0].expiresAt, clock + 4000)

    const released = await leaseTool.execute(
      { op: 'release', leaseId: acquired.lease.leaseId },
      exec('tool-a'),
    )
    assert.equal(released.released, true)
    assert.equal(released.lease.leaseId, acquired.lease.leaseId)
    await assert.rejects(
      () => leaseTool.execute({ op: 'release', leaseId: acquired.lease.leaseId }, exec('tool-a')),
      isCode('LEASE_NOT_FOUND'),
    )

    await leaseTool.execute({ op: 'acquire', tabId: 22, mode: 'read' }, exec('tool-a'))
    await leaseTool.execute({ op: 'acquire', tabId: 22, mode: 'read' }, exec('tool-b'))
    await assert.rejects(() => leaseTool.execute({ op: 'takeover', tabId: 22 }, exec('tool-b')), isCode('USER_TAKEOVER_REQUIRED'))
    const taken = await leaseTool.execute({ op: 'takeover', tabId: 22, by: 'user' }, exec('tool-b'))
    assert.equal(taken.revokedCount, 2)
    assert.equal(toolManager.status(22).active, false)
    await assert.rejects(
      () => leaseTool.execute({ op: 'acquire', tabId: -1, owner: 'tool-a' }, exec('tool-a')),
      isCode('INVALID_ARGUMENT'),
    )
  })

  await check('chrome_lease returns LEASES_UNAVAILABLE without a manager', async () => {
    const tools = chromeTools({ bridge: {}, attachments: () => null, assets: () => ({}), approval: () => null })
    const leaseTool = tools.find((tool) => tool.name === 'chrome_lease')
    assert.ok(leaseTool)
    const result = await leaseTool.execute({ op: 'list' }, { agent: { id: 'tool-a' } })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'LEASES_UNAVAILABLE')
    const rendered = leaseTool.output.render({ op: 'list' }, result)
    assert.ok(rendered[0].text.includes('LEASES_UNAVAILABLE'))
  })
} finally {
  manager.clear()
}

console.log('')
if (failures === 0) console.log(`LEASE TEST: PASS (${checks} checks)`)
else console.log(`LEASE TEST: ${failures} FAILURE(S) (${checks} passed)`)
process.exit(failures === 0 ? 0 : 1)
