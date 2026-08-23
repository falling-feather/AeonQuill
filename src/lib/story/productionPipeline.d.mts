import type { FrameStrategy, StoryAspectRatio, StorySourceKind } from './storyProject.mjs'

export const VIDEO_PRODUCTION_SCHEMA_VERSION: 1
export const VIDEO_PRODUCTION_COMMAND_SCHEMA_VERSION: 1
export const VIDEO_PRODUCTION_LIMITS: Readonly<{
  maxBriefCharacters: number
  maxInstructionCharacters: number
  maxOutputCharacters: number
  maxDurationMinutes: number
  maxEvents: number
}>

export type VideoProductionNodeStatus = 'waiting' | 'ready' | 'running' | 'paused' | 'review' | 'approved' | 'revision' | 'failed'
export type VideoProductionNode = {
  id: string
  order: number
  role: string
  title: string
  purpose: string
  adapter: string
  status: VideoProductionNodeStatus
  dependsOn: string[]
  instructions: string
  outputSummary: string
  artifact: string
  revision: number
  updatedAt: number
  stale: boolean
  error: string | null
}

export type VideoProductionProject = {
  kind: 'aeonquill.video-production'
  schemaVersion: 1
  id: string
  title: string
  brief: string
  settings: { durationMinutes: number; genre: string; aspectRatio: StoryAspectRatio }
  estimates: {
    sceneCount: number
    shotCount: number
    batchCount: number
    generationMinutesLow: number
    generationMinutesHigh: number
  }
  nodes: VideoProductionNode[]
  globalPaused: boolean
  autoAdvance: boolean
  revision: number
  createdAt: number
  updatedAt: number
  events: Array<{ id: string; at: number; type: string; nodeId: string | null; message: string }>
}

export type VideoProductionCommandType =
  | 'project.patch' | 'project.pause' | 'project.resume'
  | 'node.start' | 'node.pause' | 'node.resume' | 'node.edit'
  | 'node.submit-review' | 'node.approve' | 'node.request-revision' | 'node.fail' | 'node.reset'

export type VideoProductionCommand = {
  schemaVersion: 1
  id: string
  actor: 'user' | 'orchestrator'
  baseRevision: number
  type: VideoProductionCommandType
  payload: Record<string, unknown>
}

export class VideoProductionError extends Error {
  code: string
  details?: unknown
}

export function assertVideoProductionProject<T extends VideoProductionProject>(project: T): T
export function createVideoProductionProject(input?: {
  id?: string
  title?: string
  brief?: string
  durationMinutes?: number
  genre?: string
  aspectRatio?: StoryAspectRatio
  now?: number
}): VideoProductionProject
export function serializeVideoProductionProject(project: VideoProductionProject, options?: { pretty?: boolean }): string
export function deserializeVideoProductionProject(serialized: string): VideoProductionProject
export function assertVideoProductionCommand<T extends VideoProductionCommand>(command: T, project?: VideoProductionProject): T
export function createVideoProductionCommand(
  project: VideoProductionProject,
  type: VideoProductionCommandType,
  payload?: Record<string, unknown>,
  options?: { id?: string; actor?: 'user' | 'orchestrator' },
): VideoProductionCommand
export function applyVideoProductionCommand(
  project: VideoProductionProject,
  command: VideoProductionCommand,
  options?: { now?: number },
): VideoProductionProject
export function advanceVideoProduction(project: VideoProductionProject, options?: { now?: number }): VideoProductionProject
export function productionProgress(project: VideoProductionProject): {
  approved: number
  total: number
  percent: number
  currentNodeId: string | null
  blocker: string | null
}
export function canBridgeProductionToStory(project: VideoProductionProject): boolean
export function createApprovedStorySource(project: VideoProductionProject): {
  title: string
  kind: StorySourceKind
  text: string
  aspectRatio: StoryAspectRatio
  frameStrategy: FrameStrategy
  defaultShotSeconds: number
}
