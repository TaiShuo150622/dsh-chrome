import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension/manifest.json'), 'utf8'))
const semver = /^(\d+)\.(\d+)\.(\d+)$/
const match = semver.exec(pkg.version)
assert.ok(match, `package.json version is not semver: ${pkg.version}`)
assert.equal(manifest.version, pkg.version, 'package.json and extension/manifest.json versions must match')
assert.ok(Number(match[3]) >= 0)
assert.ok(fs.existsSync(path.join(root, 'docs', 'VERSIONING.md')), 'versioning policy document is required')
console.log('VERSION CONSISTENCY TEST: PASS')
