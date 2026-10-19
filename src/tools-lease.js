/**
 * chrome_lease tool (I3 lease foundation). Extracted from tools.js so the
 * lease surface can be tested and evolved without growing the main tool file.
 */
export function createLeaseTool({ leases, ownerOf, outputSchema, renderText, normalizeLeaseError }) {
  return {
    name: 'chrome_lease',
    description:
      'Manage in-memory tab leases for shared-visible/collab sessions: acquire read or write ownership of a tab, renew, release, list, inspect status, or take over as the user. Write leases are exclusive; read leases may be shared. Leases expire automatically after ttlMs. This is the I3 lease foundation only: acquiring a lease does not yet gate every chrome_* write action.',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['acquire', 'renew', 'release', 'list', 'status', 'takeover'] },
        tabId: { type: 'number', description: 'Target tab id for acquire/status/takeover, or an optional list filter.' },
        mode: { type: 'string', enum: ['read', 'write'], description: 'Lease mode for acquire (default read); optional list filter.' },
        ttlMs: { type: 'number', description: 'Lease lifetime in milliseconds (default 60000, max 900000).' },
        leaseId: { type: 'string', description: 'Lease id for renew/release. Omit renew leaseId to heartbeat all leases owned by this session.' },
        owner: { type: 'string', description: 'Optional owner filter for list. Acquisition/renewal/release always use the calling session owner.' },
        by: { type: 'string', enum: ['user'], description: 'takeover only: must be "user".' },
      },
      required: ['op'],
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        ok: { type: 'boolean' },
        lease: { type: 'object', additionalProperties: true },
        leases: { type: 'array', items: { type: 'object', additionalProperties: true } },
        status: { type: 'object', additionalProperties: true },
        revoked: { type: 'array', items: { type: 'object', additionalProperties: true } },
        revokedCount: { type: 'number' },
        heartbeat: { type: 'boolean' },
        released: { type: 'boolean' },
        tabId: { type: 'number' },
        error: { type: 'string' },
      }),
      render: (_args, value) => {
        if (!value?.ok) return renderText(`Lease error: ${value?.error || 'unknown'}`)
        const line = (lease) =>
          `${lease?.leaseId || '(no id)'} tab=${lease?.tabId ?? '?'} ${lease?.mode || '?'} owner=${lease?.owner || '?'} expiresAt=${lease?.expiresAt ?? '?'}`
        if (Array.isArray(value.leases)) {
          return renderText(value.leases.length ? value.leases.map(line).join('\n') : 'No active leases.')
        }
        if (value.status) {
          const status = value.status
          const holders = Array.isArray(status.holders) && status.holders.length ? status.holders.join(', ') : 'none'
          return renderText(`Tab ${status.tabId ?? '?'}: ${status.count ?? 0} active lease(s); holders: ${holders}`)
        }
        if (Array.isArray(value.revoked)) {
          return renderText(`Revoked ${value.revokedCount ?? value.revoked.length} lease(s) on tab ${value.tabId ?? '?'}`)
        }
        if (value.lease) return renderText(`Lease ${line(value.lease)}`)
        if (value.released) return renderText('Lease released.')
        return renderText('Lease operation completed.')
      },
    },
    async execute(args, exec) {
      if (!leases) return { ok: false, error: 'LEASES_UNAVAILABLE' }
      const op = String(args?.op || 'list')
      const owner = ownerOf(exec)
      try {
        if (op === 'acquire') {
          return { ok: true, lease: leases.acquire({ tabId: args?.tabId, owner, mode: args?.mode, ttlMs: args?.ttlMs }) }
        }
        if (op === 'renew') {
          if (args?.leaseId != null) {
            return { ok: true, lease: leases.renew(String(args.leaseId), { owner, ttlMs: args?.ttlMs }) }
          }
          return { ok: true, leases: leases.heartbeat(owner, { ttlMs: args?.ttlMs }), heartbeat: true }
        }
        if (op === 'release') {
          return { ok: true, released: true, lease: leases.release(String(args?.leaseId ?? ''), { owner }) }
        }
        if (op === 'list') {
          const filter = {}
          if (args?.tabId != null) filter.tabId = args.tabId
          if (args?.owner != null) filter.owner = args.owner
          if (args?.mode != null) filter.mode = args.mode
          return { ok: true, leases: leases.list(filter) }
        }
        if (op === 'status') {
          return { ok: true, status: leases.status(args?.tabId) }
        }
        if (op === 'takeover') {
          const result = leases.takeover(args?.tabId, { by: args?.by })
          return { ok: true, ...result }
        }
        return { ok: false, error: `UNKNOWN_OP:${op}` }
      } catch (error) {
        throw normalizeLeaseError(error)
      }
    },
  }

}
