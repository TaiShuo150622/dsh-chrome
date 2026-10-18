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
