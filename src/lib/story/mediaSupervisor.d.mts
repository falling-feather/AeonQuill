import type { ProcessingJob } from '../../types'

export const MEDIA_RUN_SCHEMA_VERSION: 1
export const MEDIA_RUN_KINDS: readonly ['image', 'video', 'prepare-speech', 'render-mix', 'final-cut']
export const MEDIA_RUN_STATUSES: readonly ['proposed', 'rejected', 'queued', 'running', 'completed', 'failed', 'cancelled']
export const MEDIA_RUN_NODE_KINDS: Readonly<Record<string, readonly string[]>>

export type MediaRunKind = 'image' | 'video' | 'prepare-speech' | 'render-mix' | 'final-cut'
export type MediaRunStatus = 'proposed' | 'rejected' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
export type MediaRun = {
  id: string
  nodeId: string
  kind: MediaRunKind
  targetId: string | null
  inputFingerprint: string
  requestSummary: string
  status: MediaRunStatus
  jobId: string | null
  createdAt: number
  updatedAt: number
  errorCode: string | null
}
export class MediaSupervisorError extends Error { code: string; details?: unknown }
export function assertMediaRun(input: unknown, options?: { nodeIds?: ReadonlySet<string> }): MediaRun
export function createMediaRunProposal(input: Omit<MediaRun, 'id' | 'status' | 'jobId' | 'createdAt' | 'updatedAt' | 'errorCode'> & { id?: string }, options?: { now?: number; idFactory?: (proposal: MediaRun) => string }): MediaRun
export function assertMediaJobForRun(run: MediaRun, job: ProcessingJob, options?: { projectId?: string; documentId?: string }): ProcessingJob
export function assertCanConfirmMediaRun(project: { globalPaused: boolean; nodes: Array<{ id: string; status: string; dependsOn: string[] }>; mediaRuns: MediaRun[] }, runId: string, options?: { currentInputFingerprint?: string; hasPreparedTarget?: boolean }): MediaRun
export function confirmMediaRun(project: Parameters<typeof assertCanConfirmMediaRun>[0], runId: string, options: { currentInputFingerprint?: string; hasPreparedTarget?: boolean; projectId?: string; documentId?: string; onRunMediaStep: (run: MediaRun) => Promise<ProcessingJob> }): Promise<ProcessingJob>
export function reconcileMediaRunJob(project: { mediaRuns: MediaRun[] }, runId: string, job: ProcessingJob, options?: { projectId?: string; documentId?: string }): { changed: boolean; payload: { runId: string; jobId: string; status: 'completed' | 'failed' | 'cancelled'; errorCode: string | null } }
export function evaluateMediaSupervisor(project: { mediaRuns?: MediaRun[] }): { schemaVersion: 1; status: 'none' | 'media-proposed' | 'media-running' | 'media-review' | 'media-failed' | 'media-cancelled'; action: 'none' | 'confirm-media' | 'wait-media' | 'review-media' | 'retry-media'; run: MediaRun | null; canContinue: boolean; message: string }
