import { PIXEL_DOCUMENT_SCHEMA_VERSION } from '../src/lib/pixel/pixelCore.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PixelContractError,
  applyPixelCommand,
  assertPixelDocument,
  createPixelCommand,
  createPixelDocument,
  migratePixelDocument,
} from '../src/lib/pixel/pixelCore.mjs'
import {
  createPixelTerrainMapExportBundle,
  inspectPixelTerrainCoverage,
} from '../src/lib/pixel/pixelGamePipeline.mjs'

const palette = [
  { id: 'ink', name: 'Ink', color: '#000000FF' },
  { id: 'paper', name: 'Paper', color: '#FFFFFFFF' },
]

function makeDocument() {
  return createPixelDocument({
    id: 'object-layer-fixture',
    name: 'Object layer fixture',
    width: 2,
    height: 2,
    palette,
    layers: [{ id: 'ink', name: 'Ink', visible: true, locked: false, opacity: 1 }],
    frames: [
      {
        id: 'grass-plain',
        name: 'Grass plain',
        durationMs: 100,
        gameplay: {
          anchor: { x: 1, y: 2 },
          collisions: [{ id: 'solid', name: 'Solid', type: 'solid', x: 0, y: 0, width: 1, height: 1 }],
          tileRule: { terrainId: 'grass', bitmask: 0 },
        },
        cels: { ink: [null, null, null, null] },
      },
      {
        id: 'grass-east',
        name: 'Grass east',
        durationMs: 100,
        gameplay: {
          anchor: { x: 1, y: 2 },
          collisions: [],
          tileRule: { terrainId: 'grass', bitmask: 4 },
        },
        cels: { ink: [null, null, null, null] },
      },
    ],
    terrainMaps: [{
      id: 'yard',
      name: 'Yard',
      width: 2,
      height: 2,
      cells: ['grass', 'grass', null, null],
      terrainLayer: { visible: true, locked: false },
      objectLayers: [],
    }],
  })
}

function execute(document, type, payload, actor = 'user') {
  const command = createPixelCommand(document, type, payload, { actor })
  return applyPixelCommand(document, command)
}

test('schema v7 terrain maps migrate to the current schema with an unlocked terrain layer and empty object layers', () => {
  const source = makeDocument()
  source.schemaVersion = 7
  delete source.celLinks
  for (const map of source.terrainMaps) {
    delete map.terrainLayer
    delete map.objectLayers
  }
  const migrated = migratePixelDocument(source)
  assert.equal(migrated.schemaVersion, PIXEL_DOCUMENT_SCHEMA_VERSION)
  assert.deepEqual(migrated.terrainMaps[0].terrainLayer, { visible: true, locked: false })
  assert.deepEqual(migrated.terrainMaps[0].objectLayers, [])
})

test('terrain object layer and object commands are reversible, strict, and respect locks', () => {
  const addedLayer = execute(makeDocument(), 'terrain-object-layers.add', {
    mapId: 'yard',
    layer: { id: 'props', name: 'Props', visible: true, locked: false, objects: [] },
  })
  const addedObject = execute(addedLayer.document, 'terrain-objects.add', {
    mapId: 'yard',
    layerId: 'props',
    object: {
      id: 'tree',
      name: 'Tree',
      x: 1,
      y: 1,
      width: 2,
      height: 2,
      frameId: 'grass-plain',
      collisionId: 'solid',
      properties: { blocking: true, weight: 2 },
    },
  })
  assert.deepEqual(addedObject.document.terrainMaps[0].objectLayers[0].objects[0].properties, {
    blocking: true,
    weight: 2,
  })
  assert.deepEqual(
    applyPixelCommand(addedObject.document, addedObject.inverse).document.terrainMaps[0].objectLayers[0].objects,
    [],
  )
  const patchedLayer = execute(addedLayer.document, 'terrain-object-layers.patch', {
    mapId: 'yard',
    layerId: 'props',
    patch: { locked: true },
  })
  assert.throws(
    () => execute(patchedLayer.document, 'terrain-objects.add', {
      mapId: 'yard',
      layerId: 'props',
      object: {
        id: 'rock', name: 'Rock', x: 0, y: 0, width: 1, height: 1,
        frameId: null, collisionId: null, properties: {},
      },
    }),
    (error) => error instanceof PixelContractError && error.code === 'TERRAIN_OBJECT_LAYER_LOCKED',
  )
  assert.throws(
    () => execute(addedObject.document, 'terrain-objects.patch', {
      mapId: 'yard', layerId: 'props', objectId: 'tree', patch: { width: 3 }, extra: true,
    }),
    (error) => error instanceof PixelContractError && error.code === 'UNKNOWN_FIELD',
  )
  assert.throws(
    () => execute(addedObject.document, 'frames.patch', {
      frameId: 'grass-plain',
      patch: { gameplay: { ...addedObject.document.frames[0].gameplay, collisions: [] } },
    }),
    (error) => error instanceof PixelContractError && error.code === 'COLLISION_IN_TERRAIN_OBJECT',
  )
})

test('terrain coverage inspection reports exact terrain ids, bitmasks, cells and counts without mutation', () => {
  const document = makeDocument()
  const before = structuredClone(document)
  const report = inspectPixelTerrainCoverage(document, 'yard')
  assert.deepEqual(report.missingTerrainIds, ['grass'])
  assert.deepEqual(report.missing, [{ terrainId: 'grass', bitmask: 64, cells: [{ index: 1, row: 0, column: 1 }], count: 1 }])
  assert.equal(report.checkedCellCount, 4)
  assert.equal(report.missingCount, 1)
  assert.equal(report.cells[0].terrainId, 'grass')
  assert.equal(report.cells[0].bitmask, 4)
  assert.deepEqual(document, before)
})

test('terrain object references must stay inside map pixel bounds and reference same-frame collision shapes', () => {
  const document = makeDocument()
  assert.throws(
    () => execute(document, 'terrain-object-layers.add', {
      mapId: 'yard', layer: { id: 'props', name: 'Props', visible: true, locked: false, objects: [{
        id: 'bad', name: 'Bad', x: 4, y: 0, width: 1, height: 1,
        frameId: 'grass-plain', collisionId: null, properties: {},
      }] },
    }),
    (error) => error instanceof PixelContractError && error.code === 'INVALID_INTEGER',
  )
  assert.throws(
    () => execute(document, 'terrain-object-layers.add', {
      mapId: 'yard', layer: { id: 'props', name: 'Props', visible: true, locked: false, objects: [{
        id: 'bad', name: 'Bad', x: 0, y: 0, width: 1, height: 1,
        frameId: 'grass-east', collisionId: 'solid', properties: {},
      }] },
    }),
    (error) => error instanceof PixelContractError && error.code === 'UNKNOWN_COLLISION',
  )
})

test('terrain map TMJ and manifest carry the source object layers and objectgroups', () => {
  let document = makeDocument()
  document = execute(document, 'terrain-object-layers.add', {
    mapId: 'yard',
    layer: { id: 'props', name: 'Props', visible: true, locked: false, objects: [] },
  }).document
  document = execute(document, 'terrain-objects.add', {
    mapId: 'yard',
    layerId: 'props',
    object: {
      id: 'tree', name: 'Tree', x: 1, y: 1, width: 2, height: 2,
      frameId: 'grass-plain', collisionId: 'solid', properties: { blocking: true },
    },
  }).document
  const bundle = createPixelTerrainMapExportBundle(document, { terrainMapId: 'yard' })
  assert.deepEqual(bundle.manifest.value.objectLayers, document.terrainMaps[0].objectLayers)
  const tiled = JSON.parse(bundle.tiledMap.text)
  const objectLayer = tiled.layers.find((layer) => layer.type === 'objectgroup')
  assert.equal(objectLayer.name, 'Props')
  assert.equal(objectLayer.objects[0].x, 1)
  assert.equal(objectLayer.objects[0].y, 1)
  assert.equal(objectLayer.objects[0].properties.find((property) => property.name === 'aeonquillId').value, 'tree')
})

test('terrain map export keeps the source atlas dimensions identical to its TMJ tileset', () => {
  const document = makeDocument()
  const bundle = createPixelTerrainMapExportBundle(document, { terrainMapId: 'yard' })
  const tiled = JSON.parse(bundle.tiledMap.text)
  const tileset = tiled.tilesets[0]
  assert.deepEqual(
    { width: bundle.atlas.width, height: bundle.atlas.height },
    { width: tileset.imagewidth, height: tileset.imageheight },
  )
  assert.equal(bundle.atlas.filename, tileset.image)
})
