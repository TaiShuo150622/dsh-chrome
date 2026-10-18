/**
 * Sandbox functional smoke matrix for the chrome_* tools.
 *
 * Runs the real tool layer (src/tools.js) through the real BackendRouter
 * (src/backend.js) against a REAL headless Chromium (src/headless.js) and a
 * fake desktop bridge. Nothing here touches the user's visible Chrome, the
 * native host or the network: the fixture lives on 127.0.0.1, Chrome runs with
 * `--headless=new` and a throwaway --user-data-dir, and DSH_HOME points at a
 * temporary directory.
 *
 * Why the tool layer: it exercises the same path the model sees — tool
 * normalization, guards/policy/audit, backend routing, argument mapping — not
 * just the driver. `chrome_evaluate` is the documented exception: its provider
 * hard confirmation needs a human, so its positive case runs at the driver
 * layer and the provider gate is asserted by refusing the fake confirmation.
 *
 * Run directly:
 *   node test/sandbox-smoke.mjs
 *
 * Optional:
 *   DSH_HEADLESS_CHROME=/path/to/chrome node test/sandbox-smoke.mjs
 *
 * See docs/SANDBOX-QA.md for the matrix, findings and coverage limits.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

import { HeadlessDriver, headlessSupported, headlessChromeExecutable } from '../src/headless.js'
import { chromeTools } from '../src/tools.js'
import { BackendRouter, wrapToolsForBackend } from '../src/backend.js'

if (!headlessSupported()) {
  console.log('SANDBOX SMOKE: SKIP (no Chrome/Chromium found; set DSH_HEADLESS_CHROME)')
  process.exit(0)
}

const OWNER = 'sandbox-smoke'
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Sandbox Smoke</title>
<style>
  body { margin: 0; font-family: sans-serif; }
  #hover-target { width: 160px; padding: 4px; border: 1px solid #888; }
  #at-target { width: 160px; padding: 4px; border: 1px solid #888; }
  #drag-src, #drop-target { display: inline-block; padding: 8px; border: 1px dashed #555; }
  #tall { height: 2200px; background: linear-gradient(#fff, #eee); }
</style></head><body>
<h1 id="heading">Sandbox Smoke</h1>
<p id="intro">Hello from the sandbox fixture.</p>
<label>Name <input id="name" placeholder="name"></label>
<button id="go" type="button"
  onclick="document.getElementById('out').textContent = 'hello ' + document.getElementById('name').value">Go</button>
<div id="out">(empty)</div>
<select id="choice"><option value="one">One</option><option value="two">Two</option></select>
<label><input id="check" type="checkbox"> check</label>
<input id="file" type="file">
<div id="hover-target" role="button" tabindex="0"
  onmouseover="document.getElementById('hover-out').textContent = 'hovered'">hover me</div>
<div id="hover-out">(no hover)</div>
<div id="at-target" role="button" tabindex="0"
  onclick="document.getElementById('at-out').textContent = 'clicked-at'">click at me</div>
<div id="at-out">(no click)</div>
<div id="drag-src" role="button" tabindex="0" draggable="true">drag-src</div>
<div id="drop-target" role="button" tabindex="0"
  ondragover="event.preventDefault()"
  ondrop="event.preventDefault(); document.getElementById('drag-out').textContent = 'dropped'">drop-target</div>
<div id="drag-out">(no drop)</div>
<div id="key-out">(no key)</div>
<div id="tall">tall content for scrolling</div>
<a id="download" href="/download" download="sandbox-report.txt">download</a>
<iframe id="frame" src="/frame" width="320" height="120"></iframe>
<script>
  console.log('sandbox-log-1', 42)
  console.warn('sandbox-warn-1')
  fetch('/data/resource.json?token=supersecret').catch(() => {})
  document.addEventListener('keydown', (event) => {
    document.getElementById('key-out').textContent = String(event.key || '(none)')
  })
</script>
</body></html>`

const FRAME = `<!doctype html><html><head><title>Fixture Frame</title></head><body>
<button id="frame-btn">Frame Button</button><p>frame text</p></body></html>`

const SECOND = `<!doctype html><html><head><title>Second Page</title></head><body>
<h1>Second Page</h1></body></html>`

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/data/resource.json')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, from: 'fixture' }))
    return
  }
  if (req.url === '/download') {
    res.writeHead(200, {
      'content-type': 'text/plain',
      'content-disposition': 'attachment; filename="sandbox-report.txt"',
    })
    res.end('sandbox download body\n')
    return
  }
  if (req.url === '/frame') {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(FRAME)
    return
  }
  if (req.url === '/second') {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(SECOND)
    return
  }
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(PAGE)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()
const BASE = `http://127.0.0.1:${port}`

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sandbox-smoke-'))
const previousHome = process.env.DSH_HOME
const previousUploadRoots = process.env.DSH_CHROME_UPLOAD_ROOTS
process.env.DSH_HOME = home
// R-04: uploads are restricted to the session cwd plus explicit opt-in roots.
// The smoke fixture lives in a temp DSH_HOME, so opt that directory in.
process.env.DSH_CHROME_UPLOAD_ROOTS = home
const cacheDir = path.join(home, 'cache', 'dsh-chrome')
fs.mkdirSync(cacheDir, { recursive: true })
fs.writeFileSync(
  path.join(cacheDir, 'config.json'),
  JSON.stringify({
    allowEvaluate: true,
    evaluateConfirmTimeoutMs: 5000,
    captureConfirmTimeoutMs: 5000,
    sandboxSmoke: true,
  }),
)
fs.writeFileSync(
  path.join(cacheDir, 'policy.json'),
  JSON.stringify({
    origins: {
      'https://allowed.example': 'allow',
      'https://blocked.example': 'block',
      'https://invalid.example': 'sure-why-not',
    },
  }),
)

const driver = new HeadlessDriver({ home })
const desktopCalls = []
const fakeDesktop = {
  connected: true,
  hostVersion: 'host-fake',
  extensionVersion: 'ext-fake',
  async call(method, params = {}) {
    desktopCalls.push({ method, params })
    if (method === 'browser.status') {
      return {
        extensionVersion: '9.9.9-fake',
        diskVersion: '0.0.0-fake',
        autoReload: false,
        groupCount: 1,
        groups: [{ id: 1, title: 'fake-desktop', tabs: 1 }],
        alarms: [{ name: 'fake-alarm', periodInMinutes: 1 }],
      }
    }
    if (method === 'browser.site') {
      return { origin: 'https://desktop.example', url: 'https://desktop.example/', title: 'Fake Desktop', tabId: 901 }
    }
    if (method === 'tab.goto') {
      return { tabId: 901, url: params.url, title: 'Fake Desktop', loadState: 'complete' }
    }
    if (method === 'tab.pick_start') return { tabId: 901 }
    if (method === 'tab.pick_status') {
      return {
        available: true,
        done: true,
        canceled: false,
        result: { ref: 7, selector: '#fake-pick', text: 'fake pick target', tag: 'button', box: [10, 20, 30, 40] },
      }
    }
    throw Object.assign(new Error(`fake desktop does not implement ${method}`), { code: 'UNSUPPORTED_BACKEND' })
  },
}
const router = new BackendRouter({ desktop: fakeDesktop, headless: driver, headlessSupported: headlessSupported() })

const attachmentsDir = path.join(home, 'attachments')
const savedImages = []
const attachments = () => ({
  async saveImage({ data, mediaType, name }) {
    fs.mkdirSync(attachmentsDir, { recursive: true })
    const file = path.join(attachmentsDir, `${savedImages.length + 1}-${name}`)
    fs.writeFileSync(file, Buffer.from(data))
    const image = { attachmentId: `att-${savedImages.length + 1}`, path: file, mediaType, bytes: data.length }
    savedImages.push(image)
    return image
  },
})

const confirmations = []
let denyCaptureOnce = false
const userQuestions = () => ({
  async ask(request) {
    const question = request?.questions?.[0] || {}
    const header = String(question.header || '')
    let approve = !/JavaScript/.test(header)
    if (denyCaptureOnce && /抓取/.test(header)) {
      approve = false
      denyCaptureOnce = false
    }
    confirmations.push({ header, approve, question: String(question.question || '') })
    return { answers: [{ id: 'confirm', selected: [approve ? '允许一次' : '拒绝'] }] }
  },
})

const sessionContext = () => ({
  sessions: { get: (id) => (id === OWNER ? { header: { cwd: process.cwd() } } : null) },
  sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
})

const providerConfig = () => ({ allowEvaluate: true, evaluateConfirmTimeoutMs: 5000, captureConfirmTimeoutMs: 5000 })

const rawTools = chromeTools({
  bridge: router,
  attachments,
  assets: () => ({}),
  approval: () => null,
  sessionContext,
  userQuestions,
  config: providerConfig,
})
const tools = wrapToolsForBackend(rawTools, router)
const toolByName = new Map(tools.map((tool) => [tool.name, tool]))

let execSeq = 0
function newExec() {
  return {
    agent: { id: OWNER },
    callId: `sandbox-${++execSeq}`,
    signal: new AbortController().signal,
  }
}

const covered = new Set()
async function run(name, args = {}, backend = 'headless') {
  const tool = toolByName.get(name)
  assert.ok(tool, `tool ${name} is not registered`)
  covered.add(name)
  return tool.execute({ ...args, backend }, newExec())
}

let checks = 0
async function check(label, fn) {
  try {
    await fn()
    checks += 1
    console.log(`  ok  ${label}`)
  } catch (error) {
    console.error(`  FAIL ${label}: ${error?.stack || error}`)
    throw error
  }
}

async function expectError(label, fn, { code, match } = {}) {
  let error = null
  try {
    await fn()
  } catch (caught) {
    error = caught
  }
  assert.ok(error, `${label}: expected an error`)
  if (code) {
    assert.equal(error.code, code, `${label}: expected code ${code}, got ${error.code} (${error.message})`)
  }
  if (match) assert.match(String(error.message || ''), match, `${label}: unexpected message: ${error.message}`)
  checks += 1
  console.log(`  ok  ${label} (${error.code || 'error'}: ${String(error.message).slice(0, 110)})`)
  return error
}

const knownGaps = []
function gap(title, detail) {
  knownGaps.push({ title, detail })
  console.log(`  !! KNOWN GAP ${title}: ${detail}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function poll(label, fn, predicate, { attempts = 30, delayMs = 100 } = {}) {
  let value
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    value = await fn()
    if (predicate(value)) return value
    await sleep(delayMs)
  }
  throw new Error(`${label}: condition not met after ${attempts} attempts: ${JSON.stringify(value)?.slice(0, 800)}`)
}

let mainTabId = null
const owner = OWNER
const raw = (method, params = {}) => driver.request(method, { owner, ...params })

try {
  console.log(`sandbox smoke: Chrome = ${headlessChromeExecutable()}`)
  console.log(`sandbox smoke: DSH_HOME = ${home}`)
  console.log(`sandbox smoke: fixture = ${BASE}`)

  // ---------------------------------------------------------------- backend A
  // The desktop backend cannot be driven for real here (that would touch the
  // user's Chrome), so routing/status/pick run against a fake bridge. This is
  // explicitly marked "stand-in" in the matrix.
  await check('desktop: chrome_status reports the fake bridge', async () => {
    const status = await run('chrome_status', {}, 'desktop')
    assert.equal(status.backend, 'desktop')
    assert.equal(status.connected, true)
    assert.equal(status.hostVersion, 'host-fake')
    assert.equal(status.extensionVersion, '9.9.9-fake')
    assert.equal(status.diskVersion, '0.0.0-fake')
    assert.equal(status.groupCount, 1)
    assert.equal(status.groups[0].title, 'fake-desktop')
  })

  await check('desktop: chrome_goto routes through the backend router', async () => {
    const result = await run('chrome_goto', { url: 'https://desktop.example/from-smoke' }, 'desktop')
    assert.equal(result.title, 'Fake Desktop')
    assert.equal(result.url, 'https://desktop.example/from-smoke')
    assert.ok(
      desktopCalls.some((call) => call.method === 'tab.goto' && call.params.url === 'https://desktop.example/from-smoke'),
      'desktop bridge never saw tab.goto',
    )
  })

  await check('desktop: chrome_pick works against the fake bridge (stand-in)', async () => {
    const picked = await run('chrome_pick', { timeoutMs: 2000 }, 'desktop')
    assert.equal(picked.ref, 7)
    assert.equal(picked.selector, '#fake-pick')
    assert.equal(picked.tag, 'button')
    assert.equal(picked.canceled, false)
    assert.ok(desktopCalls.some((call) => call.method === 'tab.pick_start'))
  })

  await check('router capability contract: pick exists on desktop, not headless', () => {
    assert.equal(router.runWithBackend('desktop', () => router.supports('pick')), true)
    assert.equal(router.runWithBackend('headless', () => router.supports('pick')), false)
    assert.equal(router.runWithBackend('headless', () => router.supports('pause')), false)
    assert.equal(router.runWithBackend('headless', () => router.supports('frames')), true)
    assert.equal(router.runWithBackend('headless', () => router.supports('teleport')), false)
  })

  // ------------------------------------------------------------ headless: A-L
  await check('headless: chrome_status before the first request is lazy (not running yet)', async () => {
    const status = await run('chrome_status')
    assert.equal(status.backend, 'headless')
    assert.equal(status.connected, false)
    assert.equal(status.headless.supported, true)
    assert.equal(status.headless.running, false)
    assert.match(status.headless.profile, /headless\/profile$/)
  })

  await check('chrome_goto opens the fixture and reports load state', async () => {
    const value = await run('chrome_goto', { url: `${BASE}/` })
    assert.equal(value.url, `${BASE}/`)
    assert.equal(value.title, 'Sandbox Smoke')
    assert.equal(value.loadState, 'complete')
    assert.ok(Number.isFinite(value.tabId))
    mainTabId = value.tabId
    assert.equal(driver.connected, true)
  })

  await expectError('chrome_goto rejects a non-http(s) URL at the tool layer', () => run('chrome_goto', { url: 'ftp://example.test/' }), {
    code: 'PROTECTED_PAGE',
    match: /only http\(s\) URLs/,
  })

  await check('headless: chrome_status after startup reports connected + running', async () => {
    const status = await run('chrome_status')
    assert.equal(status.connected, true)
    assert.equal(status.backend, 'headless')
    assert.equal(status.headless.running, true)
    assert.match(String(status.headless.browserVersion), /Chrome\//)
  })

  await check('site: browser.site reports the fixture origin', async () => {
    const site = await raw('browser.site')
    assert.equal(site.origin, BASE)
    assert.equal(site.url, `${BASE}/`)
    assert.equal(site.tabId, mainTabId)
  })

  // ------------------------------------------------------- config/policy/audit
  await check('chrome_config reads the temp provider config', async () => {
    const value = await run('chrome_config')
    assert.equal(value.path, path.join(cacheDir, 'config.json'))
    assert.equal(value.config.allowEvaluate, true)
    assert.equal(value.config.sandboxSmoke, true)
    assert.equal(value.error, null)
  })

  await check('chrome_policy resolves allow / block / default and flags invalid entries', async () => {
    const allowed = await run('chrome_policy', { origin: 'https://allowed.example' })
    assert.equal(allowed.mode, 'allow')
    assert.equal(allowed.source, 'policy.json')
    assert.equal(allowed.invalid.length, 1)
    assert.equal(allowed.invalid[0].origin, 'https://invalid.example')
    const blocked = await run('chrome_policy', { origin: 'https://blocked.example' })
    assert.equal(blocked.mode, 'block')
    const current = await run('chrome_policy')
    assert.equal(current.origin, BASE)
    assert.equal(current.mode, null)
    assert.equal(current.source, 'default')
  })

  await expectError(
    'policy block: a guarded action is refused with SITE_BLOCKED and audited',
    async () => {
      fs.writeFileSync(
        path.join(cacheDir, 'policy.json'),
        JSON.stringify({ origins: { [BASE]: 'block' } }),
      )
      try {
        await run('chrome_type', { selector: '#name', text: 'blocked', replace: true })
      } finally {
        fs.writeFileSync(
          path.join(cacheDir, 'policy.json'),
          JSON.stringify({
            origins: {
              'https://allowed.example': 'allow',
              'https://blocked.example': 'block',
              'https://invalid.example': 'sure-why-not',
            },
          }),
        )
      }
    },
    { code: 'SITE_BLOCKED', match: /blocked by policy\.json/ },
  )

  await check('chrome_audit sees allowed and denied guarded actions', async () => {
    const value = await run('chrome_audit', { limit: 100 })
    assert.ok(value.entries.length > 0, 'audit log is empty')
    assert.ok(
      value.entries.some((entry) => entry.tool === 'chrome_goto' && entry.decision === 'allowed'),
      `no allowed chrome_goto audit entry: ${JSON.stringify(value.entries)}`,
    )
    assert.ok(
      value.entries.some(
        (entry) => entry.tool === 'chrome_type' && entry.decision === 'denied' && entry.reason === 'site-blocked',
      ),
      `no denied chrome_type audit entry: ${JSON.stringify(value.entries)}`,
    )
    const filtered = await run('chrome_audit', { limit: 100, origin: 'https://desktop.example' })
    assert.ok(filtered.entries.every((entry) => entry.origin === 'https://desktop.example'))
  })

  // ----------------------------------------------------------- read the page
  let snapshot
  await check('chrome_snapshot returns controls, text, boxes and a stable ref', async () => {
    snapshot = await run('chrome_snapshot', { boxes: true, maxChars: 20000 })
    assert.equal(snapshot.title, 'Sandbox Smoke')
    assert.equal(snapshot.url, `${BASE}/`)
    assert.ok(snapshot.text.includes('Sandbox Smoke'))
    const go = snapshot.controls.find((control) => control.tag === 'button' && control.label === 'Go')
    assert.ok(go, `Go button not found: ${JSON.stringify(snapshot.controls)}`)
    assert.ok(Array.isArray(go.box) && go.box.length === 4, `box missing: ${JSON.stringify(go)}`)
    assert.equal(snapshot.mode, 'full')
    assert.ok(snapshot.controls.every((control) => Number.isFinite(control.ref) && control.ref > 0))
  })

  const staged = await run('chrome_snapshot', { mode: 'delta', frames: 'all' })
  if (staged.mode !== 'delta') gap('chrome_snapshot mode/frames', `requested mode=delta frames=all but headless returned mode=${staged.mode} with ${staged.frames?.length ?? 0} frame(s)`)
  else checks += 1

  await check('chrome_find finds visible text with a ref handle', async () => {
    const value = await run('chrome_find', { query: 'Sandbox', maxResults: 5 })
    assert.equal(value.query, 'Sandbox')
    assert.ok(value.matches.length >= 1, `no matches: ${JSON.stringify(value)}`)
    assert.ok(value.matches.some((match) => String(match.text).includes('Sandbox')))
  })

  const regexProbe = await run('chrome_find', { query: 'Sandbox\\s+Smoke', regex: true, maxResults: 5 })
  if (regexProbe.matches.length === 0) {
    gap('chrome_find regex', 'regex:true is rewritten as a literal substring in the page helper, so "Sandbox\\s+Smoke" finds nothing')
  } else {
    checks += 1
  }

  await check('chrome_get_text reads the main text', async () => {
    const value = await run('chrome_get_text', { maxChars: 20000 })
    assert.equal(value.found, true)
    assert.ok(value.text.includes('Sandbox Smoke'))
    assert.ok(value.text.includes('tall content for scrolling'))
  })

  await check('chrome_html returns an element and honors maxChars', async () => {
    const value = await run('chrome_html', { selector: '#go', maxChars: 500 })
    assert.ok(value.html.includes('id="go"'), `unexpected html: ${value.html}`)
    assert.equal(value.truncated, false)
  })

  // ------------------------------------------------------------- interactions
  await check('chrome_type replaces the input value', async () => {
    const nameControl = snapshot.controls.find((control) => control.tag === 'input' && control.kind === 'text')
    assert.ok(nameControl, `text input not found: ${JSON.stringify(snapshot.controls)}`)
    const value = await run('chrome_type', { ref: nameControl.ref, text: 'smoke', replace: true })
    assert.equal(value.ok, true)
    assert.equal(value.value, 'smoke')
  })

  await check('chrome_click clicks by ref and the handler runs', async () => {
    const go = snapshot.controls.find((control) => control.tag === 'button' && control.label === 'Go')
    const value = await run('chrome_click', { ref: go.ref })
    assert.equal(value.ok, true)
    assert.equal(value.label, 'Go')
    const out = await run('chrome_get_text', { selector: '#out' })
    assert.equal(out.text.trim(), 'hello smoke')
  })

  await expectError('chrome_click with an unknown ref fails with REF_NOT_FOUND', () => run('chrome_click', { ref: 999999 }), {
    code: 'REF_NOT_FOUND',
    match: /no element for ref 999999/,
  })

  await expectError('headless driver keeps REF_NOT_FOUND and the tool layer now preserves it', () => raw('tab.click', { ref: 999999 }), {
    code: 'REF_NOT_FOUND',
  })

  await check('chrome_hover returns the target', async () => {
    const value = await run('chrome_hover', { selector: '#hover-target' })
    assert.equal(value.ok, true)
    assert.equal(value.tag, 'div')
  })
  const hoverOut = await run('chrome_get_text', { selector: '#hover-out' })
  if (hoverOut.text.trim() === 'hovered') {
    checks += 1
  } else {
    gap(
      'chrome_hover semantics',
      'headless tab.hover reuses clickPage and dispatches pointer/mouse down/up/click; it never dispatches mouseover/mouseenter, so CSS :hover and the fixture mouseover handler stay unset',
    )
  }

  await check('chrome_press dispatches a keydown to the focused document', async () => {
    await raw('tab.evaluate', { expression: 'document.getElementById("name").focus()' })
    const value = await run('chrome_press', { key: 'k' })
    assert.equal(value.ok, true)
    assert.equal(value.key, 'k')
    const out = await run('chrome_get_text', { selector: '#key-out' })
    assert.ok(out.text.includes('k'), `keydown handler did not run: ${JSON.stringify(out.text)}`)
  })

  await check('chrome_scroll moves the document and reports the position', async () => {
    const top = await run('chrome_scroll', { direction: 'top' })
    assert.equal(top.ok, true)
    assert.equal(top.y, 0)
    const bottom = await run('chrome_scroll', { direction: 'bottom' })
    assert.equal(bottom.ok, true)
    assert.ok(bottom.y > 100, `page did not scroll: ${JSON.stringify(bottom)}`)
  })
  gap(
    'chrome_scroll output schema',
    'the tool schema promises viewportHeight/documentHeight/page, but the headless driver returns only { ok, tabId, x, y }',
  )

  await check('chrome_select sets a <select> and a checkbox', async () => {
    const select = snapshot.controls.find((control) => control.tag === 'select')
    const checkbox = snapshot.controls.find((control) => control.kind === 'checkbox')
    assert.ok(select && checkbox, `select/checkbox controls missing: ${JSON.stringify(snapshot.controls)}`)
    const selected = await run('chrome_select', { ref: select.ref, value: 'two' })
    assert.equal(selected.value, 'two')
    const checked = await run('chrome_select', { ref: checkbox.ref, checked: true })
    assert.equal(checked.value, 'true')
    const state = await raw('tab.evaluate', {
      expression: '({ choice: document.getElementById("choice").value, check: document.getElementById("check").checked })',
    })
    assert.deepEqual(state.value, { choice: 'two', check: true })
  })

  await expectError('chrome_select rejects an option that does not exist', () => {
    const select = snapshot.controls.find((control) => control.tag === 'select')
    return run('chrome_select', { ref: select.ref, value: 'three' })
  }, { code: 'INVALID_ARGUMENT', match: /option not found: three/ })

  await check('chrome_drag drags between refs and the drop handler runs', async () => {
    const from = snapshot.controls.find((control) => control.label === 'drag-src')
    const to = snapshot.controls.find((control) => control.label === 'drop-target')
    assert.ok(from && to, `drag controls missing: ${JSON.stringify(snapshot.controls)}`)
    const value = await run('chrome_drag', { fromRef: from.ref, toRef: to.ref })
    assert.equal(value.ok, true)
    const out = await run('chrome_get_text', { selector: '#drag-out' })
    assert.equal(out.text.trim(), 'dropped')
  })

  await check('chrome_click_at clicks viewport coordinates', async () => {
    const point = await raw('tab.evaluate', {
      expression: '(() => { const el = document.getElementById("at-target"); el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()',
    })
    const value = await run('chrome_click_at', { x: point.value.x, y: point.value.y })
    assert.equal(value.ok, true)
    const out = await run('chrome_get_text', { selector: '#at-out' })
    assert.equal(out.text.trim(), 'clicked-at')
  })

  // ---------------------------------------------------------------- evaluate
  await check('chrome_evaluate driver path evaluates values and promises', async () => {
    const value = await raw('tab.evaluate', { expression: '1 + 2' })
    assert.equal(value.value, 3)
    const promised = await raw('tab.evaluate', { expression: 'Promise.resolve(7)', awaitPromise: true })
    assert.equal(promised.value, 7)
  })

  await expectError(
    'chrome_evaluate provider gate refuses without a human confirmation',
    () => run('chrome_evaluate', { expression: '1 + 1' }),
    { code: 'APPROVAL_DENIED', match: /not approved|confirmation/ },
  )

  // ----------------------------------------------------------- frames / a11y
  await check('chrome_frames lists the main frame and the iframe', async () => {
    const value = await run('chrome_frames')
    assert.equal(value.frameCount, 2, `expected 2 frames: ${JSON.stringify(value)}`)
    assert.ok(value.frames.some((frame) => frame.parentFrameId == null))
    assert.ok(value.frames.some((frame) => String(frame.url).endsWith('/frame')))
  })

  const probeFrames = await run('chrome_frames', { probe: true })
  if (!probeFrames.frames.some((frame) => frame.probe)) {
    gap('chrome_frames probe', 'probe:true is ignored by the headless driver: frames come back without probe/{controls,title}')
  } else {
    checks += 1
  }

  await check('chrome_a11y exposes the accessibility tree', async () => {
    const value = await run('chrome_a11y', { limit: 200 })
    assert.ok(value.nodes.length > 0)
    assert.ok(
      value.nodes.some((node) => node.role === 'heading' && String(node.name).includes('Sandbox Smoke')),
      `heading missing from AX tree: ${JSON.stringify(value.nodes.slice(0, 20))}`,
    )
  })

  // -------------------------------------------------------- console / network
  await check('chrome_console reads captured logs and filters', async () => {
    const value = await run('chrome_console', { limit: 50 })
    assert.ok(value.entries.some((entry) => String(entry.text).includes('sandbox-log-1')), JSON.stringify(value.entries))
    const warnings = await run('chrome_console', { filter: 'sandbox-warn', limit: 50 })
    assert.ok(warnings.entries.length >= 1)
    assert.ok(warnings.entries.every((entry) => String(entry.text).includes('sandbox-warn')))
  })

  await check('chrome_network sees the fixture fetch', async () => {
    const value = await poll('chrome_network', () => run('chrome_network', { filter: 'resource.json', limit: 50 }), (result) =>
      (result.entries || []).some((entry) => String(entry.url).includes('/data/resource.json')),
    )
    assert.ok(value.entries.length >= 1)
  })

  // ------------------------------------------------------------------- waits
  await check('chrome_wait handles load / text / selector / url', async () => {
    const loaded = await run('chrome_wait', { until: 'load' })
    assert.equal(loaded.tabId, mainTabId)
    const text = await run('chrome_wait', { until: 'text', text: 'Sandbox Smoke' })
    assert.equal(text.tabId, mainTabId)
    const selector = await run('chrome_wait', { until: 'selector', selector: '#go' })
    assert.equal(selector.tabId, mainTabId)
    const url = await run('chrome_wait', { until: 'url', url: BASE })
    assert.equal(url.tabId, mainTabId)
  })

  await expectError('chrome_wait times out with a bounded timeout', () => run('chrome_wait', { until: 'selector', selector: '#missing', timeoutMs: 300 }), {
    code: 'TIMEOUT',
    match: /wait timed out/,
  })

  // The tool advertises networkidle/change; the headless driver only loops on
  // load/text/selector/url, so those two modes can only ever time out.
  await expectError('headless wait has no networkidle implementation', () => raw('tab.wait', { until: 'networkidle', timeoutMs: 300 }), {
    code: 'TIMEOUT',
  })
  await expectError('headless wait has no change implementation', () => raw('tab.wait', { until: 'change', timeoutMs: 300 }), {
    code: 'TIMEOUT',
  })
  gap(
    'chrome_wait networkidle/change',
    "the tool advertises until=networkidle and until=change, but the headless driver's loop only handles load/text/selector/url; both modes always end in TIMEOUT",
  )

  // ---------------------------------------------------------------- history
  await check('chrome_history back / forward / reload', async () => {
    const second = await run('chrome_goto', { url: `${BASE}/second` })
    assert.equal(second.title, 'Second Page')
    const back = await run('chrome_history', { op: 'back' })
    assert.equal(back.url, `${BASE}/`)
    const forward = await run('chrome_history', { op: 'forward' })
    assert.equal(forward.url, `${BASE}/second`)
    const reload = await run('chrome_history', { op: 'reload' })
    assert.equal(reload.url, `${BASE}/second`)
    const homeAgain = await run('chrome_history', { op: 'back' })
    assert.equal(homeAgain.url, `${BASE}/`)
  })

  // ------------------------------------------------------ screenshot/emulate
  let screenshot
  await check('chrome_screenshot returns a real PNG and an attachment', async () => {
    screenshot = await run('chrome_screenshot')
    assert.equal(screenshot.mediaType, 'image/png')
    assert.ok(screenshot.width > 0 && screenshot.height > 0)
    assert.ok(screenshot.bytes > 1000)
    assert.ok(fs.existsSync(screenshot.path))
    assert.deepEqual([...fs.readFileSync(screenshot.path).subarray(0, 8)], [...PNG_SIGNATURE])
    assert.ok(screenshot.image?.attachmentId, 'attachments.saveImage was not called')
  })

  await check('chrome_emulate applies and resets the viewport', async () => {
    const applied = await run('chrome_emulate', { width: 640, height: 480 })
    assert.equal(applied.applied, true)
    assert.equal(applied.viewport.width, 640)
    assert.equal(applied.viewport.height, 480)
    const shot = await run('chrome_screenshot')
    assert.deepEqual([shot.width, shot.height], [640, 480])
    const reset = await run('chrome_emulate', { reset: true })
    assert.equal(reset.applied, false)
  })

  await expectError('chrome_emulate rejects missing dimensions', () => run('chrome_emulate', { width: 800 }), {
    code: 'INVALID_ARGUMENT',
    match: /width and height are required/,
  })

  // -------------------------------------------------------------------- pdf
  await check('tab.pdf driver writes a real PDF', async () => {
    const value = await raw('tab.pdf')
    assert.ok(fs.existsSync(value.path))
    assert.ok(fs.readFileSync(value.path).subarray(0, 5).toString('latin1') === '%PDF-')
  })

  // P1-1 fixed: the tool accepts both contracts — desktop { dataBase64 } and
  // headless { path, bytes } (the driver already wrote the file).
  await check('chrome_pdf returns the headless driver-written PDF as a usable path', async () => {
    const value = await run('chrome_pdf')
    assert.ok(value.path && fs.existsSync(value.path), `chrome_pdf returned no file: ${JSON.stringify(value)}`)
    assert.ok(
      value.path.includes(path.join('cache', 'dsh-chrome', 'pdfs')),
      `default PDF path is not in the pdfs cache: ${value.path}`,
    )
    assert.equal(fs.readFileSync(value.path).subarray(0, 5).toString('latin1'), '%PDF-')
    assert.equal(fs.statSync(value.path).size, value.bytes)
  })

  await check('chrome_pdf honors an explicit output path on headless', async () => {
    const target = path.join(home, 'requested-pdfs', 'smoke.pdf')
    const value = await run('chrome_pdf', { path: target })
    assert.equal(value.path, target)
    assert.equal(fs.readFileSync(target).subarray(0, 5).toString('latin1'), '%PDF-')
    assert.equal(fs.statSync(target).size, value.bytes)
  })

  // ------------------------------------------------------------------ shots
  let desktopShotPath = null
  await check('chrome_shots lists and reads a desktop-style screenshot', async () => {
    const directory = path.join(home, 'cache', 'dsh-chrome', 'screenshots')
    fs.mkdirSync(directory, { recursive: true })
    const copied = path.join(directory, `desktop-fixture-${Date.now()}.png`)
    fs.copyFileSync(screenshot.path, copied)
    desktopShotPath = copied
    const listed = await run('chrome_shots', { op: 'list' })
    const entry = listed.entries.find((item) => item.name === path.basename(copied))
    assert.ok(entry, `copied screenshot not listed: ${JSON.stringify(listed.entries)}`)
    assert.equal(entry.width, screenshot.width)
    assert.equal(entry.height, screenshot.height)
    const read = await run('chrome_shots', { op: 'read', path: copied })
    assert.equal(read.bytes, fs.statSync(copied).size)
    assert.ok(read.image?.attachmentId)
  })

  await expectError('chrome_shots refuses a path outside its directory', () => run('chrome_shots', { op: 'read', path: path.join(home, 'outside.png') }), {
    code: 'INVALID_ARGUMENT',
    match: /inside the screenshots directory/,
  })

  // P1-4 fixed: the headless driver writes to .../headless/screenshots, and
  // chrome_shots now scans both roots for list and read.
  await check('chrome_shots lists and reads headless screenshots too', async () => {
    assert.ok(fs.existsSync(screenshot.path), `headless screenshot is missing: ${screenshot.path}`)
    const listed = await run('chrome_shots', { op: 'list', limit: 100 })
    assert.ok(
      listed.entries.some((entry) => entry.path === desktopShotPath),
      `desktop screenshot disappeared from the merged list: ${JSON.stringify(listed.entries)}`,
    )
    const entry = listed.entries.find((item) => item.path === screenshot.path)
    assert.ok(entry, `headless screenshot not listed: ${JSON.stringify(listed.entries)}`)
    assert.equal(entry.width, screenshot.width)
    assert.equal(entry.height, screenshot.height)
    assert.ok(
      listed.directories.includes(path.join(home, 'cache', 'dsh-chrome', 'headless', 'screenshots')),
      `headless directory missing from chrome_shots list: ${JSON.stringify(listed.directories)}`,
    )
    const read = await run('chrome_shots', { op: 'read', path: screenshot.path })
    assert.equal(read.bytes, fs.statSync(screenshot.path).size)
    assert.equal(read.width, screenshot.width)
    assert.ok(read.image?.attachmentId)
  })

  // --------------------------------------------------------------- selection
  await check('chrome_selection reads a document selection', async () => {
    await raw('tab.evaluate', {
      expression: '(() => { const range = document.createRange(); range.selectNodeContents(document.getElementById("intro")); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); return String(selection) })()',
    })
    const value = await run('chrome_selection')
    assert.equal(value.found, true)
    assert.ok(value.text.includes('Hello from the sandbox fixture'))
    assert.equal(value.source, 'document')
  })

  await raw('tab.evaluate', { expression: 'getSelection().removeAllRanges()' })
  const noSelection = await run('chrome_selection')
  assert.equal(noSelection.found, false)
  if (noSelection.message === 'NO_SELECTION' && !noSelection.reason) {
    gap(
      'chrome_selection empty-selection semantics',
      'headless returns { found:false, message:"NO_SELECTION" } while the desktop extension throws NO_SELECTION; the tool schema also promises url/title/truncated that headless never returns',
    )
  } else {
    checks += 1
  }

  // ----------------------------------------------------------------- storage
  await check('chrome_storage sets, gets, lists and removes a value', async () => {
    const set = await run('chrome_storage', { op: 'set', key: 'probe', value: { ok: 1 } })
    if (set.scope === 'localStorage') {
      gap(
        'chrome_storage scope label',
        "the headless driver returns scope:'localStorage'/'sessionStorage' while the tool schema and render assume 'local'/'session' (the render path prints \"localStorageStorage\")",
      )
    } else {
      assert.equal(set.scope, 'local')
    }
    assert.equal(set.set, 1)
    const got = await run('chrome_storage', { op: 'get', key: 'probe' })
    assert.deepEqual(got.items.probe, { ok: 1 })
    const all = await run('chrome_storage', { op: 'get' })
    assert.ok(Object.hasOwn(all.items, 'probe'))
    const removed = await run('chrome_storage', { op: 'remove', key: 'probe' })
    assert.equal(removed.removed, 1)
    const after = await run('chrome_storage', { op: 'get', key: 'probe' })
    assert.deepEqual(after.items, {})
  })

  // ----------------------------------------------------------------- upload
  await check('chrome_upload attaches an existing file', async () => {
    const fresh = await run('chrome_snapshot', {})
    const fileInput = fresh.controls.find((control) => control.kind === 'file')
    assert.ok(fileInput, `file input missing: ${JSON.stringify(fresh.controls)}`)
    const uploadPath = path.join(home, 'upload.txt')
    fs.writeFileSync(uploadPath, 'hello upload')
    const value = await run('chrome_upload', { ref: fileInput.ref, files: [uploadPath] })
    assert.equal(value.ok, true)
    assert.equal(value.files, 1)
    const name = await raw('tab.evaluate', { expression: 'document.getElementById("file").files[0]?.name ?? null' })
    assert.equal(name.value, 'upload.txt')
    const confirm = confirmations.find((entry) => entry.header === '上传本机文件')
    assert.ok(confirm && confirm.approve, `upload did not ask a hard confirmation: ${JSON.stringify(confirmations)}`)
    assert.ok(confirm.question.includes(uploadPath), `confirmation did not name the full file path: ${confirm.question}`)
    assert.ok(confirm.question.includes(BASE), `confirmation did not name the target site: ${confirm.question}`)
  })

  await expectError('chrome_upload rejects a missing file before reaching the browser', () => run('chrome_upload', { selector: '#file', files: [path.join(home, 'nope.txt')] }), {
    code: 'INVALID_ARGUMENT',
    match: /not a file/,
  })

  await expectError('chrome_upload rejects an empty file list', () => run('chrome_upload', { selector: '#file', files: [] }), {
    code: 'INVALID_ARGUMENT',
    match: /non-empty array/,
  })

  // --------------------------------------------------------------- download
  await check('chrome_download sees a completed download', async () => {
    const fresh = await run('chrome_snapshot', {})
    const link = fresh.controls.find((control) => control.tag === 'a' && control.label === 'download')
    assert.ok(link, `download link missing: ${JSON.stringify(fresh.controls)}`)
    await run('chrome_click', { ref: link.ref })
    const value = await poll('chrome_download', () => run('chrome_download', { limit: 10 }), (result) =>
      (result.items || []).some((item) => item.state === 'complete' && item.filename === 'sandbox-report.txt'),
    )
    const item = value.items.find((entry) => entry.filename === 'sandbox-report.txt')
    assert.equal(item.state, 'complete')
    assert.ok(fs.existsSync(item.path), `download file missing: ${item.path}`)
  })

  // ---------------------------------------------------------------- capture
  await expectError(
    'chrome_capture_start can be refused by the hard confirmation',
    async () => {
      denyCaptureOnce = true
      await run('chrome_capture_start', { maxEntries: 50 })
    },
    { code: 'APPROVAL_DENIED', match: /not approved/ },
  )

  let captureId = null
  await check('chrome_capture_start starts a capture after confirmation', async () => {
    const value = await run('chrome_capture_start', { maxEntries: 50 })
    assert.equal(value.active, true)
    assert.ok(String(value.captureId).startsWith('hl-'))
    captureId = value.captureId
  })

  await check('chrome_capture_requests records and redacts the fixture request', async () => {
    await raw('tab.evaluate', {
      expression: 'fetch("/data/resource.json?token=supersecret").then((response) => response.json())',
      awaitPromise: true,
    })
    const value = await poll(
      'chrome_capture_requests',
      () => run('chrome_capture_requests', { captureId, filter: 'resource.json', limit: 50 }),
      (result) => (result.entries || []).length >= 1,
    )
    const entry = value.entries.find((item) => String(item.url).includes('/data/resource.json'))
    assert.ok(entry, `request missing: ${JSON.stringify(value.entries)}`)
    assert.equal(entry.status, 200)
    assert.ok(entry.responseBody?.includes('"ok":true'), `response body missing: ${JSON.stringify(entry)}`)
    assert.ok(!String(entry.url).includes('supersecret'), `secret query value leaked: ${entry.url}`)
    assert.ok(/redacted/i.test(String(entry.url)), `secret query value was not visibly redacted: ${entry.url}`)
  })

  await check('chrome_capture_stop freezes the buffer', async () => {
    const value = await run('chrome_capture_stop', { captureId })
    assert.equal(value.active, false)
    assert.ok(value.requests >= 1)
    const after = await run('chrome_capture_requests', { captureId, filter: 'resource.json', limit: 50 })
    assert.equal(after.active, false)
    assert.ok(after.entries.length >= 1)
  })

  await expectError('chrome_capture_requests reports a lost capture id', () => run('chrome_capture_requests', { captureId: 'hl-does-not-exist' }), {
    code: 'CAPTURE_LOST',
    match: /is gone/,
  })

  // ------------------------------------------------------------- screencast
  let cast = null
  await check('chrome_screencast start/status/stop produces a frame', async () => {
    const started = await run('chrome_screencast', { op: 'start', everyNthFrame: 1, quality: 50 })
    assert.equal(started.active, true)
    assert.ok(String(started.path).endsWith('latest.jpg'))
    let status = null
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await raw('tab.evaluate', {
        expression: `document.body.style.background = ${JSON.stringify(attempt % 2 === 0 ? '#f8f8ff' : '#ffffff')}`,
      })
      await sleep(250)
      status = await run('chrome_screencast', { op: 'status' })
      if (Number(status.frames) > 0) break
    }
    assert.ok(Number(status?.frames) > 0, `screencast produced no frames: ${JSON.stringify(status)}`)
    assert.ok(fs.existsSync(status.path), `latest frame missing: ${status.path}`)
    const bytes = fs.readFileSync(status.path)
    assert.ok(bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8, 'latest frame is not a JPEG')
    assert.ok(status.image?.attachmentId, 'screencast status did not attach the newest frame')
    cast = status
  })

  await check('chrome_screencast diag reports the headless backend', async () => {
    const value = await run('chrome_screencast', { op: 'diag' })
    assert.equal(value.backend, 'headless')
    assert.ok(value.tabs.some((tab) => tab.tabId === mainTabId))
  })

  await check('chrome_screencast viewer answers even without a web server', async () => {
    const value = await run('chrome_screencast', { op: 'viewer' })
    assert.equal(typeof value.enabled, 'boolean')
    if (value.enabled) assert.equal(typeof value.url, 'string')
    if (!value.enabled) gap('chrome_screencast viewer', 'live viewer is disabled in this harness (no Host webServer); only the disabled response was exercised')
  })

  await check('chrome_screencast stop ends the stream', async () => {
    const value = await run('chrome_screencast', { op: 'stop' })
    assert.equal(value.active, false)
    assert.ok(value.frames > 0)
  })

  // ------------------------------------------------------------------- tabs
  let newTabId = null
  await check('chrome_tabs list / new / focus / close', async () => {
    const before = await run('chrome_tabs', { op: 'list' })
    assert.equal(before.tabs.length, 1)
    assert.equal(before.tabs[0].tabId, mainTabId)
    const created = await run('chrome_tabs', { op: 'new', url: `${BASE}/second` })
    newTabId = created.tabId
    assert.notEqual(newTabId, mainTabId)
    const list = await run('chrome_tabs', { op: 'list' })
    assert.equal(list.tabs.length, 2)
    const focused = await run('chrome_tabs', { op: 'focus', tabId: mainTabId })
    assert.equal(focused.focused, true)
    assert.equal(focused.tabId, mainTabId)
    const closed = await run('chrome_tabs', { op: 'close', tabId: newTabId })
    assert.equal(closed.closed, newTabId)
    assert.equal(closed.remaining, 1)
  })

  await expectError('chrome_tabs close rejects a tab this session does not own', () => run('chrome_tabs', { op: 'close', tabId: 999999 }), {
    code: 'TAB_NOT_FOUND',
    match: /not owned by this session/,
  })

  // R-05: the tool layer rejects non-http(s) destinations before the driver is
  // asked to create a target (the headless driver checks again).
  await expectError('chrome_tabs new rejects file:// at the tool layer', () => run('chrome_tabs', { op: 'new', url: 'file:///etc/hosts' }), {
    code: 'PROTECTED_PAGE',
    match: /only http\(s\) URLs/,
  })

  await expectError('headless driver rejects an unknown tab id with TAB_NOT_FOUND', () => raw('tab.snapshot', { tabId: 999999 }), {
    code: 'TAB_NOT_FOUND',
  })

  await expectError('chrome_snapshot rejects an unknown tab id', () => run('chrome_snapshot', { tabId: 999999 }), {
    code: 'TAB_NOT_FOUND',
    match: /tab 999999 is not owned/,
  })

  await expectError('headless driver rejects an unknown method', () => raw('tab.teleport'), {
    code: 'UNSUPPORTED_BACKEND',
    match: /not implemented by the headless backend/,
  })

  await expectError('chrome_tabs rejects an invalid driver-side op', () => raw('tab.tabs', { op: 'rewind' }), {
    code: 'INVALID_ARGUMENT',
    match: /unknown tabs op/,
  })

  // -------------------------------------------------------- resume / picker
  await check('chrome_resume is a no-op success on headless', async () => {
    const value = await run('chrome_resume')
    assert.equal(value.ok, true)
    assert.equal(value.tabId, mainTabId)
  })

  await expectError('chrome_pick is gated off on headless with a next step', () => run('chrome_pick', {}), {
    code: 'UNSUPPORTED_BACKEND',
    match: /needs a real user click/,
  })

  // ------------------------------------------------- headless login (guarded)
  await expectError('chrome_headless_login start refuses while session tabs are open', async () => {
    await run('chrome_headless_login', { op: 'start', url: 'https://example.test/login' })
  }, { code: 'HEADLESS_BUSY', match: /close headless tabs/ })

  await check('chrome_headless_login status reports no login window', async () => {
    const value = await run('chrome_headless_login', { op: 'status' })
    assert.equal(value.running, false)
    assert.match(String(value.profile), /headless\/profile$/)
  })

  // The visible login window is replaced by a spawn stub: same driver methods
  // and the same tool path, but nothing is launched on the user's desktop.
  const loginHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sandbox-login-'))
  const spawned = []
  const stubChild = {
    pid: 4242,
    killed: null,
    once() {},
    kill(signal) {
      this.killed = signal
    },
  }
  const loginDriver = new HeadlessDriver({
    home: loginHome,
    spawnImpl: (command, args, options) => {
      spawned.push({ command, args, options })
      return stubChild
    },
  })
  const loginRouter = new BackendRouter({ desktop: fakeDesktop, headless: loginDriver, headlessSupported: true })
  // start's hard confirmation now passes site:null, so this stub's browser.site
  // branch is not used. It stays as a safety net: if a regression resolves the
  // site again, the real-driver assertion further down catches the extra tab.
  const loginBridge = {
    connected: false,
    headless: loginDriver,
    hostVersion: null,
    extensionVersion: null,
    backend: 'headless',
    headlessInfo: () => ({ supported: true, running: false }),
    supports: () => true,
    async call(method) {
      if (method === 'browser.site') {
        return { origin: 'https://example.test', url: 'https://example.test/', title: 'Login Stub', tabId: null }
      }
      throw new Error(`login bridge does not implement ${method}`)
    },
    runWithBackend: (mode, fn) => loginRouter.runWithBackend(mode, fn),
  }
  const loginTools = wrapToolsForBackend(
    chromeTools({
      bridge: loginBridge,
      attachments,
      assets: () => ({}),
      approval: () => null,
      sessionContext,
      userQuestions,
      config: providerConfig,
    }),
    loginBridge,
  )
  const loginTool = loginTools.find((tool) => tool.name === 'chrome_headless_login')
  const runLogin = (args) => loginTool.execute({ ...args, backend: 'headless' }, newExec())
  try {
    await check('chrome_headless_login start/finish lifecycle (spawn stub, no visible window)', async () => {
      const started = await runLogin({ op: 'start', url: 'https://example.test/login' })
      assert.equal(started.running, true)
      assert.equal(started.alreadyRunning, false)
      assert.equal(started.pid, 4242)
      assert.equal(spawned.length, 1)
      assert.ok(spawned[0].args.some((arg) => arg.startsWith('--user-data-dir=') && arg.includes('headless/profile')))
      assert.ok(spawned[0].args.includes('--new-window'))
      assert.ok(spawned[0].args.includes('https://example.test/login'))
      const status = await runLogin({ op: 'status' })
      assert.equal(status.running, true)
      const finish = await runLogin({ op: 'finish' })
      assert.equal(finish.stopped, true)
      assert.equal(finish.running, false)
      assert.equal(stubChild.killed, 'SIGTERM')
    })
  } finally {
    await loginDriver.close()
    try {
      fs.rmSync(loginHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } catch {
      // a stub login profile under the temp dir is harmless if it lingers
    }
  }

  // --------------------------------------------------------- close session
  await check('chrome_close_session closes every owned tab', async () => {
    const value = await run('chrome_close_session')
    assert.ok(value.closed >= 1, `nothing closed: ${JSON.stringify(value)}`)
    const after = await run('chrome_tabs', { op: 'list' })
    assert.equal(after.tabs.length, 0)
  })

  // P1-3 fixed: start's hard confirmation passes site:null, so browser.site is
  // never resolved and no about:blank tab is created before loginStart. Spy on
  // loginStart so this check can never launch a visible window: it records the
  // tab count at the exact call site and refuses before spawning.
  const realLoginStart = driver.loginStart
  let loginStartTabs = null
  driver.loginStart = async function loginStartSpy() {
    loginStartTabs = this.tabs.size
    const error = new Error('sandbox login spy: refusing before spawn')
    error.code = 'SANDBOX_LOGIN_SPY'
    throw error
  }
  try {
    await expectError(
      'chrome_headless_login start reaches loginStart after close_session',
      () => run('chrome_headless_login', { op: 'start' }),
      { code: 'SANDBOX_LOGIN_SPY', match: /refusing before spawn/ },
    )
  } finally {
    driver.loginStart = realLoginStart
  }
  await check('login start confirmation no longer creates a tab before loginStart', () => {
    assert.equal(loginStartTabs, 0, `loginStart was reached with tabs=${loginStartTabs}, expected 0`)
    assert.equal(driver.tabs.size, 0)
  })
  assert.equal(driver.loginStatus().running, false)
  await run('chrome_close_session')

  await run('chrome_goto', { url: `${BASE}/` })
  await check('chrome_pointer shows, moves and hides the virtual pointer', async () => {
    const shown = await run('chrome_pointer', { op: 'show', selector: 'h1', label: 'DSH', pulse: true })
    assert.equal(shown.ok, true)
    assert.equal(shown.visible, true)
    const hidden = await run('chrome_pointer', { op: 'hide' })
    assert.equal(hidden.visible, false)
  })

  await check('chrome_annotate highlight/box/arrow/label/list/clear', async () => {
    const highlight = await run('chrome_annotate', { op: 'highlight', selector: 'h1', color: '#ff0' })
    assert.equal(highlight.ok, true)
    const box = await run('chrome_annotate', { op: 'box', selector: 'button' })
    assert.equal(box.ok, true)
    const circle = await run('chrome_annotate', { op: 'circle', selector: 'input' })
    assert.equal(circle.ok, true)
    const arrow = await run('chrome_annotate', { op: 'arrow', fromSelector: 'h1', selector: 'button', label: 'here' })
    assert.equal(arrow.ok, true)
    const label = await run('chrome_annotate', { op: 'label', selector: 'h1', label: 'title', index: 1 })
    assert.equal(label.ok, true)
    const list = await run('chrome_annotate', { op: 'list' })
    assert.equal(list.ok, true)
    assert.ok(list.count >= 5)
    const cleared = await run('chrome_annotate', { op: 'clear' })
    assert.equal(cleared.ok, true)
  })

  // --------------------------------------------------------------- coverage
  await check('all chrome_* tool definitions were exercised', () => {
    const missing = tools.map((tool) => tool.name).filter((name) => !covered.has(name))
    assert.deepEqual(missing, [], `tools never exercised: ${missing.join(', ')}`)
    assert.equal(tools.length, 43, 'expected 42 default tools + conditional chrome_evaluate')
  })

  await check('default registration is 42 tools (chrome_evaluate is opt-in)', () => {
    const defaultTools = chromeTools({
      bridge: router,
      attachments,
      assets: () => ({}),
      approval: () => null,
      sessionContext,
      userQuestions,
      config: () => ({}),
    })
    assert.equal(defaultTools.length, 42)
    assert.equal(defaultTools.some((tool) => tool.name === 'chrome_evaluate'), false)
  })

  console.log('')
  console.log(`SANDBOX SMOKE: PASS (${checks} checks, ${tools.length} tools, ${knownGaps.length} recorded gap(s))`)
  if (knownGaps.length > 0) {
    console.log('Known gaps (recorded in this run; see docs/SANDBOX-QA.md):')
    for (const item of knownGaps) console.log(`  - ${item.title}: ${item.detail}`)
  }
} finally {
  await driver.close()
  server.close()
  await new Promise((resolve) => setTimeout(resolve, 250))
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  if (previousUploadRoots === undefined) delete process.env.DSH_CHROME_UPLOAD_ROOTS
  else process.env.DSH_CHROME_UPLOAD_ROOTS = previousUploadRoots
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch {
    // temp profile cleanup is best-effort
  }
}
