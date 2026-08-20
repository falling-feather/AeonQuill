import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { OFFLINE_RUNTIME_PACKAGE_ID, probeOfflineRuntimePackage } from '../server/offline-runtime.mjs'
import { REQUIRED_NODE_TYPES } from '../server/workflow-builder.mjs'

const execFileAsync = promisify(execFile)
const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const packageRoot = join(
  projectRoot,
  '.runtime',
  'releases',
  'offline',
  'AEONQUILL_0.4.2_windows_x64_full',
  'runtime',
  OFFLINE_RUNTIME_PACKAGE_ID,
)
const qaRoot = join(projectRoot, '.runtime', 'qa')
const reportPath = join(qaRoot, 'offline-comfy-final.json')

function reservePort() {
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

async function waitForJson(url, child, timeoutMs = 360_000) {
  const startedAt = Date.now()
  let lastError = 'not started'
  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`ComfyUI exited before readiness with code ${child.exitCode}`)
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) })
      if (response.ok) return await response.json()
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error.message
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000))
  }
  throw new Error(`ComfyUI did not become ready within ${timeoutMs}ms (${lastError})`)
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode)
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise('timeout'), timeoutMs)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolvePromise(code)
    })
  })
}

async function stopChildTree(child) {
  if (!child || child.exitCode !== null) return { forced: false, exitCode: child?.exitCode ?? null }
  child.kill('SIGTERM')
  let exitCode = await waitForExit(child, 15_000)
  if (exitCode !== 'timeout') return { forced: false, exitCode }
  if (process.platform === 'win32') {
    await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      timeout: 15_000,
    }).catch(() => undefined)
  } else {
    child.kill('SIGKILL')
  }
  exitCode = await waitForExit(child, 15_000)
  return { forced: true, exitCode }
}

await mkdir(qaRoot, { recursive: true })
const runtime = await probeOfflineRuntimePackage({ packageRoot, verifyCriticalHashes: true })
assert.ok(runtime, 'Validated offline runtime is required before the live ComfyUI probe')
const runRoot = await mkdtemp(join(qaRoot, 'offline-comfy-run-'))
const port = await reservePort()
assert.ok(Number.isInteger(port) && port > 0)
const stdout = []
const stderr = []
let child
const startedAt = Date.now()
try {
  for (const directory of ['input', 'output', 'temp', 'user', 'user/default']) {
    await mkdir(join(runRoot, directory), { recursive: true })
  }
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const systemOnlyPath = [
    join(systemRoot, 'System32'),
    systemRoot,
    join(systemRoot, 'System32', 'Wbem'),
  ].join(';')
  child = spawn(runtime.pythonPath, [
    'main.py',
    '--listen', '127.0.0.1',
    '--port', String(port),
    '--disable-auto-launch',
    '--lowvram',
    '--reserve-vram', '1.5',
    '--disable-pinned-memory',
    '--cache-none',
    '--preview-method', 'none',
    '--input-directory', join(runRoot, 'input'),
    '--output-directory', join(runRoot, 'output'),
    '--temp-directory', join(runRoot, 'temp'),
    '--user-directory', join(runRoot, 'user'),
  ], {
    cwd: runtime.comfyRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      TEMP: join(runRoot, 'temp'),
      TMP: join(runRoot, 'temp'),
      PATH: systemOnlyPath,
      PATHEXT: process.env.PATHEXT,
      PYTHONNOUSERSITE: '1',
      U2NET_HOME: runtime.rembgModelsPath,
      CUDA_MODULE_LOADING: 'LAZY',
    },
  })
  child.stdout.on('data', (chunk) => stdout.push(String(chunk)))
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)))

  const baseUrl = `http://127.0.0.1:${port}`
  const systemStats = await waitForJson(`${baseUrl}/system_stats`, child)
  const objectInfo = await waitForJson(`${baseUrl}/object_info`, child, 60_000)
  const missingNodes = REQUIRED_NODE_TYPES.filter((nodeType) => !objectInfo[nodeType])
  assert.deepEqual(missingNodes, [], `Offline ComfyUI is missing H3 nodes: ${missingNodes.join(', ')}`)
  for (const requiredNode of ['SAMLoader', 'SAMDetectorCombined']) {
    assert.ok(objectInfo[requiredNode], `Offline ComfyUI is missing semantic node ${requiredNode}`)
  }
  const readyMs = Date.now() - startedAt
  const shutdown = await stopChildTree(child)
  const report = {
    schemaVersion: 1,
    status: 'passed',
    packageId: runtime.packageId,
    readyMs,
    comfyVersion: String(systemStats.system?.comfyui_version || runtime.manifest.runtime.comfyuiVersion),
    pythonVersion: String(systemStats.system?.python_version || '').split(' ')[0],
    device: String(systemStats.devices?.[0]?.name || 'unknown').slice(0, 120),
    requiredH3Nodes: REQUIRED_NODE_TYPES.length,
    semanticNodes: 2,
    systemNodeRequired: false,
    systemPythonRequired: false,
    shutdown,
    checkedAt: new Date().toISOString(),
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(`✓ Offline ComfyUI ready in ${readyMs}ms with ${REQUIRED_NODE_TYPES.length} H3 nodes`)
  console.log(`✓ ${report.device} · Python ${report.pythonVersion || runtime.manifest.runtime.pythonVersion}`)
  console.log(`✓ Runtime stopped; forced=${shutdown.forced}; report ${reportPath}`)
} catch (error) {
  const diagnostic = [...stdout, ...stderr].join('').slice(-12_000)
  throw new Error(`${error.message}\n${diagnostic}`)
} finally {
  await stopChildTree(child).catch(() => undefined)
  await rm(runRoot, { recursive: true, force: true })
}
