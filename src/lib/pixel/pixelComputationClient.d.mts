import type { PixelComputationRequest } from './pixelComputation.mjs'

export type PixelComputationWorkerLike = {
  onmessage: ((event: MessageEvent) => void) | null
  onerror: ((event: Event) => void) | null
  postMessage(message: unknown): void
  terminate(): void
}

export type PixelComputationClientOptions = {
  workerFactory?: () => PixelComputationWorkerLike
  /** Used for ordinary operations only; image-convert always requires a Worker. */
  syncFallback?: (request: PixelComputationRequest) => unknown
}

export class PixelComputationClient {
  constructor(options?: PixelComputationClientOptions)
  run(request: PixelComputationRequest, options?: { signal?: AbortSignal }): Promise<unknown>
  cancel(): void
  dispose(): void
}
