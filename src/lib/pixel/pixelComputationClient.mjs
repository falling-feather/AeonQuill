import {
  PixelComputationError,
  runPixelComputation,
} from './pixelComputation.mjs'

function abortError(message = 'Pixel computation was cancelled') {
  const error = typeof DOMException === 'function'
    ? new DOMException(message, 'AbortError')
    : Object.assign(new Error(message), { name: 'AbortError' })
  return error
}

function defaultWorkerFactory() {
  if (typeof Worker !== 'function') {
    throw new PixelComputationError('WORKER_UNAVAILABLE', 'Pixel computation Worker is unavailable')
  }
  return new Worker(new URL('../../modes/pixel/pixelComputation.worker.ts', import.meta.url), { type: 'module' })
}

function structuredError(errorInput) {
  const error = new PixelComputationError(
    errorInput?.code ?? 'PIXEL_COMPUTATION_WORKER',
    errorInput?.message ?? 'Pixel computation Worker failed',
    errorInput?.details,
  )
  error.name = errorInput?.name ?? 'PixelComputationError'
  return error
}

export class PixelComputationClient {
  constructor(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('PixelComputationClient options must be an object')
    }
    const unknown = Object.keys(options).filter((key) => !['workerFactory', 'syncFallback'].includes(key))
    if (unknown.length > 0) throw new TypeError(`Unknown PixelComputationClient option ${unknown[0]}`)
    this.workerFactory = options.workerFactory ?? defaultWorkerFactory
    this.syncFallback = options.syncFallback ?? runPixelComputation
    this.worker = null
    this.active = null
    this.disposed = false
    this.sequence = 0
  }

  run(request, options = {}) {
    if (this.disposed) return Promise.reject(new PixelComputationError('CLIENT_DISPOSED', 'Pixel computation client is disposed'))
    const signal = options?.signal
    if (signal?.aborted) return Promise.reject(abortError())
    this.cancel()
    const token = ++this.sequence
    let worker
    try {
      worker = this.workerFactory()
    } catch {
      return this.runFallback(request, { signal, token })
    }
    if (!worker || typeof worker.postMessage !== 'function' || typeof worker.terminate !== 'function') {
      try { worker?.terminate?.() } catch {}
      return this.runFallback(request, { signal, token })
    }
    this.worker = worker
    return new Promise((resolve, reject) => {
      const active = { token, request, worker, resolve, reject, signal, abortHandler: null }
      this.active = active
      const finish = (callback) => {
        if (this.active !== active) return false
        this.active = null
        if (this.worker === worker) this.worker = null
        if (signal && active.abortHandler) signal.removeEventListener('abort', active.abortHandler)
        try { worker.terminate() } catch {}
        callback()
        return true
      }
      worker.onmessage = (event) => {
        if (this.active !== active || active.token !== token) return
        const data = event?.data
        if (!data || data.requestId !== request.requestId || data.documentId !== request.documentId
          || data.revision !== request.revision || data.operation !== request.operation) return
        if (data.ok === false) {
          finish(() => reject(structuredError(data.error)))
          return
        }
        if (data.ok !== true) return
        finish(() => resolve(data.result))
      }
      worker.onerror = (event) => {
        if (!finish(() => {})) return
        this.runFallback(request, { signal }).then(resolve, reject)
      }
      if (signal) {
        active.abortHandler = () => {
          if (!finish(() => reject(abortError()))) return
        }
        signal.addEventListener('abort', active.abortHandler, { once: true })
      }
      try {
        worker.postMessage(request)
      } catch {
        if (!finish(() => {})) return
        this.runFallback(request, { signal }).then(resolve, reject)
      }
    })
  }

  runFallback(request, options = {}) {
    if (this.disposed) return Promise.reject(new PixelComputationError('CLIENT_DISPOSED', 'Pixel computation client is disposed'))
    const signal = options?.signal
    if (signal?.aborted) return Promise.reject(abortError())
    const token = options?.token ?? ++this.sequence
    return new Promise((resolve, reject) => {
      const active = { token, request, worker: null, resolve, reject, signal, abortHandler: null }
      this.active = active
      const finish = (callback) => {
        if (this.active !== active || active.token !== token) return false
        this.active = null
        if (signal && active.abortHandler) signal.removeEventListener('abort', active.abortHandler)
        callback()
        return true
      }
      if (signal) {
        active.abortHandler = () => {
          if (!finish(() => reject(abortError()))) return
        }
        signal.addEventListener('abort', active.abortHandler, { once: true })
      }
      Promise.resolve().then(() => this.syncFallback(request)).then((response) => {
        finish(() => resolve(response.result ?? response))
      }, (error) => {
        finish(() => reject(error))
      })
    })
  }

  cancel() {
    const active = this.active
    if (!active) return
    this.active = null
    if (this.worker === active.worker) this.worker = null
    if (active.signal && active.abortHandler) active.signal.removeEventListener('abort', active.abortHandler)
    try { active.worker?.terminate?.() } catch {}
    active.reject(abortError())
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.cancel()
    this.worker = null
  }
}
