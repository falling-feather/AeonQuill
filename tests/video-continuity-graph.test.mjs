import test from 'node:test'
import assert from 'node:assert/strict'

import {
  VideoContinuityError,
  assertContinuityAssetBinding,
  assertVideoContinuityGraph,
  continuityGraphSummary,
} from '../src/lib/story/continuityGraph.mjs'
import {
  VideoProductionError,
  applyVideoProductionCommand,
  createVideoProductionCommand,
  createVideoProductionProject,
  createVideoProductionProjectForStory,
  migrateVideoProductionProject,
  synchronizeVideoProductionProjectForStory,
} from '../src/lib/story/productionPipeline.mjs'
import { compileStoryProject } from '../src/lib/story/storyProject.mjs'

function story(text = `场景 1：雨夜·竹林
镜头 1：沈砚持剑穿过竹影。
沈砚：今夜必须查清真相。
镜头 2：苏晚从石桥另一端现身。
苏晚：先收起你的剑。

场景 2：黎明·渡口
镜头 1：两人并肩望向雾中的船。`) {
  return compileStoryProject({
    projectId: 'continuity-story',
    title: '连续性测试片',
    kind: 'script',
    text,
    aspectRatio: '16:9',
    frameStrategy: 'start-end',
    now: 1_000,
  })
}

function apply(project, type, payload = {}) {
  return applyVideoProductionCommand(
    project,
    createVideoProductionCommand(project, type, payload, { id: `continuity-test-${project.revision + 1}` }),
    { now: project.updatedAt + 1 },
  )
}

function approveNode(project, nodeId) {
  let next = apply(project, 'node.start', { nodeId })
  next = apply(next, 'node.submit-review', { nodeId, outputSummary: `${nodeId} 已形成测试产物。` })
  return apply(next, 'node.approve', { nodeId })
}

function binding(index) {
  return {
    libraryItemId: `library-item-${index}`,
    libraryVersionId: `library-version-${index}`,
    contentHash: index.toString(16).padStart(64, '0'),
    mimeType: 'image/png',
    scope: index % 2 ? 'project' : 'global-reference',
    boundAt: 2_000 + index,
  }
}

function approveRequiredAssets(project) {
  const graph = project.continuityGraph
  const slots = [...graph.views, ...graph.wardrobes, ...graph.locations, ...graph.frames]
    .filter((slot) => slot.required !== false || !('required' in slot))
  let next = project
  slots.forEach((slot, index) => {
    next = apply(next, 'continuity.asset.bind', { targetId: slot.id, binding: binding(index + 1) })
    next = apply(next, 'continuity.asset.approve', { targetId: slot.id })
  })
  return next
}

test('compiles story characters, professional views, locations, frames and shot references into a durable graph', () => {
  const production = createVideoProductionProjectForStory(story(), {
    generationMode: 'quality',
    characterMode: 'professional',
    now: 1_100,
  })
  assert.equal(production.schemaVersion, 3)
  assert.equal(production.continuityGraph.storyProjectId, 'continuity-story')
  assert.equal(production.continuityGraph.characters.length, 2)
  assert.equal(production.continuityGraph.locations.length, 2)
  assert.equal(production.continuityGraph.shots.length, 3)
  assert.equal(production.continuityGraph.frames.length, 6)
  for (const character of production.continuityGraph.characters) {
    const views = production.continuityGraph.views.filter(({ characterId }) => characterId === character.id)
    assert.deepEqual(views.map(({ view }) => view), ['front', 'side', 'back'])
    assert(views.every(({ required }) => required))
  }
  assert(production.continuityGraph.shots.every(({ status }) => status === 'blocked'))
})

test('rejects unknown fields, paths, unsupported mime types and non-SHA content identities', () => {
  assert.throws(
    () => assertContinuityAssetBinding({ ...binding(1), localPath: 'D:/private/model.png' }),
    (error) => error instanceof VideoContinuityError && error.code === 'INVALID_FIELDS',
  )
  assert.throws(
    () => assertContinuityAssetBinding({ ...binding(1), contentHash: 'abc' }),
    (error) => error instanceof VideoContinuityError && error.code === 'INVALID_CONTENT_HASH',
  )
  assert.throws(
    () => assertContinuityAssetBinding({ ...binding(1), mimeType: 'image/svg+xml' }),
    (error) => error instanceof VideoContinuityError && error.code === 'INVALID_ASSET_MIME',
  )
  const production = createVideoProductionProjectForStory(story(), { now: 1_200 })
  const malformed = structuredClone(production.continuityGraph)
  malformed.shots[0].secretThreshold = 4.2
  assert.throws(
    () => assertVideoContinuityGraph(malformed),
    (error) => error instanceof VideoContinuityError && error.code === 'INVALID_FIELDS',
  )
  const bypass = structuredClone(production.continuityGraph)
  bypass.shots[0].status = 'approved'
  assert.throws(
    () => assertVideoContinuityGraph(bypass),
    (error) => error instanceof VideoContinuityError && error.code === 'SHOT_REVIEW_STATUS_MISMATCH',
  )
})

test('requires explicit asset approval before the asset-producer gate can pass', () => {
  let production = createVideoProductionProjectForStory(story(), { generationMode: 'quality', now: 1_300 })
  production = apply(production, 'node.approve', { nodeId: 'screenwriter' })
  production = approveNode(production, 'character-designer')
  production = approveNode(production, 'art-director')
  production = approveNode(production, 'storyboard-director')
  production = apply(production, 'node.start', { nodeId: 'asset-producer' })
  production = apply(production, 'node.submit-review', { nodeId: 'asset-producer', outputSummary: '素材索引待资产门验证。' })
  assert.throws(
    () => apply(production, 'node.approve', { nodeId: 'asset-producer' }),
    (error) => error instanceof VideoProductionError && error.code === 'CONTINUITY_ASSETS_INCOMPLETE',
  )
  production = approveRequiredAssets(production)
  const summary = continuityGraphSummary(production.continuityGraph)
  assert.equal(summary.approvedAssets, summary.requiredAssets)
  assert(production.continuityGraph.shots.every(({ status }) => status === 'ready'))
  production = apply(production, 'node.approve', { nodeId: 'asset-producer' })
  assert.equal(production.nodes.find(({ id }) => id === 'asset-producer').status, 'approved')
})

test('records manual accept/retry decisions without inventing calibrated machine thresholds', () => {
  let production = approveRequiredAssets(createVideoProductionProjectForStory(story(), { generationMode: 'quality', now: 1_400 }))
  const shot = production.continuityGraph.shots[0]
  production = apply(production, 'continuity.review.record', {
    shotId: shot.id,
    reviewerId: 'local-user',
    scores: { identity: 4.4, wardrobe: 3.1, location: 4.2, sharpness: 2.8, motion: 3.9 },
    decision: 'retry',
    notes: '主体清晰度不足，只重跑当前镜头。',
  })
  let review = production.continuityGraph.reviews.at(-1)
  assert.equal(review.decision, 'retry')
  assert.equal(production.continuityGraph.shots[0].status, 'retry-required')
  assert(review.recommendedActions.some((action) => action.includes('质量母版')))
  assert.equal(continuityGraphSummary(production.continuityGraph).calibrated, false)

  production = apply(production, 'continuity.review.record', {
    shotId: shot.id,
    reviewerId: 'local-user',
    scores: { identity: 4.6, wardrobe: 4.5, location: 4.4, sharpness: 4.3, motion: 4.2 },
    decision: 'accept',
    notes: '人工确认可用。',
  })
  review = production.continuityGraph.reviews.at(-1)
  assert.equal(review.decision, 'accept')
  assert.equal(production.continuityGraph.reviews[0].status, 'superseded')
  assert.equal(production.continuityGraph.shots[0].status, 'approved')
})

test('upstream asset or wardrobe changes only supersede reviews for affected shots', () => {
  let production = approveRequiredAssets(createVideoProductionProjectForStory(story(), { generationMode: 'quality', now: 1_500 }))
  for (const shot of production.continuityGraph.shots) {
    production = apply(production, 'continuity.review.record', {
      shotId: shot.id,
      reviewerId: 'local-user',
      scores: { identity: 4, wardrobe: 4, location: 4, sharpness: 4, motion: 4 },
      decision: 'accept',
      notes: '',
    })
  }
  const firstShot = production.continuityGraph.shots[0]
  const unrelatedShot = production.continuityGraph.shots.find(({ locationId }) => locationId !== firstShot.locationId)
  const firstLocationId = firstShot.locationId
  production = apply(production, 'continuity.asset.bind', { targetId: firstLocationId, binding: binding(99) })
  assert.equal(production.continuityGraph.shots.find(({ id }) => id === firstShot.id).status, 'blocked')
  assert.equal(production.continuityGraph.shots.find(({ id }) => id === unrelatedShot.id).status, 'approved')
})

test('synchronizes revised stories while preserving unchanged content-addressed assets', () => {
  const originalStory = story()
  let production = approveRequiredAssets(createVideoProductionProjectForStory(originalStory, { generationMode: 'quality', now: 1_600 }))
  const preservedView = production.continuityGraph.views[0]
  const revisedStory = story(`${originalStory.source.text}\n\n场景 3：午后·客栈\n镜头 1：沈砚推门进入客栈。`)
  revisedStory.revision = originalStory.revision + 1
  revisedStory.updatedAt = 3_000
  production = synchronizeVideoProductionProjectForStory(production, revisedStory, { now: 3_001 })
  const syncedView = production.continuityGraph.views.find(({ id }) => id === preservedView.id)
  assert.equal(syncedView.asset.contentHash, preservedView.asset.contentHash)
  assert.equal(syncedView.status, 'approved')
  assert.equal(production.continuityGraph.storyRevision, revisedStory.revision)
  assert(production.continuityGraph.shots.length > originalStory.scenes.flatMap(({ shots }) => shots).length)
})

test('preserves pre-story character assets when the approved storyboard is bridged', () => {
  let production = createVideoProductionProject({ generationMode: 'quality', characterMode: 'professional', genre: '武侠', now: 1_650 })
  const originalView = production.continuityGraph.views[0]
  production = apply(production, 'continuity.asset.bind', { targetId: originalView.id, binding: binding(77) })
  production = apply(production, 'continuity.asset.approve', { targetId: originalView.id })
  production = synchronizeVideoProductionProjectForStory(production, story(), { now: production.updatedAt + 1 })
  const bridgedView = production.continuityGraph.views.find(({ id }) => id === originalView.id)
  assert.equal(bridgedView.status, 'approved')
  assert.equal(bridgedView.asset.contentHash, binding(77).contentHash)
})

test('migrates v2 production projects into v3 without losing node state', () => {
  const current = createVideoProductionProjectForStory(story(), { now: 1_700 })
  const legacy = structuredClone(current)
  legacy.schemaVersion = 2
  delete legacy.continuityGraph
  legacy.characterProfiles.forEach((profile) => { delete profile.storyCharacterId })
  legacy.nodes[1].status = 'approved'
  const migrated = migrateVideoProductionProject(legacy, { story: story(), now: 1_800 })
  assert.equal(migrated.schemaVersion, 3)
  assert.equal(migrated.nodes[1].status, 'approved')
  assert.equal(migrated.continuityGraph.storyProjectId, 'continuity-story')
  assert(migrated.characterProfiles.every(({ storyCharacterId }) => storyCharacterId !== null))
})

test('migrates every pre-story v2 character profile instead of collapsing them into the lead', () => {
  const current = createVideoProductionProject({ generationMode: 'quality', characterMode: 'professional', genre: '武侠', now: 1_900 })
  const legacy = structuredClone(current)
  legacy.schemaVersion = 2
  delete legacy.continuityGraph
  delete legacy.characterProfiles[0].storyCharacterId
  const supporting = structuredClone(legacy.characterProfiles[0])
  supporting.id = 'character-supporting'
  supporting.name = '苏晚'
  supporting.role = 'supporting'
  supporting.views.forEach((view) => { view.id = `${supporting.id}-${view.view}` })
  supporting.wardrobeStates.forEach((wardrobe, index) => { wardrobe.id = `${supporting.id}-wardrobe-${index + 1}` })
  legacy.characterProfiles.push(supporting)

  const migrated = migrateVideoProductionProject(legacy, { now: 2_000 })
  assert.deepEqual(migrated.characterProfiles.map(({ name }) => name), ['沈砚', '苏晚'])
  assert.deepEqual(migrated.continuityGraph.characters.map(({ profileId }) => profileId), ['character-lead', 'character-supporting'])
})

test('rejects ambiguous duplicate profile assets and graph character mappings', () => {
  const production = createVideoProductionProjectForStory(story(), { now: 2_100 })
  const duplicateView = structuredClone(production)
  duplicateView.characterProfiles[0].views.push(structuredClone(duplicateView.characterProfiles[0].views[0]))
  assert.throws(
    () => migrateVideoProductionProject(duplicateView),
    (error) => error instanceof VideoProductionError && error.code === 'DUPLICATE_ID',
  )

  const duplicateProfile = structuredClone(production.continuityGraph)
  duplicateProfile.characters[1].profileId = duplicateProfile.characters[0].profileId
  assert.throws(
    () => assertVideoContinuityGraph(duplicateProfile),
    (error) => error instanceof VideoContinuityError && error.code === 'DUPLICATE_PROFILE',
  )
})

test('migrating an existing v3 project against a newer story revision synchronizes continuity', () => {
  const originalStory = story()
  const production = createVideoProductionProjectForStory(originalStory, { now: 2_200 })
  const revisedStory = story(`${originalStory.source.text}\n\n场景 3：正午·山门\n镜头 1：苏晚独自走入山门。`)
  revisedStory.revision = originalStory.revision + 1
  revisedStory.updatedAt = 2_300

  const migrated = migrateVideoProductionProject(production, { story: revisedStory, now: 2_301 })
  assert.equal(migrated.continuityGraph.storyProjectId, revisedStory.id)
  assert.equal(migrated.continuityGraph.storyRevision, revisedStory.revision)
  assert(migrated.continuityGraph.shots.length > production.continuityGraph.shots.length)
  assert(migrated.events.some(({ type }) => type === 'continuity.synchronized'))
})
