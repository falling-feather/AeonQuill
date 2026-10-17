import type { PixelDocument } from './pixelCore.mjs'

export type AsepriteDecodeOptions = {
  documentId?: string
  documentName?: string
}

export type AsepriteDecodeResult = {
  document: PixelDocument
  warnings: string[]
}

export type AsepriteEncodeResult = {
  bytes: Uint8Array
  warnings: string[]
}

export class AsepriteFormatError extends Error {
  code: string
  details?: unknown
}

export function decodeAseprite(
  bytes: Uint8Array | ArrayBuffer,
  options?: AsepriteDecodeOptions,
): Promise<AsepriteDecodeResult>

export function encodeAseprite(document: PixelDocument): Promise<AsepriteEncodeResult>
