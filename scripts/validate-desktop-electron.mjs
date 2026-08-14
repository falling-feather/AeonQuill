import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { waitForBridgeClosed } from '../desktop/shared/bridge-contract.mjs'
import { loadReleaseMetadata, resolveReleasePaths } from '../desktop/release/release-meta.mjs'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const metadata = await loadReleaseMetadata(projectRoot)
const releasePaths = resolveReleasePaths(metadata)
const packagedMode = process.argv.includes('--packaged')
const packagedElectronPath = releasePaths.electronExecutable
const finalReportPath = join(
  projectRoot,
  '.runtime',
  'qa',
  packagedMode ? 'desktop-electron-packaged-final.json' : 'desktop-electron-dev-final.json',
)

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
      killer.once('exit', () => resolvePromise())
    })
  } else {
    child.kill('SIGTERM')
  }
}

async function runElectronQa(runtimeDirectory) {
  const appDataRoot = join(runtimeDirectory, 'app-local-data')
  const runtimePath = join(appDataRoot, 'runtime')
  const dataPath = join(appDataRoot, 'data')
  const cachePath = join(appDataRoot, 'cache')
  const logPath = join(appDataRoot, 'logs')
  const configPath = join(appDataRoot, 'config', 'local.json')
  const reportPath = join(runtimePath, 'reports', 'electron.json')
  const userDataPath = appDataRoot
  const unavailableComfyPort = await availablePort()
  const stdout = []
  const stderr = []
  const executablePath = packagedMode ? packagedElectronPath : electronPath
  const executableArgs = packagedMode ? [] : [projectRoot]
  const child = spawn(executablePath, executableArgs, {
    cwd: projectRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      AEONQUILL_DESKTOP_QA: '1',
      AEONQUILL_DESKTOP_AUTOCLOSE_MS: '700',
      AEONQUILL_DESKTOP_REPORT: reportPath,
      AEONQUILL_DESKTOP_USER_DATA: userDataPath,
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
      `Electron QA report was not readable: ${error.message}`,
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
    runtimeLayout: { runtimePath, dataPath, cachePath, logPath, configPath },
  }
}

const runtimeDirectory = await mkdtemp(join(tmpdir(), 'aeonquill-electron-qa-'))
try {
  const result = await runElectronQa(runtimeDirectory)
  const { report } = result
  assert.equal(
    result.exitCode,
    0,
    [
      `Electron exited with ${result.exitCode}`,
      result.stderr,
      report.bridge?.stderrTail,
      report.error,
    ].filter(Boolean).join('\n'),
  )
  assert.equal(report.status, 'passed', report.error || 'desktop report failed')
  assert.equal(report.shell, 'electron')
  assert.equal(report.packaged, packagedMode)
  assert.equal(report.userDataLayout, 'explicit')
  assert.equal(report.bridge.shutdown?.exited, true)
  assert.equal(report.bridge.shutdown?.portClosed, true)
  assert.equal(report.bridge.shutdown?.forced, false, 'Bridge should stop gracefully')
  assert.ok(report.timeline.bridgeReadyMs > 0)
  assert.ok(report.timeline.windowLoadedMs >= report.timeline.bridgeReadyMs)
  assert.ok(report.timeline.windowLoadedMs < 20_000, `Cold start took ${report.timeline.windowLoadedMs}ms`)
  assert.equal(report.window.rendererProbe.documentReadyState, 'complete')
  assert.equal(report.window.rendererProbe.processType, 'undefined')
  assert.equal(report.window.rendererProbe.requireType, 'undefined')
  assert.equal(report.window.rendererProbe.electronBridgeType, 'undefined')
  for (const directory of [
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
  assert.equal(report.security.nodeIntegration, false)
  assert.equal(report.security.contextIsolation, true)
  assert.equal(report.security.sandbox, true)
  assert.equal(report.security.permissionsDefault, 'deny')
  assert.deepEqual(report.window.consoleWarningsAndErrors, [])
  assert.ok(Array.isArray(report.processMetrics) && report.processMetrics.length >= 2)
  assert.equal(
    await waitForBridgeClosed({ baseUrl: `http://127.0.0.1:${report.bridge.port}`, timeoutMs: 1_000 }),
    true,
  )

  const persistedReport = {
    ...report,
    validation: {
      completedAt: new Date().toISOString(),
      assertions: 27,
      electronExitCode: result.exitCode,
    },
  }
  await mkdir(dirname(finalReportPath), { recursive: true })
  await writeFile(finalReportPath, `${JSON.stringify(persistedReport, null, 2)}\n`, 'utf8')
  console.log(`✓ Electron desktop lifecycle passed in ${report.timeline.windowLoadedMs}ms`)
  console.log(`✓ Bridge PID ${report.bridge.pid} exited gracefully; port ${report.bridge.port} is closed`)
  console.log(`✓ Renderer sandbox probe: process=${report.window.rendererProbe.processType}, require=${report.window.rendererProbe.requireType}`)
  console.log(`✓ Report: ${finalReportPath}`)
} finally {
  await rm(runtimeDirectory, { recursive: true, force: true })
}
