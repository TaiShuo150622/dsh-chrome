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
</body></html>`

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(page)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-headless-test-'))
const driver = new HeadlessDriver({ home })
try {
  await driver.ensureStarted()
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
