/**
 * dsh-desktop-chrome — Host half of the DSH desktop Chrome control plugin.
 *
 * P0 scope: mount the official browser-use seam (optional), register four
 * chrome_* tools, start the native-host bridge, and write the Chrome native
 * messaging installation assets.
 */
import fs from 'node:fs'
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
  const sessions = { current: null }
  const sandboxPolicy = { current: null }
  const userQuestions = { current: null }
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

  ctx.inject(['sessions', 'sandboxPolicy'], (scoped) => {
    sessions.current = scoped.get('sessions')
    sandboxPolicy.current = scoped.get('sandboxPolicy')
    return () => {
      sessions.current = null
      sandboxPolicy.current = null
    }
  })

  ctx.inject(['userQuestions'], (scoped) => {
    userQuestions.current = scoped.get('userQuestions')
    return () => {
      userQuestions.current = null
    }
  })

  const providerConfig = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(home, 'cache', 'dsh-chrome', 'config.json'), 'utf8'))
    } catch {
      return {}
    }
  })()
  logger?.info?.(
    'dsh-chrome: provider config loaded (allowEvaluate=%s)',
    providerConfig?.allowEvaluate === true,
  )

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
  const hasBrowserUse = Boolean(browserUse && typeof browserUse.register === 'function')
  if (!hasBrowserUse) {
    logger?.warn?.('dsh-chrome: browserUse service is not mounted; provider registration skipped')
  }

  // One effect owns both the tools and the shared browser-use slot so the
  // official ordering is explicit: stop accepting tool calls first, await the
  // registration release last. The browser-use contract is name-only (the
  // service has no browser methods); this provider keeps owning its tools,
  // state and cleanup, exactly like the official Playwright/Stagehand providers.
  ctx.effect(() => {
    const disposers = chromeTools({
      bridge,
      attachments: () => attachments.current,
      assets: () => assets.current,
      approval: () => approval.current,
      sessionContext: () => ({ sessions: sessions.current, sandboxPolicy: sandboxPolicy.current }),
      userQuestions: () => userQuestions.current,
      config: () => providerConfig,
    }).map((definition) => ctx.tools.register(definition))

    let releaseBrowserUse = null
    if (hasBrowserUse) {
      try {
        releaseBrowserUse = browserUse.register(PROVIDER_NAME)
        logger?.info?.('dsh-chrome: browser-use provider registered: %s', PROVIDER_NAME)
      } catch (error) {
        logger?.warn?.('dsh-chrome: browser-use registration failed: %s', error?.message || String(error))
      }
    }

    return async () => {
      // Official contract: providers must stop their tools and await owned work
      // before releasing the sole shared provider slot.
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // unloading continues even if one disposer throws
        }
      }
      if (releaseBrowserUse) {
        try {
          await releaseBrowserUse()
        } catch (error) {
          logger?.warn?.('dsh-chrome: browser-use release failed: %s', error?.message || String(error))
        }
      }
    }
  })
}
