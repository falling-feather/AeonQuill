import assert from 'node:assert/strict'
import test from 'node:test'

import {
  GenerationAdapterError,
  GenerationAdapterService,
  normalizeGenerationEndpointForTest,
} from '../server/generation-adapter.mjs'

const pixelPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAFAgIACQFe3gAAAABJRU5ErkJggg==', 'base64')
const tinyMp3 = Buffer.concat([Buffer.from('ID3', 'ascii'), Buffer.alloc(32, 1)])
const tinyMp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom', 'ascii'), Buffer.alloc(32, 2)])

function configure(service, capability, patch = {}) {
  return service.configure(capability, {
    providerLabel: 'Fixture Provider',
    endpoint: 'http://127.0.0.1:45678/v1',
    model: `fixture-${capability}`,
    apiKey: 'fixture-secret-key',
    maxCostUsd: 10,
    costRateUsd: capability === 'video' ? 0.2 : 0.1,
    timeoutMs: capability === 'video' ? 5_000 : 10_000,
    ...(capability === 'video' ? { pollIntervalMs: 250 } : {}),
    ...patch,
  })
}

test('generation adapter configurations are capability-scoped, memory-only, and secret-free', () => {
  const service = new GenerationAdapterService({ fetchImpl: async () => { throw new Error('unused') } })
  assert.deepEqual(Object.values(service.status()).map(({ configured }) => configured), [false, false, false])
  const status = configure(service, 'image')
  assert.equal(status.image.configured, true)
  assert.equal(status.image.persistence, 'memory-only')
  assert.equal(JSON.stringify(status).includes('fixture-secret-key'), false)
  assert.equal(status.video.configured, false)
  assert.equal(service.clear('image').image.configured, false)
  assert.throws(
    () => service.configure('video', {
      providerLabel: 'unsafe', endpoint: 'http://192.168.1.3/v1', model: 'x', apiKey: '12345678',
    }),
    (error) => error instanceof GenerationAdapterError && error.code === 'GENERATION_ADAPTER_ENDPOINT_UNSAFE',
  )
  assert.equal(normalizeGenerationEndpointForTest('https://provider.example/v1/').href, 'https://provider.example/v1')
})

test('image adapter enforces a preflight budget and validates actual image bytes', async () => {
  let calls = 0
  const service = new GenerationAdapterService({
    fetchImpl: async (url, options) => {
      calls += 1
      assert.match(String(url), /\/v1\/images\/generations$/u)
      assert.equal(options.redirect, 'error')
      assert.equal(JSON.parse(options.body).response_format, 'b64_json')
      return new Response(JSON.stringify({
        id: 'image-request-1',
        data: [{ b64_json: pixelPng.toString('base64'), mime_type: 'image/png' }],
        usage: { cost_usd: 0.08 },
      }), { headers: { 'content-type': 'application/json' } })
    },
  })
  configure(service, 'image', { costRateUsd: 0.1, maxCostUsd: 0.2 })
  const result = await service.generateImage({
    prompt: '水墨风格产品主视觉', size: '1024x1024', quality: 'high', budgetUsd: 0.1,
  })
  assert.equal(result.mimeType, 'image/png')
  assert.deepEqual(result.bytes, pixelPng)
  assert.equal(result.usage.estimatedCostUsd, 0.1)
  assert.equal(result.usage.actualCostUsd, 0.08)
  assert.equal(result.remoteRequestId, 'image-request-1')
  await assert.rejects(
    service.generateImage({ prompt: '超预算', budgetUsd: 0.09 }),
    (error) => error.code === 'GENERATION_ADAPTER_COST_LIMIT',
  )
  assert.equal(calls, 1, 'over-budget requests must fail before contacting the provider')
})

test('speech adapter accepts bounded MP3 output and rejects a mismatched MIME declaration', async () => {
  let invalid = false
  const service = new GenerationAdapterService({
    fetchImpl: async () => new Response(tinyMp3, {
      headers: {
        'content-type': invalid ? 'audio/wav' : 'audio/mpeg',
        'x-usage-cost-usd': '0.0042',
      },
    }),
  })
  configure(service, 'speech', { costRateUsd: 0.02 })
  const result = await service.synthesizeSpeech({
    text: '以光为墨，以时为卷。', voice: 'alloy', format: 'mp3', speed: 1, budgetUsd: 1,
  })
  assert.equal(result.mimeType, 'audio/mpeg')
  assert.equal(result.usage.actualCostUsd, 0.0042)
  invalid = true
  await assert.rejects(
    service.synthesizeSpeech({ text: '类型复检', voice: 'alloy', format: 'mp3', speed: 1, budgetUsd: 1 }),
    (error) => error.code === 'GENERATION_ADAPTER_MIME_MISMATCH',
  )
})

test('video adapter submits, polls, reports progress, and downloads a bounded MP4', async () => {
  let polls = 0
  let authorization = ''
  const service = new GenerationAdapterService({
    fetchImpl: async (url, options) => {
      authorization = options.headers.authorization
      const pathname = new URL(url).pathname
      if (pathname === '/v1/videos' && options.method === 'POST') {
        const body = JSON.parse(options.body)
        assert.equal(body.size, '1280x720')
        assert.equal(body.seconds, 5)
        return new Response(JSON.stringify({ id: 'remote-video-1', status: 'queued' }), { headers: { 'content-type': 'application/json' } })
      }
      if (pathname === '/v1/videos/remote-video-1' && options.method === 'GET') {
        polls += 1
        return new Response(JSON.stringify(polls === 1
          ? { id: 'remote-video-1', status: 'in_progress', progress: 54 }
          : { id: 'remote-video-1', status: 'completed', progress: 100, usage: { cost_usd: 0.9 } }), {
          headers: { 'content-type': 'application/json' },
        })
      }
      if (pathname === '/v1/videos/remote-video-1/content') {
        return new Response(tinyMp4, { headers: { 'content-type': 'video/mp4' } })
      }
      throw new Error(`unexpected fixture path: ${pathname}`)
    },
  })
  configure(service, 'video', { costRateUsd: 0.2, maxCostUsd: 2 })
  const progress = []
  const result = await service.generateVideo({
    prompt: '光阴砚品牌广告', size: '1280x720', durationSeconds: 5, budgetUsd: 1,
  }, { onProgress: (event) => progress.push(event) })
  assert.equal(authorization, 'Bearer fixture-secret-key')
  assert.equal(polls, 2)
  assert.equal(result.mimeType, 'video/mp4')
  assert.deepEqual(result.bytes, tinyMp4)
  assert.equal(result.usage.estimatedCostUsd, 1)
  assert.equal(result.usage.actualCostUsd, 0.9)
  assert.ok(progress.some(({ progress: value }) => value === 54))
  assert.equal(progress.at(-1).progress, 100)
})

test('provider output URLs require an explicitly allowed origin and redirects stay disabled', async () => {
  const service = new GenerationAdapterService({
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/output.png' }] }), {
      headers: { 'content-type': 'application/json' },
    }),
  })
  configure(service, 'image')
  await assert.rejects(
    service.generateImage({ prompt: 'blocked CDN', budgetUsd: 1 }),
    (error) => error.code === 'GENERATION_ADAPTER_OUTPUT_ORIGIN_BLOCKED',
  )
})
