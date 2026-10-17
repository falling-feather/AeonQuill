import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PixelComputationError,
  createPixelComputationSnapshot,
  runPixelComputation,
} from '../src/lib/pixel/pixelComputation.mjs'
import { PixelComputationClient } from '../src/lib/pixel/pixelComputationClient.mjs'
import {
  createPixelDocument,
  renderPixelFrameRgba,
  renderSpriteSheetRgba,
} from '../src/lib/pixel/pixelCore.mjs'
import {
  PIXEL_CONVERSION_PRESETS,
  convertRgbaToPixelDocument,
  createPixelExportBundle,
} from '../src/lib/pixel/pixelConversion.mjs'
import {
  PIXEL_TERRAIN_GRID_PRESETS,
  createPixelEngineBridgeExportBundle,
  createPixelGameExportBundle,
  createPixelTerrainMapExportBundle,
  createPixelTerrainMapLayout,
  createPixelTerrainPreviewLayout,
  inspectPixelTerrainCoverage,
  renderPixelTerrainMapRgba,
  renderPixelTerrainPreviewRgba,
} from '../src/lib/pixel/pixelGamePipeline.mjs'

function makeDocument() {
  return createPixelDocument({
    id: 'computation-fixture',
    name: 'Computation fixture',
    width: 2,
    height: 2,
    palette: [
      { id: 'ink', name: 'Ink', color: '#000000FF' },
      { id: 'paper', name: 'Paper', color: '#FFFFFFFF' },
    ],
    layers: [{ id: 'ink', name: 'Ink', visible: true, locked: false, opacity: 1 }],
    frames: [
      { id: 'frame-1', name: 'Frame 1', durationMs: 100, cels: { ink: ['ink', null, null, 'paper'] } },
      { id: 'frame-2', name: 'Frame 2', durationMs: 120, cels: { ink: [null, 'paper', 'ink', null] } },
    ],
    animationTags: [{ id: 'loop', name: 'Loop', fromFrameId: 'frame-1', toFrameId: 'frame-2', direction: 'forward', loop: true }],
    activeLayerId: 'ink',
    activeFrameId: 'frame-1',
  })
}

function request(document, operation, options = {}) {
  return {
    requestId: `request-${operation}`,
    documentId: document.id,
    revision: document.revision,
    operation,
    document,
    options,
  }
}

test('document-json serializes the complete authoritative document with unchanged JSON bytes', () => {
  const document = makeDocument()
  const response = runPixelComputation(request(document, 'document-json'))
  assert.equal(response.result, JSON.stringify(document))
  assert.equal(JSON.parse(response.result).frames.length, document.frames.length)
  assert.throws(() => runPixelComputation(request(document, 'document-json', { extra: true })))
})

function makeTerrainDocument() {
  const document = makeDocument()
  document.frames[0].gameplay.tileRule = { terrainId: 'grass', bitmask: 0 }
  document.frames[1].gameplay.tileRule = { terrainId: 'grass', bitmask: 4 }
  document.terrainMaps = [{
    id: 'yard', name: 'Yard', width: 2, height: 1, cells: ['grass', 'grass'],
    terrainLayer: { visible: true, locked: false }, objectLayers: [],
  }]
  const { kind: _kind, schemaVersion: _schemaVersion, ...input } = document
  return createPixelDocument(input)
}

function makeProjectedTerrainDocument() {
  const base = makeTerrainDocument()
  const { kind: _kind, schemaVersion: _schemaVersion, ...input } = base
  input.layerGroups = [{ id: 'group', name: 'Group', visible: true, locked: false }]
  input.layers = [
    { id: 'ink', name: 'Ink', visible: true, locked: false, opacity: 1, groupId: 'group', blendMode: 'normal' },
    { id: 'shade', name: 'Shade', visible: true, locked: false, opacity: 0.75, groupId: null, blendMode: 'multiply' },
  ]
  input.paletteCycles = [{
    id: 'cycle', name: 'Cycle', colorIds: ['ink', 'paper'], stepDurationMs: 20, direction: 'forward', enabled: true,
  }]
  input.frames = [
    ...base.frames.map((frame, index) => ({
      ...frame,
      gameplay: index === 1
        ? {
            ...frame.gameplay,
            collisions: [{ id: 'selected-solid', name: 'Selected solid', type: 'solid', x: 0, y: 0, width: 1, height: 1 }],
          }
        : frame.gameplay,
      cels: {
        ink: frame.cels.ink,
        shade: index === 0 ? ['paper', null, null, null] : [null, 'ink', null, null],
      },
    })),
    {
      id: 'frame-object-only',
      name: 'Object only',
      durationMs: 140,
      gameplay: {
        anchor: { x: 0, y: 0 },
        collisions: [{ id: 'object-solid', name: 'Object solid', type: 'solid', x: 0, y: 0, width: 1, height: 1 }],
        tileRule: { terrainId: 'grass', bitmask: 128 },
      },
      cels: { ink: ['paper', 'paper', 'ink', 'ink'], shade: ['ink', null, 'paper', null] },
    },
  ]
  input.animationEvents = [{
    id: 'terrain-hit', name: 'Terrain hit', type: 'hit', animationTagId: 'loop', frameId: 'frame-2', value: 'hit',
  }]
  input.terrainMaps = [{
    ...base.terrainMaps[0],
    objectLayers: [{
      id: 'props',
      name: 'Props',
      visible: true,
      locked: false,
      objects: [
        {
          id: 'tree',
          name: 'Tree',
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          frameId: 'frame-object-only',
          collisionId: 'object-solid',
          properties: { blocking: true },
        },
        {
          id: 'marker',
          name: 'Marker',
          x: 1,
          y: 0,
          width: 1,
          height: 1,
          frameId: 'frame-2',
          collisionId: 'selected-solid',
          properties: { selected: true },
        },
      ],
    }],
  }]
  return createPixelDocument(input)
}

function makeLargeDocument() {
  const width = 256
  const height = 256
  const frameCount = 96
  const blankCel = () => Array.from({ length: width * height }, () => null)
  return createPixelDocument({
    id: 'computation-large-fixture',
    name: 'Computation large fixture',
    width,
    height,
    palette: [{ id: 'ink', name: 'Ink', color: '#000000FF' }],
    layers: [{ id: 'ink', name: 'Ink', visible: true, locked: false, opacity: 1 }],
    frames: Array.from({ length: frameCount }, (_, index) => ({
      id: `frame-${index + 1}`,
      name: `Frame ${index + 1}`,
      durationMs: 100,
      cels: { ink: blankCel() },
    })),
    activeLayerId: 'ink',
    activeFrameId: 'frame-1',
  })
}

test('runPixelComputation keeps frame and sprite-sheet bytes identical to the synchronous functions', () => {
  const document = makeDocument()
  const frame = runPixelComputation(request(document, 'frame', { frameId: 'frame-1' }))
  assert.deepEqual(Array.from(frame.result), Array.from(renderPixelFrameRgba(document, 'frame-1')))
  const sheet = runPixelComputation(request(document, 'sprite-sheet', { columns: 2, padding: 1, spacing: 1 }))
  const expected = renderSpriteSheetRgba(document, { columns: 2, padding: 1, spacing: 1 })
  assert.deepEqual(Array.from(sheet.result.pixels), Array.from(expected.pixels))
  assert.deepEqual(sheet.result.layout, expected.layout)
  assert.equal(frame.requestId, 'request-frame')
  assert.equal(frame.documentId, document.id)
  assert.equal(frame.revision, document.revision)
})

test('runPixelComputation rejects identity drift, unknown fields and unknown operations before running an algorithm', () => {
  const document = makeDocument()
  assert.throws(
    () => runPixelComputation({ ...request(document, 'frame', { frameId: 'frame-1' }), documentId: 'other-document' }),
    (error) => error instanceof PixelComputationError && error.code === 'DOCUMENT_ID_MISMATCH',
  )
  assert.throws(
    () => runPixelComputation({ ...request(document, 'frame', { frameId: 'frame-1' }), revision: 99 }),
    (error) => error instanceof PixelComputationError && error.code === 'REVISION_MISMATCH',
  )
  assert.throws(
    () => runPixelComputation({ ...request(document, 'frame', { frameId: 'frame-1' }), extra: true }),
    (error) => error instanceof PixelComputationError && error.code === 'UNKNOWN_FIELD',
  )
  assert.throws(
    () => runPixelComputation(request(document, 'frame', { frameId: 'frame-1', extra: true })),
    (error) => error instanceof PixelComputationError && error.code === 'UNKNOWN_FIELD',
  )
  assert.throws(
    () => runPixelComputation(request(document, 'not-an-operation')),
    (error) => error instanceof PixelComputationError && error.code === 'UNKNOWN_OPERATION',
  )
})

test('runPixelComputation enforces the output budget before allocating a large result', () => {
  const document = createPixelDocument({ width: 64, height: 64 })
  assert.throws(
    () => runPixelComputation(request(document, 'sprite-sheet', { columns: 1, padding: 0, spacing: 0, budgetBytes: 1024 })),
    (error) => error instanceof PixelComputationError && error.code === 'PIXEL_COMPUTATION_BUDGET',
  )
})

test('large sprite computation uses the default budget for output and scratch instead of the input JSON size', () => {
  const document = makeLargeDocument()
  assert.doesNotThrow(() => runPixelComputation(request(document, 'sprite-sheet', {
    columns: 12,
    padding: 0,
    spacing: 0,
  })))
})

test('frames computation renders selected frames with strict ids and bounded RGBA budget', () => {
  const document = makeDocument()
  const result = runPixelComputation(request(document, 'frames', {
    frameIds: ['frame-1', 'frame-2'],
    budgetBytes: (2 * 2 * 4 * 2) + (2 * 2 * 4),
  }))
  assert.equal(result.result.width, 2)
  assert.equal(result.result.height, 2)
  assert.deepEqual(result.result.frames.map(({ frameId }) => frameId), ['frame-1', 'frame-2'])
  assert.deepEqual(Array.from(result.result.frames[0].pixels), Array.from(renderPixelFrameRgba(document, 'frame-1')))
  assert.throws(
    () => runPixelComputation(request(document, 'frames', { frameIds: ['frame-1', 'frame-1'] })),
    (error) => error instanceof PixelComputationError && error.code === 'INVALID_FRAME_IDS',
  )
  assert.throws(
    () => runPixelComputation(request(document, 'frames', { frameIds: ['unknown-frame'] })),
    (error) => error instanceof PixelComputationError && error.code === 'INVALID_FRAME_IDS',
  )
  assert.throws(
    () => runPixelComputation(request(document, 'frames', { frameIds: ['frame-1', 'frame-2'], budgetBytes: 1 })),
    (error) => error instanceof PixelComputationError && error.code === 'PIXEL_COMPUTATION_BUDGET',
  )
})

test('project-containing exports reject oversized pretty JSON before executing the renderer', () => {
  const layers = Array.from({ length: 4 }, (_, index) => ({
    id: `layer-${index}`,
    name: `Layer ${index}`,
    visible: true,
    locked: false,
    opacity: 1,
  }))
  const emptyCel = Array(128 * 128).fill(null)
  const document = createPixelDocument({
    id: 'budget-large',
    width: 128,
    height: 128,
    palette: [{ id: 'ink', name: 'Ink', color: '#000000FF' }],
    layers,
    frames: Array.from({ length: 32 }, (_, index) => ({
      id: `frame-${index}`,
      name: `Frame ${index}`,
      durationMs: 100,
      cels: Object.fromEntries(layers.map((layer) => [layer.id, [...emptyCel]])),
    })),
  })
  for (const operation of ['pixel-export', 'game-export', 'engine-export']) assert.throws(
    () => runPixelComputation(request(document, operation, {
      columns: 4,
      budgetBytes: 64 * 1024 * 1024,
    })),
    (error) => error instanceof PixelComputationError
      && error.code === 'PIXEL_COMPUTATION_BUDGET'
      && error.details?.estimatedBytes > error.details?.budgetBytes
      && error.details?.actualBytes === undefined,
  )
})

test('runPixelComputation selects the terrain, coverage and export operations through their existing implementations', () => {
  const document = makeTerrainDocument()
  const preview = runPixelComputation(request(document, 'terrain-preview', { terrainId: 'grass', occupancy: [true, true, true, true, true, true, true, true, true] }))
  const expectedPreview = renderPixelTerrainPreviewRgba(document, { terrainId: 'grass', occupancy: [true, true, true, true, true, true, true, true, true] })
  assert.deepEqual(Array.from(preview.result.pixels), Array.from(expectedPreview.pixels))
  const map = runPixelComputation(request(document, 'terrain-map', { terrainMapId: 'yard' }))
  const expectedMap = renderPixelTerrainMapRgba(document, { terrainMapId: 'yard' })
  assert.deepEqual(Array.from(map.result.pixels), Array.from(expectedMap.pixels))
  assert.deepEqual(map.result.layout, expectedMap.layout)
  const coverage = runPixelComputation(request(document, 'coverage', { mapId: 'yard' }))
  assert.deepEqual(coverage.result, inspectPixelTerrainCoverage(document, 'yard'))
  const game = runPixelComputation(request(document, 'game-export', { columns: 2, padding: 1, spacing: 1, mapWidth: 2, mapHeight: 1 }))
  assert.equal(game.result.manifest.value.sourceDocumentId, document.id)
  const engine = runPixelComputation(request(document, 'engine-export', { columns: 2, padding: 1, spacing: 1, mapWidth: 2, mapHeight: 1 }))
  assert.equal(engine.result.manifest.value.sourceDocumentId, document.id)
  const clip = runPixelComputation(request(document, 'clip-export', { tagId: 'loop', columns: 2, padding: 1, spacing: 1 }))
  assert.equal(clip.result.manifest.value.animation.id, 'loop')
  assert.deepEqual(preview.result.layout, createPixelTerrainPreviewLayout(document, { terrainId: 'grass', occupancy: [true, true, true, true, true, true, true, true, true] }))
  assert.deepEqual(map.result.layout, createPixelTerrainMapLayout(document, { terrainMapId: 'yard' }))
  assert.equal(game.result.manifest.value.sourceRevision, document.revision)
  assert.equal(engine.result.manifest.value.sourceRevision, document.revision)
  assert.equal(typeof createPixelGameExportBundle(document, { columns: 2, padding: 1, spacing: 1, mapWidth: 2, mapHeight: 1 }).manifest.text, 'string')
  assert.equal(typeof createPixelEngineBridgeExportBundle(document, { columns: 2, padding: 1, spacing: 1, mapWidth: 2, mapHeight: 1 }).manifest.text, 'string')
})

test('pixel-export and terrain-map-export preserve bundle JSON and pixel bytes from synchronous exports', () => {
  const document = makeTerrainDocument()
  const pixelOptions = { columns: 2, padding: 1, spacing: 1, baseName: 'pixel-export-fixture', frameId: 'frame-2' }
  const pixelResult = runPixelComputation(request(document, 'pixel-export', pixelOptions))
  const pixelExpected = createPixelExportBundle(document, pixelOptions)
  assert.equal(pixelResult.result.project.text, pixelExpected.project.text)
  assert.equal(pixelResult.result.metadata.text, pixelExpected.metadata.text)
  assert.deepEqual(Array.from(pixelResult.result.frame.pixels), Array.from(pixelExpected.frame.pixels))
  assert.deepEqual(Array.from(pixelResult.result.sprite.pixels), Array.from(pixelExpected.sprite.pixels))
  const terrainOptions = { terrainMapId: 'yard', baseName: 'terrain-export-fixture' }
  const terrainResult = runPixelComputation(request(document, 'terrain-map-export', terrainOptions))
  const terrainExpected = createPixelTerrainMapExportBundle(document, terrainOptions)
  assert.equal(terrainResult.result.manifest.text, terrainExpected.manifest.text)
  assert.equal(terrainResult.result.tiledMap.text, terrainExpected.tiledMap.text)
  assert.deepEqual(Array.from(terrainResult.result.preview.pixels), Array.from(terrainExpected.preview.pixels))
  assert.deepEqual(Array.from(terrainResult.result.atlas.pixels), Array.from(terrainExpected.atlas.pixels))
})

test('sprite-sheet computation includes palette-cycle elapsed time so same-revision playback does not reuse stale pixels', () => {
  const source = makeDocument()
  const { kind: _kind, schemaVersion: _schemaVersion, ...input } = source
  input.palette = [
    { id: 'red', name: 'Red', color: '#FF0000FF' },
    { id: 'blue', name: 'Blue', color: '#0000FFFF' },
  ]
  input.paletteCycles = [{ id: 'cycle', name: 'Cycle', colorIds: ['red', 'blue'], stepDurationMs: 20, direction: 'forward', enabled: true }]
  input.frames = input.frames.map((frame) => ({ ...frame, cels: { ink: ['red', null, null, null] } }))
  const document = createPixelDocument(input)
  const first = runPixelComputation(request(document, 'sprite-sheet', { columns: 2, paletteCycleElapsedMs: 0 }))
  const second = runPixelComputation(request(document, 'sprite-sheet', { columns: 2, paletteCycleElapsedMs: 20 }))
  assert.notDeepEqual(Array.from(first.result.pixels), Array.from(second.result.pixels))
  assert.deepEqual(Array.from(second.result.pixels), Array.from(renderSpriteSheetRgba(document, { columns: 2, paletteCycleElapsedMs: 20 }).pixels))
})

test('PixelComputationClient terminates superseded workers, ignores late responses, and disposes cleanly', async () => {
  const document = makeDocument()
  const workers = []
  const workerFactory = () => {
    const worker = {
      terminated: false,
      onmessage: null,
      onerror: null,
      postMessage() {},
      terminate() { this.terminated = true },
    }
    workers.push(worker)
    return worker
  }
  const client = new PixelComputationClient({ workerFactory })
  const first = client.run(request(document, 'frame', { frameId: 'frame-1' })).catch((error) => error)
  const second = client.run({ ...request(document, 'frame', { frameId: 'frame-2' }), requestId: 'request-second' })
  assert.equal(workers.length, 2)
  assert.equal(workers[0].terminated, true)
  assert.equal((await first).name, 'AbortError')
  workers[0].onmessage?.({ data: { ok: true, requestId: 'request-second', documentId: document.id, revision: document.revision, operation: 'frame', result: { stale: true } } })
  workers[1].onmessage?.({ data: { ok: true, requestId: 'request-second', documentId: document.id, revision: document.revision, operation: 'frame', result: { accepted: true } } })
  assert.deepEqual(await second, { accepted: true })
  client.dispose()
  assert.equal(workers[1].terminated, true)
})

test('PixelComputationClient uses one bounded synchronous fallback when Worker creation is unavailable', async () => {
  const document = makeDocument()
  const client = new PixelComputationClient({ workerFactory: () => { throw new Error('no worker') } })
  const result = await client.run(request(document, 'frame', { frameId: 'frame-1' }))
  assert.deepEqual(Array.from(result), Array.from(renderPixelFrameRgba(document, 'frame-1')))
  await assert.rejects(
    client.run(request(document, 'sprite-sheet', { columns: 2, budgetBytes: 1 })),
    (error) => error instanceof PixelComputationError && error.code === 'PIXEL_COMPUTATION_BUDGET',
  )
  client.dispose()
})

test('PixelComputationClient cancels an in-flight synchronous fallback and ignores its late result', async () => {
  const document = makeDocument()
  let release
  const client = new PixelComputationClient({
    workerFactory: () => { throw new Error('no worker') },
    syncFallback: () => new Promise((resolve) => { release = resolve }),
  })
  const controller = new AbortController()
  const pending = client.run(request(document, 'frame', { frameId: 'frame-1' }), { signal: controller.signal })
    .catch((error) => error)
  await Promise.resolve()
  controller.abort()
  release({ result: renderPixelFrameRgba(document, 'frame-1') })
  const error = await pending
  assert.equal(error.name, 'AbortError')
  assert.equal(client.active, null)
  client.dispose()
})

test('createPixelComputationSnapshot projects one frame without changing rendered pixels or source metadata', () => {
  const source = makeDocument()
  const before = structuredClone(source)
  const snapshot = createPixelComputationSnapshot(source, 'frame', {
    frameId: 'frame-2',
    includeHiddenLayers: false,
    paletteCycleElapsedMs: 20,
  })

  assert.notStrictEqual(snapshot, source)
  assert.deepEqual(snapshot.frames.map((frame) => frame.id), ['frame-2'])
  assert.equal(snapshot.activeFrameId, 'frame-2')
  assert.deepEqual(snapshot.animationTags, [])
  assert.deepEqual(snapshot.animationEvents, [])
  assert.deepEqual(snapshot.terrainMaps, [])
  assert.deepEqual(
    Array.from(renderPixelFrameRgba(snapshot, 'frame-2', { paletteCycleElapsedMs: 20 })),
    Array.from(renderPixelFrameRgba(source, 'frame-2', { paletteCycleElapsedMs: 20 })),
  )
  assert.deepEqual(source, before)
})

test('createPixelComputationSnapshot preserves requested multi-frame order and run output', () => {
  const source = makeDocument()
  const frameIds = ['frame-2', 'frame-1']
  const snapshot = createPixelComputationSnapshot(source, 'frames', { frameIds })
  const original = runPixelComputation(request(source, 'frames', { frameIds }))
  const projected = runPixelComputation(request(snapshot, 'frames', { frameIds }))

  assert.deepEqual(snapshot.frames.map((frame) => frame.id), frameIds)
  assert.equal(snapshot.activeFrameId, 'frame-2')
  assert.deepEqual(
    projected.result.frames.map(({ frameId, pixels }) => ({ frameId, pixels: Array.from(pixels) })),
    original.result.frames.map(({ frameId, pixels }) => ({ frameId, pixels: Array.from(pixels) })),
  )
  assert.throws(
    () => createPixelComputationSnapshot(source, 'frames', { frameIds: ['frame-1', 'frame-1'] }),
    (error) => error instanceof PixelComputationError && error.code === 'INVALID_FRAME_IDS',
  )
  assert.throws(
    () => createPixelComputationSnapshot(source, 'frames', { frameIds: ['unknown-frame'] }),
    (error) => error instanceof PixelComputationError && error.code === 'INVALID_FRAME_IDS',
  )
})

test('createPixelComputationSnapshot uses shared null cels for coverage while preserving gameplay and terrain object references', () => {
  const base = makeTerrainDocument()
  const { kind: _kind, schemaVersion: _schemaVersion, ...input } = base
  input.terrainMaps = [{
    ...input.terrainMaps[0],
    objectLayers: [{
      id: 'props',
      name: 'Props',
      visible: true,
      locked: false,
      objects: [{
        id: 'tree',
        name: 'Tree',
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        frameId: 'frame-1',
        collisionId: null,
        properties: { blocking: true },
      }],
    }],
  }]
  const source = createPixelDocument(input)
  const before = structuredClone(source)
  const snapshot = createPixelComputationSnapshot(source, 'coverage', { mapId: 'yard' })

  assert.equal(snapshot.frames.length, source.frames.length)
  assert.deepEqual(snapshot.frames.map((frame) => frame.gameplay), source.frames.map((frame) => frame.gameplay))
  assert.equal(snapshot.frames[0].cels.ink, snapshot.frames[1].cels.ink)
  assert(snapshot.frames.every((frame) => frame.cels.ink.every((colorId) => colorId === null)))
  assert.deepEqual(snapshot.terrainMaps, source.terrainMaps)
  assert.equal(snapshot.terrainMaps[0].objectLayers[0].objects[0].frameId, 'frame-1')

  const projectedCoverage = runPixelComputation(request(snapshot, 'coverage', { mapId: 'yard' }))
  const originalCoverage = runPixelComputation(request(source, 'coverage', { mapId: 'yard' }))
  assert.deepEqual(projectedCoverage.result, originalCoverage.result)
  assert.equal(projectedCoverage.result.missingCount, 1)
  assert.deepEqual(source, before)
})

test('createPixelComputationSnapshot sparsifies terrain preview and map cels while preserving full metadata and outputs', () => {
  const source = makeProjectedTerrainDocument()
  const before = structuredClone(source)
  const cases = [
    ...PIXEL_TERRAIN_GRID_PRESETS.map((preset) => ({
      operation: 'terrain-preview',
      options: { terrainId: 'grass', occupancy: [...preset.occupancy] },
    })),
    {
      operation: 'terrain-preview',
      options: { terrainId: 'grass', occupancy: [false, false, false, false, false, false, false, false, false] },
    },
    { operation: 'terrain-map', options: { terrainMapId: 'yard' } },
    { operation: 'terrain-map', options: { terrainMapId: 'yard', cells: ['grass', null] } },
  ]

  for (const { operation, options } of cases) {
    const snapshot = createPixelComputationSnapshot(source, operation, options)
    assert.notStrictEqual(snapshot, source)
    assert.deepEqual(snapshot.frames.map((frame) => frame.id), source.frames.map((frame) => frame.id))
    assert.deepEqual(snapshot.frames.map((frame) => frame.gameplay), source.frames.map((frame) => frame.gameplay))
    assert.deepEqual(snapshot.palette, source.palette)
    assert.deepEqual(snapshot.paletteCycles, source.paletteCycles)
    assert.deepEqual(snapshot.layers, source.layers)
    assert.deepEqual(snapshot.layerGroups, source.layerGroups)
    assert.deepEqual(snapshot.animationTags, source.animationTags)
    assert.deepEqual(snapshot.animationEvents, source.animationEvents)
    assert.deepEqual(snapshot.terrainMaps, source.terrainMaps)
    assert.equal(snapshot.terrainMaps[0].objectLayers[0].objects[0].frameId, 'frame-object-only')
    assert.equal(snapshot.terrainMaps[0].objectLayers[0].objects[0].collisionId, 'object-solid')

    const layout = operation === 'terrain-preview'
      ? createPixelTerrainPreviewLayout(source, options)
      : createPixelTerrainMapLayout(source, options)
    const dependencyIds = new Set(layout.cells.map((cell) => cell.frameId).filter(Boolean))
    const nonDependencyFrames = snapshot.frames.filter((frame) => !dependencyIds.has(frame.id))
    assert.equal(nonDependencyFrames.length, source.frames.length - dependencyIds.size)
    if (operation === 'terrain-map' && options.cells === undefined) {
      assert(dependencyIds.has('frame-2'))
      assert.equal(dependencyIds.has('frame-object-only'), false)
    }
    if (nonDependencyFrames.length > 0) {
      assert(nonDependencyFrames.every((frame) => frame.cels.ink.every((colorId) => colorId === null)))
      assert(nonDependencyFrames.every((frame) => frame.cels.shade.every((colorId) => colorId === null)))
      assert.equal(nonDependencyFrames[0].cels.ink, nonDependencyFrames[0].cels.shade)
      assert.equal(nonDependencyFrames[0].cels.ink, nonDependencyFrames.at(-1).cels.ink)
    }
    for (const frame of snapshot.frames.filter((candidate) => dependencyIds.has(candidate.id))) {
      const sourceFrame = source.frames.find((candidate) => candidate.id === frame.id)
      assert.equal(frame.cels.ink, sourceFrame.cels.ink)
      assert.equal(frame.cels.shade, sourceFrame.cels.shade)
    }

    const original = runPixelComputation(request(source, operation, options))
    const projected = runPixelComputation(request(snapshot, operation, options))
    assert.deepEqual(Array.from(projected.result.pixels), Array.from(original.result.pixels))
    assert.deepEqual(projected.result.layout, original.result.layout)
  }
  assert.deepEqual(source, before)
})

test('createPixelComputationSnapshot returns the original document for non-rendering operations', () => {
  const source = makeTerrainDocument()
  assert.strictEqual(createPixelComputationSnapshot(source, 'sprite-sheet', { columns: 2 }), source)
  assert.strictEqual(createPixelComputationSnapshot(source, 'game-export', { columns: 2, mapWidth: 2, mapHeight: 1 }), source)
  assert.strictEqual(createPixelComputationSnapshot(source, 'terrain-map-export', { terrainMapId: 'yard', baseName: 'terrain' }), source)
  assert.strictEqual(createPixelComputationSnapshot(source, 'engine-export', { columns: 2, mapWidth: 2, mapHeight: 1 }), source)
  assert.strictEqual(createPixelComputationSnapshot(source, 'clip-export', { tagId: 'loop', columns: 2 }), source)
  assert.strictEqual(createPixelComputationSnapshot(source, 'pixel-export', { columns: 2, frameId: 'frame-1' }), source)
})

test('image-convert delegates the exact converter result and projects only a 1x1 task identity', () => {
  const document = makeDocument()
  const source = {
    width: 2,
    height: 2,
    data: [255, 0, 0, 64, 0, 255, 0, 128, 0, 0, 255, 192, 255, 255, 255, 255],
  }
  const options = {
    ...PIXEL_CONVERSION_PRESETS['soft-alpha'].settings,
    targetWidth: 2,
    targetHeight: 2,
    colorCount: 4,
    fit: 'stretch',
    documentId: 'converted-image',
    documentName: 'Converted image',
  }
  const sourceBefore = JSON.stringify(source)
  const expected = convertRgbaToPixelDocument(source, options)
  const actual = runPixelComputation({ ...request(document, 'image-convert', options), source })
  const snapshot = createPixelComputationSnapshot(document, 'image-convert', options)

  assert.deepEqual(actual.result, expected)
  assert.equal(snapshot.id, document.id)
  assert.equal(snapshot.revision, document.revision)
  assert.equal(snapshot.name, document.name)
  assert.equal(snapshot.width, 1)
  assert.equal(snapshot.height, 1)
  assert.deepEqual(snapshot.frames[0].cels[snapshot.activeLayerId], [null])
  assert.deepEqual(source, JSON.parse(sourceBefore))
})

test('image-convert enforces its source boundary and reuses strict conversion option validation', () => {
  const document = makeDocument()
  const source = { width: 1, height: 1, data: [1, 2, 3, 255] }
  assert.throws(
    () => runPixelComputation(request(document, 'image-convert', {})),
    (error) => error instanceof PixelComputationError && error.code === 'MISSING_SOURCE',
  )
  assert.throws(
    () => runPixelComputation({ ...request(document, 'frame', { frameId: 'frame-1' }), source }),
    (error) => error instanceof PixelComputationError && error.code === 'SOURCE_NOT_ALLOWED',
  )
  assert.throws(
    () => runPixelComputation({ ...request(document, 'image-convert', { extra: true }), source }),
    (error) => error.code === 'UNKNOWN_FIELD',
  )
  assert.throws(
    () => runPixelComputation({ ...request(document, 'image-convert', { targetWidth: 0 }), source }),
    (error) => error.code === 'INVALID_INTEGER',
  )
  assert.throws(
    () => runPixelComputation({ ...request(document, 'image-convert', {}), source: { width: 1, height: 1, data: [1, 2, 3] } }),
    (error) => error.code === 'INVALID_RGBA',
  )
})

test('image-convert rejects the conservative RGBA and workspace budget before normalizing a large source', () => {
  const document = makeDocument()
  const normalSource = { width: 1024, height: 1024, data: new Uint8ClampedArray(1024 * 1024 * 4) }
  assert.doesNotThrow(() => runPixelComputation({
    ...request(document, 'image-convert', { targetWidth: 32, targetHeight: 32 }),
    source: normalSource,
  }))
  assert.throws(
    () => runPixelComputation({
      ...request(document, 'image-convert', { targetWidth: 32, targetHeight: 32, budgetBytes: 1024 }),
      source: normalSource,
    }),
    (error) => error instanceof PixelComputationError
      && error.code === 'PIXEL_COMPUTATION_BUDGET'
      && error.details?.estimatedBytes > error.details?.budgetBytes,
  )
  const largeSource = { width: 4096, height: 4096, data: new Uint8Array(4096 * 4096 * 4) }
  assert.throws(
    () => runPixelComputation({ ...request(document, 'image-convert', { targetWidth: 32, targetHeight: 32 }), source: largeSource }),
    (error) => error instanceof PixelComputationError && error.code === 'PIXEL_COMPUTATION_BUDGET',
  )
})

test('image-convert rejects long fixed palette ids before a 2048x2048 to 512x512 algorithm allocation', () => {
  const document = makeDocument()
  const source = { width: 2048, height: 2048, data: new Uint8Array(2048 * 2048 * 4) }
  const palette = [{ id: 'p'.repeat(64), name: 'Long palette id', color: '#000000FF' }]
  assert.throws(
    () => runPixelComputation({
      ...request(document, 'image-convert', {
        targetWidth: 512,
        targetHeight: 512,
        colorCount: 1,
        palette,
        fit: 'stretch',
        budgetBytes: 64 * 1024 * 1024,
      }),
      source,
    }),
    (error) => error instanceof PixelComputationError
      && error.code === 'PIXEL_COMPUTATION_BUDGET'
      && error.details?.estimatedBytes > error.details?.budgetBytes,
  )
})
