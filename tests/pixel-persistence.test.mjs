import assert from 'node:assert/strict'
import test from 'node:test'
import { createPixelDocument } from '../src/lib/pixel/pixelCore.mjs'
import { runPixelComputation } from '../src/lib/pixel/pixelComputation.mjs'
import { serializePixelDocumentOffThread } from '../src/lib/pixel/pixelPersistence.mjs'

function installWorker(t, implementation) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'Worker')
  Object.defineProperty(globalThis, 'Worker', { value: implementation, configurable: true, writable: true })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'Worker', previous)
    else delete globalThis.Worker
  })
}

test('small pixel documents keep the canonical bytes without constructing a worker', async (t) => {
  installWorker(t, class { constructor() { throw new Error('small document must not create worker') } })
  const document = createPixelDocument()
  assert.equal(await serializePixelDocumentOffThread(document), JSON.stringify(document))
})

test('newer serialization cancels the same document worker and releases both worker lifetimes', async (t) => {
  const workers = []
  class WorkerStub {
    constructor() { workers.push(this); this.terminated = false }
    postMessage(request) { this.request = request }
    terminate() { this.terminated = true }
    finish() { this.onmessage({ data: { ok: true, ...runPixelComputation(this.request) } }) }
  }
  installWorker(t, WorkerStub)
  const document = createPixelDocument({ width: 512, height: 512 })
  const first = serializePixelDocumentOffThread(document)
  first.catch(() => undefined)
  const next = { ...document, revision: 1 }
  const second = serializePixelDocumentOffThread(next)
  const firstWasCancelled = workers[0].terminated
  if (!firstWasCancelled) workers[0].finish()
  workers[1].finish()
  assert.equal(firstWasCancelled, true)
  await assert.rejects(first, { name: 'AbortError' })
  assert.equal(await second, JSON.stringify(next))
  assert.ok(workers.every(({ terminated }) => terminated))
})
