import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectStore } from '../server/project-store.mjs'

const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAFAgIACQFe3gAAAABJRU5ErkJggg=='
const pixelVariant = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

function document(id = 'project-1', revision = 1) {
  return {
    schemaVersion: 1,
    id,
    title: 'Portable project',
    revision,
    createdAt: 1,
    updatedAt: revision + 1,
    camera: { x: 0, y: 0, zoom: 1 },
    elements: [{
      id: 'image-1', kind: 'image', name: 'Image', x: 0, y: 0, width: 1, height: 1,
      rotation: 0, opacity: 1, radius: 0, fill: '#fff', stroke: '#000', src: pixel,
      sourceSrc: pixel, locked: false, visible: true, zIndex: 1,
    }],
  }
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'miaohui-project-store-'))
  const store = await new ProjectStore(root).open()
  t.after(async () => {
    store.close()
    await rm(root, { recursive: true, force: true })
  })
  return { root, store }
}

test('externalizes embedded media into one immutable content-addressed asset', async (t) => {
  const { root, store } = await fixture(t)
  const saved = await store.saveProject(document())
  assert.equal(saved.assets.length, 1)
  assert.match(saved.assets[0].id, /^[a-f0-9]{64}$/)
  assert.equal(saved.document.elements[0].src, `/api/project-assets/${saved.assets[0].id}`)
  assert.equal(saved.document.elements[0].sourceSrc, saved.document.elements[0].src)
  assert.equal(saved.document.elements[0].assetId, 'asset-image-1')
  assert.match(saved.document.elements[0].assetVersionId, /^asset-version-[a-f0-9]{32}$/)
  assert.equal(saved.assetVersions.length, 1)
  assert.equal(saved.assetVersions[0].assetId, saved.assets[0].id)
  assert.equal((await stat(join(root, 'assets', `${saved.assets[0].id}.png`))).isFile(), true)
})

test('100 saves preserve project nodes and reject a stale writer', async (t) => {
  const { store } = await fixture(t)
  let current = document('project-100', 0)
  for (let revision = 0; revision < 100; revision += 1) {
    current = {
      ...current,
      revision,
      updatedAt: revision + 1,
      elements: [{ ...current.elements[0], x: revision, src: revision === 0 ? pixel : current.elements[0].src }],
    }
    const saved = await store.saveProject(current)
    current = saved.document
  }
  store.close()
  await store.open()
  const reopened = store.getProject('project-100')
  assert.equal(reopened.revision, 99)
  assert.equal(reopened.document.elements.length, 1)
  assert.equal(reopened.document.elements[0].x, 99)
  await assert.rejects(
    () => store.saveProject({ ...reopened.document, revision: 98 }),
    (error) => error.code === 'PROJECT_REVISION_CONFLICT',
  )
})

test('records immutable logical asset versions with parent lineage', async (t) => {
  const { store } = await fixture(t)
  const first = document('versioned', 1)
  first.elements[0].assetId = 'hero-character'
  first.elements[0].assetVersion = 1
  const savedFirst = await store.saveProject(first)
  const secondDocument = {
    ...savedFirst.document,
    revision: 2,
    updatedAt: 3,
    elements: [{
      ...savedFirst.document.elements[0],
      src: pixelVariant,
      assetVersion: 2,
    }],
  }
  const savedSecond = await store.saveProject(secondDocument)
  assert.equal(savedSecond.assets.length, 2)
  assert.equal(savedSecond.assetVersions.length, 2)
  const versionOne = savedSecond.assetVersions.find((version) => version.version === 1)
  const versionTwo = savedSecond.assetVersions.find((version) => version.version === 2)
  assert.equal(versionTwo.logicalAssetId, 'hero-character')
  assert.equal(versionTwo.parentVersionId, versionOne.id)
  assert.notEqual(versionTwo.assetId, versionOne.assetId)

  await assert.rejects(() => store.saveProject({
    ...savedSecond.document,
    revision: 3,
    updatedAt: 4,
    elements: [{ ...savedSecond.document.elements[0], src: pixel, assetVersion: 2 }],
  }), (error) => error.code === 'ASSET_VERSION_CONFLICT')
})

test('failed saves are atomic and leave neither metadata nor staged blobs', async (t) => {
  const { root, store } = await fixture(t)
  const saved = await store.saveProject(document('atomic', 1))
  const filesBefore = await readdir(join(root, 'assets'))
  const missingAssetId = 'f'.repeat(64)
  await assert.rejects(() => store.saveProject({
    ...saved.document,
    revision: 2,
    updatedAt: 3,
    elements: [{
      ...saved.document.elements[0],
      src: pixelVariant,
      sourceSrc: `/api/project-assets/${missingAssetId}`,
      assetVersion: 2,
    }],
  }), (error) => error.code === 'ASSET_NOT_FOUND')
  assert.deepEqual(await readdir(join(root, 'assets')), filesBefore)
  assert.equal(store.getProject('atomic').revision, 1)
})

test('portable package round-trips document, hashes and provenance', async (t) => {
  const { root, store } = await fixture(t)
  const saved = await store.saveProject(document('portable', 4))
  const exportDirectory = join(root, 'portable-export')
  const manifest = await store.exportProject('portable', exportDirectory)
  assert.equal(manifest.assets.length, 1)
  assert.equal(manifest.assets[0].sha256, saved.assets[0].id)

  const destinationRoot = await mkdtemp(join(tmpdir(), 'miaohui-project-import-'))
  const importedStore = await new ProjectStore(destinationRoot).open()
  try {
    const imported = await importedStore.importProject(exportDirectory, { projectId: 'portable-copy' })
    assert.equal(imported.id, 'portable-copy')
    assert.equal(imported.document.elements[0].assetId, saved.document.elements[0].assetId)
    assert.equal(imported.assetVersions[0].assetId, saved.assets[0].id)
    assert.equal(imported.assetVersions[0].id, saved.assetVersions[0].id)
    assert.deepEqual(imported.assets[0].provenance, saved.assets[0].provenance)
    assert.deepEqual(
      await readFile(join(destinationRoot, 'assets', `${saved.assets[0].id}.png`)),
      await readFile(join(root, 'assets', `${saved.assets[0].id}.png`)),
    )
  } finally {
    importedStore.close()
    await rm(destinationRoot, { recursive: true, force: true })
  }
})

test('single-file MiaoHui bundle round-trips and rejects binary tampering', async (t) => {
  const { store } = await fixture(t)
  const saved = await store.saveProject(document('bundle', 7))
  const bundle = await store.exportProjectBundle('bundle')
  assert.equal(bundle[0], 0x1f)
  assert.equal(bundle[1], 0x8b)

  const imported = await store.importProjectBundle(bundle, { projectId: 'bundle-copy' })
  assert.equal(imported.document.id, 'bundle-copy')
  assert.equal(imported.document.elements[0].assetId, saved.document.elements[0].assetId)
  assert.equal(imported.assetVersions[0].assetId, saved.assets[0].id)
  const tampered = Buffer.from(bundle)
  tampered[Math.floor(tampered.length / 2)] ^= 0xff
  await assert.rejects(() => store.importProjectBundle(tampered), (error) =>
    error.code === 'INVALID_PROJECT_PACKAGE' || error.code === 'ASSET_HASH_MISMATCH',
  )
})

test('garbage collection never removes a referenced asset', async (t) => {
  const { root, store } = await fixture(t)
  const saved = await store.saveProject(document('kept', 1))
  assert.deepEqual(await store.collectGarbage(), [])
  assert.equal((await stat(join(root, 'assets', `${saved.assets[0].id}.png`))).isFile(), true)
  assert.equal(await store.deleteProject('kept'), true)
  assert.deepEqual(await store.collectGarbage(), [saved.assets[0].id])
  await assert.rejects(() => stat(join(root, 'assets', `${saved.assets[0].id}.png`)), { code: 'ENOENT' })
})

test('package import rejects tampered asset bytes', async (t) => {
  const { root, store } = await fixture(t)
  const saved = await store.saveProject(document('tamper', 1))
  const exportDirectory = join(root, 'tampered-export')
  await store.exportProject('tamper', exportDirectory)
  await import('node:fs/promises').then(({ writeFile }) =>
    writeFile(join(exportDirectory, 'assets', `${saved.assets[0].id}.png`), Buffer.from('tampered')),
  )
  await assert.rejects(() => store.importProject(exportDirectory, { projectId: 'tamper-copy' }), (error) =>
    error.code === 'ASSET_HASH_MISMATCH',
  )
})
