export type PixelActor = 'user' | 'tool' | 'agent' | 'system'
export type PixelCommandType =
  | 'pixels.paint'
  | 'pixels.erase'
  | 'pixels.restore'
  | 'palette.replace'
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
  | 'frames.reorder'
  | 'frames.select'
  | 'onion-skin.set'

export type PixelPaletteColor = {
  id: string
  name: string
  color: string
}

export type PixelLayer = {
  id: string
  name: string
  visible: boolean
  locked: boolean
  opacity: number
}

export type PixelFrame = {
  id: string
  name: string
  durationMs: number
  cels: Record<string, Array<string | null>>
}

export type PixelOnionSkin = {
  enabled: boolean
  previousFrames: number
  nextFrames: number
  opacity: number
}

export type PixelDocument = {
  kind: 'aeonquill.pixel-document'
  schemaVersion: 1
  id: string
  name: string
  width: number
  height: number
  revision: number
  palette: PixelPaletteColor[]
  layers: PixelLayer[]
  frames: PixelFrame[]
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
  schemaVersion: 1
  kind: 'aeonquill.sprite-sheet'
  sourceDocumentId: string
  sourceRevision: number
  width: number
  height: number
  columns: number
  rows: number
  padding: number
  spacing: number
  frames: SpriteSheetCell[]
  palette: PixelPaletteColor[]
}

export class PixelContractError extends Error {
  code: string
  details?: unknown
}

export const PIXEL_DOCUMENT_KIND: 'aeonquill.pixel-document'
export const PIXEL_DOCUMENT_SCHEMA_VERSION: 1
export const PIXEL_COMMAND_SCHEMA_VERSION: 1
export const PIXEL_LIMITS: Readonly<{
  maxWidth: number
  maxHeight: number
  maxPaletteColors: number
  maxLayers: number
  maxFrames: number
  maxDocumentCells: number
  maxPixelsPerCommand: number
  maxSpritePixels: number
}>

export function assertPixelDocument(input: unknown): PixelDocument
export function createBlankPixelArray(width: number, height: number): Array<string | null>
export function createPixelDocument(input?: Partial<Omit<PixelDocument, 'kind' | 'schemaVersion'>>): PixelDocument
export function migratePixelDocument(input: unknown): PixelDocument
export function serializePixelDocument(document: PixelDocument, options?: { pretty?: boolean }): string
export function deserializePixelDocument(serialized: string): PixelDocument
export function clonePixelDocument(document: PixelDocument): PixelDocument
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
