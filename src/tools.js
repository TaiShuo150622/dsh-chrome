/**
 * Model-facing chrome_* tools (P1: 12 tools).
 *
 * Reads (status/snapshot/screenshot/tabs list/wait) run without approval.
 * Mutating actions (goto/click/type/press/history/tabs new|close/close_session)
 * go through ctx.approval, which follows the DSH session policy ("follow-dsh":
 * under danger-full-access / never it is allowed without a prompt).
 */
import fsp from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createLeaseTool } from './tools-lease.js'
import { createNavigationTools } from './tools-navigation.js'
import { createCaptureTools } from './tools-capture.js'
import { createReadTools } from './tools-read.js'
import { createInputTools } from './tools-input.js'
import { createStatusTools } from './tools-status.js'
import { createScreencastTools } from './tools-screencast.js'
import { createMediaTools } from './tools-media.js'
import { createMiscTools } from './tools-misc.js'
import { createContextTool } from './tools-context.js'
import { createVerifyTool } from './tools-verify.js'
import { createLoginTool } from './tools-login.js'
import { createMemoryTools } from './tools-memory.js'
import {
  createToolSupport,
  normalizeLeaseError,
  outputSchema,
  renderText,
  validateHttpUrl,
  validateTabUrl,
} from './tool-support.js'

// Page-text budget for chrome_snapshot. The snapshot exists for structure and
// refs, not for dumping a whole page: measured on a page with ~100KB of visible
// text (内部性能记录 §6), the old 100000-char default put 102.7KB on the
// wire per call (≈26k tokens) and cost 3.41ms in the driver; 20000 chars is
// 20.8KB / 1.32ms, and on a ~1MB-text page 5.86 -> 4.78ms. Two escapes cover
// callers that need the rest: maxChars (up to 200000) and chrome_get_text.
const SNAPSHOT_TEXT_DEFAULT_CHARS = 20000

export function chromeTools({ bridge, attachments, assets, approval, sessionContext, userQuestions, config, contexts, leases = null, contextViewer = null, update = null, artifactStore = null, memoryStats = null, memoryMonitor = null }) {
  const list = []
  const {
    ownerOf,
    sessionLabel,
    call,
    supports,
    sessionCwd,
    currentSite,
    writeAudit,
    guard,
    hardConfirmAsk,
    allowEvaluate,
    evaluateConfirmTimeoutMs,
    captureConfirmTimeoutMs,
  } = createToolSupport({ bridge, approval, sessionContext, userQuestions, config })

  // Navigation tools (goto/history/tabs/close_session) live in their own module
  // (Q13). Only the shared helpers they actually use are injected; tab/owner,
  // lease-release and URL-validation semantics are unchanged.
  const navigation = createNavigationTools({
    call,
    guard,
    ownerOf,
    sessionLabel,
    validateHttpUrl,
    validateTabUrl,
    outputSchema,
    renderText,
    leases,
  })

  // Capture tools (start/stop/requests) live in their own module (Q14). The
  // hard confirmation and the 30s capture RPC timeout are preserved verbatim.
  const captureTools = createCaptureTools({
    call,
    ownerOf,
    currentSite,
    hardConfirmAsk,
    captureConfirmTimeoutMs,
    outputSchema,
    renderText,
  })

  // Read-only page tools (snapshot/find/text/console/network/html/wait) live in
  // their own module (Q15). The snapshot text budget is injected so the default
  // stays a single constant in tools.js.
  const readTools = createReadTools({
    call,
    ownerOf,
    outputSchema,
    renderText,
    snapshotTextDefaultChars: SNAPSHOT_TEXT_DEFAULT_CHARS,
  })

  // Input tools (click/click_at/type/press/hover/scroll/select/drag/upload)
  // live in their own module (Q18). The upload allowlist moved with
  // chrome_upload; its audit writes and session-cwd lookup are injected so the
  // private-site policy behavior is unchanged.
  const inputTools = createInputTools({
    call,
    guard,
    ownerOf,
    outputSchema,
    renderText,
    hardConfirmAsk,
    evaluateConfirmTimeoutMs,
    writeAudit,
    sessionCwd,
  })

  // Status/config/policy/audit tools live in their own module (Q19). `bridge`,
  // `assets` and `update` stay injected as before; currentSite keeps the exact
  // same target-page lookup used by the approval guard.
  const statusTools = createStatusTools({
    bridge,
    assets,
    update,
    currentSite,
    outputSchema,
    renderText,
  })

  // Memory diagnostics (M6): a read-only snapshot assembled by the provider
  // (Node counters + context/bridge object counts). No page content is read.
  const memoryTools = createMemoryTools({ memoryStats, memoryMonitor, outputSchema, renderText })

  // Screencast/overlay tools (screencast/pointer/annotate/emulate) live in their
  // own module (Q20). The per-session stream guards and ownership ledger move
  // with the tool, so one provider instance still owns exactly one map each.
  const screencastTools = createScreencastTools({
    bridge,
    call,
    guard,
    supports,
    ownerOf,
    attachments,
    outputSchema,
    renderText,
  })

  // Media tools (screenshot/download/pdf/shots/frames) live in their own module
  // (Q23). The attachment service and the screenshot ownership ledger move with
  // the tools; chrome_pdf additionally needs the hard-confirmation helper and
  // the session cwd to contain explicit output paths.
  const mediaTools = createMediaTools({
    call,
    ownerOf,
    attachments,
    outputSchema,
    renderText,
    hardConfirmAsk,
    sessionCwd,
    evaluateConfirmTimeoutMs,
  })

  // Misc tools (evaluate/pick/resume/storage/selection) live in their own module
  // (Q24). The evaluate hard confirmation and the pick capability gate move with
  // the tools; the config flag still decides whether chrome_evaluate registers.
  const miscTools = createMiscTools({
    call,
    guard,
    supports,
    ownerOf,
    hardConfirmAsk,
    evaluateConfirmTimeoutMs,
    allowEvaluate,
    outputSchema,
    renderText,
  })

  // ---------------------------------------------------------------- 1. status
  list.push(statusTools.status)

  // --------------------------------------------------------- 1c. memory stats
  list.push(memoryTools.memory)

  // ------------------------------------------------------------------ 2. goto
  list.push(navigation.goto)

  // -------------------------------------------------------------- 3. snapshot
  list.push(readTools.snapshot)

  // ------------------------------------------------------------ 4. screenshot
  list.push(readTools.find, readTools.getText, inputTools.select, inputTools.drag, screencastTools.emulate, miscTools.storage, mediaTools.pdf,
  readTools.a11y,
  readTools.console,
  readTools.network,
  mediaTools.screenshot)

  // ---------------------------------------------------------------- 5. hover
  list.push(inputTools.hover)

  // ------------------------------------------------------------ 4b. chrome_html
  list.push(readTools.html)

  // ---------------------------------------------------------------- 5. click
  list.push(inputTools.click)

  // --------------------------------------------------------- 4c. selection
  list.push(miscTools.selection)

  // ------------------------------------------------------- 1a. provider config
  list.push(statusTools.config)

  // ------------------------------------------------------- 1b. policy/audit
  list.push(statusTools.policy)

  list.push(statusTools.audit)


  // ------------------------------------------- 4i-2. headless login profile
  list.push(createLoginTool({ bridge, contexts, ownerOf, hardConfirmAsk, evaluateConfirmTimeoutMs, outputSchema, renderText }))

  list.push(createContextTool({ contexts, contextViewer, ownerOf, outputSchema, renderText }))

  list.push(createLeaseTool({ leases, ownerOf, outputSchema, renderText, normalizeLeaseError }))

  list.push(createVerifyTool({ contexts, artifactStore, ownerOf, fsp, randomUUID, outputSchema, renderText }))

  // ------------------------------------------------ 4h-2. pointer/annotate
  list.push(screencastTools.pointer)

  list.push(screencastTools.annotate)

  // ----------------------------------------------------- 4j. screencast
  list.push(screencastTools.screencast)


  // ---------------------------------------------------------- 4i. shots
  // Screenshot history (both desktop and headless roots) and the per-session
  // ownership ledger live in tools-media.js (Q23).
  list.push(mediaTools.shots)

  // ---------------------------------------------------------- 4h. resume
  list.push(miscTools.resume)

  // ------------------------------------------------------------ 4g. pick
  list.push(miscTools.pick)

  // -------------------------------------------------------- 4e. evaluate (gated)
  if (miscTools.evaluate) list.push(miscTools.evaluate)

  // ---------------------------------------------------- 4f. HTTP capture (C2a)
  list.push(...captureTools)

  // ------------------------------------------------------------ 4d. frames
  list.push(mediaTools.frames)

  // ------------------------------------------------------------ 5b. click_at
  list.push(inputTools.clickAt)

  // ----------------------------------------------------------------- 6. type
  list.push(inputTools.type)

  // ---------------------------------------------------------------- 7. press
  list.push(inputTools.press)

  // --------------------------------------------------------------- 8. scroll
  list.push(inputTools.scroll)

  // -------------------------------------------------------------- 9. history
  list.push(navigation.history)

  // ----------------------------------------------------------------- 10. tabs
  list.push(navigation.tabs)

  // ----------------------------------------------------------------- 11. upload
  list.push(inputTools.upload)

  // ----------------------------------------------------------------- 12. downloads
  list.push(mediaTools.download)

  // ----------------------------------------------------------------- 11. wait
  list.push(readTools.wait)

  // -------------------------------------------------------- 12. close session
  list.push(navigation.closeSession)

  return list
}
