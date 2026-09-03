import type { CanvasDocument } from '../canvasCore'
import type { PixelDocument, PixelCommand } from '../pixel/pixelCore.mjs'
import type { GenerationPlan, StoryProject } from '../story/storyProject.mjs'
import type { VideoProductionProject, VideoProductionCommand } from '../story/productionPipeline.mjs'

export type CreativePlanMode = 'balanced' | 'pixel' | 'smart-video'
export type CreativePlanSource = {
  kind: 'deterministic-local' | 'byok-text'
  agentRole: string
  modelId: string | null
  requestHash: string | null
}
export type CreativePlanSourceAsset = { assetId: string; versionId: string; sha256: string }
export type CreativePlanStep = {
  id: string
  toolId: string
  summary: string
  input: Record<string, unknown>
  sourceAssets: CreativePlanSourceAsset[]
}
export type CreativePlan = {
  schemaVersion: 1
  id: string
  projectId: string
  documentId: string
  modeId: CreativePlanMode
  baseRevision: number
  title: string
  objective: string
  source: CreativePlanSource
  steps: CreativePlanStep[]
  createdAt: number
}
export type ApprovedCreativePlan = {
  schemaVersion: 1
  plan: CreativePlan
  approval: { approvedBy: 'user'; approvedAt: number; planSha256: string }
}
export type CreativePlanReceipt = {
  schemaVersion: 1
  id: string
  planId: string
  projectId: string
  documentId: string
  modeId: CreativePlanMode
  baseRevision: number
  resultRevision: number
  title: string
  planSha256: string
  source: CreativePlanSource
  steps: Array<{ id: string; toolId: string; inputSha256: string; sourceAssets: CreativePlanSourceAsset[] }>
  approvedAt: number
  committedAt: number
}
export type SmartVideoModeDocument = {
  schemaVersion: 2
  project: StoryProject
  plan: GenerationPlan
  production: VideoProductionProject
}
export type CreativePlanModeDocument = CanvasDocument | PixelDocument | SmartVideoModeDocument
export type CreativePlanPreview = {
  schemaVersion: 1
  planId: string
  modeId: CreativePlanMode
  baseRevision: number
  resultRevision: number
  document: CreativePlanModeDocument
  commands: Array<unknown | PixelCommand | VideoProductionCommand>
  summaries: Array<{ stepId: string; toolId: string; summary: string }>
}

export class CreativePlanError extends Error { code: string; details?: unknown }
export function assertCreativePlan(input: unknown): CreativePlan
export function createCreativePlan(input: Omit<CreativePlan, 'schemaVersion'>): CreativePlan
export function hashCreativePlan(input: unknown): Promise<string>
export function approveCreativePlan(input: unknown, options?: { approvedAt?: number }): Promise<ApprovedCreativePlan>
export function assertApprovedCreativePlan(input: unknown): Promise<ApprovedCreativePlan>
export function previewCreativePlan(input: CreativePlanModeDocument, plan: CreativePlan, options?: { workspaceRevision?: number; now?: number }): CreativePlanPreview
export function executeApprovedCreativePlan(input: CreativePlanModeDocument, approved: ApprovedCreativePlan, options?: { workspaceRevision?: number; committedAt?: number }): Promise<{ document: CreativePlanModeDocument; receipt: CreativePlanReceipt; commands: unknown[] }>
export function assertCreativePlanReceipt(input: unknown): CreativePlanReceipt
export function creativePlanToolCatalog(): Record<CreativePlanMode, string[]>
