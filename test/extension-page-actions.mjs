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
assert.ok(keys.includes('overlay'), 'overlay handler must remain registered')
assert.ok(keys.includes('overlayDraw'), 'drawRefOverlay must not shadow the overlay handler')
console.log('EXTENSION PAGE ACTIONS TEST: PASS')
