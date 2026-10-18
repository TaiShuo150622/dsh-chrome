/**
 * Windows native-host launcher tests — no Windows machine, no Chrome and no
 * network required. Everything here is static or runs on the current OS.
 *
 * Covers:
 *   1. .github/workflows/windows-host.yml exists and carries the required
 *      windows-latest / Node SEA / postject / artifact fields (YAML parsed when
 *      PyYAML is available, otherwise structural assertions only);
 *   2. scripts/build-windows-host.mjs: syntax, CLI parsing, dry-run plan, SEA
 *      entry/bootstrap contract, sea-config (assets + useCodeCache:false),
 *      postject args, and the output path contract with src/install.js;
 *   3. src/install.js Windows branch: manifest points at dsh-chrome-host.exe
 *      when a packaged exe is found; a locked running exe keeps the installed
 *      copy; .cmd fallback remains when no exe exists;
 *   4. macOS/Linux install output is unchanged (POSIX launcher + chmod);
 *   5. docs/WINDOWS-HOST.md documents build/manifest/registry/uninstall/limits.
 *
 * Optional Windows-only integration (after the CI build):
 *   node test/platform-windows-host.mjs --require-built
 * which verifies the built host.exe, runs a real Windows install with the real
 * filesystem, and smoke-starts the installed exe with stdin closed.
 *
 * Run with: node test/platform-windows-host.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  HOST_NAME,
  WINDOWS_HOST_EXE_NAME,
  ensureInstallAssets,
  windowsHostExeCandidates,
} from '../src/install.js'
import {
  POSTJECT_VERSION,
  SEA_FUSE,
  buildSeaConfig,
  defaultOutputPath,
  detectBinaryFormat,
  makeSeaEntry,
  parseCliArgs,
  postjectArgs,
  resolveOptions,
} from '../scripts/build-windows-host.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workflowPath = path.join(root, '.github', 'workflows', 'windows-host.yml')
const buildScriptPath = path.join(root, 'scripts', 'build-windows-host.mjs')
const docsPath = path.join(root, 'docs', 'WINDOWS-HOST.md')
const requireBuilt = process.argv.includes('--require-built')
const realExtensionManifest = JSON.parse(
  fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'),
)

let failures = 0

function check(name, fn) {
  try {
    const detail = fn()
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name} — ${error?.message || error}`)
  }
}

async function checkAsync(name, fn) {
  try {
    const detail = await fn()
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name} — ${error?.message || error}`)
  }
}

function memoryFs({ existing = [] } = {}) {
  const files = new Map()
  const calls = []
  return {
    files,
    calls,
    async mkdir(dir, options) {
      calls.push({ op: 'mkdir', dir, options })
    },
    async readFile(file) {
      calls.push({ op: 'readFile', file })
      return JSON.stringify(realExtensionManifest)
    },
    async copyFile(source, target) {
      calls.push({ op: 'copyFile', source, target })
      files.set(target, { source })
    },
    async writeFile(file, content, options) {
      calls.push({ op: 'writeFile', file, options })
      files.set(file, { content, options })
    },
    async chmod(file, mode) {
      calls.push({ op: 'chmod', file, mode })
    },
    async access(file) {
      calls.push({ op: 'access', file })
      if (existing.includes(file)) return
      const error = new Error(`ENOENT: no such file or directory, access '${file}'`)
      error.code = 'ENOENT'
      throw error
    },
  }
}

function parseYaml(file) {
  // PyYAML is not a project dependency; use it when the machine has it, and
  // fall back to the structural assertions below otherwise.
  const probe = spawnSync('python3', ['-c', 'import yaml'], { encoding: 'utf8' })
  if (probe.error || probe.status !== 0) return { parsed: false, reason: 'PyYAML unavailable' }
  const result = spawnSync(
    'python3',
    ['-c', 'import sys, yaml; yaml.safe_load(open(sys.argv[1], encoding="utf-8"))', file],
    { encoding: 'utf8' },
  )
  assert.equal(result.status, 0, `YAML parse failed: ${result.stderr}`)
  return { parsed: true }
}

// ---------------------------------------------------------------------------
// 1) CI workflow shape
// ---------------------------------------------------------------------------

const workflow = fs.existsSync(workflowPath) ? fs.readFileSync(workflowPath, 'utf8') : ''

check('windows-host workflow exists and is not empty', () => {
  assert.ok(workflow.length > 0, `${workflowPath} missing`)
  return `${workflow.split('\n').length} lines`
})

check('workflow runs on windows-latest with Node 22', () => {
  assert.match(workflow, /^on:/m)
  assert.match(workflow, /workflow_dispatch:/)
  assert.match(workflow, /pull_request:/)
  assert.match(workflow, /runs-on:\s*windows-latest/)
  assert.match(workflow, /node-version:\s*['"]?22['"]?/)
  return 'windows-latest / node 22'
})

check('workflow installs the pinned postject injector', () => {
  assert.ok(
    workflow.includes(`postject@${POSTJECT_VERSION}`),
    `expected postject@${POSTJECT_VERSION}`,
  )
  assert.match(workflow, /npm install[^\n]*--no-save/)
  return `postject@${POSTJECT_VERSION}`
})

check('workflow checks syntax, builds SEA and uploads the exe artifact', () => {
  assert.match(workflow, /node --check host\/host\.mjs/)
  assert.match(workflow, /node --check scripts\/build-windows-host\.mjs/)
  assert.ok(workflow.includes('node test/platform-windows-host.mjs'))
  assert.ok(workflow.includes('node scripts/build-windows-host.mjs --arch x64'))
  assert.ok(workflow.includes('node test/platform-windows-host.mjs --require-built'))
  assert.match(workflow, /actions\/upload-artifact@v4/)
  assert.match(workflow, /name:\s*dsh-chrome-host-windows-x64/)
  assert.ok(workflow.includes('host/bin/win32-x64/dsh-chrome-host.exe'))
  assert.match(workflow, /if-no-files-found:\s*error/)
  return 'build + artifact fields present'
})

check('workflow runs the static test before the build and the install test after', () => {
  const staticAt = workflow.indexOf('node test/platform-windows-host.mjs')
  const buildAt = workflow.indexOf('node scripts/build-windows-host.mjs')
  const builtAt = workflow.indexOf('node test/platform-windows-host.mjs --require-built')
  assert.ok(staticAt > -1 && buildAt > -1 && builtAt > -1)
  assert.ok(staticAt < buildAt, 'static test should run before the build')
  assert.ok(buildAt < builtAt, '--require-built should run after the build')
  return 'static -> build -> require-built'
})

check('workflow YAML parses (when PyYAML is available)', () => {
  assert.ok(workflow.length > 0)
  assert.ok(!workflow.includes('\t'), 'YAML must not contain tab indentation')
  const result = parseYaml(workflowPath)
  return result.parsed ? 'PyYAML ok' : `static only (${result.reason})`
})

// ---------------------------------------------------------------------------
// 2) build script contract
// ---------------------------------------------------------------------------

check('build script passes node --check', () => {
  const result = spawnSync(process.execPath, ['--check', buildScriptPath], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return 'node --check ok'
})

check('build script parses CLI options and rejects bad ones', () => {
  const values = parseCliArgs(['--dry-run', '--arch', 'x64', '--out', 'custom.exe'])
  assert.equal(values['dry-run'], true)
  assert.equal(values.arch, 'x64')
  assert.equal(values.out, 'custom.exe')
  assert.throws(() => parseCliArgs(['--not-an-option']), /Unknown option|not allowed/i)
  assert.throws(() => parseCliArgs(['--out']), /missing|Missing value|argument/i)
  return 'parseArgs strict'
})

check('default output path follows the host/bin/win32-<arch> release layout', () => {
  const out = defaultOutputPath(root, 'x64')
  assert.equal(out, path.join(root, 'host', 'bin', 'win32-x64', WINDOWS_HOST_EXE_NAME))
  const candidates = windowsHostExeCandidates({ root, arch: 'x64', env: {} })
  assert.ok(candidates.includes(out), 'install.js must search the build output path')
  assert.equal(
    windowsHostExeCandidates({ root, arch: 'x64', env: { DSH_CHROME_HOST_EXE: 'D:/x/host.exe' } })[0],
    'D:/x/host.exe',
  )
  return out
})

check('resolveOptions derives absolute defaults and honours --out', () => {
  const defaults = resolveOptions({ argv: ['--dry-run', '--arch', 'x64'], root, platform: 'darwin' })
  assert.equal(defaults.dryRun, true)
  assert.equal(defaults.arch, 'x64')
  assert.equal(defaults.host, path.join(root, 'host', 'host.mjs'))
  assert.equal(defaults.out, defaultOutputPath(root, 'x64'))
  assert.equal(defaults.node, process.execPath)
  const custom = resolveOptions({ argv: ['--out', 'build/host.exe'], root, cwd: root })
  assert.equal(custom.out, path.join(root, 'build', 'host.exe'))
  return 'defaults + override'
})

check('SEA entry is CommonJS, reads the host.mjs asset and imports it via data:', () => {
  const entry = makeSeaEntry()
  assert.match(entry, /require\('node:sea'\)/)
  assert.match(entry, /getAsset\("host\.mjs", 'utf8'\)/)
  assert.match(entry, /data:text\/javascript;base64,/)
  assert.match(entry, /Buffer\.from\(source, 'utf8'\)/)
  assert.match(entry, /process\.exit\(1\)/)
  const file = path.join(os.tmpdir(), `dsh-sea-entry-${process.pid}.cjs`)
  fs.writeFileSync(file, entry)
  try {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  } finally {
    fs.rmSync(file, { force: true })
  }
  return 'node --check ok'
})

check('sea-config embeds host.mjs and disables code cache (import() constraint)', () => {
  const config = buildSeaConfig({
    entryPath: '/tmp/entry.cjs',
    blobPath: '/tmp/sea.blob',
    hostPath: path.join(root, 'host', 'host.mjs'),
  })
  assert.equal(config.main, path.resolve('/tmp/entry.cjs'))
  assert.equal(config.output, path.resolve('/tmp/sea.blob'))
  assert.equal(config.disableExperimentalSEAWarning, true)
  assert.equal(config.useCodeCache, false)
  assert.equal(config.useSnapshot, false)
  assert.equal(config.assets['host.mjs'], path.join(root, 'host', 'host.mjs'))
  return 'CJS main + ESM asset'
})

check('postject args carry the SEA resource, fuse and Mach-O segment', () => {
  const pe = postjectArgs({ cli: '/x/postject.js', out: '/x/host.exe', blob: '/x/b.blob', format: 'pe' })
  assert.deepEqual(pe.slice(1, 4), ['/x/host.exe', 'NODE_SEA_BLOB', '/x/b.blob'])
  assert.ok(pe.includes('--sentinel-fuse'))
  assert.ok(pe.includes(SEA_FUSE))
  assert.ok(!pe.includes('NODE_SEA'))
  const macho = postjectArgs({
    cli: '/x/postject.js',
    out: '/x/host',
    blob: '/x/b.blob',
    format: 'macho',
  })
  assert.ok(macho.includes('--macho-segment-name'))
  assert.ok(macho.includes('NODE_SEA'))
  return 'PE / Mach-O'
})

check('the current node binary has the expected executable format', () => {
  const format = detectBinaryFormat(process.execPath)
  const expected =
    process.platform === 'win32' ? 'pe' : process.platform === 'darwin' ? 'macho' : 'elf'
  assert.equal(format, expected)
  return `${format} (${process.arch})`
})

check('dry-run --json validates inputs and prints the plan without writing', () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/build-windows-host.mjs', '--dry-run', '--json', '--arch', 'x64'],
    { cwd: root, encoding: 'utf8' },
  )
  assert.equal(result.status, 0, result.stderr)
  const plan = JSON.parse(result.stdout)
  assert.equal(plan.ok, true)
  assert.equal(plan.dryRun, true)
  assert.equal(plan.arch, 'x64')
  assert.equal(plan.out, defaultOutputPath(root, 'x64'))
  assert.equal(plan.sea.configJson.main, plan.sea.entry)
  assert.equal(plan.sea.configJson.useCodeCache, false)
  assert.equal(plan.sea.configJson.assets['host.mjs'], path.join(root, 'host', 'host.mjs'))
  assert.ok(plan.commands.some((command) => command.includes('--experimental-sea-config')))
  assert.ok(plan.commands.some((command) => command.includes('NODE_SEA_BLOB')))
  assert.ok(!fs.existsSync(plan.sea.entry), 'dry-run wrote the SEA entry')
  assert.ok(!fs.existsSync(plan.workdir), 'dry-run created the workdir')
  return 'no files written'
})

if (process.platform !== 'win32') {
  check('non-Windows real build fails with a clear dry-run/allow-foreign hint', () => {
    const result = spawnSync(process.execPath, ['scripts/build-windows-host.mjs'], {
      cwd: root,
      encoding: 'utf8',
    })
    assert.equal(result.status, 2)
    assert.match(result.stderr, /windows-latest/)
    assert.match(result.stderr, /--dry-run/)
    assert.match(result.stderr, /--allow-foreign/)
    return 'exit 2 + hint'
  })
} else {
  console.log('SKIP non-Windows build error — running on Windows')
}

// ---------------------------------------------------------------------------
// 3) src/install.js: Windows manifest -> exe
// ---------------------------------------------------------------------------

const winHome = 'C:/Users/Alice'
const winEnv = {
  USERPROFILE: winHome,
  LOCALAPPDATA: 'C:/Users/Alice/AppData/Local',
  PROGRAMFILES: 'C:/Program Files',
  'PROGRAMFILES(X86)': 'C:/Program Files (x86)',
}
const winOptions = { platform: 'win32', home: winHome, env: winEnv }

await checkAsync('Windows manifest points at host.exe when a packaged exe exists', async () => {
  const fakeExe = 'C:\\tools\\dsh-chrome-host.exe'
  const fsMock = memoryFs({ existing: [fakeExe] })
  const logs = []
  const info = await ensureInstallAssets({
    root,
    ...winOptions,
    env: { ...winEnv, DSH_CHROME_HOST_EXE: fakeExe },
    fs: fsMock,
    logger: { info: (...args) => logs.push(['info', ...args]), warn: (...args) => logs.push(['warn', ...args]) },
  })
  assert.equal(info.launcherKind, 'exe')
  assert.equal(info.hostExePath, info.launcherPath)
  assert.equal(path.basename(info.launcherPath), WINDOWS_HOST_EXE_NAME)
  const copy = fsMock.calls.find((call) => call.op === 'copyFile' && call.source === fakeExe)
  assert.ok(copy, 'host.exe was not copied')
  assert.equal(copy.target, info.launcherPath)
  assert.ok(
    !fsMock.calls.some((call) => call.op === 'copyFile' && String(call.source).endsWith('host.mjs')),
    'host.mjs should not be copied when the SEA exe embeds it',
  )
  assert.ok(!fsMock.calls.some((call) => call.op === 'writeFile' && String(call.file).endsWith('.cmd')))
  const manifest = JSON.parse(fsMock.files.get(info.nativeManifestPath).content)
  assert.equal(manifest.name, HOST_NAME)
  assert.equal(manifest.path, info.launcherPath)
  assert.equal(path.extname(manifest.path), '.exe')
  assert.equal(info.registration.value, info.nativeManifestPath)
  const instructions = fsMock.files.get(info.instructionsPath).content
  assert.match(instructions, /dsh-chrome-host\.exe/)
  assert.match(instructions, /exe/)
  return info.launcherPath
})

await checkAsync('Windows keeps the installed host.exe when a running copy is locked', async () => {
  const fakeExe = 'C:\\tools\\dsh-chrome-host.exe'
  const fsMock = memoryFs({ existing: [fakeExe] })
  fsMock.stat = async (file) => ({ size: file === fakeExe ? 200 : 100, isFile: () => true })
  fsMock.copyFile = async (source, target) => {
    fsMock.calls.push({ op: 'copyFile', source, target })
    const error = new Error('EPERM: operation not permitted')
    error.code = 'EPERM'
    throw error
  }
  const logs = []
  const info = await ensureInstallAssets({
    root,
    ...winOptions,
    env: { ...winEnv, DSH_CHROME_HOST_EXE: fakeExe },
    fs: fsMock,
    logger: { info: (...args) => logs.push(['info', ...args]), warn: (...args) => logs.push(['warn', ...args]) },
  })
  assert.equal(info.launcherKind, 'exe')
  assert.equal(path.basename(info.launcherPath), WINDOWS_HOST_EXE_NAME)
  assert.ok(
    logs.some(
      ([level, format]) =>
        level === 'warn' && String(format).includes('cannot replace the running Windows host.exe'),
    ),
    'locked exe warning not logged',
  )
  const manifest = JSON.parse(fsMock.files.get(info.nativeManifestPath).content)
  assert.equal(manifest.path, info.launcherPath)
  return 'kept installed exe'
})

await checkAsync('Windows falls back to .cmd and warns when host.exe is absent', async () => {
  const fsMock = memoryFs()
  const logs = []
  const info = await ensureInstallAssets({
    root,
    ...winOptions,
    fs: fsMock,
    logger: { info: (...args) => logs.push(['info', ...args]), warn: (...args) => logs.push(['warn', ...args]) },
  })
  assert.equal(info.launcherKind, 'cmd')
  assert.equal(info.hostExePath, null)
  assert.equal(path.basename(info.launcherPath), 'dsh-chrome-host.cmd')
  assert.ok(info.hostExeCandidates.length > 0)
  const manifest = JSON.parse(fsMock.files.get(info.nativeManifestPath).content)
  assert.equal(manifest.path, info.launcherPath)
  assert.match(manifest.path, /\.cmd$/)
  assert.ok(
    fsMock.calls.some((call) => call.op === 'copyFile' && String(call.source).endsWith('host.mjs')),
    'fallback needs the copied host.mjs',
  )
  assert.ok(
    logs.some(
      ([level, format]) => level === 'warn' && String(format).includes('host.exe not found'),
    ),
    'missing host.exe warning not logged',
  )
  const instructions = fsMock.files.get(info.instructionsPath).content
  assert.match(instructions, /\.cmd/)
  assert.match(instructions, /WINDOWS-HOST\.md/)
  return 'fallback + warning'
})

await checkAsync('macOS and Linux install output is unchanged (POSIX script + chmod)', async () => {
  const cases = [
    { platform: 'darwin', home: '/home/alice', dshHome: '/tmp/dsh-mac' },
    { platform: 'linux', home: '/home/alice', dshHome: '/tmp/dsh-linux' },
  ]
  for (const item of cases) {
    const fsMock = memoryFs()
    const info = await ensureInstallAssets({
      root,
      platform: item.platform,
      home: item.home,
      dshHome: item.dshHome,
      env: {},
      fs: fsMock,
    })
    assert.equal(info.launcherKind, 'script', `${item.platform}: launcherKind`)
    assert.equal(info.hostExePath, null)
    assert.deepEqual(info.hostExeCandidates, [])
    assert.equal(path.basename(info.launcherPath), 'dsh-chrome-host')
    assert.ok(
      fsMock.calls.some((call) => call.op === 'chmod' && call.mode === 0o755),
      `${item.platform}: launcher not chmodded`,
    )
    assert.ok(
      fsMock.calls.some((call) => call.op === 'copyFile' && String(call.source).endsWith('host.mjs')),
      `${item.platform}: host.mjs not copied`,
    )
    const manifest = JSON.parse(fsMock.files.get(info.nativeManifestPath).content)
    assert.equal(manifest.path, info.launcherPath)
  }
  return 'launcherKind=script'
})

// ---------------------------------------------------------------------------
// 4) docs
// ---------------------------------------------------------------------------

check('docs/WINDOWS-HOST.md documents build, manifest, registry, uninstall, limits', () => {
  assert.ok(fs.existsSync(docsPath), `${docsPath} missing`)
  const docs = fs.readFileSync(docsPath, 'utf8')
  for (const needle of [
    '--experimental-sea-config',
    'postject',
    'NODE_SEA_BLOB',
    'dsh-chrome-host.exe',
    'host/bin/win32-x64/dsh-chrome-host.exe',
    'DSH_CHROME_HOST_EXE',
    '--dry-run',
    '--allow-foreign',
    'useCodeCache',
    'reg add',
    'reg delete',
    'NativeMessagingHosts',
    '真机验证',
    '已知限制',
  ]) {
    assert.ok(docs.includes(needle), `missing "${needle}"`)
  }
  assert.ok(docs.includes(`HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`))
  return `${docs.split('\n').length} lines`
})

// ---------------------------------------------------------------------------
// 5) optional Windows-only integration with the built artifact
// ---------------------------------------------------------------------------

if (requireBuilt) {
  await checkAsync('built host.exe exists with the expected format', async () => {
    assert.equal(process.platform, 'win32', '--require-built is Windows-only')
    const built = defaultOutputPath(root, process.arch)
    assert.ok(fs.existsSync(built), `missing built artifact: ${built}`)
    const stat = fs.statSync(built)
    assert.ok(stat.size > 1_000_000, `suspiciously small host.exe: ${stat.size} bytes`)
    assert.equal(detectBinaryFormat(built), 'pe')
    return `${built} (${(stat.size / 1024 / 1024).toFixed(1)} MiB)`
  })

  await checkAsync('real Windows install writes an exe manifest and runs', async () => {
    const built = defaultOutputPath(root, process.arch)
    assert.ok(fs.existsSync(built), `missing built artifact: ${built}`)
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-win-host-'))
    try {
      const home = path.join(tmp, 'home')
      await fsp.mkdir(home, { recursive: true })
      const info = await ensureInstallAssets({
        root,
        platform: 'win32',
        home,
        dshHome: path.join(tmp, 'dsh'),
      })
      assert.equal(info.launcherKind, 'exe')
      assert.equal(path.basename(info.launcherPath), WINDOWS_HOST_EXE_NAME)
      assert.ok(fs.existsSync(info.launcherPath), 'installed host.exe missing')
      assert.ok(fs.statSync(info.launcherPath).size > 1_000_000)
      const manifest = JSON.parse(fs.readFileSync(info.nativeManifestPath, 'utf8'))
      assert.equal(manifest.name, HOST_NAME)
      assert.equal(manifest.path, info.launcherPath)
      assert.equal(path.extname(manifest.path), '.exe')
      assert.equal(info.registration.value, info.nativeManifestPath)

      const smokeHome = path.join(tmp, 'smoke')
      const result = spawnSync(info.launcherPath, [], {
        input: '',
        timeout: 30_000,
        env: { ...process.env, DSH_HOME: smokeHome },
        encoding: 'utf8',
      })
      assert.equal(
        result.status,
        0,
        `installed host.exe failed: ${result.signal || result.status}\n${result.stdout}\n${result.stderr}`,
      )
      const log = fs.readFileSync(path.join(smokeHome, 'cache', 'dsh-chrome', 'host.log'), 'utf8')
      assert.match(log, /host started/)
      return `${path.basename(info.launcherPath)} + manifest`
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true })
    }
  })
} else {
  console.log('SKIP built-artifact integration — pass --require-built on Windows CI')
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall windows-host checks passed')
}
