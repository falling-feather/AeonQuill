export type PixelPoint = { x: number; y: number }
export type PixelRect = { x: number; y: number; width: number; height: number }
export type PixelPatchPoint = PixelPoint & { value: string | null }

export function normalizePixelRect(start: PixelPoint, end: PixelPoint, width: number, height: number): PixelRect
export function rasterPixelLine(start: PixelPoint, end: PixelPoint, width: number, height: number): PixelPoint[]
export function rasterPixelRectangle(
  start: PixelPoint,
  end: PixelPoint,
  width: number,
  height: number,
  options?: { fill?: boolean },
): PixelPoint[]
export function expandPixelBrush(
  points: PixelPoint[],
  width: number,
  height: number,
  options?: { size?: number; mirrorHorizontal?: boolean; mirrorVertical?: boolean },
): PixelPoint[]
export function floodFillPixels(
  cel: Array<string | null>,
  width: number,
  height: number,
  start: PixelPoint,
  replacementValue: string | null,
): PixelPoint[]
export function createSelectionPatch(
  cel: Array<string | null>,
  width: number,
  height: number,
  selection: PixelRect,
  operation: 'clear' | 'flip-horizontal' | 'flip-vertical' | 'move' | 'copy',
  options?: { dx?: number; dy?: number },
): PixelPatchPoint[]

export type SmartPixelCleanupReport = {
  scannedPixels: number
  isolatedRemoved: number
  pinholesFilled: number
  changedPixels: number
}

export function createSmartPixelCleanupPatch(
  cel: Array<string | null>,
  width: number,
  height: number,
  options?: { removeIsolated?: boolean; fillPinholes?: boolean },
): { pixels: PixelPatchPoint[]; report: SmartPixelCleanupReport }
