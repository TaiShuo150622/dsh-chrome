/**
 * Interactive headless login lifecycle: open a visible, dedicated Chrome window
 * on the headless profile (loginStart/showVisible), report it (loginStatus) and
 * close it (loginFinish). Extracted from HeadlessDriver (Q21) so the window
 * lifetime has one small module. HeadlessDriver keeps the same-named facade and
 * the returned objects are unchanged.
 */
import fsp from 'node:fs/promises'

export function createHeadlessLogin({ chromeExecutable, error }) {
  async function loginStart(driver, { url } = {}) {
    if (driver.loginProcess) {
      return { running: true, alreadyRunning: true, pid: driver.loginProcess.pid ?? null, profile: driver.loginProfile }
    }
    if (driver.tabs.size > 0) {
      throw error('HEADLESS_BUSY', 'close headless tabs (chrome_close_session {backend:"headless"}) before opening the login window')
    }
    if (driver.chrome || driver.cdp) await driver.close()
    const executable = chromeExecutable(driver)
    if (!executable) throw error('UNSUPPORTED_BACKEND', 'no Chrome/Chromium/Edge/Brave executable found (set DSH_HEADLESS_CHROME or DSH_HEADLESS_ENGINE)')
    const target = url && /^https?:\/\//i.test(String(url)) ? String(url) : 'about:blank'
    await fsp.mkdir(driver.loginProfile, { recursive: true })
    const child = driver.spawnImpl(
      executable,
      [
        `--user-data-dir=${driver.loginProfile}`,
        '--new-window',
        target,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-sync',
      ],
      { stdio: 'ignore' },
    )
    driver.loginProcess = child
    child.once?.('exit', () => {
      if (driver.loginProcess === child) driver.loginProcess = null
    })
    driver.logger?.info?.('headless login window opened (pid=%s)', child.pid)
    return { running: true, alreadyRunning: false, pid: child.pid ?? null, profile: driver.loginProfile, url: target }
  }

  async function showVisible(driver, { url } = {}) {
    if (driver.loginProcess) {
      return { running: true, alreadyRunning: true, visible: true, pid: driver.loginProcess.pid ?? null, profile: driver.loginProfile, url: driver.resumeUrl }
    }
    const active = [...driver.tabs.values()].find((tab) => tab.url && tab.url !== 'about:blank')
    const target = url || active?.url || 'about:blank'
    if (url && !/^https?:\/\//i.test(String(url))) {
      throw error('PROTECTED_PAGE', 'Only http(s) URLs are allowed.')
    }
    driver.resumeUrl = target && target !== 'about:blank' ? String(target) : null
    if (driver.chrome || driver.cdp || driver.tabs.size > 0) await driver.close()
    driver.visibleMode = true
    const opened = await driver.loginStart({ url: driver.resumeUrl || 'about:blank' })
    return { ...opened, visible: true, url: driver.resumeUrl }
  }

  function loginStatus(driver) {
    return {
      running: Boolean(driver.loginProcess),
      pid: driver.loginProcess?.pid ?? null,
      profile: driver.loginProfile,
      visible: driver.visibleMode,
      resumeUrl: driver.resumeUrl,
    }
  }

  function loginFinish(driver) {
    const child = driver.loginProcess
    if (!child) return { running: false, stopped: false, profile: driver.loginProfile }
    try {
      child.kill('SIGTERM')
    } catch {
      // already gone
    }
    driver.loginProcess = null
    driver.visibleMode = false
    driver.logger?.info?.('headless visible window closed')
    return { running: false, stopped: true, profile: driver.loginProfile, resumeUrl: driver.resumeUrl }
  }
  return { loginStart, showVisible, loginStatus, loginFinish }
}
