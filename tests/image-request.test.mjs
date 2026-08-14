import assert from 'node:assert/strict'
import test from 'node:test'
import { validateImageRequest } from '../server/image-processor.mjs'

const capabilities = {
  operations: [
    { id: 'upscale-lanczos', available: true },
    { id: 'pixelate', available: true },
    { id: 'sharpen', available: true },
    { id: 'alpha-cleanup', available: true },
    { id: 'masked-adjust', available: true },
    { id: 'remove-background', available: false, unavailableReason: 'model missing' },
    { id: 'upscale-realesrgan', available: true, models: ['realesr-animevideov3'] },
  ],
}

test('normalizes deterministic pixel parameters', () => {
  assert.deepEqual(validateImageRequest({
    operation: 'pixelate',
    sourceElementId: 'source-1',
    params: { targetSize: 32, colors: 12, outputScale: 4, dither: 'atkinson', alphaThreshold: 96 },
  }, capabilities), {
    operation: 'pixelate',
    sourceElementId: 'source-1',
    params: { targetSize: 32, colors: 12, outputScale: 4, dither: 'atkinson', alphaThreshold: 96 },
  })
})

test('rejects unknown operations, parameters, enum values, and unavailable adapters', () => {
  assert.throws(
    () => validateImageRequest({ operation: 'unknown' }, capabilities),
    (error) => error.status === 400 && error.code === 'IMAGE_OPERATION_UNSUPPORTED',
  )
  assert.throws(
    () => validateImageRequest({ operation: 'pixelate', params: { targetSize: 32, surprise: true } }, capabilities),
    (error) => error.status === 400,
  )
  assert.throws(
    () => validateImageRequest({ operation: 'pixelate', params: { targetSize: 40 } }, capabilities),
    (error) => error.status === 400,
  )
  assert.throws(
    () => validateImageRequest({ operation: 'remove-background' }, capabilities),
    (error) => error.status === 409 && error.code === 'IMAGE_OPERATION_UNAVAILABLE',
  )
})

test('enforces alpha cleanup bounds and accepts the tight valid boundary', () => {
  assert.throws(
    () => validateImageRequest({
      operation: 'alpha-cleanup',
      params: { transparentBelow: 128, opaqueAbove: 232 },
    }, capabilities),
    (error) => error.status === 400,
  )
  assert.throws(
    () => validateImageRequest({
      operation: 'alpha-cleanup',
      params: { transparentBelow: 24, opaqueAbove: 127 },
    }, capabilities),
    (error) => error.status === 400,
  )
  assert.deepEqual(validateImageRequest({
    operation: 'alpha-cleanup',
    params: { transparentBelow: 127, opaqueAbove: 128 },
  }, capabilities).params, {
    transparentBelow: 127,
    opaqueAbove: 128,
  })
  assert.deepEqual(validateImageRequest({
    operation: 'upscale-realesrgan',
    params: { scale: 2, model: 'realesr-animevideov3', tileSize: 192 },
  }, capabilities).params, {
    scale: 2,
    model: 'realesr-animevideov3',
    tileSize: 192,
  })
})

test('masked adjustment accepts only controlled deterministic effects', () => {
  assert.deepEqual(validateImageRequest({
    operation: 'masked-adjust',
    sourceElementId: 'semantic-result-1',
    params: { effect: 'background-blur', strength: 0.75, feather: 12 },
  }, capabilities), {
    operation: 'masked-adjust',
    sourceElementId: 'semantic-result-1',
    maskProvided: true,
    params: { effect: 'background-blur', strength: 0.75, feather: 12 },
  })
  assert.throws(
    () => validateImageRequest({
      operation: 'masked-adjust',
      params: { effect: 'arbitrary-comfy-graph', strength: 0.5, feather: 4 },
    }, capabilities),
    (error) => error.status === 400,
  )
  assert.throws(
    () => validateImageRequest({
      operation: 'masked-adjust',
      params: { effect: 'background-dim', instruction: 'run anything' },
    }, capabilities),
    (error) => error.status === 400,
  )
})
