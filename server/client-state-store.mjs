import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  parseShellPreferences,
  parseSmartVideoSession,
  serializeShellPreferences,
  serializeSmartVideoSession,
} from '../src/shell/productShellState.mjs'
import {
  deserializePixelDocument,
  serializePixelDocument,
} from '../src/lib/pixel/pixelCore.mjs'

export const CLIENT_STATE_SCHEMA_VERSION = 1

const STATE_DEFINITIONS = Object.freeze({
  'shell-preferences': {
    filename: 'shell-preferences.json',
    maxBytes: 64 * 1024,
    fields: new Set(['version', 'selectedModeId', 'balancedProjectId']),
    normalize(value) {
      const parsed = parseJsonObject(value, '主页偏好')
      assertExactFields(parsed, this.fields, '主页偏好')
      const normalized = parseShellPreferences(value)
      if (
        parsed.version !== normalized.version
        || parsed.selectedModeId !== normalized.selectedModeId
        || parsed.balancedProjectId !== normalized.balancedProjectId
      ) {
        throw stateError('INVALID_CLIENT_STATE', '主页偏好未通过严格格式校验')
      }
      return serializeShellPreferences(normalized)
    },
  },
  'pixel-document': {
    filename: 'pixel-document.json',
    maxBytes: 32 * 1024 * 1024,
    normalize(value) {
      return serializePixelDocument(deserializePixelDocument(value))
    },
  },
  'smart-video-session': {
    filename: 'smart-video-session.json',
    maxBytes: 128 * 1024,
    fields: new Set([
      'version',
      'projectId',
      'title',
      'sourceKind',
      'sourceText',
      'updatedAt',
      'sceneCount',
      'taskCount',
    ]),
    normalize(value) {
      const parsed = parseJsonObject(value, '智能视频会话')
      assertExactFields(parsed, this.fields, '智能视频会话')
      const normalized = parseSmartVideoSession(value)
      if (!normalized) throw stateError('INVALID_CLIENT_STATE', '智能视频会话未通过严格格式校验')
      return serializeSmartVideoSession(normalized)
    },
  },
})

function stateError(code, message, status = 400, details) {
  return Object.assign(new Error(message), { code, status, details })
}

function parseJsonObject(value, label) {
  if (typeof value !== 'string') throw stateError('INVALID_CLIENT_STATE', `${label}必须是序列化 JSON 字符串`)
  try {
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    return parsed
  } catch {
    throw stateError('INVALID_CLIENT_STATE', `${label}不是有效的 JSON 对象`)
  }
}

function assertExactFields(value, allowedFields, label) {
  for (const key of Object.keys(value)) {
    if (!allowedFields.has(key)) throw stateError('UNKNOWN_CLIENT_STATE_FIELD', `${label}包含未知字段：${key}`)
  }
  for (const key of allowedFields) {
    if (!(key in value)) throw stateError('MISSING_CLIENT_STATE_FIELD', `${label}缺少字段：${key}`)
  }
}

function definitionFor(kind) {
  if (typeof kind !== 'string' || !Object.hasOwn(STATE_DEFINITIONS, kind)) {
    throw stateError('UNKNOWN_CLIENT_STATE_KIND', '不支持的本机客户端状态类型', 404)
  }
  return STATE_DEFINITIONS[kind]
}

function enforceSize(value, definition) {
  if (typeof value !== 'string') throw stateError('INVALID_CLIENT_STATE', '客户端状态必须是字符串')
  const bytes = Buffer.byteLength(value)
  if (bytes > definition.maxBytes) {
    throw stateError('CLIENT_STATE_TOO_LARGE', `客户端状态超过 ${definition.maxBytes} 字节上限`, 413, {
      bytes,
      maxBytes: definition.maxBytes,
    })
  }
}

function normalizeValue(definition, value) {
  try {
    return definition.normalize(value)
  } catch (error) {
    if (error?.code && error?.status) throw error
    throw stateError('INVALID_CLIENT_STATE', `客户端状态未通过格式校验：${error?.message || '未知格式错误'}`)
  }
}

async function removeTemporary(pathname) {
  try {
    await unlink(pathname)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

export class ClientStateStore {
  constructor(rootDirectory) {
    this.rootDirectory = rootDirectory
  }

  async open() {
    await mkdir(this.rootDirectory, { recursive: true })
  }

  async get(kind) {
    const definition = definitionFor(kind)
    const pathname = join(this.rootDirectory, definition.filename)
    let wrapper
    try {
      wrapper = JSON.parse(await readFile(pathname, 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw stateError('CLIENT_STATE_CORRUPT', '本机客户端状态文件无法读取', 500)
    }
    if (
      !wrapper
      || typeof wrapper !== 'object'
      || Array.isArray(wrapper)
      || wrapper.schemaVersion !== CLIENT_STATE_SCHEMA_VERSION
      || wrapper.kind !== kind
      || !Number.isSafeInteger(wrapper.updatedAt)
      || typeof wrapper.value !== 'string'
      || Object.keys(wrapper).some((key) => !['schemaVersion', 'kind', 'updatedAt', 'value'].includes(key))
    ) {
      throw stateError('CLIENT_STATE_CORRUPT', '本机客户端状态文件格式无效', 500)
    }
    try {
      enforceSize(wrapper.value, definition)
      const value = normalizeValue(definition, wrapper.value)
      return { kind, value, updatedAt: wrapper.updatedAt }
    } catch {
      throw stateError('CLIENT_STATE_CORRUPT', '本机客户端状态内容未通过格式校验', 500)
    }
  }

  async put(kind, value) {
    const definition = definitionFor(kind)
    enforceSize(value, definition)
    const normalized = normalizeValue(definition, value)
    enforceSize(normalized, definition)
    await this.open()
    const updatedAt = Date.now()
    const pathname = join(this.rootDirectory, definition.filename)
    const temporaryPath = join(dirname(pathname), `.aeonquill-state-${process.pid}-${randomUUID()}.tmp`)
    const wrapper = {
      schemaVersion: CLIENT_STATE_SCHEMA_VERSION,
      kind,
      updatedAt,
      value: normalized,
    }
    try {
      await writeFile(temporaryPath, `${JSON.stringify(wrapper)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(temporaryPath, pathname)
    } catch (error) {
      await removeTemporary(temporaryPath).catch(() => undefined)
      throw stateError('CLIENT_STATE_WRITE_FAILED', `本机客户端状态保存失败：${error.message}`, 500)
    }
    return { kind, value: normalized, updatedAt }
  }
}

export function clientStateKinds() {
  return Object.keys(STATE_DEFINITIONS)
}
