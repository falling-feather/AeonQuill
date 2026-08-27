import type { VideoProductionProject } from './story/productionPipeline.mjs'
import { ensureLocalSession } from './videoApi'

export type AgentAdapterStatus = {
  text: {
    configured: false
    persistence: 'memory-only'
  } | {
    configured: true
    persistence: 'memory-only'
    providerLabel: string
    endpointLabel: string
    model: string
    jsonMode: 'json-object' | 'prompt-only'
    timeoutMs: number
    configuredAt: number
  }
}

export type AgentProposalResult = {
  proposal: {
    source: 'byok-text'
    title: string
    rationale: string
    proposedInstructions: string | null
    proposedOutputSummary: string | null
  }
  adapter: {
    providerLabel: string
    model: string
    persistence: 'memory-only'
  }
  usage: { promptTokens: number | null; completionTokens: number | null; totalTokens: number | null } | null
  elapsedMs: number
}

export class AgentAdapterApiError extends Error {
  status: number
  code?: string
  details?: unknown

  constructor(message: string, options: { status: number; code?: string; details?: unknown }) {
    super(message)
    this.name = 'AgentAdapterApiError'
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
    throw new AgentAdapterApiError(payload?.error?.message || `智能体接口返回 HTTP ${response.status}`, {
      status: response.status,
      code: payload?.error?.code,
      details: payload?.error?.details,
    })
  }
  return payload as T
}

export function fetchAgentAdapterStatus() {
  return api<AgentAdapterStatus>('/api/agent-adapters')
}

export function configureTextAgentAdapter(input: {
  providerLabel: string
  endpoint: string
  model: string
  apiKey: string
  jsonMode: 'json-object' | 'prompt-only'
  timeoutMs: number
}) {
  return api<AgentAdapterStatus>('/api/agent-adapters/text', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export function clearTextAgentAdapter() {
  return api<AgentAdapterStatus>('/api/agent-adapters/text', { method: 'DELETE' })
}

export function requestAgentProposal(project: VideoProductionProject, nodeId: string) {
  return api<AgentProposalResult>('/api/agent-proposals', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project, nodeId }),
  })
}
