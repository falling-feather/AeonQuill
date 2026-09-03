import type {
  PixelAnimationClipMetadata,
  PixelCollisionShape,
  PixelDocument,
  PixelTileRule,
} from './pixelCore.mjs'

export type PixelDirectionId = 'south' | 'south-west' | 'west' | 'north-west' | 'north' | 'north-east' | 'east' | 'south-east'

export type PixelGameOptions = {
  columns?: number
  padding?: number
  spacing?: number
  baseName?: string
  directionFrameIds?: Partial<Record<PixelDirectionId, string>>
  mapWidth?: number
  mapHeight?: number
  mapFrameIds?: Array<string | null>
  animationName?: string
  animationTagId?: string
}

export type PixelGameAnimation = {
  id: string
  name: string
  direction: 'forward' | 'reverse' | 'ping-pong'
  loop: boolean
  frames: Array<{ id: string; durationMs: number }>
}

export type PixelGameManifest = {
  schemaVersion: 5
  kind: 'aeonquill.pixel-game-bundle'
  sourceDocumentId: string
  sourceRevision: number
  image: string
  canvas: { width: number; height: number }
  atlas: { width: number; height: number; columns: number; rows: number; padding: number; spacing: number }
  animation: PixelGameAnimation
  animations: PixelGameAnimation[]
  animationEvents: PixelDocument['animationEvents']
  frames: Array<{
    id: string
    name: string
    durationMs: number
    atlas: { x: number; y: number; width: number; height: number }
    anchor: { x: number; y: number }
    collisions: PixelCollisionShape[]
    tileRule: PixelTileRule | null
  }>
  directions: Array<{ id: PixelDirectionId; label: string; frameId: string; frameIndex: number }>
  tilemap: {
    width: number
    height: number
    tileWidth: number
    tileHeight: number
    data: number[]
    frameIds: Array<string | null>
  }
  layerGroups: PixelDocument['layerGroups']
  layers: PixelDocument['layers']
  palette: PixelDocument['palette']
  paletteCycles: PixelDocument['paletteCycles']
}

export type PixelGameExportBundle = {
  project: { filename: string; mime: string; text: string }
  sprite: { filename: string; mime: 'image/png'; width: number; height: number; pixels: Uint8ClampedArray }
  manifest: { filename: string; mime: 'application/json'; text: string; value: PixelGameManifest }
  tiledTileset: { filename: string; mime: 'application/json'; text: string }
  tiledMap: { filename: string; mime: 'application/json'; text: string }
  viewer: { filename: string; mime: 'text/html'; text: string }
}

export type PixelAnimationClipExportBundle = {
  sprite: { filename: string; mime: 'image/png'; width: number; height: number; pixels: Uint8ClampedArray }
  manifest: { filename: string; mime: 'application/json'; text: string; value: PixelAnimationClipMetadata }
}

export type PixelTerrainPreviewOptions = {
  terrainId?: string
  occupancy?: boolean[]
}

export type PixelTerrainPreviewCell = {
  index: number
  row: number
  column: number
  occupied: boolean
  expectedBitmask: number | null
  frameId: string | null
  frameName: string | null
  matchedBitmask: number | null
  distance: number | null
  exact: boolean
}

export type PixelTerrainPreviewLayout = {
  schemaVersion: 1
  kind: 'aeonquill.pixel-terrain-preview'
  sourceDocumentId: string
  sourceRevision: number
  terrainId: string
  grid: { width: 3; height: 3 }
  tile: { width: number; height: number }
  occupancy: boolean[]
  exactCount: number
  fallbackCount: number
  cells: PixelTerrainPreviewCell[]
}

export type PixelTerrainPreviewMetadata = PixelTerrainPreviewLayout & { image: string }

export type PixelTerrainPreviewExportBundle = {
  sprite: { filename: string; mime: 'image/png'; width: number; height: number; pixels: Uint8ClampedArray }
  manifest: { filename: string; mime: 'application/json'; text: string; value: PixelTerrainPreviewMetadata }
}

export class PixelGamePipelineError extends Error {
  code: string
  details?: unknown
}

export const PIXEL_DIRECTIONS: ReadonlyArray<Readonly<{ id: PixelDirectionId; label: string }>>
export const PIXEL_TERRAIN_GRID_SIZE: 3
export const PIXEL_TERRAIN_GRID_PRESETS: ReadonlyArray<Readonly<{
  id: 'island' | 'corridor' | 'corner' | 'solid'
  label: string
  occupancy: ReadonlyArray<boolean>
}>>
export function normalizePixelGameOptions(
  document: PixelDocument,
  options?: PixelGameOptions,
): Required<Omit<PixelGameOptions, 'animationTagId'>> & { animationTagId: string | null }
export function createPixelGameManifest(document: PixelDocument, options?: PixelGameOptions): PixelGameManifest
export function createPixelGameExportBundle(document: PixelDocument, options?: PixelGameOptions): PixelGameExportBundle
export function createPixelAnimationClipExportBundle(
  document: PixelDocument,
  tagId: string,
  options?: { columns?: number; padding?: number; spacing?: number; baseName?: string },
): PixelAnimationClipExportBundle
export function createPixelTerrainPreviewLayout(
  document: PixelDocument,
  options?: PixelTerrainPreviewOptions,
): PixelTerrainPreviewLayout
export function renderPixelTerrainPreviewRgba(
  document: PixelDocument,
  options?: PixelTerrainPreviewOptions,
): { pixels: Uint8ClampedArray; width: number; height: number; layout: PixelTerrainPreviewLayout }
export function createPixelTerrainPreviewExportBundle(
  document: PixelDocument,
  options?: PixelTerrainPreviewOptions & { baseName?: string },
): PixelTerrainPreviewExportBundle
