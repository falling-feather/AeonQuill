import { assertMaskRecipe } from './maskRecipe.mjs'

export const IMAGE_EFFECT_RECIPE_KIND = 'aeonquill.image-effect-recipe'
export const IMAGE_EFFECT_RECIPE_SCHEMA_VERSION = 1
export const IMAGE_EFFECT_MAX_EDGE = 4096
export const IMAGE_EFFECT_MAX_PIXELS = 16_000_000
export const IMAGE_EFFECT_MAX_CACHED_CHARACTERS = 16 * 1024 * 1024
export const IMAGE_EFFECT_MAX_BATCH_PIXELS = 32_000_000
export const IMAGE_EFFECT_MAX_BATCH_WORK_PIXELS = 128_000_000
export const IMAGE_EFFECT_MAX_DOCUMENT_BYTES = 24 * 1024 * 1024

export function resolveImageProcessingSource(element) {
  return [...(element.processingStack ?? [])].reverse().find((step) => step.enabled && step.outputSrc)?.outputSrc
    ?? element.sourceSrc ?? element.src
}

export function editableImageProcessingSteps(element) {
  const steps = clone(element.processingStack ?? [])
  const legacy = steps.filter((step) => step.type === 'adjust' && !step.parameters)
  if (!legacy.length) return steps
  if (legacy.length > 1) fail('LEGACY_ADJUSTMENT_AMBIGUOUS', '旧调整步骤重复，请先清空效果或另存原图后重新添加')
  const step = legacy[0]
  step.parameters = normalizeImageEffectParameters({ kind: 'adjust',
    ...(element.adjustments ?? { brightness: 100, contrast: 100, saturation: 100 }) })
  // Legacy adjustments were rendered as one final CSS filter regardless of
  // their recorded position. Make that existing order explicit on first edit.
  return [...steps.filter((item) => item !== step), step]
}

const ADJUST_KEYS = new Set(['kind', 'brightness', 'contrast', 'saturation'])
const CROP_KEYS = new Set(['kind', 'aspect', 'zoom', 'positionX', 'positionY'])
const RECIPE_KEYS = new Set(['kind', 'schemaVersion', 'steps'])
const ADJUST_RECIPE_STEP_KEYS = new Set(['type', 'parameters'])
const CROP_RECIPE_STEP_KEYS = new Set(['type', 'parameters'])
const MASK_RECIPE_STEP_KEYS = new Set(['type', 'maskRecipe'])
const CROP_ASPECTS = new Set(['1:1', '4:3', '3:4', '16:9'])

export class ImageEffectContractError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'ImageEffectContractError'
    this.code = code
    this.details = details
  }
}

function fail(code, message, details = undefined) {
  throw new ImageEffectContractError(code, message, details)
}

function clone(value) {
  return globalThis.structuredClone(value)
}

function isRecord(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
}

function assertRecord(value, path) {
  if (!isRecord(value)) fail('INVALID_OBJECT', `${path} must be a plain object`)
}

function assertExactKeys(value, allowed, path) {
  assertRecord(value, path)
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length) {
    fail('UNKNOWN_FIELD', `${path} contains unsupported fields`, { path, fields: unknown })
  }
}

function assertNumber(value, path, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('INVALID_NUMBER', `${path} must be a finite number`)
  }
  if (value < minimum || value > maximum) {
    fail('OUT_OF_RANGE', `${path} must be between ${minimum} and ${maximum}`)
  }
}

function assertRecipeMask(recipe, path) {
  return assertMaskRecipe(recipe, path, (code, message, details) => fail(code, message, details))
}

function normalizeAdjustParameters(input) {
  assertExactKeys(input, ADJUST_KEYS, 'parameters')
  if (input.kind !== 'adjust') fail('INVALID_KIND', 'parameters.kind must be adjust')
  assertNumber(input.brightness, 'parameters.brightness', 0, 200)
  assertNumber(input.contrast, 'parameters.contrast', 0, 200)
  assertNumber(input.saturation, 'parameters.saturation', 0, 200)
  return {
    kind: 'adjust',
    brightness: input.brightness,
    contrast: input.contrast,
    saturation: input.saturation,
  }
}

function normalizeCropParameters(input) {
  assertExactKeys(input, CROP_KEYS, 'parameters')
  if (input.kind !== 'crop') fail('INVALID_KIND', 'parameters.kind must be crop')
  if (typeof input.aspect !== 'string' || !CROP_ASPECTS.has(input.aspect)) {
    fail('INVALID_ASPECT', 'parameters.aspect is unsupported')
  }
  assertNumber(input.zoom, 'parameters.zoom', 1, 2.5)
  assertNumber(input.positionX, 'parameters.positionX', 0, 100)
  assertNumber(input.positionY, 'parameters.positionY', 0, 100)
  return {
    kind: 'crop',
    aspect: input.aspect,
    zoom: input.zoom,
    positionX: input.positionX,
    positionY: input.positionY,
  }
}

export function normalizeImageEffectParameters(input) {
  assertRecord(input, 'parameters')
  if (input.kind === 'adjust') return normalizeAdjustParameters(input)
  if (input.kind === 'crop') return normalizeCropParameters(input)
  fail('INVALID_KIND', 'parameters.kind must be adjust or crop')
}

function stepParameters(step) {
  if (!isRecord(step)) return undefined
  return step.parameters
}

export function isReplayableImageStep(step) {
  if (!isRecord(step) || typeof step.type !== 'string') return false
  if (step.type === 'mask-refine') {
    try {
      assertRecipeMask(step.maskRecipe, 'step.maskRecipe')
      return true
    } catch {
      return false
    }
  }
  if (step.type !== 'adjust' && step.type !== 'crop') return false
  const parameters = stepParameters(step)
  if (!isRecord(parameters) || parameters.kind !== step.type) return false
  try {
    normalizeImageEffectParameters(parameters)
    return true
  } catch {
    return false
  }
}

function assertProcessingSteps(steps) {
  if (!Array.isArray(steps)) fail('INVALID_STEPS', 'steps must be an array')
  if (steps.length > 64) fail('TOO_MANY_STEPS', 'steps must contain at most 64 items')
  const ids = new Set()
  steps.forEach((step, index) => {
    assertRecord(step, `steps[${index}]`)
    if (typeof step.id !== 'string' || !step.id.trim()) {
      fail('INVALID_STEP_ID', `steps[${index}].id must be a non-empty string`)
    }
    if (ids.has(step.id)) fail('DUPLICATE_STEP_ID', `steps contains duplicate id ${step.id}`)
    ids.add(step.id)
  })
}

export function reorderImageProcessingSteps(steps, stepId, direction) {
  assertProcessingSteps(steps)
  if (direction !== 'up' && direction !== 'down') {
    fail('INVALID_DIRECTION', 'direction must be up or down')
  }
  if (typeof stepId !== 'string' || !stepId.trim()) {
    fail('STEP_NOT_FOUND', 'stepId must identify an existing step')
  }
  const index = steps.findIndex((step) => step.id === stepId)
  if (index < 0) fail('STEP_NOT_FOUND', `step ${stepId} was not found`)
  const adjacentIndex = direction === 'up' ? index - 1 : index + 1
  if (adjacentIndex < 0 || adjacentIndex >= steps.length) {
    fail('STEP_NOT_MOVABLE', `step ${stepId} cannot move ${direction}`)
  }
  if (!isReplayableImageStep(steps[index]) || !isReplayableImageStep(steps[adjacentIndex])) {
    fail('STEP_NOT_MOVABLE', `step ${stepId} cannot cross a fixed processing checkpoint`)
  }
  const result = clone(steps)
  const [moved] = result.splice(index, 1)
  result.splice(adjacentIndex, 0, moved)
  return result
}

function recipeStepFromProcessingStep(step, index) {
  if (!step.enabled || !isReplayableImageStep(step)) return undefined
  if (step.type === 'adjust' || step.type === 'crop') {
    return {
      type: step.type,
      parameters: normalizeImageEffectParameters(step.parameters),
    }
  }
  assertRecipeMask(step.maskRecipe, `steps[${index}].maskRecipe`)
  return {
    type: 'mask-refine',
    maskRecipe: clone(step.maskRecipe),
  }
}

export function effectRecipeFromSteps(steps) {
  assertProcessingSteps(steps)
  if (steps.length > 64) fail('TOO_MANY_STEPS', 'steps must contain at most 64 items')
  const recipeSteps = steps
    .map((step, index) => recipeStepFromProcessingStep(step, index))
    .filter((step) => step !== undefined)
  return {
    kind: IMAGE_EFFECT_RECIPE_KIND,
    schemaVersion: IMAGE_EFFECT_RECIPE_SCHEMA_VERSION,
    steps: recipeSteps,
  }
}

function validateRecipeStep(step, index) {
  const path = `recipe.steps[${index}]`
  assertRecord(step, path)
  if (step.type === 'adjust') {
    assertExactKeys(step, ADJUST_RECIPE_STEP_KEYS, path)
    const parameters = normalizeImageEffectParameters(step.parameters)
    if (parameters.kind !== 'adjust') {
      fail('PARAMETER_KIND_MISMATCH', `${path}.parameters.kind must match type`)
    }
    return {
      type: 'adjust',
      parameters,
    }
  }
  if (step.type === 'crop') {
    assertExactKeys(step, CROP_RECIPE_STEP_KEYS, path)
    const parameters = normalizeImageEffectParameters(step.parameters)
    if (parameters.kind !== 'crop') {
      fail('PARAMETER_KIND_MISMATCH', `${path}.parameters.kind must match type`)
    }
    return {
      type: 'crop',
      parameters,
    }
  }
  if (step.type === 'mask-refine') {
    assertExactKeys(step, MASK_RECIPE_STEP_KEYS, path)
    assertRecipeMask(step.maskRecipe, `${path}.maskRecipe`)
    return {
      type: 'mask-refine',
      maskRecipe: clone(step.maskRecipe),
    }
  }
  fail('UNSUPPORTED_STEP_TYPE', `${path}.type is unsupported`)
}

export function validateImageEffectRecipe(input) {
  assertExactKeys(input, RECIPE_KEYS, 'recipe')
  if (input.kind !== IMAGE_EFFECT_RECIPE_KIND) fail('INVALID_RECIPE_KIND', 'recipe.kind is unsupported')
  if (input.schemaVersion !== IMAGE_EFFECT_RECIPE_SCHEMA_VERSION) {
    fail('UNSUPPORTED_SCHEMA', 'recipe.schemaVersion is unsupported')
  }
  if (!Array.isArray(input.steps) || input.steps.length > 64) {
    fail('TOO_MANY_STEPS', 'recipe.steps must contain at most 64 items')
  }
  return {
    kind: IMAGE_EFFECT_RECIPE_KIND,
    schemaVersion: IMAGE_EFFECT_RECIPE_SCHEMA_VERSION,
    steps: input.steps.map(validateRecipeStep),
  }
}
