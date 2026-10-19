import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ArtifactStore } from '../src/artifact-store.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-artifact-store-'))
const store = new ArtifactStore({ root: path.join(root, 'artifacts'), retentionRuns: 2 })

try {
  // One run directory per run, outside any browser profile.
  const runA = await store.createArtifactRun('run-a')
  const runB = await store.createArtifactRun('run-b')
  const runC = await store.createArtifactRun('run-c')
  assert.equal(path.basename(runA), 'verify-run-a')
  assert.ok(fs.existsSync(runA))
  assert.equal(store.reportPath(runA, 'run-a'), path.join(runA, 'verify-run-a.json'))
  assert.equal(store.screenshotPath(runA, 'run-a'), path.join(runA, 'screenshot-run-a.png'))

  // Screenshots are copied into the run directory (survives context close).
  const source = path.join(root, 'source.png')
  fs.writeFileSync(source, 'screenshot-bytes')
  const target = await store.copyScreenshot({ path: source, bytes: 16 }, runA, 'run-a')
  assert.equal(target, store.screenshotPath(runA, 'run-a'))
  assert.equal(fs.readFileSync(target, 'utf8'), 'screenshot-bytes')

  fs.writeFileSync(path.join(runA, 'verify-run-a.json'), '{}')
  fs.writeFileSync(path.join(runB, 'verify-run-b.json'), '{}')
  fs.writeFileSync(path.join(runC, 'verify-run-c.json'), '{}')
  const epoch = Date.now() / 1000
  fs.utimesSync(runA, epoch - 30, epoch - 30)
  fs.utimesSync(runB, epoch - 20, epoch - 20)
  fs.utimesSync(runC, epoch - 10, epoch - 10)

  // Retention keeps the newest N runs by mtime.
  const pruned = store.pruneArtifacts(2)
  assert.deepEqual(pruned, ['verify-run-a'])
  assert.equal(fs.existsSync(runA), false, 'oldest artifact run should be pruned')
  assert.equal(fs.existsSync(runB), true)
  assert.equal(fs.existsSync(runC), true)
  assert.deepEqual(store.pruneArtifacts(2), [])

  // A missing root is not an error.
  const empty = new ArtifactStore({ root: path.join(root, 'missing'), retentionRuns: 5 })
  assert.deepEqual(empty.pruneArtifacts(), [])
  assert.throws(() => new ArtifactStore({}), /artifact root is required/)

  console.log('ARTIFACT STORE TEST: PASS')
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
