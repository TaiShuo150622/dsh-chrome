/**
 * Provider status/config/policy tools: chrome_status, chrome_config,
 * chrome_policy and chrome_audit. Extracted from tools.js (Q19) so provider
 * introspection and the read-only policy/audit views live in one small module.
 * The bridge/assets/update injection is preserved; schema and render output are
 * unchanged.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { BridgeError } from './bridge.js'
import {
  dshHome,
  loadPolicy,
  originOf,
  policyPath,
  readAudit,
  readProviderConfig,
  resolvePolicy,
} from './policy.js'

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

function installHint(info) {
  if (!info) return 'Installation assets are still being prepared; retry in a moment.'
  return [
    'To connect Chrome:',
    `1. Open chrome://extensions, enable Developer mode, and Load unpacked: ${info.extensionDir}`,
    '2. Quit Chrome completely and reopen it (the native messaging manifest is read at startup).',
    '3. Click the DSH Chrome toolbar icon and confirm it says Connected.',
    `Full guide: ${info.instructionsPath}`,
  ].join('\n')
}

export function createStatusTools({
  bridge,
  assets,
  update = null,
  currentSite,
  sessionShort = null,
  writeAudit = null,
  hardConfirmAsk = null,
  evaluateConfirmTimeoutMs = null,
  outputSchema,
  renderText,
}) {
  const status = {
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
        backend: { type: 'string' },
        headless: { type: 'object', additionalProperties: true },
        updateState: { type: 'object', additionalProperties: true },
        pluginUpdate: { type: 'object', additionalProperties: true },
        groupCount: {},
        alarms: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
        },
        groups: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
        },
        error: { type: 'string' },
        // null means "no bridge start error"; a JSON type string rejects null.
        bridgeError: {},
      }),
      render: (_args, value) => {
        const lines = [
          `Browser backend: ${value.backend || 'desktop'} — ${value.connected ? 'CONNECTED' : 'NOT CONNECTED'}`,
          ...(value.headless
            ? [
                `headless: ${value.headless.supported ? 'available' : 'unavailable'}${value.headless.running ? ` (running ${value.headless.browserVersion || ''})` : ''}${value.headless.loginOpen ? ` (login window open, pid ${value.headless.loginPid ?? '?'})` : ''}`,
              ]
            : []),
          ...(value.headless?.state
            ? [
                `headless driver: ${value.headless.state}` +
                  `${value.headless.activeContextId ? ` (${value.headless.activeContextId})` : ''}` +
                  `${value.headless.deathReason ? ` — last exit: ${value.headless.deathReason}` : ''}` +
                  `${value.headless.chromePid != null ? `  pid ${value.headless.chromePid}` : ''}`,
              ]
            : []),
          ...(value.headless?.maxTabs != null || value.headless?.maxContexts != null
            ? [
                `headless limits: tabs ${value.headless.tabs ?? 0}/${value.headless.maxTabs ?? '?'}  contexts ${value.headless.contexts ?? 0}/${value.headless.maxContexts ?? '?'}`,
              ]
            : []),
          `Chrome bridge: ${value.connected ? 'CONNECTED' : 'NOT CONNECTED'}`,
          `provider: ${value.provider}  protocol: ${value.protocol}`,
          `extension: ${value.extensionVersion ?? 'unknown'}  host: ${value.hostVersion ?? 'unknown'}`,
          `extension id: ${value.extensionId ?? 'unknown'}`,
          `disk version: ${value.diskVersion ?? 'unknown'}  auto-reload: ${value.autoReload ? 'on' : 'off'}`,
          `provider: ${value.providerVersion ?? 'unknown'}  last reload: ${value.updateState?.lastReloadRequestedAt ?? 'never'}`,
          ...(value.bridgeError ? [`bridge error: ${value.bridgeError}`] : []),
          ...(value.pluginUpdate?.enabled
            ? [`plugin update: current ${value.pluginUpdate.current || '?'}  latest ${value.pluginUpdate.latest || '?'}  ${value.pluginUpdate.available ? 'AVAILABLE' : 'up to date'}${value.pluginUpdate.error ? `  (check failed: ${value.pluginUpdate.error})` : ''}`]
            : []),
          `session tab groups: ${value.groupCount ?? 'unknown'}`,
        ]
        if (Array.isArray(value.alarms) && value.alarms.length > 0) {
          lines.push(
            `reconnect alarms: ${value.alarms
              .map((alarm) => `${alarm.name}${alarm.periodInMinutes ? ` (every ${alarm.periodInMinutes} min)` : ''}`)
              .join(' | ')}`,
          )
        }
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
    async execute(_args, exec) {
      const info = assets() ?? {}
      const bridgeError = typeof bridge.bridgeError === 'function' ? bridge.bridgeError() : bridge.lastError || null
      const owner = exec?.agent?.id ?? null
      const value = {
        connected: bridge.connected,
        backend: bridge.backend || 'desktop',
        headless: typeof bridge.headlessInfo === 'function' ? bridge.headlessInfo(owner) : null,
        provider: 'chrome-extension',
        bridgeError: bridgeError ? String(bridgeError.message || bridgeError) : null,
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
          if (Array.isArray(status?.alarms)) value.alarms = status.alarms
        } catch (error) {
          value.error = error?.message || String(error)
        }
      }
      return value
    },
  }

  const config = {
    name: 'chrome_config',
    description:
      'Read the provider config (~/.dsh/cache/dsh-chrome/config.json): allowEvaluate, confirmation timeouts and capture confirmation mode. Read-only; edit the file and reload the provider bundle to change it.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: outputSchema({
        path: { type: 'string' },
        config: { type: 'object', additionalProperties: true },
        error: {},
      }),
      render: (_args, value) => {
        const config = value.config || {}
        return renderText(
          [
            `provider config: ${value.path}`,
            `allowEvaluate: ${config.allowEvaluate === true}`,
            `evaluateConfirmTimeoutMs: ${config.evaluateConfirmTimeoutMs ?? 'default (120000)'}`,
            'captureConfirm: hard (fixed)',
            `captureConfirmTimeoutMs: ${config.captureConfirmTimeoutMs ?? 'default (120000)'}`,
            ...(value.error ? [`WARNING: ${value.error}`] : []),
          ].join('\n'),
        )
      },
    },
    async execute() {
      const { path: file, config, error } = readProviderConfig(dshHome())
      return { path: file, config, error }
    },
  }

  const policy = {
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
        invalid: { type: 'array', items: { type: 'object', additionalProperties: true } },
      }),
      render: (_args, value) => {
        const warning =
          Array.isArray(value.invalid) && value.invalid.length > 0
            ? `\nWARNING: ${value.invalid.length} invalid policy entr${value.invalid.length === 1 ? 'y' : 'ies'} (allowed: ${value.invalid[0]?.allowed?.join('|') || 'allow|ask|block'})`
            : ''
        return renderText(
          `Policy for ${value.origin || '(unknown origin)'}: ${value.mode || 'default (follow-dsh)'} [${value.source}]\npolicy file: ${value.policyPath}${warning}`,
        )
      },
    },
    async execute(args, exec) {
      const site = args?.origin
        ? { origin: originOf(args.origin) || String(args.origin), url: '', title: '', tabId: null }
        : await currentSite(exec, args?.tabId)
      const policy = loadPolicy(dshHome())
      const resolved = resolvePolicy(policy, site.origin)
      return {
        origin: resolved.origin,
        mode: resolved.mode,
        source: resolved.source,
        policyPath: policyPath(dshHome()),
        url: site.url || '',
        invalid: policy.invalid || [],
      }
    },
  }

  const audit = {
    name: 'chrome_audit',
    description:
      'Read the recent site-policy audit log (~/.dsh/cache/dsh-chrome/audit.jsonl): timestamp, session, tool, origin, action, decision and reason for every guarded browser write. Only entries written by this DSH session are returned by default; allSessions:true (hard confirmation) reveals entries from other sessions and legacy entries without a session field.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max entries returned (default 20, max 100).' },
        origin: { type: 'string', description: 'Only entries for this origin.' },
        allSessions: {
          type: 'boolean',
          description:
            'Read the machine-wide log, including other DSH sessions and legacy entries with no session field. Requires a hard confirmation; the cross-session read itself is audited.',
        },
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
    async execute(args, exec) {
      const limit = Number.isFinite(args?.limit) ? Math.max(1, Math.min(100, Number(args.limit))) : 20
      const origin = args?.origin ? originOf(args.origin) || String(args.origin) : null
      if (args?.allSessions === true) {
        if (typeof hardConfirmAsk !== 'function') {
          throw new BridgeError('APPROVAL_DENIED', 'hard confirmation is unavailable; refusing the cross-session audit read')
        }
        await hardConfirmAsk(exec, 'chrome_audit', {
          header: '读取全量审计日志（跨会话）',
          question:
            '允许读取本机完整的浏览器动作审计日志吗？其中包含其他 DSH 会话写入的条目，以及没有 session 字段的旧记录。默认只返回当前会话自己的条目。',
          detail: '日志位置：~/.dsh/cache/dsh-chrome/audit.jsonl；这次跨会话读取本身也会写入一条审计。',
          timeoutMs: evaluateConfirmTimeoutMs ?? undefined,
          site: null,
        })
        if (typeof writeAudit === 'function') {
          writeAudit(exec, 'chrome_audit', 'read all sessions', null, 'allowed', 'audit-all-sessions')
        }
        return { entries: readAudit(dshHome(), { limit, origin }) }
      }
      const owner = String(exec?.agent?.id ?? 'default')
      const short = typeof sessionShort === 'function' ? sessionShort(exec) : owner.slice(-8)
      return { entries: readAudit(dshHome(), { limit, origin, session: [short, owner] }) }
    },
  }

  return { status, config, policy, audit }
}
