import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PixelComputationError,
} from '../src/lib/pixel/pixelComputation.mjs'
import { PixelComputationClient } from '../src/lib/pixel/pixelComputationClient.mjs'
import {
  createPixelDocument,
  renderPixelFrameRgba,
} from '../src/lib/pixel/pixelCore.mjs'

function makeDocument() {
  return createPixelDocument({ id: 'client-fixture', name: 'Client fixture', width: 1, height: 1 })
}

function request(document, operation, options = {}, source) {
  return {
    requestId: `request-${operation}`,
    documentId: document.id,
    revision: document.revision,
    operation,
    document,
    options,
    ...(source === undefined ? {} : { source }),
  }
}

function imageSource() {
  return { width: 1, height: 1, data: [12, 34, 56, 255] }
}

function expectConversionWorkerRequired(error) {
  return error instanceof PixelComputationError
    && error.code === 'PIXEL_CONVERSION_WORKER_REQUIRED'
    && error.message.includes('图像转换')
}

test('image-convert rejects Worker factory failure without invoking synchronous fallback', async () => {
  const document = makeDocument()
  let fallbackCalls = 0
  const client = new PixelComputationClient({
    workerFactory: () => { throw new Error('worker unavailable') },
    syncFallback: () => { fallbackCalls += 1; return { result: 'unexpected' } },
  })

  await assert.rejects(
    client.run(request(document, 'image-convert', {}, imageSource())),
    expectConversionWorkerRequired,
  )
  assert.equal(fallbackCalls, 0)
  client.dispose()
})

test('image-convert rejects an invalid Worker without invoking synchronous fallback', async () => {
  const document = makeDocument()
  let fallbackCalls = 0
  let terminated = 0
  const client = new PixelComputationClient({
    workerFactory: () => ({ terminate() { terminated += 1 } }),
    syncFallback: () => { fallbackCalls += 1; return { result: 'unexpected' } },
  })

  await assert.rejects(
    client.run(request(document, 'image-convert', {}, imageSource())),
    expectConversionWorkerRequired,
  )
  assert.equal(terminated, 1)
  assert.equal(fallbackCalls, 0)
  client.dispose()
})

test('image-convert rejects Worker onerror and postMessage failure without fallback', async () => {
  const document = makeDocument()
  const workers = []
  let fallbackCalls = 0
  const client = new PixelComputationClient({
    workerFactory: () => {
      const worker = {
        onmessage: null,
        onerror: null,
        postMessage() {},
        terminate() { this.terminated = true },
      }
      workers.push(worker)
      return worker
    },
    syncFallback: () => { fallbackCalls += 1; return { result: 'unexpected' } },
  })

  const errored = client.run(request(document, 'image-convert', {}, imageSource()))
  await Promise.resolve()
  workers[0].onerror?.(new Error('worker crashed'))
  await assert.rejects(errored, expectConversionWorkerRequired)

  const throwingWorker = {
    onmessage: null,
    onerror: null,
    postMessage() { throw new Error('post failed') },
    terminate() { this.terminated = true },
  }
  client.workerFactory = () => throwingWorker
  const posted = client.run(request(document, 'image-convert', {}, imageSource()))
  await assert.rejects(posted, expectConversionWorkerRequired)

  assert.equal(fallbackCalls, 0)
  assert.equal(throwingWorker.terminated, true)
  client.dispose()
})

test('ordinary frame computation keeps synchronous fallback behavior', async () => {
  const document = makeDocument()
  let fallbackCalls = 0
  const client = new PixelComputationClient({
    workerFactory: () => { throw new Error('worker unavailable') },
    syncFallback: (input) => {
      fallbackCalls += 1
      return { result: renderPixelFrameRgba(input.document, 'frame-1') }
    },
  })

  const result = await client.run(request(document, 'frame', { frameId: 'frame-1' }))
  assert.deepEqual(Array.from(result), [0, 0, 0, 0])
  assert.equal(fallbackCalls, 1)
  client.dispose()
})
