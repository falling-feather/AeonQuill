import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createPixelSelectionClipboard,
  createPixelSelectionPastePatch,
  createSelectionPatch,
  expandPixelBrush,
  floodFillPixels,
  normalizePixelRect,
  rasterPixelLine,
  rasterPixelRectangle,
} from '../src/lib/pixel/pixelTools.mjs'

test('rasterizes deterministic lines and outline or filled rectangles', () => {
  assert.deepEqual(rasterPixelLine({ x: 0, y: 0 }, { x: 3, y: 2 }, 4, 3), [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
    { x: 2, y: 1 },
    { x: 3, y: 2 },
  ])
  assert.deepEqual(normalizePixelRect({ x: 3, y: 2 }, { x: 1, y: 0 }, 4, 3), {
    x: 1,
    y: 0,
    width: 3,
    height: 3,
  })
  assert.equal(rasterPixelRectangle({ x: 0, y: 0 }, { x: 2, y: 2 }, 4, 4).length, 8)
  assert.equal(rasterPixelRectangle({ x: 0, y: 0 }, { x: 2, y: 2 }, 4, 4, { fill: true }).length, 9)
})

test('expands a bounded square brush with horizontal and vertical symmetry', () => {
  const points = expandPixelBrush([{ x: 1, y: 1 }], 5, 5, {
    size: 2,
    mirrorHorizontal: true,
    mirrorVertical: true,
  })
  assert.equal(points.length, 16)
  assert(points.some((point) => point.x === 4 && point.y === 4))
  assert.equal(new Set(points.map((point) => `${point.x}:${point.y}`)).size, points.length)
  assert(points.every((point) => point.x >= 0 && point.x < 5 && point.y >= 0 && point.y < 5))
})

test('flood fill stays inside the contiguous source region and no-ops on an identical value', () => {
  const cel = [
    'a', 'a', 'b',
    'a', 'b', 'b',
    null, null, 'b',
  ]
  assert.deepEqual(floodFillPixels(cel, 3, 3, { x: 0, y: 0 }, 'c'), [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
  ])
  assert.deepEqual(floodFillPixels(cel, 3, 3, { x: 2, y: 0 }, 'b'), [])
})

test('builds mixed patches for clear, flip, copy and overlapping move', () => {
  const cel = [
    'a', 'b', null, null,
    'c', 'd', null, null,
    null, null, null, null,
  ]
  const selection = { x: 0, y: 0, width: 2, height: 2 }
  const flipped = createSelectionPatch(cel, 4, 3, selection, 'flip-horizontal')
  assert.deepEqual(flipped, [
    { x: 0, y: 0, value: 'b' },
    { x: 1, y: 0, value: 'a' },
    { x: 0, y: 1, value: 'd' },
    { x: 1, y: 1, value: 'c' },
  ])
  const copied = createSelectionPatch(cel, 4, 3, selection, 'copy', { dx: 2, dy: 0 })
  assert.equal(copied.length, 4)
  assert.deepEqual(copied.at(-1), { x: 3, y: 1, value: 'd' })
  const moved = createSelectionPatch(cel, 4, 3, selection, 'move', { dx: 1, dy: 0 })
  assert.deepEqual(moved, [
    { x: 0, y: 0, value: null },
    { x: 1, y: 0, value: 'a' },
    { x: 0, y: 1, value: null },
    { x: 1, y: 1, value: 'c' },
    { x: 2, y: 0, value: 'b' },
    { x: 2, y: 1, value: 'd' },
  ])
  assert.throws(
    () => createSelectionPatch(cel, 4, 3, selection, 'move', { dx: -1, dy: 0 }),
    (error) => error?.code === 'OUT_OF_BOUNDS',
  )
})

test('copies one strict selection and pastes it across cels with explicit transparency semantics', () => {
  const sourceCel = [
    'a', null, 'x', 'x',
    'b', 'c', 'x', 'x',
    'x', 'x', 'x', 'x',
  ]
  const clipboard = createPixelSelectionClipboard(
    sourceCel,
    4,
    3,
    { x: 0, y: 0, width: 2, height: 2 },
    { documentId: 'hero', documentRevision: 7, frameId: 'frame-1', layerId: 'light' },
  )
  assert.deepEqual(clipboard, {
    kind: 'aeonquill.pixel-selection-clipboard',
    schemaVersion: 1,
    width: 2,
    height: 2,
    pixels: ['a', null, 'b', 'c'],
    source: {
      documentId: 'hero',
      documentRevision: 7,
      frameId: 'frame-1',
      layerId: 'light',
      canvasWidth: 4,
      canvasHeight: 3,
      selection: { x: 0, y: 0, width: 2, height: 2 },
    },
  })
  const targetCel = Array(12).fill('x')
  assert.deepEqual(createPixelSelectionPastePatch(
    targetCel,
    4,
    3,
    clipboard,
    { x: 2, y: 1 },
    { mode: 'replace', allowedColorIds: ['a', 'b', 'c', 'x'] },
  ), [
    { x: 2, y: 1, value: 'a' },
    { x: 3, y: 1, value: null },
    { x: 2, y: 2, value: 'b' },
    { x: 3, y: 2, value: 'c' },
  ])
  assert.deepEqual(createPixelSelectionPastePatch(
    targetCel,
    4,
    3,
    clipboard,
    { x: 2, y: 1 },
    { mode: 'opaque-only', allowedColorIds: ['a', 'b', 'c', 'x'] },
  ), [
    { x: 2, y: 1, value: 'a' },
    { x: 2, y: 2, value: 'b' },
    { x: 3, y: 2, value: 'c' },
  ])
})

test('selection clipboard rejects tampering, unknown colors, unsafe metadata and out-of-bounds paste', () => {
  const clipboard = createPixelSelectionClipboard(
    ['a', null, null, 'b'],
    2,
    2,
    { x: 0, y: 0, width: 2, height: 2 },
    { documentId: 'hero', documentRevision: 0, frameId: 'frame-1', layerId: 'light' },
  )
  assert.throws(
    () => createPixelSelectionPastePatch(
      Array(9).fill(null), 3, 3, { ...clipboard, hidden: true }, { x: 0, y: 0 }, { allowedColorIds: ['a', 'b'] },
    ),
    (error) => error?.code === 'UNKNOWN_FIELD',
  )
  assert.throws(
    () => createPixelSelectionPastePatch(
      Array(9).fill(null), 3, 3, { ...clipboard, pixels: ['a', null, null, 'foreign'] }, { x: 0, y: 0 }, { allowedColorIds: ['a', 'b'] },
    ),
    (error) => error?.code === 'UNKNOWN_COLOR',
  )
  assert.throws(
    () => createPixelSelectionPastePatch(
      Array(9).fill(null), 3, 3, clipboard, { x: 2, y: 2 }, { allowedColorIds: ['a', 'b'] },
    ),
    (error) => error?.code === 'OUT_OF_BOUNDS',
  )
  assert.throws(
    () => createPixelSelectionPastePatch(
      Array(9).fill(null), 3, 3, { ...clipboard, pixels: ['a'] }, { x: 0, y: 0 }, { allowedColorIds: ['a', 'b'] },
    ),
    (error) => error?.code === 'INVALID_CLIPBOARD_PIXELS',
  )
  assert.throws(
    () => createPixelSelectionClipboard(
      ['a', null, null, 'b'], 2, 2, { x: 0, y: 0, width: 2, height: 2 },
      { documentId: '../hero', documentRevision: 0, frameId: 'frame-1', layerId: 'light' },
    ),
    (error) => error?.code === 'INVALID_ID',
  )
})
