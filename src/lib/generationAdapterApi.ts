import type { LibraryAsset } from './libraryApi'
import { ensureLocalSession } from './videoApi'
import type { ProcessingJob } from '../types'

export type GenerationCapability = 'image' | 'video' | 'speech'

export type GenerationAdapterEntry = {
  configured: false
  persistence: 'memory-only'
  profile: string
} | {
  configured: true
  persistence: 'memory-only'
  providerLabel: string
  endpointLabel: string
  model: string
  profile: string
  timeoutMs: number
  maxCostUsd: number
  costRateUsd: number
  configuredAt: number
}

export type GenerationAdapterStatus = Record<GenerationCapability, GenerationAdapterEntry>

export type GenerationAdapterConfig = {
  providerLabel: string
  endpoint: string
  model: string
  apiKey: string
  profile?: string
  timeoutMs: number
  maxCostUsd: number
  costRateUsd: number
  pollIntervalMs?: number
  outputOrigins?: string[]
}

export type GenerationResult = {
  asset: LibraryAsset
  adapter: {
    providerLabel: string
    model: string
    profile: string
    persistence: 'memory-only'
  }
  usage: {
    estimatedCostUsd: number
    actualCostUsd: number | null
    elapsedMs: number
  }
  remoteRequestId: string | null
}

export class GenerationAdapterApiError extends Error {
  status: number
  code?: string
  details?: unknown

  constructor(message: string, options: { status: number; code?: string; details?: unknown }) {
    super(message)
    this.name = 'GenerationAdapterApiError'
    this.status = options.status
    this.code = options.code
    this.details = options.details
  }
}

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  await ensureLocalSession()
  const response = await fetch(path, { ...options, credentials: 'same-origin' })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new GenerationAdapterApiError(payload?.error?.message || `生成适配器返回 HTTP ${response.status}`, {
      status: response.status,
      code: payload?.error?.code,
      details: payload?.error?.details,
    })
  }
  return payload as T
}

export function fetchGenerationAdapterStatus() {
  return api<GenerationAdapterStatus>('/api/generation-adapters')
}

export function configureGenerationAdapter(capability: GenerationCapability, input: GenerationAdapterConfig) {
  return api<GenerationAdapterStatus>(`/api/generation-adapters/${capability}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export function clearGenerationAdapter(capability: GenerationCapability) {
  return api<GenerationAdapterStatus>(`/api/generation-adapters/${capability}`, { method: 'DELETE' })
}

export function generateAdapterImage(input: {
  projectId: string
  title: string
  prompt: string
  negativePrompt?: string
  size: '1024x1024' | '1536x1024' | '1024x1536'
  quality: 'standard' | 'high'
  budgetUsd: number
  referenceAssetId?: string
}) {
  return api<GenerationResult>('/api/generation/image', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export function generateAdapterSpeech(input: {
  projectId: string
  title: string
  text: string
  voice: string
  format: 'mp3' | 'wav'
  speed: number
  budgetUsd: number
}) {
  return api<GenerationResult>('/api/generation/speech', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export function createAdapterVideoJob(input: {
  projectId: string
  title: string
  prompt: string
  size: '1280x720' | '720x1280' | '1024x1024'
  durationSeconds: number
  budgetUsd: number
  referenceAssetId?: string
}) {
  return api<{ job: ProcessingJob; reused: boolean }>('/api/jobs/provider-video', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `provider-video-${crypto.randomUUID()}` },
    body: JSON.stringify(input),
  })
}

export function fetchGenerationJob(jobId: string) {
  return api<{ job: ProcessingJob }>(`/api/jobs/${encodeURIComponent(jobId)}`)
}

export function cancelGenerationJob(jobId: string) {
  return api<{ job: ProcessingJob }>(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' })
}
