import { ensureLocalSession } from './videoApi'

export type LibraryScope = 'global' | 'project'
export type LibraryMediaKind = 'image' | 'video' | 'audio'

export type LibraryCollection = {
  id: string
  scope: LibraryScope
  projectId?: string
  title: string
  itemCount?: number
  createdAt?: number
  updatedAt?: number
}

export type LibraryAssetVersion = {
  id: string
  version: number
  assetId: string
  parentVersionId?: string
  provenance: Record<string, unknown>
  createdAt: number
  mimeType: string
  extension: string
  bytes: number
  url: string
}

export type LibraryAsset = {
  id: string
  scope: LibraryScope
  projectId?: string
  title: string
  description: string
  mediaKind: LibraryMediaKind
  sourceItemId?: string
  relationship: 'global' | 'global-reference' | 'project-owned'
  tags: string[]
  collections: LibraryCollection[]
  versionCount: number
  latestVersionId: string
  version: LibraryAssetVersion
  createdAt: number
  updatedAt: number
}

export type LibraryAssetInsertion = {
  nonce: number
  asset: LibraryAsset
}

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  await ensureLocalSession()
  const response = await fetch(path, { ...options, credentials: 'same-origin' })
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new Error(payload?.error?.message || `资源库返回 HTTP ${response.status}`)
  return payload as T
}

export async function listLibraryAssets(input: {
  scope: LibraryScope
  projectId?: string
  query?: string
  tags?: string[]
  collectionId?: string
}) {
  const query = new URLSearchParams({ scope: input.scope })
  if (input.projectId) query.set('projectId', input.projectId)
  if (input.query?.trim()) query.set('q', input.query.trim())
  for (const tag of input.tags ?? []) query.append('tag', tag)
  if (input.collectionId) query.set('collectionId', input.collectionId)
  const payload = await api<{ assets: LibraryAsset[] }>(`/api/library/assets?${query.toString()}`)
  return payload.assets
}

export async function listLibraryCollections(scope: LibraryScope, projectId?: string) {
  const query = new URLSearchParams({ scope })
  if (projectId) query.set('projectId', projectId)
  const payload = await api<{ collections: LibraryCollection[] }>(`/api/library/collections?${query.toString()}`)
  return payload.collections
}

export async function ensureLibraryProject(projectId: string) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const payload = await api<{ catalog: { projects: Array<{ id: string }> } }>('/api/workspace/catalog')
    if (payload.catalog.projects.some(({ id }) => id === projectId)) return
    await new Promise<void>((resolve) => window.setTimeout(resolve, 120 * (attempt + 1)))
  }
  throw new Error('目标项目尚未完成 SQLite 同步，请稍后重试。')
}

export async function createLibraryCollection(input: { scope: LibraryScope; projectId?: string; title: string }) {
  const payload = await api<{ collection: LibraryCollection }>('/api/library/collections', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  return payload.collection
}

export async function importLibraryAsset(input: {
  scope: LibraryScope
  projectId?: string
  title: string
  description?: string
  tags?: string[]
  collectionIds?: string[]
  dataUrl: string
}) {
  const payload = await api<{ asset: LibraryAsset }>('/api/library/assets', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  return payload.asset
}

export async function linkLibraryAssetToProject(assetId: string, projectId: string, versionId?: string) {
  const payload = await api<{ asset: LibraryAsset }>(
    `/api/library/assets/${encodeURIComponent(assetId)}/link-project`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, ...(versionId ? { versionId } : {}) }),
    },
  )
  return payload.asset
}

export async function deriveLibraryAsset(assetId: string, input: {
  projectId: string
  sourceVersionId?: string
  title?: string
  description?: string
  tags?: string[]
  collectionIds?: string[]
  dataUrl?: string
}) {
  const payload = await api<{ asset: LibraryAsset }>(
    `/api/library/assets/${encodeURIComponent(assetId)}/derive`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    },
  )
  return payload.asset
}

export function readLibraryFile(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('无法读取导入文件'))
    reader.readAsDataURL(file)
  })
}
