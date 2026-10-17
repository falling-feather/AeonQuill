import type { CanvasDocument } from './canvasCore'

export function rememberCanvasDraft(document: CanvasDocument): void
export function getCanvasDraft(projectId: string): CanvasDocument | null
export function markCanvasDraftPersisted(document: CanvasDocument): void
export function discardCanvasDraft(projectId: string): void
export function discardCanvasDraftIfCurrent(projectId: string, expectedDocument: CanvasDocument | null | undefined): boolean
export function enqueueCanvasProjectMutation<T>(projectId: string, mutation: () => Promise<T> | T): Promise<T>
export function flushCanvasProjectMutation(projectId: string): Promise<void>
export function queueCanvasDocumentSave<T>(
  document: CanvasDocument,
  saveFn: (document: CanvasDocument) => Promise<T> | T,
): Promise<T>
