import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import {
  VideoSupervisorError,
  composeWorkspaceVideoSupervisorTurn,
} from '../server/video-supervisor.mjs'
import { WorkspaceStore } from '../server/workspace-store.mjs'
import { createProjectCatalog, createWorkspaceProject } from '../src/lib/project/projectCatalog.mjs'
import { createGenerationPlan, compileStoryProject } from '../src/lib/story/storyProject.mjs'
import {
  applyVideoProductionCommand,
  createLocalAgentProposal,
  createVideoProductionCommand,
  createVideoProductionProposalCommand,
  createVideoProductionProjectForStory,
} from '../src/lib/story/productionPipeline.mjs'
import { evaluateVideoSupervisor } from '../src/lib/story/videoSupervisor.mjs'
import { createMediaRunProposal } from '../src/lib/story/mediaSupervisor.mjs'

function apply(project, type, payload = {}, now = project.updatedAt + 1) {
  return applyVideoProductionCommand(
    project,
    createVideoProductionCommand(project, type, payload, {
      id: `test-${type.replaceAll('.', '-')}-${project.revision + 1}`,
      actor: 'user',
    }),
    { now },
  )
}

function approveNode(project, nodeId) {
  const node = project.nodes.find((item) => item.id === nodeId)
  if (node.status === 'review') return apply(project, 'node.approve', { nodeId })
  let next = project
  if (node.status === 'ready' || node.status === 'revision') next = apply(next, 'node.start', { nodeId })
  next = apply(next, 'node.submit-review', { nodeId, outputSummary: `${node.title}测试产物` })
  return apply(next, 'node.approve', { nodeId })
}

function storyFixture(documentId = 'document-supervisor') {
  const story = compileStoryProject({
    projectId: documentId,
    title: '督导武侠广告',
    kind: 'idea',
    text: '一位侠客穿过雨夜竹林，剑光化为品牌印记。',
    now: 1_000,
  })
  return {
    story,
    plan: createGenerationPlan(story, { now: 1_001 }),
    production: createVideoProductionProjectForStory(story, { now: 1_002 }),
  }
}

function readyCharacterFixture(documentId) {
  const fixture = storyFixture(documentId)
  fixture.production = approveNode(fixture.production, 'screenwriter')
  return fixture
}

function fakeAdapter(candidate, count) {
  return {
    async composeCreativePlan(input) {
      count.calls += 1
      count.input = structuredClone(input)
      return {
        candidate: structuredClone(candidate),
        adapter: { providerLabel: 'Loopback', model: 'fake-supervisor', persistence: 'memory-only' },
        requestHash: 'b'.repeat(64),
        usage: { promptTokens: 30, completionTokens: 15, totalTokens: 45 },
        elapsedMs: 9,
        contextBytes: Buffer.byteLength(JSON.stringify(input.context)),
      }
    },
  }
}

async function withStore(run) {
  const root = await mkdtemp(join(tmpdir(), 'aeonquill-video-supervisor-'))
  const safeRoot = resolve(root)
  assert.equal(safeRoot.startsWith(resolve(tmpdir())), true)
  let store
  try {
    store = await new WorkspaceStore(root).open()
    await run(store)
  } finally {
    store?.close()
    await rm(safeRoot, { recursive: true, force: true })
  }
}

function initialize(store, fixture, options = {}) {
  const projectId = options.projectId ?? 'project-supervisor'
  const documentId = fixture.story.id
  const created = createWorkspaceProject(createProjectCatalog(), {
    title: '督导测试',
    initialModeId: 'smart-video',
  }, { now: 2_000, projectId, documentId })
  const value = JSON.stringify({
    schemaVersion: 2,
    project: fixture.story,
    plan: fixture.plan,
    production: fixture.production,
  })
  store.initializeModeDocument(created.catalog, {
    projectId,
    documentId,
    modeId: 'smart-video',
    revision: 0,
    value,
  }, { baseRevision: 0, now: 2_001 })
  return { projectId, documentId, value }
}

test('supervisor deterministically stops at user, pause, failure and real-runtime gates', () => {
  const initial = storyFixture()
  assert.equal(evaluateVideoSupervisor(initial.production).status, 'node-review')

  const ready = approveNode(initial.production, 'screenwriter')
  const textDecision = evaluateVideoSupervisor(ready)
  assert.equal(textDecision.status, 'text-turn-ready')
  assert.equal(textDecision.node.id, 'character-designer')
  assert.equal(textDecision.modelCallRequired, true)

  const paused = apply(ready, 'project.pause')
  assert.equal(evaluateVideoSupervisor(paused).status, 'project-paused')

  let nodePaused = apply(ready, 'node.start', { nodeId: 'character-designer' })
  nodePaused = apply(nodePaused, 'node.pause', { nodeId: 'character-designer' })
  assert.equal(evaluateVideoSupervisor(nodePaused).status, 'node-paused')

  const proposed = applyVideoProductionCommand(
    ready,
    createVideoProductionProposalCommand(
      ready,
      'character-designer',
      createLocalAgentProposal(ready, 'character-designer'),
      { id: 'test-supervisor-proposal', actor: 'orchestrator' },
    ),
    { now: ready.updatedAt + 1 },
  )
  assert.equal(evaluateVideoSupervisor(proposed).status, 'change-card-review')

  let failed = apply(ready, 'node.start', { nodeId: 'character-designer' })
  failed = apply(failed, 'node.fail', { nodeId: 'character-designer', message: 'fixture failure' })
  assert.equal(evaluateVideoSupervisor(failed).status, 'node-failed')

  let media = ready
  for (const nodeId of ['character-designer', 'art-director', 'storyboard-director']) media = approveNode(media, nodeId)
  const mediaDecision = evaluateVideoSupervisor(media)
  assert.equal(mediaDecision.status, 'runtime-required')
  assert.equal(mediaDecision.node.id, 'asset-producer')
  assert.equal(mediaDecision.modelCallRequired, false)
})

test('authoritative supervisor returns one current-node plan without writing the project', async () => {
  await withStore(async (store) => {
    const fixture = readyCharacterFixture('document-supervisor-compose')
    const registered = initialize(store, fixture)
    const calls = { calls: 0, input: null }
    const result = await composeWorkspaceVideoSupervisorTurn({
      request: { projectId: registered.projectId, documentId: registered.documentId, baseRevision: 0 },
      workspaceStore: store,
      agentAdapter: fakeAdapter({
        title: '人物设计轮次',
        objective: '建立可审阅的人物身份与服饰约束。',
        steps: [{
          toolId: 'video.node.edit',
          summary: '提交人物设定摘要',
          input: {
            nodeId: 'character-designer',
            instructions: '固定正侧背三视图、身份锚点与场景服饰状态。',
            outputSummary: '主角使用青黑劲装、旧银护腕与窄刃长剑；雨夜和晨雾场景保持同一脸部与发冠。',
          },
        }],
      }, calls),
      now: () => 3_000,
      idFactory: (() => { let index = 0; return () => `supervisor-${++index}` })(),
    })

    assert.equal(calls.calls, 1)
    assert.equal(calls.input.toolGuide.length, 1)
    assert.equal(calls.input.toolGuide[0].startsWith('video.node.edit'), true)
    assert.equal(result.decision.node.id, 'character-designer')
    assert.equal(result.plan.source.agentRole, 'video-supervisor')
    assert.equal(result.plan.steps.length, 1)
    assert.equal(result.preview.resultRevision, 1)
    assert.equal(result.preview.summaries[0].toolId, 'video.node.edit')
    assert.equal(store.getModeDocument(registered.documentId).value, registered.value)
    assert.equal(store.listAgentPlanReceipts(registered.projectId).length, 0)
  })
})

test('supervisor never calls a model at an existing approval gate and rejects node escape', async () => {
  await withStore(async (store) => {
    const fixture = storyFixture('document-supervisor-gates')
    const registered = initialize(store, fixture, { projectId: 'project-supervisor-gates' })
    const noCall = { calls: 0, input: null }
    const stopped = await composeWorkspaceVideoSupervisorTurn({
      request: { projectId: registered.projectId, documentId: registered.documentId, baseRevision: 0 },
      workspaceStore: store,
      agentAdapter: fakeAdapter({}, noCall),
    })
    assert.equal(stopped.decision.status, 'node-review')
    assert.equal(stopped.plan, null)
    assert.equal(noCall.calls, 0)
  })

  await withStore(async (store) => {
    const fixture = readyCharacterFixture('document-supervisor-escape')
    const registered = initialize(store, fixture, { projectId: 'project-supervisor-escape' })
    const calls = { calls: 0, input: null }
    await assert.rejects(
      composeWorkspaceVideoSupervisorTurn({
        request: { projectId: registered.projectId, documentId: registered.documentId, baseRevision: 0 },
        workspaceStore: store,
        agentAdapter: fakeAdapter({
          title: '越级计划',
          objective: '错误地修改其他节点。',
          steps: [{
            toolId: 'video.node.edit',
            summary: '越过当前人物节点',
            input: { nodeId: 'art-director', outputSummary: '不应被采用' },
          }],
        }, calls),
      }),
      (error) => error instanceof VideoSupervisorError && error.code === 'VIDEO_SUPERVISOR_CANDIDATE_REJECTED',
    )
    assert.equal(calls.calls, 1)
    assert.equal(store.getModeDocument(registered.documentId).value, registered.value)
    assert.equal(store.listAgentPlanReceipts(registered.projectId).length, 0)
  })
})

test('video supervisor waits for proposed and running media jobs, then stops at media review', () => {
  let project = readyCharacterFixture('document-supervisor-media').production
  for (const nodeId of ['character-designer', 'art-director', 'storyboard-director']) project = approveNode(project, nodeId)
  const run = createMediaRunProposal({
    nodeId: 'video-director',
    kind: 'video',
    targetId: 'shot-1',
    inputFingerprint: 'media-fingerprint',
    requestSummary: '受控 H3 视频执行',
  }, { now: project.updatedAt + 1 })
  project = apply(project, 'media-runs.propose', { run })
  assert.equal(evaluateVideoSupervisor(project).status, 'media-proposed')
  project = apply(project, 'media-runs.attach-job', { runId: run.id, jobId: 'media-job-1', status: 'running' })
  assert.equal(evaluateVideoSupervisor(project).status, 'media-running')
  project = apply(project, 'media-runs.reconcile', { runId: run.id, jobId: 'media-job-1', status: 'completed', errorCode: null })
  assert.equal(evaluateVideoSupervisor(project).status, 'media-review')
})
