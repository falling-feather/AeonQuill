import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CreativePlanError,
  approveCreativePlan,
  assertApprovedCreativePlan,
  createCreativePlan,
  executeApprovedCreativePlan,
  previewCreativePlan,
} from '../src/lib/agent/creativePlan.mjs'
import { createCanvasDocument, executeCanvasTool } from '../src/lib/canvasCore.mjs'
import { applyPixelCommand, createPixelCommand, createPixelDocument } from '../src/lib/pixel/pixelCore.mjs'
import { compileStoryProject, createGenerationPlan } from '../src/lib/story/storyProject.mjs'
import {
  applyVideoProductionCommand,
  createVideoProductionCommand,
  createVideoProductionProjectForStory,
} from '../src/lib/story/productionPipeline.mjs'

const source = {
  kind: 'deterministic-local',
  agentRole: 'layout-director',
  modelId: null,
  requestHash: null,
}

function plan(input) {
  return createCreativePlan({
    id: input.id,
    projectId: 'workspace-project-1',
    documentId: input.documentId,
    modeId: input.modeId,
    baseRevision: input.baseRevision ?? 0,
    title: input.title ?? '受控创作计划',
    objective: input.objective ?? '验证计划只在审批后修改正文。',
    source,
    steps: input.steps,
    createdAt: 1_000,
  })
}

test('balanced CreativePlan previews without mutation and approved replay emits a hash-bound receipt', async () => {
  const body = createCanvasDocument({
    id: 'balanced-document-1',
    title: 'Canvas',
    elements: [{
      id: 'note-1', kind: 'note', name: 'Note', x: 10, y: 20, width: 100, height: 80,
      rotation: 0, opacity: 1, radius: 0, fill: '#fff', stroke: '#000', content: 'before',
      locked: false, visible: true, zIndex: 1,
    }],
    camera: { x: 0, y: 0, zoom: 1 },
    now: 900,
  })
  const candidate = plan({
    id: 'balanced-plan-1', documentId: body.id, modeId: 'balanced',
    steps: [{
      id: 'balanced-step-1', toolId: 'canvas.elements.patch', summary: '移动便签', sourceAssets: [],
      input: { updates: [{ id: 'note-1', patch: { x: 60, y: 90 } }] },
    }],
  })
  const preview = previewCreativePlan(body, candidate, { workspaceRevision: 0, now: 1_100 })
  assert.equal(body.elements[0].x, 10)
  assert.equal(preview.document.elements[0].x, 60)
  const approved = await approveCreativePlan(candidate, { approvedAt: 1_200 })
  const executed = await executeApprovedCreativePlan(body, approved, { workspaceRevision: 0, committedAt: 1_300 })
  assert.equal(executed.document.elements[0].y, 90)
  const human = executeCanvasTool(body, {
    toolId: 'canvas.elements.patch',
    callId: 'human-balanced-equivalent',
    actor: 'user',
    input: candidate.steps[0].input,
  }, { now: 1_300 })
  assert.deepEqual(executed.document.elements, human.elements)
  assert.equal(executed.receipt.baseRevision, 0)
  assert.equal(executed.receipt.resultRevision, 1)
  assert.match(executed.receipt.planSha256, /^[a-f0-9]{64}$/u)
  assert.match(executed.receipt.steps[0].inputSha256, /^[a-f0-9]{64}$/u)
})

test('pixel CreativePlan replays safe pixel tools and rejects unknown tools', async () => {
  const body = createPixelDocument({ id: 'pixel-document-1', name: 'Pixel', width: 2, height: 2 })
  const colorId = body.palette[0].id
  const candidate = plan({
    id: 'pixel-plan-1', documentId: body.id, modeId: 'pixel',
    steps: [{
      id: 'pixel-step-1', toolId: 'pixel.pixels.paint', summary: '绘制一个像素', sourceAssets: [],
      input: { frameId: body.activeFrameId, layerId: body.activeLayerId, pixels: [{ x: 1, y: 1, colorId }] },
    }],
  })
  const preview = previewCreativePlan(body, candidate, { workspaceRevision: 0 })
  assert.equal(body.frames[0].cels[body.activeLayerId][3], null)
  assert.equal(preview.document.frames[0].cels[body.activeLayerId][3], colorId)
  const approved = await approveCreativePlan(candidate, { approvedAt: 1_200 })
  const executed = await executeApprovedCreativePlan(body, approved, { workspaceRevision: 0, committedAt: 1_300 })
  assert.equal(executed.document.revision, 1)
  const humanCommand = createPixelCommand(body, 'pixels.paint', candidate.steps[0].input, {
    id: 'human-pixel-equivalent', actor: 'user',
  })
  const humanResult = applyPixelCommand(body, humanCommand)
  assert.deepEqual(executed.document.frames, humanResult.document.frames)
  assert.deepEqual(applyPixelCommand(humanResult.document, humanResult.inverse).document.frames, body.frames)

  const unknown = plan({
    id: 'pixel-plan-unknown', documentId: body.id, modeId: 'pixel',
    steps: [{ id: 'pixel-step-unknown', toolId: 'pixel.document.replace', summary: '非法替换', sourceAssets: [], input: {} }],
  })
  assert.throws(() => previewCreativePlan(body, unknown, { workspaceRevision: 0 }), (error) => (
    error instanceof CreativePlanError && error.code === 'TOOL_NOT_FOUND'
  ))
})

test('smart-video CreativePlan uses the production command gate', async () => {
  const story = compileStoryProject({
    projectId: 'smart-document-1',
    title: 'Story',
    kind: 'idea',
    text: '一位侠客穿过竹林。',
    now: 900,
  })
  const body = {
    schemaVersion: 2,
    project: story,
    plan: createGenerationPlan(story, { now: 901 }),
    production: createVideoProductionProjectForStory(story, { now: 902 }),
  }
  const candidate = plan({
    id: 'video-plan-1', documentId: story.id, modeId: 'smart-video',
    steps: [{
      id: 'video-step-1', toolId: 'video.project.patch', summary: '关闭自动推进', sourceAssets: [],
      input: { autoAdvance: !body.production.autoAdvance },
    }],
  })
  const preview = previewCreativePlan(body, candidate, { workspaceRevision: 0, now: 1_100 })
  assert.equal(preview.document.production.autoAdvance, !body.production.autoAdvance)
  assert.equal(preview.resultRevision, 1)
  const humanCommand = createVideoProductionCommand(body.production, 'project.patch', candidate.steps[0].input, {
    id: 'human-video-equivalent', actor: 'user',
  })
  const humanProduction = applyVideoProductionCommand(body.production, humanCommand, { now: 1_100 })
  assert.equal(preview.document.production.autoAdvance, humanProduction.autoAdvance)
})

test('approval tampering, stale revisions, privileged canvas writes and hidden fields fail closed', async () => {
  const body = createCanvasDocument({
    id: 'balanced-document-2', title: 'Canvas',
    elements: [{
      id: 'locked-note', kind: 'note', name: 'Locked', x: 0, y: 0, width: 100, height: 80,
      rotation: 0, opacity: 1, radius: 0, fill: '#fff', stroke: '#000', content: 'locked',
      locked: true, visible: true, zIndex: 1,
    }],
    camera: { x: 0, y: 0, zoom: 1 }, now: 900,
  })
  const candidate = plan({
    id: 'balanced-plan-2', documentId: body.id, modeId: 'balanced',
    steps: [{
      id: 'balanced-step-2', toolId: 'canvas.elements.patch', summary: '尝试改锁定节点', sourceAssets: [],
      input: { updates: [{ id: 'locked-note', patch: { x: 10 } }] },
    }],
  })
  assert.throws(() => previewCreativePlan(body, candidate, { workspaceRevision: 0 }), (error) => error.code === 'ELEMENT_LOCKED')
  assert.throws(() => previewCreativePlan(body, candidate, { workspaceRevision: 1 }), (error) => error.code === 'REVISION_CONFLICT')

  const allowed = plan({
    id: 'balanced-plan-3', documentId: body.id, modeId: 'balanced',
    steps: [{
      id: 'balanced-step-3', toolId: 'canvas.elements.add', summary: '添加便签', sourceAssets: [],
      input: { elements: [{
        id: 'note-2', kind: 'note', name: 'New', x: 20, y: 20, width: 100, height: 80,
        rotation: 0, opacity: 1, radius: 0, fill: '#fff', stroke: '#000', content: 'new',
        locked: false, visible: true, zIndex: 2,
      }] },
    }],
  })
  const approved = await approveCreativePlan(allowed, { approvedAt: 1_200 })
  approved.plan.steps[0].input.elements[0].content = 'tampered'
  await assert.rejects(() => assertApprovedCreativePlan(approved), (error) => (
    error instanceof CreativePlanError && error.code === 'PLAN_APPROVAL_MISMATCH'
  ))
  assert.throws(() => createCreativePlan({ ...allowed, hidden: true }), (error) => (
    error instanceof CreativePlanError && error.code === 'UNKNOWN_FIELD'
  ))
})
