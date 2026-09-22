import type { CustomWorkflowSummary } from './workflowCenterApi'
import type { WorkflowControlRole } from './workflowControls.mjs'
export type WorkflowParameterKey = WorkflowControlRole
export type WorkflowRecipeInput = {
  name: string
  workflowId: string
  workflowHash: string
  mappingHash: string
  parameters: Partial<Record<WorkflowParameterKey, number>>
}
export type WorkflowRecipe = WorkflowRecipeInput & { id: string; createdAt: number; updatedAt: number }
export type WorkflowRecipeSummary = WorkflowRecipe & { availability: 'ready' | 'stale' | 'disabled' | 'missing'; reason: string | null }
export type WorkflowRecipeCatalog = { revision: number; recipes: WorkflowRecipeSummary[] }
export const WORKFLOW_RECIPE_SCHEMA_VERSION: 1
export function validateWorkflowRecipeInput(input: unknown, workflow: CustomWorkflowSummary | null): WorkflowRecipeInput
export function assertWorkflowRecipeCompatible<T extends WorkflowRecipeInput>(recipe: T, workflow: CustomWorkflowSummary | null): T
export function validateWorkflowRecipeRecord(input: unknown): WorkflowRecipe
