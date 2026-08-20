import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { loadReleaseMetadata, resolveReleasePaths } from '../desktop/release/release-meta.mjs'
import { OFFLINE_RUNTIME_PACKAGE_ID, probeOfflineRuntimePackage } from '../server/offline-runtime.mjs'

const execFileAsync = promisify(execFile)
const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const metadata = await loadReleaseMetadata(projectRoot)
const sidecarPath = resolveReleasePaths(metadata).sourceSidecar
const runtimePackageRoot = join(
  projectRoot,
  '.runtime',
  'releases',
  'offline',
  `AEONQUILL_${metadata.version}_windows_x64_full`,
  'runtime',
  OFFLINE_RUNTIME_PACKAGE_ID,
)
const qaRoot = join(projectRoot, '.runtime', 'qa')
const reportPath = join(qaRoot, 'offline-sidecar-final.json')
const sourceImagePath = join(projectRoot, 'src', 'assets', 'sample-summer-character.png')

function availablePort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const reservation = createServer()
    reservation.unref()
    reservation.once('error', rejectPromise)
    reservation.listen(0, '127.0.0.1', () => {
      const address = reservation.address()
      reservation.close((error) => error
        ? rejectPromise(error)
        : resolvePromise(typeof address === 'object' && address ? address.port : null))
    })
  })
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null) return Promise.resolve(child?.exitCode ?? null)
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise('timeout'), timeoutMs)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolvePromise(code)
    })
  })
}

async function forceStop(child) {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32') {
    await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      timeout: 15_000,
    }).catch(() => undefined)
  } else {
    child.kill('SIGKILL')
  }
  await waitForExit(child, 15_000)
}

async function waitForBridge(baseUrl, child, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Packaged sidecar exited with code ${child.exitCode}`)
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_500) })
      if (response.ok) {
        const cookie = String(response.headers.get('set-cookie') || '').split(';', 1)[0]
        assert.ok(cookie, 'Packaged sidecar did not issue a local session cookie')
        return cookie
      }
    } catch {
      // The sidecar is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
  }
  throw new Error('Packaged sidecar did not become ready')
}

async function requestJson(baseUrl, cookie, pathname, options = {}, expectedStatus = 200) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      cookie,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
    signal: options.signal || AbortSignal.timeout(180_000),
  })
  const payload = await response.json()
  assert.equal(response.status, expectedStatus, `${options.method || 'GET'} ${pathname}: ${JSON.stringify(payload)}`)
  return payload
}

async function waitForTerminalJob(baseUrl, cookie, jobId, timeoutMs = 10 * 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { job } = await requestJson(baseUrl, cookie, `/api/jobs/${encodeURIComponent(jobId)}`)
    if (['completed', 'failed', 'cancelled'].includes(job.status) && job.scheduling?.finishedAt) return job
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300))
  }
  throw new Error(`Timed out waiting for offline image job ${jobId}`)
}

await mkdir(qaRoot, { recursive: true })
const runtime = await probeOfflineRuntimePackage({ packageRoot: runtimePackageRoot, verifyCriticalHashes: true })
assert.ok(runtime, 'Validated offline runtime is required before the packaged sidecar probe')
assert.equal((await stat(sidecarPath)).isFile(), true)
const runRoot = await mkdtemp(join(qaRoot, 'offline-sidecar-run-'))
const bridgePort = await availablePort()
const unavailableComfyPort = await availablePort()
const baseUrl = `http://127.0.0.1:${bridgePort}`
const stdout = []
const stderr = []
let child
try {
  const paths = {
    runtime: join(runRoot, 'runtime'),
    data: join(runRoot, 'data'),
    cache: join(runRoot, 'cache'),
    logs: join(runRoot, 'logs'),
    config: join(runRoot, 'config', 'local.json'),
  }
  await Promise.all([
    mkdir(paths.runtime, { recursive: true }),
    mkdir(paths.data, { recursive: true }),
    mkdir(paths.cache, { recursive: true }),
    mkdir(paths.logs, { recursive: true }),
    mkdir(dirname(paths.config), { recursive: true }),
  ])
  await writeFile(paths.config, `${JSON.stringify({
    schemaVersion: 1,
    comfyUrl: `http://127.0.0.1:${unavailableComfyPort}`,
    comfyRoot: runtime.comfyRoot,
    pythonPath: runtime.pythonPath,
    comfyLaunchPolicy: 'manual',
    comfyIdleSeconds: 300,
    imageTools: {
      ffmpegPath: runtime.ffmpegPath,
      ffprobePath: runtime.ffprobePath,
      rembgModelsPath: runtime.rembgModelsPath,
      realEsrganPath: runtime.realEsrganPath,
      realEsrganModelsPath: runtime.realEsrganModelsPath,
    },
  }, null, 2)}\n`, 'utf8')
  const compactInputPath = join(runRoot, 'source-96.png')
  await execFileAsync(runtime.ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', sourceImagePath,
    '-vf', 'scale=96:96:flags=lanczos',
    '-frames:v', '1',
    compactInputPath,
  ], { windowsHide: true, timeout: 60_000 })
  const sourceDataUrl = `data:image/png;base64,${(await readFile(compactInputPath)).toString('base64')}`
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const systemOnlyPath = [join(systemRoot, 'System32'), systemRoot, join(systemRoot, 'System32', 'Wbem')].join(';')
  child = spawn(sidecarPath, [], {
    cwd: runRoot,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      APPDATA: process.env.APPDATA,
      USERPROFILE: process.env.USERPROFILE,
      PATH: systemOnlyPath,
      PATHEXT: process.env.PATHEXT,
      AEONQUILL_PORT: String(bridgePort),
      AEONQUILL_HOST: '127.0.0.1',
      AEONQUILL_RUNTIME_DIR: paths.runtime,
      AEONQUILL_DATA_DIR: paths.data,
      AEONQUILL_CACHE_DIR: paths.cache,
      AEONQUILL_LOG_DIR: paths.logs,
      AEONQUILL_CONFIG: paths.config,
      AEONQUILL_COMFY_POLICY: 'manual',
      AEONQUILL_PARENT_CONTROL: 'stdio',
      COMFY_URL: `http://127.0.0.1:${unavailableComfyPort}`,
    },
  })
  child.stdout.on('data', (chunk) => stdout.push(String(chunk)))
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)))
  const cookie = await waitForBridge(baseUrl, child)
  const tools = await requestJson(baseUrl, cookie, '/api/image-tools?refresh=1')
  const unavailable = tools.operations.filter((operation) => !operation.available)
  assert.deepEqual(unavailable, [], `Offline sidecar has unavailable processors: ${JSON.stringify(unavailable)}`)

  const cases = [
    ['pixelate', { targetSize: 32, colors: 8, outputScale: 1, dither: 'none', alphaThreshold: 64 }],
    ['remove-background', { model: 'u2netp', alphaMatting: false }],
    ['upscale-realesrgan', { model: 'realesr-animevideov3', scale: 2, tileSize: 64 }],
  ]
  const jobs = []
  for (const [operation, params] of cases) {
    const startedAt = Date.now()
    const created = await requestJson(baseUrl, cookie, '/api/jobs/image', {
      method: 'POST',
      headers: { 'idempotency-key': `rel004-${operation}-001` },
      body: JSON.stringify({ operation, sourceImageDataUrl: sourceDataUrl, params }),
    }, 202)
    const completed = await waitForTerminalJob(baseUrl, cookie, created.job.id)
    assert.equal(completed.status, 'completed', `${operation}: ${JSON.stringify(completed.error || completed)}`)
    assert.match(completed.outputUrl, /^\/api\/assets\//u)
    const outputResponse = await fetch(`${baseUrl}${completed.outputUrl}`, { headers: { cookie } })
    assert.equal(outputResponse.status, 200)
    const output = Buffer.from(await outputResponse.arrayBuffer())
    assert.deepEqual([...output.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
    assert.equal(createHash('sha256').update(output).digest('hex'), completed.outputVersion.assetId)
    jobs.push({ operation, provider: completed.output.provider, bytes: output.length, elapsedMs: Date.now() - startedAt })
  }
  assert.equal((await stat(join(paths.runtime, 'tools', 'rembg-runner.py'))).isFile(), true)
  const publicJobs = await requestJson(baseUrl, cookie, '/api/jobs')
  assert.equal(publicJobs.jobs.length, cases.length)
  assert.doesNotMatch(JSON.stringify(publicJobs), /[A-Z]:\\|\\Users\\|inputPath|outputPath|"pid"/iu)

  child.stdin.write('shutdown\n')
  child.stdin.end()
  const exitCode = await waitForExit(child, 15_000)
  assert.equal(exitCode, 0)
  const report = {
    schemaVersion: 1,
    status: 'passed',
    packageId: runtime.packageId,
    sidecarSelfContainedNode: true,
    systemPythonRequired: false,
    capabilities: tools.operations.map(({ id, provider, available }) => ({ id, provider, available })),
    jobs,
    rembgRunnerMaterialized: true,
    publicPathRedaction: true,
    exitCode,
    checkedAt: new Date().toISOString(),
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(`✓ Packaged sidecar exposes ${tools.operations.length}/${tools.operations.length} offline image processors`)
  for (const job of jobs) console.log(`✓ ${job.operation}: ${job.provider}, ${job.bytes} bytes, ${job.elapsedMs}ms`)
  console.log(`✓ No system Node/Python; rembg runner materialized; report ${reportPath}`)
} catch (error) {
  const diagnostic = `${stdout.join('')}\n${stderr.join('')}`.slice(-12_000)
  throw new Error(`${error.message}\n${diagnostic}`)
} finally {
  await forceStop(child)
  await rm(runRoot, { recursive: true, force: true })
}
