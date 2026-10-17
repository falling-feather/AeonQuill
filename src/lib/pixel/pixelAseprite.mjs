import {
  assertPixelDocument,
  createPixelDocument,
  migratePixelDocument,
  PIXEL_LIMITS,
} from './pixelCore.mjs'

const ASEPRITE_MAGIC = 0xA5E0
const FRAME_MAGIC = 0xF1FA
const MAX_FILE_BYTES = 32 * 1024 * 1024
const MAX_WARNING_COUNT = 128
const MAX_CHUNKS_PER_FRAME = 65_536
const MAX_STRING_BYTES = 0xFFFF

const CHUNK_OLD_PALETTE = 0x0004
const CHUNK_OLD_PALETTE_64 = 0x0011
const CHUNK_LAYER = 0x2004
const CHUNK_CEL = 0x2005
const CHUNK_CEL_EXTRA = 0x2006
const CHUNK_COLOR_PROFILE = 0x2007
const CHUNK_TAGS = 0x2018
const CHUNK_PALETTE = 0x2019
const CHUNK_USER_DATA = 0x2020

const LAYER_TYPE_NORMAL = 0
const LAYER_TYPE_GROUP = 1
const LAYER_TYPE_TILEMAP = 2

const BLEND_MODE_NAMES = Object.freeze({
  0: 'normal',
  1: 'multiply',
  2: 'screen',
  16: 'add',
})

const COLOR_DEPTH_BYTES = Object.freeze({ 8: 1, 16: 2, 32: 4 })

export class AsepriteFormatError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'AsepriteFormatError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

function fail(code, message, details) {
  throw new AsepriteFormatError(code, message, details)
}

function isUint8Array(value) {
  return value instanceof Uint8Array
}

function toInputBytes(input) {
  if (isUint8Array(input)) return input
  if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) return new Uint8Array(input)
  fail('INVALID_INPUT', 'Aseprite 输入必须是 Uint8Array 或 ArrayBuffer')
}

function addWarning(state, message) {
  if (state.seen.has(message)) return
  state.seen.add(message)
  if (state.warnings.length < MAX_WARNING_COUNT) state.warnings.push(message)
}

function hex(value, width = 4) {
  return `0x${value.toString(16).toUpperCase().padStart(width, '0')}`
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)))
}

function rgbaKey(r, g, b, a) {
  return `${r},${g},${b},${a}`
}

function rgbaHex(r, g, b, a) {
  return `#${[r, g, b, a].map((value) => value.toString(16).padStart(2, '0')).join('').toUpperCase()}`
}

function parseRgbaHex(color) {
  if (typeof color !== 'string' || !/^#[0-9A-Fa-f]{8}$/.test(color)) {
    fail('INVALID_DOCUMENT_COLOR', `PixelDocument 调色板颜色 ${String(color)} 不是 #RRGGBBAA`)
  }
  return [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
    Number.parseInt(color.slice(7, 9), 16),
  ]
}

class BinaryReader {
  constructor(bytes, start = 0, end = bytes.length) {
    this.bytes = bytes
    this.start = start
    this.position = start
    this.end = end
    this.view = new DataView(bytes.buffer, bytes.byteOffset + start, end - start)
  }

  get remaining() {
    return this.end - this.position
  }

  ensure(length, label) {
    if (!Number.isSafeInteger(length) || length < 0 || this.position + length > this.end) {
      fail('TRUNCATED', `Aseprite 数据在${label}处截断`, {
        position: this.position,
        required: length,
        end: this.end,
      })
    }
  }

  u8(label = 'BYTE') {
    this.ensure(1, label)
    const value = this.view.getUint8(this.position - this.start)
    this.position += 1
    return value
  }

  u16(label = 'WORD') {
    this.ensure(2, label)
    const value = this.view.getUint16(this.position - this.start, true)
    this.position += 2
    return value
  }

  i16(label = 'SHORT') {
    this.ensure(2, label)
    const value = this.view.getInt16(this.position - this.start, true)
    this.position += 2
    return value
  }

  u32(label = 'DWORD') {
    this.ensure(4, label)
    const value = this.view.getUint32(this.position - this.start, true)
    this.position += 4
    return value
  }

  i32(label = 'LONG') {
    this.ensure(4, label)
    const value = this.view.getInt32(this.position - this.start, true)
    this.position += 4
    return value
  }

  bytesOf(length, label = 'BYTE[]') {
    this.ensure(length, label)
    const value = this.bytes.slice(this.position, this.position + length)
    this.position += length
    return value
  }

  skip(length, label = 'reserved bytes') {
    this.ensure(length, label)
    this.position += length
  }

  string(label = 'STRING') {
    const length = this.u16(`${label}.length`)
    if (length > MAX_STRING_BYTES) fail('INVALID_STRING', `${label} 长度超过 UTF-8 字符串上限`)
    const raw = this.bytesOf(length, label)
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(raw)
    } catch (error) {
      fail('INVALID_UTF8', `${label} 不是有效 UTF-8 字符串`, { cause: String(error) })
    }
  }
}

function readHeader(bytes, warnings) {
  if (bytes.byteLength < 128) fail('TRUNCATED', 'Aseprite 文件不足 128 字节头部')
  const reader = new BinaryReader(bytes, 0, bytes.length)
  const fileSize = reader.u32('header.fileSize')
  const magic = reader.u16('header.magic')
  if (magic !== ASEPRITE_MAGIC) fail('INVALID_MAGIC', `不是 Aseprite 文件：期望 ${hex(ASEPRITE_MAGIC)}，得到 ${hex(magic)}`)
  if (fileSize < 128) fail('INVALID_HEADER', `Aseprite 头部声明的文件大小 ${fileSize} 小于 128 字节`)
  if (fileSize > bytes.length) fail('TRUNCATED', `Aseprite 文件头声明 ${fileSize} 字节，但实际只有 ${bytes.length} 字节`)
  if (fileSize < bytes.length) {
    addWarning(warnings, `文件头声明大小为 ${fileSize} 字节，已忽略末尾 ${bytes.length - fileSize} 个字节。`)
  }
  const fileEnd = fileSize
  const frameCount = reader.u16('header.frames')
  const width = reader.u16('header.width')
  const height = reader.u16('header.height')
  const colorDepth = reader.u16('header.colorDepth')
  const flags = reader.u32('header.flags')
  const speed = reader.u16('header.speed')
  reader.skip(4, 'header.reserved1')
  reader.skip(4, 'header.reserved2')
  const transparentIndex = reader.u8('header.transparentIndex')
  reader.skip(3, 'header.transparentReserved')
  const colorCountRaw = reader.u16('header.colorCount')
  const pixelWidth = reader.u8('header.pixelWidth')
  const pixelHeight = reader.u8('header.pixelHeight')
  const gridX = reader.i16('header.gridX')
  const gridY = reader.i16('header.gridY')
  const gridWidth = reader.u16('header.gridWidth')
  const gridHeight = reader.u16('header.gridHeight')
  reader.skip(84, 'header.future')
  if (reader.position !== 128) fail('INVALID_HEADER', 'Aseprite 头部长度不是 128 字节')
  if (frameCount < 1 || frameCount > PIXEL_LIMITS.maxFrames) {
    fail('FRAME_LIMIT', `Aseprite 帧数 ${frameCount} 超出 ${PIXEL_LIMITS.maxFrames} 帧上限`)
  }
  if (width < 1 || width > PIXEL_LIMITS.maxWidth || height < 1 || height > PIXEL_LIMITS.maxHeight) {
    fail('DIMENSION_LIMIT', `Aseprite 尺寸 ${width}x${height} 超出 ${PIXEL_LIMITS.maxWidth}x${PIXEL_LIMITS.maxHeight} 上限`)
  }
  if (!(colorDepth in COLOR_DEPTH_BYTES)) {
    fail('UNSUPPORTED_COLOR_DEPTH', `不支持 Aseprite ${colorDepth} bpp；仅支持 8 位 indexed、16 位 grayscale、32 位 RGBA`)
  }
  const colorCount = colorCountRaw === 0 ? 256 : colorCountRaw
  if (colorDepth === 8 && (colorCount < 1 || colorCount > PIXEL_LIMITS.maxPaletteColors)) {
    fail('PALETTE_LIMIT', `Aseprite indexed 调色板 ${colorCount} 色超出 ${PIXEL_LIMITS.maxPaletteColors} 色上限`)
  }
  if (pixelWidth !== 0 && pixelHeight !== 0 && (pixelWidth !== pixelHeight || pixelWidth !== 1)) {
    addWarning(warnings, `文件像素宽高比为 ${pixelWidth}:${pixelHeight}；PixelDocument 不保存像素宽高比。`)
  }
  if (gridWidth !== 0 || gridHeight !== 0 || gridX !== 0 || gridY !== 0) {
    addWarning(warnings, 'Aseprite 网格设置不会写入 PixelDocument。')
  }
  return {
    fileSize,
    fileEnd,
    frameCount,
    width,
    height,
    colorDepth,
    bytesPerPixel: COLOR_DEPTH_BYTES[colorDepth],
    flags,
    speed,
    transparentIndex,
    colorCount,
    offset: 128,
  }
}

function readLayerChunk(reader, header) {
  const flags = reader.u16('layer.flags')
  const type = reader.u16('layer.type')
  const childLevel = reader.u16('layer.childLevel')
  const defaultWidth = reader.u16('layer.defaultWidth')
  const defaultHeight = reader.u16('layer.defaultHeight')
  const blendCode = reader.u16('layer.blendMode')
  const opacityByte = reader.u8('layer.opacity')
  reader.skip(3, 'layer.reserved')
  const name = reader.string('layer.name')
  if (type === LAYER_TYPE_TILEMAP) {
    if (reader.remaining < 4) fail('TRUNCATED', 'Aseprite tilemap 图层缺少 tileset index')
    reader.u32('layer.tilesetIndex')
    fail('UNSUPPORTED_TILEMAP', '不支持 Aseprite tilemap 图层；为避免静默错图，已拒绝导入')
  }
  if (type !== LAYER_TYPE_NORMAL && type !== LAYER_TYPE_GROUP) {
    fail('UNSUPPORTED_LAYER_TYPE', `不支持 Aseprite 图层类型 ${type}`)
  }
  if ((header.flags & 4) !== 0) reader.skip(16, 'layer.uuid')
  if (reader.remaining > 0) reader.skip(reader.remaining, 'layer.future')
  const blendMode = BLEND_MODE_NAMES[blendCode]
  if (!blendMode) {
    fail('UNSUPPORTED_BLEND_MODE', `Aseprite 混合模式 ${blendCode} 无法无损映射；支持 normal、multiply、screen、addition`)
  }
  const opacityValid = (header.flags & 1) !== 0
    && (type !== LAYER_TYPE_GROUP || (header.flags & 2) !== 0)
  const visible = (flags & 1) !== 0
  const locked = (flags & 2) === 0 || (flags & 4) !== 0
  return {
    type,
    flags,
    childLevel,
    name,
    blendCode,
    blendMode,
    opacityByte: opacityValid ? opacityByte : 255,
    visible,
    locked,
    defaultWidth,
    defaultHeight,
  }
}

function readCelChunk(reader, header) {
  const layerIndex = reader.u16('cel.layerIndex')
  const x = reader.i16('cel.x')
  const y = reader.i16('cel.y')
  const opacity = reader.u8('cel.opacity')
  const type = reader.u16('cel.type')
  const zIndex = reader.i16('cel.zIndex')
  reader.skip(5, 'cel.reserved')
  if (zIndex !== 0) {
    fail('UNSUPPORTED_Z_INDEX', `Aseprite cel z-index ${zIndex} 无法映射到固定图层顺序；为避免错图，已拒绝导入`)
  }
  if (type === 0 || type === 2) {
    const width = reader.u16('cel.width')
    const height = reader.u16('cel.height')
    if (width < 1 || height < 1 || width > PIXEL_LIMITS.maxWidth || height > PIXEL_LIMITS.maxHeight) {
      fail('CEL_DIMENSION_LIMIT', `Aseprite cel 尺寸 ${width}x${height} 超出 ${PIXEL_LIMITS.maxWidth}x${PIXEL_LIMITS.maxHeight} 上限`)
    }
    const expected = width * height * header.bytesPerPixel
    if (!Number.isSafeInteger(expected) || expected > MAX_FILE_BYTES) {
      fail('CEL_SIZE_LIMIT', `Aseprite cel 原始像素数据超过 ${MAX_FILE_BYTES} 字节预算`)
    }
    if (type === 0) {
      if (reader.remaining !== expected) {
        fail('INVALID_RAW_LENGTH', `Aseprite raw cel 应有 ${expected} 字节，实际 ${reader.remaining} 字节`)
      }
      return { layerIndex, x, y, opacity, type, zIndex, width, height, raw: reader.bytesOf(expected, 'cel.rawPixels') }
    }
    if (reader.remaining < 1) fail('INVALID_COMPRESSION', 'Aseprite compressed cel 缺少 zlib 数据')
    return { layerIndex, x, y, opacity, type, zIndex, width, height, compressed: reader.bytesOf(reader.remaining, 'cel.compressedPixels') }
  }
  if (type === 1) {
    const framePosition = reader.u16('cel.linkedFrame')
    if (reader.remaining > 0) reader.skip(reader.remaining, 'cel.linkedFuture')
    return { layerIndex, x, y, opacity, type, zIndex, framePosition }
  }
  if (type === 3) {
    fail('UNSUPPORTED_TILEMAP', '不支持 Aseprite compressed tilemap cel；为避免静默错图，已拒绝导入')
  }
  fail('UNSUPPORTED_CEL_TYPE', `不支持 Aseprite cel 类型 ${type}`)
}

function readOldPaletteChunk(reader, state, scale) {
  const packets = reader.u16('oldPalette.packets')
  const useChunk = state.source !== 'new'
  const entries = useChunk ? (state.entries ?? []) : []
  let index = 0
  for (let packetIndex = 0; packetIndex < packets; packetIndex += 1) {
    index += reader.u8(`oldPalette.packet[${packetIndex}].skip`)
    const countRaw = reader.u8(`oldPalette.packet[${packetIndex}].count`)
    const count = countRaw === 0 ? 256 : countRaw
    if (index + count > 256) fail('PALETTE_LIMIT', '旧式 Aseprite palette chunk 超过 256 个索引')
    for (let colorIndex = 0; colorIndex < count; colorIndex += 1) {
      const r = reader.u8('oldPalette.red')
      const g = reader.u8('oldPalette.green')
      const b = reader.u8('oldPalette.blue')
      const red = scale === 255 ? r : (r << 2) | (r >> 4)
      const green = scale === 255 ? g : (g << 2) | (g >> 4)
      const blue = scale === 255 ? b : (b << 2) | (b >> 4)
      if (useChunk) entries[index + colorIndex] = { r: red, g: green, b: blue, a: 255, name: `Color ${index + colorIndex + 1}` }
    }
    index += count
  }
  if (useChunk) {
    state.entries = entries
    state.source = 'old'
    state.highestIndex = Math.max(state.highestIndex ?? 0, index)
  }
}

function readNewPaletteChunk(reader, state) {
  const size = reader.u32('palette.size')
  const from = reader.u32('palette.from')
  const to = reader.u32('palette.to')
  reader.skip(8, 'palette.reserved')
  if (size < 1 || size > PIXEL_LIMITS.maxPaletteColors) {
    fail('PALETTE_LIMIT', `Aseprite palette chunk 声明 ${size} 色，超出 ${PIXEL_LIMITS.maxPaletteColors} 色上限`)
  }
  if (from > to || to >= size) fail('INVALID_PALETTE', `Aseprite palette range ${from}-${to} 不在 ${size} 色范围内`)
  const entries = state.source === 'new' && state.entries?.length === size
    ? state.entries.slice()
    : Array.from({ length: size }, () => null)
  for (let index = from; index <= to; index += 1) {
    const entryFlags = reader.u16(`palette.entry[${index}].flags`)
    const r = reader.u8('palette.red')
    const g = reader.u8('palette.green')
    const b = reader.u8('palette.blue')
    const a = reader.u8('palette.alpha')
    const name = (entryFlags & 1) !== 0 ? reader.string(`palette.entry[${index}].name`) : `Color ${index + 1}`
    const next = { r, g, b, a, name: name || `Color ${index + 1}` }
    const previous = entries[index]
    entries[index] = previous ? { ...next, name: previous.name } : next
  }
  state.entries = entries
  state.source = 'new'
  state.highestIndex = size
}

function clonePaletteState(state) {
  return {
    entries: state.entries?.map((entry) => (entry ? { ...entry } : null)) ?? null,
    source: state.source,
    highestIndex: state.highestIndex,
  }
}

function readTagsChunk(reader, header, tags, warnings) {
  const count = reader.u16('tags.count')
  reader.skip(8, 'tags.reserved')
  if (count > PIXEL_LIMITS.maxAnimationTags) {
    fail('TAG_LIMIT', `Aseprite 标签数 ${count} 超出 ${PIXEL_LIMITS.maxAnimationTags} 上限`)
  }
  for (let index = 0; index < count; index += 1) {
    const from = reader.u16(`tags[${index}].from`)
    const to = reader.u16(`tags[${index}].to`)
    const directionCode = reader.u8(`tags[${index}].direction`)
    const repeat = reader.u16(`tags[${index}].repeat`)
    reader.skip(6, `tags[${index}].reserved`) // Six bytes after repeat in the current format.
    reader.skip(3, `tags[${index}].deprecatedColor`)
    reader.skip(1, `tags[${index}].extra`) // Extra byte introduced with tag colors.
    const name = reader.string(`tags[${index}].name`)
    if (name.length > 80) fail('NAME_LIMIT', `Aseprite 标签名称超过 PixelDocument 的 80 字符上限：${name.slice(0, 24)}`)
    if (from >= header.frameCount || to >= header.frameCount || from > to) {
      fail('INVALID_TAG_RANGE', `Aseprite 标签 ${name || index + 1} 的帧范围 ${from}-${to} 无效`)
    }
    let direction
    if (directionCode === 0) direction = 'forward'
    else if (directionCode === 1) direction = 'reverse'
    else if (directionCode === 2) direction = 'ping-pong'
    else if (directionCode === 3) {
      direction = 'ping-pong'
      addWarning(warnings, `标签 ${name || index + 1} 使用 ping-pong reverse；PixelDocument 仅保留 ping-pong 方向。`)
    } else {
      fail('UNSUPPORTED_TAG_DIRECTION', `Aseprite 标签 ${name || index + 1} 的方向 ${directionCode} 不支持`)
    }
    if (repeat > 1) addWarning(warnings, `标签 ${name || index + 1} 的有限重复次数 ${repeat} 无法写入 PixelDocument，仅保留 loop=true。`)
    tags.push({
      from,
      to,
      direction,
      loop: repeat === 0 || repeat > 1,
      name: name || `Tag ${index + 1}`,
    })
  }
}

function readColorProfileChunk(reader) {
  const type = reader.u16('colorProfile.type')
  const flags = reader.u16('colorProfile.flags')
  const fixedGamma = reader.i32('colorProfile.fixedGamma')
  reader.skip(8, 'colorProfile.reserved')
  if (type === 2) fail('UNSUPPORTED_COLOR_PROFILE', 'Aseprite 文件包含 ICC 色彩配置；当前导入器无法在不改变颜色的情况下转换它')
  if (type !== 0 && type !== 1) fail('UNSUPPORTED_COLOR_PROFILE', `Aseprite 色彩配置类型 ${type} 不支持`)
  if ((flags & 1) !== 0) fail('UNSUPPORTED_COLOR_PROFILE', `Aseprite 文件使用固定 gamma（${fixedGamma}）；当前 PixelDocument 不保存色彩配置`)
  if (type === 1) return
}

function buildLayerModel(entries, header, warnings) {
  if (entries.length < 1) fail('MISSING_LAYERS', 'Aseprite 文件没有图层 chunk')
  const groups = []
  const layers = []
  const layerModels = []
  let currentGroup = null
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if ((entry.flags & 64) !== 0) addWarning(warnings, `图层 ${entry.name || index + 1} 是 Aseprite reference layer；PixelDocument 不保存 reference 标记。`)
    if (entry.name.length > 80) fail('NAME_LIMIT', `Aseprite 图层名称超过 PixelDocument 的 80 字符上限：${entry.name.slice(0, 24)}`)
    if (entry.childLevel > 1) {
      fail('UNSUPPORTED_NESTING', `Aseprite 图层 ${entry.name || index + 1} 的嵌套深度 ${entry.childLevel} 超出一层 group 支持范围`)
    }
    if (entry.type === LAYER_TYPE_GROUP) {
      if (entry.childLevel !== 0) {
        fail('UNSUPPORTED_NESTING', `Aseprite group ${entry.name || index + 1} 嵌套在另一个 group 中；当前仅支持单层嵌套 scope`)
      }
      if (groups.length >= PIXEL_LIMITS.maxLayerGroups) {
        fail('LAYER_GROUP_LIMIT', `Aseprite group 数量超过 ${PIXEL_LIMITS.maxLayerGroups} 上限`)
      }
      const groupId = `group-${groups.length + 1}`
      const group = {
        id: groupId,
        name: entry.name || `Group ${groups.length + 1}`,
        visible: entry.visible,
        locked: entry.locked,
        __opacityByte: entry.opacityByte,
      }
      groups.push(group)
      layerModels.push({ kind: 'group', entry, group, groupIndex: groups.length - 1 })
      currentGroup = group
      if (entry.opacityByte !== 255) addWarning(warnings, `图层组 ${group.name} 的 opacity 已展平到子图层像素；保留项目原件以恢复组 opacity。`)
      continue
    }
    if (entry.type !== LAYER_TYPE_NORMAL) fail('UNSUPPORTED_LAYER_TYPE', `不支持图层类型 ${entry.type}`)
    if (layers.length >= PIXEL_LIMITS.maxLayers) fail('LAYER_LIMIT', `Aseprite 普通图层超过 ${PIXEL_LIMITS.maxLayers} 上限`)
    let groupId = null
    let groupOpacity = 255
    if (entry.childLevel === 1) {
      if (!currentGroup) fail('INVALID_LAYER_HIERARCHY', `Aseprite 图层 ${entry.name || index + 1} 声明 child level 1，但没有父 group`)
      groupId = currentGroup.id
      groupOpacity = currentGroup.__opacityByte ?? 255
    } else if (entry.childLevel === 0) {
      currentGroup = null
    }
    const layer = {
      id: `layer-${layers.length + 1}`,
      name: entry.name || `Layer ${layers.length + 1}`,
      visible: entry.visible,
      locked: entry.locked,
      opacity: entry.opacityByte / 255,
      groupId,
      blendMode: entry.blendMode,
    }
    layers.push(layer)
    layerModels.push({ kind: 'layer', entry, layer, layerIndex: index, groupOpacity })
    if (groupId === null && entry.opacityByte !== 255 && (header.flags & 1) === 0) {
      addWarning(warnings, `图层 ${layer.name} 的 opacity 标志未声明，按规范使用 255。`)
    }
  }
  // Keep group opacity private to the import model so it cannot leak into the PixelDocument schema.
  for (const group of groups) delete group.__opacityByte
  if (groups.length + layers.length > 64 + PIXEL_LIMITS.maxLayerGroups) {
    fail('LAYER_LIMIT', 'Aseprite 图层结构超过计算预算')
  }
  return { groups, layers, layerModels }
}

async function decompressBounded(compressed, expected, label) {
  if (typeof DecompressionStream !== 'function' || typeof Blob !== 'function') {
    fail('UNSUPPORTED_COMPRESSION', '当前运行环境没有 DecompressionStream，无法解码 Aseprite zlib cel')
  }
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate'))
  const reader = stream.getReader()
  const output = new Uint8Array(expected)
  let offset = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value)
      if (offset + chunk.byteLength > expected) {
        fail('DECOMPRESSION_LIMIT', `${label} 解压输出超过声明的 ${expected} 字节上限`)
      }
      output.set(chunk, offset)
      offset += chunk.byteLength
    }
  } catch (error) {
    try { await reader.cancel() } catch {}
    if (error instanceof AsepriteFormatError) throw error
    fail('INVALID_COMPRESSION', `${label} 不是有效的 zlib/deflate 数据`, { cause: String(error) })
  }
  if (offset !== expected) {
    fail('INVALID_DECOMPRESSED_LENGTH', `${label} 解压后应有 ${expected} 字节，实际 ${offset} 字节`)
  }
  return output
}

async function readCelPixels(cel, header, cache) {
  if (cel.raw) return cel.raw
  if (cache.has(cel)) return cache.get(cel)
  const expected = cel.width * cel.height * header.bytesPerPixel
  const promise = decompressBounded(cel.compressed, expected, 'Aseprite compressed cel')
  cache.set(cel, promise)
  return promise
}

async function resolveRawCel(frameIndex, layerIndex, frames, header, cache, stack = new Set()) {
  const key = `${frameIndex}:${layerIndex}`
  if (stack.has(key)) fail('LINK_CYCLE', `Aseprite linked cel 形成循环：${key}`)
  const frame = frames[frameIndex]
  const cel = frame.cels.get(layerIndex)
  if (!cel) return null
  if (cel.type === 1) {
    if (cel.framePosition < 0 || cel.framePosition >= frames.length) {
      fail('INVALID_LINK', `Aseprite linked cel 引用帧 ${cel.framePosition} 超出范围`)
    }
    if (cel.framePosition === frameIndex) {
      fail('LINK_CYCLE', `Aseprite linked cel 在帧 ${frameIndex} 中引用自身`)
    }
    if (cel.framePosition > frameIndex) {
      fail('INVALID_FORWARD_LINK', `Aseprite linked cel 在帧 ${frameIndex} 中向前引用帧 ${cel.framePosition}`)
    }
    const next = new Set(stack)
    next.add(key)
    const source = await resolveRawCel(cel.framePosition, layerIndex, frames, header, cache, next)
    if (!source) fail('INVALID_LINK', `Aseprite linked cel 引用帧 ${cel.framePosition} 的空 cel`)
    return source
  }
  const pixels = await readCelPixels(cel, header, cache)
  return { width: cel.width, height: cel.height, pixels }
}

function paletteEntryAt(paletteState, index, header) {
  if (!paletteState.entries || !paletteState.entries[index]) {
    if (header.colorDepth === 8) fail('MISSING_PALETTE', `Aseprite indexed 像素引用了缺失的调色板索引 ${index}`)
    return { r: 0, g: 0, b: 0, a: 255, name: `Color ${index + 1}` }
  }
  return paletteState.entries[index]
}

function sourcePixelToRgba(raw, index, header, paletteState) {
  if (header.colorDepth === 32) {
    const offset = index * 4
    return [raw[offset], raw[offset + 1], raw[offset + 2], raw[offset + 3]]
  }
  if (header.colorDepth === 16) {
    const offset = index * 2
    const value = raw[offset]
    return [value, value, value, raw[offset + 1]]
  }
  const entry = paletteEntryAt(paletteState, raw[index], header)
  if (raw[index] === header.transparentIndex) return [entry.r, entry.g, entry.b, 0]
  return [entry.r, entry.g, entry.b, entry.a]
}

function applyRawCel(canvas, rawCel, cel, header, paletteState, width, height, groupOpacity) {
  const source = rawCel.pixels
  const sourceWidth = rawCel.width
  const sourceHeight = rawCel.height
  const combinedOpacity = (cel.opacity / 255) * (groupOpacity / 255)
  const startX = Math.max(0, cel.x)
  const startY = Math.max(0, cel.y)
  const endX = Math.min(width, cel.x + sourceWidth)
  const endY = Math.min(height, cel.y + sourceHeight)
  for (let y = startY; y < endY; y += 1) {
    const sourceY = y - cel.y
    for (let x = startX; x < endX; x += 1) {
      const sourceX = x - cel.x
      const sourceIndex = sourceY * sourceWidth + sourceX
      const [r, g, b, alpha] = sourcePixelToRgba(source, sourceIndex, header, paletteState)
      const targetOffset = (y * width + x) * 4
      canvas[targetOffset] = r
      canvas[targetOffset + 1] = g
      canvas[targetOffset + 2] = b
      canvas[targetOffset + 3] = clampByte(alpha * combinedOpacity)
    }
  }
}

function finalizeOldPalette(paletteState, header) {
  if (!paletteState.entries) return
  if (paletteState.source !== 'old') return
  const size = Math.max(1, Math.min(256, header.colorCount, paletteState.highestIndex || 1))
  paletteState.entries = Array.from({ length: size }, (_, index) => paletteState.entries[index] ?? ({
    r: 0,
    g: 0,
    b: 0,
    a: 255,
    name: `Color ${index + 1}`,
  }))
}

function buildPixelPalette(canvases, header, paletteStates, warnings) {
  const used = new Map()
  for (const frameCanvases of canvases) {
    for (const canvas of frameCanvases.values()) {
      for (let offset = 0; offset < canvas.length; offset += 4) {
        const alpha = canvas[offset + 3]
        if (alpha === 0) continue
        const key = rgbaKey(canvas[offset], canvas[offset + 1], canvas[offset + 2], alpha)
        if (!used.has(key)) used.set(key, [canvas[offset], canvas[offset + 1], canvas[offset + 2], alpha])
      }
    }
  }
  const sourceEntries = []
  const sourceByColor = new Map()
  for (const state of paletteStates) {
    for (const [index, entry] of (state?.entries ?? []).entries()) {
      if (!entry) continue
      const normalized = {
        r: entry.r,
        g: entry.g,
        b: entry.b,
        a: entry.a,
        name: entry.name || `Color ${index + 1}`,
      }
      const key = rgbaKey(normalized.r, normalized.g, normalized.b, normalized.a)
      if (!sourceByColor.has(key)) {
        sourceByColor.set(key, normalized)
        sourceEntries.push(normalized)
      }
    }
  }
  if (sourceEntries.length > PIXEL_LIMITS.maxPaletteColors) {
    addWarning(warnings, 'Aseprite 跨帧 palette 快照合计超过 256 色，已按实际像素颜色建立单一调色板；未进行量化。')
  }
  const entries = sourceEntries.length > PIXEL_LIMITS.maxPaletteColors ? [] : sourceEntries
  const entryKeys = new Set(entries.map((entry) => rgbaKey(entry.r, entry.g, entry.b, entry.a)))
  let allUsedCovered = true
  for (const key of used.keys()) {
    if (!entryKeys.has(key)) allUsedCovered = false
  }
  if (entries.length === 0 || !allUsedCovered) {
    if (entries.length > 0 && !allUsedCovered) {
      addWarning(warnings, 'Aseprite palette chunk 未覆盖所有 RGBA/灰度像素，已追加实际像素颜色；未进行量化。')
    }
    for (const [key, [r, g, b, a]] of used) {
      if (!entryKeys.has(key)) {
        entries.push({ r, g, b, a, name: `Color ${entries.length + 1}` })
        entryKeys.add(key)
      }
    }
  }
  if (entries.length === 0) {
    entries.push({ r: 0, g: 0, b: 0, a: 0, name: 'Transparent' })
  }
  if (entries.length > PIXEL_LIMITS.maxPaletteColors) {
    fail('COLOR_LIMIT_EXCEEDED', `图像实际颜色和 Aseprite 调色板合计超过 ${PIXEL_LIMITS.maxPaletteColors} 色；未自动量化，请先减少颜色后再导入`)
  }
  for (const entry of entries) {
    if (entry.name && entry.name.length > 48) fail('NAME_LIMIT', 'Aseprite 调色板名称超过 PixelDocument 的 48 字符上限')
  }
  const palette = entries.map((entry, index) => ({
    id: `color-${index + 1}`,
    name: entry.name || `Color ${index + 1}`,
    color: rgbaHex(entry.r, entry.g, entry.b, entry.a),
  }))
  const colorToId = new Map()
  for (const [index, entry] of entries.entries()) {
    const key = rgbaKey(entry.r, entry.g, entry.b, entry.a)
    if (!colorToId.has(key)) colorToId.set(key, `color-${index + 1}`)
  }
  return { palette, colorToId }
}

function canvasToCelPixels(canvas, colorToId, width, height) {
  const pixels = new Array(width * height)
  for (let index = 0; index < pixels.length; index += 1) {
    const offset = index * 4
    const alpha = canvas[offset + 3]
    if (alpha === 0) {
      pixels[index] = null
      continue
    }
    const key = rgbaKey(canvas[offset], canvas[offset + 1], canvas[offset + 2], alpha)
    const colorId = colorToId.get(key)
    if (!colorId) fail('COLOR_LIMIT_EXCEEDED', `像素颜色 ${key} 未进入调色板；未自动量化`)
    pixels[index] = colorId
  }
  return pixels
}

function createImportedCelLinks(frames, normalModels, pixelFrames, warnings) {
  const links = []
  let sequence = 1
  for (const model of normalModels) {
    const parent = frames.map((_, index) => index)
    const find = (index) => {
      let root = index
      while (parent[root] !== root) root = parent[root]
      while (parent[index] !== index) {
        const next = parent[index]
        parent[index] = root
        index = next
      }
      return root
    }
    const union = (left, right) => {
      const leftRoot = find(left)
      const rightRoot = find(right)
      if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot
    }
    let explicitLinkCount = 0
    for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
      const cel = frames[frameIndex].cels.get(model.layerIndex)
      if (cel?.type !== 1) continue
      explicitLinkCount += 1
      union(frameIndex, cel.framePosition)
    }
    if (!explicitLinkCount) continue
    const groups = new Map()
    for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
      const root = find(frameIndex)
      const group = groups.get(root) ?? []
      group.push(frameIndex)
      groups.set(root, group)
    }
    for (const frameIndexes of groups.values()) {
      if (frameIndexes.length < 2) continue
      frameIndexes.sort((left, right) => left - right)
      const firstPixels = pixelFrames[frameIndexes[0]].cels[model.layer.id]
      const samePixels = frameIndexes.every((frameIndex) => {
        const pixels = pixelFrames[frameIndex].cels[model.layer.id]
        return pixels.length === firstPixels.length && pixels.every((value, index) => value === firstPixels[index])
      })
      if (!samePixels) {
        addWarning(warnings, `Aseprite linked cel 拓扑（图层 ${model.layer.name}，帧 ${frameIndexes.map((index) => index + 1).join('、')}）未保留关联：offset、opacity 或 palette 变化导致物化像素不同。`)
        continue
      }
      links.push({
        id: `cel-link-${sequence++}`,
        layerId: model.layer.id,
        frameIds: frameIndexes.map((frameIndex) => pixelFrames[frameIndex].id),
      })
    }
  }
  return links
}

function normalizeDuration(raw, speed, warnings, frameIndex) {
  if (raw === 0) addWarning(warnings, `第 ${frameIndex + 1} 帧未声明时长，已回退到头部 speed 或 20ms。`)
  let duration = raw || speed || 20
  if (duration < 20) {
    addWarning(warnings, `第 ${frameIndex + 1} 帧时长 ${duration}ms 低于 PixelDocument 下限，已使用 20ms。`)
    duration = 20
  }
  if (duration > 60_000) {
    addWarning(warnings, `第 ${frameIndex + 1} 帧时长 ${duration}ms 超出 PixelDocument 上限，已使用 60000ms。`)
    duration = 60_000
  }
  return duration
}

function validateDecodeOptions(options) {
  if (options === undefined) return {}
  if (options === null || typeof options !== 'object' || Array.isArray(options)) fail('INVALID_OPTIONS', 'Aseprite options 必须是对象')
  for (const key of Object.keys(options)) {
    if (!new Set(['documentId', 'documentName']).has(key)) fail('INVALID_OPTIONS', `不支持 Aseprite options.${key}`)
  }
  if (options.documentId !== undefined && (typeof options.documentId !== 'string' || options.documentId.length < 1 || options.documentId.length > 64)) {
    fail('INVALID_OPTIONS', 'Aseprite options.documentId 必须是 1-64 个字符')
  }
  if (options.documentName !== undefined && (typeof options.documentName !== 'string' || options.documentName.length < 1 || options.documentName.length > 120)) {
    fail('INVALID_OPTIONS', 'Aseprite options.documentName 必须是 1-120 个字符')
  }
  return options
}

export async function decodeAseprite(input, options = undefined) {
  const bytes = toInputBytes(input)
  if (bytes.byteLength > MAX_FILE_BYTES) fail('FILE_TOO_LARGE', `Aseprite 文件超过 ${MAX_FILE_BYTES} 字节上限`)
  const settings = validateDecodeOptions(options)
  const warnings = { warnings: [], seen: new Set() }
  const header = readHeader(bytes, warnings)
  const paletteState = { entries: null, source: null, highestIndex: 0 }
  const tags = []
  let tagsSeen = false
  const frames = []
  const layerEntries = []
  let offset = header.offset
  for (let frameIndex = 0; frameIndex < header.frameCount; frameIndex += 1) {
    if (offset + 16 > header.fileEnd) fail('TRUNCATED', `第 ${frameIndex + 1} 个 Aseprite 帧头不完整`)
    const frameReader = new BinaryReader(bytes, offset, header.fileEnd)
    const frameSize = frameReader.u32(`frame[${frameIndex}].size`)
    if (frameSize < 16 || offset + frameSize > header.fileEnd) {
      fail('INVALID_FRAME_SIZE', `第 ${frameIndex + 1} 个 Aseprite 帧大小 ${frameSize} 越过文件边界`)
    }
    const frameEnd = offset + frameSize
    const frame = new BinaryReader(bytes, offset, frameEnd)
    frame.u32(`frame[${frameIndex}].size`)
    const frameMagic = frame.u16(`frame[${frameIndex}].magic`)
    if (frameMagic !== FRAME_MAGIC) fail('INVALID_FRAME_MAGIC', `第 ${frameIndex + 1} 个 Aseprite 帧魔数错误：得到 ${hex(frameMagic)}`)
    const oldChunkCount = frame.u16(`frame[${frameIndex}].oldChunkCount`)
    const duration = frame.u16(`frame[${frameIndex}].duration`)
    frame.skip(2, `frame[${frameIndex}].reserved`)
    const newChunkCount = frame.u32(`frame[${frameIndex}].newChunkCount`)
    const chunkCount = oldChunkCount === 0xFFFF ? newChunkCount : (newChunkCount || oldChunkCount)
    if (chunkCount > MAX_CHUNKS_PER_FRAME) fail('CHUNK_LIMIT', `第 ${frameIndex + 1} 帧 chunk 数超过计算预算`)
    const frameRecord = { duration, cels: new Map(), paletteState: null }
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      if (frame.position + 6 > frameEnd) fail('TRUNCATED', `第 ${frameIndex + 1} 帧第 ${chunkIndex + 1} 个 chunk 头不完整`)
      const chunkStart = frame.position
      const chunkSize = frame.u32(`frame[${frameIndex}].chunk[${chunkIndex}].size`)
      const chunkType = frame.u16(`frame[${frameIndex}].chunk[${chunkIndex}].type`)
      if (chunkSize < 6 || chunkStart + chunkSize > frameEnd) {
        fail('INVALID_CHUNK_SIZE', `Aseprite chunk ${hex(chunkType)} 大小 ${chunkSize} 越过帧边界`)
      }
      const chunk = new BinaryReader(bytes, frame.position, chunkStart + chunkSize)
      switch (chunkType) {
        case CHUNK_LAYER: {
          const layer = readLayerChunk(chunk, header)
          if (frameIndex === 0) layerEntries.push(layer)
          else addWarning(warnings, `忽略第 ${frameIndex + 1} 帧重复的图层定义 chunk。`)
          break
        }
        case CHUNK_CEL: {
          const cel = readCelChunk(chunk, header)
          if (frameRecord.cels.has(cel.layerIndex)) fail('DUPLICATE_CEL', `第 ${frameIndex + 1} 帧图层 ${cel.layerIndex} 出现重复 cel`)
          frameRecord.cels.set(cel.layerIndex, cel)
          break
        }
        case CHUNK_CEL_EXTRA: {
          const extraFlags = chunk.u32('celExtra.flags')
          if ((extraFlags & 1) !== 0) {
            fail('UNSUPPORTED_CEL_BOUNDS', 'Aseprite cel 使用 precise bounds；当前 PixelDocument 只支持整数裁剪矩形')
          }
          break
        }
        case CHUNK_OLD_PALETTE:
          readOldPaletteChunk(chunk, paletteState, 255)
          break
        case CHUNK_OLD_PALETTE_64:
          readOldPaletteChunk(chunk, paletteState, 63)
          break
        case CHUNK_PALETTE:
          readNewPaletteChunk(chunk, paletteState)
          break
        case CHUNK_TAGS:
          if (tagsSeen) fail('DUPLICATE_TAGS', 'Aseprite 文件包含重复的 tags chunk')
          tagsSeen = true
          readTagsChunk(chunk, header, tags, warnings)
          break
        case CHUNK_COLOR_PROFILE:
          readColorProfileChunk(chunk)
          break
        case CHUNK_USER_DATA:
          addWarning(warnings, 'Aseprite user data 未映射到 PixelDocument。')
          break
        default:
          addWarning(warnings, `跳过未支持的 Aseprite chunk ${hex(chunkType)}；相关扩展数据不会写入 PixelDocument。`)
          break
      }
      if (chunk.position > chunk.end) fail('INVALID_CHUNK_SIZE', `Aseprite chunk ${hex(chunkType)} 读取越过边界`)
      frame.position = chunkStart + chunkSize
    }
    if (frame.position !== frameEnd) fail('INVALID_FRAME_SIZE', `第 ${frameIndex + 1} 帧 chunk 数据未读到帧末尾`)
    frameRecord.paletteState = clonePaletteState(paletteState)
    frames.push(frameRecord)
    offset = frameEnd
  }
  if (offset !== header.fileEnd) addWarning(warnings, `文件尾部仍有 ${header.fileEnd - offset} 个未解析字节。`)
  for (const frame of frames) finalizeOldPalette(frame.paletteState, header)
  const layerModel = buildLayerModel(layerEntries, header, warnings)
  const normalModels = layerModel.layerModels.filter((model) => model.kind === 'layer')
  if (normalModels.length < 1) fail('MISSING_LAYERS', 'Aseprite 文件没有可导入的普通图层')
  const totalCells = header.width * header.height * normalModels.length * header.frameCount
  if (totalCells > PIXEL_LIMITS.maxDocumentCells) {
    fail('DOCUMENT_TOO_LARGE', `Aseprite 像素预算 ${totalCells} 超过 ${PIXEL_LIMITS.maxDocumentCells}`)
  }
  const layerIndexToModel = new Map(layerModel.layerModels.map((model, index) => [index, model]))
  for (const frame of frames) {
    for (const layerIndex of frame.cels.keys()) {
      const model = layerIndexToModel.get(layerIndex)
      if (!model) fail('UNKNOWN_LAYER', `Aseprite cel 引用了不存在的图层索引 ${layerIndex}`)
      if (model.kind !== 'layer') fail('INVALID_CEL_LAYER', `Aseprite cel 不能附着到 group 图层 ${layerIndex}`)
    }
  }
  const celCache = new Map()
  const canvases = []
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
    const frameRecord = frames[frameIndex]
    const current = new Map()
    for (const model of normalModels) {
      const cel = frameRecord.cels.get(model.layerIndex)
      let canvas
      if (!cel) {
        canvas = new Uint8Array(header.width * header.height * 4)
      } else {
        const rawCel = await resolveRawCel(frameIndex, model.layerIndex, frames, header, celCache)
        if (!rawCel) fail('INVALID_LINK', `第 ${frameIndex + 1} 帧图层 ${model.layer.id} 没有可解析的 cel`)
        canvas = new Uint8Array(header.width * header.height * 4)
        applyRawCel(canvas, rawCel, cel, header, frameRecord.paletteState, header.width, header.height, model.groupOpacity)
      }
      current.set(model.layer.id, canvas)
    }
    canvases.push(current)
  }
  const { palette, colorToId } = buildPixelPalette(canvases, header, frames.map((frame) => frame.paletteState), warnings)
  const pixelFrames = canvases.map((frameCanvases, frameIndex) => ({
    id: `frame-${frameIndex + 1}`,
    name: `Frame ${frameIndex + 1}`,
    durationMs: normalizeDuration(frames[frameIndex].duration, header.speed, warnings, frameIndex),
    cels: Object.fromEntries(normalModels.map((model) => [
      model.layer.id,
      canvasToCelPixels(frameCanvases.get(model.layer.id), colorToId, header.width, header.height),
    ])),
  }))
  const frameIds = pixelFrames.map((frame) => frame.id)
  const celLinks = createImportedCelLinks(frames, normalModels, pixelFrames, warnings)
  const animationTags = tags.map((tag, index) => ({
    id: `tag-${index + 1}`,
    name: tag.name,
    fromFrameId: frameIds[tag.from],
    toFrameId: frameIds[tag.to],
    direction: tag.direction,
    loop: tag.loop,
  }))
  const documentInput = {
    id: settings.documentId ?? 'aseprite-document',
    name: settings.documentName ?? 'Imported Aseprite sprite',
    width: header.width,
    height: header.height,
    palette,
    layerGroups: layerModel.groups,
    layers: layerModel.layers,
    frames: pixelFrames,
    celLinks,
    animationTags,
  }
  const document = migratePixelDocument(createPixelDocument(documentInput))
  assertPixelDocument(document)
  return { document, warnings: warnings.warnings }
}

class ByteWriter {
  constructor() {
    this.parts = []
    this.length = 0
  }

  u8(value) {
    const bytes = new Uint8Array([value & 0xFF])
    this.parts.push(bytes)
    this.length += 1
  }

  u16(value) {
    const bytes = new Uint8Array(2)
    new DataView(bytes.buffer).setUint16(0, value, true)
    this.parts.push(bytes)
    this.length += 2
  }

  i16(value) {
    const bytes = new Uint8Array(2)
    new DataView(bytes.buffer).setInt16(0, value, true)
    this.parts.push(bytes)
    this.length += 2
  }

  u32(value) {
    const bytes = new Uint8Array(4)
    new DataView(bytes.buffer).setUint32(0, value, true)
    this.parts.push(bytes)
    this.length += 4
  }

  i32(value) {
    const bytes = new Uint8Array(4)
    new DataView(bytes.buffer).setInt32(0, value, true)
    this.parts.push(bytes)
    this.length += 4
  }

  bytesOf(value) {
    const bytes = value instanceof Uint8Array ? value : Uint8Array.from(value)
    this.parts.push(bytes)
    this.length += bytes.length
  }

  zeros(length) {
    if (length <= 0) return
    this.bytesOf(new Uint8Array(length))
  }

  string(value) {
    const bytes = new TextEncoder().encode(String(value))
    if (bytes.length > MAX_STRING_BYTES) fail('INVALID_STRING', 'Aseprite STRING 超过 65535 个 UTF-8 字节')
    this.u16(bytes.length)
    this.bytesOf(bytes)
  }

  toUint8Array() {
    const output = new Uint8Array(this.length)
    let offset = 0
    for (const part of this.parts) {
      output.set(part, offset)
      offset += part.length
    }
    return output
  }
}

function makeChunk(type, payload) {
  const writer = new ByteWriter()
  writer.u32(payload.length + 6)
  writer.u16(type)
  writer.bytesOf(payload)
  return writer.toUint8Array()
}

async function compressDeflate(input) {
  if (typeof CompressionStream !== 'function' || typeof Blob !== 'function') return null
  const stream = new Blob([input]).stream().pipeThrough(new CompressionStream('deflate'))
  const reader = stream.getReader()
  const parts = []
  let length = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value)
      length += chunk.byteLength
      if (length > MAX_FILE_BYTES) fail('FILE_TOO_LARGE', 'Aseprite compressed cel 超过文件预算')
      parts.push(chunk)
    }
  } catch (error) {
    try { await reader.cancel() } catch {}
    if (error instanceof AsepriteFormatError) throw error
    fail('INVALID_COMPRESSION', 'CompressionStream 无法编码 Aseprite zlib cel', { cause: String(error) })
  }
  const output = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}

function createLayerChunkPayload(layerSpec) {
  const writer = new ByteWriter()
  const layer = layerSpec.kind === 'group' ? layerSpec.group : layerSpec.layer
  let flags = layer.visible ? 1 : 0
  if (!layer.locked) flags |= 2
  else flags |= 4
  const type = layerSpec.kind === 'group' ? LAYER_TYPE_GROUP : LAYER_TYPE_NORMAL
  writer.u16(flags)
  writer.u16(type)
  writer.u16(layerSpec.kind === 'group' ? 0 : (layer.groupId === null ? 0 : 1))
  writer.u16(0)
  writer.u16(0)
  const blendModeCode = layerSpec.kind === 'group' ? 0 : ({ normal: 0, multiply: 1, screen: 2, add: 16 }[layer.blendMode])
  if (blendModeCode === undefined) fail('UNSUPPORTED_BLEND_MODE', `PixelDocument 混合模式 ${layer.blendMode} 无法导出到 Aseprite`)
  writer.u16(blendModeCode)
  writer.u8(layerSpec.kind === 'group' ? 255 : clampByte(layer.opacity * 255))
  writer.zeros(3)
  writer.string(layer.name)
  return writer.toUint8Array()
}

function createPaletteChunkPayload(document) {
  const writer = new ByteWriter()
  writer.u32(document.palette.length)
  writer.u32(0)
  writer.u32(document.palette.length - 1)
  writer.zeros(8)
  for (const color of document.palette) {
    const [r, g, b, a] = parseRgbaHex(color.color)
    writer.u16(1)
    writer.u8(r)
    writer.u8(g)
    writer.u8(b)
    writer.u8(a)
    writer.string(color.name)
  }
  return writer.toUint8Array()
}

function createTagsChunkPayload(document) {
  const writer = new ByteWriter()
  writer.u16(document.animationTags.length)
  writer.zeros(8)
  const frameIndex = new Map(document.frames.map((frame, index) => [frame.id, index]))
  for (const tag of document.animationTags) {
    const from = frameIndex.get(tag.fromFrameId)
    const to = frameIndex.get(tag.toFrameId)
    if (from === undefined || to === undefined || from > to) fail('INVALID_TAG_RANGE', `PixelDocument 标签 ${tag.name} 的帧范围无法导出`)
    writer.u16(from)
    writer.u16(to)
    writer.u8(tag.direction === 'forward' ? 0 : tag.direction === 'reverse' ? 1 : 2)
    writer.u16(tag.loop ? 0 : 1)
    writer.zeros(6)
    writer.zeros(3)
    writer.u8(0)
    writer.string(tag.name)
  }
  return writer.toUint8Array()
}

function createRgbaCelPixels(document, frame, layer, colorMap) {
  const pixels = frame.cels[layer.id]
  const output = new Uint8Array(document.width * document.height * 4)
  for (let index = 0; index < pixels.length; index += 1) {
    const colorId = pixels[index]
    if (colorId === null) continue
    const color = colorMap.get(colorId)
    if (!color) fail('UNKNOWN_COLOR', `PixelDocument cel 引用了未知颜色 ${colorId}`)
    const offset = index * 4
    output[offset] = color[0]
    output[offset + 1] = color[1]
    output[offset + 2] = color[2]
    output[offset + 3] = color[3]
  }
  return output
}

function createCelChunkPayload(layerIndex, document, pixels, compressed) {
  const writer = new ByteWriter()
  writer.u16(layerIndex)
  writer.i16(0)
  writer.i16(0)
  writer.u8(255)
  writer.u16(compressed ? 2 : 0)
  writer.i16(0)
  writer.zeros(5)
  writer.u16(document.width)
  writer.u16(document.height)
  writer.bytesOf(pixels)
  return writer.toUint8Array()
}

function createLinkedCelChunkPayload(layerIndex, framePosition) {
  const writer = new ByteWriter()
  writer.u16(layerIndex)
  writer.i16(0)
  writer.i16(0)
  writer.u8(255)
  writer.u16(1)
  writer.i16(0)
  writer.zeros(5)
  writer.u16(framePosition)
  return writer.toUint8Array()
}

function documentHasGameplay(document) {
  return document.frames.some((frame) => (
    frame.gameplay.collisions.length > 0
    || frame.gameplay.tileRule !== null
    || frame.gameplay.anchor.x !== Math.floor(document.width / 2)
    || frame.gameplay.anchor.y !== document.height
  ))
}

function collectExportWarnings(document, warnings) {
  const lost = []
  if (document.terrainMaps.length > 0) lost.push('terrainMaps')
  if (document.paletteCycles.length > 0) lost.push('paletteCycles')
  if (document.animationEvents.length > 0) lost.push('animationEvents')
  if (documentHasGameplay(document)) lost.push('frame gameplay')
  if (document.frames.some((frame, index) => frame.name !== `Frame ${index + 1}`)) lost.push('frame names')
  if (document.onionSkin.enabled !== true || document.onionSkin.previousFrames !== 1 || document.onionSkin.nextFrames !== 1 || document.onionSkin.opacity !== 0.22) {
    lost.push('onionSkin')
  }
  if (lost.length > 0) {
    warnings.push(`以下 AEONQUILL 字段或 Aseprite 不承载的信息（${lost.join('、')}）不会写入 Aseprite，请保留项目原件。`)
  }
}

function buildExportLayerSpecs(document) {
  const groups = new Map(document.layerGroups.map((group) => [group.id, group]))
  const specs = []
  const emitted = new Set()
  let openGroup = null
  for (const layer of document.layers) {
    if (layer.groupId === null) {
      openGroup = null
      specs.push({ kind: 'layer', layer })
      continue
    }
    const group = groups.get(layer.groupId)
    if (!group) fail('UNKNOWN_LAYER_GROUP', `PixelDocument 图层 ${layer.id} 引用了未知 group ${layer.groupId}`)
    if (emitted.has(group.id) && openGroup !== group.id) {
      fail('NONCONTIGUOUS_GROUP', `PixelDocument group ${group.name} 的子图层不连续，无法无损导出 Aseprite`)
    }
    if (!emitted.has(group.id)) {
      specs.push({ kind: 'group', group })
      emitted.add(group.id)
    }
    specs.push({ kind: 'layer', layer })
    openGroup = group.id
  }
  for (const group of document.layerGroups) {
    if (!emitted.has(group.id)) {
      specs.push({ kind: 'group', group })
      emitted.add(group.id)
    }
  }
  return specs
}

export async function encodeAseprite(documentInput) {
  const document = migratePixelDocument(documentInput)
  assertPixelDocument(document)
  const warnings = []
  collectExportWarnings(document, warnings)
  const specs = buildExportLayerSpecs(document)
  const layerIndexById = new Map()
  const normalSpecs = []
  specs.forEach((spec, index) => {
    if (spec.kind === 'layer') {
      layerIndexById.set(spec.layer.id, index)
      normalSpecs.push({ ...spec, index })
    }
  })
  const colorMap = new Map(document.palette.map((color) => [color.id, parseRgbaHex(color.color)]))
  const frameIndexById = new Map(document.frames.map((frame, index) => [frame.id, index]))
  const linkedCelByKey = new Map()
  for (const link of document.celLinks) {
    const frameIndexes = link.frameIds.map((frameId) => frameIndexById.get(frameId))
    const anchor = Math.min(...frameIndexes)
    for (const frameId of link.frameIds) {
      linkedCelByKey.set(`${link.layerId}:${frameId}`, { anchor, frameIds: link.frameIds })
    }
  }
  const output = new ByteWriter()
  output.u32(0)
  output.u16(ASEPRITE_MAGIC)
  output.u16(document.frames.length)
  output.u16(document.width)
  output.u16(document.height)
  output.u16(32)
  output.u32(3)
  output.u16(Math.min(60_000, Math.max(20, document.frames[0].durationMs)))
  output.u32(0)
  output.u32(0)
  output.u8(0)
  output.zeros(3)
  output.u16(document.palette.length === 256 ? 0 : document.palette.length)
  output.u8(1)
  output.u8(1)
  output.i16(0)
  output.i16(0)
  output.u16(0)
  output.u16(0)
  output.zeros(84)
  for (let frameIndex = 0; frameIndex < document.frames.length; frameIndex += 1) {
    const frame = document.frames[frameIndex]
    const chunks = []
    if (frameIndex === 0) {
      for (const spec of specs) chunks.push(makeChunk(CHUNK_LAYER, createLayerChunkPayload(spec)))
      chunks.push(makeChunk(CHUNK_PALETTE, createPaletteChunkPayload(document)))
      if (document.animationTags.length > 0) chunks.push(makeChunk(CHUNK_TAGS, createTagsChunkPayload(document)))
    }
    for (const spec of normalSpecs) {
      const link = linkedCelByKey.get(`${spec.layer.id}:${frame.id}`)
      const framePosition = link?.anchor
      if (framePosition !== undefined && frameIndex !== framePosition) {
        chunks.push(makeChunk(CHUNK_CEL, createLinkedCelChunkPayload(spec.index, framePosition)))
        continue
      }
      const raw = createRgbaCelPixels(document, frame, spec.layer, colorMap)
      let compressed = null
      compressed = await compressDeflate(raw)
      const useCompressed = compressed !== null && compressed.length < raw.length
      const pixels = useCompressed ? compressed : raw
      chunks.push(makeChunk(CHUNK_CEL, createCelChunkPayload(spec.index, document, pixels, useCompressed)))
    }
    if (chunks.length > MAX_CHUNKS_PER_FRAME) fail('CHUNK_LIMIT', '导出的 Aseprite 帧 chunk 数超过计算预算')
    const bodyLength = chunks.reduce((total, chunk) => total + chunk.length, 0)
    const frameWriter = new ByteWriter()
    frameWriter.u32(bodyLength + 16)
    frameWriter.u16(FRAME_MAGIC)
    frameWriter.u16(chunks.length >= 0xFFFF ? 0xFFFF : chunks.length)
    frameWriter.u16(Math.min(60_000, Math.max(20, frame.durationMs)))
    frameWriter.zeros(2)
    frameWriter.u32(chunks.length)
    for (const chunk of chunks) frameWriter.bytesOf(chunk)
    output.bytesOf(frameWriter.toUint8Array())
    if (output.length > MAX_FILE_BYTES) fail('FILE_TOO_LARGE', `导出的 Aseprite 文件超过 ${MAX_FILE_BYTES} 字节上限`)
  }
  const bytes = output.toUint8Array()
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(0, bytes.length, true)
  return { bytes, warnings }
}
