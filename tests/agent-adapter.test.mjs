import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  AgentAdapterError,
  AgentAdapterService,
  normalizeAgentEndpointForTest,
} from '../server/agent-adapter.mjs'
import { createVideoProductionProject } from '../src/lib/story/productionPipeline.mjs'

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
}

test('BYOK text configuration remains memory-only and never exposes the API key', () => {
  const service = new AgentAdapterService({ now: () => 1_000 })
  const status = service.configureText({
    providerLabel: '自有兼容接口',
    endpoint: 'https://api.example.com/v1',
    model: 'example-model',
    apiKey: 'sk-super-secret-value',
    jsonMode: 'json-object',
    timeoutMs: 30_000,
  })
  assert.deepEqual(status, {
    text: {
      configured: true,
      persistence: 'memory-only',
      providerLabel: '自有兼容接口',
      endpointLabel: 'https://api.example.com',
      model: 'example-model',
      jsonMode: 'json-object',
      timeoutMs: 30_000,
      configuredAt: 1_000,
    },
  })
  assert.equal(JSON.stringify(status).includes('super-secret'), false)
  assert.deepEqual(service.clearText(), { text: { configured: false, persistence: 'memory-only' } })
})

test('endpoint policy requires HTTPS remotely and only allows HTTP on loopback', () => {
  assert.equal(normalizeAgentEndpointForTest('https://api.example.com/v1').href, 'https://api.example.com/v1/chat/completions')
  assert.equal(normalizeAgentEndpointForTest('http://127.0.0.1:11434/v1').href, 'http://127.0.0.1:11434/v1/chat/completions')
  assert.throws(
    () => normalizeAgentEndpointForTest('http://api.example.com/v1'),
    (error) => error instanceof AgentAdapterError && error.code === 'AGENT_ADAPTER_ENDPOINT_UNSAFE',
  )
  assert.throws(
    () => normalizeAgentEndpointForTest('https://192.168.1.10/v1'),
    (error) => error instanceof AgentAdapterError && error.code === 'AGENT_ADAPTER_ENDPOINT_UNSAFE',
  )
})

test('OpenAI-compatible execution returns a strict proposal without mutating the production project', async () => {
  let observed
  const fetchImpl = async (url, options) => {
    observed = { url: String(url), authorization: options.headers.authorization, body: JSON.parse(options.body) }
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        title: '强化第一幕钩子',
        rationale: '把产品价值放进第一个视觉动作，避免额外角色。',
        proposedInstructions: '第一幕必须在 3 秒内建立光阴砚与时间意象。',
        proposedOutputSummary: '墨滴落砚，时间长卷展开；品牌能力通过动作而非口播展示。',
      }) } }],
      usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  let now = 2_000
  const service = new AgentAdapterService({ fetchImpl, now: () => now++ })
  service.configureText({ endpoint: 'https://api.example.com/v1', model: 'model-a', apiKey: 'key-12345678' })
  const project = createVideoProductionProject({ now: 1_000, durationMinutes: 1, genre: '品牌广告' })
  const before = JSON.stringify(project)
  const result = await service.propose({ project, nodeId: 'screenwriter' })
  assert.equal(result.proposal.source, 'byok-text')
  assert.equal(result.proposal.title, '强化第一幕钩子')
  assert.deepEqual(result.usage, { promptTokens: 120, completionTokens: 80, totalTokens: 200 })
  assert.equal(JSON.stringify(project), before)
  assert.equal(observed.url, 'https://api.example.com/v1/chat/completions')
  assert.equal(observed.authorization, 'Bearer key-12345678')
  assert.equal(observed.body.response_format.type, 'json_object')
  assert.equal(observed.body.messages[1].content.includes('key-12345678'), false)
  assert.equal(JSON.stringify(result).includes('key-12345678'), false)
})

test('malformed model proposals and blocked nodes fail closed', async () => {
  const service = new AgentAdapterService({
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        title: 'Unsafe',
        rationale: 'Contains an unknown execution field.',
        proposedInstructions: 'text',
        proposedOutputSummary: null,
        workflowJson: { arbitrary: true },
      }) } }],
    }), { status: 200 }),
  })
  service.configureText({ endpoint: 'https://api.example.com/v1', model: 'model-a', apiKey: 'key-12345678' })
  const project = createVideoProductionProject({ now: 1_000 })
  await assert.rejects(
    service.propose({ project, nodeId: 'screenwriter' }),
    (error) => error instanceof AgentAdapterError && error.code === 'AGENT_ADAPTER_UNKNOWN_FIELD',
  )
  await assert.rejects(
    service.propose({ project, nodeId: 'video-director' }),
    (error) => error instanceof AgentAdapterError && error.code === 'AGENT_ADAPTER_NODE_BLOCKED',
  )
})

test('cross-mode BYOK completion returns only a strict plan candidate and a reproducible redacted request hash', async () => {
  let observed
  const service = new AgentAdapterService({
    now: (() => { let now = 2_000; return () => now++ })(),
    fetchImpl: async (url, options) => {
      observed = { url: String(url), authorization: options.headers.authorization, body: JSON.parse(options.body) }
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          title: '调整像素调色板',
          objective: '让高光更清晰，同时不修改任何媒体资产。',
          steps: [{
            toolId: 'pixel.palette.replace',
            summary: '把 ember 调整为明亮橙红色',
            input: { colorId: 'ember', color: '#FF7048FF', name: 'Bright Ember' },
          }],
        }) } }],
        usage: { prompt_tokens: 90, completion_tokens: 40, total_tokens: 130 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  service.configureText({ endpoint: 'https://api.example.com/v1', model: 'model-plan', apiKey: 'key-12345678' })
  const result = await service.composeCreativePlan({
    modeId: 'pixel',
    instruction: '把 Ember 调亮',
    context: { document: { id: 'pixel-1', revision: 0, palette: [{ id: 'ember', color: '#E66B4DFF' }] } },
    toolGuide: ['pixel.palette.replace — only replace an existing color'],
  })

  assert.equal(result.candidate.steps[0].toolId, 'pixel.palette.replace')
  assert.deepEqual(result.usage, { promptTokens: 90, completionTokens: 40, totalTokens: 130 })
  assert.match(result.requestHash, /^[a-f0-9]{64}$/u)
  const expectedHash = createHash('sha256').update(JSON.stringify(canonicalize({
    model: 'model-plan',
    messages: observed.body.messages,
  }))).digest('hex')
  assert.equal(result.requestHash, expectedHash)
  assert.equal(observed.authorization, 'Bearer key-12345678')
  assert.equal(observed.body.messages[0].content.includes('pixel.palette.replace'), true)
  assert.equal(observed.body.messages[1].content.includes('把 Ember 调亮'), true)
  assert.equal(JSON.stringify(observed.body.messages).includes('key-12345678'), false)
  assert.equal(JSON.stringify(result).includes('key-12345678'), false)
})

test('cross-mode candidate schema, context complexity and response limits fail closed', async () => {
  let responsePayload = {
    choices: [{ message: { content: JSON.stringify({
      title: 'Unsafe', objective: 'Unknown field', steps: [{
        toolId: 'canvas.elements.patch', summary: 'bad', input: {}, workflowJson: {},
      }],
    }) } }],
  }
  const service = new AgentAdapterService({
    fetchImpl: async () => new Response(JSON.stringify(responsePayload), { status: 200 }),
  })
  service.configureText({ endpoint: 'https://api.example.com/v1', model: 'model-plan', apiKey: 'key-12345678' })
  const input = {
    modeId: 'balanced', instruction: '调整布局', context: { document: { id: 'canvas-1' } },
    toolGuide: ['canvas.elements.patch — safe fields only'],
  }
  await assert.rejects(
    service.composeCreativePlan(input),
    (error) => error instanceof AgentAdapterError && error.code === 'AGENT_ADAPTER_UNKNOWN_FIELD',
  )

  const excessiveContext = Object.fromEntries(Array.from({ length: 4_001 }, (_, index) => [`field${index}`, index]))
  await assert.rejects(
    service.composeCreativePlan({ ...input, context: excessiveContext }),
    (error) => error instanceof AgentAdapterError && error.code === 'AGENT_ADAPTER_CONTEXT_INVALID',
  )

  const oversized = new AgentAdapterService({
    fetchImpl: async () => new Response('{}', { status: 200, headers: { 'content-length': String(2 * 1024 * 1024 + 1) } }),
  })
  oversized.configureText({ endpoint: 'https://api.example.com/v1', model: 'model-plan', apiKey: 'key-12345678' })
  await assert.rejects(
    oversized.composeCreativePlan(input),
    (error) => error instanceof AgentAdapterError && error.code === 'AGENT_ADAPTER_RESPONSE_TOO_LARGE',
  )

  const timedOut = new AgentAdapterService({
    setTimeoutImpl: (callback) => { queueMicrotask(callback); return 1 },
    clearTimeoutImpl: () => undefined,
    fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
    }),
  })
  timedOut.configureText({ endpoint: 'https://api.example.com/v1', model: 'model-plan', apiKey: 'key-12345678', timeoutMs: 5_000 })
  await assert.rejects(
    timedOut.composeCreativePlan(input),
    (error) => error instanceof AgentAdapterError && error.code === 'AGENT_ADAPTER_TIMEOUT',
  )

  let reconfigured
  reconfigured = new AgentAdapterService({
    fetchImpl: async () => {
      reconfigured.clearText()
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          title: '过期结果', objective: '配置变化后不得采用', steps: [{
            toolId: 'canvas.elements.patch', summary: '调整布局', input: { updates: [] },
          }],
        }) } }],
      }), { status: 200 })
    },
  })
  reconfigured.configureText({ endpoint: 'https://api.example.com/v1', model: 'model-plan', apiKey: 'key-12345678' })
  await assert.rejects(
    reconfigured.composeCreativePlan(input),
    (error) => error instanceof AgentAdapterError && error.code === 'AGENT_ADAPTER_CONFIGURATION_CHANGED',
  )
})
