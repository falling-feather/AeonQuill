import { isIP } from 'node:net'

import { assertVideoProductionProject } from '../src/lib/story/productionPipeline.mjs'

const MAX_API_KEY_CHARACTERS = 2_048
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_MODEL_CHARACTERS = 160
const MAX_ENDPOINT_CHARACTERS = 2_048
const DEFAULT_TIMEOUT_MS = 60_000
const PRIVATE_V4 = [
  /^10\./u,
  /^127\./u,
  /^169\.254\./u,
  /^192\.168\./u,
  /^172\.(?:1[6-9]|2\d|3[01])\./u,
  /^0\./u,
]

export class AgentAdapterError extends Error {
  constructor(code, message, status = 400, details) {
    super(message)
    this.name = 'AgentAdapterError'
    this.code = code
    this.status = status
    if (details !== undefined) this.details = details
  }
}

function fail(code, message, status = 400, details) {
  throw new AgentAdapterError(code, message, status, details)
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function exactFields(value, allowed, label) {
  if (!isRecord(value)) fail('AGENT_ADAPTER_INVALID_REQUEST', `${label} 必须是对象`)
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length) fail('AGENT_ADAPTER_UNKNOWN_FIELD', `${label} 包含不支持的字段`, 400, { unknown })
  return value
}

function boundedString(value, label, min, max) {
  if (typeof value !== 'string') fail('AGENT_ADAPTER_INVALID_FIELD', `${label} 必须是字符串`)
  const normalized = value.trim()
  if (normalized.length < min || normalized.length > max) fail('AGENT_ADAPTER_INVALID_FIELD', `${label} 长度必须为 ${min}–${max}`)
  return normalized
}

function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, '')
  return normalized === 'localhost' || normalized === '::1' || normalized === '127.0.0.1'
}

function isPrivateLiteral(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, '')
  if (isLoopbackHostname(normalized)) return false
  const family = isIP(normalized)
  if (family === 4) return PRIVATE_V4.some((pattern) => pattern.test(normalized))
  if (family === 6) return normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb') || normalized === '::'
  return false
}

function normalizeEndpoint(value) {
  const raw = boundedString(value, 'endpoint', 8, MAX_ENDPOINT_CHARACTERS)
  let url
  try { url = new URL(raw) } catch { fail('AGENT_ADAPTER_ENDPOINT_INVALID', '接口地址不是有效 URL') }
  if (url.username || url.password || url.search || url.hash) fail('AGENT_ADAPTER_ENDPOINT_INVALID', '接口地址不得包含凭据、查询参数或片段')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))) {
    fail('AGENT_ADAPTER_ENDPOINT_UNSAFE', '远程接口必须使用 HTTPS；HTTP 仅允许本机回环地址')
  }
  if (isPrivateLiteral(url.hostname) || url.hostname.toLowerCase().endsWith('.local')) {
    fail('AGENT_ADAPTER_ENDPOINT_UNSAFE', '接口地址不得指向局域网或链路本地目标')
  }
  const trimmedPath = url.pathname.replace(/\/+$/gu, '')
  if (!trimmedPath || trimmedPath === '/') url.pathname = '/v1/chat/completions'
  else if (!trimmedPath.endsWith('/chat/completions')) url.pathname = `${trimmedPath}/chat/completions`
  else url.pathname = trimmedPath
  return url
}

function endpointLabel(url) {
  return `${url.protocol}//${url.host}`
}

function strictProposal(value) {
  const proposal = exactFields(value, new Set(['title', 'rationale', 'proposedInstructions', 'proposedOutputSummary']), '模型提案')
  const proposedInstructions = proposal.proposedInstructions === null
    ? null
    : boundedString(proposal.proposedInstructions, 'proposedInstructions', 1, 4_000)
  const proposedOutputSummary = proposal.proposedOutputSummary === null
    ? null
    : boundedString(proposal.proposedOutputSummary, 'proposedOutputSummary', 1, 12_000)
  if (proposedInstructions === null && proposedOutputSummary === null) fail('AGENT_ADAPTER_EMPTY_PROPOSAL', '模型没有返回可审阅的变更')
  return {
    source: 'byok-text',
    title: boundedString(proposal.title, 'title', 1, 120),
    rationale: boundedString(proposal.rationale, 'rationale', 1, 1_000),
    proposedInstructions,
    proposedOutputSummary,
  }
}

function extractJsonText(value) {
  const text = boundedString(value, '模型响应', 2, MAX_RESPONSE_BYTES)
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(text)
  return fenced ? fenced[1] : text
}

function createAgentMessages(project, node) {
  const approvedContext = project.nodes
    .filter((candidate) => candidate.order < node.order && candidate.status === 'approved')
    .map((candidate) => `${candidate.title}: ${candidate.outputSummary}`)
    .join('\n')
    .slice(0, 8_000)
  const characterContext = project.characterProfiles.map((profile) => ({
    name: profile.name,
    mode: profile.mode,
    identityLock: profile.identityLock,
    views: profile.views.map(({ view, status }) => ({ view, status })),
    wardrobeStates: profile.wardrobeStates.map(({ label, trigger, status }) => ({ label, trigger, status })),
  }))
  return [
    {
      role: 'system',
      content: '你是光阴砚 AEONQUILL 的受控视频生产角色。只提出一张可审阅变更卡，不得声称已生成图片、视频、音频或文件。仅返回一个 JSON 对象，字段必须恰好为 title、rationale、proposedInstructions、proposedOutputSummary；后两项允许 null。',
    },
    {
      role: 'user',
      content: JSON.stringify({
        project: {
          title: project.title,
          brief: project.brief,
          settings: project.settings,
          estimates: project.estimates,
        },
        roleSession: {
          id: node.id,
          title: node.title,
          purpose: node.purpose,
          instructions: node.instructions,
          currentOutputSummary: node.outputSummary,
          revision: node.revision,
        },
        approvedContext,
        characters: characterContext,
      }),
    },
  ]
}

function publicUsage(usage) {
  if (!isRecord(usage)) return null
  const promptTokens = Number.isSafeInteger(usage.prompt_tokens) && usage.prompt_tokens >= 0 ? usage.prompt_tokens : null
  const completionTokens = Number.isSafeInteger(usage.completion_tokens) && usage.completion_tokens >= 0 ? usage.completion_tokens : null
  const totalTokens = Number.isSafeInteger(usage.total_tokens) && usage.total_tokens >= 0 ? usage.total_tokens : null
  return { promptTokens, completionTokens, totalTokens }
}

export class AgentAdapterService {
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
    this.text = null
  }

  status() {
    if (!this.text) return { text: { configured: false, persistence: 'memory-only' } }
    return {
      text: {
        configured: true,
        persistence: 'memory-only',
        providerLabel: this.text.providerLabel,
        endpointLabel: endpointLabel(this.text.endpoint),
        model: this.text.model,
        jsonMode: this.text.jsonMode,
        timeoutMs: this.text.timeoutMs,
        configuredAt: this.text.configuredAt,
      },
    }
  }

  configureText(input) {
    const value = exactFields(input, new Set(['providerLabel', 'endpoint', 'model', 'apiKey', 'jsonMode', 'timeoutMs']), '文本适配器')
    const endpoint = normalizeEndpoint(value.endpoint)
    const apiKey = boundedString(value.apiKey, 'apiKey', 8, MAX_API_KEY_CHARACTERS)
    const model = boundedString(value.model, 'model', 1, MAX_MODEL_CHARACTERS)
    const providerLabel = boundedString(value.providerLabel ?? 'OpenAI-compatible', 'providerLabel', 1, 80)
    const jsonMode = value.jsonMode ?? 'json-object'
    if (!['json-object', 'prompt-only'].includes(jsonMode)) fail('AGENT_ADAPTER_INVALID_FIELD', 'jsonMode 不受支持')
    const timeoutMs = value.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 180_000) fail('AGENT_ADAPTER_INVALID_FIELD', 'timeoutMs 必须为 5000–180000')
    this.text = { providerLabel, endpoint, model, apiKey, jsonMode, timeoutMs, configuredAt: this.now() }
    return this.status()
  }

  clearText() {
    this.text = null
    return this.status()
  }

  async propose(input) {
    const value = exactFields(input, new Set(['project', 'nodeId']), '智能体提案请求')
    if (!this.text) fail('AGENT_ADAPTER_NOT_CONFIGURED', '尚未配置本次运行使用的文本 API', 409)
    const project = assertVideoProductionProject(value.project)
    const nodeId = boundedString(value.nodeId, 'nodeId', 1, 80)
    const node = project.nodes.find((candidate) => candidate.id === nodeId)
    if (!node) fail('AGENT_ADAPTER_UNKNOWN_NODE', `找不到生产节点 ${nodeId}`, 404)
    if (node.status === 'waiting' || node.status === 'failed') fail('AGENT_ADAPTER_NODE_BLOCKED', '节点依赖未满足或处于失败态，不能生成提案', 409)
    const configured = this.text
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('timeout')), configured.timeoutMs)
    const startedAt = this.now()
    let response
    try {
      response = await this.fetchImpl(configured.endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${configured.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          model: configured.model,
          messages: createAgentMessages(project, node),
          temperature: 0.35,
          max_tokens: 1_500,
          ...(configured.jsonMode === 'json-object' ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: controller.signal,
      })
    } catch (error) {
      if (controller.signal.aborted) fail('AGENT_ADAPTER_TIMEOUT', '文本 API 超时；正式节点未改变', 504)
      fail('AGENT_ADAPTER_NETWORK_ERROR', `文本 API 请求失败：${error instanceof Error ? error.message : '网络错误'}`, 502)
    } finally {
      clearTimeout(timeout)
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      fail('AGENT_ADAPTER_UPSTREAM_ERROR', `文本 API 返回 HTTP ${response.status}`, 502, { upstreamStatus: response.status, responseBytes: Buffer.byteLength(body) })
    }
    const declaredBytes = Number(response.headers.get('content-length') || 0)
    if (declaredBytes > MAX_RESPONSE_BYTES) fail('AGENT_ADAPTER_RESPONSE_TOO_LARGE', '文本 API 响应超过 2 MiB', 502)
    const responseText = await response.text()
    if (Buffer.byteLength(responseText) > MAX_RESPONSE_BYTES) fail('AGENT_ADAPTER_RESPONSE_TOO_LARGE', '文本 API 响应超过 2 MiB', 502)
    let payload
    try { payload = JSON.parse(responseText) } catch { fail('AGENT_ADAPTER_INVALID_RESPONSE', '文本 API 没有返回有效 JSON', 502) }
    const content = payload?.choices?.[0]?.message?.content
    if (typeof content !== 'string') fail('AGENT_ADAPTER_INVALID_RESPONSE', '文本 API 响应缺少 choices[0].message.content', 502)
    let proposalPayload
    try { proposalPayload = JSON.parse(extractJsonText(content)) } catch { fail('AGENT_ADAPTER_INVALID_PROPOSAL', '文本模型没有返回可校验的提案 JSON', 502) }
    return {
      proposal: strictProposal(proposalPayload),
      adapter: {
        providerLabel: configured.providerLabel,
        model: configured.model,
        persistence: 'memory-only',
      },
      usage: publicUsage(payload.usage),
      elapsedMs: Math.max(0, this.now() - startedAt),
    }
  }
}

export function normalizeAgentEndpointForTest(value) {
  const url = normalizeEndpoint(value)
  return { href: url.href, label: endpointLabel(url) }
}
