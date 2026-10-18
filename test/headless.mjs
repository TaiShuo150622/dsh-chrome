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
  await driver.request('tab.click', { owner: 's1', ref: downloadLink.ref })
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
