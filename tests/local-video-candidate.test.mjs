import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { compileStoryProject } from '../src/lib/story/storyProject.mjs'
import {
  applyVideoProductionCommand,
  createVideoProductionCommand,
  createVideoProductionProjectForStory,
} from '../src/lib/story/productionPipeline.mjs'
import {
  assertLocalVideoCandidateJobBinding,
  createLocalVideoCandidateJobBinding,
  reconcileLocalVideoCandidateJob,
  retargetLocalVideoCandidateSubmission,
} from '../src/lib/story/localVideoCandidate.mjs'
import { ProjectStore } from '../server/project-store.mjs'
import {
  authoritativeLocalVideoCandidate,
  promoteLocalVideoCandidateOutput,
} from '../server/local-video-candidate.mjs'

const SCRIPT = `场景 1：雨夜山门
镜头 1：中景，沈砚提剑走入山门。
沈砚：今夜只问旧案。`
const NOW = 1_800_000_000_000
const PROJECT_ID = 'local-candidate-project'
const DOCUMENT_ID = 'local-candidate-document'
const QA_ROOT = resolve('.runtime', 'qa-temp')

function fixture() {
  const story = compileStoryProject({
    projectId: DOCUMENT_ID,
    kind: 'script',
    text: SCRIPT,
    aspectRatio: '16:9',
    frameStrategy: 'start-end',
    defaultShotSeconds: 5,
    now: NOW,
  })
  const production = createVideoProductionProjectForStory(story, {
    generationMode: 'fast',
    characterMode: 'quick',
    now: NOW,
  })
  return { story, production }
}

function command(project, type, payload, sequence) {
  return applyVideoProductionCommand(project, createVideoProductionCommand(project, type, payload, {
    id: `local-candidate-test-${sequence}`,
    actor: 'user',
  }), { now: project.updatedAt + 1 })
}

function approveInputs(productionInput, suffix = 'initial') {
  let production = productionInput
  const slots = [
    ...production.continuityGraph.views,
    ...production.continuityGraph.wardrobes,
    ...production.continuityGraph.locations,
    ...production.continuityGraph.frames,
  ]
  let sequence = 1
  for (const slot of slots) {
    production = command(production, 'continuity.asset.bind', {
      targetId: slot.id,
      binding: {
        libraryItemId: `library-${suffix}-${sequence}`,
        libraryVersionId: `library-version-${suffix}-${sequence}`,
        contentHash: String(sequence).padStart(64, suffix === 'initial' ? '1' : '2').slice(-64),
        mimeType: 'image/png',
        scope: 'project',
        boundAt: production.updatedAt + 1,
      },
    }, sequence++)
    production = command(production, 'continuity.asset.approve', { targetId: slot.id }, sequence++)
  }
  return production
}

function bindingFor(production, submissionId = 'story-111111111111111111111111111111111111111111111111') {
  const shot = production.continuityGraph.shots[0]
  return createLocalVideoCandidateJobBinding({
    projectId: PROJECT_ID,
    documentId: DOCUMENT_ID,
    production,
    shotId: shot.id,
    executionItemId: 'execution-item-001',
    submissionId,
  })
}

function workspace(getProduction) {
  return {
    getModeDocument(documentId) {
      if (documentId !== DOCUMENT_ID) return null
      return {
        projectId: PROJECT_ID,
        documentId: DOCUMENT_ID,
        modeId: 'smart-video',
        value: JSON.stringify({ production: getProduction() }),
      }
    },
  }
}

function jobFor(id, binding, attempt = 1, retryOf = undefined) {
  return {
    id,
    kind: 'video',
    tool: 'text-to-video',
    status: 'running',
    createdAt: NOW + attempt,
    workflowVersion: 'h3-quality-matrix-v3',
    scheduling: { attempt },
    ...(retryOf ? { retryOf } : {}),
    request: {
      mode: 'text-to-video',
      prompt: '武侠人物缓慢走入雨夜山门',
      aspectRatio: '16:9',
      duration: 5,
      preset: 'fast',
      seed: 7,
      audio: false,
      candidateBinding: binding,
    },
  }
}

test('builds an exact local H3 candidate identity and rejects blocked or extended bindings', () => {
  const blocked = fixture().production
  assert.throws(
    () => bindingFor(blocked),
    (error) => error.code === 'LOCAL_CANDIDATE_SHOT_BLOCKED',
  )
  const production = approveInputs(blocked)
  const binding = bindingFor(production)
  assert.equal(binding.documentId, DOCUMENT_ID)
  assert.equal(binding.shotId, production.continuityGraph.shots[0].id)
  assert.equal(binding.inputFingerprint, production.continuityGraph.shots[0].inputFingerprint)
  assert.throws(
    () => assertLocalVideoCandidateJobBinding({ ...binding, title: '不得用标题猜测归属' }),
    (error) => error.code === 'INVALID_LOCAL_CANDIDATE_FIELDS',
  )
})

test('promotes immutable local MP4 candidates idempotently, reconciles retries, and fails closed after shot changes', async () => {
  await mkdir(QA_ROOT, { recursive: true })
  const root = join(QA_ROOT, `local-video-candidate-${randomUUID()}`)
  const outputOne = join(root, 'candidate-one.mp4')
  const outputTwo = join(root, 'candidate-two.mp4')
  const projectStore = new ProjectStore(join(root, 'projects'))
  let production = approveInputs(fixture().production)
  const workspaceStore = workspace(() => production)
  try {
    await mkdir(root, { recursive: true })
    await Promise.all([
      writeFile(outputOne, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom-one', 'ascii')])),
      writeFile(outputTwo, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom-two', 'ascii')])),
    ])
    await projectStore.open()
    const firstBinding = bindingFor(production)
    const firstJob = jobFor('video-11111111-1111-4111-8111-111111111111', firstBinding)
    assert.equal(authoritativeLocalVideoCandidate(firstBinding, { workspaceStore }).shot.id, firstBinding.shotId)
    const firstPromotion = await promoteLocalVideoCandidateOutput({
      job: firstJob,
      outputPath: outputOne,
      workspaceStore,
      projectStore,
      now: NOW + 100,
    })
    const replay = await promoteLocalVideoCandidateOutput({
      job: firstJob,
      outputPath: outputOne,
      workspaceStore,
      projectStore,
      now: NOW + 101,
    })
    assert.equal(replay.libraryAsset.id, firstPromotion.libraryAsset.id)
    assert.equal(projectStore.listLibraryAssets({ scope: 'project', projectId: PROJECT_ID }).length, 1)

    const completedFirst = {
      ...firstJob,
      status: 'completed',
      libraryAsset: firstPromotion.libraryAsset,
      localCandidateBackfill: firstPromotion.localCandidateBackfill,
    }
    const firstReconciliation = reconcileLocalVideoCandidateJob(production, completedFirst, {
      projectId: PROJECT_ID,
      documentId: DOCUMENT_ID,
    })
    assert.equal(firstReconciliation.status, 'ready')
    production = command(production, 'continuity.candidate.register', firstReconciliation.payload, 100)
    assert.equal(reconcileLocalVideoCandidateJob(production, completedFirst, {
      projectId: PROJECT_ID,
      documentId: DOCUMENT_ID,
    }).status, 'already-registered')

    const shot = production.continuityGraph.shots[0]
    const retryBinding = retargetLocalVideoCandidateSubmission(firstBinding, {
      productionRevision: production.revision,
      continuityRevision: production.continuityGraph.revision,
      storyRevision: production.continuityGraph.storyRevision,
      inputFingerprint: shot.inputFingerprint,
      generationMode: production.settings.generationMode,
      submissionId: 'retry-22222222-2222-4222-8222-222222222222',
    })
    const retryJob = jobFor('video-22222222-2222-4222-8222-222222222222', retryBinding, 2, firstJob.id)
    const retryPromotion = await promoteLocalVideoCandidateOutput({
      job: retryJob,
      outputPath: outputTwo,
      workspaceStore,
      projectStore,
      now: NOW + 200,
    })
    const completedRetry = {
      ...retryJob,
      status: 'completed',
      libraryAsset: retryPromotion.libraryAsset,
      localCandidateBackfill: retryPromotion.localCandidateBackfill,
    }
    const retryReconciliation = reconcileLocalVideoCandidateJob(production, completedRetry, {
      projectId: PROJECT_ID,
      documentId: DOCUMENT_ID,
    })
    assert.equal(retryReconciliation.status, 'ready')
    production = command(production, 'continuity.candidate.register', retryReconciliation.payload, 101)
    assert.equal(production.continuityGraph.candidates.length, 2)
    assert.equal(projectStore.listLibraryAssets({ scope: 'project', projectId: PROJECT_ID }).length, 2)

    assert.equal(reconcileLocalVideoCandidateJob(production, completedRetry, {
      projectId: 'another-project',
      documentId: DOCUMENT_ID,
    }).status, 'foreign')

    const location = production.continuityGraph.locations[0]
    production = command(production, 'continuity.asset.unbind', { targetId: location.id }, 102)
    production = command(production, 'continuity.asset.bind', {
      targetId: location.id,
      binding: {
        libraryItemId: 'library-location-replacement',
        libraryVersionId: 'library-version-location-replacement',
        contentHash: 'f'.repeat(64),
        mimeType: 'image/png',
        scope: 'project',
        boundAt: production.updatedAt + 1,
      },
    }, 103)
    production = command(production, 'continuity.asset.approve', { targetId: location.id }, 104)
    const stale = reconcileLocalVideoCandidateJob(production, completedRetry, {
      projectId: PROJECT_ID,
      documentId: DOCUMENT_ID,
    })
    assert.equal(stale.status, 'rejected')
    assert.equal(stale.code, 'LOCAL_CANDIDATE_INPUT_STALE')
    assert.throws(
      () => authoritativeLocalVideoCandidate(retryBinding, { workspaceStore }, { requireProductionRevision: false }),
      (error) => error.code === 'LOCAL_CANDIDATE_INPUT_STALE',
    )
    assert.equal(reconcileLocalVideoCandidateJob(production, {
      id: 'video-chain-fixture',
      kind: 'video-chain',
      status: 'completed',
      createdAt: NOW,
      request: { projectId: PROJECT_ID, shots: [] },
    }, { projectId: PROJECT_ID, documentId: DOCUMENT_ID }).status, 'ignored')
  } finally {
    projectStore.close()
    const resolved = resolve(root)
    assert.ok(resolved.startsWith(`${QA_ROOT}\\`) || resolved.startsWith(`${QA_ROOT}/`))
    await rm(resolved, { recursive: true, force: true })
  }
})
