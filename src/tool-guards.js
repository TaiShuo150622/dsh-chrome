/**
 * Tool execution guards shared by the backend wrapper.
 *
 * The lease guard is separate from routing so `backend.js` stays focused on
 * choosing a backend and adding the `backend` parameter. write-lease policy
 * (which tools mutate, how the active tab is resolved) lives here and can be
 * tested without a real browser.
 */
export const WRITE_TOOLS = Object.freeze(new Set([
  'chrome_goto',
  'chrome_click',
  'chrome_click_at',
  'chrome_type',
  'chrome_press',
  'chrome_scroll',
  'chrome_select',
  'chrome_drag',
  'chrome_upload',
  'chrome_tabs',
  'chrome_history',
  'chrome_hover',
  'chrome_storage',
  'chrome_emulate',
  'chrome_close_session',
  'chrome_evaluate',
  'chrome_pointer',
  'chrome_annotate',
]))

export function isWriteTool(name) {
  return WRITE_TOOLS.has(name)
}

/**
 * Run a write tool under an implicit write lease on the active tab.
 *
 * `run` is the actual routed execution (including backend selection). The
 * guard only resolves the tab, acquires/releases the lease, and lets
 * LeaseError bubble to the tool caller.
 */
export async function withWriteLease({ toolName, args, exec, mode, router, leases, run }) {
  if (!leases || !isWriteTool(toolName)) return run()
  const owner = exec?.agent?.id ?? 'default'
  let tabId = args?.tabId
  if (tabId == null) {
    try {
      const list = await router.runWithBackend(mode, () => router.call('tab.tabs', { op: 'list', owner }))
      tabId = list?.activeTabId ?? null
    } catch {
      tabId = null
    }
  }
  if (tabId == null) return run()
  const lease = leases.acquire({ tabId, owner, mode: 'write' })
  try {
    return await run()
  } finally {
    try {
      leases.release(lease.leaseId, { owner })
    } catch {
      // Tab close/navigation may have dropped it already.
    }
  }
}
