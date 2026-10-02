import type { PixelDocument, PixelPaletteColor, SpriteSheetLayout, SpriteSheetMetadata } from './pixelCore.mjs'

export type RgbaImage = {
  width: number
  height: number
  data: Uint8ClampedArray | Uint8Array | number[]
}

export type PixelDitherMode = 'none' | 'bayer4' | 'floyd-steinberg'
export type PixelFitMode = 'contain' | 'cover' | 'stretch'
export type PixelResampleMode = 'nearest' | 'area'
export type PixelColorMatchMode = 'rgb' | 'oklab'
export type PixelAlphaMode = 'threshold' | 'preserve'
export type PixelConversionPresetId = 'pixel-art' | 'illustration' | 'soft-alpha'
export type PixelConversionPreset = {
  readonly id: PixelConversionPresetId
  readonly label: string
  readonly settings: Readonly<{
    resample: PixelResampleMode
    colorMatch: PixelColorMatchMode
    alphaMode: PixelAlphaMode
    dither: PixelDitherMode
  }>
}

export type PixelConversionOptions = {
  targetWidth?: number
  targetHeight?: number
  colorCount?: number
  palette?: PixelPaletteColor[]
  dither?: PixelDitherMode
  ditherStrength?: number
  fit?: PixelFitMode
  alphaThreshold?: number
  resample?: PixelResampleMode
  colorMatch?: PixelColorMatchMode
  alphaMode?: PixelAlphaMode
  documentId?: string
  documentName?: string
}

export type NormalizedPixelConversionOptions = Required<Omit<PixelConversionOptions, 'palette'>> & {
  palette: PixelPaletteColor[] | null
}

export type PixelConversionReport = {
  sourceWidth: number
  sourceHeight: number
  targetWidth: number
  targetHeight: number
  opaquePixels: number
  transparentPixels: number
  paletteSize: number
  paletteMode: 'fixed' | 'generated'
  dither: PixelDitherMode
  fit: PixelFitMode
  alphaThreshold: number
  resample: PixelResampleMode
  colorMatch: PixelColorMatchMode
  alphaMode: PixelAlphaMode
}

export type PixelExportBundle = {
  layout: SpriteSheetLayout
  project: { filename: string; mime: string; text: string }
  frame: {
    filename: string
    mime: 'image/png'
    frameId: string
    width: number
    height: number
    pixels: Uint8ClampedArray
  }
  sprite: {
    filename: string
    mime: 'image/png'
    width: number
    height: number
    pixels: Uint8ClampedArray
  }
  metadata: {
    filename: string
    mime: 'application/json'
    text: string
    value: SpriteSheetMetadata
  }
}

export const PIXEL_PROJECT_MIME: 'application/vnd.aeonquill.pixel+json'
export const PIXEL_PROJECT_EXTENSION: '.aeonpixel.json'
export const PIXEL_METADATA_MIME: 'application/json'
export const PIXEL_PNG_MIME: 'image/png'
export const PIXEL_CONVERSION_DITHER_MODES: readonly PixelDitherMode[]
export const PIXEL_CONVERSION_FIT_MODES: readonly PixelFitMode[]
export const PIXEL_CONVERSION_RESAMPLE_MODES: readonly PixelResampleMode[]
export const PIXEL_CONVERSION_COLOR_MATCH_MODES: readonly PixelColorMatchMode[]
export const PIXEL_CONVERSION_ALPHA_MODES: readonly PixelAlphaMode[]
export const PIXEL_CONVERSION_PRESETS: Readonly<Record<PixelConversionPresetId, PixelConversionPreset>>

export function assertRgbaImage(input: unknown): { width: number; height: number; data: Uint8ClampedArray }
export function normalizePixelConversionOptions(input?: PixelConversionOptions): NormalizedPixelConversionOptions
export function resizeRgbaImage(
  source: RgbaImage,
  options: { width: number; height: number; fit?: PixelFitMode; resample?: PixelResampleMode },
): { width: number; height: number; data: Uint8ClampedArray }
export function extractDeterministicPalette(
  rgba: Uint8ClampedArray | Uint8Array | number[],
  options?: { colorCount?: number; alphaThreshold?: number; alphaMode?: PixelAlphaMode },
): PixelPaletteColor[]
export function convertRgbaToPixelDocument(
  source: RgbaImage,
  options?: PixelConversionOptions,
): { document: PixelDocument; report: PixelConversionReport }
export function deserializePixelProject(serialized: string): PixelDocument
export function serializePixelProject(document: PixelDocument, options?: { pretty?: boolean }): string
export function pixelDocumentsSemanticallyEqual(left: PixelDocument, right: PixelDocument): boolean
export function safePixelFilename(input: unknown, fallback?: string): string
export function createPixelExportBundle(
  document: PixelDocument,
  options?: { columns?: number; padding?: number; spacing?: number; baseName?: string; frameId?: string },
): PixelExportBundle
