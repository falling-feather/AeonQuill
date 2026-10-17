import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { encodeWorkspaceRequestBody, prepareWorkspaceRequestBody } from '../src/lib/workspaceRequestBody.mjs'

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

test('large request body remains exact UTF-8 JSON including lone surrogates and escapes', async () => {
  const input = { value: '像素🙂\ud800\n"'.repeat(170_000), revision: 4, baseRevision: 3 }
  const body = encodeWorkspaceRequestBody(input)
  assert.ok(body instanceof Blob)
  assert.equal(body.type, 'application/json')
  assert.equal(digest(new Uint8Array(await body.arrayBuffer())), digest(Buffer.from(JSON.stringify(input))))
  assert.equal(encodeWorkspaceRequestBody({ value: 'small' }), '{"value":"small"}')
})

test('large body preparation defers encoding to a worker and terminates it after the result', async () => {
  let posted
  let terminated = 0
  const worker = { postMessage(value) { posted = value }, terminate() { terminated += 1 } }
  const input = { value: 'x'.repeat(1_100_000), baseRevision: 2 }
  const pending = prepareWorkspaceRequestBody(input, { workerFactory: () => worker })
  assert.equal(posted, input)
  const encoded = encodeWorkspaceRequestBody(input)
  worker.onmessage({ data: { ok: true, body: encoded } })
  assert.equal(await pending, encoded)
  assert.equal(terminated, 1)
})

test('worker transport failure reuses the canonical encoder while algorithm errors are returned', async () => {
  const input = { value: 'x'.repeat(1_100_000) }
  const fallback = await prepareWorkspaceRequestBody(input, { workerFactory: () => { throw new Error('unavailable') } })
  assert.ok(fallback instanceof Blob)
  let terminated = 0
  const worker = { postMessage() {}, terminate() { terminated += 1 } }
  const pending = prepareWorkspaceRequestBody(input, { workerFactory: () => worker })
  worker.onmessage({ data: { ok: false, error: 'encoding rejected' } })
  await assert.rejects(pending, /encoding rejected/u)
  assert.equal(terminated, 1)
})

test('small requests use the original string path without constructing a worker', async () => {
  const body = await prepareWorkspaceRequestBody({ value: 'a' }, { workerFactory: () => { throw new Error('should not run') } })
  assert.equal(body, '{"value":"a"}')
})
