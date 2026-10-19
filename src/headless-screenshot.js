/**
 * Screenshot frame cache + viewer screencast materialization for
 * HeadlessDriver (Q26). The driver keeps facade methods and the dispatch
 * envelopes; this module owns the short-lived screenshot screencast, the
 * freshness marker / frame cache, the driver-side PNG and page-side JPEG
 * crops, and the throttled viewer-frame flush. Screenshot bytes, clip/ref
 * semantics, fallbacks and counters are unchanged.
 */
import fs from 'node:fs'
import path from 'node:path'

import { decodePngFrame, encodePngFrame, jpegFrameSize, pngFrameSize } from './headless-png.js'

// Screenshot frame streaming (see docs/HEADLESS.md §4.1.1): while a tab is
// being screenshotted repeatedly, keep a short-lived screencast running and
// serve `tab.screenshot` from the compositor's own frames. Chrome encodes a
// screencast PNG with the same encoder as Page.captureScreenshot (the bytes are
// identical for identical content), but the frame is produced off the request
// path, so a shot costs one compositor frame interval (~16ms) instead of a full
// capture (~44ms). JPEG requests use a JPEG screencast through the same cache:
// the frame is cheaper to encode, and capture would otherwise cost ~44ms.
// A driver-side change marker plus the frame timestamp guarantee the returned
// frame includes the latest tab action; when that cannot be established the
// call falls back to a capture (first frame missing) or to the latest painted
// frame (visible page that produced no repaint), so screenshots never silently
// return a picture older than the last action.
const SHOT_STREAM_ENABLED = process.env.DSH_HEADLESS_SHOT_STREAM !== '0'
const SHOT_STREAM_IDLE_MS = Math.max(250, Number(process.env.DSH_HEADLESS_SHOT_STREAM_IDLE_MS) || 2000)
export const SHOT_STREAM_FRAME_TIMEOUT_MS = Math.max(20, Number(process.env.DSH_HEADLESS_SHOT_STREAM_FRAME_TIMEOUT_MS) || 40)
const SHOT_STREAM_FIRST_FRAME_TIMEOUT_MS = Math.max(50, Number(process.env.DSH_HEADLESS_FIRST_FRAME_TIMEOUT_MS) || 1000)
// Keep the frame stream (and its cached frame) alive only across idle windows
// in which the page produced no frame at all: a blinking caret or any animation
// repaints within the window, and encoding those frames while nobody is
// screenshotting both burns CPU and slows the next CDP round trip, so those
// pages keep the old stop-after-idle behaviour.
const SHOT_STREAM_KEEPALIVE = process.env.DSH_HEADLESS_SHOT_STREAM_KEEPALIVE !== '0'
const SHOT_STREAM_FAILURES_BEFORE_BACKOFF = 2
const SHOT_STREAM_BACKOFF_MS = 5000
// JPEG `clip`/`ref` shots are cropped by the page's own decoder/encoder inside
// an isolated world, because the driver has no JPEG codec (docs/HEADLESS.md
// §4.1.9). The frame bytes are stored on that world's `window`, so cropping an
// unchanged frame again pays no transfer. A frame above this size is left to
// Page.captureScreenshot: a 2MB+ JPEG is a 4K-class fully-detailed page, where
// the data-URL round trip stops paying for itself.
// `DSH_HEADLESS_JPEG_CROP=0` restores the capture path.
const SHOT_JPEG_CROP_ENABLED = process.env.DSH_HEADLESS_JPEG_CROP !== '0'
const SHOT_JPEG_CROP_MAX_FRAME_BYTES = 2 * 1024 * 1024
const SHOT_JPEG_CROP_WORLD = 'dsh-shot-crop'

// Viewer screencast materialization (docs/HEADLESS.md §4.1.6): the live viewer
// polls `/live/frame` every 300ms, so decoding and rewriting latest.<ext> +
// meta.json for every screencast frame (up to 30/s) is wasted work. Keep only
// the newest frame and flush it at most once per interval; a trailing timer
// makes sure the last frame of a burst still lands, and `tab.screencast_stop`
// flushes synchronously so the final frame is never dropped.
const SCREENCAST_WRITE_INTERVAL_MS = 100

// Every request that can change what the page renders bumps the owning tab's
// change marker. `tab.screenshot` only reuses a streamed frame (or waits for a
// new one) whose composition timestamp is at least this marker.
export const SHOT_STREAM_METHODS = new Set([
  'tab.goto',
  'tab.click',
  'tab.clickAt',
  'tab.type',
  'tab.scroll',
  'tab.press',
  'tab.history',
  'tab.select',
  'tab.drag',
  'tab.hover',
  'tab.upload',
  'tab.evaluate',
  'tab.wait',
  'tab.storage',
  'tab.emulate',
])

export class HeadlessScreenshot {
  constructor(driver, { error }) {
    this.driver = driver
    this.error = error
  }

  // The headless window is fixed for the process lifetime, so innerWidth /
  // innerHeight only change through tab.emulate: cache them per tab instead of
  // paying a Runtime.evaluate on every screenshot.
  async viewportSize(tab) {
    if (!tab.viewport) {
      const meta = await this.driver.evalOn(tab, '({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })')
      tab.viewport = { w: meta?.w || 0, h: meta?.h || 0, dpr: meta?.dpr || 1 }
    }
    return tab.viewport
  }

  // Only the active headless target composites; background tabs report
  // visibilityState "hidden" and would never emit screencast frames.
  async pageVisible(tab) {
    try {
      return (await this.driver.evalOn(tab, `document.visibilityState === 'visible'`)) === true
    } catch {
      return false
    }
  }

  // Throttled viewer-frame materialization (§4.1.6). Runs at most once per
  // SCREENCAST_WRITE_INTERVAL_MS; if a flush just happened, arm one trailing
  // timer instead of dropping the frame so a page that changes once still ends
  // up on disk.
  scheduleScreencastFlush(tab) {
    const state = tab.screencast
    if (!state || state.flushTimer) return
    const waited = Date.now() - (state.lastWriteAt || 0)
    if (waited >= SCREENCAST_WRITE_INTERVAL_MS) {
      this.flushScreencastFrame(tab)
      return
    }
    state.flushTimer = setTimeout(() => {
      state.flushTimer = null
      this.flushScreencastFrame(tab)
    }, SCREENCAST_WRITE_INTERVAL_MS - waited)
    state.flushTimer.unref?.()
  }

  flushScreencastFrame(tab) {
    const state = tab.screencast
    const params = state?.pending
    if (!params) return
    state.pending = null
    state.lastWriteAt = Date.now()
    try {
      const data = Buffer.from(String(params.data || ''), 'base64')
      if (!state.dirReady) {
        fs.mkdirSync(this.driver.screencastDir, { recursive: true })
        state.dirReady = true
      }
      const file = path.join(this.driver.screencastDir, `latest.${state.format === 'png' ? 'png' : 'jpg'}`)
      const tmp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, data, { mode: 0o600 })
      fs.renameSync(tmp, file)
      fs.writeFileSync(
        path.join(this.driver.screencastDir, 'meta.json'),
        `${JSON.stringify({
          updatedAt: Date.now(),
          format: state.format === 'png' ? 'png' : 'jpg',
          bytes: data.byteLength,
          frames: state.frames,
          metadata: params.metadata || null,
          owner: state.owner ?? null,
          backend: 'headless',
        })}\n`,
        { mode: 0o600 },
      )
    } catch {
      // best effort
    }
  }

  // `Page.screencastFrame`: the live viewer materializes its own frames and
  // the screenshot stream keeps only the newest composited frame. Acking
  // stays in the driver, which owns the CDP session.
  handleFrame(tab, params) {
    const state = tab.screencast
    if (state) {
      state.frames += 1
      state.lastAt = Date.now()
      // Decode + atomic write happen on flush, not per frame (§4.1.6).
      state.pending = params
      this.scheduleScreencastFlush(tab)
      return
    }
    // Screenshot frame cache: keep only the newest composited frame. Its
    // metadata.timestamp is a Unix-epoch timestamp (same clock as Date.now),
    // which is what lets tab.screenshot prove the frame is not older than
    // the last page-changing request.
    const shot = tab.shotStream
    if (shot?.active) {
      const composedAt = Number(params.metadata?.timestamp)
      const data = String(params.data || '')
      if (Number.isFinite(composedAt) && data) {
        shot.frames += 1
        const buffer = Buffer.from(data, 'base64')
        // Chrome can emit a frame of the wrong geometry right after a
        // capture-with-clip (observed 600x300 and 1440x720 frames where the
        // stream was asked for 1440x813): that is the clip/old surface, not
        // the viewport. Such a frame cannot be mapped back to CSS px, so it
        // must not become the cached frame; it counts as "no frame" so the
        // clip path takes its capture fallback immediately instead of waiting
        // a repaint window for a frame it cannot use.
        const pixelSize = shot.format === 'jpeg' ? jpegFrameSize(buffer) : pngFrameSize(buffer)
        const usable =
          !pixelSize ||
          (Math.abs(pixelSize.width - shot.maxWidth) <= 2 && Math.abs(pixelSize.height - shot.maxHeight) <= 2)
        if (usable) {
          shot.last = {
            buffer,
            composedAt,
            width: Number(params.metadata?.deviceWidth) || 0,
            height: Number(params.metadata?.deviceHeight) || 0,
          }
          this.resolveShotWaiters(shot)
        }
      }
    }
  }

  shotStreamState(tab) {
    if (!tab.shotStream) {
      tab.shotStream = {
        active: false,
        frames: 0,
        served: 0,
        cropped: 0,
        jpegCropped: 0,
        fallbacks: 0,
        timeouts: 0,
        repaintMisses: 0,
        failures: 0,
        disabledUntil: 0,
        format: 'png',
        quality: 0,
        maxWidth: 0,
        maxHeight: 0,
        startedAt: 0,
        restarts: 0,
        framesAtIdleCheck: 0,
        last: null,
        waiters: [],
        stopTimer: null,
      }
    }
    return tab.shotStream
  }

  async ensureShotStream(tab, { format = 'png', quality = 0 } = {}) {
    if (!SHOT_STREAM_ENABLED) return null
    // The live viewer owns Page.startScreencast while it runs; screenshots fall
    // back to Page.captureScreenshot rather than fighting over the stream.
    if (tab.screencast?.active) return null
    const streamQuality = format === 'jpeg' ? quality : 0
    const state = this.shotStreamState(tab)
    const now = Date.now()
    if (state.disabledUntil > now) return null
    const viewport = await this.viewportSize(tab)
    const dpr = viewport.dpr || 1
    const maxWidth = Math.max(1, Math.round((viewport.w || 0) * dpr))
    const maxHeight = Math.max(1, Math.round((viewport.h || 0) * dpr))
    if (state.active) {
      if (
        state.maxWidth === maxWidth &&
        state.maxHeight === maxHeight &&
        state.format === format &&
        state.quality === streamQuality
      ) {
        return state
      }
      // A PNG frame cannot serve a JPEG request (or a different JPEG quality),
      // so switch the stream instead of returning the cached frame.
      await this.stopShotStream(tab)
    }
    // A hidden target (any non-active headless tab) is not composited, so its
    // screencast would never produce a frame. Keep the capture path there.
    if (!(await this.pageVisible(tab))) return null
    try {
      const params = { format, maxWidth, maxHeight, everyNthFrame: 1 }
      if (format === 'jpeg') params.quality = quality
      await this.driver.cdp.send('Page.startScreencast', params, tab.sessionId)
    } catch {
      state.failures += 1
      if (state.failures >= SHOT_STREAM_FAILURES_BEFORE_BACKOFF) state.disabledUntil = now + SHOT_STREAM_BACKOFF_MS
      return null
    }
    state.active = true
    state.frames = 0
    state.restarts += 1
    state.last = null
    state.format = format
    state.quality = streamQuality
    state.maxWidth = maxWidth
    state.maxHeight = maxHeight
    state.startedAt = now
    state.failures = 0
    // Even if the first screenshot falls back (no frame in time), the stream
    // must not stay on forever.
    this.touchShotStream(tab, state)
    return state
  }

  async stopShotStream(tab, { keepLast = false } = {}) {
    const state = tab?.shotStream
    if (!state) return
    this.dropShotStream(tab, { keepLast })
    if (!state.active) return
    state.active = false
    try {
      await this.driver.cdp?.send('Page.stopScreencast', {}, tab.sessionId)
    } catch {
      // tab already gone
    }
  }

  // Drop local stream state without talking to CDP (tab closing / browser
  // shutdown), resolving any in-flight screenshot waiters with null.
  dropShotStream(tab, { keepLast = false } = {}) {
    const state = tab?.shotStream
    if (!state) return
    if (state.stopTimer) {
      clearTimeout(state.stopTimer)
      state.stopTimer = null
    }
    for (const waiter of state.waiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.resolve(null)
    }
    if (!keepLast) state.last = null
  }

  touchShotStream(tab, state) {
    if (state.stopTimer) clearTimeout(state.stopTimer)
    state.framesAtIdleCheck = state.frames
    state.stopTimer = setTimeout(async () => {
      state.stopTimer = null
      if (!state.active) return
      // A screenshot is in flight: the frame it is waiting for is not an
      // "unattended" repaint, so keep the stream for it.
      if (state.waiters.length > 0) {
        this.touchShotStream(tab, state)
        return
      }
      // A visible page that produced no frame during the idle window is static:
      // keeping the stream (and its cached frame) alive turns the next screenshot
      // into a cache hit instead of a stream restart. Hidden tabs are not
      // composited, so their cached frame may predate page changes that happened
      // while hidden; drop it instead of serving it later.
      const idleFrames = state.frames - state.framesAtIdleCheck
      if (
        SHOT_STREAM_KEEPALIVE &&
        state.served > 0 &&
        idleFrames === 0 &&
        (await this.pageVisible(tab))
      ) {
        this.touchShotStream(tab, state)
        return
      }
      this.stopShotStream(tab).catch(() => {})
    }, SHOT_STREAM_IDLE_MS)
    state.stopTimer.unref?.()
  }

  resolveShotWaiters(state) {
    if (state.waiters.length === 0 || !state.last) return
    const frame = state.last
    const pending = []
    for (const waiter of state.waiters) {
      if (frame.composedAt >= waiter.changeAt) {
        clearTimeout(waiter.timer)
        waiter.resolve(frame)
      } else {
        pending.push(waiter)
      }
    }
    state.waiters = pending
  }

  waitShotFrame(state, changeAt, timeoutMs) {
    if (state.last && state.last.composedAt >= changeAt) return Promise.resolve(state.last)
    return new Promise((resolve) => {
      const waiter = { changeAt, timer: null, resolve: null }
      waiter.timer = setTimeout(() => {
        state.waiters = state.waiters.filter((item) => item !== waiter)
        resolve(null)
      }, timeoutMs)
      waiter.resolve = (frame) => resolve(frame)
      state.waiters.push(waiter)
    })
  }

  // `clip` is CSS px (same contract as the desktop backend); `ref` resolves to
  // the element's viewport box, which is exactly the box the extension captures.
  // `fullPage` overrides both, so it never reaches here.
  async resolveScreenshotClip(tab, params) {
    const raw = params?.clip
    if (raw && typeof raw === 'object') {
      const x = Number(raw.x)
      const y = Number(raw.y)
      const width = Number(raw.width)
      const height = Number(raw.height)
      if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
        throw this.error('INVALID_ARGUMENT', 'clip must be {x,y,width,height} with positive width/height')
      }
      return { x, y, width, height }
    }
    if (params?.ref != null) {
      const ref = Number(params.ref)
      const box = await this.driver.evalOn(
        tab,
        `(() => { const el = document.querySelector('[data-dsh-ref="${Number.isFinite(ref) ? ref : -1}"]'); if (!el) return null; const rect = el.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height } })()`,
      ).catch(() => null)
      if (!box || !(Number(box.width) > 0) || !(Number(box.height) > 0)) {
        throw this.error('REF_STALE', `ref ${params.ref} has no visible box; take a new snapshot`)
      }
      return { x: Number(box.x), y: Number(box.y), width: Number(box.width), height: Number(box.height) }
    }
    return null
  }

  // Crop a CSS-px region out of a device-pixel frame, re-encoding it as PNG.
  // Returns null when the region is fully outside the frame or the frame is not
  // a decodable 8-bit RGB/RGBA PNG — the caller then falls back to capture.
  // Only the top-left prefix that contains the crop is decoded (see
  // `unfilterPngRows` in headless-png.js) and the result is kept on the frame
  // object, so repeated shots of an unchanged page skip both the decode and the
  // frame wait.
  async cropScreenshotFrame(tab, frame, clip) {
    const size = frame.pngSize || (frame.pngSize = pngFrameSize(frame.buffer))
    if (!size) return null
    const viewport = await this.viewportSize(tab)
    const scale = size.width / (viewport.w || size.width)
    const requestedX = Math.round(clip.x * scale)
    const requestedY = Math.round(clip.y * scale)
    const requestedWidth = Math.max(1, Math.round(clip.width * scale))
    const requestedHeight = Math.max(1, Math.round(clip.height * scale))
    if (
      requestedX >= size.width ||
      requestedY >= size.height ||
      requestedX + requestedWidth <= 0 ||
      requestedY + requestedHeight <= 0
    ) {
      return null
    }
    const x = Math.max(0, requestedX)
    const y = Math.max(0, requestedY)
    const width = Math.min(size.width - x, requestedWidth - (x - requestedX))
    const height = Math.min(size.height - y, requestedHeight - (y - requestedY))
    if (width < 1 || height < 1) return null
    const neededColumns = x + width
    const neededRows = y + height
    let decoded = frame.decoded
    if (
      !decoded ||
      decoded.width !== size.width ||
      decoded.height !== size.height ||
      decoded.decodedWidth < neededColumns ||
      decoded.decodedHeight < neededRows
    ) {
      decoded = decodePngFrame(frame.buffer, { maxColumns: neededColumns, maxRows: neededRows })
      if (!decoded) return null
      frame.decoded = decoded
    }
    const { channels, pixels } = decoded
    const stride = decoded.decodedWidth * channels
    const cropped = Buffer.allocUnsafe(width * height * channels)
    for (let row = 0; row < height; row += 1) {
      pixels.copy(
        cropped,
        row * width * channels,
        (y + row) * stride + x * channels,
        (y + row) * stride + (x + width) * channels,
      )
    }
    return encodePngFrame(width, height, channels, cropped)
  }

  // The same region crop for JPEG frames, which the driver cannot decode
  // itself. The page has a JPEG codec (the one that decoded the <img> the user
  // is looking at), so the crop is done there with `createImageBitmap` +
  // `canvas.toDataURL('image/jpeg', q)`, and the frame is passed in as a
  // `data:` URL. Two properties make that safe and cheap:
  //
  // - The code runs in a **dedicated isolated world** (`Page.createIsolatedWorld`).
  //   Page scripts have their own globals and DOM prototypes there, so a page
  //   cannot patch `createImageBitmap`/`toDataURL` to break the crop or to forge
  //   pixels for its own screenshot. Anything that fails (context destroyed by a
  //   navigation, no canvas support, encode error, malformed output) returns
  //   null and the caller falls back to a full-viewport capture + crop and then
  //   to Page.captureScreenshot with the clip.
  // - The frame bytes are cached on the isolated world's `window` under a token
  //   derived from the frame (composition timestamp + encoded size). Re-cropping
  //   an unchanged frame therefore skips the transfer; only a new frame pays it.
  //
  // Cost is content-dependent: a light text page crops in ~5ms, a fully-detailed
  // frame pays a full decode (~10ms) + crop encode (~10ms), still ~half of the
  // ~50ms capture. Frames above SHOT_JPEG_CROP_MAX_FRAME_BYTES keep capture.
  async shotCropContext(tab) {
    if (tab.shotCropWorld != null) return tab.shotCropWorld
    // A new world has no cached frame, so the next crop embeds the bytes again.
    tab.shotCropFrameToken = null
    try {
      const tree = await this.driver.cdp.send('Page.getFrameTree', {}, tab.sessionId)
      const frameId = tree?.frameTree?.frame?.id
      if (!frameId) return null
      const world = await this.driver.cdp.send(
        'Page.createIsolatedWorld',
        { frameId, worldName: SHOT_JPEG_CROP_WORLD },
        tab.sessionId,
      )
      const contextId = world?.executionContextId
      tab.shotCropWorld = Number.isFinite(contextId) ? contextId : null
      return tab.shotCropWorld
    } catch {
      tab.shotCropWorld = null
      return null
    }
  }

  async cropJpegScreenshotFrame(tab, frame, clip, quality) {
    if (!frame?.buffer) return null
    if (!frame.jpegSize) frame.jpegSize = jpegFrameSize(frame.buffer)
    return this.cropJpegBuffer(tab, frame.buffer, frame.jpegSize, clip, quality, `${frame.composedAt}:${frame.buffer.length}`)
  }

  // A JPEG+clip shot whose frame-stream crop could not be used is served by
  // capturing the **whole viewport** and cropping that, never by capturing with
  // a clip while the stream runs: a clip capture makes Chrome's screencast emit
  // frames sized to the clip for this tab, which poisons every later crop
  // (measured; see docs/HEADLESS.md §4.1.9). The full capture also repaints the
  // full surface, so the next stream crop has a usable frame again.
  async captureFullJpegClip(tab, clip, quality) {
    if (!SHOT_JPEG_CROP_ENABLED) return null
    try {
      const shot = await this.driver.cdp.send(
        'Page.captureScreenshot',
        { format: 'jpeg', quality, captureBeyondViewport: false },
        tab.sessionId,
      )
      if (!shot?.data) return null
      const buffer = Buffer.from(shot.data, 'base64')
      return await this.cropJpegBuffer(tab, buffer, jpegFrameSize(buffer), clip, quality, `capture:${Date.now()}`)
    } catch {
      return null
    }
  }

  // The exact clipped capture. Cheap (Chrome encodes only the region) and used
  // for a cold JPEG region shot *before* any screencast exists for the tab;
  // afterwards the stream is warmed for the shots that follow. The caller must
  // not use this while the stream is running — see captureFullJpegClip.
  async captureClippedJpeg(tab, clip, quality) {
    try {
      const shot = await this.driver.cdp.send(
        'Page.captureScreenshot',
        { format: 'jpeg', quality, captureBeyondViewport: false, clip: { ...clip, scale: 1 } },
        tab.sessionId,
      )
      if (!shot?.data) return null
      return Buffer.from(shot.data, 'base64')
    } catch {
      return null
    }
  }

  async cropJpegBuffer(tab, buffer, size, clip, quality, token) {
    if (!SHOT_JPEG_CROP_ENABLED) return null
    if (!buffer || !size) return null
    if (buffer.length > SHOT_JPEG_CROP_MAX_FRAME_BYTES) return null
    const viewport = await this.viewportSize(tab)
    // Chrome can emit frames of the wrong geometry right after a capture with a
    // clip (observed 1440x720 and 600x300 where the stream was asked for
    // 1440x813). Cropping one of those would silently return the right region
    // at the wrong resolution, so anything that does not match the current
    // device size keeps the capture path instead. The +-2px tolerance covers
    // encoder rounding.
    const expectedWidth = Math.max(1, Math.round((viewport.w || size.width) * (viewport.dpr || 1)))
    const expectedHeight = Math.max(1, Math.round((viewport.h || size.height) * (viewport.dpr || 1)))
    if (Math.abs(size.width - expectedWidth) > 2 || Math.abs(size.height - expectedHeight) > 2) return null
    const scale = size.width / (viewport.w || size.width)
    const requestedX = Math.round(clip.x * scale)
    const requestedY = Math.round(clip.y * scale)
    const requestedWidth = Math.max(1, Math.round(clip.width * scale))
    const requestedHeight = Math.max(1, Math.round(clip.height * scale))
    if (
      requestedX >= size.width ||
      requestedY >= size.height ||
      requestedX + requestedWidth <= 0 ||
      requestedY + requestedHeight <= 0
    ) {
      return null
    }
    const x = Math.max(0, requestedX)
    const y = Math.max(0, requestedY)
    const width = Math.min(size.width - x, requestedWidth - (x - requestedX))
    const height = Math.min(size.height - y, requestedHeight - (y - requestedY))
    if (width < 1 || height < 1) return null
    const encodeQuality = Math.max(0.1, Math.min(1, quality / 100))
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const contextId = await this.shotCropContext(tab)
      if (contextId == null) return null
      const reuse = tab.shotCropFrameToken === token
      const expression = `(async () => {
  ${reuse ? '' : `window.__dshShotFrame = ${JSON.stringify(buffer.toString('base64'))}`}
  const image = await createImageBitmap(await (await fetch('data:image/jpeg;base64,' + window.__dshShotFrame)).blob())
  const canvas = document.createElement('canvas')
  canvas.width = ${width}
  canvas.height = ${height}
  canvas.getContext('2d').drawImage(image, ${x}, ${y}, ${width}, ${height}, 0, 0, ${width}, ${height})
  image.close()
  const url = canvas.toDataURL('image/jpeg', ${encodeQuality})
  return url.slice(url.indexOf(',') + 1)
})()`
      let value
      try {
        const result = await this.driver.cdp.send(
          'Runtime.evaluate',
          { expression, contextId, returnByValue: true, awaitPromise: true },
          tab.sessionId,
        )
        if (result.exceptionDetails) {
          throw new Error(result.exceptionDetails.exception?.description || 'jpeg crop failed')
        }
        value = result.result?.value
      } catch {
        // The isolated world dies with its document (navigation). Drop it and
        // retry once with a fresh world; the retry re-embeds the frame.
        tab.shotCropWorld = null
        tab.shotCropFrameToken = null
        continue
      }
      if (typeof value !== 'string' || value.length < 32) return null
      const bytes = Buffer.from(value, 'base64')
      if (
        bytes.length < 128 ||
        bytes[0] !== 0xff ||
        bytes[1] !== 0xd8 ||
        bytes[2] !== 0xff ||
        bytes[bytes.length - 2] !== 0xff ||
        bytes[bytes.length - 1] !== 0xd9
      ) {
        // Do not trust the world's frame cache after a malformed result.
        tab.shotCropFrameToken = null
        return null
      }
      tab.shotCropFrameToken = token
      return bytes
    }
    return null
  }

  // A change marker is a *promise* that a paint is owed: `tab.screenshot` waits
  // up to SHOT_STREAM_FRAME_TIMEOUT_MS for a frame composed at or after it.
  // Two independent pieces of evidence can retire that promise once the marker
  // is already older than the wait the driver grants: (a) the wait expired with
  // no frame (see screenshotFromStream), and (b) a probe proved the following
  // action paint-free. Without retirement the marker stays in the future
  // forever, so *every* later screenshot re-pays the full window for a paint
  // that is already known not to come — one conservative no-op could poison
  // all screenshot latency that follows it. Lowering the marker to the newest
  // painted frame is safe for a late paint: a frame that composes afterwards
  // still updates `state.last` and is served by the freshness check, so only
  // the repeated wait is dropped, never a frame that has arrived.
  retireRenderChange(tab) {
    const last = tab.shotStream?.last
    const marker = tab.renderChangeAt || 0
    if (!last || !Number.isFinite(last.composedAt)) return false
    if (last.composedAt >= marker) return false
    tab.renderChangeAt = last.composedAt
    tab.renderChangeRetires = (tab.renderChangeRetires || 0) + 1
    return true
  }

  // Returns a PNG buffer for the current viewport (or for the requested `clip`
  // region), or null when no frame is available at all (caller falls back to
  // Page.captureScreenshot).
  //
  // Freshness rule: a cached frame is only reused when its composition
  // timestamp is at or after the last page-changing request. Otherwise wait for
  // the compositor's next frame. If that frame does not arrive within
  // SHOT_STREAM_FRAME_TIMEOUT_MS the change was not painted (yet), so the
  // latest painted frame is returned — that is still what the page looks like,
  // and a capture would force a repaint just to show the same pixels. The wait
  // is longer for the very first frame of a new stream (Chrome has to start the
  // capture pipeline), where there is no cached frame to fall back on. A miss
  // also retires the marker (see retireRenderChange): the window was granted
  // once for that change, so screenshots issued later must not grant it again.
  //
  // JPEG + clip is the one case that does not wait for a first frame: nothing
  // is cached yet on a just-started stream, and taking the capture right away
  // (see captureJpegClip, ~full-viewport capture + crop) is cheaper than the
  // up-to-150ms first-frame wait. The stream keeps warming in the background,
  // so the next clip shot within the idle window is a crop.
  async screenshotFromStream(tab, options = {}) {
    const state = await this.ensureShotStream(tab, options)
    if (!state) return null
    if (options.clip && options.format === 'jpeg' && !state.last) return null
    const changeAt = tab.renderChangeAt || 0
    let repaintMiss = false
    let frame = state.last && state.last.composedAt >= changeAt ? state.last : null
    if (frame && Date.now() / 1000 - frame.composedAt > 1) {
      // A stale-but-fresh-enough frame from a tab that was backgrounded since
      // may hide page-internal changes (hidden tabs are not composited).
      if (!(await this.pageVisible(tab))) return null
    }
    if (!frame) {
      const hasCached = Boolean(state.last)
      frame = await this.waitShotFrame(
        state,
        changeAt,
        hasCached ? SHOT_STREAM_FRAME_TIMEOUT_MS : SHOT_STREAM_FIRST_FRAME_TIMEOUT_MS,
      )
      if (!frame && hasCached) {
        // No new frame within the repaint window. On a visible page that means
        // the change produced no painted output (e.g. a read-only evaluate), so
        // the latest painted frame is the honest screenshot. On a hidden tab
        // nothing is being composited at all — fall back to capture.
        if (!(await this.pageVisible(tab))) return null
        state.repaintMisses += 1
        repaintMiss = true
        frame = state.last
        // The window has been paid for this marker and it produced no frame:
        // retire it, otherwise this same wait is re-paid by every screenshot
        // that follows (measured: one conservative no-op made all later shots
        // cost ~43ms instead of ~1ms, docs/HEADLESS.md §4.1.14).
        this.retireRenderChange(tab)
      }
    }
    if (!frame) {
      state.timeouts += 1
      state.fallbacks += 1
      if (state.timeouts >= SHOT_STREAM_FAILURES_BEFORE_BACKOFF) {
        await this.stopShotStream(tab)
        state.disabledUntil = Date.now() + SHOT_STREAM_BACKOFF_MS
      }
      return null
    }
    state.timeouts = 0
    state.served += 1
    this.touchShotStream(tab, state)
    if (!options.clip) return frame.buffer
    if (options.format === 'jpeg') {
      // A repaint-miss frame is the *previous* paint: honest for a page that
      // provably did not repaint, but the JPEG crop path cannot tell the two
      // apart from its own side, so it keeps the capture for that case instead
      // of possibly returning pre-action pixels. (The PNG path has always used
      // the miss frame; its bytes are lossless and driver-side, so a stale
      // frame there is a freshness question, not a resolution one.)
      if (repaintMiss) {
        state.fallbacks += 1
        return null
      }
      const jpegCropped = await this.cropJpegScreenshotFrame(tab, frame, options.clip, options.quality)
      if (jpegCropped) {
        state.cropped += 1
        state.jpegCropped += 1
        return jpegCropped
      }
      state.fallbacks += 1
      return null
    }
    const cropped = await this.cropScreenshotFrame(tab, frame, options.clip)
    if (!cropped) {
      state.fallbacks += 1
      return null
    }
    state.cropped += 1
    return cropped
  }
}
