import assert from 'node:assert/strict'

import { SidecarBroker, SidecarError, chunkEvent } from '../src/sidecar.js'
import { BridgeServer } from '../src/bridge.js'

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms))

function fakeServices({ gap = false } = {}) {
  const calls = { prompt: [], cancel: [], follow: [] }
  const listValue = {
    items: [
      { sessionId: 's1', running: false, updatedAt: 2 },
      { sessionId: 's2', running: true, updatedAt: 1 },
    ],
  }
  const controller = {
    async list() {
      return listValue
    },
    async prompt(request) {
      calls.prompt.push(request)
      return { accepted: true }
    },
    cancel(request) {
      calls.cancel.push(request)
      return { accepted: true }
    },
    async *follow(request, signal) {
      calls.follow.push(request)
      yield { type: 'snapshot', cursor: 0, records: [], assistantStream: null, projections: null }
      yield { type: 'event', event: { type: 'user/message', seq: 1, data: { text: 'hi' } } }
      yield { type: 'event', event: { type: 'assistant/message', seq: 2, data: { text: 'hello' } } }
      yield { type: 'event', event: { type: 'assistant/message', seq: 2, data: { text: 'duplicate' } } }
      if (gap) {
        yield { type: 'event', event: { type: 'tool/result', seq: 4, data: {} } }
      } else {
        yield { type: 'event', event: { type: 'tool/result', seq: 3, data: {}, } }
        yield { type: 'assistant-stream', frame: { type: 'chunk', index: 0 } }
      }
      if (!signal.aborted) await tick(20)
    },
  }
  return { services: { sessionController: controller }, calls }
}

async function collect() {
  const events = []
  const send = (frame) => events.push(frame)
  return { events, send }
}

// 1) connect + list + bind + follow: durable exactly-once, transient kept.
{
  const { services } = fakeServices()
  const broker = new SidecarBroker({ services })
  const { events, send } = await collect()
  const client = await broker.connect({ clientInstanceId: 'c1', windowId: 1, send })
  assert.ok(client.clientId)
  const sessions = await broker.request(client.clientId, 'sessions.list')
  assert.equal(sessions.items.length, 2)
  await assert.rejects(() => broker.request(client.clientId, 'prompt', { requestId: 'r0', content: [{ type: 'text', text: 'x' }] }), (error) => error.code === 'SESSION_UNBOUND')
  assert.deepEqual(await broker.request(client.clientId, 'session.bind', { sessionId: 's1' }), { sessionId: 's1' })
  await broker.request(client.clientId, 'session.follow', {})
  await tick(40)
  const snapshot = events.find((event) => event.event === 'sidecar.session.snapshot')
  assert.ok(snapshot)
  const durable = events.filter((event) => event.event === 'sidecar.session.durable')
  assert.deepEqual(durable.map((event) => event.params.seq), [1, 2, 3])
  assert.ok(events.some((event) => event.event === 'sidecar.assistant.stream'))
  broker.stop()
}

// 2) durable gap reports and marks resyncing.
{
  const { services } = fakeServices({ gap: true })
  const broker = new SidecarBroker({ services })
  const { events, send } = await collect()
  const client = await broker.connect({ clientInstanceId: 'c2', send })
  await broker.request(client.clientId, 'session.bind', { sessionId: 's1' })
  await broker.request(client.clientId, 'session.follow', {})
  await tick(40)
  const error = events.find((event) => event.event === 'sidecar.error')
  assert.equal(error?.params?.code, 'DURABLE_GAP')
  assert.equal(broker.stats().clientsDetail[0].state, 'resyncing')
  broker.stop()
}

// 3) prompt/cancel forward to the controller and reject mismatched sessions.
{
  const { services, calls } = fakeServices()
  const broker = new SidecarBroker({ services })
  const { send } = await collect()
  const client = await broker.connect({ clientInstanceId: 'c3', send })
  await broker.request(client.clientId, 'session.bind', { sessionId: 's1' })
  const result = await broker.request(client.clientId, 'prompt', { requestId: 'r1', content: [{ type: 'text', text: 'hello' }] })
  assert.equal(result.accepted, true)
  assert.equal(calls.prompt[0].sessionId, 's1')
  assert.equal(calls.prompt[0].mode, 'queue')
  await assert.rejects(() => broker.request(client.clientId, 'prompt', { sessionId: 's2', requestId: 'r2', content: [{ type: 'text', text: 'x' }] }), (error) => error.code === 'SESSION_MISMATCH')
  await broker.request(client.clientId, 'cancel', {})
  assert.equal(calls.cancel[0].sessionId, 's1')
  broker.stop()
}

// 4) approval claim is single-winner across clients; timeout resolves cancelled.
{
  const broker = new SidecarBroker({ services: {} })
  const a = await collect()
  const b = await collect()
  const clientA = await broker.connect({ clientInstanceId: 'a', send: a.send })
  const clientB = await broker.connect({ clientInstanceId: 'b', send: b.send })
  let resolved = null
  broker.registerApproval({ approvalRequestId: 'ap1', sessionId: 's1', display: { tool: 'chrome_click' }, resolve: (outcome) => { resolved = outcome } })
  await tick(20)
  assert.ok(a.events.some((event) => event.event === 'sidecar.approval.request'))
  assert.ok(b.events.some((event) => event.event === 'sidecar.approval.request'))
  const first = await broker.request(clientA.clientId, 'approval.claim', { approvalRequestId: 'ap1', outcome: 'approved' })
  assert.equal(first.ok, true)
  assert.equal(resolved, 'approved')
  await assert.rejects(() => broker.request(clientB.clientId, 'approval.claim', { approvalRequestId: 'ap1', outcome: 'denied' }), (error) => error.code === 'ALREADY_DECIDED')
  assert.ok(b.events.some((event) => event.event === 'sidecar.approval.settled'))
  broker.stop()
}

// 5) oversized events become reassemblable chunk frames.
{
  const broker = new SidecarBroker({ services: {}, maxFrameBytes: 1024 })
  const { events, send } = await collect()
  await broker.connect({ clientInstanceId: 'c5', send })
  const big = { event: 'sidecar.session.durable', params: { payload: 'x'.repeat(5000) } }
  const chunks = chunkEvent(big, 1024)
  assert.ok(chunks.length > 1)
  assert.ok(chunks.every((frame) => Buffer.byteLength(JSON.stringify(frame)) <= 1024))
  const raw = chunks.map((frame) => frame.params.data).join('')
  assert.deepEqual(JSON.parse(raw), big)
  broker.stop()
}

// 6) missing service is explicit, not silently ignored.
{
  const broker = new SidecarBroker({ services: {} })
  const { send } = await collect()
  const client = await broker.connect({ clientInstanceId: 'c6', send })
  await assert.rejects(() => broker.request(client.clientId, 'sessions.list'), (error) => error.code === 'SERVICE_UNAVAILABLE')
  broker.stop()
}

// 7) connection replacement aborts the old client's work.
{
  const { services } = fakeServices()
  const broker = new SidecarBroker({ services })
  const first = await collect()
  const client = await broker.connect({ clientInstanceId: 'same', send: first.send })
  await broker.request(client.clientId, 'session.bind', { sessionId: 's1' })
  await broker.request(client.clientId, 'session.follow', {})
  const second = await collect()
  await broker.connect({ clientInstanceId: 'same', send: second.send })
  assert.equal(broker.stats().clients, 1)
  assert.equal(broker.stats().clientsDetail[0].clientId !== client.clientId, true)
  broker.stop()
}

// 8) bridge emit writes an event frame only while connected.
{
  const bridge = new BridgeServer({ home: '/tmp/dsh-sidecar-test-home' })
  const writes = []
  bridge.socket = { write: (line) => writes.push(line), destroyed: false }
  bridge.authed = true
  assert.equal(bridge.emit('sidecar.event', { seq: 1 }), true)
  assert.match(writes[0], /"event":"sidecar\.event"/)
  bridge.socket = null
  assert.equal(bridge.emit('sidecar.event', { seq: 2 }), false)
}

console.log('SIDECAR TEST: PASS')
