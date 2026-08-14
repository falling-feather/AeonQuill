import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const sourcePath = fileURLToPath(new URL('../src/assets/sample-summer-character.png', import.meta.url))
const keepRuntime = process.env.AEONQUILL_KEEP_SEMANTIC_SMOKE === '1'

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
  const tempRoot = `${resolve(tmpdir())}${process.platform === 'win32' ? '\\' : '/'}`.toLowerCase()
  const target = resolve(directory).toLowerCase()
  if (!target.startsWith(tempRoot) || !basename(directory).startsWith('aeonquill-semantic-')) {
    throw new Error(`Refusing to clean unexpected semantic smoke directory: ${directory}`)
  }
}

async function main() {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), 'aeonquill-semantic-'))
  const port = await availablePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const stdout = []
  const stderr = []
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: projectRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MIAOHUI_RUNTIME_DIR: runtimeDirectory,
      MIAOHUI_PORT: String(port),
      MIAOHUI_HOST: '127.0.0.1',
      MIAOHUI_COMFY_POLICY: 'idle',
      MIAOHUI_COMFY_IDLE_SECONDS: '30',
    },
  })
  child.stdout.on('data', (chunk) => stdout.push(String(chunk)))
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

    const catalogResponse = await request('/api/semantic-workflows?refresh=1')
    assert.equal(catalogResponse.status, 200)
    const catalog = await catalogResponse.json()
    const elementExtract = catalog.workflows.find((workflow) => workflow.id === 'element-extract')
    assert.equal(elementExtract?.implemented, true)
    assert.equal(elementExtract?.installed, true, JSON.stringify(elementExtract))
    console.log(`[semantic-smoke] catalog=${elementExtract.status}`)

    const sourceBytes = await readFile(sourcePath)
    const createResponse = await request('/api/jobs/semantic-image', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'semantic-smoke-element-001',
      },
      body: JSON.stringify({
        workflowId: 'element-extract',
        sourceImageDataUrl: `data:image/png;base64,${sourceBytes.toString('base64')}`,
        sourceElementId: 'semantic-smoke-source',
        params: {
          positivePoints: [{ x: 0.51, y: 0.48 }],
          negativePoints: [{ x: 0.08, y: 0.08 }],
          threshold: 0.8,
        },
      }),
    })
    const created = await createResponse.json()
    assert.equal(createResponse.status, 202, JSON.stringify(created))
    const jobId = created.job.id
    let previousDetail
    let terminalJob
    const jobDeadline = Date.now() + 8 * 60_000
    while (Date.now() < jobDeadline) {
      const response = await request(`/api/jobs/${encodeURIComponent(jobId)}`)
      assert.equal(response.status, 200)
      const { job } = await response.json()
      if (job.detail !== previousDetail) {
        console.log(`[semantic-smoke] ${job.progress}% ${job.detail}`)
        previousDetail = job.detail
      }
      if (['completed', 'failed', 'cancelled'].includes(job.status) && job.scheduling?.finishedAt) {
        terminalJob = job
        break
      }
      await delay(750)
    }
    assert.ok(terminalJob, 'semantic element extraction timed out')
    assert.equal(terminalJob.status, 'completed', JSON.stringify(terminalJob.error || terminalJob))
    assert.equal(terminalJob.output?.provider, 'comfy-impact-sam')
    assert.ok(terminalJob.outputUrl && terminalJob.maskUrl)

    const localConfig = JSON.parse(await readFile(join(projectRoot, 'config', 'local.json'), 'utf8'))
    const managedUploadPath = join(localConfig.comfyRoot, 'input', `aeonquill-${jobId}.png`)
    await assert.rejects(() => readFile(managedUploadPath), { code: 'ENOENT' })

    for (const pathname of [terminalJob.outputUrl, terminalJob.maskUrl]) {
      const response = await request(pathname)
      assert.equal(response.status, 200)
      const bytes = Buffer.from(await response.arrayBuffer())
      assert.ok(bytes.length > 1_024)
      assert.equal(bytes.subarray(1, 4).toString('ascii'), 'PNG')
    }

    const stopResponse = await request('/api/runtime/stop', { method: 'POST' })
    assert.ok([200, 409].includes(stopResponse.status))
    console.log(`[semantic-smoke] completed=${jobId}`)
    console.log(`[semantic-smoke] runtime=${runtimeDirectory}`)
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
