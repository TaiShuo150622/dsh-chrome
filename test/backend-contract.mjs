/**
 * Backend capability contract tests (task-7 / docs/CAPABILITIES.md).
 *
 * Self-contained: no browser, no native host, no HTTP server, no ports. It only
 * imports the pure contract (src/capabilities.js) and the router
 * (src/backend.js) with fake backends. Run directly:
 *
 *   node test/backend-contract.mjs
 */
import assert from 'node:assert/strict'

import {
  BACKEND_CAPABILITIES,
  CAPABILITIES,
  KNOWN_BACKENDS,
  assertBackendSupports,
  backendSupports,
  capabilitiesFor,
  isKnownBackend,
} from '../src/capabilities.js'
import { BACKENDS, BackendRouter, wrapToolsForBackend } from '../src/backend.js'

let checks = 0
async function check(name, fn) {
  await fn()
  checks += 1
  console.log(`  ok  ${name}`)
}

// Capabilities that need a visible browser and a human in front of it.
const DESKTOP_ONLY = Object.freeze(['pick', 'pause'])

function fakeRouter(overrides = {}) {
  const calls = []
  const desktop = {
    connected: true,
    hostVersion: 'host-1',
    extensionVersion: 'ext-1',
    async call(method, params, timeoutMs) {
      calls.push({ backend: 'desktop', method, params, timeoutMs })
      return { backend: 'desktop', method, params }
    },
  }
  const headless = {
    connected: true,
    browserVersion: 'HeadlessChrome/test',
    async request(method, params) {
      calls.push({ backend: 'headless', method, params })
      return { backend: 'headless', method, params }
    },
  }
  const router = new BackendRouter({ desktop, headless, headlessSupported: true, ...overrides })
  return { router, desktop, headless, calls }
}

console.log('capability list + declared matrix')

await check('CAPABILITIES is the canonical unique list in display order', () => {
  assert.deepEqual(CAPABILITIES, [
    'frames',
    'shadow',
    'capture',
    'upload',
    'download',
    'pick',
    'screencast',
    'tabs',
    'pause',
    'evaluate',
  ])
  assert.equal(new Set(CAPABILITIES).size, CAPABILITIES.length, 'capability names are unique')
  assert.ok(Object.isFrozen(CAPABILITIES), 'CAPABILITIES is frozen')
})

await check('desktop declares the full capability set', () => {
  assert.deepEqual(BACKEND_CAPABILITIES.desktop, CAPABILITIES)
  for (const capability of CAPABILITIES) {
    assert.equal(backendSupports('desktop', capability), true, `desktop supports ${capability}`)
  }
})

await check('headless declares every capability except pick and pause', () => {
  const expected = CAPABILITIES.filter((name) => !DESKTOP_ONLY.includes(name))
  assert.deepEqual(BACKEND_CAPABILITIES.headless, expected)
  for (const capability of expected) {
    assert.equal(backendSupports('headless', capability), true, `headless supports ${capability}`)
  }
  for (const capability of DESKTOP_ONLY) {
    assert.equal(backendSupports('headless', capability), false, `headless lacks ${capability}`)
  }
})

await check('declared sets are frozen and backend names agree with the router enum', () => {
  assert.ok(Object.isFrozen(BACKEND_CAPABILITIES), 'BACKEND_CAPABILITIES is frozen')
  assert.ok(Object.isFrozen(BACKEND_CAPABILITIES.headless), 'headless set is frozen')
  assert.deepEqual(KNOWN_BACKENDS, ['desktop', 'headless'])
  assert.deepEqual(BACKENDS, KNOWN_BACKENDS)
  assert.deepEqual(BACKENDS, ['desktop', 'headless'])
})

await check('unknown backend is safely unsupported (pure functions never throw)', () => {
  for (const backend of ['firefox', 'remote-cloud', '', 'DESKTOP', undefined, null, 42, {}]) {
    assert.equal(isKnownBackend(backend), false, `isKnownBackend(${String(backend)})`)
    assert.deepEqual(capabilitiesFor(backend), [], `capabilitiesFor(${String(backend)})`)
    for (const capability of CAPABILITIES) {
      assert.equal(backendSupports(backend, capability), false, `${String(backend)} must not support ${capability}`)
    }
  }
})

await check('unknown capability is safely unsupported', () => {
  for (const backend of KNOWN_BACKENDS) {
    for (const capability of ['teleport', '', 'frames.deep', null, undefined, 1, {}]) {
      assert.equal(backendSupports(backend, capability), false, `${backend} must not support ${String(capability)}`)
    }
  }
})

await check('assertBackendSupports returns true for supported pairs', () => {
  assert.equal(assertBackendSupports('desktop', 'pick'), true)
  assert.equal(assertBackendSupports('desktop', 'pause'), true)
  assert.equal(assertBackendSupports('headless', 'frames'), true)
  assert.equal(assertBackendSupports('headless', 'capture'), true)
})

await check('assertBackendSupports throws UNSUPPORTED_BACKEND for missing capabilities', () => {
  assert.throws(
    () => assertBackendSupports('headless', 'pick'),
    (error) => {
      assert.equal(error.code, 'UNSUPPORTED_BACKEND')
      assert.equal(error.backend, 'headless')
      assert.equal(error.capability, 'pick')
      assert.match(error.message, /headless/)
      assert.match(error.message, /pick/)
      return true
    },
  )
  assert.throws(() => assertBackendSupports('headless', 'pause'), { code: 'UNSUPPORTED_BACKEND' })
  assert.throws(() => assertBackendSupports('desktop', 'teleport'), { code: 'UNSUPPORTED_BACKEND' })
})

await check('assertBackendSupports reports unknown backend and appends a detail hint', () => {
  assert.throws(
    () => assertBackendSupports('firefox', 'tabs'),
    (error) => {
      assert.equal(error.code, 'UNSUPPORTED_BACKEND')
      assert.match(error.message, /unknown backend "firefox"/)
      assert.match(error.message, /known: desktop, headless/)
      return true
    },
  )
  assert.throws(
    () => assertBackendSupports('headless', 'pick', 'use backend:"desktop" for pick'),
    /use backend:"desktop" for pick/,
  )
})

console.log('router: current-backend capabilities (AsyncLocalStorage)')

await check('outside a routed call the router reports the desktop default', () => {
  const { router } = fakeRouter()
  assert.equal(router.backend, 'desktop')
  assert.deepEqual(router.capabilities, CAPABILITIES)
  for (const capability of CAPABILITIES) assert.equal(router.supports(capability), true, capability)
  assert.equal(router.supports('teleport'), false, 'unknown capability is false')
  assert.equal(router.supports(undefined), false, 'non-string capability is false')
})

await check('inside runWithBackend("headless") the router reports the headless set', () => {
  const { router } = fakeRouter()
  router.runWithBackend('headless', () => {
    assert.equal(router.backend, 'headless')
    assert.deepEqual(router.capabilities, BACKEND_CAPABILITIES.headless)
    assert.equal(router.supports('frames'), true)
    assert.equal(router.supports('capture'), true)
    assert.equal(router.supports('pick'), false)
    assert.equal(router.supports('pause'), false)
    assert.equal(router.supports('teleport'), false)
  })
  // ALS scope is exited, not leaked.
  assert.equal(router.backend, 'desktop')
  assert.equal(router.supports('pick'), true)
})

await check('concurrent routed calls cannot mix capabilities (one router, two backends)', async () => {
  const { router } = fakeRouter()
  const [headlessView, desktopView] = await Promise.all([
    router.runWithBackend('headless', async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return { backend: router.backend, pick: router.supports('pick'), count: router.capabilities.length }
    }),
    router.runWithBackend('desktop', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { backend: router.backend, pick: router.supports('pick'), count: router.capabilities.length }
    }),
  ])
  assert.deepEqual(headlessView, { backend: 'headless', pick: false, count: BACKEND_CAPABILITIES.headless.length })
  assert.deepEqual(desktopView, { backend: 'desktop', pick: true, count: CAPABILITIES.length })
  assert.equal(router.backend, 'desktop')
  assert.equal(router.capabilities.length, CAPABILITIES.length)
})

await check('injected headlessCapabilities overrides only the headless set', () => {
  const { router } = fakeRouter({ headlessCapabilities: ['frames', 'capture'] })
  assert.deepEqual(
    router.runWithBackend('headless', () => router.capabilities),
    ['frames', 'capture'],
    'injected list is returned in canonical order',
  )
  router.runWithBackend('headless', () => {
    assert.equal(router.supports('frames'), true)
    assert.equal(router.supports('capture'), true)
    assert.equal(router.supports('tabs'), false, 'declared-but-overridden capability is now false')
    assert.equal(router.supports('pick'), false)
  })
  assert.equal(router.runWithBackend('desktop', () => router.supports('tabs')), true, 'desktop is unaffected')
  assert.deepEqual(router.runWithBackend('desktop', () => router.capabilities), CAPABILITIES)
})

await check('injected headlessCapabilities accepts a Set, de-duplicates, and rejects nonsense early', () => {
  const { router } = fakeRouter({ headlessCapabilities: new Set(['capture', 'frames', 'frames']) })
  assert.deepEqual(router.runWithBackend('headless', () => router.capabilities), ['frames', 'capture'])

  const empty = fakeRouter({ headlessCapabilities: [] }).router
  assert.deepEqual(empty.runWithBackend('headless', () => empty.capabilities), [])
  assert.equal(empty.runWithBackend('headless', () => empty.supports('frames')), false)

  assert.throws(() => fakeRouter({ headlessCapabilities: 'frames' }), TypeError, 'string is not an iterable of names')
  assert.throws(() => fakeRouter({ headlessCapabilities: 42 }), TypeError)
  assert.throws(() => fakeRouter({ headlessCapabilities: ['frames', 'teleport'] }), TypeError, 'unknown capability name')
  assert.throws(() => fakeRouter({ headlessCapabilities: [42] }), TypeError, 'non-string entry')
})

await check('router.capabilities is frozen contract data', () => {
  const { router } = fakeRouter()
  assert.ok(Object.isFrozen(router.capabilities))
  assert.throws(() => router.capabilities.push('teleport'), TypeError)
  assert.equal(router.supports('teleport'), false)
  assert.throws(() => {
    BACKEND_CAPABILITIES.desktop = []
  }, TypeError)
})

console.log('router: capability is the contract, not runtime availability')

await check('a missing headless driver keeps the declared capability but fails the call', async () => {
  const { router } = fakeRouter({ headless: null, headlessSupported: false })
  await assert.rejects(
    router.runWithBackend('headless', async () => {
      assert.equal(router.supports('frames'), true, 'capability is type-level')
      assert.equal(router.connected, false, 'availability is separate')
      return router.call('tab.frames', {})
    }),
    (error) => {
      assert.equal(error.code, 'UNSUPPORTED_BACKEND')
      return true
    },
  )
})

console.log('router: routing / call behavior is unchanged')

await check('call still routes desktop -> desktop.call and headless -> headless.request', async () => {
  const { router, calls } = fakeRouter()

  const desktopResult = await router.call('tab.probe', { value: 'd' }, 4321)
  assert.deepEqual(desktopResult, { backend: 'desktop', method: 'tab.probe', params: { value: 'd' } })
  assert.deepEqual(calls.at(-1), { backend: 'desktop', method: 'tab.probe', params: { value: 'd' }, timeoutMs: 4321 })

  const headlessResult = await router.runWithBackend('headless', () => router.call('tab.probe', { value: 'h' }, 4321))
  assert.deepEqual(headlessResult, { backend: 'headless', method: 'tab.probe', params: { value: 'h' } })
  assert.equal(calls.at(-1).backend, 'headless')
  assert.equal(calls.filter((call) => call.backend === 'headless').length, 1)
})

await check('connected / hostVersion / extensionVersion semantics are unchanged', () => {
  const { router } = fakeRouter()
  assert.equal(router.connected, true)
  assert.equal(router.hostVersion, 'host-1')
  assert.equal(router.extensionVersion, 'ext-1')
  router.runWithBackend('headless', () => {
    assert.equal(router.connected, true)
    assert.equal(router.hostVersion, null)
    assert.equal(router.extensionVersion, null)
  })
})

await check('wrapToolsForBackend still injects the backend enum and strips the argument', async () => {
  const { router, calls } = fakeRouter()
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
  assert.equal(tool.parameters.properties.backend.enum, BACKENDS)
  assert.deepEqual(tool.parameters.properties.backend.enum, ['desktop', 'headless'])
  assert.match(tool.description, /backend:"headless"/)

  const result = await tool.execute({ value: 'x', backend: 'headless' }, {})
  assert.equal(result.backend, 'headless', 'the backend argument selects the route')
  assert.equal('backend' in calls.at(-1).params, false, 'backend is stripped before the tool sees args')
  assert.equal(calls.at(-1).params.value, 'x')
})

await check('runWithBackend keeps its existing coercion for unexpected modes', async () => {
  const { router, calls } = fakeRouter()
  assert.equal(router.runWithBackend('firefox', () => router.backend), 'desktop')
  assert.equal(router.runWithBackend(undefined, () => router.backend), 'desktop')
  assert.equal(router.runWithBackend('headless', () => router.backend), 'headless')
  await router.runWithBackend('firefox', () => router.call('tab.probe', {}))
  assert.equal(calls.at(-1).backend, 'desktop', 'unknown mode still falls back to the desktop route')
})

console.log(`\nBACKEND CONTRACT TEST: PASS (${checks} checks)`)
