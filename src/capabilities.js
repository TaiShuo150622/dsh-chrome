/**
 * Backend capability contract.
 *
 * The tool layer (src/tools.js) keeps ONE schema for every chrome_* tool; a
 * backend declares here which capabilities it can actually honour. A tool that
 * needs a capability the current backend lacks must fail with
 * `UNSUPPORTED_BACKEND` (the error code headless already uses for unimplemented
 * methods) instead of silently returning a weaker result.
 *
 * This module is pure: no I/O, no runtime state, no third-party dependencies.
 * It is the single source of truth for capability names and for what each
 * backend type promises; src/backend.js exposes the current backend's answer
 * through BackendRouter#capabilities / #supports().
 *
 * See docs/CAPABILITIES.md and docs/ARCHITECTURE-PLATFORM.md §1.1.
 */

/**
 * Canonical capability names, in display order.
 *
 * `pause` is the USER_SWITCHED foreground-tab pause semantic, not a tool: the
 * desktop extension sets the pause when the user activates another tab, and
 * chrome_resume / chrome_tabs {op:"focus"} clear it. Headless has no foreground
 * tab a user could switch away from, so the capability does not apply there.
 */
export const CAPABILITIES = Object.freeze([
  'frames', // iframe deep read (frame-qualified refs, tab.frames)
  'shadow', // open shadow DOM deep read
  'capture', // Network capture (capture_start / capture_requests / capture_stop)
  'upload', // attach local files to <input type=file>
  'download', // trigger / list browser downloads
  'pick', // element pick driven by a real user click
  'screencast', // continuous frame stream for the live viewer
  'tabs', // multi-tab lifecycle / selection
  'pause', // USER_SWITCHED foreground-tab pause semantics
  'evaluate', // page-context JavaScript evaluation
])

const CAPABILITY_SET = new Set(CAPABILITIES)
const NO_CAPABILITIES = Object.freeze([])

/**
 * Capability set declared by each backend, in CAPABILITIES order.
 *
 * - desktop: visible Chrome through the MV3 extension + native host; full set.
 * - headless: background Chromium over CDP; everything except the two
 *   capabilities that require a visible browser and a human in front of it
 *   (pick needs a real click; pause needs a foreground tab to be switched away
 *   from).
 *
 * Declaring a capability is a contract promise to the tool layer, not a
 * duplicate of the current per-method whitelist: src/headless.js still rejects
 * unimplemented methods at request time with UNSUPPORTED_BACKEND, which stays
 * as the runtime safety net until tools gate on capabilities.
 */
export const BACKEND_CAPABILITIES = Object.freeze({
  desktop: CAPABILITIES,
  headless: Object.freeze(CAPABILITIES.filter((name) => name !== 'pick' && name !== 'pause')),
})

const BACKEND_SETS = new Map(
  Object.entries(BACKEND_CAPABILITIES).map(([backend, list]) => [backend, new Set(list)]),
)

/** Backend names that have a declared capability set (currently desktop/headless). */
export const KNOWN_BACKENDS = Object.freeze(Object.keys(BACKEND_CAPABILITIES))

/** True when `backend` has a declared capability set. Unknown names are safe. */
export function isKnownBackend(backend) {
  return typeof backend === 'string' && Object.hasOwn(BACKEND_CAPABILITIES, backend)
}

/** Frozen capability names declared by `backend`; unknown backend -> empty array. */
export function capabilitiesFor(backend) {
  return isKnownBackend(backend) ? BACKEND_CAPABILITIES[backend] : NO_CAPABILITIES
}

/**
 * Pure membership check. Unknown backend and unknown capability both return
 * false (never throw), so callers can safely probe a backend they do not know.
 */
export function backendSupports(backend, capability) {
  if (!isKnownBackend(backend)) return false
  if (typeof capability !== 'string' || !CAPABILITY_SET.has(capability)) return false
  return BACKEND_SETS.get(backend).has(capability)
}

/**
 * Throw unless `backend` declares `capability`.
 *
 * Returns true when supported. Otherwise throws an Error with
 * `code === 'UNSUPPORTED_BACKEND'` plus `backend` / `capability` fields, so the
 * provider and the model-facing tools can treat a missing capability exactly
 * like the existing headless "not implemented" errors.
 *
 * @param {string} backend
 * @param {string} capability
 * @param {string} [detail] optional next-step hint appended to the message
 */
export function assertBackendSupports(backend, capability, detail = '') {
  if (backendSupports(backend, capability)) return true
  const reason = isKnownBackend(backend)
    ? `backend "${backend}" does not support capability "${capability}"`
    : `unknown backend "${backend}" (known: ${KNOWN_BACKENDS.join(', ')})`
  const error = new Error(detail ? `${reason}; ${detail}` : reason)
  error.code = 'UNSUPPORTED_BACKEND'
  error.backend = backend
  error.capability = capability
  throw error
}
