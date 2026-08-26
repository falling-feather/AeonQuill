import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ProjectStore, ProjectStoreError } from '../server/project-store.mjs'

const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAFAgIACQFe3gAAAABJRU5ErkJggg=='
const pixelVariant = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

async function withStore(run) {
  const root = await mkdtemp(join(tmpdir(), 'aeonquill-library-'))
  const store = await new ProjectStore(root).open()
  try {
    await run(store, root)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
}

test('global assets link into a project without copying content and can be found by tag', async () => {
  await withStore(async (store, root) => {
    const collection = store.createLibraryCollection({
      id: 'collection-global-brand', scope: 'global', title: '品牌母版',
    }, { now: 1_000 })
    const global = await store.createLibraryAsset({
      id: 'library-global-hero',
      scope: 'global',
      title: '主角立绘',
      description: '跨模式使用的固定人物资产',
      tags: ['武侠', '角色'],
      collectionIds: [collection.id],
      dataUrl: pixel,
    }, { now: 2_000 })
    const linked = store.linkLibraryAssetToProject(global.id, 'project-wuxia', undefined, { now: 3_000 })

    assert.equal(linked.relationship, 'global-reference')
    assert.equal(linked.version.assetId, global.version.assetId)
    assert.equal(store.listLibraryAssets({ scope: 'project', projectId: 'project-wuxia' }).length, 1)
    assert.equal(store.listLibraryAssets({ scope: 'global', query: '固定人物', tags: ['角色'] })[0].id, global.id)
    assert.equal((await readdir(join(root, 'assets'))).length, 1)
  })
})

test('project derivatives and versions preserve immutable global originals and parent lineage', async () => {
  await withStore(async (store, root) => {
    const global = await store.createLibraryAsset({
      id: 'library-global-product', scope: 'global', title: '砚台原件', tags: ['产品'], dataUrl: pixel,
    }, { now: 1_000 })
    const projectCollection = store.createLibraryCollection({
      id: 'collection-project-shots', scope: 'project', projectId: 'project-ad', title: '广告镜头',
    }, { now: 2_000 })
    const derived = await store.deriveLibraryAsset(global.id, {
      id: 'library-project-product',
      projectId: 'project-ad',
      title: '砚台暖色版',
      tags: ['产品', '暖色'],
      collectionIds: [projectCollection.id],
    }, { now: 3_000 })

    assert.equal(derived.scope, 'project')
    assert.equal(derived.version.assetId, global.version.assetId)
    assert.equal(derived.version.parentVersionId, global.version.id)
    assert.equal(derived.collections[0].id, projectCollection.id)
    assert.equal((await readdir(join(root, 'assets'))).length, 1)

    const edited = await store.addLibraryAssetVersion(derived.id, {
      projectId: 'project-ad', dataUrl: pixelVariant,
    }, { now: 4_000 })
    assert.equal(edited.version.version, 2)
    assert.equal(edited.version.parentVersionId, derived.version.id)
    assert.notEqual(edited.version.assetId, global.version.assetId)
    assert.equal(store.getLibraryAsset(global.id).version.assetId, global.version.assetId)
    assert.equal((await readdir(join(root, 'assets'))).length, 2)
  })
})

test('global originals reject in-place content edits and foreign project access', async () => {
  await withStore(async (store) => {
    const global = await store.createLibraryAsset({
      id: 'library-global-lock', scope: 'global', title: '全局原件', dataUrl: pixel,
    })
    await assert.rejects(
      () => store.addLibraryAssetVersion(global.id, { projectId: 'project-a', dataUrl: pixelVariant }),
      (error) => error instanceof ProjectStoreError && error.code === 'LIBRARY_ORIGINAL_IMMUTABLE',
    )
    const local = await store.deriveLibraryAsset(global.id, {
      id: 'library-project-lock', projectId: 'project-a', title: '项目派生',
    })
    assert.throws(
      () => store.getLibraryAsset(local.id, { projectId: 'project-b' }),
      (error) => error instanceof ProjectStoreError && error.code === 'LIBRARY_ITEM_FORBIDDEN',
    )
  })
})

test('library references protect content from garbage collection', async () => {
  await withStore(async (store) => {
    const item = await store.createLibraryAsset({
      id: 'library-global-gc', scope: 'global', title: '保留素材', dataUrl: pixel,
    })
    assert.deepEqual(await store.collectGarbage(), [])
    assert.ok(store.getAsset(item.version.assetId))
  })
})

test('scope, tags and collection boundaries fail closed', async () => {
  await withStore(async (store) => {
    const projectCollection = store.createLibraryCollection({
      id: 'collection-project-only', scope: 'project', projectId: 'project-a', title: '项目集合',
    })
    await assert.rejects(
      () => store.createLibraryAsset({
        id: 'library-invalid-collection', scope: 'global', title: '错误集合',
        collectionIds: [projectCollection.id], dataUrl: pixel,
      }),
      (error) => error instanceof ProjectStoreError && error.code === 'LIBRARY_COLLECTION_SCOPE_MISMATCH',
    )
    await assert.rejects(
      () => store.createLibraryAsset({
        id: 'library-invalid-tags', scope: 'project', projectId: 'project-a', title: '重复标签',
        tags: ['角色', '角色'], dataUrl: pixel,
      }),
      (error) => error instanceof ProjectStoreError && error.code === 'INVALID_LIBRARY_TAGS',
    )
  })
})
