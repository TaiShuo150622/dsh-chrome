import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { WRITE_TOOLS } from '../src/tool-guards.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = fs.readFileSync(path.join(root, 'src', 'tools.js'), 'utf8')
for (const name of WRITE_TOOLS) {
  const pattern = new RegExp(`name: '${name}',\\n    mutating: true,`)
  assert.match(source, pattern, `${name} must declare mutating: true`)
}
// Read-only tools must not be accidentally marked mutating.
for (const name of ['chrome_snapshot', 'chrome_get_text', 'chrome_status', 'chrome_screenshot', 'chrome_lease', 'chrome_verify']) {
  const pattern = new RegExp(`name: '${name}',\\n    mutating: true,`)
  assert.doesNotMatch(source, pattern, `${name} must stay read-only`)
}
console.log('TOOL METADATA TEST: PASS')
