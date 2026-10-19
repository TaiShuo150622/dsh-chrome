/**
 * Read-only page tools: chrome_snapshot, chrome_find, chrome_get_text,
 * chrome_console, chrome_network, chrome_html and chrome_wait. Extracted from
 * tools.js so page inspection (schema, text budget, render) has one small
 * dependency surface; nothing here mutates the page.
 */
import { BridgeError } from './bridge.js'

export function createReadTools({
  call,
  ownerOf,
  outputSchema,
  renderText,
  snapshotTextDefaultChars,
}) {
  const snapshot = {
    name: 'chrome_snapshot',
    description:
      'Return a text snapshot of the current DSH session page: title, URL, a numbered list of visible interactive controls (use the numbers as refs for click/type), and visible page text. Refs are stable across snapshots until the page changes; newly seen controls are marked with new:true. Password and payment-card values are masked. Prefer this over screenshots for reading content.',
    parameters: {
      type: 'object',
      properties: {
        maxChars: { type: 'number', description: 'Maximum page-text characters to return (default 20000, up to 200000). Use chrome_get_text to read a long page.' },
        boxes: { type: 'boolean', description: 'Include each control viewport box [x,y,width,height] in CSS px.' },
        mode: { type: 'string', enum: ['full', 'delta'], description: 'delta returns only controls that changed since the previous snapshot in this page.' },
        frames: { type: 'string', enum: ['all', 'main'], description: 'all (default) includes iframe controls with f<frame>:<ref> handles; main keeps legacy main-frame-only output.' },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        title: { type: 'string' },
        url: { type: 'string' },
        text: { type: 'string' },
        truncated: { type: 'boolean' },
        mode: { type: 'string' },
        changedCount: { type: 'number' },
        sameCount: { type: 'number' },
        removedRefs: { type: 'array', items: { type: 'number' } },
        frameCount: { type: 'number' },
        controls: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              ref: { type: 'number' },
              frameRef: { type: 'string' },
              frame: { type: 'string' },
              tag: { type: 'string' },
              label: { type: 'string' },
              kind: { type: 'string' },
              value: { type: 'string' },
              new: { type: 'boolean' },
              box: { type: 'array', items: { type: 'number' } },
            },
            additionalProperties: true,
          },
        },
        frames: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              frameId: { type: 'string' },
              prefix: { type: 'string' },
              parentFrameId: {},
              url: { type: 'string' },
              title: { type: 'string' },
              controls: { type: 'array', items: { type: 'object', additionalProperties: true } },
              error: { type: 'string' },
            },
            additionalProperties: true,
          },
        },
      }),
      render: (_args, value) => {
        const controls = Array.isArray(value.controls) ? value.controls : []
        if (value.mode === 'delta') {
          const lines = controls.map(
            (control) =>
              `${control.new ? '+ ' : '~ '}[${control.ref}] ${control.tag} ${JSON.stringify(control.label)}${control.value ? ` value=${JSON.stringify(control.value)}` : ''}`,
          )
          return renderText(
            `Delta snapshot: ${value.changedCount ?? 0} changed, ${value.sameCount ?? 0} unchanged, removed refs [${(value.removedRefs ?? []).join(',')}]\n${lines.join('\n')}`,
          )
        }
        const controlLines = controls.map(
          (control) =>
            `${control.new ? '+ ' : ''}[${control.ref}] ${control.tag}${control.kind ? ` (${control.kind})` : ''} ${JSON.stringify(control.label)}${control.value ? ` value=${JSON.stringify(control.value)}` : ''}${control.box ? ` box=[${control.box.join(',')}]` : ''}`,
        )
        const body = [
          `# ${value.title || '(untitled)'}`,
          `URL: ${value.url}`,
          '',
          `Controls (${controls.length}):`,
          ...controlLines,
        ]
        const frames = Array.isArray(value.frames) ? value.frames : []
        if (frames.length > 1) {
          body.push('', `Frames (${frames.length}):`)
          for (const frame of frames) {
            if (frame.parentFrameId == null && frames.length > 0) {
              // main frame controls already listed above
              continue
            }
            const indent = frame.parentFrameId ? '  ↳ ' : ''
            body.push(`${indent}f${frame.prefix || '?'} ${frame.url || ''}${frame.error ? ` (error: ${frame.error})` : ''}`)
            for (const control of frame.controls || []) {
              const handle = control.frameRef ? `[${control.frameRef}]` : `[${control.ref}]`
              body.push(
                `  ${control.new ? '+ ' : ''}${handle} ${control.tag}${control.kind ? ` (${control.kind})` : ''} ${JSON.stringify(control.label)}${control.value ? ` value=${JSON.stringify(control.value)}` : ''}`,
              )
            }
          }
        }
        // A budget the reader cannot see is a budget it cannot raise: the
        // truncation line carries the effective size and both escapes.
        const pageText = value.text || ''
        body.push(
          '',
          'Page text:',
          pageText,
          value.truncated
            ? `\n[page text truncated at ${pageText.length} characters — pass maxChars (up to 200000) for more, or use chrome_get_text]`
            : '',
        )
        return renderText(body.join('\n'))
      },
    },
    async execute(args, exec) {
      const maxChars = Number.isFinite(args?.maxChars)
        ? Math.max(1000, Math.min(200000, args.maxChars))
        : snapshotTextDefaultChars
      return call(
        'tab.snapshot',
        { maxChars, boxes: Boolean(args?.boxes), mode: args?.mode || 'full', frames: args?.frames || 'all', tabId: args?.tabId, owner: ownerOf(exec) },
        30000,
      )
    },
  }

  const find = {
    name: 'chrome_find',
    description:
      'Find text inside the current DSH session page. Returns matching snippets with data-dsh-ref handles (when the match sits in a link/button/input) and viewport coordinates, so results can be clicked without a full snapshot.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text or pattern to search for (case-insensitive).' },
        regex: { type: 'boolean', description: 'Treat query as a regular expression (case-insensitive).' },
        maxResults: { type: 'number', description: 'Optional cap, 1-50 (default 20).' },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        query: { type: 'string' },
        matches: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              ref: { type: 'number' },
              frameRef: { type: 'string' },
              frame: { type: 'string' },
              text: { type: 'string' },
              tag: { type: 'string' },
              x: { type: 'number' },
              y: { type: 'number' },
            },
            additionalProperties: true,
          },
        },
        truncated: { type: 'boolean' },
      }),
      render: (_args, value) => {
        const header = `Matches for "${value.query}": ${value.matches?.length ?? 0}${value.truncated ? ' (truncated)' : ''}`
        const lines = (value.matches ?? []).map(
          (match) => `- [${match.frameRef ? match.frameRef : `ref ${match.ref}`}] ${match.tag} ${JSON.stringify(match.text)}`,
        )
        return [{ type: 'text', text: [header, ...lines].join('\n') }]
      },
    },
    async execute(args, exec) {
      const value = await call(
        'tab.find',
        {
          query: String(args?.query ?? ''),
          regex: Boolean(args?.regex),
          maxResults: args?.maxResults,
          tabId: args?.tabId,
          owner: ownerOf(exec),
        },
        30000,
      )
      if (!value) throw new BridgeError('INTERNAL', 'extension returned no find result')
      return value
    },
  }

  const getText = {
    name: 'chrome_get_text',
    description:
      'Read the visible text of the DSH session page (or one element via a CSS selector). Useful for long articles / lazy-loaded content where a full snapshot of controls is unnecessary.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'Optional CSS selector; defaults to main/article/[role=main]/body.' },
        maxChars: { type: 'number', description: 'Max characters, 500-200000 (default 20000).' },
        format: { type: 'string', enum: ['text', 'markdown'], description: 'Output format (default text).' },
        frames: { type: 'string', enum: ['all', 'main'], description: 'all joins iframe text with [f<frame>] labels; main (default) keeps main-frame text only.' },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        found: { type: 'boolean' },
        text: { type: 'string' },
        truncated: { type: 'boolean' },
        frames: { type: 'number' },
      }),
      render: (_args, value) => {
        if (!value.found) return [{ type: 'text', text: 'No matching element found for the requested selector.' }]
        return [
          {
            type: 'text',
            text: `${value.truncated ? '(truncated) ' : ''}${value.text}`,
          },
        ]
      },
    },
    async execute(args, exec) {
      const value = await call(
        'tab.get_text',
        { selector: args?.selector, maxChars: args?.maxChars, format: args?.format, frames: args?.frames, tabId: args?.tabId, owner: ownerOf(exec) },
        30000,
      )
      if (!value) throw new BridgeError('INTERNAL', 'extension returned no text result')
      return value
    },
  }

  const console = {
    name: 'chrome_console',
    description:
      'Read recent console output captured from the DSH session page (log/info/warn/error/debug plus uncaught errors). Captured at document_start by the extension, so logs emitted before the call are available. Optionally clear the buffer.',
    parameters: {
      type: 'object',
      properties: {
        level: {
          type: 'string',
          enum: ['log', 'info', 'warn', 'error', 'debug'],
          description: 'Optional level filter.',
        },
        filter: { type: 'string', description: 'Optional substring filter on the log text.' },
        limit: { type: 'number', description: 'Max entries, 1-120 (default 50).' },
        clear: { type: 'boolean', description: 'Clear the buffer after reading.' },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        available: { type: 'boolean' },
        entries: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              level: { type: 'string' },
              text: { type: 'string' },
              time: { type: 'number' },
            },
            additionalProperties: true,
          },
        },
      }),
      render: (_args, value) => {
        if (!value.available) return [{ type: 'text', text: 'Console capture is not installed on this page; reload the tab and retry.' }]
        const lines = (value.entries ?? []).map((entry) => `[${entry.level}] ${entry.text}`)
        return [{ type: 'text', text: lines.length ? lines.join('\n') : '(no console entries)' }]
      },
    },
    async execute(args, exec) {
      const value = await call(
        'tab.console',
        { level: args?.level, filter: args?.filter, limit: args?.limit, clear: args?.clear, tabId: args?.tabId, owner: ownerOf(exec) },
        30000,
      )
      if (!value) throw new BridgeError('INTERNAL', 'extension returned no console result')
      return value
    },
  }

  const network = {
    name: 'chrome_network',
    description:
      'List resources loaded by the DSH session page (Resource Timing): URL, initiator type, duration and transfer size. Use to see what the page fetched; request status/headers are not available in this v1.',
    parameters: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Optional substring filter on the URL.' },
        limit: { type: 'number', description: 'Max entries, 1-200 (default 50).' },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        available: { type: 'boolean' },
        entries: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              url: { type: 'string' },
              type: { type: 'string' },
              durationMs: { type: 'number' },
              transferSize: { type: 'number' },
              status: { type: 'number' },
            },
            additionalProperties: true,
          },
        },
      }),
      render: (_args, value) => {
        const lines = (value.entries ?? []).map(
          (entry) =>
            `${entry.type || 'resource'} ${entry.status != null ? `[${entry.status}] ` : ''}${entry.durationMs}ms ${entry.transferSize}B ${entry.url}`,
        )
        return [{ type: 'text', text: lines.length ? lines.join('\n') : '(no network entries)' }]
      },
    },
    async execute(args, exec) {
      const value = await call(
        'tab.network',
        { filter: args?.filter, limit: args?.limit, tabId: args?.tabId, owner: ownerOf(exec) },
        30000,
      )
      if (!value) throw new BridgeError('INTERNAL', 'extension returned no network result')
      return value
    },
  }

  const html = {
    name: 'chrome_html',
    description:
      'Read the DOM/HTML of the current page or a selector. Credential-shaped attributes (value/csrf/token/password/secret/session/cookie/api-key) are masked before returning; mode "simplified" also strips scripts, styles, comments, inline event handlers and style attributes.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector to read (default: whole documentElement).' },
        mode: { type: 'string', enum: ['outer', 'simplified'], description: 'outer = raw outerHTML with masked secrets; simplified = also strip scripts/styles/handlers (default outer).' },
        maxChars: { type: 'number', description: 'Optional cap (500-200000, default 20000).' },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        found: { type: 'boolean' },
        mode: { type: 'string' },
        html: { type: 'string' },
        truncated: { type: 'boolean' },
        length: { type: 'number' },
        tabId: { type: 'number' },
      }),
      render: (_args, value) => {
        const body = String(value.html ?? '')
        const shown = body.length > 3000 ? `${body.slice(0, 3000)}\n… (${body.length} chars total)` : body
        return renderText(`HTML (${value.mode || 'outer'}${value.truncated ? ', truncated' : ''}):\n${shown}`)
      },
    },
    async execute(args, exec) {
      return call(
        'tab.html',
        {
          selector: args?.selector,
          mode: args?.mode,
          maxChars: args?.maxChars,
          tabId: args?.tabId,
          owner: ownerOf(exec),
        },
        30000,
      )
    },
  }

  const wait = {
    name: 'chrome_wait',
    description:
      'Wait for the current DSH session page: until=load (document complete), networkidle (load + short settle), text (page text contains it), selector (CSS selector exists), url (current URL contains it), or change (DOM controls changed since the previous snapshot). Fails with TIMEOUT instead of hanging.',
    parameters: {
      type: 'object',
      properties: {
        until: { type: 'string', enum: ['load', 'networkidle', 'text', 'selector', 'url', 'change'] },
        text: { type: 'string', description: 'Required when until=text.' },
        selector: { type: 'string', description: 'Required when until=selector (CSS selector).' },
        url: { type: 'string', description: 'Required when until=url (substring of the current URL).' },
        timeoutMs: { type: 'number', description: 'Maximum wait in ms (default 30000, max 120000).' },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
      },
      required: ['until'],
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
        renderText(
          [
            `Ready: ${value.title || '(untitled)'} — ${value.url} (${value.loadState})`,
            ...(value.frame ? [`Frame: f${value.frame.prefix} ${value.frame.url}`] : []),
          ].join('\n'),
        ),
    },
    async execute(args, exec) {
      return call(
        'tab.wait',
        {
          until: String(args?.until ?? 'load'),
          text: args?.text,
          selector: args?.selector,
          url: args?.url,
          timeoutMs: args?.timeoutMs,
          tabId: args?.tabId,
          owner: ownerOf(exec),
        },
        120000,
      )
    },
  }

  const a11y = {
    name: 'chrome_a11y',
    description:
      'Return the accessibility tree of the DSH session page (role/name/value nodes, filtered and truncated). Useful for understanding structure, dialogs and non-DOM UIs; use chrome_snapshot for clickable refs.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max nodes, 1-400 (default 200).' },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        total: { type: 'number' },
        truncated: { type: 'boolean' },
        nodes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              role: { type: 'string' },
              name: { type: 'string' },
              value: { type: 'string' },
            },
            additionalProperties: true,
          },
        },
      }),
      render: (_args, value) => {
        const lines = (value.nodes ?? []).map((node) =>
          `${node.role}${node.name ? ` ${JSON.stringify(node.name)}` : ''}${node.value ? ` value=${JSON.stringify(node.value)}` : ''}`,
        )
        return renderText(
          `Accessibility nodes (${lines.length}/${value.total}${value.truncated ? ', truncated' : ''}):\n${lines.join('\n') || '(none)'}`,
        )
      },
    },
    async execute(args, exec) {
      const value = await call('tab.a11y', { limit: args?.limit, tabId: args?.tabId, owner: ownerOf(exec) }, 30000)
      if (!value) throw new BridgeError('INTERNAL', 'extension returned no accessibility tree')
      return value
    },
  }

  return { snapshot, find, getText, a11y, console, network, html, wait }
}
