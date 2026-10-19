/**
 * Media tools: chrome_screenshot, chrome_download, chrome_pdf, chrome_shots and
 * chrome_frames. Extracted from tools.js (Q23) so screenshot capture, the
 * filesystem-backed screenshot history/ownership ledger, PDF export, frame
 * listing and download history live in one module.
 *
 * The attachment service is injected explicitly. Tool names, schemas, render
 * blocks, error codes and the shot-owner ledger behavior are unchanged.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'

import { BridgeError } from './bridge.js'
import { dshHome } from './policy.js'

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown size'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

// Screenshot history lives in two places: the desktop host writes to
// cache/dsh-chrome/screenshots, the headless driver to
// cache/dsh-chrome/headless/screenshots. chrome_shots reads both so the
// history is backend-independent.
function screenshotDirectories() {
  return [
    path.join(dshHome(), 'cache', 'dsh-chrome', 'screenshots'),
    path.join(dshHome(), 'cache', 'dsh-chrome', 'headless', 'screenshots'),
  ]
}

// Screenshot ownership ledger. The files are still written by the host /
// headless driver into shared directories, so the provider records which
// session asked for each shot and hides shots recorded for other sessions
// (R-06). Files with no recorded owner predate the ledger and stay visible.
function shotOwnersPath() {
  return path.join(dshHome(), 'cache', 'dsh-chrome', 'shot-owners.json')
}

async function readShotOwners() {
  try {
    const parsed = JSON.parse(await fsp.readFile(shotOwnersPath(), 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

async function recordShotOwner(file, owner) {
  if (!file || !owner) return
  try {
    const owners = await readShotOwners()
    owners[path.resolve(String(file))] = String(owner)
    const keys = Object.keys(owners)
    for (const key of keys.slice(0, Math.max(0, keys.length - 2000))) delete owners[key]
    await fsp.mkdir(path.dirname(shotOwnersPath()), { recursive: true })
    await fsp.writeFile(shotOwnersPath(), `${JSON.stringify(owners)}\n`, { mode: 0o600 })
  } catch {
    // The ledger is best effort; an unwritable cache must not lose the shot.
  }
}

function shotVisible(owners, file, owner) {
  const recorded = owners[path.resolve(String(file))]
  return !recorded || recorded === String(owner)
}

export function createMediaTools({
  call,
  ownerOf,
  attachments,
  outputSchema,
  renderText,
}) {
  const screenshot = {
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
      await recordShotOwner(shot.path, ownerOf(exec))
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
  }

  const pdf = {
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
      const cacheDir = path.join(dshHome(), 'cache', 'dsh-chrome', 'pdfs')
      const target = args?.path ? String(args.path) : path.join(cacheDir, `page-${Date.now()}.pdf`)
      // Desktop extension: the payload comes back inline and the tool writes it.
      if (value?.dataBase64) {
        await fsp.mkdir(path.dirname(target), { recursive: true })
        const bytes = Buffer.from(value.dataBase64, 'base64')
        await fsp.writeFile(target, bytes, { mode: 0o600 })
        return { path: target, bytes: bytes.length }
      }
      // Headless driver: Page.printToPDF already wrote the file and returns
      // { path, bytes }. Move it to the requested/default target so both
      // backends answer with one contract and no orphan copy is left behind in
      // the headless screenshot directory.
      const source = typeof value?.path === 'string' && value.path ? value.path : null
      if (source) {
        let stat = null
        try {
          stat = await fsp.stat(source)
        } catch {
          stat = null
        }
        if (stat?.isFile()) {
          if (path.resolve(source) === path.resolve(target)) return { path: target, bytes: stat.size }
          await fsp.mkdir(path.dirname(target), { recursive: true })
          await fsp.copyFile(source, target)
          await fsp.chmod(target, 0o600).catch(() => {})
          const copied = await fsp.stat(target)
          await fsp.rm(source, { force: true }).catch(() => {})
          return { path: target, bytes: copied.size }
        }
      }
      throw new BridgeError('INTERNAL', 'browser backend returned no pdf data')
    },
  }

  const shots = {
    name: 'chrome_shots',
    description:
      'List or read screenshot history saved by this provider (desktop ~/.dsh/cache/dsh-chrome/screenshots and headless ~/.dsh/cache/dsh-chrome/headless/screenshots). History is filesystem-backed, so it survives restarts. op="list" returns recent screenshots with size + PNG dimensions; op="read" returns one screenshot (path under either directory) as an image attachment. Shots recorded for another DSH session are hidden.',
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
        directories: { type: 'array', items: { type: 'string' } },
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
    async execute(args, exec) {
      const directories = screenshotDirectories()
      const directory = directories[0]
      const op = String(args?.op || 'list')
      const owner = ownerOf(exec)
      const shotOwners = op === 'list' || op === 'read' ? await readShotOwners() : {}
      if (op === 'list') {
        const limit = Number.isFinite(args?.limit) ? Math.max(1, Math.min(100, Number(args.limit))) : 20
        const entries = []
        const seen = new Set()
        for (const root of directories) {
          let names = []
          try {
            names = await fsp.readdir(root)
          } catch {
            continue
          }
          for (const name of names) {
            if (!/\.(png|jpe?g)$/i.test(name)) continue
            const file = path.join(root, name)
            if (seen.has(file)) continue
            seen.add(file)
            // Filter before stat/open so another session's file is never read.
            if (!shotVisible(shotOwners, file, owner)) continue
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
        }
        entries.sort((a, b) => b.mtimeMs - a.mtimeMs)
        return { directory, directories, entries: entries.slice(0, limit) }
      }
      if (op === 'read') {
        const target = path.resolve(String(args?.path || ''))
        const root = directories
          .map((candidate) => path.resolve(candidate))
          .find((candidate) => target.startsWith(`${candidate}${path.sep}`))
        if (!root) {
          throw new BridgeError('INVALID_ARGUMENT', 'path must be inside the screenshots directory')
        }
        if (!shotVisible(shotOwners, target, owner)) {
          throw new BridgeError('INVALID_ARGUMENT', 'screenshot belongs to another DSH session')
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
        return { directory: root, path: target, bytes: data.byteLength, width, height, image }
      }
      throw new BridgeError('INVALID_ARGUMENT', `unknown shots op: ${op}`)
    },
  }

  const frames = {
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
  }

  const download = {
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
  }

  return { screenshot, pdf, shots, frames, download }
}
