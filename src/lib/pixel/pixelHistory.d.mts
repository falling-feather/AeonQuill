import type { PixelCommand, PixelDocument } from './pixelCore.mjs'

export type PixelDocumentHistorySnapshot = {
  kind: 'document-snapshot'
  document: PixelDocument
}

export type PixelHistoryEntry = PixelCommand | PixelDocumentHistorySnapshot

export function createPixelDocumentHistoryEntry(document: PixelDocument): PixelDocumentHistorySnapshot
export function applyPixelHistoryEntry(
  currentDocument: PixelDocument,
  entry: PixelHistoryEntry,
  commandId: string,
): { document: PixelDocument; inverse: PixelHistoryEntry }
