import type { PixelPatchPoint, PixelRect } from './pixelTools.mjs'

export type PixelTransformAnchor = 'top-left' | 'center'
export type PixelTransformMode = 'move' | 'copy'
export type PixelTransformOptions = {
  width?: number
  height?: number
  angle?: number
  anchor?: PixelTransformAnchor
  mode?: PixelTransformMode
}
export type PixelTransformReport = {
  sourceWidth: number
  sourceHeight: number
  targetWidth: number
  targetHeight: number
  angle: number
  clippedPixels: number
}
export type PixelTransformResult = {
  pixels: PixelPatchPoint[]
  selection: PixelRect
  report: PixelTransformReport
}

export function transformPixelSelection(
  cel: Array<string | null>,
  canvasWidth: number,
  canvasHeight: number,
  selection: PixelRect,
  options?: PixelTransformOptions,
): PixelTransformResult
