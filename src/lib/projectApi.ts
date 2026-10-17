import type { CanvasDocument } from './canvasCore'
import type {
  ApprovedCreativePlan,
  CreativePlanReceipt,
} from './agent/creativePlan.mjs'
import type { ProjectCatalog } from './project'
import { ensureLocalSession } from './videoApi'

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
const workspaceDocumentWriteAttempts = new Map<string, number>()
const workspaceDocumentReadAttempts = new Map<string, number>()
const workspaceDocumentDirty = new Map<string, boolean>()
const workspaceCreativePlanCommits = new Map<string, { catalog: ProjectCatalog; revision: number }>()

function workspaceDocumentAttempt(documentId: string) {
  return workspaceDocumentWriteAttempts.get(documentId) ?? 0
}

function workspaceDocumentReadAttempt(documentId: string) {
  return workspaceDocumentReadAttempts.get(documentId) ?? 0
}

function beginWorkspaceDocumentRead(documentId: string) {
  const attempt = workspaceDocumentReadAttempt(documentId) + 1
  workspaceDocumentReadAttempts.set(documentId, attempt)
  return attempt
}

function markWorkspaceDocumentWriteQueued(documentId: string) {
  const attempt = workspaceDocumentAttempt(documentId) + 1
  workspaceDocumentWriteAttempts.set(documentId, attempt)
  workspaceDocumentDirty.set(documentId, true)
  return attempt
}

function markWorkspaceDocumentAuthoritative(documentId: string, revision: number | null) {
  workspaceDocumentWriteAttempts.set(documentId, workspaceDocumentAttempt(documentId) + 1)
  workspaceDocumentReadAttempts.set(documentId, workspaceDocumentReadAttempt(documentId) + 1)
  workspaceDocumentRevisions.set(documentId, revision)
  workspaceDocumentDirty.set(documentId, false)
}

function markWorkspaceDocumentWriteSucceeded(documentId: string, attempt: number, revision: number) {
  const currentAttempt = workspaceDocumentAttempt(documentId)
  const dirty = workspaceDocumentDirty.get(documentId) === true
  if (attempt !== currentAttempt && !dirty) return
  workspaceDocumentRevisions.set(documentId, revision)
  if (attempt === currentAttempt) workspaceDocumentDirty.set(documentId, false)
}

async function settleWorkspaceDocumentWrites() {
  const pending = [...workspaceDocumentWrites.values()]
  if (pending.length) await Promise.allSettled(pending)
}

export async function initializeWorkspaceModeDocument(input: {
  catalog: ProjectCatalog
  baseRevision: number
  document: Pick<WorkspaceModeDocument, 'projectId' | 'documentId' | 'modeId' | 'revision' | 'value'>
  source?: string
}) {
  const payload = await api<WorkspaceCatalogRecord & { document: WorkspaceModeDocument }>(
    '/api/workspace/documents/initialize',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        catalog: input.catalog,
        baseRevision: input.baseRevision,
        document: input.document,
        source: input.source ?? 'product-shell-create',
      }),
    },
  )
  markWorkspaceDocumentAuthoritative(payload.document.documentId, payload.document.revision)
  return payload
}

export async function loadWorkspaceModeDocument(
  projectId: string,
  documentId: string,
  modeId: WorkspaceModeDocument['modeId'],
) {
  const readAttempt = beginWorkspaceDocumentRead(documentId)
  const writeAttempt = workspaceDocumentAttempt(documentId)
  const cleanAtStart = workspaceDocumentDirty.get(documentId) !== true
  const query = new URLSearchParams({ projectId, modeId })
  const payload = await api<{ document: WorkspaceModeDocument | null }>(
    `/api/workspace/documents/${encodeURIComponent(documentId)}?${query.toString()}`,
  )
  if (cleanAtStart
    && workspaceDocumentDirty.get(documentId) !== true
    && workspaceDocumentAttempt(documentId) === writeAttempt
    && workspaceDocumentReadAttempt(documentId) === readAttempt) {
    workspaceDocumentRevisions.set(documentId, payload.document?.revision ?? null)
  }
  return payload.document
}

export function saveWorkspaceModeDocument(input: {
  projectId: string
  documentId: string
  modeId: WorkspaceModeDocument['modeId']
  revision: number
  value: string | Promise<string>
  reason?: string
  forceRecovery?: boolean
}) {
  const writeAttempt = markWorkspaceDocumentWriteQueued(input.documentId)
  const previous = workspaceDocumentWrites.get(input.documentId)
  const request = (previous ? previous.catch(() => undefined) : Promise.resolve())
    .then(async () => {
      const baseRevision = workspaceDocumentRevisions.has(input.documentId)
        ? workspaceDocumentRevisions.get(input.documentId) ?? null
        : null
      const { documentId, ...body } = input
      const { prepareWorkspaceRequestBody } = await import('./workspaceRequestBody.mjs')
      const value = await body.value
      if (typeof value !== 'string') throw new Error('工作区正文编码结果无效')
      const requestBody = await prepareWorkspaceRequestBody({ ...body, value, baseRevision })
      const payload = await api<{ document: WorkspaceModeDocument }>(
        `/api/workspace/documents/${encodeURIComponent(documentId)}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: requestBody,
        },
      )
      markWorkspaceDocumentWriteSucceeded(documentId, writeAttempt, payload.document.revision)
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

export async function commitWorkspaceCreativePlan(approvedPlan: ApprovedCreativePlan) {
  await flushWorkspaceModeDocument(approvedPlan.plan.documentId)
  const payload = await api<{
    catalog: ProjectCatalog
    document: WorkspaceModeDocument
    receipt: CreativePlanReceipt
    replayed: boolean
  }>('/api/workspace/agent-plans/commit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ approvedPlan }),
  })
  markWorkspaceDocumentAuthoritative(payload.document.documentId, payload.document.revision)
  workspaceCreativePlanCommits.set(payload.document.documentId, {
    catalog: payload.catalog,
    revision: payload.document.revision,
  })
  return payload
}

export function takeWorkspaceCreativePlanCommit(documentId: string) {
  const committed = workspaceCreativePlanCommits.get(documentId) ?? null
  workspaceCreativePlanCommits.delete(documentId)
  return committed
}

export async function listWorkspaceCreativePlanReceipts(
  projectId: string,
  options: { documentId?: string; limit?: number } = {},
) {
  const query = new URLSearchParams()
  if (options.documentId) query.set('documentId', options.documentId)
  if (options.limit !== undefined) query.set('limit', String(options.limit))
  const suffix = query.size ? `?${query.toString()}` : ''
  const payload = await api<{ receipts: CreativePlanReceipt[] }>(
    `/api/workspace/projects/${encodeURIComponent(projectId)}/agent-plan-receipts${suffix}`,
  )
  return payload.receipts
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
  await settleWorkspaceDocumentWrites()
  const payload = await api<{
    restored: WorkspaceCatalogRecord & {
      document: WorkspaceModeDocument | null
      restoredFrom: WorkspaceRecoveryPoint
    }
  }>(`/api/workspace/recovery-points/${encodeURIComponent(recoveryPointId)}/restore`, { method: 'POST' })
  const restoredDocumentId = payload.restored.document?.documentId ?? payload.restored.restoredFrom.documentId
  if (restoredDocumentId) {
    markWorkspaceDocumentAuthoritative(restoredDocumentId, payload.restored.document?.revision ?? null)
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
