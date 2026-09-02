import { ensureLocalSession } from './videoApi'

export type WorkflowArtifactStatus = {
  id: string
  kind: 'model' | 'manual-extension' | 'manual-model-set'
  label: string
  bytes: number | null
  relativePath: string | null
  sourceUrl: string
  licenseId: string
  expectedSha256: string | null
  automatic: boolean
  instruction?: string
  present: boolean
  verified: boolean
  contentHash: string | null
  location: null | {
    rootId: string
    rootLabel: string
    source: 'configured-runtime' | 'extra-model-path'
    category: string
    shared: boolean
    portable: boolean
    referenceCount: number
  }
  status: 'runtime-unconfigured' | 'missing' | 'wrong-kind' | 'size-mismatch' | 'verified' | 'present-unverified' | 'present-manual' | 'manual-required'
}

export type WorkflowPackLicense = {
  id: string
  name: string
  spdx: string | null
  acceptanceRequired: boolean
  commercialUse: string
  redistribution: string
  sourceUrl: string
  notice: string
}

export type WorkflowInstallJob = {
  id: string
  packId: string
  status: 'queued' | 'running' | 'waiting-user' | 'completed' | 'failed' | 'cancelled'
  phase: string
  progress: number
  downloadedBytes: number
  totalBytes: number
  currentArtifactId: string | null
  manualMissing?: Array<{ id: string; label: string; instruction?: string; sourceUrl: string }>
  error?: { code: string; message: string; details?: unknown } | null
  createdAt: number
  updatedAt: number
  completedAt?: number
}

export type WorkflowPack = {
  id: string
  version: string
  category: 'video' | 'video-postprocess' | 'image' | string
  title: string
  summary: string
  capabilities: string[]
  maturity: 'production' | 'candidate' | 'preview' | 'experimental' | string
  minVramGb: number
  recommendedVramGb: number
  minSystemRamGb: number
  estimatedMinutes: string
  runtime: { minComfy?: string; python?: string; torchCudaFloor?: number; cuda?: string }
  license: WorkflowPackLicense
  artifacts: WorkflowArtifactStatus[]
  requiredNodes: string[]
  sourceUrl: string
  downloadBytes: number
  fullDownloadBytes: number
  requiredLicenseIds: string[]
  acceptedLicense: boolean
  enabled: boolean
  installed: boolean
  integrityVerified: boolean
  ready: boolean
  status: 'uninstalled' | 'installed-disabled' | 'enabled-sleeping' | 'waking' | 'executable' | 'error'
  missingArtifacts: string[]
  unverifiedArtifacts: string[]
  missingNodes: string[]
  runtimeIssues: string[]
  runtimeConnected: boolean
  lifecycleState: string
  recommendation: { level: 'unknown' | 'blocked' | 'caution' | 'recommended' | 'compatible'; label: string }
  activeJob: WorkflowInstallJob | null
}

export type CustomWorkflowMappingRole = 'prompt' | 'negativePrompt' | 'sourceImage' | 'lastFrame' | 'seed' | 'width' | 'height' | 'frames' | 'steps' | 'output'
export type CustomWorkflowMappings = Partial<Record<CustomWorkflowMappingRole, { nodeId: string; inputName?: string }>>

export type CustomWorkflowInspection = {
  version: string
  hash: string
  nodeCount: number
  nodeTypes: string[]
  models: string[]
  mappings: CustomWorkflowMappings | null
  candidates: {
    inputs: Array<{ nodeId: string; nodeType: string; inputName: string; valueType: string }>
    outputs: Array<{ nodeId: string; nodeType: string }>
  }
  findings: Array<{ severity: 'error' | 'warning' | 'info'; code: string; message: string }>
  canImport: boolean
  runtimeRecheckRequired?: boolean
}

export type CustomWorkflowSummary = {
  id: string
  title: string
  version: number
  hash: string
  nodeCount: number
  nodeTypes: string[]
  models: string[]
  mappings: CustomWorkflowMappings
  enabled: boolean
  source: 'user-api-json'
  createdAt: number
  updatedAt: number
}

export type WorkflowCenterCatalog = {
  version: string
  checkedAt: number
  storage: { configured: boolean; location: 'runtime-registry' | 'not-configured'; modelRoots: number; sharedRoots: number }
  hardware: { device: string | null; vramTotal: number; vramGb: number | null }
  runtime: { connected: boolean; comfyVersion: string | null; pytorchVersion: string | null; lifecycle: { state?: string; lastError?: string | null } | null }
  registry: {
    version: string
    registryHash: string | null
    configured: boolean
    python: { exists: boolean } | null
    runtimePackageId: string | null
    configFiles: Array<{ status: 'loaded' | 'missing' | 'invalid'; sha256?: string; error: string | null; code?: string }>
    modelRoots: Array<{ id: string; category: string; label: string; source: string; exists: boolean; shared: boolean; portable: boolean; isDefault: boolean }>
    nodeRoots: Array<{ id: string; category: string; label: string; source: string; exists: boolean; shared: boolean; portable: boolean; isDefault: boolean }>
    sharedRoots: Array<{ id: string; category: string; label: string; source: string; exists: boolean; shared: boolean; portable: boolean; isDefault: boolean }>
    warnings: Array<{ code: string; message: string; rootId?: string }>
  }
  packs: WorkflowPack[]
  customWorkflows: CustomWorkflowSummary[]
  jobs: WorkflowInstallJob[]
}

export class WorkflowCenterApiError extends Error {
  status: number
  code: string
  details?: unknown

  constructor(message: string, status: number, code: string, details?: unknown) {
    super(message)
    this.name = 'WorkflowCenterApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  await ensureLocalSession()
  const response = await fetch(path, { ...options, credentials: 'same-origin' })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new WorkflowCenterApiError(
      payload?.error?.message || `工作流中心返回 HTTP ${response.status}`,
      response.status,
      payload?.error?.code || 'WORKFLOW_CENTER_REQUEST_FAILED',
      payload?.error?.details,
    )
  }
  return payload as T
}

function jsonRequest(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

export function fetchWorkflowCenterCatalog(refresh = false) {
  return api<WorkflowCenterCatalog>(`/api/workflow-center/catalog${refresh ? '?refresh=1' : ''}`)
}

export async function installWorkflowPack(pack: WorkflowPack, acceptedLicenseIds: string[]) {
  const payload = await api<{ job: WorkflowInstallJob }>(
    `/api/workflow-center/packs/${encodeURIComponent(pack.id)}/install`,
    jsonRequest({ acceptedLicenseIds, acknowledgedDiskBytes: pack.downloadBytes }),
  )
  return payload.job
}

export async function cancelWorkflowInstall(jobId: string) {
  const payload = await api<{ job: WorkflowInstallJob }>(
    `/api/workflow-center/jobs/${encodeURIComponent(jobId)}/cancel`,
    jsonRequest({}),
  )
  return payload.job
}

export async function enableWorkflowPack(packId: string) {
  const payload = await api<{ result: { packId: string; enabled: true; restartRecommended: boolean } }>(
    `/api/workflow-center/packs/${encodeURIComponent(packId)}/enable`,
    jsonRequest({}),
  )
  return payload.result
}

export async function disableWorkflowPack(packId: string) {
  const payload = await api<{ result: { packId: string; enabled: false } }>(
    `/api/workflow-center/packs/${encodeURIComponent(packId)}/disable`,
    jsonRequest({}),
  )
  return payload.result
}

export async function inspectCustomWorkflow(workflow: unknown, mappings: CustomWorkflowMappings) {
  const payload = await api<{ inspection: CustomWorkflowInspection }>(
    '/api/workflow-center/custom/inspect',
    jsonRequest({ workflow, mappings }),
  )
  return payload.inspection
}

export async function importCustomWorkflow(title: string, workflow: unknown, mappings: CustomWorkflowMappings) {
  const payload = await api<{ customWorkflow: CustomWorkflowSummary }>(
    '/api/workflow-center/custom',
    jsonRequest({ title, workflow, mappings }),
  )
  return payload.customWorkflow
}

export async function setCustomWorkflowEnabled(customId: string, enabled: boolean) {
  const payload = await api<{ customWorkflow: CustomWorkflowSummary }>(
    `/api/workflow-center/custom/${encodeURIComponent(customId)}/enabled`,
    jsonRequest({ enabled }),
  )
  return payload.customWorkflow
}

export async function removeCustomWorkflow(customId: string) {
  const response = await api<{ result: { id: string; removed: true } }>(
    `/api/workflow-center/custom/${encodeURIComponent(customId)}`,
    { method: 'DELETE' },
  )
  return response.result
}
