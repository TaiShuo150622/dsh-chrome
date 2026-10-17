/**
 * dsh-desktop-chrome — Host half of the DSH desktop Chrome control plugin.
 *
 * P0 scope: mount the official browser-use seam (optional), register four
 * chrome_* tools, start the native-host bridge, and write the Chrome native
 * messaging installation assets.
 */
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { BridgeServer } from './src/bridge.js'
import { ensureInstallAssets } from './src/install.js'
import { chromeTools } from './src/tools.js'

export const name = 'dsh-chrome'
export const inject = ['tools']

export const PROVIDER_NAME = 'chrome-extension'

export function apply(ctx) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)))
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const bridge = new BridgeServer({ home })
  const assets = { current: null }
  const attachments = { current: null }
  const approval = { current: null }
  const logger = ctx.logger

  ctx.inject(['attachments'], (scoped) => {
    attachments.current = scoped.get('attachments')
    return () => {
      attachments.current = null
    }
  })

  ctx.inject(['approval'], (scoped) => {
    approval.current = scoped.get('approval')
    return () => {
      approval.current = null
    }
  })

  ctx.effect(() => {
    const ready = bridge.start().catch((error) => {
      logger?.warn?.('dsh-chrome: bridge listen failed: %s', error?.message || String(error))
    })
    ensureInstallAssets({ root, logger })
      .then((info) => {
        assets.current = info
        logger?.info?.('dsh-chrome: native host installed at %s', info.nativeManifestPath)
      })
      .catch((error) => {
        logger?.warn?.('dsh-chrome: install assets failed: %s', error?.message || String(error))
      })
    void ready
    return async () => {
      await bridge.stop()
    }
  })

  const browserUse = ctx.get('browserUse')
  if (browserUse && typeof browserUse.register === 'function') {
    ctx.effect(() => {
      const dispose = browserUse.register(PROVIDER_NAME)
      logger?.info?.('dsh-chrome: browser-use provider registered: %s', PROVIDER_NAME)
      return () => dispose()
    })
  } else {
    logger?.warn?.('dsh-chrome: browserUse service is not mounted; provider registration skipped')
  }

  ctx.effect(() => {
    const disposers = chromeTools({
      bridge,
      attachments: () => attachments.current,
      assets: () => assets.current,
      approval: () => approval.current,
    }).map((definition) => ctx.tools.register(definition))
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // unloading continues even if one disposer throws
        }
      }
    }
  })
}
