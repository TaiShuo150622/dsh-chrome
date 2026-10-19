/**
 * Launch-argument test — no Chrome required.
 *
 * The argv list and the DevToolsActivePort handshake are the pieces of
 * `ensureStarted` that a unit test can pin without spawning a browser: flag
 * order/content selects headless vs. visible mode and the CDP endpoint. The
 * expectations below are the literal contract (a reordering is a behaviour
 * change, not a cosmetic one), so they are spelled out rather than derived
 * from the module under test.
 */
import assert from 'node:assert/strict'

import { buildLaunchArgs, parseDevToolsActivePort } from '../src/headless-launch.js'

const PROFILE = '/tmp/dsh-headless-profile'

const HEADLESS_ARGS = [
  '--headless=new',
  '--no-startup-window',
  '--remote-debugging-port=0',
  `--user-data-dir=${PROFILE}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-sync',
  '--disable-extensions',
  '--mute-audio',
  '--window-size=1440,900',
  'about:blank',
]

const VISIBLE_ARGS = [
  '--new-window',
  '--remote-debugging-port=0',
  `--user-data-dir=${PROFILE}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-sync',
  '--disable-extensions',
  '--mute-audio',
  '--window-size=1440,900',
  'about:blank',
]

// Headless: compositor-only flags, no startup window, about:blank last.
assert.deepEqual(buildLaunchArgs({ profileDir: PROFILE }), HEADLESS_ARGS)
assert.deepEqual(buildLaunchArgs({ visible: false, profileDir: PROFILE }), HEADLESS_ARGS)

// Visible: a real headed window keeps its startup window.
assert.deepEqual(buildLaunchArgs({ visible: true, profileDir: PROFILE }), VISIBLE_ARGS)

// windowSize is per-axis: a missing axis falls back to the default.
assert.deepEqual(
  buildLaunchArgs({ profileDir: PROFILE, windowSize: { width: 800, height: 600 } }),
  HEADLESS_ARGS.map((arg) => (arg === '--window-size=1440,900' ? '--window-size=800,600' : arg)),
)
assert.deepEqual(
  buildLaunchArgs({ profileDir: PROFILE, windowSize: { width: 800 } }),
  HEADLESS_ARGS.map((arg) => (arg === '--window-size=1440,900' ? '--window-size=800,900' : arg)),
)
assert.deepEqual(
  buildLaunchArgs({ visible: true, profileDir: PROFILE, windowSize: null }),
  VISIBLE_ARGS,
)

// Extra flags (DSH_HEADLESS_CHROME_ARGS) are inserted before about:blank.
assert.deepEqual(buildLaunchArgs({ profileDir: PROFILE, extraArgs: ['--use-gl=angle', '--foo'] }), [
  ...HEADLESS_ARGS.slice(0, -1),
  '--use-gl=angle',
  '--foo',
  'about:blank',
])
assert.deepEqual(buildLaunchArgs({ profileDir: PROFILE, extraArgs: [] }), HEADLESS_ARGS)

// DevToolsActivePort: port on line 1, websocket path on line 2.
assert.equal(parseDevToolsActivePort(null), null)
assert.equal(parseDevToolsActivePort(undefined), null)
assert.equal(parseDevToolsActivePort(''), null)
assert.equal(parseDevToolsActivePort('   '), null)
assert.equal(parseDevToolsActivePort('9222'), null, 'a port without a websocket path is not usable yet')
assert.deepEqual(parseDevToolsActivePort('9222\n/devtools/browser/abc-123'), {
  port: '9222',
  wsPath: '/devtools/browser/abc-123',
  url: 'ws://127.0.0.1:9222/devtools/browser/abc-123',
})
assert.equal(
  parseDevToolsActivePort('\n9222\n/devtools/browser/abc-123\n').url,
  'ws://127.0.0.1:9222/devtools/browser/abc-123',
  'surrounding blank lines are ignored',
)

console.log('HEADLESS LAUNCH TEST: PASS')
