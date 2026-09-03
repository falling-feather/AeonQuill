import { assertVideoProductionProject } from './productionPipeline.mjs'

export const LOCAL_VIDEO_CANDIDATE_BINDING_SCHEMA_VERSION = 1
export const LOCAL_VIDEO_CANDIDATE_BACKFILL_SCHEMA_VERSION = 1

const SAFE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,199}$/u
const IDEMPOTENCY_KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/u
const CONTENT_HASH_PATTERN = /^[a-f0-9]{64}$/u
const LIBRARY_ITEM_PATTERN = /^library-[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/u
const LIBRARY_VERSION_PATTERN = /^library-version-[a-f0-9]{32}$/u
const BINDING_KEYS = Object.freeze([
  'schemaVersion',
  'projectId',
  'documentId',
  'productionId',
  'productionRevision',
  'continuityRevision',
  'storyRevision',
  'shotId',
  'inputFingerprint',
  'generationMode',
  'executionItemId',
  'submissionId',
])
const BACKFILL_KEYS = Object.freeze([
  'schemaVersion',
  'status',
  'jobId',
  'binding',
  'libraryItemId',
  'libraryVersionId',
  'contentHash',
  'mimeType',
  'code',
  'message',
  'createdAt',
])

export class LocalVideoCandidateError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'LocalVideoCandidateError'
    this.code = code
    this.details = details
  }
}

function fail(code, message, details) {
  throw new LocalVideoCandidateError(code, message, details)
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value, keys, path) {
  if (!isRecord(value)) fail('INVALID_LOCAL_CANDIDATE_OBJECT', `${path} must be an object`)
  const expected = new Set(keys)
  const unknown = Object.keys(value).filter((key) => !expected.has(key))
  const missing = keys.filter((key) => !Object.hasOwn(value, key))
  if (unknown.length || missing.length) {
    fail('INVALID_LOCAL_CANDIDATE_FIELDS', `${path} fields do not match the supported schema`, { unknown, missing })
  }
}

function safeId(value, path, pattern = SAFE_ID_PATTERN) {
  if (typeof value !== 'string' || !pattern.test(value)) fail('INVALID_LOCAL_CANDIDATE_ID', `${path} is invalid`)
  return value
}

function revision(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_LOCAL_CANDIDATE_REVISION', `${path} must be a non-negative integer`)
  return value
}

function timestamp(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_LOCAL_CANDIDATE_TIMESTAMP', `${path} must be a non-negative integer`)
  return value
}

function clone(value) {
  return structuredClone(value)
}

function sameBinding(left, right) {
  return BINDING_KEYS.every((key) => left[key] === right[key])
}

function errorResult(code, message, key = null) {
  return { status: 'rejected', code, message, key }
}

export function assertLocalVideoCandidateJobBinding(binding) {
  exactKeys(binding, BINDING_KEYS, 'candidateBinding')
  if (binding.schemaVersion !== LOCAL_VIDEO_CANDIDATE_BINDING_SCHEMA_VERSION) {
    fail('UNSUPPORTED_LOCAL_CANDIDATE_BINDING', 'candidateBinding schema is unsupported')
  }
  safeId(binding.projectId, 'candidateBinding.projectId')
  safeId(binding.documentId, 'candidateBinding.documentId')
  safeId(binding.productionId, 'candidateBinding.productionId')
  revision(binding.productionRevision, 'candidateBinding.productionRevision')
  revision(binding.continuityRevision, 'candidateBinding.continuityRevision')
  revision(binding.storyRevision, 'candidateBinding.storyRevision')
  safeId(binding.shotId, 'candidateBinding.shotId')
  safeId(binding.inputFingerprint, 'candidateBinding.inputFingerprint')
  if (!['fast', 'quality'].includes(binding.generationMode)) {
    fail('INVALID_LOCAL_CANDIDATE_MODE', 'candidateBinding.generationMode is unsupported')
  }
  safeId(binding.executionItemId, 'candidateBinding.executionItemId')
  safeId(binding.submissionId, 'candidateBinding.submissionId', IDEMPOTENCY_KEY_PATTERN)
  return binding
}

export function createLocalVideoCandidateJobBinding(input) {
  if (!isRecord(input)) fail('INVALID_LOCAL_CANDIDATE_INPUT', 'Local candidate binding input must be an object')
  const production = assertVideoProductionProject(input.production)
  safeId(input.projectId, 'input.projectId')
  safeId(input.documentId, 'input.documentId')
  safeId(input.shotId, 'input.shotId')
  safeId(input.executionItemId, 'input.executionItemId')
  safeId(input.submissionId, 'input.submissionId', IDEMPOTENCY_KEY_PATTERN)
  if (production.continuityGraph.storyProjectId !== input.documentId) {
    fail('LOCAL_CANDIDATE_DOCUMENT_MISMATCH', 'Production continuity graph does not belong to the workspace document')
  }
  if (!Number.isSafeInteger(production.continuityGraph.storyRevision)) {
    fail('LOCAL_CANDIDATE_STORY_UNBOUND', 'Production continuity graph is not bound to a story revision')
  }
  const shot = production.continuityGraph.shots.find(({ id }) => id === input.shotId)
  if (!shot) fail('LOCAL_CANDIDATE_SHOT_NOT_FOUND', `Unknown continuity shot ${input.shotId}`)
  if (shot.status === 'blocked') {
    fail('LOCAL_CANDIDATE_SHOT_BLOCKED', `Shot ${input.shotId} still has unapproved required assets`)
  }
  return assertLocalVideoCandidateJobBinding({
    schemaVersion: LOCAL_VIDEO_CANDIDATE_BINDING_SCHEMA_VERSION,
    projectId: input.projectId,
    documentId: input.documentId,
    productionId: production.id,
    productionRevision: production.revision,
    continuityRevision: production.continuityGraph.revision,
    storyRevision: production.continuityGraph.storyRevision,
    shotId: shot.id,
    inputFingerprint: shot.inputFingerprint,
    generationMode: production.settings.generationMode,
    executionItemId: input.executionItemId,
    submissionId: input.submissionId,
  })
}

export function retargetLocalVideoCandidateSubmission(bindingInput, input) {
  const binding = assertLocalVideoCandidateJobBinding(bindingInput)
  if (!isRecord(input)) fail('INVALID_LOCAL_CANDIDATE_INPUT', 'Retarget input must be an object')
  return assertLocalVideoCandidateJobBinding({
    ...clone(binding),
    productionRevision: revision(input.productionRevision, 'input.productionRevision'),
    continuityRevision: revision(input.continuityRevision, 'input.continuityRevision'),
    storyRevision: revision(input.storyRevision, 'input.storyRevision'),
    inputFingerprint: safeId(input.inputFingerprint, 'input.inputFingerprint'),
    generationMode: input.generationMode,
    submissionId: safeId(input.submissionId, 'input.submissionId', IDEMPOTENCY_KEY_PATTERN),
  })
}

export function assertLocalVideoCandidateBackfill(backfill, bindingInput = undefined) {
  exactKeys(backfill, BACKFILL_KEYS, 'localCandidateBackfill')
  if (backfill.schemaVersion !== LOCAL_VIDEO_CANDIDATE_BACKFILL_SCHEMA_VERSION) {
    fail('UNSUPPORTED_LOCAL_CANDIDATE_BACKFILL', 'localCandidateBackfill schema is unsupported')
  }
  if (!['ready', 'rejected'].includes(backfill.status)) fail('INVALID_LOCAL_CANDIDATE_STATUS', 'Backfill status is unsupported')
  safeId(backfill.jobId, 'localCandidateBackfill.jobId')
  const binding = assertLocalVideoCandidateJobBinding(backfill.binding)
  if (bindingInput && !sameBinding(binding, assertLocalVideoCandidateJobBinding(bindingInput))) {
    fail('LOCAL_CANDIDATE_BACKFILL_MISMATCH', 'Backfill binding differs from the submitted job binding')
  }
  timestamp(backfill.createdAt, 'localCandidateBackfill.createdAt')
  if (backfill.status === 'ready') {
    safeId(backfill.libraryItemId, 'localCandidateBackfill.libraryItemId', LIBRARY_ITEM_PATTERN)
    safeId(backfill.libraryVersionId, 'localCandidateBackfill.libraryVersionId', LIBRARY_VERSION_PATTERN)
    safeId(backfill.contentHash, 'localCandidateBackfill.contentHash', CONTENT_HASH_PATTERN)
    if (backfill.mimeType !== 'video/mp4') fail('INVALID_LOCAL_CANDIDATE_MIME', 'Local H3 candidate output must be video/mp4')
    if (backfill.code !== null || backfill.message !== null) fail('INVALID_LOCAL_CANDIDATE_RESULT', 'Ready backfill cannot carry an error')
  } else {
    if (backfill.libraryItemId !== null || backfill.libraryVersionId !== null || backfill.contentHash !== null || backfill.mimeType !== null) {
      fail('INVALID_LOCAL_CANDIDATE_RESULT', 'Rejected backfill cannot carry a library asset')
    }
    safeId(backfill.code, 'localCandidateBackfill.code')
    if (typeof backfill.message !== 'string' || !backfill.message.trim() || backfill.message.length > 1_000) {
      fail('INVALID_LOCAL_CANDIDATE_RESULT', 'Rejected backfill must carry a bounded message')
    }
  }
  return backfill
}

export function createReadyLocalVideoCandidateBackfill(input) {
  const binding = assertLocalVideoCandidateJobBinding(input.binding)
  const asset = input.libraryAsset
  if (!isRecord(asset) || !isRecord(asset.version)) fail('INVALID_LOCAL_CANDIDATE_ASSET', 'Library asset is invalid')
  return assertLocalVideoCandidateBackfill({
    schemaVersion: LOCAL_VIDEO_CANDIDATE_BACKFILL_SCHEMA_VERSION,
    status: 'ready',
    jobId: input.jobId,
    binding: clone(binding),
    libraryItemId: asset.id,
    libraryVersionId: asset.version.id,
    contentHash: asset.version.assetId,
    mimeType: asset.version.mimeType,
    code: null,
    message: null,
    createdAt: input.now,
  }, binding)
}

export function createRejectedLocalVideoCandidateBackfill(input) {
  const binding = assertLocalVideoCandidateJobBinding(input.binding)
  const normalizedCode = String(input.code || 'LOCAL_CANDIDATE_BACKFILL_FAILED')
    .toUpperCase()
    .replace(/[^A-Z0-9._:-]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, 120) || 'LOCAL_CANDIDATE_BACKFILL_FAILED'
  return assertLocalVideoCandidateBackfill({
    schemaVersion: LOCAL_VIDEO_CANDIDATE_BACKFILL_SCHEMA_VERSION,
    status: 'rejected',
    jobId: input.jobId,
    binding: clone(binding),
    libraryItemId: null,
    libraryVersionId: null,
    contentHash: null,
    mimeType: null,
    code: normalizedCode,
    message: String(input.message || 'Local H3 candidate backfill failed').slice(0, 1_000),
    createdAt: input.now,
  }, binding)
}

export function reconcileLocalVideoCandidateJob(productionInput, job, workspace) {
  const rawBinding = isRecord(job?.request) && isRecord(job.request.candidateBinding)
    ? job.request.candidateBinding
    : null
  if (!rawBinding) return { status: 'ignored', key: null }
  if (rawBinding.projectId !== workspace?.projectId || rawBinding.documentId !== workspace?.documentId) {
    return { status: 'foreign', key: null }
  }
  let binding
  try {
    binding = assertLocalVideoCandidateJobBinding(rawBinding)
  } catch (error) {
    return errorResult(error?.code || 'INVALID_LOCAL_CANDIDATE_BINDING', error?.message || '本地候选身份无效')
  }
  const key = `${job?.id || 'unknown'}:${binding.submissionId}`
  try {
    const production = assertVideoProductionProject(productionInput)
    if (job?.kind !== 'video') return errorResult('LOCAL_CANDIDATE_KIND_MISMATCH', '本地候选回填只接受单镜头视频任务', key)
    if (job.status !== 'completed') return { status: 'pending', key }
    if (production.id !== binding.productionId
      || production.continuityGraph.storyProjectId !== binding.documentId) {
      return errorResult('LOCAL_CANDIDATE_PRODUCTION_MISMATCH', '任务不属于当前制片文档', key)
    }
    if (production.continuityGraph.storyRevision !== binding.storyRevision) {
      return errorResult('LOCAL_CANDIDATE_STORY_STALE', '故事版本已变化；本次视频仅保留为任务输出，不回填镜头', key)
    }
    if (production.settings.generationMode !== binding.generationMode) {
      return errorResult('LOCAL_CANDIDATE_MODE_STALE', '生成策略已变化；本次视频不回填当前镜头', key)
    }
    const shot = production.continuityGraph.shots.find(({ id }) => id === binding.shotId)
    if (!shot) return errorResult('LOCAL_CANDIDATE_SHOT_NOT_FOUND', '目标镜头已不存在', key)
    if (shot.inputFingerprint !== binding.inputFingerprint) {
      return errorResult('LOCAL_CANDIDATE_INPUT_STALE', '镜头输入已变化；旧视频不会覆盖当前候选', key)
    }
    const backfill = assertLocalVideoCandidateBackfill(job.localCandidateBackfill, binding)
    if (backfill.jobId !== job.id) return errorResult('LOCAL_CANDIDATE_JOB_MISMATCH', '回填结果与任务身份不一致', key)
    if (backfill.status === 'rejected') return errorResult(backfill.code, backfill.message, key)
    const asset = job.libraryAsset
    if (!isRecord(asset) || !isRecord(asset.version)) {
      return errorResult('LOCAL_CANDIDATE_ASSET_MISSING', '任务完成但项目资源库版本缺失', key)
    }
    if (asset.id !== backfill.libraryItemId
      || asset.scope !== 'project'
      || asset.projectId !== binding.projectId
      || asset.relationship !== 'project-owned'
      || asset.mediaKind !== 'video'
      || asset.version.id !== backfill.libraryVersionId
      || asset.version.assetId !== backfill.contentHash
      || asset.version.mimeType !== backfill.mimeType) {
      return errorResult('LOCAL_CANDIDATE_ASSET_MISMATCH', '任务资源库版本与回填清单不一致', key)
    }
    const provenance = asset.version.provenance
    if (!isRecord(provenance)
      || provenance.source !== 'local-h3-video-candidate'
      || provenance.jobId !== job.id
      || provenance.documentId !== binding.documentId
      || provenance.shotId !== binding.shotId
      || provenance.executionItemId !== binding.executionItemId
      || provenance.submissionId !== binding.submissionId) {
      return errorResult('LOCAL_CANDIDATE_PROVENANCE_MISMATCH', '任务资源来源无法证明其镜头归属', key)
    }
    const existing = production.continuityGraph.candidates.find((candidate) => (
      candidate.shotId === shot.id
      && candidate.inputFingerprint === shot.inputFingerprint
      && candidate.asset.libraryItemId === backfill.libraryItemId
      && candidate.asset.libraryVersionId === backfill.libraryVersionId
      && candidate.asset.contentHash === backfill.contentHash
    ))
    if (existing) return { status: 'already-registered', key, candidateId: existing.id }
    return {
      status: 'ready',
      key,
      payload: {
        shotId: shot.id,
        label: String(asset.title || `${shot.label} · 本地 H3`).slice(0, 160),
        source: 'comfyui-h3',
        generationMode: binding.generationMode,
        inputFingerprint: binding.inputFingerprint,
        binding: {
          libraryItemId: backfill.libraryItemId,
          libraryVersionId: backfill.libraryVersionId,
          contentHash: backfill.contentHash,
          mimeType: backfill.mimeType,
          scope: 'project',
          boundAt: backfill.createdAt,
        },
      },
    }
  } catch (error) {
    return errorResult(error?.code || 'LOCAL_CANDIDATE_RECONCILE_FAILED', error?.message || '本地候选回填校验失败', key)
  }
}
