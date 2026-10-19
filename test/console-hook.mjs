/**
 * M5 — `extension/console-hook.js` bounded ring buffer (no Chrome required).
 *
 * The hook runs in the page's MAIN world at document_start and patches
 * console.*. A page can log in a loop, so the buffer must be a hard-bounded
 * ring (500 entries) with per-entry truncation (2000 chars): without both, a
 * chatty page grows the tab's memory until the extension dies.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = fs.readFileSync(path.join(root, 'extension', 'console-hook.js'), 'utf8')

const originalCalls = []
const fakeConsole = {}
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  fakeConsole[level] = (...args) => originalCalls.push({ level, args })
}
const listeners = new Map()
const window = {
  addEventListener(type, listener) {
    listeners.set(type, listener)
  },
}
const sandbox = {
  window,
  console: fakeConsole,
  Date,
  Error,
  JSON,
  Object,
  String,
  Array,
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox)

const hook = window.__dshConsole
assert.ok(hook, 'the hook must expose window.__dshConsole')
assert.equal(Array.isArray(hook.entries), true)
assert.equal(hook.entries.length, 0)

// Normal formatting and the original console function still runs.
fakeConsole.log('hello', { a: 1 })
assert.equal(originalCalls.length, 1, 'the original console.log must still be called')
assert.equal(hook.entries.length, 1)
assert.equal(hook.entries[0].level, 'log')
assert.equal(hook.entries[0].text, 'hello {"a":1}')
assert.equal(typeof hook.entries[0].time, 'number')

// 600 calls keep exactly the newest 500 (hard cap).
for (let index = 0; index < 600; index += 1) fakeConsole.log(`entry-${index}`)
assert.equal(hook.entries.length, 500, 'the ring must be capped at 500 entries')
assert.equal(hook.entries[0].text, 'entry-100')
assert.equal(hook.entries.at(-1).text, 'entry-599')

// One oversized entry is truncated to 2000 chars and does not evict the ring.
fakeConsole.log('x'.repeat(5000))
assert.equal(hook.entries.at(-1).text.length, 2000, 'a single entry must be truncated')
assert.equal(hook.entries.length, 500)

// Truncation applies to the joined argument text, not per argument: three
// 1000-char arguments still yield one 2000-char entry.
fakeConsole.log('a'.repeat(1000), 'b'.repeat(1000), 'c'.repeat(1000))
assert.equal(hook.entries.at(-1).text.length, 2000, 'joined argument text must be truncated')

// Uncaught errors and unhandled rejections use the same bounded path.
listeners.get('error')?.({ message: 'boom', filename: 'app.js', lineno: 9 })
assert.equal(hook.entries.at(-1).level, 'error')
assert.match(hook.entries.at(-1).text, /boom/)
assert.match(hook.entries.at(-1).text, /app\.js:9/)
listeners.get('unhandledrejection')?.({ reason: new Error('nope') })
assert.match(hook.entries.at(-1).text, /Unhandled rejection Error: nope/)

// The page can clear the buffer without replacing the hook.
hook.clear()
assert.equal(hook.entries.length, 0)
fakeConsole.info('after-clear')
assert.equal(hook.entries.length, 1)

// Re-injection (e.g. SPA navigation) keeps the first hook instead of stacking
// a second set of console wrappers.
vm.runInContext(source, sandbox)
assert.equal(window.__dshConsole, hook, 're-running the hook must not replace the buffer')
assert.equal(hook.entries.length, 1)

console.log('CONSOLE HOOK TEST: PASS')
