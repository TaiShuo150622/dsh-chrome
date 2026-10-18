/**
 * Backend router: every chrome_* tool keeps one schema, but an optional
 * `backend` argument selects between the desktop extension bridge and the
 * background headless Chromium driver. AsyncLocalStorage carries the choice
 * through the async tool execution so concurrent calls cannot mix backends.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

const backendStorage = new AsyncLocalStorage()

export const BACKENDS = ['desktop', 'headless']

export function currentBackend() {
  return backendStorage.getStore() || 'desktop'
}

export class BackendRouter {
  constructor({ desktop, headless = null, headlessSupported = false }) {
    this.desktop = desktop
    this.headless = headless
    this.headlessSupported = headlessSupported
  }

  get backend() {
    return currentBackend()
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

/**
 * Add the `backend` parameter to every chrome_* tool and route execution.
 * The wrapped tool sees the original arguments (without `backend`).
 */
export function wrapToolsForBackend(tools, router) {
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
        return router.runWithBackend(mode, () => tool.execute(rest, exec))
      },
    }
  })
}
