import type { LocalVideoCandidateBackfill, LocalVideoCandidateTarget } from './localVideoCandidate.mjs'

export const VIDEO_CHAIN_MANIFEST_SCHEMA_VERSION: 1

export type VideoChainManifestShotStatus = 'planned' | 'queued' | 'completed' | 'reused' | 'failed'

export type VideoChainManifestShot = {
  index: number
  executionItemId: string
  requestHash: string
  candidateTarget: LocalVideoCandidateTarget | null
  childJobId: string | null
  childSubmissionId: string | null
  reusedFromChildJobId: string | null
  status: VideoChainManifestShotStatus
  localCandidateBackfill: LocalVideoCandidateBackfill | null
  error: { code: string; message: string } | null
  updatedAt: number
}

export type VideoChainManifest = {
  schemaVersion: 1
  projectId: string
  createdAt: number
  shots: VideoChainManifestShot[]
}

export class VideoChainManifestError extends Error {
  code: string
  details?: unknown
}

export function assertVideoChainManifest<T extends VideoChainManifest>(manifest: T): T
export function createVideoChainManifest(input: {
  projectId: string
  shots: Array<{
    executionItemId: string
    requestHash: string
    candidateTarget?: LocalVideoCandidateTarget
  }>
  now: number
}): VideoChainManifest
export function transitionVideoChainManifestShot(
  manifest: VideoChainManifest,
  index: number,
  patch: Partial<Pick<VideoChainManifestShot,
    | 'status'
    | 'childJobId'
    | 'childSubmissionId'
    | 'reusedFromChildJobId'
    | 'localCandidateBackfill'
    | 'error'>>,
  options?: { now?: number },
): VideoChainManifest
