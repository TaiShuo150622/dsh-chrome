/**
 * Model-facing chrome_* tools (P1: 12 tools).
 *
 * Reads (status/snapshot/screenshot/tabs list/wait) run without approval.
 * Mutating actions (goto/click/type/press/history/tabs new|close/close_session)
 * go through ctx.approval, which follows the DSH session policy ("follow-dsh":
 * under danger-full-access / never it is allowed without a prompt).
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { BridgeError } from './bridge.js'
import { appendAudit, dshHome, loadPolicy, originOf, policyPath, readAudit, resolvePolicy } from './policy.js'

const MUTATION_TIMEOUT_MS = 45000

function outputSchema(properties) {
  return { type: 'object', properties, additionalProperties: true }
}

function renderText(text) {
  return [{ type: 'text', text }]
}

let providerVersionCache
async function providerVersion() {
  if (providerVersionCache !== undefined) return providerVersionCache
  try {
    const raw = await fsp.readFile(new URL('../package.json', import.meta.url), 'utf8')
    providerVersionCache = JSON.parse(raw).version ?? null
  } catch {
    providerVersionCache = null
  }
  return providerVersionCache
}

async function readUpdateState() {
  const cacheDir = path.join(
    process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
    'cache',
    'dsh-chrome',
  )
  try {
    return JSON.parse(await fsp.readFile(path.join(cacheDir, 'update-state.json'), 'utf8'))
  } catch {
    return null
  }
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

export function chromeTools({ bridge, attachments, assets, approval, sessionContext, userQuestions, config }) {
  const list = []
  const ownerOf = (exec) => exec?.agent?.id ?? 'default'
  const pluginConfig = config?.() && typeof config() === 'object' ? config() : {}
  const allowEvaluate = pluginConfig.allowEvaluate === true
  const evaluateConfirmTimeoutMs = Number.isFinite(pluginConfig.evaluateConfirmTimeoutMs)
    ? Math.max(1000, Math.min(600000, Number(pluginConfig.evaluateConfirmTimeoutMs)))
    : 120000
  const captureConfirmTimeoutMs = Number.isFinite(pluginConfig.captureConfirmTimeoutMs)
    ? Math.max(1000, Math.min(600000, Number(pluginConfig.captureConfirmTimeoutMs)))
    : 120000
  // Default "hard": every capture start asks the human. "follow-dsh" is a
  // development/test escape hatch; it never skips the tool registration.
  const captureConfirmMode = pluginConfig.captureConfirm === 'follow-dsh' ? 'follow-dsh' : 'hard'

  const sessionLabel = (exec) => {
    try {
      const services = sessionContext?.()
      const session = services?.sessions?.get?.(exec?.agent?.id)
      const cwd = session?.header?.cwd ?? session?.cwd ?? session?.meta?.cwd
      if (typeof cwd === 'string' && cwd.trim()) return path.basename(cwd)
    } catch {
      // fall through to short id in the extension
    }
    return null
  }

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

  const sessionShort = (exec) => {
    const id = exec?.agent?.id || 'default'
    return String(id).slice(-8)
  }

  async function currentSite(exec) {
    try {
      const site = await bridge.call('browser.site', { owner: ownerOf(exec) }, 5000)
      return { origin: site?.origin || null, url: site?.url || '', title: site?.title || '', tabId: site?.tabId ?? null }
    } catch {
      return { origin: null, url: '', title: '', tabId: null }
    }
  }

  function writeAudit(exec, toolName, action, site, decision, reason) {
    appendAudit(dshHome(), {
      ts: new Date().toISOString(),
      session: sessionShort(exec),
      tool: toolName,
      origin: site?.origin || null,
      action: String(action || '').slice(0, 300),
      decision,
      reason,
    })
  }

  async function guard(exec, toolName, action) {
    const site = await currentSite(exec)
    const resolved = resolvePolicy(loadPolicy(dshHome()), site.origin)
    if (resolved.mode === 'block') {
      writeAudit(exec, toolName, action, site, 'denied', 'site-blocked')
      throw new BridgeError('SITE_BLOCKED', `site ${site.origin || '(unknown)'} is blocked by policy.json`)
    }
    if (resolved.mode === 'allow') {
      writeAudit(exec, toolName, action, site, 'allowed', 'site-allow')
      return
    }
    // follow-dsh: the session's sandbox preset already grants full access.
    if (sessionSandboxMode(exec) === 'danger-full-access') {
      writeAudit(exec, toolName, action, site, 'allowed', 'follow-dsh')
      return
    }
    const service = approval?.()
    if (!service || !exec?.agent) {
      writeAudit(exec, toolName, action, site, 'allowed', 'no-approval-service')
      return
    }
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
      writeAudit(exec, toolName, action, site, 'denied', 'approval-unavailable')
      throw new BridgeError('APPROVAL_DENIED', `approval unavailable: ${error?.message || error}`)
    }
    if (outcome !== 'allowed-once') {
      writeAudit(exec, toolName, action, site, 'denied', `approval-${outcome}`)
      throw new BridgeError('APPROVAL_DENIED', `browser action was not approved (${outcome})`)
    }
    writeAudit(exec, toolName, action, site, 'allowed', 'approval')
  }

  async function hardConfirmAsk(exec, toolName, { header, question, detail, timeoutMs }) {
    const service = userQuestions?.()
    if (!service || typeof service.ask !== 'function') {
      throw new BridgeError('APPROVAL_DENIED', 'hard confirmation service is unavailable; refusing sensitive action')
    }
    if (!exec?.agent) {
      throw new BridgeError('APPROVAL_DENIED', 'hard confirmation requires a live agent')
    }
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, Number.isFinite(timeoutMs) ? timeoutMs : evaluateConfirmTimeoutMs)
    const forwardAbort = () => controller.abort()
    exec.signal?.addEventListener?.('abort', forwardAbort)
    try {
      const answer = await service.ask({
        agent: exec.agent,
        signal: controller.signal,
        questions: [
          {
            id: 'confirm',
            header,
            question,
            ...(detail ? { detail } : {}),
            options: [
              { label: '允许一次', description: '只执行这一次，不持久授权' },
              { label: '拒绝', description: '不执行并返回 APPROVAL_DENIED' },
            ],
          },
        ],
      })
      const selected = answer?.answers?.[0]?.selected
      const choice = Array.isArray(selected) ? selected.join(' ') : ''
      if (!choice.includes('允许')) {
        throw new BridgeError('APPROVAL_DENIED', 'sensitive browser action was not approved')
      }
    } catch (error) {
      if (error instanceof BridgeError) throw error
      const code = String(error?.code || error?.name || '')
      if (timedOut) throw new BridgeError('APPROVAL_TIMEOUT', 'confirmation timed out')
      if (code === 'DELEGATED_CALLER') {
        throw new BridgeError('DELEGATED_CALLER', 'delegated agents cannot confirm this browser action')
      }
      throw new BridgeError('APPROVAL_DENIED', `confirmation failed: ${error?.message || error}`)
    } finally {
      clearTimeout(timer)
      exec.signal?.removeEventListener?.('abort', forwardAbort)
    }
  }

  async function hardConfirm(exec, toolName, expression) {
    return hardConfirmAsk(exec, toolName, {
      header: '执行页面 JavaScript',
      question: `${toolName} 将在当前页面执行一段表达式，是否允许本次执行？\n\n${String(expression).slice(0, 800)}`,
      timeoutMs: evaluateConfirmTimeoutMs,
    })
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
        diskVersion: {},
        autoReload: { type: 'boolean' },
        providerVersion: {},
        updateState: { type: 'object', additionalProperties: true },
        groupCount: {},
        groups: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
        },
        error: { type: 'string' },
      }),
      render: (_args, value) => {
        const lines = [
          `Chrome bridge: ${value.connected ? 'CONNECTED' : 'NOT CONNECTED'}`,
          `provider: ${value.provider}  protocol: ${value.protocol}`,
          `extension: ${value.extensionVersion ?? 'unknown'}  host: ${value.hostVersion ?? 'unknown'}`,
          `extension id: ${value.extensionId ?? 'unknown'}`,
          `disk version: ${value.diskVersion ?? 'unknown'}  auto-reload: ${value.autoReload ? 'on' : 'off'}`,
          `provider: ${value.providerVersion ?? 'unknown'}  last reload: ${value.updateState?.lastReloadRequestedAt ?? 'never'}`,
          `session tab groups: ${value.groupCount ?? 'unknown'}`,
        ]
        if (Array.isArray(value.groups) && value.groups.length > 0) {
          lines.push(
            `groups: ${value.groups
              .map((group) => `#${group.id} ${JSON.stringify(group.title)} tabs=${group.tabs}`)
              .join(' | ')}`,
          )
        }
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
        diskVersion: null,
        autoReload: false,
        providerVersion: await providerVersion(),
        updateState: await readUpdateState(),
      }
      if (bridge.connected) {
        try {
          const status = await bridge.call('browser.status', {}, 3000)
          if (typeof status?.extensionVersion === 'string') {
            value.extensionVersion = status.extensionVersion
            bridge.extensionVersion = status.extensionVersion
          }
          if (typeof status?.diskVersion === 'string') value.diskVersion = status.diskVersion
          value.autoReload = Boolean(status?.autoReload)
          value.groupCount = status?.groupCount ?? null
          if (Array.isArray(status?.groups)) value.groups = status.groups
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
        frame: { type: 'object', additionalProperties: true },
      }),
      render: (_args, value) =>
        renderText(`Navigated to ${value.title || '(untitled)'} — ${value.url} (${value.loadState})`),
    },
    async execute(args, exec) {
      const url = validateHttpUrl(args?.url)
      await guard(exec, 'chrome_goto', `navigate to ${url}`)
      return call('tab.goto', { url, owner: ownerOf(exec), ownerLabel: sessionLabel(exec) })
    },
  })

  // -------------------------------------------------------------- 3. snapshot
  list.push({
    name: 'chrome_snapshot',
    description:
      'Return a text snapshot of the current DSH session page: title, URL, a numbered list of visible interactive controls (use the numbers as refs for click/type), and visible page text. Refs are stable across snapshots until the page changes; newly seen controls are marked with new:true. Password and payment-card values are masked. Prefer this over screenshots for reading content.',
    parameters: {
      type: 'object',
      properties: {
        maxChars: { type: 'number', description: 'Maximum page-text characters to return (default 100000).' },
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
        body.push('', 'Page text:', value.text || '', value.truncated ? '\n[truncated]' : '')
        return renderText(body.join('\n'))
      },
    },
    async execute(args, exec) {
      const maxChars = Number.isFinite(args?.maxChars)
        ? Math.max(1000, Math.min(200000, args.maxChars))
        : 100000
      return call(
        'tab.snapshot',
        { maxChars, boxes: Boolean(args?.boxes), mode: args?.mode || 'full', frames: args?.frames || 'all', tabId: args?.tabId, owner: ownerOf(exec) },
        30000,
      )
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
  },
  {
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
  },
  {
    name: 'chrome_select',
    description:
      'Select an option in a <select>, set a checkbox/radio, or toggle one. Takes a ref from chrome_snapshot or chrome_find. Pass value for select/radio, checked for checkbox/radio.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'number', description: 'Ref of the select/checkbox/radio control.' },
        selector: { type: 'string', description: 'CSS selector alternative to ref (used when ref is omitted).' },
        value: { type: 'string', description: 'Option value or visible label (for <select>).' },
        checked: { type: 'boolean', description: 'Desired checked state (for checkbox/radio); defaults to toggle.' },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        ok: { type: 'boolean' },
        tag: { type: 'string' },
        value: { type: 'string' },
      }),
      render: (_args, value) => [
        { type: 'text', text: `${value.tag} → ${value.value}` },
      ],
    },
    async execute(args, exec) {
      const value = await call(
        'tab.select',
        { ref: args?.ref, selector: args?.selector, value: args?.value, checked: args?.checked, tabId: args?.tabId, owner: ownerOf(exec) },
        30000,
      )
      if (!value) throw new BridgeError('INTERNAL', 'extension returned no select result')
      return value
    },
  },
  {
    name: 'chrome_drag',
    description:
      'Drag from one snapshot ref to another (pointer/mouse plus HTML5 drag events). Useful for sliders, sortable lists and kanban boards.',
    parameters: {
      type: 'object',
      properties: {
        fromRef: { type: 'number', description: 'Ref of the element to drag.' },
        toRef: { type: 'number', description: 'Ref of the drop target.' },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
      },
      required: ['fromRef', 'toRef'],
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        ok: { type: 'boolean' },
        from: { type: 'number' },
        to: { type: 'number' },
        tabId: { type: 'number' },
      }),
      render: (_args, value) => renderText(`Dragged ref ${value.from} → ref ${value.to}`),
    },
    async execute(args, exec) {
      await guard(exec, 'chrome_drag', `drag ${args?.fromRef}->${args?.toRef}`)
      return call(
        'tab.drag',
        { fromRef: args?.fromRef, toRef: args?.toRef, tabId: args?.tabId, owner: ownerOf(exec) },
        30000,
      )
    },
  },
  {
    name: 'chrome_emulate',
    description:
      'Override the viewport with CDP Emulation (responsive testing): set width/height/mobile, or reset to the real viewport. Layout and screenshots follow the override.',
    parameters: {
      type: 'object',
      properties: {
        width: { type: 'number', description: 'Viewport width in CSS px (>=100).' },
        height: { type: 'number', description: 'Viewport height in CSS px (>=100).' },
        mobile: { type: 'boolean', description: 'Emulate a mobile device.' },
        reset: { type: 'boolean', description: 'Clear the viewport override.' },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        width: {},
        height: {},
        applied: { type: 'boolean' },
        reloaded: { type: 'boolean' },
        clearError: {},
        viewport: { type: 'object', additionalProperties: true },
      }),
      render: (_args, value) => {
        const inner = value.viewport ? ` (window ${value.viewport.innerWidth}x${value.viewport.innerHeight})` : ''
        return renderText(
          value.applied
            ? `Viewport emulated at ${value.width}x${value.height}${inner}`
            : `Viewport override cleared${value.reloaded ? ', page reloaded' : ''}${inner}`,
        )
      },
    },
    async execute(args, exec) {
      const reset = Boolean(args?.reset)
      if (!reset) {
        const width = Number(args?.width)
        const height = Number(args?.height)
        if (!Number.isFinite(width) || !Number.isFinite(height)) {
          throw new BridgeError('INVALID_ARGUMENT', 'width and height are required unless reset:true')
        }
      }
      await guard(exec, 'chrome_emulate', reset ? 'reset viewport' : `emulate ${args?.width}x${args?.height}`)
      return call(
        'tab.emulate',
        { width: args?.width, height: args?.height, mobile: Boolean(args?.mobile), reset, tabId: args?.tabId, owner: ownerOf(exec) },
        30000,
      )
    },
  },
  {
    name: 'chrome_storage',
    description:
      'Read or change the session page storage (localStorage / sessionStorage): get one key, several keys or all entries; set/remove/clear (mutations require approval). Values are JSON-encoded when not strings.',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['get', 'set', 'remove', 'clear'] },
        scope: { type: 'string', enum: ['local', 'session'], description: 'Storage area (default local).' },
        key: { type: 'string', description: 'Key for get/set.' },
        value: { description: 'Value for set (string or JSON-serializable value).' },
        keys: { type: 'array', items: { type: 'string' }, description: 'Keys for get/remove batches.' },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
      },
      required: ['op'],
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        ok: { type: 'boolean' },
        scope: { type: 'string' },
        value: {},
        items: { type: 'object', additionalProperties: true },
        set: { type: 'number' },
        removed: { type: 'number' },
        cleared: { type: 'boolean' },
        tabId: { type: 'number' },
      }),
      render: (_args, value) => {
        if (value.items) {
          const lines = Object.entries(value.items).map(([key, item]) => `${key}=${JSON.stringify(item)}`)
          return renderText(`${value.scope}Storage: ${lines.join(', ') || '(empty)'}`)
        }
        if (value.value !== undefined) return renderText(`${value.scope}Storage ${JSON.stringify(value.value)}`)
        if (value.set != null) return renderText(`Set ${value.set} key(s) in ${value.scope}Storage`)
        if (value.removed != null) return renderText(`Removed ${value.removed} key(s) from ${value.scope}Storage`)
        return renderText(`Cleared ${value.scope}Storage`)
      },
    },
    async execute(args, exec) {
      const op = String(args?.op ?? 'get')
      if (op !== 'get') await guard(exec, 'chrome_storage', `storage ${op}`)
      return call(
        'tab.storage',
        {
          op,
          scope: args?.scope,
          key: args?.key,
          value: args?.value,
          keys: args?.keys,
          tabId: args?.tabId,
          owner: ownerOf(exec),
        },
        30000,
      )
    },
  },
  {
    name: 'chrome_pdf',
    description:
      'Export the current DSH session page to a PDF file with CDP Page.printToPDF and return the saved path. Useful for archiving or sharing a page as it renders.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Optional absolute output path; defaults to the DSH cache pdfs directory.' },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        path: { type: 'string' },
        bytes: { type: 'number' },
      }),
      render: (_args, value) => renderText(`PDF ${(value.bytes / 1024).toFixed(1)} KiB saved to ${value.path}`),
    },
    async execute(args, exec) {
      const value = await call('tab.pdf', { tabId: args?.tabId, owner: ownerOf(exec) }, 60000)
      if (!value?.dataBase64) throw new BridgeError('INTERNAL', 'extension returned no pdf data')
      const cacheDir = path.join(
        process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
        'cache',
        'dsh-chrome',
        'pdfs',
      )
      const target = args?.path ? String(args.path) : path.join(cacheDir, `page-${Date.now()}.pdf`)
      await fsp.mkdir(path.dirname(target), { recursive: true })
      const bytes = Buffer.from(value.dataBase64, 'base64')
      await fsp.writeFile(target, bytes, { mode: 0o600 })
      return { path: target, bytes: bytes.length }
    },
  },
  {
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
  },
  {
    name: 'chrome_screenshot',
    description:
      'Capture a PNG screenshot of the current DSH session page (or tabId) and return it as an image in this conversation. The file is also saved on disk. Use when layout or visual state matters; use chrome_snapshot for text.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
        ref: { type: 'number', description: 'Capture only the element with this snapshot ref.' },
        frameRef: { type: 'string', description: 'Capture only an iframe element, e.g. "f83F9D728:1" (from chrome_snapshot frames).' },
        fullPage: { type: 'boolean', description: 'Capture the full scrollable document instead of the viewport.' },
        highlight: { type: 'boolean', description: 'Overlay labeled boxes for current snapshot refs in the capture.' },
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
        { tabId: args?.tabId, ref: args?.ref, frameRef: args?.frameRef, clip: args?.clip, fullPage: Boolean(args?.fullPage), highlight: Boolean(args?.highlight), owner: ownerOf(exec) },
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

  // ---------------------------------------------------------------- 5. hover
  list.push({
    name: 'chrome_hover',
    description:
      'Hover over the control with the given snapshot ref (useful to reveal menus, tooltips or hover-only actions). Take a fresh snapshot if refs may be stale. The virtual cursor is shown at the target.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'number', description: 'Control number from the latest chrome_snapshot or chrome_find.' },
        selector: { type: 'string', description: 'CSS selector alternative to ref (used when ref is omitted).' },
        frameRef: { type: 'string', description: 'Iframe handle from chrome_snapshot frames, e.g. "f83F9D728:1".' },
        snapshot: {
          type: 'boolean',
          description: 'Attach a fresh page snapshot to the result (saves a separate chrome_snapshot roundtrip).',
        },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        ok: { type: 'boolean' },
        tag: { type: 'string' },
        label: { type: 'string' },
        tabId: { type: 'number' },
        page: { type: 'object', additionalProperties: true },
      }),
      render: (_args, value) => renderText(`Hovered ${value.tag || 'element'} ${JSON.stringify(value.label || '')}${value.page ? '\n[page snapshot attached]' : ''}`),
    },
    async execute(args, exec) {
      await guard(exec, 'chrome_hover', `hover ref ${args?.ref}`)
      return call('tab.hover', { ref: args?.ref, selector: args?.selector, frameRef: args?.frameRef, snapshot: Boolean(args?.snapshot), tabId: args?.tabId, owner: ownerOf(exec) })
    },
  })

  // ------------------------------------------------------------ 4b. chrome_html
  list.push({
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
        selector: { type: 'string', description: 'CSS selector alternative to ref (used when ref is omitted).' },
        frameRef: { type: 'string', description: 'Iframe handle from chrome_snapshot frames, e.g. "f83F9D728:1" (takes precedence over ref).' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default left).' },
        clickCount: { type: 'number', description: 'Click count, 1-3 (default 1; 2 = double click).' },
        snapshot: {
          type: 'boolean',
          description: 'Attach a fresh page snapshot to the result (saves a separate chrome_snapshot roundtrip).',
        },
        dialog: {
          type: 'object',
          description:
            'How to answer a JS dialog (confirm/prompt/beforeunload) triggered by this action. Default: dismiss. Set accept:true to accept; promptText fills a prompt.',
          properties: {
            accept: { type: 'boolean' },
            promptText: { type: 'string' },
          },
          additionalProperties: false,
        },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        ok: { type: 'boolean' },
        tag: { type: 'string' },
        label: { type: 'string' },
        tabId: { type: 'number' },
        dialogs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string' },
              message: { type: 'string' },
              accepted: { type: 'boolean' },
            },
            additionalProperties: true,
          },
        },
        page: { type: 'object', additionalProperties: true },
      }),
      render: (_args, value) => renderText(`Clicked ${value.tag || 'element'} ${JSON.stringify(value.label || '')}${value.page ? '\n[page snapshot attached]' : ''}`),
    },
    async execute(args, exec) {
      await guard(exec, 'chrome_click', `click ref ${args?.ref}`)
      return call('tab.click', { ref: args?.ref, selector: args?.selector, frameRef: args?.frameRef, button: args?.button, clickCount: args?.clickCount, snapshot: Boolean(args?.snapshot), dialog: args?.dialog, tabId: args?.tabId, owner: ownerOf(exec) })
    },
  })

  // --------------------------------------------------------- 4c. selection
  list.push({
    name: 'chrome_selection',
    description:
      'Read the current page selection (or selected text inside a focused input/textarea) with its source URL and title, wrapped as untrusted page content. Password/payment/secret fields return SENSITIVE_SELECTION; no selection returns NO_SELECTION.',
    parameters: {
      type: 'object',
      properties: {
        maxChars: { type: 'number', description: 'Optional cap (10-20000, default 4000).' },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        found: { type: 'boolean' },
        text: { type: 'string' },
        url: { type: 'string' },
        title: { type: 'string' },
        truncated: { type: 'boolean' },
        source: { type: 'string' },
        tabId: { type: 'number' },
      }),
      render: (_args, value) =>
        renderText(
          `Selection from ${value.url || 'page'} (${value.title || ''}):\n${value.text || ''}${value.truncated ? '\n[truncated]' : ''}`,
        ),
    },
    async execute(args, exec) {
      return call(
        'tab.selection',
        { maxChars: args?.maxChars, tabId: args?.tabId, owner: ownerOf(exec) },
        30000,
      )
    },
  })

  // ------------------------------------------------------- 1b. policy/audit
  list.push({
    name: 'chrome_policy',
    description:
      'Read the effective site policy for the current page (or an explicit origin) from ~/.dsh/cache/dsh-chrome/policy.json. Modes: allow (skip ordinary approval), ask (session approval), block (SITE_BLOCKED). Read-only: policy.json is edited by the human, never by tools.',
    parameters: {
      type: 'object',
      properties: {
        origin: { type: 'string', description: 'Optional origin, e.g. https://example.com (default: current session tab).' },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        origin: {},
        mode: {},
        source: { type: 'string' },
        policyPath: { type: 'string' },
        url: { type: 'string' },
      }),
      render: (_args, value) =>
        renderText(
          `Policy for ${value.origin || '(unknown origin)'}: ${value.mode || 'default (follow-dsh)'} [${value.source}]\npolicy file: ${value.policyPath}`,
        ),
    },
    async execute(args, exec) {
      const site = args?.origin
        ? { origin: originOf(args.origin) || String(args.origin), url: '', title: '', tabId: null }
        : await currentSite(exec)
      const resolved = resolvePolicy(loadPolicy(dshHome()), site.origin)
      return {
        origin: resolved.origin,
        mode: resolved.mode,
        source: resolved.source,
        policyPath: policyPath(dshHome()),
        url: site.url || '',
      }
    },
  })

  list.push({
    name: 'chrome_audit',
    description:
      'Read the recent site-policy audit log (~/.dsh/cache/dsh-chrome/audit.jsonl): timestamp, session, tool, origin, action, decision and reason for every guarded browser write.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max entries returned (default 20, max 100).' },
        origin: { type: 'string', description: 'Only entries for this origin.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        entries: { type: 'array', items: { type: 'object', additionalProperties: true } },
      }),
      render: (_args, value) => {
        const lines = (value.entries || []).map(
          (entry) =>
            `- ${entry.ts} ${entry.tool || '?'} ${entry.origin || '(none)'} → ${entry.decision} (${entry.reason || ''})`,
        )
        return renderText(`Audit entries: ${value.entries?.length ?? 0}\n${lines.join('\n')}`)
      },
    },
    async execute(args) {
      const limit = Number.isFinite(args?.limit) ? Math.max(1, Math.min(100, Number(args.limit))) : 20
      const origin = args?.origin ? originOf(args.origin) || String(args.origin) : null
      return { entries: readAudit(dshHome(), { limit, origin }) }
    },
  })

  // ---------------------------------------------------------- 4i. shots
  list.push({
    name: 'chrome_shots',
    description:
      'List or read screenshot history saved by this provider (~/.dsh/cache/dsh-chrome/screenshots). History is filesystem-backed, so it survives restarts. op="list" returns recent screenshots with size + PNG dimensions; op="read" returns one screenshot (path under that directory) as an image attachment.',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['list', 'read'] },
        limit: { type: 'number', description: 'list: max entries (default 20, max 100).' },
        path: { type: 'string', description: 'read: absolute path under the screenshots directory.' },
      },
      required: ['op'],
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        directory: { type: 'string' },
        entries: { type: 'array', items: { type: 'object', additionalProperties: true } },
        path: { type: 'string' },
        width: {},
        height: {},
        bytes: { type: 'number' },
        image: { type: 'object', additionalProperties: true },
      }),
      render: (_args, value) => {
        if (value.image) {
          return [
            { type: 'image', attachment: value.image },
            { type: 'text', text: `Screenshot ${value.width}x${value.height} (${formatBytes(value.bytes)}) ${value.path}` },
          ]
        }
        const lines = (value.entries || []).map(
          (entry) => `- ${entry.mtime} ${entry.name} (${formatBytes(entry.bytes)}${entry.width ? `, ${entry.width}x${entry.height}` : ''})`,
        )
        return renderText(`Screenshot history (${value.entries?.length ?? 0}) in ${value.directory}\n${lines.join('\n')}`)
      },
    },
    async execute(args) {
      const directory = path.join(dshHome(), 'cache', 'dsh-chrome', 'screenshots')
      const op = String(args?.op || 'list')
      if (op === 'list') {
        const limit = Number.isFinite(args?.limit) ? Math.max(1, Math.min(100, Number(args.limit))) : 20
        let names = []
        try {
          names = await fsp.readdir(directory)
        } catch {
          names = []
        }
        const entries = []
        for (const name of names) {
          if (!/\.(png|jpe?g)$/i.test(name)) continue
          const file = path.join(directory, name)
          try {
            const stat = await fsp.stat(file)
            const entry = {
              name,
              path: file,
              bytes: stat.size,
              mtime: stat.mtime.toISOString(),
              mtimeMs: stat.mtimeMs,
            }
            if (/\.png$/i.test(name)) {
              try {
                const head = Buffer.alloc(24)
                const handle = await fsp.open(file, 'r')
                try {
                  await handle.read(head, 0, 24, 0)
                } finally {
                  await handle.close()
                }
                if (head.readUInt32BE(0) === 0x89504e47) {
                  entry.width = head.readUInt32BE(16)
                  entry.height = head.readUInt32BE(20)
                }
              } catch {
                // dimensions optional
              }
            }
            entries.push(entry)
          } catch {
            // skip unreadable file
          }
        }
        entries.sort((a, b) => b.mtimeMs - a.mtimeMs)
        return { directory, entries: entries.slice(0, limit) }
      }
      if (op === 'read') {
        const target = path.resolve(String(args?.path || ''))
        const root = path.resolve(directory)
        if (!target.startsWith(`${root}${path.sep}`)) {
          throw new BridgeError('INVALID_ARGUMENT', 'path must be inside the screenshots directory')
        }
        const data = await fsp.readFile(target)
        let width
        let height
        if (data.length >= 24 && data.readUInt32BE(0) === 0x89504e47) {
          width = data.readUInt32BE(16)
          height = data.readUInt32BE(20)
        }
        let image = null
        try {
          const service = attachments?.()
          if (service) {
            image = await service.saveImage({
              data: new Uint8Array(data),
              mediaType: /\.jpe?g$/i.test(target) ? 'image/jpeg' : 'image/png',
              name: path.basename(target),
            })
          }
        } catch {
          image = null
        }
        return { directory, path: target, bytes: data.byteLength, width, height, image }
      }
      throw new BridgeError('INVALID_ARGUMENT', `unknown shots op: ${op}`)
    },
  })

  // ---------------------------------------------------------- 4h. resume
  list.push({
    name: 'chrome_resume',
    description:
      'Resume normal browser actions after a USER_SWITCHED pause. A pause is set when the user activates another tab while the DSH session tab was the active one; the next mutating action returns USER_SWITCHED until this tool (or chrome_tabs {op:"focus"}) clears it.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: outputSchema({
        ok: { type: 'boolean' },
        tabId: {},
      }),
      render: (_args, value) => renderText(`Resumed browser session${value.tabId != null ? ` (tab ${value.tabId})` : ''}`),
    },
    async execute(_args, exec) {
      return call('tab.resume', { owner: ownerOf(exec) }, 15000)
    },
  })

  // ------------------------------------------------------------ 4g. pick
  list.push({
    name: 'chrome_pick',
    description:
      'Enter element-pick mode: an overlay appears; the user clicks one element and the tool returns {ref, selector, text, tag, box}. The returned ref can be used directly with chrome_click/chrome_type. Blocks until the pick completes, is canceled, or times out. Set cancel:true to abort an active pick.',
    parameters: {
      type: 'object',
      properties: {
        timeoutMs: { type: 'number', description: 'Pick timeout, 500-120000 ms (default 60000).' },
        cancel: { type: 'boolean', description: 'Cancel the active pick instead of starting a new one.' },
        nowait: { type: 'boolean', description: 'Start pick mode and return immediately; use poll:true later to fetch the result.' },
        poll: { type: 'boolean', description: 'Return the current pick status; pending:true means the user has not clicked yet.' },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        ref: { type: 'number' },
        selector: { type: 'string' },
        text: { type: 'string' },
        tag: { type: 'string' },
        box: { type: 'array', items: { type: 'number' } },
        canceled: { type: 'boolean' },
        started: { type: 'boolean' },
        pending: { type: 'boolean' },
        tabId: {},
      }),
      render: (_args, value) => {
        if (value.pending) return renderText('Pick pending: waiting for the user to click an element')
        if (value.started) return renderText('Pick mode started; use chrome_pick {poll:true} to fetch the result')
        if (value.canceled) return renderText('Pick canceled')
        return renderText(
          `Picked <${value.tag || 'element'}> ref=${value.ref} ${JSON.stringify(value.text || '')}\nselector: ${value.selector || ''}\nbox: [${(value.box || []).join(',')}]`,
        )
      },
    },
    async execute(args, exec) {
      const tabId = args?.tabId
      const owner = ownerOf(exec)
      if (args?.cancel) {
        await call('tab.pick_cancel', { tabId, owner }, 15000)
        return { canceled: true, tabId: tabId ?? null }
      }
      if (args?.poll) {
        const status = await call('tab.pick_status', { tabId, owner }, 15000)
        if (!status?.available) throw new BridgeError('PICK_CANCELED', 'no pick mode is active')
        if (!status.done) return { pending: true, tabId: tabId ?? null }
        if (status.canceled || !status.result) throw new BridgeError('PICK_CANCELED', 'pick was canceled')
        return { ...status.result, canceled: false, tabId: tabId ?? null }
      }
      if (args?.nowait) {
        const startedInfo = await call('tab.pick_start', { tabId, owner }, 15000)
        return { started: true, tabId: startedInfo?.tabId ?? tabId ?? null }
      }
      const timeoutMs = Number.isFinite(args?.timeoutMs)
        ? Math.max(500, Math.min(120000, Number(args.timeoutMs)))
        : 60000
      await call('tab.pick_start', { tabId, owner }, 15000)
      const started = Date.now()
      while (Date.now() - started < timeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, 250))
        const status = await call('tab.pick_status', { tabId, owner }, 15000)
        if (!status?.available) {
          await call('tab.pick_cancel', { tabId, owner }, 15000).catch(() => {})
          throw new BridgeError('PICK_CANCELED', 'pick mode was closed')
        }
        if (status.done) {
          if (status.canceled || !status.result) throw new BridgeError('PICK_CANCELED', 'pick was canceled')
          return { ...status.result, canceled: false, tabId: tabId ?? null }
        }
      }
      await call('tab.pick_cancel', { tabId, owner }, 15000).catch(() => {})
      throw new BridgeError('PICK_TIMEOUT', `no element picked within ${timeoutMs}ms`)
    },
  })

  // -------------------------------------------------------- 4e. evaluate (gated)
  if (allowEvaluate) {
    list.push({
      name: 'chrome_evaluate',
      description:
        'Evaluate a JavaScript expression in the current DSH session page through CDP Runtime.evaluate. Disabled by default: it is registered only when allowEvaluate is true in ~/.dsh/cache/dsh-chrome/config.json, and every call requires an explicit hard confirmation (userQuestions) even under danger-full-access. Page content and the result are untrusted data.',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: 'JavaScript expression to evaluate in the page.' },
          awaitPromise: { type: 'boolean', description: 'Await a returned promise (default false).' },
          timeoutMs: { type: 'number', description: 'Evaluation timeout, 500-30000 ms (default 10000).' },
          tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
        },
        required: ['expression'],
        additionalProperties: false,
      },
      output: {
        schema: outputSchema({
          ok: { type: 'boolean' },
          value: {},
          type: { type: 'string' },
          unserializable: { type: 'boolean' },
        }),
        render: (_args, value) => {
          const shown =
            value.unserializable && value.value != null
              ? String(value.value)
              : JSON.stringify(value.value)
          const clipped = shown != null && shown.length > 4000 ? `${shown.slice(0, 4000)}\n… (${shown.length} chars)` : shown
          return renderText(`evaluate (${value.type || 'unknown'}):\n${clipped ?? 'null'}`)
        },
      },
      async execute(args, exec) {
        const expression = String(args?.expression ?? '')
        if (!expression.trim()) throw new BridgeError('INVALID_ARGUMENT', 'expression must not be empty')
        await hardConfirm(exec, 'chrome_evaluate', expression)
        const value = await call(
          'tab.evaluate',
          {
            expression,
            awaitPromise: Boolean(args?.awaitPromise),
            timeoutMs: args?.timeoutMs,
            tabId: args?.tabId,
            owner: ownerOf(exec),
          },
          45000,
        )
        if (value && value.ok === false) {
          throw new BridgeError('EVAL_ERROR', value?.error?.message || 'page evaluation failed')
        }
        return value
      },
    })
  }

  // ---------------------------------------------------- 4f. HTTP capture (C2a)
  list.push({
    name: 'chrome_capture_start',
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
      if (captureConfirmMode === 'hard') {
        const tabHint = Number.isFinite(args?.tabId) ? `标签 ${args.tabId}` : '当前会话标签'
        await hardConfirmAsk(exec, 'chrome_capture_start', {
          header: '开始抓取网络请求（高敏感）',
          question: `允许抓取${tabHint} 的网络请求吗？会记录 URL/状态/脱敏后的请求与响应体（默认不含 Cookie/Authorization 等 headers），可能包含个人信息。`,
          detail: '停止：chrome_capture_stop；最长 10 分钟自动停止；抓包期间 Chrome 会显示「正在调试此浏览器」横幅',
          timeoutMs: captureConfirmTimeoutMs,
        })
      }
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
  })

  list.push({
    name: 'chrome_capture_stop',
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
  })

  list.push({
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
  })

  // ------------------------------------------------------------ 4d. frames
  list.push({
    name: 'chrome_frames',
    description:
      'List the frames of the current DSH session page (main frame plus iframes) via CDP Page.getFrameTree. Set probe:true to also read each frame URL/title/control count with a fixed read-only script in an isolated world (no arbitrary code injection).',
    parameters: {
      type: 'object',
      properties: {
        probe: { type: 'boolean', description: 'Read url/title/control count in every frame.' },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        tabId: { type: 'number' },
        frames: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
        },
      }),
      render: (_args, value) => {
        const lines = (value.frames || []).map((frame) => {
          const indent = frame.parentFrameId ? '  ↳ ' : ''
          const probe = frame.probe ? ` controls=${frame.probe.buttons} title=${JSON.stringify(frame.probe.title)}` : frame.probeError ? ` probeError=${frame.probeError}` : ''
          return `${indent}${String(frame.frameId || '').slice(0, 8) || '?'} ${frame.url || ''}${probe}`
        })
        return renderText(`Frames (${lines.length}):\n${lines.join('\n')}`)
      },
    },
    async execute(args, exec) {
      return call('tab.frames', { probe: Boolean(args?.probe), tabId: args?.tabId, owner: ownerOf(exec) }, 30000)
    },
  })

  // ------------------------------------------------------------ 5b. click_at
  list.push({
    name: 'chrome_click_at',
    description:
      'Click at CSS-pixel viewport coordinates (x, y) instead of a snapshot ref. Useful for canvas, maps, video controls and other painted UI that has no DOM control. Coordinates outside the viewport return OUT_OF_VIEWPORT.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Viewport x in CSS pixels.' },
        y: { type: 'number', description: 'Viewport y in CSS pixels.' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default left).' },
        clickCount: { type: 'number', description: 'Click count, 1-3 (default 1; 2 = double click).' },
        snapshot: { type: 'boolean', description: 'Attach a fresh page snapshot to the result.' },
        dialog: { type: 'object', additionalProperties: true },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        ok: { type: 'boolean' },
        x: { type: 'number' },
        y: { type: 'number' },
        tag: { type: 'string' },
        label: { type: 'string' },
        tabId: { type: 'number' },
        page: { type: 'object', additionalProperties: true },
      }),
      render: (_args, value) =>
        renderText(
          `Clicked at (${value.x}, ${value.y}) on <${value.tag || 'unknown'}> ${JSON.stringify(value.label || '')}${value.page ? '\n[page snapshot attached]' : ''}`,
        ),
    },
    async execute(args, exec) {
      await guard(exec, 'chrome_click_at', `click at ${args?.x},${args?.y}`)
      return call('tab.clickAt', {
        x: args?.x,
        y: args?.y,
        button: args?.button,
        clickCount: args?.clickCount,
        snapshot: Boolean(args?.snapshot),
        dialog: args?.dialog,
        tabId: args?.tabId,
        owner: ownerOf(exec),
      })
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
        selector: { type: 'string', description: 'CSS selector alternative to ref (used when ref is omitted).' },
        frameRef: { type: 'string', description: 'Iframe handle from chrome_snapshot frames, e.g. "f749ABB6B:2" (takes precedence over ref).' },
        text: { type: 'string', description: 'Text to enter.' },
        replace: { type: 'boolean', description: 'Replace the existing value instead of appending.' },
        submit: { type: 'boolean', description: 'Submit the form after typing.' },
        snapshot: {
          type: 'boolean',
          description: 'Attach a fresh page snapshot to the result (saves a separate chrome_snapshot roundtrip).',
        },
        dialog: {
          type: 'object',
          description:
            'How to answer a JS dialog (confirm/prompt/beforeunload) triggered by this action. Default: dismiss. Set accept:true to accept; promptText fills a prompt.',
          properties: {
            accept: { type: 'boolean' },
            promptText: { type: 'string' },
          },
          additionalProperties: false,
        },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        ok: { type: 'boolean' },
        value: { type: 'string' },
        submitted: { type: 'boolean' },
        tabId: { type: 'number' },
        dialogs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string' },
              message: { type: 'string' },
              accepted: { type: 'boolean' },
            },
            additionalProperties: true,
          },
        },
        page: { type: 'object', additionalProperties: true },
      }),
      render: (_args, value) =>
        renderText(
          `Typed into field${value.submitted ? ' and submitted the form' : ''}; value now ${JSON.stringify(value.value ?? '')}${value.page ? '\n[page snapshot attached]' : ''}`,
        ),
    },
    async execute(args, exec) {
      await guard(exec, 'chrome_type', `type into ref ${args?.ref}`)
      return call('tab.type', {
        ref: args?.ref,
        selector: args?.selector,
        frameRef: args?.frameRef,
        text: String(args?.text ?? ''),
        replace: Boolean(args?.replace),
        submit: Boolean(args?.submit),
        snapshot: Boolean(args?.snapshot),
        dialog: args?.dialog,
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
        snapshot: {
          type: 'boolean',
          description: 'Attach a fresh page snapshot to the result (saves a separate chrome_snapshot roundtrip).',
        },
        dialog: {
          type: 'object',
          description:
            'How to answer a JS dialog (confirm/prompt/beforeunload) triggered by this action. Default: dismiss. Set accept:true to accept; promptText fills a prompt.',
          properties: {
            accept: { type: 'boolean' },
            promptText: { type: 'string' },
          },
          additionalProperties: false,
        },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
      },
      required: ['key'],
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({ ok: { type: 'boolean' }, key: { type: 'string' }, target: { type: 'string' },
        dialogs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string' },
              message: { type: 'string' },
              accepted: { type: 'boolean' },
            },
            additionalProperties: true,
          },
        },
        page: { type: 'object', additionalProperties: true },
      }),
      render: (_args, value) => renderText(`Pressed ${value.key} on <${value.target}>${value.page ? '\n[page snapshot attached]' : ''}`),
    },
    async execute(args, exec) {
      await guard(exec, 'chrome_press', `press ${args?.key}`)
      return call('tab.press', { key: String(args?.key ?? ''), snapshot: Boolean(args?.snapshot), dialog: args?.dialog, tabId: args?.tabId, owner: ownerOf(exec) })
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
        snapshot: {
          type: 'boolean',
          description: 'Attach a fresh page snapshot to the result (saves a separate chrome_snapshot roundtrip).',
        },
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
        page: { type: 'object', additionalProperties: true },
      }),
      render: (_args, value) =>
        renderText(`Scrolled to y=${value.y} (viewport ${value.viewportHeight}, document ${value.documentHeight})${value.page ? '\n[page snapshot attached]' : ''}`),
    },
    async execute(args, exec) {
      return call('tab.scroll', {
        direction: String(args?.direction ?? 'down'),
        amount: args?.amount,
        snapshot: Boolean(args?.snapshot),
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
        frame: { type: 'object', additionalProperties: true },
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
      if (op !== 'list') await guard(exec, 'chrome_tabs', `tabs ${op}`)
      return call('tab.tabs', {
        op,
        url: args?.url,
        tabId: args?.tabId,
        owner: ownerOf(exec),
        ownerLabel: sessionLabel(exec),
      })
    },
  })

  // ----------------------------------------------------------------- 11. upload
  list.push({
    name: 'chrome_upload',
    description:
      'Attach local files to a file input on the session page (e.g. upload a screenshot or a document). The ref must point at an <input type=file> from the latest snapshot. Requires approval and only accepts existing local files.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'number', description: 'Ref of the file input element.' },
        selector: { type: 'string', description: 'CSS selector alternative to ref (used when ref is omitted).' },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Absolute local file paths to attach.',
        },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
      },
      required: ['files'],
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        ok: { type: 'boolean' },
        ref: {},
        selector: {},
        files: { type: 'number' },
      }),
      render: (_args, value) =>
        renderText(`Attached ${value.files} file(s) to ${value.ref != null ? `ref ${value.ref}` : `selector ${value.selector}`}`),
    },
    async execute(args, exec) {
      const ref = Number(args?.ref)
      const selector = args?.selector ? String(args.selector) : ''
      if (!Number.isFinite(ref) && !selector) throw new BridgeError('INVALID_ARGUMENT', 'ref or selector is required')
      const files = Array.isArray(args?.files) ? args.files.map(String) : []
      if (files.length === 0) throw new BridgeError('INVALID_ARGUMENT', 'files must be a non-empty array')
      for (const file of files) {
        const stat = await fsp.stat(file).catch(() => null)
        if (!stat?.isFile()) throw new BridgeError('INVALID_ARGUMENT', `not a file: ${file}`)
      }
      await guard(exec, 'chrome_upload', `upload ${files.length} file(s) to ref ${ref}`)
      const value = await call(
        'tab.upload',
        { ref: Number.isFinite(ref) ? ref : undefined, selector, files, tabId: args?.tabId, owner: ownerOf(exec) },
        60000,
      )
      if (!value) throw new BridgeError('INTERNAL', 'extension returned no upload result')
      return value
    },
  })

  // ----------------------------------------------------------------- 12. downloads
  list.push({
    name: 'chrome_download',
    description:
      'List recent Chrome downloads (filename, URL, state, bytes, start time). Use after triggering a download to find the saved file path.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max entries, 1-100 (default 20).' },
      },
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'number' },
              filename: { type: 'string' },
              url: { type: 'string' },
              state: { type: 'string' },
              bytesReceived: { type: 'number' },
              totalBytes: { type: 'number' },
              startTime: { type: 'string' },
            },
            additionalProperties: true,
          },
        },
      }),
      render: (_args, value) => {
        const lines = (value.items ?? []).map(
          (item) => `${item.state} ${item.totalBytes}B ${item.filename || item.url}`,
        )
        return renderText(lines.length ? lines.join('\n') : '(no downloads)')
      },
    },
    async execute(args) {
      const value = await call('browser.downloads', { limit: args?.limit }, 30000)
      if (!value) throw new BridgeError('INTERNAL', 'extension returned no download list')
      return value
    },
  })

  // ----------------------------------------------------------------- 11. wait
  list.push({
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
