import type { RuntimeStatus, VideoJobRequest } from '../../types'
import type { GenerationPlan, StoryProject } from './storyProject.mjs'

export const STORY_EXECUTION_SCHEMA_VERSION: 1
export const STORY_EXECUTION_CONFIRMATION_SCHEMA_VERSION: 1
export const MANAGED_FRAME_ASSET_SCHEMA_VERSION: 1
export const CONTROLLED_H3_WORKFLOW_VERSION: 'h3-turbo-v2'

export const STORY_EXECUTION_LIMITS: Readonly<{
  maxItems: number
  maxAssetBindings: number
  maxPromptCharacters: number
  maxAssetPayloadCharacters: number
}>

export const CONTROLLED_H3_WORKFLOW_IDS: Readonly<{
  textToVideo: 'aeonquill.video.minimax-h3-t2v.v1'
  imageToVideo: 'aeonquill.video.minimax-h3-i2v.v1'
}>

export type VideoExecutionMode = 'text-to-video' | 'image-to-video'
export type VideoFrameMode = 'none' | 'first' | 'first-last'
export type VideoExecutionPreset = 'fast' | 'balanced' | 'delivery720' | 'nativeHigh'
export type Sha256AssetVersionId = `sha256:${string}`

export type ExecutionRuntimeSnapshot = {
  bridgeAvailable: boolean
  connected: boolean
  ready: boolean
  lifecycleState: 'stopped' | 'starting' | 'ready' | 'external' | 'stopping' | 'error' | 'unknown'
  lifecyclePolicy: 'persistent' | 'idle' | 'manual' | null
  vramTotalBytes: number | null
  missingNodes: string[]
  missingModels: string[]
  message: string | null
}

export type ManagedFrameAsset = {
  schemaVersion: 1
  bindingId: string
  assetVersionId: Sha256AssetVersionId
  role: 'first-frame' | 'last-frame'
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  status: 'ready' | 'missing'
}

export type VideoExecutionSelection = {
  shotId: string
  mode: VideoExecutionMode
  frameMode: VideoFrameMode
  preset: VideoExecutionPreset
  audio: boolean
  firstFrameBindingId: string | null
  lastFrameBindingId: string | null
}

export type VideoExecutionSelectionRequest = {
  schemaVersion: 1
  selections: VideoExecutionSelection[]
}

export type VideoExecutionBlock = {
  code: string
  message: string
}

export type VideoExecutionChecklistItem = {
  id: string
  ordinal: number
  planTaskId: string
  sceneId: string
  shotId: string
  label: string
  mode: VideoExecutionMode
  frameMode: VideoFrameMode
  workflowId:
    | typeof CONTROLLED_H3_WORKFLOW_IDS.textToVideo
    | typeof CONTROLLED_H3_WORKFLOW_IDS.imageToVideo
  status: 'ready' | 'blocked'
  blocks: VideoExecutionBlock[]
  assetBindings: {
    firstFrame: ManagedFrameAsset | null
    lastFrame: ManagedFrameAsset | null
  }
  request: Omit<VideoJobRequest, 'sourceElementId' | 'sourceImageDataUrl' | 'lastFrameImageDataUrl'>
}

export type VideoExecutionChecklist = {
  schemaVersion: 1
  id: string
  projectId: string
  projectRevision: number
  planId: string
  createdAt: number
  runtime: ExecutionRuntimeSnapshot
  items: VideoExecutionChecklistItem[]
  digest: string
}

export type VideoExecutionConfirmation = {
  schemaVersion: 1
  checklistId: string
  checklistDigest: string
  confirmedAt: number
  confirmedItemIds: string[]
  digest: string
}

export type ManagedAssetPayload = {
  bindingId: string
  assetVersionId: Sha256AssetVersionId
  dataUrl: string
}

export type CompiledVideoSubmission = {
  schemaVersion: 1
  itemId: string
  workflowId:
    | typeof CONTROLLED_H3_WORKFLOW_IDS.textToVideo
    | typeof CONTROLLED_H3_WORKFLOW_IDS.imageToVideo
  idempotencyKey: string
  request: VideoJobRequest
}

export function createExecutionRuntimeSnapshot(
  status: Partial<RuntimeStatus> | null | undefined,
  options?: { bridgeAvailable?: boolean },
): ExecutionRuntimeSnapshot
export function assertExecutionRuntimeSnapshot<T extends ExecutionRuntimeSnapshot>(runtime: T): T
export function assertManagedFrameAsset<T extends ManagedFrameAsset>(asset: T): T
export function assertVideoExecutionSelectionRequest<T extends VideoExecutionSelectionRequest>(request: T): T
export function createVideoExecutionChecklist(
  project: StoryProject,
  plan: GenerationPlan,
  request: VideoExecutionSelectionRequest,
  options: { now: number; runtime: ExecutionRuntimeSnapshot; assets: ManagedFrameAsset[] },
): VideoExecutionChecklist
export function assertVideoExecutionChecklist<T extends VideoExecutionChecklist>(
  checklist: T,
  project?: StoryProject,
  plan?: GenerationPlan,
): T
export function createVideoExecutionConfirmation(
  checklist: VideoExecutionChecklist,
  options: { itemIds: string[]; now: number },
): VideoExecutionConfirmation
export function assertVideoExecutionConfirmation<T extends VideoExecutionConfirmation>(
  confirmation: T,
  checklist: VideoExecutionChecklist,
): T
export function compileConfirmedVideoRequests(
  checklist: VideoExecutionChecklist,
  confirmation: VideoExecutionConfirmation,
  assetPayloads?: ManagedAssetPayload[],
): CompiledVideoSubmission[]
