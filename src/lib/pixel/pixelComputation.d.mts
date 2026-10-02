import type {
  PixelDocument,
  renderPixelFramesRgba,
} from './pixelCore.mjs'
import type {
  PixelEngineBridgeOptions,
  PixelGameOptions,
  PixelTerrainMapOptions,
  PixelTerrainPreviewOptions,
} from './pixelGamePipeline.mjs'
import type {
  PixelConversionOptions,
  RgbaImage,
  convertRgbaToPixelDocument,
} from './pixelConversion.mjs'

export const PIXEL_COMPUTATION_DEFAULT_BUDGET_BYTES: number
export const PIXEL_COMPUTATION_OPERATIONS: ReadonlyArray<PixelComputationOperation>
export type PixelComputationOperation =
  | 'frame'
  | 'frames'
  | 'sprite-sheet'
  | 'terrain-map'
  | 'terrain-preview'
  | 'coverage'
  | 'image-convert'
  | 'game-export'
  | 'engine-export'
  | 'clip-export'
  | 'pixel-export'
  | 'terrain-map-export'

export type PixelComputationOptions =
  | ({ frameId: string; includeHiddenLayers?: boolean; paletteCycleElapsedMs?: number } & { budgetBytes?: number })
  | ({ frameIds: string[]; includeHiddenLayers?: boolean; paletteCycleElapsedMs?: number } & { budgetBytes?: number })
  | ({ columns?: number; padding?: number; spacing?: number; paletteCycleElapsedMs?: number } & { budgetBytes?: number })
  | (PixelTerrainMapOptions & { budgetBytes?: number })
  | (PixelTerrainPreviewOptions & { budgetBytes?: number })
  | ({ mapId: string; budgetBytes?: number })
  | (PixelConversionOptions & { budgetBytes?: number })
  | (PixelGameOptions & { budgetBytes?: number })
  | (PixelEngineBridgeOptions & { budgetBytes?: number })
  | ({ tagId: string; columns?: number; padding?: number; spacing?: number; baseName?: string; budgetBytes?: number })
  | ({ columns?: number; padding?: number; spacing?: number; baseName?: string; frameId?: string; budgetBytes?: number })
  | ({ terrainMapId?: string; cells?: Array<string | null>; baseName?: string; budgetBytes?: number })

export type PixelComputationFramesResult = ReturnType<typeof renderPixelFramesRgba>

export type PixelComputationRequest = {
  requestId: string
  documentId: string
  revision: number
  operation: PixelComputationOperation
  document: PixelDocument
  /** Only image-convert requests may provide source. */
  source?: RgbaImage
  options: Record<string, unknown> & { budgetBytes?: number }
}

export class PixelComputationError extends Error {
  code: string
  details?: unknown
}

export type PixelComputationConversionResult = ReturnType<typeof convertRgbaToPixelDocument>

/**
 * Build a short-lived, read-only PixelDocument projection for Worker input.
 * The returned value is not a storage or export document and must not be mutated.
 * Immutable source substructures may be shared until postMessage/structuredClone.
 */
export function createPixelComputationSnapshot(
  document: PixelDocument,
  operation: PixelComputationOperation,
  options: PixelComputationOptions,
): PixelDocument

export function runPixelComputation(request: PixelComputationRequest): {
  requestId: string
  documentId: string
  revision: number
  operation: PixelComputationOperation
  result: unknown
}
