import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

import { HeadlessDriver } from '../src/headless.js'

const page = `<!doctype html><html><head><title>Overlay Test</title></head><body>
<h1>Overlay Test Page</h1>
<p>Highlight this sentence for the annotation test.</p>
<button>Action</button>
<input placeholder="field">
<iframe id="child" srcdoc="<button id='frame-btn'>Frame Button</button><p>Frame text</p>"></iframe>
</body></html>`

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(page)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-overlay-test-'))
const driver = new HeadlessDriver({ home })
const overlay = (params) => driver.request('tab.overlay', { owner: 's1', ...params })

try {
  await driver.ensureStarted()
  await driver.request('tab.goto', { owner: 's1', url: `http://127.0.0.1:${port}/` })
  const baseShot = await driver.request('tab.screenshot', { owner: 's1' })

  const pointer = await overlay({ op: 'pointer', selector: 'h1', label: 'DSH', pulse: true })
  assert.equal(pointer.ok, true)
  assert.equal(pointer.visible, true)
  await new Promise((resolve) => setTimeout(resolve, 300))
  const pointerShot = await driver.request('tab.screenshot', { owner: 's1' })
  assert.notDeepEqual(fs.readFileSync(pointerShot.path), fs.readFileSync(baseShot.path), 'pointer must be visible in screenshots')
  const hidden = await overlay({ op: 'hide-pointer' })
  assert.equal(hidden.visible, false)

  const highlight = await overlay({ op: 'highlight', text: 'Highlight this sentence', color: '#ffcc00' })
  assert.equal(highlight.ok, true)
  const box = await overlay({ op: 'box', selector: 'button', color: '#ff3b30' })
  assert.equal(box.ok, true)
  const circle = await overlay({ op: 'circle', selector: 'input', color: '#34c759' })
  assert.equal(circle.ok, true)
  const arrow = await overlay({ op: 'arrow', fromSelector: 'h1', selector: 'button', label: 'click here' })
  assert.equal(arrow.ok, true)
  const label = await overlay({ op: 'label', selector: 'h1', label: 'step 1', index: 1 })
  assert.equal(label.ok, true)
  const list = await overlay({ op: 'list' })
  assert.equal(list.count, 5)
  await new Promise((resolve) => setTimeout(resolve, 300))
  const annotatedShot = await driver.request('tab.screenshot', { owner: 's1' })
  assert.notDeepEqual(fs.readFileSync(annotatedShot.path), fs.readFileSync(baseShot.path), 'annotations must be visible in screenshots')

  const snap = await driver.request('tab.snapshot', { owner: 's1', maxChars: 2000 })
  assert.equal(snap.text.includes('step 1'), false, 'overlay labels must be excluded from snapshots')
  assert.equal(snap.text.includes('click here'), false)

  assert.equal((await overlay({ op: 'clear', id: highlight.id })).ok, true)
  assert.equal((await overlay({ op: 'list' })).count, 4)
  assert.equal((await overlay({ op: 'clear' })).ok, true)
  assert.equal((await overlay({ op: 'list' })).count, 0)

  // Persistence/export: annotations auto-save per URL and survive a reload.
  const persisted = await overlay({ op: 'box', selector: 'button', label: 'persist' })
  assert.equal(persisted.ok, true)
  const exported = await overlay({ op: 'export' })
  assert.equal(exported.ok, true)
  assert.equal(exported.count, 1)
  assert.equal(typeof exported.json, 'string')
  await driver.request('tab.goto', { owner: 's1', url: `http://127.0.0.1:${port}/` })
  const restored = await overlay({ op: 'list' })
  assert.equal(restored.count, 1, 'annotations should restore after reload')
  // op="restore" reloads the persisted set; it must not append a duplicate
  // copy on every call (state + DOM + sessionStorage used to grow each time).
  const restoredAgain = await overlay({ op: 'restore' })
  assert.equal(restoredAgain.ok, true)
  assert.equal((await overlay({ op: 'list' })).count, 1, 'restore is idempotent')
  assert.equal((await overlay({ op: 'clear' })).ok, true)

  // iframe: frame:true searches every frame and returns the matching frameId.
  await driver.request('tab.goto', { owner: 's1', url: `http://127.0.0.1:${port}/` })
  await new Promise((resolve) => setTimeout(resolve, 250))
  const frameBox = await driver.request('tab.overlay', { owner: 's1', op: 'box', frame: true, selector: '#frame-btn', color: '#af52de' })
  assert.equal(frameBox.ok, true, JSON.stringify(frameBox))
  assert.ok(frameBox.frameId, 'iframe annotation should report its frameId')
  const frameShot = await driver.request('tab.screenshot', { owner: 's1' })
  assert.notDeepEqual(fs.readFileSync(frameShot.path), fs.readFileSync(baseShot.path), 'iframe annotation must be visible in screenshots')

  // Auto-follow: with auto on, a click moves the overlay pointer.
  await overlay({ op: 'auto', enabled: true })
  const autoBase = await driver.request('tab.screenshot', { owner: 's1' })
  await driver.request('tab.click', { owner: 's1', selector: 'button' })
  await new Promise((resolve) => setTimeout(resolve, 300))
  const autoShot = await driver.request('tab.screenshot', { owner: 's1' })
  assert.notDeepEqual(fs.readFileSync(autoShot.path), fs.readFileSync(autoBase.path), 'auto-follow pointer must move on click')
  const autoStatus = await overlay({ op: 'auto', enabled: false })
  assert.equal(autoStatus.auto, false)
  console.log('OVERLAY TEST: PASS')
} finally {
  await driver.close()
  server.close()
  await new Promise((resolve) => setTimeout(resolve, 300))
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch {
    // temp profile leak is harmless
  }
}
