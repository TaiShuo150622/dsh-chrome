#!/usr/bin/env node
/**
 * Package the unpacked extension as a zip for testers / GitHub Releases.
 *
 * The zip keeps the directory layout required by "Load unpacked" (manifest.json
 * at the archive root). Usage: npm run package:extension
 */
import { execFileSync } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const extensionDir = path.join(root, 'extension')
const manifest = JSON.parse(await fsp.readFile(path.join(extensionDir, 'manifest.json'), 'utf8'))
const outDir = path.join(root, 'dist')
const target = path.join(outDir, `dsh-chrome-extension-${manifest.version}.zip`)

await fsp.mkdir(outDir, { recursive: true })
await fsp.rm(target, { force: true })

try {
  execFileSync('zip', ['-r', '-q', target, '.'], { cwd: extensionDir, stdio: 'inherit' })
} catch (error) {
  console.error('zip failed; make sure the `zip` CLI is available')
  process.exit(1)
}

const stat = await fsp.stat(target)
console.log(`packaged ${path.relative(root, target)} (${(stat.size / 1024).toFixed(1)} KiB, v${manifest.version})`)
