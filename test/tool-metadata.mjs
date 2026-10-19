import assert from 'node:assert/strict'

import { chromeTools } from '../src/tools.js'
import { isWriteTool } from '../src/tool-guards.js'

// Build the real tool definitions (the same factory index.js calls) instead of
// regex-scanning src/tools.js, so metadata is validated where it is consumed.
const tools = chromeTools({
  bridge: { call: async () => ({}), supports: () => true },
  config: () => ({ allowEvaluate: true }),
})
const byName = new Map(tools.map((tool) => [tool.name, tool]))
assert.equal(tools.length, 46, 'expected 45 default tools + conditional chrome_evaluate')

// Tools that mutate the user's browser. Keep this list in sync with the
// definitions: a write tool without `mutating: true` would silently skip the
// write lease, and a read-only tool with it would acquire a needless lease.
const WRITE_TOOLS = [
  'chrome_goto',
  'chrome_click',
  'chrome_click_at',
  'chrome_type',
  'chrome_press',
  'chrome_scroll',
  'chrome_select',
  'chrome_drag',
  'chrome_upload',
  'chrome_tabs',
  'chrome_history',
  'chrome_hover',
  'chrome_storage',
  'chrome_emulate',
  'chrome_close_session',
  'chrome_evaluate',
  'chrome_pointer',
  'chrome_annotate',
  'chrome_pdf',
]
for (const name of WRITE_TOOLS) {
  const tool = byName.get(name)
  assert.ok(tool, `${name} must be registered`)
  assert.equal(tool.mutating, true, `${name} must declare mutating: true`)
}
for (const tool of tools) {
  assert.equal(tool.mutating === true, WRITE_TOOLS.includes(tool.name), `${tool.name} mutating metadata is out of sync with the write-tool list`)
}

// Read-only tools must not be accidentally marked mutating.
for (const name of ['chrome_snapshot', 'chrome_get_text', 'chrome_status', 'chrome_screenshot', 'chrome_lease', 'chrome_verify']) {
  assert.notEqual(byName.get(name)?.mutating, true, `${name} must stay read-only`)
}

// Stateful tools change provider-side state (contexts/capture/screencast) but
// not the page: they declare both facts explicitly.
for (const name of ['chrome_context', 'chrome_screencast', 'chrome_capture_start', 'chrome_capture_stop']) {
  const tool = byName.get(name)
  assert.ok(tool, `${name} must be registered`)
  assert.equal(tool.mutating, false, `${name} must declare mutating: false`)
  assert.equal(tool.stateful, true, `${name} must declare stateful: true`)
}

// The runtime guard reads only the definition. Names (or objects without the
// metadata) never imply mutating, so there is no parallel name list to drift.
for (const tool of tools) {
  assert.equal(isWriteTool(tool), tool.mutating === true, `${tool.name} guard must follow its metadata`)
}
for (const name of WRITE_TOOLS) {
  assert.equal(isWriteTool(name), false, `a bare tool name (${name}) must not imply mutating`)
}
assert.equal(isWriteTool({ name: 'chrome_click' }), false, 'an object without mutating must not be a write tool')
assert.equal(isWriteTool(null), false)
assert.equal(isWriteTool(undefined), false)

console.log('TOOL METADATA TEST: PASS')
