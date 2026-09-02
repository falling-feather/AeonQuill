import assert from 'node:assert/strict'
import { mkdir, readFile, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { startIsolatedBridge } from './qa-runtime.mjs'

async function requestJson(bridge, pathname, options = {}, expected = 200) {
  const response = await bridge.request(pathname, {
    ...options,
    headers: options.body ? { 'content-type': 'application/json', ...options.headers } : options.headers,
  })
  const payload = await response.json()
  assert.equal(response.status, expected, `${options.method || 'GET'} ${pathname}: ${JSON.stringify(payload)}`)
  return payload
}

async function writeOld(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, value)
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1_000)
  await utimes(filePath, old, old)
}

async function waitForTerminal(bridge, jobId) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const { job } = await requestJson(bridge, `/api/jobs/${encodeURIComponent(jobId)}`)
    assert.equal(JSON.stringify(job).includes(bridge.runtimeDirectory), false)
    if (['completed', 'failed', 'cancelled'].includes(job.status) && job.scheduling?.finishedAt) return job
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
  throw new Error(`Storage cleanup did not finish: ${jobId}`)
}

const bridge = await startIsolatedBridge('storage-lifecycle')
let failure
try {
  const initial = await requestJson(bridge, '/api/storage/scan?runtime=0')
  assert.equal(initial.policy.preserveDeliveries, true)
  assert.equal(initial.safety.symlinksFollowed, false)
  assert.equal(initial.safety.deliveriesPreserved, true)
  assert.equal(initial.categories.length, 8)
  assert.equal(JSON.stringify(initial).includes(bridge.runtimeDirectory), false)

  const retentionDays = {
    terminalInputs: 1,
    intermediateOutputs: 1,
    previewCache: 1,
    comfyResiduals: 1,
    projectOrphans: 1,
  }
  const { policy } = await requestJson(bridge, '/api/storage/policy', {
    method: 'PUT',
    body: JSON.stringify({ baseRevision: initial.policy.revision, retentionDays, projectOverrides: {} }),
  })
  assert.equal(policy.revision, initial.policy.revision + 1)
  const conflict = await requestJson(bridge, '/api/storage/policy', {
    method: 'PUT',
    body: JSON.stringify({ baseRevision: initial.policy.revision, retentionDays }),
  }, 409)
  assert.equal(conflict.error.code, 'STORAGE_POLICY_CONFLICT')

  const previewPath = join(bridge.runtimeDirectory, 'cache', 'previews', 'api-old-preview.webp')
  const comfyPath = join(bridge.runtimeDirectory, 'comfyui', 'output', 'AEONQUILL', 'api-old-output.mp4')
  const externalPath = join(bridge.runtimeDirectory, 'comfyui', 'output', 'foreign-output.mp4')
  await Promise.all([
    writeOld(previewPath, 'preview'),
    writeOld(comfyPath, 'controlled'),
    writeOld(externalPath, 'must remain'),
  ])

  const scan = await requestJson(bridge, '/api/storage/scan?runtime=0')
  assert.equal(scan.totals.candidateFiles, 2)
  assert.deepEqual(new Set(scan.candidates.map(({ category }) => category)), new Set(['proxies', 'comfy-residuals']))
  assert.equal(JSON.stringify(scan).includes(bridge.runtimeDirectory), false)
  const acknowledgedBytes = scan.candidates.reduce((sum, candidate) => sum + candidate.bytes, 0)
  const mismatch = await requestJson(bridge, '/api/storage/cleanup', {
    method: 'POST',
    headers: { 'idempotency-key': 'storage-ack-mismatch' },
    body: JSON.stringify({
      scanId: scan.scanId,
      fingerprint: scan.fingerprint,
      candidateIds: scan.candidates.map(({ id }) => id),
      acknowledgedBytes: acknowledgedBytes + 1,
    }),
  }, 409)
  assert.equal(mismatch.error.code, 'STORAGE_CLEANUP_ACK_MISMATCH')

  const queued = await requestJson(bridge, '/api/storage/cleanup', {
    method: 'POST',
    headers: { 'idempotency-key': 'storage-cleanup-api-0001' },
    body: JSON.stringify({
      scanId: scan.scanId,
      fingerprint: scan.fingerprint,
      candidateIds: scan.candidates.map(({ id }) => id),
      acknowledgedBytes,
    }),
  }, 202)
  assert.equal(queued.job.kind, 'storage-cleanup')
  assert.equal(queued.job.request.candidateIds.length, 2)
  const completed = await waitForTerminal(bridge, queued.job.id)
  assert.equal(completed.status, 'completed')
  assert.equal(completed.storageCleanup.reclaimedBytes, acknowledgedBytes)
  assert.equal(completed.storageCleanup.failures.length, 0)
  assert.equal(completed.storageCleanup.verification.consistent, true)
  await assert.rejects(stat(previewPath), (error) => error.code === 'ENOENT')
  await assert.rejects(stat(comfyPath), (error) => error.code === 'ENOENT')
  assert.equal(await readFile(externalPath, 'utf8'), 'must remain')

  const stale = await requestJson(bridge, '/api/storage/cleanup', {
    method: 'POST',
    headers: { 'idempotency-key': 'storage-cleanup-api-stale' },
    body: JSON.stringify({
      scanId: scan.scanId,
      fingerprint: scan.fingerprint,
      candidateIds: scan.candidates.map(({ id }) => id),
      acknowledgedBytes,
    }),
  }, 409)
  assert.equal(stale.error.code, 'STORAGE_SCAN_EXPIRED')

  const verification = await requestJson(bridge, '/api/storage/scan?runtime=0')
  assert.equal(verification.totals.candidateFiles, 0)
  await unlink(externalPath)
  console.log('✓ Storage lifecycle API scanned, acknowledged, cleaned and rescanned without path disclosure')
} catch (error) {
  failure = error
} finally {
  await bridge.stop({ keepRuntime: Boolean(failure) }).catch(() => {})
}

if (failure) throw failure
