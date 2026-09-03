export type PixelActor = 'user' | 'tool' | 'agent' | 'system'
export type PixelCommandType =
  | 'pixels.paint' | 'pixels.erase' | 'pixels.patch' | 'pixels.restore' | 'palette.replace'
  | 'palette-cycles.add' | 'palette-cycles.remove' | 'palette-cycles.restore' | 'palette-cycles.patch'
  | 'groups.add' | 'groups.remove' | 'groups.restore' | 'groups.patch'
  | 'layers.add' | 'layers.remove' | 'layers.restore' | 'layers.patch' | 'layers.reorder' | 'layers.select'
  | 'frames.add' | 'frames.remove' | 'frames.restore' | 'frames.patch' | 'frames.duration.set' | 'frames.reorder' | 'frames.select'
  | 'cels.copy' | 'cels.restore'
  | 'animations.add' | 'animations.remove' | 'animations.restore' | 'animations.patch'
  | 'animation-events.add' | 'animation-events.remove' | 'animation-events.restore' | 'animation-events.patch'
  | 'onion-skin.set'

export type PixelPaletteColor = { id: string; name: string; color: string }
export type PixelPaletteCycleDirection = 'forward' | 'reverse' | 'ping-pong'
export type PixelPaletteCycle = {
  id: string
  name: string
  colorIds: string[]
  stepDurationMs: number
  direction: PixelPaletteCycleDirection
  enabled: boolean
}
export type PixelLayerGroup = { id: string; name: string; visible: boolean; locked: boolean }
export type PixelBlendMode = 'normal' | 'multiply' | 'screen' | 'add'
export type PixelCollisionType = 'solid' | 'hitbox' | 'hurtbox' | 'interaction'
export type PixelCollisionShape = { id: string; name: string; type: PixelCollisionType; x: number; y: number; width: number; height: number }
export type PixelTileRule = { terrainId: string; bitmask: number }
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
export type PixelAnimationEventType = 'marker' | 'sfx' | 'hit' | 'custom'
export type PixelAnimationEvent = {
  id: string
  name: string
  type: PixelAnimationEventType
  animationTagId: string
  frameId: string
  value: string
}
export type PixelOnionSkin = { enabled: boolean; previousFrames: number; nextFrames: number; opacity: number }
export type PixelDocument = {
  kind: 'aeonquill.pixel-document'
  schemaVersion: 5
  id: string
  name: string
  width: number
  height: number
  revision: number
  palette: PixelPaletteColor[]
  paletteCycles: PixelPaletteCycle[]
  layerGroups: PixelLayerGroup[]
  layers: PixelLayer[]
  frames: PixelFrame[]
  animationTags: PixelAnimationTag[]
  animationEvents: PixelAnimationEvent[]
  activeLayerId: string
  activeFrameId: string
  onionSkin: PixelOnionSkin
}
export type PixelCommand = { schemaVersion: 1; id: string; actor: PixelActor; type: PixelCommandType; baseRevision: number; payload: Record<string, unknown> }
export type PixelCommandResult = { document: PixelDocument; inverse: PixelCommand }
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
export type SpriteSheetFrame = SpriteSheetCell & { gameplay: PixelFrameGameplay }
export type SpriteSheetLayout = { width: number; height: number; columns: number; rows: number; padding: number; spacing: number; cells: SpriteSheetCell[] }
export type SpriteSheetMetadata = {
  schemaVersion: 5
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
  animationEvents: PixelAnimationEvent[]
  layerGroups: PixelLayerGroup[]
  layers: PixelLayer[]
  palette: PixelPaletteColor[]
  paletteCycles: PixelPaletteCycle[]
}
export type PixelAnimationClipMetadata = {
  schemaVersion: 5
  kind: 'aeonquill.pixel-animation-clip'
  sourceDocumentId: string
  sourceRevision: number
  width: number
  height: number
  columns: number
  rows: number
  padding: number
  spacing: number
  animation: PixelAnimationTag & { frameIds: string[] }
  frames: SpriteSheetFrame[]
  events: PixelAnimationEvent[]
  layerGroups: PixelLayerGroup[]
  layers: PixelLayer[]
  palette: PixelPaletteColor[]
  paletteCycles: PixelPaletteCycle[]
}

export class PixelContractError extends Error { code: string; details?: unknown }
export const PIXEL_DOCUMENT_KIND: 'aeonquill.pixel-document'
export const PIXEL_DOCUMENT_SCHEMA_VERSION: 5
export const PIXEL_COMMAND_SCHEMA_VERSION: 1
export const PIXEL_PALETTE_CYCLE_DIRECTIONS: ReadonlyArray<PixelPaletteCycleDirection>
export const PIXEL_ANIMATION_EVENT_TYPES: ReadonlyArray<PixelAnimationEventType>
export const PIXEL_BLEND_MODES: ReadonlyArray<PixelBlendMode>
export const PIXEL_COLLISION_TYPES: ReadonlyArray<PixelCollisionType>
export const PIXEL_TILE_NEIGHBORS: ReadonlyArray<Readonly<{ id: string; label: string; bit: number }>>
export const PIXEL_LIMITS: Readonly<{
  maxWidth: number; maxHeight: number; maxPaletteColors: number; maxLayers: number; maxLayerGroups: number
  maxFrames: number; maxAnimationTags: number; maxPaletteCycles: number; maxPaletteCycleColors: number
  maxAnimationEvents: number; maxCollisionShapesPerFrame: number; maxDocumentCells: number
  maxPixelsPerCommand: number; maxBulkCellsPerCommand: number; maxSpritePixels: number
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
export function resolvePixelPaletteCycleMap(document: PixelDocument, elapsedMs: number): Record<string, string>
export function assertPixelCommand(input: unknown, document?: PixelDocument): PixelCommand
export function createPixelCommand(document: PixelDocument, type: PixelCommandType, payload: Record<string, unknown>, options?: { id?: string; actor?: PixelActor }): PixelCommand
export function applyPixelCommand(document: PixelDocument, command: PixelCommand): PixelCommandResult
export function renderPixelFrameRgba(document: PixelDocument, frameId: string, options?: { includeHiddenLayers?: boolean; paletteCycleElapsedMs?: number }): Uint8ClampedArray
export function createSpriteSheetLayout(document: PixelDocument, options?: { columns?: number; padding?: number; spacing?: number }): SpriteSheetLayout
export function createSpriteSheetMetadata(document: PixelDocument, options?: { columns?: number; padding?: number; spacing?: number }): SpriteSheetMetadata
export function renderSpriteSheetRgba(document: PixelDocument, options?: { columns?: number; padding?: number; spacing?: number }): { pixels: Uint8ClampedArray; layout: SpriteSheetLayout; metadata: SpriteSheetMetadata }
export function renderPixelAnimationClipRgba(document: PixelDocument, tagId: string, options?: { columns?: number; padding?: number; spacing?: number }): { pixels: Uint8ClampedArray; layout: SpriteSheetLayout; metadata: PixelAnimationClipMetadata }
