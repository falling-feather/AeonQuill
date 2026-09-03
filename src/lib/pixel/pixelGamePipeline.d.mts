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

export type PixelEngineBridgeOptions = PixelGameOptions & {
  pixelsPerUnit?: number
  rpgMakerFrameIds?: Partial<Record<'south' | 'west' | 'east' | 'north', string[]>>
}

export type PixelEngineBridgeManifest = {
  schemaVersion: 1
  kind: 'aeonquill.pixel-engine-bridge'
  sourceDocumentId: string
  sourceRevision: number
  sourceSchemaVersion: number
  files: {
    sprite: string
    manifest: string
    godotImporter: string
    godotOutput: string
    unityImporter: string
    rpgMakerCharacter: string
    readme: string
  }
  coordinateSystem: { origin: 'top-left'; unit: 'pixel' }
  frames: PixelGameManifest['frames']
  animations: PixelGameAnimation[]
  animationEvents: PixelDocument['animationEvents']
  directions: PixelGameManifest['directions']
  tilemap: PixelGameManifest['tilemap']
  layerGroups: PixelDocument['layerGroups']
  layers: PixelDocument['layers']
  palette: PixelDocument['palette']
  paletteCycles: PixelDocument['paletteCycles']
  godot: {
    target: 'Godot 4.x'
    durationFps: 1000
    outputResource: string
    importer: string
  }
  unity: {
    target: 'Unity 2021.2+'
    pixelsPerUnit: number
    yConversion: 'atlasHeight - top - height'
    texture: { filterMode: 'Point'; mipmaps: false; compression: 'Uncompressed'; wrapMode: 'Clamp' }
    importer: string
    stableIdPolicy: 'reuse-existing-name-id'
  }
  rpgMakerMz: {
    target: 'RPG Maker MZ'
    layout: { columns: 3; rows: 4; rowOrder: Array<'south' | 'west' | 'east' | 'north'> }
    image: string
    cells: Array<{
      row: number
      column: number
      direction: 'south' | 'west' | 'east' | 'north'
      directionLabel: string
      frameId: string
      repeated: boolean
    }>
  }
}

export type PixelEngineBridgeExportBundle = {
  sprite: { filename: string; mime: 'image/png'; width: number; height: number; pixels: Uint8ClampedArray }
  manifest: { filename: string; mime: 'application/json'; text: string; value: PixelEngineBridgeManifest }
  godotImporter: { filename: string; mime: 'text/x-gdscript'; text: string }
  unityImporter: { filename: string; mime: 'text/x-csharp'; text: string }
  rpgMakerCharacter: { filename: string; mime: 'image/png'; width: number; height: number; pixels: Uint8ClampedArray }
  readme: { filename: string; mime: 'text/markdown'; text: string }
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
export function createPixelEngineBridgeExportBundle(
  document: PixelDocument,
  options?: PixelEngineBridgeOptions,
): PixelEngineBridgeExportBundle
