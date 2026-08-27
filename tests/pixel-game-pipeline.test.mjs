import test from 'node:test'
import assert from 'node:assert/strict'
import { createPixelDocument } from '../src/lib/pixel/pixelCore.mjs'
import { createSmartPixelCleanupPatch } from '../src/lib/pixel/pixelTools.mjs'
import {
  PIXEL_DIRECTIONS,
  PixelGamePipelineError,
  createPixelGameExportBundle,
  createPixelGameManifest,
} from '../src/lib/pixel/pixelGamePipeline.mjs'

function createEightFrameDocument() {
  const layers = [{ id: 'body', name: 'Body', visible: true, locked: false, opacity: 1 }]
  const frames = Array.from({ length: 8 }, (_, index) => ({
    id: `direction-${index + 1}`,
    name: `Direction ${index + 1}`,
    durationMs: 100 + index * 10,
    cels: { body: ['ink', null, null, index % 2 === 0 ? 'paper' : 'ink'] },
  }))
  return createPixelDocument({
    id: 'hero-eight-way',
    name: 'Hero Eight Way',
    width: 2,
    height: 2,
    layers,
    frames,
    activeLayerId: 'body',
    activeFrameId: frames[0].id,
  })
}

test('builds a deterministic eight-direction game manifest with anchors and tile mapping', () => {
  const document = createEightFrameDocument()
  const manifest = createPixelGameManifest(document, { columns: 4, mapWidth: 3, mapHeight: 3, anchor: { x: 1, y: 2 } })
  assert.equal(manifest.kind, 'aeonquill.pixel-game-bundle')
  assert.equal(manifest.directions.length, PIXEL_DIRECTIONS.length)
  assert.deepEqual(manifest.directions.map((direction) => direction.frameId), document.frames.map((frame) => frame.id))
  assert.deepEqual(manifest.frames[0].anchor, { x: 1, y: 2 })
  assert.equal(manifest.tilemap.data.length, 9)
  assert.deepEqual(manifest.tilemap.data.slice(0, 8), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.equal(manifest.tilemap.data[8], 0)
})

test('exports one sprite fact into manifest, Tiled map and an offline viewer', () => {
  const bundle = createPixelGameExportBundle(createEightFrameDocument(), { columns: 4, mapWidth: 4, mapHeight: 2 })
  const tileset = JSON.parse(bundle.tiledTileset.text)
  const tilemap = JSON.parse(bundle.tiledMap.text)
  assert.equal(bundle.sprite.filename, 'Hero-Eight-Way-sprite-sheet.png')
  assert.equal(bundle.manifest.value.image, bundle.sprite.filename)
  assert.equal(tileset.image, bundle.sprite.filename)
  assert.equal(tilemap.tilesets[0].source, bundle.tiledTileset.filename)
  assert.equal(tilemap.layers[0].data.length, 8)
  assert.match(bundle.viewer.text, /image-rendering:pixelated/)
  assert.equal(/https?:\/\//.test(bundle.viewer.text), false)
})

test('fails closed when a direction or map points at an unknown frame', () => {
  const document = createEightFrameDocument()
  assert.throws(
    () => createPixelGameManifest(document, { directionFrameIds: { north: 'missing' } }),
    (error) => error instanceof PixelGamePipelineError && error.code === 'UNKNOWN_FRAME',
  )
  assert.throws(
    () => createPixelGameManifest(document, { mapWidth: 2, mapHeight: 2, mapFrameIds: ['direction-1'] }),
    (error) => error instanceof PixelGamePipelineError && error.code === 'INVALID_TILEMAP',
  )
})

test('smart cleanup removes only isolated specks and fills strict four-neighbour pinholes', () => {
  const cel = [
    'ink', null, null, null, null,
    null, null, 'paper', null, null,
    null, 'paper', null, 'paper', null,
    null, null, 'paper', null, null,
    null, null, null, null, null,
  ]
  const result = createSmartPixelCleanupPatch(cel, 5, 5)
  assert.deepEqual(result.pixels, [
    { x: 0, y: 0, value: null },
    { x: 2, y: 2, value: 'paper' },
  ])
  assert.deepEqual(result.report, {
    scannedPixels: 25,
    isolatedRemoved: 1,
    pinholesFilled: 1,
    changedPixels: 2,
  })
})
