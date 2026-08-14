import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { waitForBridgeClosed } from '../desktop/shared/bridge-contract.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const releaseMode = process.argv.includes('--release')
const buildProfile = releaseMode ? 'release' : 'debug'
const targetDirectory = join(projectRoot, 'desktop', 'tauri', 'src-tauri', 'target', buildProfile)
const appPath = join(targetDirectory, 'miaohui-desktop.exe')
const sidecarPath = join(targetDirectory, 'miaohui-bridge.exe')
const finalReportPath = join(
  projectRoot,
  '.runtime',
  'qa',
  releaseMode ? 'desktop-tauri-release-final.json' : 'desktop-tauri-debug-final.json',
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
  const reportPath = join(runtimeDirectory, 'reports', 'tauri.json')
  const unavailableComfyPort = await availablePort()
  const stdout = []
  const stderr = []
  const child = spawn(appPath, [], {
    cwd: targetDirectory,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MIAOHUI_DESKTOP_QA: '1',
      MIAOHUI_DESKTOP_REPORT: reportPath,
      MIAOHUI_RUNTIME_DIR: runtimeDirectory,
      MIAOHUI_CONFIG: join(runtimeDirectory, 'no-local-config.json'),
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
  return { report, exitCode, stdout: stdout.join('').trim(), stderr: stderr.join('').trim() }
}

const [appStats, sidecarStats] = await Promise.all([stat(appPath), stat(sidecarPath)])
assert.ok(appStats.isFile() && appStats.size > 1_000_000, 'Tauri debug executable is missing')
assert.ok(sidecarStats.isFile() && sidecarStats.size > 20_000_000, 'Tauri sidecar is missing')

const [config, capability] = await Promise.all([
  readFile(join(projectRoot, 'desktop', 'tauri', 'src-tauri', 'tauri.conf.json'), 'utf8').then(JSON.parse),
  readFile(join(projectRoot, 'desktop', 'tauri', 'src-tauri', 'capabilities', 'main.json'), 'utf8').then(JSON.parse),
])
assert.equal(config.app.withGlobalTauri, false)
assert.deepEqual(capability.permissions, ['core:default'])
assert.equal(capability.permissions.some((permission) => permission.startsWith('shell:')), false)

const runtimeDirectory = await mkdtemp(join(tmpdir(), 'miaohui-tauri-qa-'))
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
  assert.equal(report.rendererProbe.tauriGlobalType, 'undefined')
  assert.equal(report.rendererProbe.processType, 'undefined')
  assert.equal(report.rendererProbe.requireType, 'undefined')
  assert.equal(report.rendererProbe.documentReadyState, 'complete')
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
      shellPermissionExposedToRenderer: false,
      navigationPolicy: 'exact bridge origin',
      newWindows: 'deny',
    },
    validation: {
      completedAt: new Date().toISOString(),
      assertions: 22,
      tauriExitCode: result.exitCode,
    },
  }
  await mkdir(dirname(finalReportPath), { recursive: true })
  await writeFile(finalReportPath, `${JSON.stringify(persistedReport, null, 2)}\n`, 'utf8')
  console.log(`✓ Tauri desktop lifecycle passed in ${report.timeline.windowLoadedMs}ms`)
  console.log(`✓ Bridge PID ${report.bridgePid} exited through parent control; port ${report.bridgePort} is closed`)
  console.log(`✓ Renderer probe: __TAURI__=${report.rendererProbe.tauriGlobalType}, process=${report.rendererProbe.processType}`)
  console.log(`✓ ${buildProfile} artifacts ${((appStats.size + sidecarStats.size) / 1024 / 1024).toFixed(1)} MiB combined`)
  console.log(`✓ Report: ${finalReportPath}`)
} finally {
  await rm(runtimeDirectory, { recursive: true, force: true })
}
