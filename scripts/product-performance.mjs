export const PRODUCT_PERFORMANCE_VERSION = 'aeonquill-product-performance-v1'
export const PRODUCT_PERFORMANCE_THRESHOLDS_VERSION = 'aeonquill-product-performance-thresholds-v1'
export const PRODUCT_PERFORMANCE_SMOKE_LATENCY_MULTIPLIER = 1.5

const MODE_IDS = ['balanced', 'pixel', 'smart-video']
const LIMIT_KEYS = [
  'homeColdP95Ms',
  'homeWarmP95Ms',
  'modeFirstP95Ms',
  'modeCachedP95Ms',
  'heapGrowthBytes',
  'heapSlopeBytesPerMinute',
  'domNodeGrowth',
  'domNodeSlopePerMinute',
  'documentGrowth',
  'eventListenerGrowth',
  'finalModeHosts',
  'finalMediaElements',
]

function finiteNumber(value, label, minimum = 0) {
  if (!Number.isFinite(value) || value < minimum) throw new Error(`${label} must be a finite number >= ${minimum}`)
  return value
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} fields do not match the supported schema`)
  }
}

export function percentile(values, ratio) {
  if (!Array.isArray(values) || values.length === 0) throw new Error('percentile requires at least one sample')
  finiteNumber(ratio, 'percentile ratio')
  if (ratio > 1) throw new Error('percentile ratio must be <= 1')
  const sorted = values.map((value, index) => finiteNumber(value, `sample[${index}]`)).sort((left, right) => left - right)
  if (sorted.length === 1) return sorted[0]
  const position = (sorted.length - 1) * ratio
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  const weight = position - lower
  return sorted[lower] * (1 - weight) + sorted[upper] * weight
}

export function summarizeSamples(values) {
  const normalized = values.map((value, index) => finiteNumber(value, `sample[${index}]`))
  if (!normalized.length) throw new Error('sample summary requires at least one value')
  return {
    count: normalized.length,
    samples: normalized.map((value) => Number(value.toFixed(2))),
    min: Number(Math.min(...normalized).toFixed(2)),
    p50: Number(percentile(normalized, 0.5).toFixed(2)),
    p95: Number(percentile(normalized, 0.95).toFixed(2)),
    max: Number(Math.max(...normalized).toFixed(2)),
  }
}

export function linearSlopePerMinute(samples, field) {
  if (!Array.isArray(samples) || samples.length < 2) return 0
  const points = samples.map((sample, index) => ({
    x: finiteNumber(sample.elapsedMs, `samples[${index}].elapsedMs`) / 60_000,
    y: finiteNumber(sample[field], `samples[${index}].${field}`),
  }))
  const xMean = points.reduce((sum, point) => sum + point.x, 0) / points.length
  const yMean = points.reduce((sum, point) => sum + point.y, 0) / points.length
  const denominator = points.reduce((sum, point) => sum + (point.x - xMean) ** 2, 0)
  if (denominator === 0) return 0
  const numerator = points.reduce((sum, point) => sum + (point.x - xMean) * (point.y - yMean), 0)
  return Number((numerator / denominator).toFixed(2))
}

export function validatePerformanceThresholds(value) {
  exactKeys(value, ['schemaVersion', 'environment', 'limits'], 'thresholds')
  if (value.schemaVersion !== PRODUCT_PERFORMANCE_THRESHOLDS_VERSION) throw new Error('Unsupported performance threshold schema')
  exactKeys(value.environment, ['viewport', 'coldSamples', 'warmSamples', 'modeSamples', 'formalSoakMinutes', 'smokeSoakSeconds', 'modeDwellMs', 'homeDwellMs'], 'thresholds.environment')
  exactKeys(value.environment.viewport, ['width', 'height'], 'thresholds.environment.viewport')
  finiteNumber(value.environment.viewport.width, 'viewport width', 320)
  finiteNumber(value.environment.viewport.height, 'viewport height', 480)
  finiteNumber(value.environment.coldSamples, 'coldSamples', 3)
  finiteNumber(value.environment.warmSamples, 'warmSamples', 3)
  finiteNumber(value.environment.modeSamples, 'modeSamples', 3)
  finiteNumber(value.environment.formalSoakMinutes, 'formalSoakMinutes', 30)
  finiteNumber(value.environment.smokeSoakSeconds, 'smokeSoakSeconds', 15)
  finiteNumber(value.environment.modeDwellMs, 'modeDwellMs', 250)
  finiteNumber(value.environment.homeDwellMs, 'homeDwellMs', 100)
  exactKeys(value.limits, LIMIT_KEYS, 'thresholds.limits')
  for (const key of LIMIT_KEYS) finiteNumber(value.limits[key], `thresholds.limits.${key}`)
  return value
}

function check(id, actual, limit, unit) {
  return { id, status: actual <= limit ? 'passed' : 'failed', actual, limit, unit }
}

export function assessProductPerformance(report, thresholds, { requireFormalSoak = false, latencyMultiplier = 1 } = {}) {
  validatePerformanceThresholds(thresholds)
  finiteNumber(latencyMultiplier, 'latencyMultiplier', 1)
  if (latencyMultiplier > 2) throw new Error('latencyMultiplier must be <= 2')
  if (!report || report.schemaVersion !== PRODUCT_PERFORMANCE_VERSION) throw new Error('Unsupported product performance report')
  for (const section of [report.home?.cold, report.home?.warm]) {
    if (!section || !Number.isFinite(section.p95) || section.count < 1) throw new Error('Performance report is missing home samples')
  }
  for (const modeId of MODE_IDS) {
    const mode = report.modes?.[modeId]
    if (!mode?.first || !mode?.cached || !Number.isFinite(mode.first.p95) || !Number.isFinite(mode.cached.p95)) {
      throw new Error(`Performance report is missing ${modeId} samples`)
    }
  }
  if (!report.soak || !Array.isArray(report.soak.samples) || report.soak.samples.length < 2) {
    throw new Error('Performance report is missing soak samples')
  }
  if (requireFormalSoak && report.soak.durationMs < thresholds.environment.formalSoakMinutes * 60_000) {
    throw new Error('Formal performance assessment requires the configured soak duration')
  }

  const limits = thresholds.limits
  const checks = [
    check('home-cold-p95', report.home.cold.p95, limits.homeColdP95Ms * latencyMultiplier, 'ms'),
    check('home-warm-p95', report.home.warm.p95, limits.homeWarmP95Ms * latencyMultiplier, 'ms'),
  ]
  for (const modeId of MODE_IDS) {
    checks.push(check(`${modeId}-first-p95`, report.modes[modeId].first.p95, limits.modeFirstP95Ms * latencyMultiplier, 'ms'))
    checks.push(check(`${modeId}-cached-p95`, report.modes[modeId].cached.p95, limits.modeCachedP95Ms * latencyMultiplier, 'ms'))
  }
  checks.push(
    check('soak-heap-growth', report.soak.growth.jsHeapUsedBytes, limits.heapGrowthBytes, 'bytes'),
    check('soak-dom-growth', report.soak.growth.domNodes, limits.domNodeGrowth, 'nodes'),
    check('soak-document-growth', report.soak.growth.documents, limits.documentGrowth, 'documents'),
    check('soak-listener-growth', report.soak.growth.eventListeners, limits.eventListenerGrowth, 'listeners'),
    check('released-mode-hosts', report.soak.release.modeHosts, limits.finalModeHosts, 'elements'),
    check('released-media-elements', report.soak.release.mediaElements, limits.finalMediaElements, 'elements'),
  )
  if (requireFormalSoak) {
    checks.push(
      check('soak-heap-slope', Math.max(0, report.soak.slopes.jsHeapUsedBytesPerMinute), limits.heapSlopeBytesPerMinute, 'bytes/minute'),
      check('soak-dom-slope', Math.max(0, report.soak.slopes.domNodesPerMinute), limits.domNodeSlopePerMinute, 'nodes/minute'),
    )
  }
  return { status: checks.every((item) => item.status === 'passed') ? 'passed' : 'failed', checks }
}

export function finalizeSoak(samples, release, durationMs, cycles) {
  if (!Array.isArray(samples) || samples.length < 2) throw new Error('Soak result requires at least two samples')
  const first = samples[0]
  const last = samples.at(-1)
  const growth = {
    jsHeapUsedBytes: Math.max(0, last.jsHeapUsedBytes - first.jsHeapUsedBytes),
    domNodes: Math.max(0, last.domNodes - first.domNodes),
    documents: Math.max(0, last.documents - first.documents),
    eventListeners: Math.max(0, last.eventListeners - first.eventListeners),
  }
  return {
    durationMs,
    cycles,
    samples,
    growth,
    slopes: {
      jsHeapUsedBytesPerMinute: linearSlopePerMinute(samples, 'jsHeapUsedBytes'),
      domNodesPerMinute: linearSlopePerMinute(samples, 'domNodes'),
      documentsPerMinute: linearSlopePerMinute(samples, 'documents'),
      eventListenersPerMinute: linearSlopePerMinute(samples, 'eventListeners'),
    },
    release,
  }
}
