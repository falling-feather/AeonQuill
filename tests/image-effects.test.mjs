import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ImageEffectContractError,
  effectRecipeFromSteps,
  isReplayableImageStep,
  normalizeImageEffectParameters,
  reorderImageProcessingSteps,
  validateImageEffectRecipe,
} from '../src/lib/imageEffects.mjs'

const adjust = {
  kind: 'adjust',
  brightness: 120,
  contrast: 85,
  saturation: 110,
}

const crop = {
  kind: 'crop',
  aspect: '4:3',
  zoom: 1.25,
  positionX: 40,
  positionY: 60,
}

const maskRecipe = {
  schemaVersion: 2,
  strokes: [{
    id: 'stroke-1',
    mode: 'remove',
    size: 0.12,
    hardness: 0.8,
    points: [{ x: 0.2, y: 0.3 }, { x: 0.7, y: 0.6 }],
  }],
  morphology: { expand: 0, feather: 2, trim: 0 },
}

function step(id, type, extra = {}) {
  return {
    id,
    type,
    label: type,
    detail: '',
    enabled: true,
    createdAt: 1,
    ...extra,
  }
}

function codeOf(code) {
  return (error) => error instanceof ImageEffectContractError && error.code === code
}

test('normalizes effect parameters strictly and returns an independent copy', () => {
  const input = { ...adjust }
  const normalized = normalizeImageEffectParameters(input)
  assert.deepEqual(normalized, input)
  assert.notStrictEqual(normalized, input)
  normalized.brightness = 200
  assert.equal(input.brightness, 120)

  assert.throws(
    () => normalizeImageEffectParameters({ ...adjust, extra: true }),
    codeOf('UNKNOWN_FIELD'),
  )
  assert.throws(
    () => normalizeImageEffectParameters({ ...adjust, brightness: Number.NaN }),
    codeOf('INVALID_NUMBER'),
  )
  assert.throws(
    () => normalizeImageEffectParameters({ ...adjust, saturation: 201 }),
    codeOf('OUT_OF_RANGE'),
  )
  assert.throws(
    () => normalizeImageEffectParameters({ ...crop, zoom: 0.5 }),
    codeOf('OUT_OF_RANGE'),
  )
  assert.throws(
    () => normalizeImageEffectParameters({ ...crop, aspect: '2:1' }),
    codeOf('INVALID_ASPECT'),
  )
})

test('replayability requires a matching valid local parameter kind', () => {
  assert.equal(isReplayableImageStep(step('adjust-1', 'adjust', { parameters: adjust })), true)
  assert.equal(isReplayableImageStep(step('crop-1', 'crop', { parameters: crop })), true)
  assert.equal(isReplayableImageStep(step('wrong-kind', 'adjust', { parameters: crop })), false)
  assert.equal(isReplayableImageStep(step('invalid', 'adjust', { parameters: { ...adjust, brightness: 999 } })), false)
  assert.equal(isReplayableImageStep(step('mask-1', 'mask-refine', { maskRecipe })), true)
  assert.equal(isReplayableImageStep(step('invalid-mask', 'mask-refine', {
    maskRecipe: { schemaVersion: 1, strokes: [{ id: 'missing-points' }] },
  })), false)
  assert.equal(isReplayableImageStep(step('old-1', 'adjust', { outputSrc: 'data:image/png;base64,AA==' })), false)
})

test('reorders only adjacent replayable steps and never mutates the input', () => {
  const original = [
    step('adjust-1', 'adjust', { parameters: adjust }),
    step('crop-1', 'crop', { parameters: crop }),
    step('checkpoint', 'upscale', { outputSrc: 'data:image/png;base64,AA==' }),
    step('mask-1', 'mask-refine', { maskRecipe }),
  ]
  const moved = reorderImageProcessingSteps(original, 'crop-1', 'up')
  assert.deepEqual(moved.map(({ id }) => id), ['crop-1', 'adjust-1', 'checkpoint', 'mask-1'])
  assert.deepEqual(original.map(({ id }) => id), ['adjust-1', 'crop-1', 'checkpoint', 'mask-1'])
  assert.notStrictEqual(moved[0], original[1])

  assert.throws(
    () => reorderImageProcessingSteps(original, 'mask-1', 'up'),
    codeOf('STEP_NOT_MOVABLE'),
  )
  assert.throws(
    () => reorderImageProcessingSteps(original, 'adjust-1', 'up'),
    codeOf('STEP_NOT_MOVABLE'),
  )
  assert.throws(
    () => reorderImageProcessingSteps([
      step('duplicate', 'adjust', { parameters: adjust }),
      step('duplicate', 'crop', { parameters: crop }),
    ], 'duplicate', 'down'),
    codeOf('DUPLICATE_STEP_ID'),
  )
  assert.throws(
    () => reorderImageProcessingSteps(original, 'adjust-1', 'sideways'),
    codeOf('INVALID_DIRECTION'),
  )
  assert.throws(
    () => reorderImageProcessingSteps(original, 'missing', 'down'),
    codeOf('STEP_NOT_FOUND'),
  )
  assert.throws(
    () => reorderImageProcessingSteps(new Array(65).fill(null).map((_, index) =>
      step(`too-many-${index}`, 'adjust', { parameters: adjust })), 'too-many-1', 'up'),
    codeOf('TOO_MANY_STEPS'),
  )
})

test('creates an effect recipe without persistent metadata or disabled steps', () => {
  const input = [
    step('adjust-1', 'adjust', { parameters: adjust, outputSrc: 'old-adjust' }),
    step('disabled-crop', 'crop', { parameters: crop, enabled: false, outputSrc: 'old-crop' }),
    step('mask-1', 'mask-refine', { maskRecipe, outputSrc: 'old-mask' }),
    step('remote-1', 'upscale', { outputSrc: 'remote-result' }),
  ]
  const recipe = effectRecipeFromSteps(input)
  assert.deepEqual(recipe, {
    kind: 'aeonquill.image-effect-recipe',
    schemaVersion: 1,
    steps: [
      { type: 'adjust', parameters: adjust },
      { type: 'mask-refine', maskRecipe },
    ],
  })
  assert.equal(Object.hasOwn(recipe.steps[0], 'id'), false)
  recipe.steps[0].parameters.brightness = 1
  recipe.steps[1].maskRecipe.strokes[0].points[0].x = 0.9
  assert.equal(input[0].parameters.brightness, 120)
  assert.equal(input[2].maskRecipe.strokes[0].points[0].x, 0.2)

  assert.throws(
    () => effectRecipeFromSteps(new Array(65).fill(null).map((_, index) =>
      step(`adjust-${index}`, 'adjust', { parameters: adjust }))),
    codeOf('TOO_MANY_STEPS'),
  )
})

test('validates recipe protocol and rejects unknown or malformed fields', () => {
  const valid = {
    kind: 'aeonquill.image-effect-recipe',
    schemaVersion: 1,
    steps: [
      { type: 'adjust', parameters: adjust },
      { type: 'crop', parameters: crop },
      { type: 'mask-refine', maskRecipe },
    ],
  }
  const validated = validateImageEffectRecipe(valid)
  assert.deepEqual(validated, valid)
  assert.notStrictEqual(validated, valid)
  validated.steps[0].parameters.contrast = 1
  assert.equal(valid.steps[0].parameters.contrast, 85)

  assert.throws(
    () => validateImageEffectRecipe({ ...valid, extra: true }),
    codeOf('UNKNOWN_FIELD'),
  )
  assert.throws(
    () => validateImageEffectRecipe({ ...valid, schemaVersion: 2 }),
    codeOf('UNSUPPORTED_SCHEMA'),
  )
  assert.throws(
    () => validateImageEffectRecipe({
      ...valid,
      steps: [{ type: 'adjust', parameters: { ...adjust, hidden: 1 } }],
    }),
    codeOf('UNKNOWN_FIELD'),
  )
  assert.throws(
    () => validateImageEffectRecipe({
      ...valid,
      steps: [{ type: 'mask-refine', maskRecipe: { ...maskRecipe, hidden: true } }],
    }),
    codeOf('UNKNOWN_FIELD'),
  )
  assert.throws(
    () => validateImageEffectRecipe({
      ...valid,
      steps: [{ type: 'crop', parameters: crop, maskRecipe }],
    }),
    codeOf('UNKNOWN_FIELD'),
  )
  assert.throws(
    () => validateImageEffectRecipe({
      ...valid,
      steps: [{ type: 'adjust', parameters: crop }],
    }),
    codeOf('PARAMETER_KIND_MISMATCH'),
  )
})
