import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AgentAdapterError,
  AgentAdapterService,
  normalizeAgentEndpointForTest,
} from '../server/agent-adapter.mjs'
import { createVideoProductionProject } from '../src/lib/story/productionPipeline.mjs'

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
