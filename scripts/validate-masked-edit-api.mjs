import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const sourcePath = fileURLToPath(new URL('../src/assets/sample-summer-character.png', import.meta.url))
const keepRuntime = process.env.AEONQUILL_KEEP_MASKED_EDIT_SMOKE === '1'

function delay(duration) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, duration))
}

async function availablePort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer()
    server.unref()
    server.once('error', rejectPromise)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : null
      server.close((error) => error ? rejectPromise(error) : resolvePromise(port))
    })
  })
}

async function terminateProcessTree(child) {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32') {
    await new Promise((resolvePromise) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
      killer.once('error', () => {
        child.kill()
        resolvePromise()
      })
      killer.once('exit', resolvePromise)
    })
    return
  }
  child.kill('SIGTERM')
  await Promise.race([new Promise((resolvePromise) => child.once('exit', resolvePromise)), delay(3_000)])
  if (child.exitCode === null) child.kill('SIGKILL')
}

function assertSafeTemporaryDirectory(directory) {
  const separator = process.platform === 'win32' ? '\\' : '/'
  const tempRoot = `${resolve(tmpdir())}${separator}`.toLowerCase()
  const target = resolve(directory).toLowerCase()
  if (!target.startsWith(tempRoot) || !basename(directory).startsWith('aeonquill-masked-edit-')) {
    throw new Error(`Refusing to clean unexpected masked-edit smoke directory: ${directory}`)
  }
}

async function waitForTerminalJob(request, jobId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const response = await request(`/api/jobs/${encodeURIComponent(jobId)}`)
    assert.equal(response.status, 200)
    const { job } = await response.json()
    if (['completed', 'failed', 'cancelled'].includes(job.status) && job.scheduling?.finishedAt) {
      return job
    }
    await delay(100)
  }
  throw new Error(`masked adjustment timed out: ${jobId}`)
}

async function main() {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), 'aeonquill-masked-edit-'))
  const port = await availablePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const stderr = []
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: projectRoot,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      MIAOHUI_RUNTIME_DIR: runtimeDirectory,
      MIAOHUI_PORT: String(port),
      MIAOHUI_HOST: '127.0.0.1',
      MIAOHUI_COMFY_POLICY: 'manual',
    },
  })
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)))

  try {
    const readyDeadline = Date.now() + 20_000
    let healthResponse
    while (Date.now() < readyDeadline && child.exitCode === null) {
      try {
        healthResponse = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) })
        if (healthResponse.ok) break
      } catch {}
      await delay(150)
    }
    assert.equal(healthResponse?.ok, true, `bridge failed to start\n${stderr.join('')}`)
    const sessionCookie = String(healthResponse.headers.get('set-cookie') || '').split(';', 1)[0]
    assert.match(sessionCookie, /^miaohui_session=/)
    const request = (pathname, options = {}) => fetch(`${baseUrl}${pathname}`, {
      ...options,
      headers: { cookie: sessionCookie, ...options.headers },
    })

    const toolsResponse = await request('/api/image-tools?refresh=1')
    assert.equal(toolsResponse.status, 200)
    const manifest = await toolsResponse.json()
    const capability = manifest.operations.find((operation) => operation.id === 'masked-adjust')
    assert.equal(capability?.available, true, JSON.stringify(capability))
    assert.equal(capability?.deterministic, true)

    const sourceBytes = await readFile(sourcePath)
    const imageDataUrl = `data:image/png;base64,${sourceBytes.toString('base64')}`
    const invalidResponse = await request('/api/jobs/image', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'masked-edit-missing-mask-001',
      },
      body: JSON.stringify({
        operation: 'masked-adjust',
        sourceImageDataUrl: imageDataUrl,
        params: { effect: 'background-dim', strength: 0.6, feather: 4 },
      }),
    })
    assert.equal(invalidResponse.status, 400)

    const createResponse = await request('/api/jobs/image', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'masked-edit-smoke-001',
      },
      body: JSON.stringify({
        operation: 'masked-adjust',
        sourceImageDataUrl: imageDataUrl,
        maskImageDataUrl: imageDataUrl,
        sourceElementId: 'semantic-derived-1',
        params: { effect: 'background-blur', strength: 0.7, feather: 6 },
      }),
    })
    const created = await createResponse.json()
    assert.equal(createResponse.status, 202, JSON.stringify(created))
    const jobId = created.job.id
    const sseController = new AbortController()
    const sseResponse = await request('/api/jobs/events', { signal: sseController.signal })
    assert.equal(sseResponse.status, 200)
    assert.match(sseResponse.headers.get('content-type') || '', /text\/event-stream/)
    const sseChunk = new TextDecoder().decode((await sseResponse.body.getReader().read()).value)
    assert.match(sseChunk, new RegExp(jobId))
    sseController.abort()

    const terminalJob = await waitForTerminalJob(request, jobId)
    assert.equal(terminalJob.status, 'completed', JSON.stringify(terminalJob.error || terminalJob))
    assert.equal(terminalJob.output?.provider, 'ffmpeg')
    assert.equal(terminalJob.request?.maskProvided, true)
    assert.equal(terminalJob.request?.maskImageDataUrl, undefined)
    assert.equal(terminalJob.inputPath, undefined)
    assert.equal(terminalJob.maskPath, undefined)
    assert.ok(terminalJob.outputUrl)

    const assetResponse = await request(terminalJob.outputUrl)
    assert.equal(assetResponse.status, 200)
    const outputBytes = Buffer.from(await assetResponse.arrayBuffer())
    assert.ok(outputBytes.length > 1_024)
    assert.equal(outputBytes.subarray(1, 4).toString('ascii'), 'PNG')

    const cancellableResponse = await request('/api/jobs/image', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'masked-edit-cancel-001',
      },
      body: JSON.stringify({
        operation: 'masked-adjust',
        sourceImageDataUrl: imageDataUrl,
        maskImageDataUrl: imageDataUrl,
        sourceElementId: 'semantic-derived-cancel',
        params: { effect: 'background-blur', strength: 1, feather: 32 },
      }),
    })
    const cancellable = await cancellableResponse.json()
    assert.equal(cancellableResponse.status, 202, JSON.stringify(cancellable))
    const cancelResponse = await request(`/api/jobs/${encodeURIComponent(cancellable.job.id)}/cancel`, {
      method: 'POST',
    })
    const cancelled = await cancelResponse.json()
    assert.equal(cancelResponse.status, 200, JSON.stringify(cancelled))
    assert.equal(cancelled.job.status, 'cancelled')

    const retryResponse = await request(`/api/jobs/${encodeURIComponent(cancellable.job.id)}/retry`, {
      method: 'POST',
      headers: { 'idempotency-key': 'masked-edit-retry-001' },
    })
    const retried = await retryResponse.json()
    assert.equal(retryResponse.status, 202, JSON.stringify(retried))
    assert.equal(retried.job.retryOf, cancellable.job.id)
    assert.equal(retried.job.request?.maskProvided, true)
    const retryTerminal = await waitForTerminalJob(request, retried.job.id)
    assert.equal(retryTerminal.status, 'completed', JSON.stringify(retryTerminal.error || retryTerminal))
    assert.equal(retryTerminal.maskPath, undefined)
    console.log(`[masked-edit-smoke] completed=${jobId}`)
    console.log(`[masked-edit-smoke] output=${terminalJob.output.width}x${terminalJob.output.height}`)
    console.log(`[masked-edit-smoke] cancelled=${cancellable.job.id} retried=${retried.job.id}`)
  } finally {
    await terminateProcessTree(child)
    if (!keepRuntime) {
      assertSafeTemporaryDirectory(runtimeDirectory)
      await rm(runtimeDirectory, { recursive: true, force: true })
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
