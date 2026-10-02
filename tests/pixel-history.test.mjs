import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createPixelCommand,
  createPixelDocument,
} from '../src/lib/pixel/pixelCore.mjs'
import {
  applyPixelHistoryEntry,
  createPixelDocumentHistoryEntry,
} from '../src/lib/pixel/pixelHistory.mjs'

function makeDocument({ converted = false, revision = 0 } = {}) {
  if (!converted) {
    return createPixelDocument({
      id: 'history-document',
      name: 'History source',
      width: 2,
      height: 2,
      revision,
      palette: [
        { id: 'ink', name: 'Ink', color: '#000000FF' },
        { id: 'paper', name: 'Paper', color: '#FFFFFFFF' },
      ],
      layers: [{ id: 'ink-layer', name: 'Ink', visible: true, locked: false, opacity: 1 }],
      frames: [
        { id: 'frame-1', name: 'Frame 1', durationMs: 100, cels: { 'ink-layer': ['ink', null, null, 'paper'] } },
        { id: 'frame-2', name: 'Frame 2', durationMs: 140, cels: { 'ink-layer': [null, 'paper', 'ink', null] } },
      ],
      animationTags: [{ id: 'loop', name: 'Loop', fromFrameId: 'frame-1', toFrameId: 'frame-2', direction: 'forward', loop: true }],
      animationEvents: [{ id: 'marker-1', name: 'Marker', type: 'marker', animationTagId: 'loop', frameId: 'frame-1', value: 'start' }],
      terrainMaps: [{
        id: 'yard',
        name: 'Yard',
        width: 2,
        height: 1,
        cells: ['grass', null],
        terrainLayer: { visible: true, locked: false },
        objectLayers: [],
      }],
      activeLayerId: 'ink-layer',
      activeFrameId: 'frame-1',
      onionSkin: { enabled: true, previousFrames: 1, nextFrames: 1, opacity: 0.3 },
    })
  }

  return createPixelDocument({
    id: 'history-document',
    name: 'History converted',
    width: 3,
    height: 1,
    revision,
    palette: [
      { id: 'ink', name: 'Ink', color: '#111111FF' },
      { id: 'paper', name: 'Paper', color: '#EEEEEEFF' },
      { id: 'accent', name: 'Accent', color: '#FF00AAFF' },
    ],
    layers: [{ id: 'ink-layer', name: 'Ink', visible: true, locked: false, opacity: 0.8 }],
    frames: [
      { id: 'converted-1', name: 'Converted 1', durationMs: 80, cels: { 'ink-layer': ['accent', null, 'paper'] } },
      { id: 'converted-2', name: 'Converted 2', durationMs: 180, cels: { 'ink-layer': [null, 'ink', 'accent'] } },
      { id: 'converted-3', name: 'Converted 3', durationMs: 240, cels: { 'ink-layer': ['paper', 'accent', null] } },
    ],
    terrainMaps: [{
      id: 'converted-yard',
      name: 'Converted Yard',
      width: 3,
      height: 1,
      cells: ['grass', 'water', null],
      terrainLayer: { visible: false, locked: true },
      objectLayers: [],
    }],
    activeLayerId: 'ink-layer',
    activeFrameId: 'converted-2',
    onionSkin: { enabled: false, previousFrames: 0, nextFrames: 2, opacity: 0.5 },
  })
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

test('applies a command with the history id and current revision, then undoes it as a command', () => {
  const source = makeDocument()
  const command = createPixelCommand(source, 'pixels.paint', {
    frameId: 'frame-1',
    layerId: 'ink-layer',
    pixels: [{ x: 1, y: 0, colorId: 'paper' }],
  }, { id: 'candidate-command' })
  const stale = deepFreeze({ ...command, id: 'stale-command', baseRevision: 99 })

  const applied = applyPixelHistoryEntry(source, stale, 'history-command-1')
  assert.equal(applied.document.revision, 1)
  assert.equal(applied.document.frames[0].cels['ink-layer'][1], 'paper')
  assert.equal(applied.inverse.baseRevision, 1)

  const undone = applyPixelHistoryEntry(applied.document, applied.inverse, 'history-undo-1')
  assert.equal(undone.document.revision, 2)
  assert.deepEqual(undone.document.frames[0].cels['ink-layer'], source.frames[0].cels['ink-layer'])
  assert.equal(undone.inverse.baseRevision, 2)
})

test('captures and restores a complete independent document snapshot across a mixed conversion undo and redo', () => {
  const source = makeDocument()
  const converted = makeDocument({ converted: true, revision: 1 })
  const entry = createPixelDocumentHistoryEntry(converted)
  assert.equal(entry.kind, 'document-snapshot')
  assert.notStrictEqual(entry.document, converted)
  assert.notStrictEqual(entry.document.frames, converted.frames)
  assert.notStrictEqual(entry.document.palette, converted.palette)
  assert.notStrictEqual(entry.document.terrainMaps, converted.terrainMaps)

  const applied = applyPixelHistoryEntry(source, entry, 'conversion-apply')
  assert.equal(applied.document.revision, 1)
  assert.deepEqual(applied.document, converted)
  assert.notStrictEqual(applied.document.frames[0], entry.document.frames[0])

  const restored = applyPixelHistoryEntry(applied.document, applied.inverse, 'conversion-undo')
  assert.equal(restored.document.revision, 2)
  assert.deepEqual(restored.document, { ...source, revision: 2 })

  const redone = applyPixelHistoryEntry(restored.document, entry, 'conversion-redo')
  assert.equal(redone.document.revision, 3)
  assert.equal(redone.document.width, converted.width)
  assert.deepEqual(redone.document.frames, converted.frames)
  assert.deepEqual(redone.document.terrainMaps, converted.terrainMaps)
})

test('validates frozen snapshots and keeps all history documents independent', () => {
  const source = deepFreeze(makeDocument())
  const entry = createPixelDocumentHistoryEntry(source)
  assert.notStrictEqual(entry.document, source)
  assert.notStrictEqual(entry.document.frames[0].cels['ink-layer'], source.frames[0].cels['ink-layer'])

  const current = deepFreeze(makeDocument({ revision: 4 }))
  const applied = applyPixelHistoryEntry(current, deepFreeze(entry), 'snapshot-apply')
  applied.document.frames[0].cels['ink-layer'][0] = null
  assert.equal(entry.document.frames[0].cels['ink-layer'][0], 'ink')
  assert.equal(current.frames[0].cels['ink-layer'][0], 'ink')
  assert.notStrictEqual(applied.inverse.document, current)
  assert.notStrictEqual(applied.inverse.document.frames[0], current.frames[0])
})

test('rejects unknown history tags, unknown fields, cross-document snapshots, illegal snapshots, and revision overflow', () => {
  const source = makeDocument()
  const snapshot = createPixelDocumentHistoryEntry(source)
  const command = createPixelCommand(source, 'frames.select', { frameId: 'frame-2' })

  assert.throws(
    () => applyPixelHistoryEntry(source, { kind: 'future-history-entry', document: source }, 'bad-tag'),
    (error) => error?.code === 'UNKNOWN_HISTORY_ENTRY',
  )
  assert.throws(
    () => applyPixelHistoryEntry(source, { ...snapshot, extra: true }, 'bad-field'),
    (error) => error?.code === 'UNKNOWN_FIELD',
  )
  assert.throws(
    () => applyPixelHistoryEntry(source, { ...snapshot, document: { ...snapshot.document, id: 'other-document' } }, 'cross-document'),
    (error) => error?.code === 'DOCUMENT_ID_MISMATCH',
  )
  assert.throws(
    () => applyPixelHistoryEntry(source, { ...snapshot, document: { ...snapshot.document, unknown: true } }, 'bad-document'),
    (error) => error?.code === 'UNKNOWN_FIELD',
  )
  assert.throws(
    () => applyPixelHistoryEntry(source, { ...command, unknown: true }, 'bad-command'),
    (error) => error?.code === 'UNKNOWN_FIELD',
  )

  const overflow = makeDocument({ revision: Number.MAX_SAFE_INTEGER })
  assert.throws(
    () => applyPixelHistoryEntry(overflow, command, 'overflow-command'),
    (error) => error?.code === 'REVISION_OVERFLOW',
  )
  assert.throws(
    () => applyPixelHistoryEntry(overflow, snapshot, 'overflow-snapshot'),
    (error) => error?.code === 'REVISION_OVERFLOW',
  )
})
