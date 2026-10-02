import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createPixelSelectionClipboard,
  createPixelSelectionPastePatch,
  createSelectionPatch,
  expandPixelBrush,
  floodFillPixels,
  normalizePixelRect,
  pixelPerfectStroke,
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

test('pixel-perfect stroke removes the middle point of each oriented orthogonal L', () => {
  const cases = [
    [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }],
    [{ x: 2, y: 1 }, { x: 2, y: 2 }, { x: 1, y: 2 }],
    [{ x: 2, y: 2 }, { x: 1, y: 2 }, { x: 1, y: 1 }],
    [{ x: 1, y: 2 }, { x: 1, y: 1 }, { x: 2, y: 1 }],
  ]
  for (const points of cases) {
    assert.deepEqual(pixelPerfectStroke(points, 4, 4), [points[0], points[2]])
    assert.deepEqual(pixelPerfectStroke([...points].reverse(), 4, 4), [points[2], points[0]])
  }
})

test('pixel-perfect stroke leaves straight, diagonal, and non-adjacent paths unchanged', () => {
  const straight = [{ x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 }]
  const diagonal = [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }]
  const nonAdjacent = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }]
  assert.deepEqual(pixelPerfectStroke(straight, 4, 3), straight)
  assert.deepEqual(pixelPerfectStroke(diagonal, 3, 3), diagonal)
  assert.deepEqual(pixelPerfectStroke(nonAdjacent, 4, 2), nonAdjacent)
  assert.equal(pixelPerfectStroke(straight, 4, 3).length, straight.length)
})

test('pixel-perfect stroke preserves duplicate, backtracking, and revisited point occurrences', () => {
  const duplicate = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }]
  const backtrack = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 0 }]
  const revisit = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 0 }]
  assert.deepEqual(pixelPerfectStroke(duplicate, 2, 2), duplicate)
  assert.deepEqual(pixelPerfectStroke(backtrack, 2, 2), backtrack)
  assert.deepEqual(pixelPerfectStroke(revisit, 2, 2), revisit)
})

test('pixel-perfect stroke preserves overlapping candidates and a closed endpoint revisit', () => {
  const overlapping = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }]
  const closed = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
    { x: 0, y: 0 },
  ]
  assert.deepEqual(pixelPerfectStroke(overlapping, 3, 2), overlapping)
  assert.deepEqual(pixelPerfectStroke([...overlapping].reverse(), 3, 2).reverse(), overlapping)
  assert.deepEqual(pixelPerfectStroke(closed, 2, 2), closed)
})

test('pixel-perfect stroke removes only isolated candidates across long staircases and mirrors', () => {
  const staircase = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 2, y: 1 },
    { x: 2, y: 2 },
    { x: 3, y: 2 },
    { x: 3, y: 3 },
  ]
  const isolated = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 2, y: 2 },
    { x: 3, y: 2 },
    { x: 3, y: 3 },
  ]
  const mirrored = staircase.map(({ x, y }) => ({ x: 3 - x, y }))
  assert.deepEqual(pixelPerfectStroke(staircase, 4, 4), staircase)
  assert.deepEqual(pixelPerfectStroke([...staircase].reverse(), 4, 4).reverse(), staircase)
  assert.deepEqual(pixelPerfectStroke(mirrored, 4, 4), mirrored)
  assert.deepEqual(pixelPerfectStroke(isolated, 4, 4), [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
    { x: 2, y: 2 },
    { x: 3, y: 3 },
  ])
})

test('pixel-perfect stroke validates points, dimensions, and operation length without mutating input', () => {
  const points = Object.freeze([
    Object.freeze({ x: 0, y: 0 }),
    Object.freeze({ x: 1, y: 0 }),
    Object.freeze({ x: 1, y: 1 }),
  ])
  const result = pixelPerfectStroke(points, 2, 2)
  assert.deepEqual(result, [{ x: 0, y: 0 }, { x: 1, y: 1 }])
  assert.notStrictEqual(result[0], points[0])
  assert.notStrictEqual(result[1], points[2])
  assert.throws(() => pixelPerfectStroke([], 0, 2), (error) => error?.code === 'INVALID_INTEGER')
  assert.throws(() => pixelPerfectStroke([{ x: 0, y: 0, value: 'a' }], 2, 2), (error) => error?.code === 'UNKNOWN_FIELD')
  assert.throws(() => pixelPerfectStroke([{ x: 2, y: 0 }], 2, 2), (error) => error?.code === 'INVALID_INTEGER')
  assert.throws(() => pixelPerfectStroke(Array.from({ length: 65_537 }, () => ({ x: 0, y: 0 })), 1, 1), (error) => error?.code === 'LIMIT_EXCEEDED')
})

test('pixel-perfect stroke accepts an empty path and returns a fresh empty array', () => {
  const result = pixelPerfectStroke([], 1, 1)
  assert.deepEqual(result, [])
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
