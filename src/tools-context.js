/**
 * chrome_context tool: per-session isolated browser contexts. Extracted from
 * tools.js so context lifecycle (create/use/list/current/close/viewer) has a
 * small, testable dependency surface.
 */
export function createContextTool({ contexts, contextViewer, ownerOf, outputSchema, renderText }) {
  return {
      name: 'chrome_context',
      description:
        'Manage isolated browser contexts for sandbox verification: op="create" makes a per-session headless context (default preset sandbox), op="use" switches the session active context, op="list" lists this session contexts, op="current" shows the active one, op="close" closes one. Contexts are isolated (separate profile); backend:"headless" calls route to the session active context.',
      parameters: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['create', 'use', 'list', 'current', 'close', 'viewer'] },
          preset: { type: 'string', enum: ['sandbox', 'sandbox-persistent', 'debug', 'collab'] },
          profile: { type: 'string', description: 'Named profile label for sandbox-persistent/debug.' },
          contextId: { type: 'string', description: 'Context id for use/close.' },
        },
        required: ['op'],
        additionalProperties: false,
      },
      output: {
        schema: outputSchema({
          ok: { type: 'boolean' },
          contextId: { type: 'string' },
          preset: { type: 'string' },
          visible: { type: 'boolean' },
          isolation: { type: 'string' },
          contexts: { type: 'array', items: { type: 'object', additionalProperties: true } },
          url: { type: 'string' },
          error: { type: 'string' },
        }),
        render: (_args, value) => {
          if (!value?.ok) return renderText(`Context error: ${value?.error || 'unknown'}`)
          if (typeof value.url === 'string' && value.url) return renderText(`Context viewer: ${value.url}`)
          if (Array.isArray(value.contexts)) {
            return renderText(value.contexts.length ? value.contexts.map((ctx) => `${ctx.contextId} ${ctx.preset} ${ctx.isolation}${ctx.visible ? ' visible' : ''} owner=${ctx.owner}`).join('\n') : 'No browser contexts for this session.')
          }
          return renderText(`Context ${value.contextId || ''} ${value.preset || ''} ${value.isolation || ''}${value.visible ? ' visible' : ' hidden'}`)
        },
      },
      async execute(args, exec) {
        if (!contexts) return { ok: false, error: 'CONTEXTS_UNAVAILABLE' }
        const owner = ownerOf(exec)
        const op = String(args?.op || 'list')
        if (op === 'create') {
          const ctx = await contexts.create({ owner, preset: args?.preset, profileName: args?.profile })
          return { ok: true, ...ctx }
        }
        if (op === 'list') {
          return { ok: true, contexts: contexts.list().filter((ctx) => ctx.owner === owner) }
        }
        if (op === 'current') {
          const ctx = contexts.activeFor(owner)
          return ctx ? { ok: true, ...contexts.view(ctx.contextId) } : { ok: false, error: 'NO_ACTIVE_CONTEXT' }
        }
        if (op === 'viewer') {
          const ctx = contexts.activeFor(owner)
          if (!ctx) return { ok: false, error: 'NO_ACTIVE_CONTEXT' }
          const viewer = typeof contextViewer === 'function' ? contextViewer() : contextViewer
          const url = viewer?.urlFor?.(ctx.contextId)
          return url ? { ok: true, contextId: ctx.contextId, url } : { ok: false, error: 'VIEWER_UNAVAILABLE' }
        }
        if (op === 'use') {
          return { ok: true, ...contexts.setActive(owner, String(args?.contextId || '')) }
        }
        if (op === 'close') {
          const contextId = String(args?.contextId || '')
          const closed = await contexts.close(contextId)
          return closed ? { ok: true, contextId } : { ok: false, error: 'CONTEXT_NOT_FOUND' }
        }
        return { ok: false, error: `UNKNOWN_OP:${op}` }
      },
  }

}
