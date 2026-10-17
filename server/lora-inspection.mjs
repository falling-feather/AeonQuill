import { createHash } from 'node:crypto'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { LORA_BASE_FAMILIES } from '../src/lib/loraCompatibility.mjs'

export const LORA_MAX_HEADER_BYTES = 4 * 1024 * 1024
export const LORA_MAX_FILE_BYTES = 2 * 1024 ** 3

const HEADER_LENGTH_BYTES = 8
const MAX_SIZE_T = (2 ** 48) - 1
const MAX_SHAPE_RANK = 64
const MAX_METADATA_VALUE_LENGTH = 256
const SHA256 = /^[a-f0-9]{64}$/u
const FAMILY_SET = new Set(LORA_BASE_FAMILIES)
const DTYPE_BYTES = Object.freeze({
  BOOL: 1,
  U8: 1,
  I8: 1,
  F16: 2,
  BF16: 2,
  U16: 2,
  I16: 2,
  F32: 4,
  U32: 4,
  I32: 4,
  F64: 8,
  U64: 8,
  I64: 8,
})

const PUBLIC_METADATA_KEYS = new Set([
  'ss_base_model_version',
  'ss_network_module',
  'ss_network_dim',
  'ss_network_alpha',
  'ss_epoch',
  'ss_steps',
  'ss_learning_rate',
  'ss_resolution',
  'ss_clip_skip',
  'ss_num_train_images',
  'ss_sd_model_name',
  'modelspec.architecture',
  'modelspec.title',
  'trigger_words',
  'ss_trigger_words',
  'token_string',
])

const FAMILY_METADATA_KEYS = new Set([
  'ss_base_model_version',
  'ss_sd_model_name',
  'modelspec.architecture',
  'modelspec.title',
])

function inspectionError(code, message, status = 400, details) {
  return Object.assign(new Error(message), { code, status, ...(details ? { details } : {}) })
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isInside(root, target) {
  const child = relative(root, target)
  return Boolean(child) && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

function assertExpectedFamily(expectedFamily) {
  if (expectedFamily !== undefined && (typeof expectedFamily !== 'string' || !FAMILY_SET.has(expectedFamily))) {
    throw inspectionError('LORA_EXPECTED_FAMILY_INVALID', 'expectedFamily不在受支持集合中')
  }
}

async function resolveAllowedRoots(allowedRoots) {
  if (!Array.isArray(allowedRoots) || !allowedRoots.length) {
    throw inspectionError('LORA_ALLOWED_ROOTS_REQUIRED', 'allowedRoots不能为空')
  }
  const resolved = []
  for (const root of allowedRoots) {
    if (typeof root !== 'string' || !isAbsolute(root)) {
      throw inspectionError('LORA_ALLOWED_ROOT_INVALID', 'allowedRoots必须是绝对目录路径')
    }
    let entry
    try {
      entry = await lstat(root)
    } catch {
      throw inspectionError('LORA_ALLOWED_ROOT_UNAVAILABLE', 'allowedRoots包含不可访问目录')
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw inspectionError('LORA_ALLOWED_ROOT_INVALID', 'allowedRoots只能包含真实目录')
    }
    let actual
    try {
      actual = await realpath(root)
    } catch {
      throw inspectionError('LORA_ALLOWED_ROOT_UNAVAILABLE', 'allowedRoots目录无法解析')
    }
    if (!resolved.includes(actual)) resolved.push(actual)
  }
  return resolved
}

async function resolveAllowedFile(filePath, roots) {
  if (typeof filePath !== 'string' || !isAbsolute(filePath)) {
    throw inspectionError('LORA_FILE_PATH_INVALID', '内部LoRA文件路径必须是绝对路径')
  }
  if (!/\.safetensors$/iu.test(filePath)) {
    throw inspectionError('LORA_FILE_EXTENSION_INVALID', '只允许.safetensors文件')
  }
  let entry
  try {
    entry = await lstat(filePath)
  } catch {
    throw inspectionError('LORA_FILE_NOT_FOUND', 'LoRA文件不存在或不可访问', 404)
  }
  if (entry.isSymbolicLink()) {
    throw inspectionError('LORA_FILE_SYMLINK', 'LoRA文件不能是符号链接')
  }
  let actual
  try {
    actual = await realpath(filePath)
  } catch {
    throw inspectionError('LORA_FILE_NOT_FOUND', 'LoRA文件无法解析', 404)
  }
  if (!roots.some((root) => isInside(root, actual))) {
    throw inspectionError('LORA_PATH_NOT_ALLOWED', 'LoRA文件必须位于allowedRoots内')
  }
  if (!entry.isFile()) throw inspectionError('LORA_FILE_NOT_REGULAR', 'LoRA路径必须是regular file')
  if (entry.size > LORA_MAX_FILE_BYTES) {
    throw inspectionError('LORA_FILE_TOO_LARGE', 'LoRA文件超过2GiB上限', 413)
  }
  return { actual, size: entry.size }
}

async function readExact(handle, length, position) {
  const buffer = Buffer.alloc(length)
  let offset = 0
  while (offset < length) {
    const result = await handle.read(buffer, offset, length - offset, position + offset)
    if (!result.bytesRead) throw inspectionError('LORA_FILE_TRUNCATED', 'LoRA文件在读取期间提前结束', 409)
    offset += result.bytesRead
  }
  return buffer
}

function parseHeaderLength(prefix) {
  if (prefix.length !== HEADER_LENGTH_BYTES) throw inspectionError('LORA_HEADER_MISSING', 'safetensors文件缺少header长度')
  const length = prefix.readBigUInt64LE(0)
  if (length === 0n) throw inspectionError('LORA_HEADER_INVALID', 'safetensors header不能为空')
  if (length > BigInt(LORA_MAX_HEADER_BYTES)) throw inspectionError('LORA_HEADER_TOO_LARGE', 'safetensors header超过4MiB上限', 413)
  return Number(length)
}

function decodeHeader(buffer) {
  if (buffer[0] !== 0x7b) throw inspectionError('LORA_HEADER_INVALID', 'safetensors header必须以对象开始')
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    throw inspectionError('LORA_HEADER_UTF8_INVALID', 'safetensors header不是有效UTF-8')
  }
  try {
    return { text, value: JSON.parse(text) }
  } catch {
    throw inspectionError('LORA_HEADER_JSON_INVALID', 'safetensors header不是有效JSON')
  }
}

function duplicateKeyInJson(text) {
  let index = 0

  const skipWhitespace = () => {
    while (index < text.length && /\s/u.test(text[index])) index += 1
  }
  const parseString = () => {
    const start = index
    if (text[index] !== '"') throw new Error('string')
    index += 1
    while (index < text.length) {
      const character = text[index]
      if (character === '\\') {
        index += 2
        if (text[index - 1] === 'u') index += 4
        continue
      }
      index += 1
      if (character === '"') return JSON.parse(text.slice(start, index))
    }
    throw new Error('string')
  }
  const parseValue = () => {
    skipWhitespace()
    const character = text[index]
    if (character === '{') return parseObject()
    if (character === '[') return parseArray()
    if (character === '"') {
      parseString()
      return
    }
    if (text.startsWith('true', index)) {
      index += 4
      return
    }
    if (text.startsWith('false', index)) {
      index += 5
      return
    }
    if (text.startsWith('null', index)) {
      index += 4
      return
    }
    const number = text.slice(index).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u)
    if (!number) throw new Error('value')
    index += number[0].length
  }
  const parseArray = () => {
    index += 1
    skipWhitespace()
    if (text[index] === ']') {
      index += 1
      return
    }
    while (true) {
      parseValue()
      skipWhitespace()
      if (text[index] === ']') {
        index += 1
        return
      }
      if (text[index] !== ',') throw new Error('array')
      index += 1
    }
  }
  const parseObject = () => {
    index += 1
    skipWhitespace()
    const keys = new Set()
    if (text[index] === '}') {
      index += 1
      return
    }
    while (true) {
      const key = parseString()
      if (keys.has(key)) throw inspectionError('LORA_HEADER_DUPLICATE_KEY', 'safetensors header含重复JSON键')
      keys.add(key)
      skipWhitespace()
      if (text[index] !== ':') throw new Error('object')
      index += 1
      parseValue()
      skipWhitespace()
      if (text[index] === '}') {
        index += 1
        return
      }
      if (text[index] !== ',') throw new Error('object')
      index += 1
      skipWhitespace()
    }
  }

  try {
    parseValue()
    skipWhitespace()
    return index !== text.length
  } catch (error) {
    if (error?.code === 'LORA_HEADER_DUPLICATE_KEY') throw error
    return false
  }
}

function dtypeBytes(dtype) {
  if (typeof dtype !== 'string') throw inspectionError('LORA_DTYPE_INVALID', 'tensor dtype必须是字符串')
  if (Object.hasOwn(DTYPE_BYTES, dtype)) return DTYPE_BYTES[dtype]
  if (/^F8_[A-Z0-9]+$/u.test(dtype)) return 1
  throw inspectionError('LORA_DTYPE_UNSUPPORTED', `不支持的tensor dtype：${dtype}`)
}

function safeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SIZE_T) {
    throw inspectionError('LORA_HEADER_NUMBER_INVALID', `${label}超出安全范围`)
  }
  return value
}

function tensorBytes(shape, bytesPerElement) {
  let count = 1n
  for (const dimension of shape) count *= BigInt(dimension)
  const bytes = count * BigInt(bytesPerElement)
  if (bytes > BigInt(Number.MAX_SAFE_INTEGER)) throw inspectionError('LORA_TENSOR_SIZE_INVALID', 'tensor大小超出安全范围')
  return Number(bytes)
}

function parseTensorEntries(header, dataBytes) {
  if (!isRecord(header)) throw inspectionError('LORA_HEADER_SHAPE_INVALID', 'safetensors header根必须是对象')
  const metadata = header.__metadata__
  if (metadata !== undefined) {
    if (!isRecord(metadata) || Object.values(metadata).some((value) => typeof value !== 'string')) {
      throw inspectionError('LORA_METADATA_INVALID', 'safetensors __metadata__必须是字符串映射')
    }
  }
  const tensors = []
  for (const [name, info] of Object.entries(header)) {
    if (name === '__metadata__') continue
    if (!isRecord(info) || Object.keys(info).some((key) => !['dtype', 'shape', 'data_offsets'].includes(key))) {
      throw inspectionError('LORA_TENSOR_INFO_INVALID', 'tensor条目字段无效')
    }
    if (!Array.isArray(info.shape) || info.shape.length > MAX_SHAPE_RANK) {
      throw inspectionError('LORA_SHAPE_INVALID', 'tensor shape无效')
    }
    const shape = info.shape.map((value) => safeInteger(value, 'shape'))
    if (!Array.isArray(info.data_offsets) || info.data_offsets.length !== 2) {
      throw inspectionError('LORA_OFFSETS_INVALID', 'tensor data_offsets必须有两个元素')
    }
    const begin = safeInteger(info.data_offsets[0], 'data_offsets.begin')
    const end = safeInteger(info.data_offsets[1], 'data_offsets.end')
    if (begin > end || end > dataBytes) throw inspectionError('LORA_OFFSETS_INVALID', 'tensor data_offsets越过数据区')
    const bytesPerElement = dtypeBytes(info.dtype)
    const expectedBytes = tensorBytes(shape, bytesPerElement)
    if (expectedBytes !== end - begin) throw inspectionError('LORA_TENSOR_SIZE_MISMATCH', 'tensor shape/dtype与data_offsets大小不一致')
    tensors.push({ name, dtype: info.dtype, shape, begin, end })
  }
  if (!tensors.length) throw inspectionError('LORA_TENSORS_MISSING', 'safetensors header没有tensor')
  const ordered = tensors.slice().sort((left, right) => left.begin - right.begin || left.end - right.end)
  let cursor = 0
  for (const tensor of ordered) {
    if (tensor.begin < cursor) throw inspectionError('LORA_TENSOR_OVERLAP', 'tensor data_offsets发生重叠')
    if (tensor.begin > cursor) throw inspectionError('LORA_TENSOR_HOLE', 'tensor data_offsets存在未索引空洞')
    cursor = tensor.end
  }
  if (cursor !== dataBytes) throw inspectionError('LORA_TENSOR_HOLE', 'tensor data_offsets没有覆盖完整数据区')
  return { metadata: metadata || {}, tensors }
}

function metadataValueSafe(value) {
  return typeof value === 'string'
    && value.length <= MAX_METADATA_VALUE_LENGTH
    && !/\p{Cc}/u.test(value)
    && !/[A-Za-z]:[\\/]|(?:^|[\\/])\.\.?(?:[\\/]|$)|(?:https?|file):\/\//iu.test(value)
}

function normalizeTriggerMetadata(value) {
  let candidates
  try {
    const parsed = JSON.parse(value)
    candidates = Array.isArray(parsed) ? parsed : null
  } catch {
    candidates = null
  }
  if (!candidates) candidates = value.split(/[,\n]/u)
  return candidates
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry && entry.length <= 80 && !/\p{Cc}/u.test(entry) && !/[\\/]|:\/\//u.test(entry))
    .slice(0, 16)
    .join(', ')
    .slice(0, 1_024)
}

function publicMetadata(raw) {
  const output = {}
  let filtered = false
  for (const [key, value] of Object.entries(raw)) {
    if (!PUBLIC_METADATA_KEYS.has(key)) {
      filtered = true
      continue
    }
    if (['trigger_words', 'ss_trigger_words', 'token_string'].includes(key)) {
      const normalized = normalizeTriggerMetadata(value)
      if (normalized) output[key] = normalized
      else filtered = true
      continue
    }
    if (!metadataValueSafe(value)) {
      filtered = true
      continue
    }
    output[key] = value
  }
  return { metadata: output, filtered }
}

function familyCandidates(metadata, tensors) {
  const candidates = new Map()
  const add = (family, evidence) => {
    if (!candidates.has(family)) candidates.set(family, new Set())
    candidates.get(family).add(evidence)
  }
  const inspect = (key, value) => {
    const text = `${key} ${value}`.toLocaleLowerCase('en-US')
    if (/minimax|\bh3\b/u.test(text)) add('minimax-h3', `metadata:${key}`)
    if (/qwen[ _-]*image|qwen-image-edit/u.test(text)) add('qwen-image-edit', `metadata:${key}`)
    if (/flux|kontext/u.test(text)) add('flux', `metadata:${key}`)
    if (/sdxl|stable[ _-]?diffusion[ _-]?xl|sd[ _-]?xl/u.test(text)) add('sdxl', `metadata:${key}`)
    if (/sd[ _-]?(?:v1|1\.5)|stable[ _-]?diffusion[ _-]?(?:v1|1\.5)|sd15/u.test(text)
      || (key === 'ss_base_model_version' && /(?:^|[^0-9])v?1(?:[._-]?5)?(?:$|[^0-9])/u.test(String(value).toLocaleLowerCase('en-US')))) {
      add('sd15', `metadata:${key}`)
    }
  }
  for (const [key, value] of Object.entries(metadata)) {
    if (FAMILY_METADATA_KEYS.has(key)) inspect(key, value)
  }
  for (const tensor of tensors) {
    const text = tensor.name.toLocaleLowerCase('en-US')
    if (/minimax|\bh3\b/u.test(text)) add('minimax-h3', 'tensor-pattern:h3')
    if (/qwen[ _-]*image|qwen-image-edit/u.test(text)) add('qwen-image-edit', 'tensor-pattern:qwen')
    if (/flux|kontext|double_blocks|single_blocks/u.test(text)) add('flux', 'tensor-pattern:flux')
    if (/sdxl|stable_diffusion_xl|xl_base/u.test(text)) add('sdxl', 'tensor-pattern:sdxl')
  }
  const evidence = [...new Set([...candidates.values()].flatMap((value) => [...value]))].sort()
  const families = [...candidates.keys()]
  return { family: families.length === 1 ? families[0] : null, evidence, ambiguous: families.length > 1 }
}

const PAIR_PATTERNS = [
  { kind: 'a', pattern: /^(.*?)(?:[._])lora[_-]?a(?:\.([^.]+))?\.weight$/iu },
  { kind: 'b', pattern: /^(.*?)(?:[._])lora[_-]?b(?:\.([^.]+))?\.weight$/iu },
  { kind: 'a', pattern: /^(.*?)(?:[._])lora[_-]?down(?:\.([^.]+))?\.weight$/iu },
  { kind: 'b', pattern: /^(.*?)(?:[._])lora[_-]?up(?:\.([^.]+))?\.weight$/iu },
]

function pairDescriptor(name) {
  for (const descriptor of PAIR_PATTERNS) {
    const match = name.match(descriptor.pattern)
    if (match) return { kind: descriptor.kind, key: `${match[1]}\u0000${match[2] || ''}` }
  }
  return null
}

function pairRank(left, right) {
  if (left.shape.length !== right.shape.length || left.shape.length < 2) return null
  if (left.shape[0] < 1 || left.shape[0] !== right.shape[1]) return null
  for (let index = 2; index < left.shape.length; index += 1) {
    if (left.shape[index] !== right.shape[index] && left.shape[index] !== 1 && right.shape[index] !== 1) return null
  }
  return left.shape[0]
}

function inspectPairs(tensors) {
  const pairs = new Map()
  for (const tensor of tensors) {
    const descriptor = pairDescriptor(tensor.name)
    if (!descriptor) continue
    const pair = pairs.get(descriptor.key) || {}
    pair[descriptor.kind] = tensor
    pairs.set(descriptor.key, pair)
  }
  const ranks = []
  let incomplete = false
  let invalid = false
  for (const pair of pairs.values()) {
    if (!pair.a || !pair.b) {
      incomplete = true
      continue
    }
    const rank = pairRank(pair.a, pair.b)
    if (rank === null) invalid = true
    else ranks.push(rank)
  }
  return {
    pairCount: pairs.size,
    validPairCount: ranks.length,
    incomplete,
    invalid,
    rank: ranks.length ? { min: Math.min(...ranks), max: Math.max(...ranks) } : null,
  }
}

async function hashHandle(handle, size) {
  const hash = createHash('sha256')
  const chunk = Buffer.allocUnsafe(1024 * 1024)
  let offset = 0
  while (offset < size) {
    const length = Math.min(chunk.length, size - offset)
    const result = await handle.read(chunk, 0, length, offset)
    if (!result.bytesRead) throw inspectionError('LORA_FILE_TRUNCATED', 'LoRA文件在哈希期间提前结束', 409)
    hash.update(chunk.subarray(0, result.bytesRead))
    offset += result.bytesRead
  }
  return hash.digest('hex')
}

export async function inspectLoraFile(filePath, { allowedRoots, expectedFamily } = {}) {
  assertExpectedFamily(expectedFamily)
  const roots = await resolveAllowedRoots(allowedRoots)
  const safeFile = await resolveAllowedFile(filePath, roots)
  let handle
  try {
    handle = await open(safeFile.actual, 'r')
    const opened = await handle.stat()
    if (!opened.isFile() || opened.size !== safeFile.size || opened.size > LORA_MAX_FILE_BYTES) {
      throw inspectionError('LORA_FILE_CHANGED', 'LoRA文件在检查期间发生变化', 409)
    }
    const prefix = await readExact(handle, HEADER_LENGTH_BYTES, 0)
    const headerLength = parseHeaderLength(prefix)
    if (headerLength + HEADER_LENGTH_BYTES > opened.size) {
      throw inspectionError('LORA_HEADER_TRUNCATED', 'safetensors header超过文件长度')
    }
    const headerBytes = await readExact(handle, headerLength, HEADER_LENGTH_BYTES)
    const decoded = decodeHeader(headerBytes)
    if (duplicateKeyInJson(decoded.text)) throw inspectionError('LORA_HEADER_DUPLICATE_KEY', 'safetensors header含重复JSON键')
    const dataBytes = opened.size - HEADER_LENGTH_BYTES - headerLength
    const parsed = parseTensorEntries(decoded.value, dataBytes)
    const pair = inspectPairs(parsed.tensors)
    const family = familyCandidates(parsed.metadata, parsed.tensors)
    const publicInfo = publicMetadata(parsed.metadata)
    const warnings = []
    if (publicInfo.filtered) warnings.push('LORA_METADATA_FILTERED')
    if (!pair.pairCount) warnings.push('LORA_PAIRS_MISSING')
    if (pair.incomplete) warnings.push('LORA_PAIRS_INCOMPLETE')
    if (pair.invalid) warnings.push('LORA_PAIR_SHAPE_UNVERIFIED')
    if (family.ambiguous) warnings.push('LORA_FAMILY_AMBIGUOUS')
    if (!family.family) warnings.push('LORA_FAMILY_UNVERIFIED')
    let compatibility = family.family && pair.validPairCount && !pair.incomplete && !pair.invalid
      ? 'compatible'
      : 'unverified'
    if (expectedFamily !== undefined) {
      if (family.family && family.family !== expectedFamily) {
        compatibility = 'incompatible'
        warnings.push('LORA_FAMILY_MISMATCH')
      } else if (!family.family) {
        warnings.push('LORA_EXPECTED_FAMILY_UNVERIFIED')
      }
    }
    const sha256 = await hashHandle(handle, opened.size)
    const after = await handle.stat()
    let pathStillPointsToSameFile = false
    try {
      const currentPath = await realpath(filePath)
      const currentEntry = await lstat(filePath)
      pathStillPointsToSameFile = currentPath === safeFile.actual
        && currentEntry.isFile()
        && !currentEntry.isSymbolicLink()
        && currentEntry.size === opened.size
        && currentEntry.mtimeMs === opened.mtimeMs
        && currentEntry.ctimeMs === opened.ctimeMs
    } catch {
      pathStillPointsToSameFile = false
    }
    if (!after.isFile() || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || !pathStillPointsToSameFile) {
      throw inspectionError('LORA_FILE_CHANGED', 'LoRA文件在检查期间发生变化', 409)
    }
    return {
      sha256,
      bytes: opened.size,
      format: 'safetensors',
      family: family.family,
      familyEvidence: family.evidence,
      tensorCount: parsed.tensors.length,
      rank: pair.rank,
      metadata: publicInfo.metadata,
      compatibility,
      warnings: [...new Set(warnings)],
    }
  } finally {
    await handle?.close().catch(() => {})
  }
}
