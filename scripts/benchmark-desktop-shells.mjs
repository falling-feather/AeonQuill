import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadReleaseMetadata, resolveReleasePaths } from '../desktop/release/release-meta.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const metadata = await loadReleaseMetadata(projectRoot)
const releasePaths = resolveReleasePaths(metadata)
const metricsScript = join(projectRoot, 'scripts', 'process-tree-metrics.ps1')
const reportPath = join(projectRoot, '.runtime', 'qa', 'desktop-shell-benchmark-final.json')
const electronExecutable = releasePaths.electronExecutable
const tauriTarget = releasePaths.targetReleaseRoot
const tauriExecutable = releasePaths.builtApp
const tauriSidecar = releasePaths.bundledSidecar
const tauriInstaller = releasePaths.installer

function delay(duration) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, duration))
}

async function availablePort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const reservation = createServer()
    reservation.unref()
    reservation.once('error', rejectPromise)
    reservation.listen(0, '127.0.0.1', () => {
      const address = reservation.address()
      const port = typeof address === 'object' && address ? address.port : null
      reservation.close((error) => error ? rejectPromise(error) : resolvePromise(port))
    })
  })
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode)
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit)
      resolvePromise('timeout')
    }, timeoutMs)
    function onExit(code) {
      clearTimeout(timer)
      resolvePromise(code)
    }
    child.once('exit', onExit)
  })
}

async function terminateProcessTree(child) {
  if (!child || child.exitCode !== null) return
  await new Promise((resolvePromise) => {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    })
    killer.once('error', () => {
      child.kill()
      resolvePromise()
    })
    killer.once('exit', () => resolvePromise())
  })
}

async function snapshotProcessTree(rootProcessId) {
  const child = spawn('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', metricsScript,
    '-RootProcessId', String(rootProcessId),
  ], {
    cwd: projectRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  // A cold Win32_Process CIM query can take more than 12 seconds on a busy
  // Windows workstation even though the shell under test is healthy.
  const exitCode = await waitForChildExit(child, 30_000)
  if (exitCode === 'timeout') await terminateProcessTree(child)
  assert.equal(exitCode, 0, `Process metrics failed: ${stderr}`)
  const parsed = JSON.parse(stdout.trim() || '[]')
  return Array.isArray(parsed) ? parsed : [parsed]
}

function summarizeProcesses(processes) {
  const byName = {}
  for (const processInfo of processes) {
    const current = byName[processInfo.name] || { count: 0, workingSetBytes: 0, privateBytes: 0 }
    current.count += 1
    current.workingSetBytes += processInfo.workingSetBytes
    current.privateBytes += processInfo.privateBytes
    byName[processInfo.name] = current
  }
  return {
    processCount: processes.length,
    workingSetBytes: processes.reduce((sum, value) => sum + value.workingSetBytes, 0),
    privateBytes: processes.reduce((sum, value) => sum + value.privateBytes, 0),
    byName,
  }
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]
}

async function runShell(shell, iteration) {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), `aeonquill-${shell}-benchmark-`))
  const appDataRoot = join(runtimeDirectory, 'app-local-data')
  const runtimePath = join(appDataRoot, 'runtime')
  const shellReportPath = join(runtimePath, 'reports', `${shell}.json`)
  const unavailableComfyPort = await availablePort()
  const executable = shell === 'electron' ? electronExecutable : tauriExecutable
  const cwd = shell === 'electron' ? dirname(electronExecutable) : tauriTarget
  const stderr = []
  const startedAt = Date.now()
  const child = spawn(executable, [], {
    cwd,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      AEONQUILL_DESKTOP_QA: '1',
      AEONQUILL_DESKTOP_AUTOCLOSE_MS: '9000',
      AEONQUILL_DESKTOP_REPORT: shellReportPath,
      AEONQUILL_DESKTOP_USER_DATA: appDataRoot,
      AEONQUILL_RUNTIME_DIR: runtimePath,
      AEONQUILL_DATA_DIR: join(appDataRoot, 'data'),
      AEONQUILL_CACHE_DIR: join(appDataRoot, 'cache'),
      AEONQUILL_LOG_DIR: join(appDataRoot, 'logs'),
      AEONQUILL_CONFIG: join(appDataRoot, 'config', 'local.json'),
      MIAOHUI_COMFY_POLICY: 'manual',
      COMFY_URL: `http://127.0.0.1:${unavailableComfyPort}`,
    },
  })
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)))
  try {
    await delay(6_500)
    assert.equal(child.exitCode, null, `${shell} exited before the memory sample`)
    const processes = await snapshotProcessTree(child.pid)
    const exitCode = await waitForChildExit(child, 30_000)
    if (exitCode === 'timeout') await terminateProcessTree(child)
    assert.equal(exitCode, 0, `${shell} benchmark exit=${exitCode}: ${stderr.join('')}`)
    const shellReport = JSON.parse(await readFile(shellReportPath, 'utf8'))
    assert.equal(shellReport.status, 'passed')
    return {
      shell,
      iteration,
      wallClockMs: Date.now() - startedAt,
      windowLoadedMs: shellReport.timeline.windowLoadedMs,
      rendererProbedMs: shellReport.timeline.rendererProbedMs,
      shutdownFinishedMs: shellReport.timeline.shutdownFinishedMs,
      memory: summarizeProcesses(processes),
    }
  } finally {
    await terminateProcessTree(child)
    await rm(runtimeDirectory, { recursive: true, force: true })
  }
}

await Promise.all([
  stat(electronExecutable),
  stat(tauriExecutable),
  stat(tauriSidecar),
  stat(tauriInstaller),
])

const runs = []
for (let iteration = 1; iteration <= 3; iteration += 1) {
  runs.push(await runShell('electron', iteration))
  runs.push(await runShell('tauri', iteration))
}

const packageReport = JSON.parse(await readFile(join(projectRoot, '.runtime', 'qa', 'electron-package-final.json'), 'utf8'))
const [tauriExeStats, tauriSidecarStats, tauriInstallerStats] = await Promise.all([
  stat(tauriExecutable),
  stat(tauriSidecar),
  stat(tauriInstaller),
])
const summaries = {}
for (const shell of ['electron', 'tauri']) {
  const shellRuns = runs.filter((run) => run.shell === shell)
  summaries[shell] = {
    samples: shellRuns.length,
    medianWindowLoadedMs: median(shellRuns.map((run) => run.windowLoadedMs)),
    medianWorkingSetBytes: median(shellRuns.map((run) => run.memory.workingSetBytes)),
    medianPrivateBytes: median(shellRuns.map((run) => run.memory.privateBytes)),
    medianProcessCount: median(shellRuns.map((run) => run.memory.processCount)),
    minWindowLoadedMs: Math.min(...shellRuns.map((run) => run.windowLoadedMs)),
    maxWindowLoadedMs: Math.max(...shellRuns.map((run) => run.windowLoadedMs)),
  }
}

const report = {
  schemaVersion: 1,
  status: 'passed',
  methodology: {
    order: 'electron then tauri, repeated three times',
    memorySampleAfterSpawnMs: 6_500,
    autoCloseAfterRendererProbeMs: 9_000,
    note: 'Repeated local process launches; OS caches are warm after the first sample.',
  },
  artifacts: {
    electronUnpackedBytes: packageReport.package.bytes,
    tauriReleaseCombinedBytes: tauriExeStats.size + tauriSidecarStats.size,
    tauriInstallerBytes: tauriInstallerStats.size,
  },
  summaries,
  runs,
  benchmarkedAt: new Date().toISOString(),
}
await mkdir(dirname(reportPath), { recursive: true })
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

for (const shell of ['electron', 'tauri']) {
  const summary = summaries[shell]
  console.log(
    `✓ ${shell}: load ${summary.medianWindowLoadedMs}ms, `
    + `working set ${(summary.medianWorkingSetBytes / 1024 / 1024).toFixed(1)} MiB, `
    + `private ${(summary.medianPrivateBytes / 1024 / 1024).toFixed(1)} MiB`,
  )
}
console.log(`✓ Report: ${reportPath}`)
