import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyVideoProductionCommand,
  createVideoProductionCommand,
  createVideoProductionProject,
  deserializeVideoProductionProject,
  migrateVideoProductionProject,
  serializeVideoProductionProject,
} from '../src/lib/story/productionPipeline.mjs'
import {
  assertCanConfirmMediaRun,
  assertMediaJobForRun,
  confirmMediaRun,
  createMediaRunProposal,
  evaluateMediaSupervisor,
  normalizeMediaRunPreparation,
  reconcileMediaRunJob,
} from '../src/lib/story/mediaSupervisor.mjs'

function apply(project, type, payload, now = project.updatedAt + 1) {
  return applyVideoProductionCommand(
    project,
    createVideoProductionCommand(project, type, payload, { id: `media-${type}-${project.revision + 1}` }),
    { now },
  )
}

function approvedVideoProject() {
  const project = createVideoProductionProject({ now: 1_000 })
  const next = structuredClone(project)
  for (const node of next.nodes) {
    if (node.id === 'video-director') break
    node.status = 'approved'
    node.outputSummary ||= `${node.id} approved`
  }
  next.nodes.find(({ id }) => id === 'video-director').status = 'ready'
  return next
}

function proposal(project = approvedVideoProject(), overrides = {}) {
  return createMediaRunProposal({
    nodeId: 'video-director',
    kind: 'video',
    targetId: 'shot-1',
    inputFingerprint: 'fingerprint-1',
    requestSummary: '本地 H3 受控镜头任务',
    ...overrides,
  }, { now: project.updatedAt + 1 })
}

test('migrates v5 production exports to v6 with an empty portable media run list', () => {
  const current = createVideoProductionProject({ now: 1_000 })
  const legacy = structuredClone(current)
  legacy.schemaVersion = 5
  const restored = migrateVideoProductionProject(legacy, { now: 1_001 })
  assert.equal(restored.schemaVersion, 6)
  assert.deepEqual(restored.mediaRuns, [])
})

test('propose records a media candidate without invoking any execution callback', () => {
  const initial = approvedVideoProject()
  const run = proposal(initial)
  const proposed = apply(initial, 'media-runs.propose', { run })
  assert.equal(proposed.mediaRuns.length, 1)
  assert.equal(proposed.mediaRuns[0].status, 'proposed')
  assert.equal(evaluateMediaSupervisor(proposed).status, 'media-proposed')
})

test('confirm gates reject pause, unapproved dependencies, stale input, and duplicate active runs', () => {
  const initial = approvedVideoProject()
  const run = proposal(initial)
  let project = apply(initial, 'media-runs.propose', { run })
  assert.doesNotThrow(() => assertCanConfirmMediaRun(project, run.id, { currentInputFingerprint: 'fingerprint-1' }))

  assert.throws(
    () => assertCanConfirmMediaRun({ ...project, globalPaused: true }, run.id, { currentInputFingerprint: 'fingerprint-1' }),
    (error) => error.code === 'MEDIA_PROJECT_PAUSED',
  )
  const stale = structuredClone(project)
  stale.nodes.find(({ id }) => id === 'asset-producer').status = 'review'
  assert.throws(
    () => assertCanConfirmMediaRun(stale, run.id, { currentInputFingerprint: 'fingerprint-1' }),
    (error) => error.code === 'MEDIA_DEPENDENCY_NOT_APPROVED',
  )
  assert.throws(
    () => assertCanConfirmMediaRun(project, run.id, { currentInputFingerprint: 'fingerprint-2' }),
    (error) => error.code === 'MEDIA_INPUT_STALE',
  )
  project = apply(project, 'media-runs.attach-job', { runId: run.id, jobId: 'job-1', status: 'queued' })
  const second = proposal(project, { id: 'media-run-second' })
  project = apply(project, 'media-runs.propose', { run: second })
  assert.throws(
    () => assertCanConfirmMediaRun(project, second.id, { currentInputFingerprint: 'fingerprint-1' }),
    (error) => error.code === 'MEDIA_ACTIVE_RUN_EXISTS',
  )
})

test('confirm invokes the execution callback only after all gates and validates its managed Job', async () => {
  const initial = approvedVideoProject()
  const run = proposal(initial, { id: 'media-run-confirm' })
  const project = apply(initial, 'media-runs.propose', { run })
  let calls = 0
  await assert.rejects(
    confirmMediaRun({ ...project, globalPaused: true }, run.id, {
      currentInputFingerprint: run.inputFingerprint,
      onRunMediaStep: async () => { calls += 1; throw new Error('must not run') },
    }),
    (error) => error.code === 'MEDIA_PROJECT_PAUSED',
  )
  assert.equal(calls, 0)
  const job = await confirmMediaRun(project, run.id, {
    projectId: 'project-1',
    documentId: 'document-1',
    currentInputFingerprint: run.inputFingerprint,
    onRunMediaStep: async () => {
      calls += 1
      return {
        id: 'confirm-job',
        kind: 'video',
        status: 'queued',
        mediaBinding: { projectId: 'project-1', documentId: 'document-1', runId: run.id, inputFingerprint: run.inputFingerprint },
        request: { targetId: run.targetId },
      }
    },
  })
  assert.equal(job.id, 'confirm-job')
  assert.equal(calls, 1)
})

test('attach-job rejects wrong or cross-target jobs and binds a proposal only once', () => {
  const project = approvedVideoProject()
  const run = proposal(project)
  const proposed = apply(project, 'media-runs.propose', { run })
  const job = {
    id: 'job-1',
    kind: 'video',
    status: 'queued',
    mediaBinding: { projectId: 'project-1', documentId: 'document-1', runId: run.id, inputFingerprint: run.inputFingerprint },
    request: { projectId: 'project-1', documentId: 'document-1', targetId: 'shot-1', inputFingerprint: 'fingerprint-1' },
  }
  assert.doesNotThrow(() => assertMediaJobForRun(run, job, { projectId: 'project-1', documentId: 'document-1' }))
  assert.throws(
    () => assertMediaJobForRun(run, { ...job, request: { ...job.request, targetId: 'shot-2' } }, { projectId: 'project-1', documentId: 'document-1' }),
    (error) => error.code === 'MEDIA_JOB_TARGET_MISMATCH',
  )
  assert.throws(
    () => assertMediaJobForRun(run, { ...job, kind: 'sound-render' }, { projectId: 'project-1', documentId: 'document-1' }),
    (error) => error.code === 'MEDIA_JOB_KIND_MISMATCH',
  )
  const attached = apply(proposed, 'media-runs.attach-job', { runId: run.id, jobId: job.id, status: 'queued' })
  assert.equal(attached.mediaRuns[0].jobId, job.id)
  assert.throws(
    () => apply(attached, 'media-runs.attach-job', { runId: run.id, jobId: 'job-2', status: 'queued' }),
    (error) => error.code === 'MEDIA_RUN_NOT_PROPOSED',
  )
})

test('media jobs require strict project/document/run/fingerprint binding fields', () => {
  const project = approvedVideoProject()
  const run = proposal(project)
  const baseJob = {
    id: 'job-strict',
    kind: 'video',
    status: 'queued',
    request: { targetId: 'shot-1' },
  }
  assert.throws(
    () => assertMediaJobForRun(run, baseJob, { projectId: 'project-1', documentId: 'document-1' }),
    (error) => error.code === 'MEDIA_JOB_BINDING_INVALID',
  )
  const binding = { projectId: 'project-1', documentId: 'document-1', runId: run.id, inputFingerprint: run.inputFingerprint }
  assert.doesNotThrow(() => assertMediaJobForRun(run, { ...baseJob, mediaBinding: binding }, { projectId: 'project-1', documentId: 'document-1' }))
  for (const [field, value, code] of [
    ['projectId', 'project-2', 'MEDIA_JOB_PROJECT_MISMATCH'],
    ['documentId', 'document-2', 'MEDIA_JOB_DOCUMENT_MISMATCH'],
    ['runId', 'other-run', 'MEDIA_JOB_RUN_MISMATCH'],
    ['inputFingerprint', 'other-fingerprint', 'MEDIA_JOB_INPUT_MISMATCH'],
  ]) {
    assert.throws(
      () => assertMediaJobForRun(run, { ...baseJob, mediaBinding: { ...binding, [field]: value } }, { projectId: 'project-1', documentId: 'document-1' }),
      (error) => error.code === code,
    )
  }
})

test('reconcile is terminal and idempotent; completion remains at human review', () => {
  const initial = approvedVideoProject()
  const run = proposal(initial)
  let project = apply(initial, 'media-runs.propose', { run })
  project = apply(project, 'media-runs.attach-job', { runId: run.id, jobId: 'job-1', status: 'running' })
  project = apply(project, 'media-runs.reconcile', { runId: run.id, jobId: 'job-1', status: 'completed', errorCode: null })
  assert.equal(evaluateMediaSupervisor(project).status, 'media-review')
  const revision = project.revision
  const same = apply(project, 'media-runs.reconcile', { runId: run.id, jobId: 'job-1', status: 'completed', errorCode: null }, project.updatedAt + 1)
  assert.equal(same.revision, revision)
  assert.equal(same.mediaRuns[0].status, 'completed')
  assert.equal(same.mediaRuns[0].jobId, 'job-1')
})

test('media run references survive project serialization and refresh-style job lookup', () => {
  const initial = approvedVideoProject()
  const run = proposal(initial, { id: 'media-run-refresh' })
  let project = apply(initial, 'media-runs.propose', { run })
  project = apply(project, 'media-runs.attach-job', { runId: run.id, jobId: 'job-refresh', status: 'queued' })
  const restored = deserializeVideoProductionProject(serializeVideoProductionProject(project))
  assert.deepEqual(restored.mediaRuns, project.mediaRuns)
  const job = {
    id: 'job-refresh',
    kind: 'video',
    status: 'completed',
    mediaBinding: { projectId: 'project-1', documentId: 'document-1', runId: run.id, inputFingerprint: run.inputFingerprint },
    request: { targetId: run.targetId },
  }
  assert.equal(reconcileMediaRunJob(restored, run.id, job, { projectId: 'project-1', documentId: 'document-1' }).changed, true)
})

test('approved nodes and superseded terminal media runs do not hold the supervisor at an old result', () => {
  const project = approvedVideoProject()
  const first = { ...proposal(project, { id: 'old-complete' }), status: 'completed', jobId: 'job-old' }
  const failed = { ...proposal(project, { id: 'new-failure' }), status: 'failed', jobId: 'job-new', updatedAt: first.updatedAt + 1, errorCode: 'RENDER_FAILED' }
  project.mediaRuns = [first, failed]
  assert.equal(evaluateMediaSupervisor(project).run.id, failed.id)
  project.nodes.find(({ id }) => id === 'video-director').status = 'approved'
  assert.equal(evaluateMediaSupervisor(project).status, 'none')
  assert.equal(project.mediaRuns.length, 2, 'history is preserved after review')
})

test('inherited node names cannot enter the media node allowlist', () => {
  assert.throws(() => proposal(undefined, { nodeId: 'constructor' }), { code: 'MEDIA_NODE_UNSUPPORTED' })
})

test('rejected and stale proposals cannot be attached or executed', () => {
  const initial = approvedVideoProject()
  const run = proposal(initial)
  let project = apply(initial, 'media-runs.propose', { run })
  project = apply(project, 'media-runs.reject', { runId: run.id, errorCode: 'USER_REJECTED' })
  assert.throws(
    () => apply(project, 'media-runs.attach-job', { runId: run.id, jobId: 'job-rejected', status: 'queued' }),
    (error) => error.code === 'MEDIA_RUN_NOT_PROPOSED',
  )
  const staleRun = proposal(project, { id: 'media-run-stale', inputFingerprint: 'old-fingerprint' })
  project = apply(project, 'media-runs.propose', { run: staleRun })
  const edited = structuredClone(project)
  edited.nodes.find(({ id }) => id === 'storyboard-director').revision += 1
  edited.nodes.find(({ id }) => id === 'storyboard-director').status = 'revision'
  assert.throws(
    () => assertCanConfirmMediaRun(edited, staleRun.id, { currentInputFingerprint: 'new-fingerprint' }),
    (error) => error.code === 'MEDIA_INPUT_STALE',
  )
})

test('media preparation descriptors are strict, copied, kind-bound, and preserve legacy records', () => {
  const imageInput = {
    kind: 'image',
    workflowId: 'workflow-image',
    sourceLibraryItemId: 'library-source',
    sourceContentHash: 'a'.repeat(64),
    lastFrameLibraryItemId: 'library-last',
    lastFrameContentHash: 'b'.repeat(64),
  }
  const image = normalizeMediaRunPreparation('image', imageInput)
  assert.deepEqual(image, imageInput)
  imageInput.sourceLibraryItemId = 'mutated'
  assert.equal(image.sourceLibraryItemId, 'library-source')
  const speech = normalizeMediaRunPreparation('prepare-speech', { kind: 'prepare-speech', speechBudgetUsd: 12.5 })
  assert.deepEqual(speech, { kind: 'prepare-speech', speechBudgetUsd: 12.5 })
  assert.equal(normalizeMediaRunPreparation('video', undefined), undefined)
  const legacy = proposal()
  assert.equal(Object.hasOwn(legacy, 'preparation'), false)
  const described = createMediaRunProposal({
    id: 'media-run-prepared', nodeId: 'asset-producer', kind: 'image', targetId: 'workflow-image',
    inputFingerprint: legacy.inputFingerprint, requestSummary: legacy.requestSummary, preparation: image,
  }, { now: 2_000 })
  assert.deepEqual(described.preparation, image)
  const projectWithPreparation = apply(approvedVideoProject(), 'media-runs.propose', { run: described })
  const restored = deserializeVideoProductionProject(serializeVideoProductionProject(projectWithPreparation))
  assert.deepEqual(restored.mediaRuns[0].preparation, image)
  const speechRun = createMediaRunProposal({
    id: 'media-run-speech-prepared', nodeId: 'sound-director', kind: 'prepare-speech', targetId: null,
    inputFingerprint: legacy.inputFingerprint, requestSummary: legacy.requestSummary,
    preparation: speech,
  }, { now: 2_001 })
  const restoredSpeech = deserializeVideoProductionProject(serializeVideoProductionProject(
    apply(approvedVideoProject(), 'media-runs.propose', { run: speechRun }),
  ))
  assert.deepEqual(restoredSpeech.mediaRuns[0].preparation, speech)
  const legacyProject = apply(approvedVideoProject(), 'media-runs.propose', { run: legacy })
  assert.equal(Object.hasOwn(JSON.parse(serializeVideoProductionProject(legacyProject)).mediaRuns[0], 'preparation'), false)
  for (const [kind, value, code] of [
    ['image', { kind: 'prepare-speech', speechBudgetUsd: 1 }, 'MEDIA_PREPARATION_KIND_MISMATCH'],
    ['image', { kind: 'image', workflowId: 'workflow-image', sourceContentHash: 'a'.repeat(64) }, 'MEDIA_PREPARATION_PAIR_REQUIRED'],
    ['image', { kind: 'image', workflowId: 'workflow-image', sourceLibraryItemId: 'library-source', sourceContentHash: 'A'.repeat(64) }, 'MEDIA_PREPARATION_INVALID_HASH'],
    ['image', { kind: 'image', workflowId: 'workflow-image', sourceLibraryItemId: 'C:\\secret', sourceContentHash: 'a'.repeat(64) }, 'MEDIA_INVALID_ID'],
    ['image', { kind: 'image', workflowId: 'workflow-image', prompt: 'secret' }, 'MEDIA_UNKNOWN_FIELD'],
    ['prepare-speech', { kind: 'prepare-speech', speechBudgetUsd: 0 }, 'MEDIA_PREPARATION_INVALID_BUDGET'],
    ['prepare-speech', { kind: 'prepare-speech', speechBudgetUsd: 51 }, 'MEDIA_PREPARATION_INVALID_BUDGET'],
  ]) {
    assert.throws(
      () => normalizeMediaRunPreparation(kind, value),
      (error) => error.code === code,
    )
  }
})
