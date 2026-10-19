/**
 * HTTP capture tools: chrome_capture_start / chrome_capture_stop /
 * chrome_capture_requests. Extracted from tools.js so the capture lifecycle
 * (hard confirmation, buffer freeze, body budget) has one small dependency
 * surface. Approval and error-code semantics are unchanged.
 */
export function createCaptureTools({
  call,
  ownerOf,
  hardConfirmAsk,
  captureConfirmTimeoutMs,
  outputSchema,
  renderText,
}) {
  const captureStart = {
    name: 'chrome_capture_start',
    mutating: false,
    // Stateful capture buffer, not a page mutation: no write lease.
    stateful: true,
    description:
      'Start capturing HTTP requests for one DSH session tab through the DevTools Network domain. Records method/URL/status/mimeType/resourceType/timing; headers (Cookie, Authorization, Set-Cookie) are never captured. Requires explicit user confirmation every time; Chrome shows a debugging banner while capture is active (max 10 minutes).',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
        resourceTypes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Resource types to record (default: xhr, fetch, document).',
        },
        maxEntries: { type: 'number', description: 'Max requests kept in the buffer (default 300, max 1000).' },
        storeBodies: { type: 'boolean', description: 'Fetch and cache truncated, redacted text bodies while attached (default true).' },
      },
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        captureId: { type: 'string' },
        tabId: { type: 'number' },
        startedAt: { type: 'string' },
        active: { type: 'boolean' },
        alreadyActive: { type: 'boolean' },
        maxEntries: { type: 'number' },
        resourceTypes: { type: 'array', items: { type: 'string' } },
      }),
      render: (_args, value) =>
        renderText(
          value.alreadyActive
            ? `Capture already active: ${value.captureId} (tab ${value.tabId})`
            : `Capture started: ${value.captureId} (tab ${value.tabId}, max ${value.maxEntries} entries). Chrome may show a debugging banner.`,
        ),
    },
    async execute(args, exec) {
      const tabHint = Number.isFinite(args?.tabId) ? `标签 ${args.tabId}` : '当前会话标签'
      await hardConfirmAsk(exec, 'chrome_capture_start', {
        header: '开始抓取网络请求（高敏感）',
        question: `允许抓取${tabHint} 的网络请求吗？会记录 URL/状态/脱敏后的请求与响应体（默认不含 Cookie/Authorization 等 headers），可能包含个人信息。`,
        detail: '停止：chrome_capture_stop；最长 10 分钟自动停止；抓包期间 Chrome 会显示「正在调试此浏览器」横幅',
        timeoutMs: captureConfirmTimeoutMs,
      })
      return call(
        'tab.capture_start',
        {
          tabId: args?.tabId,
          resourceTypes: args?.resourceTypes,
          maxEntries: args?.maxEntries,
          storeBodies: args?.storeBodies,
          owner: ownerOf(exec),
        },
        30000,
      )
    },
  }

  const captureStop = {
    name: 'chrome_capture_stop',
    mutating: false,
    // Counterpart of chrome_capture_start: freezes provider-side state only.
    stateful: true,
    description:
      'Stop the active network capture, release the debugger pin and freeze the buffer. Captured entries stay readable through chrome_capture_requests; new requests are not recorded.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
        captureId: { type: 'string', description: 'Optional capture id (defaults to the active capture).' },
      },
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        captureId: { type: 'string' },
        tabId: { type: 'number' },
        startedAt: { type: 'string' },
        endedAt: { type: 'string' },
        durationMs: { type: 'number' },
        requests: { type: 'number' },
        dropped: { type: 'number' },
        bodiesDropped: { type: 'number' },
        active: { type: 'boolean' },
        endedReason: { type: 'string' },
      }),
      render: (_args, value) =>
        renderText(
          `Capture stopped: ${value.captureId} — ${value.requests} request(s), dropped ${value.dropped}, reason ${value.endedReason || 'stopped'} (${value.durationMs}ms)`,
        ),
    },
    async execute(args, exec) {
      return call('tab.capture_stop', { tabId: args?.tabId, captureId: args?.captureId, owner: ownerOf(exec) }, 30000)
    },
  }

  const captureRequests = {
    name: 'chrome_capture_requests',
    description:
      'Read captured HTTP metadata (method/URL/status/mimeType/resourceType/timing). Headers are never captured; secret-shaped query params are redacted. Works while active or after stop (frozen buffer); if the worker restarted the buffer is reported as lost.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
        captureId: { type: 'string', description: 'Optional capture id (defaults to the active capture).' },
        limit: { type: 'number', description: 'Max entries returned (default 50, max 200).' },
        filter: { type: 'string', description: 'Case-insensitive filter over method + URL.' },
        resourceTypes: { type: 'array', items: { type: 'string' }, description: 'Only these resource types.' },
        includeBodies: { type: 'boolean', description: 'Include truncated request/response bodies (default true).' },
        maxBodyChars: { type: 'number', description: 'Body display cap, 64-65536 (default 4096).' },
      },
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        available: { type: 'boolean' },
        lost: { type: 'boolean' },
        active: { type: 'boolean' },
        captureId: { type: 'string' },
        tabId: { type: 'number' },
        entries: { type: 'array', items: { type: 'object', additionalProperties: true } },
        total: { type: 'number' },
        truncated: { type: 'boolean' },
        dropped: { type: 'number' },
        bodiesDropped: { type: 'number' },
      }),
      render: (_args, value) => {
        if (value.lost) return renderText('Capture buffer is lost (worker restarted); start a new capture.')
        const lines = (value.entries || []).map((entry) => {
          const status = entry.status != null ? entry.status : (entry.failed ? 'ERR' : '—')
          const duration = entry.durationMs != null ? `${entry.durationMs}ms` : '—'
          const lines = [`- ${entry.method || '?'} ${entry.url || ''} → ${status} ${entry.mimeType || ''} (${entry.resourceType || '?'}, ${duration})`]
          if (entry.requestBody) lines.push(`  request: ${String(entry.requestBody).slice(0, 400)}`)
          if (entry.responseBody) lines.push(`  response: ${String(entry.responseBody).slice(0, 400)}`)
          if (entry.bodyUnavailable) lines.push(`  body: unavailable (${entry.bodyUnavailable})`)
          return lines.join('\n')
        })
        const header = `Capture ${value.captureId || ''}${value.active ? ' (active)' : ' (stopped)'}: ${value.entries?.length ?? 0}/${value.total ?? 0} entries${value.truncated ? ' (truncated)' : ''}, dropped ${value.dropped ?? 0}`
        return renderText([header, ...lines].join('\n'))
      },
    },
    async execute(args, exec) {
      return call(
        'tab.capture_requests',
        {
          tabId: args?.tabId,
          captureId: args?.captureId,
          limit: args?.limit,
          filter: args?.filter,
          resourceTypes: args?.resourceTypes,
          includeBodies: args?.includeBodies,
          maxBodyChars: args?.maxBodyChars,
          owner: ownerOf(exec),
        },
        30000,
      )
    },
  }

  return [captureStart, captureStop, captureRequests]
}
