import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'
import test from 'node:test'

import {
  assertDiagnosticReportSafe,
  createDiagnosticReport,
  createZipArchive,
  DiagnosticBundleService,
  redactDiagnosticText,
} from '../server/diagnostic-bundle.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const testRoot = join(projectRoot, '.runtime', 'test-temp')
const baseTime = Date.UTC(2026, 8, 3, 1, 1, 1)

function reportId(index) {
  return `diag-2026090301010${index}-00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
}

function zipEntries(archive) {
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

function diagnosticReport(index = 1, overrides = {}) {
  return createDiagnosticReport({
    reportId: reportId(index),
    createdAt: baseTime + index * 1_000,
    runtimeDiagnostics: {
      schemaVersion: 1,
      checkedAt: baseTime,
      product: { name: '光阴砚 AEONQUILL', service: 'aeonquill-local-runtime', platform: 'win32', architecture: 'x64', node: '22.0.0' },
      identity: {
        version: 'aeonquill-build-identity-v1', productVersion: '0.7.1', functionalTrack: 'V0.7.55',
        sourceCommit: 'a'.repeat(40), sourceCommitShort: 'a'.repeat(8), runtimePackageId: 'runtime-v3',
        runtimeRegistryVersion: 'aeonquill-runtime-registry-v2', identityHash: 'b'.repeat(64),
      },
      registryMigration: null,
      storage: { scope: 'development', runtimeWritable: true, dataWritable: true, cacheWritable: true, logsWritable: true, configWritable: true, outputDirectoryWritable: true, projectsManaged: true, uninstallPreservesUserData: true, legacyDataLayout: false },
      configuration: { fileValid: true, rootConfigured: true, pythonConfigured: true, rootValid: true, pythonValid: true, outputDirectoryConfigured: false, outputDirectorySource: 'application', offlineRuntimePackageId: 'runtime-v3', launchPolicy: 'idle', idleSeconds: 300, restartRequired: false, legacyEnvironment: false },
      capabilities: { bridge: { status: 'ready' }, image: { status: 'ready', available: 1, total: 1, operations: [{ id: 'pixelate', provider: 'ffmpeg', available: true }] }, comfyui: { status: 'sleeping', configured: true, connected: false, ready: false, lifecycle: 'stopped', device: 'RTX 4060', vramTotal: 8 * 1024 ** 3, missingNodes: 0, missingModels: 0 }, semantic: { installed: 1, total: 4, ready: 1 } },
      logs: { managed: true, comfyLogAvailable: true },
      issues: [],
    },
    workflowCatalog: {
      version: 'aeonquill-workflow-center-v2', checkedAt: baseTime,
      storage: { configured: true, modelRoots: 2, sharedRoots: 1 },
      hardware: { device: 'RTX 4060', vramTotal: 8 * 1024 ** 3, vramGb: 8 },
      runtime: { connected: false, comfyVersion: null, pytorchVersion: null, lifecycle: { state: 'stopped' } },
      registry: { version: 'registry-v2', registryHash: 'c'.repeat(64), configured: true, runtimePackageId: 'runtime-v3', modelRoots: [{ source: 'configured' }], nodeRoots: [{ source: 'configured' }], sharedRoots: [{ source: 'shared-yaml' }], warnings: [] },
      packs: [{ id: 'h3-quality-int8', status: 'enabled-sleeping', enabled: true, installed: true, integrityVerified: true, ready: false, lifecycleState: 'stopped', missingArtifacts: [], unverifiedArtifacts: [], missingNodes: [], runtimeIssues: [], acceptedLicense: true, downloadBytes: 0, recommendation: { level: 'recommended' } }],
      customWorkflows: [{ id: 'private-title-must-not-appear', enabled: true }], jobs: [],
    },
    storageScan: {
      version: 'aeonquill-storage-lifecycle-v1', scannedAt: baseTime,
      policy: { schemaVersion: 1, revision: 2, retentionDays: { terminalInputs: 7 }, projectOverrides: { 'private-project': {} } },
      capacity: { totalBytes: 1000, freeBytes: 800, reserveBytes: 100, usableBytes: 700, status: 'healthy' },
      estimates: [{ id: 'video-quality-720p', requiredBytes: 12, available: true }],
      totals: { bytes: 10, files: 2, candidateBytes: 3, candidateFiles: 1 },
      references: { projectAssets: 1, jobAssets: 2, recoveryPoints: 3 },
      categories: [{ id: 'job-outputs', bytes: 10, files: 2, protectedFiles: 1, candidateBytes: 3, candidateFiles: 1, missingFiles: 0, scanErrors: 0, truncated: false }],
      safety: { modelsRequireRuntimeRemovalCheck: true, customOutputManualOnly: false, deliveriesPreserved: true, symlinksFollowed: false },
    },
    activeJobs: Array.from({ length: 25 }, (_, jobIndex) => ({
      id: `failed-${jobIndex}`, kind: 'video', tool: 'text-to-video', status: 'failed', phase: 'failed', progress: 20,
      createdAt: baseTime + jobIndex, updatedAt: baseTime + jobIndex,
      request: { prompt: `private-story-${jobIndex}`, inputPath: `D:\\Private\\shot-${jobIndex}.png`, apiKey: 'secret-in-request' },
      error: { code: 'REMOTE_FAILED', title: '生成失败', message: `token=very-secret-${jobIndex} D:\\Private\\shot.png https://service.example/path?key=hidden`, suggestions: ['检查后重试'] },
      logs: [
        ...Array.from({ length: 14 }, (_, logIndex) => ({ at: baseTime + logIndex, level: 'error', message: `安全阶段 ${logIndex}` })),
        { at: baseTime + 20, level: 'error', message: `prompt: private-story-${jobIndex}` },
      ],
      scheduling: { resourceClass: 'gpu', priority: 50, attempt: 1, maxAttempts: 3, timeoutMs: 60_000, finishedAt: baseTime + jobIndex },
    })),
    archivedJobs: [],
    archiveSummary: { schemaVersion: 1, revision: 2 },
    schedulerSnapshot: { resources: { gpu: { limit: 1, activeJobs: ['private-job'], queuedJobs: ['another-private-job'] } } },
    ...overrides,
  })
}

test('diagnostic text redaction removes local paths, credentials, URLs and creative text', () => {
  assert.equal(redactDiagnosticText('prompt: a private screenplay'), '[content omitted]')
  const safe = redactDiagnosticText('token=private-value C:\\Users\\person\\shot.png https://example.test/x?key=private')
  assert.doesNotMatch(safe, /private-value|C:\\Users|example\.test|key=private/u)
})

test('diagnostic report is allowlisted, bounded, and excludes creative/private fields', () => {
  const report = diagnosticReport()
  assert.equal(report.jobs.recentFailures.length, 20)
  assert.equal(report.jobs.recentFailures[0].logs.length, 12)
  assert.equal(report.jobs.recentFailures[0].logs.at(-1).message, '[content omitted]')
  assert.equal(report.workflows.customWorkflows.total, 1)
  assert.equal(report.storage.policy.projectOverrideCount, 1)
  assert.deepEqual(report.jobs.scheduler.resources.gpu, { limit: 1, active: 1, queued: 1 })
  const serialized = JSON.stringify(report)
  assert.doesNotMatch(serialized, /private-story|secret-in-request|very-secret|D:\\\\Private|service\.example|private-title|private-project/u)
  assert.doesNotMatch(serialized, /"(?:prompt|inputPath|apiKey)"\s*:/u)
  assert.doesNotThrow(() => assertDiagnosticReportSafe(report))
})

test('diagnostic report privacy gate rejects path and credential fields', () => {
  const pathLeak = structuredClone(diagnosticReport())
  pathLeak.collectionIssues.push({ section: 'test', code: 'LEAK', message: 'C:\\Users\\private\\file.png' })
  assert.throws(() => assertDiagnosticReportSafe(pathLeak), { code: 'DIAGNOSTIC_PATH_LEAK' })
  const credentialField = structuredClone(diagnosticReport())
  credentialField.token = 'private'
  assert.throws(() => assertDiagnosticReportSafe(credentialField), { code: 'DIAGNOSTIC_CREDENTIAL_FIELD' })
})

test('diagnostic ZIP contains only the requested readable entries', () => {
  const archive = createZipArchive([
    { name: 'diagnostic.json', content: '{"ok":true}\n' },
    { name: 'README.txt', content: 'safe' },
  ], baseTime)
  const entries = zipEntries(archive)
  assert.deepEqual([...entries.keys()], ['diagnostic.json', 'README.txt'])
  assert.equal(entries.get('diagnostic.json').toString('utf8'), '{"ok":true}\n')
  assert.throws(() => createZipArchive([{ name: '../private.txt', content: 'unsafe' }]), { code: 'DIAGNOSTIC_ZIP_ENTRY_INVALID' })
})

test('diagnostic bundle service enforces integrity, retention and maximum bundle count', async () => {
  await mkdir(testRoot, { recursive: true })
  const root = await mkdtemp(join(testRoot, 'diagnostic-bundle-'))
  let now = baseTime + 10_000
  const service = new DiagnosticBundleService({ rootDirectory: root, ttlMs: 60_000, maxBundles: 2, now: () => now })
  try {
    const abandoned = `.aeonquill-diagnostics-${reportId(9)}.zip.123.00000000-0000-4000-8000-000000000009.tmp`
    await writeFile(join(root, abandoned), 'incomplete', 'utf8')
    await service.open()
    assert.deepEqual(await readdir(root), [])
    const first = await service.create(diagnosticReport(1, { createdAt: now, reportId: reportId(1) }))
    now += 1_000
    const second = await service.create(diagnosticReport(2, { createdAt: now, reportId: reportId(2) }))
    now += 1_000
    const third = await service.create(diagnosticReport(3, { createdAt: now, reportId: reportId(3) }))
    await assert.rejects(() => service.read(first.id), { code: 'DIAGNOSTIC_BUNDLE_NOT_FOUND' })
    const opened = await service.read(third.id)
    assert.equal(createHash('sha256').update(opened.content).digest('hex'), third.sha256)
    const entries = zipEntries(opened.content)
    assert.deepEqual([...entries.keys()], ['diagnostic.json', 'README.txt', 'manifest.json'])
    const payload = JSON.parse(entries.get('diagnostic.json').toString('utf8'))
    assert.equal(payload.reportId, third.id)
    const manifest = JSON.parse(entries.get('manifest.json').toString('utf8'))
    assert.equal(manifest.files[0].sha256, createHash('sha256').update(entries.get('diagnostic.json')).digest('hex'))
    now = third.expiresAt + 1
    assert.equal(await service.cleanupExpired(), 2)
    await assert.rejects(() => service.read(third.id), { code: 'DIAGNOSTIC_BUNDLE_NOT_FOUND' })
  } finally {
    service.close()
    await rm(root, { recursive: true, force: true })
  }
})
