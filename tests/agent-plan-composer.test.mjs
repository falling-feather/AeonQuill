import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import {
  AgentPlanComposerError,
  buildCreativePlanContext,
  composeWorkspaceCreativePlan,
} from '../server/agent-plan-composer.mjs'
import { WorkspaceStore } from '../server/workspace-store.mjs'
import { previewCreativePlan } from '../src/lib/agent/creativePlan.mjs'
import { createCanvasDocument } from '../src/lib/canvasCore.mjs'
import { createPixelDocument, serializePixelDocument } from '../src/lib/pixel/pixelCore.mjs'
import { createProjectCatalog, createWorkspaceProject } from '../src/lib/project/projectCatalog.mjs'
import { createGenerationPlan, compileStoryProject } from '../src/lib/story/storyProject.mjs'
import { createVideoProductionProjectForStory } from '../src/lib/story/productionPipeline.mjs'

async function withStore(run) {
  const root = await mkdtemp(join(tmpdir(), 'aeonquill-agent-plan-composer-'))
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

function modeFixture(modeId) {
  const projectId = `project-${modeId}`
  const documentId = `document-${modeId}`
  const created = createWorkspaceProject(createProjectCatalog(), {
    title: `${modeId} Agent 计划`, initialModeId: modeId,
  }, { now: 1_000, projectId, documentId })
  let value
  if (modeId === 'balanced') {
    value = JSON.stringify(createCanvasDocument({
      id: documentId,
      title: '带敏感媒体引用的画布',
      elements: [
        {
          id: 'image-source', kind: 'image', name: 'C:\\private\\source.png',
          x: 0, y: 0, width: 320, height: 180, rotation: 0, opacity: 1, radius: 0,
          fill: 'transparent', stroke: 'transparent', src: 'data:image/png;base64,TOPSECRETBYTES',
          locked: false, visible: true, zIndex: 1,
        },
        {
          id: 'note-source', kind: 'note', name: '提示',
          x: 340, y: 0, width: 180, height: 120, rotation: 0, opacity: 1, radius: 8,
          fill: '#FFF4C2', stroke: '#E7CE75', content: '不要泄露 sk-abcdefgh12345678 或 https://private.example/media.png',
          locked: false, visible: true, zIndex: 2,
        },
      ],
      camera: { x: 0, y: 0, zoom: 1 },
      now: 1_000,
    }))
  } else if (modeId === 'pixel') {
    value = serializePixelDocument(createPixelDocument({
      id: documentId, name: 'Pixel Agent', width: 8, height: 8, revision: 0,
    }))
  } else {
    const story = compileStoryProject({
      projectId: documentId,
      title: '武侠广告',
      kind: 'idea',
      text: '一位侠客穿过竹林，墨迹化作品牌标志。',
      now: 1_000,
    })
    value = JSON.stringify({
      schemaVersion: 2,
      project: story,
      plan: createGenerationPlan(story, { now: 1_001 }),
      production: createVideoProductionProjectForStory(story, { now: 1_002 }),
    })
  }
  return {
    created,
    request: { projectId, documentId, modeId, baseRevision: 0, instruction: '按当前结构生成一条安全修改计划' },
    document: { projectId, documentId, modeId, revision: 0, value },
  }
}

function fakeAdapter(candidate, observe = () => undefined) {
  return {
    async composeCreativePlan(input) {
      await observe(input)
      return {
        candidate: structuredClone(candidate),
        adapter: { providerLabel: 'Loopback', model: 'fake-planner', persistence: 'memory-only' },
        requestHash: 'a'.repeat(64),
        usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
        elapsedMs: 12,
        contextBytes: Buffer.byteLength(JSON.stringify(input.context)),
      }
    },
  }
}

function idFactory() {
  let sequence = 0
  return () => `generated-${++sequence}`
}

test('authoritative composer produces preview-only plans for all three modes without writing bodies or receipts', async () => {
  const cases = [
    {
      modeId: 'balanced',
      candidate: {
        title: '添加品牌说明', objective: '在画布中新增一张可审阅便签。',
        steps: [{
          toolId: 'canvas.elements.add', summary: '添加品牌便签', input: { elements: [{
            id: 'agent-note', kind: 'note', name: '品牌说明', x: 60, y: 80,
            width: 220, height: 120, rotation: 0, opacity: 1, radius: 8,
            fill: '#FFF4C2', stroke: '#E7CE75', content: '以光为墨，以时为卷。',
            locked: false, visible: true, zIndex: 3,
          }] },
        }],
      },
      assertPreview: (preview) => assert.equal(preview.document.elements.some(({ id }) => id === 'agent-note'), true),
    },
    {
      modeId: 'pixel',
      candidate: {
        title: '调整 Ember', objective: '增强像素高光。',
        steps: [{
          toolId: 'pixel.palette.replace', summary: '调亮 Ember',
          input: { colorId: 'ember', color: '#FF7048FF', name: 'Bright Ember' },
        }],
      },
      assertPreview: (preview) => assert.equal(preview.document.palette.find(({ id }) => id === 'ember').color, '#FF7048FF'),
    },
    {
      modeId: 'smart-video',
      candidate: {
        title: '暂停自动推进', objective: '让导演逐节点复核。',
        steps: [{ toolId: 'video.project.patch', summary: '关闭自动推进', input: { autoAdvance: false } }],
      },
      assertPreview: (preview) => assert.equal(preview.document.production.autoAdvance, false),
    },
  ]

  for (const entry of cases) {
    await withStore(async (store) => {
      const fixture = modeFixture(entry.modeId)
      store.initializeModeDocument(fixture.created.catalog, fixture.document, { baseRevision: 0, now: 2_000 })
      const before = store.getModeDocument(fixture.request.documentId)
      let observedContext
      const result = await composeWorkspaceCreativePlan({
        request: fixture.request,
        workspaceStore: store,
        agentAdapter: fakeAdapter(entry.candidate, ({ context }) => { observedContext = context }),
        idFactory: idFactory(),
        now: () => 3_000,
      })

      assert.equal(result.plan.source.kind, 'byok-text')
      assert.equal(result.plan.source.modelId, 'fake-planner')
      assert.equal(result.plan.source.requestHash, 'a'.repeat(64))
      assert.equal(result.preview.baseRevision, 0)
      assert.equal(result.preview.resultRevision, 1)
      assert.deepEqual(result.contextDisclosure.excludes, ['API 密钥', '本机路径', '媒体 URL 与媒体字节', '任务私有路径'])
      const fullPreview = previewCreativePlan(JSON.parse(before.value), result.plan, {
        workspaceRevision: 0,
        now: 3_000,
      })
      entry.assertPreview(fullPreview)
      const after = store.getModeDocument(fixture.request.documentId)
      assert.deepEqual(after, before)
      assert.deepEqual(store.listAgentPlanReceipts(fixture.request.projectId), [])
      assert.ok(observedContext)
    })
  }
})

test('bounded context redacts media bytes, local paths, URLs and credential-shaped text', () => {
  const fixture = modeFixture('balanced')
  const context = buildCreativePlanContext('balanced', JSON.parse(fixture.document.value))
  const serialized = JSON.stringify(context)
  assert.equal(serialized.includes('TOPSECRETBYTES'), false)
  assert.equal(serialized.includes('C:\\private'), false)
  assert.equal(serialized.includes('private.example'), false)
  assert.equal(serialized.includes('sk-abcdefgh12345678'), false)
  assert.equal(serialized.includes('[媒体数据已省略]'), false, 'media fields are omitted rather than summarized')
  assert.equal(serialized.includes('[本机路径已省略]'), true)
  assert.equal(serialized.includes('[外部链接已省略]'), true)
  assert.equal(serialized.includes('[凭据已省略]'), true)
})

test('unknown tools, unsafe references, unrequested deletion, cross identity and revision drift fail without a plan write', async () => {
  await withStore(async (store) => {
    const fixture = modeFixture('balanced')
    store.initializeModeDocument(fixture.created.catalog, fixture.document, { baseRevision: 0, now: 2_000 })
    const before = store.getModeDocument(fixture.request.documentId)
    const run = (candidate, request = fixture.request, observe) => composeWorkspaceCreativePlan({
      request,
      workspaceStore: store,
      agentAdapter: fakeAdapter(candidate, observe),
      idFactory: idFactory(),
      now: () => 3_000,
    })

    await assert.rejects(
      run({ title: '越权', objective: '调用隐藏工具', steps: [{ toolId: 'canvas.document.reset', summary: '重置', input: {} }] }),
      (error) => error instanceof AgentPlanComposerError && error.code === 'AGENT_PLAN_TOOL_NOT_EXPOSED',
    )
    await assert.rejects(
      run({ title: '路径', objective: '写入路径', steps: [{
        toolId: 'canvas.elements.patch', summary: '写入路径',
        input: { updates: [{ id: 'note-source', patch: { content: 'file:///C:/private/image.png' } }] },
      }] }),
      (error) => error instanceof AgentPlanComposerError && error.code === 'AGENT_PLAN_UNSAFE_REFERENCE',
    )
    await assert.rejects(
      run({ title: '删除', objective: '静默删除', steps: [{
        toolId: 'canvas.elements.remove', summary: '删除便签', input: { ids: ['note-source'] },
      }] }),
      (error) => error instanceof AgentPlanComposerError && error.code === 'AGENT_PLAN_DELETE_NOT_REQUESTED',
    )
    await assert.rejects(
      run({ title: '跨项目', objective: '无效', steps: [{
        toolId: 'canvas.elements.patch', summary: '调整', input: { updates: [{ id: 'note-source', patch: { x: 20 } }] },
      }] }, { ...fixture.request, projectId: 'project-other' }),
      (error) => error instanceof AgentPlanComposerError && error.code === 'WORKSPACE_PROJECT_NOT_FOUND',
    )
    await assert.rejects(
      run({ title: '失效对象', objective: '尝试修改不存在的对象', steps: [{
        toolId: 'canvas.elements.patch', summary: '移动不存在的对象',
        input: { updates: [{ id: 'missing-element', patch: { x: 20 } }] },
      }] }),
      (error) => error instanceof AgentPlanComposerError
        && error.code === 'AGENT_PLAN_CANDIDATE_REJECTED'
        && error.status === 422,
    )
    assert.deepEqual(store.getModeDocument(fixture.request.documentId), before)

    const safeCandidate = { title: '调整', objective: '安全调整', steps: [{
      toolId: 'canvas.elements.patch', summary: '移动便签', input: { updates: [{ id: 'note-source', patch: { x: 20 } }] },
    }] }
    await assert.rejects(
      run(safeCandidate, fixture.request, () => {
        const changed = JSON.parse(before.value)
        changed.revision = 1
        changed.updatedAt = 2_500
        store.saveModeDocument({
          projectId: fixture.request.projectId,
          documentId: fixture.request.documentId,
          modeId: fixture.request.modeId,
          revision: 1,
          baseRevision: 0,
          value: JSON.stringify(changed),
        }, { now: 2_500 })
      }),
      (error) => error instanceof AgentPlanComposerError && error.code === 'REVISION_CONFLICT',
    )

    assert.equal(store.listAgentPlanReceipts(fixture.request.projectId).length, 0)
    assert.equal(store.getModeDocument(fixture.request.documentId).revision, 1, 'only the simulated concurrent edit is present')
  })
})
