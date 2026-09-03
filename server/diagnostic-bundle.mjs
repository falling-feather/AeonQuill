import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { deflateRawSync } from 'node:zlib'

import { redactSensitiveText } from './security.mjs'

export const DIAGNOSTIC_REPORT_VERSION = 'aeonquill-diagnostic-report-v1'
export const DIAGNOSTIC_BUNDLE_VERSION = 'aeonquill-diagnostic-bundle-v1'

const MAX_REPORT_BYTES = 512 * 1024
const MAX_FAILURES = 20
const MAX_JOB_LOGS = 12
const DEFAULT_TTL_MS = 15 * 60 * 1_000
const DEFAULT_MAX_BUNDLES = 5
const SAFE_REPORT_ID = /^diag-[0-9]{14}-[a-f0-9-]{36}$/u
const SAFE_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u
const MANAGED_BUNDLE_NAME = /^aeonquill-diagnostics-diag-[0-9]{14}-[a-f0-9-]{36}\.zip$/u
const MANAGED_BUNDLE_TEMP_NAME = /^\.aeonquill-diagnostics-diag-[0-9]{14}-[a-f0-9-]{36}\.zip\.[0-9]+\.[a-f0-9-]{36}\.tmp$/u
const CONTENT_BEARING_LOG = /(?:\b(?:prompt|negative[_ -]?prompt|dialogue|transcript|script|user[_ -]?text|input[_ -]?text)\b|提示词|负面词|剧本|台词|对白|用户输入|正文)\s*[:：=]/iu
const SECRET_VALUE = /\b(?:sk|key|token)-[A-Za-z0-9_-]{12,}\b/giu
const REMOTE_URL = /https?:\/\/[^\s"'<>]+/giu
const ENCODED_PAYLOAD = /\b[A-Za-z0-9+/=_-]{80,}\b/gu

function diagnosticError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status })
}

function safeInteger(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback
}

function safeNumber(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function safeId(value, fallback = null) {
  return typeof value === 'string' && SAFE_JOB_ID.test(value) ? value : fallback
}

export function redactDiagnosticText(value, maximumLength = 480) {
  let text = String(value ?? '')
    .replace(REMOTE_URL, '[url]')
    .replace(SECRET_VALUE, '[credential]')
  text = redactSensitiveText(text)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ')
    .replace(REMOTE_URL, '[url]')
    .replace(SECRET_VALUE, '[credential]')
    .replace(ENCODED_PAYLOAD, '[encoded-data]')
    .replace(/\s+/gu, ' ')
    .trim()
  if (CONTENT_BEARING_LOG.test(text)) text = '[content omitted]'
  return text.length > maximumLength ? `${text.slice(0, Math.max(0, maximumLength - 1))}…` : text
}

function safeIdentity(identity) {
  if (!identity || typeof identity !== 'object') return null
  return {
    version: redactDiagnosticText(identity.version || identity.buildIdentityVersion, 80) || null,
    productVersion: redactDiagnosticText(identity.productVersion, 40) || null,
    functionalTrack: redactDiagnosticText(identity.functionalTrack, 80) || null,
    sourceCommit: redactDiagnosticText(identity.sourceCommit, 80) || null,
    sourceCommitShort: redactDiagnosticText(identity.sourceCommitShort, 20) || null,
    runtimePackageId: redactDiagnosticText(identity.runtimePackageId, 160) || null,
    runtimeRegistryVersion: redactDiagnosticText(identity.runtimeRegistryVersion, 100) || null,
    identityHash: redactDiagnosticText(identity.identityHash, 80) || null,
  }
}

function safeIssue(issue) {
  return {
    code: redactDiagnosticText(issue?.code, 100) || 'UNKNOWN',
    severity: ['info', 'warning', 'error'].includes(issue?.severity) ? issue.severity : 'warning',
    message: redactDiagnosticText(issue?.message, 320),
    action: redactDiagnosticText(issue?.action, 320),
  }
}

function runtimeSummary(diagnostics) {
  if (!diagnostics) return null
  return {
    schemaVersion: safeInteger(diagnostics.schemaVersion),
    checkedAt: safeInteger(diagnostics.checkedAt),
    product: {
      name: redactDiagnosticText(diagnostics.product?.name, 80),
      service: redactDiagnosticText(diagnostics.product?.service, 80),
      platform: redactDiagnosticText(diagnostics.product?.platform, 40),
      architecture: redactDiagnosticText(diagnostics.product?.architecture, 40),
      node: redactDiagnosticText(diagnostics.product?.node, 40),
    },
    identity: safeIdentity(diagnostics.identity),
    registryMigration: diagnostics.registryMigration ? {
      version: redactDiagnosticText(diagnostics.registryMigration.version, 100) || null,
      status: redactDiagnosticText(diagnostics.registryMigration.status, 40),
      readyCount: safeInteger(diagnostics.registryMigration.readyCount),
      changeCount: safeInteger(diagnostics.registryMigration.changeCount),
      movesModelFiles: diagnostics.registryMigration.movesModelFiles === true,
      blockedRoots: safeInteger(diagnostics.registryMigration.removalGate?.blockedRoots),
    } : null,
    storage: {
      scope: redactDiagnosticText(diagnostics.storage?.scope, 40),
      runtimeWritable: Boolean(diagnostics.storage?.runtimeWritable),
      dataWritable: Boolean(diagnostics.storage?.dataWritable),
      cacheWritable: Boolean(diagnostics.storage?.cacheWritable),
      logsWritable: Boolean(diagnostics.storage?.logsWritable),
      configWritable: Boolean(diagnostics.storage?.configWritable),
      outputDirectoryWritable: diagnostics.storage?.outputDirectoryWritable === null
        ? null
        : Boolean(diagnostics.storage?.outputDirectoryWritable),
      projectsManaged: Boolean(diagnostics.storage?.projectsManaged),
      uninstallPreservesUserData: Boolean(diagnostics.storage?.uninstallPreservesUserData),
      legacyDataLayout: Boolean(diagnostics.storage?.legacyDataLayout),
    },
    configuration: {
      fileValid: Boolean(diagnostics.configuration?.fileValid),
      rootConfigured: Boolean(diagnostics.configuration?.rootConfigured),
      pythonConfigured: Boolean(diagnostics.configuration?.pythonConfigured),
      rootValid: Boolean(diagnostics.configuration?.rootValid),
      pythonValid: Boolean(diagnostics.configuration?.pythonValid),
      outputDirectoryConfigured: Boolean(diagnostics.configuration?.outputDirectoryConfigured),
      outputDirectorySource: diagnostics.configuration?.outputDirectorySource === 'custom' ? 'custom' : 'application',
      offlineRuntimePackageId: redactDiagnosticText(diagnostics.configuration?.offlineRuntimePackageId, 160) || null,
      launchPolicy: redactDiagnosticText(diagnostics.configuration?.launchPolicy, 40),
      idleSeconds: safeInteger(diagnostics.configuration?.idleSeconds),
      restartRequired: Boolean(diagnostics.configuration?.restartRequired),
      legacyEnvironment: Boolean(diagnostics.configuration?.legacyEnvironment),
    },
    capabilities: {
      bridge: { status: redactDiagnosticText(diagnostics.capabilities?.bridge?.status, 40) },
      image: {
        status: redactDiagnosticText(diagnostics.capabilities?.image?.status, 40),
        available: safeInteger(diagnostics.capabilities?.image?.available),
        total: safeInteger(diagnostics.capabilities?.image?.total),
        operations: (diagnostics.capabilities?.image?.operations || []).slice(0, 50).map((operation) => ({
          id: redactDiagnosticText(operation.id, 80),
          provider: redactDiagnosticText(operation.provider, 80),
          available: Boolean(operation.available),
          unavailableReason: operation.unavailableReason
            ? redactDiagnosticText(operation.unavailableReason, 240)
            : null,
        })),
      },
      comfyui: {
        status: redactDiagnosticText(diagnostics.capabilities?.comfyui?.status, 40),
        configured: Boolean(diagnostics.capabilities?.comfyui?.configured),
        connected: Boolean(diagnostics.capabilities?.comfyui?.connected),
        ready: Boolean(diagnostics.capabilities?.comfyui?.ready),
        lifecycle: redactDiagnosticText(diagnostics.capabilities?.comfyui?.lifecycle, 40),
        device: redactDiagnosticText(diagnostics.capabilities?.comfyui?.device, 120) || null,
        vramTotal: safeNumber(diagnostics.capabilities?.comfyui?.vramTotal),
        missingNodes: safeInteger(diagnostics.capabilities?.comfyui?.missingNodes),
        missingModels: safeInteger(diagnostics.capabilities?.comfyui?.missingModels),
      },
      semantic: {
        installed: safeInteger(diagnostics.capabilities?.semantic?.installed),
        total: safeInteger(diagnostics.capabilities?.semantic?.total),
        ready: safeInteger(diagnostics.capabilities?.semantic?.ready),
      },
    },
    logs: {
      managed: Boolean(diagnostics.logs?.managed),
      comfyLogAvailable: Boolean(diagnostics.logs?.comfyLogAvailable),
    },
    issues: (diagnostics.issues || []).slice(0, 50).map(safeIssue),
  }
}

function countBy(values, selector) {
  const counts = {}
  for (const value of values || []) {
    const key = redactDiagnosticText(selector(value), 80) || 'unknown'
    counts[key] = (counts[key] || 0) + 1
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)))
}

function workflowSummary(catalog) {
  if (!catalog) return null
  const registryRoots = [
    ...(catalog.registry?.modelRoots || []),
    ...(catalog.registry?.nodeRoots || []),
    ...(catalog.registry?.sharedRoots || []),
  ]
  return {
    version: redactDiagnosticText(catalog.version, 100),
    checkedAt: safeInteger(catalog.checkedAt),
    storage: {
      configured: Boolean(catalog.storage?.configured),
      modelRoots: safeInteger(catalog.storage?.modelRoots),
      sharedRoots: safeInteger(catalog.storage?.sharedRoots),
    },
    hardware: {
      device: redactDiagnosticText(catalog.hardware?.device, 120) || null,
      vramTotal: safeNumber(catalog.hardware?.vramTotal),
      vramGb: safeNumber(catalog.hardware?.vramGb),
    },
    runtime: {
      connected: Boolean(catalog.runtime?.connected),
      comfyVersion: redactDiagnosticText(catalog.runtime?.comfyVersion, 60) || null,
      pytorchVersion: redactDiagnosticText(catalog.runtime?.pytorchVersion, 60) || null,
      lifecycleState: redactDiagnosticText(catalog.runtime?.lifecycle?.state, 40) || null,
    },
    registry: {
      version: redactDiagnosticText(catalog.registry?.version, 100) || null,
      registryHash: redactDiagnosticText(catalog.registry?.registryHash, 80) || null,
      configured: Boolean(catalog.registry?.configured),
      runtimePackageId: redactDiagnosticText(catalog.registry?.runtimePackageId, 160) || null,
      modelRoots: (catalog.registry?.modelRoots || []).length,
      nodeRoots: (catalog.registry?.nodeRoots || []).length,
      sharedRoots: (catalog.registry?.sharedRoots || []).length,
      rootSources: countBy(registryRoots, (root) => root.source || root.category || 'unknown'),
      warnings: countBy(catalog.registry?.warnings || [], (warning) => warning.code || warning.kind || 'warning'),
    },
    packs: (catalog.packs || []).slice(0, 100).map((pack) => ({
      id: redactDiagnosticText(pack.id, 120),
      status: redactDiagnosticText(pack.status, 60),
      enabled: Boolean(pack.enabled),
      installed: Boolean(pack.installed),
      integrityVerified: Boolean(pack.integrityVerified),
      ready: Boolean(pack.ready),
      lifecycleState: redactDiagnosticText(pack.lifecycleState, 40),
      missingArtifacts: (pack.missingArtifacts || []).slice(0, 100).map((id) => redactDiagnosticText(id, 120)),
      unverifiedArtifacts: (pack.unverifiedArtifacts || []).slice(0, 100).map((id) => redactDiagnosticText(id, 120)),
      missingNodes: (pack.missingNodes || []).slice(0, 100).map((id) => redactDiagnosticText(id, 120)),
      runtimeIssues: (pack.runtimeIssues || []).slice(0, 20).map((issue) => redactDiagnosticText(issue, 240)),
      acceptedLicense: Boolean(pack.acceptedLicense),
      downloadBytes: safeNumber(pack.downloadBytes),
      recommendation: redactDiagnosticText(pack.recommendation?.level, 40) || null,
    })),
    customWorkflows: {
      total: (catalog.customWorkflows || []).length,
      enabled: (catalog.customWorkflows || []).filter((workflow) => workflow.enabled).length,
    },
    installationJobs: (catalog.jobs || []).slice(0, 20).map((job) => ({
      id: safeId(job.id, '[invalid-id]'),
      packId: redactDiagnosticText(job.packId, 120),
      status: redactDiagnosticText(job.status, 40),
      phase: redactDiagnosticText(job.phase, 60),
      progress: Math.max(0, Math.min(100, safeNumber(job.progress))),
      createdAt: safeInteger(job.createdAt),
      updatedAt: safeInteger(job.updatedAt),
      errorCode: redactDiagnosticText(job.error?.code, 100) || null,
    })),
  }
}

function storageSummary(scan) {
  if (!scan) return null
  return {
    version: redactDiagnosticText(scan.version, 100),
    scannedAt: safeInteger(scan.scannedAt),
    policy: {
      schemaVersion: safeInteger(scan.policy?.schemaVersion),
      revision: safeInteger(scan.policy?.revision),
      retentionDays: Object.fromEntries(Object.entries(scan.policy?.retentionDays || {})
        .slice(0, 50)
        .map(([key, value]) => [redactDiagnosticText(key, 80), safeInteger(value)])),
      projectOverrideCount: Object.keys(scan.policy?.projectOverrides || {}).length,
    },
    policyIssue: scan.policyIssue ? {
      code: redactDiagnosticText(scan.policyIssue.code, 100),
      message: redactDiagnosticText(scan.policyIssue.message, 320),
    } : null,
    capacity: {
      totalBytes: safeNumber(scan.capacity?.totalBytes),
      freeBytes: safeNumber(scan.capacity?.freeBytes),
      reserveBytes: safeNumber(scan.capacity?.reserveBytes),
      usableBytes: safeNumber(scan.capacity?.usableBytes),
      status: redactDiagnosticText(scan.capacity?.status, 40),
    },
    estimates: (scan.estimates || []).slice(0, 20).map((estimate) => ({
      id: redactDiagnosticText(estimate.id, 80),
      requiredBytes: safeNumber(estimate.requiredBytes),
      available: Boolean(estimate.available),
    })),
    totals: {
      bytes: safeNumber(scan.totals?.bytes),
      files: safeInteger(scan.totals?.files),
      candidateBytes: safeNumber(scan.totals?.candidateBytes),
      candidateFiles: safeInteger(scan.totals?.candidateFiles),
    },
    references: {
      projectAssets: safeInteger(scan.references?.projectAssets),
      jobAssets: safeInteger(scan.references?.jobAssets),
      recoveryPoints: safeInteger(scan.references?.recoveryPoints),
    },
    categories: (scan.categories || []).slice(0, 50).map((category) => ({
      id: redactDiagnosticText(category.id, 80),
      bytes: safeNumber(category.bytes),
      files: safeInteger(category.files),
      protectedFiles: safeInteger(category.protectedFiles),
      candidateBytes: safeNumber(category.candidateBytes),
      candidateFiles: safeInteger(category.candidateFiles),
      missingFiles: safeInteger(category.missingFiles),
      scanErrors: safeInteger(category.scanErrors),
      truncated: Boolean(category.truncated),
    })),
    safety: {
      modelsRequireRuntimeRemovalCheck: scan.safety?.modelsRequireRuntimeRemovalCheck === true,
      customOutputManualOnly: Boolean(scan.safety?.customOutputManualOnly),
      deliveriesPreserved: scan.safety?.deliveriesPreserved === true,
      symlinksFollowed: scan.safety?.symlinksFollowed === true,
    },
  }
}

function jobTimestamp(job) {
  return safeInteger(job?.scheduling?.finishedAt || job?.completedAt || job?.updatedAt || job?.createdAt)
}

function safeFailureJob(job, location) {
  const scheduling = job.scheduling || {}
  const outputVersion = job.outputVersion || {}
  return {
    id: safeId(job.id, '[invalid-id]'),
    location,
    kind: redactDiagnosticText(job.kind, 80),
    tool: redactDiagnosticText(job.tool, 100),
    status: 'failed',
    phase: redactDiagnosticText(job.phase, 80),
    progress: Math.max(0, Math.min(100, safeNumber(job.progress))),
    createdAt: safeInteger(job.createdAt),
    updatedAt: safeInteger(job.updatedAt),
    finishedAt: safeInteger(scheduling.finishedAt || job.completedAt),
    retryOf: safeId(job.retryOf),
    workflowVersion: redactDiagnosticText(job.workflowVersion, 100) || null,
    executionIdentity: safeIdentity(job.executionIdentity),
    scheduling: {
      resourceClass: redactDiagnosticText(scheduling.resourceClass, 40),
      priority: safeInteger(scheduling.priority),
      attempt: safeInteger(scheduling.attempt),
      maxAttempts: safeInteger(scheduling.maxAttempts),
      timeoutMs: safeInteger(scheduling.timeoutMs),
      queuedAt: safeInteger(scheduling.queuedAt),
      startedAt: safeInteger(scheduling.startedAt),
      finishedAt: safeInteger(scheduling.finishedAt),
    },
    error: job.error ? {
      code: redactDiagnosticText(job.error.code, 100) || 'UNKNOWN',
      title: redactDiagnosticText(job.error.title, 180),
      message: redactDiagnosticText(job.error.message, 480),
      suggestions: (job.error.suggestions || []).slice(0, 8).map((suggestion) => redactDiagnosticText(suggestion, 240)),
    } : null,
    logs: (job.logs || []).slice(-MAX_JOB_LOGS).map((log) => ({
      at: safeInteger(log.at),
      level: redactDiagnosticText(log.level, 40),
      message: redactDiagnosticText(log.message, 320),
    })),
    archive: job.archiveMetadata ? {
      archivedAt: safeInteger(job.archiveMetadata.archivedAt),
      reason: redactDiagnosticText(job.archiveMetadata.reason, 40),
    } : null,
    outputEvidence: {
      available: Boolean(job.output || job.outputVersion),
      sha256: /^[a-f0-9]{64}$/u.test(outputVersion.sha256 || '') ? outputVersion.sha256 : null,
      assetVersionId: redactDiagnosticText(outputVersion.assetVersionId, 160) || null,
      deliveryStatus: redactDiagnosticText(job.delivery?.status, 40) || null,
    },
  }
}

function statusSummary(jobs) {
  const byStatus = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0, other: 0 }
  for (const job of jobs || []) {
    if (Object.hasOwn(byStatus, job.status)) byStatus[job.status] += 1
    else byStatus.other += 1
  }
  return { total: (jobs || []).length, byStatus }
}

function schedulerSummary(snapshot) {
  return {
    resources: Object.fromEntries(Object.entries(snapshot?.resources || {}).slice(0, 20).map(([resourceClass, resource]) => [
      redactDiagnosticText(resourceClass, 40),
      {
        limit: safeInteger(resource.limit),
        active: Array.isArray(resource.activeJobs) ? resource.activeJobs.length : 0,
        queued: Array.isArray(resource.queuedJobs) ? resource.queuedJobs.length : 0,
      },
    ])),
  }
}

export function createDiagnosticReport({
  reportId,
  createdAt = Date.now(),
  runtimeDiagnostics,
  workflowCatalog,
  storageScan,
  activeJobs = [],
  archivedJobs = [],
  archiveSummary = null,
  schedulerSnapshot = null,
  collectionIssues = [],
} = {}) {
  const resolvedReportId = reportId || `diag-${new Date(createdAt).toISOString().replace(/\D/gu, '').slice(0, 14)}-${randomUUID()}`
  if (!SAFE_REPORT_ID.test(resolvedReportId)) throw diagnosticError('DIAGNOSTIC_REPORT_ID_INVALID', 'Diagnostic report id is invalid')
  const failures = [
    ...activeJobs.map((job) => ({ job, location: 'active' })),
    ...archivedJobs.map((job) => ({ job, location: 'archived' })),
  ]
    .filter(({ job }) => job?.status === 'failed')
    .sort((left, right) => jobTimestamp(right.job) - jobTimestamp(left.job) || String(right.job.id).localeCompare(String(left.job.id)))
    .slice(0, MAX_FAILURES)
    .map(({ job, location }) => safeFailureJob(job, location))

  const report = {
    schemaVersion: DIAGNOSTIC_REPORT_VERSION,
    reportId: resolvedReportId,
    createdAt: safeInteger(createdAt),
    privacy: {
      defaultRedaction: true,
      includesPrivateMedia: false,
      includesAbsolutePaths: false,
      includesCredentials: false,
      includesUserCreativeText: false,
      excluded: ['API 凭据与会话', '绝对路径', '私有媒体字节', '提示词、剧本与台词正文', '项目标题与资源名称'],
      bounded: { recentFailures: MAX_FAILURES, logsPerFailure: MAX_JOB_LOGS, reportBytes: MAX_REPORT_BYTES },
    },
    runtime: runtimeSummary(runtimeDiagnostics),
    workflows: workflowSummary(workflowCatalog),
    jobs: {
      active: statusSummary(activeJobs),
      archive: {
        ...statusSummary(archivedJobs),
        schemaVersion: safeInteger(archiveSummary?.schemaVersion),
        revision: safeInteger(archiveSummary?.revision),
        oldestArchivedAt: safeInteger(archiveSummary?.oldestArchivedAt),
        newestArchivedAt: safeInteger(archiveSummary?.newestArchivedAt),
      },
      scheduler: schedulerSummary(schedulerSnapshot),
      recentFailures: failures,
    },
    storage: storageSummary(storageScan),
    collectionIssues: collectionIssues.slice(0, 20).map((issue) => ({
      section: redactDiagnosticText(issue.section, 60),
      code: redactDiagnosticText(issue.code, 100) || 'COLLECTION_FAILED',
      message: redactDiagnosticText(issue.message, 320),
    })),
  }
  assertDiagnosticReportSafe(report)
  return report
}

export function assertDiagnosticReportSafe(report) {
  if (!report || report.schemaVersion !== DIAGNOSTIC_REPORT_VERSION || !SAFE_REPORT_ID.test(report.reportId || '')) {
    throw diagnosticError('DIAGNOSTIC_REPORT_INVALID', 'Diagnostic report does not match the supported schema', 500)
  }
  const source = JSON.stringify(report)
  const bytes = Buffer.byteLength(source)
  if (bytes > MAX_REPORT_BYTES) throw diagnosticError('DIAGNOSTIC_REPORT_TOO_LARGE', 'Diagnostic report exceeds its safety limit', 500)
  const forbidden = [
    ['DIAGNOSTIC_PATH_LEAK', /(?:[A-Za-z]:\\\\|\\\\\\\\[^\s"']+|\/(?:Users|home|tmp|var\/folders)\/)/iu],
    ['DIAGNOSTIC_CREDENTIAL_FIELD', /"(?:api[_-]?key|authorization|cookie|credential|password|secret|session|token)"\s*:/iu],
    ['DIAGNOSTIC_CREATIVE_FIELD', /"(?:prompt|negativePrompt|dialogue|transcript|script|userText|inputText|projectTitle|assetName)"\s*:/iu],
    ['DIAGNOSTIC_PRIVATE_PATH_FIELD', /"(?:inputPath|outputPath|maskPath|lastFramePath|temporaryOutputPath|comfyRoot|pythonPath|sourceUrl|downloadUrl)"\s*:/iu],
    ['DIAGNOSTIC_MEDIA_LEAK', /data:(?:image|video|audio)\//iu],
  ]
  for (const [code, pattern] of forbidden) {
    if (pattern.test(source)) throw diagnosticError(code, 'Diagnostic report failed its privacy gate', 500)
  }
  return { bytes }
}

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1)
    table[index] = value >>> 0
  }
  return table
})()

function crc32(bytes) {
  let value = 0xffffffff
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function dosTime(timestamp) {
  const date = new Date(Math.max(Date.UTC(1980, 0, 1), timestamp))
  const time = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2)
  const day = ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate()
  return { time, day }
}

export function createZipArchive(entries, timestamp = Date.now()) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 100) {
    throw diagnosticError('DIAGNOSTIC_ZIP_INVALID', 'Diagnostic ZIP entry list is invalid', 500)
  }
  const localParts = []
  const centralParts = []
  let offset = 0
  const { time, day } = dosTime(timestamp)
  for (const entry of entries) {
    if (!entry || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(entry.name || '')) {
      throw diagnosticError('DIAGNOSTIC_ZIP_ENTRY_INVALID', 'Diagnostic ZIP entry name is invalid', 500)
    }
    const name = Buffer.from(entry.name, 'utf8')
    const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(String(entry.content ?? ''), 'utf8')
    const compressed = deflateRawSync(content, { level: 9 })
    const checksum = crc32(content)
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(0x0800, 6)
    localHeader.writeUInt16LE(8, 8)
    localHeader.writeUInt16LE(time, 10)
    localHeader.writeUInt16LE(day, 12)
    localHeader.writeUInt32LE(checksum, 14)
    localHeader.writeUInt32LE(compressed.length, 18)
    localHeader.writeUInt32LE(content.length, 22)
    localHeader.writeUInt16LE(name.length, 26)
    localHeader.writeUInt16LE(0, 28)
    localParts.push(localHeader, name, compressed)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(0x0800, 8)
    centralHeader.writeUInt16LE(8, 10)
    centralHeader.writeUInt16LE(time, 12)
    centralHeader.writeUInt16LE(day, 14)
    centralHeader.writeUInt32LE(checksum, 16)
    centralHeader.writeUInt32LE(compressed.length, 20)
    centralHeader.writeUInt32LE(content.length, 24)
    centralHeader.writeUInt16LE(name.length, 28)
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt16LE(0, 34)
    centralHeader.writeUInt16LE(0, 36)
    centralHeader.writeUInt32LE(0, 38)
    centralHeader.writeUInt32LE(offset, 42)
    centralParts.push(centralHeader, name)
    offset += localHeader.length + name.length + compressed.length
  }
  const centralDirectory = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...localParts, centralDirectory, end])
}

function checksum(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function diagnosticReadme(report) {
  return [
    '光阴砚 AEONQUILL 脱敏诊断包',
    '',
    `报告编号：${report.reportId}`,
    `生成时间：${new Date(report.createdAt).toISOString()}`,
    `格式版本：${report.schemaVersion}`,
    '',
    '本包默认不包含 API 凭据、会话、绝对路径、私有媒体字节、提示词、剧本、台词、项目标题或资源名称。',
    'diagnostic.json 用于技术排障；manifest.json 用于核对包内文件 SHA-256。',
    '分享前仍建议由用户自行检查内容。',
    '',
  ].join('\r\n')
}

export class DiagnosticBundleService {
  constructor({ rootDirectory, ttlMs = DEFAULT_TTL_MS, maxBundles = DEFAULT_MAX_BUNDLES, now = () => Date.now() } = {}) {
    if (!rootDirectory) throw new Error('DiagnosticBundleService requires a root directory')
    this.rootDirectory = resolve(rootDirectory)
    this.ttlMs = Math.max(60_000, Math.min(60 * 60 * 1_000, safeInteger(ttlMs, DEFAULT_TTL_MS)))
    this.maxBundles = Math.max(1, Math.min(20, safeInteger(maxBundles, DEFAULT_MAX_BUNDLES)))
    this.now = now
    this.bundles = new Map()
    this.cleanupTimer = null
  }

  async open() {
    await mkdir(this.rootDirectory, { recursive: true })
    for (const entry of await readdir(this.rootDirectory, { withFileTypes: true })) {
      if (entry.isFile() && (MANAGED_BUNDLE_NAME.test(entry.name) || MANAGED_BUNDLE_TEMP_NAME.test(entry.name))) {
        await unlink(join(this.rootDirectory, entry.name)).catch(() => {})
      }
    }
    this.cleanupTimer = setInterval(() => void this.cleanupExpired().catch(() => {}), Math.min(this.ttlMs, 60_000))
    this.cleanupTimer.unref()
    return this
  }

  close() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer)
    this.cleanupTimer = null
  }

  async cleanupExpired() {
    const now = this.now()
    const expired = [...this.bundles.values()].filter((bundle) => bundle.expiresAt <= now)
    for (const bundle of expired) {
      this.bundles.delete(bundle.id)
      await unlink(bundle.path).catch(() => {})
    }
    return expired.length
  }

  async create(report) {
    assertDiagnosticReportSafe(report)
    await this.cleanupExpired()
    const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8')
    const readmeBytes = Buffer.from(diagnosticReadme(report), 'utf8')
    const manifest = {
      schemaVersion: DIAGNOSTIC_BUNDLE_VERSION,
      reportId: report.reportId,
      createdAt: report.createdAt,
      files: [
        { name: 'diagnostic.json', bytes: reportBytes.length, sha256: checksum(reportBytes) },
        { name: 'README.txt', bytes: readmeBytes.length, sha256: checksum(readmeBytes) },
      ],
    }
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    const archive = createZipArchive([
      { name: 'diagnostic.json', content: reportBytes },
      { name: 'README.txt', content: readmeBytes },
      { name: 'manifest.json', content: manifestBytes },
    ], report.createdAt)
    const id = report.reportId
    const filename = `aeonquill-diagnostics-${id}.zip`
    const finalPath = join(this.rootDirectory, filename)
    const temporaryPath = join(this.rootDirectory, `.${filename}.${process.pid}.${randomUUID()}.tmp`)
    await writeFile(temporaryPath, archive, { flag: 'wx', mode: 0o600 })
    try {
      await rename(temporaryPath, finalPath)
    } catch (error) {
      await unlink(temporaryPath).catch(() => {})
      throw error
    }
    const bundle = {
      id,
      filename,
      path: finalPath,
      bytes: archive.length,
      sha256: checksum(archive),
      createdAt: report.createdAt,
      expiresAt: report.createdAt + this.ttlMs,
      reportSchemaVersion: report.schemaVersion,
    }
    this.bundles.set(id, bundle)
    const overflow = [...this.bundles.values()]
      .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))
      .slice(this.maxBundles)
    for (const stale of overflow) {
      this.bundles.delete(stale.id)
      await unlink(stale.path).catch(() => {})
    }
    return this.publicBundle(bundle)
  }

  publicBundle(bundle) {
    return {
      version: DIAGNOSTIC_BUNDLE_VERSION,
      id: bundle.id,
      filename: bundle.filename,
      bytes: bundle.bytes,
      sha256: bundle.sha256,
      createdAt: bundle.createdAt,
      expiresAt: bundle.expiresAt,
      reportSchemaVersion: bundle.reportSchemaVersion,
      downloadUrl: `/api/diagnostics/bundles/${encodeURIComponent(bundle.id)}`,
      privacy: {
        defaultRedaction: true,
        includesPrivateMedia: false,
        includesAbsolutePaths: false,
        includesCredentials: false,
        includesUserCreativeText: false,
      },
    }
  }

  async read(id) {
    await this.cleanupExpired()
    if (!SAFE_REPORT_ID.test(id || '')) throw diagnosticError('DIAGNOSTIC_BUNDLE_ID_INVALID', 'Diagnostic bundle id is invalid')
    const bundle = this.bundles.get(id)
    if (!bundle) throw diagnosticError('DIAGNOSTIC_BUNDLE_NOT_FOUND', 'Diagnostic bundle expired or was not found', 404)
    try {
      const [bytes, details] = await Promise.all([readFile(bundle.path), stat(bundle.path)])
      if (!details.isFile() || details.size !== bundle.bytes || checksum(bytes) !== bundle.sha256) {
        throw diagnosticError('DIAGNOSTIC_BUNDLE_INTEGRITY_FAILED', 'Diagnostic bundle failed its integrity check', 500)
      }
      return { ...this.publicBundle(bundle), content: bytes }
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.bundles.delete(id)
        throw diagnosticError('DIAGNOSTIC_BUNDLE_NOT_FOUND', 'Diagnostic bundle expired or was not found', 404)
      }
      throw error
    }
  }
}
