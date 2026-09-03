import {
  assertLocalVideoCandidateBackfill,
  assertLocalVideoCandidateTarget,
  localVideoCandidateTargetMatchesBinding,
} from './localVideoCandidate.mjs'

export const VIDEO_CHAIN_MANIFEST_SCHEMA_VERSION = 1

const SAFE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,199}$/u
const IDEMPOTENCY_KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/u
const CONTENT_HASH_PATTERN = /^[a-f0-9]{64}$/u
const MANIFEST_KEYS = Object.freeze(['schemaVersion', 'projectId', 'createdAt', 'shots'])
const SHOT_KEYS = Object.freeze([
  'index',
  'executionItemId',
  'requestHash',
  'candidateTarget',
  'childJobId',
  'childSubmissionId',
  'reusedFromChildJobId',
  'status',
  'localCandidateBackfill',
  'error',
  'updatedAt',
])
const ERROR_KEYS = Object.freeze(['code', 'message'])
const TRANSITION_KEYS = new Set([
  'status',
  'childJobId',
  'childSubmissionId',
  'reusedFromChildJobId',
  'localCandidateBackfill',
  'error',
])
const STATUSES = new Set(['planned', 'queued', 'completed', 'reused', 'failed'])

export class VideoChainManifestError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'VideoChainManifestError'
    this.code = code
    this.details = details
  }
}

function fail(code, message, details) {
  throw new VideoChainManifestError(code, message, details)
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value, keys, path) {
  if (!isRecord(value)) fail('INVALID_VIDEO_CHAIN_MANIFEST_OBJECT', `${path} must be an object`)
  const expected = new Set(keys)
  const unknown = Object.keys(value).filter((key) => !expected.has(key))
  const missing = keys.filter((key) => !Object.hasOwn(value, key))
  if (unknown.length || missing.length) {
    fail('INVALID_VIDEO_CHAIN_MANIFEST_FIELDS', `${path} fields do not match the supported schema`, {
      path,
      unknown,
      missing,
    })
  }
}

function safeId(value, path, pattern = SAFE_ID_PATTERN) {
  if (typeof value !== 'string' || !pattern.test(value)) fail('INVALID_VIDEO_CHAIN_MANIFEST_ID', `${path} is invalid`)
  return value
}

function timestamp(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_VIDEO_CHAIN_MANIFEST_TIMESTAMP', `${path} is invalid`)
  return value
}

function nullable(value, validator, path) {
  if (value === null) return null
  return validator(value, path)
}

function manifestError(value, path) {
  exactKeys(value, ERROR_KEYS, path)
  safeId(value.code, `${path}.code`)
  if (typeof value.message !== 'string' || !value.message.trim() || value.message.length > 1_000) {
    fail('INVALID_VIDEO_CHAIN_MANIFEST_ERROR', `${path}.message is invalid`)
  }
  return value
}

function validateShotState(shot, path) {
  const hasChild = shot.childJobId !== null
  const hasSubmission = shot.childSubmissionId !== null
  if (hasChild !== hasSubmission) fail('INVALID_VIDEO_CHAIN_SHOT_STATE', `${path} child identity is incomplete`)
  if (shot.status === 'planned') {
    if (hasChild || shot.reusedFromChildJobId !== null || shot.localCandidateBackfill !== null || shot.error !== null) {
      fail('INVALID_VIDEO_CHAIN_SHOT_STATE', `${path} planned state carries execution output`)
    }
    return
  }
  if (shot.status === 'queued') {
    if (!hasChild || shot.reusedFromChildJobId !== null || shot.localCandidateBackfill !== null || shot.error !== null) {
      fail('INVALID_VIDEO_CHAIN_SHOT_STATE', `${path} queued state is incomplete`)
    }
    return
  }
  if (shot.status === 'completed') {
    if (!hasChild || shot.reusedFromChildJobId !== null || shot.error !== null) {
      fail('INVALID_VIDEO_CHAIN_SHOT_STATE', `${path} completed state is incomplete`)
    }
    if (Boolean(shot.candidateTarget) !== Boolean(shot.localCandidateBackfill)) {
      fail('INVALID_VIDEO_CHAIN_SHOT_STATE', `${path} completed candidate state does not match its target`)
    }
    return
  }
  if (shot.status === 'reused') {
    if (!hasChild || shot.reusedFromChildJobId !== shot.childJobId || shot.error !== null) {
      fail('INVALID_VIDEO_CHAIN_SHOT_STATE', `${path} reused state is incomplete`)
    }
    if (Boolean(shot.candidateTarget) !== Boolean(shot.localCandidateBackfill)) {
      fail('INVALID_VIDEO_CHAIN_SHOT_STATE', `${path} reused candidate state does not match its target`)
    }
    if (shot.localCandidateBackfill?.status === 'rejected') {
      fail('INVALID_VIDEO_CHAIN_SHOT_STATE', `${path} cannot reuse a rejected candidate backfill`)
    }
    return
  }
  if (shot.status === 'failed' && (shot.reusedFromChildJobId !== null || shot.localCandidateBackfill !== null || shot.error === null)) {
    fail('INVALID_VIDEO_CHAIN_SHOT_STATE', `${path} failed state is incomplete`)
  }
}

export function assertVideoChainManifest(manifest) {
  exactKeys(manifest, MANIFEST_KEYS, 'videoChainManifest')
  if (manifest.schemaVersion !== VIDEO_CHAIN_MANIFEST_SCHEMA_VERSION) {
    fail('UNSUPPORTED_VIDEO_CHAIN_MANIFEST', 'videoChainManifest schema is unsupported')
  }
  safeId(manifest.projectId, 'videoChainManifest.projectId')
  timestamp(manifest.createdAt, 'videoChainManifest.createdAt')
  if (!Array.isArray(manifest.shots) || manifest.shots.length < 2 || manifest.shots.length > 24) {
    fail('INVALID_VIDEO_CHAIN_MANIFEST_SHOTS', 'videoChainManifest requires 2–24 shots')
  }
  const executionIds = new Set()
  const candidateShotIds = new Set()
  let candidateScope = null
  manifest.shots.forEach((shot, index) => {
    const path = `videoChainManifest.shots[${index}]`
    exactKeys(shot, SHOT_KEYS, path)
    if (shot.index !== index) fail('INVALID_VIDEO_CHAIN_SHOT_ORDER', `${path}.index must be contiguous`)
    safeId(shot.executionItemId, `${path}.executionItemId`)
    if (executionIds.has(shot.executionItemId)) fail('DUPLICATE_VIDEO_CHAIN_EXECUTION_ITEM', `${path}.executionItemId is duplicated`)
    executionIds.add(shot.executionItemId)
    if (typeof shot.requestHash !== 'string' || !CONTENT_HASH_PATTERN.test(shot.requestHash)) {
      fail('INVALID_VIDEO_CHAIN_REQUEST_HASH', `${path}.requestHash is invalid`)
    }
    if (shot.candidateTarget !== null) {
      const target = assertLocalVideoCandidateTarget(shot.candidateTarget)
      if (target.projectId !== manifest.projectId || target.executionItemId !== shot.executionItemId) {
        fail('VIDEO_CHAIN_CANDIDATE_TARGET_MISMATCH', `${path}.candidateTarget does not belong to this execution item`)
      }
      if (candidateShotIds.has(target.shotId)) fail('DUPLICATE_VIDEO_CHAIN_CANDIDATE_SHOT', `${path}.candidateTarget.shotId is duplicated`)
      candidateShotIds.add(target.shotId)
      const scope = [
        target.projectId,
        target.documentId,
        target.productionId,
        target.productionRevision,
        target.continuityRevision,
        target.storyRevision,
        target.generationMode,
      ].join('\0')
      if (candidateScope !== null && candidateScope !== scope) {
        fail('VIDEO_CHAIN_CANDIDATE_SCOPE_MISMATCH', 'All candidate targets in one chain must share production authority')
      }
      candidateScope = scope
    }
    nullable(shot.childJobId, safeId, `${path}.childJobId`)
    nullable(shot.childSubmissionId, (value, field) => safeId(value, field, IDEMPOTENCY_KEY_PATTERN), `${path}.childSubmissionId`)
    nullable(shot.reusedFromChildJobId, safeId, `${path}.reusedFromChildJobId`)
    if (!STATUSES.has(shot.status)) fail('INVALID_VIDEO_CHAIN_SHOT_STATUS', `${path}.status is unsupported`)
    if (shot.localCandidateBackfill !== null) {
      const backfill = assertLocalVideoCandidateBackfill(shot.localCandidateBackfill)
      if (backfill.jobId !== shot.childJobId
        || !shot.candidateTarget
        || !localVideoCandidateTargetMatchesBinding(shot.candidateTarget, backfill.binding)) {
        fail('VIDEO_CHAIN_BACKFILL_MISMATCH', `${path}.localCandidateBackfill does not prove this shot target`)
      }
    }
    if (shot.error !== null) manifestError(shot.error, `${path}.error`)
    timestamp(shot.updatedAt, `${path}.updatedAt`)
    if (shot.updatedAt < manifest.createdAt) fail('INVALID_VIDEO_CHAIN_MANIFEST_TIMESTAMP', `${path}.updatedAt predates the manifest`)
    validateShotState(shot, path)
  })
  return manifest
}

export function createVideoChainManifest(input) {
  if (!isRecord(input) || !Array.isArray(input.shots)) {
    fail('INVALID_VIDEO_CHAIN_MANIFEST_INPUT', 'Video chain manifest input is invalid')
  }
  const createdAt = timestamp(input.now, 'input.now')
  return assertVideoChainManifest({
    schemaVersion: VIDEO_CHAIN_MANIFEST_SCHEMA_VERSION,
    projectId: input.projectId,
    createdAt,
    shots: input.shots.map((shot, index) => ({
      index,
      executionItemId: shot.executionItemId,
      requestHash: shot.requestHash,
      candidateTarget: shot.candidateTarget ? structuredClone(shot.candidateTarget) : null,
      childJobId: null,
      childSubmissionId: null,
      reusedFromChildJobId: null,
      status: 'planned',
      localCandidateBackfill: null,
      error: null,
      updatedAt: createdAt,
    })),
  })
}

export function transitionVideoChainManifestShot(manifestInput, index, patch, options = {}) {
  const manifest = assertVideoChainManifest(manifestInput)
  if (!Number.isSafeInteger(index) || index < 0 || index >= manifest.shots.length) {
    fail('INVALID_VIDEO_CHAIN_SHOT_INDEX', 'Video chain shot index is invalid')
  }
  if (!isRecord(patch) || Object.keys(patch).some((key) => !TRANSITION_KEYS.has(key))) {
    fail('INVALID_VIDEO_CHAIN_SHOT_TRANSITION', 'Video chain shot transition fields are invalid')
  }
  const now = timestamp(options.now ?? Math.max(Date.now(), manifest.shots[index].updatedAt), 'options.now')
  if (now < manifest.shots[index].updatedAt) {
    fail('INVALID_VIDEO_CHAIN_MANIFEST_TIMESTAMP', 'Video chain shot transitions must be monotonic')
  }
  const next = structuredClone(manifest)
  next.shots[index] = {
    ...next.shots[index],
    ...structuredClone(patch),
    updatedAt: now,
  }
  return assertVideoChainManifest(next)
}
