import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assessSemanticImageQuality,
  evaluateSemanticImageEdit,
  validateSemanticImageQualityManifest,
} from '../server/semantic-image-quality.mjs'

const digest = 'a'.repeat(64)

function candidate() {
  return {
    id: 'qwen-contract',
    label: 'Qwen contract fixture',
    workflowVersion: 'qwen-image-edit-2511-int8-v1',
    artifacts: { diffusion: digest, textEncoder: digest, vae: digest },
    license: {
      code: 'Apache-2.0',
      model: 'Apache-2.0',
      redistribution: 'reviewed',
      commercial: 'reviewed',
      sources: ['https://example.invalid/model'],
      reviewedAt: '2026-09-03',
    },
  }
}

function sample(id, workflowId, category = 'product') {
  return {
    id,
    candidateId: 'qwen-contract',
    workflowId,
    category,
    width: 2,
    height: 2,
    source: { path: 'fixtures/source.ppm', sha256: digest },
    output: { path: 'fixtures/output.ppm', sha256: digest },
    ...(workflowId === 'portrait-adjust' ? {} : {
      mask: { path: 'fixtures/mask.pgm', sha256: digest },
    }),
    instructionSha256: digest,
    seed: 0,
    latencyMs: 100,
    peakVramMiB: 7000,
    review: {
      instructionAdherence: 5,
      identityPreservation: workflowId === 'portrait-adjust' ? 5 : null,
      compositionPreservation: 5,
      artifactFreedom: 5,
      accepted: true,
      repairSeconds: [0],
    },
  }
}

function manifest(samples) {
  return {
    schemaVersion: 1,
    datasetId: 'semantic-contract-v1',
    description: 'Synthetic contract fixture; not quality evidence.',
    datasetRights: 'Synthetic values authored for protocol testing only.',
    environment: {
      gpu: 'Synthetic GPU',
      vramMiB: 8192,
      systemRamMiB: 32768,
      os: 'test',
      runtimePackageId: 'test-runtime',
      comfyVersion: '0.3.70',
      nodeInventorySha256: digest,
    },
    thresholds: {
      minimumPerWorkflow: 1,
      minimumPerCategory: 1,
      outsideMaskMaeP95Max: 0,
      instructionP50Min: 4,
      identityP50Min: 4,
      compositionP50Min: 4,
      artifactFreedomP50Min: 4,
      acceptanceRateMin: 0.8,
      repairP50MaxSeconds: 60,
    },
    candidates: [candidate()],
    samples,
  }
}

test('semantic edit metrics separate masked change from outside-mask drift', () => {
  const source = Uint8ClampedArray.from([
    0, 0, 0, 255, 0, 0, 0, 255,
    0, 0, 0, 255, 0, 0, 0, 255,
  ])
  const output = source.slice()
  output.set([255, 0, 0, 255], 4)
  const mask = Uint8Array.from([0, 255, 0, 0])
  const clean = evaluateSemanticImageEdit({ source, output, mask, width: 2, height: 2 })
  assert.equal(clean.insideChangeRatio, 1)
  assert.equal(clean.outsideMaskMae, 0)
  assert.equal(clean.outsideChangeRatio, 0)

  output[0] = 16
  const leaked = evaluateSemanticImageEdit({ source, output, mask, width: 2, height: 2 })
  assert.ok(leaked.outsideMaskMae > 0)
  assert.equal(leaked.outsideChangeRatio, 1 / 3)
})

test('semantic quality manifest fails closed on paths, hashes, mask roles and hidden fields', () => {
  const valid = manifest([
    sample('region-001', 'region-edit'),
    sample('point-001', 'point-edit', 'illustration'),
    sample('portrait-001', 'portrait-adjust', 'portrait'),
  ])
  assert.equal(validateSemanticImageQualityManifest(valid).samples.length, 3)
  assert.throws(
    () => validateSemanticImageQualityManifest({ ...valid, hidden: true }),
    /unsupported fields/,
  )
  assert.throws(
    () => validateSemanticImageQualityManifest({
      ...valid,
      samples: [{ ...valid.samples[0], source: { path: '../source.png', sha256: digest } }],
    }),
    /contained portable/,
  )
  assert.throws(
    () => validateSemanticImageQualityManifest({
      ...valid,
      samples: [{ ...valid.samples[2], mask: { path: 'mask.png', sha256: digest } }],
    }),
    /forbidden/,
  )
})

test('coverage gate requires all workflows, all categories, decoded metrics and human thresholds', () => {
  const samples = [
    sample('region-001', 'region-edit', 'product'),
    sample('point-001', 'point-edit', 'illustration'),
    sample('portrait-001', 'portrait-adjust', 'portrait'),
    sample('region-hair-001', 'region-edit', 'hair-translucent'),
  ]
  const rows = samples.map((item) => ({
    sampleId: item.id,
    outsideMaskMae: item.workflowId === 'portrait-adjust' ? null : 0,
  }))
  const result = assessSemanticImageQuality(manifest(samples), rows)
  assert.equal(result.datasetReady, true)
  assert.equal(result.candidates['qwen-contract'].coverageReady, true)
  assert.equal(result.candidates['qwen-contract'].thresholdsReady, true)
  assert.equal(result.gateReady, true)

  const missingMetrics = assessSemanticImageQuality(manifest(samples), rows.slice(1))
  assert.equal(missingMetrics.gateReady, false)
})
