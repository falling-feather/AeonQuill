import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { gzip, gunzip } from 'node:zlib'

import { createPixelDocument, serializePixelDocument } from '../src/lib/pixel/pixelCore.mjs'
import {
  addProjectDocument,
  createProjectCatalog,
  createWorkspaceProject,
  touchProjectDocument,
} from '../src/lib/project/projectCatalog.mjs'
import { createVideoProductionProjectForStory } from '../src/lib/story/productionPipeline.mjs'
import { compileStoryProject, createGenerationPlan } from '../src/lib/story/storyProject.mjs'
import { ProjectPackageService } from '../server/project-package.mjs'
import { ProjectStore } from '../server/project-store.mjs'
import { WorkspaceStore } from '../server/workspace-store.mjs'

const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)
const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAFAgIACQFe3gAAAABJRU5ErkJggg=='

function canvasDocument(id = 'document-balanced') {
  return {
    schemaVersion: 1,
    id,
    title: '三模式广告画布',
    revision: 1,
    createdAt: 1_000,
    updatedAt: 2_000,
    camera: { x: 12, y: -8, zoom: 1.25 },
    elements: [{
      id: 'image-brand', kind: 'image', name: '品牌母图', x: 10, y: 20, width: 320, height: 180,
      rotation: 0, opacity: 1, radius: 8, fill: '#fff', stroke: '#000', src: pixel,
      sourceSrc: pixel, locked: false, visible: true, zIndex: 1,
    }],
  }
}

async function stores(t, prefix = 'aeonquill-package-') {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const projectStore = await new ProjectStore(join(root, 'projects')).open()
  const workspaceStore = await new WorkspaceStore(join(root, 'workspaces')).open()
  const service = new ProjectPackageService({ projectStore, workspaceStore })
  t.after(async () => {
    workspaceStore.close()
    projectStore.close()
    await rm(root, { recursive: true, force: true })
  })
  return { root, projectStore, workspaceStore, service }
}

async function populateThreeModeProject(target) {
  let created = createWorkspaceProject(createProjectCatalog(), {
    title: '跨模式武侠广告',
    description: '均衡母图、像素角色和智能视频共用一个项目资源图。',
    initialModeId: 'balanced',
    color: 'amber',
  }, { now: 1_000, projectId: 'project-wuxia-ad', documentId: 'document-balanced' })
  let catalog = created.catalog
  catalog = addProjectDocument(catalog, 'project-wuxia-ad', {
    modeId: 'pixel', title: '像素角色',
  }, { now: 1_100, documentId: 'document-pixel' }).catalog
  catalog = addProjectDocument(catalog, 'project-wuxia-ad', {
    modeId: 'smart-video', title: '视频制片',
  }, { now: 1_200, documentId: 'document-video' }).catalog
  catalog = touchProjectDocument(catalog, 'project-wuxia-ad', 'document-balanced', { revision: 1 }, { now: 2_000 })
  catalog = touchProjectDocument(catalog, 'project-wuxia-ad', 'document-pixel', { revision: 1 }, { now: 2_100 })
  target.workspaceStore.saveCatalog(catalog, { baseRevision: 0, now: 2_200, source: 'package-fixture' })

  const balanced = await target.projectStore.saveProject(canvasDocument(), { now: 2_300 })
  target.workspaceStore.saveModeDocument({
    projectId: 'project-wuxia-ad', documentId: 'document-balanced', modeId: 'balanced',
    baseRevision: null, revision: 1, value: JSON.stringify(balanced.document),
  }, { now: 2_400 })

  const pixelDocument = createPixelDocument({ id: 'document-pixel', name: '墨客行走', width: 2, height: 2, revision: 1 })
  pixelDocument.frames[0].cels[pixelDocument.layers[0].id][0] = 'ink'
  target.workspaceStore.saveModeDocument({
    projectId: 'project-wuxia-ad', documentId: 'document-pixel', modeId: 'pixel',
    baseRevision: null, revision: 1, value: serializePixelDocument(pixelDocument),
  }, { now: 2_500 })

  const story = compileStoryProject({
    projectId: 'document-video',
    title: '一念落砚',
    kind: 'idea',
    text: '雨夜，侠客以墨为剑守护一卷品牌手稿。\n黎明，他将光阴写入砚台。',
    aspectRatio: '16:9',
    frameStrategy: 'start-end',
    defaultShotSeconds: 5,
    now: 2_600,
  })
  const plan = createGenerationPlan(story, { now: 2_600 })
  const production = createVideoProductionProjectForStory(story)
  target.workspaceStore.saveModeDocument({
    projectId: 'project-wuxia-ad', documentId: 'document-video', modeId: 'smart-video',
    baseRevision: null, revision: 0,
    value: JSON.stringify({ schemaVersion: 2, project: story, plan, production }),
  }, { now: 2_700 })

  const collection = target.projectStore.createLibraryCollection({
    id: 'collection-project-wuxia', scope: 'project', projectId: 'project-wuxia-ad', title: '跨模式定稿',
  }, { now: 2_800 })
  const globalAsset = await target.projectStore.createLibraryAsset({
    id: 'library-global-ink', scope: 'global', title: '共享墨滴', dataUrl: pixel, tags: ['品牌', '墨色'],
  }, { now: 2_900, source: 'package-fixture-global' })
  target.projectStore.linkLibraryAssetToProject(globalAsset.id, 'project-wuxia-ad', undefined, { now: 3_000 })
  await target.projectStore.deriveLibraryAsset(globalAsset.id, {
    id: 'library-project-ink', projectId: 'project-wuxia-ad', title: '项目墨滴定稿',
    tags: ['定稿'], collectionIds: [collection.id],
  }, { now: 3_100, source: 'package-fixture-derived' })
  target.workspaceStore.createRecoveryPoint('project-wuxia-ad', {
    documentId: 'document-pixel', reason: 'package-fixture-pixel', now: 3_200,
  })
  target.workspaceStore.createRecoveryPoint('project-wuxia-ad', {
    documentId: 'document-video', reason: 'package-fixture-video', now: 3_300,
  })
}

test('complete AEONQUILL package round-trips three mode bodies, recoveries, resources and provenance', async (t) => {
  const source = await stores(t, 'aeonquill-package-source-')
  await populateThreeModeProject(source)
  const exported = await source.service.exportBundle('project-wuxia-ad', { now: 4_000 })
  assert.equal(exported.preview.complete, true)
  assert.deepEqual(exported.preview.documents.byMode, { balanced: 1, pixel: 1, 'smart-video': 1 })
  assert.deepEqual(exported.preview.documents.bodiesByMode, { balanced: 1, pixel: 1, 'smart-video': 1 })
  assert.equal(exported.preview.recoveryPoints, 2)
  assert.equal(exported.preview.library.projectItems, 1)
  assert.equal(exported.preview.library.globalReferences, 1)
  assert.equal(exported.preview.assets.count, 1)

  const destination = await stores(t, 'aeonquill-package-destination-')
  const imported = await destination.service.importBundle(exported.body, { conflictPolicy: 'reject', now: 5_000 })
  assert.equal(imported.legacy, false)
  assert.equal(imported.project.id, 'project-wuxia-ad')
  assert.equal(imported.catalog.projects.length, 1)
  assert.equal(imported.project.documents.length, 3)
  const balanced = destination.workspaceStore.getModeDocument('document-balanced')
  const pixelBody = destination.workspaceStore.getModeDocument('document-pixel')
  const videoBody = destination.workspaceStore.getModeDocument('document-video')
  assert.equal(JSON.parse(balanced.value).elements[0].assetVersionId.startsWith('asset-version-'), true)
  assert.equal(JSON.parse(pixelBody.value).frames[0].cels['layer-1'][0], 'ink')
  assert.equal(JSON.parse(videoBody.value).production.schemaVersion, 4)
  assert.equal(destination.workspaceStore.listRecoveryPoints('project-wuxia-ad').length, 2)
  const library = destination.projectStore.listLibraryAssets({ scope: 'project', projectId: 'project-wuxia-ad' })
  assert.equal(library.length, 2)
  assert.deepEqual(new Set(library.map(({ relationship }) => relationship)), new Set(['global-reference', 'project-owned']))
  assert.equal(library.find(({ id }) => id === 'library-project-ink').version.provenance.source, 'package-fixture-derived')
  assert.equal(destination.projectStore.listProjectAssets('document-balanced').length, 1)
})

test('package inspection rejects binary tampering and canonical-path traversal', async (t) => {
  const source = await stores(t, 'aeonquill-package-tamper-')
  await populateThreeModeProject(source)
  const { body } = await source.service.exportBundle('project-wuxia-ad')
  const tampered = Buffer.from(body)
  tampered[Math.floor(tampered.length / 2)] ^= 0xff
  await assert.rejects(() => source.service.inspectBundle(tampered), (error) =>
    ['INVALID_AEONQUILL_PACKAGE', 'PROJECT_PACKAGE_HASH_MISMATCH'].includes(error.code))

  const envelope = JSON.parse((await gunzipAsync(body)).toString('utf8'))
  envelope.payload.assets[0].path = '../outside.png'
  envelope.payloadSha256 = createHash('sha256').update(JSON.stringify(envelope.payload)).digest('hex')
  const traversal = await gzipAsync(Buffer.from(JSON.stringify(envelope), 'utf8'))
  await assert.rejects(() => source.service.inspectBundle(traversal), (error) =>
    error.code === 'UNSAFE_PROJECT_PACKAGE_PATH')

  const driftEnvelope = JSON.parse((await gunzipAsync(body)).toString('utf8'))
  driftEnvelope.payload.balancedProjects[0].document.elements[0].x += 1
  driftEnvelope.payloadSha256 = createHash('sha256').update(JSON.stringify(driftEnvelope.payload)).digest('hex')
  const driftedMetadata = await gzipAsync(Buffer.from(JSON.stringify(driftEnvelope), 'utf8'))
  await assert.rejects(() => source.service.inspectBundle(driftedMetadata), (error) =>
    error.code === 'INVALID_AEONQUILL_PACKAGE' && /workspace body and asset metadata disagree/u.test(error.message))
})

test('same-id import rejects by default and copy policy remaps the full graph', async (t) => {
  const source = await stores(t, 'aeonquill-package-conflict-source-')
  await populateThreeModeProject(source)
  const { body } = await source.service.exportBundle('project-wuxia-ad')
  const destination = await stores(t, 'aeonquill-package-conflict-destination-')
  await destination.service.importBundle(body, { conflictPolicy: 'reject', now: 5_000 })
  await assert.rejects(
    () => destination.service.importBundle(body, { conflictPolicy: 'reject', now: 6_000 }),
    (error) => error.code === 'PROJECT_PACKAGE_ID_CONFLICT',
  )
  const copied = await destination.service.importBundle(body, { conflictPolicy: 'copy', now: 7_000 })
  assert.notEqual(copied.project.id, 'project-wuxia-ad')
  assert.equal(copied.project.documents.every(({ id }) => !['document-balanced', 'document-pixel', 'document-video'].includes(id)), true)
  assert.equal(destination.workspaceStore.getCatalog().catalog.projects.length, 2)
  for (const document of copied.project.documents) {
    const bodyRecord = destination.workspaceStore.getModeDocument(document.id)
    assert.equal(bodyRecord.projectId, copied.project.id)
    const parsed = JSON.parse(bodyRecord.value)
    if (document.modeId === 'smart-video') assert.equal(parsed.project.id, document.id)
    else assert.equal(parsed.id, document.id)
  }
  assert.equal(destination.projectStore.listLibraryAssets({ scope: 'project', projectId: copied.project.id }).length, 2)
})

test('low space and injected interruption fail closed without partial metadata or assets', async (t) => {
  const source = await stores(t, 'aeonquill-package-fail-source-')
  await populateThreeModeProject(source)
  const { body } = await source.service.exportBundle('project-wuxia-ad')

  const lowSpace = await stores(t, 'aeonquill-package-low-space-')
  await assert.rejects(
    () => lowSpace.service.importBundle(body, { availableBytes: 0 }),
    (error) => error.code === 'PROJECT_PACKAGE_DISK_SPACE' && error.status === 507,
  )
  assert.equal(lowSpace.workspaceStore.getCatalog().catalog.projects.length, 0)
  assert.deepEqual(await readdir(lowSpace.projectStore.assetDirectory), [])

  const interrupted = await stores(t, 'aeonquill-package-interrupted-')
  await assert.rejects(
    () => interrupted.service.importBundle(body, { availableBytes: Number.MAX_SAFE_INTEGER, interruptAt: 'before-commit' }),
    (error) => error.code === 'PROJECT_PACKAGE_IMPORT_INTERRUPTED',
  )
  assert.equal(interrupted.workspaceStore.getCatalog().catalog.projects.length, 0)
  assert.equal(interrupted.projectStore.getProject('document-balanced'), null)
  assert.deepEqual(interrupted.projectStore.listLibraryAssets({ scope: 'global' }), [])
  assert.deepEqual(await readdir(interrupted.projectStore.assetDirectory), [])
})

test('import repairs a missing known blob but rejects corruption under the same content id', async (t) => {
  const source = await stores(t, 'aeonquill-package-asset-repair-source-')
  await populateThreeModeProject(source)
  const { body } = await source.service.exportBundle('project-wuxia-ad')
  const destination = await stores(t, 'aeonquill-package-asset-repair-destination-')
  await destination.service.importBundle(body, { conflictPolicy: 'reject', now: 7_500 })
  const [asset] = destination.projectStore.listProjectAssets('document-balanced')
  const stored = destination.projectStore.getAsset(asset.id)
  const assetPath = destination.projectStore.assetPath(stored)
  await unlink(assetPath)
  await destination.service.importBundle(body, { conflictPolicy: 'copy', now: 7_600 })
  const repaired = await readFile(assetPath)
  assert.equal(createHash('sha256').update(repaired).digest('hex'), asset.id)

  await writeFile(assetPath, Buffer.from('corrupt-content'))
  await assert.rejects(
    () => destination.service.importBundle(body, { conflictPolicy: 'copy', now: 7_700 }),
    (error) => error.code === 'PROJECT_PACKAGE_HASH_MISMATCH',
  )
})

test('legacy .miaohui remains readable but is explicitly incomplete', async (t) => {
  const source = await stores(t, 'aeonquill-package-legacy-source-')
  await source.projectStore.saveProject(canvasDocument('legacy-canvas'))
  const legacyBundle = await source.projectStore.exportProjectBundle('legacy-canvas')
  const destination = await stores(t, 'aeonquill-package-legacy-destination-')
  const preview = await destination.service.previewImport(legacyBundle)
  assert.equal(preview.format, 'legacy-miaohui-canvas')
  assert.equal(preview.complete, false)
  assert.equal(preview.warnings.some((warning) => warning.includes('不包含像素/智能视频')), true)
  const imported = await destination.service.importBundle(legacyBundle, { conflictPolicy: 'reject', now: 8_000 })
  assert.equal(imported.legacy, true)
  assert.equal(imported.project.documents.length, 1)
  assert.equal(imported.project.documents[0].modeId, 'balanced')
  assert.equal(destination.workspaceStore.getCatalog().catalog.projects.length, 1)
})

test('legacy import interruption rolls back catalog and canvas together', async (t) => {
  const source = await stores(t, 'aeonquill-package-legacy-interrupt-source-')
  await source.projectStore.saveProject(canvasDocument('legacy-interrupted-canvas'))
  const legacyBundle = await source.projectStore.exportProjectBundle('legacy-interrupted-canvas')
  const destination = await stores(t, 'aeonquill-package-legacy-interrupt-destination-')
  await assert.rejects(
    () => destination.service.importBundle(legacyBundle, {
      conflictPolicy: 'reject',
      now: 9_000,
      interruptAt: 'after-legacy-catalog',
    }),
    (error) => error.code === 'PROJECT_PACKAGE_IMPORT_INTERRUPTED',
  )
  assert.equal(destination.workspaceStore.getCatalog().catalog.projects.length, 0)
  assert.equal(destination.workspaceStore.getModeDocument('legacy-interrupted-canvas'), null)
  assert.equal(destination.projectStore.getProject('legacy-interrupted-canvas'), null)
  assert.deepEqual(await readdir(destination.projectStore.assetDirectory), [])
})
