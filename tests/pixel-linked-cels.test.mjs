import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PixelContractError,
  PIXEL_DOCUMENT_SCHEMA_VERSION,
  applyPixelCommand,
  assertPixelDocument,
  clonePixelDocument,
  createPixelCommand,
  createPixelDocument,
  migratePixelDocument,
} from '../src/lib/pixel/pixelCore.mjs'

const palette = [
  { id: 'a', name: 'A', color: '#FF0000FF' },
  { id: 'b', name: 'B', color: '#00FF00FF' },
  { id: 'c', name: 'C', color: '#0000FFFF' },
]

function makeDocument({ frameCount = 4, celLinks = [], pixels = [] } = {}) {
  const frames = Array.from({ length: frameCount }, (_, index) => ({
    id: `frame-${index + 1}`,
    name: `Frame ${index + 1}`,
    durationMs: 120,
    cels: { ink: pixels[index] ? [...pixels[index]] : [null, null] },
  }))
  return createPixelDocument({
    id: 'linked-cels-test',
    name: 'Linked cels',
    width: 2,
    height: 1,
    palette,
    layers: [{ id: 'ink', name: 'Ink', visible: true, locked: false, opacity: 1 }],
    frames,
    celLinks,
  })
}

function execute(document, type, payload, actor = 'user') {
  return applyPixelCommand(document, createPixelCommand(document, type, payload, {
    id: `${type.replaceAll('.', '-')}-${document.revision + 1}`,
    actor,
  }))
}

function expectContract(callback, code) {
  assert.throws(callback, (error) => error instanceof PixelContractError && error.code === code)
}

function withoutRevision(document) {
  const copy = structuredClone(document)
  delete copy.revision
  return copy
}

test('creates schema v9 documents with empty links and migrates v8 explicitly without mutating input', () => {
  const document = makeDocument()
  assert.equal(PIXEL_DOCUMENT_SCHEMA_VERSION, 9)
  assert.deepEqual(document.celLinks, [])

  const legacyV8 = structuredClone(document)
  delete legacyV8.celLinks
  legacyV8.schemaVersion = 8
  const before = structuredClone(legacyV8)
  const migrated = migratePixelDocument(legacyV8)
  assert.equal(migrated.schemaVersion, 9)
  assert.deepEqual(migrated.celLinks, [])
  assert.deepEqual(legacyV8, before)
})

test('validates link groups strictly and requires equal materialized pixels', () => {
  const valid = makeDocument({
    pixels: [['a', 'b'], ['a', 'b']],
    celLinks: [{ id: 'link-1', layerId: 'ink', frameIds: ['frame-1', 'frame-2'] }],
  })
  assert.deepEqual(valid.celLinks, [{ id: 'link-1', layerId: 'ink', frameIds: ['frame-1', 'frame-2'] }])

  expectContract(() => makeDocument({
    pixels: [['a', 'b'], ['a', 'c']],
    celLinks: [{ id: 'link-1', layerId: 'ink', frameIds: ['frame-1', 'frame-2'] }],
  }), 'CEL_LINK_MISMATCH')
  expectContract(() => makeDocument({
    celLinks: [{ id: 'link-1', layerId: 'ink', frameIds: ['frame-1'] }],
  }), 'INVALID_LIST')
  expectContract(() => makeDocument({
    celLinks: [{ id: 'link-1', layerId: 'ink', frameIds: ['frame-1', 'frame-2', 'frame-2'] }],
  }), 'DUPLICATE_ID')
  expectContract(() => makeDocument({
    celLinks: [{ id: 'link-1', layerId: 'missing', frameIds: ['frame-1', 'frame-2'] }],
  }), 'UNKNOWN_LAYER')
  expectContract(() => makeDocument({
    celLinks: [{ id: 'link-1', layerId: 'ink', frameIds: ['frame-1', 'missing'] }],
  }), 'UNKNOWN_FRAME')
  expectContract(() => makeDocument({
    celLinks: [{ id: 'link-1', layerId: 'ink', frameIds: ['frame-1', 'frame-2'], extra: true }],
  }), 'UNKNOWN_FIELD')
  expectContract(() => assertPixelDocument({ ...valid, celLinks: [
    ...valid.celLinks,
    { id: 'link-2', layerId: 'ink', frameIds: ['frame-1', 'frame-2'] },
  ] }), 'CEL_LINK_CONFLICT')
})

test('links frames, fans out source pixels, merges touched groups, and reverses exactly', () => {
  let document = makeDocument({
    pixels: [['a', 'b'], ['a', 'b'], ['c', 'c'], ['c', 'c']],
    celLinks: [
      { id: 'old-a', layerId: 'ink', frameIds: ['frame-1', 'frame-2'] },
      { id: 'old-b', layerId: 'ink', frameIds: ['frame-3', 'frame-4'] },
    ],
  })
  const input = document
  const before = structuredClone(document)
  const result = execute(document, 'cels.link', {
    id: 'merged',
    layerId: 'ink',
    sourceFrameId: 'frame-2',
    frameIds: ['frame-2', 'frame-3'],
  })
  document = result.document
  assert.deepEqual(input, before)
  assert.deepEqual(input.celLinks, [
    { id: 'old-a', layerId: 'ink', frameIds: ['frame-1', 'frame-2'] },
    { id: 'old-b', layerId: 'ink', frameIds: ['frame-3', 'frame-4'] },
  ])
  assert.deepEqual(document.celLinks, [{ id: 'merged', layerId: 'ink', frameIds: ['frame-2', 'frame-3', 'frame-1', 'frame-4'] }])
  assert.deepEqual(document.frames.map((frame) => frame.cels.ink), [
    ['a', 'b'],
    ['a', 'b'],
    ['a', 'b'],
    ['a', 'b'],
  ])
  assert.equal(result.inverse.type, 'cels.restore-links')
  const restored = applyPixelCommand(document, result.inverse)
  assert.deepEqual(withoutRevision(restored.document), withoutRevision(before))
})

test('rejects invalid link payloads, unrelated id conflicts, and locked fan-out targets', () => {
  const linked = makeDocument({
    pixels: [['a', 'b'], ['a', 'b'], ['a', 'b'], ['a', 'b']],
    celLinks: [{ id: 'existing', layerId: 'ink', frameIds: ['frame-1', 'frame-2'] }],
  })
  expectContract(() => execute(linked, 'cels.link', {
    id: 'existing', layerId: 'ink', sourceFrameId: 'frame-3', frameIds: ['frame-3', 'frame-4'],
  }), 'DUPLICATE_ID')
  const withUnrelated = makeDocument({
    pixels: [['a', 'b'], ['a', 'b'], ['c', 'c'], ['c', 'c']],
    celLinks: [
      { id: 'existing', layerId: 'ink', frameIds: ['frame-1', 'frame-2'] },
      { id: 'unrelated', layerId: 'ink', frameIds: ['frame-3', 'frame-4'] },
    ],
  })
  expectContract(() => execute(withUnrelated, 'cels.link', {
    id: 'unrelated', layerId: 'ink', sourceFrameId: 'frame-1', frameIds: ['frame-1', 'frame-2'],
  }), 'DUPLICATE_ID')
  expectContract(() => execute(linked, 'cels.link', {
    id: 'bad-source', layerId: 'ink', sourceFrameId: 'frame-4', frameIds: ['frame-1', 'frame-2'],
  }), 'INVALID_SOURCE_FRAME')
  expectContract(() => execute(linked, 'cels.link', {
    id: 'bad-fields', layerId: 'ink', sourceFrameId: 'frame-1', frameIds: ['frame-1', 'frame-2'], extra: true,
  }), 'UNKNOWN_FIELD')
  expectContract(() => execute(linked, 'cels.restore-links', {
    layerId: 'ink', entries: [], groups: [],
  }), 'ACTOR_FORBIDDEN')

  const locked = execute(linked, 'layers.patch', { layerId: 'ink', patch: { locked: true } }).document
  expectContract(() => execute(locked, 'cels.link', {
    id: 'blocked', layerId: 'ink', sourceFrameId: 'frame-1', frameIds: ['frame-1', 'frame-2'],
  }), 'LAYER_LOCKED')
  expectContract(() => execute(locked, 'cels.unlink', { frameId: 'frame-1', layerId: 'ink' }), 'LAYER_LOCKED')

  const grouped = createPixelDocument({
    id: linked.id,
    name: linked.name,
    width: linked.width,
    height: linked.height,
    palette: linked.palette,
    frames: linked.frames.map((frame) => ({
      ...frame,
      cels: { ink: [...frame.cels.ink] },
    })),
    layerGroups: [{ id: 'locked-group', name: 'Locked', visible: true, locked: true }],
    layers: [{ id: 'ink', name: 'Ink', visible: true, locked: false, opacity: 1, groupId: 'locked-group', blendMode: 'normal' }],
    celLinks: linked.celLinks,
  })
  expectContract(() => execute(grouped, 'cels.link', {
    id: 'blocked-group', layerId: 'ink', sourceFrameId: 'frame-1', frameIds: ['frame-1', 'frame-2'],
  }), 'LAYER_GROUP_LOCKED')
})

test('unlink removes only one member, removes singleton groups, and reverses relation without pixel changes', () => {
  const linked = makeDocument({
    pixels: [['a', 'b'], ['a', 'b'], ['a', 'b']],
    celLinks: [{ id: 'link-1', layerId: 'ink', frameIds: ['frame-1', 'frame-2', 'frame-3'] }],
  })
  const before = structuredClone(linked)
  const result = execute(linked, 'cels.unlink', { frameId: 'frame-2', layerId: 'ink' })
  assert.deepEqual(result.document.celLinks, [{ id: 'link-1', layerId: 'ink', frameIds: ['frame-1', 'frame-3'] }])
  assert.deepEqual(result.document.frames.map((frame) => frame.cels.ink), before.frames.map((frame) => frame.cels.ink))
  assert.deepEqual(withoutRevision(applyPixelCommand(result.document, result.inverse).document), withoutRevision(before))

  const pair = makeDocument({
    pixels: [['a', 'b'], ['a', 'b']],
    celLinks: [{ id: 'link-2', layerId: 'ink', frameIds: ['frame-1', 'frame-2'] }],
  })
  const removed = execute(pair, 'cels.unlink', { frameId: 'frame-1', layerId: 'ink' })
  assert.deepEqual(removed.document.celLinks, [])
  assert.deepEqual(withoutRevision(applyPixelCommand(removed.document, removed.inverse).document), withoutRevision(pair))
})

test('pixel edits fan out to linked frames and inverse restore fans out as one revision', () => {
  const linked = makeDocument({
    pixels: [['a', 'b'], ['a', 'b'], ['c', 'c']],
    celLinks: [{ id: 'link-1', layerId: 'ink', frameIds: ['frame-1', 'frame-2'] }],
  })
  const edited = execute(linked, 'pixels.patch', {
    frameId: 'frame-1', layerId: 'ink', pixels: [{ x: 0, y: 0, value: 'c' }],
  })
  assert.deepEqual(edited.document.frames[0].cels.ink, ['c', 'b'])
  assert.deepEqual(edited.document.frames[1].cels.ink, ['c', 'b'])
  assert.deepEqual(edited.document.frames[2].cels.ink, ['c', 'c'])
  const restored = applyPixelCommand(edited.document, edited.inverse)
  assert.deepEqual(withoutRevision(restored.document), withoutRevision(linked))
})

test('cels.copy fans out linked targets and cels.restore reverses every affected member', () => {
  const linked = makeDocument({
    pixels: [['a', 'b'], ['c', 'c'], ['c', 'c'], ['a', 'a']],
    celLinks: [{ id: 'target-link', layerId: 'ink', frameIds: ['frame-2', 'frame-3'] }],
  })
  const result = execute(linked, 'cels.copy', {
    sourceFrameId: 'frame-1',
    targetFrameIds: ['frame-2'],
    layerIds: ['ink'],
    mode: 'replace',
  })
  assert.deepEqual(result.document.frames[1].cels.ink, ['a', 'b'])
  assert.deepEqual(result.document.frames[2].cels.ink, ['a', 'b'])
  assert.deepEqual(withoutRevision(applyPixelCommand(result.document, result.inverse).document), withoutRevision(linked))
})

test('frame and layer deletion repair links and inverse restores the original relation', () => {
  const linked = makeDocument({
    pixels: [['a', 'b'], ['a', 'b'], ['a', 'b'], ['c', 'c']],
    celLinks: [{ id: 'link-1', layerId: 'ink', frameIds: ['frame-1', 'frame-2', 'frame-3'] }],
  })
  const beforeFrame = structuredClone(linked)
  const removedFrame = execute(linked, 'frames.remove', { frameId: 'frame-2' })
  assert.deepEqual(removedFrame.document.celLinks, [{ id: 'link-1', layerId: 'ink', frameIds: ['frame-1', 'frame-3'] }])
  assert.deepEqual(withoutRevision(applyPixelCommand(removedFrame.document, removedFrame.inverse).document), withoutRevision(beforeFrame))

  const beforeLayer = createPixelDocument({
    ...(() => {
      const source = makeDocument({
        pixels: [['a', 'b'], ['a', 'b'], ['a', 'b'], ['c', 'c']],
        celLinks: [{ id: 'link-1', layerId: 'ink', frameIds: ['frame-1', 'frame-2', 'frame-3'] }],
      })
      return {
        id: source.id,
        name: source.name,
        width: source.width,
        height: source.height,
        palette: source.palette,
        layers: [
          { id: 'ink', name: 'Ink', visible: true, locked: false, opacity: 1 },
          { id: 'paper', name: 'Paper', visible: true, locked: false, opacity: 1 },
        ],
        frames: source.frames.map((frame) => ({
          ...frame,
          cels: { ink: [...frame.cels.ink], paper: [null, null] },
        })),
        celLinks: source.celLinks,
      }
    })(),
  })
  const removedLayer = execute(beforeLayer, 'layers.remove', { layerId: 'ink' })
  assert.deepEqual(removedLayer.document.celLinks, [])
  assert.deepEqual(withoutRevision(applyPixelCommand(removedLayer.document, removedLayer.inverse).document), withoutRevision(beforeLayer))
})

test('copying a frame creates independent materialized cels and clone does not alias links or cels', () => {
  const linked = makeDocument({
    pixels: [['a', 'b'], ['a', 'b'], ['c', 'c'], ['c', 'c']],
    celLinks: [{ id: 'link-1', layerId: 'ink', frameIds: ['frame-1', 'frame-2'] }],
  })
  const copied = execute(linked, 'frames.add', {
    frame: { id: 'frame-5', name: 'Frame 5', durationMs: 120 },
    copyFromFrameId: 'frame-1',
  }).document
  assert.deepEqual(copied.celLinks, linked.celLinks)
  assert.equal(copied.celLinks.some((link) => link.frameIds.includes('frame-5')), false)
  const cloned = clonePixelDocument(linked)
  cloned.celLinks[0].frameIds.push('frame-3')
  cloned.frames[0].cels.ink[0] = 'c'
  assert.deepEqual(linked.celLinks[0].frameIds, ['frame-1', 'frame-2'])
  assert.equal(linked.frames[0].cels.ink[0], 'a')
})

test('link and restore commands enforce the bulk cell limit', () => {
  const width = 512
  const height = 512
  const blank = Array(width * height).fill(null)
  const frames = Array.from({ length: 5 }, (_, index) => ({
    id: `frame-${index + 1}`,
    name: `Frame ${index + 1}`,
    durationMs: 120,
    cels: { ink: blank.slice() },
  }))
  const document = createPixelDocument({
    id: 'bulk-link-test', name: 'Bulk link', width, height, palette,
    layers: [{ id: 'ink', name: 'Ink', visible: true, locked: false, opacity: 1 }], frames,
  })
  expectContract(() => execute(document, 'cels.link', {
    id: 'too-large', layerId: 'ink', sourceFrameId: 'frame-1', frameIds: ['frame-1', 'frame-2', 'frame-3', 'frame-4', 'frame-5'],
  }), 'BULK_COMMAND_TOO_LARGE')
})
