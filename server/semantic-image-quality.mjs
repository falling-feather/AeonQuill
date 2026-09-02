import { IMAGE_QUALITY_CATEGORIES, summarizeDistribution } from './image-quality.mjs'

export const SEMANTIC_IMAGE_QUALITY_WORKFLOWS = Object.freeze([
  'region-edit',
  'point-edit',
  'portrait-adjust',
])

const SHA256 = /^[a-f0-9]{64}$/u
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]*$/iu
const MAX_PIXELS = 24_000_000
const MAX_SAMPLES = 2_000
const MAX_CANDIDATES = 12

function fail(message) {
  throw Object.assign(new Error(message), { code: 'SEMANTIC_IMAGE_QUALITY_MANIFEST_INVALID' })
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value, allowed, required, label) {
  if (!isRecord(value)) fail(`${label} must be an object`)
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length) fail(`${label} contains unsupported fields: ${unknown.join(', ')}`)
  const missing = required.filter((key) => !Object.hasOwn(value, key))
  if (missing.length) fail(`${label} is missing fields: ${missing.join(', ')}`)
}

function boundedString(value, label, maximum = 1_000) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    fail(`${label} must contain 1-${maximum} characters`)
  }
  return value.trim()
}

function identifier(value, label) {
  const normalized = boundedString(value, label, 80)
  if (!IDENTIFIER.test(normalized)) fail(`${label} must be a portable identifier`)
  return normalized
}

function integer(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${label} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

function number(value, label, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    fail(`${label} must be between ${minimum} and ${maximum}`)
  }
  return value
}

function relativePath(value, label) {
  const normalized = boundedString(value, label, 500)
  if (
    normalized.includes('\\')
    || normalized.startsWith('/')
    || /^[a-z]:/iu.test(normalized)
    || normalized.split('/').some((part) => !part || part === '.' || part === '..')
  ) fail(`${label} must be a contained portable relative path`)
  return normalized
}

function fileDescriptor(value, label) {
  exactKeys(value, ['path', 'sha256'], ['path', 'sha256'], label)
  if (typeof value.sha256 !== 'string' || !SHA256.test(value.sha256)) {
    fail(`${label}.sha256 must be a lowercase SHA-256 digest`)
  }
  return { path: relativePath(value.path, `${label}.path`), sha256: value.sha256 }
}

function validateLicense(value, label) {
  exactKeys(
    value,
    ['code', 'model', 'redistribution', 'commercial', 'sources', 'reviewedAt'],
    ['code', 'model', 'redistribution', 'commercial', 'sources', 'reviewedAt'],
    label,
  )
  if (!Array.isArray(value.sources) || !value.sources.length || value.sources.length > 12) {
    fail(`${label}.sources must contain 1-12 source URLs`)
  }
  const sources = value.sources.map((source, index) => {
    const url = boundedString(source, `${label}.sources[${index}]`, 500)
    if (!/^https:\/\//iu.test(url)) fail(`${label}.sources[${index}] must use HTTPS`)
    return url
  })
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value.reviewedAt)) fail(`${label}.reviewedAt must use YYYY-MM-DD`)
  return {
    code: boundedString(value.code, `${label}.code`, 120),
    model: boundedString(value.model, `${label}.model`, 120),
    redistribution: boundedString(value.redistribution, `${label}.redistribution`, 120),
    commercial: boundedString(value.commercial, `${label}.commercial`, 120),
    sources,
    reviewedAt: value.reviewedAt,
  }
}

function validateCandidate(value, index) {
  const label = `candidates[${index}]`
  exactKeys(
    value,
    ['id', 'label', 'workflowVersion', 'artifacts', 'license'],
    ['id', 'label', 'workflowVersion', 'artifacts', 'license'],
    label,
  )
  exactKeys(
    value.artifacts,
    ['diffusion', 'textEncoder', 'vae'],
    ['diffusion', 'textEncoder', 'vae'],
    `${label}.artifacts`,
  )
  const artifacts = {}
  for (const key of ['diffusion', 'textEncoder', 'vae']) {
    const digest = value.artifacts[key]
    if (typeof digest !== 'string' || !SHA256.test(digest)) {
      fail(`${label}.artifacts.${key} must be a lowercase SHA-256 digest`)
    }
    artifacts[key] = digest
  }
  return {
    id: identifier(value.id, `${label}.id`),
    label: boundedString(value.label, `${label}.label`, 120),
    workflowVersion: identifier(value.workflowVersion, `${label}.workflowVersion`),
    artifacts,
    license: validateLicense(value.license, `${label}.license`),
  }
}

function validateEnvironment(value) {
  exactKeys(
    value,
    ['gpu', 'vramMiB', 'systemRamMiB', 'os', 'runtimePackageId', 'comfyVersion', 'nodeInventorySha256'],
    ['gpu', 'vramMiB', 'systemRamMiB', 'os', 'runtimePackageId', 'comfyVersion', 'nodeInventorySha256'],
    'environment',
  )
  if (typeof value.nodeInventorySha256 !== 'string' || !SHA256.test(value.nodeInventorySha256)) {
    fail('environment.nodeInventorySha256 must be a lowercase SHA-256 digest')
  }
  return {
    gpu: boundedString(value.gpu, 'environment.gpu', 160),
    vramMiB: integer(value.vramMiB, 'environment.vramMiB', 0, 262_144),
    systemRamMiB: integer(value.systemRamMiB, 'environment.systemRamMiB', 0, 2_097_152),
    os: boundedString(value.os, 'environment.os', 160),
    runtimePackageId: identifier(value.runtimePackageId, 'environment.runtimePackageId'),
    comfyVersion: boundedString(value.comfyVersion, 'environment.comfyVersion', 80),
    nodeInventorySha256: value.nodeInventorySha256,
  }
}

function validateThresholds(value) {
  const keys = [
    'minimumPerWorkflow', 'minimumPerCategory', 'outsideMaskMaeP95Max',
    'instructionP50Min', 'identityP50Min', 'compositionP50Min',
    'artifactFreedomP50Min', 'acceptanceRateMin', 'repairP50MaxSeconds',
  ]
  exactKeys(value, keys, keys, 'thresholds')
  return {
    minimumPerWorkflow: integer(value.minimumPerWorkflow, 'thresholds.minimumPerWorkflow', 1, 100),
    minimumPerCategory: integer(value.minimumPerCategory, 'thresholds.minimumPerCategory', 1, 100),
    outsideMaskMaeP95Max: number(value.outsideMaskMaeP95Max, 'thresholds.outsideMaskMaeP95Max', 0, 1),
    instructionP50Min: number(value.instructionP50Min, 'thresholds.instructionP50Min', 1, 5),
    identityP50Min: number(value.identityP50Min, 'thresholds.identityP50Min', 1, 5),
    compositionP50Min: number(value.compositionP50Min, 'thresholds.compositionP50Min', 1, 5),
    artifactFreedomP50Min: number(value.artifactFreedomP50Min, 'thresholds.artifactFreedomP50Min', 1, 5),
    acceptanceRateMin: number(value.acceptanceRateMin, 'thresholds.acceptanceRateMin', 0, 1),
    repairP50MaxSeconds: number(value.repairP50MaxSeconds, 'thresholds.repairP50MaxSeconds', 0, 86_400),
  }
}

function validateReview(value, label, portrait) {
  const keys = [
    'instructionAdherence', 'identityPreservation', 'compositionPreservation',
    'artifactFreedom', 'accepted', 'repairSeconds', 'notes',
  ]
  exactKeys(value, keys, keys.slice(0, 6), label)
  if (typeof value.accepted !== 'boolean') fail(`${label}.accepted must be boolean`)
  if (!Array.isArray(value.repairSeconds) || !value.repairSeconds.length || value.repairSeconds.length > 20) {
    fail(`${label}.repairSeconds must contain 1-20 observations`)
  }
  const identityPreservation = value.identityPreservation === null
    ? null
    : integer(value.identityPreservation, `${label}.identityPreservation`, 1, 5)
  if (portrait && identityPreservation === null) fail(`${label}.identityPreservation is required for portrait-adjust`)
  return {
    instructionAdherence: integer(value.instructionAdherence, `${label}.instructionAdherence`, 1, 5),
    identityPreservation,
    compositionPreservation: integer(value.compositionPreservation, `${label}.compositionPreservation`, 1, 5),
    artifactFreedom: integer(value.artifactFreedom, `${label}.artifactFreedom`, 1, 5),
    accepted: value.accepted,
    repairSeconds: value.repairSeconds.map((seconds, index) => number(
      seconds,
      `${label}.repairSeconds[${index}]`,
      0,
      86_400,
    )),
    ...(value.notes === undefined ? {} : { notes: boundedString(value.notes, `${label}.notes`, 500) }),
  }
}

function validateSample(value, index, candidateIds) {
  const label = `samples[${index}]`
  const allowed = [
    'id', 'candidateId', 'workflowId', 'category', 'width', 'height', 'source', 'output',
    'mask', 'instructionSha256', 'seed', 'latencyMs', 'peakVramMiB', 'review',
  ]
  exactKeys(
    value,
    allowed,
    allowed.filter((key) => key !== 'mask'),
    label,
  )
  const workflowId = value.workflowId
  if (!SEMANTIC_IMAGE_QUALITY_WORKFLOWS.includes(workflowId)) fail(`${label}.workflowId is unsupported`)
  if (!IMAGE_QUALITY_CATEGORIES.includes(value.category)) fail(`${label}.category is unsupported`)
  const candidateId = identifier(value.candidateId, `${label}.candidateId`)
  if (!candidateIds.has(candidateId)) fail(`${label}.candidateId is not declared`)
  if (typeof value.instructionSha256 !== 'string' || !SHA256.test(value.instructionSha256)) {
    fail(`${label}.instructionSha256 must be a lowercase SHA-256 digest`)
  }
  const masked = workflowId === 'region-edit' || workflowId === 'point-edit'
  if (masked !== Boolean(value.mask)) fail(`${label}.mask is ${masked ? 'required' : 'forbidden'} for ${workflowId}`)
  const width = integer(value.width, `${label}.width`, 1, 8_192)
  const height = integer(value.height, `${label}.height`, 1, 8_192)
  if (width * height > MAX_PIXELS) fail(`${label} exceeds ${MAX_PIXELS} pixels`)
  return {
    id: identifier(value.id, `${label}.id`),
    candidateId,
    workflowId,
    category: value.category,
    width,
    height,
    source: fileDescriptor(value.source, `${label}.source`),
    output: fileDescriptor(value.output, `${label}.output`),
    ...(masked ? { mask: fileDescriptor(value.mask, `${label}.mask`) } : {}),
    instructionSha256: value.instructionSha256,
    seed: integer(value.seed, `${label}.seed`, 0, Number.MAX_SAFE_INTEGER),
    latencyMs: number(value.latencyMs, `${label}.latencyMs`, 0, 7_200_000),
    peakVramMiB: number(value.peakVramMiB, `${label}.peakVramMiB`, 0, 262_144),
    review: validateReview(value.review, `${label}.review`, workflowId === 'portrait-adjust'),
  }
}

export function validateSemanticImageQualityManifest(value) {
  const keys = [
    'schemaVersion', 'datasetId', 'description', 'datasetRights', 'environment',
    'thresholds', 'candidates', 'samples',
  ]
  exactKeys(value, keys, keys, 'manifest')
  if (value.schemaVersion !== 1) fail('manifest.schemaVersion must equal 1')
  if (!Array.isArray(value.candidates) || !value.candidates.length || value.candidates.length > MAX_CANDIDATES) {
    fail(`manifest.candidates must contain 1-${MAX_CANDIDATES} candidates`)
  }
  const candidates = value.candidates.map(validateCandidate)
  const candidateIds = new Set(candidates.map((candidate) => candidate.id))
  if (candidateIds.size !== candidates.length) fail('manifest.candidates contains duplicate ids')
  if (!Array.isArray(value.samples) || !value.samples.length || value.samples.length > MAX_SAMPLES) {
    fail(`manifest.samples must contain 1-${MAX_SAMPLES} samples`)
  }
  const samples = value.samples.map((sample, index) => validateSample(sample, index, candidateIds))
  if (new Set(samples.map((sample) => sample.id)).size !== samples.length) fail('manifest.samples contains duplicate ids')
  return {
    schemaVersion: 1,
    datasetId: identifier(value.datasetId, 'manifest.datasetId'),
    description: boundedString(value.description, 'manifest.description'),
    datasetRights: boundedString(value.datasetRights, 'manifest.datasetRights', 500),
    environment: validateEnvironment(value.environment),
    thresholds: validateThresholds(value.thresholds),
    candidates,
    samples,
  }
}

function assertPixels(value, expected, label, channels) {
  if (!(value instanceof Uint8Array) && !(value instanceof Uint8ClampedArray)) {
    throw new TypeError(`${label} must be an 8-bit typed array`)
  }
  if (value.length !== expected * channels) throw new RangeError(`${label} dimensions do not match`)
}

export function evaluateSemanticImageEdit({
  source,
  output,
  mask,
  width,
  height,
  maskThreshold = 128,
  changeThreshold = 4,
}) {
  const pixels = width * height
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || pixels > MAX_PIXELS) {
    throw new RangeError('semantic image dimensions are invalid')
  }
  assertPixels(source, pixels, 'source', 4)
  assertPixels(output, pixels, 'output', 4)
  if (mask !== undefined) assertPixels(mask, pixels, 'mask', 1)
  integer(maskThreshold, 'maskThreshold', 1, 254)
  integer(changeThreshold, 'changeThreshold', 1, 255)

  let globalDifference = 0
  let globalChanged = 0
  let insideDifference = 0
  let insideChanged = 0
  let insideCount = 0
  let outsideDifference = 0
  let outsideChanged = 0
  let outsideCount = 0
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    let difference = 0
    let maximum = 0
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs(output[pixel * 4 + channel] - source[pixel * 4 + channel])
      difference += delta
      maximum = Math.max(maximum, delta)
    }
    globalDifference += difference
    if (maximum >= changeThreshold) globalChanged += 1
    if (mask === undefined || mask[pixel] >= maskThreshold) {
      insideDifference += difference
      insideCount += 1
      if (maximum >= changeThreshold) insideChanged += 1
    } else {
      outsideDifference += difference
      outsideCount += 1
      if (maximum >= changeThreshold) outsideChanged += 1
    }
  }
  return {
    globalMae: globalDifference / (pixels * 4 * 255),
    globalChangeRatio: globalChanged / pixels,
    insideMaskMae: insideCount ? insideDifference / (insideCount * 4 * 255) : 0,
    insideChangeRatio: insideCount ? insideChanged / insideCount : 0,
    outsideMaskMae: mask === undefined || !outsideCount
      ? null
      : outsideDifference / (outsideCount * 4 * 255),
    outsideChangeRatio: mask === undefined || !outsideCount ? null : outsideChanged / outsideCount,
  }
}

function metricSummary(rows, key) {
  return summarizeDistribution(rows.map((row) => row[key]).filter((value) => value !== null))
}

export function assessSemanticImageQuality(manifestValue, evaluatedRows = []) {
  const manifest = validateSemanticImageQualityManifest(manifestValue)
  const rowById = new Map(evaluatedRows.map((row) => [row.sampleId, row]))
  const categories = Object.fromEntries(IMAGE_QUALITY_CATEGORIES.map((category) => [
    category,
    manifest.samples.filter((sample) => sample.category === category).length,
  ]))
  const candidates = Object.fromEntries(manifest.candidates.map((candidate) => {
    const samples = manifest.samples.filter((sample) => sample.candidateId === candidate.id)
    const rows = samples.map((sample) => rowById.get(sample.id)).filter(Boolean)
    const workflows = Object.fromEntries(SEMANTIC_IMAGE_QUALITY_WORKFLOWS.map((workflowId) => [
      workflowId,
      samples.filter((sample) => sample.workflowId === workflowId).length,
    ]))
    const instruction = summarizeDistribution(samples.map((sample) => sample.review.instructionAdherence))
    const identity = summarizeDistribution(samples
      .map((sample) => sample.review.identityPreservation)
      .filter((value) => value !== null))
    const composition = summarizeDistribution(samples.map((sample) => sample.review.compositionPreservation))
    const artifactFreedom = summarizeDistribution(samples.map((sample) => sample.review.artifactFreedom))
    const repair = summarizeDistribution(samples.flatMap((sample) => sample.review.repairSeconds))
    const acceptanceRate = samples.length
      ? samples.filter((sample) => sample.review.accepted).length / samples.length
      : 0
    const outsideMaskMae = metricSummary(rows, 'outsideMaskMae')
    const coverageReady = SEMANTIC_IMAGE_QUALITY_WORKFLOWS.every(
      (workflowId) => workflows[workflowId] >= manifest.thresholds.minimumPerWorkflow,
    )
    const maskedSampleCount = samples.filter((sample) => sample.mask).length
    const metricsReady = rows.length === samples.length
      && outsideMaskMae.count === maskedSampleCount
      && identity.count > 0
    const thresholdsReady = metricsReady
      && instruction.p50 >= manifest.thresholds.instructionP50Min
      && identity.p50 >= manifest.thresholds.identityP50Min
      && composition.p50 >= manifest.thresholds.compositionP50Min
      && artifactFreedom.p50 >= manifest.thresholds.artifactFreedomP50Min
      && acceptanceRate >= manifest.thresholds.acceptanceRateMin
      && repair.p50 <= manifest.thresholds.repairP50MaxSeconds
      && outsideMaskMae.p95 !== null
      && outsideMaskMae.p95 <= manifest.thresholds.outsideMaskMaeP95Max
    return [candidate.id, {
      sampleCount: samples.length,
      workflows,
      coverageReady,
      metricsReady,
      thresholdsReady,
      acceptanceRate: Number(acceptanceRate.toFixed(6)),
      instruction,
      identity,
      composition,
      artifactFreedom,
      repairSeconds: repair,
      outsideMaskMae,
      latencyMs: summarizeDistribution(samples.map((sample) => sample.latencyMs)),
      peakVramMiB: summarizeDistribution(samples.map((sample) => sample.peakVramMiB)),
    }]
  }))
  const datasetReady = IMAGE_QUALITY_CATEGORIES.every(
    (category) => categories[category] >= manifest.thresholds.minimumPerCategory,
  )
  return {
    categories,
    datasetReady,
    candidates,
    gateReady: datasetReady && Object.values(candidates).every((candidate) => (
      candidate.coverageReady && candidate.thresholdsReady
    )),
  }
}
