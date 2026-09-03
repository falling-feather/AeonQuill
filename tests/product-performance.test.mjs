import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assessProductPerformance,
  finalizeSoak,
  linearSlopePerMinute,
  percentile,
  PRODUCT_PERFORMANCE_SMOKE_LATENCY_MULTIPLIER,
  PRODUCT_PERFORMANCE_THRESHOLDS_VERSION,
  PRODUCT_PERFORMANCE_VERSION,
  summarizeSamples,
  validatePerformanceThresholds,
} from '../scripts/product-performance.mjs'

const thresholds = {
  schemaVersion: PRODUCT_PERFORMANCE_THRESHOLDS_VERSION,
  environment: {
    viewport: { width: 1440, height: 900 }, coldSamples: 7, warmSamples: 7, modeSamples: 7,
    formalSoakMinutes: 30, smokeSoakSeconds: 30, modeDwellMs: 750, homeDwellMs: 250,
  },
  limits: {
    homeColdP95Ms: 3000, homeWarmP95Ms: 1500, modeFirstP95Ms: 5000, modeCachedP95Ms: 2500,
    heapGrowthBytes: 1000, heapSlopeBytesPerMinute: 100, domNodeGrowth: 100, domNodeSlopePerMinute: 10,
    documentGrowth: 2, eventListenerGrowth: 50, finalModeHosts: 0, finalMediaElements: 0,
  },
}

function passingReport() {
  const summary = summarizeSamples([100, 110, 120, 130, 140, 150, 160])
  const samples = [
    { elapsedMs: 0, jsHeapUsedBytes: 1000, domNodes: 100, documents: 2, eventListeners: 20 },
    { elapsedMs: 30 * 60_000, jsHeapUsedBytes: 1500, domNodes: 130, documents: 2, eventListeners: 25 },
  ]
  return {
    schemaVersion: PRODUCT_PERFORMANCE_VERSION,
    home: { cold: summary, warm: summary },
    modes: {
      balanced: { first: summary, cached: summary },
      pixel: { first: summary, cached: summary },
      'smart-video': { first: summary, cached: summary },
    },
    soak: finalizeSoak(samples, { modeHosts: 0, mediaElements: 0 }, 30 * 60_000, 20),
  }
}

test('product performance statistics use deterministic interpolation and slopes', () => {
  assert.equal(percentile([40, 10, 30, 20], 0.5), 25)
  assert.equal(summarizeSamples([10, 20, 30, 40]).p95, 38.5)
  assert.equal(linearSlopePerMinute([
    { elapsedMs: 0, value: 10 },
    { elapsedMs: 60_000, value: 20 },
    { elapsedMs: 120_000, value: 30 },
  ], 'value'), 10)
})

test('threshold schema is exact and rejects unknown policy fields', () => {
  assert.equal(validatePerformanceThresholds(structuredClone(thresholds)).schemaVersion, PRODUCT_PERFORMANCE_THRESHOLDS_VERSION)
  const invalid = structuredClone(thresholds)
  invalid.limits.hiddenOverride = 1
  assert.throws(() => validatePerformanceThresholds(invalid), /fields do not match/u)
})

test('formal assessment enforces latency, retained resources and slopes', () => {
  const report = passingReport()
  assert.equal(assessProductPerformance(report, thresholds, { requireFormalSoak: true }).status, 'passed')
  report.soak.growth.jsHeapUsedBytes = 1001
  const failed = assessProductPerformance(report, thresholds, { requireFormalSoak: true })
  assert.equal(failed.status, 'failed')
  assert.equal(failed.checks.find((item) => item.id === 'soak-heap-growth')?.status, 'failed')
})

test('short smoke report cannot be represented as a formal soak', () => {
  const report = passingReport()
  report.soak.durationMs = 29 * 60_000
  assert.throws(
    () => assessProductPerformance(report, thresholds, { requireFormalSoak: true }),
    /requires the configured soak duration/u,
  )
})

test('smoke latency allowance absorbs machine jitter without weakening the formal gate', () => {
  const report = passingReport()
  report.home.warm.p95 = thresholds.limits.homeWarmP95Ms * 1.4
  assert.equal(assessProductPerformance(report, thresholds, {
    latencyMultiplier: PRODUCT_PERFORMANCE_SMOKE_LATENCY_MULTIPLIER,
  }).status, 'passed')
  const formal = assessProductPerformance(report, thresholds, { requireFormalSoak: true })
  assert.equal(formal.checks.find((item) => item.id === 'home-warm-p95')?.status, 'failed')
})
