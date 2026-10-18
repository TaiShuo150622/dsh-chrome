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
  // Timing assertions protect the *contract* (no 40ms wait), but this machine can
  // be under heavy external load. Scale the wall-clock ceiling with loadavg while
  // the repaintMisses/frame/bytes assertions keep the semantic contract strict.
  const timingBudget = (ms) => {
    const load = os.loadavg()[0]
    const factor = load > 2 ? Math.min(20, load / 2) : 1
    return ms * factor
  }
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
  // Let the compositor publish the canvas paint before the conservative capture;
  // under load the screenshot can otherwise race the frame and read stale pixels.
  await settle(250)
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
  // Keyboard press (docs/HEADLESS.md §4.1.12): a key with no UA default action
  // outside an editable field keeps the previous change marker when the tracker
  // sees no page change, so the next screenshot is a cache hit. Scrolling/
  // activation/modifier keys, editable focus, a non-collapsed selection, a
  // closed shadow root and any tracker counter movement keep the conservative
  // wait.
  await driver.request('tab.evaluate', { owner: 's1', expression: 'document.activeElement?.blur()' })
  await driver.request('tab.screenshot', { owner: 's1' })
  await settle(300)
  const pressBaselineShot = await driver.request('tab.screenshot', { owner: 's1' })
  const pressBaselineBytes = fs.readFileSync(pressBaselineShot.path)
  const pressBaseDiag = await tabDiag()
  const pressStartedAt = performance.now()
  await driver.request('tab.press', { owner: 's1', key: 'Escape' })
  const pressEscapeShot = await driver.request('tab.screenshot', { owner: 's1' })
  const pressEscapeMs = performance.now() - pressStartedAt
  const pressEscapeDiag = await tabDiag()
  assert.equal(
    pressEscapeDiag.visualSkips,
    pressBaseDiag.visualSkips + 1,
    `no-op Escape press did not skip the repaint window: ${JSON.stringify({ before: pressBaseDiag.visualSkips, after: pressEscapeDiag.visualSkips })}`,
  )
  // A stray compositor frame can advance the frame counter on an otherwise idle
  // page, so the contract is measured directly: no repaint-miss (that is the
  // 40ms window), a cache-hit latency, and the same bytes.
  assert.equal(
    pressEscapeDiag.screenshotStream.repaintMisses,
    pressBaseDiag.screenshotStream.repaintMisses,
    'no-op Escape press ran into the repaint window',
  )
  assert.ok(pressEscapeMs < timingBudget(25), `no-op Escape press paid the repaint window (${pressEscapeMs.toFixed(1)}ms)`)
  assert.deepEqual(fs.readFileSync(pressEscapeShot.path), pressBaselineBytes, 'no-op Escape press must reuse the cached frame')
  // A printable character with no editable focus is equally paint-free.
  const printableBaseDiag = await tabDiag()
  await driver.request('tab.press', { owner: 's1', key: 'k' })
  const printableShot = await driver.request('tab.screenshot', { owner: 's1' })
  const printableDiag = await tabDiag()
  assert.equal(printableDiag.visualSkips, printableBaseDiag.visualSkips + 1, 'printable press with body focus did not skip the repaint window')
  assert.deepEqual(fs.readFileSync(printableShot.path), pressBaselineBytes, 'printable press must reuse the cached frame')
  // A focused button is not editable, so a printable key still qualifies; Enter
  // can activate the control, so it must not.
  await driver.request('tab.evaluate', { owner: 's1', expression: 'document.getElementById("go").focus()' })
  await driver.request('tab.screenshot', { owner: 's1' })
  await settle()
  const buttonFocusBase = await tabDiag()
  await driver.request('tab.press', { owner: 's1', key: 'k' })
  const buttonFocusDiag = await tabDiag()
  assert.equal(buttonFocusDiag.visualSkips, buttonFocusBase.visualSkips + 1, 'printable press on a focused button did not skip the repaint window')
  await driver.request('tab.press', { owner: 's1', key: 'Enter' })
  const buttonEnterDiag = await tabDiag()
  assert.equal(buttonEnterDiag.visualSkips, buttonFocusBase.visualSkips + 1, 'Enter on a focused control must keep the conservative wait')
  // Scrolling keys and modifiers keep the wait: the compositor scroll can land
  // after the after-snapshot.
  await driver.request('tab.evaluate', { owner: 's1', expression: 'document.activeElement?.blur()' })
  const arrowBaseDiag = await tabDiag()
  await driver.request('tab.press', { owner: 's1', key: 'ArrowDown' })
  await driver.request('tab.screenshot', { owner: 's1' })
  const arrowDiag = await tabDiag()
  assert.equal(arrowDiag.visualSkips, arrowBaseDiag.visualSkips, 'a scrolling key must keep the conservative wait')
  const shiftBaseDiag = await tabDiag()
  await driver.request('tab.press', { owner: 's1', key: 'Shift' })
  const shiftDiag = await tabDiag()
  assert.equal(shiftDiag.visualSkips, shiftBaseDiag.visualSkips, 'a modifier key must keep the conservative wait')
  // Editable focus: a keystroke can move a caret or change a value without any
  // DOM mutation, so both a printable key and Escape keep the wait.
  await driver.request('tab.evaluate', { owner: 's1', expression: 'document.getElementById("name").focus()' })
  await driver.request('tab.screenshot', { owner: 's1' })
  await settle()
  const editableBaseDiag = await tabDiag()
  for (const key of ['k', 'Escape']) {
    await driver.request('tab.press', { owner: 's1', key })
    const editableDiag = await tabDiag()
    assert.equal(
      editableDiag.visualSkips,
      editableBaseDiag.visualSkips,
      `a press over an editable focus (${key}) must keep the conservative wait`,
    )
  }
  await driver.request('tab.evaluate', { owner: 's1', expression: 'document.activeElement?.blur()' })
  // A non-collapsed document selection can be replaced by a key inside an
  // editable, and collapsing it is a repaint: keep the wait while one exists.
  await driver.request('tab.screenshot', { owner: 's1' })
  await settle()
  await driver.request('tab.evaluate', {
    owner: 's1',
    expression:
      '(() => { const range = document.createRange(); range.selectNodeContents(document.getElementById("out")); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); return String(selection) })()',
  })
  await driver.request('tab.screenshot', { owner: 's1' })
  await settle()
  const selectionBaseDiag = await tabDiag()
  await driver.request('tab.press', { owner: 's1', key: 'k' })
  const selectionDiag = await tabDiag()
  assert.equal(selectionDiag.visualSkips, selectionBaseDiag.visualSkips, 'a press with a non-collapsed selection must keep the conservative wait')
  await driver.request('tab.evaluate', { owner: 's1', expression: 'getSelection().removeAllRanges()' })
  await driver.request('tab.screenshot', { owner: 's1' })
  await settle()
  const clearedSelectionShot = await driver.request('tab.screenshot', { owner: 's1' })
  const clearedSelectionBytes = fs.readFileSync(clearedSelectionShot.path)
  const clearedSelectionBase = await tabDiag()
  await driver.request('tab.press', { owner: 's1', key: 'k' })
  const clearedSelectionShot2 = await driver.request('tab.screenshot', { owner: 's1' })
  const clearedSelectionDiag = await tabDiag()
  assert.equal(
    clearedSelectionDiag.visualSkips,
    clearedSelectionBase.visualSkips + 1,
    'the shortcut did not come back after clearing the selection',
  )
  assert.deepEqual(fs.readFileSync(clearedSelectionShot2.path), clearedSelectionBytes, 'press after clearing the selection must reuse the cached frame')
  // Escape closing a modal dialog is a UA default action whose effect is a DOM
  // mutation (the `open` attribute): the tracker must see it and keep the wait.
  await driver.request('tab.evaluate', {
    owner: 's1',
    expression:
      '(() => { const dialog = document.createElement("dialog"); dialog.id = "probe-dialog"; dialog.textContent = "probe dialog"; document.body.append(dialog); dialog.showModal(); return dialog.open })()',
  })
  await driver.request('tab.screenshot', { owner: 's1' })
  await settle()
  const dialogBaseDiag = await tabDiag()
  await driver.request('tab.press', { owner: 's1', key: 'Escape' })
  const dialogDiag = await tabDiag()
  assert.equal(dialogDiag.visualSkips, dialogBaseDiag.visualSkips, 'Escape on a modal dialog must keep the conservative wait')
  const dialogOpen = await driver.request('tab.evaluate', { owner: 's1', expression: 'document.getElementById("probe-dialog").open' })
  assert.equal(dialogOpen.value, false, 'Escape did not close the modal dialog')
  await driver.request('tab.evaluate', { owner: 's1', expression: 'document.getElementById("probe-dialog").remove()' })
  // Focus inside an open shadow root: document.activeElement is the host, so the
  // tracker must walk shadowRoot.activeElement to find the editable field.
  await driver.request('tab.evaluate', {
    owner: 's1',
    expression:
      '(() => { const host = document.createElement("div"); host.id = "probe-shadow-host"; document.body.append(host); const root = host.attachShadow({ mode: "open" }); const input = document.createElement("input"); input.id = "probe-shadow-input"; root.append(input); input.focus(); return document.activeElement.tagName })()',
  })
  await driver.request('tab.screenshot', { owner: 's1' })
  await settle()
  const shadowBaseDiag = await tabDiag()
  await driver.request('tab.press', { owner: 's1', key: 'k' })
  const shadowDiag = await tabDiag()
  assert.equal(shadowDiag.visualSkips, shadowBaseDiag.visualSkips, 'an editable inside an open shadow root must keep the conservative wait')
  await driver.request('tab.evaluate', { owner: 's1', expression: 'document.activeElement?.blur(); document.getElementById("probe-shadow-host").remove()' })
  // A closed shadow root cannot be inspected, so a focused custom element (the
  // likely host) keeps the wait instead of guessing that it is not editable.
  await driver.request('tab.evaluate', {
    owner: 's1',
    expression:
      '(() => { const host = document.createElement("x-probe-closed"); host.setAttribute("tabindex", "0"); document.body.append(host); const root = host.attachShadow({ mode: "closed" }); const input = document.createElement("input"); input.id = "probe-closed-input"; root.append(input); input.focus(); return document.activeElement.tagName })()',
  })
  await driver.request('tab.screenshot', { owner: 's1' })
  await settle()
  const closedBaseDiag = await tabDiag()
  await driver.request('tab.press', { owner: 's1', key: 'k' })
  const closedDiag = await tabDiag()
  assert.equal(closedDiag.visualSkips, closedBaseDiag.visualSkips, 'a focused custom element must keep the conservative wait (closed shadow root)')
  await driver.request('tab.evaluate', { owner: 's1', expression: 'document.activeElement?.blur(); document.querySelector("x-probe-closed").remove()' })
  // A page key handler that mutates the DOM is a paint source: the probe must
  // see the mutation and the screenshot must be fresh.
  await driver.request('tab.evaluate', {
    owner: 's1',
    expression:
      '(() => { window.__pressProbeKey = (event) => { if (event.key === "z") document.getElementById("out").textContent = "key-" + Date.now() }; document.addEventListener("keydown", window.__pressProbeKey); return true })()',
  })
  await driver.request('tab.screenshot', { owner: 's1' })
  await settle()
  const handlerBaseShot = await driver.request('tab.screenshot', { owner: 's1' })
  const handlerBaseBytes = fs.readFileSync(handlerBaseShot.path)
  const handlerBaseDiag = await tabDiag()
  // `tab.text` is not probe-covered, so reading the value cannot move the
  // visualSkips counter this assertion is about.
  const outBeforePress = (await driver.request('tab.text', { owner: 's1', selector: '#out' })).text
  await driver.request('tab.press', { owner: 's1', key: 'z' })
  const handlerShot = await driver.request('tab.screenshot', { owner: 's1' })
  const handlerDiag = await tabDiag()
  const outAfterPress = (await driver.request('tab.text', { owner: 's1', selector: '#out' })).text
  assert.notEqual(outAfterPress, outBeforePress, 'the key handler did not run')
  assert.equal(handlerDiag.visualSkips, handlerBaseDiag.visualSkips, 'a DOM-mutating key handler must keep the conservative wait')
  assert.notDeepEqual(fs.readFileSync(handlerShot.path), handlerBaseBytes, 'a DOM-mutating key handler must not be stale')
  await driver.request('tab.evaluate', { owner: 's1', expression: 'document.removeEventListener("keydown", window.__pressProbeKey); delete window.__pressProbeKey' })

  // Real pointer clicks (docs/HEADLESS.md §4.1.13): a single left click at a
  // point where the pointer already rests, over a target no UA default action
  // can reach, cannot paint, so the next screenshot is a cache hit. Everything
  // that can make the UA move state without a tracker counter keeps the
  // conservative wait: the pointer moving onto another element (the CSS :hover
  // chain changes), a focused control, a non-collapsed selection, a double
  // click (it selects text) and targets the UA can activate (button, anchor,
  // input, tabindex widget). The hover case is the one that would otherwise be
  // served stale, so it is asserted down to the frame bytes.
  await driver.request('tab.evaluate', {
    owner: 's1',
    expression: 'window.scrollTo(0, 0); document.activeElement?.blur(); getSelection().removeAllRanges()',
  })
  await driver.request('tab.evaluate', {
    owner: 's1',
    expression:
      '(() => { const style = document.createElement("style"); style.id = "probe-hover-style"; style.textContent = "#hover-probe:hover { background: #f00 }"; document.head.append(style); const div = document.createElement("div"); div.id = "hover-probe"; div.style.cssText = "padding:6px;border:1px solid #999;width:120px"; div.textContent = "hover probe"; document.getElementById("noop").insertAdjacentElement("afterend", div); return true })()',
  })
  const rectOf = async (selector) =>
    (
      await driver.request('tab.evaluate', {
        owner: 's1',
        expression: `(() => { const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2), inside: box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth } })()`,
      })
    ).value
  const noopCentre = await rectOf('#noop')
  const outCentre = await rectOf('#out')
  const buttonCentre = await rectOf('#go')
  const linkCentre = await rectOf('#download')
  const fieldCentre = await rectOf('#name')
  const tabindexCentre = await rectOf('#drag-src')
  const hoverStyleCentre = await rectOf('#hover-probe')
  assert.ok(
    noopCentre.inside && outCentre.inside && buttonCentre.inside && linkCentre.inside && fieldCentre.inside && tabindexCentre.inside && hoverStyleCentre.inside,
    `clickAt probe targets left the viewport: ${JSON.stringify({ noopCentre, outCentre, buttonCentre, linkCentre, fieldCentre, tabindexCentre, hoverStyleCentre })}`,
  )
  // A pending compose from an earlier action can land at any time; wait until
  // two consecutive screenshots agree, so a byte comparison measures the click
  // under test instead of a late frame.
  const stableFrameBytes = async () => {
    let previous = await driver.request('tab.screenshot', { owner: 's1' })
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await settle()
      const next = await driver.request('tab.screenshot', { owner: 's1' })
      if (fs.readFileSync(next.path).equals(fs.readFileSync(previous.path))) return fs.readFileSync(next.path)
      previous = next
    }
    throw new Error('the page never settled: consecutive screenshots keep changing')
  }
  // Parking the pointer on #noop changes the hover chain, so that click keeps
  // the conservative wait. Settle the earlier paints first: a frame that is
  // still in flight when the click lands would satisfy its marker, and this
  // block needs the marker to be genuinely pending.
  const parkBaseBytes = await stableFrameBytes()
  const clickAtParkBase = await tabDiag()
  await driver.request('tab.clickAt', { owner: 's1', x: noopCentre.x, y: noopCentre.y })
  const clickAtParkDiag = await tabDiag()
  assert.equal(clickAtParkDiag.visualSkips, clickAtParkBase.visualSkips, 'the click that moves the pointer must keep the conservative wait')
  // That conservative click bumped the change marker without painting, so the
  // next screenshot has to pay the repaint window — but only once. The miss
  // retires the marker (docs/HEADLESS.md §4.1.14); the screenshots after it must
  // reuse the frame the miss served instead of paying the same window again.
  const parkMissBefore = clickAtParkBase.screenshotStream.repaintMisses
  const parkRetireBefore = clickAtParkBase.renderChangeRetires
  assert.ok(
    Number.isFinite(parkRetireBefore),
    `the driver does not report retired change markers: ${JSON.stringify(clickAtParkBase)}`,
  )
  await driver.request('tab.screenshot', { owner: 's1' })
  const parkShot1Diag = await tabDiag()
  assert.equal(
    parkShot1Diag.screenshotStream.repaintMisses,
    parkMissBefore + 1,
    'the conservative paint-free click did not pay the repaint window once',
  )
  assert.equal(parkShot1Diag.renderChangeRetires, parkRetireBefore + 1, 'a repaint-window miss did not retire the change marker')
  const parkShot2StartedAt = performance.now()
  const parkShot2 = await driver.request('tab.screenshot', { owner: 's1' })
  const parkShot2Ms = performance.now() - parkShot2StartedAt
  const parkShot2Diag = await tabDiag()
  assert.equal(
    parkShot2Diag.screenshotStream.repaintMisses,
    parkShot1Diag.screenshotStream.repaintMisses,
    'the retired change marker made the next screenshot pay the repaint window again (amplification)',
  )
  assert.ok(parkShot2Ms < timingBudget(15), `a screenshot after a retired marker paid the repaint window (${parkShot2Ms.toFixed(1)}ms)`)
  assert.deepEqual(fs.readFileSync(parkShot2.path), parkBaseBytes, 'a screenshot after a retired marker returned a different frame')
  // A proven paint-free action retires an older marker too, once that marker is
  // older than the window the driver grants anyway: move the pointer onto
  // #out with a conservative click (new pending marker), wait past the window,
  // then run a read-only evaluate. Its clean verdict must let the screenshot
  // hit the cache instead of waiting for a frame the marker cannot produce.
  await driver.request('tab.clickAt', { owner: 's1', x: outCentre.x, y: outCentre.y })
  await settle()
  const cleanRetireBase = await tabDiag()
  await driver.request('tab.evaluate', { owner: 's1', expression: 'document.getElementById("out").textContent' })
  const cleanShotStartedAt = performance.now()
  const cleanShot = await driver.request('tab.screenshot', { owner: 's1' })
  const cleanShotMs = performance.now() - cleanShotStartedAt
  const cleanShotDiag = await tabDiag()
  assert.equal(
    cleanShotDiag.screenshotStream.repaintMisses,
    cleanRetireBase.screenshotStream.repaintMisses,
    'a proven paint-free action past the repaint window still waited for a frame',
  )
  assert.ok(
    cleanShotDiag.renderChangeRetires > cleanRetireBase.renderChangeRetires,
    'a proven paint-free action did not retire the stale change marker',
  )
  assert.ok(cleanShotMs < timingBudget(15), `the screenshot after a clean action paid the repaint window (${cleanShotMs.toFixed(1)}ms)`)
  assert.ok(fs.readFileSync(cleanShot.path).length > 128, 'the screenshot after a clean action returned no frame')
  // A DOM mutation after a retirement still owns the marker: the screenshot
  // must wait for and return the new paint, not the retired frame.
  const retiredFrameBytes = fs.readFileSync(cleanShot.path)
  await driver.request('tab.evaluate', { owner: 's1', expression: 'document.getElementById("out").textContent = "post-retire"' })
  const afterRetireMutationShot = await driver.request('tab.screenshot', { owner: 's1' })
  assert.notDeepEqual(
    fs.readFileSync(afterRetireMutationShot.path),
    retiredFrameBytes,
    'a DOM mutation after a marker retirement was served stale',
  )
  // Back to #noop for the cache-hit assertions below: that pointer move is
  // conservative again, so one screenshot pays the window and retires it.
  await driver.request('tab.clickAt', { owner: 's1', x: noopCentre.x, y: noopCentre.y })
  await settle()
  await driver.request('tab.screenshot', { owner: 's1' })
  const clickAtBaseBytes = await stableFrameBytes()
  const clickAtBaseDiag = await tabDiag()
  const clickAtStartedAt = performance.now()
  await driver.request('tab.clickAt', { owner: 's1', x: noopCentre.x, y: noopCentre.y })
  const clickAtShot = await driver.request('tab.screenshot', { owner: 's1' })
  const clickAtMs = performance.now() - clickAtStartedAt
  const clickAtDiag = await tabDiag()
  assert.equal(
    clickAtDiag.visualSkips,
    clickAtBaseDiag.visualSkips + 1,
    `a repeated click at the same point did not skip the repaint window: ${JSON.stringify({ before: clickAtBaseDiag.visualSkips, after: clickAtDiag.visualSkips })}`,
  )
  assert.equal(
    clickAtDiag.screenshotStream.repaintMisses,
    clickAtBaseDiag.screenshotStream.repaintMisses,
    'a repeated click at the same point ran into the repaint window',
  )
  assert.ok(clickAtMs < 25, `a repeated click at the same point paid the repaint window (${clickAtMs.toFixed(1)}ms)`)
  assert.deepEqual(fs.readFileSync(clickAtShot.path), clickAtBaseBytes, 'a repeated click at the same point must reuse the cached frame')
  // The hover chain is the paint source no tracker counter records: the first
  // click onto a :hover-styled element must keep the wait AND produce the new
  // paint, and the repeat must skip while returning that hovered frame.
  const hoverStylePreBytes = await stableFrameBytes()
  const hoverStyleBaseDiag = await tabDiag()
  await driver.request('tab.clickAt', { owner: 's1', x: hoverStyleCentre.x, y: hoverStyleCentre.y })
  const hoverStyleClickDiag = await tabDiag()
  const hoverStyleShot = await driver.request('tab.screenshot', { owner: 's1' })
  assert.equal(hoverStyleClickDiag.visualSkips, hoverStyleBaseDiag.visualSkips, 'the click that applies a hover style must keep the conservative wait')
  assert.notDeepEqual(fs.readFileSync(hoverStyleShot.path), hoverStylePreBytes, 'a hover repaint must not be served from the cache')
  await settle()
  const hoverStyleSettledBytes = await stableFrameBytes()
  const hoverStyleRepeatBaseDiag = await tabDiag()
  const hoverStyleRepeatStartedAt = performance.now()
  await driver.request('tab.clickAt', { owner: 's1', x: hoverStyleCentre.x, y: hoverStyleCentre.y })
  const hoverStyleRepeatShot = await driver.request('tab.screenshot', { owner: 's1' })
  const hoverStyleRepeatMs = performance.now() - hoverStyleRepeatStartedAt
  const hoverStyleRepeatDiag = await tabDiag()
  assert.equal(
    hoverStyleRepeatDiag.visualSkips,
    hoverStyleRepeatBaseDiag.visualSkips + 1,
    'the repeat click on the already-hovered element did not skip the repaint window',
  )
  assert.ok(hoverStyleRepeatMs < 25, `the repeat click on the hovered element paid the repaint window (${hoverStyleRepeatMs.toFixed(1)}ms)`)
  assert.deepEqual(fs.readFileSync(hoverStyleRepeatShot.path), hoverStyleSettledBytes, 'the shortcut must return the hovered frame, not the pre-hover one')
  // Everything below only asserts the conservative path (no skip): a paint can
  // land late, so frame bytes are not compared here.
  // A double click selects text, so it keeps the wait even at the same point.
  const doubleClickBaseDiag = await tabDiag()
  await driver.request('tab.clickAt', { owner: 's1', x: hoverStyleCentre.x, y: hoverStyleCentre.y, clickCount: 2 })
  const doubleClickDiag = await tabDiag()
  assert.equal(doubleClickDiag.visualSkips, doubleClickBaseDiag.visualSkips, 'a double click must keep the conservative wait')
  await driver.request('tab.evaluate', { owner: 's1', expression: 'getSelection().removeAllRanges()' })
  // Moving the pointer onto another element is the hover hazard again.
  const awayBaseDiag = await tabDiag()
  await driver.request('tab.clickAt', { owner: 's1', x: noopCentre.x, y: noopCentre.y })
  const awayDiag = await tabDiag()
  assert.equal(awayDiag.visualSkips, awayBaseDiag.visualSkips, 'a click that moves the pointer onto another element must keep the conservative wait')
  // The click after that has a settled hover chain again, so the pointer veto
  // must not have been a permanent one.
  const settledAgainBaseDiag = await tabDiag()
  await driver.request('tab.clickAt', { owner: 's1', x: noopCentre.x, y: noopCentre.y })
  const settledAgainDiag = await tabDiag()
  assert.equal(settledAgainDiag.visualSkips, settledAgainBaseDiag.visualSkips + 1, 'the shortcut did not come back once the pointer stopped moving')
  // UA-reachable targets: every one of these can change state the tracker
  // cannot see (navigation, activation, focus, caret), so none may short-cut.
  // Each target is clicked twice so the second click has a settled hover chain
  // and only the target hazard can be what vetoes it.
  for (const [label, centre] of [
    ['button', buttonCentre],
    ['anchor', linkCentre],
    ['input', fieldCentre],
    ['tabindex widget', tabindexCentre],
  ]) {
    await driver.request('tab.clickAt', { owner: 's1', x: centre.x, y: centre.y })
    await settle()
    const beforeHazardDiag = await tabDiag()
    await driver.request('tab.clickAt', { owner: 's1', x: centre.x, y: centre.y })
    const afterHazardDiag = await tabDiag()
    assert.equal(afterHazardDiag.visualSkips, beforeHazardDiag.visualSkips, `a settled click on a ${label} must keep the conservative wait`)
  }
  // Focus on an editable field: clicking elsewhere blurs it, which repaints.
  await driver.request('tab.clickAt', { owner: 's1', x: noopCentre.x, y: noopCentre.y })
  await settle()
  await driver.request('tab.evaluate', { owner: 's1', expression: 'document.getElementById("name").focus()' })
  const focusBaseDiag = await tabDiag()
  await driver.request('tab.clickAt', { owner: 's1', x: noopCentre.x, y: noopCentre.y })
  const focusClickDiag = await tabDiag()
  assert.equal(focusClickDiag.visualSkips, focusBaseDiag.visualSkips, 'a click that blurs a focused field must keep the conservative wait')
  await driver.request('tab.evaluate', { owner: 's1', expression: 'document.activeElement?.blur()' })
  // A non-collapsed selection is collapsed by a click: keep the wait while one
  // exists, and let the shortcut come back once it is cleared.
  await driver.request('tab.evaluate', {
    owner: 's1',
    expression:
      '(() => { const range = document.createRange(); range.selectNodeContents(document.getElementById("out")); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); return String(selection) })()',
  })
  await driver.request('tab.screenshot', { owner: 's1' })
  await settle()
  const selectionClickBase = await tabDiag()
  await driver.request('tab.clickAt', { owner: 's1', x: noopCentre.x, y: noopCentre.y })
  const selectionClickDiag = await tabDiag()
  assert.equal(selectionClickDiag.visualSkips, selectionClickBase.visualSkips, 'a click with a non-collapsed selection must keep the conservative wait')
  await driver.request('tab.evaluate', { owner: 's1', expression: 'getSelection().removeAllRanges()' })
  await driver.request('tab.screenshot', { owner: 's1' })
  await settle()
  const recoveredBaseDiag = await tabDiag()
  await driver.request('tab.clickAt', { owner: 's1', x: noopCentre.x, y: noopCentre.y })
  const recoveredDiag = await tabDiag()
  assert.equal(recoveredDiag.visualSkips, recoveredBaseDiag.visualSkips + 1, 'the shortcut did not come back after clearing the selection')
  await driver.request('tab.evaluate', {
    owner: 's1',
    expression: 'document.getElementById("hover-probe")?.remove(); document.getElementById("probe-hover-style")?.remove(); window.scrollTo(0, 0)',
  })

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

  // Synthetic drag probe (docs/HEADLESS.md §4.1.15). `tab.drag` dispatches
  // DragEvents only; the UA performs no drag-and-drop default action for
  // untrusted events, so a drag whose handlers leave every tracker counter
  // untouched cannot have painted and must keep the frame marker. The opposite
  // cases are asserted right after it: a drop handler that mutates the DOM owes
  // a new frame, and a canvas anywhere on the page disables the shortcut.
  await driver.request('tab.screenshot', { owner: 's1' })
  await settle()
  const dragBaseBytes = await stableFrameBytes()
  const dragBaseDiag = await tabDiag()
  const dragSkipStartedAt = performance.now()
  const dragSkip = await driver.request('tab.drag', { owner: 's1', fromRef: dragSrc.ref, toRef: dropTarget.ref })
  assert.equal(dragSkip.ok, true)
  const dragSkipShot = await driver.request('tab.screenshot', { owner: 's1' })
  const dragSkipMs = performance.now() - dragSkipStartedAt
  const dragSkipDiag = await tabDiag()
  assert.equal(
    dragSkipDiag.visualSkips,
    dragBaseDiag.visualSkips + 1,
    `a handler-free drag did not skip the repaint window: ${JSON.stringify({ before: dragBaseDiag.visualSkips, after: dragSkipDiag.visualSkips })}`,
  )
  assert.equal(
    dragSkipDiag.screenshotStream.repaintMisses,
    dragBaseDiag.screenshotStream.repaintMisses,
    'a handler-free drag ran into the repaint window',
  )
  assert.ok(dragSkipMs < 25, `a handler-free drag + screenshot paid the repaint window (${dragSkipMs.toFixed(1)}ms)`)
  assert.deepEqual(fs.readFileSync(dragSkipShot.path), dragBaseBytes, 'a handler-free drag returned a different frame')

  // Canvas pixels repaint with no DOM mutation, so the probe must veto the
  // shortcut: the drag keeps the marker and the screenshot pays the window once.
  await driver.request('tab.evaluate', {
    owner: 's1',
    expression:
      '(() => { const c = document.createElement("canvas"); c.id = "drag-probe-canvas"; c.width = 40; c.height = 10; document.body.appendChild(c); return true })()',
  })
  await settle()
  await driver.request('tab.screenshot', { owner: 's1' })
  await settle()
  const canvasDragBaseDiag = await tabDiag()
  await driver.request('tab.drag', { owner: 's1', fromRef: dragSrc.ref, toRef: dropTarget.ref })
  const canvasDragDiag = await tabDiag()
  assert.equal(
    canvasDragDiag.visualSkips,
    canvasDragBaseDiag.visualSkips,
    'a page with a canvas must keep the conservative wait for drags',
  )
  await driver.request('tab.screenshot', { owner: 's1' })
  const canvasDragShotDiag = await tabDiag()
  assert.equal(
    canvasDragShotDiag.screenshotStream.repaintMisses,
    canvasDragBaseDiag.screenshotStream.repaintMisses + 1,
    'the vetoed drag did not pay the repaint window once',
  )
  await driver.request('tab.evaluate', { owner: 's1', expression: 'document.getElementById("drag-probe-canvas").remove()' })
  await settle()
  await driver.request('tab.screenshot', { owner: 's1' })
  await settle()

  // A drop handler that mutates the DOM is a real paint: the drag must not
  // short-cut and the screenshot must return the NEW frame.
  await driver.request('tab.evaluate', {
    owner: 's1',
    expression: `(() => {
      const target = document.getElementById('drop-target')
      target.addEventListener('drop', (event) => {
        event.preventDefault()
        const row = document.createElement('span')
        row.textContent = 'dropped'
        target.appendChild(row)
      })
      return true
    })()`,
  })
  const dragMutationBaseBytes = await stableFrameBytes()
  const dragMutationBaseDiag = await tabDiag()
  await driver.request('tab.drag', { owner: 's1', fromRef: dragSrc.ref, toRef: dropTarget.ref })
  const dragMutationDiag = await tabDiag()
  assert.equal(
    dragMutationDiag.visualSkips,
    dragMutationBaseDiag.visualSkips,
    'a drag whose drop handler mutates the DOM must keep the conservative wait',
  )
  const dragMutationShot = await driver.request('tab.screenshot', { owner: 's1' })
  assert.notDeepEqual(
    fs.readFileSync(dragMutationShot.path),
    dragMutationBaseBytes,
    'a DOM-mutating drag was served a stale frame',
  )

  // Same-value re-types (docs/HEADLESS.md §4.1.16). `tab.type` writes the field
  // and dispatches the events a keystroke would, but repeating the value that is
  // already there leaves the value, the focus and the caret untouched, so the
  // next screenshot must reuse the cached frame instead of paying the repaint
  // window. Everything that does change something keeps the conservative wait:
  // a new value, a focus move, a `submit` and a contenteditable write.
  await driver.request('tab.evaluate', { owner: 's1', expression: 'document.activeElement?.blur()' })
  await driver.request('tab.screenshot', { owner: 's1' })
  await settle()
  const typeSnap = await driver.request('tab.snapshot', { owner: 's1', maxChars: 5000 })
  const typeInput = typeSnap.controls.find((control) => control.label === 'name')
  assert.ok(typeInput, `type probe input missing: ${JSON.stringify(typeSnap.controls)}`)
  // The first type moves focus into the field and changes its value: a real
  // paint, so the base frame is taken after it has landed.
  await driver.request('tab.type', { owner: 's1', ref: typeInput.ref, text: 'same', replace: true })
  await driver.request('tab.screenshot', { owner: 's1' })
  await settle()
  const typeBaseBytes = await stableFrameBytes()
  const typeBaseDiag = await tabDiag()
  const typeSameStartedAt = performance.now()
  const typeSame = await driver.request('tab.type', { owner: 's1', ref: typeInput.ref, text: 'same', replace: true })
  const typeSameShot = await driver.request('tab.screenshot', { owner: 's1' })
  const typeSameMs = performance.now() - typeSameStartedAt
  const typeSameDiag = await tabDiag()
  assert.equal(typeSame.value, 'same', 'a same-value type changed the field value')
  assert.equal(
    typeSameDiag.visualSkips,
    typeBaseDiag.visualSkips + 1,
    `a same-value type did not skip the repaint window: ${JSON.stringify({ before: typeBaseDiag.visualSkips, after: typeSameDiag.visualSkips })}`,
  )
  assert.equal(
    typeSameDiag.screenshotStream.repaintMisses,
    typeBaseDiag.screenshotStream.repaintMisses,
    'a same-value type ran into the repaint window',
  )
  assert.ok(typeSameMs < 25, `a same-value type + screenshot paid the repaint window (${typeSameMs.toFixed(1)}ms)`)
  assert.deepEqual(fs.readFileSync(typeSameShot.path), typeBaseBytes, 'a same-value type returned a different frame')
  // A new value is a real paint: the conservative wait stays and the screenshot
  // must show the new text. The replacement is deliberately the same length as
  // the old value, so the caret stays put and only the value comparison can
  // tell the type apart from a no-op (a length change would move the caret too
  // and hide a missing value check).
  const typeChange = await driver.request('tab.type', { owner: 's1', ref: typeInput.ref, text: 'SAME', replace: true })
  const typeChangeDiag = await tabDiag()
  assert.equal(typeChange.value, 'SAME')
  assert.equal(
    typeChangeDiag.visualSkips,
    typeSameDiag.visualSkips,
    'a value-changing type must keep the conservative wait',
  )
  const typeChangeShot = await driver.request('tab.screenshot', { owner: 's1' })
  assert.notDeepEqual(fs.readFileSync(typeChangeShot.path), typeBaseBytes, 'a value-changing type was served a stale frame')
  // A page with a canvas repaints pixels the tracker cannot see: the same-value
  // type must keep the wait there even though nothing changes in the DOM.
  await driver.request('tab.evaluate', {
    owner: 's1',
    expression: '(() => { const c = document.createElement("canvas"); c.id = "type-probe-canvas"; c.width = 40; c.height = 10; document.body.appendChild(c); return true })()',
  })
  await driver.request('tab.screenshot', { owner: 's1' })
  await settle()
  const canvasTypeBaseDiag = await tabDiag()
  const canvasType = await driver.request('tab.type', { owner: 's1', ref: typeInput.ref, text: 'SAME', replace: true })
  const canvasTypeDiag = await tabDiag()
  assert.equal(canvasType.value, 'SAME')
  assert.equal(
    canvasTypeDiag.visualSkips,
    canvasTypeBaseDiag.visualSkips,
    'a page with a canvas must keep the conservative wait for same-value types',
  )
  await driver.request('tab.screenshot', { owner: 's1' })
  const canvasTypeShotDiag = await tabDiag()
  assert.equal(
    canvasTypeShotDiag.screenshotStream.repaintMisses,
    canvasTypeBaseDiag.screenshotStream.repaintMisses + 1,
    'the vetoed same-value type did not pay the repaint window once',
  )
  await driver.request('tab.evaluate', { owner: 's1', expression: 'document.getElementById("type-probe-canvas").remove()' })
  await settle()
  await driver.request('tab.screenshot', { owner: 's1' })
  await settle()
  // The same value typed into an unfocused field still moves focus (and paints
  // the field's focus ring), so the page-side result must veto the shortcut.
  await driver.request('tab.evaluate', { owner: 's1', expression: 'document.activeElement?.blur()' })
  await driver.request('tab.screenshot', { owner: 's1' })
  await settle()
  const unfocusedTypeBaseDiag = await tabDiag()
  const unfocusedType = await driver.request('tab.type', { owner: 's1', ref: typeInput.ref, text: 'SAME', replace: true })
  const unfocusedTypeDiag = await tabDiag()
  assert.equal(unfocusedType.value, 'SAME')
  assert.equal(
    unfocusedTypeDiag.visualSkips,
    unfocusedTypeBaseDiag.visualSkips,
    'a type that moves focus must keep the conservative wait',
  )
  // `submit` can navigate after the after-snapshot, so it never shortcuts, even
  // when the value is unchanged.
  await driver.request('tab.screenshot', { owner: 's1' })
  await settle()
  const submitTypeBaseDiag = await tabDiag()
  const submitType = await driver.request('tab.type', { owner: 's1', ref: typeInput.ref, text: 'SAME', replace: true, submit: true })
  const submitTypeDiag = await tabDiag()
  assert.equal(submitType.submitted, true)
  assert.equal(submitTypeDiag.visualSkips, submitTypeBaseDiag.visualSkips, 'a submitted type must keep the conservative wait')
  await driver.request('tab.screenshot', { owner: 's1' })
  await settle()
  // A contenteditable write rebuilds the text node even for the same string:
  // that is a mutation, so it must keep the conservative wait.
  await driver.request('tab.evaluate', {
    owner: 's1',
    expression:
      '(() => { const box = document.createElement("div"); box.id = "type-probe-editable"; box.setAttribute("contenteditable", "true"); box.textContent = "editable text"; document.body.appendChild(box); return true })()',
  })
  await driver.request('tab.type', { owner: 's1', selector: '#type-probe-editable', text: 'editable text', replace: true })
  await driver.request('tab.screenshot', { owner: 's1' })
  await settle()
  const editableTypeBaseDiag = await tabDiag()
  const editableType = await driver.request('tab.type', { owner: 's1', selector: '#type-probe-editable', text: 'editable text', replace: true })
  const editableTypeDiag = await tabDiag()
  assert.equal(editableType.value, 'editable text')
  assert.equal(
    editableTypeDiag.visualSkips,
    editableTypeBaseDiag.visualSkips,
    'a same-text contenteditable write must keep the conservative wait',
  )
  await driver.request('tab.evaluate', { owner: 's1', expression: 'document.getElementById("type-probe-editable").remove()' })
  await settle()
  await driver.request('tab.screenshot', { owner: 's1' })
  await settle()

  // Same-value re-selects (docs/HEADLESS.md §4.1.17). `tab.select` dispatches
  // input/change whether or not the state moved, so choosing the option a select
  // already shows (or setting a checkbox to the state it already has) changes
  // nothing and cannot repaint: the next screenshot must reuse the cached frame
  // instead of paying the repaint window. A real value change, a canvas pixel
  // source and a page handler's work keep the conservative wait.
  // The earlier scroll/click blocks left the page scrolled far down; the select
  // sits at the top, and a viewport screenshot only shows a select repaint when
  // the control is inside the viewport.
  await driver.request('tab.scroll', { owner: 's1', direction: 'top' })
  await driver.request('tab.evaluate', { owner: 's1', expression: 'document.activeElement?.blur()' })
  await driver.request('tab.screenshot', { owner: 's1' })
  await settle()
  const selectSnap = await driver.request('tab.snapshot', { owner: 's1', maxChars: 5000 })
  const selectProbe = selectSnap.controls.find((control) => control.tag === 'select')
  const checkProbe = selectSnap.controls.find((control) => control.kind === 'checkbox')
  assert.ok(selectProbe && checkProbe, `select probe controls missing: ${JSON.stringify(selectSnap.controls)}`)
  // The select already holds "two" and the checkbox is checked from the
  // interaction block above; repeating them is a state no-op.
  const selectBaseBytes = await stableFrameBytes()
  const selectBaseDiag = await tabDiag()
  const selectSameStartedAt = performance.now()
  const selectSame = await driver.request('tab.select', { owner: 's1', ref: selectProbe.ref, value: 'two' })
  const selectSameShot = await driver.request('tab.screenshot', { owner: 's1' })
  const selectSameMs = performance.now() - selectSameStartedAt
  const selectSameDiag = await tabDiag()
  assert.equal(selectSame.value, 'two', 'a same-value select changed the selected option')
  assert.equal(
    selectSameDiag.visualSkips,
    selectBaseDiag.visualSkips + 1,
    `a same-value select did not skip the repaint window: ${JSON.stringify({ before: selectBaseDiag.visualSkips, after: selectSameDiag.visualSkips })}`,
  )
  assert.equal(
    selectSameDiag.screenshotStream.repaintMisses,
    selectBaseDiag.screenshotStream.repaintMisses,
    'a same-value select ran into the repaint window',
  )
  assert.ok(selectSameMs < 25, `a same-value select + screenshot paid the repaint window (${selectSameMs.toFixed(1)}ms)`)
  assert.deepEqual(fs.readFileSync(selectSameShot.path), selectBaseBytes, 'a same-value select returned a different frame')
  // The checkbox half of the same probe: an unchanged `checked` value.
  const checkSameStartedAt = performance.now()
  const checkSame = await driver.request('tab.select', { owner: 's1', ref: checkProbe.ref, checked: true })
  const checkSameShot = await driver.request('tab.screenshot', { owner: 's1' })
  const checkSameMs = performance.now() - checkSameStartedAt
  const checkSameDiag = await tabDiag()
  assert.equal(checkSame.value, 'true')
  assert.equal(
    checkSameDiag.visualSkips,
    selectSameDiag.visualSkips + 1,
    `a same-state checkbox did not skip the repaint window: ${JSON.stringify({ before: selectSameDiag.visualSkips, after: checkSameDiag.visualSkips })}`,
  )
  assert.ok(checkSameMs < 25, `a same-state checkbox + screenshot paid the repaint window (${checkSameMs.toFixed(1)}ms)`)
  assert.deepEqual(fs.readFileSync(checkSameShot.path), selectBaseBytes, 'a same-state checkbox returned a different frame')
  // A real option change keeps the conservative wait; the select's rendered
  // text changes, so the later frame must differ from the base one.
  const selectChange = await driver.request('tab.select', { owner: 's1', ref: selectProbe.ref, value: 'one' })
  const selectChangeDiag = await tabDiag()
  assert.equal(selectChange.value, 'one')
  assert.equal(
    selectChangeDiag.visualSkips,
    checkSameDiag.visualSkips,
    'a value-changing select must keep the conservative wait',
  )
  await new Promise((resolve) => setTimeout(resolve, 400))
  const selectChangeBytes = await stableFrameBytes()
  assert.notDeepEqual(selectChangeBytes, selectBaseBytes, 'a value-changing select was served a stale frame')
  // Toggling the checkbox is a real change too.
  const checkToggle = await driver.request('tab.select', { owner: 's1', ref: checkProbe.ref, checked: false })
  const checkToggleDiag = await tabDiag()
  assert.equal(checkToggle.value, 'false')
  assert.equal(
    checkToggleDiag.visualSkips,
    selectChangeDiag.visualSkips,
    'a checkbox toggle must keep the conservative wait',
  )
  await driver.request('tab.screenshot', { owner: 's1' })
  await settle()
  // Canvas pixels repaint with no DOM mutation the tracker can see: the
  // same-value select must keep the wait there.
  await driver.request('tab.evaluate', {
    owner: 's1',
    expression: '(() => { const c = document.createElement("canvas"); c.id = "select-probe-canvas"; c.width = 40; c.height = 10; document.body.appendChild(c); return true })()',
  })
  await driver.request('tab.screenshot', { owner: 's1' })
  await settle()
  const canvasSelectBaseDiag = await tabDiag()
  const canvasSelect = await driver.request('tab.select', { owner: 's1', ref: selectProbe.ref, value: 'one' })
  const canvasSelectDiag = await tabDiag()
  assert.equal(canvasSelect.value, 'one')
  assert.equal(
    canvasSelectDiag.visualSkips,
    canvasSelectBaseDiag.visualSkips,
    'a page with a canvas must keep the conservative wait for same-value selects',
  )
  await driver.request('tab.screenshot', { owner: 's1' })
  const canvasSelectShotDiag = await tabDiag()
  assert.equal(
    canvasSelectShotDiag.screenshotStream.repaintMisses,
    canvasSelectBaseDiag.screenshotStream.repaintMisses + 1,
    'the vetoed same-value select did not pay the repaint window once',
  )
  await driver.request('tab.evaluate', { owner: 's1', expression: 'document.getElementById("select-probe-canvas").remove()' })
  await driver.request('tab.screenshot', { owner: 's1' })
  await settle()

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
