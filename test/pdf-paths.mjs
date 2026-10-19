/**
 * chrome_pdf path containment (H2), no Chrome required.
 *
 * The PDF tool is a filesystem write primitive, so an explicit path must stay
 * inside the provider PDF cache or the session working directory, must name a
 * new file, must not traverse a symlink out of those roots, must not replace
 * provider state (policy/config/audit/operations), and must be hard-confirmed
 * with the full path before the browser is asked for the PDF.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { chromeTools } from '../src/tools.js'

const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-chrome-pdf-'))
process.env.DSH_HOME = home
const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-chrome-pdf-cwd-'))
const cacheDir = path.join(home, 'cache', 'dsh-chrome', 'pdfs')
await fsp.mkdir(cacheDir, { recursive: true })

const PDF_BYTES = Buffer.from('%PDF-1.4\n%%EOF\n')

let pdfCalls = 0
const bridge = {
  async call(method) {
    if (method === 'tab.pdf') {
      pdfCalls += 1
      return { dataBase64: PDF_BYTES.toString('base64') }
    }
    throw new Error(`pdf-paths fake does not implement ${method}`)
  },
}

function makeTools({ approve = true, sessionCwd = cwd, questions = [] } = {}) {
  return chromeTools({
    bridge,
    attachments: () => null,
    assets: () => ({}),
    approval: () => null,
    sessionContext: () => ({ sessions: { get: () => ({ header: { cwd: sessionCwd } }) } }),
    userQuestions: () => ({
      async ask(request) {
        const question = request?.questions?.[0] || {}
        questions.push({ header: String(question.header || ''), question: String(question.question || '') })
        return { answers: [{ id: 'confirm', selected: [approve ? '允许一次' : '拒绝'] }] }
      },
    }),
    config: () => ({ evaluateConfirmTimeoutMs: 5000 }),
  })
}

const exec = () => ({ agent: { id: 'pdf-paths-session' }, callId: 'pdf-paths-call', signal: new AbortController().signal })

async function expectError(promise, code, label, pattern = null) {
  try {
    await promise
  } catch (error) {
    assert.equal(error?.code, code, `${label}: expected ${code}, got ${error?.code} (${error?.message})`)
    if (pattern) assert.match(String(error?.message || ''), pattern, label)
    return
  }
  assert.fail(`${label}: expected ${code}, call succeeded`)
}

const questions = []
const tools = makeTools({ questions })
const pdf = tools.find((tool) => tool.name === 'chrome_pdf')
assert.ok(pdf, 'chrome_pdf must be registered')
assert.equal(pdf.mutating, true, 'chrome_pdf must declare mutating: true for the write lease')

// Default exports stay in the PDF cache and never prompt.
const defaultPdf = await pdf.execute({}, exec())
assert.ok(defaultPdf?.path?.startsWith(`${cacheDir}${path.sep}`), `default path outside pdfs cache: ${defaultPdf?.path}`)
assert.ok(fs.existsSync(defaultPdf.path), 'default PDF was not written')
assert.equal(fs.readFileSync(defaultPdf.path).subarray(0, 5).toString('latin1'), '%PDF-')
assert.equal(questions.length, 0, 'default PDF must not ask for confirmation')

// Explicit path inside the PDF cache: confirmed, question names the full path.
const cacheTarget = path.join(cacheDir, 'explicit', 'inside.pdf')
const fromCache = await pdf.execute({ path: cacheTarget }, exec())
assert.equal(fromCache.path, cacheTarget)
assert.ok(fs.existsSync(cacheTarget), 'explicit cache PDF was not written')
assert.equal(questions.length, 1, 'explicit path must ask exactly once')
assert.match(questions[0].header, /PDF/)
assert.ok(questions[0].question.includes(cacheTarget), `confirmation does not show the full path: ${questions[0].question}`)

// Explicit path inside the session cwd is allowed.
const cwdTarget = path.join(cwd, 'nested', 'from-cwd.pdf')
const fromCwd = await pdf.execute({ path: cwdTarget }, exec())
assert.equal(fromCwd.path, cwdTarget)
assert.ok(fs.existsSync(cwdTarget), 'explicit cwd PDF was not written')
assert.ok(questions[1].question.includes(cwdTarget), 'cwd confirmation does not show the full path')

// Relative paths are rejected before prompting.
const beforeRelative = questions.length
await expectError(pdf.execute({ path: 'relative.pdf' }, exec()), 'INVALID_ARGUMENT', 'relative path', /absolute/)
assert.equal(questions.length, beforeRelative, 'relative path must not prompt')

// Paths outside both roots are rejected, including .. traversal out of the cache.
await expectError(pdf.execute({ path: path.join(home, 'outside.pdf') }, exec()), 'INVALID_ARGUMENT', 'outside roots', /path escape/)
await expectError(
  pdf.execute({ path: path.join(cacheDir, '..', 'evil.pdf') }, exec()),
  'INVALID_ARGUMENT',
  'cache parent traversal',
  /path escape/,
)
assert.ok(!fs.existsSync(path.join(home, 'outside.pdf')), 'outside path was written')
assert.ok(!fs.existsSync(path.join(home, 'cache', 'dsh-chrome', 'evil.pdf')), 'traversal path was written')

// Existing files are never replaced, even when the path is allowed.
const existing = path.join(cacheDir, 'existing.pdf')
await fsp.writeFile(existing, 'sentinel')
const beforeExisting = questions.length
await expectError(pdf.execute({ path: existing }, exec()), 'INVALID_ARGUMENT', 'existing file', /overwrite/)
assert.equal(await fsp.readFile(existing, 'utf8'), 'sentinel', 'existing file was modified')
assert.equal(questions.length, beforeExisting, 'existing path must not prompt')

// A symlinked file is refused, not followed. A link that resolves outside the
// roots fails containment; a link that stays inside fails the existing-file
// check, so the linked file is never replaced.
const secret = path.join(home, 'secret.txt')
await fsp.writeFile(secret, 'outside-sentinel')
const linkTarget = path.join(cacheDir, 'link.pdf')
await fsp.symlink(secret, linkTarget)
await expectError(pdf.execute({ path: linkTarget }, exec()), 'INVALID_ARGUMENT', 'symlinked file', /path escape/)
assert.equal(await fsp.readFile(secret, 'utf8'), 'outside-sentinel', 'symlink target was modified')
const insideExisting = path.join(cacheDir, 'inside-existing.pdf')
await fsp.writeFile(insideExisting, 'inside-sentinel')
const insideLink = path.join(cacheDir, 'inside-link.pdf')
await fsp.symlink(insideExisting, insideLink)
await expectError(pdf.execute({ path: insideLink }, exec()), 'INVALID_ARGUMENT', 'symlink inside roots', /overwrite/)
assert.equal(await fsp.readFile(insideExisting, 'utf8'), 'inside-sentinel', 'inside symlink target was modified')
const dangling = path.join(cacheDir, 'dangling.pdf')
await fsp.symlink(path.join(home, 'does-not-exist.pdf'), dangling)
await expectError(pdf.execute({ path: dangling }, exec()), 'INVALID_ARGUMENT', 'dangling symlink', /overwrite/)

// A symlinked parent directory cannot smuggle the write outside the roots.
const outsideDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-chrome-pdf-outside-'))
const linkDir = path.join(cacheDir, 'linkdir')
await fsp.symlink(outsideDir, linkDir)
await expectError(
  pdf.execute({ path: path.join(linkDir, 'escape.pdf') }, exec()),
  'INVALID_ARGUMENT',
  'symlinked parent',
  /path escape/,
)
assert.ok(!fs.existsSync(path.join(outsideDir, 'escape.pdf')), 'symlinked parent escaped the roots')
const cwdLink = path.join(cwd, 'link-out')
await fsp.symlink(outsideDir, cwdLink)
await expectError(
  pdf.execute({ path: path.join(cwdLink, 'escape2.pdf') }, exec()),
  'INVALID_ARGUMENT',
  'symlinked cwd parent',
  /path escape/,
)

// Provider state cannot be replaced from the session cwd (here the session cwd
// is DSH_HOME, so the state files are inside an allowed root).
const homeTools = makeTools({ sessionCwd: home })
const homePdf = homeTools.find((tool) => tool.name === 'chrome_pdf')
const stateDir = path.join(home, 'cache', 'dsh-chrome')
await fsp.mkdir(stateDir, { recursive: true })
await expectError(
  homePdf.execute({ path: path.join(stateDir, 'operations.jsonl') }, exec()),
  'INVALID_ARGUMENT',
  'provider state file',
  /provider state/,
)
assert.ok(!fs.existsSync(path.join(stateDir, 'operations.jsonl')), 'provider state file was created')
await fsp.writeFile(path.join(stateDir, 'policy.json'), '{"mode":"allow"}')
await expectError(
  homePdf.execute({ path: path.join(stateDir, 'policy.json') }, exec()),
  'INVALID_ARGUMENT',
  'policy.json overwrite',
)
assert.equal(await fsp.readFile(path.join(stateDir, 'policy.json'), 'utf8'), '{"mode":"allow"}', 'policy.json was modified')

// Refusing the hard confirmation fails closed before the browser call.
const denyTools = makeTools({ approve: false })
const denyPdf = denyTools.find((tool) => tool.name === 'chrome_pdf')
const denyTarget = path.join(cacheDir, 'denied.pdf')
const callsBeforeDeny = pdfCalls
await expectError(denyPdf.execute({ path: denyTarget }, exec()), 'APPROVAL_DENIED', 'denied confirmation', /not approved/)
assert.equal(pdfCalls, callsBeforeDeny, 'denied confirmation must not call tab.pdf')
assert.ok(!fs.existsSync(denyTarget), 'denied confirmation wrote a file')

// Headless { path, bytes } envelope: move the driver-written PDF into a
// contained explicit target and leave no orphan behind.
const source = path.join(home, 'driver-written.pdf')
await fsp.writeFile(source, PDF_BYTES)
const driverBridge = {
  async call(method) {
    if (method === 'tab.pdf') return { path: source, bytes: PDF_BYTES.length }
    throw new Error(`pdf-paths driver fake does not implement ${method}`)
  },
}
const driverTools = chromeTools({
  bridge: driverBridge,
  attachments: () => null,
  assets: () => ({}),
  approval: () => null,
  sessionContext: () => ({ sessions: { get: () => ({ header: { cwd } }) } }),
  userQuestions: () => ({ ask: async () => ({ answers: [{ id: 'confirm', selected: ['允许一次'] }] }) }),
  config: () => ({ evaluateConfirmTimeoutMs: 5000 }),
})
const driverPdf = driverTools.find((tool) => tool.name === 'chrome_pdf')
const moveTarget = path.join(cacheDir, 'headless', 'moved.pdf')
const moved = await driverPdf.execute({ path: moveTarget }, exec())
assert.equal(moved.path, moveTarget)
assert.equal(moved.bytes, PDF_BYTES.length)
assert.equal(fs.readFileSync(moveTarget).subarray(0, 5).toString('latin1'), '%PDF-')
assert.ok(!fs.existsSync(source), 'headless driver source was not removed after the move')

console.log('PDF PATHS TEST: PASS')
