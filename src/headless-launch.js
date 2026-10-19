/**
 * Launch arguments and DevToolsActivePort parsing for the headless backend.
 *
 * Kept pure (no env, no fs, no spawn) so the exact Chromium argument list and
 * the port-file handshake are unit-testable without launching a real Chrome.
 */

const DEFAULT_WINDOW = { width: 1440, height: 900 }

/**
 * Build the Chromium argv used by `HeadlessDriver.ensureStarted`.
 *
 * `visible` selects a real headed window (I2 isolated-visible) instead of the
 * compositor-only headless flags; both are driven through the same CDP path.
 * Every headless tab is created by the driver through Target.createTarget, so
 * the startup window/page is dead weight there; visible mode keeps it because
 * the user must see and interact with it. `extraArgs` is already tokenized by
 * the caller (DSH_HEADLESS_CHROME_ARGS).
 */
export function buildLaunchArgs({ visible = false, profileDir, windowSize = null, extraArgs = [] } = {}) {
  return [
    ...(visible ? ['--new-window'] : ['--headless=new']),
    ...(visible ? [] : ['--no-startup-window']),
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-extensions',
    '--mute-audio',
    `--window-size=${windowSize?.width || DEFAULT_WINDOW.width},${windowSize?.height || DEFAULT_WINDOW.height}`,
    ...extraArgs,
    'about:blank',
  ]
}

/**
 * Parse the two-line DevToolsActivePort file Chrome writes into the profile:
 * the chosen port on line 1 and the browser websocket path on line 2. Returns
 * null until both lines exist (the file is created before it is complete, and
 * it may hold a stale entry from a previous run).
 */
export function parseDevToolsActivePort(text) {
  const lines = String(text ?? '')
    .trim()
    .split('\n')
  if (lines.length < 2) return null
  return {
    port: lines[0],
    wsPath: lines[1],
    url: `ws://127.0.0.1:${lines[0]}${lines[1]}`,
  }
}
