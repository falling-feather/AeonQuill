import {
  assertPixelDocument,
  createPixelDocument,
  createSpriteSheetMetadata,
  renderPixelFrameRgba,
  renderPixelFramesRgba,
  renderSpriteSheetRgba,
  serializePixelDocument,
} from './pixelCore.mjs'
import {
  convertRgbaToPixelDocument,
  createPixelExportBundle,
  extractDeterministicPalette,
  normalizePixelConversionOptions,
} from './pixelConversion.mjs'
import {
  createPixelAnimationClipExportBundle,
  createPixelEngineBridgeExportBundle,
  createPixelGameExportBundle,
  createPixelTerrainMapExportBundle,
  createPixelTerrainMapLayout,
  inspectPixelTerrainCoverage,
  createPixelTerrainPreviewLayout,
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
  'image-convert',
  'game-export',
  'engine-export',
  'clip-export',
  'pixel-export',
  'terrain-map-export',
  'document-json',
])

const OPERATION_SET = new Set(PIXEL_COMPUTATION_OPERATIONS)
const PIXEL_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const RGBA_SOURCE_MAX_SIDE = 16_384
const RGBA_SOURCE_MAX_PIXELS = 16_777_216
const CEL_ARRAY_REFERENCE_BYTES = 16
const GENERATED_PALETTE_REFERENCE_RGBA = new Uint8ClampedArray(256 * 4)
for (let index = 0; index < 256; index += 1) {
  const offset = index * 4
  GENERATED_PALETTE_REFERENCE_RGBA[offset] = index
  GENERATED_PALETTE_REFERENCE_RGBA[offset + 1] = (index * 53) % 256
  GENERATED_PALETTE_REFERENCE_RGBA[offset + 2] = (index * 97) % 256
  GENERATED_PALETTE_REFERENCE_RGBA[offset + 3] = 255
}
const GENERATED_PALETTE_CACHE = new Map()
const REQUEST_FIELDS = new Set(['requestId', 'documentId', 'revision', 'operation', 'document', 'options', 'source'])
const OPERATION_OPTION_FIELDS = Object.freeze({
  'document-json': new Set(['budgetBytes']),
  frame: new Set(['frameId', 'includeHiddenLayers', 'paletteCycleElapsedMs', 'budgetBytes']),
  frames: new Set(['frameIds', 'includeHiddenLayers', 'paletteCycleElapsedMs', 'budgetBytes']),
  'sprite-sheet': new Set(['columns', 'padding', 'spacing', 'paletteCycleElapsedMs', 'budgetBytes']),
  'terrain-map': new Set(['terrainMapId', 'cells', 'budgetBytes']),
  'terrain-preview': new Set(['terrainId', 'occupancy', 'budgetBytes']),
  coverage: new Set(['mapId', 'budgetBytes']),
  'image-convert': null,
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
  if (operation !== 'image-convert') assertKnownFields(options, OPERATION_OPTION_FIELDS[operation], 'request.options')
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

function assertRgbaSourceMetadata(input) {
  const source = assertRecord(input, 'request.source')
  assertKnownFields(source, new Set(['width', 'height', 'data']), 'request.source')
  const width = assertInteger(source.width, 'request.source.width', 1, RGBA_SOURCE_MAX_SIDE)
  const height = assertInteger(source.height, 'request.source.height', 1, RGBA_SOURCE_MAX_SIDE)
  const pixelCount = width * height
  if (pixelCount > RGBA_SOURCE_MAX_PIXELS) {
    fail('SOURCE_TOO_LARGE', `request.source contains ${pixelCount} pixels`, {
      limit: RGBA_SOURCE_MAX_PIXELS,
    })
  }
  const data = source.data
  if (!Array.isArray(data) && !ArrayBuffer.isView(data)) {
    fail('INVALID_RGBA', 'request.source.data must be an array or typed array', { path: 'request.source.data' })
  }
  const expectedLength = pixelCount * 4
  if (data.length !== expectedLength) {
    fail('INVALID_RGBA', `request.source.data must contain exactly ${expectedLength} channels`, {
      path: 'request.source.data',
      expectedLength,
      actualLength: data.length,
    })
  }
  return {
    source,
    width,
    height,
    dataBytes: ArrayBuffer.isView(data) ? data.byteLength : data.length * 8,
  }
}

function assertRequestSource(operation, request) {
  const hasSource = Object.hasOwn(request, 'source')
  if (operation === 'image-convert') {
    if (!hasSource || request.source === undefined) fail('MISSING_SOURCE', 'request.source is required for image-convert')
    return assertRgbaSourceMetadata(request.source)
  }
  if (hasSource) fail('SOURCE_NOT_ALLOWED', `request.source is only allowed for image-convert`, { operation })
  return null
}

function assertSnapshotFrameId(document, value, path) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64) {
    fail('INVALID_STRING', `${path} must contain 1-64 characters`, { path })
  }
  if (!PIXEL_IDENTIFIER_PATTERN.test(value)) {
    fail('INVALID_ID', `${path} is not a safe identifier`, { path })
  }
  if (!document.frames.some((frame) => frame.id === value)) {
    fail('UNKNOWN_FRAME', `Unknown frame ${value}`, { frameId: value })
  }
  return value
}

function assertSnapshotRenderOptions(options) {
  if (options.includeHiddenLayers !== undefined && typeof options.includeHiddenLayers !== 'boolean') {
    fail('INVALID_BOOLEAN', 'options.includeHiddenLayers must be boolean', { path: 'options.includeHiddenLayers' })
  }
  if (options.paletteCycleElapsedMs !== undefined && options.paletteCycleElapsedMs !== null) {
    assertInteger(options.paletteCycleElapsedMs, 'options.paletteCycleElapsedMs', 0, Number.MAX_SAFE_INTEGER)
  }
}

function assertSnapshotOperationInput(document, operation, options) {
  if (operation === 'frame') {
    assertSnapshotFrameId(document, options.frameId, 'options.frameId')
    assertSnapshotRenderOptions(options)
    return
  }
  if (operation === 'frames') {
    assertSnapshotRenderOptions(options)
    return
  }
  if (operation === 'coverage') {
    const mapId = options.mapId
    if (typeof mapId !== 'string' || !PIXEL_IDENTIFIER_PATTERN.test(mapId)) {
      fail('INVALID_TERRAIN_MAP', 'mapId must be a stable terrain map id', { mapId })
    }
    if (!document.terrainMaps.some((terrainMap) => terrainMap.id === mapId)) {
      fail('UNKNOWN_TERRAIN_MAP', `Unknown terrain map ${mapId}`, { mapId })
    }
  }
}

function withoutBudget(options) {
  if (!Object.hasOwn(options, 'budgetBytes')) return options
  const next = { ...options }
  delete next.budgetBytes
  return next
}

function projectDocumentWithBlankCels(document, dependencyFrameIds = new Set()) {
  // A retained frame may share a Cel with another retained layer's frame. Close
  // the dependency set over link groups so strict materialized links stay valid.
  let previousSize = -1
  while (previousSize !== dependencyFrameIds.size) {
    previousSize = dependencyFrameIds.size
    for (const link of document.celLinks) {
      if (link.frameIds.some((frameId) => dependencyFrameIds.has(frameId))) {
        for (const frameId of link.frameIds) dependencyFrameIds.add(frameId)
      }
    }
  }
  const blankCel = Array.from({ length: document.width * document.height }, () => null)
  const frames = document.frames.map((frame) => {
    if (dependencyFrameIds.has(frame.id)) return frame
    return {
      ...frame,
      cels: Object.fromEntries(document.layers.map((layer) => [layer.id, blankCel])),
    }
  })
  return { ...document, frames }
}

function createTerrainComputationSnapshot(document, operation, options) {
  const layout = operation === 'terrain-map'
    ? createPixelTerrainMapLayout(document, options)
    : createPixelTerrainPreviewLayout(document, options)
  const dependencyFrameIds = new Set(
    layout.cells
      .filter((cell) => cell.occupied && cell.frameId !== null)
      .map((cell) => cell.frameId),
  )
  return projectDocumentWithBlankCels(document, dependencyFrameIds)
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

function estimateConversionPalette(options) {
  if (options.palette !== null) return options.palette
  const cacheKey = `${options.colorCount}:${options.alphaMode}`
  let palette = GENERATED_PALETTE_CACHE.get(cacheKey)
  if (!palette) {
    palette = extractDeterministicPalette(GENERATED_PALETTE_REFERENCE_RGBA, {
      colorCount: options.colorCount,
      alphaThreshold: options.alphaThreshold,
      alphaMode: options.alphaMode,
    })
    GENERATED_PALETTE_CACHE.set(cacheKey, palette)
  }
  return palette
}

function estimateImageConversion(sourceMetadata, options) {
  const sourceRgbaBytes = sourceMetadata.width * sourceMetadata.height * 4
  const workerBufferBytes = Math.max(sourceRgbaBytes, sourceMetadata.dataBytes)
  const targetPixels = options.targetWidth * options.targetHeight
  const targetRgbaBytes = targetPixels * 4
  const palette = estimateConversionPalette(options)
  const maxPaletteIdBytes = Math.max(...palette.map((color) => color.id.length * 2))
  const targetCelBytes = targetPixels * (maxPaletteIdBytes + CEL_ARRAY_REFERENCE_BYTES)
  const paletteMetadataBytes = measureBytes(palette)
  const colorExtractionWorkspaceBytes = targetPixels
    * (options.dither === 'floyd-steinberg' ? 64 : 32)
    + options.colorCount * 256
  const outputBytes = targetRgbaBytes + targetCelBytes + paletteMetadataBytes + 64 * 1024
  const intermediateBytes = sourceRgbaBytes
    + workerBufferBytes
    + targetRgbaBytes
    + colorExtractionWorkspaceBytes
  return {
    outputBytes,
    intermediateBytes,
    sourceRgbaBytes,
    workerBufferBytes,
    targetRgbaBytes,
    targetCelBytes,
    paletteMetadataBytes,
    maxPaletteIdBytes,
    colorExtractionWorkspaceBytes,
  }
}

function estimateComputation(document, operation, options, sourceMetadata, normalizedConversionOptions) {
  if (operation === 'document-json') return { outputBytes: JSON.stringify(document).length * 2, intermediateBytes: 0 }
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
  if (operation === 'image-convert') {
    return estimateImageConversion(sourceMetadata, normalizedConversionOptions)
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

function assertBudget(document, operation, options, sourceMetadata, normalizedConversionOptions) {
  const budgetBytes = options.budgetBytes ?? PIXEL_COMPUTATION_DEFAULT_BUDGET_BYTES
  const estimate = estimateComputation(document, operation, options, sourceMetadata, normalizedConversionOptions)
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

function executeOperation(document, operation, options, source) {
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
    case 'image-convert':
      return convertRgbaToPixelDocument(source, input)
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
    case 'document-json':
      return serializePixelDocument(document)
    default:
      fail('UNKNOWN_OPERATION', `Unsupported pixel computation operation ${String(operation)}`, { operation })
  }
}

/**
 * Creates a short-lived, read-only PixelDocument projection for Worker input.
 * The projection may share immutable source substructures; callers must not
 * persist, export, or mutate it or any source Cel through those references.
 */
export function createPixelComputationSnapshot(documentInput, operationInput, optionsInput) {
  const document = assertPixelDocument(documentInput)
  const operation = assertString(operationInput, 'operation')
  if (!OPERATION_SET.has(operation)) fail('UNKNOWN_OPERATION', `Unsupported pixel computation operation ${operation}`, { operation })
  const options = assertOperationOptions(operation, optionsInput, document)
  if (operation === 'image-convert') {
    normalizePixelConversionOptions(withoutBudget(options))
    return createPixelDocument({
      id: document.id,
      name: document.name,
      width: 1,
      height: 1,
      revision: document.revision,
    })
  }
  assertBudget(document, operation, options)
  assertSnapshotOperationInput(document, operation, options)

  if (operation === 'terrain-map' || operation === 'terrain-preview') {
    return createTerrainComputationSnapshot(document, operation, withoutBudget(options))
  }

  if (operation !== 'frame' && operation !== 'frames' && operation !== 'coverage') return document

  if (operation === 'coverage') {
    return projectDocumentWithBlankCels(document)
  }

  const frameIds = operation === 'frame' ? [options.frameId] : options.frameIds
  const selectedFrameIds = new Set(frameIds)
  const frames = frameIds.map((frameId) => {
    const sourceFrame = document.frames.find((frame) => frame.id === frameId)
    return { ...sourceFrame, cels: sourceFrame.cels }
  })
  return {
    ...document,
    frames,
    animationTags: [],
    animationEvents: [],
    terrainMaps: [],
    celLinks: document.celLinks.map((link) => ({ ...link, frameIds: link.frameIds.filter((id) => selectedFrameIds.has(id)) }))
      .filter((link) => link.frameIds.length >= 2),
    activeFrameId: frameIds[0],
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
  const sourceMetadata = assertRequestSource(operation, request)
  const document = assertPixelDocument(request.document)
  if (document.id !== documentId) fail('DOCUMENT_ID_MISMATCH', 'request.documentId must match document.id', { documentId, actual: document.id })
  if (document.revision !== revision) fail('REVISION_MISMATCH', 'request.revision must match document.revision', { revision, actual: document.revision })
  const options = assertOperationOptions(operation, request.options, document)
  const normalizedConversionOptions = operation === 'image-convert'
    ? normalizePixelConversionOptions(withoutBudget(options))
    : null
  const { budgetBytes, estimate } = assertBudget(document, operation, options, sourceMetadata, normalizedConversionOptions)
  const result = executeOperation(document, operation, options, sourceMetadata?.source)
  const resultBytes = operation === 'frames'
    ? result.frames.reduce((total, frame) => total + frame.pixels.byteLength, frameBytes(document))
    : measureBytes(result)
  const actualBytes = operation === 'image-convert'
    ? resultBytes + estimate.intermediateBytes
    : resultBytes
  if (actualBytes > budgetBytes) {
    fail('PIXEL_COMPUTATION_BUDGET', `Pixel ${operation} result contains ${actualBytes} bytes, over the ${budgetBytes}-byte budget`, {
      operation,
      budgetBytes,
      actualBytes,
      ...(operation === 'image-convert' ? {
        resultBytes,
        intermediateBytes: estimate.intermediateBytes,
      } : {}),
    })
  }
  return { requestId, documentId, revision, operation, result }
}
