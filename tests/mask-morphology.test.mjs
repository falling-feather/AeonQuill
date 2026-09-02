import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyMaskMorphology,
  normalizeMaskMorphology,
} from '../src/lib/maskMorphology.mjs'

function mask(rows) {
  return Uint8ClampedArray.from(rows.flat())
}

test('positive expansion grows a one-pixel mask with a bounded square kernel', () => {
  const source = mask([
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 255, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
  ])
  const output = applyMaskMorphology(source, 5, 5, { expand: 1, feather: 0, trim: 0 })
  assert.deepEqual([...output], [
    0, 0, 0, 0, 0,
    0, 255, 255, 255, 0,
    0, 255, 255, 255, 0,
    0, 255, 255, 255, 0,
    0, 0, 0, 0, 0,
  ])
  assert.equal(source[7], 0, 'source mask must remain immutable')
})

test('negative expansion erodes a solid region without losing image-edge samples', () => {
  const source = mask([
    [0, 0, 0, 0, 0],
    [0, 255, 255, 255, 0],
    [0, 255, 255, 255, 0],
    [0, 255, 255, 255, 0],
    [0, 0, 0, 0, 0],
  ])
  const output = applyMaskMorphology(source, 5, 5, { expand: -1, feather: 0, trim: 0 })
  assert.deepEqual([...output], [
    0, 0, 0, 0, 0,
    0, 0, 0, 0, 0,
    0, 0, 255, 0, 0,
    0, 0, 0, 0, 0,
    0, 0, 0, 0, 0,
  ])
})

test('trim and feather create a deterministic soft edge after weak-alpha cleanup', () => {
  const source = Uint8ClampedArray.from([0, 7, 128, 255, 0])
  const output = applyMaskMorphology(source, 5, 1, { expand: 0, feather: 1, trim: 8 })
  assert.deepEqual([...output], [0, 43, 128, 128, 128])
  assert.deepEqual(normalizeMaskMorphology({ expand: -4, feather: 3, trim: 12 }), {
    expand: -4,
    feather: 3,
    trim: 12,
  })
})

test('morphology rejects unsafe dimensions, radii and hidden fields', () => {
  assert.throws(
    () => applyMaskMorphology(new Uint8Array(4), 2, 2, { expand: 33, feather: 0, trim: 0 }),
    /expand/,
  )
  assert.throws(
    () => applyMaskMorphology(new Uint8Array(3), 2, 2),
    /length/,
  )
  assert.throws(
    () => normalizeMaskMorphology({ expand: 0, feather: 0, trim: 0, hidden: true }),
    /unsupported/,
  )
})
