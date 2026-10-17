/**
 * Model-facing chrome_* tools (P0: status / goto / snapshot / screenshot).
 * Each definition follows the Host ToolDefinition contract:
 * name, description, parameters, output.schema/render, execute.
 */
import fsp from 'node:fs/promises'

import { BridgeError } from './bridge.js'

function text(value) {
  return JSON.stringify(value, null, 2)
}

function renderText(summary) {
  return [{ type: 'text', text: summary }]
}

function outputSchema(properties) {
  return { type: 'object', properties, additionalProperties: true }
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

export function chromeTools({ bridge, attachments, assets }) {
  const list = []

  list.push({
    name: 'chrome_status',
    description:
      'Report the Chrome bridge state: whether the extension is connected, extension/host/protocol versions, the pinned extension id, and the exact install paths. Call this first when browser tools fail.',
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

  list.push({
    name: 'chrome_goto',
    description:
      'Open an http(s) URL in the current DSH session browser tab, creating a background tab if needed. This does not steal focus from the user. Returns the tab id, final URL, title, and load state.',
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
    async execute(args) {
      const url = validateHttpUrl(args?.url)
      try {
        return await bridge.call('tab.goto', { url }, 45000)
      } catch (error) {
        throw normalize(error)
      }
    },
  })

  list.push({
    name: 'chrome_snapshot',
    description:
      'Return a text snapshot of the current DSH session page: title, URL, a numbered list of visible interactive controls (use the numbers as refs for later actions), and visible page text. Password and payment-card values are masked. Prefer this over screenshots for reading page content.',
    parameters: {
      type: 'object',
      properties: {
        maxChars: {
          type: 'number',
          description: 'Maximum page-text characters to return (default 100000).',
        },
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
    async execute(args) {
      const maxChars = Number.isFinite(args?.maxChars) ? Math.max(1000, Math.min(200000, args.maxChars)) : 100000
      try {
        return await bridge.call('tab.snapshot', { maxChars }, 30000)
      } catch (error) {
        throw normalize(error)
      }
    },
  })

  list.push({
    name: 'chrome_screenshot',
    description:
      'Capture a PNG screenshot of the current DSH session page and return it as an image in this conversation. The screenshot is also saved on disk. Use when layout or visual state matters; use chrome_snapshot for text content.',
    parameters: {
      type: 'object',
      properties: {},
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
    async execute() {
      let shot
      try {
        shot = await bridge.call('tab.screenshot', {}, 60000)
      } catch (error) {
        throw normalize(error)
      }
      if (!shot?.path) throw new BridgeError('INTERNAL', 'native host did not return a screenshot path')
      let bytes = shot.bytes
      let image = null
      try {
        const data = await fsp.readFile(shot.path)
        bytes = data.byteLength
        const service = attachments()
        if (service) {
          image = await service.saveImage({
            data: new Uint8Array(data),
            mediaType: shot.mediaType || 'image/png',
            name: `chrome-screenshot-${Date.now()}.png`,
          })
        }
      } catch (error) {
        // Saving to DSH attachments is best-effort in P0; the file path still returns.
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

  return list
}

function normalize(error) {
  if (error instanceof BridgeError) return error
  const wrapped = new BridgeError('INTERNAL', error?.message || String(error))
  wrapped.cause = error
  return wrapped
}
