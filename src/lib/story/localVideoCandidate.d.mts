import type { ProcessingJob } from '../../types'
import type { VideoProductionProject } from './productionPipeline.mjs'

export const LOCAL_VIDEO_CANDIDATE_BINDING_SCHEMA_VERSION: 1
export const LOCAL_VIDEO_CANDIDATE_BACKFILL_SCHEMA_VERSION: 1
export const LOCAL_VIDEO_CANDIDATE_TARGET_SCHEMA_VERSION: 1

export type LocalVideoCandidateJobBinding = {
  schemaVersion: 1
  projectId: string
  documentId: string
  productionId: string
  productionRevision: number
  continuityRevision: number
  storyRevision: number
  shotId: string
  inputFingerprint: string
  generationMode: 'fast' | 'quality'
  executionItemId: string
  submissionId: string
}

export type LocalVideoCandidateTarget = Omit<LocalVideoCandidateJobBinding, 'submissionId'>

export type LocalVideoCandidateBackfill = {
  schemaVersion: 1
  status: 'ready' | 'rejected'
  jobId: string
  binding: LocalVideoCandidateJobBinding
  libraryItemId: string | null
  libraryVersionId: string | null
  contentHash: string | null
  mimeType: 'video/mp4' | null
  code: string | null
  message: string | null
  createdAt: number
}

export class LocalVideoCandidateError extends Error {
  code: string
  details?: unknown
}

export function assertLocalVideoCandidateJobBinding<T extends LocalVideoCandidateJobBinding>(binding: T): T
export function assertLocalVideoCandidateTarget<T extends LocalVideoCandidateTarget>(target: T): T
export function createLocalVideoCandidateTarget(input: {
  projectId: string
  documentId: string
  production: VideoProductionProject
  shotId: string
  executionItemId: string
}): LocalVideoCandidateTarget
export function localVideoCandidateTargetFromBinding(binding: LocalVideoCandidateJobBinding): LocalVideoCandidateTarget
export function localVideoCandidateTargetsEqual(
  left: LocalVideoCandidateTarget,
  right: LocalVideoCandidateTarget,
): boolean
export function localVideoCandidateTargetMatchesBinding(
  target: LocalVideoCandidateTarget,
  binding: LocalVideoCandidateJobBinding,
): boolean
export function materializeLocalVideoCandidateJobBinding(
  target: LocalVideoCandidateTarget,
  input: {
    production: VideoProductionProject
    submissionId: string
    requireTargetRevisions?: boolean
  },
): LocalVideoCandidateJobBinding
export function createLocalVideoCandidateJobBinding(input: {
  projectId: string
  documentId: string
  production: VideoProductionProject
  shotId: string
  executionItemId: string
  submissionId: string
}): LocalVideoCandidateJobBinding
export function retargetLocalVideoCandidateSubmission(
  binding: LocalVideoCandidateJobBinding,
  input: Pick<LocalVideoCandidateJobBinding, 'productionRevision' | 'continuityRevision' | 'storyRevision' | 'inputFingerprint' | 'generationMode' | 'submissionId'>,
): LocalVideoCandidateJobBinding
export function assertLocalVideoCandidateBackfill<T extends LocalVideoCandidateBackfill>(
  backfill: T,
  binding?: LocalVideoCandidateJobBinding,
): T
export function createReadyLocalVideoCandidateBackfill(input: {
  jobId: string
  binding: LocalVideoCandidateJobBinding
  libraryAsset: Record<string, unknown>
  now: number
}): LocalVideoCandidateBackfill
export function createRejectedLocalVideoCandidateBackfill(input: {
  jobId: string
  binding: LocalVideoCandidateJobBinding
  code: string
  message: string
  now: number
}): LocalVideoCandidateBackfill
export function reconcileLocalVideoCandidateJob(
  production: VideoProductionProject,
  job: ProcessingJob,
  workspace: { projectId?: string; documentId?: string },
):
  | { status: 'ignored' | 'foreign'; key: null }
  | { status: 'pending'; key: string }
  | { status: 'rejected'; key: string | null; code: string; message: string }
  | { status: 'already-registered'; key: string; candidateId: string }
  | {
      status: 'ready'
      key: string
      payload: {
        shotId: string
        label: string
        source: 'comfyui-h3'
        generationMode: 'fast' | 'quality'
        inputFingerprint: string
        binding: {
          libraryItemId: string
          libraryVersionId: string
          contentHash: string
          mimeType: 'video/mp4'
          scope: 'project'
          boundAt: number
        }
      }
    }
