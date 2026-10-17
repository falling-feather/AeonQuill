import type { CustomWorkflowSummary } from './workflowCenterApi'
import type { WorkflowControlRole } from './workflowControls.mjs'
import type { LoraBinding, LoraBaseFamily } from './loraCompatibility.mjs'
export type WorkflowParameterKey = WorkflowControlRole
export type WorkflowWeightSet = {
  schemaVersion: 1
  registryVersion: string
  family: 'minimax-h3'
  profileId: 'fp8Scaled4060' | 'int8ConvrotCu130'
  samplingMode: 'base' | 'turbo'
  artifacts: Array<{
    role: 'base' | 'text-encoder' | 'video-vae' | 'audio-vae' | 'acceleration-lora'
    id: string
    sha256: string
  }>
}
export type WorkflowRecipeInput = {
  name: string
  workflowId: string
  workflowHash: string
  mappingHash: string
  parameters: Partial<Record<WorkflowParameterKey, number>>
  weightSet?: WorkflowWeightSet | null
  loraBindings?: LoraBinding[]
}
export type WorkflowRecipe = WorkflowRecipeInput & { id: string; createdAt: number; updatedAt: number; weightSet: WorkflowWeightSet | null; loraBindings: LoraBinding[] }
export type WorkflowRecipeSummary = WorkflowRecipe & { availability: 'ready' | 'stale' | 'disabled' | 'missing'; reason: string | null }
export type WorkflowRecipeCatalog = { revision: number; recipes: WorkflowRecipeSummary[] }
export const WORKFLOW_RECIPE_SCHEMA_VERSION: 3
export function validateWorkflowRecipeInput(input: unknown, workflow: CustomWorkflowSummary | null): WorkflowRecipeInput
export function assertWorkflowRecipeCompatible<T extends WorkflowRecipeInput>(recipe: T, workflow: CustomWorkflowSummary | null): T
export function validateWorkflowRecipeRecord(input: unknown): WorkflowRecipe
export function migrateWorkflowRecipeRecord(input: unknown, schemaVersion: number): WorkflowRecipe
export function validateWorkflowWeightSet(input: unknown): WorkflowWeightSet | null
export function assertWorkflowWeightSetCompatible(actual: WorkflowWeightSet | null, expected: WorkflowWeightSet | null): void
export function normalizeWorkflowLoraBindings(input: unknown): LoraBinding[]
export function assertWorkflowLoraBindingsCompatible(
  input: unknown,
  workflow: (CustomWorkflowSummary & { loraRequirements?: { family: LoraBaseFamily | null; names: string[] } }) | null,
): LoraBinding[]
export function assertWorkflowLoraControlsMatchBindings(bindings: unknown, values?: Record<string, unknown>): LoraBinding[]
