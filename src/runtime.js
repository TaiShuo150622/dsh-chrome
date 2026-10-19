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
 * This module intentionally does not own the bridge, contexts or tools; those
 * still live in index.js until their runtime split is queued.
 */
import { registerContextViewer } from './context-viewer.js'
import { registerLiveView, unregisterLiveView } from './liveview.js'
import { createUpdateChecker } from './update.js'

/**
 * Register the loopback viewers and return their handles plus one disposer.
 *
 * @param {object} options
 * @param {{register: Function, getOrigin?: Function}} options.webServer Host web server.
 * @param {string} options.home DSH home (viewer token files and screencast frames).
 * @param {(contextId: string) => ({driver: object, owner?: string} | null | Promise<...>)} options.getContext Context lookup for the per-context viewer.
 * @param {{info?: Function, warn?: Function}} [options.logger]
 */
export function createViewerRuntime({ webServer, home, logger = null, getContext }) {
  // Same registration order as the original inline effect: live view first,
  // then the context viewer. Both fail soft; registration errors are logged by
  // the individual modules and surface as disabled handles.
  const liveview = registerLiveView({ webServer, home, logger })
  const viewer = registerContextViewer({ webServer, home, logger, getContext })
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
