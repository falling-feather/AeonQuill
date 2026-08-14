import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { waitForBridgeClosed } from '../desktop/shared/bridge-contract.mjs'
import { loadReleaseMetadata, resolveReleasePaths } from '../desktop/release/release-meta.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const metadata = await loadReleaseMetadata(projectRoot)
const releasePaths = resolveReleasePaths(metadata)
const runtimeRoot = resolve(projectRoot, '.runtime')
const installerPath = releasePaths.installer
const testRoot = join(runtimeRoot, 'install-test', `tauri-${process.pid}`)
const installDirectory = join(testRoot, 'app')
const userDataDirectory = join(testRoot, 'user-data-preserve')
const appRuntimeDirectory = join(userDataDirectory, 'runtime')
const appDataDirectory = join(userDataDirectory, 'data')
const appCacheDirectory = join(userDataDirectory, 'cache')
const appLogDirectory = join(userDataDirectory, 'logs')
const appConfigPath = join(userDataDirectory, 'config', 'local.json')
const userDataSentinel = join(userDataDirectory, 'projects', 'keep-after-uninstall.txt')
const legacyRuntimeSentinel = join(appRuntimeDirectory, 'projects', 'legacy-runtime-sentinel.txt')
const legacyRuntimeDatabase = join(appRuntimeDirectory, 'projects', 'projects.sqlite3')
const newDataDatabase = join(appDataDirectory, 'projects', 'projects.sqlite3')
const appReportPath = join(appRuntimeDirectory, 'reports', 'installed-app.json')
const finalReportPath = join(runtimeRoot, 'qa', 'tauri-installer-final.json')
const uninstallRegistryKey = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${metadata.productName}`
const startMenuShortcut = join(
  process.env.APPDATA || '',
  'Microsoft',
  'Windows',
  'Start Menu',
  'Programs',
  metadata.productName,
  `${metadata.productName}.lnk`,
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
assert.equal(await pathExists(startMenuShortcut), false, 'Refusing to overwrite an existing AEONQUILL shortcut')
const registryBefore = await runProcess('reg.exe', ['query', uninstallRegistryKey], { timeoutMs: 10_000 })
assert.equal(registryBefore.exitCode, 1, 'Refusing to overwrite an existing AEONQUILL uninstall registration')
await mkdir(dirname(userDataSentinel), { recursive: true })
await writeFile(userDataSentinel, 'AEONQUILL user data must survive uninstall.\n', 'utf8')
await mkdir(dirname(legacyRuntimeSentinel), { recursive: true })
await writeFile(legacyRuntimeSentinel, 'AEONQUILL legacy runtime data must remain visible.\n', 'utf8')

let installedAppProcess = null
try {
  const installStartedAt = Date.now()
  const installResult = await runProcess(installerPath, ['/S', `/D=${installDirectory}`], {
    cwd: testRoot,
    timeoutMs: 180_000,
  })
  assert.equal(installResult.exitCode, 0, `Installer exit=${installResult.exitCode}\n${installResult.stderr}`)
  const installMs = Date.now() - installStartedAt

  const installedAppPath = join(installDirectory, metadata.appExecutable)
  const installedSidecarPath = join(installDirectory, metadata.sidecarRuntimeFilename)
  const installedReleaseFiles = [
    join(installDirectory, 'release', 'INSTALL.zh-CN.md'),
    join(installDirectory, 'release', 'LIMITATIONS.zh-CN.md'),
    join(installDirectory, 'release', 'THIRD-PARTY-NOTICES.md'),
  ]
  const [installedAppStats, installedSidecarStats] = await Promise.all([
    stat(installedAppPath),
    stat(installedSidecarPath),
  ])
  assert.ok(installedAppStats.size > 1_000_000)
  assert.ok(installedSidecarStats.size > 20_000_000)
  for (const releaseFile of installedReleaseFiles) {
    assert.ok((await stat(releaseFile)).size > 500, `Bundled release notice is missing: ${releaseFile}`)
  }
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
      AEONQUILL_DESKTOP_QA: '1',
      AEONQUILL_DESKTOP_AUTOCLOSE_MS: '600',
      AEONQUILL_DESKTOP_REPORT: appReportPath,
      AEONQUILL_RUNTIME_DIR: appRuntimeDirectory,
      AEONQUILL_DATA_DIR: appDataDirectory,
      AEONQUILL_CACHE_DIR: appCacheDirectory,
      AEONQUILL_LOG_DIR: appLogDirectory,
      AEONQUILL_CONFIG: appConfigPath,
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
  assert.ok(
    appReport.timeline.windowCloseRequestedMs >= appReport.timeline.rendererProbedMs,
    'Installed app QA must close the real main window instead of requesting a synthetic app exit',
  )
  assert.equal(appReport.shutdown?.forced, false)
  assert.equal(appReport.shutdown?.portClosed, true)
  for (const directory of [
    appRuntimeDirectory,
    appDataDirectory,
    appCacheDirectory,
    appLogDirectory,
    dirname(appConfigPath),
  ]) {
    assert.equal((await stat(directory)).isDirectory(), true)
  }
  assert.equal((await stat(legacyRuntimeDatabase)).isFile(), true)
  assert.equal(
    await pathExists(newDataDatabase),
    false,
    'An empty new data directory must not hide durable data from the legacy runtime layout',
  )
  assert.equal(
    await readFile(legacyRuntimeSentinel, 'utf8'),
    'AEONQUILL legacy runtime data must remain visible.\n',
  )
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
  assert.equal(
    await readFile(userDataSentinel, 'utf8'),
    'AEONQUILL user data must survive uninstall.\n',
    'Uninstaller removed or changed user project data',
  )
  assert.equal(
    await readFile(legacyRuntimeSentinel, 'utf8'),
    'AEONQUILL legacy runtime data must remain visible.\n',
    'Uninstaller removed or changed compatible legacy runtime data',
  )
  const uninstallMs = Date.now() - uninstallStartedAt

  const report = {
    schemaVersion: 1,
    status: 'passed',
    product: {
      name: metadata.productName,
      version: metadata.version,
      identifier: metadata.identifier,
    },
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
      releaseNoticesInstalled: installedReleaseFiles.length,
    },
    installedApp: {
      lifecycleMs: appLifecycleMs,
      windowLoadedMs: appReport.timeline.windowLoadedMs,
      rendererSandboxed: true,
      bridgeExitedGracefully: true,
      legacyRuntimeDataFallback: true,
    },
    uninstallation: {
      exitCode: uninstallResult.exitCode,
      uninstallMs,
      installedExecutableRemoved: true,
      uninstallRegistrationRemoved: true,
      startMenuShortcutRemoved: true,
      userDataPreserved: true,
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
