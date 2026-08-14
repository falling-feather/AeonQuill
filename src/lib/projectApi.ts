import type { CanvasDocument } from './canvasCore'
import { ensureLocalSession } from './videoApi'

export type ProjectAssetSummary = {
  id: string
  mimeType: string
  extension: string
  bytes: number
  provenance: Record<string, unknown>
  createdAt: number
  url: string
}

export type StoredProject = {
  id: string
  title: string
  schemaVersion: number
  revision: number
  document: CanvasDocument
  createdAt: number
  updatedAt: number
  assets: ProjectAssetSummary[]
  assetVersions: Array<{
    id: string
    logicalAssetId: string
    version: number
    assetId: string
    parentVersionId?: string
    sourceElementId?: string
    provenance: Record<string, unknown>
    createdAt: number
  }>
}

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  await ensureLocalSession()
  const response = await fetch(path, { ...options, credentials: 'same-origin' })
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new Error(payload?.error?.message || `项目存储返回 HTTP ${response.status}`)
  return payload as T
}

export async function saveLocalProject(document: CanvasDocument) {
  const payload = await api<{ project: StoredProject }>('/api/projects/current', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ document }),
  })
  return payload.project
}

export async function loadLocalProject(projectId = 'local-project') {
  const payload = await api<{ project: StoredProject | null }>(
    `/api/projects/current?id=${encodeURIComponent(projectId)}`,
  )
  return payload.project
}

export async function collectLocalProjectGarbage() {
  return api<{ removed: string[] }>('/api/projects/gc', { method: 'POST' })
}

export async function downloadLocalProjectPackage(projectId = 'local-project') {
  await ensureLocalSession()
  const response = await fetch(
    `/api/projects/current/package?id=${encodeURIComponent(projectId)}`,
    { credentials: 'same-origin' },
  )
  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    throw new Error(payload?.error?.message || `项目包导出返回 HTTP ${response.status}`)
  }
  return response.blob()
}

export async function importLocalProjectPackage(file: Blob, projectId = 'local-project') {
  await ensureLocalSession()
  const response = await fetch(
    `/api/projects/import?projectId=${encodeURIComponent(projectId)}`,
    {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/vnd.miaohui.project' },
      body: file,
    },
  )
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new Error(payload?.error?.message || `项目包导入返回 HTTP ${response.status}`)
  return (payload as { project: StoredProject }).project
}
