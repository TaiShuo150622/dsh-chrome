/**
 * chrome_verify tool: isolated-context verification steps + artifacts. Kept
 * out of the main tool file so its step interpreter and artifact layout can be
 * tested without loading every chrome_* tool.
 */
import { redactConsoleEntry, redactNetworkEntry, redactUrl } from './headless-redact.js'
import { classifyTarget, targetAllowedByAllowlist } from './verify-targets.js'

export function createVerifyTool({
  contexts,
  artifactStore,
  ownerOf,
  fsp,
  randomUUID,
  outputSchema,
  renderText,
  hardConfirmAsk = null,
  evaluateConfirmTimeoutMs = 120000,
  guard = null,
  writeAudit = null,
  validateHttpUrl = null,
  privateAllowlist = null,
}) {
  // Test-only allowlist for loopback/link-local/private navigations. The
  // provider never passes one, so there is no config/env/model switch that
  // turns off the private-target refusal at runtime.
  const allowlist = Array.isArray(privateAllowlist) ? privateAllowlist.slice() : []

  function blockedTarget(rawUrl) {
    const target = classifyTarget(rawUrl)
    if (!target.http || !target.reason) return null
    if (targetAllowedByAllowlist(target, allowlist)) return null
    return target
  }

  function privateTargetError(exec, action, rawUrl, target) {
    writeAudit?.(
      exec,
      'chrome_verify',
      action,
      { origin: target.origin, url: redactUrl(rawUrl), tabId: null },
      'denied',
      `private-target:${target.reason}`,
    )
    const error = new Error(
      `chrome_verify refuses a ${target.reason} target (${redactUrl(rawUrl)}); ` +
        'loopback/link-local/private targets are blocked by default',
    )
    error.code = 'PROTECTED_PAGE'
    return error
  }

  function requireGuard(toolName) {
    if (typeof guard !== 'function') {
      const error = new Error(`${toolName} requires the site guard; refusing the step`)
      error.code = 'APPROVAL_DENIED'
      return error
    }
    return null
  }

  // H5: a verify `type` step is model-supplied input too. The driver refuses a
  // password/OTP/payment target with SENSITIVE_FIELD; only after this one-shot
  // hard confirmation is the step retried. The step text never enters the card.
  async function confirmSensitiveType(exec, targetUrl) {
    if (typeof hardConfirmAsk !== 'function') {
      const error = new Error('hard confirmation service is unavailable; refusing to type into a sensitive field')
      error.code = 'APPROVAL_DENIED'
      throw error
    }
    let origin = ''
    try {
      origin = new URL(String(targetUrl)).origin
    } catch {
      origin = ''
    }
    await hardConfirmAsk(exec, 'chrome_verify', {
      header: 'verify：向敏感字段输入（密码 / OTP / 支付）',
      question: `允许 verify 步骤在 ${origin || '当前页面'} 上向被识别为密码/OTP/支付字段的控件输入一次明文吗？`,
      detail:
        '该字段被浏览器识别为敏感字段。步骤文本不会出现在结果、报告或审计里；' +
        '允许只对本次步骤生效，不会保存或自动填入任何凭据。',
      timeoutMs: evaluateConfirmTimeoutMs,
      site: targetUrl ? { origin, url: String(targetUrl), tabId: null } : null,
    })
  }

  return {
      name: 'chrome_verify',
      description:
        'Run a repeatable browser verification on an isolated headless context: navigate, waitFor, click, type, then assert URL/title/text/element/console/network. Returns machine-readable checks plus artifacts (screenshot, console/network summary, JSON report). This is the sandbox-verification layer; it reuses the per-session context and does not open a visible window.',
      parameters: {
        type: 'object',
        properties: {
          contextId: { type: 'string', description: 'Optional existing context id; defaults to this session active context.' },
          url: { type: 'string', description: 'Optional first navigation URL.' },
          steps: {
            type: 'array',
            description: 'Ordered steps: navigate/waitFor/click/type/assert.',
            items: { type: 'object', additionalProperties: true },
          },
          options: {
            type: 'object',
            properties: {
              screenshotOnFailure: { type: 'boolean' },
              captureConsole: { type: 'boolean' },
              captureNetwork: { type: 'boolean' },
            },
            additionalProperties: false,
          },
        },
        required: ['steps'],
        additionalProperties: false,
      },
      output: {
        schema: outputSchema({
          ok: { type: 'boolean' },
          contextId: { type: 'string' },
          url: { type: 'string' },
          durationMs: { type: 'number' },
          checks: { type: 'array', items: { type: 'object', additionalProperties: true } },
          artifacts: { type: 'array', items: { type: 'object', additionalProperties: true } },
          error: { type: 'string' },
        }),
        render: (_args, value) => {
          if (!value || value.ok == null) return renderText(`Verify error: ${value?.error || 'unknown'}`)
          const failed = (value.checks || []).filter((check) => !check.ok)
          const lines = (value.checks || []).map((check) => `${check.ok ? 'PASS' : 'FAIL'} ${check.id || check.type || ''} ${check.message || ''}`)
          lines.unshift(`chrome_verify ${value.ok ? 'PASS' : 'FAIL'} (${value.durationMs}ms, ${value.checks?.length || 0} checks)`)
          if (failed.length) lines.push(`failed: ${failed.length}`)
          if (value.artifacts?.length) lines.push(`artifacts: ${value.artifacts.map((item) => item.path || item.type).join(', ')}`)
          return renderText(lines.join('\n'))
        },
      },
      async execute(args, exec) {
        if (!contexts) return { ok: false, error: 'CONTEXTS_UNAVAILABLE' }
        if (!artifactStore) return { ok: false, error: 'ARTIFACTS_UNAVAILABLE' }
        const owner = ownerOf(exec)
        const runId = randomUUID()
        const steps = Array.isArray(args?.steps) ? args.steps.slice(0, 50) : []
        if (steps.length === 0) return { ok: false, error: 'STEPS_REQUIRED' }
        let contextId = String(args?.contextId || '')
        const requested = contextId ? contexts.getOwned(contextId, owner) : contexts.activeFor(owner)
        let ctx = requested
        if (contextId && !ctx) return { ok: false, error: 'CONTEXT_NOT_FOUND' }
        if (!ctx) {
          ctx = await contexts.create({ owner, preset: 'sandbox' })
          contextId = ctx.contextId
        } else {
          contextId = ctx.contextId
        }
        const driver = contexts.driverForOwned ? contexts.driverForOwned(contextId, owner) : contexts.driverFor(contextId)
        if (!driver) return { ok: false, error: 'CONTEXT_NOT_FOUND' }
        const artifactDir = await artifactStore.createArtifactRun(runId)
        const startedAt = Date.now()
        const checks = []
        const artifacts = []
        let failed = false
        let failureCode = null
        let lastUrl = ''
        const siteFrom = (url, title = '', tabId = null) => {
          const target = classifyTarget(url)
          return {
            origin: target.origin,
            url: String(url || ''),
            title: String(title || ''),
            tabId: Number.isInteger(tabId) ? tabId : null,
          }
        }
        // Resolve the page the verify context is on, through its own driver.
        // The desktop bridge's active tab is a different page and must never
        // decide what this step is allowed to touch.
        const resolveSite = async () => {
          try {
            const site = await driver.request('browser.site', { owner })
            if (site && typeof site.url === 'string') return siteFrom(site.url, site.title, site.tabId)
          } catch {}
          try {
            const snap = await driver.request('tab.snapshot', { owner, maxChars: 2000 })
            if (snap && typeof snap.url === 'string') return siteFrom(snap.url, snap.title, snap.tabId)
          } catch {}
          return null
        }
        const noSiteError = () => {
          const error = new Error('cannot resolve the verify context page; refusing to act on an unknown site')
          error.code = 'APPROVAL_DENIED'
          return error
        }
        const guardAction = async (action, options) => {
          const missing = requireGuard('chrome_verify')
          if (missing) throw missing
          await guard(exec, 'chrome_verify', action, options)
        }
        const assertAllowedTarget = (rawUrl, action) => {
          const target = blockedTarget(rawUrl)
          if (target) throw privateTargetError(exec, action, rawUrl, target)
        }
        const makeArtifacts = async () => {
          try {
            const consoleResult = await driver.request('tab.console', { owner, level: 'error', limit: 200 })
            const networkResult = await driver.request('tab.network', { owner, limit: 200 })
            const report = {
              runId,
              at: new Date().toISOString(),
              contextId,
              // H6: persisted artifacts are model/page supplied, so the final
              // URL and every console/network entry are redacted before they
              // hit disk. Console text and performance URLs routinely carry
              // tokens and `password=` pairs.
              url: redactUrl(lastUrl),
              checks,
              console: (Array.isArray(consoleResult?.entries) ? consoleResult.entries : []).map(redactConsoleEntry),
              network: (Array.isArray(networkResult?.entries) ? networkResult.entries : []).map(redactNetworkEntry),
              durationMs: Date.now() - startedAt,
            }
            const reportPath = artifactStore.reportPath(artifactDir, runId)
            await fsp.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
            artifacts.push({ type: 'report', path: reportPath })
          } catch {
            // artifacts are best-effort on a broken page
          }
          try {
            const shot = await driver.request('tab.screenshot', { owner })
            if (shot?.path) {
              // Context profiles are ephemeral; copy evidence into the global
              // artifact run so it survives context close.
              const target = artifactStore.screenshotPath(artifactDir, runId)
              try {
                await artifactStore.copyScreenshot(shot, artifactDir, runId)
                artifacts.push({ type: 'screenshot', path: target, bytes: shot.bytes })
              } catch {
                artifacts.push({ type: 'screenshot', path: shot.path, bytes: shot.bytes })
              }
            }
          } catch {}
        }
        try {
          for (const step of steps) {
            const action = String(step?.action || '')
            if (action === 'navigate') {
              const raw = String(step.url || '')
              if (!raw) { checks.push({ id: `step-${checks.length + 1}`, type: 'navigate', ok: false, message: 'missing url' }); failed = true; break }
              if (typeof validateHttpUrl !== 'function') {
                const error = new Error('URL validation is unavailable; refusing to navigate')
                error.code = 'PROTECTED_PAGE'
                throw error
              }
              const url = validateHttpUrl(raw)
              assertAllowedTarget(url, `navigate to ${redactUrl(url)}`)
              // H6: navigate targets are approved like chrome_goto, and the
              // decision is audited under chrome_verify.
              await guardAction(`navigate to ${redactUrl(url)}`, { targetUrl: url })
              const result = await driver.request('tab.goto', { owner, url })
              const finalUrl = String(result?.url || url)
              const redirected = blockedTarget(finalUrl)
              if (redirected) {
                // The approval covered the public URL. A redirect into the
                // local network must not become a post-approval read: leave
                // the page (so artifacts do not capture it) and stop the run.
                try { await driver.request('tab.goto', { owner, url: 'about:blank' }) } catch {}
                lastUrl = 'about:blank'
                throw privateTargetError(exec, `navigate to ${redactUrl(finalUrl)}`, finalUrl, redirected)
              }
              lastUrl = finalUrl
              artifacts.push({ type: 'navigation', url: redactUrl(finalUrl) })
              continue
            }
            if (action === 'waitFor') {
              const until = String(step.until || (step.selector ? 'selector' : step.text ? 'text' : 'load'))
              await driver.request('tab.wait', {
                owner,
                until,
                selector: step.selector,
                text: step.text,
                url: step.url,
                timeoutMs: Number(step.timeoutMs) || 15000,
              })
              continue
            }
            if (action === 'click') {
              const site = await resolveSite()
              if (!site) throw noSiteError()
              const actionLabel = `click on ${redactUrl(site.url)}`
              assertAllowedTarget(site.url, actionLabel)
              await guardAction(actionLabel, { site })
              await driver.request('tab.click', { owner, selector: step.selector, ref: step.ref })
              continue
            }
            if (action === 'type') {
              const site = await resolveSite()
              if (!site) throw noSiteError()
              const actionLabel = `type into ${redactUrl(site.url)}`
              assertAllowedTarget(site.url, actionLabel)
              await guardAction(actionLabel, { site })
              if (site.url) lastUrl = site.url
              const typeParams = {
                owner,
                selector: step.selector,
                ref: step.ref,
                text: String(step.text ?? ''),
                replace: step.replace !== false,
              }
              try {
                await driver.request('tab.type', typeParams)
              } catch (error) {
                if (error?.code !== 'SENSITIVE_FIELD') throw error
                await confirmSensitiveType(exec, site.url || lastUrl || step.url || '')
                await driver.request('tab.type', { ...typeParams, sensitiveApproved: true })
              }
              continue
            }
            if (action === 'assert') {
              let snapshot = null
              const getSnapshot = async () => {
                snapshot ||= await driver.request('tab.snapshot', { owner, maxChars: 200000 })
                return snapshot
              }
              for (const [index, check] of (Array.isArray(step.checks) ? step.checks : []).entries()) {
                const id = check?.id || `check-${checks.length + 1}-${index + 1}`
                const type = String(check?.type || '')
                let ok = false
                let message = ''
                try {
                  if (type === 'url') {
                    const snap = await getSnapshot()
                    lastUrl = snap?.url || lastUrl
                    ok = check.contains ? String(snap?.url || '').includes(String(check.contains)) : check.matches ? new RegExp(String(check.matches)).test(String(snap?.url || '')) : Boolean(snap?.url)
                    message = ok ? '' : `url was ${snap?.url || ''}`
                  } else if (type === 'title') {
                    const snap = await getSnapshot()
                    ok = String(snap?.title || '').includes(String(check.contains || ''))
                    message = ok ? '' : `title was ${snap?.title || ''}`
                  } else if (type === 'text') {
                    const snap = await getSnapshot()
                    ok = String(snap?.text || '').includes(String(check.contains || ''))
                    message = ok ? '' : 'expected text not found'
                  } else if (type === 'element') {
                    const result = await driver.request('tab.evaluate', {
                      owner,
                      expression: `(() => { const el = document.querySelector(${JSON.stringify(String(check.selector || ''))}); if (!el) return { exists: false }; const r = el.getBoundingClientRect(); return { exists: true, visible: r.width > 0 && r.height > 0, text: (el.innerText || '') .slice(0, 2000) }; })()`,
                    })
                    const value = result?.value || {}
                    if (check.exists === false) ok = value.exists === false
                    else if (check.state === 'visible') ok = Boolean(value.exists && value.visible)
                    else if (check.state === 'absent') ok = !value.exists
                    else if (check.state === 'enabled') ok = Boolean(value.exists) && value.disabled !== true
                    else ok = Boolean(value.exists)
                    if (ok && check.contains) ok = String(value.text || '').includes(String(check.contains))
                    if (ok && check.matches) ok = new RegExp(String(check.matches)).test(String(value.text || ''))
                    message = ok ? '' : `element check failed: ${JSON.stringify(value).slice(0, 200)}`
                  } else if (type === 'console') {
                    const logs = await driver.request('tab.console', { owner, level: 'error', limit: 200 })
                    const count = Array.isArray(logs?.entries) ? logs.entries.length : 0
                    ok = count <= Number(check.maxErrors ?? 0)
                    message = ok ? '' : `${count} console error(s)`
                  } else if (type === 'network') {
                    const entries = (await driver.request('tab.network', { owner, limit: 200 }))?.entries || []
                    const filtered = check.urlPattern ? entries.filter((entry) => String(entry.url || '').includes(String(check.urlPattern))) : entries
                    const failures = filtered.filter((entry) => Number(entry.status) >= 400 || entry.status == null && Number(entry.transferSize) === 0)
                    ok = failures.length <= Number(check.maxFailures ?? 0)
                    message = ok ? '' : `${failures.length} failed request(s)`
                  } else {
                    message = `unknown check type: ${type}`
                  }
                } catch (error) {
                  ok = false
                  message = String(error?.message || error)
                }
                checks.push({ id, type, ok, message })
                if (!ok) failed = true
              }
              continue
            }
            checks.push({ id: `step-${checks.length + 1}`, type: action || 'unknown', ok: false, message: 'unknown action' })
            failed = true
            break
          }
        } catch (error) {
          const check = {
            id: `error-${checks.length + 1}`,
            type: 'action',
            ok: false,
            message: String(error?.message || error),
          }
          if (typeof error?.code === 'string') {
            check.code = error.code
            failureCode = error.code
          }
          checks.push(check)
          failed = true
        }
        const options = args?.options || {}
        // Artifacts are first-class: always keep the JSON report + screenshot,
        // so a passing run is reproducible and a failing run has evidence.
        await makeArtifacts()
        try { artifactStore.pruneArtifacts?.() } catch {}
        try {
          const snap = await driver.request('tab.snapshot', { owner, maxChars: 2000 })
          lastUrl = snap?.url || lastUrl
        } catch {}
        return {
          ok: !failed,
          contextId,
          url: lastUrl,
          durationMs: Date.now() - startedAt,
          checks,
          artifacts,
          ...(failureCode ? { error: failureCode } : {}),
        }
      },
  }

}
