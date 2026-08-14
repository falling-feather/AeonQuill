import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PixelContractError,
  applyPixelCommand,
  assertPixelDocument,
  createPixelCommand,
  createPixelDocument,
  createSpriteSheetLayout,
  createSpriteSheetMetadata,
  deserializePixelDocument,
  migratePixelDocument,
  renderPixelFrameRgba,
  renderSpriteSheetRgba,
  serializePixelDocument,
} from '../src/lib/pixel/pixelCore.mjs'

const palette = [
  { id: 'red', name: 'Red', color: '#FF0000FF' },
  { id: 'blue', name: 'Blue', color: '#0000FFFF' },
  { id: 'mist', name: 'Mist', color: '#FFFFFFFF' },
]

function execute(document, type, payload, actor = 'user') {
  return applyPixelCommand(document, createPixelCommand(document, type, payload, {
    id: `test-${document.revision + 1}`,
    actor,
  }))
}

function withoutRevision(document) {
  const copy = structuredClone(document)
  delete copy.revision
  return copy
}

function makeMultiLayerMultiFrameDocument() {
  let document = createPixelDocument({
    id: 'sprite-test',
    name: 'Two frame sprite',
    width: 2,
    height: 2,
    palette,
  })
  document = execute(document, 'layers.add', {
    layer: { id: 'highlight', name: 'Highlight', visible: true, locked: false, opacity: 1 },
  }).document
  document = execute(document, 'frames.add', {
    frame: { id: 'frame-2', name: 'Frame 2', durationMs: 240 },
    copyFromFrameId: 'frame-1',
  }).document
  document = execute(document, 'pixels.paint', {
    frameId: 'frame-1',
    layerId: 'layer-1',
    pixels: [{ x: 0, y: 0, colorId: 'red' }, { x: 1, y: 1, colorId: 'red' }],
  }).document
  document = execute(document, 'pixels.paint', {
    frameId: 'frame-1',
    layerId: 'highlight',
    pixels: [{ x: 0, y: 0, colorId: 'blue' }],
  }).document
  document = execute(document, 'pixels.paint', {
    frameId: 'frame-2',
    layerId: 'layer-1',
    pixels: [{ x: 1, y: 0, colorId: 'red' }],
  }).document
  return document
}

test('builds a fixed multi-layer, multi-frame document and composites top layers deterministically', () => {
  const document = makeMultiLayerMultiFrameDocument()
  assert.equal(document.layers.length, 2)
  assert.equal(document.frames.length, 2)
  assert.equal(document.frames[0].cels['layer-1'][0], 'red')
  assert.equal(document.frames[0].cels.highlight[0], 'blue')

  const rgba = renderPixelFrameRgba(document, 'frame-1')
  assert.deepEqual(Array.from(rgba.slice(0, 4)), [0, 0, 255, 255])
  assert.deepEqual(Array.from(rgba.slice(12, 16)), [255, 0, 0, 255])
})

test('rejects unknown fields, invalid cells, unsafe coordinates and edits to locked layers', () => {
  const document = createPixelDocument({ width: 2, height: 2, palette })
  assert.throws(
    () => assertPixelDocument({ ...document, hiddenPayload: true }),
    (error) => error instanceof PixelContractError && error.code === 'UNKNOWN_FIELD',
  )

  const badCel = structuredClone(document)
  badCel.frames[0].cels['layer-1'][2] = 'missing-color'
  assert.throws(
    () => assertPixelDocument(badCel),
    (error) => error instanceof PixelContractError && error.code === 'UNKNOWN_COLOR',
  )

  assert.throws(
    () => createPixelCommand(document, 'pixels.paint', {
      frameId: 'frame-1',
      layerId: 'layer-1',
      pixels: [{ x: 2, y: 0, colorId: 'red' }],
    }),
    (error) => error instanceof PixelContractError && error.code === 'INVALID_INTEGER',
  )

  const locked = execute(document, 'layers.patch', {
    layerId: 'layer-1',
    patch: { locked: true },
  }).document
  assert.throws(
    () => createPixelCommand(locked, 'pixels.erase', {
      frameId: 'frame-1',
      layerId: 'layer-1',
      pixels: [{ x: 0, y: 0 }],
    }),
    (error) => error instanceof PixelContractError && error.code === 'LAYER_LOCKED',
  )
})

test('paint, erase, palette, layer and frame commands return applicable inverse commands', () => {
  let document = makeMultiLayerMultiFrameDocument()

  for (const [type, payload] of [
    ['pixels.erase', { frameId: 'frame-1', layerId: 'highlight', pixels: [{ x: 0, y: 0 }] }],
    ['palette.replace', { colorId: 'blue', color: '#3366CCFF', name: 'Ocean' }],
    ['layers.remove', { layerId: 'highlight' }],
    ['frames.remove', { frameId: 'frame-2' }],
  ]) {
    const before = document
    const changed = execute(before, type, payload)
    const restored = applyPixelCommand(changed.document, changed.inverse)
    assert.deepEqual(withoutRevision(restored.document), withoutRevision(before), `${type} should be reversible`)
    document = restored.document
  }
})

test('applies a multi-pixel gesture as one revision and one complete inverse command', () => {
  const before = createPixelDocument({ width: 4, height: 4, palette })
  const result = execute(before, 'pixels.paint', {
    frameId: 'frame-1',
    layerId: 'layer-1',
    pixels: [
      { x: 0, y: 0, colorId: 'red' },
      { x: 1, y: 0, colorId: 'red' },
      { x: 2, y: 1, colorId: 'red' },
      { x: 3, y: 2, colorId: 'red' },
    ],
  })

  assert.equal(result.document.revision, before.revision + 1)
  assert.equal(result.inverse.type, 'pixels.restore')
  assert.equal(result.inverse.payload.pixels.length, 4)
  const restored = applyPixelCommand(result.document, result.inverse)
  assert.deepEqual(withoutRevision(restored.document), withoutRevision(before))
})

test('switches and reorders layers and frames while keeping onion-skin settings reversible', () => {
  let document = makeMultiLayerMultiFrameDocument()
  const original = document

  document = execute(document, 'layers.reorder', { layerIds: ['highlight', 'layer-1'] }).document
  document = execute(document, 'frames.reorder', { frameIds: ['frame-2', 'frame-1'] }).document
  document = execute(document, 'layers.select', { layerId: 'layer-1' }).document
  document = execute(document, 'frames.select', { frameId: 'frame-1' }).document
  const onionChange = execute(document, 'onion-skin.set', {
    patch: { enabled: false, previousFrames: 2, nextFrames: 0, opacity: 0.4 },
  })

  assert.deepEqual(onionChange.document.layers.map((layer) => layer.id), ['highlight', 'layer-1'])
  assert.deepEqual(onionChange.document.frames.map((frame) => frame.id), ['frame-2', 'frame-1'])
  assert.deepEqual(onionChange.document.onionSkin, {
    enabled: false,
    previousFrames: 2,
    nextFrames: 0,
    opacity: 0.4,
  })
  const onionRestored = applyPixelCommand(onionChange.document, onionChange.inverse)
  assert.deepEqual(onionRestored.document.onionSkin, original.onionSkin)
})

test('serializes schema v1 without loss and migrates the existing single-layer palette-index format', () => {
  const document = makeMultiLayerMultiFrameDocument()
  const serialized = serializePixelDocument(document)
  assert.equal(serializePixelDocument(deserializePixelDocument(serialized)), serialized)

  const migrated = migratePixelDocument({
    version: 0,
    id: 'legacy-sprite',
    name: 'Legacy',
    width: 2,
    height: 2,
    palette: ['transparent', '#112233', '#ABCDEF80'],
    pixels: ['1', '.', 2, 0],
    frameDurationMs: 90,
  })
  assert.equal(migrated.schemaVersion, 1)
  assert.deepEqual(migrated.frames[0].cels['layer-1'], ['color-1', null, 'color-2', null])
  assert.equal(migrated.palette[0].color, '#112233FF')
  assert.equal(migrated.frames[0].durationMs, 90)
})

test('produces bounded sprite-sheet layout, metadata and RGBA pixels in document frame order', () => {
  let document = makeMultiLayerMultiFrameDocument()
  document = execute(document, 'frames.add', {
    frame: { id: 'frame-3', name: 'Frame 3', durationMs: 360 },
  }).document

  const layout = createSpriteSheetLayout(document, { columns: 2, padding: 1, spacing: 1 })
  assert.deepEqual(
    { width: layout.width, height: layout.height, columns: layout.columns, rows: layout.rows },
    { width: 7, height: 7, columns: 2, rows: 2 },
  )
  assert.deepEqual(layout.cells.map(({ frameId, x, y }) => ({ frameId, x, y })), [
    { frameId: 'frame-1', x: 1, y: 1 },
    { frameId: 'frame-2', x: 4, y: 1 },
    { frameId: 'frame-3', x: 1, y: 4 },
  ])

  const metadata = createSpriteSheetMetadata(document, { columns: 2, padding: 1, spacing: 1 })
  assert.equal(metadata.kind, 'aeonquill.sprite-sheet')
  assert.deepEqual(metadata.frames.map((frame) => frame.durationMs), [120, 240, 360])

  const rendered = renderSpriteSheetRgba(document, { columns: 2, padding: 1, spacing: 1 })
  assert.equal(rendered.pixels.length, 7 * 7 * 4)
  const firstCellOffset = (1 * 7 + 1) * 4
  assert.deepEqual(Array.from(rendered.pixels.slice(firstCellOffset, firstCellOffset + 4)), [0, 0, 255, 255])
})
