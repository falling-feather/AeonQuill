import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadReleaseMetadata } from '../desktop/release/release-meta.mjs'

const execFileAsync = promisify(execFile)
const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const metadata = await loadReleaseMetadata(projectRoot)
const installedArgument = process.argv.find((argument) => argument.startsWith('--installed-directory='))
const installedDirectory = installedArgument
  ? resolve(installedArgument.slice('--installed-directory='.length))
  : null
const releaseMode = process.argv.includes('--release') || Boolean(installedDirectory)
const buildProfile = releaseMode ? 'release' : 'debug'
const sourceDirectory = installedDirectory
  || join(projectRoot, 'desktop', 'tauri', 'src-tauri', 'target', buildProfile)
const sourceAppPath = join(sourceDirectory, metadata.appExecutable)
const sourceSidecarPath = join(sourceDirectory, metadata.sidecarRuntimeFilename)
const qaRoot = join(projectRoot, '.runtime', 'qa-temp')
const finalReportPath = join(
  projectRoot,
  '.runtime',
  'qa',
  installedDirectory
    ? 'desktop-single-instance-installed-final.json'
    : `desktop-single-instance-${buildProfile}-final.json`,
)

function waitForExit(child, timeoutMs) {
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
      killer.once('exit', () => resolvePromise())
    })
    return
  }
  child.kill('SIGTERM')
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

async function processesAt(executablePath) {
  if (process.platform !== 'win32') return []
  const command = [
    "$items = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:AEONQUILL_QA_EXECUTABLE } | Select-Object ProcessId, ParentProcessId, ExecutablePath)",
    'ConvertTo-Json -Compress -InputObject $items',
  ].join('; ')
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', command],
    {
      windowsHide: true,
      encoding: 'utf8',
      env: { ...process.env, AEONQUILL_QA_EXECUTABLE: executablePath },
      maxBuffer: 1024 * 1024,
    },
  )
  const source = stdout.trim()
  if (!source) return []
  const parsed = JSON.parse(source.replace(/^\uFEFF/, ''))
  return Array.isArray(parsed) ? parsed : [parsed]
}

async function waitForExactlyOneRuntime(appPath, sidecarPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = { apps: [], sidecars: [] }
  while (Date.now() < deadline) {
    const [apps, sidecars] = await Promise.all([
      processesAt(appPath),
      processesAt(sidecarPath),
    ])
    last = { apps, sidecars }
    if (apps.length === 1 && sidecars.length === 1) return last
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 180))
  }
  throw new Error(`Expected one desktop and one bridge process, got ${last.apps.length}/${last.sidecars.length}`)
}

function launch(appPath, launchDirectory, environment) {
  const stdout = []
  const stderr = []
  const child = spawn(appPath, [], {
    cwd: launchDirectory,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: environment,
  })
  child.stdout.on('data', (chunk) => stdout.push(String(chunk)))
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)))
  return { child, stdout, stderr }
}

await Promise.all([
  stat(sourceAppPath).then((entry) => assert.ok(entry.isFile() && entry.size > 1_000_000)),
  stat(sourceSidecarPath).then((entry) => assert.ok(entry.isFile() && entry.size > 20_000_000)),
])

await mkdir(qaRoot, { recursive: true })
const isolatedRoot = await mkdtemp(join(qaRoot, 'aeonquill-single-instance-'))
const launchDirectory = join(isolatedRoot, 'App')
const launchAppPath = join(launchDirectory, metadata.appExecutable)
const launchSidecarPath = join(launchDirectory, metadata.sidecarRuntimeFilename)
const userDataRoot = join(isolatedRoot, 'UserData')
const runtimePath = join(userDataRoot, 'runtime')
const reportPath = join(runtimePath, 'reports', 'single-instance-primary.json')
const children = []

try {
  await mkdir(launchDirectory, { recursive: true })
  await Promise.all([
    copyFile(sourceAppPath, launchAppPath),
    copyFile(sourceSidecarPath, launchSidecarPath),
    writeFile(join(launchDirectory, 'aeonquill-layout.json'), `${JSON.stringify({
      schemaVersion: 1,
      layout: 'sibling-user-data',
      dataDirectoryName: 'UserData',
    }, null, 2)}\n`, 'utf8'),
  ])

  const unavailableComfyPort = await availablePort()
  const environment = {
    ...process.env,
    LOCALAPPDATA: join(isolatedRoot, 'local-app-data'),
    AEONQUILL_DESKTOP_QA: '1',
    AEONQUILL_DESKTOP_AUTOCLOSE_MS: '8000',
    AEONQUILL_DESKTOP_REPORT: reportPath,
    AEONQUILL_RUNTIME_DIR: runtimePath,
    AEONQUILL_DATA_DIR: join(userDataRoot, 'data'),
    AEONQUILL_CACHE_DIR: join(userDataRoot, 'cache'),
    AEONQUILL_LOG_DIR: join(userDataRoot, 'logs'),
    AEONQUILL_CONFIG: join(userDataRoot, 'config', 'local.json'),
    MIAOHUI_COMFY_POLICY: 'manual',
    COMFY_URL: `http://127.0.0.1:${unavailableComfyPort}`,
  }

  const primary = launch(launchAppPath, launchDirectory, environment)
  children.push(primary.child)
  const initialProcesses = await waitForExactlyOneRuntime(launchAppPath, launchSidecarPath, 15_000)
  assert.equal(primary.child.exitCode, null, 'Primary desktop exited before concurrent launches')

  const secondaryLaunches = Array.from({ length: 3 }, () => launch(
    launchAppPath,
    launchDirectory,
    environment,
  ))
  children.push(...secondaryLaunches.map(({ child }) => child))
  const secondaryExitCodes = await Promise.all(
    secondaryLaunches.map(({ child }) => waitForExit(child, 4_000)),
  )
  for (const [index, exitCode] of secondaryExitCodes.entries()) {
    assert.notEqual(
      exitCode,
      'timeout',
      `Concurrent launch ${index + 1} did not yield to the primary instance`,
    )
    assert.equal(
      exitCode,
      0,
      `Concurrent launch ${index + 1} exited with ${exitCode}: ${secondaryLaunches[index].stderr.join('').trim()}`,
    )
  }
  assert.equal(primary.child.exitCode, null, 'Primary desktop must survive secondary launch attempts')
  const finalProcesses = await waitForExactlyOneRuntime(launchAppPath, launchSidecarPath, 4_000)

  const primaryExitCode = await waitForExit(primary.child, 22_000)
  if (primaryExitCode === 'timeout') {
    throw new Error('Primary desktop did not complete its hidden QA lifecycle')
  }
  assert.equal(primaryExitCode, 0, primary.stderr.join('').trim())
  const desktopReport = JSON.parse(await readFile(reportPath, 'utf8'))
  assert.equal(desktopReport.status, 'passed', desktopReport.error || 'Primary desktop lifecycle failed')
  assert.equal(desktopReport.shutdown?.portClosed, true)
  assert.equal(desktopReport.shutdown?.forced, false)

  const persistedReport = {
    schemaVersion: 1,
    status: 'passed',
    completedAt: new Date().toISOString(),
    target: installedDirectory ? 'installed-copy' : buildProfile,
    executable: launchAppPath,
    launchAttempts: 4,
    primaryPid: primary.child.pid,
    initialDesktopProcessIds: initialProcesses.apps.map((entry) => entry.ProcessId),
    initialBridgeProcessIds: initialProcesses.sidecars.map((entry) => entry.ProcessId),
    secondaryExitCodes,
    finalDesktopProcessIds: finalProcesses.apps.map((entry) => entry.ProcessId),
    finalBridgeProcessIds: finalProcesses.sidecars.map((entry) => entry.ProcessId),
    focusPolicy: 'QA runs hidden; normal repeated launches restore and focus the existing main window',
    desktopLifecycleReport: desktopReport,
  }
  await mkdir(dirname(finalReportPath), { recursive: true })
  await writeFile(finalReportPath, `${JSON.stringify(persistedReport, null, 2)}\n`, 'utf8')
  console.log('✓ 4 concurrent launch attempts produced exactly 1 desktop + 1 bridge process')
  console.log(`✓ Secondary exit codes: ${secondaryExitCodes.join(', ')}`)
  console.log(`✓ Hidden primary lifecycle passed; report: ${finalReportPath}`)
} finally {
  await Promise.all(children.map((child) => terminateProcessTree(child)))
  await rm(isolatedRoot, { recursive: true, force: true })
}
