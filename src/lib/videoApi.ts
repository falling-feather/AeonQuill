import type { ProcessingJob, RuntimeStatus, VideoJobRequest } from '../types'

export const VIDEO_DIMENSIONS = {
  '16:9': { width: 608, height: 352 },
  '9:16': { width: 352, height: 608 },
  '1:1': { width: 448, height: 448 },
} as const

export type JobEvent =
  | { type: 'jobs.snapshot'; jobs: ProcessingJob[] }
  | { type: 'job.updated'; job: ProcessingJob }
  | { type: 'jobs.cleared'; ids: string[] }
  | { type: 'runtime.updated'; runtime: RuntimeStatus }

let sessionReady: Promise<void> | null = null

export function ensureLocalSession() {
  if (!sessionReady) {
    sessionReady = fetch('/api/health', { credentials: 'same-origin', cache: 'no-store' })
      .then((response) => {
        if (!response.ok) throw new Error(`本地服务会话初始化失败（HTTP ${response.status}）`)
      })
      .catch((error) => {
        sessionReady = null
        throw error
      })
  }
  return sessionReady
}

async function authenticatedFetch(path: string, options?: RequestInit, allowRetry = true) {
  await ensureLocalSession()
  const response = await fetch(path, { ...options, credentials: 'same-origin' })
  if (allowRetry && response.status === 401) {
    sessionReady = null
    await ensureLocalSession()
    return authenticatedFetch(path, options, false)
  }
  return response
}

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await authenticatedFetch(path, options)
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(payload?.error?.message || `本地服务返回 HTTP ${response.status}`)
  }
  return payload as T
}

export async function fetchRuntimeStatus(refresh = false) {
  return api<RuntimeStatus>(`/api/runtime/status${refresh ? '?refresh=1' : ''}`)
}

export async function startRuntime() {
  return api<RuntimeStatus>('/api/runtime/start', { method: 'POST' })
}

export async function stopRuntime() {
  return api<RuntimeStatus>('/api/runtime/stop', { method: 'POST' })
}

export async function updateRuntimePolicy(
  policy: NonNullable<RuntimeStatus['lifecycle']>['policy'],
  idleSeconds: number,
) {
  return api<RuntimeStatus>('/api/runtime/policy', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ policy, idleSeconds }),
  })
}

export async function fetchVideoJobs() {
  const payload = await api<{ jobs: ProcessingJob[] }>('/api/jobs')
  return payload.jobs
}

export type CreateVideoJobOptions = {
  idempotencyKey?: string
  priority?: number
}

export async function createVideoJob(request: VideoJobRequest, options: CreateVideoJobOptions = {}) {
  const idempotencyKey = options.idempotencyKey ?? `video-${crypto.randomUUID()}`
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'idempotency-key': idempotencyKey,
  }
  if (options.priority !== undefined) headers['x-miaohui-priority'] = String(options.priority)
  const payload = await api<{ job: ProcessingJob }>('/api/jobs/video', {
    method: 'POST',
    headers,
    body: JSON.stringify(request),
  })
  return payload.job
}

export async function cancelVideoJob(jobId: string) {
  const payload = await api<{ job: ProcessingJob }>(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: 'POST',
  })
  return payload.job
}

export async function retryVideoJob(jobId: string) {
  const payload = await api<{ job: ProcessingJob }>(`/api/jobs/${encodeURIComponent(jobId)}/retry`, {
    method: 'POST',
    headers: { 'idempotency-key': `retry-${crypto.randomUUID()}` },
  })
  return payload.job
}

export async function clearFinishedJobs() {
  return api<{ removed: string[] }>('/api/jobs', { method: 'DELETE' })
}

export async function subscribeVideoJobs(
  onEvent: (event: JobEvent) => void,
  onConnectionChange?: (connected: boolean) => void,
) {
  const reconnectDelays = [250, 500, 1_000, 2_000, 4_000] as const
  let source: EventSource | undefined
  let reconnectTimer: number | undefined
  let reconnectAttempt = 0
  let connecting = false
  let disposed = false

  const scheduleReconnect = () => {
    if (disposed || reconnectTimer !== undefined) return
    const delay = reconnectDelays[Math.min(reconnectAttempt, reconnectDelays.length - 1)]
    reconnectAttempt += 1
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = undefined
      void connect(true)
    }, delay)
  }

  const connect = async (renewSession = false) => {
    if (disposed || connecting || source) return
    connecting = true
    try {
      if (renewSession) sessionReady = null
      await ensureLocalSession()
      if (disposed) return

      const nextSource = new EventSource('/api/jobs/events')
      source = nextSource
      nextSource.onopen = () => {
        if (disposed || source !== nextSource) return
        reconnectAttempt = 0
        onConnectionChange?.(true)
      }
      nextSource.onerror = () => {
        if (disposed || source !== nextSource) return
        source = undefined
        nextSource.close()
        onConnectionChange?.(false)
        scheduleReconnect()
      }
      nextSource.onmessage = (message) => {
        if (disposed || source !== nextSource) return
        try {
          onEvent(JSON.parse(message.data) as JobEvent)
        } catch {
          // Ignore malformed local events and let the stream continue.
        }
      }
    } catch {
      if (!disposed) {
        onConnectionChange?.(false)
        scheduleReconnect()
      }
    } finally {
      connecting = false
    }
  }

  await connect()
  return () => {
    disposed = true
    if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
    source?.close()
    source = undefined
  }
}

function loadImage(source: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('无法读取选中的画布图片'))
    image.src = source
  })
}

export async function normalizeVideoFirstFrame(
  source: string,
  aspectRatio: VideoJobRequest['aspectRatio'],
) {
  const image = await loadImage(source)
  const { width, height } = VIDEO_DIMENSIONS[aspectRatio]
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('浏览器无法创建首帧处理画布')

  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight)
  const drawWidth = image.naturalWidth * scale
  const drawHeight = image.naturalHeight * scale
  context.fillStyle = '#000000'
  context.fillRect(0, 0, width, height)
  context.drawImage(
    image,
    (width - drawWidth) / 2,
    (height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  )
  return canvas.toDataURL('image/png')
}
