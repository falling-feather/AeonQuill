import type { CanvasDocument } from './canvasCore'
import type { ProjectCatalog } from './project'
import {
  assertGenerationPlan,
  assertStoryProject,
  type GenerationPlan,
  type StoryProject,
} from './story/storyProject.mjs'
import {
  createVideoProductionProjectForStory,
  migrateVideoProductionProject,
  type VideoProductionProject,
} from './story/productionPipeline.mjs'
import { ensureLocalSession } from './videoApi'

export const SMART_VIDEO_DOCUMENT_SCHEMA_VERSION = 2

export class ProjectApiError extends Error {
  code?: string
  status: number
  details?: unknown

  constructor(message: string, options: { code?: string; status: number; details?: unknown }) {
    super(message)
    this.name = 'ProjectApiError'
    this.code = options.code
    this.status = options.status
    this.details = options.details
  }
}

const TRANSIENT_GET_RETRY_DELAYS_MS = [80, 240] as const

function delay(durationMs: number) {
  return new Promise<void>((resolvePromise) => window.setTimeout(resolvePromise, durationMs))
}

async function fetchProjectApi(path: string, options?: RequestInit) {
  const method = String(options?.method || 'GET').toUpperCase()
  const delays = method === 'GET' ? TRANSIENT_GET_RETRY_DELAYS_MS : []
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetch(path, { ...options, credentials: 'same-origin' })
    } catch (error) {
      if (options?.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError') || attempt >= delays.length) {
        throw error
      }
      await delay(delays[attempt])
    }
  }
}

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
  const response = await fetchProjectApi(path, options)
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new ProjectApiError(payload?.error?.message || `项目存储返回 HTTP ${response.status}`, {
      code: payload?.error?.code,
      status: response.status,
      details: payload?.error?.details,
    })
  }
  return payload as T
}

export type WorkspaceCatalogRecord = {
  catalog: ProjectCatalog
  updatedAt: number
}

export type WorkspaceModeDocument = {
  projectId: string
  documentId: string
  modeId: 'balanced' | 'pixel' | 'smart-video'
  revision: number
  value: string
  createdAt: number
  updatedAt: number
}

export type WorkspaceRecoveryPoint = {
  id: string
  projectId: string
  documentId?: string
  modeId?: WorkspaceModeDocument['modeId']
  catalogRevision: number
  documentRevision?: number
  reason: string
  createdAt: number
}

export type ProjectPackagePreview = {
  format: 'aeonquill-project' | 'legacy-miaohui-canvas'
  packageSchemaVersion: number | null
  complete: boolean
  project: {
    id: string
    title: string
    initialModeId: WorkspaceModeDocument['modeId']
    status: string
  }
  documents: {
    total: number
    byMode: Record<WorkspaceModeDocument['modeId'], number>
    bodiesByMode: Record<WorkspaceModeDocument['modeId'], number>
    missingBodies: string[]
    missingBalancedMetadata: string[]
  }
  recoveryPoints: number
  library: {
    collections: number
    projectItems: number
    globalReferences: number
    versions: number
  }
  assets: { count: number; bytes: number }
  rawBytes: number | null
  archiveBytes: number | null
  warnings: string[]
  conflicts?: Array<{ kind: 'project' | 'document'; id: string }>
}

export type ProjectPackageImportResult = {
  legacy: boolean
  preview: ProjectPackagePreview
  catalog: ProjectCatalog
  project: ProjectCatalog['projects'][number]
  documents: WorkspaceModeDocument[]
  idMap: {
    projectId: Record<string, string>
    documentIds: Record<string, string>
    libraryItemIds: Record<string, string>
    collectionIds: Record<string, string>
  }
}

export type SmartVideoDocument = {
  schemaVersion: typeof SMART_VIDEO_DOCUMENT_SCHEMA_VERSION
  project: StoryProject
  plan: GenerationPlan
  production: VideoProductionProject
}

export function serializeSmartVideoDocument(input: { project: StoryProject; plan: GenerationPlan; production?: VideoProductionProject }) {
  const project = assertStoryProject(input.project)
  const plan = assertGenerationPlan(input.plan, project)
  const production = input.production
    ? migrateVideoProductionProject(input.production, { story: project })
    : createVideoProductionProjectForStory(project)
  return JSON.stringify({ schemaVersion: SMART_VIDEO_DOCUMENT_SCHEMA_VERSION, project, plan, production })
}

export function deserializeSmartVideoDocument(serialized: string): SmartVideoDocument {
  let value: unknown
  try {
    value = JSON.parse(serialized)
  } catch {
    throw new Error('智能视频项目正文不是有效 JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('智能视频项目正文必须是对象')
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort().join(',')
  const isLegacy = record.schemaVersion === 1 && keys === 'plan,project,schemaVersion'
  const isCurrent = record.schemaVersion === SMART_VIDEO_DOCUMENT_SCHEMA_VERSION && keys === 'plan,production,project,schemaVersion'
  if (!isLegacy && !isCurrent) {
    throw new Error('智能视频项目正文版本或字段不受支持')
  }
  const project = assertStoryProject(record.project as StoryProject)
  const plan = assertGenerationPlan(record.plan as GenerationPlan, project)
  const production = isLegacy
    ? createVideoProductionProjectForStory(project)
    : migrateVideoProductionProject(record.production, { story: project })
  return { schemaVersion: SMART_VIDEO_DOCUMENT_SCHEMA_VERSION, project, plan, production }
}

export async function loadWorkspaceCatalog() {
  return api<WorkspaceCatalogRecord>('/api/workspace/catalog')
}

export async function saveWorkspaceCatalog(catalog: ProjectCatalog, baseRevision: number, source = 'product-shell') {
  return api<WorkspaceCatalogRecord>('/api/workspace/catalog', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ catalog, baseRevision, source }),
  })
}

const workspaceDocumentRevisions = new Map<string, number | null>()
const workspaceDocumentWrites = new Map<string, Promise<WorkspaceModeDocument>>()

export async function loadWorkspaceModeDocument(
  projectId: string,
  documentId: string,
  modeId: WorkspaceModeDocument['modeId'],
) {
  const query = new URLSearchParams({ projectId, modeId })
  const payload = await api<{ document: WorkspaceModeDocument | null }>(
    `/api/workspace/documents/${encodeURIComponent(documentId)}?${query.toString()}`,
  )
  workspaceDocumentRevisions.set(documentId, payload.document?.revision ?? null)
  return payload.document
}

export function saveWorkspaceModeDocument(input: {
  projectId: string
  documentId: string
  modeId: WorkspaceModeDocument['modeId']
  revision: number
  value: string
  reason?: string
  forceRecovery?: boolean
}) {
  const previous = workspaceDocumentWrites.get(input.documentId)
  const request = (previous ? previous.catch(() => undefined) : Promise.resolve())
    .then(async () => {
      const baseRevision = workspaceDocumentRevisions.has(input.documentId)
        ? workspaceDocumentRevisions.get(input.documentId) ?? null
        : null
      const { documentId, ...body } = input
      const payload = await api<{ document: WorkspaceModeDocument }>(
        `/api/workspace/documents/${encodeURIComponent(documentId)}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, baseRevision }),
        },
      )
      workspaceDocumentRevisions.set(documentId, payload.document.revision)
      return payload.document
    })
  workspaceDocumentWrites.set(input.documentId, request)
  void request.finally(() => {
    if (workspaceDocumentWrites.get(input.documentId) === request) workspaceDocumentWrites.delete(input.documentId)
  }).catch(() => undefined)
  return request
}

export async function flushWorkspaceModeDocument(documentId: string) {
  const pending = workspaceDocumentWrites.get(documentId)
  if (pending) await pending
}

export async function listWorkspaceRecoveryPoints(projectId: string) {
  const payload = await api<{ recoveryPoints: WorkspaceRecoveryPoint[] }>(
    `/api/workspace/projects/${encodeURIComponent(projectId)}/recovery-points`,
  )
  return payload.recoveryPoints
}

export async function createWorkspaceRecoveryPoint(projectId: string, options: { documentId?: string; reason?: string } = {}) {
  const payload = await api<{ recoveryPoint: WorkspaceRecoveryPoint }>(
    `/api/workspace/projects/${encodeURIComponent(projectId)}/recovery-points`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(options),
    },
  )
  return payload.recoveryPoint
}

export async function restoreWorkspaceRecoveryPoint(recoveryPointId: string) {
  const payload = await api<{
    restored: WorkspaceCatalogRecord & {
      document: WorkspaceModeDocument | null
      restoredFrom: WorkspaceRecoveryPoint
    }
  }>(`/api/workspace/recovery-points/${encodeURIComponent(recoveryPointId)}/restore`, { method: 'POST' })
  if (payload.restored.document) {
    workspaceDocumentRevisions.set(payload.restored.document.documentId, payload.restored.document.revision)
  }
  return payload
}

export async function previewWorkspaceProjectPackage(projectId: string) {
  const payload = await api<{ preview: ProjectPackagePreview }>(
    `/api/workspace/projects/${encodeURIComponent(projectId)}/package/preview`,
  )
  return payload.preview
}

export async function downloadWorkspaceProjectPackage(projectId: string) {
  await ensureLocalSession()
  const response = await fetch(
    `/api/workspace/projects/${encodeURIComponent(projectId)}/package`,
    { credentials: 'same-origin' },
  )
  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    throw new ProjectApiError(payload?.error?.message || `完整项目包导出返回 HTTP ${response.status}`, {
      code: payload?.error?.code,
      status: response.status,
      details: payload?.error?.details,
    })
  }
  return response.blob()
}

export async function previewWorkspaceProjectPackageFile(file: Blob) {
  await ensureLocalSession()
  const response = await fetch('/api/workspace/packages/preview', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/octet-stream' },
    body: file,
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new ProjectApiError(payload?.error?.message || `项目包预检返回 HTTP ${response.status}`, {
      code: payload?.error?.code,
      status: response.status,
      details: payload?.error?.details,
    })
  }
  return (payload as { preview: ProjectPackagePreview }).preview
}

export async function importWorkspaceProjectPackage(
  file: Blob,
  options: { conflictPolicy?: 'reject' | 'copy'; projectId?: string } = {},
) {
  await ensureLocalSession()
  const query = new URLSearchParams({ conflictPolicy: options.conflictPolicy ?? 'reject' })
  if (options.projectId) query.set('projectId', options.projectId)
  const response = await fetch(`/api/workspace/packages/import?${query.toString()}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/octet-stream' },
    body: file,
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new ProjectApiError(payload?.error?.message || `项目包导入返回 HTTP ${response.status}`, {
      code: payload?.error?.code,
      status: response.status,
      details: payload?.error?.details,
    })
  }
  return (payload as { result: ProjectPackageImportResult }).result
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
