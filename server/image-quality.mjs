const DEFAULT_THRESHOLD = 128
const DEFAULT_BOUNDARY_RADIUS = 2
const MAX_MASK_PIXELS = 24_000_000
const MAX_SAMPLES = 5_000
const MAX_CANDIDATES = 16
const MAX_REPAIR_OBSERVATIONS = 20

export const IMAGE_QUALITY_CATEGORIES = Object.freeze([
  'product',
  'portrait',
  'illustration',
  'hair-translucent',
])

export const IMAGE_QUALITY_METRIC_DIRECTIONS = Object.freeze({
  alphaMae: 'lower',
  binaryIou: 'higher',
  precision: 'higher',
  recall: 'higher',
  f1: 'higher',
  boundaryPrecision: 'higher',
  boundaryRecall: 'higher',
  boundaryF1: 'higher',
  boundaryAlphaMae: 'lower',
  backgroundLeakage: 'lower',
  foregroundOpacityError: 'lower',
})

function fail(message) {
  throw Object.assign(new Error(message), { code: 'IMAGE_QUALITY_MANIFEST_INVALID' })
}

function isRecord(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

function assertRecord(value, label) {
  if (!isRecord(value)) fail(`${label} must be an object`)
}

function assertExactKeys(value, allowedKeys, requiredKeys, label) {
  assertRecord(value, label)
  const allowed = new Set(allowedKeys)
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length) fail(`${label} contains unsupported keys: ${unknown.join(', ')}`)
  const missing = requiredKeys.filter((key) => !Object.hasOwn(value, key))
  if (missing.length) fail(`${label} is missing required keys: ${missing.join(', ')}`)
}

function boundedString(value, label, maximum = 500) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    fail(`${label} must be a non-empty string no longer than ${maximum} characters`)
  }
  return value.trim()
}

function identifier(value, label) {
  const normalized = boundedString(value, label, 80)
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(normalized)) {
    fail(`${label} must contain only letters, numbers, dots, underscores, and hyphens`)
  }
  return normalized
}

function boundedNumber(value, label, minimum, maximum, integer = false) {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value < minimum
    || value > maximum
    || (integer && !Number.isInteger(value))
  ) {
    fail(`${label} must be ${integer ? 'an integer ' : ''}between ${minimum} and ${maximum}`)
  }
  return value
}

function relativeMaskPath(value, label) {
  const normalized = boundedString(value, label, 500)
  if (
    normalized.includes('\\')
    || normalized.startsWith('/')
    || /^[a-z]:/i.test(normalized)
    || normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    fail(`${label} must be a portable relative path inside the benchmark directory`)
  }
  return normalized
}

function validatePrediction(value, sampleIndex, predictionIndex, candidateIds) {
  const label = `samples[${sampleIndex}].predictions[${predictionIndex}]`
  assertExactKeys(
    value,
    ['candidateId', 'mask', 'latencyMs', 'peakVramMiB', 'repairSeconds', 'notes'],
    ['candidateId', 'mask', 'latencyMs', 'peakVramMiB'],
    label,
  )
  const candidateId = identifier(value.candidateId, `${label}.candidateId`)
  if (!candidateIds.has(candidateId)) fail(`${label}.candidateId is not declared by candidates`)
  const repairSeconds = value.repairSeconds === undefined
    ? []
    : (() => {
        if (
          !Array.isArray(value.repairSeconds)
          || !value.repairSeconds.length
          || value.repairSeconds.length > MAX_REPAIR_OBSERVATIONS
        ) {
          fail(
            `${label}.repairSeconds must contain 1-${MAX_REPAIR_OBSERVATIONS} observations when provided`,
          )
        }
        return value.repairSeconds.map((seconds, index) => boundedNumber(
          seconds,
          `${label}.repairSeconds[${index}]`,
          0,
          86_400,
        ))
      })()
  return {
    candidateId,
    mask: relativeMaskPath(value.mask, `${label}.mask`),
    latencyMs: boundedNumber(value.latencyMs, `${label}.latencyMs`, 0, 3_600_000),
    peakVramMiB: boundedNumber(value.peakVramMiB, `${label}.peakVramMiB`, 0, 262_144),
    repairSeconds,
    ...(value.notes === undefined ? {} : { notes: boundedString(value.notes, `${label}.notes`) }),
  }
}

export function validateImageQualityManifest(value) {
  assertExactKeys(
    value,
    ['schemaVersion', 'datasetId', 'description', 'evaluation', 'candidates', 'samples'],
    ['schemaVersion', 'datasetId', 'description', 'evaluation', 'candidates', 'samples'],
    'manifest',
  )
  if (value.schemaVersion !== 1) fail('manifest.schemaVersion must equal 1')

  assertExactKeys(
    value.evaluation,
    ['threshold', 'boundaryRadius'],
    ['threshold', 'boundaryRadius'],
    'manifest.evaluation',
  )
  const evaluation = {
    threshold: boundedNumber(
      value.evaluation.threshold,
      'manifest.evaluation.threshold',
      1,
      254,
      true,
    ),
    boundaryRadius: boundedNumber(
      value.evaluation.boundaryRadius,
      'manifest.evaluation.boundaryRadius',
      0,
      16,
      true,
    ),
  }

  if (
    !Array.isArray(value.candidates)
    || !value.candidates.length
    || value.candidates.length > MAX_CANDIDATES
  ) {
    fail(`manifest.candidates must contain 1-${MAX_CANDIDATES} candidates`)
  }
  const candidates = value.candidates.map((candidate, index) => {
    const label = `candidates[${index}]`
    assertExactKeys(candidate, ['id', 'label', 'registryId'], ['id', 'label'], label)
    return {
      id: identifier(candidate.id, `${label}.id`),
      label: boundedString(candidate.label, `${label}.label`, 120),
      ...(candidate.registryId === undefined
        ? {}
        : { registryId: identifier(candidate.registryId, `${label}.registryId`) }),
    }
  })
  const candidateIds = new Set(candidates.map((candidate) => candidate.id))
  if (candidateIds.size !== candidates.length) fail('manifest.candidates contains duplicate ids')

  if (!Array.isArray(value.samples) || !value.samples.length || value.samples.length > MAX_SAMPLES) {
    fail(`manifest.samples must contain 1-${MAX_SAMPLES} samples`)
  }
  const sampleIds = new Set()
  const samples = value.samples.map((sample, sampleIndex) => {
    const label = `samples[${sampleIndex}]`
    assertExactKeys(
      sample,
      ['id', 'category', 'width', 'height', 'groundTruthMask', 'predictions', 'notes'],
      ['id', 'category', 'width', 'height', 'groundTruthMask', 'predictions'],
      label,
    )
    const id = identifier(sample.id, `${label}.id`)
    if (sampleIds.has(id)) fail(`${label}.id is duplicated`)
    sampleIds.add(id)
    if (!IMAGE_QUALITY_CATEGORIES.includes(sample.category)) {
      fail(`${label}.category is not supported`)
    }
    const width = boundedNumber(sample.width, `${label}.width`, 1, 8_192, true)
    const height = boundedNumber(sample.height, `${label}.height`, 1, 8_192, true)
    if (width * height > MAX_MASK_PIXELS) fail(`${label} exceeds ${MAX_MASK_PIXELS} pixels`)
    if (!Array.isArray(sample.predictions) || !sample.predictions.length) {
      fail(`${label}.predictions must not be empty`)
    }
    const predictions = sample.predictions.map((prediction, predictionIndex) => (
      validatePrediction(prediction, sampleIndex, predictionIndex, candidateIds)
    ))
    if (new Set(predictions.map((prediction) => prediction.candidateId)).size !== predictions.length) {
      fail(`${label}.predictions contains a duplicate candidate`)
    }
    return {
      id,
      category: sample.category,
      width,
      height,
      groundTruthMask: relativeMaskPath(
        sample.groundTruthMask,
        `${label}.groundTruthMask`,
      ),
      predictions,
      ...(sample.notes === undefined ? {} : { notes: boundedString(sample.notes, `${label}.notes`) }),
    }
  })

  return {
    schemaVersion: 1,
    datasetId: identifier(value.datasetId, 'manifest.datasetId'),
    description: boundedString(value.description, 'manifest.description', 1_000),
    evaluation,
    candidates,
    samples,
  }
}

function assertMask(mask, expectedLength, label) {
  if (!(mask instanceof Uint8Array) && !(mask instanceof Uint8ClampedArray)) {
    throw new TypeError(`${label} must be an 8-bit typed array`)
  }
  if (mask.length !== expectedLength) {
    throw new RangeError(`${label} length must equal width × height`)
  }
}

function binaryBoundary(binary, width, height) {
  const output = new Uint8Array(binary.length)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x
      if (!binary[index]) continue
      let boundary = x === 0 || y === 0 || x === width - 1 || y === height - 1
      for (let offsetY = -1; !boundary && offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (!offsetX && !offsetY) continue
          const neighbor = (y + offsetY) * width + x + offsetX
          if (!binary[neighbor]) {
            boundary = true
            break
          }
        }
      }
      if (boundary) output[index] = 1
    }
  }
  return output
}

function dilateBinary(binary, width, height, radius) {
  if (!radius) return binary.slice()
  const horizontal = new Uint8Array(binary.length)
  const output = new Uint8Array(binary.length)
  for (let y = 0; y < height; y += 1) {
    let active = 0
    for (let x = -radius; x < width; x += 1) {
      if (x + radius < width) active += binary[y * width + x + radius]
      if (x - radius - 1 >= 0) active -= binary[y * width + x - radius - 1]
      if (x >= 0) horizontal[y * width + x] = active > 0 ? 1 : 0
    }
  }
  for (let x = 0; x < width; x += 1) {
    let active = 0
    for (let y = -radius; y < height; y += 1) {
      if (y + radius < height) active += horizontal[(y + radius) * width + x]
      if (y - radius - 1 >= 0) active -= horizontal[(y - radius - 1) * width + x]
      if (y >= 0) output[y * width + x] = active > 0 ? 1 : 0
    }
  }
  return output
}

function ratioOrPerfect(numerator, denominator, otherDenominator) {
  if (denominator) return numerator / denominator
  return otherDenominator ? 0 : 1
}

export function evaluateAlphaMask({
  prediction,
  groundTruth,
  width,
  height,
  threshold = DEFAULT_THRESHOLD,
  boundaryRadius = DEFAULT_BOUNDARY_RADIUS,
}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError('width and height must be positive integers')
  }
  if (width * height > MAX_MASK_PIXELS) throw new RangeError('mask exceeds the evaluation pixel limit')
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 254) {
    throw new RangeError('threshold must be an integer between 1 and 254')
  }
  if (!Number.isInteger(boundaryRadius) || boundaryRadius < 0 || boundaryRadius > 16) {
    throw new RangeError('boundaryRadius must be an integer between 0 and 16')
  }
  const pixelCount = width * height
  assertMask(prediction, pixelCount, 'prediction')
  assertMask(groundTruth, pixelCount, 'groundTruth')

  const predictedBinary = new Uint8Array(pixelCount)
  const truthBinary = new Uint8Array(pixelCount)
  let absoluteError = 0
  let truePositive = 0
  let falsePositive = 0
  let falseNegative = 0
  let backgroundLeakage = 0
  let backgroundCount = 0
  let foregroundOpacityError = 0
  let foregroundCount = 0

  for (let index = 0; index < pixelCount; index += 1) {
    const predictedAlpha = prediction[index]
    const truthAlpha = groundTruth[index]
    absoluteError += Math.abs(predictedAlpha - truthAlpha)
    const predictedForeground = predictedAlpha >= threshold
    const truthForeground = truthAlpha >= threshold
    predictedBinary[index] = predictedForeground ? 1 : 0
    truthBinary[index] = truthForeground ? 1 : 0
    if (predictedForeground && truthForeground) truePositive += 1
    else if (predictedForeground) falsePositive += 1
    else if (truthForeground) falseNegative += 1
    if (truthAlpha === 0) {
      backgroundLeakage += predictedAlpha
      backgroundCount += 1
    }
    if (truthAlpha === 255) {
      foregroundOpacityError += 255 - predictedAlpha
      foregroundCount += 1
    }
  }

  const predictedBoundary = binaryBoundary(predictedBinary, width, height)
  const truthBoundary = binaryBoundary(truthBinary, width, height)
  const predictedBoundaryTolerance = dilateBinary(predictedBoundary, width, height, boundaryRadius)
  const truthBoundaryTolerance = dilateBinary(truthBoundary, width, height, boundaryRadius)
  const boundaryBand = dilateBinary(truthBoundary, width, height, Math.max(1, boundaryRadius))
  let predictedBoundaryCount = 0
  let truthBoundaryCount = 0
  let matchedPredictedBoundary = 0
  let matchedTruthBoundary = 0
  let boundaryAbsoluteError = 0
  let boundaryBandCount = 0

  for (let index = 0; index < pixelCount; index += 1) {
    if (predictedBoundary[index]) {
      predictedBoundaryCount += 1
      if (truthBoundaryTolerance[index]) matchedPredictedBoundary += 1
    }
    if (truthBoundary[index]) {
      truthBoundaryCount += 1
      if (predictedBoundaryTolerance[index]) matchedTruthBoundary += 1
    }
    if (boundaryBand[index]) {
      boundaryAbsoluteError += Math.abs(prediction[index] - groundTruth[index])
      boundaryBandCount += 1
    }
  }

  const predictedPositive = truePositive + falsePositive
  const truthPositive = truePositive + falseNegative
  const union = truePositive + falsePositive + falseNegative
  const precision = ratioOrPerfect(truePositive, predictedPositive, truthPositive)
  const recall = ratioOrPerfect(truePositive, truthPositive, predictedPositive)
  const boundaryPrecision = ratioOrPerfect(
    matchedPredictedBoundary,
    predictedBoundaryCount,
    truthBoundaryCount,
  )
  const boundaryRecall = ratioOrPerfect(
    matchedTruthBoundary,
    truthBoundaryCount,
    predictedBoundaryCount,
  )

  return {
    alphaMae: absoluteError / (pixelCount * 255),
    binaryIou: union ? truePositive / union : 1,
    precision,
    recall,
    f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0,
    boundaryPrecision,
    boundaryRecall,
    boundaryF1: boundaryPrecision + boundaryRecall
      ? 2 * boundaryPrecision * boundaryRecall / (boundaryPrecision + boundaryRecall)
      : 0,
    boundaryAlphaMae: boundaryBandCount
      ? boundaryAbsoluteError / (boundaryBandCount * 255)
      : 0,
    backgroundLeakage: backgroundCount ? backgroundLeakage / (backgroundCount * 255) : 0,
    foregroundOpacityError: foregroundCount
      ? foregroundOpacityError / (foregroundCount * 255)
      : 0,
  }
}

export function quantile(values, ratio) {
  if (!Array.isArray(values) || !values.length) return null
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
    throw new RangeError('ratio must be between 0 and 1')
  }
  const sorted = values.map((value) => {
    if (!Number.isFinite(value)) throw new TypeError('quantile values must be finite numbers')
    return value
  }).sort((left, right) => left - right)
  const position = (sorted.length - 1) * ratio
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  const fraction = position - lower
  return sorted[lower] + (sorted[upper] - sorted[lower]) * fraction
}

function rounded(value) {
  return value === null ? null : Number(value.toFixed(6))
}

export function summarizeDistribution(values) {
  if (!Array.isArray(values) || !values.length) {
    return { count: 0, min: null, mean: null, p50: null, p95: null, max: null }
  }
  const normalized = values.map((value) => {
    if (!Number.isFinite(value)) throw new TypeError('distribution values must be finite numbers')
    return value
  })
  return {
    count: normalized.length,
    min: rounded(Math.min(...normalized)),
    mean: rounded(normalized.reduce((sum, value) => sum + value, 0) / normalized.length),
    p50: rounded(quantile(normalized, 0.5)),
    p95: rounded(quantile(normalized, 0.95)),
    max: rounded(Math.max(...normalized)),
  }
}

export function assessImageQualityCoverage(manifest, minimumPerCategory = 20) {
  const normalized = validateImageQualityManifest(manifest)
  if (!Number.isInteger(minimumPerCategory) || minimumPerCategory < 1 || minimumPerCategory > 1_000) {
    throw new RangeError('minimumPerCategory must be an integer between 1 and 1000')
  }
  const datasetCategories = Object.fromEntries(IMAGE_QUALITY_CATEGORIES.map((category) => [
    category,
    normalized.samples.filter((sample) => sample.category === category).length,
  ]))
  let predictionCount = 0
  let repairObservationCount = 0
  let predictionsWithRepair = 0
  const candidates = Object.fromEntries(normalized.candidates.map((candidate) => {
    const categories = Object.fromEntries(IMAGE_QUALITY_CATEGORIES.map((category) => {
      const count = normalized.samples.filter((sample) => (
        sample.category === category
        && sample.predictions.some((prediction) => prediction.candidateId === candidate.id)
      )).length
      return [category, count]
    }))
    const predictions = normalized.samples.flatMap((sample) => (
      sample.predictions.filter((prediction) => prediction.candidateId === candidate.id)
    ))
    predictionCount += predictions.length
    predictionsWithRepair += predictions.filter((prediction) => prediction.repairSeconds.length).length
    repairObservationCount += predictions.reduce(
      (total, prediction) => total + prediction.repairSeconds.length,
      0,
    )
    return [candidate.id, {
      categories,
      complete: IMAGE_QUALITY_CATEGORIES.every(
        (category) => categories[category] >= minimumPerCategory,
      ),
    }]
  }))
  const datasetComplete = IMAGE_QUALITY_CATEGORIES.every(
    (category) => datasetCategories[category] >= minimumPerCategory,
  )
  const candidatesComplete = Object.values(candidates).every((candidate) => candidate.complete)
  const repairComplete = predictionCount > 0 && predictionsWithRepair === predictionCount
  return {
    minimumPerCategory,
    datasetCategories,
    datasetComplete,
    candidates,
    candidatesComplete,
    repair: {
      predictionCount,
      predictionsWithRepair,
      observationCount: repairObservationCount,
      complete: repairComplete,
    },
    gateReady: datasetComplete && candidatesComplete && repairComplete,
  }
}
