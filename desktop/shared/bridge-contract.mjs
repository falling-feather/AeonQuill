import { createServer } from 'node:net'
import { isAbsolute, relative, resolve } from 'node:path'

export const LOOPBACK_HOST = '127.0.0.1'
export const BRIDGE_START_TIMEOUT_MS = 20_000

function delay(duration) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, duration))
}

export function isPathInside(parentDirectory, candidatePath) {
  if (!parentDirectory || !candidatePath) return false
  const relativePath = relative(resolve(parentDirectory), resolve(candidatePath))
  return Boolean(relativePath) && !relativePath.startsWith('..') && !isAbsolute(relativePath)
}

export async function findAvailableLoopbackPort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const reservation = createServer()
    reservation.unref()
    reservation.once('error', rejectPromise)
    reservation.listen(0, LOOPBACK_HOST, () => {
      const address = reservation.address()
      const port = typeof address === 'object' && address ? address.port : null
      reservation.close((error) => {
        if (error) rejectPromise(error)
        else if (!port) rejectPromise(new Error('Unable to reserve a local bridge port'))
        else resolvePromise(port)
      })
    })
  })
}

export async function waitForBridgeReady({
  baseUrl,
  isProcessAlive = () => true,
  timeoutMs = BRIDGE_START_TIMEOUT_MS,
  fetchImpl = fetch,
}) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline && isProcessAlive()) {
    try {
      const response = await fetchImpl(`${baseUrl}/api/health`, {
        redirect: 'error',
        signal: AbortSignal.timeout(1_000),
      })
      if (!response.ok) throw new Error(`health returned HTTP ${response.status}`)
      const health = await response.json()
      if (health?.ok !== true || health?.service !== 'miaohui-local-bridge') {
        throw new Error('health response did not identify the MiaoHui bridge')
      }
      return health
    } catch (error) {
      lastError = error
    }
    await delay(120)
  }
  const reason = isProcessAlive()
    ? `timed out after ${timeoutMs}ms`
    : 'bridge process exited before becoming ready'
  throw new Error(`Local bridge ${reason}: ${lastError?.message || 'no health response'}`)
}

export async function waitForBridgeClosed({ baseUrl, timeoutMs = 5_000, fetchImpl = fetch }) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await fetchImpl(`${baseUrl}/api/health`, {
        redirect: 'error',
        signal: AbortSignal.timeout(400),
      })
    } catch {
      return true
    }
    await delay(80)
  }
  return false
}
