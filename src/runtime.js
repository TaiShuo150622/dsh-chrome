/**
 * Runtime wiring for the loopback viewers.
 *
 * Both viewers are registered on the Host web server and share one lifecycle:
 * the live screencast viewer first, then the per-context viewer. Teardown is
 * the reverse concern (context viewer first, then the live viewer) and stays
 * here so index.js keeps a thin `ctx.effect` instead of duplicating cleanup
 * order.
 *
 * This module intentionally does not own the bridge, contexts, tools or the
 * update checker; those still live in index.js until their runtime split is
 * queued.
 */
import { registerContextViewer } from './context-viewer.js'
import { registerLiveView, unregisterLiveView } from './liveview.js'

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
