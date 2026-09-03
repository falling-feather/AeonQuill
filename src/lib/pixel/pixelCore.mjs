export const PIXEL_DOCUMENT_KIND = 'aeonquill.pixel-document'
export const PIXEL_DOCUMENT_SCHEMA_VERSION = 7
export const PIXEL_COMMAND_SCHEMA_VERSION = 1

export const PIXEL_LIMITS = Object.freeze({
  maxWidth: 512,
  maxHeight: 512,
  maxPaletteColors: 256,
  maxLayers: 64,
  maxLayerGroups: 32,
  maxFrames: 256,
  maxAnimationTags: 64,
  maxPaletteCycles: 16,
  maxPaletteCycleColors: 32,
  maxAnimationEvents: 256,
  maxCollisionShapesPerFrame: 8,
  maxTerrainMaps: 16,
  maxTerrainMapWidth: 64,
  maxTerrainMapHeight: 64,
  maxTerrainMapCells: 4_096,
  maxDocumentCells: 16_777_216,
  maxPixelsPerCommand: 65_536,
  maxBulkCellsPerCommand: 1_048_576,
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
  'paletteCycles',
  'layerGroups',
  'layers',
  'frames',
  'animationTags',
  'animationEvents',
  'terrainMaps',
  'activeLayerId',
  'activeFrameId',
  'onionSkin',
])
const PALETTE_FIELDS = new Set(['id', 'name', 'color'])
const PALETTE_CYCLE_FIELDS = new Set(['id', 'name', 'colorIds', 'stepDurationMs', 'direction', 'enabled'])
const LAYER_GROUP_FIELDS = new Set(['id', 'name', 'visible', 'locked'])
const LAYER_FIELDS = new Set(['id', 'name', 'visible', 'locked', 'opacity', 'groupId', 'blendMode'])
const FRAME_FIELDS = new Set(['id', 'name', 'durationMs', 'cels', 'gameplay'])
const FRAME_GAMEPLAY_FIELDS = new Set(['anchor', 'collisions', 'tileRule'])
const ANCHOR_FIELDS = new Set(['x', 'y'])
const COLLISION_FIELDS = new Set(['id', 'name', 'type', 'x', 'y', 'width', 'height'])
const TILE_RULE_FIELDS = new Set(['terrainId', 'bitmask'])
const TERRAIN_MAP_FIELDS = new Set(['id', 'name', 'width', 'height', 'cells'])
const SCHEMA_SIX_TERRAIN_MAP_FIELDS = new Set(['id', 'name', 'terrainId', 'width', 'height', 'occupancy'])
const ANIMATION_TAG_FIELDS = new Set(['id', 'name', 'fromFrameId', 'toFrameId', 'direction', 'loop'])
const ANIMATION_EVENT_FIELDS = new Set(['id', 'name', 'type', 'animationTagId', 'frameId', 'value'])
const ONION_FIELDS = new Set(['enabled', 'previousFrames', 'nextFrames', 'opacity'])
const COMMAND_FIELDS = new Set(['schemaVersion', 'id', 'actor', 'type', 'baseRevision', 'payload'])
const ACTORS = new Set(['user', 'tool', 'agent', 'system'])
const COMMAND_TYPES = new Set([
  'pixels.paint',
  'pixels.erase',
  'pixels.patch',
  'pixels.restore',
  'palette.replace',
  'palette-cycles.add',
  'palette-cycles.remove',
  'palette-cycles.restore',
  'palette-cycles.patch',
  'groups.add',
  'groups.remove',
  'groups.restore',
  'groups.patch',
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
  'frames.duration.set',
  'frames.reorder',
  'frames.select',
  'cels.copy',
  'cels.restore',
  'animations.add',
  'animations.remove',
  'animations.restore',
  'animations.patch',
  'animation-events.add',
  'animation-events.remove',
  'animation-events.restore',
  'animation-events.patch',
  'terrain-maps.add',
  'terrain-maps.remove',
  'terrain-maps.restore',
  'terrain-maps.patch',
  'terrain-maps.resize',
  'terrain-maps.restore-shape',
  'terrain-maps.cells.patch',
  'onion-skin.set',
])
const INTERNAL_COMMAND_TYPES = new Set([
  'pixels.restore',
  'palette-cycles.restore',
  'groups.restore',
  'layers.restore',
  'frames.restore',
  'cels.restore',
  'animations.restore',
  'animation-events.restore',
  'terrain-maps.restore',
  'terrain-maps.restore-shape',
])
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{8}$/
const ANIMATION_DIRECTIONS = new Set(['forward', 'reverse', 'ping-pong'])
export const PIXEL_PALETTE_CYCLE_DIRECTIONS = Object.freeze(['forward', 'reverse', 'ping-pong'])
const PIXEL_PALETTE_CYCLE_DIRECTION_SET = new Set(PIXEL_PALETTE_CYCLE_DIRECTIONS)
export const PIXEL_ANIMATION_EVENT_TYPES = Object.freeze(['marker', 'sfx', 'hit', 'custom'])
const PIXEL_ANIMATION_EVENT_TYPE_SET = new Set(PIXEL_ANIMATION_EVENT_TYPES)
export const PIXEL_BLEND_MODES = Object.freeze(['normal', 'multiply', 'screen', 'add'])
const PIXEL_BLEND_MODE_SET = new Set(PIXEL_BLEND_MODES)
export const PIXEL_COLLISION_TYPES = Object.freeze(['solid', 'hitbox', 'hurtbox', 'interaction'])
const PIXEL_COLLISION_TYPE_SET = new Set(PIXEL_COLLISION_TYPES)
export const PIXEL_TILE_NEIGHBORS = Object.freeze([
  Object.freeze({ id: 'north', label: '北', bit: 1 }),
  Object.freeze({ id: 'north-east', label: '东北', bit: 2 }),
  Object.freeze({ id: 'east', label: '东', bit: 4 }),
  Object.freeze({ id: 'south-east', label: '东南', bit: 8 }),
  Object.freeze({ id: 'south', label: '南', bit: 16 }),
  Object.freeze({ id: 'south-west', label: '西南', bit: 32 }),
  Object.freeze({ id: 'west', label: '西', bit: 64 }),
  Object.freeze({ id: 'north-west', label: '西北', bit: 128 }),
])

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

function assertUniqueStringList(values, path, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Array.isArray(values) || values.length < min || values.length > max) {
    fail('INVALID_LIST', `${path} must contain ${min}-${max} unique ids`, { path })
  }
  const seen = new Set()
  values.forEach((value, index) => {
    assertId(value, `${path}[${index}]`)
    if (seen.has(value)) fail('DUPLICATE_ID', `${path} contains duplicate id ${value}`, { path, id: value })
    seen.add(value)
  })
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

function assertPaletteCycle(input, path, paletteIds, claimedColorIds = new Map()) {
  const cycle = assertRecord(input, path)
  assertKnownFields(cycle, PALETTE_CYCLE_FIELDS, path)
  assertId(cycle.id, `${path}.id`)
  assertString(cycle.name, `${path}.name`, { min: 1, max: 64 })
  const colorIds = assertUniqueStringList(cycle.colorIds, `${path}.colorIds`, {
    min: 2,
    max: PIXEL_LIMITS.maxPaletteCycleColors,
  })
  for (const colorId of colorIds) {
    if (!paletteIds.has(colorId)) {
      fail('UNKNOWN_COLOR', `${path}.colorIds references an unknown palette color`, { colorId })
    }
    const owner = claimedColorIds.get(colorId)
    if (owner !== undefined && owner !== cycle.id) {
      fail('PALETTE_CYCLE_CONFLICT', `${path}.colorIds reuses color ${colorId} from cycle ${owner}`, {
        colorId,
        cycleId: cycle.id,
        owner,
      })
    }
    claimedColorIds.set(colorId, cycle.id)
  }
  assertInteger(cycle.stepDurationMs, `${path}.stepDurationMs`, { min: 20, max: 60_000 })
  if (!PIXEL_PALETTE_CYCLE_DIRECTION_SET.has(cycle.direction)) {
    fail('INVALID_PALETTE_CYCLE_DIRECTION', `${path}.direction is unsupported`, { direction: cycle.direction })
  }
  assertBoolean(cycle.enabled, `${path}.enabled`)
  return cycle
}

function assertLayerGroup(input, path) {
  const group = assertRecord(input, path)
  assertKnownFields(group, LAYER_GROUP_FIELDS, path)
  assertId(group.id, `${path}.id`)
  assertString(group.name, `${path}.name`, { min: 1, max: 80 })
  assertBoolean(group.visible, `${path}.visible`)
  assertBoolean(group.locked, `${path}.locked`)
  return group
}

function assertLayer(input, path, groupIds) {
  const layer = assertRecord(input, path)
  assertKnownFields(layer, LAYER_FIELDS, path)
  assertId(layer.id, `${path}.id`)
  assertString(layer.name, `${path}.name`, { min: 1, max: 80 })
  assertBoolean(layer.visible, `${path}.visible`)
  assertBoolean(layer.locked, `${path}.locked`)
  assertNumber(layer.opacity, `${path}.opacity`, { min: 0, max: 1 })
  if (layer.groupId !== null) {
    assertId(layer.groupId, `${path}.groupId`)
    if (groupIds && !groupIds.has(layer.groupId)) {
      fail('UNKNOWN_LAYER_GROUP', `${path}.groupId references an unknown layer group`, { groupId: layer.groupId })
    }
  }
  if (!PIXEL_BLEND_MODE_SET.has(layer.blendMode)) {
    fail('INVALID_BLEND_MODE', `${path}.blendMode is unsupported`, { blendMode: layer.blendMode })
  }
  return layer
}

export function createDefaultPixelFrameGameplay(width, height) {
  assertInteger(width, 'width', { min: 1, max: PIXEL_LIMITS.maxWidth })
  assertInteger(height, 'height', { min: 1, max: PIXEL_LIMITS.maxHeight })
  return {
    anchor: { x: Math.floor(width / 2), y: height },
    collisions: [],
    tileRule: null,
  }
}

function assertFrameGameplay(input, path, documentWidth, documentHeight) {
  const gameplay = assertRecord(input, path)
  assertKnownFields(gameplay, FRAME_GAMEPLAY_FIELDS, path)
  const anchor = assertRecord(gameplay.anchor, `${path}.anchor`)
  assertKnownFields(anchor, ANCHOR_FIELDS, `${path}.anchor`)
  assertInteger(anchor.x, `${path}.anchor.x`, { min: 0, max: documentWidth })
  assertInteger(anchor.y, `${path}.anchor.y`, { min: 0, max: documentHeight })

  if (!Array.isArray(gameplay.collisions) || gameplay.collisions.length > PIXEL_LIMITS.maxCollisionShapesPerFrame) {
    fail('INVALID_COLLISIONS', `${path}.collisions must contain 0-${PIXEL_LIMITS.maxCollisionShapesPerFrame} shapes`)
  }
  gameplay.collisions.forEach((collisionInput, index) => {
    const collisionPath = `${path}.collisions[${index}]`
    const collision = assertRecord(collisionInput, collisionPath)
    assertKnownFields(collision, COLLISION_FIELDS, collisionPath)
    assertId(collision.id, `${collisionPath}.id`)
    assertString(collision.name, `${collisionPath}.name`, { min: 1, max: 48 })
    if (!PIXEL_COLLISION_TYPE_SET.has(collision.type)) {
      fail('INVALID_COLLISION_TYPE', `${collisionPath}.type is unsupported`, { type: collision.type })
    }
    const x = assertInteger(collision.x, `${collisionPath}.x`, { min: 0, max: documentWidth - 1 })
    const y = assertInteger(collision.y, `${collisionPath}.y`, { min: 0, max: documentHeight - 1 })
    assertInteger(collision.width, `${collisionPath}.width`, { min: 1, max: documentWidth - x })
    assertInteger(collision.height, `${collisionPath}.height`, { min: 1, max: documentHeight - y })
  })
  assertUniqueIds(gameplay.collisions, `${path}.collisions`)

  if (gameplay.tileRule !== null) {
    const tileRule = assertRecord(gameplay.tileRule, `${path}.tileRule`)
    assertKnownFields(tileRule, TILE_RULE_FIELDS, `${path}.tileRule`)
    assertId(tileRule.terrainId, `${path}.tileRule.terrainId`)
    assertInteger(tileRule.bitmask, `${path}.tileRule.bitmask`, { min: 0, max: 255 })
  }
  return gameplay
}

function assertTerrainMap(input, path) {
  const terrainMap = assertRecord(input, path)
  assertKnownFields(terrainMap, TERRAIN_MAP_FIELDS, path)
  assertId(terrainMap.id, `${path}.id`)
  assertString(terrainMap.name, `${path}.name`, { min: 1, max: 80 })
  const width = assertInteger(terrainMap.width, `${path}.width`, {
    min: 1,
    max: PIXEL_LIMITS.maxTerrainMapWidth,
  })
  const height = assertInteger(terrainMap.height, `${path}.height`, {
    min: 1,
    max: PIXEL_LIMITS.maxTerrainMapHeight,
  })
  const cellCount = width * height
  if (cellCount > PIXEL_LIMITS.maxTerrainMapCells) {
    fail('TERRAIN_MAP_TOO_LARGE', `${path} contains ${cellCount} cells`, {
      cellCount,
      limit: PIXEL_LIMITS.maxTerrainMapCells,
    })
  }
  if (!Array.isArray(terrainMap.cells) || terrainMap.cells.length !== cellCount) {
    fail('INVALID_TERRAIN_CELLS', `${path}.cells must contain exactly ${cellCount} terrain ids or null values`, {
      path: `${path}.cells`,
    })
  }
  terrainMap.cells.forEach((terrainId, index) => {
    if (terrainId !== null) assertId(terrainId, `${path}.cells[${index}]`)
  })
  return terrainMap
}

function assertSchemaSixTerrainMap(input, path) {
  const terrainMap = assertRecord(input, path)
  assertKnownFields(terrainMap, SCHEMA_SIX_TERRAIN_MAP_FIELDS, path)
  assertId(terrainMap.id, `${path}.id`)
  assertString(terrainMap.name, `${path}.name`, { min: 1, max: 80 })
  assertId(terrainMap.terrainId, `${path}.terrainId`)
  const width = assertInteger(terrainMap.width, `${path}.width`, {
    min: 1,
    max: PIXEL_LIMITS.maxTerrainMapWidth,
  })
  const height = assertInteger(terrainMap.height, `${path}.height`, {
    min: 1,
    max: PIXEL_LIMITS.maxTerrainMapHeight,
  })
  const cellCount = width * height
  if (cellCount > PIXEL_LIMITS.maxTerrainMapCells) {
    fail('TERRAIN_MAP_TOO_LARGE', `${path} contains ${cellCount} cells`, {
      cellCount,
      limit: PIXEL_LIMITS.maxTerrainMapCells,
    })
  }
  if (!Array.isArray(terrainMap.occupancy) || terrainMap.occupancy.length !== cellCount) {
    fail('INVALID_TERRAIN_OCCUPANCY', `${path}.occupancy must contain exactly ${cellCount} cells`)
  }
  terrainMap.occupancy.forEach((occupied, index) => assertBoolean(occupied, `${path}.occupancy[${index}]`))
  return terrainMap
}

function assertAnimationTag(input, path, frameIds, frameOrder) {
  const tag = assertRecord(input, path)
  assertKnownFields(tag, ANIMATION_TAG_FIELDS, path)
  assertId(tag.id, `${path}.id`)
  assertString(tag.name, `${path}.name`, { min: 1, max: 80 })
  assertId(tag.fromFrameId, `${path}.fromFrameId`)
  assertId(tag.toFrameId, `${path}.toFrameId`)
  if (!frameIds.has(tag.fromFrameId)) fail('UNKNOWN_FRAME', `${path}.fromFrameId references an unknown frame`, { frameId: tag.fromFrameId })
  if (!frameIds.has(tag.toFrameId)) fail('UNKNOWN_FRAME', `${path}.toFrameId references an unknown frame`, { frameId: tag.toFrameId })
  if (frameOrder.get(tag.fromFrameId) > frameOrder.get(tag.toFrameId)) {
    fail('INVALID_ANIMATION_RANGE', `${path} must run from an earlier frame to a later frame`, {
      fromFrameId: tag.fromFrameId,
      toFrameId: tag.toFrameId,
    })
  }
  if (!ANIMATION_DIRECTIONS.has(tag.direction)) {
    fail('INVALID_ANIMATION_DIRECTION', `${path}.direction is unsupported`, { direction: tag.direction })
  }
  assertBoolean(tag.loop, `${path}.loop`)
  return tag
}

function assertAnimationEvent(input, path, animationTagsById, frameIds, frameOrder) {
  const event = assertRecord(input, path)
  assertKnownFields(event, ANIMATION_EVENT_FIELDS, path)
  assertId(event.id, `${path}.id`)
  assertString(event.name, `${path}.name`, { min: 1, max: 64 })
  if (!PIXEL_ANIMATION_EVENT_TYPE_SET.has(event.type)) {
    fail('INVALID_ANIMATION_EVENT_TYPE', `${path}.type is unsupported`, { type: event.type })
  }
  assertId(event.animationTagId, `${path}.animationTagId`)
  const tag = animationTagsById.get(event.animationTagId)
  if (!tag) {
    fail('UNKNOWN_ANIMATION_TAG', `${path}.animationTagId references an unknown animation tag`, {
      tagId: event.animationTagId,
    })
  }
  assertId(event.frameId, `${path}.frameId`)
  if (!frameIds.has(event.frameId)) {
    fail('UNKNOWN_FRAME', `${path}.frameId references an unknown frame`, { frameId: event.frameId })
  }
  const frameIndex = frameOrder.get(event.frameId)
  if (frameIndex < frameOrder.get(tag.fromFrameId) || frameIndex > frameOrder.get(tag.toFrameId)) {
    fail('EVENT_OUTSIDE_ANIMATION', `${path}.frameId must stay inside animation ${tag.id}`, {
      frameId: event.frameId,
      tagId: tag.id,
    })
  }
  assertString(event.value, `${path}.value`, { min: 0, max: 160 })
  return event
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

  if (!Array.isArray(document.paletteCycles) || document.paletteCycles.length > PIXEL_LIMITS.maxPaletteCycles) {
    fail('INVALID_PALETTE_CYCLES', `document.paletteCycles must contain 0-${PIXEL_LIMITS.maxPaletteCycles} cycles`)
  }
  const claimedCycleColors = new Map()
  document.paletteCycles.forEach((cycle, index) => assertPaletteCycle(
    cycle,
    `document.paletteCycles[${index}]`,
    paletteIds,
    claimedCycleColors,
  ))
  assertUniqueIds(document.paletteCycles, 'document.paletteCycles')

  if (!Array.isArray(document.layerGroups) || document.layerGroups.length > PIXEL_LIMITS.maxLayerGroups) {
    fail('INVALID_LAYER_GROUPS', `document.layerGroups must contain 0-${PIXEL_LIMITS.maxLayerGroups} groups`)
  }
  document.layerGroups.forEach((group, index) => assertLayerGroup(group, `document.layerGroups[${index}]`))
  const groupIds = assertUniqueIds(document.layerGroups, 'document.layerGroups')

  if (!Array.isArray(document.layers) || document.layers.length < 1 || document.layers.length > PIXEL_LIMITS.maxLayers) {
    fail('INVALID_LAYERS', `document.layers must contain 1-${PIXEL_LIMITS.maxLayers} layers`)
  }
  document.layers.forEach((layer, index) => assertLayer(layer, `document.layers[${index}]`, groupIds))
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
    assertFrameGameplay(frame.gameplay, `${path}.gameplay`, document.width, document.height)
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
  if (!Array.isArray(document.animationTags) || document.animationTags.length > PIXEL_LIMITS.maxAnimationTags) {
    fail('INVALID_ANIMATION_TAGS', `document.animationTags must contain 0-${PIXEL_LIMITS.maxAnimationTags} tags`)
  }
  const frameOrder = new Map(document.frames.map((frame, index) => [frame.id, index]))
  document.animationTags.forEach((tag, index) => assertAnimationTag(
    tag,
    `document.animationTags[${index}]`,
    frameIds,
    frameOrder,
  ))
  assertUniqueIds(document.animationTags, 'document.animationTags')
  const animationTagsById = new Map(document.animationTags.map((tag) => [tag.id, tag]))
  if (!Array.isArray(document.animationEvents) || document.animationEvents.length > PIXEL_LIMITS.maxAnimationEvents) {
    fail('INVALID_ANIMATION_EVENTS', `document.animationEvents must contain 0-${PIXEL_LIMITS.maxAnimationEvents} events`)
  }
  document.animationEvents.forEach((event, index) => assertAnimationEvent(
    event,
    `document.animationEvents[${index}]`,
    animationTagsById,
    frameIds,
    frameOrder,
  ))
  assertUniqueIds(document.animationEvents, 'document.animationEvents')
  if (!Array.isArray(document.terrainMaps) || document.terrainMaps.length > PIXEL_LIMITS.maxTerrainMaps) {
    fail('INVALID_TERRAIN_MAPS', `document.terrainMaps must contain 0-${PIXEL_LIMITS.maxTerrainMaps} maps`)
  }
  document.terrainMaps.forEach((terrainMap, index) => assertTerrainMap(terrainMap, `document.terrainMaps[${index}]`))
  assertUniqueIds(document.terrainMaps, 'document.terrainMaps')
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
    'id', 'name', 'width', 'height', 'revision', 'palette', 'paletteCycles', 'layerGroups', 'layers', 'frames',
    'animationTags', 'animationEvents', 'terrainMaps', 'activeLayerId', 'activeFrameId', 'onionSkin',
  ]), 'input')
  const width = options.width ?? 16
  const height = options.height ?? 16
  assertInteger(width, 'input.width', { min: 1, max: PIXEL_LIMITS.maxWidth })
  assertInteger(height, 'input.height', { min: 1, max: PIXEL_LIMITS.maxHeight })
  if (options.palette !== undefined && !Array.isArray(options.palette)) fail('INVALID_PALETTE', 'input.palette must be an array')
  if (options.paletteCycles !== undefined && !Array.isArray(options.paletteCycles)) fail('INVALID_PALETTE_CYCLES', 'input.paletteCycles must be an array')
  if (options.layerGroups !== undefined && !Array.isArray(options.layerGroups)) fail('INVALID_LAYER_GROUPS', 'input.layerGroups must be an array')
  if (options.layers !== undefined && !Array.isArray(options.layers)) fail('INVALID_LAYERS', 'input.layers must be an array')
  if (options.frames !== undefined && !Array.isArray(options.frames)) fail('INVALID_FRAMES', 'input.frames must be an array')
  if (options.animationTags !== undefined && !Array.isArray(options.animationTags)) fail('INVALID_ANIMATION_TAGS', 'input.animationTags must be an array')
  if (options.animationEvents !== undefined && !Array.isArray(options.animationEvents)) fail('INVALID_ANIMATION_EVENTS', 'input.animationEvents must be an array')
  if (options.terrainMaps !== undefined && !Array.isArray(options.terrainMaps)) fail('INVALID_TERRAIN_MAPS', 'input.terrainMaps must be an array')
  const palette = options.palette === undefined ? DEFAULT_PALETTE : options.palette
  const layerGroups = options.layerGroups ?? []
  const layers = (options.layers === undefined
    ? [{ id: 'layer-1', name: 'Ink', visible: true, locked: false, opacity: 1 }]
    : options.layers).map((layer) => ({
      ...layer,
      groupId: layer.groupId ?? null,
      blendMode: layer.blendMode ?? 'normal',
    }))
  const frameInputs = options.frames === undefined
    ? [{
        id: 'frame-1',
        name: 'Frame 1',
        durationMs: 120,
        cels: Object.fromEntries(layers.map((layer) => [layer.id, createBlankPixelArray(width, height)])),
      }]
    : options.frames
  const frames = frameInputs.map((frame) => ({
    ...frame,
    gameplay: frame.gameplay ?? createDefaultPixelFrameGameplay(width, height),
  }))
  const document = {
    kind: PIXEL_DOCUMENT_KIND,
    schemaVersion: PIXEL_DOCUMENT_SCHEMA_VERSION,
    id: options.id ?? 'pixel-document',
    name: options.name ?? 'Untitled sprite',
    width,
    height,
    revision: options.revision ?? 0,
    palette,
    paletteCycles: options.paletteCycles ?? [],
    layerGroups,
    layers,
    frames,
    animationTags: options.animationTags ?? [],
    animationEvents: options.animationEvents ?? [],
    terrainMaps: options.terrainMaps ?? [],
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
  if (isRecord(input) && input.schemaVersion === 6) {
    const legacy = assertRecord(input, 'schemaSixDocument')
    assertKnownFields(legacy, DOCUMENT_FIELDS, 'schemaSixDocument')
    if (!Array.isArray(legacy.terrainMaps) || legacy.terrainMaps.length > PIXEL_LIMITS.maxTerrainMaps) {
      fail('INVALID_TERRAIN_MAPS', `schemaSixDocument.terrainMaps must contain 0-${PIXEL_LIMITS.maxTerrainMaps} maps`)
    }
    const legacyMaps = legacy.terrainMaps.map((terrainMap, index) => (
      assertSchemaSixTerrainMap(terrainMap, `schemaSixDocument.terrainMaps[${index}]`)
    ))
    assertUniqueIds(legacyMaps, 'schemaSixDocument.terrainMaps')
    const migrated = {
      ...cloneJson(legacy),
      schemaVersion: PIXEL_DOCUMENT_SCHEMA_VERSION,
      terrainMaps: legacyMaps.map((terrainMap) => ({
        id: terrainMap.id,
        name: terrainMap.name,
        width: terrainMap.width,
        height: terrainMap.height,
        cells: terrainMap.occupancy.map((occupied) => occupied ? terrainMap.terrainId : null),
      })),
    }
    assertPixelDocument(migrated)
    return migrated
  }
  if (isRecord(input) && input.schemaVersion === 5) {
    const legacy = assertRecord(input, 'schemaFiveDocument')
    const schemaFiveFields = new Set([...DOCUMENT_FIELDS].filter((field) => field !== 'terrainMaps'))
    assertKnownFields(legacy, schemaFiveFields, 'schemaFiveDocument')
    const migrated = {
      ...cloneJson(legacy),
      schemaVersion: PIXEL_DOCUMENT_SCHEMA_VERSION,
      terrainMaps: [],
    }
    assertPixelDocument(migrated)
    return migrated
  }
  if (isRecord(input) && input.schemaVersion === 4) {
    const legacy = assertRecord(input, 'schemaFourDocument')
    const schemaFourFields = new Set([...DOCUMENT_FIELDS].filter((field) => !new Set(['paletteCycles', 'animationEvents', 'terrainMaps']).has(field)))
    assertKnownFields(legacy, schemaFourFields, 'schemaFourDocument')
    const migrated = {
      ...cloneJson(legacy),
      schemaVersion: PIXEL_DOCUMENT_SCHEMA_VERSION,
      paletteCycles: [],
      animationEvents: [],
      terrainMaps: [],
    }
    assertPixelDocument(migrated)
    return migrated
  }
  if (isRecord(input) && input.schemaVersion === 3) {
    const legacy = assertRecord(input, 'schemaThreeDocument')
    const schemaThreeFields = new Set([...DOCUMENT_FIELDS].filter((field) => !new Set(['paletteCycles', 'animationEvents', 'terrainMaps']).has(field)))
    assertKnownFields(legacy, schemaThreeFields, 'schemaThreeDocument')
    const migrated = {
      ...cloneJson(legacy),
      schemaVersion: PIXEL_DOCUMENT_SCHEMA_VERSION,
      paletteCycles: [],
      frames: legacy.frames.map((frame) => ({
        ...frame,
        gameplay: createDefaultPixelFrameGameplay(legacy.width, legacy.height),
      })),
      animationEvents: [],
      terrainMaps: [],
    }
    assertPixelDocument(migrated)
    return migrated
  }
  if (isRecord(input) && input.schemaVersion === 2) {
    const legacy = assertRecord(input, 'schemaTwoDocument')
    const schemaTwoFields = new Set([...DOCUMENT_FIELDS].filter((field) => !new Set(['paletteCycles', 'layerGroups', 'animationEvents', 'terrainMaps']).has(field)))
    assertKnownFields(legacy, schemaTwoFields, 'schemaTwoDocument')
    const migrated = {
      ...cloneJson(legacy),
      schemaVersion: PIXEL_DOCUMENT_SCHEMA_VERSION,
      paletteCycles: [],
      layerGroups: [],
      layers: legacy.layers.map((layer) => ({ ...layer, groupId: null, blendMode: 'normal' })),
      frames: legacy.frames.map((frame) => ({
        ...frame,
        gameplay: createDefaultPixelFrameGameplay(legacy.width, legacy.height),
      })),
      animationEvents: [],
      terrainMaps: [],
    }
    assertPixelDocument(migrated)
    return migrated
  }
  if (isRecord(input) && input.schemaVersion === 1) {
    const legacy = assertRecord(input, 'schemaOneDocument')
    const schemaOneFields = new Set([...DOCUMENT_FIELDS].filter((field) => !new Set(['paletteCycles', 'animationTags', 'animationEvents', 'layerGroups', 'terrainMaps']).has(field)))
    assertKnownFields(legacy, schemaOneFields, 'schemaOneDocument')
    const migrated = {
      ...cloneJson(legacy),
      schemaVersion: PIXEL_DOCUMENT_SCHEMA_VERSION,
      paletteCycles: [],
      layerGroups: [],
      layers: legacy.layers.map((layer) => ({ ...layer, groupId: null, blendMode: 'normal' })),
      frames: legacy.frames.map((frame) => ({
        ...frame,
        gameplay: createDefaultPixelFrameGameplay(legacy.width, legacy.height),
      })),
      animationTags: [],
      animationEvents: [],
      terrainMaps: [],
    }
    assertPixelDocument(migrated)
    return migrated
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

function resolveAnimationTagFrames(document, tag) {
  const fromIndex = document.frames.findIndex((frame) => frame.id === tag.fromFrameId)
  const toIndex = document.frames.findIndex((frame) => frame.id === tag.toFrameId)
  const range = document.frames.slice(fromIndex, toIndex + 1)
  if (tag.direction === 'reverse') return range.reverse().map((frame) => frame.id)
  if (tag.direction === 'ping-pong' && range.length > 2) {
    return [...range, ...range.slice(1, -1).reverse()].map((frame) => frame.id)
  }
  return range.map((frame) => frame.id)
}

export function resolvePixelAnimationSequences(documentInput) {
  const document = assertPixelDocument(documentInput)
  return document.animationTags.map((tag) => ({
    tagId: tag.id,
    frameIds: resolveAnimationTagFrames(document, tag),
  }))
}

export function resolvePixelAnimationFrames(documentInput, tagId) {
  assertId(tagId, 'tagId')
  const sequence = resolvePixelAnimationSequences(documentInput).find((item) => item.tagId === tagId)
  if (!sequence) fail('UNKNOWN_ANIMATION_TAG', `Unknown animation tag ${tagId}`, { tagId })
  return sequence.frameIds
}

function paletteCycleOffset(cycle, elapsedMs) {
  const steps = Math.floor(elapsedMs / cycle.stepDurationMs)
  const length = cycle.colorIds.length
  if (cycle.direction === 'reverse') return (length - (steps % length)) % length
  if (cycle.direction === 'ping-pong') {
    const period = Math.max(1, (length - 1) * 2)
    const phase = steps % period
    return phase < length ? phase : period - phase
  }
  return steps % length
}

export function resolvePixelPaletteCycleMap(documentInput, elapsedMs = 0) {
  const document = assertPixelDocument(documentInput)
  assertInteger(elapsedMs, 'elapsedMs', { min: 0, max: Number.MAX_SAFE_INTEGER })
  const mapping = Object.fromEntries(document.palette.map((color) => [color.id, color.id]))
  for (const cycle of document.paletteCycles) {
    if (!cycle.enabled) continue
    const offset = paletteCycleOffset(cycle, elapsedMs)
    cycle.colorIds.forEach((colorId, index) => {
      mapping[colorId] = cycle.colorIds[(index + offset) % cycle.colorIds.length]
    })
  }
  return mapping
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

function assertWritableLayer(document, layer) {
  if (layer.locked) fail('LAYER_LOCKED', `Layer ${layer.id} is locked`, { layerId: layer.id })
  if (layer.groupId !== null) {
    const group = document.layerGroups.find((item) => item.id === layer.groupId)
    if (group && !group.visible) {
      fail('LAYER_GROUP_HIDDEN', `Layer group ${group.id} is hidden`, { groupId: group.id, layerId: layer.id })
    }
    if (group?.locked) {
      fail('LAYER_GROUP_LOCKED', `Layer group ${group.id} is locked`, { groupId: group.id, layerId: layer.id })
    }
  }
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
      assertWritableLayer(document, layer)
      assertPointList(payload.pixels, 'command.payload.pixels', document, { withColor: true })
      break
    }
    case 'pixels.erase': {
      assertKnownFields(payload, new Set(['frameId', 'layerId', 'pixels']), 'command.payload')
      const { layer } = assertTarget(payload, document)
      assertWritableLayer(document, layer)
      assertPointList(payload.pixels, 'command.payload.pixels', document, {})
      break
    }
    case 'pixels.patch': {
      assertKnownFields(payload, new Set(['frameId', 'layerId', 'pixels']), 'command.payload')
      const { layer } = assertTarget(payload, document)
      assertWritableLayer(document, layer)
      assertPointList(payload.pixels, 'command.payload.pixels', document, { withValue: true })
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
    case 'palette-cycles.add':
    case 'palette-cycles.restore': {
      assertKnownFields(payload, new Set(['cycle', 'index']), 'command.payload')
      if (document.paletteCycles.some((cycle) => cycle.id === payload.cycle?.id)) {
        fail('DUPLICATE_ID', `Palette cycle ${String(payload.cycle?.id)} already exists`)
      }
      if (document.paletteCycles.length >= PIXEL_LIMITS.maxPaletteCycles) fail('LIMIT_EXCEEDED', 'Maximum palette cycle count reached')
      if (payload.index !== undefined) assertIndex(payload.index, 'command.payload.index', document.paletteCycles.length)
      assertPixelDocument({ ...document, paletteCycles: [...document.paletteCycles, payload.cycle] })
      break
    }
    case 'palette-cycles.remove':
      assertKnownFields(payload, new Set(['cycleId']), 'command.payload')
      assertId(payload.cycleId, 'command.payload.cycleId')
      if (!document.paletteCycles.some((cycle) => cycle.id === payload.cycleId)) {
        fail('UNKNOWN_PALETTE_CYCLE', `Unknown palette cycle ${payload.cycleId}`)
      }
      break
    case 'palette-cycles.patch': {
      assertKnownFields(payload, new Set(['cycleId', 'patch']), 'command.payload')
      assertId(payload.cycleId, 'command.payload.cycleId')
      const cycle = document.paletteCycles.find((item) => item.id === payload.cycleId)
      if (!cycle) fail('UNKNOWN_PALETTE_CYCLE', `Unknown palette cycle ${payload.cycleId}`)
      const patch = assertRecord(payload.patch, 'command.payload.patch')
      assertKnownFields(patch, new Set(['name', 'colorIds', 'stepDurationMs', 'direction', 'enabled']), 'command.payload.patch')
      if (Object.keys(patch).length === 0) fail('EMPTY_PATCH', 'Palette cycle patch must change at least one field')
      const candidate = { ...cycle, ...patch }
      assertPixelDocument({
        ...document,
        paletteCycles: document.paletteCycles.map((item) => item.id === cycle.id ? candidate : item),
      })
      break
    }
    case 'groups.add': {
      assertKnownFields(payload, new Set(['group', 'index']), 'command.payload')
      assertLayerGroup(payload.group, 'command.payload.group')
      if (document.layerGroups.some((group) => group.id === payload.group.id)) fail('DUPLICATE_ID', `Layer group ${payload.group.id} already exists`)
      if (document.layerGroups.length >= PIXEL_LIMITS.maxLayerGroups) fail('LIMIT_EXCEEDED', 'Maximum layer group count reached')
      if (payload.index !== undefined) assertIndex(payload.index, 'command.payload.index', document.layerGroups.length)
      break
    }
    case 'groups.remove':
      assertKnownFields(payload, new Set(['groupId']), 'command.payload')
      assertId(payload.groupId, 'command.payload.groupId')
      if (!document.layerGroups.some((group) => group.id === payload.groupId)) fail('UNKNOWN_LAYER_GROUP', `Unknown layer group ${payload.groupId}`)
      break
    case 'groups.restore': {
      assertKnownFields(payload, new Set(['group', 'index', 'layerIds']), 'command.payload')
      assertLayerGroup(payload.group, 'command.payload.group')
      if (document.layerGroups.some((group) => group.id === payload.group.id)) fail('DUPLICATE_ID', `Layer group ${payload.group.id} already exists`)
      assertIndex(payload.index, 'command.payload.index', document.layerGroups.length)
      const layerIds = assertUniqueStringList(payload.layerIds, 'command.payload.layerIds', { min: 0, max: document.layers.length })
      for (const layerId of layerIds) {
        if (!document.layers.some((layer) => layer.id === layerId)) fail('UNKNOWN_LAYER', `Unknown layer ${layerId}`)
      }
      break
    }
    case 'groups.patch': {
      assertKnownFields(payload, new Set(['groupId', 'patch']), 'command.payload')
      assertId(payload.groupId, 'command.payload.groupId')
      const group = document.layerGroups.find((item) => item.id === payload.groupId)
      if (!group) fail('UNKNOWN_LAYER_GROUP', `Unknown layer group ${payload.groupId}`)
      const patch = assertRecord(payload.patch, 'command.payload.patch')
      assertKnownFields(patch, new Set(['name', 'visible', 'locked']), 'command.payload.patch')
      if (Object.keys(patch).length === 0) fail('EMPTY_PATCH', 'Layer group patch must change at least one field')
      assertLayerGroup({ ...group, ...patch }, 'command.payload.patch')
      break
    }
    case 'layers.add': {
      assertKnownFields(payload, new Set(['layer', 'index']), 'command.payload')
      assertLayer(payload.layer, 'command.payload.layer', new Set(document.layerGroups.map((group) => group.id)))
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
      assertLayer(payload.layer, 'command.payload.layer', new Set(document.layerGroups.map((group) => group.id)))
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
      assertKnownFields(patch, new Set(['name', 'visible', 'locked', 'opacity', 'groupId', 'blendMode']), 'command.payload.patch')
      if (Object.keys(patch).length === 0) fail('EMPTY_PATCH', 'Layer patch must change at least one field')
      const layer = document.layers.find((item) => item.id === payload.layerId)
      assertLayer({ ...layer, ...patch }, 'command.payload.patch', new Set(document.layerGroups.map((group) => group.id)))
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
      assertKnownFields(frame, new Set(['id', 'name', 'durationMs', 'gameplay']), 'command.payload.frame')
      assertId(frame.id, 'command.payload.frame.id')
      assertString(frame.name, 'command.payload.frame.name', { min: 1, max: 80 })
      assertInteger(frame.durationMs, 'command.payload.frame.durationMs', { min: 20, max: 60_000 })
      if (frame.gameplay !== undefined) {
        assertFrameGameplay(frame.gameplay, 'command.payload.frame.gameplay', document.width, document.height)
      }
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
      if (document.animationTags.some((tag) => tag.fromFrameId === payload.frameId || tag.toFrameId === payload.frameId)) {
        fail('FRAME_IN_ANIMATION_TAG', `Frame ${payload.frameId} is an animation boundary`, { frameId: payload.frameId })
      }
      if (document.animationEvents.some((event) => event.frameId === payload.frameId)) {
        fail('FRAME_IN_ANIMATION_EVENT', `Frame ${payload.frameId} is referenced by an animation event`, { frameId: payload.frameId })
      }
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
      assertKnownFields(patch, new Set(['name', 'durationMs', 'gameplay']), 'command.payload.patch')
      if (Object.keys(patch).length === 0) fail('EMPTY_PATCH', 'Frame patch must change at least one field')
      if (patch.name !== undefined) assertString(patch.name, 'command.payload.patch.name', { min: 1, max: 80 })
      if (patch.durationMs !== undefined) assertInteger(patch.durationMs, 'command.payload.patch.durationMs', { min: 20, max: 60_000 })
      if (patch.gameplay !== undefined) {
        assertFrameGameplay(patch.gameplay, 'command.payload.patch.gameplay', document.width, document.height)
      }
      break
    }
    case 'frames.duration.set': {
      assertKnownFields(payload, new Set(['frames']), 'command.payload')
      if (!Array.isArray(payload.frames) || payload.frames.length < 1 || payload.frames.length > document.frames.length) {
        fail('INVALID_FRAME_DURATIONS', 'command.payload.frames must contain a bounded non-empty frame list')
      }
      const seen = new Set()
      payload.frames.forEach((entryInput, index) => {
        const entry = assertRecord(entryInput, `command.payload.frames[${index}]`)
        assertKnownFields(entry, new Set(['frameId', 'durationMs']), `command.payload.frames[${index}]`)
        assertId(entry.frameId, `command.payload.frames[${index}].frameId`)
        if (seen.has(entry.frameId)) fail('DUPLICATE_ID', `command.payload.frames contains duplicate frame ${entry.frameId}`)
        seen.add(entry.frameId)
        if (!document.frames.some((frame) => frame.id === entry.frameId)) fail('UNKNOWN_FRAME', `Unknown frame ${entry.frameId}`)
        assertInteger(entry.durationMs, `command.payload.frames[${index}].durationMs`, { min: 20, max: 60_000 })
      })
      break
    }
    case 'frames.reorder': {
      assertKnownFields(payload, new Set(['frameIds']), 'command.payload')
      assertIdOrder(payload.frameIds, document.frames.map((frame) => frame.id), 'command.payload.frameIds')
      const byId = new Map(document.frames.map((frame) => [frame.id, frame]))
      assertPixelDocument({ ...document, frames: payload.frameIds.map((frameId) => byId.get(frameId)) })
      break
    }
    case 'frames.select':
      assertKnownFields(payload, new Set(['frameId']), 'command.payload')
      assertId(payload.frameId, 'command.payload.frameId')
      if (!document.frames.some((frame) => frame.id === payload.frameId)) fail('UNKNOWN_FRAME', `Unknown frame ${payload.frameId}`)
      break
    case 'cels.copy': {
      assertKnownFields(payload, new Set(['sourceFrameId', 'targetFrameIds', 'layerIds', 'mode']), 'command.payload')
      assertId(payload.sourceFrameId, 'command.payload.sourceFrameId')
      if (!document.frames.some((frame) => frame.id === payload.sourceFrameId)) fail('UNKNOWN_FRAME', `Unknown source frame ${payload.sourceFrameId}`)
      const targetFrameIds = assertUniqueStringList(payload.targetFrameIds, 'command.payload.targetFrameIds', { max: document.frames.length - 1 })
      if (targetFrameIds.has(payload.sourceFrameId)) fail('INVALID_COPY_TARGET', 'Source frame cannot also be a copy target')
      for (const frameId of targetFrameIds) {
        if (!document.frames.some((frame) => frame.id === frameId)) fail('UNKNOWN_FRAME', `Unknown target frame ${frameId}`)
      }
      const layerIds = assertUniqueStringList(payload.layerIds, 'command.payload.layerIds', { max: document.layers.length })
      for (const layerId of layerIds) {
        const layer = document.layers.find((item) => item.id === layerId)
        if (!layer) fail('UNKNOWN_LAYER', `Unknown layer ${layerId}`)
        assertWritableLayer(document, layer)
      }
      if (!new Set(['replace', 'non-transparent']).has(payload.mode)) fail('INVALID_COPY_MODE', `Unsupported cel copy mode ${String(payload.mode)}`)
      const cellCount = targetFrameIds.size * layerIds.size * document.width * document.height
      if (cellCount > PIXEL_LIMITS.maxBulkCellsPerCommand) {
        fail('BULK_COMMAND_TOO_LARGE', `Cel copy would touch ${cellCount} cells`, { cellCount, limit: PIXEL_LIMITS.maxBulkCellsPerCommand })
      }
      break
    }
    case 'cels.restore': {
      assertKnownFields(payload, new Set(['frames']), 'command.payload')
      if (!Array.isArray(payload.frames) || payload.frames.length < 1 || payload.frames.length > document.frames.length) {
        fail('INVALID_CEL_RESTORE', 'command.payload.frames must contain a bounded non-empty frame list')
      }
      const frameIds = new Set()
      let cellCount = 0
      const paletteIds = new Set(document.palette.map((color) => color.id))
      const validLayerIds = new Set(document.layers.map((layer) => layer.id))
      payload.frames.forEach((entryInput, index) => {
        const entry = assertRecord(entryInput, `command.payload.frames[${index}]`)
        assertKnownFields(entry, new Set(['frameId', 'cels']), `command.payload.frames[${index}]`)
        assertId(entry.frameId, `command.payload.frames[${index}].frameId`)
        if (frameIds.has(entry.frameId)) fail('DUPLICATE_ID', `command.payload.frames contains duplicate frame ${entry.frameId}`)
        frameIds.add(entry.frameId)
        if (!document.frames.some((frame) => frame.id === entry.frameId)) fail('UNKNOWN_FRAME', `Unknown frame ${entry.frameId}`)
        const cels = assertRecord(entry.cels, `command.payload.frames[${index}].cels`)
        const layerIds = Object.keys(cels)
        if (layerIds.length < 1 || layerIds.length > document.layers.length) fail('INVALID_CEL_RESTORE', 'Each restored frame must include at least one cel')
        for (const layerId of layerIds) {
          if (!validLayerIds.has(layerId)) fail('UNKNOWN_LAYER', `Unknown layer ${layerId}`)
          assertPixelArray(cels[layerId], document.width * document.height, paletteIds, `command.payload.frames[${index}].cels.${layerId}`)
          cellCount += document.width * document.height
        }
      })
      if (cellCount > PIXEL_LIMITS.maxBulkCellsPerCommand) {
        fail('BULK_COMMAND_TOO_LARGE', `Cel restore would touch ${cellCount} cells`, { cellCount, limit: PIXEL_LIMITS.maxBulkCellsPerCommand })
      }
      break
    }
    case 'animations.add':
    case 'animations.restore': {
      assertKnownFields(payload, new Set(['tag', 'index']), 'command.payload')
      const frameIds = new Set(document.frames.map((frame) => frame.id))
      const frameOrder = new Map(document.frames.map((frame, index) => [frame.id, index]))
      assertAnimationTag(payload.tag, 'command.payload.tag', frameIds, frameOrder)
      if (document.animationTags.some((tag) => tag.id === payload.tag.id)) fail('DUPLICATE_ID', `Animation ${payload.tag.id} already exists`)
      if (document.animationTags.length >= PIXEL_LIMITS.maxAnimationTags) fail('LIMIT_EXCEEDED', 'Maximum animation tag count reached')
      if (payload.index !== undefined) assertIndex(payload.index, 'command.payload.index', document.animationTags.length)
      break
    }
    case 'animations.remove':
      assertKnownFields(payload, new Set(['tagId']), 'command.payload')
      assertId(payload.tagId, 'command.payload.tagId')
      if (!document.animationTags.some((tag) => tag.id === payload.tagId)) fail('UNKNOWN_ANIMATION_TAG', `Unknown animation tag ${payload.tagId}`)
      if (document.animationEvents.some((event) => event.animationTagId === payload.tagId)) {
        fail('ANIMATION_IN_EVENT', `Animation ${payload.tagId} is referenced by an animation event`, { tagId: payload.tagId })
      }
      break
    case 'animations.patch': {
      assertKnownFields(payload, new Set(['tagId', 'patch']), 'command.payload')
      assertId(payload.tagId, 'command.payload.tagId')
      const tag = document.animationTags.find((item) => item.id === payload.tagId)
      if (!tag) fail('UNKNOWN_ANIMATION_TAG', `Unknown animation tag ${payload.tagId}`)
      const patch = assertRecord(payload.patch, 'command.payload.patch')
      assertKnownFields(patch, new Set(['name', 'fromFrameId', 'toFrameId', 'direction', 'loop']), 'command.payload.patch')
      if (Object.keys(patch).length === 0) fail('EMPTY_PATCH', 'Animation patch must change at least one field')
      assertPixelDocument({
        ...document,
        animationTags: document.animationTags.map((item) => item.id === tag.id ? { ...tag, ...patch } : item),
      })
      break
    }
    case 'animation-events.add':
    case 'animation-events.restore': {
      assertKnownFields(payload, new Set(['event', 'index']), 'command.payload')
      if (document.animationEvents.some((event) => event.id === payload.event?.id)) {
        fail('DUPLICATE_ID', `Animation event ${String(payload.event?.id)} already exists`)
      }
      if (document.animationEvents.length >= PIXEL_LIMITS.maxAnimationEvents) fail('LIMIT_EXCEEDED', 'Maximum animation event count reached')
      if (payload.index !== undefined) assertIndex(payload.index, 'command.payload.index', document.animationEvents.length)
      assertPixelDocument({ ...document, animationEvents: [...document.animationEvents, payload.event] })
      break
    }
    case 'animation-events.remove':
      assertKnownFields(payload, new Set(['eventId']), 'command.payload')
      assertId(payload.eventId, 'command.payload.eventId')
      if (!document.animationEvents.some((event) => event.id === payload.eventId)) {
        fail('UNKNOWN_ANIMATION_EVENT', `Unknown animation event ${payload.eventId}`)
      }
      break
    case 'animation-events.patch': {
      assertKnownFields(payload, new Set(['eventId', 'patch']), 'command.payload')
      assertId(payload.eventId, 'command.payload.eventId')
      const event = document.animationEvents.find((item) => item.id === payload.eventId)
      if (!event) fail('UNKNOWN_ANIMATION_EVENT', `Unknown animation event ${payload.eventId}`)
      const patch = assertRecord(payload.patch, 'command.payload.patch')
      assertKnownFields(patch, new Set(['name', 'type', 'animationTagId', 'frameId', 'value']), 'command.payload.patch')
      if (Object.keys(patch).length === 0) fail('EMPTY_PATCH', 'Animation event patch must change at least one field')
      assertPixelDocument({
        ...document,
        animationEvents: document.animationEvents.map((item) => item.id === event.id ? { ...event, ...patch } : item),
      })
      break
    }
    case 'terrain-maps.add':
    case 'terrain-maps.restore': {
      assertKnownFields(payload, new Set(['terrainMap', 'index']), 'command.payload')
      assertTerrainMap(payload.terrainMap, 'command.payload.terrainMap')
      if (document.terrainMaps.some((terrainMap) => terrainMap.id === payload.terrainMap.id)) {
        fail('DUPLICATE_ID', `Terrain map ${payload.terrainMap.id} already exists`)
      }
      if (document.terrainMaps.length >= PIXEL_LIMITS.maxTerrainMaps) fail('LIMIT_EXCEEDED', 'Maximum terrain map count reached')
      if (payload.index !== undefined) assertIndex(payload.index, 'command.payload.index', document.terrainMaps.length)
      break
    }
    case 'terrain-maps.remove':
      assertKnownFields(payload, new Set(['terrainMapId']), 'command.payload')
      assertTerrainMapTarget(payload, document)
      break
    case 'terrain-maps.patch': {
      assertKnownFields(payload, new Set(['terrainMapId', 'patch']), 'command.payload')
      const terrainMap = assertTerrainMapTarget(payload, document)
      const patch = assertRecord(payload.patch, 'command.payload.patch')
      assertKnownFields(patch, new Set(['name']), 'command.payload.patch')
      const keys = Object.keys(patch)
      if (keys.length === 0) fail('EMPTY_PATCH', 'Terrain map patch must change at least one field')
      if (keys.every((key) => terrainMap[key] === patch[key])) fail('NO_TERRAIN_CHANGE', 'Terrain map patch does not change any field')
      assertTerrainMap({ ...terrainMap, ...patch }, 'command.payload.patch')
      break
    }
    case 'terrain-maps.resize': {
      assertKnownFields(payload, new Set(['terrainMapId', 'width', 'height']), 'command.payload')
      const terrainMap = assertTerrainMapTarget(payload, document)
      const width = assertInteger(payload.width, 'command.payload.width', { min: 1, max: PIXEL_LIMITS.maxTerrainMapWidth })
      const height = assertInteger(payload.height, 'command.payload.height', { min: 1, max: PIXEL_LIMITS.maxTerrainMapHeight })
      if (width * height > PIXEL_LIMITS.maxTerrainMapCells) fail('TERRAIN_MAP_TOO_LARGE', 'Terrain map dimensions exceed the cell limit')
      if (width === terrainMap.width && height === terrainMap.height) fail('NO_TERRAIN_CHANGE', 'Terrain map size is unchanged')
      break
    }
    case 'terrain-maps.restore-shape': {
      assertKnownFields(payload, new Set(['terrainMapId', 'width', 'height', 'cells']), 'command.payload')
      const terrainMap = assertTerrainMapTarget(payload, document)
      const candidate = {
        ...terrainMap,
        width: payload.width,
        height: payload.height,
        cells: payload.cells,
      }
      assertTerrainMap(candidate, 'command.payload')
      if (
        terrainMap.width === candidate.width
        && terrainMap.height === candidate.height
        && terrainMap.cells.every((terrainId, index) => terrainId === candidate.cells[index])
      ) fail('NO_TERRAIN_CHANGE', 'Terrain map shape is unchanged')
      break
    }
    case 'terrain-maps.cells.patch': {
      assertKnownFields(payload, new Set(['terrainMapId', 'cells']), 'command.payload')
      const terrainMap = assertTerrainMapTarget(payload, document)
      assertTerrainMapCells(payload.cells, terrainMap, 'command.payload.cells')
      break
    }
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
    case 'pixels.patch':
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
    case 'palette-cycles.add':
    case 'palette-cycles.restore': {
      const index = payload.index ?? next.paletteCycles.length
      next.paletteCycles.splice(index, 0, cloneJson(payload.cycle))
      inverseType = 'palette-cycles.remove'
      inversePayload = { cycleId: payload.cycle.id }
      break
    }
    case 'palette-cycles.remove': {
      const index = next.paletteCycles.findIndex((cycle) => cycle.id === payload.cycleId)
      const [cycle] = next.paletteCycles.splice(index, 1)
      inverseType = 'palette-cycles.restore'
      inversePayload = { cycle, index }
      break
    }
    case 'palette-cycles.patch': {
      const cycle = next.paletteCycles.find((item) => item.id === payload.cycleId)
      const previous = Object.fromEntries(Object.keys(payload.patch).map((key) => [key, cloneJson(cycle[key])]))
      Object.assign(cycle, cloneJson(payload.patch))
      inverseType = 'palette-cycles.patch'
      inversePayload = { cycleId: payload.cycleId, patch: previous }
      break
    }
    case 'groups.add': {
      const index = payload.index ?? next.layerGroups.length
      next.layerGroups.splice(index, 0, cloneJson(payload.group))
      inverseType = 'groups.remove'
      inversePayload = { groupId: payload.group.id }
      break
    }
    case 'groups.remove': {
      const index = next.layerGroups.findIndex((group) => group.id === payload.groupId)
      const [group] = next.layerGroups.splice(index, 1)
      const layerIds = next.layers.filter((layer) => layer.groupId === payload.groupId).map((layer) => layer.id)
      for (const layer of next.layers) {
        if (layer.groupId === payload.groupId) layer.groupId = null
      }
      inverseType = 'groups.restore'
      inversePayload = { group, index, layerIds }
      break
    }
    case 'groups.restore': {
      next.layerGroups.splice(payload.index, 0, cloneJson(payload.group))
      const layerIds = new Set(payload.layerIds)
      for (const layer of next.layers) {
        if (layerIds.has(layer.id)) layer.groupId = payload.group.id
      }
      inverseType = 'groups.remove'
      inversePayload = { groupId: payload.group.id }
      break
    }
    case 'groups.patch': {
      const group = next.layerGroups.find((item) => item.id === payload.groupId)
      const previous = Object.fromEntries(Object.keys(payload.patch).map((key) => [key, group[key]]))
      Object.assign(group, payload.patch)
      inverseType = 'groups.patch'
      inversePayload = { groupId: payload.groupId, patch: previous }
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
      const gameplay = payload.frame.gameplay
        ?? (source ? source.gameplay : createDefaultPixelFrameGameplay(next.width, next.height))
      next.frames.splice(index, 0, { ...cloneJson(payload.frame), gameplay: cloneJson(gameplay), cels })
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
    case 'frames.duration.set': {
      const previous = payload.frames.map((entry) => {
        const frame = next.frames.find((item) => item.id === entry.frameId)
        const prior = { frameId: frame.id, durationMs: frame.durationMs }
        frame.durationMs = entry.durationMs
        return prior
      })
      inverseType = 'frames.duration.set'
      inversePayload = { frames: previous }
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
    case 'cels.copy': {
      const source = next.frames.find((frame) => frame.id === payload.sourceFrameId)
      const previous = payload.targetFrameIds.map((frameId) => {
        const target = next.frames.find((frame) => frame.id === frameId)
        const cels = {}
        for (const layerId of payload.layerIds) {
          cels[layerId] = cloneJson(target.cels[layerId])
          target.cels[layerId] = payload.mode === 'replace'
            ? cloneJson(source.cels[layerId])
            : source.cels[layerId].map((colorId, index) => colorId === null ? target.cels[layerId][index] : colorId)
        }
        return { frameId, cels }
      })
      inverseType = 'cels.restore'
      inversePayload = { frames: previous }
      break
    }
    case 'cels.restore': {
      const previous = payload.frames.map((entry) => {
        const frame = next.frames.find((item) => item.id === entry.frameId)
        const cels = {}
        for (const layerId of Object.keys(entry.cels)) {
          cels[layerId] = cloneJson(frame.cels[layerId])
          frame.cels[layerId] = cloneJson(entry.cels[layerId])
        }
        return { frameId: entry.frameId, cels }
      })
      inverseType = 'cels.restore'
      inversePayload = { frames: previous }
      break
    }
    case 'animations.add':
    case 'animations.restore': {
      const index = payload.index ?? next.animationTags.length
      next.animationTags.splice(index, 0, cloneJson(payload.tag))
      inverseType = 'animations.remove'
      inversePayload = { tagId: payload.tag.id }
      break
    }
    case 'animations.remove': {
      const index = next.animationTags.findIndex((tag) => tag.id === payload.tagId)
      const [tag] = next.animationTags.splice(index, 1)
      inverseType = 'animations.restore'
      inversePayload = { tag, index }
      break
    }
    case 'animations.patch': {
      const tag = next.animationTags.find((item) => item.id === payload.tagId)
      const previous = Object.fromEntries(Object.keys(payload.patch).map((key) => [key, tag[key]]))
      Object.assign(tag, payload.patch)
      inverseType = 'animations.patch'
      inversePayload = { tagId: payload.tagId, patch: previous }
      break
    }
    case 'animation-events.add':
    case 'animation-events.restore': {
      const index = payload.index ?? next.animationEvents.length
      next.animationEvents.splice(index, 0, cloneJson(payload.event))
      inverseType = 'animation-events.remove'
      inversePayload = { eventId: payload.event.id }
      break
    }
    case 'animation-events.remove': {
      const index = next.animationEvents.findIndex((event) => event.id === payload.eventId)
      const [event] = next.animationEvents.splice(index, 1)
      inverseType = 'animation-events.restore'
      inversePayload = { event, index }
      break
    }
    case 'animation-events.patch': {
      const event = next.animationEvents.find((item) => item.id === payload.eventId)
      const previous = Object.fromEntries(Object.keys(payload.patch).map((key) => [key, event[key]]))
      Object.assign(event, cloneJson(payload.patch))
      inverseType = 'animation-events.patch'
      inversePayload = { eventId: payload.eventId, patch: previous }
      break
    }
    case 'terrain-maps.add':
    case 'terrain-maps.restore': {
      const index = payload.index ?? next.terrainMaps.length
      next.terrainMaps.splice(index, 0, cloneJson(payload.terrainMap))
      inverseType = 'terrain-maps.remove'
      inversePayload = { terrainMapId: payload.terrainMap.id }
      break
    }
    case 'terrain-maps.remove': {
      const index = next.terrainMaps.findIndex((terrainMap) => terrainMap.id === payload.terrainMapId)
      const [terrainMap] = next.terrainMaps.splice(index, 1)
      inverseType = 'terrain-maps.restore'
      inversePayload = { terrainMap, index }
      break
    }
    case 'terrain-maps.patch': {
      const terrainMap = next.terrainMaps.find((item) => item.id === payload.terrainMapId)
      const previous = Object.fromEntries(Object.keys(payload.patch).map((key) => [key, terrainMap[key]]))
      Object.assign(terrainMap, cloneJson(payload.patch))
      inverseType = 'terrain-maps.patch'
      inversePayload = { terrainMapId: payload.terrainMapId, patch: previous }
      break
    }
    case 'terrain-maps.resize': {
      const terrainMap = next.terrainMaps.find((item) => item.id === payload.terrainMapId)
      const previous = {
        width: terrainMap.width,
        height: terrainMap.height,
        cells: cloneJson(terrainMap.cells),
      }
      const cells = Array.from({ length: payload.width * payload.height }, () => null)
      const overlapWidth = Math.min(terrainMap.width, payload.width)
      const overlapHeight = Math.min(terrainMap.height, payload.height)
      for (let y = 0; y < overlapHeight; y += 1) {
        for (let x = 0; x < overlapWidth; x += 1) {
          cells[y * payload.width + x] = terrainMap.cells[y * terrainMap.width + x]
        }
      }
      terrainMap.width = payload.width
      terrainMap.height = payload.height
      terrainMap.cells = cells
      inverseType = 'terrain-maps.restore-shape'
      inversePayload = { terrainMapId: payload.terrainMapId, ...previous }
      break
    }
    case 'terrain-maps.restore-shape': {
      const terrainMap = next.terrainMaps.find((item) => item.id === payload.terrainMapId)
      const previous = {
        width: terrainMap.width,
        height: terrainMap.height,
        cells: cloneJson(terrainMap.cells),
      }
      terrainMap.width = payload.width
      terrainMap.height = payload.height
      terrainMap.cells = cloneJson(payload.cells)
      inverseType = 'terrain-maps.restore-shape'
      inversePayload = { terrainMapId: payload.terrainMapId, ...previous }
      break
    }
    case 'terrain-maps.cells.patch': {
      const terrainMap = next.terrainMaps.find((item) => item.id === payload.terrainMapId)
      const previous = payload.cells.map((cell) => ({
        x: cell.x,
        y: cell.y,
        terrainId: terrainMap.cells[cell.y * terrainMap.width + cell.x],
      }))
      for (const cell of payload.cells) {
        terrainMap.cells[cell.y * terrainMap.width + cell.x] = cell.terrainId
      }
      inverseType = 'terrain-maps.cells.patch'
      inversePayload = { terrainMapId: payload.terrainMapId, cells: previous }
      break
    }
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

function blendChannel(mode, source, destination) {
  switch (mode) {
    case 'multiply':
      return (source * destination) / 255
    case 'screen':
      return source + destination - (source * destination) / 255
    case 'add':
      return Math.min(255, source + destination)
    default:
      return source
  }
}

function assertTerrainMapTarget(payload, document) {
  assertId(payload.terrainMapId, 'command.payload.terrainMapId')
  const terrainMap = document.terrainMaps.find((item) => item.id === payload.terrainMapId)
  if (!terrainMap) fail('UNKNOWN_TERRAIN_MAP', `Unknown terrain map ${payload.terrainMapId}`)
  return terrainMap
}

function assertTerrainMapCells(cells, terrainMap, path) {
  if (!Array.isArray(cells) || cells.length < 1 || cells.length > PIXEL_LIMITS.maxTerrainMapCells) {
    fail('INVALID_TERRAIN_CELLS', `${path} must contain 1-${PIXEL_LIMITS.maxTerrainMapCells} unique cells`)
  }
  const seen = new Set()
  let changed = false
  cells.forEach((cellInput, index) => {
    const cellPath = `${path}[${index}]`
    const cell = assertRecord(cellInput, cellPath)
    assertKnownFields(cell, new Set(['x', 'y', 'terrainId']), cellPath)
    const x = assertInteger(cell.x, `${cellPath}.x`, { min: 0, max: terrainMap.width - 1 })
    const y = assertInteger(cell.y, `${cellPath}.y`, { min: 0, max: terrainMap.height - 1 })
    if (cell.terrainId !== null) assertId(cell.terrainId, `${cellPath}.terrainId`)
    const key = `${x}:${y}`
    if (seen.has(key)) fail('DUPLICATE_TERRAIN_CELL', `${path} contains duplicate coordinate ${key}`, { path, key })
    seen.add(key)
    if (terrainMap.cells[y * terrainMap.width + x] !== cell.terrainId) changed = true
  })
  if (!changed) fail('NO_TERRAIN_CHANGE', `${path} does not change the terrain map`)
}

function blendPixel(output, offset, source, opacity, mode) {
  const sourceAlpha = (source[3] / 255) * opacity
  if (sourceAlpha <= 0) return
  const destinationAlpha = output[offset + 3] / 255
  const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha)
  if (outputAlpha <= 0) return
  for (let channel = 0; channel < 3; channel += 1) {
    const sourceChannel = source[channel]
    const destinationChannel = output[offset + channel]
    const blended = blendChannel(mode, sourceChannel, destinationChannel)
    const premultiplied = sourceAlpha * (1 - destinationAlpha) * sourceChannel
      + sourceAlpha * destinationAlpha * blended
      + (1 - sourceAlpha) * destinationAlpha * destinationChannel
    output[offset + channel] = Math.round(premultiplied / outputAlpha)
  }
  output[offset + 3] = Math.round(outputAlpha * 255)
}

export function renderPixelFrameRgba(documentInput, frameId, options = {}) {
  const document = assertPixelDocument(documentInput)
  assertId(frameId, 'frameId')
  const settings = assertRecord(options, 'options')
  assertKnownFields(settings, new Set(['includeHiddenLayers', 'paletteCycleElapsedMs']), 'options')
  if (settings.includeHiddenLayers !== undefined) assertBoolean(settings.includeHiddenLayers, 'options.includeHiddenLayers')
  const paletteCycleElapsedMs = settings.paletteCycleElapsedMs ?? 0
  assertInteger(paletteCycleElapsedMs, 'options.paletteCycleElapsedMs', { min: 0, max: Number.MAX_SAFE_INTEGER })
  const frame = document.frames.find((item) => item.id === frameId)
  if (!frame) fail('UNKNOWN_FRAME', `Unknown frame ${frameId}`)
  const paletteById = new Map(document.palette.map((color) => [color.id, color]))
  const cycleMap = resolvePixelPaletteCycleMap(document, paletteCycleElapsedMs)
  const colors = new Map(document.palette.map((color) => [
    color.id,
    parseRgba(paletteById.get(cycleMap[color.id]).color),
  ]))
  const groupById = new Map(document.layerGroups.map((group) => [group.id, group]))
  const output = new Uint8ClampedArray(document.width * document.height * 4)
  for (const layer of document.layers) {
    const group = layer.groupId === null ? null : groupById.get(layer.groupId)
    if (((!layer.visible || (group && !group.visible)) && !settings.includeHiddenLayers) || layer.opacity <= 0) continue
    const pixels = frame.cels[layer.id]
    for (let index = 0; index < pixels.length; index += 1) {
      const colorId = pixels[index]
      if (colorId === null) continue
      blendPixel(output, index * 4, colors.get(colorId), layer.opacity, layer.blendMode)
    }
  }
  return output
}

function readSpriteOptions(document, input, frameCount = document.frames.length) {
  const options = assertRecord(input, 'options')
  assertKnownFields(options, new Set(['columns', 'padding', 'spacing']), 'options')
  const columns = options.columns ?? Math.ceil(Math.sqrt(frameCount))
  const padding = options.padding ?? 0
  const spacing = options.spacing ?? 0
  assertInteger(columns, 'options.columns', { min: 1, max: frameCount })
  assertInteger(padding, 'options.padding', { min: 0, max: 256 })
  assertInteger(spacing, 'options.spacing', { min: 0, max: 256 })
  return { columns, padding, spacing }
}

function createSpriteSheetLayoutForFrameIds(document, frameIds, options = {}) {
  const selectedFrameIds = assertUniqueStringList(frameIds, 'frameIds', { min: 1, max: document.frames.length })
  for (const frameId of selectedFrameIds) {
    if (!document.frames.some((frame) => frame.id === frameId)) fail('UNKNOWN_FRAME', `Unknown frame ${frameId}`, { frameId })
  }
  const orderedFrameIds = [...frameIds]
  const { columns, padding, spacing } = readSpriteOptions(document, options, orderedFrameIds.length)
  const rows = Math.ceil(orderedFrameIds.length / columns)
  const width = padding * 2 + columns * document.width + Math.max(0, columns - 1) * spacing
  const height = padding * 2 + rows * document.height + Math.max(0, rows - 1) * spacing
  if (width > 32_768 || height > 32_768) {
    fail('SPRITE_TOO_LARGE', `Sprite sheet dimensions ${width}x${height} exceed 32768px`)
  }
  const cells = orderedFrameIds.map((frameId, index) => {
    const frame = document.frames.find((item) => item.id === frameId)
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

export function createSpriteSheetLayout(documentInput, options = {}) {
  const document = assertPixelDocument(documentInput)
  return createSpriteSheetLayoutForFrameIds(document, document.frames.map((frame) => frame.id), options)
}

export function createSpriteSheetMetadata(documentInput, options = {}) {
  const document = assertPixelDocument(documentInput)
  const layout = createSpriteSheetLayout(document, options)
  return createSpriteSheetMetadataFromLayout(document, layout)
}

function createSpriteSheetMetadataFromLayout(document, layout) {
  const animationSequences = new Map(document.animationTags.map((tag) => [tag.id, resolveAnimationTagFrames(document, tag)]))
  return {
    schemaVersion: PIXEL_DOCUMENT_SCHEMA_VERSION,
    kind: 'aeonquill.sprite-sheet',
    sourceDocumentId: document.id,
    sourceRevision: document.revision,
    width: layout.width,
    height: layout.height,
    columns: layout.columns,
    rows: layout.rows,
    padding: layout.padding,
    spacing: layout.spacing,
    frames: layout.cells.map((cell) => ({
      ...cell,
      gameplay: cloneJson(document.frames.find((frame) => frame.id === cell.frameId).gameplay),
    })),
    animations: document.animationTags.map((tag) => ({
      ...cloneJson(tag),
      frameIds: animationSequences.get(tag.id),
    })),
    animationEvents: cloneJson(document.animationEvents),
    layerGroups: cloneJson(document.layerGroups),
    layers: cloneJson(document.layers),
    palette: cloneJson(document.palette),
    paletteCycles: cloneJson(document.paletteCycles),
    terrainMaps: cloneJson(document.terrainMaps),
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
    metadata: createSpriteSheetMetadataFromLayout(document, layout),
  }
}

export function renderPixelAnimationClipRgba(documentInput, tagId, options = {}) {
  const document = assertPixelDocument(documentInput)
  assertId(tagId, 'tagId')
  const tag = document.animationTags.find((item) => item.id === tagId)
  if (!tag) fail('UNKNOWN_ANIMATION_TAG', `Unknown animation tag ${tagId}`, { tagId })
  const sequenceFrameIds = resolveAnimationTagFrames(document, tag)
  const uniqueFrameIds = [...new Set(sequenceFrameIds)]
  const layout = createSpriteSheetLayoutForFrameIds(document, uniqueFrameIds, options)
  const totalPixels = layout.width * layout.height
  if (totalPixels > PIXEL_LIMITS.maxSpritePixels) {
    fail('SPRITE_TOO_LARGE', `Animation clip contains ${totalPixels} pixels`, { totalPixels, limit: PIXEL_LIMITS.maxSpritePixels })
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
    metadata: {
      schemaVersion: PIXEL_DOCUMENT_SCHEMA_VERSION,
      kind: 'aeonquill.pixel-animation-clip',
      sourceDocumentId: document.id,
      sourceRevision: document.revision,
      width: layout.width,
      height: layout.height,
      columns: layout.columns,
      rows: layout.rows,
      padding: layout.padding,
      spacing: layout.spacing,
      animation: { ...cloneJson(tag), frameIds: sequenceFrameIds },
      frames: layout.cells.map((cell) => ({
        ...cell,
        gameplay: cloneJson(document.frames.find((frame) => frame.id === cell.frameId).gameplay),
      })),
      events: cloneJson(document.animationEvents.filter((event) => event.animationTagId === tag.id)),
      layerGroups: cloneJson(document.layerGroups),
      layers: cloneJson(document.layers),
      palette: cloneJson(document.palette),
      paletteCycles: cloneJson(document.paletteCycles),
      terrainMaps: cloneJson(document.terrainMaps),
    },
  }
}
