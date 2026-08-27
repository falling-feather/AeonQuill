import { isIP } from 'node:net'

const CAPABILITIES = Object.freeze(['image', 'video', 'speech'])
const PROFILE_BY_CAPABILITY = Object.freeze({
  image: 'openai-compatible-images-v1',
  video: 'openai-compatible-videos-v1',
  speech: 'openai-compatible-speech-v1',
})
const MAX_API_KEY_CHARACTERS = 2_048
const MAX_ENDPOINT_CHARACTERS = 2_048
const MAX_MODEL_CHARACTERS = 160
const MAX_JSON_RESPONSE_BYTES = 48 * 1024 * 1024
const OUTPUT_LIMITS = Object.freeze({
  image: 32 * 1024 * 1024,
  speech: 64 * 1024 * 1024,
  video: 240 * 1024 * 1024,
})
const PRIVATE_V4 = [
  /^10\./u,
  /^127\./u,
  /^169\.254\./u,
  /^192\.168\./u,
  /^172\.(?:1[6-9]|2\d|3[01])\./u,
  /^0\./u,
]

export class GenerationAdapterError extends Error {
  constructor(code, message, status = 400, details) {
    super(message)
    this.name = 'GenerationAdapterError'
    this.code = code
    this.status = status
    if (details !== undefined) this.details = details
  }
}

function fail(code, message, status = 400, details) {
  throw new GenerationAdapterError(code, message, status, details)
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function exactFields(value, allowed, label) {
  if (!isRecord(value)) fail('GENERATION_ADAPTER_INVALID_REQUEST', `${label}必须是对象`)
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length) fail('GENERATION_ADAPTER_UNKNOWN_FIELD', `${label}包含不支持的字段`, 400, { unknown })
  return value
}

function boundedString(value, label, min, max) {
  if (typeof value !== 'string') fail('GENERATION_ADAPTER_INVALID_FIELD', `${label}必须是字符串`)
  const normalized = value.trim()
  if (normalized.length < min || normalized.length > max) {
    fail('GENERATION_ADAPTER_INVALID_FIELD', `${label}长度必须为 ${min}–${max}`)
  }
  return normalized
}

function boundedNumber(value, label, minimum, maximum, options = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    fail('GENERATION_ADAPTER_INVALID_FIELD', `${label}必须为 ${minimum}–${maximum}`)
  }
  if (options.integer && !Number.isSafeInteger(value)) fail('GENERATION_ADAPTER_INVALID_FIELD', `${label}必须为整数`)
  return value
}

function assertCapability(value) {
  if (!CAPABILITIES.includes(value)) fail('GENERATION_ADAPTER_CAPABILITY_UNKNOWN', '生成能力不受支持', 404)
  return value
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
  if (family === 6) {
    return normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || normalized.startsWith('fe8')
      || normalized.startsWith('fe9')
      || normalized.startsWith('fea')
      || normalized.startsWith('feb')
      || normalized === '::'
  }
  return false
}

function normalizeEndpoint(value) {
  const raw = boundedString(value, 'endpoint', 8, MAX_ENDPOINT_CHARACTERS)
  let url
  try { url = new URL(raw) } catch { fail('GENERATION_ADAPTER_ENDPOINT_INVALID', '接口地址不是有效 URL') }
  if (url.username || url.password || url.search || url.hash) {
    fail('GENERATION_ADAPTER_ENDPOINT_INVALID', '接口地址不得包含凭据、查询参数或片段')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))) {
    fail('GENERATION_ADAPTER_ENDPOINT_UNSAFE', '远程接口必须使用 HTTPS；HTTP 仅允许本机回环地址')
  }
  if (isPrivateLiteral(url.hostname) || url.hostname.toLowerCase().endsWith('.local')) {
    fail('GENERATION_ADAPTER_ENDPOINT_UNSAFE', '接口地址不得指向局域网或链路本地目标')
  }
  url.pathname = url.pathname.replace(/\/+$/gu, '') || '/v1'
  return url
}

function endpointLabel(url) {
  return `${url.protocol}//${url.host}`
}

function normalizeOutputOrigins(value = []) {
  if (!Array.isArray(value) || value.length > 4) fail('GENERATION_ADAPTER_INVALID_FIELD', 'outputOrigins 最多包含 4 项')
  const normalized = value.map((entry) => {
    const url = normalizeEndpoint(entry)
    url.pathname = '/'
    return url.origin
  })
  if (new Set(normalized).size !== normalized.length) fail('GENERATION_ADAPTER_INVALID_FIELD', 'outputOrigins 不得重复')
  return normalized
}

function capabilityEndpoint(config, suffix) {
  const url = new URL(config.endpoint)
  const current = url.pathname.replace(/\/+$/gu, '')
  url.pathname = current.endsWith(suffix) ? current : `${current}${suffix}`
  return url
}

function videoItemEndpoint(config, remoteId, suffix = '') {
  const base = capabilityEndpoint(config, '/videos')
  base.pathname = `${base.pathname}/${encodeURIComponent(remoteId)}${suffix}`
  return base
}

function estimatedCost(capability, config, input) {
  if (capability === 'speech') return config.costRateUsd * Math.max(1, input.text.length) / 1_000
  if (capability === 'video') return config.costRateUsd * input.durationSeconds
  return config.costRateUsd
}

function enforceBudget(capability, config, input) {
  const budgetUsd = boundedNumber(input.budgetUsd, 'budgetUsd', 0, 1_000)
  const estimate = estimatedCost(capability, config, input)
  const ceiling = Math.min(config.maxCostUsd, budgetUsd)
  if (estimate > ceiling + 1e-9) {
    fail('GENERATION_ADAPTER_COST_LIMIT', `预计费用 $${estimate.toFixed(4)} 超过本次或适配器上限 $${ceiling.toFixed(4)}`, 409, {
      estimatedCostUsd: Number(estimate.toFixed(6)),
      ceilingUsd: Number(ceiling.toFixed(6)),
    })
  }
  return Number(estimate.toFixed(6))
}

function abortableDelay(duration, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason || new Error('cancelled'))
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolvePromise()
    }, duration)
    const onAbort = () => {
      clearTimeout(timer)
      rejectPromise(signal.reason || new Error('cancelled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function readResponseBytes(response, limit, label) {
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > limit) fail('GENERATION_ADAPTER_RESPONSE_TOO_LARGE', `${label}超过允许的字节上限`, 502, { limitBytes: limit })
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) {
        await reader.cancel().catch(() => {})
        fail('GENERATION_ADAPTER_RESPONSE_TOO_LARGE', `${label}超过允许的字节上限`, 502, { limitBytes: limit })
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
}

function normalizedMime(response) {
  return String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
}

function sniffImageMime(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return null
}

function sniffAudioMime(bytes) {
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WAVE') return 'audio/wav'
  if (bytes.length >= 3 && bytes.subarray(0, 3).toString('ascii') === 'ID3') return 'audio/mpeg'
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'audio/mpeg'
  return null
}

function sniffVideoMime(bytes) {
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp') return 'video/mp4'
  return null
}

function assertMediaBytes(capability, bytes, declaredMime = '') {
  if (!Buffer.isBuffer(bytes) || !bytes.length) fail('GENERATION_ADAPTER_EMPTY_OUTPUT', '生成接口返回了空媒体', 502)
  if (bytes.length > OUTPUT_LIMITS[capability]) {
    fail('GENERATION_ADAPTER_RESPONSE_TOO_LARGE', '生成媒体超过受管资产上限', 502, { limitBytes: OUTPUT_LIMITS[capability] })
  }
  const sniffed = capability === 'image' ? sniffImageMime(bytes) : capability === 'speech' ? sniffAudioMime(bytes) : sniffVideoMime(bytes)
  if (!sniffed) fail('GENERATION_ADAPTER_MIME_INVALID', '生成接口返回的媒体签名不受支持', 502)
  if (declaredMime && declaredMime !== 'application/octet-stream' && declaredMime !== sniffed) {
    fail('GENERATION_ADAPTER_MIME_MISMATCH', '生成接口声明的媒体类型与实际字节不一致', 502)
  }
  return sniffed
}

function decodeBase64Media(capability, value, declaredMime = '') {
  const encoded = boundedString(value, 'base64 媒体', 4, Math.ceil(OUTPUT_LIMITS[capability] * 4 / 3) + 8)
  if (!/^[a-zA-Z0-9+/]+={0,2}$/u.test(encoded) || encoded.length % 4 === 1) {
    fail('GENERATION_ADAPTER_INVALID_RESPONSE', '生成接口返回的 base64 媒体无效', 502)
  }
  return { bytes: Buffer.from(encoded, 'base64'), declaredMime }
}

function parseActualCost(payload, headers) {
  const candidates = [
    payload?.usage?.cost_usd,
    payload?.usage?.costUsd,
    headers?.get?.('x-usage-cost-usd'),
  ]
  for (const value of candidates) {
    const number = Number(value)
    if (Number.isFinite(number) && number >= 0 && number <= 1_000_000) return Number(number.toFixed(6))
  }
  return null
}

function publicUsage(estimatedCostUsd, actualCostUsd, elapsedMs) {
  return { estimatedCostUsd, actualCostUsd, elapsedMs: Math.max(0, Math.round(elapsedMs)) }
}

function validateReferenceDataUrl(value) {
  if (value === undefined || value === null) return null
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([a-zA-Z0-9+/=]+)$/u.exec(value)
  if (!match) fail('GENERATION_ADAPTER_REFERENCE_INVALID', '参考素材必须是受支持的图像 Data URL')
  const bytes = Buffer.from(match[2], 'base64')
  if (!bytes.length || bytes.length > 24 * 1024 * 1024) fail('GENERATION_ADAPTER_REFERENCE_INVALID', '参考素材为空或超过 24 MiB')
  assertMediaBytes('image', bytes, match[1])
  return { mimeType: match[1], dataBase64: match[2] }
}

export class GenerationAdapterService {
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
    this.configurations = new Map()
  }

  status() {
    return Object.fromEntries(CAPABILITIES.map((capability) => {
      const config = this.configurations.get(capability)
      return [capability, config ? {
        configured: true,
        persistence: 'memory-only',
        providerLabel: config.providerLabel,
        endpointLabel: endpointLabel(config.endpoint),
        model: config.model,
        profile: config.profile,
        timeoutMs: config.timeoutMs,
        maxCostUsd: config.maxCostUsd,
        costRateUsd: config.costRateUsd,
        configuredAt: config.configuredAt,
      } : {
        configured: false,
        persistence: 'memory-only',
        profile: PROFILE_BY_CAPABILITY[capability],
      }]
    }))
  }

  configure(capabilityValue, input) {
    const capability = assertCapability(capabilityValue)
    const value = exactFields(input, new Set([
      'providerLabel', 'endpoint', 'model', 'apiKey', 'profile', 'timeoutMs', 'maxCostUsd', 'costRateUsd', 'pollIntervalMs', 'outputOrigins',
    ]), '生成适配器')
    const profile = value.profile ?? PROFILE_BY_CAPABILITY[capability]
    if (profile !== PROFILE_BY_CAPABILITY[capability]) fail('GENERATION_ADAPTER_PROFILE_UNSUPPORTED', '适配器协议不受支持')
    const timeoutMaximum = capability === 'video' ? 2 * 60 * 60 * 1_000 : 180_000
    const timeoutMs = boundedNumber(value.timeoutMs ?? (capability === 'video' ? 30 * 60_000 : 60_000), 'timeoutMs', 5_000, timeoutMaximum, { integer: true })
    const config = {
      capability,
      providerLabel: boundedString(value.providerLabel ?? 'OpenAI-compatible', 'providerLabel', 1, 80),
      endpoint: normalizeEndpoint(value.endpoint),
      model: boundedString(value.model, 'model', 1, MAX_MODEL_CHARACTERS),
      apiKey: boundedString(value.apiKey, 'apiKey', 8, MAX_API_KEY_CHARACTERS),
      profile,
      timeoutMs,
      maxCostUsd: boundedNumber(value.maxCostUsd ?? 5, 'maxCostUsd', 0, 1_000),
      costRateUsd: boundedNumber(value.costRateUsd ?? 0, 'costRateUsd', 0, 100),
      pollIntervalMs: capability === 'video'
        ? boundedNumber(value.pollIntervalMs ?? 1_000, 'pollIntervalMs', 250, 10_000, { integer: true })
        : null,
      outputOrigins: normalizeOutputOrigins(value.outputOrigins),
      configuredAt: this.now(),
    }
    this.configurations.set(capability, config)
    return this.status()
  }

  clear(capabilityValue) {
    this.configurations.delete(assertCapability(capabilityValue))
    return this.status()
  }

  config(capability) {
    const config = this.configurations.get(capability)
    if (!config) fail('GENERATION_ADAPTER_NOT_CONFIGURED', `尚未配置本次运行使用的${capability} API`, 409)
    return config
  }

  async request(config, url, init, options = {}) {
    const controller = new AbortController()
    const externalSignal = options.signal
    const onAbort = () => controller.abort(externalSignal.reason || new Error('cancelled'))
    if (externalSignal?.aborted) onAbort()
    else externalSignal?.addEventListener('abort', onAbort, { once: true })
    const timeout = setTimeout(() => controller.abort(Object.assign(new Error('timeout'), { code: 'GENERATION_ADAPTER_TIMEOUT' })), options.timeoutMs ?? config.timeoutMs)
    let response
    try {
      response = await this.fetchImpl(url, {
        ...init,
        redirect: 'error',
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          accept: options.accept ?? 'application/json',
          ...init.headers,
        },
        signal: controller.signal,
      })
    } catch {
      if (externalSignal?.aborted) fail('GENERATION_ADAPTER_CANCELLED', '生成请求已取消；没有写入产物', 499)
      if (controller.signal.aborted) fail('GENERATION_ADAPTER_TIMEOUT', '生成接口超过安全时限；没有写入产物', 504)
      fail('GENERATION_ADAPTER_NETWORK_ERROR', '生成接口连接失败；没有写入产物', 502)
    } finally {
      clearTimeout(timeout)
      externalSignal?.removeEventListener('abort', onAbort)
    }
    if (!response.ok) {
      const body = await readResponseBytes(response, 64 * 1024, '上游错误响应').catch(() => Buffer.alloc(0))
      fail('GENERATION_ADAPTER_UPSTREAM_ERROR', `生成接口返回 HTTP ${response.status}`, 502, {
        upstreamStatus: response.status,
        responseBytes: body.length,
      })
    }
    return response
  }

  async requestJson(config, url, init, options = {}) {
    const response = await this.request(config, url, init, options)
    const mimeType = normalizedMime(response)
    if (mimeType && mimeType !== 'application/json') fail('GENERATION_ADAPTER_INVALID_RESPONSE', '生成接口没有返回 JSON', 502)
    const bytes = await readResponseBytes(response, options.limit ?? MAX_JSON_RESPONSE_BYTES, 'JSON 响应')
    let payload
    try { payload = JSON.parse(bytes.toString('utf8')) } catch { fail('GENERATION_ADAPTER_INVALID_RESPONSE', '生成接口返回的 JSON 无效', 502) }
    return { payload, headers: response.headers }
  }

  assertOutputUrl(config, raw) {
    let url
    try { url = new URL(raw) } catch { fail('GENERATION_ADAPTER_OUTPUT_URL_INVALID', '生成接口返回的下载地址无效', 502) }
    if (url.username || url.password || url.hash || url.protocol !== 'https:') {
      fail('GENERATION_ADAPTER_OUTPUT_URL_UNSAFE', '生成接口返回的下载地址不安全', 502)
    }
    const allowed = new Set([config.endpoint.origin, ...config.outputOrigins])
    if (!allowed.has(url.origin)) fail('GENERATION_ADAPTER_OUTPUT_ORIGIN_BLOCKED', '生成结果来源未在适配器允许列表中', 502)
    return url
  }

  async fetchOutput(config, capability, url, signal) {
    const response = await this.request(config, url, { method: 'GET' }, {
      signal,
      accept: capability === 'image' ? 'image/*' : capability === 'speech' ? 'audio/*' : 'video/mp4',
    })
    const bytes = await readResponseBytes(response, OUTPUT_LIMITS[capability], '生成媒体')
    const mimeType = assertMediaBytes(capability, bytes, normalizedMime(response))
    return { bytes, mimeType }
  }

  async generateImage(input, options = {}) {
    const config = this.config('image')
    const value = exactFields(input, new Set(['prompt', 'negativePrompt', 'size', 'quality', 'budgetUsd', 'referenceDataUrl']), '图像生成请求')
    const prompt = boundedString(value.prompt, 'prompt', 1, 6_000)
    const negativePrompt = value.negativePrompt === undefined ? undefined : boundedString(value.negativePrompt, 'negativePrompt', 1, 2_000)
    const size = value.size ?? '1024x1024'
    if (!['1024x1024', '1536x1024', '1024x1536'].includes(size)) fail('GENERATION_ADAPTER_INVALID_FIELD', 'size 不受支持')
    const quality = value.quality ?? 'standard'
    if (!['standard', 'high'].includes(quality)) fail('GENERATION_ADAPTER_INVALID_FIELD', 'quality 不受支持')
    const reference = validateReferenceDataUrl(value.referenceDataUrl)
    const estimatedCostUsd = enforceBudget('image', config, value)
    const startedAt = this.now()
    const { payload, headers } = await this.requestJson(config, capabilityEndpoint(config, '/images/generations'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        prompt,
        ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
        size,
        quality,
        n: 1,
        response_format: 'b64_json',
        ...(reference ? { input_reference: reference } : {}),
      }),
    }, { signal: options.signal })
    const output = payload?.data?.[0]
    if (!isRecord(output)) fail('GENERATION_ADAPTER_INVALID_RESPONSE', '图像接口响应缺少 data[0]', 502)
    let media
    if (typeof output.b64_json === 'string') {
      const decoded = decodeBase64Media('image', output.b64_json, typeof output.mime_type === 'string' ? output.mime_type : '')
      media = { bytes: decoded.bytes, mimeType: assertMediaBytes('image', decoded.bytes, decoded.declaredMime) }
    } else if (typeof output.url === 'string') {
      media = await this.fetchOutput(config, 'image', this.assertOutputUrl(config, output.url), options.signal)
    } else {
      fail('GENERATION_ADAPTER_INVALID_RESPONSE', '图像接口没有返回 b64_json 或允许的 URL', 502)
    }
    return {
      ...media,
      adapter: { providerLabel: config.providerLabel, model: config.model, profile: config.profile, persistence: 'memory-only' },
      usage: publicUsage(estimatedCostUsd, parseActualCost(payload, headers), this.now() - startedAt),
      remoteRequestId: typeof payload.id === 'string' ? payload.id.slice(0, 200) : null,
    }
  }

  async synthesizeSpeech(input, options = {}) {
    const config = this.config('speech')
    const value = exactFields(input, new Set(['text', 'voice', 'format', 'speed', 'budgetUsd']), '语音生成请求')
    const text = boundedString(value.text, 'text', 1, 8_000)
    const voice = boundedString(value.voice ?? 'alloy', 'voice', 1, 80)
    const format = value.format ?? 'mp3'
    if (!['mp3', 'wav'].includes(format)) fail('GENERATION_ADAPTER_INVALID_FIELD', 'format 不受支持')
    const speed = boundedNumber(value.speed ?? 1, 'speed', 0.25, 4)
    const estimatedCostUsd = enforceBudget('speech', config, { ...value, text })
    const startedAt = this.now()
    const response = await this.request(config, capabilityEndpoint(config, '/audio/speech'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: config.model, input: text, voice, response_format: format, speed }),
    }, { signal: options.signal, accept: format === 'wav' ? 'audio/wav' : 'audio/mpeg' })
    const bytes = await readResponseBytes(response, OUTPUT_LIMITS.speech, '语音媒体')
    const mimeType = assertMediaBytes('speech', bytes, normalizedMime(response))
    return {
      bytes,
      mimeType,
      adapter: { providerLabel: config.providerLabel, model: config.model, profile: config.profile, persistence: 'memory-only' },
      usage: publicUsage(estimatedCostUsd, parseActualCost(null, response.headers), this.now() - startedAt),
      remoteRequestId: String(response.headers.get('x-request-id') || '').slice(0, 200) || null,
    }
  }

  async generateVideo(input, options = {}) {
    const config = this.config('video')
    const value = exactFields(input, new Set(['prompt', 'size', 'durationSeconds', 'budgetUsd', 'referenceDataUrl']), '视频生成请求')
    const prompt = boundedString(value.prompt, 'prompt', 1, 6_000)
    const size = value.size ?? '1280x720'
    if (!['1280x720', '720x1280', '1024x1024'].includes(size)) fail('GENERATION_ADAPTER_INVALID_FIELD', 'size 不受支持')
    const durationSeconds = boundedNumber(value.durationSeconds ?? 5, 'durationSeconds', 2, 20, { integer: true })
    const reference = validateReferenceDataUrl(value.referenceDataUrl)
    const estimatedCostUsd = enforceBudget('video', config, { ...value, durationSeconds })
    const startedAt = this.now()
    const deadlineAt = startedAt + config.timeoutMs
    const submitted = await this.requestJson(config, capabilityEndpoint(config, '/videos'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        prompt,
        size,
        seconds: durationSeconds,
        ...(reference ? { input_reference: reference } : {}),
      }),
    }, { signal: options.signal, timeoutMs: Math.min(config.timeoutMs, 180_000), limit: 2 * 1024 * 1024 })
    const remoteId = boundedString(submitted.payload?.id, '视频任务 id', 1, 200)
    let latestPayload = submitted.payload
    let latestHeaders = submitted.headers
    let pollCount = 0
    while (true) {
      const status = String(latestPayload?.status || '').toLowerCase()
      const progressValue = Number(latestPayload?.progress)
      const progress = Number.isFinite(progressValue) ? Math.max(0, Math.min(99, Math.round(progressValue))) : status === 'queued' ? 2 : 10
      options.onProgress?.({ remoteId, status: status || 'queued', progress, pollCount })
      if (['completed', 'succeeded'].includes(status)) break
      if (['failed', 'cancelled', 'canceled', 'expired'].includes(status)) {
        fail('GENERATION_ADAPTER_UPSTREAM_FAILED', `视频接口任务状态为 ${status}`, 502, { remoteStatus: status })
      }
      if (!['queued', 'pending', 'in_progress', 'running', 'processing', ''].includes(status)) {
        fail('GENERATION_ADAPTER_INVALID_RESPONSE', '视频接口返回了未知任务状态', 502)
      }
      if (this.now() + config.pollIntervalMs >= deadlineAt) fail('GENERATION_ADAPTER_TIMEOUT', '视频接口超过安全时限；没有写入产物', 504)
      await abortableDelay(config.pollIntervalMs, options.signal)
      pollCount += 1
      const polled = await this.requestJson(config, videoItemEndpoint(config, remoteId), { method: 'GET' }, {
        signal: options.signal,
        timeoutMs: Math.min(180_000, Math.max(5_000, deadlineAt - this.now())),
        limit: 2 * 1024 * 1024,
      })
      latestPayload = polled.payload
      latestHeaders = polled.headers
    }
    let media
    const output = latestPayload?.output
    if (typeof output?.b64_json === 'string') {
      const decoded = decodeBase64Media('video', output.b64_json, typeof output.mime_type === 'string' ? output.mime_type : 'video/mp4')
      media = { bytes: decoded.bytes, mimeType: assertMediaBytes('video', decoded.bytes, decoded.declaredMime) }
    } else if (typeof output?.url === 'string') {
      media = await this.fetchOutput(config, 'video', this.assertOutputUrl(config, output.url), options.signal)
    } else {
      media = await this.fetchOutput(config, 'video', videoItemEndpoint(config, remoteId, '/content'), options.signal)
    }
    options.onProgress?.({ remoteId, status: 'completed', progress: 100, pollCount })
    return {
      ...media,
      adapter: { providerLabel: config.providerLabel, model: config.model, profile: config.profile, persistence: 'memory-only' },
      usage: publicUsage(estimatedCostUsd, parseActualCost(latestPayload, latestHeaders), this.now() - startedAt),
      remoteRequestId: remoteId,
    }
  }
}

export function generationAdapterProfiles() {
  return { ...PROFILE_BY_CAPABILITY }
}

export function normalizeGenerationEndpointForTest(value) {
  const url = normalizeEndpoint(value)
  return { href: url.href, label: endpointLabel(url) }
}
