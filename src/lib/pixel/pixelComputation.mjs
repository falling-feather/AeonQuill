import {
  assertPixelDocument,
  createSpriteSheetMetadata,
  renderPixelFrameRgba,
  renderPixelFramesRgba,
  renderSpriteSheetRgba,
} from './pixelCore.mjs'
import { createPixelExportBundle } from './pixelConversion.mjs'
import {
  createPixelAnimationClipExportBundle,
  createPixelEngineBridgeExportBundle,
  createPixelGameExportBundle,
  createPixelTerrainMapExportBundle,
  inspectPixelTerrainCoverage,
  renderPixelTerrainMapRgba,
  renderPixelTerrainPreviewRgba,
} from './pixelGamePipeline.mjs'

export const PIXEL_COMPUTATION_DEFAULT_BUDGET_BYTES = 64 * 1024 * 1024
export const PIXEL_COMPUTATION_OPERATIONS = Object.freeze([
  'frame',
  'frames',
  'sprite-sheet',
  'terrain-map',
  'terrain-preview',
  'coverage',
  'game-export',
  'engine-export',
  'clip-export',
  'pixel-export',
  'terrain-map-export',
])

const OPERATION_SET = new Set(PIXEL_COMPUTATION_OPERATIONS)
const REQUEST_FIELDS = new Set(['requestId', 'documentId', 'revision', 'operation', 'document', 'options'])
const OPERATION_OPTION_FIELDS = Object.freeze({
  frame: new Set(['frameId', 'includeHiddenLayers', 'paletteCycleElapsedMs', 'budgetBytes']),
  frames: new Set(['frameIds', 'includeHiddenLayers', 'paletteCycleElapsedMs', 'budgetBytes']),
  'sprite-sheet': new Set(['columns', 'padding', 'spacing', 'paletteCycleElapsedMs', 'budgetBytes']),
  'terrain-map': new Set(['terrainMapId', 'cells', 'budgetBytes']),
  'terrain-preview': new Set(['terrainId', 'occupancy', 'budgetBytes']),
  coverage: new Set(['mapId', 'budgetBytes']),
  'game-export': new Set([
    'columns', 'padding', 'spacing', 'baseName', 'directionFrameIds',
    'mapWidth', 'mapHeight', 'mapFrameIds', 'animationName', 'animationTagId', 'budgetBytes',
  ]),
  'pixel-export': new Set(['columns', 'padding', 'spacing', 'baseName', 'frameId', 'budgetBytes']),
  'terrain-map-export': new Set(['terrainMapId', 'cells', 'baseName', 'budgetBytes']),
  'engine-export': new Set([
    'columns', 'padding', 'spacing', 'baseName', 'directionFrameIds',
    'mapWidth', 'mapHeight', 'mapFrameIds', 'animationName', 'animationTagId',
    'pixelsPerUnit', 'rpgMakerFrameIds', 'budgetBytes',
  ]),
  'clip-export': new Set(['tagId', 'columns', 'padding', 'spacing', 'baseName', 'budgetBytes']),
})

export class PixelComputationError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'PixelComputationError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

function fail(code, message, details) {
  throw new PixelComputationError(code, message, details)
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

function assertRequestId(value, path) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) {
    fail('INVALID_REQUEST_ID', `${path} must contain 1-128 characters`, { path })
  }
  return value
}

function assertString(value, path) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) {
    fail('INVALID_STRING', `${path} must contain 1-128 characters`, { path })
  }
  return value
}

function assertInteger(value, path, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('INVALID_INTEGER', `${path} must be an integer between ${min} and ${max}`, { path, value })
  }
  return value
}

function assertOperationOptions(operation, input, document) {
  const options = assertRecord(input, 'request.options')
  assertKnownFields(options, OPERATION_OPTION_FIELDS[operation], 'request.options')
  if (operation === 'frames') {
    if (!Array.isArray(options.frameIds) || options.frameIds.length < 1 || options.frameIds.length > document.frames.length) {
      fail('INVALID_FRAME_IDS', `request.options.frameIds must contain 1-${document.frames.length} ids`)
    }
    const frameIds = new Set(document.frames.map((frame) => frame.id))
    const seen = new Set()
    options.frameIds.forEach((frameId, index) => {
      if (typeof frameId !== 'string' || frameId.length < 1 || frameId.length > 160 || !frameIds.has(frameId)) {
        fail('INVALID_FRAME_IDS', `request.options.frameIds[${index}] is unknown`)
      }
      if (seen.has(frameId)) fail('INVALID_FRAME_IDS', `request.options.frameIds contains duplicate ${frameId}`)
      seen.add(frameId)
    })
  }
  if (options.budgetBytes !== undefined) {
    assertInteger(options.budgetBytes, 'request.options.budgetBytes', 1, Number.MAX_SAFE_INTEGER)
  }
  return options
}

function withoutBudget(options) {
  if (!Object.hasOwn(options, 'budgetBytes')) return options
  const next = { ...options }
  delete next.budgetBytes
  return next
}

function safePositiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function frameBytes(document) {
  return document.width * document.height * 4
}

function spriteBytes(document, options, frameCount = document.frames.length) {
  const columns = Math.min(frameCount, safePositiveInteger(options.columns, Math.ceil(Math.sqrt(frameCount))))
  const padding = Number.isSafeInteger(options.padding) && options.padding >= 0 ? options.padding : 0
  const spacing = Number.isSafeInteger(options.spacing) && options.spacing >= 0 ? options.spacing : 0
  const rows = Math.ceil(frameCount / columns)
  const width = padding * 2 + columns * document.width + Math.max(0, columns - 1) * spacing
  const height = padding * 2 + rows * document.height + Math.max(0, rows - 1) * spacing
  return width * height * 4
}

function estimatePrettyJsonLength(value, depth = 0) {
  if (value === null) return 4
  if (typeof value !== 'object') return JSON.stringify(value).length
  const childIndent = (depth + 1) * 2
  let length = 1
  if (Array.isArray(value)) {
    if (value.length === 0) return 2
    value.forEach((child, index) => {
      length += 1 + childIndent + estimatePrettyJsonLength(child, depth + 1)
      if (index < value.length - 1) length += 1
    })
  } else {
    const keys = Object.keys(value)
    if (keys.length === 0) return 2
    keys.forEach((key, index) => {
      length += 1 + childIndent + JSON.stringify(key).length + 2
      length += estimatePrettyJsonLength(value[key], depth + 1)
      if (index < keys.length - 1) length += 1
    })
  }
  return length + 1 + depth * 2 + 1
}

function estimatePrettyJsonBytes(value) {
  return estimatePrettyJsonLength(value) * 2
}

function findTerrainMap(document, mapId) {
  return document.terrainMaps.find((terrainMap) => terrainMap.id === mapId) ?? document.terrainMaps[0]
}

function clipFrameCount(document, tagId) {
  const tag = document.animationTags.find((candidate) => candidate.id === tagId) ?? document.animationTags[0]
  if (!tag) return document.frames.length
  const from = document.frames.findIndex((frame) => frame.id === tag.fromFrameId)
  const to = document.frames.findIndex((frame) => frame.id === tag.toFrameId)
  return from >= 0 && to >= from ? to - from + 1 : document.frames.length
}

function estimateComputation(document, operation, options) {
  const singleFrame = frameBytes(document)
  if (operation === 'frame') return { outputBytes: singleFrame, intermediateBytes: 0 }
  if (operation === 'frames') {
    return {
      outputBytes: singleFrame * options.frameIds.length,
      intermediateBytes: singleFrame,
    }
  }
  if (operation === 'sprite-sheet') {
    const outputBytes = spriteBytes(document, options)
    return { outputBytes, intermediateBytes: singleFrame }
  }
  if (operation === 'terrain-preview') {
    const outputBytes = document.width * 3 * document.height * 3 * 4
    return { outputBytes, intermediateBytes: singleFrame }
  }
  if (operation === 'terrain-map') {
    const terrainMap = findTerrainMap(document, options.terrainMapId)
    const outputBytes = terrainMap ? document.width * terrainMap.width * document.height * terrainMap.height * 4 : singleFrame
    return { outputBytes, intermediateBytes: singleFrame }
  }
  if (operation === 'coverage') {
    const terrainMap = findTerrainMap(document, options.mapId)
    const cellCount = terrainMap?.cells.length ?? 0
    return { outputBytes: 4096 + cellCount * 192, intermediateBytes: 0 }
  }
  if (operation === 'clip-export') {
    const documentBytes = JSON.stringify(document).length * 2
    const outputBytes = spriteBytes(document, options, clipFrameCount(document, options.tagId))
    return { outputBytes: outputBytes + documentBytes, intermediateBytes: singleFrame }
  }
  if (operation === 'pixel-export') {
    const exportOptions = {
      columns: options.columns,
      padding: options.padding,
      spacing: options.spacing,
    }
    const projectBytes = estimatePrettyJsonBytes(document)
    const metadataBytes = estimatePrettyJsonBytes(createSpriteSheetMetadata(document, exportOptions))
    const outputBytes = spriteBytes(document, options) + singleFrame + projectBytes + metadataBytes
    return {
      outputBytes: outputBytes + 2 * 1024 * 1024,
      intermediateBytes: singleFrame + metadataBytes,
    }
  }
  if (operation === 'game-export') {
    const documentBytes = estimatePrettyJsonBytes(document)
    const outputBytes = spriteBytes(document, options)
    return { outputBytes: outputBytes + singleFrame + documentBytes + 2 * 1024 * 1024, intermediateBytes: singleFrame }
  }
  if (operation === 'terrain-map-export') {
    const terrainMap = findTerrainMap(document, options.terrainMapId)
    const terrainBytes = terrainMap ? document.width * terrainMap.width * document.height * terrainMap.height * 4 : singleFrame
    return { outputBytes: terrainBytes + spriteBytes(document, options) + 3 * 1024 * 1024, intermediateBytes: singleFrame }
  }
  if (operation === 'engine-export') {
    const documentBytes = estimatePrettyJsonBytes(document)
    const outputBytes = spriteBytes(document, options)
    return { outputBytes: outputBytes + singleFrame + documentBytes + 2 * 1024 * 1024, intermediateBytes: singleFrame }
  }
  const outputBytes = spriteBytes(document, options) + document.width * 3 * document.height * 4
  return { outputBytes: outputBytes + 3 * 1024 * 1024, intermediateBytes: singleFrame }
}

function measureBytes(value, seen = new Set()) {
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return 8
  if (typeof value === 'string') return value.length * 2
  if (ArrayBuffer.isView(value)) return value.byteLength
  if (value instanceof ArrayBuffer) return value.byteLength
  if (typeof value !== 'object' || seen.has(value)) return 0
  seen.add(value)
  let total = 0
  for (const [key, child] of Object.entries(value)) total += key.length * 2 + measureBytes(child, seen)
  return total
}

function assertBudget(document, operation, options) {
  const budgetBytes = options.budgetBytes ?? PIXEL_COMPUTATION_DEFAULT_BUDGET_BYTES
  const estimate = estimateComputation(document, operation, options)
  const estimatedBytes = estimate.outputBytes + estimate.intermediateBytes
  if (estimatedBytes > budgetBytes) {
    fail('PIXEL_COMPUTATION_BUDGET', `Pixel ${operation} computation requires approximately ${estimatedBytes} bytes, over the ${budgetBytes}-byte budget`, {
      operation,
      budgetBytes,
      outputBytes: estimate.outputBytes,
      intermediateBytes: estimate.intermediateBytes,
      estimatedBytes,
    })
  }
  return { budgetBytes, estimate }
}

function executeOperation(document, operation, options) {
  const input = withoutBudget(options)
  switch (operation) {
    case 'frame': {
      const { frameId, ...frameOptions } = input
      return renderPixelFrameRgba(document, frameId, frameOptions)
    }
    case 'frames': {
      const { frameIds, ...frameOptions } = input
      return renderPixelFramesRgba(document, frameIds, frameOptions)
    }
    case 'sprite-sheet':
      return renderSpriteSheetRgba(document, input)
    case 'terrain-map':
      return renderPixelTerrainMapRgba(document, input)
    case 'terrain-preview':
      return renderPixelTerrainPreviewRgba(document, input)
    case 'coverage':
      return inspectPixelTerrainCoverage(document, input.mapId)
    case 'game-export':
      return createPixelGameExportBundle(document, input)
    case 'engine-export':
      return createPixelEngineBridgeExportBundle(document, input)
    case 'clip-export': {
      const { tagId, ...clipOptions } = input
      return createPixelAnimationClipExportBundle(document, tagId, clipOptions)
    }
    case 'pixel-export':
      return createPixelExportBundle(document, input)
    case 'terrain-map-export':
      return createPixelTerrainMapExportBundle(document, input)
    default:
      fail('UNKNOWN_OPERATION', `Unsupported pixel computation operation ${String(operation)}`, { operation })
  }
}

export function runPixelComputation(input) {
  const request = assertRecord(input, 'request')
  assertKnownFields(request, REQUEST_FIELDS, 'request')
  const requestId = assertRequestId(request.requestId, 'request.requestId')
  const documentId = assertString(request.documentId, 'request.documentId')
  const revision = assertInteger(request.revision, 'request.revision', 0)
  const operation = assertString(request.operation, 'request.operation')
  if (!OPERATION_SET.has(operation)) fail('UNKNOWN_OPERATION', `Unsupported pixel computation operation ${operation}`, { operation })
  const document = assertPixelDocument(request.document)
  if (document.id !== documentId) fail('DOCUMENT_ID_MISMATCH', 'request.documentId must match document.id', { documentId, actual: document.id })
  if (document.revision !== revision) fail('REVISION_MISMATCH', 'request.revision must match document.revision', { revision, actual: document.revision })
  const options = assertOperationOptions(operation, request.options, document)
  const { budgetBytes } = assertBudget(document, operation, options)
  const result = executeOperation(document, operation, options)
  const actualBytes = operation === 'frames'
    ? result.frames.reduce((total, frame) => total + frame.pixels.byteLength, frameBytes(document))
    : measureBytes(result)
  if (actualBytes > budgetBytes) {
    fail('PIXEL_COMPUTATION_BUDGET', `Pixel ${operation} result contains ${actualBytes} bytes, over the ${budgetBytes}-byte budget`, {
      operation,
      budgetBytes,
      actualBytes,
    })
  }
  return { requestId, documentId, revision, operation, result }
}
