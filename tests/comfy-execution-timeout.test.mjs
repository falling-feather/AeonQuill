import assert from 'node:assert/strict'
import test from 'node:test'
import { ComfyClient } from '../server/comfy-client.mjs'

function setup(t) {
  const client = new ComfyClient('http://127.0.0.1:1')
  client.history = async () => null
  const socket = new EventTarget()
  socket.readyState = WebSocket.OPEN
  const controller = new AbortController()
  const timers = []
  t.mock.method(globalThis, 'setTimeout', (callback, milliseconds) => {
    const timer = { callback, milliseconds }
    timers.push(timer)
    return timer
  })
  t.after(() => controller.abort())
  return { client, socket, controller, timers }
}

test('Comfy result waiting honors a long execution budget instead of a hard two-hour cutoff', async t => {
  const { client, socket, controller, timers } = setup(t)
  const pending = client.waitForPrompt(socket, 'long-native-12', controller.signal, () => {}, { timeoutMs: 8 * 60 * 60 * 1000 })
  pending.catch(() => {})
  assert.equal(timers.at(-1).milliseconds, 8 * 60 * 60 * 1000)
  timers.at(-1).callback()
  await assert.rejects(pending, error => error.code === 'COMFY_EXECUTION_TIMEOUT')
})

test('old callers keep the two-hour default and cancellation still settles the wait', async t => {
  const { client, socket, controller, timers } = setup(t)
  const pending = client.waitForPrompt(socket, 'legacy', controller.signal, () => {})
  pending.catch(() => {})
  assert.equal(timers.at(-1).milliseconds, 2 * 60 * 60 * 1000)
  controller.abort()
  await assert.rejects(pending, error => error.name === 'AbortError')
})

test('execution tracker forwards an explicit budget to the actual wait', async t => {
  const { client, controller } = setup(t)
  const nativeWebSocket = globalThis.WebSocket
  globalThis.WebSocket = class extends EventTarget {
    constructor() {
      super()
      this.readyState = 1
      queueMicrotask(() => this.dispatchEvent(new Event('open')))
    }
    close() { this.readyState = 3 }
  }
  t.after(() => { globalThis.WebSocket = nativeWebSocket })
  let forwarded
  client.waitForPrompt = (...args) => { forwarded = args; return Promise.resolve(null) }
  const tracker = await client.openExecutionTracker('budget-client')
  const options = { timeoutMs: 8 * 60 * 60 * 1000 }
  await tracker.waitForPrompt('prompt', controller.signal, options)
  assert.equal(forwarded[4], options)
  tracker.close()
})

test('an already cancelled long wait rejects without registering a timer', async t => {
  const { client, socket, controller, timers } = setup(t)
  controller.abort()
  const pending = client.waitForPrompt(socket, 'cancelled', controller.signal, () => {}, { timeoutMs: 8 * 60 * 60 * 1000 })
  pending.catch(() => {})
  if (timers.length) timers.at(-1).callback()
  await assert.rejects(pending, error => error.name === 'AbortError')
  assert.equal(timers.length, 0)
})

test('Comfy waiting rejects invalid Node timer bounds before attaching a wait', t => {
  const { client, socket, controller, timers } = setup(t)
  for (const timeoutMs of [0, -1, NaN, Infinity, 2_147_483_648]) {
    let pending
    try {
      assert.throws(() => {
        pending = client.waitForPrompt(socket, 'invalid', controller.signal, () => {}, { timeoutMs })
        pending?.catch(() => {})
      }, RangeError)
    } finally {
      controller.abort()
    }
  }
  assert.equal(timers.length, 0)
})
