import {
  PIXEL_DOCUMENT_SCHEMA_VERSION,
  PIXEL_LIMITS,
  PixelContractError,
  assertPixelDocument,
  createPixelDocument,
  migratePixelDocument,
  renderPixelFrameRgba,
  renderSpriteSheetRgba,
  serializePixelDocument,
} from './pixelCore.mjs'

export const PIXEL_PROJECT_MIME = 'application/vnd.aeonquill.pixel+json'
export const PIXEL_PROJECT_EXTENSION = '.aeonpixel.json'
export const PIXEL_METADATA_MIME = 'application/json'
export const PIXEL_PNG_MIME = 'image/png'

export const PIXEL_CONVERSION_DITHER_MODES = Object.freeze(['none', 'bayer4', 'floyd-steinberg'])
export const PIXEL_CONVERSION_FIT_MODES = Object.freeze(['contain', 'cover', 'stretch'])

const DITHER_MODES = new Set(PIXEL_CONVERSION_DITHER_MODES)
const FIT_MODES = new Set(PIXEL_CONVERSION_FIT_MODES)
const SOURCE_MAX_SIDE = 16_384
const SOURCE_MAX_PIXELS = 16_777_216
const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{8}$/

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

function assertInteger(value, path, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('INVALID_INTEGER', `${path} must be an integer between ${min} and ${max}`, { path, min, max })
  }
  return value
}

function assertNumber(value, path, min, max) {
  if (!Number.isFinite(value) || value < min || value > max) {
    fail('INVALID_NUMBER', `${path} must be between ${min} and ${max}`, { path, min, max })
  }
  return value
}

function clampChannel(value) {
  return Math.max(0, Math.min(255, Math.round(value)))
}

function parseHexColor(color) {
  if (typeof color !== 'string' || !HEX_COLOR_PATTERN.test(color)) {
    fail('INVALID_COLOR', `Expected #RRGGBBAA, received ${String(color)}`)
  }
  return [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
    Number.parseInt(color.slice(7, 9), 16),
  ]
}

function toHexChannel(value) {
  return clampChannel(value).toString(16).padStart(2, '0').toUpperCase()
}

function rgbaHex(red, green, blue, alpha = 255) {
  return `#${toHexChannel(red)}${toHexChannel(green)}${toHexChannel(blue)}${toHexChannel(alpha)}`
}

function isTransparentAlpha(alpha, threshold) {
  return alpha === 0 || alpha < threshold
}

function clonePalette(palette) {
  if (!Array.isArray(palette)) fail('INVALID_PALETTE', 'palette must be an array')
  const validated = createPixelDocument({ width: 1, height: 1, palette })
  return validated.palette
}

function normalizeRgbaData(input, expectedLength, path) {
  if (!Array.isArray(input) && !ArrayBuffer.isView(input)) {
    fail('INVALID_RGBA', `${path} must be an array or typed array`, { path })
  }
  if (input.length !== expectedLength) {
    fail('INVALID_RGBA', `${path} must contain exactly ${expectedLength} channels`, {
      path,
      expectedLength,
      actualLength: input.length,
    })
  }
  const output = new Uint8ClampedArray(expectedLength)
  for (let index = 0; index < expectedLength; index += 1) {
    const value = input[index]
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      fail('INVALID_RGBA_CHANNEL', `${path}[${index}] must be an integer between 0 and 255`, { path, index, value })
    }
    output[index] = value
  }
  return output
}

export function assertRgbaImage(input) {
  const source = assertRecord(input, 'source')
  assertKnownFields(source, new Set(['width', 'height', 'data']), 'source')
  const width = assertInteger(source.width, 'source.width', 1, SOURCE_MAX_SIDE)
  const height = assertInteger(source.height, 'source.height', 1, SOURCE_MAX_SIDE)
  if (width * height > SOURCE_MAX_PIXELS) {
    fail('SOURCE_TOO_LARGE', `source contains ${width * height} pixels`, { limit: SOURCE_MAX_PIXELS })
  }
  return {
    width,
    height,
    data: normalizeRgbaData(source.data, width * height * 4, 'source.data'),
  }
}

export function normalizePixelConversionOptions(input = {}) {
  const options = assertRecord(input, 'options')
  assertKnownFields(options, new Set([
    'targetWidth',
    'targetHeight',
    'colorCount',
    'palette',
    'dither',
    'ditherStrength',
    'fit',
    'alphaThreshold',
    'documentId',
    'documentName',
  ]), 'options')
  const targetWidth = assertInteger(options.targetWidth ?? 32, 'options.targetWidth', 1, PIXEL_LIMITS.maxWidth)
  const targetHeight = assertInteger(options.targetHeight ?? 32, 'options.targetHeight', 1, PIXEL_LIMITS.maxHeight)
  const colorCount = assertInteger(options.colorCount ?? 8, 'options.colorCount', 1, PIXEL_LIMITS.maxPaletteColors)
  const dither = options.dither ?? 'none'
  if (!DITHER_MODES.has(dither)) fail('INVALID_DITHER', `Unsupported dither mode ${String(dither)}`)
  const fit = options.fit ?? 'contain'
  if (!FIT_MODES.has(fit)) fail('INVALID_FIT', `Unsupported fit mode ${String(fit)}`)
  const ditherStrength = assertNumber(options.ditherStrength ?? 1, 'options.ditherStrength', 0, 1)
  const alphaThreshold = assertInteger(options.alphaThreshold ?? 16, 'options.alphaThreshold', 0, 255)
  const palette = options.palette === undefined ? null : clonePalette(options.palette)
  const documentId = options.documentId ?? 'imported-pixel'
  const documentName = options.documentName ?? 'Imported pixel art'
  if (typeof documentId !== 'string' || documentId.length === 0) fail('INVALID_ID', 'options.documentId must be a string')
  if (typeof documentName !== 'string' || documentName.length === 0) fail('INVALID_STRING', 'options.documentName must be a string')
  return {
    targetWidth,
    targetHeight,
    colorCount,
    palette,
    dither,
    ditherStrength,
    fit,
    alphaThreshold,
    documentId,
    documentName,
  }
}

function nearestSourceCoordinate(position, sourceSize, destinationSize) {
  return Math.max(0, Math.min(sourceSize - 1, Math.round(((position + 0.5) * sourceSize) / destinationSize - 0.5)))
}

export function resizeRgbaImage(sourceInput, optionsInput = {}) {
  const source = assertRgbaImage(sourceInput)
  const options = assertRecord(optionsInput, 'options')
  assertKnownFields(options, new Set(['width', 'height', 'fit']), 'options')
  const width = assertInteger(options.width, 'options.width', 1, PIXEL_LIMITS.maxWidth)
  const height = assertInteger(options.height, 'options.height', 1, PIXEL_LIMITS.maxHeight)
  const fit = options.fit ?? 'contain'
  if (!FIT_MODES.has(fit)) fail('INVALID_FIT', `Unsupported fit mode ${String(fit)}`)
  return resizeValidatedRgbaImage(source, { width, height, fit })
}

function resizeValidatedRgbaImage(source, { width, height, fit }) {
  const output = new Uint8ClampedArray(width * height * 4)

  if (fit === 'stretch') {
    for (let y = 0; y < height; y += 1) {
      const sourceY = nearestSourceCoordinate(y, source.height, height)
      for (let x = 0; x < width; x += 1) {
        const sourceX = nearestSourceCoordinate(x, source.width, width)
        const sourceOffset = (sourceY * source.width + sourceX) * 4
        output.set(source.data.subarray(sourceOffset, sourceOffset + 4), (y * width + x) * 4)
      }
    }
    return { width, height, data: output }
  }

  const scale = fit === 'contain'
    ? Math.min(width / source.width, height / source.height)
    : Math.max(width / source.width, height / source.height)
  const drawnWidth = Math.max(1, Math.round(source.width * scale))
  const drawnHeight = Math.max(1, Math.round(source.height * scale))
  const offsetX = Math.floor((width - drawnWidth) / 2)
  const offsetY = Math.floor((height - drawnHeight) / 2)

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const drawnX = x - offsetX
      const drawnY = y - offsetY
      if (fit === 'contain' && (drawnX < 0 || drawnX >= drawnWidth || drawnY < 0 || drawnY >= drawnHeight)) {
        continue
      }
      const sourceX = nearestSourceCoordinate(drawnX, source.width, drawnWidth)
      const sourceY = nearestSourceCoordinate(drawnY, source.height, drawnHeight)
      const sourceOffset = (sourceY * source.width + sourceX) * 4
      output.set(source.data.subarray(sourceOffset, sourceOffset + 4), (y * width + x) * 4)
    }
  }
  return { width, height, data: output }
}

function buildHistogram(rgba, alphaThreshold) {
  const histogram = new Map()
  for (let offset = 0; offset < rgba.length; offset += 4) {
    if (isTransparentAlpha(rgba[offset + 3], alphaThreshold)) continue
    const key = (rgba[offset] << 16) | (rgba[offset + 1] << 8) | rgba[offset + 2]
    const entry = histogram.get(key)
    if (entry) entry.count += 1
    else histogram.set(key, { key, r: rgba[offset], g: rgba[offset + 1], b: rgba[offset + 2], count: 1 })
  }
  return [...histogram.values()].sort((left, right) => left.key - right.key)
}

function colorBoxStats(colors) {
  let minR = 255
  let minG = 255
  let minB = 255
  let maxR = 0
  let maxG = 0
  let maxB = 0
  let population = 0
  for (const color of colors) {
    minR = Math.min(minR, color.r)
    minG = Math.min(minG, color.g)
    minB = Math.min(minB, color.b)
    maxR = Math.max(maxR, color.r)
    maxG = Math.max(maxG, color.g)
    maxB = Math.max(maxB, color.b)
    population += color.count
  }
  const ranges = [maxR - minR, maxG - minG, maxB - minB]
  const channel = ranges.indexOf(Math.max(...ranges))
  return { channel, range: ranges[channel], population }
}

function splitColorBox(colors) {
  if (colors.length < 2) return null
  const stats = colorBoxStats(colors)
  const channelKey = ['r', 'g', 'b'][stats.channel]
  const sorted = [...colors].sort((left, right) => left[channelKey] - right[channelKey] || left.key - right.key)
  const midpoint = stats.population / 2
  let cumulative = 0
  let splitIndex = 1
  for (let index = 0; index < sorted.length - 1; index += 1) {
    cumulative += sorted[index].count
    if (cumulative >= midpoint) {
      splitIndex = index + 1
      break
    }
  }
  return [sorted.slice(0, splitIndex), sorted.slice(splitIndex)]
}

function averageColor(colors) {
  let red = 0
  let green = 0
  let blue = 0
  let population = 0
  for (const color of colors) {
    red += color.r * color.count
    green += color.g * color.count
    blue += color.b * color.count
    population += color.count
  }
  return [Math.round(red / population), Math.round(green / population), Math.round(blue / population)]
}

export function extractDeterministicPalette(rgbaInput, optionsInput = {}) {
  const options = assertRecord(optionsInput, 'options')
  assertKnownFields(options, new Set(['colorCount', 'alphaThreshold']), 'options')
  const colorCount = assertInteger(options.colorCount ?? 8, 'options.colorCount', 1, PIXEL_LIMITS.maxPaletteColors)
  const alphaThreshold = assertInteger(options.alphaThreshold ?? 16, 'options.alphaThreshold', 0, 255)
  if (!Array.isArray(rgbaInput) && !ArrayBuffer.isView(rgbaInput)) fail('INVALID_RGBA', 'rgba must be an array or typed array')
  if (rgbaInput.length % 4 !== 0) fail('INVALID_RGBA', 'rgba length must be divisible by 4')
  const rgba = normalizeRgbaData(rgbaInput, rgbaInput.length, 'rgba')
  const histogram = buildHistogram(rgba, alphaThreshold)
  if (histogram.length === 0) return [{ id: 'color-01', name: 'Color 1', color: '#000000FF' }]

  let representatives
  if (histogram.length <= colorCount) {
    representatives = histogram.map((color) => [color.r, color.g, color.b])
  } else {
    const boxes = [histogram]
    while (boxes.length < colorCount) {
      let selectedIndex = -1
      let selectedScore = -1
      for (let index = 0; index < boxes.length; index += 1) {
        if (boxes[index].length < 2) continue
        const stats = colorBoxStats(boxes[index])
        const score = stats.range * stats.population
        if (score > selectedScore) {
          selectedIndex = index
          selectedScore = score
        }
      }
      if (selectedIndex < 0) break
      const split = splitColorBox(boxes[selectedIndex])
      if (!split || split[1].length === 0) break
      boxes.splice(selectedIndex, 1, split[0], split[1])
    }
    representatives = boxes.map(averageColor)
  }

  const unique = new Map()
  for (const [red, green, blue] of representatives) {
    const color = rgbaHex(red, green, blue)
    unique.set(color, { red, green, blue, color })
  }
  const sorted = [...unique.values()].sort((left, right) => {
    const leftLuma = left.red * 299 + left.green * 587 + left.blue * 114
    const rightLuma = right.red * 299 + right.green * 587 + right.blue * 114
    return leftLuma - rightLuma || (left.color < right.color ? -1 : left.color > right.color ? 1 : 0)
  })
  return sorted.map((entry, index) => ({
    id: `color-${String(index + 1).padStart(2, '0')}`,
    name: `Color ${index + 1}`,
    color: entry.color,
  }))
}

function nearestPaletteIndex(red, green, blue, parsedPalette) {
  let selectedIndex = 0
  let selectedDistance = Number.POSITIVE_INFINITY
  for (let index = 0; index < parsedPalette.length; index += 1) {
    const color = parsedPalette[index]
    const redDelta = red - color[0]
    const greenDelta = green - color[1]
    const blueDelta = blue - color[2]
    const distance = redDelta * redDelta * 0.299 + greenDelta * greenDelta * 0.587 + blueDelta * blueDelta * 0.114
    if (distance < selectedDistance) {
      selectedDistance = distance
      selectedIndex = index
    }
  }
  return selectedIndex
}

const BAYER_4 = Object.freeze([
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
])

function quantizePixels(rgba, width, height, palette, options) {
  const output = Array.from({ length: width * height }, () => null)
  const parsedPalette = palette.map((color) => parseHexColor(color.color))
  if (options.dither === 'floyd-steinberg') {
    const working = new Float32Array(width * height * 3)
    for (let index = 0; index < width * height; index += 1) {
      working[index * 3] = rgba[index * 4]
      working[index * 3 + 1] = rgba[index * 4 + 1]
      working[index * 3 + 2] = rgba[index * 4 + 2]
    }
    const spread = (x, y, redError, greenError, blueError, weight) => {
      if (x < 0 || x >= width || y < 0 || y >= height) return
      const pixelIndex = y * width + x
      if (isTransparentAlpha(rgba[pixelIndex * 4 + 3], options.alphaThreshold)) return
      const offset = pixelIndex * 3
      working[offset] += redError * weight * options.ditherStrength
      working[offset + 1] += greenError * weight * options.ditherStrength
      working[offset + 2] += blueError * weight * options.ditherStrength
    }
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const pixelIndex = y * width + x
        if (isTransparentAlpha(rgba[pixelIndex * 4 + 3], options.alphaThreshold)) continue
        const offset = pixelIndex * 3
        const red = Math.max(0, Math.min(255, working[offset]))
        const green = Math.max(0, Math.min(255, working[offset + 1]))
        const blue = Math.max(0, Math.min(255, working[offset + 2]))
        const paletteIndex = nearestPaletteIndex(red, green, blue, parsedPalette)
        const selected = parsedPalette[paletteIndex]
        output[pixelIndex] = palette[paletteIndex].id
        const redError = red - selected[0]
        const greenError = green - selected[1]
        const blueError = blue - selected[2]
        spread(x + 1, y, redError, greenError, blueError, 7 / 16)
        spread(x - 1, y + 1, redError, greenError, blueError, 3 / 16)
        spread(x, y + 1, redError, greenError, blueError, 5 / 16)
        spread(x + 1, y + 1, redError, greenError, blueError, 1 / 16)
      }
    }
    return output
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixelIndex = y * width + x
      const offset = pixelIndex * 4
      if (isTransparentAlpha(rgba[offset + 3], options.alphaThreshold)) continue
      let adjustment = 0
      if (options.dither === 'bayer4') {
        adjustment = (((BAYER_4[(y % 4) * 4 + (x % 4)] + 0.5) / 16) - 0.5) * 64 * options.ditherStrength
      }
      const paletteIndex = nearestPaletteIndex(
        clampChannel(rgba[offset] + adjustment),
        clampChannel(rgba[offset + 1] + adjustment),
        clampChannel(rgba[offset + 2] + adjustment),
        parsedPalette,
      )
      output[pixelIndex] = palette[paletteIndex].id
    }
  }
  return output
}

export function convertRgbaToPixelDocument(sourceInput, optionsInput = {}) {
  const source = assertRgbaImage(sourceInput)
  const options = normalizePixelConversionOptions(optionsInput)
  const resized = resizeValidatedRgbaImage(source, {
    width: options.targetWidth,
    height: options.targetHeight,
    fit: options.fit,
  })
  const palette = options.palette ?? extractDeterministicPalette(resized.data, {
    colorCount: options.colorCount,
    alphaThreshold: options.alphaThreshold,
  })
  const pixels = quantizePixels(resized.data, resized.width, resized.height, palette, options)
  const opaquePixels = pixels.reduce((count, colorId) => count + (colorId === null ? 0 : 1), 0)
  const document = createPixelDocument({
    id: options.documentId,
    name: options.documentName,
    width: resized.width,
    height: resized.height,
    palette,
    layers: [{ id: 'imported', name: 'Imported image', visible: true, locked: false, opacity: 1 }],
    frames: [{
      id: 'frame-1',
      name: 'Frame 1',
      durationMs: 120,
      cels: { imported: pixels },
    }],
    activeLayerId: 'imported',
    activeFrameId: 'frame-1',
    onionSkin: { enabled: true, previousFrames: 1, nextFrames: 1, opacity: 0.22 },
  })
  return {
    document,
    report: {
      sourceWidth: source.width,
      sourceHeight: source.height,
      targetWidth: resized.width,
      targetHeight: resized.height,
      opaquePixels,
      transparentPixels: pixels.length - opaquePixels,
      paletteSize: palette.length,
      paletteMode: options.palette ? 'fixed' : 'generated',
      dither: options.dither,
      fit: options.fit,
      alphaThreshold: options.alphaThreshold,
    },
  }
}

export function deserializePixelProject(serialized) {
  if (typeof serialized !== 'string') fail('INVALID_SERIALIZED_DOCUMENT', 'Serialized pixel project must be a string')
  let parsed
  try {
    parsed = JSON.parse(serialized)
  } catch (error) {
    fail('INVALID_JSON', 'Serialized pixel project is not valid JSON', { cause: String(error) })
  }
  const project = assertRecord(parsed, 'project')
  if (!Object.prototype.hasOwnProperty.call(project, 'schemaVersion')) {
    fail('MISSING_SCHEMA_VERSION', 'Pixel project must declare schemaVersion')
  }
  if (project.schemaVersion !== 0 && project.schemaVersion !== PIXEL_DOCUMENT_SCHEMA_VERSION) {
    fail('UNSUPPORTED_SCHEMA', `Unsupported pixel project schema ${String(project.schemaVersion)}`)
  }
  return migratePixelDocument(project)
}

export function serializePixelProject(document, options = {}) {
  const settings = assertRecord(options, 'options')
  assertKnownFields(settings, new Set(['pretty']), 'options')
  if (settings.pretty !== undefined && typeof settings.pretty !== 'boolean') {
    fail('INVALID_BOOLEAN', 'options.pretty must be boolean', { path: 'options.pretty' })
  }
  return serializePixelDocument(document, { pretty: settings.pretty ?? true })
}

function canonicalPixelDocument(documentInput) {
  const document = assertPixelDocument(documentInput)
  return {
    kind: document.kind,
    schemaVersion: document.schemaVersion,
    id: document.id,
    name: document.name,
    width: document.width,
    height: document.height,
    revision: document.revision,
    palette: document.palette.map((color) => ({ id: color.id, name: color.name, color: color.color })),
    layers: document.layers.map((layer) => ({
      id: layer.id,
      name: layer.name,
      visible: layer.visible,
      locked: layer.locked,
      opacity: layer.opacity,
    })),
    frames: document.frames.map((frame) => ({
      id: frame.id,
      name: frame.name,
      durationMs: frame.durationMs,
      cels: Object.fromEntries(document.layers.map((layer) => [layer.id, [...frame.cels[layer.id]]])),
    })),
    activeLayerId: document.activeLayerId,
    activeFrameId: document.activeFrameId,
    onionSkin: { ...document.onionSkin },
  }
}

export function pixelDocumentsSemanticallyEqual(left, right) {
  return JSON.stringify(canonicalPixelDocument(left)) === JSON.stringify(canonicalPixelDocument(right))
}

export function safePixelFilename(input, fallback = 'aeonquill-pixel') {
  const source = typeof input === 'string' ? input.normalize('NFKC').trim() : ''
  const safe = source
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80)
  return safe || fallback
}

export function createPixelExportBundle(documentInput, optionsInput = {}) {
  const document = assertPixelDocument(documentInput)
  const options = assertRecord(optionsInput, 'options')
  assertKnownFields(options, new Set(['columns', 'padding', 'spacing', 'baseName', 'frameId']), 'options')
  const frameId = options.frameId ?? document.activeFrameId
  const frame = document.frames.find((item) => item.id === frameId)
  if (!frame) fail('UNKNOWN_FRAME', `Unknown frame ${String(frameId)}`)
  const baseName = safePixelFilename(options.baseName ?? document.name)
  const sprite = renderSpriteSheetRgba(document, {
    columns: options.columns,
    padding: options.padding,
    spacing: options.spacing,
  })
  const projectText = serializePixelProject(document, { pretty: true })
  const metadataText = JSON.stringify(sprite.metadata, null, 2)
  return {
    layout: sprite.layout,
    project: {
      filename: `${baseName}${PIXEL_PROJECT_EXTENSION}`,
      mime: PIXEL_PROJECT_MIME,
      text: projectText,
    },
    frame: {
      filename: `${baseName}-${safePixelFilename(frame.name, frame.id)}.png`,
      mime: PIXEL_PNG_MIME,
      frameId,
      width: document.width,
      height: document.height,
      pixels: renderPixelFrameRgba(document, frameId),
    },
    sprite: {
      filename: `${baseName}-sprite-sheet.png`,
      mime: PIXEL_PNG_MIME,
      width: sprite.layout.width,
      height: sprite.layout.height,
      pixels: sprite.pixels,
    },
    metadata: {
      filename: `${baseName}-sprite-sheet.json`,
      mime: PIXEL_METADATA_MIME,
      text: metadataText,
      value: sprite.metadata,
    },
  }
}
