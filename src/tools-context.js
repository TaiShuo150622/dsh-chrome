/**
 * chrome_context tool: per-session isolated browser contexts. Extracted from
 * tools.js so context lifecycle (create/use/list/current/close/viewer) has a
 * small, testable dependency surface.
 */
export function createContextTool({ contexts, contextViewer, ownerOf, outputSchema, renderText }) {
  // M4: live limits for the context view. Optional so the lightweight fake
  // managers used by viewer/secret tests keep working unchanged.
  const limitsView = () => (typeof contexts?.limits === 'function' ? contexts.limits() : null)
  const limitsLine = (value) => {
    const current = value?.limits
    if (!current) return ''
    return `contexts ${current.contexts ?? '?'}/${current.maxContexts ?? '?'}  tabs ${current.tabs ?? 0}/${current.maxTabs ?? '?'}`
  }
  // H8: the driver state travels with every context view, so a crashed
  // browser is visible here instead of only surfacing on the next request.
  const stateLabel = (ctx) => {
    if (!ctx) return ''
    return [
      ctx.state || 'ready',
      ctx.deathReason ? `died:${ctx.deathReason}` : '',
      ctx.chromePid != null ? `pid ${ctx.chromePid}` : '',
    ]
      .filter(Boolean)
      .join(' ')
  }
  return {
      name: 'chrome_context',
      mutating: false,
      // Creates/activates/closes provider-side browser contexts. It changes
      // lifecycle state, not the page in a shared tab, so no write lease.
      stateful: true,
      description:
        'Manage isolated browser contexts for sandbox verification: op="create" makes a per-session headless context (default preset sandbox), op="use" switches the session active context, op="list" lists this session contexts with driver state, op="current" shows the active one, op="close" closes one, op="restart" explicitly rebuilds a crashed/dead context. op="viewer" writes the viewer URL to a local handoff file and returns its path plus an opaque handle; the bearer URL is never returned. Contexts are isolated (separate profile); backend:"headless" calls route to the session active context.',
      parameters: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['create', 'use', 'list', 'current', 'close', 'restart', 'viewer'] },
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
          state: { type: 'string' },
          deathReason: {},
          chromePid: {},
          restarted: { type: 'boolean' },
          previous: { type: 'object', additionalProperties: true },
          contexts: { type: 'array', items: { type: 'object', additionalProperties: true } },
          limits: { type: 'object', additionalProperties: true },
          handle: { type: 'string' },
          urlFile: { type: 'string' },
          hint: { type: 'string' },
          error: { type: 'string' },
        }),
        render: (_args, value) => {
          if (!value?.ok) return renderText(`Context error: ${value?.error || 'unknown'}`)
          if (typeof value.urlFile === 'string' && value.urlFile) {
            return renderText(`Context viewer ready for ${value.contextId} (${value.handle}).\n${value.hint}`)
          }
          if (Array.isArray(value.contexts)) {
            const summary = limitsLine(value)
            const rows = value.contexts.length
              ? value.contexts.map(
                  (ctx) =>
                    `${ctx.contextId} ${ctx.preset} ${ctx.isolation} ${stateLabel(ctx)}${ctx.visible ? ' visible' : ''} owner=${ctx.owner}`,
                )
              : ['No browser contexts for this session.']
            return renderText([...(summary ? [summary] : []), ...rows].join('\n'))
          }
          const line = `Context ${value.contextId || ''} ${value.preset || ''} ${value.isolation || ''} ${stateLabel(value)}${value.visible ? ' visible' : ' hidden'}`
          return renderText([line, limitsLine(value)].filter(Boolean).join('\n'))
        },
      },
      async execute(args, exec) {
        if (!contexts) return { ok: false, error: 'CONTEXTS_UNAVAILABLE' }
        const owner = ownerOf(exec)
        const op = String(args?.op || 'list')
        if (op === 'create') {
          const ctx = await contexts.create({ owner, preset: args?.preset, profileName: args?.profile })
          return { ok: true, ...ctx, limits: limitsView() }
        }
        if (op === 'list') {
          return {
            ok: true,
            contexts: contexts.listFor ? contexts.listFor(owner) : contexts.list().filter((ctx) => ctx.owner === owner),
            limits: limitsView(),
          }
        }
        if (op === 'current') {
          const ctx = contexts.activeFor(owner)
          return ctx ? { ok: true, ...contexts.view(ctx.contextId), limits: limitsView() } : { ok: false, error: 'NO_ACTIVE_CONTEXT' }
        }
        if (op === 'viewer') {
          const ctx = contexts.activeFor(owner)
          if (!ctx) return { ok: false, error: 'NO_ACTIVE_CONTEXT' }
          const viewer = typeof contextViewer === 'function' ? contextViewer() : contextViewer
          // openFor keeps the bearer token/access URL on the Host: the model
          // receives only an opaque handle and the 0600 local handoff path.
          const info = viewer?.openFor?.(ctx.contextId)
          return info
            ? { ok: true, contextId: ctx.contextId, handle: `context:${ctx.contextId}`, urlFile: info.urlFile, hint: info.hint }
            : { ok: false, error: 'VIEWER_UNAVAILABLE' }
        }
        if (op === 'use') {
          return { ok: true, ...contexts.setActive(owner, String(args?.contextId || '')), limits: limitsView() }
        }
        if (op === 'close') {
          const contextId = String(args?.contextId || '')
          const closed = await contexts.closeOwned(contextId, owner)
          return closed ? { ok: true, contextId } : { ok: false, error: 'CONTEXT_NOT_FOUND' }
        }
        if (op === 'restart') {
          const contextId = String(args?.contextId || '')
          const target = contextId ? contexts.getOwned(contextId, owner) : contexts.activeFor(owner)
          if (!target) return { ok: false, error: 'CONTEXT_NOT_FOUND' }
          if (typeof contexts.restart !== 'function') return { ok: false, error: 'CONTEXT_RESTART_UNAVAILABLE' }
          try {
            const result = await contexts.restart(target.contextId, { owner })
            return {
              ok: true,
              restarted: true,
              previous: result.previous,
              ...result.context,
              limits: limitsView(),
            }
          } catch (error) {
            if (error?.code === 'CONTEXT_NOT_CRASHED') {
              const view = contexts.view?.(target.contextId)
              return { ok: false, error: error.code, state: view?.state, message: error.message }
            }
            if (error?.code === 'CONTEXT_NOT_FOUND') return { ok: false, error: error.code }
            throw error
          }
        }
        return { ok: false, error: `UNKNOWN_OP:${op}` }
      },
  }

}
