import assert from 'node:assert/strict'

import { wrapToolsForBackend } from '../src/backend.js'
import { BrowserLeaseManager } from '../src/lease.js'

const toolCalls = []
const tools = [
  {
    name: 'chrome_goto',
    description: 'fake goto',
    parameters: { type: 'object', properties: {}, additionalProperties: true },
    async execute(args, exec) {
      toolCalls.push({ tool: 'goto', owner: exec?.agent?.id, args })
      return { ok: true }
    },
  },
  {
    name: 'chrome_snapshot',
    description: 'fake snapshot',
    parameters: { type: 'object', properties: {}, additionalProperties: true },
    async execute(args, exec) {
      toolCalls.push({ tool: 'snapshot', owner: exec?.agent?.id, args })
      return { ok: true }
    },
  },
]
const router = {
  async call(method, params) {
    if (method === 'tab.tabs') return { activeTabId: 7, tabs: [{ tabId: 7, active: true }], params }
    return { ok: true }
  },
  runWithBackend(_mode, fn) {
    return fn()
  },
}
const leases = new BrowserLeaseManager()
const wrapped = wrapToolsForBackend(tools, router, { leases, leaseRequired: true })
const goto = wrapped.find((tool) => tool.name === 'chrome_goto')
const snapshot = wrapped.find((tool) => tool.name === 'chrome_snapshot')

const execA = { agent: { id: 'session-a' } }
const execB = { agent: { id: 'session-b' } }

// First write acquires/release around the call; a second owner cannot overlap.
let releaseFirst
const first = goto.execute({}, execA)
await first
assert.equal(toolCalls.length, 1)
assert.equal(leases.list().length, 0, 'implicit lease must be released after the tool')

// Read tools are not gated and may run while another owner holds the write lease.
const held = leases.acquire({ tabId: 7, owner: 'session-a', mode: 'write' })
const read = await snapshot.execute({}, execB)
assert.equal(read.ok, true)
await assert.rejects(() => goto.execute({}, execB), (error) => error.code === 'LEASE_HELD')
leases.release(held.leaseId, { owner: 'session-a' })
const after = await goto.execute({}, execB)
assert.equal(after.ok, true)

// Default mode (leaseRequired false) keeps old behavior: no implicit lease and no conflict.
const ungated = wrapToolsForBackend(tools, router).find((tool) => tool.name === 'chrome_goto')
const held2 = leases.acquire({ tabId: 7, owner: 'session-a', mode: 'write' })
const ungatedResult = await ungated.execute({}, execB)
assert.equal(ungatedResult.ok, true)
leases.release(held2.leaseId, { owner: 'session-a' })
assert.equal(leases.list().length, 0)
console.log('LEASE GATE TEST: PASS')
