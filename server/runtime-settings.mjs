import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import {
  cacheDirectory,
  dataDirectory,
  defaultOutputDirectory,
  logDirectory,
  projectRoot,
  runtimeDirectory,
  usingLegacyDataDirectory,
} from './runtime-paths.mjs'

const SETTINGS_KEYS = new Set([
  'mode',
  'comfyRoot',
  'pythonPath',
  'comfyUrl',
  'comfyLaunchPolicy',
  'comfyIdleSeconds',
  'outputDirectory',
])
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
const LAUNCH_POLICIES = new Set(['persistent', 'idle', 'manual'])
const MAX_PATH_LENGTH = 1_024
const DEFAULT_COMFY_URL = 'http://127.0.0.1:8188'

function settingsError(code, message, status = 400, details) {
  return Object.assign(new Error(message), { code, status, details })
}

async function isFile(pathname) {
  if (!pathname) return false
  try {
    return (await stat(pathname)).isFile()
  } catch {
    return false
  }
}

async function isDirectory(pathname) {
  if (!pathname) return false
  try {
    return (await stat(pathname)).isDirectory()
  } catch {
    return false
  }
}

function exactObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw settingsError('INVALID_RUNTIME_SETTINGS', `${label} 必须是对象`)
  }
  for (const key of Object.keys(value)) {
    if (!SETTINGS_KEYS.has(key)) {
      throw settingsError('UNKNOWN_RUNTIME_SETTING', `不支持的本机设置字段：${key}`)
    }
  }
  return value
}

function normalizeOptionalPath(value, label) {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  if (typeof value !== 'string') throw settingsError('INVALID_LOCAL_PATH', `${label} 必须是本机绝对路径`)
  const normalized = value.trim()
  if (
    !normalized
    || normalized.length > MAX_PATH_LENGTH
    || /[\u0000-\u001f\u007f]/u.test(normalized)
    || (process.platform === 'win32' && /^\\\\/u.test(normalized))
    || !isAbsolute(normalized)
  ) {
    throw settingsError('INVALID_LOCAL_PATH', `${label} 必须是有效的本机绝对路径`)
  }
  return resolve(normalized)
}

export function normalizeLoopbackComfyUrl(value) {
  if (value === undefined) return undefined
  if (value === null || value === '') return DEFAULT_COMFY_URL
  let url
  try {
    url = new URL(String(value))
  } catch {
    throw settingsError('INVALID_COMFY_URL', 'ComfyUI 地址必须是有效的回环 HTTP 地址')
  }
  if (
    url.protocol !== 'http:'
    || !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())
    || url.username
    || url.password
    || (url.pathname !== '/' && url.pathname !== '')
    || url.search
    || url.hash
  ) {
    throw settingsError('INVALID_COMFY_URL', '只允许不含凭据、路径或查询的回环 HTTP ComfyUI 地址')
  }
  const port = Number(url.port || 80)
  if (!Number.isSafeInteger(port) || port < 1_024 || port > 65_535) {
    throw settingsError('INVALID_COMFY_URL', 'ComfyUI 端口必须在 1024–65535 之间')
  }
  return url.origin
}

function normalizePolicy(value) {
  if (value === undefined) return undefined
  if (!LAUNCH_POLICIES.has(value)) {
    throw settingsError('INVALID_COMFY_POLICY', 'ComfyUI 运行策略必须是 persistent、idle 或 manual')
  }
  return value
}

function normalizeIdleSeconds(value) {
  if (value === undefined) return undefined
  const seconds = Number(value)
  if (!Number.isSafeInteger(seconds) || seconds < 30 || seconds > 3_600) {
    throw settingsError('INVALID_IDLE_TIMEOUT', '空闲关闭时间必须是 30–3600 秒的整数')
  }
  return seconds
}

export function resolveLocalConfigPath() {
  return resolve(
    process.env.AEONQUILL_CONFIG
      || process.env.MIAOHUI_CONFIG
      || join(projectRoot, 'config', 'local.json'),
  )
}

export const localConfigPath = resolveLocalConfigPath()

export async function readLocalConfigFile(pathname = localConfigPath) {
  try {
    const parsed = JSON.parse(await readFile(pathname, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw settingsError('INVALID_LOCAL_CONFIG', '本机配置文件必须是 JSON 对象', 500)
    }
    return parsed
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    if (error instanceof SyntaxError) {
      throw settingsError('INVALID_LOCAL_CONFIG', '本机配置文件不是有效 JSON', 500)
    }
    throw error
  }
}

function candidateRoots(configuredRoot) {
  const candidates = new Set()
  if (typeof configuredRoot === 'string' && configuredRoot) candidates.add(resolve(configuredRoot))
  if (process.env.COMFY_ROOT) candidates.add(resolve(process.env.COMFY_ROOT))
  const homes = [homedir(), 'C:\\', 'D:\\']
  for (const root of homes) {
    candidates.add(resolve(root, 'ComfyUI'))
    candidates.add(resolve(root, 'ComfyUI_windows_portable', 'ComfyUI'))
  }
  return candidates
}

async function shallowComfyRoots() {
  const found = []
  if (process.platform !== 'win32') return found
  for (const drive of ['C:\\', 'D:\\']) {
    let entries
    try {
      entries = await readdir(drive, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/comfy/i.test(entry.name)) continue
      const root = join(drive, entry.name)
      const queue = [{ pathname: root, depth: 0 }]
      let visited = 0
      while (queue.length && visited < 100) {
        const current = queue.shift()
        visited += 1
        found.push(current.pathname, join(current.pathname, 'ComfyUI'))
        if (current.depth >= 4) continue
        let children
        try {
          children = await readdir(current.pathname, { withFileTypes: true })
        } catch {
          continue
        }
        for (const child of children) {
          if (!child.isDirectory() || !/(?:comfy|aki|portable|windows)/i.test(child.name)) continue
          queue.push({ pathname: join(current.pathname, child.name), depth: current.depth + 1 })
        }
      }
    }
  }
  return found
}

async function pythonCandidates(comfyRoot, configuredPython) {
  const parent = dirname(comfyRoot)
  return [
    configuredPython,
    process.env.COMFY_PYTHON,
    process.env.AEONQUILL_COMFY_PYTHON,
    join(comfyRoot, '.venv', 'Scripts', 'python.exe'),
    join(comfyRoot, 'venv', 'Scripts', 'python.exe'),
    join(parent, 'python_embeded', 'python.exe'),
    join(parent, 'python_embedded', 'python.exe'),
    join(parent, 'python', 'python.exe'),
  ].filter((value) => typeof value === 'string' && Boolean(value)).map((value) => resolve(value))
}

export async function discoverComfyInstallation({ configuredRoot, configuredPython, roots } = {}) {
  const candidates = roots
    ? [...roots].map((value) => resolve(value))
    : [...candidateRoots(configuredRoot), ...await shallowComfyRoots()]
  const seen = new Set()
  for (const root of candidates) {
    if (seen.has(root)) continue
    seen.add(root)
    if (!(await isFile(join(root, 'main.py')))) continue
    const pythonPaths = await pythonCandidates(root, configuredPython)
    const pythonPath = await (async () => {
      for (const candidate of pythonPaths) if (await isFile(candidate)) return candidate
      return null
    })()
    if (pythonPath) return { comfyRoot: root, pythonPath }
  }
  return null
}

export function safePathLabel(pathname) {
  if (!pathname || typeof pathname !== 'string') return undefined
  const resolved = resolve(pathname)
  const parsed = parse(resolved)
  const drive = /^[a-zA-Z]:\\?$/u.test(parsed.root) ? `${parsed.root[0].toUpperCase()} 盘` : '本机'
  return `${drive} · ${basename(resolved)}`
}

async function validatePaths(patch, current = {}) {
  if (patch.comfyRoot) {
    if (!(await isDirectory(patch.comfyRoot)) || !(await isFile(join(patch.comfyRoot, 'main.py')))) {
      throw settingsError('COMFY_ROOT_INVALID', '所选目录不是有效的 ComfyUI 根目录（缺少 main.py）')
    }
  }
  if (patch.pythonPath && !(await isFile(patch.pythonPath))) {
    throw settingsError('PYTHON_PATH_INVALID', '所选 Python 可执行文件不存在')
  }
  if (patch.outputDirectory) {
    if (!(await isDirectory(patch.outputDirectory))) {
      throw settingsError('OUTPUT_DIRECTORY_INVALID', '所选输出目录不存在或不是文件夹')
    }
    if (!(await writableDirectory(patch.outputDirectory))) {
      throw settingsError('OUTPUT_DIRECTORY_NOT_WRITABLE', '所选输出目录不可写，请检查权限或改选其他目录')
    }
  }
  if ((patch.comfyRoot === null) !== (patch.pythonPath === null) && (patch.comfyRoot === null || patch.pythonPath === null)) {
    throw settingsError('INCOMPLETE_COMFY_CONFIGURATION', '清除配置时必须同时清除 ComfyUI 根目录和 Python 路径')
  }
  const nextRoot = patch.comfyRoot !== undefined ? patch.comfyRoot : current.comfyRoot
  const nextPython = patch.pythonPath !== undefined ? patch.pythonPath : current.pythonPath
  if (Boolean(nextRoot) !== Boolean(nextPython)) {
    throw settingsError('INCOMPLETE_COMFY_CONFIGURATION', 'ComfyUI 根目录与 Python 路径必须成对配置')
  }
}

export async function validateRuntimeSettingsPayload(value, { current = {} } = {}) {
  const input = exactObject(value, '本机设置')
  const mode = input.mode ?? 'manual'
  if (!['manual', 'auto-discover'].includes(mode)) {
    throw settingsError('INVALID_CONFIGURATION_MODE', '配置模式必须是 manual 或 auto-discover')
  }

  let patch
  if (mode === 'auto-discover') {
    if (Object.keys(input).some((key) => key !== 'mode')) {
      throw settingsError('AUTO_DISCOVERY_FIELDS_FORBIDDEN', '自动发现模式不能同时提交手工路径')
    }
    const discovered = await discoverComfyInstallation({
      configuredRoot: current.comfyRoot,
      configuredPython: current.pythonPath,
    })
    if (!discovered) {
      throw settingsError(
        'COMFY_NOT_DISCOVERED',
        '未在已配置位置、用户目录或 C/D 盘常见目录发现完整 ComfyUI；请改用手工配置',
        409,
      )
    }
    patch = {
      comfyRoot: discovered.comfyRoot,
      pythonPath: discovered.pythonPath,
    }
  } else {
    patch = {
      comfyRoot: normalizeOptionalPath(input.comfyRoot, 'ComfyUI 根目录'),
      pythonPath: normalizeOptionalPath(input.pythonPath, 'Python 可执行文件'),
      comfyUrl: normalizeLoopbackComfyUrl(input.comfyUrl),
      comfyLaunchPolicy: normalizePolicy(input.comfyLaunchPolicy),
      comfyIdleSeconds: normalizeIdleSeconds(input.comfyIdleSeconds),
      outputDirectory: normalizeOptionalPath(input.outputDirectory, '输出目录'),
    }
    for (const key of Object.keys(patch)) if (patch[key] === undefined) delete patch[key]
    if (!Object.keys(patch).length) {
      throw settingsError('EMPTY_RUNTIME_SETTINGS', '至少提交一项本机设置')
    }
  }
  await validatePaths(patch, current)
  return patch
}

function applyPatch(current, patch) {
  const next = { ...current, schemaVersion: 1 }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key]
    else next[key] = value
  }
  return next
}

export async function persistRuntimeSettings(value, pathname = localConfigPath) {
  let current
  let recoveredInvalidConfig = false
  try {
    current = await readLocalConfigFile(pathname)
  } catch (error) {
    if (error.code !== 'INVALID_LOCAL_CONFIG') throw error
    const directory = dirname(pathname)
    await mkdir(directory, { recursive: true })
    const backupPath = join(directory, `local.invalid-${Date.now()}.json`)
    try {
      await rename(pathname, backupPath)
    } catch (backupError) {
      throw settingsError('LOCAL_CONFIG_RECOVERY_FAILED', `损坏配置无法安全备份：${backupError.message}`, 500)
    }
    current = {}
    recoveredInvalidConfig = true
  }
  const patch = await validateRuntimeSettingsPayload(value, { current })
  const next = applyPatch(current, patch)
  const directory = dirname(pathname)
  await mkdir(directory, { recursive: true })
  const temporaryPath = join(directory, `.aeonquill-local-${process.pid}-${randomUUID()}.tmp`)
  try {
    await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporaryPath, pathname)
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined)
    throw settingsError('LOCAL_CONFIG_WRITE_FAILED', `本机配置保存失败：${error.message}`, 500)
  }
  return { config: next, patch, recoveredInvalidConfig }
}

async function writableDirectory(pathname) {
  const probePath = join(pathname, `.aeonquill-write-probe-${process.pid}-${randomUUID()}.tmp`)
  try {
    await mkdir(pathname, { recursive: true })
    await writeFile(probePath, '', { encoding: 'utf8', mode: 0o600 })
    await unlink(probePath)
    return true
  } catch {
    await unlink(probePath).catch(() => undefined)
    return false
  }
}

function configSignature(config) {
  return JSON.stringify({
    comfyRoot: config.comfyRoot ?? null,
    pythonPath: config.pythonPath ?? null,
    comfyUrl: String(config.comfyUrl || DEFAULT_COMFY_URL).replace(/\/$/u, ''),
    comfyLaunchPolicy: config.comfyLaunchPolicy ?? config.launchPolicy ?? 'idle',
    comfyIdleSeconds: Number(config.comfyIdleSeconds ?? Math.round((config.idleTimeoutMs || 300_000) / 1_000)),
  })
}

function runtimeScope() {
  const projectRelative = relative(projectRoot, runtimeDirectory)
  if (projectRelative && !projectRelative.startsWith('..') && !isAbsolute(projectRelative)) return 'development'
  if (process.env.AEONQUILL_RUNTIME_DIR) return 'user-data'
  if (process.env.MIAOHUI_RUNTIME_DIR) return 'legacy-user-data'
  return 'custom'
}

export async function buildRuntimeDiagnostics({
  activeConfig,
  persistedConfig,
  runtime,
  imageManifest,
  semanticManifest,
  configError,
  checkedAt = Date.now(),
} = {}) {
  const stored = persistedConfig ?? await readLocalConfigFile()
  const trustedStored = configError ? {} : stored
  const effectiveRoot = trustedStored.comfyRoot || activeConfig?.comfyRoot
  const effectivePython = trustedStored.pythonPath || activeConfig?.pythonPath
  const customOutputDirectory = trustedStored.outputDirectory
  const effectiveOutputDirectory = customOutputDirectory || activeConfig?.outputDirectory || defaultOutputDirectory
  const rootConfigured = typeof effectiveRoot === 'string' && Boolean(effectiveRoot)
  const pythonConfigured = typeof effectivePython === 'string' && Boolean(effectivePython)
  const rootValid = rootConfigured && await isFile(join(effectiveRoot, 'main.py'))
  const pythonValid = pythonConfigured && await isFile(effectivePython)
  const outputDirectoryConfigured = typeof customOutputDirectory === 'string' && Boolean(customOutputDirectory)
  const outputDirectoryEffective = typeof effectiveOutputDirectory === 'string' && Boolean(effectiveOutputDirectory)
  const outputDirectorySource = outputDirectoryConfigured ? 'custom' : 'application'
  const outputDirectoryValid = outputDirectoryEffective && await isDirectory(effectiveOutputDirectory)
  const outputDirectoryWritable = outputDirectoryValid && await writableDirectory(effectiveOutputDirectory)
  const imageOperations = imageManifest?.operations ?? []
  const availableImageOperations = imageOperations.filter((operation) => operation.available)
  const semanticWorkflows = semanticManifest?.workflows ?? []
  const installedSemanticWorkflows = semanticWorkflows.filter((workflow) => workflow.installed)
  const issues = []

  if (configError) {
    issues.push({
      code: 'LOCAL_CONFIG_INVALID',
      severity: 'error',
      message: '本机配置文件无效；应用已使用安全默认值启动。',
      action: '在设置中保存有效配置；原文件会先备份再修复',
    })
  }

  const runtimeWritable = await writableDirectory(runtimeDirectory)
  const dataWritable = await writableDirectory(dataDirectory)
  const cacheWritable = await writableDirectory(cacheDirectory)
  const logsWritable = await writableDirectory(logDirectory)
  const configWritable = await writableDirectory(dirname(localConfigPath))
  if (!runtimeWritable || !dataWritable || !cacheWritable || !logsWritable || !configWritable) {
    issues.push({
      code: 'USER_DATA_NOT_WRITABLE',
      severity: 'error',
      message: '当前用户数据或配置目录不可写；项目和任务可能无法保存。',
      action: '检查当前用户目录权限后重新检测',
    })
  }
  if (usingLegacyDataDirectory) {
    issues.push({
      code: 'LEGACY_DATA_LAYOUT',
      severity: 'info',
      message: '检测到旧版用户数据；本次继续使用原位置以避免项目失联。',
      action: '应用不会自动搬移或删除这些数据；后续版本将提供显式迁移工具',
    })
  }
  if (!rootValid || !pythonValid) {
    issues.push({
      code: 'COMFY_CONFIGURATION_REQUIRED',
      severity: 'warning',
      message: '尚未配置可由 AEONQUILL 按需启动的 ComfyUI 与 Python。',
      action: '自动发现或手工填写本机路径',
    })
  }
  if (outputDirectoryEffective && (!outputDirectoryValid || !outputDirectoryWritable)) {
    issues.push({
      code: 'OUTPUT_DIRECTORY_UNAVAILABLE',
      severity: 'warning',
      message: '已配置的输出目录当前不可用；内部项目资产仍会正常保存。',
      action: '在设置中重新选择一个存在且可写的本机目录',
    })
  }
  if (!availableImageOperations.length) {
    issues.push({
      code: 'IMAGE_PROCESSORS_UNAVAILABLE',
      severity: 'warning',
      message: '未发现可执行的本机图像处理器；浏览器草稿能力仍可使用。',
      action: '安装或配置受支持的图像执行器',
    })
  }
  const missingH3 = (runtime?.missingNodes?.length ?? 0) + (runtime?.missingModels?.length ?? 0)
  if (runtime?.connected && missingH3) {
    issues.push({
      code: 'H3_DEPENDENCIES_INCOMPLETE',
      severity: 'warning',
      message: `ComfyUI 已连接，但 H3 仍缺少 ${missingH3} 项节点或模型依赖。`,
      action: '按智能视频阻塞清单补齐依赖后复检',
    })
  }

  const persistedNormalized = {
    ...activeConfig,
    ...trustedStored,
    launchPolicy: trustedStored.comfyLaunchPolicy ?? activeConfig?.launchPolicy,
    idleTimeoutMs: trustedStored.comfyIdleSeconds
      ? Number(trustedStored.comfyIdleSeconds) * 1_000
      : activeConfig?.idleTimeoutMs,
  }
  const restartRequired = Boolean(activeConfig) && configSignature(activeConfig) !== configSignature(persistedNormalized)
  const readyForManagedStart = rootValid && pythonValid
  const comfyStatus = runtime?.connected
    ? runtime.ready ? 'ready' : 'incomplete'
    : readyForManagedStart ? 'sleeping' : 'needs-configuration'

  return {
    schemaVersion: 1,
    checkedAt,
    product: {
      name: '光阴砚 AEONQUILL',
      service: 'aeonquill-local-runtime',
      platform: process.platform,
      architecture: process.arch,
      node: process.versions.node,
    },
    storage: {
      scope: runtimeScope(),
      runtimeWritable,
      dataWritable,
      cacheWritable,
      logsWritable,
      configWritable,
      outputDirectoryWritable: outputDirectoryEffective ? outputDirectoryWritable : null,
      runtimeLabel: runtimeScope() === 'development' ? '开发工作区运行时' : '当前用户应用数据',
      configLabel: safePathLabel(localConfigPath),
      projectsManaged: true,
      uninstallPreservesUserData: true,
      legacyDataLayout: usingLegacyDataDirectory,
    },
    configuration: {
      fileValid: !configError,
      rootConfigured,
      pythonConfigured,
      rootValid,
      pythonValid,
      rootLabel: safePathLabel(effectiveRoot),
      pythonLabel: safePathLabel(effectivePython),
      outputDirectoryConfigured,
      outputDirectorySource,
      outputDirectoryLabel: safePathLabel(effectiveOutputDirectory),
      offlineRuntimePackageId: activeConfig?.offlineRuntimePackageId ?? null,
      comfyUrl: String(trustedStored.comfyUrl || activeConfig?.comfyUrl || DEFAULT_COMFY_URL),
      launchPolicy: trustedStored.comfyLaunchPolicy || activeConfig?.launchPolicy || 'idle',
      idleSeconds: Number(trustedStored.comfyIdleSeconds || Math.round((activeConfig?.idleTimeoutMs || 300_000) / 1_000)),
      restartRequired,
      legacyEnvironment: Boolean(
        (!process.env.AEONQUILL_RUNTIME_DIR && process.env.MIAOHUI_RUNTIME_DIR)
        || (!process.env.AEONQUILL_CONFIG && process.env.MIAOHUI_CONFIG),
      ),
    },
    capabilities: {
      bridge: { status: 'ready', label: '本机桥接已连接' },
      image: {
        status: availableImageOperations.length ? 'ready' : 'unavailable',
        available: availableImageOperations.length,
        total: imageOperations.length,
        operations: imageOperations.map(({ id, label, provider, available, unavailableReason }) => ({
          id,
          label,
          provider,
          available,
          unavailableReason,
        })),
      },
      comfyui: {
        status: comfyStatus,
        configured: readyForManagedStart,
        connected: Boolean(runtime?.connected),
        ready: Boolean(runtime?.ready),
        lifecycle: runtime?.lifecycle?.state || 'stopped',
        device: runtime?.device,
        vramTotal: runtime?.vramTotal || 0,
        missingNodes: runtime?.missingNodes?.length ?? 0,
        missingModels: runtime?.missingModels?.length ?? 0,
      },
      semantic: {
        installed: installedSemanticWorkflows.length,
        total: semanticWorkflows.length,
        ready: semanticWorkflows.filter((workflow) => workflow.available).length,
      },
    },
    logs: {
      managed: true,
      label: '当前用户运行日志',
      comfyLogAvailable: await isFile(join(logDirectory, 'comfyui.log')),
    },
    issues,
  }
}
