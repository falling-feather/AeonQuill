import test from 'node:test'
import assert from 'node:assert/strict'
import { createPixelDocument } from '../src/lib/pixel/pixelCore.mjs'
import { createSmartPixelCleanupPatch } from '../src/lib/pixel/pixelTools.mjs'
import {
  PIXEL_DIRECTIONS,
  PixelGamePipelineError,
  createPixelAnimationClipExportBundle,
  createPixelGameExportBundle,
  createPixelGameManifest,
  createPixelTerrainPreviewExportBundle,
  createPixelTerrainPreviewLayout,
  renderPixelTerrainPreviewRgba,
} from '../src/lib/pixel/pixelGamePipeline.mjs'

function createEightFrameDocument() {
  const layers = [{
    id: 'body',
    name: 'Body',
    visible: true,
    locked: false,
    opacity: 1,
    groupId: 'character',
    blendMode: 'screen',
  }]
  const frames = Array.from({ length: 8 }, (_, index) => ({
    id: `direction-${index + 1}`,
    name: `Direction ${index + 1}`,
    durationMs: 100 + index * 10,
    gameplay: {
      anchor: index === 0 ? { x: 1, y: 2 } : { x: 0, y: 0 },
      collisions: index === 0
        ? [{ id: 'feet', name: 'Feet', type: 'solid', x: 0, y: 1, width: 2, height: 1 }]
        : [],
      tileRule: index < 2 ? { terrainId: 'grass', bitmask: index === 0 ? 85 : 170 } : null,
    },
    cels: { body: ['ink', null, null, index % 2 === 0 ? 'paper' : 'ink'] },
  }))
  return createPixelDocument({
    id: 'hero-eight-way',
    name: 'Hero Eight Way',
    width: 2,
    height: 2,
    layerGroups: [{ id: 'character', name: 'Character', visible: true, locked: false }],
    layers,
    frames,
    animationTags: [
      { id: 'walk', name: 'Walk', fromFrameId: 'direction-1', toFrameId: 'direction-4', direction: 'forward', loop: true },
      { id: 'turn', name: 'Turn', fromFrameId: 'direction-5', toFrameId: 'direction-8', direction: 'ping-pong', loop: false },
    ],
    animationEvents: [
      { id: 'step', name: 'Step', type: 'sfx', animationTagId: 'walk', frameId: 'direction-2', value: 'sfx.step' },
      { id: 'turn-hit', name: 'Turn hit', type: 'hit', animationTagId: 'turn', frameId: 'direction-7', value: 'sword' },
    ],
    paletteCycles: [{
      id: 'ink-pulse', name: 'Ink pulse', colorIds: ['ink', 'paper'], stepDurationMs: 80, direction: 'ping-pong', enabled: true,
    }],
    activeLayerId: 'body',
    activeFrameId: frames[0].id,
  })
}

function createTerrainDocument(masks = [28, 124, 112, 31, 255, 241, 7, 199, 193]) {
  const layers = [{
    id: 'terrain-layer', name: 'Terrain', visible: true, locked: false, opacity: 1, groupId: null, blendMode: 'normal',
  }]
  const frames = masks.map((bitmask, index) => ({
    id: `terrain-${index + 1}`,
    name: `Terrain ${bitmask}`,
    durationMs: 100,
    gameplay: {
      anchor: { x: 0, y: 1 },
      collisions: [],
      tileRule: { terrainId: 'stone', bitmask },
    },
    cels: { 'terrain-layer': [index % 2 === 0 ? 'ink' : 'paper'] },
  }))
  return createPixelDocument({
    id: 'terrain-nine-grid',
    name: 'Terrain Nine Grid',
    width: 1,
    height: 1,
    layers,
    frames,
    activeLayerId: layers[0].id,
    activeFrameId: frames[0].id,
  })
}

test('builds a deterministic eight-direction game manifest with anchors and tile mapping', () => {
  const document = createEightFrameDocument()
  const manifest = createPixelGameManifest(document, { columns: 4, mapWidth: 3, mapHeight: 3 })
  assert.equal(manifest.kind, 'aeonquill.pixel-game-bundle')
  assert.equal(manifest.schemaVersion, 5)
  assert.deepEqual(manifest.animationEvents, document.animationEvents)
  assert.deepEqual(manifest.paletteCycles, document.paletteCycles)
  assert.deepEqual(manifest.layerGroups, document.layerGroups)
  assert.equal(manifest.layers[0].blendMode, 'screen')
  assert.equal(manifest.animation.id, 'walk')
  assert.deepEqual(manifest.animation.frames.map((frame) => frame.id), ['direction-1', 'direction-2', 'direction-3', 'direction-4'])
  assert.deepEqual(manifest.animations[1].frames.map((frame) => frame.id), [
    'direction-5', 'direction-6', 'direction-7', 'direction-8', 'direction-7', 'direction-6',
  ])
  assert.equal(manifest.directions.length, PIXEL_DIRECTIONS.length)
  assert.deepEqual(manifest.directions.map((direction) => direction.frameId), document.frames.map((frame) => frame.id))
  assert.deepEqual(manifest.frames[0].anchor, { x: 1, y: 2 })
  assert.deepEqual(manifest.frames[0].collisions, [
    { id: 'feet', name: 'Feet', type: 'solid', x: 0, y: 1, width: 2, height: 1 },
  ])
  assert.deepEqual(manifest.frames[0].tileRule, { terrainId: 'grass', bitmask: 85 })
  assert.deepEqual(manifest.frames[1].anchor, { x: 0, y: 0 })
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
  assert.equal(tileset.tiles[0].objectgroup.objects[0].class, 'solid')
  assert.equal(tileset.tiles[0].objectgroup.objects[0].properties[0].value, 'feet')
  assert.deepEqual(tileset.wangsets[0].colors.map((color) => color.name), ['grass'])
  assert.equal(tileset.wangsets[0].type, 'mixed')
  assert.deepEqual(tileset.wangsets[0].wangtiles[0], {
    tileid: 0,
    wangid: [1, 0, 1, 0, 1, 0, 1, 0],
  })
  assert.match(bundle.viewer.text, /image-rendering:pixelated/)
  assert.match(bundle.viewer.text, /collisionColors/)
  assert.match(bundle.viewer.text, /Terrain/)
  assert.match(bundle.viewer.text, /paletteCycles/)
  assert.equal(/https?:\/\//.test(bundle.viewer.text), false)
})

test('exports one active animation clip with a unique atlas and exact playback, event and palette facts', () => {
  const document = createEightFrameDocument()
  const bundle = createPixelAnimationClipExportBundle(document, 'turn', { columns: 2, padding: 1, spacing: 1 })
  assert.equal(bundle.sprite.filename, 'Hero-Eight-Way-Turn-clip.png')
  assert.equal(bundle.manifest.value.kind, 'aeonquill.pixel-animation-clip')
  assert.equal(bundle.manifest.value.schemaVersion, 5)
  assert.deepEqual(bundle.manifest.value.frames.map((frame) => frame.frameId), [
    'direction-5', 'direction-6', 'direction-7', 'direction-8',
  ])
  assert.deepEqual(bundle.manifest.value.animation.frameIds, [
    'direction-5', 'direction-6', 'direction-7', 'direction-8', 'direction-7', 'direction-6',
  ])
  assert.deepEqual(bundle.manifest.value.events.map((event) => event.id), ['turn-hit'])
  assert.deepEqual(bundle.manifest.value.paletteCycles, document.paletteCycles)
  assert.equal(bundle.sprite.pixels.length, bundle.sprite.width * bundle.sprite.height * 4)
})

test('infers gated eight-neighbour masks and matches a deterministic nine-grid terrain set', () => {
  const document = createTerrainDocument()
  const full = createPixelTerrainPreviewLayout(document, {
    terrainId: 'stone',
    occupancy: Array(9).fill(true),
  })
  assert.equal(full.kind, 'aeonquill.pixel-terrain-preview')
  assert.equal(full.exactCount, 9)
  assert.equal(full.fallbackCount, 0)
  assert.deepEqual(full.cells.map((cell) => cell.expectedBitmask), [28, 124, 112, 31, 255, 241, 7, 199, 193])
  assert.deepEqual(full.cells.map((cell) => cell.matchedBitmask), [28, 124, 112, 31, 255, 241, 7, 199, 193])

  const diagonalWithoutGates = createPixelTerrainPreviewLayout(document, {
    terrainId: 'stone',
    occupancy: [false, false, true, false, true, false, false, false, false],
  })
  assert.equal(diagonalWithoutGates.cells[4].expectedBitmask, 0)
  assert.equal(diagonalWithoutGates.cells[4].exact, false)
  assert.equal(diagonalWithoutGates.cells[4].matchedBitmask, 28)
})

test('terrain preview reports stable fallback, renders pixels, exports facts and rejects unsafe input', () => {
  const document = createTerrainDocument([1, 2])
  const occupancy = [false, false, false, false, true, false, false, false, false]
  const preview = createPixelTerrainPreviewLayout(document, { terrainId: 'stone', occupancy })
  assert.equal(preview.exactCount, 0)
  assert.equal(preview.fallbackCount, 1)
  assert.equal(preview.cells[4].expectedBitmask, 0)
  assert.equal(preview.cells[4].frameId, 'terrain-1')
  assert.equal(preview.cells[4].distance, 1)

  const rendered = renderPixelTerrainPreviewRgba(document, { terrainId: 'stone', occupancy })
  assert.equal(rendered.width, 3)
  assert.equal(rendered.height, 3)
  assert.equal(rendered.pixels.length, 36)
  assert.deepEqual(Array.from(rendered.pixels.slice((4 * 4), (4 * 4) + 4)), [23, 24, 33, 255])

  const bundle = createPixelTerrainPreviewExportBundle(document, { terrainId: 'stone', occupancy })
  assert.equal(bundle.sprite.filename, 'Terrain-Nine-Grid-stone-terrain-preview.png')
  assert.equal(bundle.manifest.value.image, bundle.sprite.filename)
  assert.equal(bundle.manifest.value.cells[4].frameId, 'terrain-1')
  assert.equal(JSON.parse(bundle.manifest.text).fallbackCount, 1)

  assert.throws(
    () => createPixelTerrainPreviewLayout(document, { terrainId: 'missing', occupancy }),
    (error) => error instanceof PixelGamePipelineError && error.code === 'UNKNOWN_TERRAIN',
  )
  assert.throws(
    () => createPixelTerrainPreviewLayout(document, { terrainId: 'stone', occupancy: [true] }),
    (error) => error instanceof PixelGamePipelineError && error.code === 'INVALID_TERRAIN_OCCUPANCY',
  )
  assert.throws(
    () => createPixelTerrainPreviewLayout(document, { terrainId: 'stone', occupancy, surprise: true }),
    (error) => error instanceof PixelGamePipelineError && error.code === 'UNKNOWN_FIELD',
  )
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
  assert.throws(
    () => createPixelGameManifest(document, { animationTagId: 'missing' }),
    (error) => error instanceof PixelGamePipelineError && error.code === 'UNKNOWN_ANIMATION_TAG',
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
