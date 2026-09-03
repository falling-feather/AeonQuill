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
  resolvePixelAnimationSequences,
  resolvePixelAnimationFrames,
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
    layer: {
      id: 'highlight',
      name: 'Highlight',
      visible: true,
      locked: false,
      opacity: 1,
      groupId: null,
      blendMode: 'normal',
    },
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

test('applies mixed transparent and colored pixel patches as one reversible command', () => {
  let document = createPixelDocument({ width: 3, height: 2, palette })
  document = execute(document, 'pixels.paint', {
    frameId: 'frame-1',
    layerId: 'layer-1',
    pixels: [{ x: 0, y: 0, colorId: 'red' }, { x: 1, y: 0, colorId: 'blue' }],
  }).document
  const before = document
  const changed = execute(document, 'pixels.patch', {
    frameId: 'frame-1',
    layerId: 'layer-1',
    pixels: [{ x: 0, y: 0, value: null }, { x: 2, y: 1, value: 'blue' }],
  })

  assert.equal(changed.document.frames[0].cels['layer-1'][0], null)
  assert.equal(changed.document.frames[0].cels['layer-1'][5], 'blue')
  assert.equal(changed.inverse.type, 'pixels.restore')
  assert.deepEqual(withoutRevision(applyPixelCommand(changed.document, changed.inverse).document), withoutRevision(before))

  const locked = execute(changed.document, 'layers.patch', {
    layerId: 'layer-1',
    patch: { locked: true },
  }).document
  assert.throws(
    () => createPixelCommand(locked, 'pixels.patch', {
      frameId: 'frame-1',
      layerId: 'layer-1',
      pixels: [{ x: 0, y: 0, value: 'red' }],
    }),
    (error) => error instanceof PixelContractError && error.code === 'LAYER_LOCKED',
  )
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

test('serializes schema v4 without loss and migrates v1/v2/v3 plus the single-layer palette-index format', () => {
  const document = makeMultiLayerMultiFrameDocument()
  const serialized = serializePixelDocument(document)
  assert.equal(serializePixelDocument(deserializePixelDocument(serialized)), serialized)

  const schemaThree = structuredClone(document)
  schemaThree.schemaVersion = 3
  schemaThree.frames = schemaThree.frames.map(({ gameplay: _gameplay, ...frame }) => frame)
  const migratedSchemaThree = migratePixelDocument(schemaThree)
  assert.equal(migratedSchemaThree.schemaVersion, 4)
  assert.deepEqual(migratedSchemaThree.frames.map((frame) => frame.gameplay), [
    { anchor: { x: 1, y: 2 }, collisions: [], tileRule: null },
    { anchor: { x: 1, y: 2 }, collisions: [], tileRule: null },
  ])

  const schemaTwo = structuredClone(schemaThree)
  schemaTwo.schemaVersion = 2
  delete schemaTwo.layerGroups
  schemaTwo.layers = schemaTwo.layers.map(({ groupId: _groupId, blendMode: _blendMode, ...layer }) => layer)
  const migratedSchemaTwo = migratePixelDocument(schemaTwo)
  assert.equal(migratedSchemaTwo.schemaVersion, 4)
  assert.deepEqual(migratedSchemaTwo.layerGroups, [])
  assert.deepEqual(migratedSchemaTwo.layers.map((layer) => [layer.groupId, layer.blendMode]), [[null, 'normal'], [null, 'normal']])

  const schemaOne = structuredClone(schemaTwo)
  schemaOne.schemaVersion = 1
  delete schemaOne.animationTags
  const migratedSchemaOne = migratePixelDocument(schemaOne)
  assert.equal(migratedSchemaOne.schemaVersion, 4)
  assert.deepEqual(migratedSchemaOne.animationTags, [])

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
  assert.equal(migrated.schemaVersion, 4)
  assert.deepEqual(migrated.frames[0].cels['layer-1'], ['color-1', null, 'color-2', null])
  assert.equal(migrated.palette[0].color, '#112233FF')
  assert.equal(migrated.frames[0].durationMs, 90)
  assert.deepEqual(migrated.frames[0].gameplay, { anchor: { x: 1, y: 2 }, collisions: [], tileRule: null })
})

test('frame gameplay metadata is strict, reversible, copied with frames and preserved in sprite metadata', () => {
  let document = createPixelDocument({ width: 8, height: 6, palette })
  assert.deepEqual(document.frames[0].gameplay, {
    anchor: { x: 4, y: 6 },
    collisions: [],
    tileRule: null,
  })

  const gameplay = {
    anchor: { x: 3, y: 5 },
    collisions: [
      { id: 'feet', name: 'Feet', type: 'solid', x: 2, y: 4, width: 4, height: 2 },
      { id: 'sword', name: 'Sword', type: 'hitbox', x: 5, y: 1, width: 3, height: 2 },
    ],
    tileRule: { terrainId: 'grass', bitmask: 85 },
  }
  const patched = execute(document, 'frames.patch', { frameId: 'frame-1', patch: { gameplay } })
  assert.deepEqual(patched.document.frames[0].gameplay, gameplay)
  assert.deepEqual(
    withoutRevision(applyPixelCommand(patched.document, patched.inverse).document),
    withoutRevision(document),
  )

  const copied = execute(patched.document, 'frames.add', {
    frame: { id: 'frame-copy', name: 'Copy', durationMs: 120 },
    copyFromFrameId: 'frame-1',
  })
  assert.deepEqual(copied.document.frames[1].gameplay, gameplay)
  assert.notEqual(copied.document.frames[1].gameplay, patched.document.frames[0].gameplay)

  const blank = execute(copied.document, 'frames.add', {
    frame: { id: 'frame-blank', name: 'Blank', durationMs: 120 },
  })
  assert.deepEqual(blank.document.frames[2].gameplay, {
    anchor: { x: 4, y: 6 },
    collisions: [],
    tileRule: null,
  })
  const metadata = createSpriteSheetMetadata(blank.document, { columns: 2 })
  assert.equal(metadata.schemaVersion, 4)
  assert.deepEqual(metadata.frames[0].gameplay, gameplay)

  const invalidCases = [
    { ...gameplay, anchor: { x: 9, y: 5 } },
    { ...gameplay, collisions: [...gameplay.collisions, { ...gameplay.collisions[0] }] },
    { ...gameplay, collisions: [{ ...gameplay.collisions[0], type: 'circle' }] },
    { ...gameplay, collisions: [{ ...gameplay.collisions[0], x: 7, width: 2 }] },
    { ...gameplay, tileRule: { terrainId: 'grass', bitmask: 256 } },
    { ...gameplay, hiddenPayload: true },
  ]
  for (const invalid of invalidCases) {
    assert.throws(
      () => execute(patched.document, 'frames.patch', { frameId: 'frame-1', patch: { gameplay: invalid } }),
      (error) => error instanceof PixelContractError,
    )
  }
})

test('layer groups and blend modes are strict, reversible, and share one deterministic RGBA truth', () => {
  const colors = [
    { id: 'base', name: 'Base', color: '#6496C8FF' },
    { id: 'top', name: 'Top', color: '#326496FF' },
  ]
  let document = createPixelDocument({
    id: 'blend-fixture',
    name: 'Blend fixture',
    width: 1,
    height: 1,
    palette: colors,
    layers: [
      { id: 'base', name: 'Base', visible: true, locked: false, opacity: 1, groupId: null, blendMode: 'normal' },
      { id: 'top', name: 'Top', visible: true, locked: false, opacity: 1, groupId: null, blendMode: 'normal' },
    ],
    frames: [{
      id: 'frame-1',
      name: 'Frame 1',
      durationMs: 100,
      cels: { base: ['base'], top: ['top'] },
    }],
    activeLayerId: 'top',
    activeFrameId: 'frame-1',
  })
  assert.throws(
    () => execute(document, 'layers.patch', { layerId: 'top', patch: { groupId: 'missing-group' } }),
    (error) => error instanceof PixelContractError && error.code === 'UNKNOWN_LAYER_GROUP',
  )
  assert.throws(
    () => execute(document, 'layers.patch', { layerId: 'top', patch: { blendMode: 'soft-light' } }),
    (error) => error instanceof PixelContractError && error.code === 'INVALID_BLEND_MODE',
  )

  const added = execute(document, 'groups.add', {
    group: { id: 'character', name: 'Character', visible: true, locked: false },
  })
  document = execute(added.document, 'layers.patch', {
    layerId: 'top',
    patch: { groupId: 'character', blendMode: 'multiply' },
  }).document
  assert.deepEqual(Array.from(renderPixelFrameRgba(document, 'frame-1')), [20, 59, 118, 255])

  document = execute(document, 'layers.patch', { layerId: 'top', patch: { blendMode: 'screen' } }).document
  assert.deepEqual(Array.from(renderPixelFrameRgba(document, 'frame-1')), [130, 191, 232, 255])
  document = execute(document, 'layers.patch', { layerId: 'top', patch: { blendMode: 'add' } }).document
  assert.deepEqual(Array.from(renderPixelFrameRgba(document, 'frame-1')), [150, 250, 255, 255])

  const hidden = execute(document, 'groups.patch', { groupId: 'character', patch: { visible: false } })
  assert.deepEqual(Array.from(renderPixelFrameRgba(hidden.document, 'frame-1')), [100, 150, 200, 255])
  assert.throws(
    () => execute(hidden.document, 'pixels.erase', { frameId: 'frame-1', layerId: 'top', pixels: [{ x: 0, y: 0 }] }),
    (error) => error instanceof PixelContractError && error.code === 'LAYER_GROUP_HIDDEN',
  )
  assert.deepEqual(withoutRevision(applyPixelCommand(hidden.document, hidden.inverse).document), withoutRevision(document))

  const locked = execute(document, 'groups.patch', { groupId: 'character', patch: { locked: true } }).document
  assert.throws(
    () => execute(locked, 'pixels.erase', { frameId: 'frame-1', layerId: 'top', pixels: [{ x: 0, y: 0 }] }),
    (error) => error instanceof PixelContractError && error.code === 'LAYER_GROUP_LOCKED',
  )

  const removed = execute(document, 'groups.remove', { groupId: 'character' })
  assert.equal(removed.document.layers[1].groupId, null)
  assert.deepEqual(
    withoutRevision(applyPixelCommand(removed.document, removed.inverse).document),
    withoutRevision(document),
  )
  assert.deepEqual(withoutRevision(applyPixelCommand(added.document, added.inverse).document), withoutRevision(createPixelDocument({
    id: 'blend-fixture',
    name: 'Blend fixture',
    width: 1,
    height: 1,
    palette: colors,
    layers: [
      { id: 'base', name: 'Base', visible: true, locked: false, opacity: 1, groupId: null, blendMode: 'normal' },
      { id: 'top', name: 'Top', visible: true, locked: false, opacity: 1, groupId: null, blendMode: 'normal' },
    ],
    frames: [{ id: 'frame-1', name: 'Frame 1', durationMs: 100, cels: { base: ['base'], top: ['top'] } }],
    activeLayerId: 'top',
    activeFrameId: 'frame-1',
  })))
})

test('animation tags, batch durations and cross-frame cel copies are strict and reversible', () => {
  let document = makeMultiLayerMultiFrameDocument()
  document = execute(document, 'frames.add', {
    frame: { id: 'frame-3', name: 'Frame 3', durationMs: 360 },
    copyFromFrameId: 'frame-2',
  }).document

  const tagged = execute(document, 'animations.add', {
    tag: {
      id: 'attack',
      name: 'Attack',
      fromFrameId: 'frame-1',
      toFrameId: 'frame-3',
      direction: 'ping-pong',
      loop: true,
    },
  })
  assert.deepEqual(resolvePixelAnimationFrames(tagged.document, 'attack'), ['frame-1', 'frame-2', 'frame-3', 'frame-2'])
  assert.deepEqual(resolvePixelAnimationSequences(tagged.document), [
    { tagId: 'attack', frameIds: ['frame-1', 'frame-2', 'frame-3', 'frame-2'] },
  ])
  assert.throws(
    () => execute(tagged.document, 'frames.remove', { frameId: 'frame-1' }),
    (error) => error instanceof PixelContractError && error.code === 'FRAME_IN_ANIMATION_TAG',
  )

  const timed = execute(tagged.document, 'frames.duration.set', {
    frames: [
      { frameId: 'frame-1', durationMs: 80 },
      { frameId: 'frame-2', durationMs: 90 },
      { frameId: 'frame-3', durationMs: 100 },
    ],
  })
  assert.deepEqual(timed.document.frames.map((frame) => frame.durationMs), [80, 90, 100])
  assert.deepEqual(
    withoutRevision(applyPixelCommand(timed.document, timed.inverse).document),
    withoutRevision(tagged.document),
  )

  const copied = execute(timed.document, 'cels.copy', {
    sourceFrameId: 'frame-1',
    targetFrameIds: ['frame-2', 'frame-3'],
    layerIds: ['highlight'],
    mode: 'replace',
  })
  assert.deepEqual(copied.document.frames[1].cels.highlight, copied.document.frames[0].cels.highlight)
  assert.deepEqual(copied.document.frames[2].cels.highlight, copied.document.frames[0].cels.highlight)
  assert.deepEqual(
    withoutRevision(applyPixelCommand(copied.document, copied.inverse).document),
    withoutRevision(timed.document),
  )

  const removed = execute(tagged.document, 'animations.remove', { tagId: 'attack' })
  assert.deepEqual(removed.document.animationTags, [])
  assert.deepEqual(
    withoutRevision(applyPixelCommand(removed.document, removed.inverse).document),
    withoutRevision(tagged.document),
  )
})

test('animation and bulk commands reject inverted ranges, duplicate targets and locked layers', () => {
  let document = makeMultiLayerMultiFrameDocument()
  assert.throws(
    () => execute(document, 'animations.add', {
      tag: {
        id: 'backwards', name: 'Backwards', fromFrameId: 'frame-2', toFrameId: 'frame-1', direction: 'forward', loop: true,
      },
    }),
    (error) => error instanceof PixelContractError && error.code === 'INVALID_ANIMATION_RANGE',
  )
  assert.throws(
    () => execute(document, 'frames.duration.set', {
      frames: [{ frameId: 'frame-1', durationMs: 80 }, { frameId: 'frame-1', durationMs: 90 }],
    }),
    (error) => error instanceof PixelContractError && error.code === 'DUPLICATE_ID',
  )
  document = execute(document, 'layers.patch', { layerId: 'highlight', patch: { locked: true } }).document
  assert.throws(
    () => execute(document, 'cels.copy', {
      sourceFrameId: 'frame-1', targetFrameIds: ['frame-2'], layerIds: ['highlight'], mode: 'replace',
    }),
    (error) => error instanceof PixelContractError && error.code === 'LAYER_LOCKED',
  )
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
  assert.equal(metadata.schemaVersion, 4)
  assert.deepEqual(metadata.frames.map((frame) => frame.durationMs), [120, 240, 360])

  const rendered = renderSpriteSheetRgba(document, { columns: 2, padding: 1, spacing: 1 })
  assert.equal(rendered.pixels.length, 7 * 7 * 4)
  const firstCellOffset = (1 * 7 + 1) * 4
  assert.deepEqual(Array.from(rendered.pixels.slice(firstCellOffset, firstCellOffset + 4)), [0, 0, 255, 255])
})
