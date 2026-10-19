/**
 * Sidecar broker (spike): the Host-side object the Chrome side panel talks to.
 *
 * This file is deliberately transport-agnostic. It owns the per-client state
 * machine, bounded event queues, durable-sequence checks, frame chunking and the
 * single-answer approval claim table. The bridge/native host only carry frames.
 *
 * Plan reference: docs/NATIVE-SIDECAR-PLAN-V2.md. Spike scope: mockable logic
 * first; real Host service wiring is added once the 2-3 day spike passes.
 */
import { randomUUID } from 'node:crypto'

export const SIDECAR_PROTOCOL = 1
export const SIDECAR_MAX_FRAME_BYTES = 256 * 1024
export const SIDECAR_QUEUE_LIMIT = 128

export class SidecarError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'SidecarError'
    this.code = code
  }
}

const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8')

/** Split a JSON-serializable event into transport frames <= maxFrameBytes. */
export function chunkEvent(event, maxFrameBytes = SIDECAR_MAX_FRAME_BYTES) {
  const raw = JSON.stringify(event)
  if (Buffer.byteLength(raw, 'utf8') <= maxFrameBytes) return [JSON.parse(raw)]
  const frameId = randomUUID()
  const chunks = []
  let rest = raw
  while (rest.length > 0) {
    // A character may be 1-4 bytes; leave headroom for the chunk envelope.
    let take = Math.min(rest.length, maxFrameBytes - 512)
    if (take < 1) take = 1
    let piece = rest.slice(0, take)
    while (Buffer.byteLength(piece, 'utf8') > maxFrameBytes - 512 && piece.length > 1) {
      piece = piece.slice(0, Math.floor(piece.length * 0.8))
    }
    chunks.push(piece)
    rest = rest.slice(piece.length)
  }
  return chunks.map((data, index) => ({
    event: 'sidecar.chunk',
    params: { frameId, index, total: chunks.length, data },
  }))
}

export class SidecarBroker {
  constructor({ services = {}, logger = null, maxFrameBytes = SIDECAR_MAX_FRAME_BYTES, queueLimit = SIDECAR_QUEUE_LIMIT } = {}) {
    this.services = services
    this.logger = logger
    this.maxFrameBytes = maxFrameBytes
    this.queueLimit = queueLimit
    this.clients = new Map()
    this.approvals = new Map()
    this.decidedApprovals = new Map()
    this.generation = 0
    this.stopped = false
  }

  #service(name) {
    const value = this.services?.[name]
    if (!value) throw new SidecarError('SERVICE_UNAVAILABLE', `${name} is not available in this Host`)
    return value
  }

  async connect({ clientInstanceId, windowId = null, capabilities = [], send } = {}) {
    if (this.stopped) throw new SidecarError('STOPPED', 'sidecar is stopped')
    if (typeof clientInstanceId !== 'string' || !clientInstanceId) {
      throw new SidecarError('INVALID_ARGUMENT', 'clientInstanceId is required')
    }
    if (typeof send !== 'function') throw new SidecarError('INVALID_ARGUMENT', 'send callback is required')
    let existing = null
    for (const client of this.clients.values()) {
      if (client.clientInstanceId === clientInstanceId) existing = client
    }
    if (existing) this.disconnect(existing.clientId, 'replaced')
    const generationId = ++this.generation
    const client = {
      clientId: randomUUID(),
      connectionId: randomUUID(),
      generationId,
      clientInstanceId,
      windowId,
      capabilities: new Set(capabilities),
      send,
      state: 'ready',
      boundSessionId: null,
      queue: [],
      queueDepth: 0,
      followAbort: null,
      abort: new AbortController(),
      signal: null,
      lastDurableSeq: null,
      droppedTransient: 0,
      createdAt: Date.now(),
    }
    client.signal = client.abort.signal
    this.clients.set(client.clientId, client)
    this.#send(client, {
      event: 'sidecar.ready',
      params: {
        connectionId: client.connectionId,
        protocol: SIDECAR_PROTOCOL,
        maxFrameBytes: this.maxFrameBytes,
        capabilities: ['sessions.list', 'session.bind', 'session.follow', 'prompt', 'cancel', 'approval.claim'],
      },
    })
    return { clientId: client.clientId, connectionId: client.connectionId, generationId }
  }

  disconnect(clientId, reason = 'closed') {
    const client = this.clients.get(clientId)
    if (!client) return false
    try {
      client.followAbort?.abort()
      client.abort.abort()
    } catch {}
    this.clients.delete(clientId)
    // Do not auto-resolve approvals: their lifecycle belongs to DSH's request
    // signal. A closed UI must show as unavailable to the broker, not decide.
    try {
      client.send({ event: 'sidecar.disconnected', params: { reason } })
    } catch {}
    return true
  }

  async request(clientId, method, params = {}) {
    const client = this.clients.get(clientId)
    if (!client) throw new SidecarError('CLIENT_UNKNOWN', 'unknown sidecar client')
    switch (method) {
      case 'sessions.list':
        return this.#listSessions(client)
      case 'session.bind':
        return this.#bindSession(client, params)
      case 'session.unbind':
        return this.#unbindSession(client)
      case 'session.follow':
        return this.#followSession(client, params)
      case 'prompt':
        return this.#prompt(client, params)
      case 'cancel':
        return this.#cancel(client, params)
      case 'approval.claim':
        return this.#claimApproval(client, params)
      case 'ping':
        return { ok: true, at: Date.now() }
      default:
        throw new SidecarError('UNKNOWN_METHOD', `unknown sidecar method: ${method}`)
    }
  }

  async #listSessions(client) {
    const controller = this.#service('sessionController')
    const value = await controller.list({}, client.signal)
    const items = Array.isArray(value?.items) ? value.items : []
    return { items: items.map((item) => ({ ...item })) }
  }

  async #bindSession(client, params) {
    const sessionId = String(params?.sessionId || '')
    if (!sessionId) throw new SidecarError('INVALID_ARGUMENT', 'sessionId is required')
    const controller = this.#service('sessionController')
    const value = await controller.list({}, client.signal)
    const items = Array.isArray(value?.items) ? value.items : []
    if (!items.some((item) => item.sessionId === sessionId)) {
      throw new SidecarError('SESSION_NOT_VISIBLE', `session ${sessionId} is not visible to this Host`)
    }
    try {
      client.followAbort?.abort()
    } catch {}
    client.followAbort = null
    client.boundSessionId = sessionId
    client.state = 'bound'
    client.lastDurableSeq = null
    return { sessionId }
  }

  async #unbindSession(client) {
    try {
      client.followAbort?.abort()
    } catch {}
    client.followAbort = null
    client.boundSessionId = null
    client.state = 'ready'
    client.lastDurableSeq = null
    return { ok: true }
  }

  async #followSession(client, params = {}) {
    if (!client.boundSessionId) throw new SidecarError('SESSION_UNBOUND', 'bind a session before following')
    const controller = this.#service('sessionController')
    const address = params.address || { kind: 'session', sessionId: client.boundSessionId }
    const abort = new AbortController()
    client.followAbort?.abort()
    client.followAbort = abort
    const request = {
      address,
      ...(params.assistantStream ? { assistantStream: true } : {}),
      ...(params.maxMessages ? { maxMessages: params.maxMessages } : {}),
      ...(params.turnWindow ? { turnWindow: params.turnWindow } : {}),
    }
    void this.#pumpFollow(client, controller, request, abort.signal)
    return { following: true, sessionId: client.boundSessionId }
  }

  async #pumpFollow(client, controller, request, signal) {
    try {
      for await (const frame of controller.follow(request, signal)) {
        if (!this.clients.has(client.clientId)) return
        this.#onFollowFrame(client, frame)
      }
    } catch (error) {
      if (signal.aborted) return
      this.#sendEvent(client, 'sidecar.error', { code: error?.code || 'FOLLOW_FAILED', message: String(error?.message || error) })
    }
  }

  #onFollowFrame(client, frame) {
    if (!frame || typeof frame !== 'object') return
    if (frame.type === 'snapshot') {
      client.lastDurableSeq = null
      this.#sendEvent(client, 'sidecar.session.snapshot', {
        sessionId: client.boundSessionId,
        cursor: frame.cursor ?? null,
        records: frame.records ?? [],
        assistantStream: frame.assistantStream ?? null,
        projections: frame.projections ?? null,
      })
      return
    }
    if (frame.type === 'event') {
      const seq = Number(frame.event?.seq)
      if (!Number.isFinite(seq)) return
      if (client.lastDurableSeq != null) {
        if (seq <= client.lastDurableSeq) return // duplicate
        if (seq !== client.lastDurableSeq + 1) {
          this.#sendEvent(client, 'sidecar.error', { code: 'DURABLE_GAP', message: `expected seq ${client.lastDurableSeq + 1}, got ${seq}` })
          client.state = 'resyncing'
        }
      }
      client.lastDurableSeq = seq
      this.#sendEvent(client, 'sidecar.session.durable', { sessionId: client.boundSessionId, seq, event: frame.event }, { transient: false })
      return
    }
    if (frame.type === 'assistant-stream') {
      this.#sendEvent(client, 'sidecar.assistant.stream', { sessionId: client.boundSessionId, frame: frame.frame }, { transient: true })
    }
  }

  async #prompt(client, params) {
    if (!client.boundSessionId) throw new SidecarError('SESSION_UNBOUND', 'bind a session before prompting')
    if (params?.sessionId && params.sessionId !== client.boundSessionId) {
      throw new SidecarError('SESSION_MISMATCH', 'prompt session does not match the bound session')
    }
    const requestId = String(params?.requestId || '')
    if (!requestId) throw new SidecarError('INVALID_ARGUMENT', 'requestId is required')
    const content = params?.content
    if (!Array.isArray(content) || content.length === 0) throw new SidecarError('INVALID_ARGUMENT', 'content is required')
    const controller = this.#service('sessionController')
    const value = await controller.prompt({
      requestId,
      sessionId: client.boundSessionId,
      mode: params?.mode === 'steer' ? 'steer' : 'queue',
      content,
      ...(params?.clientTimeZone ? { clientTimeZone: params.clientTimeZone } : {}),
    }, client.signal)
    return { accepted: value?.accepted === true, requestId, sessionId: client.boundSessionId }
  }

  async #cancel(client, params) {
    if (!client.boundSessionId) throw new SidecarError('SESSION_UNBOUND', 'bind a session before cancelling')
    const sessionId = params?.sessionId || client.boundSessionId
    if (sessionId !== client.boundSessionId) throw new SidecarError('SESSION_MISMATCH', 'cancel session does not match the bound session')
    const controller = this.#service('sessionController')
    const value = controller.cancel({ sessionId })
    return { accepted: value?.accepted === true }
  }

  registerApproval({ approvalRequestId, sessionId, display = {}, deadline = null, resolve } = {}) {
    if (!approvalRequestId || typeof resolve !== 'function') {
      throw new SidecarError('INVALID_ARGUMENT', 'approvalRequestId and resolve are required')
    }
    if (this.approvals.has(approvalRequestId)) throw new SidecarError('DUPLICATE_APPROVAL', 'approval already registered')
    const record = { approvalRequestId, sessionId, display, deadline, resolve, state: 'pending', claimedBy: null, createdAt: Date.now(), timer: null }
    if (Number.isFinite(deadline) && deadline > Date.now()) {
      record.timer = setTimeout(() => this.#settleApproval(record, 'cancelled', 'timeout'), deadline - Date.now())
      record.timer.unref?.()
    }
    this.approvals.set(approvalRequestId, record)
    for (const client of this.clients.values()) {
      if (client.boundSessionId && client.boundSessionId !== sessionId) continue
      this.#sendEvent(client, 'sidecar.approval.request', { approvalRequestId, sessionId, ...display, deadline })
    }
    return { approvalRequestId, pending: true }
  }

  async #claimApproval(client, params) {
    const approvalRequestId = String(params?.approvalRequestId || '')
    const record = this.approvals.get(approvalRequestId)
    if (!record) {
      if (this.decidedApprovals.has(approvalRequestId)) throw new SidecarError('ALREADY_DECIDED', 'approval already decided')
      throw new SidecarError('APPROVAL_UNKNOWN', 'unknown approval request')
    }
    if (record.state !== 'pending') throw new SidecarError('ALREADY_DECIDED', 'approval already decided')
    if (client.boundSessionId && record.sessionId && client.boundSessionId !== record.sessionId) {
      throw new SidecarError('APPROVAL_SESSION_MISMATCH', 'approval belongs to another session')
    }
    record.state = 'decided'
    record.claimedBy = client.clientId
    if (record.timer) clearTimeout(record.timer)
    this.approvals.delete(approvalRequestId)
    this.decidedApprovals.set(approvalRequestId, record)
    setTimeout(() => this.decidedApprovals.delete(approvalRequestId), 60_000).unref?.()
    const outcome = params?.outcome
    const settled = { approvalRequestId, decision: outcome, by: client.clientId }
    for (const other of this.clients.values()) this.#sendEvent(other, 'sidecar.approval.settled', settled)
    await record.resolve(outcome)
    return { ok: true, approvalRequestId }
  }

  #settleApproval(record, decision, by) {
    if (record.state !== 'pending') return
    record.state = 'decided'
    if (record.timer) clearTimeout(record.timer)
    this.approvals.delete(record.approvalRequestId)
    for (const client of this.clients.values()) {
      this.#sendEvent(client, 'sidecar.approval.settled', { approvalRequestId: record.approvalRequestId, decision, by })
    }
    try {
      record.resolve(decision)
    } catch {}
  }

  #sendEvent(client, event, params, { transient = false } = {}) {
    return this.#send(client, { event, params }, { transient })
  }

  #send(client, message, { transient = false } = {}) {
    if (!this.clients.has(client.clientId)) return false
    if (client.queueDepth >= this.queueLimit) {
      if (transient) {
        client.droppedTransient += 1
        return false
      }
      this.disconnect(client.clientId, 'queue_overflow')
      return false
    }
    // Chunk oversized payloads so a single native message stays below the
    // Chrome Host -> Extension 1 MB ceiling (plan v2 §2).
    let frames
    try {
      frames = chunkEvent(message, this.maxFrameBytes)
    } catch {
      frames = [{ event: 'sidecar.error', params: { code: 'SERIALIZE_FAILED', message: 'event is not JSON serializable' } }]
    }
    client.queueDepth += 1
    Promise.resolve()
      .then(() => {
        for (const frame of frames) client.send(frame)
      })
      .catch(() => {})
      .finally(() => {
        client.queueDepth = Math.max(0, client.queueDepth - 1)
      })
    return true
  }

  stats() {
    return {
      clients: this.clients.size,
      approvals: this.approvals.size,
      clientsDetail: [...this.clients.values()].map((client) => ({
        clientId: client.clientId,
        boundSessionId: client.boundSessionId,
        state: client.state,
        queueDepth: client.queueDepth,
        droppedTransient: client.droppedTransient,
        lastDurableSeq: client.lastDurableSeq,
      })),
    }
  }

  stop() {
    this.stopped = true
    for (const id of [...this.clients.keys()]) this.disconnect(id, 'stopped')
    for (const record of this.approvals.values()) {
      if (record.timer) clearTimeout(record.timer)
      try {
        record.resolve('cancelled')
      } catch {}
    }
    this.approvals.clear()
  }
}
