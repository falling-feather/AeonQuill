import { readFile } from 'node:fs/promises'

function createHttpError(message, status, payload) {
  const error = new Error(message)
  error.status = status
  error.payload = payload
  return error
}

function abortError() {
  const error = new Error('The operation was cancelled')
  error.name = 'AbortError'
  return error
}

function withTimeout(ms, signal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${ms}ms`)), ms)
  const abort = () => controller.abort(signal?.reason || abortError())
  signal?.addEventListener('abort', abort, { once: true })
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    },
  }
}

function parseSocketMessage(event) {
  if (typeof event.data === 'string') return JSON.parse(event.data)
  if (event.data instanceof ArrayBuffer) return null
  return null
}

export class ComfyClient {
  constructor(baseUrl = 'http://127.0.0.1:8188') {
    this.baseUrl = baseUrl.replace(/\/$/, '')
  }

  url(pathname) {
    return `${this.baseUrl}${pathname.startsWith('/') ? pathname : `/${pathname}`}`
  }

  async request(pathname, options = {}, timeoutMs = 15_000) {
    const timeout = withTimeout(timeoutMs, options.signal)
    try {
      const response = await fetch(this.url(pathname), { ...options, signal: timeout.signal })
      if (!response.ok) {
        const text = await response.text()
        let payload = text
        try {
          payload = JSON.parse(text)
        } catch {
          // Keep the original response text for diagnostics.
        }
        throw createHttpError(`ComfyUI returned HTTP ${response.status}`, response.status, payload)
      }
      return response
    } finally {
      timeout.cleanup()
    }
  }

  async runtimeStatus() {
    const [statsResponse, queueResponse] = await Promise.all([
      this.request('/system_stats'),
      this.request('/queue'),
    ])
    const stats = await statsResponse.json()
    const queue = await queueResponse.json()
    const device = stats.devices?.[0]
    return {
      connected: true,
      comfyVersion: stats.system?.comfyui_version || 'unknown',
      pythonVersion: stats.system?.python_version || 'unknown',
      device: device?.name || '未检测到 GPU',
      vramTotal: device?.vram_total || 0,
      vramFree: device?.vram_free || 0,
      queueRunning: queue.queue_running?.length || 0,
      queuePending: queue.queue_pending?.length || 0,
    }
  }

  async queueState() {
    return this.request('/queue').then((response) => response.json())
  }

  async objectInfo() {
    return this.request('/object_info').then((response) => response.json())
  }

  async uploadImage(filePath, filename, signal) {
    const bytes = await readFile(filePath)
    const form = new FormData()
    form.append('image', new Blob([bytes], { type: 'image/png' }), filename)
    form.append('type', 'input')
    form.append('overwrite', 'true')
    const response = await this.request('/upload/image', {
      method: 'POST',
      body: form,
      signal,
    }, 60_000)
    const result = await response.json()
    return result.subfolder ? `${result.subfolder}/${result.name}` : result.name
  }

  async prepareSamImage(imageReference, signal) {
    const normalized = String(imageReference || '').replace(/\\/g, '/')
    const segments = normalized.split('/').filter(Boolean)
    const filename = segments.pop()
    if (
      !filename
      || ![...segments, filename].every((segment) => /^[a-zA-Z0-9._-]+$/.test(segment) && segment !== '.' && segment !== '..')
    ) {
      throw Object.assign(new Error('Invalid managed image reference for SAM'), {
        code: 'INVALID_COMFY_IMAGE_REFERENCE',
      })
    }
    const response = await this.request('/sam/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sam_model_name: 'sam_vit_b_01ec64.pth',
        filename,
        type: 'input',
        subfolder: segments.join('/'),
      }),
      signal,
    }, 30_000)
    await response.arrayBuffer()
  }

  async detectSamMask({ positivePoints, negativePoints, threshold }, signal) {
    const response = await this.request('/sam/detect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ positive_points: positivePoints, negative_points: negativePoints, threshold }),
      signal,
    }, 180_000)
    return Buffer.from(await response.arrayBuffer())
  }

  async releaseSam() {
    await this.request('/sam/release', { method: 'POST' }, 10_000).catch(() => {})
  }

  async queuePrompt(prompt, clientId, signal) {
    const response = await this.request('/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, client_id: clientId }),
      signal,
    }, 30_000)
    const result = await response.json()
    if (!result.prompt_id) {
      const error = new Error('ComfyUI rejected the workflow')
      error.payload = result
      throw error
    }
    return result
  }

  async removePendingPrompt(promptId) {
    await this.request('/queue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ delete: [promptId] }),
    })
  }

  async interrupt() {
    await this.request('/interrupt', { method: 'POST' })
  }

  async history(promptId) {
    const response = await this.request(`/history/${encodeURIComponent(promptId)}`, {}, 30_000)
    const payload = await response.json()
    return payload[promptId] || null
  }

  async fetchOutput(file) {
    const query = new URLSearchParams({
      filename: file.filename,
      subfolder: file.subfolder || '',
      type: file.type || 'output',
    })
    return this.request(`/view?${query}`, {}, 120_000)
  }

  async openExecutionTracker(clientId, onMessage = () => {}) {
    const websocketUrl = new URL(this.baseUrl)
    websocketUrl.protocol = websocketUrl.protocol === 'https:' ? 'wss:' : 'ws:'
    websocketUrl.pathname = '/ws'
    websocketUrl.search = new URLSearchParams({ clientId }).toString()
    const socket = new WebSocket(websocketUrl)

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out connecting to ComfyUI WebSocket')), 10_000)
      socket.addEventListener('open', () => {
        clearTimeout(timeout)
        resolve()
      }, { once: true })
      socket.addEventListener('error', () => {
        clearTimeout(timeout)
        reject(new Error('Unable to connect to ComfyUI WebSocket'))
      }, { once: true })
    })

    return {
      socket,
      waitForPrompt: (promptId, signal) => this.waitForPrompt(socket, promptId, signal, onMessage),
      close: () => socket.close(),
    }
  }

  waitForPrompt(socket, promptId, signal, onMessage) {
    return new Promise((resolve, reject) => {
      let settled = false
      let completionObserved = false
      const startedAt = Date.now()

      const cleanup = () => {
        clearInterval(pollTimer)
        clearTimeout(timeoutTimer)
        socket.removeEventListener('message', handleMessage)
        signal?.removeEventListener('abort', handleAbort)
      }
      const finish = (callback, value) => {
        if (settled) return
        settled = true
        cleanup()
        callback(value)
      }
      const handleAbort = () => finish(reject, abortError())
      const handleMessage = (event) => {
        let message
        try {
          message = parseSocketMessage(event)
        } catch {
          return
        }
        if (!message) return
        const messagePromptId = message.data?.prompt_id
        if (messagePromptId && messagePromptId !== promptId) return
        onMessage(message)

        if (message.type === 'execution_error') {
          const error = new Error(message.data?.exception_message || 'ComfyUI execution failed')
          error.comfyData = message.data
          finish(reject, error)
        } else if (message.type === 'execution_interrupted') {
          finish(reject, abortError())
        } else if (message.type === 'execution_success') {
          completionObserved = true
        } else if (message.type === 'executing' && message.data?.node === null) {
          completionObserved = true
        }
      }
      const pollHistory = async () => {
        if (settled) return
        try {
          const entry = await this.history(promptId)
          if (!entry) return
          const messages = entry.status?.messages || []
          const errorMessage = messages.find((item) => item?.[0] === 'execution_error')
          if (errorMessage) {
            const data = errorMessage[1] || {}
            const error = new Error(data.exception_message || 'ComfyUI execution failed')
            error.comfyData = data
            finish(reject, error)
            return
          }
          if (entry.status?.completed || completionObserved) finish(resolve, entry)
        } catch (error) {
          if (Date.now() - startedAt > 30_000 && socket.readyState === WebSocket.CLOSED) {
            finish(reject, error)
          }
        }
      }

      socket.addEventListener('message', handleMessage)
      signal?.addEventListener('abort', handleAbort, { once: true })
      const pollTimer = setInterval(pollHistory, 2_000)
      const timeoutTimer = setTimeout(
        () => finish(reject, new Error('Video generation exceeded the two-hour safety timeout')),
        2 * 60 * 60 * 1000,
      )
      pollHistory()
    })
  }
}

export function findVideoOutput(historyEntry) {
  for (const output of Object.values(historyEntry?.outputs || {})) {
    for (const value of Object.values(output || {})) {
      if (!Array.isArray(value)) continue
      const match = value.find((item) => item?.filename && /\.(mp4|webm|mov)$/i.test(item.filename))
      if (match) return match
    }
  }
  return null
}
