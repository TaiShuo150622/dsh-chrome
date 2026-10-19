/**
 * chrome_verify tool: isolated-context verification steps + artifacts. Kept
 * out of the main tool file so its step interpreter and artifact layout can be
 * tested without loading every chrome_* tool.
 */
export function createVerifyTool({ contexts, artifactStore, ownerOf, fsp, randomUUID, outputSchema, renderText }) {
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
        let lastUrl = ''
        const makeArtifacts = async () => {
          try {
            const consoleResult = await driver.request('tab.console', { owner, level: 'error', limit: 200 })
            const networkResult = await driver.request('tab.network', { owner, limit: 200 })
            const report = {
              runId,
              at: new Date().toISOString(),
              contextId,
              url: lastUrl,
              checks,
              console: consoleResult?.entries || [],
              network: networkResult?.entries || [],
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
              const url = String(step.url || '')
              if (!url) { checks.push({ id: `step-${checks.length + 1}`, type: 'navigate', ok: false, message: 'missing url' }); failed = true; break }
              const result = await driver.request('tab.goto', { owner, url })
              lastUrl = result?.url || url
              artifacts.push({ type: 'navigation', url: lastUrl })
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
              await driver.request('tab.click', { owner, selector: step.selector, ref: step.ref })
              continue
            }
            if (action === 'type') {
              await driver.request('tab.type', { owner, selector: step.selector, ref: step.ref, text: String(step.text ?? ''), replace: step.replace !== false })
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
          checks.push({ id: `error-${checks.length + 1}`, type: 'action', ok: false, message: String(error?.message || error) })
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
        }
      },
  }

}
