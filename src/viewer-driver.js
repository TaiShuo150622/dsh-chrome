/**
 * Driver/context bridge for the per-context viewer (Q28): one place turns the
 * injected context into a usable driver and maps driver error codes to the
 * viewer HTTP contract. Error codes and status mapping are unchanged.
 */
import { ViewerError } from './viewer-auth.js'

const VIEWER_OWNER = 'viewer'

async function callDriver(driver, method, params = {}) {
  try {
    return await driver.request(method, { ...params, owner: driver.__dshContextViewerOwner || VIEWER_OWNER })
  } catch (error) {
    const code = typeof error?.code === 'string' && error.code ? error.code : 'DRIVER_ERROR'
    const status = code === 'CONTEXT_NOT_FOUND' || code === 'TAB_NOT_FOUND' ? 404 : 500
    throw new ViewerError(status, code, error?.message || String(error))
  }
}

/** Resolve the injected context into a usable driver, mapping "not found" to 404. */
async function resolveContext(contextId, getContext) {
  let value
  try {
    value = await getContext(contextId)
  } catch (error) {
    if (error?.code === 'CONTEXT_NOT_FOUND') throw new ViewerError(404, 'CONTEXT_NOT_FOUND', `context ${contextId} was not found`)
    throw error
  }
  if (!value) throw new ViewerError(404, 'CONTEXT_NOT_FOUND', `context ${contextId} was not found`)
  const driver = value.driver || (typeof value.request === 'function' ? value : null)
  if (!driver || typeof driver.request !== 'function') {
    throw new ViewerError(503, 'CONTEXT_UNAVAILABLE', `context ${contextId} has no driver`)
  }
  if (value.owner) driver.__dshContextViewerOwner = String(value.owner)
  return { context: value, driver }
}

export { VIEWER_OWNER, callDriver, resolveContext }
