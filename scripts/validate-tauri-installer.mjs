import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { waitForBridgeClosed } from '../desktop/shared/bridge-contract.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const runtimeRoot = resolve(projectRoot, '.runtime')
const installerPath = join(
  projectRoot,
  'desktop',
  'tauri',
  'src-tauri',
  'target',
  'release',
  'bundle',
  'nsis',
  'MiaoHui_0.1.0_x64-setup.exe',
)
const testRoot = join(runtimeRoot, 'install-test', `tauri-${process.pid}`)
const installDirectory = join(testRoot, 'app')
const appRuntimeDirectory = join(testRoot, 'runtime')
const appReportPath = join(appRuntimeDirectory, 'reports', 'installed-app.json')
const finalReportPath = join(runtimeRoot, 'qa', 'tauri-installer-final.json')
const uninstallRegistryKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MiaoHui'
const startMenuShortcut = join(
  process.env.APPDATA || '',
  'Microsoft',
  'Windows',
  'Start Menu',
  'Programs',
  'MiaoHui.lnk',
)

function assertRuntimeTarget(target) {
  const relativePath = relative(runtimeRoot, resolve(target))
  assert.ok(relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath), `Unsafe test target: ${target}`)
}

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

async function runProcess(command, args, { cwd, env = process.env, timeoutMs = 120_000 } = {}) {
  const stdout = []
  const stderr = []
  const child = spawn(command, args, {
    cwd,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => stdout.push(String(chunk)))
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)))
  const exitCode = await waitForChildExit(child, timeoutMs)
  if (exitCode === 'timeout') await terminateProcessTree(child)
  return { child, exitCode, stdout: stdout.join('').trim(), stderr: stderr.join('').trim() }
}

async function sha256(pathname) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(pathname)) hash.update(chunk)
  return hash.digest('hex')
}

async function waitUntilMissing(pathname, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await stat(pathname)
    } catch (error) {
      if (error.code === 'ENOENT') return true
      throw error
    }
    await delay(150)
  }
  return false
}

async function pathExists(pathname) {
  try {
    await stat(pathname)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function waitUntilRegistryMissing(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await runProcess('reg.exe', ['query', uninstallRegistryKey], { timeoutMs: 5_000 })
    if (result.exitCode === 1) return true
    await delay(150)
  }
  return false
}

for (const target of [testRoot, installDirectory, appRuntimeDirectory]) assertRuntimeTarget(target)
const installerStats = await stat(installerPath)
assert.ok(installerStats.isFile() && installerStats.size > 10 * 1024 * 1024, 'NSIS installer is missing')
assert.equal(await pathExists(startMenuShortcut), false, 'Refusing to overwrite an existing MiaoHui shortcut')
const registryBefore = await runProcess('reg.exe', ['query', uninstallRegistryKey], { timeoutMs: 10_000 })
assert.equal(registryBefore.exitCode, 1, 'Refusing to overwrite an existing MiaoHui uninstall registration')
await mkdir(testRoot, { recursive: true })

let installedAppProcess = null
try {
  const installStartedAt = Date.now()
  const installResult = await runProcess(installerPath, ['/S', `/D=${installDirectory}`], {
    cwd: testRoot,
    timeoutMs: 180_000,
  })
  assert.equal(installResult.exitCode, 0, `Installer exit=${installResult.exitCode}\n${installResult.stderr}`)
  const installMs = Date.now() - installStartedAt

  const installedAppPath = join(installDirectory, 'miaohui-desktop.exe')
  const installedSidecarPath = join(installDirectory, 'miaohui-bridge.exe')
  const [installedAppStats, installedSidecarStats] = await Promise.all([
    stat(installedAppPath),
    stat(installedSidecarPath),
  ])
  assert.ok(installedAppStats.size > 1_000_000)
  assert.ok(installedSidecarStats.size > 20_000_000)
  const uninstallEntry = (await readdir(installDirectory)).find((name) => /^uninstall.*\.exe$/i.test(name))
  assert.ok(uninstallEntry, 'NSIS uninstaller was not installed')
  const uninstallerPath = join(installDirectory, uninstallEntry)

  const unavailableComfyPort = await availablePort()
  const appStartedAt = Date.now()
  installedAppProcess = spawn(installedAppPath, [], {
    cwd: installDirectory,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MIAOHUI_DESKTOP_QA: '1',
      MIAOHUI_DESKTOP_AUTOCLOSE_MS: '600',
      MIAOHUI_DESKTOP_REPORT: appReportPath,
      MIAOHUI_RUNTIME_DIR: appRuntimeDirectory,
      MIAOHUI_CONFIG: join(appRuntimeDirectory, 'no-local-config.json'),
      MIAOHUI_COMFY_POLICY: 'manual',
      COMFY_URL: `http://127.0.0.1:${unavailableComfyPort}`,
    },
  })
  const appExitCode = await waitForChildExit(installedAppProcess, 35_000)
  if (appExitCode === 'timeout') await terminateProcessTree(installedAppProcess)
  assert.equal(appExitCode, 0, `Installed app exit=${appExitCode}`)
  const appLifecycleMs = Date.now() - appStartedAt
  const appReport = JSON.parse(await readFile(appReportPath, 'utf8'))
  assert.equal(appReport.status, 'passed')
  assert.equal(appReport.packaged, true)
  assert.equal(appReport.rendererProbe.processType, 'undefined')
  assert.equal(appReport.rendererProbe.requireType, 'undefined')
  assert.equal(appReport.shutdown?.forced, false)
  assert.equal(appReport.shutdown?.portClosed, true)
  assert.equal(
    await waitForBridgeClosed({ baseUrl: `http://127.0.0.1:${appReport.bridgePort}`, timeoutMs: 1_000 }),
    true,
  )

  const uninstallStartedAt = Date.now()
  const uninstallResult = await runProcess(uninstallerPath, ['/S'], {
    cwd: testRoot,
    timeoutMs: 120_000,
  })
  assert.equal(uninstallResult.exitCode, 0, `Uninstaller exit=${uninstallResult.exitCode}\n${uninstallResult.stderr}`)
  assert.equal(await waitUntilMissing(installedAppPath, 15_000), true, 'Installed executable remained after uninstall')
  assert.equal(await waitUntilRegistryMissing(15_000), true, 'Uninstall registration remained after uninstall')
  assert.equal(await waitUntilMissing(startMenuShortcut, 15_000), true, 'Start menu shortcut remained after uninstall')
  const uninstallMs = Date.now() - uninstallStartedAt

  const report = {
    schemaVersion: 1,
    status: 'passed',
    installer: {
      filename: installerPath.split(/[\\/]/).pop(),
      bytes: installerStats.size,
      sha256: await sha256(installerPath),
      signed: false,
      webview2Mode: 'embedBootstrapper',
    },
    installation: {
      mode: 'currentUser-silent-isolated-directory',
      installMs,
      executableBytes: installedAppStats.size,
      sidecarBytes: installedSidecarStats.size,
      uninstallerCreated: true,
    },
    installedApp: {
      lifecycleMs: appLifecycleMs,
      windowLoadedMs: appReport.timeline.windowLoadedMs,
      rendererSandboxed: true,
      bridgeExitedGracefully: true,
    },
    uninstallation: {
      exitCode: uninstallResult.exitCode,
      uninstallMs,
      installedExecutableRemoved: true,
      uninstallRegistrationRemoved: true,
      startMenuShortcutRemoved: true,
    },
    validatedAt: new Date().toISOString(),
  }
  await mkdir(dirname(finalReportPath), { recursive: true })
  await writeFile(finalReportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(`✓ NSIS silent install completed in ${installMs}ms`)
  console.log(`✓ Installed app lifecycle passed in ${appLifecycleMs}ms`)
  console.log(`✓ Silent uninstall completed in ${uninstallMs}ms and removed the executable`)
  console.log(`✓ Installer ${(installerStats.size / 1024 / 1024).toFixed(1)} MiB, SHA-256 ${report.installer.sha256.slice(0, 12)}…`)
  console.log(`✓ Report: ${finalReportPath}`)
} finally {
  await terminateProcessTree(installedAppProcess)
  assertRuntimeTarget(testRoot)
  await rm(testRoot, { recursive: true, force: true })
}
