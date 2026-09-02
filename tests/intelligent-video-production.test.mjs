import test from 'node:test'
import assert from 'node:assert/strict'
import {
  VideoProductionError,
  advanceVideoProduction,
  applyVideoProductionCommand,
  assertVideoProductionProject,
  canBridgeProductionToStory,
  createApprovedStorySource,
  createLocalAgentProposal,
  createVideoProductionCommand,
  createVideoProductionProposalCommand,
  createVideoProductionProject,
  createVideoProductionProjectForStory,
  deserializeVideoProductionProject,
  migrateVideoProductionProject,
  productionProgress,
  serializeVideoProductionProject,
} from '../src/lib/story/productionPipeline.mjs'
import { compileStoryProject } from '../src/lib/story/storyProject.mjs'

function apply(project, type, payload = {}) {
  return applyVideoProductionCommand(
    project,
    createVideoProductionCommand(project, type, payload, { id: `test-${project.revision + 1}` }),
    { now: project.updatedAt + 1 },
  )
}

function approveNode(project, nodeId) {
  let next = apply(project, 'node.start', { nodeId })
  const node = next.nodes.find((item) => item.id === nodeId)
  next = apply(next, 'node.submit-review', { nodeId, outputSummary: `${node.title}测试产物` })
  return apply(next, 'node.approve', { nodeId })
}

test('creates an honest ten-minute wuxia production graph with deterministic estimates', () => {
  const project = createVideoProductionProject({
    brief: '我想要生成一部十分钟左右的武侠剧',
    durationMinutes: 10,
    genre: '武侠',
    now: 1_000,
  })
  assert.equal(project.nodes.length, 10)
  assert.deepEqual(project.estimates, {
    sceneCount: 12,
    shotCount: 120,
    batchCount: 24,
    generationMinutesLow: 720,
    generationMinutesHigh: 1_920,
  })
  assert.equal(project.settings.generationMode, 'fast')
  assert.equal(project.settings.characterMode, 'professional')
  assert.deepEqual(project.characterProfiles[0].views.map(({ view }) => view), ['front', 'side', 'back'])
  assert.equal(project.nodes[0].status, 'approved')
  assert.equal(project.nodes[1].status, 'review')
  assert(project.nodes.slice(2).every((node) => node.status === 'waiting'))
  assert.deepEqual(productionProgress(project), {
    approved: 1,
    total: 10,
    percent: 10,
    currentNodeId: 'screenwriter',
    blocker: '剧本设计待用户审批',
  })
})

test('enforces review gates and supports start, pause, resume and submit-review transitions', () => {
  let project = createVideoProductionProject({ now: 2_000 })
  assert.throws(
    () => advanceVideoProduction(project, { now: 2_001 }),
    (error) => error instanceof VideoProductionError && error.code === 'REVIEW_REQUIRED',
  )
  project = apply(project, 'node.approve', { nodeId: 'screenwriter' })
  assert.equal(project.nodes.find((node) => node.id === 'character-designer').status, 'ready')
  project = apply(project, 'node.start', { nodeId: 'character-designer' })
  project = apply(project, 'node.pause', { nodeId: 'character-designer' })
  assert.equal(project.nodes.find((node) => node.id === 'character-designer').status, 'paused')
  project = apply(project, 'node.resume', { nodeId: 'character-designer' })
  project = advanceVideoProduction(project, { now: project.updatedAt + 1 })
  assert.equal(project.nodes.find((node) => node.id === 'character-designer').status, 'review')
})

test('global pause is fail-closed and resumes the running node', () => {
  let project = createVideoProductionProject({ now: 3_000 })
  project = apply(project, 'node.approve', { nodeId: 'screenwriter' })
  project = apply(project, 'node.start', { nodeId: 'character-designer' })
  project = apply(project, 'project.pause')
  assert.equal(project.globalPaused, true)
  assert.equal(project.nodes.find((node) => node.id === 'character-designer').status, 'paused')
  assert.throws(
    () => advanceVideoProduction(project, { now: project.updatedAt + 1 }),
    (error) => error instanceof VideoProductionError && error.code === 'PROJECT_PAUSED',
  )
  project = apply(project, 'project.resume')
  assert.equal(project.nodes.find((node) => node.id === 'character-designer').status, 'running')
})

test('editing an approved node returns it to review and invalidates every downstream result', () => {
  let project = createVideoProductionProject({ now: 4_000 })
  project = apply(project, 'node.approve', { nodeId: 'screenwriter' })
  project = approveNode(project, 'character-designer')
  project = approveNode(project, 'art-director')
  project = apply(project, 'node.edit', {
    nodeId: 'screenwriter',
    outputSummary: '改为双主角结构，并调整第二幕背叛动机。',
  })
  assert.equal(project.nodes.find((node) => node.id === 'screenwriter').status, 'review')
  assert.equal(project.nodes.find((node) => node.id === 'character-designer').status, 'waiting')
  assert.equal(project.nodes.find((node) => node.id === 'character-designer').stale, true)
  assert.equal(project.nodes.find((node) => node.id === 'art-director').status, 'waiting')
  assert.equal(project.nodes.find((node) => node.id === 'art-director').stale, true)
})

test('bridges only approved storyboard output into the existing strict StoryProject contract', () => {
  let project = createVideoProductionProject({ now: 5_000 })
  assert.equal(canBridgeProductionToStory(project), false)
  assert.throws(
    () => createApprovedStorySource(project),
    (error) => error instanceof VideoProductionError && error.code === 'STORYBOARD_NOT_APPROVED',
  )
  project = apply(project, 'node.approve', { nodeId: 'screenwriter' })
  project = approveNode(project, 'character-designer')
  project = approveNode(project, 'art-director')
  project = approveNode(project, 'storyboard-director')
  const source = createApprovedStorySource(project)
  const story = compileStoryProject({ ...source, now: 6_000 })
  assert.equal(story.scenes.length, 12)
  assert.equal(story.scenes.reduce((sum, scene) => sum + scene.shots.length, 0), 120)
  assert.equal(story.scenes.flatMap((scene) => scene.shots).reduce((sum, shot) => sum + shot.durationSeconds, 0), 600)
})

test('rejects unknown fields, illegal transitions and stale commands while preserving lossless serialization', () => {
  const project = createVideoProductionProject({ now: 7_000 })
  assert.throws(
    () => assertVideoProductionProject({ ...project, hiddenPrompt: 'unsafe' }),
    (error) => error instanceof VideoProductionError && error.code === 'UNKNOWN_FIELD',
  )
  const cyclic = structuredClone(project)
  cyclic.nodes[0].dependsOn = ['screenwriter']
  assert.throws(
    () => assertVideoProductionProject(cyclic),
    (error) => error instanceof VideoProductionError && error.code === 'INVALID_DEPENDENCY',
  )
  assert.throws(
    () => apply(project, 'node.start', { nodeId: 'video-director' }),
    (error) => error instanceof VideoProductionError && error.code === 'INVALID_TRANSITION',
  )
  const stale = createVideoProductionCommand(project, 'node.approve', { nodeId: 'screenwriter' }, { id: 'stale' })
  const changed = apply(project, 'project.patch', { autoAdvance: true })
  assert.throws(
    () => applyVideoProductionCommand(changed, stale, { now: changed.updatedAt + 1 }),
    (error) => error instanceof VideoProductionError && error.code === 'REVISION_CONFLICT',
  )
  assert.deepEqual(deserializeVideoProductionProject(serializeVideoProductionProject(project)), project)
})

test('agent proposals remain reviewable change cards and become stale after a manual edit', () => {
  let project = createVideoProductionProject({ now: 8_000, generationMode: 'quality', characterMode: 'quick' })
  const proposal = createLocalAgentProposal(project, 'screenwriter')
  project = applyVideoProductionCommand(
    project,
    createVideoProductionProposalCommand(project, 'screenwriter', proposal, { id: 'proposal-create', actor: 'orchestrator' }),
    { now: 8_001 },
  )
  assert.equal(project.changeCards[0].status, 'proposed')
  assert.equal(project.nodes.find(({ id }) => id === 'screenwriter').revision, 1)
  project = apply(project, 'proposal.accept', { cardId: project.changeCards[0].id })
  assert.equal(project.changeCards[0].status, 'accepted')
  assert.equal(project.nodes.find(({ id }) => id === 'screenwriter').revision, 2)
  assert.equal(project.nodes.find(({ id }) => id === 'screenwriter').status, 'review')

  project = applyVideoProductionCommand(
    project,
    createVideoProductionProposalCommand(project, 'screenwriter', createLocalAgentProposal(project, 'screenwriter'), { id: 'proposal-create-2' }),
    { now: project.updatedAt + 1 },
  )
  const pending = project.changeCards.find(({ status }) => status === 'proposed')
  project = apply(project, 'node.edit', { nodeId: 'screenwriter', outputSummary: '用户手工改写的新版本。' })
  assert.equal(project.changeCards.find(({ id }) => id === pending.id).status, 'superseded')
  assert.throws(
    () => apply(project, 'proposal.accept', { cardId: pending.id }),
    (error) => error instanceof VideoProductionError && error.code === 'INVALID_CHANGE_CARD_STATUS',
  )
})

test('migrates schema v1 production exports without losing node approvals', () => {
  const current = createVideoProductionProject({ now: 9_000, generationMode: 'quality' })
  const legacy = structuredClone(current)
  legacy.schemaVersion = 1
  delete legacy.characterProfiles
  delete legacy.continuityGraph
  delete legacy.soundTimeline
  delete legacy.changeCards
  delete legacy.settings.generationMode
  delete legacy.settings.characterMode
  delete legacy.settings.recommendation
  const restored = deserializeVideoProductionProject(JSON.stringify(legacy))
  assert.equal(restored.schemaVersion, 4)
  assert.equal(restored.settings.generationMode, 'quality')
  assert.equal(restored.nodes[1].status, current.nodes[1].status)
  assert.equal(restored.characterProfiles.length, 1)
})

test('migrates schema v3 production exports into a story-bound sound timeline', () => {
  const story = compileStoryProject({
    projectId: 'sound-migration-story',
    title: '声音迁移测试',
    kind: 'script',
    text: '场景 1：雨巷\n镜头 1：沈砚回望\n沈砚：风声不对。',
    now: 9_500,
  })
  const current = createVideoProductionProjectForStory(story, { now: 9_501 })
  const legacy = structuredClone(current)
  legacy.schemaVersion = 3
  delete legacy.soundTimeline

  const restored = migrateVideoProductionProject(legacy, { story, now: 9_502 })
  assert.equal(restored.schemaVersion, 4)
  assert.equal(restored.soundTimeline.storyProjectId, story.id)
  assert.equal(restored.soundTimeline.storyRevision, story.revision)
  assert.equal(restored.soundTimeline.subtitleCues.length, 1)
  assert.equal(restored.nodes[1].status, current.nodes[1].status)
})

test('sound-director approval fails closed until required audio, subtitles, style and mix are approved', () => {
  const story = compileStoryProject({
    projectId: 'sound-gate-story',
    title: '声音门测试',
    kind: 'script',
    text: '场景 1：竹林\n镜头 1：沈砚抬剑\n沈砚：来者何人？',
    now: 10_000,
  })
  let project = createVideoProductionProjectForStory(story, { now: 10_001 })
  project.nodes.forEach((node) => {
    node.status = node.id === 'sound-director' ? 'review' : node.id === 'quality-controller' ? 'waiting' : 'approved'
    if (!node.outputSummary) node.outputSummary = `${node.title}测试产物`
  })
  project = structuredClone(assertVideoProductionProject(project))
  assert.throws(
    () => apply(project, 'node.approve', { nodeId: 'sound-director' }),
    (error) => error instanceof VideoProductionError && error.code === 'SOUND_TIMELINE_INCOMPLETE',
  )

  for (const [index, cue] of project.soundTimeline.audioCues.filter(({ required }) => required).entries()) {
    const binding = {
      libraryItemId: `sound-item-${index + 1}`,
      libraryVersionId: `sound-version-${index + 1}`,
      contentHash: (index + 1).toString(16).padStart(64, '0'),
      mimeType: 'audio/mpeg',
      scope: 'project',
      boundAt: project.updatedAt + 1,
    }
    project = apply(project, 'sound.asset.bind', { cueId: cue.id, binding })
    project = apply(project, 'sound.asset.approve', { cueId: cue.id })
  }
  project = apply(project, 'sound.subtitles.approve-all')
  project = apply(project, 'sound.subtitle-style.approve')
  project = apply(project, 'sound.mix.approve')
  project = apply(project, 'node.approve', { nodeId: 'sound-director' })
  assert.equal(project.nodes.find(({ id }) => id === 'sound-director').status, 'approved')
  assert.equal(project.nodes.find(({ id }) => id === 'quality-controller').status, 'ready')
})
