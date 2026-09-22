import {
  PIXEL_DOCUMENT_SCHEMA_VERSION,
  PIXEL_LIMITS,
  PIXEL_TILE_NEIGHBORS,
  assertPixelDocument,
  createSpriteSheetLayout,
  renderPixelAnimationClipRgba,
  renderPixelFrameRgba,
  renderSpriteSheetRgba,
  resolvePixelAnimationSequences,
} from './pixelCore.mjs'
import { createPixelExportBundle, safePixelFilename } from './pixelConversion.mjs'

export const PIXEL_DIRECTIONS = Object.freeze([
  Object.freeze({ id: 'south', label: '南' }),
  Object.freeze({ id: 'south-west', label: '西南' }),
  Object.freeze({ id: 'west', label: '西' }),
  Object.freeze({ id: 'north-west', label: '西北' }),
  Object.freeze({ id: 'north', label: '北' }),
  Object.freeze({ id: 'north-east', label: '东北' }),
  Object.freeze({ id: 'east', label: '东' }),
  Object.freeze({ id: 'south-east', label: '东南' }),
])

export const PIXEL_TERRAIN_GRID_SIZE = 3

export const PIXEL_TERRAIN_GRID_PRESETS = Object.freeze([
  Object.freeze({
    id: 'island',
    label: '孤岛',
    occupancy: Object.freeze([false, false, false, false, true, false, false, false, false]),
  }),
  Object.freeze({
    id: 'corridor',
    label: '横向',
    occupancy: Object.freeze([false, false, false, true, true, true, false, false, false]),
  }),
  Object.freeze({
    id: 'corner',
    label: '转角',
    occupancy: Object.freeze([false, true, true, false, true, true, false, false, false]),
  }),
  Object.freeze({
    id: 'solid',
    label: '全满',
    occupancy: Object.freeze([true, true, true, true, true, true, true, true, true]),
  }),
])

const TERRAIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const TERRAIN_NEIGHBOR_OFFSETS = Object.freeze([
  Object.freeze({ id: 'north', row: -1, column: 0, gateIds: [] }),
  Object.freeze({ id: 'north-east', row: -1, column: 1, gateIds: ['north', 'east'] }),
  Object.freeze({ id: 'east', row: 0, column: 1, gateIds: [] }),
  Object.freeze({ id: 'south-east', row: 1, column: 1, gateIds: ['south', 'east'] }),
  Object.freeze({ id: 'south', row: 1, column: 0, gateIds: [] }),
  Object.freeze({ id: 'south-west', row: 1, column: -1, gateIds: ['south', 'west'] }),
  Object.freeze({ id: 'west', row: 0, column: -1, gateIds: [] }),
  Object.freeze({ id: 'north-west', row: -1, column: -1, gateIds: ['north', 'west'] }),
])
const TERRAIN_BIT_BY_ID = new Map(PIXEL_TILE_NEIGHBORS.map((neighbor) => [neighbor.id, neighbor.bit]))
const TERRAIN_OFFSET_BY_ID = new Map(TERRAIN_NEIGHBOR_OFFSETS.map((neighbor) => [neighbor.id, neighbor]))
const PIXEL_GAME_OPTION_FIELDS = Object.freeze([
  'columns', 'padding', 'spacing', 'baseName', 'directionFrameIds',
  'mapWidth', 'mapHeight', 'mapFrameIds', 'animationName', 'animationTagId',
])
const RPG_MAKER_DIRECTIONS = Object.freeze([
  Object.freeze({ id: 'south', label: '下' }),
  Object.freeze({ id: 'west', label: '左' }),
  Object.freeze({ id: 'east', label: '右' }),
  Object.freeze({ id: 'north', label: '上' }),
])

export class PixelGamePipelineError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'PixelGamePipelineError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

function fail(code, message, details) {
  throw new PixelGamePipelineError(code, message, details)
}

function assertRecord(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_OBJECT', `${path} must be an object`)
  return value
}

function assertKnownFields(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('UNKNOWN_FIELD', `${path}.${key} is not allowed`)
  }
}

function assertInteger(value, path, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('INVALID_INTEGER', `${path} must be an integer between ${min} and ${max}`, { path, value })
  }
  return value
}

function assertFrameId(frameIds, value, path) {
  if (typeof value !== 'string' || !frameIds.has(value)) fail('UNKNOWN_FRAME', `${path} must reference an existing frame`, { path, value })
  return value
}

function assertTerrainId(value, path) {
  if (typeof value !== 'string' || !TERRAIN_ID_PATTERN.test(value)) {
    fail('INVALID_TERRAIN_ID', `${path} must be a stable terrain id`, { path, value })
  }
  return value
}

function assertTerrainOccupancy(value, width, height, path) {
  const cellCount = width * height
  if (!Array.isArray(value) || value.length !== cellCount || value.some((entry) => typeof entry !== 'boolean')) {
    fail('INVALID_TERRAIN_OCCUPANCY', `${path} must contain exactly ${cellCount} booleans`)
  }
  return [...value]
}

function assertTerrainCells(value, width, height, path) {
  const cellCount = width * height
  if (!Array.isArray(value) || value.length !== cellCount) {
    fail('INVALID_TERRAIN_CELLS', `${path} must contain exactly ${cellCount} terrain ids or null values`)
  }
  return value.map((terrainId, index) => (
    terrainId === null ? null : assertTerrainId(terrainId, `${path}[${index}]`)
  ))
}

function terrainGridOccupied(occupancy, row, column, width, height) {
  if (row < 0 || column < 0 || row >= height || column >= width) return false
  return occupancy[row * width + column]
}

function inferTerrainCellBitmask(occupancy, row, column, width, height) {
  let bitmask = 0
  for (const neighbor of TERRAIN_NEIGHBOR_OFFSETS) {
    if (!terrainGridOccupied(occupancy, row + neighbor.row, column + neighbor.column, width, height)) continue
    const gatesOpen = neighbor.gateIds.every((gateId) => {
      const gate = TERRAIN_OFFSET_BY_ID.get(gateId)
      return terrainGridOccupied(occupancy, row + gate.row, column + gate.column, width, height)
    })
    if (gatesOpen) bitmask |= TERRAIN_BIT_BY_ID.get(neighbor.id)
  }
  return bitmask
}

function terrainGridMatches(cells, terrainId, row, column, width, height) {
  if (row < 0 || column < 0 || row >= height || column >= width) return false
  return cells[row * width + column] === terrainId
}

function inferTerrainCellBitmaskById(cells, terrainId, row, column, width, height) {
  let bitmask = 0
  for (const neighbor of TERRAIN_NEIGHBOR_OFFSETS) {
    if (!terrainGridMatches(cells, terrainId, row + neighbor.row, column + neighbor.column, width, height)) continue
    const gatesOpen = neighbor.gateIds.every((gateId) => {
      const gate = TERRAIN_OFFSET_BY_ID.get(gateId)
      return terrainGridMatches(cells, terrainId, row + gate.row, column + gate.column, width, height)
    })
    if (gatesOpen) bitmask |= TERRAIN_BIT_BY_ID.get(neighbor.id)
  }
  return bitmask
}

function bitCount8(value) {
  let remaining = value & 0xff
  let count = 0
  while (remaining > 0) {
    remaining &= remaining - 1
    count += 1
  }
  return count
}

function createTerrainLayout(document, { kind, terrainId, width, height, occupancy, terrainMapId, terrainMapName }) {
  const candidates = document.frames
    .map((frame, frameIndex) => ({ frame, frameIndex }))
    .filter(({ frame }) => frame.gameplay.tileRule?.terrainId === terrainId)
  if (candidates.length === 0) {
    fail('UNKNOWN_TERRAIN', `No frames are registered for terrain ${terrainId}`, { terrainId })
  }
  const cells = Array.from({ length: width * height }, (_, index) => {
    const row = Math.floor(index / width)
    const column = index % width
    if (!occupancy[index]) {
      return {
        index,
        row,
        column,
        occupied: false,
        expectedBitmask: null,
        frameId: null,
        frameName: null,
        matchedBitmask: null,
        distance: null,
        exact: false,
      }
    }
    const expectedBitmask = inferTerrainCellBitmask(occupancy, row, column, width, height)
    const ranked = candidates
      .map(({ frame, frameIndex }) => ({
        frame,
        frameIndex,
        matchedBitmask: frame.gameplay.tileRule.bitmask,
        distance: bitCount8(expectedBitmask ^ frame.gameplay.tileRule.bitmask),
      }))
      .sort((left, right) => (
        left.distance - right.distance
        || left.frameIndex - right.frameIndex
        || left.frame.id.localeCompare(right.frame.id)
      ))
    const match = ranked[0]
    return {
      index,
      row,
      column,
      occupied: true,
      expectedBitmask,
      frameId: match.frame.id,
      frameName: match.frame.name,
      matchedBitmask: match.matchedBitmask,
      distance: match.distance,
      exact: match.distance === 0,
    }
  })
  return {
    schemaVersion: 1,
    kind,
    sourceDocumentId: document.id,
    sourceRevision: document.revision,
    ...(terrainMapId === undefined ? {} : { terrainMapId, terrainMapName }),
    terrainId,
    grid: { width, height },
    tile: { width: document.width, height: document.height },
    occupancy,
    exactCount: cells.filter((cell) => cell.occupied && cell.exact).length,
    fallbackCount: cells.filter((cell) => cell.occupied && !cell.exact).length,
    cells,
  }
}

export function createPixelTerrainPreviewLayout(documentInput, optionsInput = {}) {
  const document = assertPixelDocument(documentInput)
  const options = assertRecord(optionsInput, 'options')
  assertKnownFields(options, new Set(['terrainId', 'occupancy']), 'options')
  const fallbackTerrainId = document.frames.find((frame) => frame.gameplay.tileRule)?.gameplay.tileRule?.terrainId
  const terrainId = assertTerrainId(options.terrainId ?? fallbackTerrainId, 'options.terrainId')
  const occupancy = assertTerrainOccupancy(
    options.occupancy ?? PIXEL_TERRAIN_GRID_PRESETS.at(-1).occupancy,
    PIXEL_TERRAIN_GRID_SIZE,
    PIXEL_TERRAIN_GRID_SIZE,
    'options.occupancy',
  )
  return createTerrainLayout(document, {
    kind: 'aeonquill.pixel-terrain-preview',
    terrainId,
    width: PIXEL_TERRAIN_GRID_SIZE,
    height: PIXEL_TERRAIN_GRID_SIZE,
    occupancy,
  })
}

export function createPixelTerrainMapLayout(documentInput, optionsInput = {}) {
  const document = assertPixelDocument(documentInput)
  const options = assertRecord(optionsInput, 'options')
  assertKnownFields(options, new Set(['terrainMapId', 'cells']), 'options')
  const terrainMapId = options.terrainMapId ?? document.terrainMaps[0]?.id
  if (typeof terrainMapId !== 'string') fail('UNKNOWN_TERRAIN_MAP', 'options.terrainMapId must reference an existing terrain map')
  const terrainMap = document.terrainMaps.find((item) => item.id === terrainMapId)
  if (!terrainMap) fail('UNKNOWN_TERRAIN_MAP', `Unknown terrain map ${terrainMapId}`, { terrainMapId })
  const terrainGrid = assertTerrainCells(
    options.cells ?? terrainMap.cells,
    terrainMap.width,
    terrainMap.height,
    'options.cells',
  )
  const terrainIds = [...new Set(terrainGrid.filter((terrainId) => terrainId !== null))]
  const candidatesByTerrain = new Map(terrainIds.map((terrainId) => [
    terrainId,
    document.frames
      .map((frame, frameIndex) => ({ frame, frameIndex }))
      .filter(({ frame }) => frame.gameplay.tileRule?.terrainId === terrainId),
  ]))
  const unavailableTerrainIds = terrainIds.filter((terrainId) => candidatesByTerrain.get(terrainId).length === 0)
  if (unavailableTerrainIds.length > 0) {
    fail('UNKNOWN_TERRAIN', `No frames are registered for terrain ${unavailableTerrainIds.join(', ')}`, {
      terrainIds: unavailableTerrainIds,
    })
  }
  const cells = terrainGrid.map((terrainId, index) => {
    const row = Math.floor(index / terrainMap.width)
    const column = index % terrainMap.width
    if (terrainId === null) {
      return {
        index,
        row,
        column,
        terrainId: null,
        occupied: false,
        expectedBitmask: null,
        frameId: null,
        frameName: null,
        matchedBitmask: null,
        distance: null,
        exact: false,
      }
    }
    const expectedBitmask = inferTerrainCellBitmaskById(
      terrainGrid,
      terrainId,
      row,
      column,
      terrainMap.width,
      terrainMap.height,
    )
    const ranked = candidatesByTerrain.get(terrainId)
      .map(({ frame, frameIndex }) => ({
        frame,
        frameIndex,
        matchedBitmask: frame.gameplay.tileRule.bitmask,
        distance: bitCount8(expectedBitmask ^ frame.gameplay.tileRule.bitmask),
      }))
      .sort((left, right) => (
        left.distance - right.distance
        || left.frameIndex - right.frameIndex
        || left.frame.id.localeCompare(right.frame.id)
      ))
    const match = ranked[0]
    return {
      index,
      row,
      column,
      terrainId,
      occupied: true,
      expectedBitmask,
      frameId: match.frame.id,
      frameName: match.frame.name,
      matchedBitmask: match.matchedBitmask,
      distance: match.distance,
      exact: match.distance === 0,
    }
  })
  return {
    schemaVersion: 2,
    kind: 'aeonquill.pixel-terrain-map',
    sourceDocumentId: document.id,
    sourceRevision: document.revision,
    terrainMapId: terrainMap.id,
    terrainMapName: terrainMap.name,
    terrainIds,
    grid: { width: terrainMap.width, height: terrainMap.height },
    tile: { width: document.width, height: document.height },
    terrainGrid,
    exactCount: cells.filter((cell) => cell.occupied && cell.exact).length,
    fallbackCount: cells.filter((cell) => cell.occupied && !cell.exact).length,
    cells,
  }
}

export function inspectPixelTerrainCoverage(documentInput, mapId) {
  const document = assertPixelDocument(documentInput)
  if (typeof mapId !== 'string' || !TERRAIN_ID_PATTERN.test(mapId)) {
    fail('INVALID_TERRAIN_MAP', 'mapId must be a stable terrain map id', { mapId })
  }
  const terrainMap = document.terrainMaps.find((candidate) => candidate.id === mapId)
  if (!terrainMap) fail('UNKNOWN_TERRAIN_MAP', `Unknown terrain map ${mapId}`, { mapId })
  const exactRules = new Set(document.frames
    .map((frame) => frame.gameplay.tileRule)
    .filter(Boolean)
    .map((rule) => `${rule.terrainId}:${rule.bitmask}`))
  const grouped = new Map()
  const cells = []
  for (let index = 0; index < terrainMap.cells.length; index += 1) {
    const terrainId = terrainMap.cells[index]
    if (terrainId === null) continue
    const row = Math.floor(index / terrainMap.width)
    const column = index % terrainMap.width
    const bitmask = inferTerrainCellBitmaskById(
      terrainMap.cells,
      terrainId,
      row,
      column,
      terrainMap.width,
      terrainMap.height,
    )
    const covered = exactRules.has(`${terrainId}:${bitmask}`)
    const cell = { index, row, column, terrainId, bitmask, covered }
    cells.push(cell)
    if (!covered) {
      const key = `${terrainId}:${bitmask}`
      const entry = grouped.get(key) ?? { terrainId, bitmask, cells: [], count: 0 }
      entry.cells.push({ index, row, column })
      entry.count += 1
      grouped.set(key, entry)
    }
  }
  const missing = [...grouped.values()]
  return {
    schemaVersion: 1,
    kind: 'aeonquill.pixel-terrain-coverage',
    sourceDocumentId: document.id,
    sourceRevision: document.revision,
    terrainMapId: terrainMap.id,
    terrainMapName: terrainMap.name,
    checkedCellCount: terrainMap.cells.length,
    occupiedCellCount: cells.length,
    missingCount: missing.reduce((sum, entry) => sum + entry.count, 0),
    missingTerrainIds: [...new Set(missing.map((entry) => entry.terrainId))],
    missingBitmasks: missing.map(({ terrainId, bitmask, count }) => ({ terrainId, bitmask, count })),
    missing,
    cells,
  }
}

function renderTerrainLayout(document, layout) {
  const width = document.width * layout.grid.width
  const height = document.height * layout.grid.height
  const totalPixels = width * height
  if (totalPixels > PIXEL_LIMITS.maxSpritePixels) {
    fail('TERRAIN_RENDER_TOO_LARGE', `Terrain render contains ${totalPixels} pixels`, {
      totalPixels,
      limit: PIXEL_LIMITS.maxSpritePixels,
    })
  }
  const pixels = new Uint8ClampedArray(totalPixels * 4)
  const framePixelsById = new Map()
  for (const cell of layout.cells) {
    if (!cell.occupied || cell.frameId === null) continue
    let framePixels = framePixelsById.get(cell.frameId)
    if (!framePixels) {
      framePixels = renderPixelFrameRgba(document, cell.frameId)
      framePixelsById.set(cell.frameId, framePixels)
    }
    for (let sourceRow = 0; sourceRow < document.height; sourceRow += 1) {
      const sourceStart = sourceRow * document.width * 4
      const targetStart = ((cell.row * document.height + sourceRow) * width + cell.column * document.width) * 4
      pixels.set(framePixels.subarray(sourceStart, sourceStart + document.width * 4), targetStart)
    }
  }
  return { pixels, width, height, layout }
}

export function renderPixelTerrainPreviewRgba(documentInput, optionsInput = {}) {
  const document = assertPixelDocument(documentInput)
  const layout = createPixelTerrainPreviewLayout(document, optionsInput)
  return renderTerrainLayout(document, layout)
}

export function renderPixelTerrainMapRgba(documentInput, optionsInput = {}) {
  const document = assertPixelDocument(documentInput)
  const layout = createPixelTerrainMapLayout(document, optionsInput)
  return renderTerrainLayout(document, layout)
}

function defaultMapSize(frameCount) {
  const width = Math.max(1, Math.ceil(Math.sqrt(frameCount)))
  return { width, height: Math.max(1, Math.ceil(frameCount / width)) }
}

export function normalizePixelGameOptions(documentInput, optionsInput = {}) {
  const document = assertPixelDocument(documentInput)
  const options = assertRecord(optionsInput, 'options')
  assertKnownFields(options, new Set(PIXEL_GAME_OPTION_FIELDS), 'options')
  const frameIds = new Set(document.frames.map((frame) => frame.id))
  const fallbackMap = defaultMapSize(document.frames.length)
  const columns = assertInteger(options.columns ?? Math.min(4, document.frames.length), 'options.columns', 1, document.frames.length)
  const padding = assertInteger(options.padding ?? 1, 'options.padding', 0, 64)
  const spacing = assertInteger(options.spacing ?? 1, 'options.spacing', 0, 64)
  const mapWidth = assertInteger(options.mapWidth ?? fallbackMap.width, 'options.mapWidth', 1, 256)
  const mapHeight = assertInteger(options.mapHeight ?? fallbackMap.height, 'options.mapHeight', 1, 256)
  const directionInput = options.directionFrameIds === undefined
    ? {}
    : assertRecord(options.directionFrameIds, 'options.directionFrameIds')
  assertKnownFields(directionInput, new Set(PIXEL_DIRECTIONS.map((direction) => direction.id)), 'options.directionFrameIds')
  const directionFrameIds = Object.fromEntries(PIXEL_DIRECTIONS.map((direction, index) => [
    direction.id,
    assertFrameId(frameIds, directionInput[direction.id] ?? document.frames[index % document.frames.length].id, `options.directionFrameIds.${direction.id}`),
  ]))
  let mapFrameIds
  if (options.mapFrameIds === undefined) {
    mapFrameIds = Array.from({ length: mapWidth * mapHeight }, (_, index) => document.frames[index]?.id ?? null)
  } else {
    if (!Array.isArray(options.mapFrameIds) || options.mapFrameIds.length !== mapWidth * mapHeight) {
      fail('INVALID_TILEMAP', 'options.mapFrameIds must match mapWidth × mapHeight')
    }
    mapFrameIds = options.mapFrameIds.map((frameId, index) => (
      frameId === null ? null : assertFrameId(frameIds, frameId, `options.mapFrameIds[${index}]`)
    ))
  }
  const animationName = typeof options.animationName === 'string' && options.animationName.trim()
    ? options.animationName.trim().slice(0, 64)
    : 'default'
  const animationTagId = options.animationTagId ?? document.animationTags[0]?.id ?? null
  if (animationTagId !== null && (
    typeof animationTagId !== 'string'
    || !document.animationTags.some((tag) => tag.id === animationTagId)
  )) {
    fail('UNKNOWN_ANIMATION_TAG', 'options.animationTagId must reference an existing animation tag')
  }
  return {
    columns,
    padding,
    spacing,
    baseName: safePixelFilename(options.baseName ?? document.name),
    directionFrameIds,
    mapWidth,
    mapHeight,
    mapFrameIds,
    animationName,
    animationTagId,
  }
}

export function createPixelGameManifest(documentInput, optionsInput = {}) {
  const document = assertPixelDocument(documentInput)
  const options = normalizePixelGameOptions(document, optionsInput)
  const layout = createSpriteSheetLayout(document, {
    columns: options.columns,
    padding: options.padding,
    spacing: options.spacing,
  })
  const cellByFrame = new Map(layout.cells.map((cell) => [cell.frameId, cell]))
  const frames = document.frames.map((frame) => {
    const cell = cellByFrame.get(frame.id)
    return {
      id: frame.id,
      name: frame.name,
      durationMs: frame.durationMs,
      atlas: { x: cell.x, y: cell.y, width: cell.width, height: cell.height },
      anchor: { ...frame.gameplay.anchor },
      collisions: frame.gameplay.collisions.map((collision) => ({ ...collision })),
      tileRule: frame.gameplay.tileRule ? { ...frame.gameplay.tileRule } : null,
    }
  })
  const directions = PIXEL_DIRECTIONS.map((direction) => {
    const frameId = options.directionFrameIds[direction.id]
    return { ...direction, frameId, frameIndex: document.frames.findIndex((frame) => frame.id === frameId) }
  })
  const animationSequences = new Map(resolvePixelAnimationSequences(document).map((sequence) => [sequence.tagId, sequence.frameIds]))
  const animations = document.animationTags.map((tag) => ({
    id: tag.id,
    name: tag.name,
    direction: tag.direction,
    loop: tag.loop,
    frames: animationSequences.get(tag.id).map((frameId) => ({
      id: frameId,
      durationMs: document.frames.find((frame) => frame.id === frameId).durationMs,
    })),
  }))
  const selectedAnimation = options.animationTagId
    ? animations.find((animation) => animation.id === options.animationTagId)
    : null
  const tileIds = new Map(layout.cells.map((cell) => [cell.frameId, cell.index + 1]))
  return {
    schemaVersion: PIXEL_DOCUMENT_SCHEMA_VERSION,
    kind: 'aeonquill.pixel-game-bundle',
    sourceDocumentId: document.id,
    sourceRevision: document.revision,
    image: `${options.baseName}-sprite-sheet.png`,
    canvas: { width: document.width, height: document.height },
    atlas: {
      width: layout.width,
      height: layout.height,
      columns: layout.columns,
      rows: layout.rows,
      padding: layout.padding,
      spacing: layout.spacing,
    },
    animation: selectedAnimation ?? {
      id: 'default',
      name: options.animationName,
      direction: 'forward',
      loop: true,
      frames: frames.map((frame) => ({ id: frame.id, durationMs: frame.durationMs })),
    },
    animations,
    animationEvents: document.animationEvents.map((event) => ({ ...event })),
    frames,
    directions,
    tilemap: {
      width: options.mapWidth,
      height: options.mapHeight,
      tileWidth: document.width,
      tileHeight: document.height,
      data: options.mapFrameIds.map((frameId) => frameId === null ? 0 : tileIds.get(frameId)),
      frameIds: [...options.mapFrameIds],
    },
    layerGroups: document.layerGroups.map((group) => ({ ...group })),
    layers: document.layers.map((layer) => ({ ...layer })),
    palette: document.palette.map((color) => ({ ...color })),
    paletteCycles: document.paletteCycles.map((cycle) => ({ ...cycle, colorIds: [...cycle.colorIds] })),
    terrainMaps: structuredClone(document.terrainMaps),
  }
}

function createTiledTileset(manifest, baseName) {
  const terrainIds = [...new Set(manifest.frames
    .map((frame) => frame.tileRule?.terrainId)
    .filter(Boolean))]
  const wangBits = [1, 2, 4, 8, 16, 32, 64, 128]
  return {
    columns: manifest.atlas.columns,
    image: manifest.image,
    imageheight: manifest.atlas.height,
    imagewidth: manifest.atlas.width,
    margin: manifest.atlas.padding,
    name: baseName,
    spacing: manifest.atlas.spacing,
    tilecount: manifest.frames.length,
    tileheight: manifest.canvas.height,
    tilewidth: manifest.canvas.width,
    type: 'tileset',
    version: '1.10',
    tiledversion: '1.10.2',
    tiles: manifest.frames.map((frame, index) => ({
      id: index,
      properties: [
        { name: 'frameId', type: 'string', value: frame.id },
        { name: 'anchorX', type: 'int', value: frame.anchor.x },
        { name: 'anchorY', type: 'int', value: frame.anchor.y },
        { name: 'durationMs', type: 'int', value: frame.durationMs },
        ...(frame.tileRule ? [
          { name: 'terrainId', type: 'string', value: frame.tileRule.terrainId },
          { name: 'terrainBitmask', type: 'int', value: frame.tileRule.bitmask },
        ] : []),
      ],
      ...(frame.collisions.length > 0 ? {
        objectgroup: {
          draworder: 'index',
          id: index + 1,
          name: `${frame.name} Collisions`,
          objects: frame.collisions.map((collision, collisionIndex) => ({
            class: collision.type,
            height: collision.height,
            id: collisionIndex + 1,
            name: collision.name,
            rotation: 0,
            type: collision.type,
            visible: true,
            width: collision.width,
            x: collision.x,
            y: collision.y,
            properties: [{ name: 'aeonquillId', type: 'string', value: collision.id }],
          })),
          opacity: 1,
          type: 'objectgroup',
          visible: true,
          x: 0,
          y: 0,
        },
      } : {}),
    })),
    wangsets: terrainIds.map((terrainId) => ({
      name: terrainId,
      tile: -1,
      type: 'mixed',
      colors: [{
        color: '#8A71FF',
        name: terrainId,
        probability: 1,
        tile: -1,
      }],
      wangtiles: manifest.frames.flatMap((frame, tileid) => (
        frame.tileRule?.terrainId === terrainId
          ? [{
              tileid,
              wangid: wangBits.map((bit) => (frame.tileRule.bitmask & bit) === bit ? 1 : 0),
            }]
          : []
      )),
    })),
  }
}

function createTiledMap(manifest, tilesetFilename) {
  return {
    compressionlevel: -1,
    height: manifest.tilemap.height,
    infinite: false,
    layers: [{
      data: [...manifest.tilemap.data],
      height: manifest.tilemap.height,
      id: 1,
      name: 'AEONQUILL Tilemap',
      opacity: 1,
      type: 'tilelayer',
      visible: true,
      width: manifest.tilemap.width,
      x: 0,
      y: 0,
    }],
    nextlayerid: 2,
    nextobjectid: 1,
    orientation: 'orthogonal',
    renderorder: 'right-down',
    tiledversion: '1.10.2',
    tileheight: manifest.tilemap.tileHeight,
    tilesets: [{ firstgid: 1, source: tilesetFilename }],
    tilewidth: manifest.tilemap.tileWidth,
    type: 'map',
    version: '1.10',
    width: manifest.tilemap.width,
  }
}

function safeEmbeddedJson(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026')
}

function createViewerHtml(manifest) {
  const data = safeEmbeddedJson(manifest)
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AEONQUILL Pixel Game Preview</title><style>
html{color-scheme:dark;font-family:system-ui,sans-serif;background:#101216;color:#f7f8fb}body{margin:0;padding:24px;display:grid;gap:20px}header{display:flex;justify-content:space-between;align-items:end}h1{font-size:22px;margin:0}small{color:#a1abff}main{display:grid;grid-template-columns:minmax(280px,1fr) minmax(240px,360px);gap:20px}.panel{background:#171a22;border:1px solid #333849;padding:16px}canvas{width:100%;image-rendering:pixelated;background:repeating-conic-gradient(#252936 0 25%,#1d202a 0 50%) 0/24px 24px}button{background:#6d7dff;color:#fff;border:0;padding:9px 12px;cursor:pointer}.directions{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}.directions button{background:#2b3040}.meta{font:12px ui-monospace,monospace;color:#c8ccef;white-space:pre-wrap}@media(max-width:720px){main{grid-template-columns:1fr}}
</style></head><body><header><div><small>AEONQUILL / PIXEL</small><h1>游戏资产交付预览</h1></div><button id="play">暂停动画</button></header><main><section class="panel"><canvas id="view"></canvas></section><aside class="panel"><div class="directions" id="directions"></div><p class="meta" id="meta"></p></aside></main>
<script>
const manifest=${data};
const image=new Image();image.src=manifest.image;
const canvas=document.querySelector('#view');const ctx=canvas.getContext('2d');ctx.imageSmoothingEnabled=false;
canvas.width=manifest.canvas.width;canvas.height=manifest.canvas.height;
let playing=true,index=0,last=0,manual=null;
const frames=new Map(manifest.frames.map(f=>[f.id,f]));
const collisionColors={solid:'#FFB020',hitbox:'#FF4D6D',hurtbox:'#4CC9F0',interaction:'#6EE7B7'};
function draw(frame){
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.drawImage(image,frame.atlas.x,frame.atlas.y,frame.atlas.width,frame.atlas.height,0,0,canvas.width,canvas.height);
  frame.collisions.forEach(shape=>{ctx.strokeStyle=collisionColors[shape.type]||'#FFFFFF';ctx.lineWidth=.6;ctx.strokeRect(shape.x+.3,shape.y+.3,Math.max(.4,shape.width-.6),Math.max(.4,shape.height-.6));});
  const ax=Math.min(canvas.width-.25,Math.max(.25,frame.anchor.x));const ay=Math.min(canvas.height-.25,Math.max(.25,frame.anchor.y));
  ctx.strokeStyle='#B596FF';ctx.lineWidth=.5;ctx.beginPath();ctx.moveTo(Math.max(0,ax-1.5),ay);ctx.lineTo(Math.min(canvas.width,ax+1.5),ay);ctx.moveTo(ax,Math.max(0,ay-1.5));ctx.lineTo(ax,Math.min(canvas.height,ay+1.5));ctx.stroke();
  const tile=frame.tileRule?'\\nTerrain '+frame.tileRule.terrainId+' · mask '+frame.tileRule.bitmask:'\\nTerrain 未设置';
  const events=manifest.animationEvents.filter(event=>event.animationTagId===manifest.animation.id&&event.frameId===frame.id);
  const eventText=events.length?'\\n事件 '+events.map(event=>event.name+' ['+event.type+']'+(event.value?' = '+event.value:'')).join(' / '):'\\n事件 无';
  const activeCycles=manifest.paletteCycles.filter(cycle=>cycle.enabled);
  const cycleText='\\n调色板循环 '+(activeCycles.length?activeCycles.map(cycle=>cycle.name+' · '+cycle.direction+' · '+cycle.stepDurationMs+'ms').join(' / '):'无');
  document.querySelector('#meta').textContent=frame.name+' · '+frame.durationMs+'ms\\n锚点 '+frame.anchor.x+','+frame.anchor.y+'\\n碰撞区 '+frame.collisions.length+tile+eventText+cycleText+'\\n图块 '+manifest.tilemap.width+'×'+manifest.tilemap.height;
}
function loop(now){const seq=manifest.animation.frames;if(image.complete&&seq.length){const ref=manual?frames.get(manual):frames.get(seq[index].id);draw(ref);if(playing&&!manual&&now-last>=seq[index].durationMs){last=now;index=(index+1)%seq.length;}}requestAnimationFrame(loop)}
document.querySelector('#play').onclick=e=>{playing=!playing;manual=null;e.target.textContent=playing?'暂停动画':'播放动画'};
const list=document.querySelector('#directions');manifest.directions.forEach(d=>{const b=document.createElement('button');b.textContent=d.label;b.onclick=()=>{manual=d.frameId;playing=false;document.querySelector('#play').textContent='播放动画'};list.append(b)});
image.onload=()=>requestAnimationFrame(loop);
</script></body></html>`
}

export function createPixelGameExportBundle(documentInput, optionsInput = {}) {
  const document = assertPixelDocument(documentInput)
  const options = normalizePixelGameOptions(document, optionsInput)
  const base = createPixelExportBundle(document, {
    columns: options.columns,
    padding: options.padding,
    spacing: options.spacing,
    baseName: options.baseName,
  })
  const manifest = createPixelGameManifest(document, options)
  const tilesetFilename = `${options.baseName}-tileset.tsj`
  const mapFilename = `${options.baseName}-tilemap.tmj`
  const manifestText = JSON.stringify(manifest, null, 2)
  return {
    project: base.project,
    sprite: base.sprite,
    manifest: {
      filename: `${options.baseName}-game-manifest.json`,
      mime: 'application/json',
      text: manifestText,
      value: manifest,
    },
    tiledTileset: {
      filename: tilesetFilename,
      mime: 'application/json',
      text: JSON.stringify(createTiledTileset(manifest, options.baseName), null, 2),
    },
    tiledMap: {
      filename: mapFilename,
      mime: 'application/json',
      text: JSON.stringify(createTiledMap(manifest, tilesetFilename), null, 2),
    },
    viewer: {
      filename: `${options.baseName}-preview.html`,
      mime: 'text/html',
      text: createViewerHtml(manifest),
    },
  }
}

export function createPixelAnimationClipExportBundle(documentInput, tagId, optionsInput = {}) {
  const document = assertPixelDocument(documentInput)
  const options = assertRecord(optionsInput, 'options')
  assertKnownFields(options, new Set(['columns', 'padding', 'spacing', 'baseName']), 'options')
  const tag = document.animationTags.find((item) => item.id === tagId)
  if (!tag) fail('UNKNOWN_ANIMATION_TAG', `Unknown animation tag ${String(tagId)}`)
  const fromIndex = document.frames.findIndex((frame) => frame.id === tag.fromFrameId)
  const toIndex = document.frames.findIndex((frame) => frame.id === tag.toFrameId)
  const uniqueFrameCount = toIndex - fromIndex + 1
  const columns = assertInteger(options.columns ?? Math.min(4, uniqueFrameCount), 'options.columns', 1, uniqueFrameCount)
  const padding = assertInteger(options.padding ?? 1, 'options.padding', 0, 64)
  const spacing = assertInteger(options.spacing ?? 1, 'options.spacing', 0, 64)
  const baseName = safePixelFilename(options.baseName ?? document.name)
  const clipName = `${baseName}-${safePixelFilename(tag.name, tag.id)}-clip`
  const clip = renderPixelAnimationClipRgba(document, tag.id, { columns, padding, spacing })
  return {
    sprite: {
      filename: `${clipName}.png`,
      mime: 'image/png',
      width: clip.layout.width,
      height: clip.layout.height,
      pixels: clip.pixels,
    },
    manifest: {
      filename: `${clipName}.json`,
      mime: 'application/json',
      text: JSON.stringify(clip.metadata, null, 2),
      value: clip.metadata,
    },
  }
}

export function createPixelTerrainPreviewExportBundle(documentInput, optionsInput = {}) {
  const document = assertPixelDocument(documentInput)
  const options = assertRecord(optionsInput, 'options')
  assertKnownFields(options, new Set(['terrainId', 'occupancy', 'baseName']), 'options')
  const rendered = renderPixelTerrainPreviewRgba(document, {
    ...(options.terrainId === undefined ? {} : { terrainId: options.terrainId }),
    ...(options.occupancy === undefined ? {} : { occupancy: options.occupancy }),
  })
  const baseName = safePixelFilename(options.baseName ?? document.name)
  const terrainName = safePixelFilename(rendered.layout.terrainId, 'terrain')
  const previewName = `${baseName}-${terrainName}-terrain-preview`
  const image = `${previewName}.png`
  const metadata = { ...rendered.layout, image }
  return {
    sprite: {
      filename: image,
      mime: 'image/png',
      width: rendered.width,
      height: rendered.height,
      pixels: rendered.pixels,
    },
    manifest: {
      filename: `${previewName}.json`,
      mime: 'application/json',
      text: JSON.stringify(metadata, null, 2),
      value: metadata,
    },
  }
}

export function createPixelTerrainMapExportBundle(documentInput, optionsInput = {}) {
  const document = assertPixelDocument(documentInput)
  const options = assertRecord(optionsInput, 'options')
  assertKnownFields(options, new Set(['terrainMapId', 'cells', 'baseName']), 'options')
  const rendered = renderPixelTerrainMapRgba(document, {
    ...(options.terrainMapId === undefined ? {} : { terrainMapId: options.terrainMapId }),
    ...(options.cells === undefined ? {} : { cells: options.cells }),
  })
  const baseName = safePixelFilename(options.baseName ?? document.name)
  const terrainMapName = safePixelFilename(rendered.layout.terrainMapName, rendered.layout.terrainMapId)
  const exportStem = `${baseName}-${terrainMapName}-terrain-map`
  const atlasStem = `${exportStem}-source`
  const atlasOptions = {
    baseName: atlasStem,
    columns: Math.min(4, document.frames.length),
    padding: 1,
    spacing: 1,
  }
  const atlasRender = renderSpriteSheetRgba(document, {
    columns: atlasOptions.columns,
    padding: atlasOptions.padding,
    spacing: atlasOptions.spacing,
  })
  const atlasBundle = {
    sprite: {
      filename: `${atlasStem}-sprite-sheet.png`,
      mime: 'image/png',
      width: atlasRender.layout.width,
      height: atlasRender.layout.height,
      pixels: atlasRender.pixels,
    },
  }
  const gameManifest = createPixelGameManifest(document, atlasOptions)
  const tiledTileset = createTiledTileset(gameManifest, atlasStem)
  const tileIdByFrame = new Map(gameManifest.frames.map((frame, index) => [frame.id, index + 1]))
  const image = `${exportStem}.png`
  const atlas = atlasBundle.sprite.filename
  const sourceTerrainMap = document.terrainMaps.find((terrainMap) => terrainMap.id === rendered.layout.terrainMapId)
  const metadata = {
    ...rendered.layout,
    image,
    atlas,
    terrainLayer: { ...sourceTerrainMap.terrainLayer },
    objectLayers: structuredClone(sourceTerrainMap.objectLayers),
  }
  let nextObjectId = 1
  const objectLayers = sourceTerrainMap.objectLayers.map((objectLayer, layerIndex) => ({
    draworder: 'topdown',
    id: layerIndex + 2,
    name: objectLayer.name,
    objects: objectLayer.objects.map((object) => ({
      class: '',
      height: object.height,
      id: nextObjectId++,
      name: object.name,
      rotation: 0,
      type: '',
      visible: true,
      width: object.width,
      x: object.x,
      y: object.y,
      properties: [
        { name: 'aeonquillId', type: 'string', value: object.id },
        ...(object.frameId === null ? [] : [{ name: 'frameId', type: 'string', value: object.frameId }]),
        ...(object.collisionId === null ? [] : [{ name: 'collisionId', type: 'string', value: object.collisionId }]),
        ...Object.entries(object.properties).map(([name, value]) => ({
          name,
          type: typeof value === 'boolean' ? 'bool' : typeof value === 'number' ? (Number.isInteger(value) ? 'int' : 'float') : 'string',
          value,
        })),
      ],
    })),
    opacity: 1,
    properties: [{ name: 'aeonquillLocked', type: 'bool', value: objectLayer.locked }],
    type: 'objectgroup',
    visible: objectLayer.visible,
    x: 0,
    y: 0,
  }))
  const tiledMap = {
    compressionlevel: -1,
    height: rendered.layout.grid.height,
    infinite: false,
    layers: [{
      data: rendered.layout.cells.map((cell) => (
        cell.occupied && cell.frameId !== null ? tileIdByFrame.get(cell.frameId) : 0
      )),
      height: rendered.layout.grid.height,
      id: 1,
      name: rendered.layout.terrainMapName,
      opacity: 1,
      type: 'tilelayer',
      visible: sourceTerrainMap.terrainLayer.visible,
      width: rendered.layout.grid.width,
      x: 0,
      y: 0,
    }, ...objectLayers],
    nextlayerid: objectLayers.length + 2,
    nextobjectid: nextObjectId,
    orientation: 'orthogonal',
    properties: [
      { name: 'aeonquillTerrainMapId', type: 'string', value: rendered.layout.terrainMapId },
      { name: 'aeonquillTerrainIds', type: 'string', value: JSON.stringify(rendered.layout.terrainIds) },
      { name: 'aeonquillTerrainGrid', type: 'string', value: JSON.stringify(rendered.layout.terrainGrid) },
      { name: 'aeonquillSourceDocumentId', type: 'string', value: document.id },
      { name: 'aeonquillSourceRevision', type: 'int', value: document.revision },
      { name: 'aeonquillTerrainLayerLocked', type: 'bool', value: sourceTerrainMap.terrainLayer.locked },
    ],
    renderorder: 'right-down',
    tiledversion: '1.10.2',
    tileheight: document.height,
    tilesets: [{ firstgid: 1, ...tiledTileset }],
    tilewidth: document.width,
    type: 'map',
    version: '1.10',
    width: rendered.layout.grid.width,
  }
  return {
    preview: {
      filename: image,
      mime: 'image/png',
      width: rendered.width,
      height: rendered.height,
      pixels: rendered.pixels,
    },
    atlas: atlasBundle.sprite,
    manifest: {
      filename: `${exportStem}.json`,
      mime: 'application/json',
      text: JSON.stringify(metadata, null, 2),
      value: metadata,
    },
    tiledMap: {
      filename: `${exportStem}.tmj`,
      mime: 'application/json',
      text: JSON.stringify(tiledMap, null, 2),
      value: tiledMap,
    },
  }
}

function stableAsciiToken(value) {
  let hash = 0x811c9dc5
  for (const character of String(value)) {
    hash ^= character.codePointAt(0)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function normalizeRpgMakerFrameIds(document, input, fallbackDirectionFrameIds) {
  const frameIds = new Set(document.frames.map((frame) => frame.id))
  const value = input === undefined ? {} : assertRecord(input, 'options.rpgMakerFrameIds')
  assertKnownFields(value, new Set(RPG_MAKER_DIRECTIONS.map((direction) => direction.id)), 'options.rpgMakerFrameIds')
  return Object.fromEntries(RPG_MAKER_DIRECTIONS.map((direction) => {
    const source = value[direction.id] ?? [fallbackDirectionFrameIds[direction.id]]
    if (!Array.isArray(source) || (source.length !== 1 && source.length !== 3)) {
      fail('INVALID_RPG_MAKER_PATTERN', `options.rpgMakerFrameIds.${direction.id} must contain one or three frame ids`)
    }
    const checked = source.map((frameId, index) => (
      assertFrameId(frameIds, frameId, `options.rpgMakerFrameIds.${direction.id}[${index}]`)
    ))
    return [direction.id, {
      sourcePatternCount: checked.length,
      frameIds: checked.length === 1 ? [checked[0], checked[0], checked[0]] : checked,
    }]
  }))
}

function normalizePixelEngineBridgeOptions(document, optionsInput) {
  const options = assertRecord(optionsInput, 'options')
  assertKnownFields(options, new Set([
    ...PIXEL_GAME_OPTION_FIELDS,
    'pixelsPerUnit',
    'rpgMakerFrameIds',
  ]), 'options')
  const gameOptionsInput = Object.fromEntries(PIXEL_GAME_OPTION_FIELDS.flatMap((key) => (
    Object.hasOwn(options, key) ? [[key, options[key]]] : []
  )))
  const gameOptions = normalizePixelGameOptions(document, gameOptionsInput)
  return {
    gameOptions,
    pixelsPerUnit: assertInteger(options.pixelsPerUnit ?? document.height, 'options.pixelsPerUnit', 1, 4096),
    rpgMakerFrameIds: normalizeRpgMakerFrameIds(document, options.rpgMakerFrameIds, gameOptions.directionFrameIds),
  }
}

function renderRpgMakerCharacterRgba(document, rpgMakerFrameIds) {
  const width = document.width * 3
  const height = document.height * RPG_MAKER_DIRECTIONS.length
  const pixels = new Uint8ClampedArray(width * height * 4)
  const framePixelsById = new Map()
  const cells = []
  for (const [row, direction] of RPG_MAKER_DIRECTIONS.entries()) {
    const mapping = rpgMakerFrameIds[direction.id]
    for (const [column, frameId] of mapping.frameIds.entries()) {
      let source = framePixelsById.get(frameId)
      if (!source) {
        source = renderPixelFrameRgba(document, frameId)
        framePixelsById.set(frameId, source)
      }
      for (let sourceRow = 0; sourceRow < document.height; sourceRow += 1) {
        const sourceStart = sourceRow * document.width * 4
        const targetStart = ((row * document.height + sourceRow) * width + column * document.width) * 4
        pixels.set(source.subarray(sourceStart, sourceStart + document.width * 4), targetStart)
      }
      cells.push({
        row,
        column,
        direction: direction.id,
        directionLabel: direction.label,
        frameId,
        repeated: mapping.sourcePatternCount === 1,
      })
    }
  }
  return { pixels, width, height, cells }
}

function createGodotImporterScript(manifestFilename, outputFilename) {
  return `@tool
extends EditorScript

const BRIDGE_MANIFEST := ${JSON.stringify(manifestFilename)}
const OUTPUT_RESOURCE := ${JSON.stringify(outputFilename)}

func _safe_sibling_filename(value: Variant) -> bool:
    var filename := str(value)
    return (
        not filename.is_empty()
        and filename.to_lower().ends_with(".png")
        and filename == filename.get_file()
        and not filename.contains("/")
        and not filename.contains("\\\\")
        and not filename.contains(":")
        and filename != "."
        and filename != ".."
    )

func _run() -> void:
    var base_dir := get_script().resource_path.get_base_dir()
    var manifest_path := base_dir.path_join(BRIDGE_MANIFEST)
    var file := FileAccess.open(manifest_path, FileAccess.READ)
    if file == null:
        push_error("AEONQUILL: cannot open " + manifest_path)
        return
    var manifest = JSON.parse_string(file.get_as_text())
    if typeof(manifest) != TYPE_DICTIONARY or manifest.get("kind") != "aeonquill.pixel-engine-bridge" or manifest.get("schemaVersion") != 1:
        push_error("AEONQUILL: unsupported bridge manifest")
        return
    var files = manifest.get("files")
    var frames = manifest.get("frames")
    var animations = manifest.get("animations")
    if typeof(files) != TYPE_DICTIONARY or not _safe_sibling_filename(files.get("sprite")):
        push_error("AEONQUILL: sprite must be a safe sibling filename")
        return
    if typeof(frames) != TYPE_ARRAY or frames.is_empty() or typeof(animations) != TYPE_ARRAY:
        push_error("AEONQUILL: frames and animations must be arrays")
        return
    var sprite_path := base_dir.path_join(str(files["sprite"]))
    var sprite_texture := load(sprite_path) as Texture2D
    if sprite_texture == null:
        push_error("AEONQUILL: sprite atlas is not imported: " + sprite_path)
        return
    var source_by_id := {}
    var texture_size := sprite_texture.get_size()
    for source_frame in frames:
        if typeof(source_frame) != TYPE_DICTIONARY or str(source_frame.get("id")).is_empty():
            push_error("AEONQUILL: every frame needs a non-empty id")
            return
        var frame_id := str(source_frame["id"])
        if source_by_id.has(frame_id):
            push_error("AEONQUILL: duplicate frame id " + frame_id)
            return
        var region = source_frame.get("atlas")
        if typeof(region) != TYPE_DICTIONARY:
            push_error("AEONQUILL: frame atlas is missing")
            return
        var region_x := float(region.get("x", -1))
        var region_y := float(region.get("y", -1))
        var region_width := float(region.get("width", 0))
        var region_height := float(region.get("height", 0))
        if (
            region_x < 0 or region_y < 0 or region_width <= 0 or region_height <= 0
            or region_x + region_width > texture_size.x or region_y + region_height > texture_size.y
        ):
            push_error("AEONQUILL: frame atlas is outside the sprite texture")
            return
        source_by_id[frame_id] = source_frame
    var library := SpriteFrames.new()
    library.clear_all()
    if library.has_animation("default"):
        library.remove_animation("default")
    for animation in animations:
        if typeof(animation) != TYPE_DICTIONARY or typeof(animation.get("frames")) != TYPE_ARRAY:
            push_error("AEONQUILL: invalid animation entry")
            return
        var animation_name := str(animation.get("name"))
        if animation_name.is_empty():
            push_error("AEONQUILL: animation name cannot be empty")
            return
        if library.has_animation(animation_name):
            animation_name += "_" + str(animation["id"])
        library.add_animation(animation_name)
        library.set_animation_speed(animation_name, 1000.0)
        library.set_animation_loop_mode(animation_name, SpriteFrames.LOOP_LINEAR if bool(animation.get("loop", false)) else SpriteFrames.LOOP_NONE)
        for frame_ref in animation["frames"]:
            if typeof(frame_ref) != TYPE_DICTIONARY:
                push_error("AEONQUILL: invalid animation frame reference")
                return
            var source_frame = source_by_id.get(str(frame_ref.get("id")))
            if source_frame == null:
                push_error("AEONQUILL: animation references an unknown frame")
                return
            var duration_ms := float(frame_ref.get("durationMs", 0))
            if duration_ms < 1 or duration_ms > 60000:
                push_error("AEONQUILL: frame duration must be between 1 and 60000 ms")
                return
            var region = source_frame["atlas"]
            var frame_texture := AtlasTexture.new()
            frame_texture.atlas = sprite_texture
            frame_texture.region = Rect2(float(region["x"]), float(region["y"]), float(region["width"]), float(region["height"]))
            library.add_frame(animation_name, frame_texture, duration_ms)
    var output_path := base_dir.path_join(OUTPUT_RESOURCE)
    var result := ResourceSaver.save(library, output_path)
    if result != OK:
        push_error("AEONQUILL: ResourceSaver failed with code " + str(result))
        return
    print("AEONQUILL: saved SpriteFrames to " + output_path)
`
}

function createUnityImporterScript(className) {
  return `// AEONQUILL Pixel Bridge · Unity 2021.2+
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.U2D.Sprites;
using UnityEngine;

internal static class ${className}
{
    [Serializable] private sealed class BridgeFiles { public string sprite; }
    [Serializable] private sealed class AtlasRect { public float x; public float y; public float width; public float height; }
    [Serializable] private sealed class Anchor { public float x; public float y; }
    [Serializable] private sealed class Frame { public string id; public string name; public AtlasRect atlas; public Anchor anchor; }
    [Serializable] private sealed class UnitySettings { public float pixelsPerUnit; public string yConversion; }
    [Serializable] private sealed class BridgeManifest
    {
        public int schemaVersion;
        public string kind;
        public int sourceRevision;
        public BridgeFiles files;
        public Frame[] frames;
        public UnitySettings unity;
    }

    [MenuItem("Assets/AEONQUILL/Import selected pixel bridge (${className})")]
    private static void ImportSelected()
    {
        var manifestPath = AssetDatabase.GetAssetPath(Selection.activeObject);
        if (string.IsNullOrEmpty(manifestPath) || !manifestPath.EndsWith("-engine-bridge.json", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Select an AEONQUILL *-engine-bridge.json file inside Assets.");
        var manifest = JsonUtility.FromJson<BridgeManifest>(File.ReadAllText(manifestPath));
        if (manifest == null || manifest.schemaVersion != 1 || manifest.kind != "aeonquill.pixel-engine-bridge" ||
            manifest.files == null || manifest.unity == null || manifest.frames == null || manifest.frames.Length == 0)
            throw new InvalidDataException("Unsupported AEONQUILL bridge manifest.");
        if (!IsSafeSiblingFilename(manifest.files.sprite))
            throw new InvalidDataException("Sprite must be a safe PNG filename beside the manifest.");
        if (!IsFinite(manifest.unity.pixelsPerUnit) || manifest.unity.pixelsPerUnit <= 0f || manifest.unity.pixelsPerUnit > 4096f)
            throw new InvalidDataException("pixelsPerUnit must be finite and between 0 and 4096.");
        var directory = Path.GetDirectoryName(manifestPath)?.Replace('\\\\', '/') ?? "Assets";
        var texturePath = directory + "/" + manifest.files.sprite;
        var importer = AssetImporter.GetAtPath(texturePath) as TextureImporter;
        if (importer == null)
            throw new FileNotFoundException("Sprite atlas must be placed beside the manifest.", texturePath);
        var texture = AssetDatabase.LoadAssetAtPath<Texture2D>(texturePath);
        if (texture == null)
            throw new InvalidDataException("Sprite atlas could not be loaded as Texture2D.");
        var stableNames = new HashSet<string>(StringComparer.Ordinal);
        foreach (var frame in manifest.frames)
        {
            if (frame == null || string.IsNullOrWhiteSpace(frame.id) || string.IsNullOrWhiteSpace(frame.name) || frame.atlas == null || frame.anchor == null)
                throw new InvalidDataException("Every frame needs id, name, atlas and anchor data.");
            if (!IsFinite(frame.atlas.x) || !IsFinite(frame.atlas.y) || !IsFinite(frame.atlas.width) || !IsFinite(frame.atlas.height) ||
                frame.atlas.x < 0f || frame.atlas.y < 0f || frame.atlas.width <= 0f || frame.atlas.height <= 0f ||
                frame.atlas.x + frame.atlas.width > texture.width || frame.atlas.y + frame.atlas.height > texture.height)
                throw new InvalidDataException("Frame atlas rectangle is outside the sprite texture.");
            if (!IsFinite(frame.anchor.x) || !IsFinite(frame.anchor.y))
                throw new InvalidDataException("Frame anchor must be finite.");
            if (!stableNames.Add(frame.name + "__" + frame.id))
                throw new InvalidDataException("Frame names and ids must form unique sprite names.");
        }
        importer.textureType = TextureImporterType.Sprite;
        importer.spriteImportMode = SpriteImportMode.Multiple;
        importer.spritePixelsPerUnit = manifest.unity.pixelsPerUnit;
        importer.mipmapEnabled = false;
        importer.filterMode = FilterMode.Point;
        importer.textureCompression = TextureImporterCompression.Uncompressed;
        importer.alphaIsTransparency = true;
        importer.wrapMode = TextureWrapMode.Clamp;
        importer.SaveAndReimport();
        texture = AssetDatabase.LoadAssetAtPath<Texture2D>(texturePath);
        if (texture == null)
            throw new InvalidDataException("Sprite atlas disappeared after reimport.");
        var factory = new SpriteDataProviderFactories();
        factory.Init();
        var provider = factory.GetSpriteEditorDataProviderFromObject(texture);
        if (provider == null)
            throw new InvalidOperationException("Unity 2D Sprite package with Sprite Editor Data Provider is required.");
        provider.InitSpriteEditorDataProvider();
        var existing = provider.GetSpriteRects().ToDictionary(item => item.name, item => item.spriteID);
        var rects = manifest.frames.Select(frame => {
            var stableName = frame.name + "__" + frame.id;
            var pivotX = Mathf.Clamp01(frame.anchor.x / Math.Max(1f, frame.atlas.width));
            var pivotY = Mathf.Clamp01(1f - frame.anchor.y / Math.Max(1f, frame.atlas.height));
            return new SpriteRect {
                name = stableName,
                spriteID = existing.TryGetValue(stableName, out var id) ? id : GUID.Generate(),
                rect = new Rect(frame.atlas.x, texture.height - frame.atlas.y - frame.atlas.height, frame.atlas.width, frame.atlas.height),
                alignment = SpriteAlignment.Custom,
                pivot = new Vector2(pivotX, pivotY)
            };
        }).ToArray();
        provider.SetSpriteRects(rects);
        var names = provider.GetDataProvider<ISpriteNameFileIdDataProvider>();
        if (names == null)
            throw new InvalidOperationException("Unity 2D Sprite package with Sprite Editor Data Provider is required.");
        names.SetNameFileIdPairs(rects.Select(item => new SpriteNameFileIdPair(item.name, item.spriteID)));
        provider.Apply();
        (provider.targetObject as AssetImporter)?.SaveAndReimport();
        Selection.activeObject = texture;
        EditorGUIUtility.PingObject(texture);
        Debug.Log($"AEONQUILL: imported {rects.Length} sprites from revision {manifest.sourceRevision}.");
    }

    private static bool IsSafeSiblingFilename(string value)
    {
        return !string.IsNullOrWhiteSpace(value) &&
               value.EndsWith(".png", StringComparison.OrdinalIgnoreCase) &&
               value == Path.GetFileName(value) &&
               value.IndexOfAny(new[] { '/', '\\\\', ':' }) < 0 &&
               value != "." && value != "..";
    }

    private static bool IsFinite(float value)
    {
        return !float.IsNaN(value) && !float.IsInfinity(value);
    }
}
`
}

function createEngineBridgeReadme(files, manifest) {
  return `# AEONQUILL Pixel Engine Bridge

源项目：\`${manifest.sourceDocumentId}\` · revision \`${manifest.sourceRevision}\`

## Godot 4

把本目录复制到 Godot 项目，等待 PNG 导入后，在编辑器中打开并运行 \`${files.godotImporter}\`。脚本读取同目录桥接清单，以 AtlasTexture、1000 FPS 基准和逐帧毫秒相对时长生成 \`${files.godotOutput}\`。碰撞、Terrain、事件和调色板循环保留在 JSON 中，不会被脚本执行。

## Unity 2021.2+

把本目录复制到 \`Assets/\`，确保安装 Unity 2D Sprite 包；选择 \`${files.manifest}\`，执行 \`Assets > AEONQUILL > Import selected pixel bridge\`。脚本通过 Sprite Editor Data Provider 切片，使用 Point、无 Mipmap、无压缩和 \`${manifest.unity.pixelsPerUnit}\` PPU，并把左上原点锚点转换为 Unity 左下原点 pivot。同名 Sprite 在重复导入时复用既有 ID。

## RPG Maker MZ

把 \`${files.rpgMakerCharacter}\` 复制到项目 \`img/characters/\`。文件名以 \`$\` 开头，尺寸为单角色 3×4；行序固定为下、左、右、上。若某方向只映射一帧，三 pattern 会明确重复该帧，不会伪造步态；具体来源见桥接 JSON 的 \`rpgMakerMz.cells\`。

## 边界

本包不执行脚本事件、不嵌入音频，也不把 AEONQUILL 矩形碰撞自动改写为各引擎节点。请保留 \`${files.manifest}\` 作为来源事实。当前格式依据：Godot SpriteFrames/ResourceSaver、Unity Sprite Editor Data Provider，以及 RPG Maker MZ 官方 Asset Standards。

- https://docs.godotengine.org/en/stable/classes/class_spriteframes.html
- https://docs.godotengine.org/en/stable/classes/class_resourcesaver.html
- https://docs.unity3d.com/current/Manual/sprite/sprite-editor/sprite-editor-data-provider-api.html
- https://rpgmakerofficial.com/product/MZ_help-en/01_11_01.html
`
}

export function createPixelEngineBridgeExportBundle(documentInput, optionsInput = {}) {
  const document = assertPixelDocument(documentInput)
  const options = normalizePixelEngineBridgeOptions(document, optionsInput)
  const base = createPixelExportBundle(document, {
    columns: options.gameOptions.columns,
    padding: options.gameOptions.padding,
    spacing: options.gameOptions.spacing,
    baseName: options.gameOptions.baseName,
  })
  const game = createPixelGameManifest(document, options.gameOptions)
  const animations = game.animations.length > 0 ? game.animations : [game.animation]
  const rpgMaker = renderRpgMakerCharacterRgba(document, options.rpgMakerFrameIds)
  const token = stableAsciiToken(document.id)
  const unityClassName = `AeonQuillPixelImporter_${token}`
  const files = {
    sprite: base.sprite.filename,
    manifest: `${options.gameOptions.baseName}-engine-bridge.json`,
    godotImporter: `${options.gameOptions.baseName}-godot-import.gd`,
    godotOutput: `${options.gameOptions.baseName}-sprite-frames.tres`,
    unityImporter: `${unityClassName}.cs`,
    rpgMakerCharacter: `$${options.gameOptions.baseName}-character.png`,
    readme: `${options.gameOptions.baseName}-engine-README.md`,
  }
  const manifest = {
    schemaVersion: 1,
    kind: 'aeonquill.pixel-engine-bridge',
    sourceDocumentId: document.id,
    sourceRevision: document.revision,
    sourceSchemaVersion: document.schemaVersion,
    files,
    coordinateSystem: { origin: 'top-left', unit: 'pixel' },
    frames: game.frames,
    animations,
    animationEvents: game.animationEvents,
    directions: game.directions,
    tilemap: game.tilemap,
    layerGroups: game.layerGroups,
    layers: game.layers,
    palette: game.palette,
    paletteCycles: game.paletteCycles,
    terrainMaps: game.terrainMaps,
    godot: {
      target: 'Godot 4.x',
      durationFps: 1000,
      outputResource: files.godotOutput,
      importer: files.godotImporter,
    },
    unity: {
      target: 'Unity 2021.2+',
      pixelsPerUnit: options.pixelsPerUnit,
      yConversion: 'atlasHeight - top - height',
      texture: { filterMode: 'Point', mipmaps: false, compression: 'Uncompressed', wrapMode: 'Clamp' },
      importer: files.unityImporter,
      stableIdPolicy: 'reuse-existing-name-id',
    },
    rpgMakerMz: {
      target: 'RPG Maker MZ',
      layout: { columns: 3, rows: 4, rowOrder: RPG_MAKER_DIRECTIONS.map((direction) => direction.id) },
      image: files.rpgMakerCharacter,
      cells: rpgMaker.cells,
    },
  }
  return {
    sprite: base.sprite,
    manifest: {
      filename: files.manifest,
      mime: 'application/json',
      text: JSON.stringify(manifest, null, 2),
      value: manifest,
    },
    godotImporter: {
      filename: files.godotImporter,
      mime: 'text/x-gdscript',
      text: createGodotImporterScript(files.manifest, files.godotOutput),
    },
    unityImporter: {
      filename: files.unityImporter,
      mime: 'text/x-csharp',
      text: createUnityImporterScript(unityClassName),
    },
    rpgMakerCharacter: {
      filename: files.rpgMakerCharacter,
      mime: 'image/png',
      width: rpgMaker.width,
      height: rpgMaker.height,
      pixels: rpgMaker.pixels,
    },
    readme: {
      filename: files.readme,
      mime: 'text/markdown',
      text: createEngineBridgeReadme(files, manifest),
    },
  }
}
