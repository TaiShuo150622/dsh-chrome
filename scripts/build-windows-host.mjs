#!/usr/bin/env node
/**
 * Build the Windows native-messaging host as a single `dsh-chrome-host.exe`
 * with Node's single-executable-application (SEA) support.
 *
 * Why an SEA:
 *   - Chrome on Windows launches the manifest `path` with CreateProcess, so it
 *     must be a real `.exe` — the `.cmd` scaffold can never work in production;
 *   - the exe carries its own Node runtime and the embedded `host/host.mjs`, so
 *     users do not install Node and the host has no sibling runtime files;
 *   - the same host source as macOS/Linux is shipped (no second implementation).
 *
 * SEA detail: the injected main script must be CommonJS (Node 22/24), while
 * `host/host.mjs` is an ES module with only `node:` imports. Instead of
 * rewriting it, the main is a tiny CJS bootstrap that reads the host source
 * from a SEA *asset* and evaluates it through a `data:` URL dynamic import.
 * `useCodeCache` must stay false: `import()` is incompatible with the V8 code
 * cache. See docs/WINDOWS-HOST.md for the full rationale and failure modes.
 *
 * Usage:
 *   node scripts/build-windows-host.mjs [options]
 *
 * Exit codes: 0 ok (or dry-run printed), 1 build failed, 2 usage/platform.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

import { WINDOWS_HOST_EXE_NAME } from '../src/install.js'

export const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
export const SEA_ASSET_KEY = 'host.mjs'
export const POSTJECT_VERSION = '1.0.0-alpha.6'
export const MACHO_SEGMENT = 'NODE_SEA'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Contract with src/install.js: release layout is host/bin/win32-<arch>/. */
export function defaultOutputPath(root = repoRoot, arch = process.arch) {
  return path.join(root, 'host', 'bin', `win32-${arch}`, WINDOWS_HOST_EXE_NAME)
}

export class WindowsHostBuildError extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.name = 'WindowsHostBuildError'
    this.exitCode = exitCode
  }
}

function usageError(message) {
  return new WindowsHostBuildError(message, 2)
}

export function helpText() {
  return `Build dsh-chrome-host.exe for Windows with Node SEA.

Usage:
  node scripts/build-windows-host.mjs [options]

Options:
  --out <file>            output exe (default: host/bin/win32-<arch>/${WINDOWS_HOST_EXE_NAME})
  --node <file>           Node executable used as the SEA base (default: current node)
  --host <file>           host.mjs to embed (default: host/host.mjs)
  --workdir <dir>         scratch dir for sea-entry/sea-config/blob
                          (default: a temp dir; removed on success)
  --postject <file>       postject CLI (default: node_modules/postject/dist/cli.js)
  --arch <arch>           arch in the default output path (default: ${process.arch})
  --dry-run               validate inputs and print the plan; write nothing
  --allow-foreign         allow a non-Windows build for a local SEA smoke test
                          (never ship that binary)
  --no-smoke              do not run the built exe with stdin closed
  --keep-workdir          keep the scratch dir (sea-config, blob) for debugging
  --json                  print one JSON object (dry-run plan / build result)
  --verbose               print child-process output
  --help                  show this help

Windows prerequisites:
  npm install --no-save --no-package-lock postject@${POSTJECT_VERSION}

Examples:
  node scripts/build-windows-host.mjs
  node scripts/build-windows-host.mjs --dry-run
  node scripts/build-windows-host.mjs --out dist/windows-host/host.exe --arch x64
`
}

export function parseCliArgs(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      out: { type: 'string' },
      node: { type: 'string' },
      host: { type: 'string' },
      workdir: { type: 'string' },
      postject: { type: 'string' },
      arch: { type: 'string' },
      'dry-run': { type: 'boolean' },
      'allow-foreign': { type: 'boolean' },
      'no-smoke': { type: 'boolean' },
      'keep-workdir': { type: 'boolean' },
      json: { type: 'boolean' },
      verbose: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  })
  return values
}

/**
 * Turn parsed arguments into absolute, validated-enough options. File
 * existence is checked by `prepareBuild()` so `--help` and bad usage never
 * touch the filesystem.
 */
export function resolveOptions({
  argv = process.argv.slice(2),
  root = repoRoot,
  platform = process.platform,
  arch = process.arch,
  cwd = process.cwd(),
} = {}) {
  let values
  try {
    values = parseCliArgs(argv)
  } catch (error) {
    throw usageError(error?.message || String(error))
  }
  if (values.help) return { help: true }

  if (values.arch != null && !/^[A-Za-z0-9_-]+$/.test(values.arch)) {
    throw usageError(`invalid --arch: ${values.arch}`)
  }
  const resolvedArch = values.arch || arch
  const resolveFromCwd = (value) => path.resolve(cwd, value)

  if (values['allow-foreign'] && !values.out) {
    throw usageError(
      '--allow-foreign requires an explicit --out; never write a host-platform binary into the release path',
    )
  }

  const options = {
    help: false,
    root,
    platform,
    arch: resolvedArch,
    host: values.host ? resolveFromCwd(values.host) : path.join(root, 'host', 'host.mjs'),
    node: values.node ? resolveFromCwd(values.node) : process.execPath,
    out: values.out ? resolveFromCwd(values.out) : defaultOutputPath(root, resolvedArch),
    workdir: values.workdir
      ? resolveFromCwd(values.workdir)
      : path.join(os.tmpdir(), `dsh-windows-host-${process.pid}`),
    postject: values.postject
      ? resolveFromCwd(values.postject)
      : path.join(root, 'node_modules', 'postject', 'dist', 'cli.js'),
    dryRun: Boolean(values['dry-run']),
    allowForeign: Boolean(values['allow-foreign']),
    smoke: !values['no-smoke'],
    keepWorkdir: Boolean(values['keep-workdir']),
    json: Boolean(values.json),
    verbose: Boolean(values.verbose),
  }

  if (path.resolve(options.out) === path.resolve(options.node)) {
    throw usageError('--out must not be the same file as --node')
  }
  return options
}

/**
 * CJS bootstrap injected as the SEA main. It reads the embedded host source and
 * starts it as an ES module. Kept as a constant generator so tests can assert
 * the SEA contract without a Windows machine.
 */
export function makeSeaEntry() {
  const lines = [
    "'use strict'",
    '// Generated by scripts/build-windows-host.mjs — do not edit.',
    '// The SEA main must be CommonJS; host/host.mjs stays ESM and is embedded',
    '// as the "host.mjs" asset, then evaluated through a data: URL import.',
    "const { getAsset } = require('node:sea')",
    'let source',
    'try {',
    `  source = getAsset(${JSON.stringify(SEA_ASSET_KEY)}, 'utf8')`,
    '} catch (error) {',
    '  process.stderr.write(`dsh-chrome-host: embedded host.mjs asset is missing: ${error?.message || error}\\n`)',
    '  process.exit(1)',
    '}',
    "const dataUrl = 'data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64')",
    'import(dataUrl).catch((error) => {',
    '  process.stderr.write(`dsh-chrome-host: failed to start embedded host: ${error?.stack || error}\\n`)',
    '  process.exit(1)',
    '})',
    '',
  ]
  return lines.join('\n')
}

/** SEA preparation config for `node --experimental-sea-config`. */
export function buildSeaConfig({ entryPath, blobPath, hostPath }) {
  if (!entryPath || !blobPath || !hostPath) {
    throw new Error('buildSeaConfig requires { entryPath, blobPath, hostPath }')
  }
  return {
    main: path.resolve(entryPath),
    output: path.resolve(blobPath),
    disableExperimentalSEAWarning: true,
    // `import()` does not work when useCodeCache is true (Node docs).
    useCodeCache: false,
    useSnapshot: false,
    assets: { [SEA_ASSET_KEY]: path.resolve(hostPath) },
  }
}

/** Detect the base binary format from its first bytes. */
export function detectBinaryFormat(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(4)
    const read = fs.readSync(fd, buf, 0, 4, 0)
    if (read < 2) return 'unknown'
    if (buf[0] === 0x4d && buf[1] === 0x5a) return 'pe' // MZ
    if (read >= 4) {
      const be = buf.readUInt32BE(0)
      if ([0xfeedface, 0xfeedfacf, 0xcafebabe, 0xcefaedfe, 0xcffaedfe, 0xbebafeca].includes(be)) {
        return 'macho'
      }
      if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) return 'elf'
    }
    return 'unknown'
  } finally {
    if (fd != null) fs.closeSync(fd)
  }
}

export function postjectArgs({ cli, out, blob, format }) {
  const args = [cli, out, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', SEA_FUSE]
  if (format === 'macho') args.push('--macho-segment-name', MACHO_SEGMENT)
  return args
}

function nativeFormat(platform = process.platform) {
  if (platform === 'win32') return 'pe'
  if (platform === 'darwin') return 'macho'
  if (platform === 'linux') return 'elf'
  return null
}

function nodeVersion(binary) {
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : 'unknown'
}

function checkHostSyntax(hostPath) {
  // Run the check on the *building* node, not the target binary: --dry-run may
  // point --node at an exe that this machine cannot execute.
  const result = spawnSync(process.execPath, ['--check', hostPath], { encoding: 'utf8' })
  if (result.error) {
    throw new WindowsHostBuildError(`cannot run node --check: ${result.error.message}`)
  }
  if (result.status !== 0) {
    throw new WindowsHostBuildError(
      `host.mjs failed node --check:\n${String(result.stderr || '').trim()}`,
    )
  }
}

/**
 * Validate inputs and compute every path/command. Read-only; used by both
 * --dry-run and the real build.
 */
export function prepareBuild(options) {
  if (!fs.existsSync(options.host) || !fs.statSync(options.host).isFile()) {
    throw usageError(`host source not found: ${options.host}`)
  }
  checkHostSyntax(options.host)

  if (!fs.existsSync(options.node) || !fs.statSync(options.node).isFile()) {
    throw usageError(`node binary not found: ${options.node}`)
  }
  const format = detectBinaryFormat(options.node)
  if (options.platform === 'win32' && format !== 'pe') {
    throw usageError(
      `--node is not a Windows PE executable (detected ${format}); pass a node.exe built for win32-${options.arch}`,
    )
  }
  if (format === 'unknown') {
    throw usageError(`cannot identify the binary format of --node: ${options.node}`)
  }
  const hostFormat = nativeFormat(process.platform)
  if (options.platform !== 'win32' && hostFormat && format !== hostFormat) {
    throw usageError(
      `--node is ${format}, but this ${process.platform} host can only execute ${hostFormat} binaries; cross-building a Windows exe on this host is not supported (use the windows-latest workflow).`,
    )
  }

  const entryPath = path.join(options.workdir, 'sea-entry.cjs')
  const configPath = path.join(options.workdir, 'sea-config.json')
  const blobPath = path.join(options.workdir, 'sea-prep.blob')
  const seaConfig = buildSeaConfig({ entryPath, blobPath, hostPath: options.host })
  const entrySource = makeSeaEntry()
  const postjectAvailable =
    fs.existsSync(options.postject) && fs.statSync(options.postject).isFile()
  const postject = postjectArgs({
    cli: options.postject,
    out: options.out,
    blob: blobPath,
    format,
  })

  return {
    options,
    format,
    nodeVersion: nodeVersion(options.node),
    entryPath,
    configPath,
    blobPath,
    entrySource,
    seaConfig,
    postjectAvailable,
    postject,
    commands: [
      `${process.execPath} --check ${options.host}`,
      `${options.node} --experimental-sea-config ${configPath}`,
      `copy ${options.node} -> ${options.out} (chmod 755)`,
      `${process.execPath} ${postject.join(' ')}`,
      `${options.out} with stdin closed (DSH_HOME=<temp>)`,
    ],
  }
}

function assertBuildAllowed(options) {
  if (options.platform === 'win32') return
  if (options.dryRun || options.allowForeign) return
  throw new WindowsHostBuildError(
    [
      'this script builds a Windows native host (dsh-chrome-host.exe).',
      'Run it on Windows (CI: windows-latest), or pass --dry-run to print the plan.',
      '--allow-foreign builds a SEA from the current platform\'s node for a local mechanism check; never ship that binary.',
    ].join('\n'),
    2,
  )
}

function printPlan(plan) {
  const { options, seaConfig } = plan
  console.log('Windows native host build plan (dry run)')
  console.log(`  host.mjs        : ${options.host}`)
  console.log(`  node (SEA base) : ${options.node} (${plan.nodeVersion}, ${plan.format})`)
  console.log(`  output          : ${options.out}`)
  console.log(`  workdir         : ${options.workdir}`)
  console.log(
    `  postject CLI    : ${options.postject}${plan.postjectAvailable ? '' : ' (missing — npm install --no-save --no-package-lock postject@' + POSTJECT_VERSION + ')'}`,
  )
  console.log(
    `  target          : win32-${options.arch}${options.platform === 'win32' ? '' : ' (layout only; --allow-foreign builds for this host)'}`,
  )
  console.log('  sea-config.json :')
  for (const line of JSON.stringify(seaConfig, null, 2).split('\n')) console.log(`    ${line}`)
  console.log('  steps:')
  plan.commands.forEach((command, index) => console.log(`    ${index + 1}. ${command}`))
  if (!options.smoke) console.log('  smoke           : disabled (--no-smoke)')
}

function runChecked(file, args, { quiet = false, label = file } = {}) {
  const result = spawnSync(file, args, {
    cwd: repoRoot,
    stdio: quiet ? 'pipe' : 'inherit',
    encoding: 'utf8',
  })
  if (result.error) {
    throw new WindowsHostBuildError(`${label} could not start: ${result.error.message}`)
  }
  if (result.status !== 0) {
    const output = quiet
      ? [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
      : ''
    throw new WindowsHostBuildError(
      `${label} failed (exit ${result.status})${output ? `:\n${output}` : ''}`,
    )
  }
  return result
}

function smokeTest(plan) {
  const { options } = plan
  const smokeHome = path.join(options.workdir, 'smoke-home')
  const env = { ...process.env, DSH_HOME: smokeHome }
  const result = spawnSync(options.out, [], {
    input: '',
    env,
    timeout: 30_000,
    encoding: 'utf8',
  })
  const logPath = path.join(smokeHome, 'cache', 'dsh-chrome', 'host.log')
  let log = ''
  try {
    log = fs.readFileSync(logPath, 'utf8')
  } catch {
    // reported below
  }
  if (result.error || result.status !== 0) {
    const detail = [
      result.error
        ? String(result.error.message)
        : `exit ${result.status}${result.signal ? ` (signal ${result.signal})` : ''}`,
      result.stdout ? `stdout:\n${result.stdout}` : '',
      result.stderr ? `stderr:\n${result.stderr}` : '',
      log ? `host.log:\n${log}` : `host.log missing: ${logPath}`,
    ]
      .filter(Boolean)
      .join('\n')
    throw new WindowsHostBuildError(
      `host.exe smoke test failed (${detail})\nscratch dir kept: ${options.workdir}`,
    )
  }
  if (!log.includes('host started')) {
    throw new WindowsHostBuildError(
      `host.exe ran but host.log has no "host started" line (${logPath})\nscratch dir kept: ${options.workdir}`,
    )
  }
  const firstLine = log.split('\n').find(Boolean) || ''
  return { ok: true, logPath, firstLine }
}

/**
 * Real build. Writes only `options.out` plus the scratch workdir; the smoke
 * run writes under `DSH_HOME` inside the workdir.
 */
export function buildHost(options) {
  assertBuildAllowed(options)
  const plan = prepareBuild(options)

  if (!plan.postjectAvailable) {
    throw new WindowsHostBuildError(
      [
        `postject CLI not found: ${options.postject}`,
        'Install the pinned injector first:',
        `  npm install --no-save --no-package-lock postject@${POSTJECT_VERSION}`,
        'or pass --postject <path/to/postject/dist/cli.js>.',
      ].join('\n'),
    )
  }

  fs.mkdirSync(options.workdir, { recursive: true })
  fs.mkdirSync(path.dirname(options.out), { recursive: true })
  fs.writeFileSync(plan.entryPath, plan.entrySource, { mode: 0o600 })
  fs.writeFileSync(plan.configPath, `${JSON.stringify(plan.seaConfig, null, 2)}\n`, { mode: 0o600 })

  runChecked(options.node, ['--experimental-sea-config', plan.configPath], {
    quiet: options.json && !options.verbose,
    label: 'node --experimental-sea-config',
  })
  if (!fs.existsSync(plan.blobPath)) {
    throw new WindowsHostBuildError(`SEA blob was not created: ${plan.blobPath}`)
  }

  fs.copyFileSync(options.node, options.out)
  fs.chmodSync(options.out, 0o755)

  // macOS-only local mechanism check (--allow-foreign): the ad-hoc signature of
  // the copied node binary must be removed before injection and re-applied
  // afterwards, or the kernel kills the modified binary on launch. Never runs
  // for the Windows target build.
  if (plan.format === 'macho') {
    spawnSync('codesign', ['--remove-signature', options.out], { stdio: 'ignore' })
  }

  runChecked(process.execPath, plan.postject, {
    quiet: options.json && !options.verbose,
    label: 'postject injection',
  })

  if (plan.format === 'macho') {
    runChecked('codesign', ['--sign', '-', options.out], {
      quiet: options.json && !options.verbose,
      label: 'codesign (local macOS check only)',
    })
  }

  const injected = fs.readFileSync(options.out)
  if (!injected.includes(Buffer.from(`${SEA_FUSE}:1`))) {
    throw new WindowsHostBuildError(
      'postject finished but the SEA fuse is not flipped; the executable would start as plain Node',
    )
  }

  const smoke = options.smoke ? smokeTest(plan) : { ok: false, skipped: true }
  const sha256 = createHash('sha256').update(injected).digest('hex')
  const summary = {
    ok: true,
    dryRun: false,
    platform: options.platform,
    arch: options.arch,
    out: options.out,
    bytes: injected.length,
    sha256,
    node: { path: options.node, version: plan.nodeVersion, format: plan.format },
    postject: { cli: options.postject, version: POSTJECT_VERSION },
    sea: { entry: plan.entryPath, config: plan.configPath, blob: plan.blobPath },
    smoke,
  }

  if (!options.keepWorkdir) fs.rmSync(options.workdir, { recursive: true, force: true })

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2))
  } else {
    console.log(`built ${options.out}`)
    console.log(`  size     : ${(summary.bytes / 1024 / 1024).toFixed(1)} MiB`)
    console.log(`  sha256   : ${sha256}`)
    console.log(`  base node: ${options.node} (${plan.nodeVersion})`)
    console.log(`  smoke    : ${summary.smoke.ok ? 'host started, stdin EOF exit 0' : 'skipped'}`)
    if (summary.smoke.firstLine) console.log(`  host.log : ${summary.smoke.firstLine}`)
    console.log('  note     : unsigned build; sign it before public distribution')
  }
  return summary
}

/** Dry-run: validate and print the plan, writing nothing. */
export function dryRun(options) {
  const plan = prepareBuild(options)
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          dryRun: true,
          platform: options.platform,
          arch: options.arch,
          host: options.host,
          node: { path: options.node, version: plan.nodeVersion, format: plan.format },
          out: options.out,
          workdir: options.workdir,
          postject: {
            cli: options.postject,
            version: POSTJECT_VERSION,
            available: plan.postjectAvailable,
          },
          sea: {
            entry: plan.entryPath,
            config: plan.configPath,
            blob: plan.blobPath,
            configJson: plan.seaConfig,
          },
          commands: plan.commands,
          smoke: options.smoke,
        },
        null,
        2,
      ),
    )
  } else {
    printPlan(plan)
  }
  return plan
}

function main() {
  const options = resolveOptions()
  if (options.help) {
    console.log(helpText())
    return
  }
  // A dry run is allowed anywhere; a real build is Windows-only unless the
  // caller explicitly opts into a local mechanism check.
  if (options.dryRun) dryRun(options)
  else buildHost(options)
}

const invokedDirectly =
  process.argv[1] != null &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url

if (invokedDirectly) {
  try {
    main()
  } catch (error) {
    const message = error?.message || String(error)
    console.error(`build-windows-host: ${message}`)
    process.exitCode = error?.exitCode ?? 1
  }
}
