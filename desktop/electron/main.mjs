import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { app, BrowserWindow, dialog, session, utilityProcess } from 'electron'
import {
  findAvailableLoopbackPort,
  isPathInside,
  LOOPBACK_HOST,
  waitForBridgeClosed,
  waitForBridgeReady,
} from '../shared/bridge-contract.mjs'
import { selectElectronUserDataDirectory } from '../shared/user-data-compat.mjs'
import { resolvePortableDataDirectory } from '../shared/portable-layout.mjs'
import { createRestrictedChildEnvironment, redactSensitiveText } from '../../server/security.mjs'

const startupStartedAt = Date.now()
const qaMode = (process.env.AEONQUILL_DESKTOP_QA || process.env.MIAOHUI_DESKTOP_QA) === '1'
const qaUserData = process.env.AEONQUILL_DESKTOP_USER_DATA || process.env.MIAOHUI_DESKTOP_USER_DATA

app.setName('AEONQUILL')
const portableLayout = app.isPackaged
  ? resolvePortableDataDirectory({ executableDirectory: dirname(process.execPath) })
  : null
const storagePathsExplicit = [
  'AEONQUILL_RUNTIME_DIR',
  'AEONQUILL_DATA_DIR',
  'AEONQUILL_CACHE_DIR',
  'AEONQUILL_LOG_DIR',
  'AEONQUILL_CONFIG',
  'MIAOHUI_RUNTIME_DIR',
  'MIAOHUI_DATA_DIR',
  'MIAOHUI_CACHE_DIR',
  'MIAOHUI_LOG_DIR',
  'MIAOHUI_CONFIG',
].some((key) => Boolean(process.env[key]))
const userDataSelection = selectElectronUserDataDirectory({
  defaultDirectory: app.getPath('userData'),
  legacyDirectory: join(app.getPath('appData'), 'MiaoHui'),
  explicitDirectory: qaUserData,
  portableDirectory: portableLayout?.directory,
  storagePathsExplicit,
})
if (['explicit', 'portable-sibling-user-data'].includes(userDataSelection.layout)) {
  mkdirSync(userDataSelection.directory, { recursive: true })
}
app.setPath('userData', userDataSelection.directory)

let mainWindow = null
let bridgeProcess = null
let bridgePid = null
let bridgeExitCode = null
let bridgeBaseUrl = null
let bridgePort = null
let bridgeExited = false
let intentionalShutdown = false
let shutdownComplete = false
let shutdownPromise = null
let fatalError = null

const bridgeLogs = { stdout: '', stderr: '' }
const rendererMessages = []
const timeline = {}
const rendererProbe = {}

function elapsedMs() {
  return Date.now() - startupStartedAt
}

function appendBoundedLog(target, chunk) {
  const next = `${bridgeLogs[target]}${String(chunk)}`
  bridgeLogs[target] = next.slice(-16_000)
}

function safeMessage(error) {
  return redactSensitiveText(error?.message || String(error || 'Unknown desktop error'))
}

function summarizeAppMetrics() {
  return app.getAppMetrics().map((metric) => ({
    pid: metric.pid,
    type: metric.type,
    name: metric.name,
    cpuPercent: metric.cpu?.percentCPUUsage,
    idleWakeupsPerSecond: metric.cpu?.idleWakeupsPerSecond,
    memory: metric.memory,
  }))
}

function runtimePaths() {
  const appRoot = app.getAppPath()
  const appDataRoot = resolve(app.getPath('userData'))
  const runtimeDirectory = resolve(
    process.env.AEONQUILL_RUNTIME_DIR
      || process.env.MIAOHUI_RUNTIME_DIR
      || join(appDataRoot, 'runtime'),
  )
  const dataDirectory = resolve(process.env.AEONQUILL_DATA_DIR || join(appDataRoot, 'data'))
  const cacheDirectory = resolve(process.env.AEONQUILL_CACHE_DIR || join(appDataRoot, 'cache'))
  const logDirectory = resolve(process.env.AEONQUILL_LOG_DIR || join(appDataRoot, 'logs'))
  const defaultOutputDirectory = resolve(
    process.env.AEONQUILL_DEFAULT_OUTPUT_DIR
      || (userDataSelection.layout === 'portable-sibling-user-data'
        ? join(dirname(appDataRoot), 'output')
        : app.isPackaged
        ? join(appDataRoot, 'output')
        : join(appRoot, 'output')),
  )
  const configPath = resolve(
    process.env.AEONQUILL_CONFIG
      || process.env.MIAOHUI_CONFIG
      || join(appDataRoot, 'config', 'local.json'),
  )
  return { appRoot, appDataRoot, runtimeDirectory, dataDirectory, cacheDirectory, logDirectory, defaultOutputDirectory, configPath }
}

function createBridgeEnvironment({
  port,
  runtimeDirectory,
  dataDirectory,
  cacheDirectory,
  logDirectory,
  defaultOutputDirectory,
  configPath,
}) {
  return createRestrictedChildEnvironment({
    AEONQUILL_PORT: port,
    AEONQUILL_HOST: LOOPBACK_HOST,
    AEONQUILL_RUNTIME_DIR: runtimeDirectory,
    AEONQUILL_DATA_DIR: dataDirectory,
    AEONQUILL_CACHE_DIR: cacheDirectory,
    AEONQUILL_LOG_DIR: logDirectory,
    AEONQUILL_DEFAULT_OUTPUT_DIR: defaultOutputDirectory,
    AEONQUILL_CONFIG: configPath,
    MIAOHUI_PORT: port,
    MIAOHUI_HOST: LOOPBACK_HOST,
    MIAOHUI_RUNTIME_DIR: runtimeDirectory,
    MIAOHUI_CONFIG: configPath,
    AEONQUILL_ALLOWED_ORIGINS: process.env.AEONQUILL_ALLOWED_ORIGINS,
    MIAOHUI_ALLOWED_ORIGINS: process.env.MIAOHUI_ALLOWED_ORIGINS,
    AEONQUILL_COMFY_POLICY: process.env.AEONQUILL_COMFY_POLICY,
    AEONQUILL_COMFY_IDLE_SECONDS: process.env.AEONQUILL_COMFY_IDLE_SECONDS,
    MIAOHUI_COMFY_POLICY: process.env.MIAOHUI_COMFY_POLICY,
    MIAOHUI_COMFY_IDLE_SECONDS: process.env.MIAOHUI_COMFY_IDLE_SECONDS,
    AEONQUILL_IMAGE_CONCURRENCY: process.env.AEONQUILL_IMAGE_CONCURRENCY,
    MIAOHUI_IMAGE_CONCURRENCY: process.env.MIAOHUI_IMAGE_CONCURRENCY,
    COMFY_URL: process.env.COMFY_URL,
    AEONQUILL_COMFY_ROOT: process.env.AEONQUILL_COMFY_ROOT,
    AEONQUILL_COMFY_PYTHON: process.env.AEONQUILL_COMFY_PYTHON,
    COMFY_ROOT: process.env.COMFY_ROOT,
    COMFY_PYTHON: process.env.COMFY_PYTHON,
    FFMPEG_PATH: process.env.FFMPEG_PATH,
    FFPROBE_PATH: process.env.FFPROBE_PATH,
    AEONQUILL_REMBG_PATH: process.env.AEONQUILL_REMBG_PATH,
    AEONQUILL_REMBG_MODELS: process.env.AEONQUILL_REMBG_MODELS,
    AEONQUILL_REALESRGAN_PATH: process.env.AEONQUILL_REALESRGAN_PATH,
    AEONQUILL_REALESRGAN_MODELS: process.env.AEONQUILL_REALESRGAN_MODELS,
    MIAOHUI_REMBG_PATH: process.env.MIAOHUI_REMBG_PATH,
    MIAOHUI_REMBG_MODELS: process.env.MIAOHUI_REMBG_MODELS,
    MIAOHUI_REALESRGAN_PATH: process.env.MIAOHUI_REALESRGAN_PATH,
    MIAOHUI_REALESRGAN_MODELS: process.env.MIAOHUI_REALESRGAN_MODELS,
  })
}

async function startBridge() {
  const {
    appRoot,
    runtimeDirectory,
    dataDirectory,
    cacheDirectory,
    logDirectory,
    defaultOutputDirectory,
    configPath,
  } = runtimePaths()
  await Promise.all([
    mkdir(runtimeDirectory, { recursive: true }),
    mkdir(dataDirectory, { recursive: true }),
    mkdir(cacheDirectory, { recursive: true }),
    mkdir(logDirectory, { recursive: true }),
    mkdir(defaultOutputDirectory, { recursive: true }),
    mkdir(dirname(configPath), { recursive: true }),
  ])
  bridgePort = await findAvailableLoopbackPort()
  bridgeBaseUrl = `http://${LOOPBACK_HOST}:${bridgePort}`
  const bridgeEntry = join(appRoot, 'server', 'index.mjs')

  bridgeProcess = utilityProcess.fork(bridgeEntry, [], {
    cwd: appRoot,
    env: createBridgeEnvironment({
      port: bridgePort,
      runtimeDirectory,
      dataDirectory,
      cacheDirectory,
      logDirectory,
      defaultOutputDirectory,
      configPath,
    }),
    serviceName: 'AEONQUILL Local Bridge',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  bridgeProcess.stdout?.on('data', (chunk) => {
    appendBoundedLog('stdout', chunk)
    if (!qaMode) process.stdout.write(chunk)
  })
  bridgeProcess.stderr?.on('data', (chunk) => {
    appendBoundedLog('stderr', chunk)
    if (!qaMode) process.stderr.write(chunk)
  })
  bridgeProcess.once('spawn', () => {
    bridgePid = bridgeProcess?.pid || null
    timeline.bridgeSpawnedMs = elapsedMs()
  })
  bridgeProcess.once('exit', (code) => {
    bridgeExited = true
    bridgeExitCode = code
    if (!intentionalShutdown) {
      fatalError = new Error(`Local bridge exited unexpectedly with code ${code}`)
      if (mainWindow && !mainWindow.isDestroyed()) {
        void mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(
          '<main style="font:16px system-ui;padding:40px"><h1>AEONQUILL 本地服务已停止</h1><p>请重新启动应用；诊断信息已保存在本机运行目录。</p></main>',
        )}`)
      }
    }
  })

  const health = await waitForBridgeReady({
    baseUrl: bridgeBaseUrl,
    isProcessAlive: () => !bridgeExited,
  })
  bridgePid ||= bridgeProcess.pid || null
  timeline.bridgeReadyMs = elapsedMs()
  return health
}

function blockUntrustedNavigation(webContents) {
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  webContents.on('will-attach-webview', (event) => event.preventDefault())
  webContents.on('will-frame-navigate', (details) => {
    try {
      if (new URL(details.url).origin !== bridgeBaseUrl) details.preventDefault()
    } catch {
      details.preventDefault()
    }
  })
}

function configureDesktopSession() {
  const desktopSession = session.defaultSession
  desktopSession.setPermissionCheckHandler(() => false)
  desktopSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  desktopSession.setDevicePermissionHandler(() => false)
  desktopSession.webRequest.onBeforeRequest((details, callback) => {
    try {
      const url = new URL(details.url)
      const isNetworkRequest = ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)
      callback({ cancel: isNetworkRequest && url.origin !== bridgeBaseUrl })
    } catch {
      callback({ cancel: true })
    }
  })
}

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f6f6f2',
    title: '光阴砚 AEONQUILL',
    webPreferences: {
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: true,
    },
  })
  mainWindow.setMenuBarVisibility(false)
  blockUntrustedNavigation(mainWindow.webContents)
  mainWindow.webContents.on('console-message', (details, legacyLevel, legacyMessage, legacyLine, legacySourceId) => {
    const level = details.level ?? legacyLevel
    if (level !== 'warning' && level !== 'error' && Number(level) < 2) return
    rendererMessages.push({
      level,
      message: String(details.message ?? legacyMessage ?? '').slice(0, 1_000),
      line: details.lineNumber ?? legacyLine,
      source: String(details.sourceId ?? legacySourceId ?? '').slice(-300),
    })
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    fatalError = new Error(`Renderer process ended: ${details.reason}`)
  })

  await mainWindow.loadURL(bridgeBaseUrl)
  timeline.windowLoadedMs = elapsedMs()
  Object.assign(rendererProbe, await mainWindow.webContents.executeJavaScript(`({
    documentReadyState: document.readyState,
    title: document.title,
    url: location.href,
    processType: typeof process,
    requireType: typeof require,
    electronBridgeType: typeof window.electron,
  })`, true))
  timeline.rendererProbedMs = elapsedMs()
  if (!qaMode) mainWindow.show()
}

async function forceKillBridgeProcess(pid) {
  if (!pid || process.platform !== 'win32') return false
  return new Promise((resolvePromise) => {
    execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (error) => {
      resolvePromise(!error)
    })
  })
}

async function stopBridge() {
  if (!bridgeProcess || bridgeExited) {
    const portClosed = bridgeBaseUrl
      ? await waitForBridgeClosed({ baseUrl: bridgeBaseUrl, timeoutMs: 1_000 })
      : true
    return { requested: false, exited: bridgeExited, exitCode: bridgeExitCode, portClosed, forced: false }
  }
  intentionalShutdown = true
  const pid = bridgePid || bridgeProcess.pid
  const exitPromise = new Promise((resolvePromise) => {
    bridgeProcess.once('exit', (code) => resolvePromise(code))
  })
  const requested = bridgeProcess.kill()
  let forced = false
  let exitCode = await Promise.race([
    exitPromise,
    new Promise((resolvePromise) => setTimeout(() => resolvePromise(null), 5_000)),
  ])
  if (!bridgeExited) {
    forced = await forceKillBridgeProcess(pid)
    exitCode = await Promise.race([
      exitPromise,
      new Promise((resolvePromise) => setTimeout(() => resolvePromise(null), 3_000)),
    ])
  }
  const portClosed = bridgeBaseUrl
    ? await waitForBridgeClosed({ baseUrl: bridgeBaseUrl, timeoutMs: 3_000 })
    : true
  return { requested, exited: bridgeExited, exitCode, portClosed, forced }
}

async function writeQaReport(shutdown = null, error = null) {
  if (!qaMode) return
  const { runtimeDirectory } = runtimePaths()
  const configuredReportPath = process.env.AEONQUILL_DESKTOP_REPORT || process.env.MIAOHUI_DESKTOP_REPORT
  const reportPath = configuredReportPath
    ? resolve(configuredReportPath)
    : join(runtimeDirectory, 'desktop-electron-qa.json')
  if (!isPathInside(runtimeDirectory, reportPath)) {
    throw new Error('Desktop QA report must be written inside the isolated runtime directory')
  }
  await mkdir(dirname(reportPath), { recursive: true })
  const report = {
    schemaVersion: 1,
    status: error || fatalError ? 'failed' : 'passed',
    shell: 'electron',
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    },
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    userDataLayout: userDataSelection.layout,
    timeline,
    bridge: {
      host: LOOPBACK_HOST,
      port: bridgePort,
      pid: bridgePid,
      healthUrl: bridgeBaseUrl ? `${bridgeBaseUrl}/api/health` : null,
      exitCode: bridgeExitCode,
      shutdown,
      stderrTail: bridgeLogs.stderr.slice(-2_000),
    },
    window: {
      visibleDuringQa: false,
      rendererProbe,
      consoleWarningsAndErrors: rendererMessages,
    },
    security: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      permissionsDefault: 'deny',
      newWindows: 'deny',
      navigationOrigin: bridgeBaseUrl,
    },
    processMetrics: summarizeAppMetrics(),
    mainProcessMemory: process.memoryUsage(),
    error: error || fatalError ? safeMessage(error || fatalError) : null,
  }
  const temporaryPath = `${reportPath}.tmp-${process.pid}`
  await writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await rename(temporaryPath, reportPath)
}

async function completeShutdown(error = null) {
  if (shutdownPromise) return shutdownPromise
  shutdownPromise = (async () => {
    const shutdown = await stopBridge()
    timeline.shutdownFinishedMs = elapsedMs()
    await writeQaReport(shutdown, error)
    shutdownComplete = true
  })()
  return shutdownPromise
}

async function run() {
  await app.whenReady()
  timeline.electronReadyMs = elapsedMs()
  await startBridge()
  configureDesktopSession()
  await createMainWindow()

  if (qaMode) {
    const configuredAutoClose = process.env.AEONQUILL_DESKTOP_AUTOCLOSE_MS
      || process.env.MIAOHUI_DESKTOP_AUTOCLOSE_MS
    const autoCloseMs = Math.max(250, Math.min(12_000, Number(configuredAutoClose) || 600))
    setTimeout(() => app.quit(), autoCloseMs)
  }
}

const hasSingleInstanceLock = qaMode || app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', (event) => {
    if (shutdownComplete) return
    event.preventDefault()
    void completeShutdown().then(() => app.quit()).catch((error) => {
      console.error(safeMessage(error))
      app.exit(1)
    })
  })
  run().catch(async (error) => {
    fatalError = error
    console.error(safeMessage(error))
    if (!qaMode) dialog.showErrorBox('AEONQUILL 启动失败', safeMessage(error))
    try {
      await completeShutdown(error)
    } finally {
      app.exit(1)
    }
  })
}
