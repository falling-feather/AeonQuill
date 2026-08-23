import test from 'node:test'
import assert from 'node:assert/strict'
import {
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
