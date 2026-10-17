import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PixelContractError,
  applyPixelCommand,
  createPixelCommand,
  createPixelDocument,
} from '../src/lib/pixel/pixelCore.mjs'
import { transformPixelSelection } from '../src/lib/pixel/pixelTransform.mjs'

function at(cel, width, x, y) {
  return cel[y * width + x]
}

function applyPatch(cel, width, patch) {
  const next = cel.slice()
  for (const point of patch) next[point.y * width + point.x] = point.value
  return next
}

function matrix(cel, width, rect) {
  return Array.from({ length: rect.height }, (_, y) => (
    Array.from({ length: rect.width }, (_, x) => at(cel, width, rect.x + x, rect.y + y))
  ))
}

function executePixelsPatch(document, pixels) {
  const command = createPixelCommand(document, 'pixels.patch', {
    frameId: 'frame-1',
    layerId: 'layer-1',
    pixels,
  }, { id: `transform-${document.revision + 1}`, actor: 'tool' })
  return applyPixelCommand(document, command)
}

test('defaults to an identity move and reports the visible target selection', () => {
  const cel = [
    null, null, null, null, null,
    null, 'a', 'b', null, null,
    null, 'c', 'd', null, null,
    null, null, null, null, null,
  ]
  const before = cel.slice()
  const result = transformPixelSelection(cel, 5, 4, { x: 1, y: 1, width: 2, height: 2 })

  assert.deepEqual(result.selection, { x: 1, y: 1, width: 2, height: 2 })
  assert.deepEqual(result.report, {
    sourceWidth: 2,
    sourceHeight: 2,
    targetWidth: 2,
    targetHeight: 2,
    angle: 0,
    clippedPixels: 0,
  })
  assert.deepEqual(result.pixels, [])
  assert.deepEqual(cel, before)
})

test('rotates a non-square selection exactly and four clockwise turns restore it', () => {
  const width = 12
  const height = 12
  const cel = Array(width * height).fill(null)
  const original = cel.slice()
  const values = ['a', 'b', 'c', 'd', 'e', 'f']
  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < 2; x += 1) cel[(4 + y) * width + 3 + x] = values[y * 2 + x]
  }
  const source = cel.slice()
  let selection = { x: 3, y: 4, width: 2, height: 3 }
  for (let turn = 0; turn < 4; turn += 1) {
    const result = transformPixelSelection(cel, width, height, selection, { angle: 90 })
    assert.equal(result.report.angle, 90)
    cel.splice(0, cel.length, ...applyPatch(cel, width, result.pixels))
    selection = result.selection
  }
  assert.deepEqual(selection, { x: 3, y: 4, width: 2, height: 3 })
  assert.deepEqual(cel, source)
  assert.deepEqual(original.slice(0, 3), [null, null, null])
})

test('uses exact integer mappings for 180 and 270 degree turns', () => {
  const cel = [
    null, null, null, null, null,
    null, 'a', 'b', 'c', null,
    null, 'd', 'e', 'f', null,
    null, null, null, null, null,
  ]
  const half = transformPixelSelection(cel, 5, 4, { x: 1, y: 1, width: 3, height: 2 }, { angle: 180, mode: 'copy' })
  assert.deepEqual(matrix(applyPatch(cel, 5, half.pixels), 5, half.selection), [
    ['f', 'e', 'd'],
    ['c', 'b', 'a'],
  ])

  const quarter = transformPixelSelection(cel, 5, 4, { x: 1, y: 1, width: 3, height: 2 }, { angle: 270, mode: 'copy' })
  assert.deepEqual(quarter.selection, { x: 1, y: 1, width: 2, height: 3 })
  assert.deepEqual(matrix(applyPatch(cel, 5, quarter.pixels), 5, quarter.selection), [
    ['c', 'f'],
    ['b', 'e'],
    ['a', 'd'],
  ])
})

test('scales with nearest sampling and differentiates center and top-left anchors', () => {
  const cel = [
    null, null, null, null, null, null,
    null, 'a', 'b', 'c', 'd', null,
    null, 'e', 'f', 'g', 'h', null,
    null, null, null, null, null, null,
  ]
  const reduced = transformPixelSelection(cel, 6, 4, { x: 1, y: 1, width: 4, height: 2 }, {
    width: 2,
    height: 1,
    anchor: 'top-left',
    mode: 'copy',
  })
  assert.deepEqual(reduced.selection, { x: 1, y: 1, width: 2, height: 1 })
  assert.deepEqual(matrix(applyPatch(cel, 6, reduced.pixels), 6, reduced.selection), [['f', 'h']])

  const center = transformPixelSelection(cel, 6, 4, { x: 1, y: 1, width: 2, height: 2 }, {
    width: 4,
    height: 2,
    anchor: 'center',
    mode: 'copy',
  })
  const topLeft = transformPixelSelection(cel, 6, 4, { x: 1, y: 1, width: 2, height: 2 }, {
    width: 4,
    height: 2,
    anchor: 'top-left',
    mode: 'copy',
  })
  assert.deepEqual(center.selection, { x: 0, y: 1, width: 4, height: 2 })
  assert.deepEqual(topLeft.selection, { x: 1, y: 1, width: 4, height: 2 })
})

test('move clears the source before transparent transformed pixels are overlaid, while copy preserves it', () => {
  const width = 7
  const cel = Array(width * 7).fill(null)
  const values = ['a', 'b', null, 'd', 'e', 'f', 'g', 'h', 'i']
  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < 3; x += 1) cel[(2 + y) * width + 2 + x] = values[y * 3 + x]
  }
  const selection = { x: 2, y: 2, width: 3, height: 3 }
  const move = transformPixelSelection(cel, width, 7, selection, {
    angle: 45,
    anchor: 'center',
    mode: 'move',
  })
  const copy = transformPixelSelection(cel, width, 7, selection, {
    angle: 45,
    anchor: 'center',
    mode: 'copy',
  })
  assert.deepEqual(move.selection, { x: 1, y: 1, width: 5, height: 5 })
  const moved = applyPatch(cel, width, move.pixels)
  const copied = applyPatch(cel, width, copy.pixels)
  assert.equal(at(moved, width, 4, 3), null)
  assert.equal(at(copied, width, 4, 3), null)

  const reducedMove = transformPixelSelection(cel, width, 7, selection, {
    width: 1,
    height: 1,
    anchor: 'center',
    mode: 'move',
  })
  const reducedCopy = transformPixelSelection(cel, width, 7, selection, {
    width: 1,
    height: 1,
    anchor: 'center',
    mode: 'copy',
  })
  assert.equal(at(applyPatch(cel, width, reducedMove.pixels), width, 2, 2), null)
  assert.equal(at(applyPatch(cel, width, reducedCopy.pixels), width, 2, 2), 'a')
})

test('returns a clipped legal selection and counts only canvas-clipped target pixels', () => {
  const cel = Array(25).fill(null)
  cel[4 * 5 + 4] = 'a'
  const result = transformPixelSelection(cel, 5, 5, { x: 3, y: 3, width: 2, height: 2 }, {
    width: 4,
    height: 4,
    anchor: 'center',
    mode: 'copy',
  })
  assert.deepEqual(result.selection, { x: 2, y: 2, width: 3, height: 3 })
  assert.equal(result.report.clippedPixels, 7)
  assert(result.pixels.every((point) => point.x >= 0 && point.x < 5 && point.y >= 0 && point.y < 5))
})

test('patches remain reversible through the existing pixels.patch command', () => {
  const palette = [
    { id: 'a', name: 'A', color: '#FF0000FF' },
    { id: 'b', name: 'B', color: '#00FF00FF' },
    { id: 'c', name: 'C', color: '#0000FFFF' },
  ]
  let document = createPixelDocument({ id: 'transform-test', name: 'Transform', width: 4, height: 4, palette })
  const before = structuredClone(document)
  const cel = document.frames[0].cels['layer-1'].slice()
  cel[1 + 1 * 4] = 'a'
  cel[2 + 1 * 4] = 'b'
  cel[1 + 2 * 4] = 'c'
  cel[2 + 2 * 4] = 'a'
  const result = transformPixelSelection(cel, 4, 4, { x: 1, y: 1, width: 2, height: 2 }, { angle: 180 })
  const applied = executePixelsPatch(document, result.pixels)
  document = applied.document
  const restored = applyPixelCommand(document, applied.inverse)
  assert.deepEqual(restored.document.frames[0].cels['layer-1'], before.frames[0].cels['layer-1'])
})

test('rejects malformed inputs, unknown fields, unsafe values, and over-limit operations', () => {
  const cel = Array(16).fill(null)
  const call = (selection, options = {}) => transformPixelSelection(cel, 4, 4, selection, options)
  const isContract = (code) => (error) => error instanceof PixelContractError && error.code === code

  assert.throws(() => call({ x: 0, y: 0, width: 2, height: 2, extra: true }), isContract('UNKNOWN_FIELD'))
  assert.throws(() => call({ x: 0, y: 0, width: 2.5, height: 2 }), isContract('INVALID_INTEGER'))
  assert.throws(() => call({ x: 3, y: 3, width: 2, height: 2 }), isContract('OUT_OF_BOUNDS'))
  assert.throws(() => call({ x: 0, y: 0, width: 2, height: 2 }, { angle: Number.NaN }), isContract('INVALID_NUMBER'))
  assert.throws(() => call({ x: 0, y: 0, width: 2, height: 2 }, { width: 0 }), isContract('INVALID_INTEGER'))
  assert.throws(() => call({ x: 0, y: 0, width: 2, height: 2 }, { hidden: true }), isContract('UNKNOWN_FIELD'))
  assert.throws(() => call({ x: 0, y: 0, width: 2, height: 2 }, { mode: 'blend' }), isContract('INVALID_MODE'))
  assert.throws(() => transformPixelSelection(Array(16).fill('bad color'), 4, 4, { x: 0, y: 0, width: 1, height: 1 }), isContract('INVALID_VALUE'))
  assert.throws(() => transformPixelSelection(Array(15).fill(null), 4, 4, { x: 0, y: 0, width: 1, height: 1 }), isContract('INVALID_CEL'))
  assert.throws(() => transformPixelSelection(Array(256 * 256).fill(null), 256, 256, { x: 0, y: 0, width: 256, height: 256 }, { angle: 45 }), isContract('LIMIT_EXCEEDED'))
})

test('does not mutate the cel, selection, or options inputs', () => {
  const cel = ['a', null, 'b', null]
  const selection = Object.freeze({ x: 0, y: 0, width: 2, height: 2 })
  const options = Object.freeze({ angle: 90, mode: 'copy' })
  const celBefore = cel.slice()
  const result = transformPixelSelection(cel, 2, 2, selection, options)
  assert.deepEqual(cel, celBefore)
  assert.notStrictEqual(result.selection, selection)
  assert.deepEqual(result.selection, { x: 0, y: 0, width: 2, height: 2 })
})
