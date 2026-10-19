/**
 * Screencast/overlay tools: chrome_screencast, chrome_pointer, chrome_annotate
 * and chrome_emulate. Extracted from tools.js (Q20) so the provider-side
 * stream state (ownership ledger + viewer guard, R-06) and overlay/CDP
 * emulation calls live in one module. Screenshot, cursor and annotation
 * behavior is unchanged.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'

import { BridgeError } from './bridge.js'
import { getLiveViewInfo, getLiveViewOpenInfo, getViewerActivity } from './liveview.js'
import { dshHome } from './policy.js'
import { createScreencastGuard } from './screencast-guard.js'

export function createScreencastTools({
  bridge,
  call,
  guard,
  supports,
  ownerOf,
  attachments,
  outputSchema,
  renderText,
}) {
  const screencastGuards = new Map()
  // Session -> { tabId, startedAt } for screencasts this provider started.
  // Frame files are still shared per DSH_HOME, so status must not hand the
  // global latest.jpg to a session that never started a stream (R-06).
  const screencastOwners = new Map()

  function screencastLatestPath() {
    return path.join(dshHome(), 'cache', 'dsh-chrome', 'screencast', 'latest.jpg')
  }

  const screencast = {
    name: 'chrome_screencast',
    mutating: false,
    // Stateful provider-side stream, but it does not mutate page/tab state and
    // therefore does not take a write lease.
    stateful: true,
    description:
      'Continuous page view prototype: op="start" begins CDP Page.startScreencast (JPEG frames every Nth frame), the native host writes the latest frame to ~/.dsh/cache/dsh-chrome/screencast/latest.jpg, op="status" returns it as an image (only for the session that started an active stream), op="stop" ends the stream; op="viewer" writes the loopback live-view URL to a local handoff file and returns its path plus an opaque handle (the bearer URL is never returned); op="diag" returns the last extension diagnostics. Frames are not sent to the model unless status is called.',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['start', 'stop', 'status', 'diag', 'viewer'] },
        format: { type: 'string', enum: ['jpeg', 'png'], description: 'start: frame format (default jpeg).' },
        quality: { type: 'number', description: 'start: JPEG quality 1-100 (default 60).' },
        everyNthFrame: { type: 'number', description: 'start: deliver every Nth frame, 1-10 (default 2).' },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
      },
      required: ['op'],
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        active: { type: 'boolean' },
        tabId: {},
        format: { type: 'string' },
        frames: {},
        startedAt: { type: 'string' },
        lastAt: {},
        updatedAt: {},
        bytes: {},
        path: { type: 'string' },
        metaPath: { type: 'string' },
        frameOwner: {},
        image: {},
        handle: { type: 'string' },
        urlFile: { type: 'string' },
        hint: { type: 'string' },
        enabled: { type: 'boolean' },
      }),
      render: (args, value) => {
        if (args?.op === 'diag') {
          const entries = Array.isArray(value?.entries) ? value.entries : []
          return renderText(JSON.stringify(entries.slice(-12), null, 1))
        }
        if (args?.op === 'viewer') {
          return renderText(value.hint || (value.enabled ? 'Live viewer is running.' : 'Live viewer is disabled (Host webServer is unavailable).'))
        }
        const blocks = []
        if (value.image) blocks.push({ type: 'image', attachment: value.image })
        if (value.active) {
          const visibility = [
            value.visible != null ? `visible=${value.visible}` : null,
            value.tabActive != null ? `tabActive=${value.tabActive}` : null,
            value.frameAgeMs != null ? `frameAge=${value.frameAgeMs}ms` : null,
          ]
            .filter(Boolean)
            .join(' ')
          blocks.push({
            type: 'text',
            text: `Screencast active (${value.format || 'jpeg'}), frames=${value.frames ?? '—'}${visibility ? `, ${visibility}` : ''}${value.path ? `\nlatest frame: ${value.path}` : '\nwaiting for the first frame…'}${value.hint ? `\n${value.hint}` : ''}`,
          })
        } else {
          blocks.push({
            type: 'text',
            text: value.frames != null
              ? `Screencast stopped; frames=${value.frames}${value.elapsedMs != null ? ` in ${value.elapsedMs}ms` : ''}`
              : 'Screencast inactive',
          })
        }
        return blocks
      },
    },
    async execute(args, exec) {
      if (!supports('screencast')) {
        throw new BridgeError(
          'UNSUPPORTED_BACKEND',
          'chrome_screencast needs a backend that declares the screencast capability. Use backend:"desktop" for the live viewer, or use chrome_screenshot for a still image.',
        )
      }
      const op = String(args?.op || 'status')
      const owner = ownerOf(exec)
      if (op === 'start') {
        const started = await call(
          'tab.screencast_start',
          {
            format: args?.format,
            quality: args?.quality,
            everyNthFrame: args?.everyNthFrame,
            tabId: args?.tabId,
            owner,
          },
          30000,
        )
        const mode = bridge.backend || 'desktop'
        const previous = screencastGuards.get(owner)
        if (previous) previous.disarm()
        if (getLiveViewInfo().enabled) {
          const guard = createScreencastGuard({
            lastViewerAt: () => getViewerActivity().lastFrameAt,
            stop: () => {
              const stopCall = () => bridge.call('tab.screencast_stop', { owner }, 15000)
              return typeof bridge.runWithBackend === 'function' ? bridge.runWithBackend(mode, stopCall) : stopCall()
            },
          })
          guard.arm()
          screencastGuards.set(owner, guard)
        }
        screencastOwners.set(owner, { tabId: started?.tabId ?? args?.tabId ?? null, startedAt: Date.now() })
        return { ...started, path: screencastLatestPath() }
      }
      if (op === 'stop') {
        const guard = screencastGuards.get(owner)
        if (guard) {
          guard.disarm()
          screencastGuards.delete(owner)
        }
        screencastOwners.delete(owner)
        return call('tab.screencast_stop', { owner }, 30000)
      }
      if (op === 'diag') {
        return call('tab.debug_diag', { owner }, 15000)
      }
      if (op === 'viewer') {
        // The live URL carries the bearer token; return only the local handoff.
        return getLiveViewOpenInfo()
      }
      if (op === 'status') {
        const status = await call('tab.screencast_status', { owner }, 15000)
        const directory = path.join(dshHome(), 'cache', 'dsh-chrome', 'screencast')
        const metaPath = path.join(directory, 'meta.json')
        let meta = null
        try {
          meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'))
        } catch {
          meta = null
        }
        if (status?.active !== true) screencastOwners.delete(owner)
        const metaOwner = typeof meta?.owner === 'string' && meta.owner ? meta.owner : null
        // Only the session that started an active stream may read the shared
        // frame file, and only while that frame is not attributed to another
        // session (older metadata has no owner; the active/owner check still
        // blocks the "B reads A's frame without any stream" case).
        const canReadFrame =
          status?.active === true && screencastOwners.has(owner) && (metaOwner == null || metaOwner === owner)
        let image = null
        let bytes = null
        const file = screencastLatestPath()
        if (canReadFrame) {
          try {
            const data = await fsp.readFile(file)
            bytes = data.byteLength
            const service = attachments?.()
            if (service) {
              image = await service.saveImage({
                data: new Uint8Array(data),
                mediaType: /\.png$/.test(file) ? 'image/png' : 'image/jpeg',
                name: path.basename(file),
              })
            }
          } catch {
            image = null
          }
        }
        return {
          ...status,
          updatedAt: meta?.updatedAt ? new Date(meta.updatedAt).toISOString() : null,
          bytes,
          path: file,
          metaPath,
          frameOwner: metaOwner,
          image,
        }
      }
      throw new BridgeError('INVALID_ARGUMENT', `unknown screencast op: ${op}`)
    },
  }

  const pointer = {
    name: 'chrome_pointer',
    mutating: true,
    description:
      'Show a persistent virtual pointer pinned to an element (ref/selector) or viewport coordinates, with an optional label; op="show"/"move" pins it, op="hide" hides it, op="auto" enables/disables automatic following of click/type/hover actions, pulse:true plays a click ripple. The pointer is an overlay (pointer-events:none) and appears in screenshots but not in page text snapshots.',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['show', 'move', 'hide', 'auto'] },
        ref: { type: 'number', description: 'Pin to the element with this snapshot ref.' },
        selector: { type: 'string', description: 'Pin to this CSS selector instead of ref.' },
        x: { type: 'number', description: 'Viewport x (CSS px) when not using ref/selector.' },
        y: { type: 'number', description: 'Viewport y (CSS px) when not using ref/selector.' },
        label: { type: 'string', description: 'Label next to the pointer (default "DSH"; empty hides it).' },
        pulse: { type: 'boolean', description: 'Play a click ripple after moving.' },
        enabled: { type: 'boolean', description: 'op=auto: enable/disable automatic follow (default true).' },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
        frame: { type: 'boolean', description: 'Search all frames/iframes for the target (annotation inside an iframe).' },
      },
      required: ['op'],
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({ ok: { type: 'boolean' }, visible: { type: 'boolean' }, x: { type: 'number' }, y: { type: 'number' }, label: { type: 'string' }, error: { type: 'string' } }),
      render: (_args, value) => {
        if (value?.auto != null) return renderText(`Pointer auto-follow: ${value.auto ? 'on' : 'off'}`)
        return value?.visible
          ? renderText(`Pointer at (${Math.round(value.x)}, ${Math.round(value.y)}) label=${JSON.stringify(value.label || '')}`)
          : renderText(value?.error ? `Pointer error: ${value.error}` : 'Pointer hidden')
      },
    },
    async execute(args, exec) {
      const op = String(args?.op || 'show')
      return call('tab.overlay', {
        op: op === 'hide' ? 'hide-pointer' : op === 'auto' ? 'auto' : 'pointer',
        enabled: args?.enabled,
        ref: args?.ref,
        selector: args?.selector,
        x: args?.x,
        y: args?.y,
        label: args?.label,
        pulse: Boolean(args?.pulse),
        tabId: args?.tabId,
        frame: Boolean(args?.frame),
        owner: ownerOf(exec),
      })
    },
  }

  const annotate = {
    name: 'chrome_annotate',
    mutating: true,
    description:
      'Draw annotations over the current page: highlight text (text/ref/selector), box/circle an element, draw an arrow from one target to another, or add a text label/index bubble; op="list" returns current annotations, op="clear" removes them (all, or one by id), op="export" returns the JSON/report and op="restore" reloads the persisted set. Annotations auto-persist per tab URL in sessionStorage and survive reloads. Overlays appear in screenshots and are excluded from page text snapshots.',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['highlight', 'box', 'circle', 'arrow', 'label', 'list', 'clear', 'export', 'restore'] },
        ref: { type: 'number', description: 'Target element ref (highlight/box/circle/arrow/label).' },
        selector: { type: 'string', description: 'Target CSS selector instead of ref.' },
        text: { type: 'string', description: 'Text to find/highlight when no ref/selector is given.' },
        fromRef: { type: 'number', description: 'Arrow start ref.' },
        fromSelector: { type: 'string', description: 'Arrow start selector.' },
        color: { type: 'string', description: 'CSS color (default cycles DSH palette).' },
        label: { type: 'string', description: 'Text label/bubble content.' },
        id: { type: 'string', description: 'clear: remove this annotation id only.' },
        index: { type: 'number', description: 'label: numeric badge shown in the bubble.' },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
        frame: { type: 'boolean', description: 'Search all frames/iframes for the target (annotate inside an iframe); returns frameId/frameUrl.' },
      },
      required: ['op'],
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        ok: { type: 'boolean' },
        id: { type: 'string' },
        kind: { type: 'string' },
        count: { type: 'number' },
        cleared: {},
        annotations: { type: 'array', items: { type: 'object', additionalProperties: true } },
        url: { type: 'string' },
        json: { type: 'string' },
        frameId: { type: 'string' },
        frameUrl: { type: 'string' },
        rect: { type: 'object', additionalProperties: true },
        error: { type: 'string' },
      }),
      render: (_args, value) => {
        if (!value?.ok) return renderText(`Annotate error: ${value?.error || 'unknown'}`)
        if (Array.isArray(value.annotations)) {
          const lines = value.annotations.map((a) => `${a.id} ${a.kind} ${a.label || ''}`)
          return renderText(`Annotations (${value.count ?? lines.length}):
${lines.length ? lines.join('\n') : '(none)'}`)
        }
        if (value.cleared) return renderText(`Cleared ${value.cleared === true ? 'all annotations' : `annotation ${value.cleared}`}`)
        return renderText(`Added ${value.kind || 'annotation'} ${value.id || ''} (${value.count ?? '?'} total)`)
      },
    },
    async execute(args, exec) {
      return call('tab.overlay', {
        op: String(args?.op || 'list'),
        ref: args?.ref,
        selector: args?.selector,
        text: args?.text,
        from: args?.fromRef != null ? { ref: args.fromRef } : args?.fromSelector ? { selector: args.fromSelector } : undefined,
        color: args?.color,
        label: args?.label,
        id: args?.id,
        index: args?.index,
        tabId: args?.tabId,
        frame: Boolean(args?.frame),
        owner: ownerOf(exec),
      })
    },
  }

  const emulate = {
    name: 'chrome_emulate',
    mutating: true,
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
      await guard(exec, 'chrome_emulate', reset ? 'reset viewport' : `emulate ${args?.width}x${args?.height}`, { tabId: args?.tabId })
      return call(
        'tab.emulate',
        { width: args?.width, height: args?.height, mobile: Boolean(args?.mobile), reset, tabId: args?.tabId, owner: ownerOf(exec) },
        30000,
      )
    },
  }

  return { screencast, pointer, annotate, emulate }
}
