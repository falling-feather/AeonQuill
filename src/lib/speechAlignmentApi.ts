import { ensureLocalSession, fetchVideoJob } from './videoApi'
import type { ProcessingJob, SpeechAlignmentJobRequest } from '../types'
import type { SoundAlignmentCandidate } from './story/soundAlignment.mjs'

export type { SpeechAlignmentJobRequest } from '../types'
export type SpeechAlignmentResult = { candidate: SoundAlignmentCandidate; durationMs: number }

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  await ensureLocalSession()
  const response = await fetch(path, { ...options, credentials: 'same-origin' })
  const body = await response.json()
  if (!response.ok) throw new Error(body?.error?.message || `本地对齐服务返回 HTTP ${response.status}`)
  return body as T
}

export async function createSpeechAlignmentJob(body: SpeechAlignmentJobRequest, signal?: AbortSignal) {
  return (await request<{ job: ProcessingJob }>('/api/jobs/speech-alignment', {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', 'idempotency-key': `speech-alignment-${crypto.randomUUID()}` },
    body: JSON.stringify(body),
  })).job
}

export function fetchSpeechAlignmentResult(jobId: string, signal?: AbortSignal) {
  return request<SpeechAlignmentResult>(`/api/jobs/${encodeURIComponent(jobId)}/alignment`, { signal })
}

function delay(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted()
    const abort = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = window.setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, 500)
    signal.addEventListener('abort', abort, { once: true })
  })
}

export async function waitForSpeechAlignment(jobId: string, signal: AbortSignal, onJob: (job: ProcessingJob) => void) {
  const deadline = Date.now() + 11 * 60_000
  while (Date.now() < deadline) {
    signal.throwIfAborted()
    const job = await fetchVideoJob(jobId)
    signal.throwIfAborted()
    onJob(job)
    if (job.status === 'completed') return fetchSpeechAlignmentResult(jobId, signal)
    if (job.status === 'failed' || job.status === 'cancelled') throw new Error(job.error?.message || '对齐任务已取消')
    await delay(signal)
  }
  throw new Error('等待对齐结果超时，请在任务记录中查看执行状态')
}
