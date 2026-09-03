import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'

import { startIsolatedBridge } from './qa-runtime.mjs'

function readZipEntries(archive) {
  const entries = new Map()
  let offset = 0
  while (offset + 4 <= archive.length && archive.readUInt32LE(offset) === 0x04034b50) {
    const method = archive.readUInt16LE(offset + 8)
    const compressedBytes = archive.readUInt32LE(offset + 18)
    const expectedBytes = archive.readUInt32LE(offset + 22)
    const nameBytes = archive.readUInt16LE(offset + 26)
    const extraBytes = archive.readUInt16LE(offset + 28)
    const nameStart = offset + 30
    const contentStart = nameStart + nameBytes + extraBytes
    const name = archive.subarray(nameStart, nameStart + nameBytes).toString('utf8')
    const compressed = archive.subarray(contentStart, contentStart + compressedBytes)
    const content = method === 8 ? inflateRawSync(compressed) : Buffer.from(compressed)
    assert.equal(content.length, expectedBytes)
    entries.set(name, content)
    offset = contentStart + compressedBytes
  }
  return entries
}

async function requestJson(bridge, pathname, options = {}, expected = 200) {
  const response = await bridge.request(pathname, {
    ...options,
    headers: options.body ? { 'content-type': 'application/json', ...options.headers } : options.headers,
  })
  const payload = await response.json()
  assert.equal(response.status, expected, `${options.method || 'GET'} ${pathname}: ${JSON.stringify(payload)}`)
  return payload
}

const now = Date.now()
const privatePrompt = 'private-wuxia-script-must-not-leak'
const privateCredential = 'private-api-token-must-not-leak'
const privatePath = 'D:\\Private\\story\\hero.png'
const fixture = {
  id: 'diagnostic-failed-job',
  kind: 'video',
  tool: 'text-to-video',
  label: 'private-project-title-must-not-leak',
  status: 'failed',
  phase: 'failed',
  progress: 42,
  detail: privatePrompt,
  createdAt: now - 2_000,
  updatedAt: now - 1_000,
  request: { prompt: privatePrompt, inputPath: privatePath, apiKey: privateCredential },
  inputPath: privatePath,
  outputPath: 'D:\\Private\\story\\failed.mp4',
  error: {
    code: 'REMOTE_FAILED',
    title: '外部执行失败',
    message: `token=${privateCredential} ${privatePath} https://example.invalid/run?key=${privateCredential}`,
    suggestions: ['降低并发后重试'],
  },
  logs: [
    { at: now - 1_200, level: 'info', message: '进入采样阶段' },
    { at: now - 1_100, level: 'error', message: `prompt: ${privatePrompt}` },
  ],
  scheduling: {
    schemaVersion: 1,
    resourceClass: 'gpu',
    priority: 50,
    idempotencyKey: privateCredential,
    attempt: 1,
    maxAttempts: 3,
    timeoutMs: 120_000,
    queuedAt: now - 2_000,
    startedAt: now - 1_900,
    finishedAt: now - 1_000,
  },
}

const bridge = await startIsolatedBridge('diagnostic-bundle')
let failure
try {
  await writeFile(join(bridge.runtimeDirectory, 'jobs.json'), JSON.stringify([fixture], null, 2), 'utf8')
  await bridge.restart()

  const invalid = await requestJson(bridge, '/api/diagnostics/bundles', {
    method: 'POST',
    body: JSON.stringify({ includePrivateMedia: true }),
  }, 400)
  assert.equal(invalid.error.code, 'DIAGNOSTIC_REQUEST_INVALID')

  const health = await requestJson(bridge, '/api/health')
  const created = await requestJson(bridge, '/api/diagnostics/bundles', { method: 'POST', body: '{}' }, 201)
  const receipt = created.bundle
  assert.equal(receipt.version, 'aeonquill-diagnostic-bundle-v1')
  assert.equal(receipt.privacy.defaultRedaction, true)
  assert.equal(receipt.privacy.includesPrivateMedia, false)
  assert.match(receipt.downloadUrl, /^\/api\/diagnostics\/bundles\/diag-/u)
  assert.match(receipt.filename, /^aeonquill-diagnostics-diag-.*\.zip$/u)
  assert.ok(receipt.bytes > 0 && receipt.bytes < 512 * 1024)
  assert.doesNotMatch(JSON.stringify(created), /[A-Za-z]:\\\\|private-|example\.invalid/u)

  const response = await bridge.request(receipt.downloadUrl)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/zip')
  assert.match(response.headers.get('content-disposition') || '', /attachment; filename="aeonquill-diagnostics-/u)
  const archive = Buffer.from(await response.arrayBuffer())
  assert.equal(archive.length, receipt.bytes)
  assert.equal(createHash('sha256').update(archive).digest('hex'), receipt.sha256)
  assert.equal(response.headers.get('x-diagnostic-sha256'), receipt.sha256)

  const entries = readZipEntries(archive)
  assert.deepEqual([...entries.keys()], ['diagnostic.json', 'README.txt', 'manifest.json'])
  const report = JSON.parse(entries.get('diagnostic.json').toString('utf8'))
  assert.equal(report.schemaVersion, 'aeonquill-diagnostic-report-v1')
  assert.equal(report.runtime.identity.identityHash, health.identity.identityHash)
  assert.equal(report.jobs.recentFailures.length, 1)
  assert.equal(report.jobs.recentFailures[0].id, fixture.id)
  assert.equal(report.jobs.recentFailures[0].logs[1].message, '[content omitted]')
  assert.ok(report.storage.capacity.totalBytes > 0)
  assert.ok(report.workflows.packs.length >= 1)
  assert.equal(report.runtime.capabilities.comfyui.connected, false)
  const reportText = JSON.stringify(report)
  assert.doesNotMatch(reportText, new RegExp([privatePrompt, privateCredential, 'D:\\\\Private', 'example\\.invalid'].join('|'), 'u'))
  assert.doesNotMatch(reportText, /(?:[A-Za-z]:\\\\|"(?:prompt|apiKey|inputPath|outputPath|sourceUrl)"\s*:|data:(?:image|video|audio)\/)/iu)

  const manifest = JSON.parse(entries.get('manifest.json').toString('utf8'))
  assert.equal(manifest.schemaVersion, 'aeonquill-diagnostic-bundle-v1')
  assert.equal(manifest.reportId, receipt.id)
  for (const file of manifest.files) {
    assert.equal(file.sha256, createHash('sha256').update(entries.get(file.name)).digest('hex'))
    assert.equal(file.bytes, entries.get(file.name).length)
  }

  const missing = await requestJson(bridge, '/api/diagnostics/bundles/diag-20260903010101-00000000-0000-4000-8000-000000000000', {}, 404)
  assert.equal(missing.error.code, 'DIAGNOSTIC_BUNDLE_NOT_FOUND')

  await bridge.restart()
  const expiredAfterRestart = await requestJson(bridge, receipt.downloadUrl, {}, 404)
  assert.equal(expiredAfterRestart.error.code, 'DIAGNOSTIC_BUNDLE_NOT_FOUND')
} catch (error) {
  failure = error
  process.exitCode = 1
  console.error(error.stack || error.message)
} finally {
  const logs = bridge.logs()
  await bridge.stop({ keepRuntime: Boolean(failure) })
  if (failure) console.error(`QA runtime retained: ${bridge.runtimeDirectory}\n${logs.stdout}\n${logs.stderr}`)
}

if (!failure) console.log('✓ Diagnostic bundle API exports a bounded, downloadable and restart-ephemeral redacted ZIP')
