import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import {
  findAvailableLoopbackPort,
  isPathInside,
  waitForBridgeClosed,
  waitForBridgeReady,
} from '../desktop/shared/bridge-contract.mjs'

test('desktop bridge contract reserves a loopback port', async () => {
  const port = await findAvailableLoopbackPort()
  assert.ok(Number.isInteger(port) && port > 0 && port < 65_536)
})

test('desktop bridge contract validates paths without prefix confusion', () => {
  assert.equal(isPathInside('C:\\runtime', 'C:\\runtime\\reports\\qa.json'), true)
  assert.equal(isPathInside('C:\\runtime', 'C:\\runtime-other\\qa.json'), false)
  assert.equal(isPathInside('C:\\runtime', 'C:\\runtime'), false)
})

test('desktop bridge contract recognizes readiness and closure', async (context) => {
  const server = createServer((request, response) => {
    if (request.url === '/api/health') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, service: 'miaohui-local-bridge', version: 'test' }))
      return
    }
    response.writeHead(404).end()
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  context.after(() => server.close())
  const address = server.address()
  const baseUrl = `http://127.0.0.1:${address.port}`

  const health = await waitForBridgeReady({ baseUrl, timeoutMs: 1_000 })
  assert.equal(health.version, 'test')
  await new Promise((resolvePromise) => server.close(resolvePromise))
  assert.equal(await waitForBridgeClosed({ baseUrl, timeoutMs: 1_000 }), true)
})
