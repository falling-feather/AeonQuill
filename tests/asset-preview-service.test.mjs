import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AssetPreviewService, assertAssetVariant } from '../server/asset-preview-service.mjs'

const assetId = 'a'.repeat(64)

test('validates versioned preview tiers', () => {
  assert.equal(assertAssetVariant('thumbnail-v1'), 'thumbnail-v1')
  assert.equal(assertAssetVariant('preview-v1'), 'preview-v1')
  assert.throws(() => assertAssetVariant('original'), { code: 'INVALID_ASSET_VARIANT' })
})

test('deduplicates concurrent generation, caches output, and removes derived variants', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'miaohui-preview-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const inputPath = join(root, 'input.png')
  await writeFile(inputPath, Buffer.from('source'))
  let renders = 0
  const service = await new AssetPreviewService({
    rootDirectory: join(root, 'cache'),
    renderer: async ({ outputPath, maxEdge }) => {
      renders += 1
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 15))
      await writeFile(outputPath, Buffer.from(`webp-${maxEdge}`))
    },
  }).open()
  const request = { assetId, inputPath, mimeType: 'image/png' }
  const [first, second] = await Promise.all([
    service.materialize(request, 'thumbnail-v1'),
    service.materialize(request, 'thumbnail-v1'),
  ])
  assert.equal(first.path, second.path)
  assert.equal(renders, 1)
  assert.equal((await readFile(first.path)).toString(), 'webp-512')
  await service.materialize(request, 'thumbnail-v1')
  assert.equal(renders, 1)
  await service.materialize(request, 'preview-v1')
  assert.equal(renders, 2)
  await service.removeVariants([assetId])
  await assert.rejects(readFile(first.path), { code: 'ENOENT' })
})

test('rejects non-image source assets before rendering', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'miaohui-preview-type-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const service = await new AssetPreviewService({
    rootDirectory: root,
    renderer: async () => assert.fail('renderer must not be called'),
  }).open()
  await assert.rejects(
    service.materialize({ assetId, inputPath: join(root, 'video.mp4'), mimeType: 'video/mp4' }, 'preview-v1'),
    { code: 'ASSET_PREVIEW_UNSUPPORTED' },
  )
})
