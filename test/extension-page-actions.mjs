import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8')
const start = source.indexOf('const PAGE_ACTIONS = {')
assert.notEqual(start, -1, 'PAGE_ACTIONS object must exist')
const end = source.indexOf('\n}', start)
assert.notEqual(end, -1, 'PAGE_ACTIONS object must close')
const body = source.slice(start, end)
const keys = [...body.matchAll(/^  ([A-Za-z_$][\w$]*):/gm)].map((match) => match[1])
const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index)
assert.deepEqual(duplicates, [], `duplicate PAGE_ACTIONS keys: ${duplicates.join(', ')}`)
// P4: PAGE_ACTIONS is evaluated through CDP Runtime.evaluate in the page's MAIN
// world. The overlay must never be registered there, or a page could read/call
// window.__dshOverlay; it goes through chrome.scripting world:"ISOLATED".
assert.ok(!keys.includes('overlay'), 'overlay must not be a MAIN-world PAGE_ACTIONS handler')
assert.ok(keys.includes('overlayDraw'), 'drawRefOverlay must not shadow the overlay handler')

// Every overlay injection/invocation must name the isolated world explicitly
// (the manifest content script runs there by default).
const overlayStart = source.indexOf('function overlayRunner')
assert.notEqual(overlayStart, -1, 'overlayRunner must exist')
const overlayEnd = source.indexOf('async function overlayAction', overlayStart)
assert.notEqual(overlayEnd, -1, 'overlayAction must follow the overlay helpers')
const overlaySource = source.slice(overlayStart, overlayEnd)
assert.ok(overlaySource.includes("world: 'ISOLATED'"), 'overlay scripting calls must use world:"ISOLATED"')
assert.ok(!overlaySource.includes("world: 'MAIN'"), 'overlay must never be injected into MAIN world')

// The MAIN-world cursor helper may only publish coordinates on a DOM event; it
// must not reach for the isolated overlay object (it cannot see it, and a page
// could otherwise call the overlay).
const cursorStart = source.indexOf('function cursorHelperSrc')
assert.notEqual(cursorStart, -1, 'cursorHelperSrc must exist')
const cursorEnd = source.indexOf('// Shared page-side detector', cursorStart)
assert.notEqual(cursorEnd, -1, 'cursorHelperSrc must be followed by the page detector')
const cursorSource = source.slice(cursorStart, cursorEnd)
assert.ok(!cursorSource.includes('__dshOverlay'), 'MAIN-world cursor helper must not reference __dshOverlay')
assert.ok(source.includes("const CURSOR_EVENT = '__dsh_cursor_follow__'"), 'cursor event name must be defined')
assert.ok(cursorSource.includes('CURSOR_EVENT'), 'cursor helper must publish coordinates for the isolated overlay')

console.log('EXTENSION PAGE ACTIONS TEST: PASS')
