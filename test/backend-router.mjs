import assert from 'node:assert/strict'
import { BackendRouter, wrapToolsForBackend } from '../src/backend.js'

const calls = []
const desktop = {
  connected: true,
  hostVersion: 'host-1',
  extensionVersion: 'ext-1',
  async call(method, params) {
    calls.push({ backend: 'desktop', method, params })
    return { backend: 'desktop', method }
  },
}
const headless = {
  connected: true,
  browserVersion: 'HeadlessChrome/1',
  async request(method, params) {
    calls.push({ backend: 'headless', method, params })
    return { backend: 'headless', method }
  },
}
const router = new BackendRouter({ desktop, headless, headlessSupported: true })
const tools = [
  {
    name: 'chrome_probe',
    description: 'probe',
    parameters: { type: 'object', properties: { value: { type: 'string' } }, additionalProperties: false },
    async execute(args) {
      return router.call('tab.probe', { value: args?.value ?? null })
    },
  },
]
const [tool] = wrapToolsForBackend(tools, router)
assert.ok(tool.parameters.properties.backend, 'backend parameter is injected')
assert.deepEqual(tool.parameters.properties.backend.enum, ['desktop', 'headless'])

const desktopResult = await tool.execute({ value: 'desktop-case' }, {})
assert.deepEqual(desktopResult, { backend: 'desktop', method: 'tab.probe' })
assert.equal(calls.at(-1).params.value, 'desktop-case')
assert.equal('backend' in calls.at(-1).params, false, 'backend is stripped before the tool sees args')

const headlessResult = await tool.execute({ value: 'headless-case', backend: 'headless' }, {})
assert.deepEqual(headlessResult, { backend: 'headless', method: 'tab.probe' })
assert.equal(calls.at(-1).params.value, 'headless-case')

const agentA = tool.execute({ value: 'a', backend: 'headless' }, {})
const agentB = tool.execute({ value: 'b' }, {})
await Promise.all([agentA, agentB])
assert.equal(router.backend, 'desktop')
assert.equal(router.connected, true)
router.runWithBackend('headless', () => {
  assert.equal(router.backend, 'headless')
  assert.equal(router.hostVersion, null)
})
console.log('BACKEND ROUTER TEST: PASS')
