export type PixelSystemClipboard = {
  kind: 'aeonquill.pixel-system-clipboard'
  schemaVersion: 1
  width: number
  height: number
  colors: string[]
  pixels: Array<number | null>
}

export type PixelSystemClipboardSelection = { x: number; y: number; width: number; height: number }
export type PixelSystemClipboardAddedColor = { id: string; name: string; color: string }
export type PixelSystemClipboardPasteResult = {
  document: import('./pixelCore.mjs').PixelDocument
  selection: PixelSystemClipboardSelection
  changedPixels: number
  addedColors: PixelSystemClipboardAddedColor[]
}

export class PixelSystemClipboardError extends Error {
  code: string
  details?: unknown
}

export const PIXEL_SYSTEM_CLIPBOARD_KIND: 'aeonquill.pixel-system-clipboard'
export const PIXEL_SYSTEM_CLIPBOARD_SCHEMA_VERSION: 1
export const PIXEL_SYSTEM_CLIPBOARD_MAX_TEXT_CHARACTERS: 1_048_576
export const PIXEL_SYSTEM_CLIPBOARD_MAX_COLORS: 256
export const PIXEL_SYSTEM_CLIPBOARD_MAX_CELLS: 65_536

export function assertPixelSystemClipboard(input: unknown): PixelSystemClipboard
export function createPixelSystemClipboard(
  document: import('./pixelCore.mjs').PixelDocument,
  selection: PixelSystemClipboardSelection,
): PixelSystemClipboard
export function serializePixelSystemClipboard(clipboard: PixelSystemClipboard): string
export function deserializePixelSystemClipboard(text: string): PixelSystemClipboard
export function pixelSystemClipboardFromRgba(
  width: number,
  height: number,
  rgba: Uint8Array | Uint8ClampedArray,
): PixelSystemClipboard
export function pixelSystemClipboardToRgba(clipboard: PixelSystemClipboard): {
  width: number
  height: number
  rgba: Uint8ClampedArray
}
export function pastePixelSystemClipboard(
  document: import('./pixelCore.mjs').PixelDocument,
  clipboard: PixelSystemClipboard,
  target: { x: number; y: number },
  options?: { mode?: 'replace' | 'opaque-only' },
): PixelSystemClipboardPasteResult
