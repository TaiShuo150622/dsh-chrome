/**
 * Runtime wiring for the loopback viewers and the update checker.
 *
 * Both viewers are registered on the Host web server and share one lifecycle:
 * the live screencast viewer first, then the per-context viewer. Teardown is
 * the reverse concern (context viewer first, then the live viewer) and stays
 * here so index.js keeps a thin `ctx.effect` instead of duplicating cleanup
 * order.
 *
 * The update checker is created here too: index.js only registers its
 * start/stop effect and injects the checker into chrome_status.
 *
 * The native-host bridge, its install assets and the contexts teardown are
 * orchestrated here as well (Q22); index.js keeps only the effect and the
 * injection of the handles it needs.
 */
import { BridgeServer } from './bridge.js'
import { registerContextViewer } from './context-viewer.js'
import { ensureInstallAssets } from './install.js'
import { registerLiveView, unregisterLiveView } from './liveview.js'
import { createUpdateChecker } from './update.js'

/**
 * Register the loopback viewers and return their handles plus one disposer.
 *
 * @param {object} options
 * @param {{register: Function, getOrigin?: Function}} options.webServer Host web server.
 * @param {string} options.home DSH home (viewer token files and screencast frames).
 * @param {(contextId: string) => ({driver: object, owner?: string} | null | Promise<...>)} options.getContext Context lookup for the per-context viewer.
 * @param {boolean} [options.allowInput] Explicit opt-in for context-viewer input (default read-only).
 * @param {{info?: Function, warn?: Function}} [options.logger]
 */
export function createViewerRuntime({ webServer, home, logger = null, getContext, allowInput = false }) {
  // Same registration order as the original inline effect: live view first,
  // then the context viewer. Both fail soft; registration errors are logged by
  // the individual modules and surface as disabled handles.
  const liveview = registerLiveView({ webServer, home, logger })
  const viewer = registerContextViewer({ webServer, home, logger, getContext, allowInput })
  let disposed = false
  return {
    viewer,
    liveview,
    dispose() {
      if (disposed) return
      disposed = true
      // Original cleanup order: stop serving context frames first, then the
      // live viewer. Each step tolerates its own errors so unload continues.
      try {
        viewer?.dispose?.()
      } catch {
        // unloading continues
      }
      unregisterLiveView()
    },
  }
}

/**
 * Create the update checker and expose its start/stop lifecycle.
 *
 * index.js keeps the checker handle for chrome_status (`update`) but no longer
 * constructs it or wires its timer; the effect order at unload is unchanged.
 *
 * @param {object} options
 * @param {string} options.home DSH home (update state cache).
 * @param {string} options.currentVersion Installed provider version.
 * @param {object} [options.config] `config.update` block.
 * @param {{info?: Function, warn?: Function}} [options.logger]
 * @param {Function} [options.createChecker] Checker factory (tests inject a stub).
 */
export function createUpdateRuntime({
  home,
  currentVersion,
  config,
  logger = null,
  createChecker = createUpdateChecker,
}) {
  const updateChecker = createChecker({ home, currentVersion, config: config || {}, logger })
  return {
    updateChecker,
    start() {
      updateChecker.start()
    },
    stop() {
      updateChecker.stop()
    },
  }
}

/**
 * Create the native-host bridge and own its start/stop lifecycle.
 *
 * `start` preserves the original effect order: listen first, then write the
 * Chrome native-messaging assets and publish the result through `assets`.
 * `stop` keeps the original teardown order: close the bridge socket first,
 * then close every browser context. Both awaited steps stay in index.js's
 * single effect; the module only sequences them.
 *
 * @param {object} options
 * @param {string} options.home DSH home (bridge socket + discovery file).
 * @param {string} options.root Provider root directory (extension assets).
 * @param {{current: object|null}} options.assets Install-asset handle read by chrome_status.
 * @param {{closeAll: Function}|null} [options.contexts] Context manager cleaned up on unload.
 * @param {{info?: Function, warn?: Function}} [options.logger]
 * @param {Function} [options.createBridge] Bridge factory (tests inject a stub).
 * @param {Function} [options.installAssets] Installer factory (tests inject a stub).
 */
export function createBridgeRuntime({
  home,
  root,
  assets = null,
  contexts = null,
  logger = null,
  createBridge = (options) => new BridgeServer(options),
  installAssets = ensureInstallAssets,
}) {
  const bridge = createBridge({ home })
  return {
    bridge,
    start() {
      const ready = bridge.start().catch((error) => {
        logger?.warn?.('dsh-chrome: bridge listen failed: %s', error?.message || String(error))
      })
      installAssets({ root, logger })
        .then((info) => {
          if (assets) assets.current = info
          logger?.info?.('dsh-chrome: native host installed at %s', info.nativeManifestPath)
        })
        .catch((error) => {
          logger?.warn?.('dsh-chrome: install assets failed: %s', error?.message || String(error))
        })
      void ready
    },
    async stop() {
      await bridge.stop()
      if (contexts) await contexts.closeAll()
    },
  }
}
