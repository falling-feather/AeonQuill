import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

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
    assert.equal(storedVideo.production.schemaVersion, 2)
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
