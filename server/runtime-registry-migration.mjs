import { createHash, randomUUID } from 'node:crypto'
import { readFile, mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parseDocument, stringify } from 'yaml'
import { parseExtraModelPathsYaml } from './runtime-registry.mjs'

export const RUNTIME_REGISTRY_MIGRATION_VERSION = 'aeonquill-runtime-registry-migration-v1'
const STATE_VERSION = 1
const HASH_PATTERN = /^[a-f0-9]{64}$/u

function migrationError(message, code, status = 409, details) {
  return Object.assign(new Error(message), { code, status, ...(details ? { details } : {}) })
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function portablePath(pathname) {
  return pathname.replace(/\\/gu, '/') || '.'
}

async function fileStats(pathname) {
  try {
    return await stat(pathname)
  } catch {
    return null
  }
}

async function writeAtomic(pathname, source) {
  const temporaryPath = join(dirname(pathname), `.aeonquill-registry-${process.pid}-${randomUUID()}.tmp`)
  await writeFile(temporaryPath, source, { encoding: 'utf8', mode: 0o600 })
  try {
    await rename(temporaryPath, pathname)
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
}

function resolvedEntryFacts(parsed) {
  return parsed.entries.map(({ group, category, path }) => ({
    group,
    category,
    path: resolve(path),
  })).sort((left, right) => `${left.group}\0${left.category}\0${left.path}`.localeCompare(
    `${right.group}\0${right.category}\0${right.path}`,
    'en',
  ))
}

function sameResolvedFacts(left, right) {
  return JSON.stringify(resolvedEntryFacts(left)) === JSON.stringify(resolvedEntryFacts(right))
}

export function planPortableConfigMigration(source, { configPath } = {}) {
  const resolvedConfigPath = resolve(configPath || 'extra_model_paths.yaml')
  const beforeHash = sha256(source)
  const document = parseDocument(source, {
    merge: false,
    prettyErrors: false,
    schema: 'core',
    uniqueKeys: true,
  })
  if (document.errors.length) {
    return {
      status: 'blocked',
      beforeHash,
      afterHash: null,
      source,
      migratedSource: null,
      changes: [],
      reason: '配置文件无法安全解析',
    }
  }
  const value = document.toJS({ maxAliasCount: 0 })
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      status: 'blocked',
      beforeHash,
      afterHash: null,
      source,
      migratedSource: null,
      changes: [],
      reason: '配置顶层不是映射对象',
    }
  }
  const next = structuredClone(value)
  const changes = []
  for (const [group, configuration] of Object.entries(next)) {
    if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) continue
    const basePath = configuration.base_path
    if (typeof basePath !== 'string' || !isAbsolute(basePath)) continue
    const nextBasePath = relative(dirname(resolvedConfigPath), resolve(basePath))
    if (!nextBasePath || isAbsolute(nextBasePath)) continue
    configuration.base_path = portablePath(nextBasePath)
    changes.push({ group, from: 'absolute', to: 'relative', relativeDepth: nextBasePath.split(/[\\/]+/u).filter((part) => part === '..').length })
  }
  if (!changes.length) {
    return {
      status: 'not-needed',
      beforeHash,
      afterHash: beforeHash,
      source,
      migratedSource: source,
      changes,
      reason: '没有可安全改写的绝对 base_path',
    }
  }
  const migratedSource = stringify(next, { lineWidth: 0 })
  const before = parseExtraModelPathsYaml(source, { configPath: resolvedConfigPath })
  const after = parseExtraModelPathsYaml(migratedSource, { configPath: resolvedConfigPath })
  if (!sameResolvedFacts(before, after)) {
    return {
      status: 'blocked',
      beforeHash,
      afterHash: sha256(migratedSource),
      source,
      migratedSource,
      changes,
      reason: '相对路径改写后的模型根与原配置不一致',
    }
  }
  const afterHash = sha256(migratedSource)
  return {
    status: 'ready',
    id: `plan-${sha256(`${resolvedConfigPath}\0${beforeHash}\0${afterHash}`).slice(0, 24)}`,
    beforeHash,
    afterHash,
    source,
    migratedSource,
    changes,
    reason: null,
  }
}

function publicRecord(record) {
  if (!record) return null
  return {
    id: record.id,
    planId: record.planId,
    status: record.status,
    beforeHash: record.beforeHash,
    afterHash: record.afterHash,
    appliedAt: record.appliedAt,
    rolledBackAt: record.rolledBackAt || null,
    changeCount: record.changeCount,
    rollbackAvailable: record.status === 'applied',
  }
}

function publicPlan(plan) {
  return {
    id: plan.id || null,
    status: plan.status,
    beforeHash: plan.beforeHash,
    afterHash: plan.afterHash,
    configLabel: 'ComfyUI / extra_model_paths.yaml',
    changeCount: plan.changes.length,
    groups: plan.changes.map(({ group, relativeDepth }) => ({ group, relativeDepth })),
    reason: plan.reason,
  }
}

function initialState() {
  return { schemaVersion: STATE_VERSION, records: [] }
}

export class RuntimeRegistryMigrationService {
  constructor({ rootDirectory, getRegistry, assertMutationAllowed } = {}) {
    if (!rootDirectory) throw new TypeError('Runtime registry migration rootDirectory is required')
    if (typeof getRegistry !== 'function') throw new TypeError('Runtime registry migration getRegistry is required')
    this.rootDirectory = resolve(rootDirectory)
    this.statePath = join(this.rootDirectory, 'state.json')
    this.getRegistry = getRegistry
    this.assertMutationAllowed = assertMutationAllowed || (() => undefined)
    this.state = initialState()
  }

  async open() {
    await mkdir(this.rootDirectory, { recursive: true })
    try {
      const parsed = JSON.parse(await readFile(this.statePath, 'utf8'))
      if (parsed?.schemaVersion === STATE_VERSION && Array.isArray(parsed.records)) this.state = parsed
    } catch (error) {
      if (error.code !== 'ENOENT') throw migrationError('运行时迁移记录损坏，已拒绝覆盖', 'RUNTIME_MIGRATION_STATE_INVALID', 500)
    }
  }

  async persist() {
    await writeAtomic(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`)
  }

  async _plans() {
    const registry = await this.getRegistry()
    const plans = []
    for (const config of registry.configFiles.filter(({ status }) => status === 'loaded')) {
      const source = await readFile(config.path, 'utf8')
      plans.push({
        configPath: config.path,
        ...planPortableConfigMigration(source, { configPath: config.path }),
      })
    }
    return { registry, plans }
  }

  async preview() {
    const { registry, plans } = await this._plans()
    const latest = this.state.records.at(-1) || null
    const ready = plans.filter(({ status }) => status === 'ready')
    const blocked = plans.filter(({ status }) => status === 'blocked')
    const sharedRoots = registry.sharedRoots.map((root) => ({
      rootId: root.id,
      rootLabel: root.label,
      referenceCount: root.references.length,
      blocked: root.references.length > 0,
    }))
    return {
      version: RUNTIME_REGISTRY_MIGRATION_VERSION,
      status: blocked.length ? 'blocked' : ready.length ? 'ready' : 'not-needed',
      plans: plans.map(publicPlan),
      readyCount: ready.length,
      changeCount: ready.reduce((total, plan) => total + plan.changes.length, 0),
      movesModelFiles: false,
      removalGate: {
        sharedRoots,
        blockedRoots: sharedRoots.filter(({ blocked: isBlocked }) => isBlocked).length,
      },
      latest: publicRecord(latest),
    }
  }

  async apply({ planId, beforeHash } = {}) {
    await this.assertMutationAllowed()
    if (typeof planId !== 'string' || !planId || !HASH_PATTERN.test(String(beforeHash || ''))) {
      throw migrationError('迁移确认参数无效', 'RUNTIME_MIGRATION_REQUEST_INVALID', 400)
    }
    const { plans } = await this._plans()
    const plan = plans.find(({ id }) => id === planId)
    if (!plan || plan.status !== 'ready' || plan.beforeHash !== beforeHash) {
      throw migrationError('迁移预览已经过期，请重新检测后再确认', 'RUNTIME_MIGRATION_PLAN_STALE')
    }
    const currentSource = await readFile(plan.configPath, 'utf8')
    if (sha256(currentSource) !== plan.beforeHash) {
      throw migrationError('配置文件在确认后发生变化，已拒绝覆盖', 'RUNTIME_MIGRATION_CONFIG_CHANGED')
    }
    const recordId = `migration-${Date.now()}-${randomUUID().slice(0, 8)}`
    const backupPath = join(this.rootDirectory, `${recordId}.backup.yaml`)
    await writeAtomic(backupPath, currentSource)
    try {
      await writeAtomic(plan.configPath, plan.migratedSource)
      const installedSource = await readFile(plan.configPath, 'utf8')
      if (sha256(installedSource) !== plan.afterHash) {
        throw migrationError('迁移写入后的哈希不一致', 'RUNTIME_MIGRATION_POST_WRITE_MISMATCH', 500)
      }
      const verification = planPortableConfigMigration(installedSource, { configPath: plan.configPath })
      if (verification.status !== 'not-needed') {
        throw migrationError('迁移后仍存在可改写的绝对共享根', 'RUNTIME_MIGRATION_POST_WRITE_INVALID', 500)
      }
    } catch (error) {
      await writeAtomic(plan.configPath, currentSource).catch(() => undefined)
      throw error
    }
    const record = {
      id: recordId,
      planId: plan.id,
      status: 'applied',
      configPath: plan.configPath,
      backupPath,
      beforeHash: plan.beforeHash,
      afterHash: plan.afterHash,
      changeCount: plan.changes.length,
      appliedAt: Date.now(),
      rolledBackAt: null,
    }
    this.state.records.push(record)
    this.state.records = this.state.records.slice(-20)
    await this.persist()
    return { record: publicRecord(record), preview: await this.preview() }
  }

  async rollback({ recordId } = {}) {
    await this.assertMutationAllowed()
    if (typeof recordId !== 'string' || !recordId) {
      throw migrationError('回滚记录无效', 'RUNTIME_MIGRATION_ROLLBACK_INVALID', 400)
    }
    const record = this.state.records.find(({ id }) => id === recordId)
    if (!record || record.status !== 'applied') {
      throw migrationError('没有可用的迁移回滚记录', 'RUNTIME_MIGRATION_ROLLBACK_UNAVAILABLE')
    }
    const [currentSource, backupSource] = await Promise.all([
      readFile(record.configPath, 'utf8'),
      readFile(record.backupPath, 'utf8'),
    ])
    if (sha256(currentSource) !== record.afterHash || sha256(backupSource) !== record.beforeHash) {
      throw migrationError('当前配置或回滚备份已变化，已拒绝覆盖', 'RUNTIME_MIGRATION_ROLLBACK_STALE')
    }
    await writeAtomic(record.configPath, backupSource)
    record.status = 'rolled-back'
    record.rolledBackAt = Date.now()
    await this.persist()
    return { record: publicRecord(record), preview: await this.preview() }
  }

  async checkRemoval({ rootId } = {}) {
    if (typeof rootId !== 'string' || !rootId) {
      throw migrationError('共享根标识无效', 'RUNTIME_REMOVAL_CHECK_INVALID', 400)
    }
    const registry = await this.getRegistry()
    const root = [...registry.modelRoots, ...registry.nodeRoots].find(({ id }) => id === rootId)
    if (!root) throw migrationError('共享根已变化，请重新检测', 'RUNTIME_REMOVAL_ROOT_UNKNOWN', 404)
    return {
      rootId,
      rootLabel: root.label,
      blocked: root.references.length > 0,
      referenceCount: root.references.length,
      reasons: root.references.map(({ type }) => type),
    }
  }
}
