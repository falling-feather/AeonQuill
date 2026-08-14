import type {
  ImageJobRequest,
  ImageToolManifest,
  ProcessingJob,
} from '../types'
import { ensureLocalSession } from './videoApi'

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  await ensureLocalSession()
  const response = await fetch(path, { ...options, credentials: 'same-origin' })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(payload?.error?.message || `本地图像服务返回 HTTP ${response.status}`)
  }
  return payload as T
}

export function fetchImageTools(refresh = false) {
  return api<ImageToolManifest>(`/api/image-tools${refresh ? '?refresh=1' : ''}`)
}

export async function normalizeImageSource(source: string) {
  if (source.startsWith('data:')) return source
  const response = await fetch(source, { credentials: 'same-origin' })
  if (!response.ok) throw new Error('无法读取选中的画布图片')
  const blob = await response.blob()
  if (!blob.type.startsWith('image/')) throw new Error('当前画布资源不是可处理的图片')
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('无法编码图片输入'))
    reader.readAsDataURL(blob)
  })
}

export async function createImageJob(request: ImageJobRequest) {
  const payload = await api<{ job: ProcessingJob }>('/api/jobs/image', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `image-${crypto.randomUUID()}`,
    },
    body: JSON.stringify(request),
  })
  return payload.job
}
