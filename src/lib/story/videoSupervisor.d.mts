import type { VideoProductionNodeStatus, VideoProductionProject } from './productionPipeline.mjs'

export const VIDEO_SUPERVISOR_DECISION_SCHEMA_VERSION: 1

export type VideoSupervisorDecisionStatus =
  | 'project-paused'
  | 'change-card-review'
  | 'node-review'
  | 'node-failed'
  | 'node-paused'
  | 'media-proposed'
  | 'media-running'
  | 'media-review'
  | 'media-failed'
  | 'media-cancelled'
  | 'text-turn-ready'
  | 'runtime-required'
  | 'completed'
  | 'dependency-blocked'

export type VideoSupervisorDecision = {
  schemaVersion: 1
  status: VideoSupervisorDecisionStatus
  action: 'resume-project' | 'review-change-card' | 'review-node' | 'reset-node' | 'resume-node' | 'compose-text-turn' | 'open-runtime' | 'none' | 'resolve-dependency' | 'confirm-media' | 'wait-media' | 'review-media' | 'retry-media'
  node: null | {
    id: string
    order: number
    role: string
    title: string
    purpose: string
    adapter: string
    status: VideoProductionNodeStatus
    revision: number
  }
  pendingCardId: string | null
  modelCallRequired: boolean
  canContinue: boolean
  approvedNodes: number
  totalNodes: number
  message: string
}

export function evaluateVideoSupervisor(project: VideoProductionProject, options?: Record<string, unknown>): VideoSupervisorDecision
export function isVideoSupervisorTextNode(nodeId: string): boolean
