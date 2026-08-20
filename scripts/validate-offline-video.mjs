import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
const packageRoot = join(
  projectRoot,
  '.runtime',
  'releases',
  'offline',
  `AEONQUILL_${metadata.version}_windows_x64_full`,
  'runtime',
  OFFLINE_RUNTIME_PACKAGE_ID,
)
const qaRoot = join(projectRoot, '.runtime', 'qa')
const reportPath = join(qaRoot, 'offline-video-final.json')
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
      timeout: 20_000,
    }).catch(() => undefined)
  } else child.kill('SIGKILL')
  await waitForExit(child, 20_000)
}

async function waitForBridge(baseUrl, child) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Packaged sidecar exited with code ${child.exitCode}`)
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_500) })
      if (response.ok) {
        const cookie = String(response.headers.get('set-cookie') || '').split(';', 1)[0]
        if (cookie) return cookie
      }
    } catch {
      // Bridge is still starting.
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

async function waitForVideoJob(baseUrl, cookie, jobId, label) {
  const deadline = Date.now() + 40 * 60_000
  let previous = ''
  while (Date.now() < deadline) {
    const { job } = await requestJson(baseUrl, cookie, `/api/jobs/${encodeURIComponent(jobId)}`)
    const marker = `${job.phase}:${Math.floor(Number(job.progress || 0) / 5) * 5}:${job.detail}`
    if (marker !== previous) {
      previous = marker
      console.log(`→ ${label} ${job.phase} ${job.progress}% · ${job.detail}`)
    }
    if (['completed', 'failed', 'cancelled'].includes(job.status) && job.scheduling?.finishedAt) return job
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000))
  }
  throw new Error(`${label} did not finish within 40 minutes`)
}

async function probeVideo(runtime, pathname) {
  const { stdout } = await execFileAsync(runtime.ffprobePath, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,width,height,avg_frame_rate:format=duration',
    '-of', 'json',
    pathname,
  ], { windowsHide: true, encoding: 'utf8', timeout: 60_000 })
  return JSON.parse(stdout)
}

await mkdir(qaRoot, { recursive: true })
const runtime = await probeOfflineRuntimePackage({ packageRoot, verifyCriticalHashes: false })
assert.ok(runtime, 'Offline runtime package is unavailable')
const runRoot = await mkdtemp(join(qaRoot, 'offline-video-run-'))
const bridgePort = await availablePort()
const comfyPort = await availablePort()
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
    comfyUrl: `http://127.0.0.1:${comfyPort}`,
    comfyRoot: runtime.comfyRoot,
    pythonPath: runtime.pythonPath,
    comfyLaunchPolicy: 'idle',
    comfyIdleSeconds: 600,
    imageTools: {
      ffmpegPath: runtime.ffmpegPath,
      ffprobePath: runtime.ffprobePath,
      rembgModelsPath: runtime.rembgModelsPath,
      realEsrganPath: runtime.realEsrganPath,
      realEsrganModelsPath: runtime.realEsrganModelsPath,
    },
    comfyArgs: [
      'main.py', '--listen', '127.0.0.1', '--port', String(comfyPort),
      '--disable-auto-launch', '--fast-disk', '--lowvram', '--reserve-vram', '1.5',
      '--disable-pinned-memory', '--cache-none', '--preview-method', 'none',
    ],
  }, null, 2)}\n`, 'utf8')
  const framePath = join(runRoot, 'first-frame.png')
  await execFileAsync(runtime.ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', sourceImagePath,
    '-vf', 'scale=608:352:force_original_aspect_ratio=decrease,pad=608:352:(ow-iw)/2:(oh-ih)/2:color=black,format=rgb24',
    '-frames:v', '1', framePath,
  ], { windowsHide: true, timeout: 60_000 })
  const frameDataUrl = `data:image/png;base64,${(await readFile(framePath)).toString('base64')}`
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
      AEONQUILL_PARENT_CONTROL: 'stdio',
    },
  })
  child.stdout.on('data', (chunk) => stdout.push(String(chunk)))
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)))
  const cookie = await waitForBridge(baseUrl, child)
  const cases = [
    {
      label: 'T2V',
      request: {
        mode: 'text-to-video',
        prompt: 'A calm black ink ripple on white rice paper, locked camera, subtle natural motion, clean composition.',
        aspectRatio: '16:9', duration: 5, preset: 'fast', seed: 420401, audio: true,
      },
    },
    {
      label: 'I2V',
      request: {
        mode: 'image-to-video',
        prompt: 'Preserve the character identity and composition. Add a gentle breathing motion and a slow breeze, locked camera.',
        aspectRatio: '16:9', duration: 5, preset: 'fast', seed: 420402, audio: false,
        sourceImageDataUrl: frameDataUrl,
      },
    },
  ]
  const results = []
  for (const testCase of cases) {
    const startedAt = Date.now()
    const created = await requestJson(baseUrl, cookie, '/api/jobs/video', {
      method: 'POST',
      headers: { 'idempotency-key': `rel004-${testCase.label.toLowerCase()}-001` },
      body: JSON.stringify(testCase.request),
    }, 202)
    const completed = await waitForVideoJob(baseUrl, cookie, created.job.id, testCase.label)
    assert.equal(completed.status, 'completed', `${testCase.label}: ${JSON.stringify(completed.error || completed.logs || completed)}`)
    assert.match(completed.outputUrl, /^\/api\/assets\//u)
    assert.equal(completed.output.subfolder, 'AEONQUILL')
    assert.match(completed.output.filename, new RegExp(`^${testCase.label}_`, 'u'))
    assert.doesNotMatch(JSON.stringify(completed), /MiaoHui|[A-Z]:\\|\\Users\\|inputPath|outputPath|"pid"/iu)
    const response = await fetch(`${baseUrl}${completed.outputUrl}`, { headers: { cookie } })
    assert.equal(response.status, 200)
    const bytes = Buffer.from(await response.arrayBuffer())
    assert.equal(createHash('sha256').update(bytes).digest('hex'), completed.outputVersion.assetId)
    const outputPath = join(runRoot, `${testCase.label}.mp4`)
    await writeFile(outputPath, bytes)
    const media = await probeVideo(runtime, outputPath)
    const stream = media.streams?.[0]
    assert.equal(stream?.codec_name, 'h264')
    assert.equal(stream?.width, 608)
    assert.equal(stream?.height, 352)
    assert.ok(Number(media.format?.duration) >= 5 && Number(media.format?.duration) < 6)
    results.push({
      mode: testCase.request.mode,
      audioRequested: testCase.request.audio,
      elapsedMs: Date.now() - startedAt,
      bytes: bytes.length,
      sha256: completed.outputVersion.assetId,
      codec: stream.codec_name,
      width: stream.width,
      height: stream.height,
      duration: Number(media.format.duration),
      workflowVersion: completed.workflowVersion,
    })
  }
  const stoppedRuntime = await requestJson(baseUrl, cookie, '/api/runtime/stop', { method: 'POST' })
  assert.equal(stoppedRuntime.connected, false)
  child.stdin.write('shutdown\n')
  child.stdin.end()
  assert.equal(await waitForExit(child, 20_000), 0)
  const report = {
    schemaVersion: 1,
    status: 'passed',
    packageId: runtime.packageId,
    sidecarSelfContainedNode: true,
    systemPythonRequired: false,
    gpuClass: 'RTX 4060 Laptop 8GB',
    results,
    runtimeStopped: true,
    checkedAt: new Date().toISOString(),
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  for (const result of results) {
    console.log(`✓ ${result.mode}: ${result.width}×${result.height}, ${result.duration}s, ${(result.elapsedMs / 1000).toFixed(1)}s`)
  }
  console.log(`✓ ComfyUI stopped and packaged sidecar exited; report ${reportPath}`)
} catch (error) {
  const comfyLog = await readFile(join(runRoot, 'logs', 'comfyui.log'), 'utf8').catch(() => '')
  const diagnostic = `${stdout.join('')}\n${stderr.join('')}\n${comfyLog}`.slice(-20_000)
  throw new Error(`${error.message}\n${diagnostic}`)
} finally {
  await forceStop(child)
  await rm(runRoot, { recursive: true, force: true })
}
