import { runPixelComputation, type PixelComputationRequest } from '../../lib/pixel/pixelComputation.mjs'

type WorkerScope = {
  onmessage: ((event: MessageEvent<PixelComputationRequest>) => void) | null
  postMessage: (message: unknown, transfer?: Transferable[]) => void
}

const scope = globalThis as unknown as WorkerScope

function collectTransferables(value: unknown, seen = new Set<ArrayBuffer>()): Transferable[] {
  if (value instanceof ArrayBuffer) {
    if (seen.has(value)) return []
    seen.add(value)
    return [value]
  }
  if (ArrayBuffer.isView(value)) return collectTransferables(value.buffer, seen)
  if (value === null || typeof value !== 'object') return []
  const result: Transferable[] = []
  for (const child of Object.values(value)) result.push(...collectTransferables(child, seen))
  return result
}

function serializeError(error: unknown) {
  if (error && typeof error === 'object') {
    const source = error as { name?: unknown; code?: unknown; message?: unknown; details?: unknown }
    return {
      name: typeof source.name === 'string' ? source.name : 'PixelComputationError',
      code: typeof source.code === 'string' ? source.code : 'PIXEL_COMPUTATION_WORKER',
      message: typeof source.message === 'string' ? source.message : 'Pixel computation Worker failed',
      ...(source.details === undefined ? {} : { details: source.details }),
    }
  }
  return { name: 'PixelComputationError', code: 'PIXEL_COMPUTATION_WORKER', message: String(error) }
}

scope.onmessage = (event) => {
  const request = event.data
  try {
    const response = runPixelComputation(request)
    scope.postMessage({ ok: true, ...response }, collectTransferables(response.result))
  } catch (error) {
    const source = request && typeof request === 'object' ? request as Partial<PixelComputationRequest> : {}
    scope.postMessage({
      ok: false,
      requestId: source.requestId,
      documentId: source.documentId,
      revision: source.revision,
      operation: source.operation,
      error: serializeError(error),
    })
  }
}

export {}
