/** Stable intelligent-video story and task-planning contract. */
export const STORY_PROJECT_SCHEMA_VERSION: 1
export const GENERATION_PLAN_SCHEMA_VERSION: 1

export const STORY_LIMITS: Readonly<{
  maxSourceCharacters: number
  maxTitleCharacters: number
  maxCharacters: number
  maxLocations: number
  maxScenes: number
  maxShotsPerScene: number
  maxShots: number
  maxDialogueLinesPerShot: number
  maxTotalDurationSeconds: number
  maxTasks: number
}>

export const CONTROLLED_WORKFLOW_IDS: Readonly<{
  characterReference: 'aeonquill.character-reference.v1'
  locationReference: 'aeonquill.location-reference.v1'
  shotFrame: 'aeonquill.shot-frame.v1'
  shotVideo: 'aeonquill.video.minimax-h3-i2v.v1'
}>

export type StorySourceKind = 'idea' | 'script'
export type StoryAspectRatio = '16:9' | '9:16' | '1:1'
export type FrameStrategy = 'keyframe' | 'start-end'
export type ConsistencyStatus = 'needs-reference' | 'reference-planned' | 'ready'
export type FrameRole = 'key' | 'start' | 'end'

export type StoryDialogue = {
  speaker: string
  text: string
}

export type StoryShot = {
  id: string
  ordinal: number
  title: string
  action: string
  dialogue: StoryDialogue[]
  characterIds: string[]
  durationSeconds: number
  camera: {
    framing: 'wide' | 'medium' | 'close-up'
    movement: 'locked' | 'push-in' | 'pan' | 'orbit' | 'follow'
  }
  continuityNotes: string
  frameRoles: FrameRole[]
}

export type StoryScene = {
  id: string
  ordinal: number
  heading: string
  summary: string
  locationId: string
  characterIds: string[]
  shots: StoryShot[]
}

export type StoryCharacter = {
  id: string
  name: string
  aliases: string[]
  description: string
  visualPrompt: string
  consistencyStatus: ConsistencyStatus
}

export type StoryLocation = {
  id: string
  name: string
  description: string
  visualPrompt: string
  consistencyStatus: ConsistencyStatus
}

export type StoryProject = {
  schemaVersion: 1
  id: string
  title: string
  revision: number
  createdAt: number
  updatedAt: number
  source: {
    kind: StorySourceKind
    text: string
    language: string
  }
  settings: {
    aspectRatio: StoryAspectRatio
    frameStrategy: FrameStrategy
    defaultShotSeconds: number
    seed: number
  }
  characters: StoryCharacter[]
  locations: StoryLocation[]
  scenes: StoryScene[]
}

export type GenerationTaskStage = 'references' | 'frames' | 'videos'
export type GenerationTaskKind =
  | 'character-reference'
  | 'location-reference'
  | 'shot-frame'
  | 'shot-video'

export type GenerationTask = {
  id: string
  stage: GenerationTaskStage
  kind: GenerationTaskKind
  workflowId: string
  status: 'planned' | 'blocked' | 'ready'
  dependsOn: string[]
  inputs: {
    aspectRatio: StoryAspectRatio
    prompt: string
    negativePrompt: string
    characterIds: string[]
    locationId: string | null
    sceneId: string | null
    shotId: string | null
    frameRole: FrameRole | null
    durationSeconds: number | null
    seed: number
  }
  outputs: Array<{
    role: string
    logicalAssetKey: string
    mimeType: string
  }>
}

export type GenerationPlan = {
  schemaVersion: 1
  id: string
  projectId: string
  projectRevision: number
  createdAt: number
  stages: Array<{
    id: GenerationTaskStage
    label: string
    order: number
  }>
  tasks: GenerationTask[]
}

export type StoryCompileInput = {
  projectId?: string
  title?: string
  kind: StorySourceKind
  text: string
  aspectRatio?: StoryAspectRatio
  frameStrategy?: FrameStrategy
  defaultShotSeconds?: number
  seed?: number
  now?: number
}

export class StoryContractError extends Error {
  code: string
  details?: unknown
  constructor(code: string, message: string, details?: unknown)
}

export function normalizeStoryText(value: string): string
export function assertStoryProject<T extends StoryProject>(project: T): T
export function compileStoryProject(input: StoryCompileInput): StoryProject
export function migrateStoryProject(input: unknown, options?: { now?: number }): StoryProject
export function parseStoryProjectCandidate(candidate: string | unknown): StoryProject
export function createGenerationPlan(project: StoryProject, options?: { now?: number }): GenerationPlan
export function assertGenerationPlan<T extends GenerationPlan>(plan: T, project?: StoryProject): T
