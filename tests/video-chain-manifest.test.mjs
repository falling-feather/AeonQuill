import assert from 'node:assert/strict'
import test from 'node:test'
import { createReadyLocalVideoCandidateBackfill } from '../src/lib/story/localVideoCandidate.mjs'
import {
  assertVideoChainManifest,
  createVideoChainManifest,
  transitionVideoChainManifestShot,
} from '../src/lib/story/videoChainManifest.mjs'

const NOW = 1_800_000_000_000
const HASH_ONE = '1'.repeat(64)
const HASH_TWO = '2'.repeat(64)
const CHILD_ONE = 'video-11111111-1111-4111-8111-111111111111'
const CHILD_TWO = 'video-22222222-2222-4222-8222-222222222222'
const SUBMISSION_ONE = 'video-chain:parent-11111111:shot:0'
const SUBMISSION_TWO = 'video-chain:parent-11111111:shot:1'

function target(overrides = {}) {
  return {
    schemaVersion: 1,
    projectId: 'chain-project',
    documentId: 'chain-document',
    productionId: 'production-chain-001',
    productionRevision: 12,
    continuityRevision: 8,
    storyRevision: 3,
    shotId: 'continuity-shot-001',
    inputFingerprint: 'fingerprint-chain-shot-001',
    generationMode: 'quality',
    executionItemId: 'execution-chain-001',
    ...overrides,
  }
}

function manifest() {
  return createVideoChainManifest({
    projectId: 'chain-project',
    shots: [
      { executionItemId: 'execution-chain-001', requestHash: HASH_ONE, candidateTarget: target() },
      { executionItemId: 'execution-chain-002', requestHash: HASH_TWO },
    ],
    now: NOW,
  })
}

function readyBackfill() {
  const binding = { ...target(), submissionId: SUBMISSION_ONE }
  return createReadyLocalVideoCandidateBackfill({
    jobId: CHILD_ONE,
    binding,
    libraryAsset: {
      id: 'library-chain-candidate-001',
      version: {
        id: 'library-version-11111111111111111111111111111111',
        assetId: 'a'.repeat(64),
        mimeType: 'video/mp4',
      },
    },
    now: NOW + 20,
  })
}

test('creates an exact ordered chain manifest and rejects duplicate or cross-scope targets', () => {
  const created = manifest()
  assert.equal(created.schemaVersion, 1)
  assert.deepEqual(created.shots.map(({ index, status }) => ({ index, status })), [
    { index: 0, status: 'planned' },
    { index: 1, status: 'planned' },
  ])
  assert.equal(created.shots[0].candidateTarget.shotId, 'continuity-shot-001')
  assert.equal(created.shots[1].candidateTarget, null)
  assert.throws(
    () => assertVideoChainManifest({ ...created, debugPath: 'D:/private/output.mp4' }),
    (error) => error.code === 'INVALID_VIDEO_CHAIN_MANIFEST_FIELDS',
  )
  assert.throws(
    () => createVideoChainManifest({
      projectId: 'chain-project',
      shots: [
        { executionItemId: 'execution-chain-001', requestHash: HASH_ONE, candidateTarget: target() },
        { executionItemId: 'execution-chain-001', requestHash: HASH_TWO },
      ],
      now: NOW,
    }),
    (error) => error.code === 'DUPLICATE_VIDEO_CHAIN_EXECUTION_ITEM',
  )
  assert.throws(
    () => createVideoChainManifest({
      projectId: 'chain-project',
      shots: [
        { executionItemId: 'execution-chain-001', requestHash: HASH_ONE, candidateTarget: target() },
        {
          executionItemId: 'execution-chain-002',
          requestHash: HASH_TWO,
          candidateTarget: target({
            executionItemId: 'execution-chain-002',
            shotId: 'continuity-shot-002',
            productionRevision: 13,
          }),
        },
      ],
      now: NOW,
    }),
    (error) => error.code === 'VIDEO_CHAIN_CANDIDATE_SCOPE_MISMATCH',
  )
})

test('persists queued, completed and reused child identity with candidate backfill proof', () => {
  const queued = transitionVideoChainManifestShot(manifest(), 0, {
    status: 'queued',
    childJobId: CHILD_ONE,
    childSubmissionId: SUBMISSION_ONE,
    reusedFromChildJobId: null,
    localCandidateBackfill: null,
    error: null,
  }, { now: NOW + 10 })
  const completed = transitionVideoChainManifestShot(queued, 0, {
    status: 'completed',
    childJobId: CHILD_ONE,
    childSubmissionId: SUBMISSION_ONE,
    reusedFromChildJobId: null,
    localCandidateBackfill: readyBackfill(),
    error: null,
  }, { now: NOW + 20 })
  assert.equal(completed.shots[0].localCandidateBackfill.status, 'ready')

  const queuedSecond = transitionVideoChainManifestShot(completed, 1, {
    status: 'queued',
    childJobId: CHILD_TWO,
    childSubmissionId: SUBMISSION_TWO,
    reusedFromChildJobId: null,
    localCandidateBackfill: null,
    error: null,
  }, { now: NOW + 30 })
  const completedSecond = transitionVideoChainManifestShot(queuedSecond, 1, {
    status: 'completed',
    childJobId: CHILD_TWO,
    childSubmissionId: SUBMISSION_TWO,
    reusedFromChildJobId: null,
    localCandidateBackfill: null,
    error: null,
  }, { now: NOW + 40 })
  assert.deepEqual(completedSecond.shots.map(({ childJobId }) => childJobId), [CHILD_ONE, CHILD_TWO])

  const reused = transitionVideoChainManifestShot(manifest(), 0, {
    status: 'reused',
    childJobId: CHILD_ONE,
    childSubmissionId: SUBMISSION_ONE,
    reusedFromChildJobId: CHILD_ONE,
    localCandidateBackfill: readyBackfill(),
    error: null,
  }, { now: NOW + 50 })
  assert.equal(reused.shots[0].status, 'reused')
})

test('fails closed for missing, rejected, cross-job or tampered candidate completion evidence', () => {
  const queued = transitionVideoChainManifestShot(manifest(), 0, {
    status: 'queued',
    childJobId: CHILD_ONE,
    childSubmissionId: SUBMISSION_ONE,
    reusedFromChildJobId: null,
    localCandidateBackfill: null,
    error: null,
  })
  assert.throws(
    () => transitionVideoChainManifestShot(queued, 0, {
      status: 'completed',
      childJobId: CHILD_ONE,
      childSubmissionId: SUBMISSION_ONE,
      reusedFromChildJobId: null,
      localCandidateBackfill: null,
      error: null,
    }),
    (error) => error.code === 'INVALID_VIDEO_CHAIN_SHOT_STATE',
  )
  assert.throws(
    () => transitionVideoChainManifestShot(queued, 0, {
      status: 'completed',
      childJobId: CHILD_ONE,
      childSubmissionId: SUBMISSION_ONE,
      reusedFromChildJobId: null,
      localCandidateBackfill: { ...readyBackfill(), jobId: CHILD_TWO },
      error: null,
    }),
    (error) => error.code === 'VIDEO_CHAIN_BACKFILL_MISMATCH',
  )
  assert.throws(
    () => transitionVideoChainManifestShot(manifest(), 0, {
      status: 'queued',
      childJobId: CHILD_ONE,
      childSubmissionId: SUBMISSION_ONE,
      reusedFromChildJobId: null,
      localCandidateBackfill: null,
      error: null,
      requestHash: 'f'.repeat(64),
    }),
    (error) => error.code === 'INVALID_VIDEO_CHAIN_SHOT_TRANSITION',
  )
})
