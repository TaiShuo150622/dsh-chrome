/**
 * Backend router: every chrome_* tool keeps one schema, but an optional
 * `backend` argument selects between the desktop extension bridge and the
 * background headless Chromium driver. AsyncLocalStorage carries the choice
 * through the async tool execution so concurrent calls cannot mix backends.
 *
 * The router is also the runtime read side of the capability contract
 * (src/capabilities.js): `capabilities` and `supports(capability)` answer for
 * the backend carried by AsyncLocalStorage, without changing routing/call
 * behavior.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

import {
  CAPABILITIES,
  backendSupports,
  capabilitiesFor,
} from './capabilities.js'

const backendStorage = new AsyncLocalStorage()

/**
 * Backend enum exposed to the tools' `backend` parameter (declaration order).
 * Keep in sync with KNOWN_BACKENDS in src/capabilities.js; test/backend-contract.mjs
 * asserts the two agree, and runWithBackend()/call() below own the actual routing.
 */
export const BACKENDS = ['desktop', 'headless']

/**
 * Normalize an injected capability override for the headless backend.
 * `null`/`undefined` means "use the declared headless contract".
 */
function normalizeCapabilities(input) {
  if (input == null) return null
  if (typeof input === 'string' || typeof input?.[Symbol.iterator] !== 'function') {
    throw new TypeError('headlessCapabilities must be an iterable of capability names (or null to use the declared contract)')
  }
  const values = new Set(input)
  for (const value of values) {
    if (typeof value !== 'string') throw new TypeError('headlessCapabilities entries must be strings')
    if (!CAPABILITIES.includes(value)) {
      throw new TypeError(`unknown capability "${value}" in headlessCapabilities (known: ${CAPABILITIES.join(', ')})`)
    }
  }
  // Canonical order, frozen: a capability list is contract data, not a mutable
  // handle owned by the caller.
  return Object.freeze(CAPABILITIES.filter((name) => values.has(name)))
}

export function currentBackend() {
  return backendStorage.getStore() || 'desktop'
}

export class BackendRouter {
  /**
   * @param {object} options
   * @param {{ call: Function, connected?: boolean }} options.desktop
   * @param {{ request: Function, connected?: boolean } | null} [options.headless]
   * @param {boolean} [options.headlessSupported]
   * @param {Iterable<string> | null} [options.headlessCapabilities] override the
   *   capability set declared for the headless backend (e.g. an embedded or
   *   remote driver that only implements a subset). Defaults to the declared
   *   headless contract from src/capabilities.js.
   */
  constructor({ desktop, headless = null, headlessSupported = false, headlessCapabilities = null }) {
    this.desktop = desktop
    this.headless = headless
    this.headlessSupported = headlessSupported
    this.headlessCapabilities = normalizeCapabilities(headlessCapabilities)
  }

  get backend() {
    return currentBackend()
  }

  /**
   * Capability names declared by the backend carried by AsyncLocalStorage at
   * this point (frozen array). Outside a wrapped tool call this is the desktop
   * backend, matching the default route. Unknown backend -> empty array.
   */
  get capabilities() {
    const backend = currentBackend()
    if (backend === 'headless' && this.headlessCapabilities) return this.headlessCapabilities
    return capabilitiesFor(backend)
  }

  /**
   * Whether the backend carried by AsyncLocalStorage declares `capability`.
   * Unknown backend/capability -> false (safe, never throws).
   *
   * This answers the contract question only; runtime availability is separate
   * (`connected`, or the UNSUPPORTED_BACKEND thrown by `call` when no driver
   * exists).
   */
  supports(capability) {
    const backend = currentBackend()
    if (typeof capability !== 'string') return false
    if (backend === 'headless' && this.headlessCapabilities) return this.headlessCapabilities.includes(capability)
    return backendSupports(backend, capability)
  }

  get connected() {
    if (currentBackend() === 'headless') return Boolean(this.headless?.connected)
    return Boolean(this.desktop?.connected)
  }

  get hostVersion() {
    return currentBackend() === 'headless' ? null : this.desktop?.hostVersion ?? null
  }

  get extensionVersion() {
    return currentBackend() === 'headless' ? null : this.desktop?.extensionVersion ?? null
  }

  set extensionVersion(value) {
    if (this.desktop) this.desktop.extensionVersion = value
  }

  headlessInfo() {
    return {
      supported: Boolean(this.headlessSupported),
      running: Boolean(this.headless?.connected),
      browserVersion: this.headless?.browserVersion ?? null,
      profile: this.headless?.home ? `${this.headless.home}/cache/dsh-chrome/headless/profile` : null,
    }
  }

  async call(method, params, timeoutMs) {
    if (currentBackend() === 'headless') {
      if (!this.headless) {
        const error = new Error('the headless backend is unavailable on this machine (no Chrome/Chromium executable)')
        error.code = 'UNSUPPORTED_BACKEND'
        throw error
      }
      return this.headless.request(method, params)
    }
    return this.desktop.call(method, params, timeoutMs)
  }

  runWithBackend(mode, fn) {
    return backendStorage.run(mode === 'headless' ? 'headless' : 'desktop', fn)
  }

  async close() {
    try {
      await this.headless?.close()
    } catch {
      // already closed
    }
  }
}

// Tools whose effect can change browser state. When shared-visible mode is
// enabled, these take an implicit write lease on the active tab.
const WRITE_TOOLS = new Set([
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
])

/**
 * Add the `backend` parameter to every chrome_* tool and route execution.
 * The wrapped tool sees the original arguments (without `backend`).
 *
 * When `options.leaseRequired` and a lease manager are supplied, mutating tools
 * acquire an implicit write lease for the active tab (owner = agent id), so two
 * DSH sessions sharing one desktop Chrome cannot write the same tab at once.
 * Defaults are off: desktop/headless behavior is unchanged unless the user
 * enables `browser.shared.enabled` in the config.
 */
export function wrapToolsForBackend(tools, router, { leases = null, leaseRequired = false } = {}) {
  return tools.map((tool) => {
    const parameters = tool.parameters && typeof tool.parameters === 'object' ? tool.parameters : { type: 'object', properties: {} }
    const properties = parameters.properties && typeof parameters.properties === 'object' ? parameters.properties : {}
    return {
      ...tool,
      description: `${tool.description} Use backend:"headless" for the background Chromium (no window); default is the desktop Chrome extension.`,
      parameters: {
        ...parameters,
        properties: {
          ...properties,
          backend: {
            type: 'string',
            enum: BACKENDS,
            description: "Which browser to drive: 'desktop' (visible Chrome via the extension, default) or 'headless' (background Chromium, no window).",
          },
        },
      },
      async execute(args, exec) {
        const mode = args?.backend === 'headless' ? 'headless' : 'desktop'
        const { backend: _backend, ...rest } = args || {}
        const run = () => router.runWithBackend(mode, () => tool.execute(rest, exec))
        if (!leaseRequired || !leases || !WRITE_TOOLS.has(tool.name)) return run()
        const owner = exec?.agent?.id ?? 'default'
        let tabId = rest?.tabId
        if (tabId == null) {
          try {
            const list = await router.runWithBackend(mode, () => router.call('tab.tabs', { op: 'list', owner }))
            tabId = list?.activeTabId ?? null
          } catch {
            tabId = null
          }
        }
        if (tabId == null) return run()
        const lease = leases.acquire({ tabId, owner, mode: 'write' })
        try {
          return await run()
        } finally {
          try {
            leases.release(lease.leaseId, { owner })
          } catch {
            // A closed/navigated tab may already have dropped the lease.
          }
        }
      },
    }
  })
}
