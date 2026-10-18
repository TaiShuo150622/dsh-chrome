import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

import { HeadlessDriver, headlessSupported, headlessChromeExecutable } from '../src/headless.js'

if (!headlessSupported()) {
  console.log(`HEADLESS TEST: SKIP (no Chrome/Chromium found; set DSH_HEADLESS_CHROME)`)
  process.exit(0)
}

// JPEG SOF pixel size, parsed independently of the driver's helper so the tests
// check the bytes that were actually written rather than the reported numbers.
function jpegSofSize(buffer) {
  let offset = 2
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) return null
    const marker = buffer[offset + 1]
    if (marker === 0xff) {
      offset += 1
      continue
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    if (marker === 0xd8 || marker === 0xd9 || marker === 0xda) return null
    const length = buffer.readUInt16BE(offset + 2)
    if (length < 2 || offset + 2 + length > buffer.length) return null
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) }
    }
    offset += 2 + length
  }
  return null
}

const page = `<!doctype html><html><head><title>Headless Test</title></head><body>
<h1>Headless Test</h1>
<label>Name <input id="name" placeholder="name"></label>
<button id="go" onclick="document.getElementById('out').textContent = 'hello ' + document.getElementById('name').value">Go</button>
<div id="out">(empty)</div>
<input id="file" type="file">
<select id="choice"><option value="one">One</option><option value="two">Two</option></select>
<input id="check" type="checkbox">
<div id="drag-src" role="button" tabindex="0" draggable="true">drag-src</div>
<div id="drop-target" role="button" tabindex="0">drop-target</div>
<a id="download" href="/download" download="headless-report.txt">download</a>
<div id="noop" style="padding:6px;border:1px solid #999;width:120px">noop</div>
<form onsubmit="return false"><button id="form-submit" type="submit">form submit</button></form>
<script>
  console.log('headless-log-1', 42)
  fetch('/data/resource.json').catch(() => {})
</script>
</body></html>`

const server = http.createServer((req, res) => {
  if (req.url === '/data/resource.json') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }
  if (req.url === '/download') {
    res.writeHead(200, {
      'content-type': 'text/plain',
      'content-disposition': 'attachment; filename="headless-report.txt"',
    })
    res.end('headless download body\n')
    return
  }
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(page)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-headless-test-'))
const driver = new HeadlessDriver({ home })
try {
  await driver.ensureStarted()
  const capture = await driver.request('tab.capture_start', { owner: 's1', maxEntries: 50 })
  assert.equal(capture.active, true)
  const gone = await driver.request('tab.goto', { owner: 's1', url: `http://127.0.0.1:${port}/` })
  assert.equal(gone.title, 'Headless Test')
  assert.equal(gone.loadState, 'complete')

  const snap = await driver.request('tab.snapshot', { owner: 's1', maxChars: 5000 })
  assert.equal(snap.title, 'Headless Test')
  const input = snap.controls.find((control) => control.tag === 'input')
  const button = snap.controls.find((control) => control.tag === 'button')
  assert.ok(input && button, `unexpected controls: ${JSON.stringify(snap.controls)}`)
  assert.equal(button.label, 'Go')
  // The page-text budget the tool default relies on (docs/PERF-LOOP.md §6): a
  // snapshot returns exactly maxChars characters and flags the truncation.
  const fullText = await driver.request('tab.snapshot', { owner: 's1', maxChars: 200000 })
  const budgetText = await driver.request('tab.snapshot', { owner: 's1', maxChars: 1000 })
  assert.equal(budgetText.text, fullText.text.slice(0, 1000))
  assert.equal(budgetText.text.length, Math.min(1000, fullText.text.length))
  assert.equal(budgetText.truncated, fullText.text.length > 1000)

  const typed = await driver.request('tab.type', { owner: 's1', ref: input.ref, text: 'world', replace: true })
  assert.equal(typed.value, 'world')
  const clicked = await driver.request('tab.click', { owner: 's1', ref: button.ref })
  assert.equal(clicked.ok, true)
  const out = await driver.request('tab.evaluate', { owner: 's1', expression: 'document.getElementById("out").textContent' })
  assert.equal(out.value, 'hello world')

  const shot = await driver.request('tab.screenshot', { owner: 's1' })
  assert.ok(fs.existsSync(shot.path), `screenshot missing: ${shot.path}`)
  assert.ok(shot.bytes > 1000)
  // The default fast-PNG path must still produce a valid PNG whose pixel size
  // matches the cached viewport size reported to the caller.
  const shotBytes = fs.readFileSync(shot.path)
  assert.equal(shot.mediaType, 'image/png')
  assert.deepEqual([...shotBytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  // Screenshot frame streaming: a second shot without any page change must
  // reuse the same composited frame (byte-identical PNG, no new capture), and a
  // driver-side change must invalidate it so the next shot shows the change.
  const shot2 = await driver.request('tab.screenshot', { owner: 's1' })
  const shot2Bytes = fs.readFileSync(shot2.path)
  const diag = await driver.request('tab.debug_diag')
  const stream = diag.tabs.find((tab) => tab.tabId === gone.tabId)?.screenshotStream
  assert.ok(stream && stream.served >= 2, `screenshot stream not used: ${JSON.stringify(stream)}`)
  assert.ok(stream.frames >= 1, `screenshot stream produced no frames: ${JSON.stringify(stream)}`)
  assert.deepEqual(shot2Bytes, shotBytes, 'unchanged page must reuse the same frame bytes')
  const dpr = (await driver.request('tab.evaluate', { owner: 's1', expression: 'devicePixelRatio' })).value
  assert.equal(shotBytes.readUInt32BE(16), Math.round(shot.width * dpr))
  assert.equal(shotBytes.readUInt32BE(20), Math.round(shot.height * dpr))
  const viewportNow = await driver.request('tab.evaluate', { owner: 's1', expression: '({ w: innerWidth, h: innerHeight })' })
  assert.deepEqual([shot.width, shot.height], [viewportNow.value.w, viewportNow.value.h])
  await driver.request('tab.evaluate', {
    owner: 's1',
    expression: 'document.getElementById("out").textContent = "frame-freshness"',
  })
  const shot3 = await driver.request('tab.screenshot', { owner: 's1' })
  assert.notDeepEqual(fs.readFileSync(shot3.path), shotBytes, 'screenshot after a page change must not be stale')
  // Optional JPEG path (used by the benchmark's alternate scenario).
  const jpegShot = await driver.request('tab.screenshot', { owner: 's1', format: 'jpeg', quality: 60 })
  assert.equal(jpegShot.mediaType, 'image/jpeg')
  assert.ok(jpegShot.path.endsWith('.jpg'), `jpeg screenshot path: ${jpegShot.path}`)
  assert.ok(fs.existsSync(jpegShot.path))
  const jpegBytes = fs.readFileSync(jpegShot.path)
  assert.deepEqual([...jpegBytes.subarray(0, 3)], [0xff, 0xd8, 0xff])
  assert.deepEqual([...jpegBytes.subarray(-2)], [0xff, 0xd9])
  assert.ok(jpegShot.bytes > 1000)
  // JPEG takes the same frame-stream path as PNG (the stream switches format).
  // A couple of requests make this independent of first-frame timing after the
  // PNG -> JPEG restart: once a frame is cached, unchanged pages must reuse it.
  const jpegBefore = (await driver.request('tab.debug_diag')).tabs.find((tab) => tab.tabId === gone.tabId)?.screenshotStream
  await driver.request('tab.screenshot', { owner: 's1', format: 'jpeg', quality: 60 })
  const jpegShot3 = await driver.request('tab.screenshot', { owner: 's1', format: 'jpeg', quality: 60 })
  const jpegShot4 = await driver.request('tab.screenshot', { owner: 's1', format: 'jpeg', quality: 60 })
  const jpegDiag = (await driver.request('tab.debug_diag')).tabs.find((tab) => tab.tabId === gone.tabId)?.screenshotStream
  assert.equal(jpegDiag.format, 'jpeg', `jpeg stream format: ${JSON.stringify(jpegDiag)}`)
  assert.equal(jpegDiag.quality, 60, `jpeg stream quality: ${JSON.stringify(jpegDiag)}`)
  assert.ok(
    jpegDiag.served > (jpegBefore?.served || 0),
    `jpeg screenshot was not served from the frame stream: ${JSON.stringify({ jpegBefore, jpegDiag })}`,
  )
  assert.deepEqual(
    fs.readFileSync(jpegShot4.path),
    fs.readFileSync(jpegShot3.path),
    'unchanged page must reuse the same JPEG frame bytes',
  )
  await driver.request('tab.evaluate', { owner: 's1', expression: 'document.getElementById("out").textContent = "jpeg-freshness"' })
  const jpegShot5 = await driver.request('tab.screenshot', { owner: 's1', format: 'jpeg', quality: 60 })
  assert.notDeepEqual(
    fs.readFileSync(jpegShot5.path),
    fs.readFileSync(jpegShot4.path),
    'JPEG screenshot after a page change must not be stale',
  )
  // Switching back to PNG restarts the stream with the PNG encoder.
  const pngAgain = await driver.request('tab.screenshot', { owner: 's1' })
  assert.equal(pngAgain.mediaType, 'image/png')
  const pngAgainDiag = (await driver.request('tab.debug_diag')).tabs.find((tab) => tab.tabId === gone.tabId)?.screenshotStream
  assert.equal(pngAgainDiag.format, 'png', `png stream after jpeg: ${JSON.stringify(pngAgainDiag)}`)

  // Driver-side clip/ref screenshots (docs/HEADLESS.md §4.1.4): a region or
  // element shot is cropped out of the streamed frame instead of forcing a new
  // Page.captureScreenshot. `clip`/`ref` are CSS px like the desktop backend,
  // the PNG is device px (x devicePixelRatio), and a `ref` returns the element
  // box rather than the whole viewport.
  const clipRegion = { x: 0, y: 0, width: 600, height: 300 }
  const clipShot = await driver.request('tab.screenshot', { owner: 's1', clip: clipRegion })
  const clipBytes = fs.readFileSync(clipShot.path)
  assert.deepEqual([clipShot.width, clipShot.height], [600, 300], `clip dimensions: ${JSON.stringify(clipShot)}`)
  assert.equal(clipBytes.readUInt32BE(16), Math.round(600 * dpr))
  assert.equal(clipBytes.readUInt32BE(20), Math.round(300 * dpr))
  const clipAgain = await driver.request('tab.screenshot', { owner: 's1', clip: clipRegion })
  assert.deepEqual(fs.readFileSync(clipAgain.path), clipBytes, 'unchanged page must reuse the same cropped frame bytes')
  await driver.request('tab.evaluate', {
    owner: 's1',
    expression: 'document.getElementById("out").textContent = "clip-freshness"',
  })
  const clipChanged = await driver.request('tab.screenshot', { owner: 's1', clip: clipRegion })
  assert.notDeepEqual(fs.readFileSync(clipChanged.path), clipBytes, 'cropped screenshot after a page change must not be stale')
  const clipDiag = (await driver.request('tab.debug_diag')).tabs.find((tab) => tab.tabId === gone.tabId)?.screenshotStream
  assert.ok(clipDiag && clipDiag.cropped >= 3, `clip screenshots were not cropped in the driver: ${JSON.stringify(clipDiag)}`)
  const buttonBox = (
    await driver.request('tab.evaluate', {
      owner: 's1',
      expression: `(() => { const rect = document.querySelector('[data-dsh-ref="${button.ref}"]').getBoundingClientRect(); return { width: rect.width, height: rect.height } })()`,
    })
  ).value
  const refShot = await driver.request('tab.screenshot', { owner: 's1', ref: button.ref })
  const refBytes = fs.readFileSync(refShot.path)
  assert.equal(refBytes.readUInt32BE(16), Math.round(buttonBox.width * dpr))
  assert.equal(refBytes.readUInt32BE(20), Math.round(buttonBox.height * dpr))
  assert.deepEqual([refShot.width, refShot.height], [Math.round(buttonBox.width), Math.round(buttonBox.height)])
  assert.ok(
    refShot.bytes < clipShot.bytes,
    `ref shot should be smaller than the 600x300 clip: ${JSON.stringify({ ref: refShot.bytes, clip: clipShot.bytes })}`,
  )
  await assert.rejects(
    driver.request('tab.screenshot', { owner: 's1', ref: 99999 }),
    (err) => err.code === 'REF_STALE',
    'unknown ref must be REF_STALE instead of silently returning the full viewport',
  )
  await assert.rejects(
    driver.request('tab.screenshot', { owner: 's1', clip: { x: 0, y: 0, width: 0, height: 10 } }),
    (err) => err.code === 'INVALID_ARGUMENT',
    'empty clip must be rejected like the desktop backend',
  )

  // JPEG clip/ref shots (docs/HEADLESS.md §4.1.9): the driver has no JPEG
  // codec, so a JPEG region is decoded/encoded by the page inside a dedicated
  // isolated world. Chrome needs a paint before the JPEG stream holds a frame
  // of the right size (the first frame after a stream start can be a stale,
  // smaller surface), so poll for a shot the driver actually cropped; the
  // capture fallback is correct too, it is just not what this path is about.
  const jpegStreamDiag = async () =>
    (await driver.request('tab.debug_diag')).tabs.find((tab) => tab.tabId === gone.tabId)?.screenshotStream
  const jpegClipRequest = () =>
    driver.request('tab.screenshot', { owner: 's1', format: 'jpeg', quality: 60, clip: clipRegion })
  let jpegClipShot = null
  for (let attempt = 0; attempt < 16 && !jpegClipShot; attempt += 1) {
    const before = (await jpegStreamDiag())?.jpegCropped || 0
    const candidate = await jpegClipRequest()
    if (((await jpegStreamDiag())?.jpegCropped || 0) > before) {
      jpegClipShot = candidate
      break
    }
    // Force a paint so the freshly (re)started JPEG stream gets a real frame.
    await driver.request('tab.evaluate', {
      owner: 's1',
      expression: `document.getElementById("out").textContent = "jpeg-clip-warm-${attempt}"`,
    })
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.ok(jpegClipShot, 'the driver never cropped a JPEG clip screenshot')
  const jpegClipBytes = fs.readFileSync(jpegClipShot.path)
  assert.equal(jpegClipShot.mediaType, 'image/jpeg')
  assert.ok(jpegClipShot.path.endsWith('.jpg'), `jpeg clip path: ${jpegClipShot.path}`)
  assert.deepEqual([...jpegClipBytes.subarray(0, 3)], [0xff, 0xd8, 0xff], 'jpeg clip must start with SOI')
  assert.deepEqual([...jpegClipBytes.subarray(-2)], [0xff, 0xd9], 'jpeg clip must end with EOI')
  assert.deepEqual(
    jpegSofSize(jpegClipBytes),
    { width: Math.round(600 * dpr), height: Math.round(300 * dpr) },
    `jpeg clip pixel size: ${JSON.stringify(jpegSofSize(jpegClipBytes))}`,
  )
  assert.deepEqual([jpegClipShot.width, jpegClipShot.height], [600, 300])
  // An unchanged page re-crops the same cached frame.
  const jpegClipAgain = await jpegClipRequest()
  assert.deepEqual(fs.readFileSync(jpegClipAgain.path), jpegClipBytes, 'unchanged page must reuse the same cropped JPEG bytes')
  // A page change must produce new pixels (never a stale frame).
  await driver.request('tab.evaluate', {
    owner: 's1',
    expression: 'document.getElementById("out").textContent = "jpeg-clip-freshness"',
  })
  const jpegClipChanged = await jpegClipRequest()
  assert.notDeepEqual(
    fs.readFileSync(jpegClipChanged.path),
    jpegClipBytes,
    'JPEG clip screenshot after a page change must not be stale',
  )
  // `ref` returns the element box in the same JPEG format.
  const jpegRef = await driver.request('tab.screenshot', { owner: 's1', format: 'jpeg', quality: 60, ref: button.ref })
  assert.deepEqual(
    jpegSofSize(fs.readFileSync(jpegRef.path)),
    { width: Math.round(buttonBox.width * dpr), height: Math.round(buttonBox.height * dpr) },
    `jpeg ref pixel size: ${JSON.stringify(jpegSofSize(fs.readFileSync(jpegRef.path)))}`,
  )
  // The crop runs in an isolated world, so a page that breaks its own canvas
  // encoder must neither break the crop nor be able to supply its own bytes.
  await driver.request('tab.evaluate', {
    owner: 's1',
    expression:
      'window.__realToDataURL = HTMLCanvasElement.prototype.toDataURL; HTMLCanvasElement.prototype.toDataURL = () => "data:image/jpeg;base64,////"; true',
  })
  const croppedBeforeOverride = (await jpegStreamDiag())?.jpegCropped || 0
  const jpegClipIsolated = await jpegClipRequest()
  const croppedAfterOverride = (await jpegStreamDiag())?.jpegCropped || 0
  await driver.request('tab.evaluate', {
    owner: 's1',
    expression: 'HTMLCanvasElement.prototype.toDataURL = window.__realToDataURL; delete window.__realToDataURL; true',
  })
  assert.ok(
    croppedAfterOverride > croppedBeforeOverride,
    `a page canvas override broke the isolated-world JPEG crop: ${JSON.stringify(await jpegStreamDiag())}`,
  )
  const isolatedBytes = fs.readFileSync(jpegClipIsolated.path)
  assert.deepEqual(
    jpegSofSize(isolatedBytes),
    { width: Math.round(600 * dpr), height: Math.round(300 * dpr) },
    'page-supplied canvas bytes must not replace the screenshot',
  )
  assert.ok(isolatedBytes.length > 128, 'page-supplied canvas bytes must not replace the screenshot')
  // Restore the page state the later visual-probe assertions expect.
  await driver.request('tab.evaluate', {
    owner: 's1',
    expression: 'document.getElementById("out").textContent = "clip-freshness"',
  })

  // Page-side visual probe (docs/HEADLESS.md §4.1.7): an action that provably
  // painted nothing (read-only evaluate, scroll that does not move the
  // viewport) keeps the previous change marker, so the next screenshot reuses
  // the cached frame instead of paying the ~40ms repaint window. Anything that
  // can paint (DOM mutation, scroll, focus, canvas pixels) must keep waiting.
  const tabDiag = async () => (await driver.request('tab.debug_diag')).tabs.find((tab) => tab.tabId === gone.tabId)
  // A repaint can land as two composited frames; settle before taking a
  // reference frame so a late second frame cannot race the cache-hit compare.
  const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms))
  const probeBase = await tabDiag()
  assert.equal(probeBase.visualTracker, true, `visual probe not installed: ${JSON.stringify(probeBase)}`)
  // Blur first: a focused input blinks a caret, and those frames would land
  // between the cache-hit comparisons below (the same reason the keep-alive
  // check further down blurs first).
  await driver.request('tab.evaluate', { owner: 's1', expression: 'document.activeElement?.blur()' })
  await driver.request('tab.screenshot', { owner: 's1' })
  await settle()
  const cachedShot = await driver.request('tab.screenshot', { owner: 's1' })
  const cachedBytes = fs.readFileSync(cachedShot.path)
  const readonlySkipBefore = await tabDiag()
  const readonlyValue = await driver.request('tab.evaluate', { owner: 's1', expression: 'document.getElementById("out").textContent' })
  assert.equal(readonlyValue.value, 'clip-freshness', 'evaluate must keep returning the page value')
  const readonlyShot = await driver.request('tab.screenshot', { owner: 's1' })
  const readonlySkipAfter = await tabDiag()
  assert.equal(
    readonlySkipAfter.screenshotStream.frames,
    readonlySkipBefore.screenshotStream.frames,
    'read-only evaluate must not wait for a new frame',
  )
  assert.equal(
    readonlySkipAfter.visualSkips,
    readonlySkipBefore.visualSkips + 1,
    `read-only evaluate did not skip the repaint window: ${JSON.stringify({ before: readonlySkipBefore.visualSkips, after: readonlySkipAfter.visualSkips })}`,
  )
  assert.equal(
    readonlySkipAfter.screenshotStream.repaintMisses,
    readonlySkipBefore.screenshotStream.repaintMisses,
    'read-only evaluate waited for a frame that cannot come',
  )
  assert.deepEqual(fs.readFileSync(readonlyShot.path), cachedBytes, 'read-only evaluate must reuse the cached frame')
  // A DOM mutation is a paint source: the next screenshot must be fresh.
  await driver.request('tab.evaluate', { owner: 's1', expression: 'document.getElementById("out").textContent = "probe-mutation"' })
  const mutatedShot = await driver.request('tab.screenshot', { owner: 's1' })
  assert.notDeepEqual(fs.readFileSync(mutatedShot.path), cachedBytes, 'DOM mutation after the probe must not be stale')
  // Give the page room to scroll, then check the three scroll cases: moving is
  // dirty, and a scroll at the boundary is paint-free.
  await driver.request('tab.evaluate', {
    owner: 's1',
    expression: 'document.body.insertAdjacentHTML("beforeend", \'<div style="height:3000px">scroll filler</div>\')',
  })
  await driver.request('tab.screenshot', { owner: 's1' })
  const atTopShot = await driver.request('tab.screenshot', { owner: 's1' })
  const atTopBytes = fs.readFileSync(atTopShot.path)
  const movingBefore = await tabDiag()
  const scrolledDown = await driver.request('tab.scroll', { owner: 's1', direction: 'down', amount: 400 })
  assert.ok(scrolledDown.y > 0, `scroll down did not move the page: ${JSON.stringify(scrolledDown)}`)
  const downShot = await driver.request('tab.screenshot', { owner: 's1' })
  const movingAfter = await tabDiag()
  assert.equal(movingAfter.visualSkips, movingBefore.visualSkips, 'a moving scroll must keep the conservative wait')
  assert.notDeepEqual(fs.readFileSync(downShot.path), atTopBytes, 'a moving scroll must not be stale')
  await driver.request('tab.scroll', { owner: 's1', direction: 'top' })
  await driver.request('tab.screenshot', { owner: 's1' })
  await settle()
  const backTopShot = await driver.request('tab.screenshot', { owner: 's1' })
  const backTopBytes = fs.readFileSync(backTopShot.path)
  const boundaryBefore = await tabDiag()
  const boundaryScroll = await driver.request('tab.scroll', { owner: 's1', direction: 'top' })
  assert.equal(boundaryScroll.y, 0)
  const boundaryShot = await driver.request('tab.screenshot', { owner: 's1' })
  const boundaryAfter = await tabDiag()
  assert.equal(
    boundaryAfter.visualSkips,
    boundaryBefore.visualSkips + 1,
    `boundary scroll did not skip the repaint window: ${JSON.stringify({ before: boundaryBefore.visualSkips, after: boundaryAfter.visualSkips })}`,
  )
  assert.deepEqual(fs.readFileSync(boundaryShot.path), backTopBytes, 'boundary scroll must reuse the cached frame')
  // Scrolling via evaluate is not a DOM mutation but changes the pixels.
  const scrollProbeBefore = await tabDiag()
  await driver.request('tab.evaluate', { owner: 's1', expression: 'window.scrollTo(0, 400)' })
  const scrolledShot = await driver.request('tab.screenshot', { owner: 's1' })
  const scrollProbeAfter = await tabDiag()
  assert.equal(scrollProbeAfter.visualSkips, scrollProbeBefore.visualSkips, 'scroll via evaluate must keep the conservative wait')
  assert.notDeepEqual(fs.readFileSync(scrolledShot.path), backTopBytes, 'scroll via evaluate must not be stale')
  // Focus changes are not DOM mutations either (focus ring repaint).
  await driver.request('tab.evaluate', { owner: 's1', expression: 'document.activeElement?.blur()' })
  await driver.request('tab.screenshot', { owner: 's1' })
  const focusProbeBefore = await tabDiag()
  await driver.request('tab.evaluate', { owner: 's1', expression: 'document.getElementById("name").focus()' })
  await driver.request('tab.screenshot', { owner: 's1' })
  const focusProbeAfter = await tabDiag()
  assert.equal(focusProbeAfter.visualSkips, focusProbeBefore.visualSkips, 'focus change must keep the conservative wait')
  // Blur again so the caret cannot add frames between the canvas cache hits.
  await driver.request('tab.evaluate', { owner: 's1', expression: 'document.activeElement?.blur()' })
  await driver.request('tab.screenshot', { owner: 's1' })
  // Canvas pixels are invisible to the probe: a canvas in the document disables
  // the shortcut, so painting it cannot return the old frame.
  await driver.request('tab.evaluate', {
    owner: 's1',
    expression: '(() => { const el = document.createElement("canvas"); el.id = "probe-canvas"; el.width = 600; el.height = 120; el.style.position = "fixed"; el.style.top = "0"; el.style.left = "0"; el.style.background = "#111"; document.body.append(el); return "canvas-added" })()',
  })
  const canvasBase = await driver.request('tab.screenshot', { owner: 's1' })
  const canvasProbeBefore = await tabDiag()
  await driver.request('tab.evaluate', {
    owner: 's1',
    expression: '(() => { const ctx = document.getElementById("probe-canvas").getContext("2d"); ctx.fillStyle = "#e00"; ctx.fillRect(0, 0, 300, 60); return "painted" })()',
  })
  const canvasShot = await driver.request('tab.screenshot', { owner: 's1' })
  const canvasProbeAfter = await tabDiag()
  assert.equal(canvasProbeAfter.visualSkips, canvasProbeBefore.visualSkips, 'canvas draw must keep the conservative wait')
  assert.notDeepEqual(fs.readFileSync(canvasShot.path), fs.readFileSync(canvasBase.path), 'canvas draw must not be stale')
  // Removing the canvas restores the shortcut for a read-only evaluate.
  await driver.request('tab.evaluate', { owner: 's1', expression: 'document.getElementById("probe-canvas").remove()' })
  await driver.request('tab.screenshot', { owner: 's1' })
  await settle()
  const restoredBase = await driver.request('tab.screenshot', { owner: 's1' })
  const restoredBefore = await tabDiag()
  await driver.request('tab.evaluate', { owner: 's1', expression: 'document.title' })
  const restoredShot = await driver.request('tab.screenshot', { owner: 's1' })
  const restoredAfter = await tabDiag()
  assert.equal(restoredAfter.visualSkips, restoredBefore.visualSkips + 1, 'shortcut did not come back after removing the canvas')
  assert.deepEqual(fs.readFileSync(restoredShot.path), fs.readFileSync(restoredBase.path), 'read-only evaluate after canvas removal must reuse the cached frame')
  // Synthetic click / hover (docs/HEADLESS.md §4.1.8): a click on a plain element
  // with no handler cannot paint, so it keeps the previous change marker and the
  // next screenshot reuses the cached frame. Clicks whose target can change UA
  // state without a DOM mutation (checkbox activation) or navigate (form submit,
  // anchor) must keep the conservative repaint window.
  await driver.request('tab.scroll', { owner: 's1', direction: 'top' })
  await driver.request('tab.screenshot', { owner: 's1' })
  await settle()
  const clickBaselineShot = await driver.request('tab.screenshot', { owner: 's1' })
  const clickBaselineBytes = fs.readFileSync(clickBaselineShot.path)
  const clickBaselineDiag = await tabDiag()
  const noopClick = await driver.request('tab.click', { owner: 's1', selector: '#noop' })
  assert.equal(noopClick.ok, true, `plain click failed: ${JSON.stringify(noopClick)}`)
  const noopClickShot = await driver.request('tab.screenshot', { owner: 's1' })
  const noopClickDiag = await tabDiag()
  assert.equal(
    noopClickDiag.visualSkips,
    clickBaselineDiag.visualSkips + 1,
    `plain click did not skip the repaint window: ${JSON.stringify({ before: clickBaselineDiag.visualSkips, after: noopClickDiag.visualSkips })}`,
  )
  assert.equal(
    noopClickDiag.screenshotStream.frames,
    clickBaselineDiag.screenshotStream.frames,
    'plain click waited for a frame that cannot come',
  )
  assert.equal(
    noopClickDiag.screenshotStream.repaintMisses,
    clickBaselineDiag.screenshotStream.repaintMisses,
    'plain click ran into the repaint window',
  )
  assert.deepEqual(fs.readFileSync(noopClickShot.path), clickBaselineBytes, 'plain click must reuse the cached frame')
  // `tab.hover` shares clickPage, so it shares the probe.
  const hoverBaseDiag = await tabDiag()
  const hovered = await driver.request('tab.hover', { owner: 's1', selector: '#noop' })
  assert.equal(hovered.ok, true, `plain hover failed: ${JSON.stringify(hovered)}`)
  const hoverShot = await driver.request('tab.screenshot', { owner: 's1' })
  const hoverDiag = await tabDiag()
  assert.equal(
    hoverDiag.visualSkips,
    hoverBaseDiag.visualSkips + 1,
    `plain hover did not skip the repaint window: ${JSON.stringify({ before: hoverBaseDiag.visualSkips, after: hoverDiag.visualSkips })}`,
  )
  assert.equal(hoverDiag.screenshotStream.frames, hoverBaseDiag.screenshotStream.frames, 'plain hover waited for a frame that cannot come')
  assert.deepEqual(fs.readFileSync(hoverShot.path), clickBaselineBytes, 'plain hover must reuse the cached frame')
  // A click whose handler mutates the DOM is a paint source: the next screenshot
  // must be fresh and the handler result must be visible.
  await driver.request('tab.type', { owner: 's1', ref: input.ref, text: 'click-probe', replace: true })
  await driver.request('tab.screenshot', { owner: 's1' })
  const beforeMutationShot = await driver.request('tab.screenshot', { owner: 's1' })
  const beforeMutationBytes = fs.readFileSync(beforeMutationShot.path)
  const mutationBaseDiag = await tabDiag()
  await driver.request('tab.click', { owner: 's1', ref: button.ref })
  const mutationShot = await driver.request('tab.screenshot', { owner: 's1' })
  const mutationDiag = await tabDiag()
  assert.equal(mutationDiag.visualSkips, mutationBaseDiag.visualSkips, 'a DOM-mutating click must keep the conservative wait')
  assert.notDeepEqual(fs.readFileSync(mutationShot.path), beforeMutationBytes, 'DOM-mutating click must not be stale')
  const mutationText = await driver.request('tab.evaluate', { owner: 's1', expression: 'document.getElementById("out").textContent' })
  assert.equal(mutationText.value, 'hello click-probe')
  // Checkbox activation toggles pixels without a DOM mutation: the change-event
  // counter plus the target hazard must keep the screenshot honest.
  await driver.request('tab.evaluate', { owner: 's1', expression: 'document.activeElement?.blur()' })
  await driver.request('tab.screenshot', { owner: 's1' })
  await settle()
  const checkboxBaseline = await driver.request('tab.screenshot', { owner: 's1' })
  const checkboxBytes = fs.readFileSync(checkboxBaseline.path)
  const checkboxBaseDiag = await tabDiag()
  const checkboxClick = await driver.request('tab.click', { owner: 's1', selector: '#check' })
  assert.equal(checkboxClick.ok, true, `checkbox click failed: ${JSON.stringify(checkboxClick)}`)
  const checkboxShot = await driver.request('tab.screenshot', { owner: 's1' })
  const checkboxDiag = await tabDiag()
  assert.equal(checkboxDiag.visualSkips, checkboxBaseDiag.visualSkips, 'checkbox activation must keep the conservative wait')
  assert.notDeepEqual(fs.readFileSync(checkboxShot.path), checkboxBytes, 'checkbox activation must not be stale')
  // Activating a checkbox from page JS fires change, not a mutation; that counter
  // is what keeps this honest.
  const jsToggleBaseDiag = await tabDiag()
  await driver.request('tab.evaluate', { owner: 's1', expression: 'document.getElementById("check").click()' })
  const jsToggleDiag = await tabDiag()
  assert.equal(jsToggleDiag.visualSkips, jsToggleBaseDiag.visualSkips, 'checkbox activation from evaluate must keep the conservative wait')
  // A submit button is a navigation hazard even when the form cancels submit.
  const formBaseDiag = await tabDiag()
  const formClick = await driver.request('tab.click', { owner: 's1', selector: '#form-submit' })
  assert.equal(formClick.ok, true, `form submit click failed: ${JSON.stringify(formClick)}`)
  const formDiag = await tabDiag()
  assert.equal(formDiag.visualSkips, formBaseDiag.visualSkips, 'form submit click must keep the conservative wait (navigation hazard)')
  // Input.* actions are not probe-covered yet: press keeps the full window.
  const pressBaseDiag = await tabDiag()
  await driver.request('tab.press', { owner: 's1', key: 'Shift' })
  const pressDiag = await tabDiag()
  assert.equal(pressDiag.visualSkips, pressBaseDiag.visualSkips, 'Input.* press still keeps the conservative wait (not probe-covered)')

  const tabs = await driver.request('tab.tabs', { owner: 's1', op: 'list' })
  assert.equal(tabs.tabs.length, 1)
  assert.equal(tabs.activeTabId, gone.tabId)

  const html = await driver.request('tab.html', { owner: 's1', maxChars: 500 })
  assert.ok(html.html.includes('Headless Test'))

  const consoleValue = await driver.request('tab.console', { owner: 's1', limit: 20 })
  assert.ok(
    consoleValue.entries.some((entry) => entry.text.includes('headless-log-1')),
    `console entries missing the page log: ${JSON.stringify(consoleValue.entries)}`,
  )

  await new Promise((resolve) => setTimeout(resolve, 200))
  const networkValue = await driver.request('tab.network', { owner: 's1', limit: 50 })
  assert.ok(
    networkValue.entries.some((entry) => entry.url.includes('/data/resource.json')),
    `network entries missing the fetched resource: ${JSON.stringify(networkValue.entries)}`,
  )

  const snap2 = await driver.request('tab.snapshot', { owner: 's1', maxChars: 2000 })
  const fileInput = snap2.controls.find((control) => control.kind === 'file')
  assert.ok(fileInput, `file input not found: ${JSON.stringify(snap2.controls)}`)
  const uploadPath = path.join(home, 'upload.txt')
  fs.writeFileSync(uploadPath, 'hello upload')
  const uploaded = await driver.request('tab.upload', { owner: 's1', ref: fileInput.ref, files: [uploadPath] })
  assert.equal(uploaded.ok, true)
  const uploadedCount = await driver.request('tab.evaluate', { owner: 's1', expression: 'document.getElementById("file").files.length' })
  assert.equal(uploadedCount.value, 1)

  const downloadLink = snap2.controls.find((control) => control.tag === 'a' && control.label === 'download')
  assert.ok(downloadLink, `download link not found: ${JSON.stringify(snap2.controls)}`)
  // An anchor can navigate, so the click hazard keeps the conservative wait even
  // though this particular download link does not repaint the page.
  const downloadClickBase = await tabDiag()
  await driver.request('tab.click', { owner: 's1', ref: downloadLink.ref })
  const downloadClickDiag = await tabDiag()
  assert.equal(
    downloadClickDiag.visualSkips,
    downloadClickBase.visualSkips,
    'anchor click must keep the conservative wait (navigation hazard)',
  )
  let items = []
  for (let i = 0; i < 50; i += 1) {
    items = (await driver.request('browser.downloads', { limit: 10 })).items
    if (items.some((item) => item.state === 'complete')) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.ok(
    items.some((item) => item.state === 'complete' && item.filename === 'headless-report.txt'),
    `download did not complete: ${JSON.stringify(items)}`,
  )

  const resumed = await driver.request('tab.resume', { owner: 's1' })
  assert.equal(resumed.ok, true)

  await new Promise((resolve) => setTimeout(resolve, 300))
  const captured = await driver.request('tab.capture_requests', { owner: 's1', captureId: capture.captureId, limit: 50 })
  assert.equal(captured.captureId, capture.captureId)
  assert.ok(
    captured.entries.some((entry) => entry.url.includes('/data/resource.json') || entry.url.endsWith('/')),
    `capture missing requests: ${JSON.stringify(captured.entries)}`,
  )
  const docEntry = captured.entries.find((entry) => entry.resourceType === 'document')
  assert.ok(docEntry?.responseBody?.includes('Headless Test'), `document body missing: ${JSON.stringify(docEntry)}`)
  const stopped = await driver.request('tab.capture_stop', { owner: 's1', captureId: capture.captureId })
  assert.equal(stopped.active, false)
  assert.ok(stopped.requests >= 1)

  const textValue = await driver.request('tab.get_text', { owner: 's1', maxChars: 5000 })
  assert.ok(textValue.found && textValue.text.includes('Headless Test'), `get_text failed: ${JSON.stringify(textValue)}`)
  const found = await driver.request('tab.find', { owner: 's1', query: 'Headless', maxResults: 5 })
  assert.ok(found.matches.length >= 1, `find failed: ${JSON.stringify(found)}`)
  const snap3 = await driver.request('tab.snapshot', { owner: 's1', maxChars: 3000 })
  const selectControl = snap3.controls.find((control) => control.tag === 'select')
  const checkControl = snap3.controls.find((control) => control.kind === 'checkbox')
  const dragSrc = snap3.controls.find((control) => control.label === 'drag-src')
  const dropTarget = snap3.controls.find((control) => control.label === 'drop-target')
  assert.ok(selectControl && checkControl && dragSrc && dropTarget, `new controls missing: ${JSON.stringify(snap3.controls)}`)
  const selected = await driver.request('tab.select', { owner: 's1', ref: selectControl.ref, value: 'two' })
  assert.equal(selected.value, 'two')
  const checked = await driver.request('tab.select', { owner: 's1', ref: checkControl.ref, checked: true })
  assert.equal(checked.value, 'true')
  const stored = await driver.request('tab.storage', { owner: 's1', op: 'set', key: 'probe', value: { ok: 1 } })
  assert.equal(stored.set, 1)
  const readBack = await driver.request('tab.storage', { owner: 's1', op: 'get', key: 'probe' })
  assert.deepEqual(readBack.items.probe, { ok: 1 })
  const emulated = await driver.request('tab.emulate', { owner: 's1', width: 800, height: 600 })
  assert.equal(emulated.applied, true)
  const widthNow = await driver.request('tab.evaluate', { owner: 's1', expression: 'innerWidth' })
  assert.equal(widthNow.value, 800)
  // Screenshot viewport metadata follows the emulation override, and the
  // streamed frame is re-sized with it (the old stream must be restarted).
  const emulatedShot = await driver.request('tab.screenshot', { owner: 's1' })
  assert.deepEqual([emulatedShot.width, emulatedShot.height], [800, 600])
  const emulatedBytes = fs.readFileSync(emulatedShot.path)
  assert.equal(emulatedBytes.readUInt32BE(16), 800)
  assert.equal(emulatedBytes.readUInt32BE(20), 600)
  const resetViewport = await driver.request('tab.emulate', { owner: 's1', reset: true })
  assert.equal(resetViewport.applied, false)
  const dragged = await driver.request('tab.drag', { owner: 's1', fromRef: dragSrc.ref, toRef: dropTarget.ref })
  assert.equal(dragged.ok, true)

  // Frame-stream keep-alive (docs/HEADLESS.md §4.1.3): an unchanged visible
  // page that produced no frame for longer than the idle window must keep its
  // cached frame and its screencast instead of restarting, so the next
  // screenshot is a cache hit rather than a first-frame wait.
  // Blur first: a focused input blinks a caret (~2 frames/s) and a repainting
  // page deliberately keeps the old stop-after-idle behaviour.
  await driver.request('tab.evaluate', { owner: 's1', expression: 'document.activeElement?.blur()' })
  const keepaliveRef = await driver.request('tab.screenshot', { owner: 's1' })
  assert.ok(fs.existsSync(keepaliveRef.path))
  // Let the blur repaint land, then reset the idle window with a cache hit so
  // the measurement starts from a quiet page.
  await new Promise((resolve) => setTimeout(resolve, 400))
  await driver.request('tab.screenshot', { owner: 's1' })
  const keepaliveBefore = (await driver.request('tab.debug_diag')).tabs.find((tab) => tab.tabId === gone.tabId)?.screenshotStream
  await new Promise((resolve) => setTimeout(resolve, 2600))
  const keepaliveShot = await driver.request('tab.screenshot', { owner: 's1' })
  const keepaliveAfter = (await driver.request('tab.debug_diag')).tabs.find((tab) => tab.tabId === gone.tabId)?.screenshotStream
  assert.equal(keepaliveAfter.active, true, `quiet frame stream stopped: ${JSON.stringify(keepaliveAfter)}`)
  assert.equal(
    keepaliveAfter.restarts,
    keepaliveBefore.restarts,
    `idle stream restarted instead of keeping the cached frame: ${JSON.stringify({ keepaliveBefore, keepaliveAfter })}`,
  )
  assert.ok(
    keepaliveAfter.served > keepaliveBefore.served,
    `idle screenshot was not served from the frame stream: ${JSON.stringify({ keepaliveBefore, keepaliveAfter })}`,
  )
  const cast = await driver.request('tab.screencast_start', { owner: 's1', everyNthFrame: 1, quality: 50 })
  assert.equal(cast.active, true)
  await new Promise((resolve) => setTimeout(resolve, 200))
  let castStatus = { frames: 0 }
  for (let attempt = 0; attempt < 4 && castStatus.frames === 0; attempt += 1) {
    await driver.request('tab.scroll', { owner: 's1', direction: attempt % 2 === 0 ? 'top' : 'bottom' })
    await driver.request('tab.evaluate', {
      owner: 's1',
      expression: `document.body.style.background = ${JSON.stringify(attempt % 2 === 0 ? '#ff0000' : '#ffffff')}`,
    })
    await new Promise((resolve) => setTimeout(resolve, 400))
    castStatus = await driver.request('tab.screencast_status', { owner: 's1' })
  }
  assert.ok(castStatus.frames > 0, `headless screencast produced no frames: ${JSON.stringify(castStatus)}`)
  const castStop = await driver.request('tab.screencast_stop', { owner: 's1' })
  assert.equal(castStop.active, false)
  assert.ok(castStop.frames > 0)
  // Screencast materialization is throttled (docs/HEADLESS.md §4.1.6): frames
  // are decoded and written at most every 100ms, and `stop` flushes the newest
  // frame synchronously. The on-disk artifact must therefore still be fresh,
  // valid, and internally consistent right after stop.
  const castFile = path.join(home, 'cache', 'dsh-chrome', 'screencast', 'latest.jpg')
  const castMetaPath = path.join(home, 'cache', 'dsh-chrome', 'screencast', 'meta.json')
  assert.ok(fs.existsSync(castFile), 'screencast stop left no latest.jpg')
  const castBytes = fs.readFileSync(castFile)
  assert.ok(
    castBytes.length > 2 && castBytes[0] === 0xff && castBytes[1] === 0xd8,
    `screencast frame is not a JPEG (${castBytes.length} bytes)`,
  )
  const castMeta = JSON.parse(fs.readFileSync(castMetaPath, 'utf8'))
  assert.equal(castMeta.bytes, castBytes.length, `meta.json bytes do not match latest.jpg: ${JSON.stringify(castMeta)}`)
  assert.ok(castMeta.frames > 0, `meta.json lost the frame counter: ${JSON.stringify(castMeta)}`)
  assert.ok(
    castMeta.frames <= castStop.frames,
    `meta.json counted more frames than the stream: ${JSON.stringify({ meta: castMeta.frames, stop: castStop.frames })}`,
  )
  assert.ok(
    Date.now() - castMeta.updatedAt < 5000,
    `throttled screencast left a stale frame on disk: ${JSON.stringify(castMeta)}`,
  )

  console.log('HEADLESS TEST: PASS')
} finally {
  await driver.close()
  server.close()
  await new Promise((resolve) => setTimeout(resolve, 300))
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch {
    // the headless profile is a temp dir; leaking it on cleanup is harmless
  }
}
