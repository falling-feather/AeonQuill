export const VIDEO_CONTINUITY_GRAPH_SCHEMA_VERSION: 2

export type ContinuityAssetStatus = 'planned' | 'ready' | 'approved'
export type ContinuityShotStatus = 'blocked' | 'candidate-required' | 'ready' | 'approved' | 'retry-required'
export type ContinuityAssetBinding = {
  libraryItemId: string
  libraryVersionId: string
  contentHash: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  scope: 'project' | 'global-reference'
  boundAt: number
}
export type ContinuityAssetSlot = { status: ContinuityAssetStatus; asset: ContinuityAssetBinding | null }
export type ContinuityVideoBinding = {
  libraryItemId: string
  libraryVersionId: string
  contentHash: string
  mimeType: 'video/mp4' | 'video/webm'
  scope: 'project' | 'global-reference'
  boundAt: number
}
export type ContinuityVideoCandidate = {
  id: string
  shotId: string
  attempt: number
  label: string
  source: 'comfyui-h3' | 'byok-video' | 'imported'
  generationMode: 'fast' | 'quality'
  asset: ContinuityVideoBinding
  inputFingerprint: string
  createdAt: number
}
export type VideoContinuityGraph = {
  kind: 'aeonquill.video-continuity-graph'
  schemaVersion: 2
  storyProjectId: string | null
  storyRevision: number | null
  characters: Array<{ id: string; storyCharacterId: string | null; profileId: string; name: string; identityLock: string; viewIds: string[]; wardrobeIds: string[] }>
  views: Array<ContinuityAssetSlot & { id: string; characterId: string; profileViewId: string; view: 'front' | 'side' | 'back' | 'expression' | 'action'; required: boolean }>
  wardrobes: Array<ContinuityAssetSlot & { id: string; characterId: string; profileWardrobeId: string; label: string; trigger: string }>
  locations: Array<ContinuityAssetSlot & { id: string; storyLocationId: string | null; name: string; visualPrompt: string }>
  frames: Array<ContinuityAssetSlot & { id: string; shotId: string; role: 'first-frame' | 'last-frame'; required: boolean }>
  shots: Array<{
    id: string
    storyShotId: string | null
    sceneId: string | null
    label: string
    locationId: string | null
    characterBindings: Array<{ characterId: string; wardrobeId: string }>
    frameIds: string[]
    candidateIds: string[]
    selectedCandidateId: string | null
    status: ContinuityShotStatus
    latestReviewId: string | null
    inputFingerprint: string
  }>
  candidates: ContinuityVideoCandidate[]
  reviews: Array<{
    id: string
    shotId: string
    candidateId: string | null
    attempt: number
    reviewerId: string
    scores: { identity: number | null; wardrobe: number | null; location: number | null; sharpness: number | null; motion: number | null }
    decision: 'accept' | 'retry'
    notes: string
    reasons: string[]
    recommendedActions: string[]
    inputFingerprint: string
    status: 'active' | 'superseded'
    createdAt: number
  }>
  revision: number
  createdAt: number
  updatedAt: number
}

export class VideoContinuityError extends Error { code: string; details?: unknown }
export function assertContinuityAssetBinding<T extends ContinuityAssetBinding>(binding: T): T
export function assertContinuityVideoBinding<T extends ContinuityVideoBinding>(binding: T): T
export function assertVideoContinuityGraph<T extends VideoContinuityGraph>(graph: T): T
export function migrateVideoContinuityGraph(input: unknown, options?: { now?: number }): VideoContinuityGraph
export function createVideoContinuityGraph(input: {
  story?: unknown | null
  characterProfiles: Array<Record<string, unknown>>
  generationMode?: 'fast' | 'quality'
  characterMode?: 'quick' | 'professional'
  now?: number
  previous?: VideoContinuityGraph | null
}): VideoContinuityGraph
export function bindContinuityAsset(graph: VideoContinuityGraph, targetId: string, binding: ContinuityAssetBinding, options?: { now?: number }): VideoContinuityGraph
export function approveContinuityAsset(graph: VideoContinuityGraph, targetId: string, options?: { now?: number }): VideoContinuityGraph
export function unbindContinuityAsset(graph: VideoContinuityGraph, targetId: string, options?: { now?: number }): VideoContinuityGraph
export function assignContinuityWardrobe(graph: VideoContinuityGraph, shotId: string, characterId: string, wardrobeId: string, options?: { now?: number }): VideoContinuityGraph
export function registerContinuityCandidate(graph: VideoContinuityGraph, candidate: {
  shotId: string
  label: string
  source: ContinuityVideoCandidate['source']
  generationMode: ContinuityVideoCandidate['generationMode']
  inputFingerprint: string
  binding: ContinuityVideoBinding
}, options?: { now?: number }): VideoContinuityGraph
export function selectContinuityCandidate(graph: VideoContinuityGraph, shotId: string, candidateId: string, options?: { now?: number }): VideoContinuityGraph
export function recordContinuityReview(graph: VideoContinuityGraph, review: {
  shotId: string
  reviewerId: string
  scores: { identity: number | null; wardrobe: number | null; location: number | null; sharpness: number | null; motion: number | null }
  decision: 'accept' | 'retry'
  notes: string
}, options?: { now?: number }): VideoContinuityGraph
export function continuityGraphSummary(graph: VideoContinuityGraph): {
  characters: number; locations: number; shots: number; requiredAssets: number; approvedAssets: number
  blockedShots: number; candidateRequiredShots: number; readyShots: number; approvedShots: number; retryShots: number
  candidates: number; currentCandidates: number; staleCandidates: number; selectedCandidates: number; calibrated: false
}
export function continuityAssetProducerReady(graph: VideoContinuityGraph): boolean
export function continuityVideoReviewReady(graph: VideoContinuityGraph): boolean
