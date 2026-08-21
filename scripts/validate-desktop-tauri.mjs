import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { waitForBridgeClosed } from '../desktop/shared/bridge-contract.mjs'
import { loadReleaseMetadata } from '../desktop/release/release-meta.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const metadata = await loadReleaseMetadata(projectRoot)
const installedDirectoryArgument = process.argv.find((argument) => argument.startsWith('--installed-directory='))
const installedDirectory = installedDirectoryArgument
  ? resolve(installedDirectoryArgument.slice('--installed-directory='.length))
  : null
const releaseMode = process.argv.includes('--release') || Boolean(installedDirectory)
const buildProfile = releaseMode ? 'release' : 'debug'
const targetDirectory = installedDirectory
  || join(projectRoot, 'desktop', 'tauri', 'src-tauri', 'target', buildProfile)
const appPath = join(targetDirectory, metadata.appExecutable)
const sidecarPath = join(targetDirectory, metadata.sidecarRuntimeFilename)
const finalReportPath = join(
  projectRoot,
  '.runtime',
  'qa',
  installedDirectory
    ? 'desktop-tauri-installed-final.json'
    : releaseMode
      ? 'desktop-tauri-release-final.json'
      : 'desktop-tauri-debug-final.json',
)

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
  } else {
    child.kill('SIGTERM')
  }
}

async function runTauriQa(runtimeDirectory) {
  const launchDirectory = installedDirectory || join(runtimeDirectory, 'App')
  const launchAppPath = installedDirectory
    ? appPath
    : join(launchDirectory, metadata.appExecutable)
  const appDataRoot = join(runtimeDirectory, 'app-local-data')
  const localAppDataPath = join(runtimeDirectory, 'local-app-data')
  const runtimePath = join(appDataRoot, 'runtime')
  const dataPath = join(appDataRoot, 'data')
  const cachePath = join(appDataRoot, 'cache')
  const logPath = join(appDataRoot, 'logs')
  const configPath = join(appDataRoot, 'config', 'local.json')
  const reportPath = join(runtimePath, 'reports', 'tauri.json')
  const unavailableComfyPort = await availablePort()
  const stdout = []
  const stderr = []
  await mkdir(localAppDataPath, { recursive: true })
  if (!installedDirectory) {
    await mkdir(launchDirectory, { recursive: true })
    await Promise.all([
      copyFile(appPath, launchAppPath),
      copyFile(sidecarPath, join(launchDirectory, metadata.sidecarRuntimeFilename)),
      writeFile(join(launchDirectory, 'aeonquill-layout.json'), `${JSON.stringify({
        schemaVersion: 1,
        layout: 'sibling-user-data',
        dataDirectoryName: 'UserData',
      }, null, 2)}\n`, 'utf8'),
    ])
  }
  const child = spawn(launchAppPath, [], {
    cwd: launchDirectory,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      LOCALAPPDATA: localAppDataPath,
      AEONQUILL_DESKTOP_QA: '1',
      AEONQUILL_DESKTOP_REPORT: reportPath,
      AEONQUILL_RUNTIME_DIR: runtimePath,
      AEONQUILL_DATA_DIR: dataPath,
      AEONQUILL_CACHE_DIR: cachePath,
      AEONQUILL_LOG_DIR: logPath,
      AEONQUILL_CONFIG: configPath,
      MIAOHUI_COMFY_POLICY: 'manual',
      COMFY_URL: `http://127.0.0.1:${unavailableComfyPort}`,
    },
  })
  child.stdout.on('data', (chunk) => stdout.push(String(chunk)))
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)))
  const exitCode = await waitForChildExit(child, 35_000)
  if (exitCode === 'timeout') await terminateProcessTree(child)

  let report
  try {
    report = JSON.parse(await readFile(reportPath, 'utf8'))
  } catch (error) {
    throw new Error([
      `Tauri QA report was not readable: ${error.message}`,
      `exit=${exitCode}`,
      stdout.join('').trim(),
      stderr.join('').trim(),
    ].filter(Boolean).join('\n'))
  } finally {
    await terminateProcessTree(child)
  }
  return {
    report,
    exitCode,
    stdout: stdout.join('').trim(),
    stderr: stderr.join('').trim(),
    runtimeLayout: { localAppDataPath, runtimePath, dataPath, cachePath, logPath, configPath },
  }
}

const [appStats, sidecarStats] = await Promise.all([stat(appPath), stat(sidecarPath)])
assert.ok(appStats.isFile() && appStats.size > 1_000_000, 'Tauri debug executable is missing')
assert.ok(sidecarStats.isFile() && sidecarStats.size > 20_000_000, 'Tauri sidecar is missing')

const [config, capability] = await Promise.all([
  readFile(join(projectRoot, 'desktop', 'tauri', 'src-tauri', 'tauri.conf.json'), 'utf8').then(JSON.parse),
  readFile(join(projectRoot, 'desktop', 'tauri', 'src-tauri', 'capabilities', 'main.json'), 'utf8').then(JSON.parse),
])
assert.equal(config.app.withGlobalTauri, false)
assert.deepEqual(capability.permissions, ['core:default', 'dialog:allow-open'])
assert.equal(capability.permissions.some((permission) => permission.startsWith('shell:')), false)

const runtimeDirectory = await mkdtemp(join(tmpdir(), 'aeonquill-tauri-qa-'))
try {
  const result = await runTauriQa(runtimeDirectory)
  const { report } = result
  assert.equal(result.exitCode, 0, `Tauri exited with ${result.exitCode}: ${result.stderr}`)
  assert.equal(report.status, 'passed', report.error || 'Tauri desktop report failed')
  assert.equal(report.shell, 'tauri')
  assert.equal(report.packaged, releaseMode)
  assert.equal(report.shutdown?.exited, true)
  assert.equal(report.shutdown?.exitCode, 0)
  assert.equal(report.shutdown?.portClosed, true)
  assert.equal(report.shutdown?.forced, false, 'Bridge should stop through parent control')
  assert.ok(report.timeline.bridgeReadyMs > 0)
  assert.ok(report.timeline.windowLoadedMs >= report.timeline.bridgeReadyMs)
  assert.ok(report.timeline.windowLoadedMs < 20_000, `Cold start took ${report.timeline.windowLoadedMs}ms`)
  assert.ok(
    report.timeline.windowCloseRequestedMs >= report.timeline.rendererProbedMs,
    'QA must exercise the same CloseRequested event as the main window close button',
  )
  assert.ok(
    report.timeline.shutdownFinishedMs >= report.timeline.windowCloseRequestedMs,
    'Bridge shutdown must finish after the main window requests application exit',
  )
  assert.equal(report.rendererProbe.tauriGlobalType, 'undefined')
  assert.equal(report.rendererProbe.processType, 'undefined')
  assert.equal(report.rendererProbe.requireType, 'undefined')
  assert.equal(report.rendererProbe.documentReadyState, 'complete')
  for (const directory of [
    result.runtimeLayout.localAppDataPath,
    result.runtimeLayout.runtimePath,
    result.runtimeLayout.dataPath,
    result.runtimeLayout.cachePath,
    result.runtimeLayout.logPath,
    dirname(result.runtimeLayout.configPath),
  ]) {
    assert.equal((await stat(directory)).isDirectory(), true)
  }
  assert.equal(
    (await stat(join(result.runtimeLayout.dataPath, 'projects', 'projects.sqlite3'))).isFile(),
    true,
    'A clean desktop start must persist projects in the dedicated data directory',
  )
  assert.equal(
    await waitForBridgeClosed({ baseUrl: `http://127.0.0.1:${report.bridgePort}`, timeoutMs: 1_000 }),
    true,
  )

  const persistedReport = {
    ...report,
    artifacts: {
      shellBytes: appStats.size,
      sidecarBytes: sidecarStats.size,
      combinedBytes: appStats.size + sidecarStats.size,
    },
    securityValidation: {
      withGlobalTauri: false,
      capabilityPermissions: capability.permissions,
      nativeDirectoryDialogOnly: capability.permissions.includes('dialog:allow-open'),
      shellPermissionExposedToRenderer: false,
      navigationPolicy: 'exact bridge origin',
      newWindows: 'deny',
    },
    validation: {
      completedAt: new Date().toISOString(),
      assertions: 31,
      tauriExitCode: result.exitCode,
      target: installedDirectory ? 'installed' : buildProfile,
    },
  }
  await mkdir(dirname(finalReportPath), { recursive: true })
  await writeFile(finalReportPath, `${JSON.stringify(persistedReport, null, 2)}\n`, 'utf8')
  console.log(`✓ Tauri desktop lifecycle passed in ${report.timeline.windowLoadedMs}ms`)
  console.log(`✓ Bridge PID ${report.bridgePid} exited through parent control; port ${report.bridgePort} is closed`)
  console.log(`✓ Renderer probe: __TAURI__=${report.rendererProbe.tauriGlobalType}, process=${report.rendererProbe.processType}`)
  console.log(`✓ ${installedDirectory ? 'installed' : buildProfile} artifacts ${((appStats.size + sidecarStats.size) / 1024 / 1024).toFixed(1)} MiB combined`)
  console.log(`✓ Report: ${finalReportPath}`)
} finally {
  await rm(runtimeDirectory, { recursive: true, force: true })
}
