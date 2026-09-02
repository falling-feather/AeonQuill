import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseDocument } from 'yaml'

export const RUNTIME_REGISTRY_VERSION = 'aeonquill-runtime-registry-v1'
export const MAX_EXTRA_MODEL_PATH_BYTES = 256 * 1024

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

async function pathStats(pathname) {
  try {
    return await stat(pathname)
  } catch {
    return null
  }
}

function stableId(...parts) {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16)
}

function normalizedPathKey(pathname) {
  const resolved = resolve(pathname)
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved
}

function isPathInside(parent, child) {
  const relation = relative(resolve(parent), resolve(child))
  return !relation || (!relation.startsWith(`..${sep}`) && relation !== '..' && !isAbsolute(relation))
}

function expandEnvironmentVariables(value, environment) {
  return value
    .replace(/%([^%]+)%/gu, (match, name) => environment[name] ?? environment[name.toUpperCase()] ?? match)
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/gu, (match, braced, plain) => {
      const name = braced || plain
      return environment[name] ?? match
    })
}

function expandUserDirectory(value, homeDirectory) {
  if (value === '~') return homeDirectory
  if (/^~[\\/]/u.test(value)) return join(homeDirectory, value.slice(2))
  return value
}

function resolveConfiguredPath(value, { basePath, configDirectory, environment, homeDirectory }) {
  const expanded = expandUserDirectory(expandEnvironmentVariables(value.trim(), environment), homeDirectory)
  if (basePath) return resolve(basePath, expanded)
  return isAbsolute(expanded) ? resolve(expanded) : resolve(configDirectory, expanded)
}

function parseYamlDocument(source, configPath) {
  const document = parseDocument(source, {
    merge: false,
    prettyErrors: false,
    schema: 'core',
    uniqueKeys: true,
  })
  if (document.errors.length) {
    const message = document.errors.map(({ message }) => message).join('；')
    throw Object.assign(new Error(`无法解析 extra model paths：${message}`), {
      code: 'RUNTIME_REGISTRY_YAML_INVALID',
      configPath,
    })
  }
  return document.toJS({ maxAliasCount: 0 })
}

export function parseExtraModelPathsYaml(source, {
  configPath = resolve('extra_model_paths.yaml'),
  environment = process.env,
  homeDirectory = homedir(),
} = {}) {
  if (typeof source !== 'string') throw new TypeError('extra model paths source must be text')
  if (Buffer.byteLength(source, 'utf8') > MAX_EXTRA_MODEL_PATH_BYTES) {
    throw Object.assign(new Error('extra model paths 配置超过 256 KiB 上限'), {
      code: 'RUNTIME_REGISTRY_YAML_TOO_LARGE',
      configPath,
    })
  }
  const parsed = parseYamlDocument(source, configPath)
  if (parsed == null) return { entries: [], warnings: [] }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw Object.assign(new Error('extra model paths 顶层必须是映射对象'), {
      code: 'RUNTIME_REGISTRY_YAML_SHAPE',
      configPath,
    })
  }
  const configDirectory = dirname(resolve(configPath))
  const entries = []
  const warnings = []
  const groups = Object.entries(parsed)
  if (groups.length > 64) {
    throw Object.assign(new Error('extra model paths 分组超过 64 个上限'), {
      code: 'RUNTIME_REGISTRY_YAML_TOO_MANY_GROUPS',
      configPath,
    })
  }
  for (const [group, rawConfiguration] of groups) {
    if (!SAFE_KEY.test(group) || FORBIDDEN_KEYS.has(group)) {
      warnings.push({ code: 'RUNTIME_REGISTRY_GROUP_IGNORED', group, message: `已忽略不安全分组：${group}` })
      continue
    }
    if (rawConfiguration == null) continue
    if (typeof rawConfiguration !== 'object' || Array.isArray(rawConfiguration)) {
      warnings.push({ code: 'RUNTIME_REGISTRY_GROUP_INVALID', group, message: `分组 ${group} 不是映射对象` })
      continue
    }
    const rawBasePath = rawConfiguration.base_path
    if (rawBasePath != null && typeof rawBasePath !== 'string') {
      warnings.push({ code: 'RUNTIME_REGISTRY_BASE_PATH_INVALID', group, message: `分组 ${group} 的 base_path 不是字符串` })
      continue
    }
    const expandedBasePath = rawBasePath == null
      ? null
      : expandUserDirectory(expandEnvironmentVariables(rawBasePath.trim(), environment), homeDirectory)
    const basePath = expandedBasePath == null
      ? null
      : isAbsolute(expandedBasePath)
        ? resolve(expandedBasePath)
        : resolve(configDirectory, expandedBasePath)
    const isDefault = rawConfiguration.is_default === true
    for (const [category, rawPaths] of Object.entries(rawConfiguration)) {
      if (category === 'base_path' || category === 'is_default') continue
      if (!SAFE_KEY.test(category) || FORBIDDEN_KEYS.has(category)) {
        warnings.push({ code: 'RUNTIME_REGISTRY_CATEGORY_IGNORED', group, category, message: `已忽略不安全目录类型：${category}` })
        continue
      }
      if (typeof rawPaths !== 'string') {
        warnings.push({ code: 'RUNTIME_REGISTRY_PATHS_INVALID', group, category, message: `${group}.${category} 必须是字符串或多行字符串` })
        continue
      }
      for (const rawPath of rawPaths.split(/\r?\n/gu).map((value) => value.trim()).filter(Boolean)) {
        if (entries.length >= 256) {
          throw Object.assign(new Error('extra model paths 路径超过 256 个上限'), {
            code: 'RUNTIME_REGISTRY_YAML_TOO_MANY_PATHS',
            configPath,
          })
        }
        entries.push({
          group,
          category,
          path: resolveConfiguredPath(rawPath, { basePath, configDirectory, environment, homeDirectory }),
          isDefault,
          portable: !isAbsolute(rawPath) && (rawBasePath == null || !isAbsolute(expandedBasePath)),
          rawPath,
          rawBasePath: rawBasePath ?? null,
        })
      }
    }
  }
  return { entries, warnings }
}

export function extraModelConfigPaths({ comfyRoot, comfyArgs = [], environment = process.env, homeDirectory = homedir() } = {}) {
  if (!comfyRoot) return []
  const paths = [join(resolve(comfyRoot), 'extra_model_paths.yaml'), join(resolve(comfyRoot), 'extra_model_paths.yml')]
  const args = Array.isArray(comfyArgs) ? comfyArgs.map(String) : []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument.startsWith('--extra-model-paths-config=')) {
      paths.push(argument.slice('--extra-model-paths-config='.length))
      continue
    }
    if (argument !== '--extra-model-paths-config') continue
    while (index + 1 < args.length && !args[index + 1].startsWith('--')) paths.push(args[index += 1])
  }
  const seen = new Set()
  return paths.map((pathname) => {
    const expanded = expandUserDirectory(expandEnvironmentVariables(pathname, environment), homeDirectory)
    return isAbsolute(expanded) ? resolve(expanded) : resolve(comfyRoot, expanded)
  }).filter((pathname) => {
    const key = normalizedPathKey(pathname)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function loadExtraConfig(configPath, required) {
  const file = await pathStats(configPath)
  if (!file) return required ? { path: configPath, status: 'missing', entries: [], warnings: [], error: '配置文件不存在' } : null
  if (!file.isFile()) return { path: configPath, status: 'invalid', entries: [], warnings: [], error: '配置路径不是文件' }
  if (file.size > MAX_EXTRA_MODEL_PATH_BYTES) return { path: configPath, status: 'invalid', entries: [], warnings: [], error: '配置文件超过 256 KiB 上限' }
  try {
    const source = await readFile(configPath, 'utf8')
    const result = parseExtraModelPathsYaml(source, { configPath })
    return { path: configPath, status: 'loaded', sha256: createHash('sha256').update(source).digest('hex'), ...result, error: null }
  } catch (error) {
    return { path: configPath, status: 'invalid', entries: [], warnings: [], error: error.message, code: error.code || 'RUNTIME_REGISTRY_YAML_INVALID' }
  }
}

function publicRoot(root) {
  return {
    id: root.id,
    category: root.category,
    path: root.path,
    label: root.source === 'configured-runtime'
      ? `当前运行时 · ${root.category}`
      : `共享目录 · ${root.category} · ${root.id.slice(-6)}`,
    source: root.source,
    exists: root.exists,
    shared: root.shared,
    portable: root.portable,
    isDefault: root.isDefault,
    references: root.references,
  }
}

export async function discoverRuntimeRegistry({
  comfyRoot,
  pythonPath,
  runtimePackageId,
  comfyArgs = [],
  modelCategories = [],
} = {}) {
  const resolvedComfyRoot = typeof comfyRoot === 'string' && comfyRoot.trim() ? resolve(comfyRoot) : null
  if (!resolvedComfyRoot) {
    return {
      version: RUNTIME_REGISTRY_VERSION,
      registryHash: null,
      configured: false,
      comfyRoot: null,
      python: null,
      runtimePackageId: runtimePackageId || null,
      configFiles: [],
      modelRoots: [],
      nodeRoots: [],
      sharedRoots: [],
      warnings: [],
    }
  }
  const allConfigPaths = extraModelConfigPaths({ comfyRoot: resolvedComfyRoot, comfyArgs })
  const explicitConfigKeys = new Set()
  const args = Array.isArray(comfyArgs) ? comfyArgs.map(String) : []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument.startsWith('--extra-model-paths-config=')) {
      const pathname = argument.slice('--extra-model-paths-config='.length)
      explicitConfigKeys.add(normalizedPathKey(isAbsolute(pathname) ? pathname : resolve(resolvedComfyRoot, pathname)))
    } else if (argument === '--extra-model-paths-config') {
      while (index + 1 < args.length && !args[index + 1].startsWith('--')) {
        const pathname = args[index += 1]
        explicitConfigKeys.add(normalizedPathKey(isAbsolute(pathname) ? pathname : resolve(resolvedComfyRoot, pathname)))
      }
    }
  }
  const loadedConfigs = (await Promise.all(allConfigPaths.map((configPath) => loadExtraConfig(
    configPath,
    explicitConfigKeys.has(normalizedPathKey(configPath)),
  )))).filter(Boolean)
  const categories = new Set(modelCategories.filter((value) => typeof value === 'string' && SAFE_KEY.test(value)))
  for (const config of loadedConfigs) for (const entry of config.entries) categories.add(entry.category)
  const roots = []
  for (const category of categories) {
    const pathname = category === 'custom_nodes'
      ? join(resolvedComfyRoot, 'custom_nodes')
      : join(resolvedComfyRoot, 'models', category)
    roots.push({
      category,
      path: resolve(pathname),
      source: 'configured-runtime',
      portable: true,
      isDefault: true,
      references: [{ type: 'comfy-root', path: resolvedComfyRoot }],
    })
  }
  for (const config of loadedConfigs) {
    if (config.status !== 'loaded') continue
    for (const entry of config.entries) {
      roots.push({
        category: entry.category,
        path: entry.path,
        source: 'extra-model-path',
        portable: entry.portable,
        isDefault: entry.isDefault,
        references: [{ type: 'extra-model-path', configPath: config.path, group: entry.group, category: entry.category }],
      })
    }
  }
  const deduped = new Map()
  for (const root of roots) {
    const key = `${root.category}\u0000${normalizedPathKey(root.path)}`
    const existing = deduped.get(key)
    if (existing) {
      existing.references.push(...root.references)
      existing.portable &&= root.portable
      existing.isDefault ||= root.isDefault
      if (existing.source !== 'configured-runtime') existing.source = root.source
      continue
    }
    deduped.set(key, { ...root })
  }
  const inspectedRoots = await Promise.all([...deduped.values()].map(async (root) => {
    const entry = await pathStats(root.path)
    return {
      ...root,
      id: `root-${stableId(root.category, normalizedPathKey(root.path))}`,
      exists: Boolean(entry?.isDirectory()),
      shared: !isPathInside(resolvedComfyRoot, root.path),
    }
  }))
  const publicRoots = inspectedRoots.map(publicRoot)
  const warnings = loadedConfigs.flatMap((config) => [
    ...config.warnings.map((warning) => ({ ...warning, configPath: config.path })),
    ...(config.status === 'invalid' || config.status === 'missing'
      ? [{ code: config.code || 'RUNTIME_REGISTRY_CONFIG_UNAVAILABLE', configPath: config.path, message: config.error }]
      : []),
  ])
  for (const root of publicRoots) {
    if (root.source === 'extra-model-path' && !root.exists) warnings.push({ code: 'RUNTIME_REGISTRY_ROOT_MISSING', rootId: root.id, path: root.path, message: '额外模型目录不存在或不可访问' })
    if (root.shared && !root.portable) warnings.push({ code: 'RUNTIME_REGISTRY_ABSOLUTE_SHARED_ROOT', rootId: root.id, path: root.path, message: '共享目录使用绝对路径；移动或清理旧运行时前必须先修复引用' })
  }
  const modelRoots = publicRoots.filter(({ category }) => category !== 'custom_nodes')
  const nodeRoots = publicRoots.filter(({ category }) => category === 'custom_nodes')
  const resolvedPythonPath = typeof pythonPath === 'string' && pythonPath.trim() ? resolve(pythonPath) : null
  const pythonEntry = resolvedPythonPath ? await pathStats(resolvedPythonPath) : null
  const configFiles = loadedConfigs.map(({ entries: _entries, warnings: _warnings, ...config }) => config)
  const registryHash = createHash('sha256').update(JSON.stringify({
    comfyRoot: resolvedComfyRoot,
    pythonPath: resolvedPythonPath,
    runtimePackageId: runtimePackageId || null,
    configs: configFiles.map(({ path, status, sha256 }) => ({ path, status, sha256: sha256 || null })),
    roots: publicRoots.map(({ category, path, source, portable, isDefault }) => ({ category, path, source, portable, isDefault })),
  })).digest('hex')
  return {
    version: RUNTIME_REGISTRY_VERSION,
    registryHash,
    configured: true,
    comfyRoot: resolvedComfyRoot,
    python: resolvedPythonPath ? { path: resolvedPythonPath, exists: Boolean(pythonEntry?.isFile()) } : null,
    runtimePackageId: runtimePackageId || null,
    configFiles,
    modelRoots,
    nodeRoots,
    sharedRoots: publicRoots.filter(({ shared }) => shared),
    warnings,
  }
}

export function registeredArtifactCandidates(artifact, registry) {
  if (!artifact?.relativePath || !registry?.configured) return []
  const segments = artifact.relativePath.replace(/\\/gu, '/').split('/').filter(Boolean)
  let roots = []
  let relativeSegments = []
  if (segments[0] === 'models' && segments.length >= 3) {
    roots = registry.modelRoots.filter(({ category }) => category === segments[1])
    relativeSegments = segments.slice(2)
  } else if (segments[0] === 'custom_nodes' && segments.length >= 2) {
    roots = registry.nodeRoots
    relativeSegments = segments.slice(1)
  } else {
    roots = [{
      id: `root-${stableId('runtime', normalizedPathKey(registry.comfyRoot))}`,
      category: 'runtime',
      path: registry.comfyRoot,
      source: 'configured-runtime',
      exists: true,
      shared: false,
      portable: true,
      references: [{ type: 'comfy-root', path: registry.comfyRoot }],
    }]
    relativeSegments = segments
  }
  return roots.map((root) => ({
    root,
    targetPath: resolve(root.path, ...relativeSegments),
  }))
}
