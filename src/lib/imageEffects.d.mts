import type { CanvasElement, MaskRecipe, ProcessingStep } from '../types'

export const IMAGE_EFFECT_RECIPE_KIND: 'aeonquill.image-effect-recipe'
export const IMAGE_EFFECT_RECIPE_SCHEMA_VERSION: 1
export const IMAGE_EFFECT_MAX_EDGE: 4096
export const IMAGE_EFFECT_MAX_PIXELS: 16000000
export const IMAGE_EFFECT_MAX_CACHED_CHARACTERS: 16777216
export const IMAGE_EFFECT_MAX_BATCH_PIXELS: 32000000
export const IMAGE_EFFECT_MAX_BATCH_WORK_PIXELS: 128000000
export const IMAGE_EFFECT_MAX_DOCUMENT_BYTES: 25165824

export type AdjustImageEffectParameters = {
  kind: 'adjust'
  brightness: number
  contrast: number
  saturation: number
}

export type CropImageEffectParameters = {
  kind: 'crop'
  aspect: '1:1' | '4:3' | '3:4' | '16:9'
  zoom: number
  positionX: number
  positionY: number
}

export type ImageEffectParameters = AdjustImageEffectParameters | CropImageEffectParameters

export function resolveImageProcessingSource(element: Pick<CanvasElement, 'processingStack' | 'src' | 'sourceSrc'>): string | undefined
export function editableImageProcessingSteps(element: Pick<CanvasElement, 'processingStack' | 'adjustments'>): ProcessingStep[]

export type ImageEffectRecipeStep =
  | { type: 'adjust'; parameters: AdjustImageEffectParameters }
  | { type: 'crop'; parameters: CropImageEffectParameters }
  | { type: 'mask-refine'; maskRecipe: MaskRecipe }

export type ImageEffectRecipe = {
  kind: 'aeonquill.image-effect-recipe'
  schemaVersion: 1
  steps: ImageEffectRecipeStep[]
}

export class ImageEffectContractError extends Error {
  constructor(code: string, message: string, details?: unknown)
  code: string
  details?: unknown
}

export function normalizeImageEffectParameters(input: unknown): ImageEffectParameters
export function isReplayableImageStep(step: unknown): boolean
export function reorderImageProcessingSteps(
  steps: readonly ProcessingStep[],
  stepId: string,
  direction: 'up' | 'down',
): ProcessingStep[]
export function effectRecipeFromSteps(steps: readonly ProcessingStep[]): ImageEffectRecipe
export function validateImageEffectRecipe(input: unknown): ImageEffectRecipe
