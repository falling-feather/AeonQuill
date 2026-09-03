import type { VideoProductionProject } from './story/productionPipeline.mjs'
import type { CreativePlan } from './agent/creativePlan.mjs'
import type { VideoSupervisorDecision } from './story/videoSupervisor.mjs'
import { ensureLocalSession } from './videoApi'

export const AGENT_ADAPTER_STATUS_EVENT = 'aeonquill:agent-adapter-status'

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

export type CreativePlanComposeResult = {
  plan: CreativePlan
  preview: {
    schemaVersion: 1
    planId: string
    modeId: 'balanced' | 'pixel' | 'smart-video'
    baseRevision: number
    resultRevision: number
    summaries: Array<{ stepId: string; toolId: string; summary: string }>
  }
  adapter: {
    providerLabel: string
    model: string
    persistence: 'memory-only'
  }
  usage: { promptTokens: number | null; completionTokens: number | null; totalTokens: number | null } | null
  elapsedMs: number
  contextDisclosure: {
    schemaVersion: 1
    contextBytes: number
    includes: string[]
    excludes: string[]
  }
}

export type VideoSupervisorTurnResult = {
  schemaVersion: 1
  decision: VideoSupervisorDecision
  plan: CreativePlan | null
  preview: CreativePlanComposeResult['preview'] | null
  adapter: CreativePlanComposeResult['adapter'] | null
  usage: CreativePlanComposeResult['usage']
  elapsedMs: number
  contextDisclosure: CreativePlanComposeResult['contextDisclosure'] | null
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

function broadcastAgentAdapterStatus(status: AgentAdapterStatus) {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<AgentAdapterStatus>(AGENT_ADAPTER_STATUS_EVENT, { detail: status }))
  }
  return status
}

export async function configureTextAgentAdapter(input: {
  providerLabel: string
  endpoint: string
  model: string
  apiKey: string
  jsonMode: 'json-object' | 'prompt-only'
  timeoutMs: number
}) {
  const status = await api<AgentAdapterStatus>('/api/agent-adapters/text', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  return broadcastAgentAdapterStatus(status)
}

export async function clearTextAgentAdapter() {
  const status = await api<AgentAdapterStatus>('/api/agent-adapters/text', { method: 'DELETE' })
  return broadcastAgentAdapterStatus(status)
}

export function requestAgentProposal(project: VideoProductionProject, nodeId: string) {
  return api<AgentProposalResult>('/api/agent-proposals', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project, nodeId }),
  })
}

export function requestCreativePlan(input: {
  projectId: string
  documentId: string
  modeId: 'balanced' | 'pixel' | 'smart-video'
  baseRevision: number
  instruction: string
}) {
  return api<CreativePlanComposeResult>('/api/workspace/agent-plans/compose', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export function requestVideoSupervisorTurn(input: {
  projectId: string
  documentId: string
  baseRevision: number
}) {
  return api<VideoSupervisorTurnResult>('/api/workspace/video-supervisor/next', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}
