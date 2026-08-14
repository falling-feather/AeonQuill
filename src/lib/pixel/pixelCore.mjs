export const PIXEL_DOCUMENT_KIND = 'aeonquill.pixel-document'
export const PIXEL_DOCUMENT_SCHEMA_VERSION = 1
export const PIXEL_COMMAND_SCHEMA_VERSION = 1

export const PIXEL_LIMITS = Object.freeze({
  maxWidth: 512,
  maxHeight: 512,
  maxPaletteColors: 256,
  maxLayers: 64,
  maxFrames: 256,
  maxDocumentCells: 16_777_216,
  maxPixelsPerCommand: 65_536,
  maxSpritePixels: 67_108_864,
})

const DOCUMENT_FIELDS = new Set([
  'kind',
  'schemaVersion',
  'id',
  'name',
  'width',
  'height',
  'revision',
  'palette',
  'layers',
  'frames',
  'activeLayerId',
  'activeFrameId',
  'onionSkin',
])
const PALETTE_FIELDS = new Set(['id', 'name', 'color'])
const LAYER_FIELDS = new Set(['id', 'name', 'visible', 'locked', 'opacity'])
const FRAME_FIELDS = new Set(['id', 'name', 'durationMs', 'cels'])
const ONION_FIELDS = new Set(['enabled', 'previousFrames', 'nextFrames', 'opacity'])
const COMMAND_FIELDS = new Set(['schemaVersion', 'id', 'actor', 'type', 'baseRevision', 'payload'])
const ACTORS = new Set(['user', 'tool', 'agent', 'system'])
const COMMAND_TYPES = new Set([
  'pixels.paint',
  'pixels.erase',
  'pixels.restore',
  'palette.replace',
  'layers.add',
  'layers.remove',
  'layers.restore',
  'layers.patch',
  'layers.reorder',
  'layers.select',
  'frames.add',
  'frames.remove',
  'frames.restore',
  'frames.patch',
  'frames.reorder',
  'frames.select',
  'onion-skin.set',
])
const INTERNAL_COMMAND_TYPES = new Set(['pixels.restore', 'layers.restore', 'frames.restore'])
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{8}$/

const DEFAULT_PALETTE = Object.freeze([
  Object.freeze({ id: 'ink', name: 'Ink', color: '#171821FF' }),
  Object.freeze({ id: 'paper', name: 'Paper', color: '#F4EBD7FF' }),
  Object.freeze({ id: 'ember', name: 'Ember', color: '#E66B4DFF' }),
  Object.freeze({ id: 'aether', name: 'Aether', color: '#65B8C9FF' }),
  Object.freeze({ id: 'violet', name: 'Violet', color: '#7A64B8FF' }),
])

export class PixelContractError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'PixelContractError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

function fail(code, message, details) {
  throw new PixelContractError(code, message, details)
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertRecord(value, path) {
  if (!isRecord(value)) fail('INVALID_OBJECT', `${path} must be an object`, { path })
  return value
}

function assertKnownFields(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('UNKNOWN_FIELD', `${path}.${key} is not allowed`, { path: `${path}.${key}` })
  }
}

function assertString(value, path, { min = 1, max = 120 } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    fail('INVALID_STRING', `${path} must contain ${min}-${max} characters`, { path })
  }
  return value
}

function assertId(value, path) {
  assertString(value, path, { min: 1, max: 64 })
  if (!ID_PATTERN.test(value)) fail('INVALID_ID', `${path} is not a safe identifier`, { path })
  return value
}

function assertInteger(value, path, { min, max }) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('INVALID_INTEGER', `${path} must be an integer between ${min} and ${max}`, { path })
  }
  return value
}

function assertNumber(value, path, { min, max }) {
  if (!Number.isFinite(value) || value < min || value > max) {
    fail('INVALID_NUMBER', `${path} must be between ${min} and ${max}`, { path })
  }
  return value
}

function assertBoolean(value, path) {
  if (typeof value !== 'boolean') fail('INVALID_BOOLEAN', `${path} must be boolean`, { path })
  return value
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

function assertUniqueIds(items, path) {
  const seen = new Set()
  for (const item of items) {
    if (seen.has(item.id)) fail('DUPLICATE_ID', `${path} contains duplicate id ${item.id}`, { path, id: item.id })
    seen.add(item.id)
  }
  return seen
}

function assertPaletteColor(input, path) {
  const color = assertRecord(input, path)
  assertKnownFields(color, PALETTE_FIELDS, path)
  assertId(color.id, `${path}.id`)
  assertString(color.name, `${path}.name`, { min: 1, max: 48 })
  if (typeof color.color !== 'string' || !HEX_COLOR_PATTERN.test(color.color)) {
    fail('INVALID_COLOR', `${path}.color must use #RRGGBBAA`, { path: `${path}.color` })
  }
  return color
}

function assertLayer(input, path) {
  const layer = assertRecord(input, path)
  assertKnownFields(layer, LAYER_FIELDS, path)
  assertId(layer.id, `${path}.id`)
  assertString(layer.name, `${path}.name`, { min: 1, max: 80 })
  assertBoolean(layer.visible, `${path}.visible`)
  assertBoolean(layer.locked, `${path}.locked`)
  assertNumber(layer.opacity, `${path}.opacity`, { min: 0, max: 1 })
  return layer
}

function assertOnionSkin(input, path = 'document.onionSkin') {
  const onionSkin = assertRecord(input, path)
  assertKnownFields(onionSkin, ONION_FIELDS, path)
  assertBoolean(onionSkin.enabled, `${path}.enabled`)
  assertInteger(onionSkin.previousFrames, `${path}.previousFrames`, { min: 0, max: 8 })
  assertInteger(onionSkin.nextFrames, `${path}.nextFrames`, { min: 0, max: 8 })
  assertNumber(onionSkin.opacity, `${path}.opacity`, { min: 0, max: 1 })
  return onionSkin
}

function assertPixelArray(pixels, pixelCount, paletteIds, path) {
  if (!Array.isArray(pixels) || pixels.length !== pixelCount) {
    fail('INVALID_CEL', `${path} must contain exactly ${pixelCount} pixels`, { path })
  }
  for (let index = 0; index < pixels.length; index += 1) {
    const colorId = pixels[index]
    if (colorId !== null && (typeof colorId !== 'string' || !paletteIds.has(colorId))) {
      fail('UNKNOWN_COLOR', `${path}[${index}] references an unknown palette color`, { path, index, colorId })
    }
  }
}

export function assertPixelDocument(input) {
  const document = assertRecord(input, 'document')
  assertKnownFields(document, DOCUMENT_FIELDS, 'document')
  if (document.kind !== PIXEL_DOCUMENT_KIND) {
    fail('INVALID_KIND', `document.kind must be ${PIXEL_DOCUMENT_KIND}`, { path: 'document.kind' })
  }
  if (document.schemaVersion !== PIXEL_DOCUMENT_SCHEMA_VERSION) {
    fail('UNSUPPORTED_SCHEMA', `Unsupported pixel document schema ${String(document.schemaVersion)}`)
  }
  assertId(document.id, 'document.id')
  assertString(document.name, 'document.name', { min: 1, max: 120 })
  assertInteger(document.width, 'document.width', { min: 1, max: PIXEL_LIMITS.maxWidth })
  assertInteger(document.height, 'document.height', { min: 1, max: PIXEL_LIMITS.maxHeight })
  assertInteger(document.revision, 'document.revision', { min: 0, max: Number.MAX_SAFE_INTEGER })

  if (!Array.isArray(document.palette) || document.palette.length < 1 || document.palette.length > PIXEL_LIMITS.maxPaletteColors) {
    fail('INVALID_PALETTE', `document.palette must contain 1-${PIXEL_LIMITS.maxPaletteColors} colors`)
  }
  document.palette.forEach((color, index) => assertPaletteColor(color, `document.palette[${index}]`))
  const paletteIds = assertUniqueIds(document.palette, 'document.palette')

  if (!Array.isArray(document.layers) || document.layers.length < 1 || document.layers.length > PIXEL_LIMITS.maxLayers) {
    fail('INVALID_LAYERS', `document.layers must contain 1-${PIXEL_LIMITS.maxLayers} layers`)
  }
  document.layers.forEach((layer, index) => assertLayer(layer, `document.layers[${index}]`))
  const layerIds = assertUniqueIds(document.layers, 'document.layers')
  if (!layerIds.has(document.activeLayerId)) {
    fail('UNKNOWN_LAYER', 'document.activeLayerId must reference an existing layer', { layerId: document.activeLayerId })
  }

  if (!Array.isArray(document.frames) || document.frames.length < 1 || document.frames.length > PIXEL_LIMITS.maxFrames) {
    fail('INVALID_FRAMES', `document.frames must contain 1-${PIXEL_LIMITS.maxFrames} frames`)
  }
  const pixelCount = document.width * document.height
  const totalCells = pixelCount * document.layers.length * document.frames.length
  if (totalCells > PIXEL_LIMITS.maxDocumentCells) {
    fail('DOCUMENT_TOO_LARGE', `Pixel document contains ${totalCells} cells`, { totalCells, limit: PIXEL_LIMITS.maxDocumentCells })
  }
  document.frames.forEach((frameInput, frameIndex) => {
    const path = `document.frames[${frameIndex}]`
    const frame = assertRecord(frameInput, path)
    assertKnownFields(frame, FRAME_FIELDS, path)
    assertId(frame.id, `${path}.id`)
    assertString(frame.name, `${path}.name`, { min: 1, max: 80 })
    assertInteger(frame.durationMs, `${path}.durationMs`, { min: 20, max: 60_000 })
    const cels = assertRecord(frame.cels, `${path}.cels`)
    for (const key of Object.keys(cels)) {
      if (!layerIds.has(key)) fail('UNKNOWN_LAYER', `${path}.cels.${key} references an unknown layer`, { layerId: key })
    }
    for (const layerId of layerIds) {
      if (!(layerId in cels)) fail('MISSING_CEL', `${path}.cels is missing layer ${layerId}`, { layerId })
      assertPixelArray(cels[layerId], pixelCount, paletteIds, `${path}.cels.${layerId}`)
    }
  })
  const frameIds = assertUniqueIds(document.frames, 'document.frames')
  if (!frameIds.has(document.activeFrameId)) {
    fail('UNKNOWN_FRAME', 'document.activeFrameId must reference an existing frame', { frameId: document.activeFrameId })
  }
  assertOnionSkin(document.onionSkin)
  return document
}

export function createBlankPixelArray(width, height) {
  assertInteger(width, 'width', { min: 1, max: PIXEL_LIMITS.maxWidth })
  assertInteger(height, 'height', { min: 1, max: PIXEL_LIMITS.maxHeight })
  return Array.from({ length: width * height }, () => null)
}

export function createPixelDocument(input = {}) {
  const options = assertRecord(input, 'input')
  assertKnownFields(options, new Set([
    'id', 'name', 'width', 'height', 'revision', 'palette', 'layers', 'frames',
    'activeLayerId', 'activeFrameId', 'onionSkin',
  ]), 'input')
  const width = options.width ?? 16
  const height = options.height ?? 16
  assertInteger(width, 'input.width', { min: 1, max: PIXEL_LIMITS.maxWidth })
  assertInteger(height, 'input.height', { min: 1, max: PIXEL_LIMITS.maxHeight })
  if (options.palette !== undefined && !Array.isArray(options.palette)) fail('INVALID_PALETTE', 'input.palette must be an array')
  if (options.layers !== undefined && !Array.isArray(options.layers)) fail('INVALID_LAYERS', 'input.layers must be an array')
  if (options.frames !== undefined && !Array.isArray(options.frames)) fail('INVALID_FRAMES', 'input.frames must be an array')
  const palette = options.palette === undefined ? DEFAULT_PALETTE : options.palette
  const layers = options.layers === undefined
    ? [{ id: 'layer-1', name: 'Ink', visible: true, locked: false, opacity: 1 }]
    : options.layers
  const frames = options.frames === undefined
    ? [{
        id: 'frame-1',
        name: 'Frame 1',
        durationMs: 120,
        cels: Object.fromEntries(layers.map((layer) => [layer.id, createBlankPixelArray(width, height)])),
      }]
    : options.frames
  const document = {
    kind: PIXEL_DOCUMENT_KIND,
    schemaVersion: PIXEL_DOCUMENT_SCHEMA_VERSION,
    id: options.id ?? 'pixel-document',
    name: options.name ?? 'Untitled sprite',
    width,
    height,
    revision: options.revision ?? 0,
    palette,
    layers,
    frames,
    activeLayerId: options.activeLayerId ?? layers[0]?.id,
    activeFrameId: options.activeFrameId ?? frames[0]?.id,
    onionSkin: options.onionSkin === undefined
      ? { enabled: true, previousFrames: 1, nextFrames: 1, opacity: 0.22 }
      : options.onionSkin,
  }
  assertPixelDocument(document)
  return cloneJson(document)
}

function migrateLegacyDocument(input) {
  const legacy = assertRecord(input, 'legacyDocument')
  assertKnownFields(legacy, new Set([
    'kind', 'schemaVersion', 'version', 'id', 'name', 'width', 'height',
    'palette', 'pixels', 'frameDurationMs',
  ]), 'legacyDocument')
  if (legacy.schemaVersion !== undefined && legacy.schemaVersion !== 0) {
    fail('UNSUPPORTED_SCHEMA', `Unsupported legacy schema ${String(legacy.schemaVersion)}`)
  }
  if (legacy.version !== undefined && legacy.version !== 0) {
    fail('UNSUPPORTED_SCHEMA', `Unsupported legacy version ${String(legacy.version)}`)
  }
  const width = assertInteger(legacy.width, 'legacyDocument.width', { min: 1, max: PIXEL_LIMITS.maxWidth })
  const height = assertInteger(legacy.height, 'legacyDocument.height', { min: 1, max: PIXEL_LIMITS.maxHeight })
  if (!Array.isArray(legacy.palette) || legacy.palette.length < 2 || legacy.palette.length > PIXEL_LIMITS.maxPaletteColors + 1) {
    fail('INVALID_PALETTE', 'legacyDocument.palette must include transparent plus at least one color')
  }
  if (legacy.palette[0] !== 'transparent') {
    fail('INVALID_PALETTE', 'legacyDocument.palette[0] must be transparent')
  }
  const palette = legacy.palette.slice(1).map((color, index) => {
    if (typeof color !== 'string' || !/^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(color)) {
      fail('INVALID_COLOR', `legacyDocument.palette[${index + 1}] is invalid`)
    }
    return {
      id: `color-${index + 1}`,
      name: `Color ${index + 1}`,
      color: color.length === 7 ? `${color}FF` : color,
    }
  })
  if (!Array.isArray(legacy.pixels) || legacy.pixels.length !== width * height) {
    fail('INVALID_CEL', `legacyDocument.pixels must contain exactly ${width * height} pixels`)
  }
  const pixels = legacy.pixels.map((value, index) => {
    if (value === null || value === '.' || value === '0' || value === 0) return null
    const paletteIndex = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
    if (!Number.isSafeInteger(paletteIndex) || paletteIndex < 1 || paletteIndex >= legacy.palette.length) {
      fail('UNKNOWN_COLOR', `legacyDocument.pixels[${index}] references an unknown palette index`, { index, value })
    }
    return `color-${paletteIndex}`
  })
  return createPixelDocument({
    id: legacy.id ?? 'migrated-pixel-document',
    name: legacy.name ?? 'Migrated sprite',
    width,
    height,
    palette,
    layers: [{ id: 'layer-1', name: 'Layer 1', visible: true, locked: false, opacity: 1 }],
    frames: [{
      id: 'frame-1',
      name: 'Frame 1',
      durationMs: legacy.frameDurationMs ?? 120,
      cels: { 'layer-1': pixels },
    }],
  })
}

export function migratePixelDocument(input) {
  if (isRecord(input) && input.schemaVersion === PIXEL_DOCUMENT_SCHEMA_VERSION) {
    assertPixelDocument(input)
    return cloneJson(input)
  }
  return migrateLegacyDocument(input)
}

export function serializePixelDocument(document, options = {}) {
  assertPixelDocument(document)
  const settings = assertRecord(options, 'options')
  assertKnownFields(settings, new Set(['pretty']), 'options')
  if (settings.pretty !== undefined) assertBoolean(settings.pretty, 'options.pretty')
  return JSON.stringify(document, null, settings.pretty ? 2 : 0)
}

export function deserializePixelDocument(serialized) {
  if (typeof serialized !== 'string') fail('INVALID_SERIALIZED_DOCUMENT', 'Serialized pixel document must be a string')
  let parsed
  try {
    parsed = JSON.parse(serialized)
  } catch (error) {
    fail('INVALID_JSON', 'Serialized pixel document is not valid JSON', { cause: String(error) })
  }
  return migratePixelDocument(parsed)
}

export function clonePixelDocument(document) {
  assertPixelDocument(document)
  return cloneJson(document)
}

function assertPoint(input, path, document, { withColor = false, withValue = false } = {}) {
  const point = assertRecord(input, path)
  const allowed = new Set(['x', 'y'])
  if (withColor) allowed.add('colorId')
  if (withValue) allowed.add('value')
  assertKnownFields(point, allowed, path)
  assertInteger(point.x, `${path}.x`, { min: 0, max: document.width - 1 })
  assertInteger(point.y, `${path}.y`, { min: 0, max: document.height - 1 })
  if (withColor) {
    assertId(point.colorId, `${path}.colorId`)
    if (!document.palette.some((color) => color.id === point.colorId)) {
      fail('UNKNOWN_COLOR', `${path}.colorId references an unknown color`, { colorId: point.colorId })
    }
  }
  if (withValue && point.value !== null) {
    assertId(point.value, `${path}.value`)
    if (!document.palette.some((color) => color.id === point.value)) {
      fail('UNKNOWN_COLOR', `${path}.value references an unknown color`, { colorId: point.value })
    }
  }
  return point
}

function assertTarget(payload, document, path = 'command.payload') {
  assertId(payload.frameId, `${path}.frameId`)
  assertId(payload.layerId, `${path}.layerId`)
  const frame = document.frames.find((item) => item.id === payload.frameId)
  const layer = document.layers.find((item) => item.id === payload.layerId)
  if (!frame) fail('UNKNOWN_FRAME', `${path}.frameId references an unknown frame`, { frameId: payload.frameId })
  if (!layer) fail('UNKNOWN_LAYER', `${path}.layerId references an unknown layer`, { layerId: payload.layerId })
  return { frame, layer }
}

function assertPointList(points, path, document, mode) {
  if (!Array.isArray(points) || points.length < 1 || points.length > PIXEL_LIMITS.maxPixelsPerCommand) {
    fail('INVALID_PIXELS', `${path} must contain 1-${PIXEL_LIMITS.maxPixelsPerCommand} unique pixels`)
  }
  const seen = new Set()
  points.forEach((point, index) => {
    assertPoint(point, `${path}[${index}]`, document, mode)
    const key = `${point.x}:${point.y}`
    if (seen.has(key)) fail('DUPLICATE_PIXEL', `${path} contains duplicate coordinate ${key}`, { path, key })
    seen.add(key)
  })
}

function assertIndex(value, path, max) {
  return assertInteger(value, path, { min: 0, max })
}

function assertIdOrder(ids, expected, path) {
  if (!Array.isArray(ids) || ids.length !== expected.length) {
    fail('INVALID_ORDER', `${path} must contain every id exactly once`, { path })
  }
  const unique = new Set(ids)
  if (unique.size !== ids.length || ids.some((id) => typeof id !== 'string' || !expected.includes(id))) {
    fail('INVALID_ORDER', `${path} must contain every id exactly once`, { path })
  }
}

export function assertPixelCommand(input, documentInput) {
  const command = assertRecord(input, 'command')
  assertKnownFields(command, COMMAND_FIELDS, 'command')
  if (command.schemaVersion !== PIXEL_COMMAND_SCHEMA_VERSION) {
    fail('UNSUPPORTED_COMMAND_SCHEMA', `Unsupported pixel command schema ${String(command.schemaVersion)}`)
  }
  assertId(command.id, 'command.id')
  if (!ACTORS.has(command.actor)) fail('INVALID_ACTOR', `Unsupported pixel command actor ${String(command.actor)}`)
  if (!COMMAND_TYPES.has(command.type)) fail('UNKNOWN_COMMAND', `Unsupported pixel command type ${String(command.type)}`)
  assertInteger(command.baseRevision, 'command.baseRevision', { min: 0, max: Number.MAX_SAFE_INTEGER })
  const payload = assertRecord(command.payload, 'command.payload')
  if (INTERNAL_COMMAND_TYPES.has(command.type) && command.actor !== 'system') {
    fail('ACTOR_FORBIDDEN', `${command.type} is reserved for reversible system commands`)
  }
  if (documentInput === undefined) return command
  const document = assertPixelDocument(documentInput)

  switch (command.type) {
    case 'pixels.paint': {
      assertKnownFields(payload, new Set(['frameId', 'layerId', 'pixels']), 'command.payload')
      const { layer } = assertTarget(payload, document)
      if (layer.locked) fail('LAYER_LOCKED', `Layer ${layer.id} is locked`, { layerId: layer.id })
      assertPointList(payload.pixels, 'command.payload.pixels', document, { withColor: true })
      break
    }
    case 'pixels.erase': {
      assertKnownFields(payload, new Set(['frameId', 'layerId', 'pixels']), 'command.payload')
      const { layer } = assertTarget(payload, document)
      if (layer.locked) fail('LAYER_LOCKED', `Layer ${layer.id} is locked`, { layerId: layer.id })
      assertPointList(payload.pixels, 'command.payload.pixels', document, {})
      break
    }
    case 'pixels.restore': {
      assertKnownFields(payload, new Set(['frameId', 'layerId', 'pixels']), 'command.payload')
      assertTarget(payload, document)
      assertPointList(payload.pixels, 'command.payload.pixels', document, { withValue: true })
      break
    }
    case 'palette.replace': {
      assertKnownFields(payload, new Set(['colorId', 'color', 'name']), 'command.payload')
      assertId(payload.colorId, 'command.payload.colorId')
      if (!document.palette.some((color) => color.id === payload.colorId)) {
        fail('UNKNOWN_COLOR', 'command.payload.colorId references an unknown palette color', { colorId: payload.colorId })
      }
      if (typeof payload.color !== 'string' || !HEX_COLOR_PATTERN.test(payload.color)) {
        fail('INVALID_COLOR', 'command.payload.color must use #RRGGBBAA')
      }
      if (payload.name !== undefined) assertString(payload.name, 'command.payload.name', { min: 1, max: 48 })
      break
    }
    case 'layers.add': {
      assertKnownFields(payload, new Set(['layer', 'index']), 'command.payload')
      assertLayer(payload.layer, 'command.payload.layer')
      if (document.layers.some((layer) => layer.id === payload.layer.id)) fail('DUPLICATE_ID', `Layer ${payload.layer.id} already exists`)
      if (document.layers.length >= PIXEL_LIMITS.maxLayers) fail('LIMIT_EXCEEDED', 'Maximum layer count reached')
      if (payload.index !== undefined) assertIndex(payload.index, 'command.payload.index', document.layers.length)
      break
    }
    case 'layers.remove':
      assertKnownFields(payload, new Set(['layerId']), 'command.payload')
      assertId(payload.layerId, 'command.payload.layerId')
      if (!document.layers.some((layer) => layer.id === payload.layerId)) fail('UNKNOWN_LAYER', `Unknown layer ${payload.layerId}`)
      if (document.layers.length === 1) fail('LAST_LAYER', 'The last layer cannot be removed')
      break
    case 'layers.restore': {
      assertKnownFields(payload, new Set(['layer', 'index', 'cels', 'activeLayerId']), 'command.payload')
      assertLayer(payload.layer, 'command.payload.layer')
      if (document.layers.some((layer) => layer.id === payload.layer.id)) fail('DUPLICATE_ID', `Layer ${payload.layer.id} already exists`)
      assertIndex(payload.index, 'command.payload.index', document.layers.length)
      const cels = assertRecord(payload.cels, 'command.payload.cels')
      assertKnownFields(cels, new Set(document.frames.map((frame) => frame.id)), 'command.payload.cels')
      for (const frame of document.frames) {
        if (!(frame.id in cels)) fail('MISSING_CEL', `Missing restored cel for frame ${frame.id}`)
        assertPixelArray(cels[frame.id], document.width * document.height, new Set(document.palette.map((color) => color.id)), `command.payload.cels.${frame.id}`)
      }
      assertId(payload.activeLayerId, 'command.payload.activeLayerId')
      if (payload.activeLayerId !== payload.layer.id && !document.layers.some((layer) => layer.id === payload.activeLayerId)) {
        fail('UNKNOWN_LAYER', `Unknown restored active layer ${payload.activeLayerId}`)
      }
      break
    }
    case 'layers.patch': {
      assertKnownFields(payload, new Set(['layerId', 'patch']), 'command.payload')
      assertId(payload.layerId, 'command.payload.layerId')
      if (!document.layers.some((layer) => layer.id === payload.layerId)) fail('UNKNOWN_LAYER', `Unknown layer ${payload.layerId}`)
      const patch = assertRecord(payload.patch, 'command.payload.patch')
      assertKnownFields(patch, new Set(['name', 'visible', 'locked', 'opacity']), 'command.payload.patch')
      if (Object.keys(patch).length === 0) fail('EMPTY_PATCH', 'Layer patch must change at least one field')
      if (patch.name !== undefined) assertString(patch.name, 'command.payload.patch.name', { min: 1, max: 80 })
      if (patch.visible !== undefined) assertBoolean(patch.visible, 'command.payload.patch.visible')
      if (patch.locked !== undefined) assertBoolean(patch.locked, 'command.payload.patch.locked')
      if (patch.opacity !== undefined) assertNumber(patch.opacity, 'command.payload.patch.opacity', { min: 0, max: 1 })
      break
    }
    case 'layers.reorder':
      assertKnownFields(payload, new Set(['layerIds']), 'command.payload')
      assertIdOrder(payload.layerIds, document.layers.map((layer) => layer.id), 'command.payload.layerIds')
      break
    case 'layers.select':
      assertKnownFields(payload, new Set(['layerId']), 'command.payload')
      assertId(payload.layerId, 'command.payload.layerId')
      if (!document.layers.some((layer) => layer.id === payload.layerId)) fail('UNKNOWN_LAYER', `Unknown layer ${payload.layerId}`)
      break
    case 'frames.add': {
      assertKnownFields(payload, new Set(['frame', 'index', 'copyFromFrameId']), 'command.payload')
      const frame = assertRecord(payload.frame, 'command.payload.frame')
      assertKnownFields(frame, new Set(['id', 'name', 'durationMs']), 'command.payload.frame')
      assertId(frame.id, 'command.payload.frame.id')
      assertString(frame.name, 'command.payload.frame.name', { min: 1, max: 80 })
      assertInteger(frame.durationMs, 'command.payload.frame.durationMs', { min: 20, max: 60_000 })
      if (document.frames.some((item) => item.id === frame.id)) fail('DUPLICATE_ID', `Frame ${frame.id} already exists`)
      if (document.frames.length >= PIXEL_LIMITS.maxFrames) fail('LIMIT_EXCEEDED', 'Maximum frame count reached')
      if (payload.index !== undefined) assertIndex(payload.index, 'command.payload.index', document.frames.length)
      if (payload.copyFromFrameId !== undefined) {
        assertId(payload.copyFromFrameId, 'command.payload.copyFromFrameId')
        if (!document.frames.some((item) => item.id === payload.copyFromFrameId)) {
          fail('UNKNOWN_FRAME', `Unknown source frame ${payload.copyFromFrameId}`)
        }
      }
      break
    }
    case 'frames.remove':
      assertKnownFields(payload, new Set(['frameId']), 'command.payload')
      assertId(payload.frameId, 'command.payload.frameId')
      if (!document.frames.some((frame) => frame.id === payload.frameId)) fail('UNKNOWN_FRAME', `Unknown frame ${payload.frameId}`)
      if (document.frames.length === 1) fail('LAST_FRAME', 'The last frame cannot be removed')
      break
    case 'frames.restore': {
      assertKnownFields(payload, new Set(['frame', 'index', 'activeFrameId']), 'command.payload')
      const frame = assertRecord(payload.frame, 'command.payload.frame')
      assertKnownFields(frame, FRAME_FIELDS, 'command.payload.frame')
      if (document.frames.some((item) => item.id === frame.id)) fail('DUPLICATE_ID', `Frame ${frame.id} already exists`)
      assertIndex(payload.index, 'command.payload.index', document.frames.length)
      const temporary = { ...document, frames: [...document.frames, frame], activeFrameId: frame.id }
      assertPixelDocument(temporary)
      assertId(payload.activeFrameId, 'command.payload.activeFrameId')
      if (payload.activeFrameId !== frame.id && !document.frames.some((item) => item.id === payload.activeFrameId)) {
        fail('UNKNOWN_FRAME', `Unknown restored active frame ${payload.activeFrameId}`)
      }
      break
    }
    case 'frames.patch': {
      assertKnownFields(payload, new Set(['frameId', 'patch']), 'command.payload')
      assertId(payload.frameId, 'command.payload.frameId')
      if (!document.frames.some((frame) => frame.id === payload.frameId)) fail('UNKNOWN_FRAME', `Unknown frame ${payload.frameId}`)
      const patch = assertRecord(payload.patch, 'command.payload.patch')
      assertKnownFields(patch, new Set(['name', 'durationMs']), 'command.payload.patch')
      if (Object.keys(patch).length === 0) fail('EMPTY_PATCH', 'Frame patch must change at least one field')
      if (patch.name !== undefined) assertString(patch.name, 'command.payload.patch.name', { min: 1, max: 80 })
      if (patch.durationMs !== undefined) assertInteger(patch.durationMs, 'command.payload.patch.durationMs', { min: 20, max: 60_000 })
      break
    }
    case 'frames.reorder':
      assertKnownFields(payload, new Set(['frameIds']), 'command.payload')
      assertIdOrder(payload.frameIds, document.frames.map((frame) => frame.id), 'command.payload.frameIds')
      break
    case 'frames.select':
      assertKnownFields(payload, new Set(['frameId']), 'command.payload')
      assertId(payload.frameId, 'command.payload.frameId')
      if (!document.frames.some((frame) => frame.id === payload.frameId)) fail('UNKNOWN_FRAME', `Unknown frame ${payload.frameId}`)
      break
    case 'onion-skin.set': {
      assertKnownFields(payload, new Set(['patch']), 'command.payload')
      const patch = assertRecord(payload.patch, 'command.payload.patch')
      assertKnownFields(patch, ONION_FIELDS, 'command.payload.patch')
      if (Object.keys(patch).length === 0) fail('EMPTY_PATCH', 'Onion skin patch must change at least one field')
      assertOnionSkin({ ...document.onionSkin, ...patch }, 'command.payload.patch')
      break
    }
    default:
      fail('UNKNOWN_COMMAND', `Unsupported pixel command type ${command.type}`)
  }
  return command
}

export function createPixelCommand(document, type, payload, options = {}) {
  assertPixelDocument(document)
  assertRecord(payload, 'payload')
  const settings = assertRecord(options, 'options')
  assertKnownFields(settings, new Set(['id', 'actor']), 'options')
  const command = {
    schemaVersion: PIXEL_COMMAND_SCHEMA_VERSION,
    id: settings.id ?? `pixel-command-${document.revision + 1}`,
    actor: settings.actor ?? 'user',
    type,
    baseRevision: document.revision,
    payload,
  }
  assertPixelCommand(command, document)
  return { ...command, payload: cloneJson(payload) }
}

function makeInverse(command, nextRevision, type, payload) {
  return {
    schemaVersion: PIXEL_COMMAND_SCHEMA_VERSION,
    id: `pixel-inverse-${nextRevision}`,
    actor: 'system',
    type,
    baseRevision: nextRevision,
    payload,
  }
}

function pixelIndex(document, x, y) {
  return y * document.width + x
}

export function applyPixelCommand(documentInput, commandInput) {
  const document = assertPixelDocument(documentInput)
  const command = assertPixelCommand(commandInput, document)
  if (command.baseRevision !== document.revision) {
    fail('REVISION_CONFLICT', `Command revision ${command.baseRevision} does not match document revision ${document.revision}`, {
      expected: document.revision,
      received: command.baseRevision,
    })
  }
  const next = cloneJson(document)
  const payload = command.payload
  let inverseType
  let inversePayload

  switch (command.type) {
    case 'pixels.paint':
    case 'pixels.erase':
    case 'pixels.restore': {
      const frame = next.frames.find((item) => item.id === payload.frameId)
      const cel = frame.cels[payload.layerId]
      const previous = payload.pixels.map((point) => ({
        x: point.x,
        y: point.y,
        value: cel[pixelIndex(next, point.x, point.y)],
      }))
      for (const point of payload.pixels) {
        cel[pixelIndex(next, point.x, point.y)] = command.type === 'pixels.paint'
          ? point.colorId
          : command.type === 'pixels.erase'
            ? null
            : point.value
      }
      inverseType = 'pixels.restore'
      inversePayload = { frameId: payload.frameId, layerId: payload.layerId, pixels: previous }
      break
    }
    case 'palette.replace': {
      const color = next.palette.find((item) => item.id === payload.colorId)
      inverseType = 'palette.replace'
      inversePayload = { colorId: color.id, color: color.color, name: color.name }
      color.color = payload.color.toUpperCase()
      if (payload.name !== undefined) color.name = payload.name
      break
    }
    case 'layers.add': {
      const index = payload.index ?? next.layers.length
      next.layers.splice(index, 0, cloneJson(payload.layer))
      for (const frame of next.frames) frame.cels[payload.layer.id] = createBlankPixelArray(next.width, next.height)
      next.activeLayerId = payload.layer.id
      inverseType = 'layers.remove'
      inversePayload = { layerId: payload.layer.id }
      break
    }
    case 'layers.remove': {
      const index = next.layers.findIndex((layer) => layer.id === payload.layerId)
      const [layer] = next.layers.splice(index, 1)
      const cels = {}
      for (const frame of next.frames) {
        cels[frame.id] = frame.cels[payload.layerId]
        delete frame.cels[payload.layerId]
      }
      const previousActiveLayerId = next.activeLayerId
      if (next.activeLayerId === payload.layerId) {
        next.activeLayerId = next.layers[Math.min(index, next.layers.length - 1)].id
      }
      inverseType = 'layers.restore'
      inversePayload = { layer, index, cels, activeLayerId: previousActiveLayerId }
      break
    }
    case 'layers.restore': {
      next.layers.splice(payload.index, 0, cloneJson(payload.layer))
      for (const frame of next.frames) frame.cels[payload.layer.id] = cloneJson(payload.cels[frame.id])
      next.activeLayerId = payload.activeLayerId
      inverseType = 'layers.remove'
      inversePayload = { layerId: payload.layer.id }
      break
    }
    case 'layers.patch': {
      const layer = next.layers.find((item) => item.id === payload.layerId)
      const previous = Object.fromEntries(Object.keys(payload.patch).map((key) => [key, layer[key]]))
      Object.assign(layer, payload.patch)
      inverseType = 'layers.patch'
      inversePayload = { layerId: payload.layerId, patch: previous }
      break
    }
    case 'layers.reorder': {
      const previous = next.layers.map((layer) => layer.id)
      const byId = new Map(next.layers.map((layer) => [layer.id, layer]))
      next.layers = payload.layerIds.map((id) => byId.get(id))
      inverseType = 'layers.reorder'
      inversePayload = { layerIds: previous }
      break
    }
    case 'layers.select':
      inverseType = 'layers.select'
      inversePayload = { layerId: next.activeLayerId }
      next.activeLayerId = payload.layerId
      break
    case 'frames.add': {
      const index = payload.index ?? next.frames.length
      const source = payload.copyFromFrameId
        ? next.frames.find((frame) => frame.id === payload.copyFromFrameId)
        : null
      const cels = Object.fromEntries(next.layers.map((layer) => [
        layer.id,
        source ? cloneJson(source.cels[layer.id]) : createBlankPixelArray(next.width, next.height),
      ]))
      next.frames.splice(index, 0, { ...cloneJson(payload.frame), cels })
      next.activeFrameId = payload.frame.id
      inverseType = 'frames.remove'
      inversePayload = { frameId: payload.frame.id }
      break
    }
    case 'frames.remove': {
      const index = next.frames.findIndex((frame) => frame.id === payload.frameId)
      const [frame] = next.frames.splice(index, 1)
      const previousActiveFrameId = next.activeFrameId
      if (next.activeFrameId === payload.frameId) {
        next.activeFrameId = next.frames[Math.min(index, next.frames.length - 1)].id
      }
      inverseType = 'frames.restore'
      inversePayload = { frame, index, activeFrameId: previousActiveFrameId }
      break
    }
    case 'frames.restore':
      next.frames.splice(payload.index, 0, cloneJson(payload.frame))
      next.activeFrameId = payload.activeFrameId
      inverseType = 'frames.remove'
      inversePayload = { frameId: payload.frame.id }
      break
    case 'frames.patch': {
      const frame = next.frames.find((item) => item.id === payload.frameId)
      const previous = Object.fromEntries(Object.keys(payload.patch).map((key) => [key, frame[key]]))
      Object.assign(frame, payload.patch)
      inverseType = 'frames.patch'
      inversePayload = { frameId: payload.frameId, patch: previous }
      break
    }
    case 'frames.reorder': {
      const previous = next.frames.map((frame) => frame.id)
      const byId = new Map(next.frames.map((frame) => [frame.id, frame]))
      next.frames = payload.frameIds.map((id) => byId.get(id))
      inverseType = 'frames.reorder'
      inversePayload = { frameIds: previous }
      break
    }
    case 'frames.select':
      inverseType = 'frames.select'
      inversePayload = { frameId: next.activeFrameId }
      next.activeFrameId = payload.frameId
      break
    case 'onion-skin.set': {
      const previous = cloneJson(next.onionSkin)
      next.onionSkin = { ...next.onionSkin, ...payload.patch }
      inverseType = 'onion-skin.set'
      inversePayload = { patch: previous }
      break
    }
    default:
      fail('UNKNOWN_COMMAND', `Unsupported pixel command type ${command.type}`)
  }

  next.revision += 1
  assertPixelDocument(next)
  const inverse = makeInverse(command, next.revision, inverseType, inversePayload)
  assertPixelCommand(inverse, next)
  return { document: next, inverse }
}

function parseRgba(color) {
  return [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
    Number.parseInt(color.slice(7, 9), 16),
  ]
}

function blendPixel(output, offset, source, opacity) {
  const sourceAlpha = (source[3] / 255) * opacity
  if (sourceAlpha <= 0) return
  const destinationAlpha = output[offset + 3] / 255
  const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha)
  if (outputAlpha <= 0) return
  output[offset] = Math.round((source[0] * sourceAlpha + output[offset] * destinationAlpha * (1 - sourceAlpha)) / outputAlpha)
  output[offset + 1] = Math.round((source[1] * sourceAlpha + output[offset + 1] * destinationAlpha * (1 - sourceAlpha)) / outputAlpha)
  output[offset + 2] = Math.round((source[2] * sourceAlpha + output[offset + 2] * destinationAlpha * (1 - sourceAlpha)) / outputAlpha)
  output[offset + 3] = Math.round(outputAlpha * 255)
}

export function renderPixelFrameRgba(documentInput, frameId, options = {}) {
  const document = assertPixelDocument(documentInput)
  assertId(frameId, 'frameId')
  const settings = assertRecord(options, 'options')
  assertKnownFields(settings, new Set(['includeHiddenLayers']), 'options')
  if (settings.includeHiddenLayers !== undefined) assertBoolean(settings.includeHiddenLayers, 'options.includeHiddenLayers')
  const frame = document.frames.find((item) => item.id === frameId)
  if (!frame) fail('UNKNOWN_FRAME', `Unknown frame ${frameId}`)
  const colors = new Map(document.palette.map((color) => [color.id, parseRgba(color.color)]))
  const output = new Uint8ClampedArray(document.width * document.height * 4)
  for (const layer of document.layers) {
    if ((!layer.visible && !settings.includeHiddenLayers) || layer.opacity <= 0) continue
    const pixels = frame.cels[layer.id]
    for (let index = 0; index < pixels.length; index += 1) {
      const colorId = pixels[index]
      if (colorId === null) continue
      blendPixel(output, index * 4, colors.get(colorId), layer.opacity)
    }
  }
  return output
}

function readSpriteOptions(document, input) {
  const options = assertRecord(input, 'options')
  assertKnownFields(options, new Set(['columns', 'padding', 'spacing']), 'options')
  const columns = options.columns ?? Math.ceil(Math.sqrt(document.frames.length))
  const padding = options.padding ?? 0
  const spacing = options.spacing ?? 0
  assertInteger(columns, 'options.columns', { min: 1, max: document.frames.length })
  assertInteger(padding, 'options.padding', { min: 0, max: 256 })
  assertInteger(spacing, 'options.spacing', { min: 0, max: 256 })
  return { columns, padding, spacing }
}

export function createSpriteSheetLayout(documentInput, options = {}) {
  const document = assertPixelDocument(documentInput)
  const { columns, padding, spacing } = readSpriteOptions(document, options)
  const rows = Math.ceil(document.frames.length / columns)
  const width = padding * 2 + columns * document.width + Math.max(0, columns - 1) * spacing
  const height = padding * 2 + rows * document.height + Math.max(0, rows - 1) * spacing
  if (width > 32_768 || height > 32_768) {
    fail('SPRITE_TOO_LARGE', `Sprite sheet dimensions ${width}x${height} exceed 32768px`)
  }
  const cells = document.frames.map((frame, index) => {
    const column = index % columns
    const row = Math.floor(index / columns)
    return {
      frameId: frame.id,
      index,
      column,
      row,
      x: padding + column * (document.width + spacing),
      y: padding + row * (document.height + spacing),
      width: document.width,
      height: document.height,
      durationMs: frame.durationMs,
    }
  })
  return { width, height, columns, rows, padding, spacing, cells }
}

export function createSpriteSheetMetadata(documentInput, options = {}) {
  const document = assertPixelDocument(documentInput)
  const layout = createSpriteSheetLayout(document, options)
  return {
    schemaVersion: 1,
    kind: 'aeonquill.sprite-sheet',
    sourceDocumentId: document.id,
    sourceRevision: document.revision,
    width: layout.width,
    height: layout.height,
    columns: layout.columns,
    rows: layout.rows,
    padding: layout.padding,
    spacing: layout.spacing,
    frames: layout.cells.map((cell) => ({ ...cell })),
    palette: cloneJson(document.palette),
  }
}

export function renderSpriteSheetRgba(documentInput, options = {}) {
  const document = assertPixelDocument(documentInput)
  const layout = createSpriteSheetLayout(document, options)
  const totalPixels = layout.width * layout.height
  if (totalPixels > PIXEL_LIMITS.maxSpritePixels) {
    fail('SPRITE_TOO_LARGE', `Sprite sheet contains ${totalPixels} pixels`, { totalPixels, limit: PIXEL_LIMITS.maxSpritePixels })
  }
  const pixels = new Uint8ClampedArray(totalPixels * 4)
  for (const cell of layout.cells) {
    const framePixels = renderPixelFrameRgba(document, cell.frameId)
    for (let y = 0; y < document.height; y += 1) {
      const sourceStart = y * document.width * 4
      const destinationStart = ((cell.y + y) * layout.width + cell.x) * 4
      pixels.set(framePixels.subarray(sourceStart, sourceStart + document.width * 4), destinationStart)
    }
  }
  return {
    pixels,
    layout,
    metadata: createSpriteSheetMetadata(document, options),
  }
}
