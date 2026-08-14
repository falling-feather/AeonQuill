import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assessImageQualityCoverage,
  evaluateAlphaMask,
  quantile,
  summarizeDistribution,
  validateImageQualityManifest,
} from '../server/image-quality.mjs'

function mask(rows) {
  return Uint8Array.from(rows.flat())
}

function prediction(candidateId, overrides = {}) {
  return {
    candidateId,
    mask: `fixtures/${candidateId}.pgm`,
    latencyMs: 12,
    peakVramMiB: 0,
    repairSeconds: [0],
    ...overrides,
  }
}

function manifestFixture({ samples, candidates = [{ id: 'baseline', label: 'Baseline' }] }) {
  return {
    schemaVersion: 1,
    datasetId: 'quality-contract-v1',
    description: 'Synthetic contract fixture; not model-quality evidence.',
    evaluation: { threshold: 128, boundaryRadius: 1 },
    candidates,
    samples,
  }
}

test('a perfect alpha mask receives perfect overlap and zero error', () => {
  const groundTruth = mask([
    [0, 0, 0],
    [0, 255, 0],
    [0, 0, 0],
  ])
  const metrics = evaluateAlphaMask({
    prediction: groundTruth.slice(),
    groundTruth,
    width: 3,
    height: 3,
    boundaryRadius: 1,
  })
  assert.deepEqual(metrics, {
    alphaMae: 0,
    binaryIou: 1,
    precision: 1,
    recall: 1,
    f1: 1,
    boundaryPrecision: 1,
    boundaryRecall: 1,
    boundaryF1: 1,
    boundaryAlphaMae: 0,
    backgroundLeakage: 0,
    foregroundOpacityError: 0,
  })
})

test('binary overlap and solid-region leakage expose a shifted mask', () => {
  const groundTruth = mask([
    [0, 0, 0, 0, 0],
    [0, 255, 255, 255, 0],
    [0, 255, 255, 255, 0],
    [0, 255, 255, 255, 0],
    [0, 0, 0, 0, 0],
  ])
  const shifted = mask([
    [0, 0, 0, 0, 0],
    [0, 0, 255, 255, 255],
    [0, 0, 255, 255, 255],
    [0, 0, 255, 255, 255],
    [0, 0, 0, 0, 0],
  ])
  const metrics = evaluateAlphaMask({
    prediction: shifted,
    groundTruth,
    width: 5,
    height: 5,
    boundaryRadius: 0,
  })
  assert.equal(metrics.binaryIou, 0.5)
  assert.equal(metrics.precision, 2 / 3)
  assert.equal(metrics.recall, 2 / 3)
  assert.equal(metrics.f1, 2 / 3)
  assert.equal(metrics.alphaMae, 6 / 25)
  assert.equal(metrics.backgroundLeakage, 3 / 16)
  assert.equal(metrics.foregroundOpacityError, 1 / 3)
  assert.ok(metrics.boundaryF1 < 1)
})

test('boundary tolerance scores a one-pixel displacement separately from binary F1', () => {
  const groundTruth = mask([
    [0, 0, 0],
    [255, 0, 0],
    [0, 0, 0],
  ])
  const shifted = mask([
    [0, 0, 0],
    [0, 255, 0],
    [0, 0, 0],
  ])
  const metrics = evaluateAlphaMask({
    prediction: shifted,
    groundTruth,
    width: 3,
    height: 3,
    boundaryRadius: 1,
  })
  assert.equal(metrics.f1, 0)
  assert.equal(metrics.boundaryF1, 1)
})

test('empty masks are treated as a perfect empty prediction', () => {
  const empty = new Uint8Array(16)
  const metrics = evaluateAlphaMask({
    prediction: empty,
    groundTruth: empty,
    width: 4,
    height: 4,
  })
  assert.equal(metrics.binaryIou, 1)
  assert.equal(metrics.f1, 1)
  assert.equal(metrics.boundaryF1, 1)
})

test('quantiles use deterministic linear interpolation and distributions expose P50/P95', () => {
  assert.equal(quantile([0, 10, 20, 30], 0.5), 15)
  assert.equal(quantile([0, 10, 20, 30], 0.95), 28.499999999999996)
  assert.deepEqual(summarizeDistribution([0, 10, 20, 30]), {
    count: 4,
    min: 0,
    mean: 15,
    p50: 15,
    p95: 28.5,
    max: 30,
  })
  assert.deepEqual(summarizeDistribution([]), {
    count: 0,
    min: null,
    mean: null,
    p50: null,
    p95: null,
    max: null,
  })
})

test('manifest validation rejects traversal, hidden payloads, and duplicate predictions', () => {
  const baseSample = {
    id: 'product-001',
    category: 'product',
    width: 8,
    height: 8,
    groundTruthMask: 'fixtures/truth.pgm',
    predictions: [prediction('baseline')],
  }
  assert.equal(validateImageQualityManifest(manifestFixture({ samples: [baseSample] })).samples.length, 1)
  assert.throws(
    () => validateImageQualityManifest(manifestFixture({
      samples: [{ ...baseSample, groundTruthMask: '../outside.png' }],
    })),
    /portable relative path/,
  )
  assert.throws(
    () => validateImageQualityManifest(manifestFixture({
      samples: [{ ...baseSample, hiddenPrompt: 'secret' }],
    })),
    /unsupported keys/,
  )
  assert.throws(
    () => validateImageQualityManifest(manifestFixture({
      samples: [{
        ...baseSample,
        predictions: [prediction('baseline'), prediction('baseline')],
      }],
    })),
    /duplicate candidate/,
  )
})

test('coverage gate requires 20 samples in every category for every candidate and repair timing', () => {
  const candidates = [
    { id: 'baseline', label: 'Baseline' },
    { id: 'candidate', label: 'Candidate' },
  ]
  const incomplete = manifestFixture({
    candidates,
    samples: [{
      id: 'product-001',
      category: 'product',
      width: 8,
      height: 8,
      groundTruthMask: 'fixtures/truth.pgm',
      predictions: [prediction('baseline'), prediction('candidate', { repairSeconds: undefined })],
    }],
  })
  const incompleteCoverage = assessImageQualityCoverage(incomplete)
  assert.equal(incompleteCoverage.gateReady, false)
  assert.equal(incompleteCoverage.repair.complete, false)

  const samples = []
  for (const category of ['product', 'portrait', 'illustration', 'hair-translucent']) {
    for (let index = 0; index < 20; index += 1) {
      samples.push({
        id: `${category}-${String(index).padStart(3, '0')}`,
        category,
        width: 8,
        height: 8,
        groundTruthMask: 'fixtures/truth.pgm',
        predictions: [prediction('baseline'), prediction('candidate')],
      })
    }
  }
  const completeCoverage = assessImageQualityCoverage(manifestFixture({ candidates, samples }))
  assert.equal(completeCoverage.datasetComplete, true)
  assert.equal(completeCoverage.candidatesComplete, true)
  assert.equal(completeCoverage.repair.complete, true)
  assert.equal(completeCoverage.gateReady, true)
})
