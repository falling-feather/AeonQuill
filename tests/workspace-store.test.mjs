import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { createCanvasDocument } from '../src/lib/canvasCore.mjs'
import { approveCreativePlan, createCreativePlan } from '../src/lib/agent/creativePlan.mjs'
import { createPixelDocument, serializePixelDocument } from '../src/lib/pixel/pixelCore.mjs'
import {
  addProjectDocument,
  createProjectCatalog,
  createWorkspaceProject,
  setProjectStatus,
  touchProjectDocument,
} from '../src/lib/project/projectCatalog.mjs'
import { compileStoryProject, createGenerationPlan } from '../src/lib/story/storyProject.mjs'
import {
  SMART_VIDEO_DOCUMENT_SCHEMA_VERSION,
  WorkspaceStore,
  WorkspaceStoreError,
} from '../server/workspace-store.mjs'

async function withStore(run) {
  const root = await mkdtemp(join(tmpdir(), 'aeonquill-workspace-store-'))
  const safeRoot = resolve(root)
  assert.equal(safeRoot.startsWith(resolve(tmpdir())), true)
  let store
  try {
    store = await new WorkspaceStore(root).open()
    await run(store, root)
  } finally {
    store?.close()
    await rm(safeRoot, { recursive: true, force: true })
  }
}

function twoProjectCatalog() {
  let result = createWorkspaceProject(createProjectCatalog(), {
    title: '品牌广告',
    initialModeId: 'smart-video',
  }, { now: 1_000, projectId: 'project-ad', documentId: 'document-video' })
  result = createWorkspaceProject(result.catalog, {
    title: '像素资产',
    initialModeId: 'pixel',
  }, { now: 2_000, projectId: 'project-pixel', documentId: 'document-pixel' })
  return result.catalog
}

function initialPixelDocument(created) {
  return {
    projectId: created.project.id,
    documentId: created.document.id,
    modeId: 'pixel',
    revision: 0,
    value: serializePixelDocument(createPixelDocument({
      id: created.document.id,
      name: created.document.title,
      width: 16,
      height: 16,
      revision: 0,
    })),
  }
}

function initialBalancedDocument(created) {
  return {
    projectId: created.project.id,
    documentId: created.document.id,
    modeId: 'balanced',
    revision: 0,
    value: JSON.stringify(createCanvasDocument({
      id: created.document.id,
      title: created.document.title,
      elements: [],
      camera: { x: 0, y: 0, zoom: 1 },
      now: 1_000,
    })),
  }
}

function balancedAgentPlan(created, overrides = {}) {
  return createCreativePlan({
    id: overrides.id ?? 'agent-plan-balanced-1',
    projectId: created.project.id,
    documentId: created.document.id,
    modeId: 'balanced',
    baseRevision: overrides.baseRevision ?? 0,
    title: overrides.title ?? '添加受控便签',
    objective: '通过同一画布工具建立可撤销便签。',
    source: { kind: 'deterministic-local', agentRole: 'layout-director', modelId: null, requestHash: null },
    steps: overrides.steps ?? [{
      id: 'agent-step-balanced-1',
      toolId: 'canvas.elements.add',
      summary: '在画布中添加一张便签',
      input: { elements: [{
        id: 'agent-note-1', kind: 'note', name: 'Agent note', x: 20, y: 30,
        width: 180, height: 120, rotation: 0, opacity: 1, radius: 0,
        fill: '#FFF4C2', stroke: '#E7CE75', content: '受控计划', locked: false,
        visible: true, zIndex: 1,
      }] },
      sourceAssets: [],
    }],
    createdAt: 3_000,
  })
}

test('catalog and revision-zero mode body initialize atomically and retry idempotently', async () => {
  await withStore(async (store) => {
    const created = createWorkspaceProject(createProjectCatalog(), {
      title: '原子像素项目', initialModeId: 'pixel',
    }, { now: 1_000, projectId: 'project-atomic', documentId: 'document-atomic' })
    const document = initialPixelDocument(created)
    const first = store.initializeModeDocument(created.catalog, document, {
      baseRevision: 0,
      now: 2_000,
      source: 'unit-create',
    })

    assert.equal(first.catalog.revision, 1)
    assert.equal(first.document.revision, 0)
    assert.equal(JSON.parse(first.document.value).id, created.document.id)
    assert.equal(store.getCatalog().catalog.projects[0].id, created.project.id)

    const retry = store.initializeModeDocument(created.catalog, document, {
      baseRevision: 0,
      now: 3_000,
      source: 'unit-retry',
    })
    assert.deepEqual(retry.document, first.document)
    assert.equal(store.getCatalog().catalog.revision, 1)
  })
})

test('initialization rejects stale catalog writers without leaving a catalog-only project', async () => {
  await withStore(async (store) => {
    const first = createWorkspaceProject(createProjectCatalog(), {
      title: '已提交项目', initialModeId: 'pixel',
    }, { now: 1_000, projectId: 'project-first', documentId: 'document-first' })
    store.initializeModeDocument(first.catalog, initialPixelDocument(first), {
      baseRevision: 0,
      now: 2_000,
    })
    const stale = createWorkspaceProject(createProjectCatalog(), {
      title: '过期写入', initialModeId: 'pixel',
    }, { now: 3_000, projectId: 'project-stale', documentId: 'document-stale' })

    assert.throws(
      () => store.initializeModeDocument(stale.catalog, initialPixelDocument(stale), {
        baseRevision: 0,
        now: 4_000,
      }),
      (error) => error instanceof WorkspaceStoreError && error.code === 'WORKSPACE_CATALOG_CONFLICT',
    )
    assert.equal(store.getCatalog().catalog.projects.some(({ id }) => id === 'project-stale'), false)
    assert.equal(store.getModeDocument('document-stale'), null)
  })
})

test('invalid initial body fails before the catalog transaction and leaves no partial entry', async () => {
  await withStore(async (store) => {
    const created = createWorkspaceProject(createProjectCatalog(), {
      title: '非法正文', initialModeId: 'balanced',
    }, { now: 1_000, projectId: 'project-invalid', documentId: 'document-invalid' })
    const wrongId = createCanvasDocument({
      id: 'other-document',
      title: created.document.title,
      elements: [],
      camera: { x: 0, y: 0, zoom: 1 },
      now: 1_000,
    })

    assert.throws(
      () => store.initializeModeDocument(created.catalog, {
        projectId: created.project.id,
        documentId: created.document.id,
        modeId: 'balanced',
        revision: 0,
        value: JSON.stringify(wrongId),
      }, { baseRevision: 0, now: 2_000 }),
      (error) => error instanceof WorkspaceStoreError && error.code === 'MODE_DOCUMENT_ID_MISMATCH',
    )
    assert.deepEqual(store.getCatalog().catalog.projects, [])
    assert.equal(store.getModeDocument(created.document.id), null)
  })
})

test('revision-zero catalog-only entries are backfilled without advancing the catalog', async () => {
  await withStore(async (store) => {
    const created = createWorkspaceProject(createProjectCatalog(), {
      title: '历史空入口', initialModeId: 'pixel',
    }, { now: 1_000, projectId: 'project-backfill', documentId: 'document-backfill' })
    store.saveCatalog(created.catalog, { baseRevision: 0, now: 2_000 })
    const recovered = store.initializeModeDocument(created.catalog, initialPixelDocument(created), {
      baseRevision: created.catalog.revision,
      now: 3_000,
      source: 'unit-backfill',
    })

    assert.equal(recovered.catalog.revision, created.catalog.revision)
    assert.equal(recovered.document.revision, 0)
    assert.equal(store.getModeDocument(created.document.id).documentId, created.document.id)
  })
})

test('approved Agent plan atomically advances body, catalog and immutable receipt with idempotent replay', async () => {
  await withStore(async (store) => {
    const created = createWorkspaceProject(createProjectCatalog(), {
      title: 'Agent 画布', initialModeId: 'balanced',
    }, { now: 1_000, projectId: 'project-agent', documentId: 'document-agent' })
    store.initializeModeDocument(created.catalog, initialBalancedDocument(created), {
      baseRevision: 0,
      now: 2_000,
    })
    const approved = await approveCreativePlan(balancedAgentPlan(created), { approvedAt: 4_000 })
    const committed = await store.commitApprovedCreativePlan(approved, { now: 5_000 })

    assert.equal(committed.replayed, false)
    assert.equal(committed.document.revision, 1)
    assert.equal(JSON.parse(committed.document.value).elements[0].id, 'agent-note-1')
    const catalog = store.getCatalog().catalog
    assert.equal(catalog.projects[0].documents[0].revision, 1)
    assert.equal(store.listAgentPlanReceipts(created.project.id).length, 1)
    assert.equal(store.listAgentPlanReceipts(created.project.id, { documentId: created.document.id })[0].planId, approved.plan.id)
    assert.equal(store.listRecoveryPoints(created.project.id).some(({ reason }) => reason === 'before-agent-plan'), true)

    const replay = await store.commitApprovedCreativePlan(approved, { now: 6_000 })
    assert.equal(replay.replayed, true)
    assert.equal(replay.document.revision, 1)
    assert.equal(store.listAgentPlanReceipts(created.project.id).length, 1)
  })
})

test('stale, tampered and unknown Agent plans leave body, catalog and receipt set unchanged', async () => {
  await withStore(async (store) => {
    const created = createWorkspaceProject(createProjectCatalog(), {
      title: 'Agent 拒绝门', initialModeId: 'balanced',
    }, { now: 1_000, projectId: 'project-agent-reject', documentId: 'document-agent-reject' })
    store.initializeModeDocument(created.catalog, initialBalancedDocument(created), {
      baseRevision: 0,
      now: 2_000,
    })
    const stale = await approveCreativePlan(balancedAgentPlan(created, {
      id: 'agent-plan-stale', baseRevision: 1,
    }), { approvedAt: 4_000 })
    await assert.rejects(
      () => store.commitApprovedCreativePlan(stale, { now: 5_000 }),
      (error) => error instanceof WorkspaceStoreError && error.code === 'REVISION_CONFLICT',
    )

    const tampered = await approveCreativePlan(balancedAgentPlan(created, {
      id: 'agent-plan-tampered',
    }), { approvedAt: 4_000 })
    tampered.plan.steps[0].input.elements[0].content = '审批后被篡改'
    await assert.rejects(
      () => store.commitApprovedCreativePlan(tampered, { now: 5_000 }),
      (error) => error instanceof WorkspaceStoreError && error.code === 'PLAN_APPROVAL_MISMATCH',
    )

    const unknown = await approveCreativePlan(balancedAgentPlan(created, {
      id: 'agent-plan-unknown',
      steps: [{ id: 'agent-step-unknown', toolId: 'canvas.document.reset', summary: '越权重置', input: {}, sourceAssets: [] }],
    }), { approvedAt: 4_000 })
    await assert.rejects(
      () => store.commitApprovedCreativePlan(unknown, { now: 5_000 }),
      (error) => error instanceof WorkspaceStoreError && ['ACTOR_FORBIDDEN', 'UNKNOWN_FIELD'].includes(error.code),
    )

    const crossProject = await approveCreativePlan(createCreativePlan({
      ...balancedAgentPlan(created, { id: 'agent-plan-cross-project' }),
      projectId: 'another-project',
    }), { approvedAt: 4_000 })
    await assert.rejects(
      () => store.commitApprovedCreativePlan(crossProject, { now: 5_000 }),
      (error) => error instanceof WorkspaceStoreError && error.code === 'WORKSPACE_PROJECT_NOT_FOUND',
    )

    const crossMode = await approveCreativePlan(createCreativePlan({
      ...balancedAgentPlan(created, { id: 'agent-plan-cross-mode' }),
      modeId: 'pixel',
    }), { approvedAt: 4_000 })
    await assert.rejects(
      () => store.commitApprovedCreativePlan(crossMode, { now: 5_000 }),
      (error) => error instanceof WorkspaceStoreError && error.code === 'WORKSPACE_MODE_MISMATCH',
    )

    assert.equal(store.getModeDocument(created.document.id).revision, 0)
    assert.equal(store.getCatalog().catalog.projects[0].documents[0].revision, 0)
    assert.deepEqual(store.listAgentPlanReceipts(created.project.id), [])
  })
})

test('SQLite catalog is authoritative, monotonic and survives reopen', async () => {
  await withStore(async (store, root) => {
    const catalog = twoProjectCatalog()
    const saved = store.saveCatalog(catalog, { baseRevision: 0, now: 3_000 })
    assert.equal(saved.catalog.projects.length, 2)
    assert.equal(saved.catalog.revision, 2)
    assert.throws(
      () => store.saveCatalog({ ...catalog, revision: 3 }, { baseRevision: 0, now: 4_000 }),
      (error) => error instanceof WorkspaceStoreError && error.code === 'WORKSPACE_CATALOG_CONFLICT',
    )
    store.close()
    const reopened = await new WorkspaceStore(root).open()
    assert.deepEqual(reopened.getCatalog().catalog, catalog)
    reopened.close()
  })
})

test('pixel and smart-video documents remain isolated by project and document id', async () => {
  await withStore(async (store) => {
    const catalog = twoProjectCatalog()
    store.saveCatalog(catalog, { baseRevision: 0, now: 3_000 })
    const pixel = createPixelDocument({ id: 'document-pixel', name: '像素资产', width: 4, height: 4, revision: 1 })
    const story = compileStoryProject({
      projectId: 'document-video',
      title: '品牌广告',
      kind: 'idea',
      text: '墨滴化为一道时间长河，最终落在光阴砚界面。',
      aspectRatio: '16:9',
      frameStrategy: 'start-end',
      defaultShotSeconds: 5,
      now: 4_000,
    })
    const plan = createGenerationPlan(story, { now: 4_000 })
    const smartVideo = JSON.stringify({
      schemaVersion: 1,
      project: story,
      plan,
    })

    store.saveModeDocument({
      projectId: 'project-pixel', documentId: 'document-pixel', modeId: 'pixel',
      baseRevision: null, revision: 1, value: serializePixelDocument(pixel),
    }, { now: 5_000 })
    store.saveModeDocument({
      projectId: 'project-ad', documentId: 'document-video', modeId: 'smart-video',
      baseRevision: null, revision: story.revision, value: smartVideo,
    }, { now: 6_000 })

    assert.equal(store.getModeDocument('document-pixel').projectId, 'project-pixel')
    const storedVideo = JSON.parse(store.getModeDocument('document-video').value)
    assert.equal(storedVideo.schemaVersion, SMART_VIDEO_DOCUMENT_SCHEMA_VERSION)
    assert.equal(storedVideo.plan.projectId, 'document-video')
    assert.equal(storedVideo.production.schemaVersion, 5)
    assert.throws(
      () => store.saveModeDocument({
        projectId: 'project-ad', documentId: 'document-pixel', modeId: 'pixel',
        baseRevision: 1, revision: 2, value: serializePixelDocument({ ...pixel, revision: 2 }),
      }),
      (error) => error instanceof WorkspaceStoreError && error.code === 'WORKSPACE_DOCUMENT_NOT_FOUND',
    )
  })
})

test('stale mode writers fail closed and recovery restores a prior body as a new revision', async () => {
  await withStore(async (store) => {
    let catalog = twoProjectCatalog()
    store.saveCatalog(catalog, { baseRevision: 0, now: 3_000 })
    const first = createPixelDocument({ id: 'document-pixel', name: '第一版', width: 2, height: 2, revision: 1 })
    const second = { ...first, name: '第二版', revision: 2 }
    store.saveModeDocument({
      projectId: 'project-pixel', documentId: 'document-pixel', modeId: 'pixel',
      baseRevision: null, revision: 1, value: serializePixelDocument(first),
    }, { now: 4_000 })
    store.saveModeDocument({
      projectId: 'project-pixel', documentId: 'document-pixel', modeId: 'pixel',
      baseRevision: 1, revision: 2, value: serializePixelDocument(second),
    }, { now: 5_000, forceRecovery: true })

    assert.throws(
      () => store.saveModeDocument({
        projectId: 'project-pixel', documentId: 'document-pixel', modeId: 'pixel',
        baseRevision: 1, revision: 3, value: serializePixelDocument({ ...second, revision: 3 }),
      }),
      (error) => error instanceof WorkspaceStoreError && error.code === 'WORKSPACE_DOCUMENT_CONFLICT',
    )
    const recovery = store.listRecoveryPoints('project-pixel').find(({ documentId }) => documentId === 'document-pixel')
    assert.ok(recovery)
    const restored = store.restoreRecoveryPoint(recovery.id, { now: 6_000 })
    assert.equal(restored.document.revision, 3)
    assert.equal(JSON.parse(restored.document.value).name, '第一版')
    assert.equal(JSON.parse(restored.document.value).revision, 3)
    assert.equal(restored.catalog.projects.find(({ id }) => id === 'project-pixel').documents[0].revision, 3)
  })
})

test('catalog checkpoints are project-scoped and cannot silently move document ownership', async () => {
  await withStore(async (store) => {
    const catalog = twoProjectCatalog()
    store.saveCatalog(catalog, { baseRevision: 0, now: 3_000 })
    const touched = touchProjectDocument(catalog, 'project-pixel', 'document-pixel', {
      title: '像素角色', revision: 5,
    }, { now: 4_000 })
    store.saveCatalog(touched, { baseRevision: catalog.revision, now: 4_000 })
    assert.equal(store.listRecoveryPoints('project-pixel').length, 1)
    assert.equal(store.listRecoveryPoints('project-ad').length, 0)

    const moved = structuredClone(touched)
    const [document] = moved.projects[1].documents.splice(0, 1)
    moved.projects[0].documents.push(document)
    moved.projects[1].documents.push({ ...document, id: 'replacement-pixel' })
    moved.revision += 1
    assert.throws(
      () => store.saveCatalog(moved, { baseRevision: touched.revision, now: 5_000 }),
      (error) => error instanceof WorkspaceStoreError && error.code === 'WORKSPACE_DOCUMENT_OWNERSHIP_CHANGE',
    )
  })
})

test('purging an expired project removes only its registered mode bodies and recovery points', async () => {
  await withStore(async (store) => {
    const day = 24 * 60 * 60 * 1_000
    let catalog = twoProjectCatalog()
    store.saveCatalog(catalog, { baseRevision: 0, now: 3_000 })
    const pixel = createPixelDocument({ id: 'document-pixel', name: '待删除', width: 2, height: 2, revision: 1 })
    store.saveModeDocument({
      projectId: 'project-pixel', documentId: 'document-pixel', modeId: 'pixel',
      baseRevision: null, revision: 1, value: serializePixelDocument(pixel),
    }, { now: 4_000 })
    store.createRecoveryPoint('project-pixel', { documentId: 'document-pixel', now: 5_000 })
    catalog = setProjectStatus(catalog, 'project-pixel', 'trashed', { now: day })
    store.saveCatalog(catalog, { baseRevision: 2, now: day })
    const purged = { ...catalog, revision: catalog.revision + 1, projects: catalog.projects.filter(({ id }) => id !== 'project-pixel') }
    store.saveCatalog(purged, { baseRevision: catalog.revision, now: day * 16 })
    assert.equal(store.getModeDocument('document-pixel'), null)
    assert.deepEqual(store.listRecoveryPoints('project-pixel'), [])
    assert.equal(store.getCatalog().catalog.projects.map(({ id }) => id).join(','), 'project-ad')
  })
})

test('storage references include rollback-only project assets and job outputs', async () => {
  await withStore(async (store) => {
    const assetId = 'a'.repeat(64)
    const jobFilename = 'recovery-native.mp4'
    const created = createWorkspaceProject(createProjectCatalog(), {
      title: '恢复点引用', initialModeId: 'balanced',
    }, { now: 1_000, projectId: 'project-recovery-assets', documentId: 'document-balanced' })
    store.saveCatalog(created.catalog, { baseRevision: 0, now: 2_000 })
    const first = {
      schemaVersion: 1,
      id: 'document-balanced',
      title: '引用版本',
      revision: 1,
      createdAt: 1_000,
      updatedAt: 3_000,
      camera: { x: 0, y: 0, zoom: 1 },
      elements: [{
        id: 'image-recovery', kind: 'image', name: 'Recovery asset', x: 0, y: 0, width: 1, height: 1,
        rotation: 0, opacity: 1, radius: 0, fill: '#fff', stroke: '#000',
        src: `/api/project-assets/${assetId}`,
        sourceSrc: `/api/assets/${jobFilename}`,
        jobId: 'job-recovery-reference',
        locked: false, visible: true, zIndex: 1,
      }],
    }
    store.saveModeDocument({
      projectId: created.project.id,
      documentId: created.document.id,
      modeId: 'balanced',
      baseRevision: null,
      revision: 1,
      value: JSON.stringify(first),
    }, { now: 3_000 })
    store.saveModeDocument({
      projectId: created.project.id,
      documentId: created.document.id,
      modeId: 'balanced',
      baseRevision: 1,
      revision: 2,
      value: JSON.stringify({ ...first, revision: 2, updatedAt: 4_000, elements: [] }),
    }, { now: 4_000, forceRecovery: true })

    const references = store.storageReferences()
    assert.deepEqual(references.projectAssetIds, [assetId])
    assert.deepEqual(references.jobAssetFilenames, [jobFilename])
    assert.equal(references.sources.recoveryPoints, 1)
    assert.deepEqual(store.jobReferences(), ['job-recovery-reference'])
  })
})
