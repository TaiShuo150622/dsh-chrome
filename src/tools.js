/**
 * Model-facing chrome_* tools (P1: 12 tools).
 *
 * Reads (status/snapshot/screenshot/tabs list/wait) run without approval.
 * Mutating actions (goto/click/type/press/history/tabs new|close/close_session)
 * go through ctx.approval, which follows the DSH session policy ("follow-dsh":
 * under danger-full-access / never it is allowed without a prompt).
 */
import fsp from 'node:fs/promises'

import { BridgeError } from './bridge.js'

const MUTATION_TIMEOUT_MS = 45000

function outputSchema(properties) {
  return { type: 'object', properties, additionalProperties: true }
}

function renderText(text) {
  return [{ type: 'text', text }]
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown size'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

function installHint(assets) {
  if (!assets) return 'Installation assets are still being prepared; retry in a moment.'
  return [
    'To connect Chrome:',
    `1. Open chrome://extensions, enable Developer mode, and Load unpacked: ${assets.extensionDir}`,
    '2. Quit Chrome completely and reopen it (the native messaging manifest is read at startup).',
    '3. Click the DSH Chrome toolbar icon and confirm it says Connected.',
    `Full guide: ${assets.instructionsPath}`,
  ].join('\n')
}

function validateHttpUrl(raw) {
  let url
  try {
    url = new URL(String(raw))
  } catch {
    throw new BridgeError('NAV_FAILED', `not a valid URL: ${String(raw)}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BridgeError('PROTECTED_PAGE', `only http(s) URLs are allowed, got ${url.protocol}`)
  }
  if (url.username || url.password) {
    throw new BridgeError('PROTECTED_PAGE', 'URLs with embedded credentials are not allowed')
  }
  return url.toString()
}

function normalize(error) {
  if (error instanceof BridgeError) return error
  const wrapped = new BridgeError('INTERNAL', error?.message || String(error))
  wrapped.cause = error
  return wrapped
}

export function chromeTools({ bridge, attachments, assets, approval, sessionContext }) {
  const list = []
  const ownerOf = (exec) => exec?.agent?.id ?? 'default'

  async function call(method, params, timeoutMs = MUTATION_TIMEOUT_MS) {
    try {
      return await bridge.call(method, params, timeoutMs)
    } catch (error) {
      throw normalize(error)
    }
  }

  function sessionSandboxMode(exec) {
    const services = sessionContext?.()
    const session = services?.sessions?.get?.(exec?.agent?.id)
    const policy = services?.sandboxPolicy
    if (!session || !policy) return null
    try {
      return policy.resolve({ session })?.mode ?? null
    } catch {
      return null
    }
  }

  async function guard(exec, toolName, action) {
    // follow-dsh: the session's sandbox preset already grants full access.
    if (sessionSandboxMode(exec) === 'danger-full-access') return
    const service = approval?.()
    if (!service || !exec?.agent) return
    let outcome
    try {
      outcome = await service.request({
        agent: exec.agent,
        toolName,
        callId: exec.callId,
        reason: action,
        displayReason: {
          en: `Browser action: ${action}`,
          zh: `浏览器操作：${action}`,
        },
        signal: exec.signal,
      })
    } catch (error) {
      throw new BridgeError('APPROVAL_DENIED', `approval unavailable: ${error?.message || error}`)
    }
    if (outcome !== 'allowed-once') {
      throw new BridgeError('APPROVAL_DENIED', `browser action was not approved (${outcome})`)
    }
  }

  // ---------------------------------------------------------------- 1. status
  list.push({
    name: 'chrome_status',
    description:
      'Report the Chrome bridge state: whether the extension is connected, extension/host/protocol versions, install paths, and the last known tab for this DSH session. Call this first when browser tools fail.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: outputSchema({
        connected: { type: 'boolean' },
        provider: { type: 'string' },
        protocol: { type: 'number' },
        hostVersion: {},
        extensionVersion: {},
        extensionId: {},
        extensionDir: {},
        nativeManifestPath: {},
        instructionsPath: {},
        error: { type: 'string' },
      }),
      render: (_args, value) => {
        const lines = [
          `Chrome bridge: ${value.connected ? 'CONNECTED' : 'NOT CONNECTED'}`,
          `provider: ${value.provider}  protocol: ${value.protocol}`,
          `extension: ${value.extensionVersion ?? 'unknown'}  host: ${value.hostVersion ?? 'unknown'}`,
          `extension id: ${value.extensionId ?? 'unknown'}`,
        ]
        if (!value.connected) lines.push('', installHint(assets()))
        if (value.error) lines.push('', `last error: ${value.error}`)
        return renderText(lines.join('\n'))
      },
    },
    async execute() {
      const info = assets() ?? {}
      const value = {
        connected: bridge.connected,
        provider: 'chrome-extension',
        protocol: 1,
        hostVersion: bridge.hostVersion,
        extensionVersion: bridge.extensionVersion,
        extensionId: info.extensionId ?? null,
        extensionDir: info.extensionDir ?? null,
        nativeManifestPath: info.nativeManifestPath ?? null,
        instructionsPath: info.instructionsPath ?? null,
      }
      if (bridge.connected) {
        try {
          const status = await bridge.call('browser.status', {}, 3000)
          if (typeof status?.extensionVersion === 'string') {
            value.extensionVersion = status.extensionVersion
            bridge.extensionVersion = status.extensionVersion
          }
        } catch (error) {
          value.error = error?.message || String(error)
        }
      }
      return value
    },
  })

  // ------------------------------------------------------------------ 2. goto
  list.push({
    name: 'chrome_goto',
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
      }),
      render: (_args, value) =>
        renderText(`Navigated to ${value.title || '(untitled)'} — ${value.url} (${value.loadState})`),
    },
    async execute(args, exec) {
      const url = validateHttpUrl(args?.url)
      await guard(exec, 'chrome_goto', `navigate to ${url}`)
      return call('tab.goto', { url, owner: ownerOf(exec) })
    },
  })

  // -------------------------------------------------------------- 3. snapshot
  list.push({
    name: 'chrome_snapshot',
    description:
      'Return a text snapshot of the current DSH session page: title, URL, a numbered list of visible interactive controls (use the numbers as refs for click/type), and visible page text. Password and payment-card values are masked. Prefer this over screenshots for reading content.',
    parameters: {
      type: 'object',
      properties: {
        maxChars: { type: 'number', description: 'Maximum page-text characters to return (default 100000).' },
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
        controls: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              ref: { type: 'number' },
              tag: { type: 'string' },
              label: { type: 'string' },
              kind: { type: 'string' },
              value: { type: 'string' },
            },
            additionalProperties: true,
          },
        },
      }),
      render: (_args, value) => {
        const controls = Array.isArray(value.controls) ? value.controls : []
        const controlLines = controls.map(
          (control) =>
            `[${control.ref}] ${control.tag}${control.kind ? ` (${control.kind})` : ''} ${JSON.stringify(control.label)}${control.value ? ` value=${JSON.stringify(control.value)}` : ''}`,
        )
        const body = [
          `# ${value.title || '(untitled)'}`,
          `URL: ${value.url}`,
          '',
          `Controls (${controls.length}):`,
          ...controlLines,
          '',
          'Page text:',
          value.text || '',
          value.truncated ? '\n[truncated]' : '',
        ]
        return renderText(body.join('\n'))
      },
    },
    async execute(args, exec) {
      const maxChars = Number.isFinite(args?.maxChars)
        ? Math.max(1000, Math.min(200000, args.maxChars))
        : 100000
      return call('tab.snapshot', { maxChars, tabId: args?.tabId, owner: ownerOf(exec) }, 30000)
    },
  })

  // ------------------------------------------------------------ 4. screenshot
  list.push({
    name: 'chrome_find',
    description:
      'Find text inside the current DSH session page. Returns matching snippets with data-dsh-ref handles (when the match sits in a link/button/input) and viewport coordinates, so results can be clicked without a full snapshot.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search for (case-insensitive).' },
        maxResults: { type: 'number', description: 'Optional cap, 1-50 (default 20).' },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
      },
      required: ['query'],
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
        const lines = (value.matches ?? []).map((match) => `- [ref ${match.ref}] ${match.tag} ${JSON.stringify(match.text)}`)
        return [{ type: 'text', text: [header, ...lines].join('\n') }]
      },
    },
    async execute(args, exec) {
      const value = await call(
        'tab.find',
        { query: String(args?.query ?? ''), maxResults: args?.maxResults, tabId: args?.tabId, owner: ownerOf(exec) },
        30000,
      )
      if (!value) throw new BridgeError('INTERNAL', 'extension returned no find result')
      return value
    },
  },
  {
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
        { level: args?.level, limit: args?.limit, clear: args?.clear, tabId: args?.tabId, owner: ownerOf(exec) },
        30000,
      )
      if (!value) throw new BridgeError('INTERNAL', 'extension returned no console result')
      return value
    },
  },
  {
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
            },
            additionalProperties: true,
          },
        },
      }),
      render: (_args, value) => {
        const lines = (value.entries ?? []).map(
          (entry) => `${entry.type || 'resource'} ${entry.durationMs}ms ${entry.transferSize}B ${entry.url}`,
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
  },
  {
    name: 'chrome_screenshot',
    description:
      'Capture a PNG screenshot of the current DSH session page (or tabId) and return it as an image in this conversation. The file is also saved on disk. Use when layout or visual state matters; use chrome_snapshot for text.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
        clip: {
          type: 'object',
          description: 'Optional viewport region to capture, in CSS pixels.',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' },
          },
          required: ['x', 'y', 'width', 'height'],
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        path: { type: 'string' },
        mediaType: { type: 'string' },
        width: { type: 'number' },
        height: { type: 'number' },
        bytes: { type: 'number' },
        image: { type: 'object', additionalProperties: true },
      }),
      render: (_args, value) => {
        const blocks = []
        if (value.image && value.image.attachmentId) {
          blocks.push({ type: 'image', attachment: value.image })
        }
        blocks.push({
          type: 'text',
          text: `Screenshot ${value.width}x${value.height} (${formatBytes(value.bytes)}) saved to ${value.path}`,
        })
        return blocks
      },
    },
    async execute(args, exec) {
      const shot = await call(
        'tab.screenshot',
        { tabId: args?.tabId, clip: args?.clip, owner: ownerOf(exec) },
        60000,
      )
      if (!shot?.path) throw new BridgeError('INTERNAL', 'native host did not return a screenshot path')
      let bytes = shot.bytes
      let image = null
      try {
        const data = await fsp.readFile(shot.path)
        bytes = data.byteLength
        const service = attachments?.()
        if (service) {
          image = await service.saveImage({
            data: new Uint8Array(data),
            mediaType: shot.mediaType || 'image/png',
            name: `chrome-screenshot-${Date.now()}.png`,
          })
        }
      } catch {
        image = null
      }
      return {
        path: shot.path,
        mediaType: shot.mediaType || 'image/png',
        width: shot.width,
        height: shot.height,
        bytes,
        image,
      }
    },
  })

  // ---------------------------------------------------------------- 5. click
  list.push({
    name: 'chrome_click',
    description:
      'Click the interactive control with the given snapshot ref number on the current DSH session page. Take a fresh snapshot if refs may be stale. Returns the clicked element kind and label.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'number', description: 'Control number from the latest chrome_snapshot.' },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
      },
      required: ['ref'],
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        ok: { type: 'boolean' },
        tag: { type: 'string' },
        label: { type: 'string' },
        tabId: { type: 'number' },
      }),
      render: (_args, value) => renderText(`Clicked ${value.tag || 'element'} ${JSON.stringify(value.label || '')}`),
    },
    async execute(args, exec) {
      await guard(exec, 'chrome_click', `click ref ${args?.ref}`)
      return call('tab.click', { ref: args?.ref, tabId: args?.tabId, owner: ownerOf(exec) })
    },
  })

  // ----------------------------------------------------------------- 6. type
  list.push({
    name: 'chrome_type',
    description:
      'Type text into the input/textarea with the given snapshot ref number (React/Vue-safe). Set replace to clear first, submit to submit the owning form. The page is not re-snapshotted automatically.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'number', description: 'Control number from the latest chrome_snapshot.' },
        text: { type: 'string', description: 'Text to enter.' },
        replace: { type: 'boolean', description: 'Replace the existing value instead of appending.' },
        submit: { type: 'boolean', description: 'Submit the form after typing.' },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
      },
      required: ['ref', 'text'],
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        ok: { type: 'boolean' },
        value: { type: 'string' },
        submitted: { type: 'boolean' },
        tabId: { type: 'number' },
      }),
      render: (_args, value) =>
        renderText(
          `Typed into field${value.submitted ? ' and submitted the form' : ''}; value now ${JSON.stringify(value.value ?? '')}`,
        ),
    },
    async execute(args, exec) {
      await guard(exec, 'chrome_type', `type into ref ${args?.ref}`)
      return call('tab.type', {
        ref: args?.ref,
        text: String(args?.text ?? ''),
        replace: Boolean(args?.replace),
        submit: Boolean(args?.submit),
        tabId: args?.tabId,
        owner: ownerOf(exec),
      })
    },
  })

  // ---------------------------------------------------------------- 7. press
  list.push({
    name: 'chrome_press',
    description:
      'Dispatch a keyboard key (Enter, Tab, Escape, ArrowUp/Down/Left/Right, PageUp/PageDown, Home/End, or a single character) to the focused element on the current DSH session page.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key to press, e.g. Enter or Escape.' },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
      },
      required: ['key'],
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({ ok: { type: 'boolean' }, key: { type: 'string' }, target: { type: 'string' } }),
      render: (_args, value) => renderText(`Pressed ${value.key} on <${value.target}>`),
    },
    async execute(args, exec) {
      await guard(exec, 'chrome_press', `press ${args?.key}`)
      return call('tab.press', { key: String(args?.key ?? ''), tabId: args?.tabId, owner: ownerOf(exec) })
    },
  })

  // --------------------------------------------------------------- 8. scroll
  list.push({
    name: 'chrome_scroll',
    description:
      'Scroll the current DSH session page: direction up/down/top/bottom, optional pixel amount (default 600). Returns the resulting scroll position.',
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] },
        amount: { type: 'number', description: 'Pixels to scroll for up/down (default 600).' },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
      },
      required: ['direction'],
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        ok: { type: 'boolean' },
        y: { type: 'number' },
        viewportHeight: { type: 'number' },
        documentHeight: { type: 'number' },
      }),
      render: (_args, value) =>
        renderText(`Scrolled to y=${value.y} (viewport ${value.viewportHeight}, document ${value.documentHeight})`),
    },
    async execute(args, exec) {
      return call('tab.scroll', {
        direction: String(args?.direction ?? 'down'),
        amount: args?.amount,
        tabId: args?.tabId,
        owner: ownerOf(exec),
      })
    },
  })

  // -------------------------------------------------------------- 9. history
  list.push({
    name: 'chrome_history',
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
      }),
      render: (_args, value) =>
        renderText(`${value.title || '(untitled)'} — ${value.url} (${value.loadState})`),
    },
    async execute(args, exec) {
      await guard(exec, 'chrome_history', String(args?.op ?? 'reload'))
      return call('tab.history', {
        op: String(args?.op ?? 'reload'),
        tabId: args?.tabId,
        owner: ownerOf(exec),
      })
    },
  })

  // ----------------------------------------------------------------- 10. tabs
  list.push({
    name: 'chrome_tabs',
    description:
      'Manage tabs owned by this DSH session: list owned tabs, open a new background tab in the session tab group, or close an owned tab. Never lists or controls tabs outside this session.',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['list', 'new', 'close'] },
        url: { type: 'string', description: 'URL for op=new (http/https; defaults to about:blank).' },
        tabId: { type: 'number', description: 'Tab id for op=close.' },
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
      }),
      render: (_args, value) => {
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
      if (op !== 'list') await guard(exec, 'chrome_tabs', `tabs ${op}`)
      return call('tab.tabs', {
        op,
        url: args?.url,
        tabId: args?.tabId,
        owner: ownerOf(exec),
      })
    },
  })

  // ----------------------------------------------------------------- 11. wait
  list.push({
    name: 'chrome_wait',
    description:
      'Wait for the current DSH session page: until=load (document complete), until=networkidle (load + short settle), or until=text with a text argument (polls page text until it appears). Fails with TIMEOUT instead of hanging.',
    parameters: {
      type: 'object',
      properties: {
        until: { type: 'string', enum: ['load', 'networkidle', 'text'] },
        text: { type: 'string', description: 'Required when until=text.' },
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
      }),
      render: (_args, value) =>
        renderText(`Ready: ${value.title || '(untitled)'} — ${value.url} (${value.loadState})`),
    },
    async execute(args, exec) {
      return call(
        'tab.wait',
        {
          until: String(args?.until ?? 'load'),
          text: args?.text,
          timeoutMs: args?.timeoutMs,
          tabId: args?.tabId,
          owner: ownerOf(exec),
        },
        120000,
      )
    },
  })

  // -------------------------------------------------------- 12. close session
  list.push({
    name: 'chrome_close_session',
    description:
      "Close every tab owned by this DSH session (and its tab group). Does not quit Chrome and never touches the user's other tabs.",
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: outputSchema({ closed: { type: 'number' } }),
      render: (_args, value) => renderText(`Closed ${value.closed} session tab(s)`),
    },
    async execute(_args, exec) {
      await guard(exec, 'chrome_close_session', 'close session tabs')
      return call('tab.close_session', { owner: ownerOf(exec) })
    },
  })

  return list
}
