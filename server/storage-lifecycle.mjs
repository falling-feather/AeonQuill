import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  statfs,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'

export const STORAGE_LIFECYCLE_VERSION = 'aeonquill-storage-lifecycle-v1'

const DAY_MS = 24 * 60 * 60 * 1_000
const SNAPSHOT_TTL_MS = 15 * 60 * 1_000
const MAX_SNAPSHOTS = 8
const MAX_SCAN_FILES = 200_000
const MAX_CLEANUP_CANDIDATES = 5_000
const MIN_FREE_RESERVE_BYTES = 2 * 1024 ** 3
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])
const ACTIVE_STATUSES = new Set(['queued', 'running'])
const SAFE_PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/u
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/u
const RETENTION_KEYS = Object.freeze([
  'terminalInputs',
  'intermediateOutputs',
  'previewCache',
  'comfyResiduals',
  'projectOrphans',
])
const DEFAULT_RETENTION_DAYS = Object.freeze({
  terminalInputs: 15,
  intermediateOutputs: 15,
  previewCache: 15,
  comfyResiduals: 7,
  projectOrphans: 15,
})
const CATEGORY_DEFINITIONS = Object.freeze({
  models: { label: '模型权重', cleanable: false },
  'custom-nodes': { label: 'ComfyUI 节点', cleanable: false },
  'project-assets': { label: '项目与资源库资产', cleanable: true },
  'job-inputs': { label: '任务输入与蒙版', cleanable: true },
  'job-outputs': { label: '中间帧与派生输出', cleanable: true },
  proxies: { label: '预览与代理缓存', cleanable: true },
  'comfy-residuals': { label: 'ComfyUI 受管残留', cleanable: true },
  deliveries: { label: '最终交付成片', cleanable: false },
})

export class StorageLifecycleError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message)
    this.name = 'StorageLifecycleError'
    this.code = code
    this.status = status
    this.details = details
  }
}

function fail(code, message, status = 400, details = undefined) {
  throw new StorageLifecycleError(code, message, status, details)
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function strictKeys(value, allowed, code = 'STORAGE_POLICY_INVALID') {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length) fail(code, 'Storage request contains unsupported fields', 400, { unknown })
}

function safeInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail('STORAGE_POLICY_INVALID', `${label} must be an integer from ${minimum} to ${maximum}`)
  }
  return value
}

function normalizeRetention(value, { partial = false } = {}) {
  if (!isRecord(value)) fail('STORAGE_POLICY_INVALID', 'Retention policy must be an object')
  strictKeys(value, RETENTION_KEYS)
  const normalized = {}
  for (const key of RETENTION_KEYS) {
    if (value[key] === undefined) {
      if (!partial) normalized[key] = DEFAULT_RETENTION_DAYS[key]
      continue
    }
    normalized[key] = safeInteger(value[key], 1, 3650, key)
  }
  return normalized
}

function normalizeProjectOverrides(value = {}) {
  if (!isRecord(value) || Object.keys(value).length > 100) {
    fail('STORAGE_POLICY_INVALID', 'Project retention overrides must be an object with at most 100 projects')
  }
  const normalized = {}
  for (const [projectId, retention] of Object.entries(value)) {
    if (!SAFE_PROJECT_ID.test(projectId)) fail('STORAGE_POLICY_INVALID', 'Project retention override has an invalid project id')
    const rule = normalizeRetention(retention, { partial: true })
    if (Object.keys(rule).length) normalized[projectId] = rule
  }
  return normalized
}

function defaultPolicy(now = Date.now()) {
  return {
    schemaVersion: 1,
    revision: 1,
    updatedAt: now,
    preserveDeliveries: true,
    retentionDays: { ...DEFAULT_RETENTION_DAYS },
    projectOverrides: {},
  }
}

function normalizeStoredPolicy(value) {
  if (!isRecord(value)) fail('STORAGE_POLICY_INVALID', 'Stored storage policy must be an object', 500)
  strictKeys(value, ['schemaVersion', 'revision', 'updatedAt', 'preserveDeliveries', 'retentionDays', 'projectOverrides'])
  if (value.schemaVersion !== 1 || value.preserveDeliveries !== true) {
    fail('STORAGE_POLICY_INVALID', 'Stored storage policy uses an unsupported schema', 500)
  }
  return {
    schemaVersion: 1,
    revision: safeInteger(value.revision, 1, Number.MAX_SAFE_INTEGER, 'revision'),
    updatedAt: safeInteger(value.updatedAt, 0, Number.MAX_SAFE_INTEGER, 'updatedAt'),
    preserveDeliveries: true,
    retentionDays: normalizeRetention(value.retentionDays),
    projectOverrides: normalizeProjectOverrides(value.projectOverrides),
  }
}

function normalizePolicyUpdate(value, current, now) {
  if (!isRecord(value)) fail('STORAGE_POLICY_INVALID', 'Storage policy update must be an object')
  strictKeys(value, ['baseRevision', 'retentionDays', 'projectOverrides'])
  if (value.baseRevision !== current.revision) {
    fail('STORAGE_POLICY_CONFLICT', `Stored policy revision ${current.revision} does not match base ${String(value.baseRevision)}`, 409, {
      current,
    })
  }
  return {
    schemaVersion: 1,
    revision: current.revision + 1,
    updatedAt: now,
    preserveDeliveries: true,
    retentionDays: value.retentionDays === undefined
      ? current.retentionDays
      : normalizeRetention(value.retentionDays),
    projectOverrides: value.projectOverrides === undefined
      ? current.projectOverrides
      : normalizeProjectOverrides(value.projectOverrides),
  }
}

function pathWithin(root, candidate) {
  const absoluteRoot = resolve(root)
  const absoluteCandidate = resolve(candidate)
  return absoluteCandidate === absoluteRoot || absoluteCandidate.startsWith(`${absoluteRoot}${sep}`)
}

function normalizedPath(value) {
  return process.platform === 'win32' ? resolve(value).toLocaleLowerCase('en-US') : resolve(value)
}

function safeHash(value) {
  return createHash('sha256').update(value).digest('hex')
}

function candidateId(category, filePath, stats, suffix = '') {
  return `storage-${safeHash(`${category}\0${normalizedPath(filePath)}\0${stats.size}\0${Math.trunc(stats.mtimeMs)}\0${suffix}`).slice(0, 32)}`
}

function ageDays(now, timestamp) {
  return Math.max(0, Math.floor((now - timestamp) / DAY_MS))
}

function boundedTimestamp(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

async function safeFileStats(filePath) {
  try {
    const stats = await lstat(filePath)
    if (!stats.isFile() || stats.isSymbolicLink()) return null
    return stats
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function scanTree(rootDirectory, { maximumFiles = MAX_SCAN_FILES } = {}) {
  const root = resolve(rootDirectory)
  let rootStats
  try {
    rootStats = await lstat(root)
  } catch (error) {
    if (error?.code === 'ENOENT') return { root, files: [], directories: 0, skippedLinks: 0, errors: 0, truncated: false, missing: true }
    return { root, files: [], directories: 0, skippedLinks: 0, errors: 1, truncated: false, missing: true }
  }
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    return { root, files: [], directories: 0, skippedLinks: rootStats.isSymbolicLink() ? 1 : 0, errors: 0, truncated: false, missing: true }
  }
  const files = []
  const directories = [root]
  let cursor = 0
  let skippedLinks = 0
  let errors = 0
  let truncated = false
  while (cursor < directories.length && files.length < maximumFiles) {
    const directory = directories[cursor++]
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      errors += 1
      continue
    }
    for (const entry of entries) {
      if (files.length >= maximumFiles) {
        truncated = true
        break
      }
      const filePath = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        skippedLinks += 1
      } else if (entry.isDirectory()) {
        directories.push(filePath)
      } else if (entry.isFile()) {
        try {
          const stats = await lstat(filePath)
          if (stats.isFile() && !stats.isSymbolicLink()) {
            files.push({
              path: filePath,
              relativePath: relative(root, filePath).replace(/\\/gu, '/'),
              name: entry.name,
              size: Number(stats.size),
              mtimeMs: Math.trunc(stats.mtimeMs),
            })
          }
        } catch {
          errors += 1
        }
      }
    }
  }
  if (cursor < directories.length) truncated = true
  return {
    root,
    files,
    directories: Math.max(0, directories.length - 1),
    skippedLinks,
    errors,
    truncated,
    missing: false,
  }
}

function emptyCategory(id) {
  const definition = CATEGORY_DEFINITIONS[id]
  return {
    id,
    label: definition.label,
    cleanable: definition.cleanable,
    bytes: 0,
    files: 0,
    candidateBytes: 0,
    candidateFiles: 0,
    protectedFiles: 0,
    missingFiles: 0,
    scanErrors: 0,
    truncated: false,
    roots: [],
  }
}

function addFile(category, bytes, state = 'protected') {
  category.files += 1
  category.bytes += Math.max(0, Number(bytes) || 0)
  if (state === 'candidate') {
    category.candidateFiles += 1
    category.candidateBytes += Math.max(0, Number(bytes) || 0)
  } else {
    category.protectedFiles += 1
  }
}

function publicCandidate(candidate, now) {
  return {
    id: candidate.id,
    category: candidate.category,
    kind: candidate.kind,
    bytes: candidate.bytes,
    ageDays: ageDays(now, candidate.mtimeMs),
    projectId: candidate.projectId,
    jobId: candidate.jobId,
    label: candidate.label,
    reason: candidate.reason,
  }
}

function projectIdForJob(job) {
  const value = job?.request?.projectId || job?.sourceElementId
  return typeof value === 'string' && SAFE_PROJECT_ID.test(value) ? value : undefined
}

function retentionFor(policy, projectId, key) {
  return policy.projectOverrides[projectId]?.[key] ?? policy.retentionDays[key]
}

function fileIsOldEnough(file, policy, projectId, key, now) {
  return now - file.mtimeMs >= retentionFor(policy, projectId, key) * DAY_MS
}

function controlledComfyPath(relativePath) {
  return relativePath.split('/').some((segment) => /^(?:AEONQUILL(?:[_-].*)?|aeonquill(?:[_-].*)?)$/u.test(segment))
}

function outputFilenameFromUrl(value) {
  if (typeof value !== 'string') return null
  const match = /^\/api\/assets\/([A-Za-z0-9._%-]{1,240})(?:[?#].*)?$/u.exec(value)
  if (!match) return null
  try {
    const filename = decodeURIComponent(match[1])
    return SAFE_FILENAME.test(filename) ? filename : null
  } catch {
    return null
  }
}

function jobFileReferences(jobs, inputDirectory, assetDirectory) {
  const inputs = new Map()
  const outputs = new Map()
  const add = (map, filePath, reference) => {
    if (!filePath) return
    const key = normalizedPath(filePath)
    const records = map.get(key) || []
    records.push(reference)
    map.set(key, records)
  }
  for (const job of jobs) {
    const projectId = projectIdForJob(job)
    for (const field of ['inputPath', 'lastFramePath']) {
      if (job[field] && pathWithin(inputDirectory, job[field])) add(inputs, job[field], { job, field, role: 'input', projectId })
    }
    if (job.maskPath) {
      const target = pathWithin(inputDirectory, job.maskPath) ? inputs : pathWithin(assetDirectory, job.maskPath) ? outputs : null
      if (target) add(target, job.maskPath, { job, field: 'maskPath', role: 'mask', projectId })
    }
    for (const field of ['outputPath', 'temporaryOutputPath']) {
      if (job[field] && pathWithin(assetDirectory, job[field])) {
        add(outputs, job[field], { job, field, role: field === 'outputPath' ? 'final' : 'temporary', projectId })
      }
    }
    const outputFilename = outputFilenameFromUrl(job.outputUrl)
    if (outputFilename) add(outputs, join(assetDirectory, outputFilename), { job, field: 'outputUrl', role: 'final', projectId })
    const maskFilename = outputFilenameFromUrl(job.maskUrl)
    if (maskFilename) add(outputs, join(assetDirectory, maskFilename), { job, field: 'maskUrl', role: 'mask', projectId })
    for (const intermediate of job.intermediateOutputs || []) {
      if (SAFE_FILENAME.test(intermediate?.filename || '')) {
        add(outputs, join(assetDirectory, intermediate.filename), { job, field: 'intermediateOutputs', role: 'intermediate', projectId, filename: intermediate.filename })
      }
    }
  }
  return { inputs, outputs }
}

function filenameReferencesWorkspace(filename, references) {
  return references.jobAssetFilenames.includes(filename)
}

function diskNumber(value) {
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value)
}

async function diskCapacity(directory) {
  const stats = await statfs(directory)
  const blockSize = BigInt(stats.bsize)
  const totalBytes = diskNumber(blockSize * BigInt(stats.blocks))
  const freeBytes = diskNumber(blockSize * BigInt(stats.bavail ?? stats.bfree))
  const reserveBytes = Math.max(MIN_FREE_RESERVE_BYTES, Math.min(20 * 1024 ** 3, Math.floor(totalBytes * 0.05)))
  return {
    totalBytes,
    freeBytes,
    reserveBytes,
    usableBytes: Math.max(0, freeBytes - reserveBytes),
    status: freeBytes <= reserveBytes ? 'critical' : freeBytes <= reserveBytes * 2 ? 'warning' : 'healthy',
  }
}

function storageEstimates(capacity) {
  const estimates = [
    { id: 'image-edit', label: '单次图像编辑', requiredBytes: 512 * 1024 ** 2 },
    { id: 'video-fast', label: '极速视频镜头', requiredBytes: 4 * 1024 ** 3 },
    { id: 'video-quality-720p', label: '质量模式 720P 镜头', requiredBytes: 12 * 1024 ** 3 },
  ]
  return estimates.map((estimate) => ({ ...estimate, available: capacity.usableBytes >= estimate.requiredBytes }))
}

export class StorageLifecycleService {
  constructor({
    rootDirectory,
    runtimeDirectory,
    dataDirectory,
    cacheDirectory,
    inputDirectory,
    assetDirectory,
    outputDirectory,
    outputDirectorySource = 'application',
    comfyDirectories = {},
    projectStore,
    workspaceStore,
    jobStore,
    getRuntimeRegistry = async () => ({ modelRoots: [], nodeRoots: [] }),
    onProjectAssetsRemoved = async () => {},
    now = () => Date.now(),
  } = {}) {
    if (!rootDirectory || !runtimeDirectory || !dataDirectory || !cacheDirectory || !inputDirectory || !assetDirectory) {
      throw new Error('StorageLifecycleService requires explicit managed roots')
    }
    if (!projectStore || !workspaceStore || !jobStore) throw new Error('StorageLifecycleService requires stores')
    this.rootDirectory = resolve(rootDirectory)
    this.policyPath = join(this.rootDirectory, 'policy.json')
    this.runtimeDirectory = resolve(runtimeDirectory)
    this.dataDirectory = resolve(dataDirectory)
    this.cacheDirectory = resolve(cacheDirectory)
    this.inputDirectory = resolve(inputDirectory)
    this.assetDirectory = resolve(assetDirectory)
    this.outputDirectory = outputDirectory ? resolve(outputDirectory) : null
    this.outputDirectorySource = outputDirectorySource
    this.comfyDirectories = Object.fromEntries(Object.entries(comfyDirectories)
      .filter(([, value]) => typeof value === 'string' && value)
      .map(([key, value]) => [key, resolve(value)]))
    this.projectStore = projectStore
    this.workspaceStore = workspaceStore
    this.jobStore = jobStore
    this.getRuntimeRegistry = getRuntimeRegistry
    this.onProjectAssetsRemoved = onProjectAssetsRemoved
    this.now = now
    this.policy = defaultPolicy(this.now())
    this.policyIssue = null
    this.snapshots = new Map()
  }

  async open() {
    await mkdir(this.rootDirectory, { recursive: true })
    try {
      this.policy = normalizeStoredPolicy(JSON.parse(await readFile(this.policyPath, 'utf8')))
    } catch (error) {
      if (error?.code === 'ENOENT') {
        await this._writePolicy(this.policy)
      } else {
        this.policyIssue = {
          code: error?.code || 'STORAGE_POLICY_CORRUPT',
          message: '空间治理策略无效，已回退到安全默认值；原文件未被覆盖。',
        }
      }
    }
    return this
  }

  getPolicy() {
    return structuredClone(this.policy)
  }

  configureOutputDirectory(directory, source = 'application') {
    this.outputDirectory = directory ? resolve(directory) : null
    this.outputDirectorySource = source === 'custom' ? 'custom' : 'application'
    this.snapshots.clear()
  }

  async _writePolicy(policy) {
    const temporaryPath = `${this.policyPath}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, JSON.stringify(policy, null, 2), { encoding: 'utf8', flag: 'wx' })
    try {
      await rename(temporaryPath, this.policyPath)
    } catch (error) {
      await unlink(temporaryPath).catch(() => {})
      throw error
    }
  }

  async updatePolicy(request) {
    const next = normalizePolicyUpdate(request, this.policy, this.now())
    await this._writePolicy(next)
    this.policy = next
    this.policyIssue = null
    this.snapshots.clear()
    return this.getPolicy()
  }

  _rememberSnapshot(snapshot) {
    const now = this.now()
    for (const [id, entry] of this.snapshots) {
      if (now - entry.createdAt > SNAPSHOT_TTL_MS) this.snapshots.delete(id)
    }
    while (this.snapshots.size >= MAX_SNAPSHOTS) this.snapshots.delete(this.snapshots.keys().next().value)
    this.snapshots.set(snapshot.id, snapshot)
  }

  _snapshot(scanId) {
    const snapshot = this.snapshots.get(scanId)
    if (!snapshot || this.now() - snapshot.createdAt > SNAPSHOT_TTL_MS) {
      this.snapshots.delete(scanId)
      fail('STORAGE_SCAN_EXPIRED', 'Storage scan expired; rescan before cleanup', 409)
    }
    return snapshot
  }

  async scan({ projectId, includeRuntimeRoots = true } = {}) {
    if (projectId !== undefined && !SAFE_PROJECT_ID.test(projectId)) fail('STORAGE_PROJECT_INVALID', 'Storage project filter is invalid')
    const now = this.now()
    const categories = Object.fromEntries(Object.keys(CATEGORY_DEFINITIONS).map((id) => [id, emptyCategory(id)]))
    const candidates = []
    const privateCandidates = new Map()
    const addCandidate = (candidate) => {
      if (privateCandidates.size >= MAX_CLEANUP_CANDIDATES) {
        categories[candidate.category].truncated = true
        return false
      }
      privateCandidates.set(candidate.id, candidate)
      candidates.push(publicCandidate(candidate, now))
      return true
    }
    const workspaceReferences = this.workspaceStore.storageReferences()
    const workspaceProjectAssets = new Set(workspaceReferences.projectAssetIds)
    const jobs = this.jobStore.list()
    const activeJobIds = new Set(jobs.filter((job) => ACTIVE_STATUSES.has(job.status)).map((job) => job.id))
    const fileReferences = jobFileReferences(jobs, this.inputDirectory, this.assetDirectory)

    if (includeRuntimeRoots) {
      let registry
      try {
        registry = await this.getRuntimeRegistry()
      } catch {
        registry = { modelRoots: [], nodeRoots: [] }
        categories.models.scanErrors += 1
      }
      const seenRoots = new Set()
      for (const [categoryId, roots] of [['models', registry.modelRoots || []], ['custom-nodes', registry.nodeRoots || []]]) {
        for (const root of roots) {
          if (!root?.path) continue
          const key = normalizedPath(root.path)
          if (seenRoots.has(`${categoryId}\0${key}`)) continue
          seenRoots.add(`${categoryId}\0${key}`)
          const scanned = await scanTree(root.path)
          const bytes = scanned.files.reduce((sum, file) => sum + file.size, 0)
          categories[categoryId].bytes += bytes
          categories[categoryId].files += scanned.files.length
          categories[categoryId].protectedFiles += scanned.files.length
          categories[categoryId].scanErrors += scanned.errors
          categories[categoryId].truncated ||= scanned.truncated
          categories[categoryId].roots.push({
            id: root.id || `root-${safeHash(key).slice(0, 16)}`,
            label: root.label || root.category || CATEGORY_DEFINITIONS[categoryId].label,
            category: root.category || categoryId,
            bytes,
            files: scanned.files.length,
            exists: !scanned.missing,
            shared: Boolean(root.shared),
            referenceCount: Array.isArray(root.references) ? root.references.length : 0,
            removalMode: 'runtime-removal-check-only',
            removalBlocked: Array.isArray(root.references) && root.references.length > 0,
            skippedLinks: scanned.skippedLinks,
          })
        }
      }
    }

    for (const asset of this.projectStore.storageInventory()) {
      const filePath = this.projectStore.assetPath(asset)
      const stats = await safeFileStats(filePath).catch(() => null)
      if (!stats) categories['project-assets'].missingFiles += 1
      const bytes = stats ? Number(stats.size) : 0
      const mtimeMs = stats ? Math.trunc(stats.mtimeMs) : asset.createdAt
      const protectedByWorkspace = workspaceProjectAssets.has(asset.id)
      const eligible = asset.referenceCount === 0
        && !protectedByWorkspace
        && now - mtimeMs >= this.policy.retentionDays.projectOrphans * DAY_MS
      if (eligible) {
        const candidate = {
          id: candidateId('project-assets', filePath, { size: bytes, mtimeMs }, asset.id),
          category: 'project-assets',
          kind: 'project-asset',
          assetId: asset.id,
          path: filePath,
          root: this.projectStore.assetDirectory,
          bytes,
          mtimeMs,
          label: `未引用资产 · ${asset.mimeType}`,
          reason: `已超过 ${this.policy.retentionDays.projectOrphans} 天且不被项目、资源库或恢复点引用`,
        }
        const accepted = addCandidate(candidate)
        addFile(categories['project-assets'], bytes, accepted ? 'candidate' : 'protected')
      } else {
        addFile(categories['project-assets'], bytes)
      }
    }

    const inputScan = await scanTree(this.inputDirectory)
    categories['job-inputs'].scanErrors += inputScan.errors
    categories['job-inputs'].truncated ||= inputScan.truncated
    for (const file of inputScan.files) {
      const references = fileReferences.inputs.get(normalizedPath(file.path)) || []
      const related = references[0]
      const relatedProject = related?.projectId
      const inScope = projectId === undefined || relatedProject === projectId
      const terminal = references.length > 0 && references.every(({ job }) => TERMINAL_STATUSES.has(job.status))
      const protectedByActiveJob = references.some(({ job }) => ACTIVE_STATUSES.has(job.status))
      const eligible = inScope
        && terminal
        && !protectedByActiveJob
        && fileIsOldEnough(file, this.policy, relatedProject, 'terminalInputs', now)
      if (eligible) {
        const candidate = {
          id: candidateId('job-inputs', file.path, file),
          category: 'job-inputs',
          kind: 'managed-file',
          path: file.path,
          root: this.inputDirectory,
          bytes: file.size,
          mtimeMs: file.mtimeMs,
          filename: file.name,
          jobId: related?.job.id,
          jobField: related?.field,
          projectId: relatedProject,
          label: related?.role === 'mask' ? '过期任务蒙版' : '过期任务输入',
          reason: `终态任务输入已超过 ${retentionFor(this.policy, relatedProject, 'terminalInputs')} 天保留期`,
        }
        const accepted = addCandidate(candidate)
        addFile(categories['job-inputs'], file.size, accepted ? 'candidate' : 'protected')
      } else {
        addFile(categories['job-inputs'], file.size)
      }
    }

    const outputScan = await scanTree(this.assetDirectory)
    categories['job-outputs'].scanErrors += outputScan.errors
    categories['job-outputs'].truncated ||= outputScan.truncated
    for (const file of outputScan.files) {
      const references = fileReferences.outputs.get(normalizedPath(file.path)) || []
      const related = references[0]
      const relatedProject = related?.projectId
      const inScope = projectId === undefined || relatedProject === projectId
      const protectedByWorkspace = filenameReferencesWorkspace(file.name, workspaceReferences)
      const protectedByActiveJob = references.some(({ job }) => ACTIVE_STATUSES.has(job.status))
      const finalOutput = references.some(({ role }) => role === 'final')
      const removableRole = references.length > 0 && references.every(({ role }) => ['intermediate', 'temporary', 'mask'].includes(role))
      const terminal = references.length > 0 && references.every(({ job }) => TERMINAL_STATUSES.has(job.status))
      const eligible = inScope
        && removableRole
        && terminal
        && !finalOutput
        && !protectedByWorkspace
        && !protectedByActiveJob
        && fileIsOldEnough(file, this.policy, relatedProject, 'intermediateOutputs', now)
      if (eligible) {
        const candidate = {
          id: candidateId('job-outputs', file.path, file),
          category: 'job-outputs',
          kind: 'managed-file',
          path: file.path,
          root: this.assetDirectory,
          bytes: file.size,
          mtimeMs: file.mtimeMs,
          filename: file.name,
          jobId: related?.job.id,
          jobField: related?.field,
          projectId: relatedProject,
          label: related?.role === 'intermediate' ? '过期中间母片' : related?.role === 'mask' ? '过期派生蒙版' : '过期临时输出',
          reason: `可再生成文件已超过 ${retentionFor(this.policy, relatedProject, 'intermediateOutputs')} 天保留期`,
        }
        const accepted = addCandidate(candidate)
        addFile(categories['job-outputs'], file.size, accepted ? 'candidate' : 'protected')
      } else {
        addFile(categories['job-outputs'], file.size)
      }
    }

    const previewRoot = join(this.cacheDirectory, 'previews')
    const previewScan = await scanTree(previewRoot)
    categories.proxies.scanErrors += previewScan.errors
    categories.proxies.truncated ||= previewScan.truncated
    for (const file of previewScan.files) {
      const eligible = now - file.mtimeMs >= this.policy.retentionDays.previewCache * DAY_MS
      if (eligible) {
        const candidate = {
          id: candidateId('proxies', file.path, file),
          category: 'proxies',
          kind: 'managed-file',
          path: file.path,
          root: previewRoot,
          bytes: file.size,
          mtimeMs: file.mtimeMs,
          filename: file.name,
          label: '可重建预览缓存',
          reason: `预览缓存已超过 ${this.policy.retentionDays.previewCache} 天保留期`,
        }
        const accepted = addCandidate(candidate)
        addFile(categories.proxies, file.size, accepted ? 'candidate' : 'protected')
      } else {
        addFile(categories.proxies, file.size)
      }
    }

    const seenComfyRoots = new Set()
    for (const [role, root] of Object.entries(this.comfyDirectories)) {
      const rootKey = normalizedPath(root)
      if (seenComfyRoots.has(rootKey)) continue
      seenComfyRoots.add(rootKey)
      const scanned = await scanTree(root)
      let rootBytes = 0
      let rootFiles = 0
      let excludedFiles = 0
      for (const file of scanned.files) {
        if (!controlledComfyPath(file.relativePath)) {
          excludedFiles += 1
          continue
        }
        rootBytes += file.size
        rootFiles += 1
        const activeReference = [...activeJobIds].some((jobId) => file.relativePath.includes(jobId))
        const eligible = !activeReference && now - file.mtimeMs >= this.policy.retentionDays.comfyResiduals * DAY_MS
        if (eligible) {
          const candidate = {
            id: candidateId('comfy-residuals', file.path, file),
            category: 'comfy-residuals',
            kind: 'managed-file',
            path: file.path,
            root,
            bytes: file.size,
            mtimeMs: file.mtimeMs,
            filename: file.name,
            label: `ComfyUI ${role} 受管残留`,
            reason: `光阴砚前缀文件已超过 ${this.policy.retentionDays.comfyResiduals} 天保留期`,
          }
          const accepted = addCandidate(candidate)
          addFile(categories['comfy-residuals'], file.size, accepted ? 'candidate' : 'protected')
        } else {
          addFile(categories['comfy-residuals'], file.size)
        }
      }
      categories['comfy-residuals'].scanErrors += scanned.errors
      categories['comfy-residuals'].truncated ||= scanned.truncated
      categories['comfy-residuals'].roots.push({
        id: `comfy-${safeHash(rootKey).slice(0, 16)}`,
        label: `ComfyUI ${role}`,
        bytes: rootBytes,
        files: rootFiles,
        excludedFiles,
        exists: !scanned.missing,
        skippedLinks: scanned.skippedLinks,
      })
    }

    if (this.outputDirectory) {
      const knownDeliveries = new Set()
      for (const job of jobs) {
        const filename = job.delivery?.status === 'copied' && SAFE_FILENAME.test(job.delivery?.filename || '')
          ? job.delivery.filename
          : null
        if (!filename || knownDeliveries.has(filename)) continue
        knownDeliveries.add(filename)
        const filePath = join(this.outputDirectory, filename)
        if (!pathWithin(this.outputDirectory, filePath)) continue
        const stats = await safeFileStats(filePath).catch(() => null)
        if (stats) addFile(categories.deliveries, Number(stats.size))
        else categories.deliveries.missingFiles += 1
      }
      categories.deliveries.roots.push({
        id: `delivery-${safeHash(normalizedPath(this.outputDirectory)).slice(0, 16)}`,
        label: this.outputDirectorySource === 'custom' ? '用户自选输出目录' : '软件默认 output',
        bytes: categories.deliveries.bytes,
        files: categories.deliveries.files,
        exists: true,
        deletionMode: 'manual-only',
      })
    }

    const capacity = await diskCapacity(this.runtimeDirectory)
    const orderedCategories = Object.keys(CATEGORY_DEFINITIONS).map((id) => categories[id])
    const candidateBytes = candidates.reduce((sum, candidate) => sum + candidate.bytes, 0)
    const fingerprint = safeHash(JSON.stringify({
      policyRevision: this.policy.revision,
      projectId: projectId || null,
      candidates: candidates.map(({ id, bytes }) => [id, bytes]),
      workspaceReferences,
    }))
    const id = `scan-${randomUUID()}`
    const snapshot = {
      id,
      createdAt: now,
      expiresAt: now + SNAPSHOT_TTL_MS,
      fingerprint,
      projectId,
      policyRevision: this.policy.revision,
      privateCandidates,
    }
    this._rememberSnapshot(snapshot)
    return {
      version: STORAGE_LIFECYCLE_VERSION,
      scanId: id,
      fingerprint,
      scannedAt: now,
      expiresAt: snapshot.expiresAt,
      projectId,
      policy: this.getPolicy(),
      policyIssue: this.policyIssue,
      capacity,
      estimates: storageEstimates(capacity),
      totals: {
        bytes: orderedCategories.reduce((sum, category) => sum + category.bytes, 0),
        files: orderedCategories.reduce((sum, category) => sum + category.files, 0),
        candidateBytes,
        candidateFiles: candidates.length,
      },
      references: {
        projectAssets: workspaceReferences.projectAssetIds.length,
        jobAssets: workspaceReferences.jobAssetFilenames.length,
        recoveryPoints: workspaceReferences.sources.recoveryPoints,
      },
      categories: orderedCategories,
      candidates,
      safety: {
        modelsRequireRuntimeRemovalCheck: true,
        customOutputManualOnly: this.outputDirectorySource === 'custom',
        deliveriesPreserved: true,
        symlinksFollowed: false,
      },
    }
  }

  validateCleanupRequest(request) {
    if (!isRecord(request)) fail('STORAGE_CLEANUP_INVALID', 'Cleanup request must be an object')
    strictKeys(request, ['scanId', 'fingerprint', 'candidateIds', 'acknowledgedBytes'], 'STORAGE_CLEANUP_INVALID')
    const snapshot = this._snapshot(request.scanId)
    if (request.fingerprint !== snapshot.fingerprint || snapshot.policyRevision !== this.policy.revision) {
      fail('STORAGE_SCAN_STALE', 'Storage state or policy changed; rescan before cleanup', 409)
    }
    if (!Array.isArray(request.candidateIds) || request.candidateIds.length < 1 || request.candidateIds.length > MAX_CLEANUP_CANDIDATES) {
      fail('STORAGE_CLEANUP_INVALID', 'Cleanup must select 1–5000 candidates')
    }
    const ids = [...new Set(request.candidateIds)]
    if (ids.length !== request.candidateIds.length || ids.some((id) => !snapshot.privateCandidates.has(id))) {
      fail('STORAGE_CLEANUP_INVALID', 'Cleanup candidate list is duplicated or does not belong to this scan', 409)
    }
    const acknowledgedBytes = ids.reduce((sum, id) => sum + snapshot.privateCandidates.get(id).bytes, 0)
    if (!Number.isSafeInteger(request.acknowledgedBytes) || request.acknowledgedBytes !== acknowledgedBytes) {
      fail('STORAGE_CLEANUP_ACK_MISMATCH', 'Acknowledged reclaim size does not match selected candidates', 409, { acknowledgedBytes })
    }
    return {
      scanId: snapshot.id,
      fingerprint: snapshot.fingerprint,
      candidateIds: ids,
      acknowledgedBytes,
    }
  }

  async _patchRemovedJobFile(candidate) {
    if (!candidate.jobId) return
    const job = this.jobStore.get(candidate.jobId)
    if (!job) return
    const patch = {
      storageLifecycle: {
        ...(job.storageLifecycle || {}),
        lastCleanupAt: this.now(),
        expiredFiles: [...new Set([...(job.storageLifecycle?.expiredFiles || []), candidate.jobField || candidate.kind])].slice(-20),
      },
    }
    if (candidate.jobField === 'intermediateOutputs') {
      patch.intermediateOutputs = (job.intermediateOutputs || []).filter((item) => item.filename !== candidate.filename)
    } else if (candidate.jobField && ['inputPath', 'lastFramePath', 'maskPath', 'temporaryOutputPath'].includes(candidate.jobField)) {
      patch[candidate.jobField] = undefined
    } else if (candidate.jobField === 'maskUrl') {
      patch.maskUrl = undefined
    }
    await this.jobStore.update(candidate.jobId, patch)
  }

  async _candidateStillSafe(candidate, workspaceReferences) {
    if (candidate.kind === 'project-asset') {
      const inventory = this.projectStore.storageInventory().find(({ id }) => id === candidate.assetId)
      return Boolean(inventory && inventory.referenceCount === 0 && !workspaceReferences.projectAssetIds.includes(candidate.assetId))
    }
    if (!pathWithin(candidate.root, candidate.path)) return false
    const stats = await safeFileStats(candidate.path)
    if (!stats || Number(stats.size) !== candidate.bytes || Math.trunc(stats.mtimeMs) !== candidate.mtimeMs) return false
    if (candidate.filename && workspaceReferences.jobAssetFilenames.includes(candidate.filename)) return false
    const jobs = this.jobStore.list()
    const currentReferences = jobFileReferences(jobs, this.inputDirectory, this.assetDirectory)
    const pathKey = normalizedPath(candidate.path)
    const references = [
      ...(currentReferences.inputs.get(pathKey) || []),
      ...(currentReferences.outputs.get(pathKey) || []),
    ]
    if (references.some(({ job }) => ACTIVE_STATUSES.has(job.status))) return false
    if (references.some(({ role }) => role === 'final')) return false
    if (candidate.jobId) {
      const job = jobs.find(({ id }) => id === candidate.jobId)
      if (job && ACTIVE_STATUSES.has(job.status)) return false
      if (candidate.jobField === 'intermediateOutputs' && !(job?.intermediateOutputs || []).some((item) => item.filename === candidate.filename)) return false
      if (candidate.jobField && ['inputPath', 'lastFramePath', 'maskPath', 'temporaryOutputPath'].includes(candidate.jobField)) {
        if (normalizedPath(job?.[candidate.jobField] || candidate.path) !== normalizedPath(candidate.path)) return false
      }
    }
    if (candidate.category === 'comfy-residuals') {
      const rel = relative(candidate.root, candidate.path).replace(/\\/gu, '/')
      if (!controlledComfyPath(rel)) return false
      if (jobs.some((job) => ACTIVE_STATUSES.has(job.status) && rel.includes(job.id))) return false
    }
    return true
  }

  async cleanup(request, { signal, onProgress } = {}) {
    const normalized = this.validateCleanupRequest(request)
    const snapshot = this._snapshot(normalized.scanId)
    if (snapshot.inUse) fail('STORAGE_SCAN_IN_USE', 'Storage scan is already being cleaned; rescan before another cleanup', 409)
    snapshot.inUse = true
    const selected = normalized.candidateIds.map((id) => snapshot.privateCandidates.get(id))
    const removed = []
    const skipped = []
    const failures = []
    let reclaimedBytes = 0
    for (let index = 0; index < selected.length; index += 1) {
      if (signal?.aborted) throw Object.assign(new Error('Storage cleanup was cancelled'), { name: 'AbortError', code: 'JOB_CANCELLED' })
      const candidate = selected[index]
      const workspaceReferences = this.workspaceStore.storageReferences()
      try {
        if (!(await this._candidateStillSafe(candidate, workspaceReferences))) {
          skipped.push({ id: candidate.id, code: 'REFERENCE_CHANGED' })
        } else if (candidate.kind === 'project-asset') {
          const removedAssets = await this.projectStore.collectGarbage({
            candidateAssetIds: [candidate.assetId],
            protectedAssetIds: workspaceReferences.projectAssetIds,
            isExternallyProtected: (assetId) => this.workspaceStore.storageReferences().projectAssetIds.includes(assetId),
          })
          if (removedAssets.includes(candidate.assetId)) {
            removed.push(candidate.id)
            reclaimedBytes += candidate.bytes
            await this.onProjectAssetsRemoved(removedAssets)
          } else {
            skipped.push({ id: candidate.id, code: 'REFERENCE_CHANGED' })
          }
        } else {
          await unlink(candidate.path)
          removed.push(candidate.id)
          reclaimedBytes += candidate.bytes
          await this._patchRemovedJobFile(candidate)
        }
      } catch (error) {
        if (error?.code === 'ENOENT') skipped.push({ id: candidate.id, code: 'ALREADY_REMOVED' })
        else failures.push({ id: candidate.id, code: error?.code || 'DELETE_FAILED', message: '文件未能安全清理' })
      }
      await onProgress?.({
        completed: index + 1,
        total: selected.length,
        reclaimedBytes,
        candidateId: candidate.id,
      })
    }
    const verification = await this.scan({ projectId: snapshot.projectId, includeRuntimeRoots: false })
    const remainingIds = new Set(verification.candidates.map(({ id }) => id))
    const result = {
      version: STORAGE_LIFECYCLE_VERSION,
      scanId: normalized.scanId,
      selectedFiles: selected.length,
      acknowledgedBytes: normalized.acknowledgedBytes,
      reclaimedBytes,
      removed,
      skipped,
      failures,
      verification: {
        scanId: verification.scanId,
        scannedAt: verification.scannedAt,
        candidateBytes: verification.totals.candidateBytes,
        candidateFiles: verification.totals.candidateFiles,
        selectedStillCandidates: selected.filter(({ id }) => remainingIds.has(id)).map(({ id }) => id),
        consistent: removed.every((id) => !remainingIds.has(id)),
      },
    }
    this.snapshots.delete(normalized.scanId)
    return result
  }
}
