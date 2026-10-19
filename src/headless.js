/**
 * Background browser backend: launch a local headless Chromium with the DevTools
 * protocol and answer the same `tab.*` / `browser.*` requests the extension
 * answers. This is the H0 spike core (navigation/snapshot/click/type/screenshot/
 * evaluate/wait/tabs); unsupported methods fail with UNSUPPORTED_BACKEND.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { buildLaunchArgs, parseDevToolsActivePort } from './headless-launch.js'
import { resolveHeadlessExecutable } from './headless-browsers.js'
import {
  HeadlessScreenshot,
  SHOT_FRAME_MAX_BYTES,
  SHOT_FRAME_MAX_PIXELS,
  SHOT_STREAM_FRAME_TIMEOUT_MS,
  SHOT_STREAM_METHODS,
} from './headless-screenshot.js'
import { HeadlessVisualProbe, VISUAL_PROBE_ENABLED } from './headless-visual-probe.js'
import { handleConsoleEvent, handleNetworkEvent } from './headless-events.js'
import { pageCall } from './headless-page-actions.js'
import { createHeadlessActions } from './headless-actions.js'
import { createHeadlessLogin } from './headless-login.js'
import { readProcessTree } from './process-tree.js'

let overlaySourceCache = null
function overlaySource() {
  if (overlaySourceCache != null) return overlaySourceCache
  try {
    overlaySourceCache = fs.readFileSync(new URL('../extension/overlay.js', import.meta.url), 'utf8')
  } catch {
    overlaySourceCache = ''
  }
  return overlaySourceCache
}

const SUPPORTED = new Set([
  'browser.status',
  'browser.site',
  'tab.tabs',
  'tab.goto',
  'tab.snapshot',
  'tab.click',
  'tab.type',
  'tab.clickAt',
  'tab.hover',
  'tab.scroll',
  'tab.press',
  'tab.history',
  'tab.resume',
  'tab.frames',
  'tab.a11y',
  'tab.screenshot',
  'tab.pdf',
  'tab.evaluate',
  'tab.wait',
  'tab.html',
  'tab.text',
  'tab.get_text',
  'tab.find',
  'tab.select',
  'tab.drag',
  'tab.storage',
  'tab.emulate',
  'tab.selection',
  'tab.console',
  'tab.network',
  'tab.capture_start',
  'tab.capture_stop',
  'tab.capture_requests',
  'tab.overlay',
  'tab.screencast_start',
  'tab.screencast_stop',
  'tab.screencast_status',
  'tab.upload',
  'tab.resume',
  'browser.downloads',
  'tab.close_session',
  'tab.debug_diag',
])

// Extra Chrome switches appended after the defaults (space-separated). This is
// the launch-flag experiment hook used by docs/HEADLESS.md §4.1.3; defaults do
// not set it.
const EXTRA_CHROME_ARGS = String(process.env.DSH_HEADLESS_CHROME_ARGS || '')
  .split(/\s+/)
  .filter(Boolean)

const DEFAULT_IDLE_MINUTES = Number(process.env.DSH_HEADLESS_IDLE_MINUTES) || 5
// Per-browser tab cap (M1/M4). One headless Chrome can host several pages, but
// every page costs a renderer process, so the driver bounds how many it will
// attach. The effective value is `maxTabs` option > DSH_HEADLESS_MAX_TABS >
// DEFAULT_MAX_TABS, resolved per attach (see resolveMaxTabs). `maxTabs` may be
// a getter function: the provider passes a live reader for the volatile
// `browser.maxTabs` setting, so a DSH settings edit applies without a reload.
export const DEFAULT_MAX_TABS = 12
export const MAX_TABS_LIMIT = 64
const MAX_TABS_ENV = 'DSH_HEADLESS_MAX_TABS'
// Bounded download history; the guid index is pruned with the list (M2).
const DOWNLOAD_HISTORY_LIMIT = 100
// Stopped captures stay readable for a bounded time and count (M3). Entries and
// redacted bodies are freed when a summary expires or is evicted, so a session
// that starts/stops captures repeatedly cannot pin an unbounded buffer.
export const CAPTURE_SUMMARY_TTL_MS = 10 * 60 * 1000
export const CAPTURE_SUMMARY_LIMIT = 8

/** Resolve the tab cap: explicit option, then env, then the default; capped at 64. */
export function resolveMaxTabs(value, env = process.env) {
  for (const candidate of [value, env?.[MAX_TABS_ENV]]) {
    if (candidate === undefined || candidate === null || candidate === '') continue
    const number = Number(candidate)
    if (!Number.isFinite(number) || number < 1) continue
    return Math.min(MAX_TABS_LIMIT, Math.floor(number))
  }
  return DEFAULT_MAX_TABS
}

// waitReady polls document.readyState. Local/real navigations often finish in
// tens of milliseconds, so a 100ms poll handed most of the load time back as
// request latency. 25ms costs a few cheap evaluates and removes that. (The
// DevToolsActivePort poll stays at 150ms: §4.1.5 measured no gain from a tight
// poll because Chrome finishes the launch ~300-570ms after writing that file,
// so the poll wait is fully overlapped.)
const READY_POLL_MS = 25

const CAPTURE_MAX_DURATION_MS = 10 * 60 * 1000
const CAPTURE_DEFAULT_MAX_ENTRIES = 300
const CAPTURE_HARD_MAX_ENTRIES = 1000

// ------------------------------------------------ driver-side PNG crop (clip/ref)
// `tab.screenshot` with `clip`/`ref` has to return a region of the page. The
// frame stream already holds the last composited frame as a device-pixel PNG,
// so the region shot is decoded, cropped and re-encoded in the driver instead
// of forcing a fresh `Page.captureScreenshot` (~45ms, docs/HEADLESS.md §4.1.4).
// The byte-level helpers live in `src/headless-png.js`; decoded pixels are
// cached on the frame object, so repeated crops of an unchanged page skip the
// decode.

function error(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

// R-05: chrome_tabs {op:"new"} / attachTab / tab.goto must not become a
// local-file read primitive. Only http(s) and the literal about:blank are
// navigable; file:, data:, javascript:, chrome: and friends are refused before
// any Target.createTarget / Page.navigate call.
const SAFE_TAB_PROTOCOLS = new Set(['http:', 'https:'])

function safeTabUrl(raw) {
  const text = String(raw ?? '').trim()
  if (!text || text === 'about:blank') return 'about:blank'
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    throw error('PROTECTED_PAGE', `not a valid URL: ${text}`)
  }
  if (!SAFE_TAB_PROTOCOLS.has(parsed.protocol)) {
    throw error('PROTECTED_PAGE', `only http(s) URLs are allowed, got ${parsed.protocol}`)
  }
  if (parsed.username || parsed.password) {
    throw error('PROTECTED_PAGE', 'URLs with embedded credentials are not allowed')
  }
  return parsed.toString()
}

// Navigation/input handlers (goto/history/click/clickAt/type/press/scroll/
// select/hover/drag/wait) live in headless-actions.js (Q25). dispatch() keeps
// the ensureStarted/noteActivity facade, the SUPPORTED gate and the shared
// error factory; handlers receive this driver and answer with the same
// envelopes. `error` and `safeTabUrl` are injected because those two helpers
// stay the single source of truth in this module.
const HEADLESS_ACTIONS = createHeadlessActions({
  error,
  safeTabUrl,
  visualProbeEnabled: VISUAL_PROBE_ENABLED,
})

/**
 * Resolve the executable for a headless launch (multi-engine MVP).
 *
 * Explicit selection (`engine` / `executable`, or the environment selectors
 * `DSH_HEADLESS_ENGINE` / `DSH_HEADLESS_CHROME`) never falls back to another
 * engine: a missing explicitly selected Edge install throws
 * `HEADLESS_EXECUTABLE_NOT_FOUND` instead of silently launching Chrome.
 * Without a selection the legacy Chrome -> Chromium probe order is unchanged.
 * Returns null only when nothing was selected and no browser is installed.
 */
export function chromeExecutable(options = {}) {
  const selection = resolveHeadlessExecutable(options)
  return selection?.executable ?? null
}

// Interactive login window lifecycle (Q21). The driver keeps same-named
// facades; the launcher lookup and the shared error factory are injected so the
// module stays independent of this file's private helpers.
const headlessLogin = createHeadlessLogin({
  chromeExecutable: (driver) =>
    chromeExecutable({ engine: driver?.engine, executable: driver?.executable }),
  error,
})

// ---------------------------------------------------------------- CDP client
class Cdp {
  constructor(url) {
    this.url = url
    this.nextId = 0
    this.pending = new Map()
    this.listeners = new Set()
    this.ws = null
  }

  async connect() {
    if (typeof WebSocket !== 'function') throw error('UNSUPPORTED_BACKEND', 'this Node runtime has no WebSocket client')
    const ws = new WebSocket(this.url)
    this.ws = ws
    await new Promise((resolve, reject) => {
      ws.onopen = resolve
      ws.onerror = () => reject(error('HEADLESS_CDP_FAILED', 'cannot connect to headless Chrome CDP'))
    })
    ws.onmessage = (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (message.id != null && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) reject(error('HEADLESS_CDP_FAILED', message.error.message || 'CDP command failed'))
        else resolve(message.result ?? {})
        return
      }
      for (const listener of this.listeners) listener(message)
    }
    ws.onclose = () => {
      for (const { reject } of this.pending.values()) reject(error('HEADLESS_CDP_FAILED', 'headless Chrome connection closed'))
      this.pending.clear()
      this.listeners.clear()
      this.ws = null
      // The driver clears its per-tab state when the browser goes away. It
      // covers a crashed/reused child as well as a dropped websocket.
      this.onClose?.()
    }
  }

  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      if (!this.ws) {
        reject(error('HEADLESS_CDP_FAILED', 'headless Chrome is not connected'))
        return
      }
      const id = ++this.nextId
      this.pending.set(id, { resolve, reject })
      try {
        this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
      } catch (sendError) {
        this.pending.delete(id)
        reject(error('HEADLESS_CDP_FAILED', sendError?.message || String(sendError)))
      }
    })
  }

  onMessage(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  close() {
    try {
      this.ws?.close()
    } catch {
      // already closed
    }
  }
}

// ------------------------------------------------------------------ driver
export class HeadlessDriver {
  constructor({ home, logger, spawnImpl = spawn, profileDir = null, screenshotDir = null, downloadDir = null, visible = false, windowSize = null, engine = null, executable = null, autoPointer = null, maxTabs = null, captureSummaryTtlMs = null, captureSummaryLimit = null, shotFrameMaxBytes = null, shotFrameMaxPixels = null, processTree = readProcessTree } = {}) {
    this.home = home
    this.visible = Boolean(visible)
    this.processTree = typeof processTree === 'function' ? processTree : null
    this.windowSize = windowSize || (this.visible ? { width: 1440, height: 900 } : null)
    this.engine = engine || null
    this.executable = executable || null
    this.logger = logger
    this.spawnImpl = spawnImpl
    // A function keeps the cap live across DSH settings edits; a number is the
    // legacy/test form. The getter resolves it on each attach.
    this.maxTabsOption = maxTabs
    this.profileDir = profileDir || path.join(home || '.', 'cache', 'dsh-chrome', 'headless', 'profile')
    this.chrome = null
    this.cdp = null
    this.browserVersion = null
    this.owners = new Map()
    this.tabs = new Map() // tabId -> tab (global; ids unique per owner group not guaranteed)
    this.nextTabId = 1
    this.startPromise = null
    this.screenshotDir = screenshotDir || path.join(home || '.', 'cache', 'dsh-chrome', 'headless', 'screenshots')
    this.screenshotDirReady = false
    this.screenshotSeq = 0
    this.downloadDir = downloadDir || path.join(home || '.', 'cache', 'dsh-chrome', 'headless', 'downloads')
    this.bySession = new Map()
    this.consoleBuffers = new Map()
    this.screencastDir = path.join(home || '.', 'cache', 'dsh-chrome', 'screencast')
    this.downloads = []
    this.downloadByGuid = new Map()
    this.idleTimer = null
    this.lastActivity = Date.now()
    // A Chrome/CDP exit is terminal for this driver object: the browser (and
    // every tab/session it owned) is gone. `dead` makes later requests fail
    // with CONTEXT_CRASHED instead of silently launching a new browser while
    // the caller still holds tab ids from the old one. `closing` marks the
    // intentional shutdown window, during which a launch must not start.
    this.dead = false
    this.deathReason = null
    this.closing = false
    this.closePromise = null
    this.loginProcess = null
    this.loginProfile = this.profileDir
    this.resumeUrl = null
    this.visibleMode = false
    // Visible debug windows show the arrow cursor by default; hidden sandbox
    // contexts stay opt-in via DSH_AUTO_POINTER / chrome_pointer auto.
    this.autoPointerEnabled = autoPointer == null ? process.env.DSH_AUTO_POINTER === '1' : Boolean(autoPointer)
    // In-flight attaches count against `maxTabs` so two concurrent
    // `chrome_tabs {op:"new"}` calls cannot overshoot the cap while both are
    // waiting inside `Target.createTarget`.
    this.pendingTabs = 0
    this.captures = new Map()
    this.captureByTab = new Map()
    this.nextCaptureSeq = 1
    this.captureSummaryTtlMs =
      Number.isFinite(captureSummaryTtlMs) && captureSummaryTtlMs > 0 ? captureSummaryTtlMs : CAPTURE_SUMMARY_TTL_MS
    this.captureSummaryLimit =
      Number.isFinite(captureSummaryLimit) && captureSummaryLimit >= 1
        ? Math.min(100, Math.floor(captureSummaryLimit))
        : CAPTURE_SUMMARY_LIMIT
    this.screenshot = new HeadlessScreenshot(this, {
      error,
      maxFrameBytes:
        Number.isFinite(shotFrameMaxBytes) && shotFrameMaxBytes > 0 ? shotFrameMaxBytes : SHOT_FRAME_MAX_BYTES,
      maxFramePixels:
        Number.isFinite(shotFrameMaxPixels) && shotFrameMaxPixels > 0 ? shotFrameMaxPixels : SHOT_FRAME_MAX_PIXELS,
    })
    this.visualProbe = new HeadlessVisualProbe(this)
  }

  get connected() {
    return Boolean(this.cdp)
  }

  /**
   * Effective tab cap: a live getter function (provider setting) or a fixed
   * option, then DSH_HEADLESS_MAX_TABS, then the default. Re-resolved on every
   * attach so a volatile settings edit reaches an already running browser.
   */
  get maxTabs() {
    const configured = typeof this.maxTabsOption === 'function' ? this.maxTabsOption() : this.maxTabsOption
    return resolveMaxTabs(configured)
  }

  /** Committed tabs in this browser (pending attaches excluded). */
  get tabCount() {
    return this.tabs.size
  }

  /**
   * M6: counts of everything this driver retains, for `chrome_memory_stats`.
   * Numbers only — no page text, console entries, URLs or capture bodies — so a
   * snapshot can be compared across calls without leaking page content.
   * `chromePid` is the launched/reused browser child (or the visible login
   * window); `visible` reports any visible window this driver currently owns.
   * M8 adds the best-effort Chrome process-tree RSS: a missing `ps`, gone pid
   * or Windows keeps `chromeRss`/`processCount` null without failing the tool.
   */
  memoryStats() {
    let captureEntries = 0
    let captureBodyBytes = 0
    for (const capture of this.captures.values()) {
      captureEntries += Array.isArray(capture?.entries) ? capture.entries.length : 0
      captureBodyBytes += Number.isFinite(capture?.bodyBytes) && capture.bodyBytes > 0 ? capture.bodyBytes : 0
    }
    let shotStreams = 0
    for (const tab of this.tabs.values()) if (tab?.shotStream) shotStreams += 1
    const chromePid = this.chrome?.pid ?? this.loginProcess?.pid ?? null
    let chromeRss = null
    let processCount = null
    if (chromePid != null && this.processTree) {
      try {
        const tree = this.processTree(chromePid)
        chromeRss = Number.isFinite(tree?.rss) ? tree.rss : null
        processCount = Number.isFinite(tree?.processCount) ? tree.processCount : null
      } catch {
        // Best-effort diagnostic: a failed ps never breaks the snapshot.
        chromeRss = null
        processCount = null
      }
    }
    return {
      chromePid,
      chromeRss,
      processCount,
      tabs: this.tabs.size,
      owners: this.owners.size,
      bySession: this.bySession.size,
      consoleBuffers: this.consoleBuffers.size,
      captures: this.captures.size,
      captureEntries,
      captureBodyBytes,
      downloads: this.downloads.length,
      downloadByGuid: this.downloadByGuid.size,
      shotStreams,
      idleTimer: Boolean(this.idleTimer),
      visible: Boolean(this.visible || this.visibleMode || this.loginProcess),
    }
  }

  async ensureStarted() {
    if (this.dead) {
      throw error(
        'CONTEXT_CRASHED',
        `the headless browser exited unexpectedly (${this.deathReason || 'unknown'}); create a new context`,
      )
    }
    if (this.closing) {
      throw error('CONTEXT_CRASHED', 'the headless context is closing; create a new context')
    }
    if (this.loginProcess) {
      throw error('HEADLESS_LOGIN_OPEN', 'an interactive login window is open; finish it before using the headless backend')
    }
    if (this.cdp) return this
    if (this.startPromise) return this.startPromise
    this.startPromise = this.launchBrowser()
    try {
      return await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  /**
   * One launch attempt. `ensureStarted` owns the shared `startPromise`; this
   * method owns every resource of the attempt, and any failure after the child
   * is spawned goes through `handleStartFailure`, so a half-started Chrome can
   * never outlive a rejected launch (M3).
   */
  async launchBrowser() {
    const executable = chromeExecutable({ engine: this.engine, executable: this.executable })
    if (!executable) {
      throw error('UNSUPPORTED_BACKEND', 'no Chrome/Chromium/Edge/Brave executable found for the headless backend (set DSH_HEADLESS_CHROME or DSH_HEADLESS_ENGINE)')
    }
    const profileDir = this.profileDir
    await fsp.mkdir(profileDir, { recursive: true })
    const activePortPath = path.join(profileDir, 'DevToolsActivePort')
    let child = null
    let cdp = null
    let portFileOwnedByLaunch = false
    try {
      // Reuse a headless Chrome left over from a previous provider instance
      // (e.g. provider reload) instead of racing a second process on the same
      // profile. A stale DevToolsActivePort is removed before a fresh launch.
      try {
        const existing = parseDevToolsActivePort(fs.readFileSync(activePortPath, 'utf8'))
        if (existing) {
          cdp = new Cdp(existing.url)
          await cdp.connect()
          const version = await cdp.send('Browser.getVersion')
          cdp.onMessage((message) => this.onCdpEvent(message))
          cdp.onClose = () => {
            if (this.cdp !== cdp) return // deliberate close already detached it
            this.handleBrowserExit('connection-closed')
          }
          await cdp
            .send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: this.downloadDir, eventsEnabled: true })
            .catch(() => {})
          this.cdp = cdp
          this.chrome = null
          this.browserVersion = version?.product || null
          this.dead = false
          this.deathReason = null
          this.startIdleTimer()
          this.logger?.info?.('headless Chrome reused: %s', this.browserVersion || 'unknown')
          return this
        }
      } catch {
        // Stale or unusable port file: drop the half-connected CDP client and
        // the file, then launch a fresh child below.
        try {
          cdp?.close()
        } catch {
          // already closed
        }
        cdp = null
        try {
          fs.unlinkSync(activePortPath)
        } catch {
          // stale file already gone
        }
      }
      child = this.spawnImpl(
        executable,
        buildLaunchArgs({
          visible: this.visible,
          profileDir,
          windowSize: this.windowSize,
          extraArgs: EXTRA_CHROME_ARGS,
        }),
        { stdio: ['ignore', 'ignore', 'pipe'] },
      )
      portFileOwnedByLaunch = true
      child.stderr?.on('data', (chunk) => this.logger?.debug?.('headless chrome: %s', String(chunk).trim().slice(0, 300)))
      this.chrome = child
      // Watch the child from the moment it exists: a Chrome that exits during
      // startup must fail the launch immediately (and be visible to the wait
      // loop) instead of waiting out the 15s port deadline.
      let childExit = null
      child.once?.('exit', (code) => {
        childExit = code
        if (this.chrome !== child) return
        this.logger?.warn?.('headless Chrome exited: %s', code)
        this.handleBrowserExit(code)
      })
      const deadline = Date.now() + 15000
      let activePort = null
      while (Date.now() < deadline) {
        if (childExit != null) break
        try {
          activePort = parseDevToolsActivePort(fs.readFileSync(activePortPath, 'utf8'))
          if (activePort) break
        } catch {
          // not ready
        }
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
      if (childExit != null) {
        throw error('HEADLESS_LAUNCH_FAILED', `headless Chrome exited during startup (code ${childExit})`)
      }
      if (!activePort) throw error('HEADLESS_LAUNCH_FAILED', 'headless Chrome did not expose DevToolsActivePort')
      cdp = new Cdp(activePort.url)
      cdp.onMessage((message) => this.onCdpEvent(message))
      await cdp.connect()
      cdp.onClose = () => {
        if (this.cdp !== cdp) return // deliberate close already detached it
        this.handleBrowserExit('connection-closed')
      }
      // These two CDP round trips are independent of each other; on a cold
      // browser each can take tens of milliseconds, so run them together.
      await fsp.mkdir(this.downloadDir, { recursive: true })
      const [version] = await Promise.all([
        cdp.send('Browser.getVersion').catch(() => null),
        cdp
          .send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: this.downloadDir, eventsEnabled: true })
          .catch((error) => this.logger?.warn?.('headless download behavior failed: %s', error?.message || String(error))),
      ])
      // Commit point: only a fully initialised browser becomes the driver's
      // connection; every earlier failure is rolled back below.
      this.cdp = cdp
      this.browserVersion = version?.product || null
      this.dead = false
      this.deathReason = null
      this.startIdleTimer()
      this.logger?.info?.('headless Chrome started: %s', this.browserVersion || 'unknown')
      return this
    } catch (failure) {
      await this.handleStartFailure({ child, cdp, activePortPath, portFileOwnedByLaunch })
      throw failure
    }
  }

  /**
   * Roll back one failed launch: close the half-connected CDP client, kill the
   * child process and remove the port file this attempt created. Best-effort
   * and never throws; the original launch error is what the caller must see.
   */
  async handleStartFailure({ child = null, cdp = null, activePortPath = null, portFileOwnedByLaunch = false } = {}) {
    try {
      cdp?.close()
    } catch {
      // already closed
    }
    if (this.cdp === cdp) this.cdp = null
    this.browserVersion = null
    try {
      child?.kill?.('SIGTERM')
    } catch {
      // child already gone
    }
    if (this.chrome === child) this.chrome = null
    this.stopIdleTimer()
    // A failed launch is not a crashed running context: the caller may retry
    // (the start promise is cleared by ensureStarted), so clear the terminal
    // marker an exit-during-startup may have set.
    this.dead = false
    this.deathReason = null
    if (portFileOwnedByLaunch) {
      try {
        fs.unlinkSync(activePortPath)
      } catch {
        // the child may already have removed it
      }
    }
  }

  startIdleTimer() {
    if (this.idleTimer) return
    this.idleTimer = setInterval(() => {
      this.checkIdle().catch(() => {})
    }, 30 * 1000)
    this.idleTimer.unref?.()
  }

  /**
   * One idle-reap decision. Only a hidden browser owned by this driver is
   * eligible: a visible/debug window belongs to the user (C17) and an open
   * login window is likewise explicit, so neither may be killed by the
   * background idle sweep. Returns whether this call closed the browser.
   */
  async checkIdle() {
    if (!this.cdp || this.dead || this.closing) return false
    if (this.visible || this.visibleMode || this.loginProcess) {
      this.lastActivity = Date.now()
      return false
    }
    if (this.tabs.size > 0) {
      this.lastActivity = Date.now()
      return false
    }
    if (Date.now() - this.lastActivity < DEFAULT_IDLE_MINUTES * 60 * 1000) return false
    this.logger?.info?.('headless Chrome idle for %s min; closing', DEFAULT_IDLE_MINUTES)
    await this.close()
    return true
  }

  noteActivity() {
    this.lastActivity = Date.now()
  }

  onNetworkEvent(tab, method, params) {
    // Thin delegate: console/network buffer mapping lives in headless-events.js.
    return handleNetworkEvent(tab, this.captureByTab.get(tab?.tabId), this.cdp.send.bind(this.cdp), method, params)
  }

  onCdpEvent(message) {
    // A deliberate close detaches the client before Chrome's last frames/events
    // arrive; a crashed connection can also deliver queued messages. Never let
    // a late event touch a driver that no longer has a live browser.
    if (!this.cdp) return
    const sessionTab = message.sessionId ? this.bySession.get(message.sessionId) : null
    if (handleConsoleEvent(this.consoleBuffers, sessionTab, message.method, message.params || {})) return
    if (message.method === 'Page.screencastFrame') {
      const tab = sessionTab
      if (!tab) return
      // Ack immediately in both modes: an unacked frame pauses the stream.
      this.cdp
        .send('Page.screencastFrameAck', { sessionId: message.params?.sessionId }, tab.sessionId)
        .catch(() => {})
      this.screenshot.handleFrame(tab, message.params || {})
      return
    }
    if (String(message.method || '').startsWith('Network.')) {
      this.onNetworkEvent(sessionTab, message.method, message.params || {})
      return
    }
    if (message.method === 'Target.detachedFromTarget') {
      const sessionId = message.params?.sessionId || message.sessionId
      const tab = sessionId ? this.bySession.get(sessionId) : null
      if (tab) this.cleanupTab(tab, { reason: 'detached' })
      return
    }
    if (message.method === 'Target.targetDestroyed') {
      const targetId = message.params?.targetId
      const tab = targetId ? this.findTabByTargetId(targetId) : null
      if (tab) this.cleanupTab(tab, { reason: 'destroyed' })
      return
    }
    if (message.method === 'Browser.downloadWillBegin') {
      const params = message.params || {}
      const record = {
        guid: params.guid,
        filename: params.suggestedFilename,
        url: params.url,
        state: 'inProgress',
        bytesReceived: 0,
        totalBytes: 0,
        startTime: new Date().toISOString(),
      }
      this.downloads.unshift(record)
      this.downloadByGuid.set(params.guid, record)
      // Keep the list and the guid index in lockstep: a record evicted from
      // the bounded history must not stay reachable through the lookup map.
      while (this.downloads.length > DOWNLOAD_HISTORY_LIMIT) {
        const evicted = this.downloads.pop()
        if (evicted && this.downloadByGuid.get(evicted.guid) === evicted) this.downloadByGuid.delete(evicted.guid)
      }
      return
    }
    if (message.method === 'Browser.downloadProgress') {
      const params = message.params || {}
      const record = this.downloadByGuid.get(params.guid)
      if (record) {
        record.state = params.state === 'completed' ? 'complete' : params.state === 'canceled' ? 'cancelled' : 'inProgress'
        record.bytesReceived = params.receivedBytes ?? record.bytesReceived
        record.totalBytes = params.totalBytes ?? record.totalBytes
      }
    }
  }

  ownerEntry(owner) {
    const key = String(owner || 'default')
    let entry = this.owners.get(key)
    if (!entry) {
      entry = { owner: key, tabs: new Map(), activeTabId: null, pending: 0 }
      this.owners.set(key, entry)
    }
    return entry
  }

  /**
   * Read an existing owner entry without creating one. Read-only requests
   * (`tabs op=list`, `tab.resume`, closing an already-gone tab) must not leave
   * an empty owner behind after the last tab was closed.
   */
  peekOwner(owner) {
    return this.owners.get(String(owner || 'default')) || null
  }

  /**
   * The one place a tab is removed from every driver map. Closing a tab from
   * `tabs op=close`, `close_session`, a context close, a `Target.detachedFromTarget`
   * event or a browser exit all funnel through here so no session, console
   * buffer, capture, shot stream or owner entry outlives the tab.
   *
   * Idempotent: a target close triggers a detach event for a tab this function
   * already unregistered, so the second call is a no-op.
   */
  cleanupTab(tab, { reason = 'closed' } = {}) {
    if (!tab || tab.cleaned) return false
    tab.cleaned = true
    tab.closedReason = reason
    this.dropShotStream(tab)
    this.dropScreencast(tab)
    this.dropCaptureForTab(tab.tabId)
    if (tab.sessionId != null && this.bySession.get(tab.sessionId) === tab) this.bySession.delete(tab.sessionId)
    this.consoleBuffers.delete(tab.tabId)
    if (this.tabs.get(tab.tabId) === tab) this.tabs.delete(tab.tabId)
    const entry = tab.owner != null ? this.owners.get(String(tab.owner)) : null
    if (entry) {
      if (entry.tabs.get(tab.tabId) === tab) entry.tabs.delete(tab.tabId)
      if (entry.activeTabId === tab.tabId) entry.activeTabId = [...entry.tabs.keys()][0] ?? null
      this.maybeReleaseOwner(entry)
    }
    return true
  }

  /** Remove a capture owned by a tab and its pending timer, leaving no index entry. */
  dropCaptureForTab(tabId) {
    const capture = this.captureByTab.get(tabId)
    if (!capture) return null
    if (capture.timer) {
      clearTimeout(capture.timer)
      capture.timer = null
    }
    if (capture.expireTimer) {
      clearTimeout(capture.expireTimer)
      capture.expireTimer = null
    }
    if (capture.active) {
      capture.active = false
      capture.endedReason = capture.endedReason || 'tab-closed'
    }
    if (this.captures.get(capture.captureId) === capture) this.captures.delete(capture.captureId)
    this.captureByTab.delete(tabId)
    this.releaseCaptureData(capture, { entries: true })
    return capture
  }

  /**
   * M3: a stopped capture keeps a readable summary for a bounded time and
   * count. `armCaptureExpiry` starts the TTL for one summary; `pruneCapture
   * Summaries` evicts the oldest stopped summaries over the limit. Active
   * captures are never touched.
   */
  armCaptureExpiry(capture) {
    if (!capture) return
    if (capture.expireTimer) clearTimeout(capture.expireTimer)
    capture.stoppedAt = capture.stoppedAt || Date.now()
    capture.expireTimer = setTimeout(() => {
      capture.expireTimer = null
      this.dropCaptureSummary(capture)
    }, this.captureSummaryTtlMs)
    capture.expireTimer.unref?.()
    this.pruneCaptureSummaries()
  }

  pruneCaptureSummaries() {
    const stopped = [...this.captures.values()].filter((capture) => !capture.active)
    if (stopped.length <= this.captureSummaryLimit) return
    stopped.sort((a, b) => (a.stoppedAt || a.startedAt || 0) - (b.stoppedAt || b.startedAt || 0))
    while (stopped.length > this.captureSummaryLimit) this.dropCaptureSummary(stopped.shift())
  }

  /** Free an expired/evicted stopped capture: entries, bodies and indexes. */
  dropCaptureSummary(capture) {
    if (!capture) return false
    if (capture.expireTimer) {
      clearTimeout(capture.expireTimer)
      capture.expireTimer = null
    }
    if (capture.timer) {
      clearTimeout(capture.timer)
      capture.timer = null
    }
    if (this.captures.get(capture.captureId) !== capture) return false
    this.captures.delete(capture.captureId)
    if (this.captureByTab.get(capture.tabId) === capture) this.captureByTab.delete(capture.tabId)
    this.releaseCaptureData(capture, { entries: true })
    return true
  }

  /**
   * Release the raw parts of a capture while keeping the already-redacted
   * `entries` readable: `_postDataRaw` (unredacted request body), the by-id
   * index (only needed while new Network events arrive) and in-flight body
   * task handles. Repeated `chrome_capture_requests` calls keep working; the
   * whole summary is later freed by TTL/count (or by tab/browser teardown).
   */
  releaseCaptureData(capture, { entries = false } = {}) {
    if (!capture) return
    for (const entry of capture.entries || []) delete entry._postDataRaw
    capture.byId?.clear()
    capture.bodyTasksSet?.clear()
    capture.bodyBytes = 0
    if (entries) {
      if (Array.isArray(capture.entries)) capture.entries.length = 0
    }
  }

  /**
   * Drop an owner entry once it has no tabs, no attach in flight and no login
   * window. Without this an owner key would stay in the map forever after its
   * last tab closes (the leak M2 targets).
   */
  maybeReleaseOwner(entry) {
    if (!entry || entry.tabs.size > 0 || entry.pending > 0 || this.loginProcess) return false
    if (this.owners.get(entry.owner) === entry) {
      this.owners.delete(entry.owner)
      return true
    }
    return false
  }

  findTabByTargetId(targetId) {
    for (const tab of this.tabs.values()) if (tab.targetId === targetId) return tab
    return null
  }

  async attachTab(entry, url) {
    const targetUrl = safeTabUrl(url)
    // M1: capacity is checked before `Target.createTarget`, and one browser
    // shares the cap across every owner, so an over-limit `chrome_tabs
    // {op:"new"}` never creates (or briefly leaks) a target.
    const limit = this.maxTabs
    if (this.tabs.size + this.pendingTabs >= limit) {
      this.maybeReleaseOwner(entry)
      throw error('RESOURCE_LIMIT', `headless tab limit reached (${limit}); close a tab first`)
    }
    this.pendingTabs += 1
    entry.pending += 1
    let targetId = null
    let sessionId = null
    try {
      const created = await this.cdp.send('Target.createTarget', { url: targetUrl })
      targetId = created?.targetId
      if (!targetId) throw error('HEADLESS_CDP_FAILED', 'Target.createTarget returned no targetId')
      const attached = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true })
      sessionId = attached?.sessionId
      if (!sessionId) throw error('HEADLESS_CDP_FAILED', `Target.attachToTarget returned no sessionId for ${targetId}`)
      // Both domain enables are independent; on a fresh target each cold round
      // trip is tens of milliseconds, so don't serialise them. A rejected
      // enable means the target is not usable, so it rolls back with the rest
      // instead of registering a half-initialised tab.
      await Promise.all([
        this.cdp.send('Page.enable', {}, sessionId),
        this.cdp.send('Runtime.enable', {}, sessionId),
      ])
      const tab = {
        tabId: this.nextTabId,
        owner: entry.owner,
        targetId,
        sessionId,
        url: targetUrl,
        title: '',
        renderChangeAt: 0,
        shotStream: null,
        visualTracker: false,
        visualSkips: 0,
        renderChangeRetires: 0,
      }
      // The visual tracker is best-effort by design (a page that refuses the
      // script only loses the paint-free shortcut), but if the install itself
      // throws, the attach counts as failed and is rolled back.
      await this.installVisualTracker(tab)
      // Commit point: every initialization step succeeded, so all maps below
      // become visible in one synchronous step. Nothing above this line wrote
      // driver state; nothing below can throw.
      this.nextTabId += 1
      this.bySession.set(sessionId, tab)
      this.consoleBuffers.set(tab.tabId, [])
      this.tabs.set(tab.tabId, tab)
      entry.tabs.set(tab.tabId, tab)
      entry.activeTabId = tab.tabId
      return tab
    } catch (failure) {
      await this.rollbackAttach(targetId, sessionId)
      throw failure
    } finally {
      this.pendingTabs -= 1
      entry.pending -= 1
      this.maybeReleaseOwner(entry)
    }
  }

  /**
   * Undo a partial attach. Best-effort and never throws: the original failure
   * is what the caller must see. Detaching first releases the flattened
   * session, then closing the target reclaims the renderer process; both are
   * attempted even if the first one fails.
   */
  async rollbackAttach(targetId, sessionId) {
    if (sessionId) {
      try {
        await this.cdp.send('Target.detachFromTarget', { sessionId })
      } catch {
        // session already gone
      }
    }
    if (targetId) {
      try {
        await this.cdp.send('Target.closeTarget', { targetId })
      } catch {
        // target already gone
      }
    }
  }

  async ensureTab(owner, tabId) {
    const entry = this.ownerEntry(owner)
    if (Number.isFinite(tabId)) {
      const tab = entry.tabs.get(tabId)
      if (!tab) {
        this.maybeReleaseOwner(entry)
        throw error('TAB_NOT_FOUND', `tab ${tabId} is not owned by this session`)
      }
      entry.activeTabId = tabId
      return tab
    }
    if (entry.activeTabId != null) return entry.tabs.get(entry.activeTabId)
    const resumeUrl = this.resumeUrl
    this.resumeUrl = null
    return this.attachTab(entry, resumeUrl || 'about:blank')
  }

  async evalOn(tab, expression, { awaitPromise = false } = {}) {
    const result = await this.cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
    }, tab.sessionId)
    if (result.exceptionDetails) {
      const message = result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'page evaluation failed'
      throw error('INTERNAL', String(message))
    }
    return result.result?.value
  }

  async ensureOverlay(tab) {
    if (tab.overlayReady) return true
    const source = overlaySource()
    if (!source) return false
    await this.evalOn(tab, `(() => { if (!window.__dshOverlay) { ${source} } return Boolean(window.__dshOverlay) })()`)
    tab.overlayReady = true
    return true
  }

  async ensureFrameOverlays(tab) {
    if (tab.frameContexts) return tab.frameContexts
    const tree = await this.cdp.send('Page.getFrameTree', {}, tab.sessionId)
    const frames = []
    const walk = (node) => {
      frames.push({ frameId: node.frame.id, url: node.frame.url, parentFrameId: node.frame.parentId || null })
      for (const child of node.childFrames || []) walk(child)
    }
    if (tree?.frameTree) walk(tree.frameTree)
    const contexts = []
    for (const frame of frames) {
      try {
        const { executionContextId } = await this.cdp.send(
          'Page.createIsolatedWorld',
          { frameId: frame.frameId, worldName: 'dsh-overlay', grantUniveralAccess: false },
          tab.sessionId,
        )
        contexts.push({ ...frame, contextId: executionContextId })
      } catch {
        // A detached/crashed frame cannot host an overlay.
      }
    }
    tab.frameContexts = contexts
    return contexts
  }

  async evalInContext(tab, contextId, expression) {
    const result = await this.cdp.send(
      'Runtime.evaluate',
      { expression, contextId, returnByValue: true },
      tab.sessionId,
    )
    if (result.exceptionDetails) {
      const message = result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'frame evaluation failed'
      throw error('INTERNAL', String(message))
    }
    return result.result?.value
  }

  async autoPointer(tab, params = {}, kind = 'move') {
    if (!this.autoPointerEnabled) return null
    try {
      if (!(await this.ensureOverlay(tab))) return null
      const payload = {
        op: 'follow',
        ref: params.ref,
        selector: params.selector,
        x: params.x,
        y: params.y,
        label: 'DSH · ' + kind,
        pulse: kind === 'click' || kind === 'type' || kind === 'key',
      }
      const value = await this.evalOn(tab, `window.__dshOverlay.handle(${JSON.stringify(payload)})`)
      if (value && !value.skipped) {
        tab.renderChangeAt = Date.now() / 1000
        tab.overlayChangedAt = Date.now() / 1000
      }
      return value
    } catch {
      return null
    }
  }

  async syncTabMeta(tab) {
    try {
      const meta = await this.evalOn(tab, '({ title: document.title, url: location.href })')
      if (meta) {
        tab.title = meta.title || ''
        tab.url = meta.url || tab.url
      }
    } catch {
      // tab may be navigating / closed
    }
    return tab
  }

  async ensureScreenshotDir() {
    if (this.screenshotDirReady) return
    await fsp.mkdir(this.screenshotDir, { recursive: true })
    this.screenshotDirReady = true
  }

  async writeCaptureFile(file, data) {
    await this.ensureScreenshotDir()
    try {
      await fsp.writeFile(file, data, { mode: 0o600 })
    } catch {
      // the cache directory may have been removed underneath us; recreate once
      await fsp.mkdir(this.screenshotDir, { recursive: true })
      await fsp.writeFile(file, data, { mode: 0o600 })
    }
  }


  // Page-side visual probe (Q27): the tracker script, snapshot shape, verdict
  // and probe wrapper live in headless-visual-probe.js. The facades preserve
  // the driver API and the action handlers' call sites.
  async installVisualTracker(tab) { return this.visualProbe.installVisualTracker(tab) }
  async visualSnapshot(tab, point) { return this.visualProbe.visualSnapshot(tab, point) }
  visualSnapshotShape(value) { return this.visualProbe.visualSnapshotShape(value) }
  visualProbeVerdict(before, after, expected) { return this.visualProbe.visualProbeVerdict(before, after, expected) }
  async visualProbeAction(tab, action, accept, precheck, point, expect, actionSnapshot) {
    return this.visualProbe.visualProbeAction(tab, action, accept, precheck, point, expect, actionSnapshot)
  }

  // ---------------------------------------------------- screenshot frame stream
  tabForParams(params = {}) {
    const tabId = Number(params.tabId)
    if (Number.isFinite(tabId)) return this.tabs.get(tabId) || null
    if (params.owner == null) return null
    const entry = this.owners.get(String(params.owner || 'default'))
    if (entry?.activeTabId == null) return null
    return entry.tabs.get(entry.activeTabId) || null
  }

  // Screenshot frame cache, freshness marker and viewer screencast state live
  // in headless-screenshot.js (Q26). These facades preserve the driver API and
  // the dispatch/screencast envelopes; output and bytes are unchanged.
  async viewportSize(tab) { return this.screenshot.viewportSize(tab) }
  async pageVisible(tab) { return this.screenshot.pageVisible(tab) }
  scheduleScreencastFlush(tab) { return this.screenshot.scheduleScreencastFlush(tab) }
  flushScreencastFrame(tab) { return this.screenshot.flushScreencastFrame(tab) }
  shotStreamState(tab) { return this.screenshot.shotStreamState(tab) }
  async ensureShotStream(tab, options) { return this.screenshot.ensureShotStream(tab, options) }
  async stopShotStream(tab, options) { return this.screenshot.stopShotStream(tab, options) }
  dropShotStream(tab, options) { return this.screenshot.dropShotStream(tab, options) }
  dropScreencast(tab) { return this.screenshot.dropScreencast(tab) }
  touchShotStream(tab, state) { return this.screenshot.touchShotStream(tab, state) }
  resolveShotWaiters(state) { return this.screenshot.resolveShotWaiters(state) }
  waitShotFrame(state, changeAt, timeoutMs) { return this.screenshot.waitShotFrame(state, changeAt, timeoutMs) }
  async resolveScreenshotClip(tab, params) { return this.screenshot.resolveScreenshotClip(tab, params) }
  async cropScreenshotFrame(tab, frame, clip) { return this.screenshot.cropScreenshotFrame(tab, frame, clip) }
  async shotCropContext(tab) { return this.screenshot.shotCropContext(tab) }
  async cropJpegScreenshotFrame(tab, frame, clip, quality) { return this.screenshot.cropJpegScreenshotFrame(tab, frame, clip, quality) }
  async captureFullJpegClip(tab, clip, quality) { return this.screenshot.captureFullJpegClip(tab, clip, quality) }
  async captureClippedJpeg(tab, clip, quality) { return this.screenshot.captureClippedJpeg(tab, clip, quality) }
  async cropJpegBuffer(tab, buffer, size, clip, quality, token) { return this.screenshot.cropJpegBuffer(tab, buffer, size, clip, quality, token) }
  retireRenderChange(tab) { return this.screenshot.retireRenderChange(tab) }
  async screenshotFromStream(tab, options) { return this.screenshot.screenshotFromStream(tab, options) }

  async pageAction(tab, name, args, timeoutMs = 15000) {
    return this.evalOn(tab, pageCall(name, args))
  }

  async waitReady(tab, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const state = await this.evalOn(tab, 'document.readyState')
        if (state === 'complete') return true
      } catch {
        // still navigating
      }
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS))
    }
    return false
  }

  findCapture(owner, captureId) {
    if (captureId) {
      const capture = this.captures.get(String(captureId))
      if (!capture) throw error('CAPTURE_LOST', `capture ${captureId} is gone (was the extension worker restarted?)`)
      if (capture.owner !== owner) throw error('CAPTURE_NOT_FOUND', `no capture ${captureId} for this session`)
      return capture
    }
    let latest = null
    for (const capture of this.captures.values()) {
      if (capture.owner !== owner) continue
      if (!latest || capture.startedAt > latest.startedAt) latest = capture
    }
    if (!latest) throw error('NO_ACTIVE_CAPTURE', 'no capture for this session; call chrome_capture_start first')
    return latest
  }

  async request(method, params = {}) {
    // A previous request that proved itself paint-free leaves the flag clear
    // before dispatching, so only a verdict from *this* action can skip the
    // change marker (`tab.evaluate` / `tab.scroll` set it inside dispatch).
    const before = this.tabForParams(params)
    if (before) before.skipRenderChange = false
    const result = await this.dispatch(method, params)
    if (SHOT_STREAM_METHODS.has(method)) {
      const tab = this.tabForParams(params)
      if (tab) {
        if (tab.skipRenderChange) {
          tab.skipRenderChange = false
          tab.visualSkips = (tab.visualSkips || 0) + 1
          // A proven paint-free action also retires an older marker, but only
          // once that marker is older than the repaint window the driver grants
          // anyway: a paint requested moments ago can still be in flight, and
          // this proof says nothing about it. Waiting out the window first means
          // this path never shortens a wait — it only stops granting it twice
          // (docs/HEADLESS.md §4.1.14).
          if (Date.now() / 1000 - (tab.renderChangeAt || 0) > SHOT_STREAM_FRAME_TIMEOUT_MS / 1000) {
            this.retireRenderChange(tab)
          }
        } else {
          tab.renderChangeAt = Date.now() / 1000
        }
      }
    }
    return result
  }

  async dispatch(method, params = {}) {
    await this.ensureStarted()
    this.noteActivity()
    const owner = params.owner
    if (!SUPPORTED.has(method)) {
      throw error('UNSUPPORTED_BACKEND', `${method} is not implemented by the headless backend yet`)
    }
    // Navigation/input handlers come from the action registry (Q25); the rest of
    // the backend methods stay in the switch below. Both answer the same
    // envelopes and error codes.
    const action = HEADLESS_ACTIONS.get(method)
    if (action) return action(this, params, owner)
    switch (method) {
      case 'browser.status':
        return {
          connected: true,
          backend: 'headless',
          extensionVersion: null,
          hostVersion: null,
          protocol: 1,
          browserVersion: this.browserVersion,
          diskVersion: null,
          autoReload: false,
          groupCount: 0,
          groups: [],
        }
      case 'browser.site': {
        const tab = await this.ensureTab(owner, params.tabId)
        await this.syncTabMeta(tab)
        let origin = null
        try {
          const parsed = new URL(tab.url)
          if (parsed.protocol === 'http:' || parsed.protocol === 'https:') origin = parsed.origin
        } catch {
          origin = null
        }
        return { origin, url: tab.url, title: tab.title, tabId: tab.tabId }
      }
      case 'tab.tabs':
        return this.tabsRequest(owner, params)
      case 'tab.get_text': {
        const tab = await this.ensureTab(owner, params.tabId)
        const selector = params.selector
          ? String(params.selector)
          : 'main, article, [role="main"], body'
        const raw = await this.evalOn(
          tab,
          `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? (el.innerText || el.textContent || '') : null; })()`,
        )
        if (raw == null) return { found: false, text: '', truncated: false, frames: 1 }
        const maxChars = Math.min(Number(params.maxChars) || 20000, 200000)
        return { found: true, text: String(raw).slice(0, maxChars), truncated: String(raw).length > maxChars, frames: 1 }
      }
      case 'tab.find': {
        const tab = await this.ensureTab(owner, params.tabId)
        return this.pageAction(tab, 'findPage', [String(params.query || ''), Boolean(params.regex), params.maxResults])
      }
      case 'tab.storage': {
        const tab = await this.ensureTab(owner, params.tabId)
        const scope = params.scope === 'session' ? 'sessionStorage' : 'localStorage'
        const op = String(params.op || 'get')
        const raw = await this.evalOn(tab, `(() => {
          const store = ${scope};
          const op = ${JSON.stringify(op)};
          const key = ${JSON.stringify(params.key ?? null)};
          const keys = ${JSON.stringify(Array.isArray(params.keys) ? params.keys : null)};
          const value = ${JSON.stringify(params.value ?? null)};
          const encode = (v) => { try { return JSON.stringify(v) } catch { return String(v) } };
          const decode = (v) => { try { return JSON.parse(v) } catch { return v } };
          if (op === 'set') { store.setItem(key == null ? 'null' : String(key), encode(value)); return { ok: true, set: 1 } }
          const want = keys && keys.length ? keys : key != null ? [String(key)] : Object.keys(store);
          const items = {};
          for (const name of want) { const item = store.getItem(name); if (item != null) items[name] = decode(item) }
          if (op === 'remove') { for (const name of want) store.removeItem(name); return { ok: true, removed: want.length } }
          if (op === 'clear') { store.clear(); return { ok: true, cleared: true } }
          return { ok: true, items }
        })()`)
        return { ...raw, scope }
      }
      case 'tab.emulate': {
        const tab = await this.ensureTab(owner, params.tabId)
        if (params.reset) {
          await this.cdp.send('Emulation.clearDeviceMetricsOverride', {}, tab.sessionId)
          tab.viewport = null
          // A running screenshot stream was sized for the old viewport.
          await this.stopShotStream(tab)
          return { applied: false, reloaded: false, viewport: { width: 0, height: 0, mobile: false } }
        }
        const width = Math.max(100, Number(params.width) || 1280)
        const height = Math.max(100, Number(params.height) || 800)
        const mobile = Boolean(params.mobile)
        await this.cdp.send(
          'Emulation.setDeviceMetricsOverride',
          { width, height, deviceScaleFactor: 1, mobile },
          tab.sessionId,
        )
        tab.viewport = mobile ? null : { w: width, h: height, dpr: 1 }
        await this.stopShotStream(tab)
        return { applied: true, reloaded: false, viewport: { width, height, mobile } }
      }
      case 'tab.overlay': {
        const tab = await this.ensureTab(owner, params.tabId)
        const payload = { ...params }
        delete payload.owner
        delete payload.tabId
        if (payload.frame) {
          delete payload.frame
          const contexts = await this.ensureFrameOverlays(tab)
          let firstError = null
          for (const context of contexts) {
            try {
              await this.evalInContext(tab, context.contextId, `(() => { if (!window.__dshOverlay) { ${overlaySource()} } return true })()`)
              const value = await this.evalInContext(tab, context.contextId, `window.__dshOverlay.handle(${JSON.stringify(payload)})`)
              if (value?.ok) {
                tab.renderChangeAt = Date.now() / 1000
                tab.overlayChangedAt = Date.now() / 1000
                return { ...value, frameId: context.frameId, frameUrl: context.url }
              }
              if (value && !firstError) firstError = { ...value, frameId: context.frameId, frameUrl: context.url }
            } catch {
              // try the next frame
            }
          }
          return firstError || { ok: false, error: 'FRAME_TARGET_NOT_FOUND' }
        }
        if (!(await this.ensureOverlay(tab))) throw error('UNSUPPORTED_BACKEND', 'overlay script is not available')
        if (String(params.op) === 'auto') this.autoPointerEnabled = params.enabled !== false
        const result = await this.evalOn(tab, `window.__dshOverlay.handle(${JSON.stringify(payload)})`)
        // Overlay changes are page paints; make the next screenshot wait for a
        // fresh frame instead of serving the cached pre-overlay frame.
        tab.renderChangeAt = Date.now() / 1000
        tab.overlayChangedAt = Date.now() / 1000
        return result
      }
      case 'tab.snapshot': {
        const tab = await this.ensureTab(owner, params.tabId)
        // snapshotPage already reports title/url, so no extra syncTabMeta round trip.
        const value = await this.pageAction(tab, 'snapshotPage', [params.maxChars || 100000, Boolean(params.boxes)])
        if (value) {
          tab.title = value.title || ''
          if (value.url) tab.url = value.url
        }
        return { ...value, mode: 'full' }
      }
      case 'tab.frames': {
        const tab = await this.ensureTab(owner, params.tabId)
        const tree = await this.cdp.send('Page.getFrameTree', {}, tab.sessionId)
        const frames = []
        const walk = (node, depth) => {
          frames.push({ frameId: node.frame.id, parentFrameId: node.frame.parentId || null, url: node.frame.url, title: node.frame.name || '' })
          for (const child of node.childFrames || []) walk(child, depth + 1)
        }
        if (tree?.frameTree) walk(tree.frameTree, 0)
        return { tabId: tab.tabId, frames, frameCount: frames.length, mainFrameId: frames[0]?.frameId }
      }
      case 'tab.a11y': {
        const tab = await this.ensureTab(owner, params.tabId)
        const tree = await this.cdp.send('Accessibility.getFullAXTree', { max_depth: params.limit || 200 }, tab.sessionId)
        const nodes = (tree?.nodes || []).map((node) => ({ role: node.role?.value, name: node.name?.value, value: node.value?.value }))
        return { tabId: tab.tabId, nodes, total: nodes.length }
      }
      case 'tab.screenshot': {
        const tab = await this.ensureTab(owner, params.tabId)
        const format = params.format === 'jpeg' ? 'jpeg' : 'png'
        const quality = Math.max(1, Math.min(100, Number(params.quality) || 70))
        // Element/region semantics match the desktop backend: `clip` is CSS px,
        // `ref` is the element's viewport box, and `fullPage` overrides both.
        const fullPage = Boolean(params.fullPage)
        const clip = fullPage ? null : await this.resolveScreenshotClip(tab, params)
        // A plain viewport shot (the common case for both formats) is served
        // from the compositor's own frames, PNG clip/ref shots are cropped out
        // of that frame in the driver (see cropScreenshotFrame), and JPEG
        // clip/ref shots are cropped by the page's own codec inside an isolated
        // world (see cropJpegScreenshotFrame, docs/HEADLESS.md §4.1.9). The
        // slow-PNG opt-out, full-page, frameRef and highlight keep the exact
        // Page.captureScreenshot path; the resolved clip is passed through so
        // the fallback is still the requested region (except for JPEG regions,
        // which take the clipped capture before the stream exists and a
        // full-viewport capture + crop after, see captureClippedJpeg /
        // captureFullJpegClip).
        const needsCapture =
          Boolean(fullPage || params.frameRef || params.highlight) ||
          (format === 'png' && params.optimizeForSpeed === false) ||
          // Overlay changes are DOM paints the compositor stream can lag behind;
          // use the capture path for a short window so screenshots always show
          // the fresh pointer/annotations.
          Boolean(tab.overlayChangedAt && Date.now() / 1000 - tab.overlayChangedAt < 5)
        // A cold JPEG region shot (no screencast running yet) takes the cheap
        // clipped capture *first* and only then starts the stream: taken while
        // the stream runs, a clipped capture makes Chrome emit clip-sized
        // screencast frames for the tab and poisons every following crop.
        const coldJpegRegion = format === 'jpeg' && clip && !needsCapture && !tab.shotStream?.active
        let data = coldJpegRegion ? await this.captureClippedJpeg(tab, clip, quality) : null
        if (coldJpegRegion) {
          // Warm the stream for the shots that follow; a failure only means the
          // next shot takes the same cold path again.
          await this.ensureShotStream(tab, { format, quality }).catch(() => null)
        }
        if (!data && !needsCapture) {
          data = await this.screenshotFromStream(tab, { format, quality, clip })
        }
        if (!data && format === 'jpeg' && clip) {
          // The stream is running (or its crop failed): capture the whole
          // viewport and crop it the same way, which also repaints the full
          // surface so the next stream crop is usable again.
          data = await this.captureFullJpegClip(tab, clip, quality)
        }
        if (!data) {
          const captureParams = { format, captureBeyondViewport: fullPage }
          if (clip) captureParams.clip = { ...clip, scale: 1 }
          if (format === 'jpeg') {
            captureParams.quality = quality
          } else if (params.optimizeForSpeed !== false) {
            // Fast PNG encoder: ~20% less screenshot CPU on content-heavy pages,
            // at the cost of a larger (still lossless) PNG. Opt out per call.
            captureParams.optimizeForSpeed = true
          }
          const shot = await this.cdp.send('Page.captureScreenshot', captureParams, tab.sessionId)
          data = Buffer.from(shot.data, 'base64')
        }
        this.screenshotSeq += 1
        const extension = format === 'jpeg' ? 'jpg' : 'png'
        const file = path.join(this.screenshotDir, `headless-${Date.now()}-${this.screenshotSeq}.${extension}`)
        await this.writeCaptureFile(file, data)
        const viewport = await this.viewportSize(tab)
        return {
          path: file,
          mediaType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
          width: clip ? Math.round(clip.width) : viewport.w,
          height: clip ? Math.round(clip.height) : viewport.h,
          bytes: data.byteLength,
        }
      }
      case 'tab.pdf': {
        const tab = await this.ensureTab(owner, params.tabId)
        const pdf = await this.cdp.send('Page.printToPDF', { printBackground: true }, tab.sessionId)
        const data = Buffer.from(pdf.data, 'base64')
        this.screenshotSeq += 1
        const file = path.join(this.screenshotDir, `headless-${Date.now()}-${this.screenshotSeq}.pdf`)
        await this.writeCaptureFile(file, data)
        return { path: file, bytes: data.byteLength }
      }
      case 'tab.evaluate': {
        const tab = await this.ensureTab(owner, params.tabId)
        // A read-only evaluate paints nothing, so the visual probe keeps the
        // previous change marker and the next screenshot is a cache hit
        // (docs/HEADLESS.md §4.1.7). Semantics of the expression are unchanged:
        // the probe only wraps it in two snapshot round trips.
        const value = await this.visualProbeAction(tab, () =>
          this.evalOn(tab, String(params.expression || 'undefined'), { awaitPromise: true }),
        )
        return { ok: true, value }
      }
      case 'tab.html': {
        const tab = await this.ensureTab(owner, params.tabId)
        const html = await this.evalOn(tab, '(' + String(params.selector ? `document.querySelector(${JSON.stringify(params.selector)})` : 'document.documentElement') + ')?.outerHTML || ""')
        return { tabId: tab.tabId, html: String(html).slice(0, params.maxChars || 20000), truncated: String(html).length > (params.maxChars || 20000) }
      }
      case 'tab.text': {
        const tab = await this.ensureTab(owner, params.tabId)
        const text = await this.evalOn(tab, `(() => { const el = ${params.selector ? `document.querySelector(${JSON.stringify(params.selector)})` : 'document.body'}; return el ? (el.innerText || el.textContent || '') : ''; })()`)
        return { tabId: tab.tabId, text: String(text).slice(0, params.maxChars || 20000), truncated: String(text).length > (params.maxChars || 20000) }
      }
      case 'tab.selection': {
        const tab = await this.ensureTab(owner, params.tabId)
        const result = await this.pageAction(tab, 'currentSelection', [params.maxChars || 4000])
        return { ...result, tabId: tab.tabId }
      }
      case 'tab.console': {
        const tab = await this.ensureTab(owner, params.tabId)
        let entries = this.consoleBuffers.get(tab.tabId) || []
        if (params.level) entries = entries.filter((entry) => entry.level === params.level)
        if (params.filter) entries = entries.filter((entry) => String(entry.text || '').includes(String(params.filter)))
        const limit = Number(params.limit) > 0 ? Math.min(Number(params.limit), 120) : 50
        const sliced = entries.slice(-limit)
        if (params.clear) this.consoleBuffers.set(tab.tabId, [])
        return { available: true, entries: sliced }
      }
      case 'tab.network': {
        const tab = await this.ensureTab(owner, params.tabId)
        const raw = await this.evalOn(
          tab,
          `performance.getEntriesByType('resource').map((entry) => ({ url: entry.name, type: entry.initiatorType, durationMs: Math.round(entry.duration), transferSize: entry.transferSize || 0, status: entry.responseStatus || null }))`,
        )
        let entries = Array.isArray(raw) ? raw : []
        if (params.filter) entries = entries.filter((entry) => String(entry.url || '').includes(String(params.filter)))
        const limit = Number(params.limit) > 0 ? Math.min(Number(params.limit), 200) : 50
        return { available: true, entries: entries.slice(0, limit) }
      }
      case 'tab.upload': {
        const tab = await this.ensureTab(owner, params.tabId)
        const selector = params.selector
          ? `document.querySelector(${JSON.stringify(String(params.selector))})`
          : `document.querySelector('[data-dsh-ref="${Number(params.ref)}"]')`
        const handle = await this.cdp.send(
          'Runtime.evaluate',
          { expression: selector, returnByValue: false },
          tab.sessionId,
        )
        const objectId = handle?.result?.objectId
        if (!objectId) throw error('REF_NOT_FOUND', `no file input for ${params.selector || `ref ${params.ref}`}`)
        const files = Array.isArray(params.files) ? params.files.map(String) : []
        if (files.length === 0) throw error('INVALID_ARGUMENT', 'files must be a non-empty array')
        await this.cdp.send('DOM.setFileInputFiles', { files, objectId }, tab.sessionId)
        return { ok: true, ref: params.ref, selector: params.selector, files: files.length }
      }
      case 'tab.resume':
        return { ok: true, tabId: this.peekOwner(owner)?.activeTabId ?? null }
      case 'browser.downloads': {
        const limit = Number(params.limit) > 0 ? Math.min(Number(params.limit), 100) : 20
        return {
          items: this.downloads.slice(0, limit).map((record) => ({
            ...record,
            path: path.join(this.downloadDir, record.filename || ''),
          })),
        }
      }
      case 'tab.capture_start': {
        const tab = await this.ensureTab(owner, params.tabId)
        if (this.captureByTab.get(tab.tabId)?.active) {
          const existing = this.captureByTab.get(tab.tabId)
          return {
            captureId: existing.captureId,
            tabId: tab.tabId,
            alreadyActive: true,
            requests: existing.entries.length,
            startedAt: new Date(existing.startedAt).toISOString(),
            resourceTypes: existing.resourceTypes,
          }
        }
        const resourceTypes = Array.isArray(params.resourceTypes) && params.resourceTypes.length > 0
          ? params.resourceTypes.map(String)
          : ['xhr', 'fetch', 'document']
        const maxEntries = Number.isFinite(params.maxEntries)
          ? Math.max(1, Math.min(CAPTURE_HARD_MAX_ENTRIES, params.maxEntries))
          : CAPTURE_DEFAULT_MAX_ENTRIES
        const capture = {
          captureId: `hl-${this.nextCaptureSeq++}`,
          owner,
          tabId: tab.tabId,
          active: true,
          startedAt: Date.now(),
          endedReason: null,
          entries: [],
          byId: new Map(),
          dropped: 0,
          maxEntries,
          storeBodies: params.storeBodies !== false,
          bodyBytes: 0,
          bodiesDropped: 0,
          bodyTasks: 0,
          resourceTypes,
        }
        capture.timer = setTimeout(() => {
          capture.timer = null
          try {
            this.cdp?.send('Network.disable', {}, tab.sessionId)
          } catch {
            // ignore
          }
          if (capture.active) {
            capture.active = false
            capture.endedReason = 'max-duration'
            capture.stoppedAt = Date.now()
            this.releaseCaptureData(capture)
            this.armCaptureExpiry(capture)
          }
        }, CAPTURE_MAX_DURATION_MS)
        capture.timer.unref?.()
        this.captures.set(capture.captureId, capture)
        this.captureByTab.set(tab.tabId, capture)
        try {
          await this.cdp.send('Network.enable', {}, tab.sessionId)
        } catch (failure) {
          // A capture whose Network domain could not be enabled must not stay
          // registered (it would never receive entries and would keep a timer).
          clearTimeout(capture.timer)
          capture.timer = null
          if (this.captures.get(capture.captureId) === capture) this.captures.delete(capture.captureId)
          if (this.captureByTab.get(tab.tabId) === capture) this.captureByTab.delete(tab.tabId)
          throw failure
        }
        return {
          captureId: capture.captureId,
          active: true,
          tabId: tab.tabId,
          startedAt: new Date(capture.startedAt).toISOString(),
          resourceTypes,
          maxEntries,
          storeBodies: capture.storeBodies,
        }
      }
      case 'tab.capture_stop': {
        const capture = this.findCapture(owner, params.captureId)
        if (capture.active) {
          capture.active = false
          capture.endedReason = capture.endedReason || 'stopped'
          capture.stoppedAt = Date.now()
          if (capture.timer) {
            clearTimeout(capture.timer)
            capture.timer = null
          }
          try {
            await this.cdp.send('Network.disable', {}, this.tabs.get(capture.tabId)?.sessionId)
          } catch {
            // tab gone
          }
          // The summary stays readable through chrome_capture_requests, but the
          // raw request-body scratch and the event index are not needed once the
          // capture is frozen; TTL/count free the rest.
          this.releaseCaptureData(capture)
          this.armCaptureExpiry(capture)
        }
        return {
          captureId: capture.captureId,
          active: false,
          tabId: capture.tabId,
          requests: capture.entries.length,
          dropped: capture.dropped,
          bodiesDropped: capture.bodiesDropped,
          startedAt: new Date(capture.startedAt).toISOString(),
          endedAt: new Date().toISOString(),
          endedReason: capture.endedReason,
          durationMs: Date.now() - capture.startedAt,
        }
      }
      case 'tab.capture_requests': {
        const capture = this.findCapture(owner, params.captureId)
        const limit = Number(params.limit) > 0 ? Math.min(Number(params.limit), 200) : 50
        let entries = capture.entries
        if (params.filter) {
          const needle = String(params.filter).toLowerCase()
          entries = entries.filter((entry) => `${entry.method} ${entry.url}`.toLowerCase().includes(needle))
        }
        if (Array.isArray(params.resourceTypes) && params.resourceTypes.length > 0) {
          const allowed = new Set(params.resourceTypes.map((type) => String(type).toLowerCase()))
          entries = entries.filter((entry) => allowed.has(entry.resourceType))
        }
        const includeBodies = params.includeBodies !== false
        const maxBodyChars = Number(params.maxBodyChars) > 0 ? Math.min(Number(params.maxBodyChars), 65536) : 4096
        const filtered = entries
        const selected = filtered.slice(-limit)
        const truncateBody = (text) => {
          const value = String(text || '')
          if (value.length <= maxBodyChars) return { text: value, truncated: false }
          return { text: `${value.slice(0, maxBodyChars)}… <truncated>`, truncated: true }
        }
        const rendered = selected.map((entry) => {
          const copy = { ...entry }
          delete copy._postDataRaw
          if (!includeBodies) {
            delete copy.requestBody
            delete copy.responseBody
          } else {
            if (copy.requestBody) {
              const result = truncateBody(copy.requestBody)
              copy.requestBody = result.text
              if (result.truncated) copy.bodyTruncated = true
            }
            if (copy.responseBody) {
              const result = truncateBody(copy.responseBody)
              copy.responseBody = result.text
              if (result.truncated) copy.bodyTruncated = true
            }
          }
          return copy
        })
        if (!capture.active) {
          // A frozen capture needs no raw event index or request-body scratch
          // after the read; the redacted entries stay readable for the TTL.
          this.releaseCaptureData(capture)
        }
        return {
          available: true,
          lost: false,
          active: capture.active,
          captureId: capture.captureId,
          tabId: capture.tabId,
          entries: rendered,
          total: filtered.length,
          truncated: filtered.length > limit,
          dropped: capture.dropped,
          bodiesDropped: capture.bodiesDropped,
        }
      }
      case 'tab.screencast_start': {
        const tab = await this.ensureTab(owner, params.tabId)
        if (tab.screencast?.active) {
          return { active: true, alreadyActive: true, tabId: tab.tabId, format: tab.screencast.format }
        }
        // The viewer takes over Page.startScreencast; stop the screenshot
        // stream first (screenshots then fall back to capture while it runs).
        await this.stopShotStream(tab)
        const format = params.format === 'png' ? 'png' : 'jpeg'
        const quality = Number.isFinite(params.quality) ? Math.max(1, Math.min(100, params.quality)) : 60
        const everyNthFrame = Number.isFinite(params.everyNthFrame)
          ? Math.max(1, Math.min(10, Math.trunc(params.everyNthFrame)))
          : 2
        tab.screencast = {
          active: true,
          format,
          frames: 0,
          startedAt: Date.now(),
          lastAt: null,
          owner: String(owner || 'default'),
          pending: null,
          flushTimer: null,
          lastWriteAt: 0,
          dirReady: false,
        }
        tab.screencast.timer = setTimeout(() => {
          const state = tab.screencast
          if (!state) return
          this.flushScreencastFrame(tab)
          this.cdp?.send('Page.stopScreencast', {}, tab.sessionId).catch(() => {})
          this.dropScreencast(tab)
        }, 10 * 60 * 1000)
        tab.screencast.timer.unref?.()
        try {
          await this.cdp.send('Page.startScreencast', { format, quality, everyNthFrame, maxWidth: 1280, maxHeight: 800 }, tab.sessionId)
        } catch (error) {
          this.dropScreencast(tab)
          throw error
        }
        return { active: true, alreadyActive: false, tabId: tab.tabId, format, everyNthFrame }
      }
      case 'tab.screencast_stop': {
        const tab = await this.ensureTab(owner, params.tabId)
        const state = tab.screencast
        const frames = state?.frames || 0
        const elapsedMs = state ? Date.now() - state.startedAt : 0
        // Write the newest frame synchronously so stopping never loses it
        // (§4.1.6: with the throttle the last frame may still be pending).
        if (state) this.flushScreencastFrame(tab)
        // Drop every local timer/state before the CDP round trip so a closed or
        // unresponsive tab cannot keep the screencast timer alive.
        this.dropScreencast(tab)
        await this.cdp?.send('Page.stopScreencast', {}, tab.sessionId).catch(() => {})
        return {
          active: false,
          tabId: tab.tabId,
          frames,
          elapsedMs,
        }
      }
      case 'tab.screencast_status': {
        const tab = await this.ensureTab(owner, params.tabId)
        const state = tab.screencast
        if (!state) return { active: false, tabId: tab.tabId, frames: 0 }
        return {
          active: true,
          tabId: tab.tabId,
          frames: state.frames,
          startedAt: new Date(state.startedAt).toISOString(),
          lastAt: state.lastAt ? new Date(state.lastAt).toISOString() : null,
          format: state.format,
        }
      }
      case 'tab.close_session': {
        const entry = this.peekOwner(owner)
        if (!entry) return { closed: 0 }
        let closed = 0
        for (const tab of [...entry.tabs.values()]) {
          if (await this.closeTab(tab, { reason: 'session-closed' })) closed += 1
        }
        entry.activeTabId = null
        this.maybeReleaseOwner(entry)
        return { closed }
      }
      case 'tab.debug_diag':
        return {
          backend: 'headless',
          browserVersion: this.browserVersion,
          owners: [...this.owners.entries()].map(([key, entry]) => ({ owner: key, tabs: entry.tabs.size, activeTabId: entry.activeTabId })),
          tabs: [...this.tabs.values()].map((tab) => {
            const stream = tab.shotStream
            return {
              tabId: tab.tabId,
              // Page-side visual probe (docs/HEADLESS.md §4.1.7): whether the
              // tracker is installed, and how many page-changing actions were
              // proven paint-free and therefore kept the previous frame marker.
              visualTracker: Boolean(tab.visualTracker),
              visualSkips: tab.visualSkips || 0,
              // Markers retired after a repaint-window miss (or a proven
              // paint-free action past the window): how often the driver
              // stopped re-waiting for a change it already knew had no paint.
              renderChangeRetires: tab.renderChangeRetires || 0,
              screenshotStream: stream
                ? {
                    active: stream.active,
                    format: stream.format,
                    quality: stream.quality,
                    frames: stream.frames,
                    restarts: stream.restarts,
                    served: stream.served,
                    cropped: stream.cropped,
                    jpegCropped: stream.jpegCropped,
                    fallbacks: stream.fallbacks,
                    timeouts: stream.timeouts,
                    repaintMisses: stream.repaintMisses,
                    maxWidth: stream.maxWidth,
                    maxHeight: stream.maxHeight,
                    disabled: stream.disabledUntil > Date.now(),
                  }
                : null,
            }
          }),
        }
      default:
        throw error('UNSUPPORTED_BACKEND', `${method} is not implemented by the headless backend yet`)
    }
  }

  async tabsRequest(owner, params) {
    const op = String(params.op || 'list')
    if (op === 'list') {
      // Read-only: never create an owner entry just to answer an empty list.
      const entry = this.peekOwner(owner)
      if (!entry) return { tabs: [], groupId: null, activeTabId: null }
      for (const tab of entry.tabs.values()) await this.syncTabMeta(tab)
      return {
        tabs: [...entry.tabs.values()].map((tab) => ({
          tabId: tab.tabId,
          title: tab.title,
          url: tab.url,
          active: tab.tabId === entry.activeTabId,
        })),
        groupId: null,
        activeTabId: entry.activeTabId,
      }
    }
    if (op === 'new') {
      // Validate before creating an owner entry: an invalid URL must not leave
      // an empty owner behind.
      const url = safeTabUrl(params.url)
      const entry = this.ownerEntry(owner)
      const tab = await this.attachTab(entry, url)
      if (url !== 'about:blank') await this.waitReady(tab)
      await this.syncTabMeta(tab)
      return { tabId: tab.tabId, url: tab.url, title: tab.title }
    }
    if (op === 'close') {
      const entry = this.peekOwner(owner)
      const tab = entry?.tabs.get(Number(params.tabId))
      if (!tab) {
        if (entry) this.maybeReleaseOwner(entry)
        throw error('TAB_NOT_FOUND', `tab ${params.tabId} is not owned by this session`)
      }
      const tabId = tab.tabId
      await this.closeTab(tab, { reason: 'tabs-close' })
      return { closed: tabId, remaining: entry.tabs.size }
    }
    if (op === 'claim') {
      const tab = await this.ensureTab(owner, params.tabId)
      await this.syncTabMeta(tab)
      const entry = this.peekOwner(owner)
      if (entry) entry.activeTabId = tab.tabId
      return { claimed: true, tabId: tab.tabId, url: tab.url, title: tab.title }
    }
    if (op === 'focus') {
      const tab = await this.ensureTab(owner, params.tabId)
      const entry = this.peekOwner(owner)
      if (entry) entry.activeTabId = tab.tabId
      return { focused: true, tabId: tab.tabId, url: tab.url, title: tab.title }
    }
    throw error('INVALID_ARGUMENT', `unknown tabs op: ${op}`)
  }

  async loginStart(options) {
    return headlessLogin.loginStart(this, options)
  }

  async showVisible(options) {
    return headlessLogin.showVisible(this, options)
  }

  loginStatus() {
    return headlessLogin.loginStatus(this)
  }

  loginFinish() {
    return headlessLogin.loginFinish(this)
  }

  /**
   * Close one tab and unregister it everywhere. `cleanupTab` runs before the
   * CDP close so a rejected close cannot leave the tab registered; the later
   * `Target.detachedFromTarget` event then finds nothing and is a no-op.
   */
  async closeTab(tab, { reason = 'closed' } = {}) {
    if (!this.cleanupTab(tab, { reason })) return false
    try {
      await this.cdp?.send('Target.closeTarget', { targetId: tab.targetId })
    } catch {
      // target already gone
    }
    return true
  }

  /**
   * Forget every tab, capture, download and owner after the browser is gone.
   * Used by normal close (including context close / idle reap) and by the
   * child `exit` / CDP `close` handlers. `dead` defaults to true (the browser
   * exited unexpectedly); the deliberate `close()` path passes false so this
   * same teardown is not mistaken for a crash.
   */
  handleBrowserExit(reason = 'browser-exit', { dead = true } = {}) {
    // Detach the CDP client first: closing it below invokes its onClose hook,
    // and that hook must not treat an intentional teardown as a crash.
    const cdp = this.cdp
    this.cdp = null
    for (const tab of [...this.tabs.values()]) this.cleanupTab(tab, { reason })
    for (const capture of this.captures.values()) {
      if (capture.timer) clearTimeout(capture.timer)
      if (capture.expireTimer) clearTimeout(capture.expireTimer)
      this.releaseCaptureData(capture, { entries: true })
    }
    this.owners.clear()
    this.bySession.clear()
    this.consoleBuffers.clear()
    this.captures.clear()
    this.captureByTab.clear()
    this.downloadByGuid.clear()
    this.downloads.length = 0
    this.chrome = null
    this.browserVersion = null
    this.stopIdleTimer()
    this.lastActivity = Date.now()
    try {
      cdp?.close()
    } catch {
      // already closed
    }
    this.dead = Boolean(dead)
    this.deathReason = dead ? String(reason) : null
  }

  stopIdleTimer() {
    if (!this.idleTimer) return
    clearInterval(this.idleTimer)
    this.idleTimer = null
  }

  /**
   * Close the browser once. Concurrent callers (idle sweep, context close,
   * login handoff) share the same in-flight close instead of returning before
   * Chrome/profile teardown is done.
   */
  close() {
    if (!this.closePromise) {
      this.closePromise = this.#close().finally(() => {
        this.closePromise = null
      })
    }
    return this.closePromise
  }

  async #close() {
    this.closing = true
    try {
      try {
        this.loginProcess?.kill?.('SIGTERM')
      } catch {
        // ignore
      }
      this.loginProcess = null
      this.visibleMode = false
      // Detach the CDP client before asking Chrome to close: its onClose hook
      // is a crash handler, and this is an intentional shutdown. `send` still
      // uses the client object after it left `this`.
      const cdp = this.cdp
      this.cdp = null
      try {
        await cdp?.send('Browser.close')
      } catch {
        // browser already gone or does not support close
      }
      // Keep the child handle before teardown nulls it.
      const child = this.chrome
      try {
        cdp?.close()
      } catch {
        // ignore
      }
      this.handleBrowserExit('closed', { dead: false })
      try {
        child?.kill('SIGTERM')
      } catch {
        // ignore
      }
    } finally {
      this.closing = false
    }
  }
}

/**
 * Whether the headless backend has (or was explicitly told to use) a browser.
 *
 * An explicit but unavailable selection counts as supported here so the first
 * request reaches the driver and reports the precise
 * `HEADLESS_EXECUTABLE_NOT_FOUND` / `HEADLESS_ENGINE_UNKNOWN` instead of the
 * router degrading to a generic `UNSUPPORTED_BACKEND`. Default probing still
 * requires an actually installed browser.
 */
export function headlessSupported(options = {}) {
  try {
    return Boolean(chromeExecutable(options))
  } catch (error) {
    if (error?.code === 'HEADLESS_EXECUTABLE_NOT_FOUND' || error?.code === 'HEADLESS_ENGINE_UNKNOWN') return true
    throw error
  }
}

/** Selected headless executable (null when no browser is installed). */
export function headlessChromeExecutable(options = {}) {
  return chromeExecutable(options)
}
