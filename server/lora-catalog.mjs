import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, lstat, realpath, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { assertLoraBindingCompatible, LORA_BASE_FAMILIES, normalizeLoraBinding } from '../src/lib/loraCompatibility.mjs'
import { inspectLoraFile, LORA_MAX_FILE_BYTES } from './lora-inspection.mjs'

export const LORA_CATALOG_SCHEMA_VERSION = 1
export const LORA_CATALOG_MAX_SCAN_DEPTH = 3
export const LORA_CATALOG_MAX_SCAN_ENTRIES = 1_000
export const LORA_CATALOG_MAX_MODELS = 200
export const LORA_CATALOG_MAX_BINDINGS = 200
export const LORA_CATALOG_MAX_STORE_BYTES = 512 * 1024

const FAMILY_SET = new Set(LORA_BASE_FAMILIES)
const MODEL_ID = /^lora-[a-f0-9]{32}$/u
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u
const RELATIVE_NAME_MAX_LENGTH = 512
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/u
const UNC_PATH = /^(?:\\\\|\/\/)/u
const TRAVERSAL_SEGMENT = /(?:^|[\\/])\.\.(?:[\\/]|$)/u

function catalogError(code, message, status = 400, details) {
  return Object.assign(new Error(message), { code, status, ...(details ? { details } : {}) })
}

function clone(value) {
  return structuredClone(value)
}

function assertAbsoluteDirectoryPath(value, label) {
  if (typeof value !== 'string' || !value || !isAbsolute(value) || value.includes('\0')) {
    throw catalogError('LORA_CATALOG_ROOT_INVALID', label + '必须是绝对路径')
  }
  return resolve(value)
}

function assertFamily(value, label = 'family') {
  if (typeof value !== 'string' || !FAMILY_SET.has(value)) {
    throw catalogError('LORA_EXPECTED_FAMILY_INVALID', label + '不在受支持集合中')
  }
  return value
}

function isInside(root, target) {
  const child = relative(root, target)
  return Boolean(child) && child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child)
}

function safeRelativeName(value, label = 'modelName') {
  if (typeof value !== 'string' || !value.length || value.length > RELATIVE_NAME_MAX_LENGTH
    || value.includes('\0') || WINDOWS_ABSOLUTE.test(value) || UNC_PATH.test(value)
    || value.startsWith('/') || TRAVERSAL_SEGMENT.test(value)
    || /\p{Cc}/u.test(value)) {
    throw catalogError('LORA_CATALOG_MODEL_NAME_INVALID', label + '必须是安全相对路径')
  }
  const normalized = value.replace(/\\/gu, '/')
  if (normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw catalogError('LORA_CATALOG_MODEL_NAME_INVALID', label + '必须是安全相对路径')
  }
  return normalized
}

function canonicalRelativeName(value) {
  const normalized = safeRelativeName(value)
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}

function modelIdFor(rootIndex, relativeName) {
  const canonical = String(rootIndex) + '\0' + canonicalRelativeName(relativeName)
  return 'lora-' + createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 32)
}

function isSafeId(value) {
  return typeof value === 'string' && ID.test(value)
}

function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map((entry) => canonicalJson(entry)).join(',') + ']'
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}

function bindingIdFor(input) {
  const digest = createHash('sha256').update(canonicalJson(input), 'utf8').digest('hex').slice(0, 32)
  return 'lora-' + digest
}

function normalizeRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['binding', 'modelId', 'modelName', 'createdAt'].includes(key))
    || !Object.hasOwn(value, 'binding') || !Object.hasOwn(value, 'modelId')
    || !Object.hasOwn(value, 'modelName') || !Object.hasOwn(value, 'createdAt')) {
    throw catalogError('LORA_CATALOG_STORE_CORRUPT', 'LoRA catalog binding record无效', 500)
  }
  const binding = normalizeLoraBinding(value.binding)
  if (!MODEL_ID.test(value.modelId) || !isSafeId(binding.id)
    || typeof value.createdAt !== 'number' || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0) {
    throw catalogError('LORA_CATALOG_STORE_CORRUPT', 'LoRA catalog binding identity无效', 500)
  }
  const modelName = safeRelativeName(value.modelName)
  return { binding, modelId: value.modelId, modelName, createdAt: value.createdAt }
}

function normalizeStore(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['schemaVersion', 'revision', 'bindings'].includes(key))
    || value.schemaVersion !== LORA_CATALOG_SCHEMA_VERSION
    || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !Array.isArray(value.bindings) || value.bindings.length > LORA_CATALOG_MAX_BINDINGS) {
    throw catalogError('LORA_CATALOG_STORE_CORRUPT', 'LoRA catalog store结构无效', 500)
  }
  const bindings = value.bindings.map(normalizeRecord)
  const ids = new Set()
  const pairs = new Set()
  for (const record of bindings) {
    if (ids.has(record.binding.id)) throw catalogError('LORA_CATALOG_STORE_CORRUPT', 'LoRA catalog binding id重复', 500)
    ids.add(record.binding.id)
    const pair = record.binding.id + '\0' + record.modelId
    if (pairs.has(pair)) throw catalogError('LORA_CATALOG_STORE_CORRUPT', 'LoRA catalog binding重复', 500)
    pairs.add(pair)
  }
  return { schemaVersion: LORA_CATALOG_SCHEMA_VERSION, revision: value.revision, bindings }
}

function publicRecord(record) {
  return clone(record)
}

async function readRegularDirectory(pathname, label) {
  let entry
  try {
    entry = await lstat(pathname)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw catalogError('LORA_CATALOG_ROOT_UNAVAILABLE', label + '无法读取')
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw catalogError('LORA_CATALOG_ROOT_INVALID', label + '必须是真实目录')
  }
  try {
    return await realpath(pathname)
  } catch {
    throw catalogError('LORA_CATALOG_ROOT_UNAVAILABLE', label + '无法解析')
  }
}

function warning(code, rootIndex, relativeName) {
  return relativeName ? code + ':' + rootIndex + ':' + relativeName : code + ':' + rootIndex
}

export class LoraCatalog {
  constructor({ roots, storeRoot } = {}) {
    if (!Array.isArray(roots) || !roots.length) throw catalogError('LORA_CATALOG_ROOTS_REQUIRED', 'roots不能为空')
    this.roots = roots.map((root, index) => assertAbsoluteDirectoryPath(root, 'roots[' + index + ']'))
    this.storeRoot = assertAbsoluteDirectoryPath(storeRoot, 'storeRoot')
    this.storePath = join(this.storeRoot, 'bindings.json')
    this.state = { schemaVersion: LORA_CATALOG_SCHEMA_VERSION, revision: 0, bindings: [] }
    this.opened = false
    this.writeChain = Promise.resolve()
  }

  async open() {
    const storeParent = await readRegularDirectory(this.storeRoot, 'storeRoot')
    if (!storeParent) {
      await mkdir(this.storeRoot, { recursive: true })
      const created = await readRegularDirectory(this.storeRoot, 'storeRoot')
      if (!created) throw catalogError('LORA_CATALOG_ROOT_UNAVAILABLE', 'storeRoot创建后无法读取', 500)
    }
    let file
    try {
      file = await lstat(this.storePath)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw catalogError('LORA_CATALOG_STORE_UNAVAILABLE', 'LoRA catalog store无法读取', 500)
    }
    if (!file) {
      this.state = { schemaVersion: LORA_CATALOG_SCHEMA_VERSION, revision: 0, bindings: [] }
      this.opened = true
      return this
    }
    if (file.isSymbolicLink() || !file.isFile() || file.size > LORA_CATALOG_MAX_STORE_BYTES) {
      throw catalogError('LORA_CATALOG_STORE_CORRUPT', 'LoRA catalog store文件无效或过大', 500)
    }
    try {
      this.state = normalizeStore(JSON.parse(await readFile(this.storePath, 'utf8')))
    } catch (error) {
      if (error?.code?.startsWith('LORA_CATALOG_')) throw error
      throw catalogError('LORA_CATALOG_STORE_CORRUPT', 'LoRA catalog store JSON损坏', 500)
    }
    this.opened = true
    return this
  }

  #assertOpen() {
    if (!this.opened) throw catalogError('LORA_CATALOG_NOT_OPEN', '请先打开LoRA catalog')
  }

  #scan = async () => {
    this.#assertOpen()
    const warnings = []
    const models = []
    const byId = new Map()
    const seenIds = new Map()
    const state = { entries: 0, budgetWarning: false }

    const addWarning = (value) => {
      if (!warnings.includes(value)) warnings.push(value)
    }
    const walk = async (rootIndex, rootActual, directory, depth, relativeDirectory) => {
      if (state.entries >= LORA_CATALOG_MAX_SCAN_ENTRIES) {
        if (!state.budgetWarning) {
          addWarning(warning('LORA_SCAN_ENTRY_LIMIT', rootIndex))
          state.budgetWarning = true
        }
        return
      }
      let entries
      try {
        entries = await readdir(directory, { withFileTypes: true })
      } catch {
        addWarning(warning('LORA_DIRECTORY_STAT_FAILED', rootIndex, relativeDirectory || '.'))
        return
      }
      entries.sort((left, right) => left.name.localeCompare(right.name, 'en-US'))
      for (const entry of entries) {
        if (state.entries >= LORA_CATALOG_MAX_SCAN_ENTRIES) {
          if (!state.budgetWarning) {
            addWarning(warning('LORA_SCAN_ENTRY_LIMIT', rootIndex))
            state.budgetWarning = true
          }
          return
        }
        state.entries += 1
        const relativeName = relativeDirectory ? relativeDirectory + '/' + entry.name : entry.name
        const child = join(directory, entry.name)
        if (entry.isSymbolicLink()) {
          addWarning(warning('LORA_SYMLINK_SKIPPED', rootIndex, relativeName))
          continue
        }
        let childEntry
        try {
          childEntry = await lstat(child)
        } catch {
          addWarning(warning('LORA_ENTRY_STAT_FAILED', rootIndex, relativeName))
          continue
        }
        if (childEntry.isSymbolicLink()) {
          addWarning(warning('LORA_SYMLINK_SKIPPED', rootIndex, relativeName))
          continue
        }
        if (childEntry.isDirectory()) {
          if (depth >= LORA_CATALOG_MAX_SCAN_DEPTH) {
            addWarning(warning('LORA_SCAN_DEPTH_LIMIT', rootIndex, relativeName))
            continue
          }
          let actualDirectory
          try {
            actualDirectory = await realpath(child)
          } catch {
            addWarning(warning('LORA_ENTRY_REALPATH_FAILED', rootIndex, relativeName))
            continue
          }
          if (!isInside(rootActual, actualDirectory)) {
            addWarning(warning('LORA_SYMLINK_ESCAPE_BLOCKED', rootIndex, relativeName))
            continue
          }
          await walk(rootIndex, rootActual, actualDirectory, depth + 1, relativeName)
          continue
        }
        if (!childEntry.isFile() || !/\.safetensors$/iu.test(entry.name)) continue
        let actualFile
        try {
          actualFile = await realpath(child)
        } catch {
          addWarning(warning('LORA_FILE_REALPATH_FAILED', rootIndex, relativeName))
          continue
        }
        if (!isInside(rootActual, actualFile)) {
          addWarning(warning('LORA_SYMLINK_ESCAPE_BLOCKED', rootIndex, relativeName))
          continue
        }
        let details
        try {
          details = await stat(actualFile)
        } catch {
          addWarning(warning('LORA_FILE_STAT_FAILED', rootIndex, relativeName))
          continue
        }
        if (!details.isFile()) {
          addWarning(warning('LORA_FILE_NOT_REGULAR', rootIndex, relativeName))
          continue
        }
        if (details.size > LORA_MAX_FILE_BYTES) {
          addWarning(warning('LORA_FILE_TOO_LARGE', rootIndex, relativeName))
          continue
        }
        if (models.length >= LORA_CATALOG_MAX_MODELS) {
          addWarning(warning('LORA_MODEL_LIMIT', rootIndex, relativeName))
          continue
        }
        const publicName = safeRelativeName(relativeName)
        const id = modelIdFor(rootIndex, publicName)
        const key = String(rootIndex) + '\0' + canonicalRelativeName(publicName)
        if (seenIds.has(id) && seenIds.get(id) !== key) {
          addWarning(warning('LORA_MODEL_ID_COLLISION', rootIndex, publicName))
          continue
        }
        seenIds.set(id, key)
        const model = { id, name: publicName, bytes: details.size }
        models.push(model)
        byId.set(id, { ...model, path: actualFile, root: rootActual })
      }
    }

    for (let rootIndex = 0; rootIndex < this.roots.length; rootIndex += 1) {
      const configured = this.roots[rootIndex]
      let rootActual
      try {
        rootActual = await readRegularDirectory(configured, 'LoRA root')
      } catch (error) {
        if (error?.code === 'LORA_CATALOG_ROOT_INVALID') throw error
        addWarning(warning('LORA_ROOT_STAT_FAILED', rootIndex))
        continue
      }
      if (!rootActual) {
        addWarning(warning('LORA_ROOT_MISSING', rootIndex))
        continue
      }
      await walk(rootIndex, rootActual, rootActual, 0, '')
    }
    models.sort((left, right) => left.name.localeCompare(right.name, 'en-US') || left.id.localeCompare(right.id))
    return { models, warnings, byId }
  }

  async list() {
    const scanned = await this.#scan()
    return { models: scanned.models, warnings: scanned.warnings }
  }

  async inspect({ modelId, expectedFamily } = {}) {
    this.#assertOpen()
    if (typeof modelId !== 'string' || !MODEL_ID.test(modelId)) throw catalogError('LORA_MODEL_ID_INVALID', 'modelId无效')
    const family = expectedFamily === undefined ? undefined : assertFamily(expectedFamily)
    const scanned = await this.#scan()
    const model = scanned.byId.get(modelId)
    if (!model) throw catalogError('LORA_MODEL_NOT_FOUND', 'LoRA模型不存在或不在受管目录中', 404)
    const inspection = await inspectLoraFile(model.path, { allowedRoots: [model.root], ...(family === undefined ? {} : { expectedFamily: family }) })
    return { model: { id: model.id, name: model.name, bytes: inspection.bytes }, inspection }
  }

  async saveBinding(input = {}) {
    this.#assertOpen()
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some((key) => !['modelId', 'role', 'expectedFamily', 'strength', 'clipStrength', 'triggerWords'].includes(key))) {
      throw catalogError('LORA_BINDING_REQUEST_INVALID', 'LoRA binding请求字段无效')
    }
    const family = assertFamily(input.expectedFamily)
    const scanned = await this.#scan()
    if (typeof input.modelId !== 'string' || !MODEL_ID.test(input.modelId)) throw catalogError('LORA_MODEL_ID_INVALID', 'modelId无效')
    const model = scanned.byId.get(input.modelId)
    if (!model) throw catalogError('LORA_MODEL_NOT_FOUND', 'LoRA模型不存在或不在受管目录中', 404)
    const prepared = normalizeLoraBinding({
      id: 'pending',
      family,
      sha256: '0'.repeat(64),
      role: input.role,
      strength: input.strength,
      ...(input.clipStrength === undefined ? {} : { clipStrength: input.clipStrength }),
      ...(input.triggerWords === undefined ? {} : { triggerWords: input.triggerWords }),
    })
    const inspection = await inspectLoraFile(model.path, { allowedRoots: [model.root], expectedFamily: family })
    if (inspection.compatibility !== 'compatible' || inspection.family !== family) {
      throw catalogError(inspection.compatibility === 'incompatible' ? 'LORA_COMPATIBILITY_INCOMPATIBLE' : 'LORA_COMPATIBILITY_UNVERIFIED', 'LoRA兼容性无法证明或与目标家族不匹配', 409)
    }
    const bindingId = bindingIdFor({
      modelId: model.id,
      sha256: inspection.sha256,
      family,
      role: prepared.role,
      strength: prepared.strength,
      clipStrength: prepared.clipStrength === undefined ? null : prepared.clipStrength,
      triggerWords: prepared.triggerWords || [],
    })
    const binding = normalizeLoraBinding({ ...prepared, id: bindingId, sha256: inspection.sha256 })
    assertLoraBindingCompatible(binding, {
      family,
      sha256: inspection.sha256,
      compatibility: inspection.compatibility,
    })
    const createdAt = Date.now()
    const record = { binding, modelId: model.id, modelName: model.name, createdAt }
    const existing = this.state.bindings.find((entry) => entry.binding.id === binding.id)
    if (existing) return { binding: clone(existing.binding), modelName: existing.modelName, createdAt: existing.createdAt }
    await this.#mutate((state) => {
      if (state.bindings.some((entry) => entry.binding.id === binding.id)) throw catalogError('LORA_BINDING_ID_CONFLICT', 'LoRA binding id已存在', 409)
      state.bindings.push(record)
      return record
    })
    return { binding: clone(binding), modelName: model.name, createdAt }
  }

  async resolveBinding(bindingId, expectedFamily) {
    this.#assertOpen()
    const family = assertFamily(expectedFamily)
    if (typeof bindingId !== 'string' || !isSafeId(bindingId)) throw catalogError('LORA_BINDING_ID_INVALID', 'bindingId无效')
    const record = this.state.bindings.find((entry) => entry.binding.id === bindingId)
    if (!record) throw catalogError('LORA_BINDING_NOT_FOUND', 'LoRA binding不存在', 404)
    const scanned = await this.#scan()
    const model = scanned.byId.get(record.modelId)
    if (!model) throw catalogError('LORA_BINDING_MODEL_MISSING', 'LoRA binding对应模型已不可用', 409)
    const inspection = await inspectLoraFile(model.path, { allowedRoots: [model.root], expectedFamily: family })
    assertLoraBindingCompatible(record.binding, {
      family,
      sha256: inspection.sha256,
      compatibility: inspection.compatibility,
    })
    return publicRecord(record)
  }

  async listBindings() {
    this.#assertOpen()
    return { bindings: this.state.bindings.map(publicRecord) }
  }

  #mutate(action) {
    const next = this.writeChain.then(async () => {
      const candidate = clone(this.state)
      const result = action(candidate)
      candidate.revision += 1
      if (candidate.bindings.length > LORA_CATALOG_MAX_BINDINGS) throw catalogError('LORA_CATALOG_BINDING_LIMIT', 'LoRA binding数量超过上限', 413)
      const content = JSON.stringify(candidate, null, 2) + '\n'
      if (Buffer.byteLength(content, 'utf8') > LORA_CATALOG_MAX_STORE_BYTES) throw catalogError('LORA_CATALOG_STORE_LIMIT', 'LoRA catalog store超过容量上限', 413)
      const temporary = join(this.storeRoot, '.bindings-' + randomUUID() + '.tmp')
      try {
        await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', flush: true })
        await rename(temporary, this.storePath)
      } finally {
        await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error })
      }
      this.state = candidate
      return clone(result)
    })
    this.writeChain = next.catch(() => undefined)
    return next
  }
}
