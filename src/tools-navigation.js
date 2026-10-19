/**
 * Navigation tools: chrome_goto, chrome_history, chrome_tabs and
 * chrome_close_session. Extracted from tools.js so tab/navigation ownership,
 * URL validation and lease release semantics live in one small module.
 *
 * The factory receives only what these tools actually use; tools.js keeps the
 * shared helpers (call/guard/ownerOf/sessionLabel/URL validation) so behavior
 * and error codes stay identical.
 */
export function createNavigationTools({
  call,
  guard,
  ownerOf,
  sessionLabel,
  validateHttpUrl,
  validateTabUrl,
  outputSchema,
  renderText,
  leases = null,
}) {
  const releaseOwnedLeases = (exec) => {
    if (!leases) return
    try {
      for (const lease of leases.list({ owner: ownerOf(exec) })) {
        try { leases.release(lease.leaseId, { owner: ownerOf(exec) }) } catch {}
      }
    } catch {}
  }

  const goto = {
    name: 'chrome_goto',
    mutating: true,
    description:
      'Open an http(s) URL in this DSH session browser tab (created as a background tab in the session tab group if absent). Does not steal focus. Returns tab id, URL, title, and load state.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http:// or https:// URL to open.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        tabId: { type: 'number' },
        url: { type: 'string' },
        title: { type: 'string' },
        loadState: { type: 'string' },
        frame: { type: 'object', additionalProperties: true },
      }),
      render: (_args, value) =>
        renderText(`Navigated to ${value.title || '(untitled)'} — ${value.url} (${value.loadState})`),
    },
    async execute(args, exec) {
      const url = validateHttpUrl(args?.url)
      await guard(exec, 'chrome_goto', `navigate to ${url}`, { targetUrl: url })
      const result = await call('tab.goto', { url, owner: ownerOf(exec), ownerLabel: sessionLabel(exec) })
      try { if (result?.tabId != null) leases?.releaseTab(result.tabId, { reason: 'navigate' }) } catch {}
      return result
    },
  }

  const history = {
    name: 'chrome_history',
    mutating: true,
    description:
      'Navigate backwards, forwards, or reload the current DSH session page. Waits for the load to complete and returns the resulting URL/title.',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['back', 'forward', 'reload'] },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
      },
      required: ['op'],
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        tabId: { type: 'number' },
        url: { type: 'string' },
        title: { type: 'string' },
        loadState: { type: 'string' },
        frame: { type: 'object', additionalProperties: true },
      }),
      render: (_args, value) =>
        renderText(`${value.title || '(untitled)'} — ${value.url} (${value.loadState})`),
    },
    async execute(args, exec) {
      await guard(exec, 'chrome_history', String(args?.op ?? 'reload'), { tabId: args?.tabId })
      const result = await call('tab.history', {
        op: String(args?.op ?? 'reload'),
        tabId: args?.tabId,
        owner: ownerOf(exec),
      })
      try { if (result?.tabId != null) leases?.releaseTab(result.tabId, { reason: 'navigate' }) } catch {}
      return result
    },
  }

  const tabs = {
    name: 'chrome_tabs',
    mutating: true,
    description:
      'Manage tabs owned by this DSH session: list owned tabs, open a new background tab in the session tab group, or close an owned tab. Never lists or controls tabs outside this session.',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['list', 'new', 'close', 'claim', 'focus'] },
        url: { type: 'string', description: 'URL for op=new (http/https; defaults to about:blank).' },
        tabId: { type: 'number', description: 'Tab id for op=close/claim; claim defaults to the active tab.' },
      },
      required: ['op'],
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        tabs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              tabId: { type: 'number' },
              title: { type: 'string' },
              url: { type: 'string' },
              active: { type: 'boolean' },
            },
            additionalProperties: true,
          },
        },
        groupId: {},
        tabId: { type: 'number' },
        url: { type: 'string' },
        title: { type: 'string' },
        closed: { type: 'number' },
        remaining: { type: 'number' },
        claimed: { type: 'boolean' },
        focused: { type: 'boolean' },
      }),
      render: (_args, value) => {
        if (value.claimed) {
          return renderText(`Claimed tab #${value.tabId} — ${value.title || ''} ${value.url || ''}`)
        }
        if (value.focused) {
          return renderText(`Focused tab #${value.tabId} — ${value.title || ''} ${value.url || ''}`)
        }
        if (Array.isArray(value.tabs)) {
          const lines = value.tabs.map(
            (tab) => `${tab.active ? '*' : ' '} #${tab.tabId} ${tab.title || '(untitled)'} — ${tab.url}`,
          )
          return renderText(`Session tabs (group ${value.groupId ?? 'none'}):\n${lines.join('\n') || '(none)'}`)
        }
        if (value.closed != null) {
          return renderText(`Closed tab ${value.closed}; ${value.remaining} tab(s) remain in this session`)
        }
        return renderText(`Opened tab #${value.tabId} — ${value.title || ''} ${value.url || ''}`)
      },
    },
    async execute(args, exec) {
      const op = String(args?.op ?? 'list')
      if (op !== 'list') {
        if (op === 'new') {
          // Guard the destination URL, not the page the session is leaving
          // (R-02). A blank tab has no site, so no lookup is needed either.
          const url = validateTabUrl(args?.url)
          await guard(exec, 'chrome_tabs', `tabs new ${url}`, { targetUrl: url })
          return call('tab.tabs', {
            op,
            url,
            tabId: args?.tabId,
            owner: ownerOf(exec),
            ownerLabel: sessionLabel(exec),
          })
        }
        if (op === 'claim') {
          // The tab is not owned yet, so the extension may look up its origin
          // on request (allowForeign). Claiming a tab from a blocked site is
          // refused before the tab becomes part of this session (R-01).
          await guard(exec, 'chrome_tabs', `tabs claim ${args?.tabId ?? 'active'}`, {
            tabId: args?.tabId,
            allowForeign: true,
          })
        } else {
          await guard(exec, 'chrome_tabs', `tabs ${op}`, { tabId: args?.tabId })
        }
      }
      const result = await call('tab.tabs', {
        op,
        url: args?.url,
        tabId: args?.tabId,
        owner: ownerOf(exec),
        ownerLabel: sessionLabel(exec),
      })
      try {
        if (op === 'close' && result?.closed != null) leases?.releaseTab(result.closed, { reason: 'tab-closed' })
      } catch {}
      return result
    },
  }

  const closeSession = {
    name: 'chrome_close_session',
    mutating: true,
    description:
      "Close every tab owned by this DSH session (and its tab group). Does not quit Chrome and never touches the user's other tabs.",
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: outputSchema({ closed: { type: 'number' } }),
      render: (_args, value) => renderText(`Closed ${value.closed} session tab(s)`),
    },
    async execute(_args, exec) {
      await guard(exec, 'chrome_close_session', 'close session tabs')
      const result = await call('tab.close_session', { owner: ownerOf(exec) })
      releaseOwnedLeases(exec)
      return result
    },
  }

  return { goto, history, tabs, closeSession }
}
