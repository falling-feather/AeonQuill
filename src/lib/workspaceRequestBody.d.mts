type BodyWorker = {
  onmessage?: ((event: { data: unknown }) => void) | null
  onerror?: (() => void) | null
  postMessage(value: unknown): void
  terminate(): void
}
export function encodeWorkspaceRequestBody(input: unknown): string | Blob
export function prepareWorkspaceRequestBody(input: unknown, options?: {
  workerFactory?: () => BodyWorker
}): Promise<string | Blob>
