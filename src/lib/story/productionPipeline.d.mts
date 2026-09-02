import type { FrameStrategy, StoryAspectRatio, StorySourceKind } from './storyProject.mjs'
import type { VideoContinuityGraph } from './continuityGraph.mjs'

export const VIDEO_PRODUCTION_SCHEMA_VERSION: 3
export const VIDEO_PRODUCTION_COMMAND_SCHEMA_VERSION: 1
export const VIDEO_PRODUCTION_LIMITS: Readonly<{
  maxBriefCharacters: number
  maxInstructionCharacters: number
  maxOutputCharacters: number
  maxDurationMinutes: number
  maxEvents: number
  maxChangeCards: number
  maxCharacters: number
}>

export type VideoGenerationMode = 'fast' | 'quality'
export type VideoCharacterMode = 'quick' | 'professional'

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
  schemaVersion: 3
  id: string
  title: string
  brief: string
  settings: {
    durationMinutes: number
    genre: string
    aspectRatio: StoryAspectRatio
    generationMode: VideoGenerationMode
    characterMode: VideoCharacterMode
    recommendation: {
      generationMode: VideoGenerationMode
      characterMode: VideoCharacterMode
      reasons: string[]
    }
  }
  estimates: {
    sceneCount: number
    shotCount: number
    batchCount: number
    generationMinutesLow: number
    generationMinutesHigh: number
  }
  nodes: VideoProductionNode[]
  characterProfiles: Array<{
    id: string
    storyCharacterId: string | null
    name: string
    role: string
    mode: VideoCharacterMode
    status: 'draft' | 'review' | 'approved' | 'revision'
    identityLock: string
    views: Array<{ id: string; view: 'front' | 'side' | 'back' | 'expression' | 'action'; status: 'planned' | 'ready' | 'approved'; assetVersionId: string | null }>
    wardrobeStates: Array<{ id: string; label: string; trigger: string; status: 'planned' | 'ready' | 'approved'; assetVersionId: string | null }>
    revision: number
    updatedAt: number
  }>
  continuityGraph: VideoContinuityGraph
  changeCards: Array<{
    id: string
    nodeId: string
    baseNodeRevision: number
    status: 'proposed' | 'accepted' | 'rejected' | 'superseded'
    source: 'deterministic-local' | 'byok-text'
    title: string
    rationale: string
    proposedInstructions: string | null
    proposedOutputSummary: string | null
    createdAt: number
    resolvedAt: number | null
  }>
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
  | 'proposal.create' | 'proposal.accept' | 'proposal.reject'
  | 'continuity.asset.bind' | 'continuity.asset.approve' | 'continuity.asset.unbind'
  | 'continuity.wardrobe.assign' | 'continuity.review.record'

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
  generationMode?: VideoGenerationMode
  characterMode?: VideoCharacterMode
  now?: number
}): VideoProductionProject
export function createVideoProductionProjectForStory(story: unknown, options?: {
  genre?: string
  generationMode?: VideoGenerationMode
  characterMode?: VideoCharacterMode
  now?: number
}): VideoProductionProject
export function recommendProductionProfiles(input?: {
  durationMinutes?: number
  genre?: string
  brief?: string
}): { generationMode: VideoGenerationMode; characterMode: VideoCharacterMode; reasons: string[] }
export function serializeVideoProductionProject(project: VideoProductionProject, options?: { pretty?: boolean }): string
export function deserializeVideoProductionProject(serialized: string): VideoProductionProject
export function migrateVideoProductionProject(input: unknown, options?: { now?: number; story?: unknown }): VideoProductionProject
export function synchronizeVideoProductionProjectForStory(project: VideoProductionProject | unknown, story: unknown, options?: { now?: number }): VideoProductionProject
export function assertVideoProductionCommand<T extends VideoProductionCommand>(command: T, project?: VideoProductionProject): T
export function createVideoProductionCommand(
  project: VideoProductionProject,
  type: VideoProductionCommandType,
  payload?: Record<string, unknown>,
  options?: { id?: string; actor?: 'user' | 'orchestrator' },
): VideoProductionCommand
export function createVideoProductionProposalCommand(
  project: VideoProductionProject,
  nodeId: string,
  proposal: {
    source?: 'deterministic-local' | 'byok-text'
    title: string
    rationale: string
    proposedInstructions?: string | null
    proposedOutputSummary?: string | null
  },
  options?: { id?: string; actor?: 'user' | 'orchestrator' },
): VideoProductionCommand
export function applyVideoProductionCommand(
  project: VideoProductionProject,
  command: VideoProductionCommand,
  options?: { now?: number },
): VideoProductionProject
export function advanceVideoProduction(project: VideoProductionProject, options?: { now?: number }): VideoProductionProject
export function createLocalAgentProposal(project: VideoProductionProject, nodeId: string): {
  source: 'deterministic-local'
  title: string
  rationale: string
  proposedInstructions: string
  proposedOutputSummary: string
}
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
