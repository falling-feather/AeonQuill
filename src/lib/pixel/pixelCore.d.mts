export type PixelActor = 'user' | 'tool' | 'agent' | 'system'
export type PixelCommandType =
  | 'pixels.paint'
  | 'pixels.erase'
  | 'pixels.patch'
  | 'pixels.restore'
  | 'palette.replace'
  | 'groups.add'
  | 'groups.remove'
  | 'groups.restore'
  | 'groups.patch'
  | 'layers.add'
  | 'layers.remove'
  | 'layers.restore'
  | 'layers.patch'
  | 'layers.reorder'
  | 'layers.select'
  | 'frames.add'
  | 'frames.remove'
  | 'frames.restore'
  | 'frames.patch'
  | 'frames.duration.set'
  | 'frames.reorder'
  | 'frames.select'
  | 'cels.copy'
  | 'cels.restore'
  | 'animations.add'
  | 'animations.remove'
  | 'animations.restore'
  | 'animations.patch'
  | 'onion-skin.set'

export type PixelPaletteColor = {
  id: string
  name: string
  color: string
}

export type PixelLayerGroup = {
  id: string
  name: string
  visible: boolean
  locked: boolean
}

export type PixelBlendMode = 'normal' | 'multiply' | 'screen' | 'add'

export type PixelCollisionType = 'solid' | 'hitbox' | 'hurtbox' | 'interaction'

export type PixelCollisionShape = {
  id: string
  name: string
  type: PixelCollisionType
  x: number
  y: number
  width: number
  height: number
}

export type PixelTileRule = {
  terrainId: string
  bitmask: number
}

export type PixelFrameGameplay = {
  anchor: { x: number; y: number }
  collisions: PixelCollisionShape[]
  tileRule: PixelTileRule | null
}

export type PixelLayer = {
  id: string
  name: string
  visible: boolean
  locked: boolean
  opacity: number
  groupId: string | null
  blendMode: PixelBlendMode
}

export type PixelFrame = {
  id: string
  name: string
  durationMs: number
  gameplay: PixelFrameGameplay
  cels: Record<string, Array<string | null>>
}

export type PixelAnimationDirection = 'forward' | 'reverse' | 'ping-pong'

export type PixelAnimationTag = {
  id: string
  name: string
  fromFrameId: string
  toFrameId: string
  direction: PixelAnimationDirection
  loop: boolean
}

export type PixelOnionSkin = {
  enabled: boolean
  previousFrames: number
  nextFrames: number
  opacity: number
}

export type PixelDocument = {
  kind: 'aeonquill.pixel-document'
  schemaVersion: 4
  id: string
  name: string
  width: number
  height: number
  revision: number
  palette: PixelPaletteColor[]
  layerGroups: PixelLayerGroup[]
  layers: PixelLayer[]
  frames: PixelFrame[]
  animationTags: PixelAnimationTag[]
  activeLayerId: string
  activeFrameId: string
  onionSkin: PixelOnionSkin
}

export type PixelCommand = {
  schemaVersion: 1
  id: string
  actor: PixelActor
  type: PixelCommandType
  baseRevision: number
  payload: Record<string, unknown>
}

export type PixelCommandResult = {
  document: PixelDocument
  inverse: PixelCommand
}

export type SpriteSheetCell = {
  frameId: string
  index: number
  column: number
  row: number
  x: number
  y: number
  width: number
  height: number
  durationMs: number
}

export type SpriteSheetFrame = SpriteSheetCell & {
  gameplay: PixelFrameGameplay
}

export type SpriteSheetLayout = {
  width: number
  height: number
  columns: number
  rows: number
  padding: number
  spacing: number
  cells: SpriteSheetCell[]
}

export type SpriteSheetMetadata = {
  schemaVersion: 4
  kind: 'aeonquill.sprite-sheet'
  sourceDocumentId: string
  sourceRevision: number
  width: number
  height: number
  columns: number
  rows: number
  padding: number
  spacing: number
  frames: SpriteSheetFrame[]
  animations: Array<PixelAnimationTag & { frameIds: string[] }>
  layerGroups: PixelLayerGroup[]
  layers: PixelLayer[]
  palette: PixelPaletteColor[]
}

export class PixelContractError extends Error {
  code: string
  details?: unknown
}

export const PIXEL_DOCUMENT_KIND: 'aeonquill.pixel-document'
export const PIXEL_DOCUMENT_SCHEMA_VERSION: 4
export const PIXEL_COMMAND_SCHEMA_VERSION: 1
export const PIXEL_BLEND_MODES: ReadonlyArray<PixelBlendMode>
export const PIXEL_COLLISION_TYPES: ReadonlyArray<PixelCollisionType>
export const PIXEL_TILE_NEIGHBORS: ReadonlyArray<Readonly<{ id: string; label: string; bit: number }>>
export const PIXEL_LIMITS: Readonly<{
  maxWidth: number
  maxHeight: number
  maxPaletteColors: number
  maxLayers: number
  maxLayerGroups: number
  maxFrames: number
  maxAnimationTags: number
  maxCollisionShapesPerFrame: number
  maxDocumentCells: number
  maxPixelsPerCommand: number
  maxBulkCellsPerCommand: number
  maxSpritePixels: number
}>

export function assertPixelDocument(input: unknown): PixelDocument
export function createBlankPixelArray(width: number, height: number): Array<string | null>
export function createDefaultPixelFrameGameplay(width: number, height: number): PixelFrameGameplay
export function createPixelDocument(input?: Partial<Omit<PixelDocument, 'kind' | 'schemaVersion'>>): PixelDocument
export function migratePixelDocument(input: unknown): PixelDocument
export function serializePixelDocument(document: PixelDocument, options?: { pretty?: boolean }): string
export function deserializePixelDocument(serialized: string): PixelDocument
export function clonePixelDocument(document: PixelDocument): PixelDocument
export function resolvePixelAnimationSequences(document: PixelDocument): Array<{ tagId: string; frameIds: string[] }>
export function resolvePixelAnimationFrames(document: PixelDocument, tagId: string): string[]
export function assertPixelCommand(input: unknown, document?: PixelDocument): PixelCommand
export function createPixelCommand(
  document: PixelDocument,
  type: PixelCommandType,
  payload: Record<string, unknown>,
  options?: { id?: string; actor?: PixelActor },
): PixelCommand
export function applyPixelCommand(document: PixelDocument, command: PixelCommand): PixelCommandResult
export function renderPixelFrameRgba(
  document: PixelDocument,
  frameId: string,
  options?: { includeHiddenLayers?: boolean },
): Uint8ClampedArray
export function createSpriteSheetLayout(
  document: PixelDocument,
  options?: { columns?: number; padding?: number; spacing?: number },
): SpriteSheetLayout
export function createSpriteSheetMetadata(
  document: PixelDocument,
  options?: { columns?: number; padding?: number; spacing?: number },
): SpriteSheetMetadata
export function renderSpriteSheetRgba(
  document: PixelDocument,
  options?: { columns?: number; padding?: number; spacing?: number },
): { pixels: Uint8ClampedArray; layout: SpriteSheetLayout; metadata: SpriteSheetMetadata }
