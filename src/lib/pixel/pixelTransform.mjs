import { PIXEL_LIMITS, PixelContractError } from './pixelCore.mjs'

const PIXEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const TRANSFORM_FIELDS = new Set(['width', 'height', 'angle', 'anchor', 'mode'])
const SELECTION_FIELDS = new Set(['x', 'y', 'width', 'height'])
const ANCHORS = new Set(['top-left', 'center'])
const MODES = new Set(['move', 'copy'])
const ANGLE_EPSILON = 1e-9

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
    fail('INVALID_INTEGER', `${path} must be an integer between ${min} and ${max}`, { path, value, min, max })
  }
  return value
}

function assertNumber(value, path, min, max) {
  if (!Number.isFinite(value) || value < min || value > max) {
    fail('INVALID_NUMBER', `${path} must be between ${min} and ${max}`, { path, value, min, max })
  }
  return value
}

function assertPixelValue(value, path) {
  if (value !== null && (typeof value !== 'string' || !PIXEL_ID_PATTERN.test(value))) {
    fail('INVALID_VALUE', `${path} must be a safe color id or null`, { path })
  }
  return value
}

function assertCanvasSize(canvasWidth, canvasHeight) {
  assertInteger(canvasWidth, 'canvasWidth', 1, PIXEL_LIMITS.maxWidth)
  assertInteger(canvasHeight, 'canvasHeight', 1, PIXEL_LIMITS.maxHeight)
  return { canvasWidth, canvasHeight }
}

function assertSelection(selectionInput, canvasWidth, canvasHeight) {
  const input = assertRecord(selectionInput, 'selection')
  assertKnownFields(input, SELECTION_FIELDS, 'selection')
  const selection = {
    x: assertInteger(input.x, 'selection.x', 0, canvasWidth - 1),
    y: assertInteger(input.y, 'selection.y', 0, canvasHeight - 1),
    width: assertInteger(input.width, 'selection.width', 1, canvasWidth),
    height: assertInteger(input.height, 'selection.height', 1, canvasHeight),
  }
  if (selection.x + selection.width > canvasWidth || selection.y + selection.height > canvasHeight) {
    fail('OUT_OF_BOUNDS', 'selection exceeds the pixel surface', { path: 'selection' })
  }
  if (selection.width * selection.height > PIXEL_LIMITS.maxPixelsPerCommand) {
    fail('LIMIT_EXCEEDED', 'selection exceeds the maximum pixel patch', {
      area: selection.width * selection.height,
      limit: PIXEL_LIMITS.maxPixelsPerCommand,
    })
  }
  return selection
}

function assertCel(cel, canvasWidth, canvasHeight) {
  if (!Array.isArray(cel) || cel.length !== canvasWidth * canvasHeight) {
    fail('INVALID_CEL', `cel must contain exactly ${canvasWidth * canvasHeight} pixels`, { path: 'cel' })
  }
  for (let index = 0; index < cel.length; index += 1) assertPixelValue(cel[index], `cel[${index}]`)
}

function assertOptions(optionsInput, selection) {
  const input = assertRecord(optionsInput, 'options')
  assertKnownFields(input, TRANSFORM_FIELDS, 'options')
  const width = input.width === undefined
    ? selection.width
    : assertInteger(input.width, 'options.width', 1, PIXEL_LIMITS.maxWidth)
  const height = input.height === undefined
    ? selection.height
    : assertInteger(input.height, 'options.height', 1, PIXEL_LIMITS.maxHeight)
  const angle = input.angle === undefined ? 0 : assertNumber(input.angle, 'options.angle', -360, 360)
  const anchor = input.anchor === undefined ? 'center' : input.anchor
  if (!ANCHORS.has(anchor)) fail('INVALID_ANCHOR', 'options.anchor must be top-left or center', { path: 'options.anchor' })
  const mode = input.mode === undefined ? 'move' : input.mode
  if (!MODES.has(mode)) fail('INVALID_MODE', 'options.mode must be move or copy', { path: 'options.mode' })
  if (width * height > PIXEL_LIMITS.maxPixelsPerCommand) {
    fail('LIMIT_EXCEEDED', 'scaled selection exceeds the maximum pixel patch', {
      area: width * height,
      limit: PIXEL_LIMITS.maxPixelsPerCommand,
    })
  }
  return { width, height, angle, anchor, mode }
}

function normalizedAngle(angle) {
  const value = angle % 360
  return value < 0 ? value + 360 : value
}

function exactQuarterTurn(angle) {
  const normalized = normalizedAngle(angle)
  const candidates = [0, 90, 180, 270]
  const quarter = candidates.find((value) => Math.abs(normalized - value) < ANGLE_EPSILON)
  return quarter === undefined ? null : quarter
}

function rotatedBounds(width, height, angle, quarter) {
  if (quarter === 0 || quarter === 180) return { width, height }
  if (quarter === 90 || quarter === 270) return { width: height, height: width }
  const radians = (angle * Math.PI) / 180
  const cosine = Math.abs(Math.cos(radians))
  const sine = Math.abs(Math.sin(radians))
  const rotatedWidth = Math.max(1, Math.ceil(width * cosine + height * sine - ANGLE_EPSILON))
  const rotatedHeight = Math.max(1, Math.ceil(width * sine + height * cosine - ANGLE_EPSILON))
  return { width: rotatedWidth, height: rotatedHeight }
}

function assertOperationArea(width, height, path) {
  const area = width * height
  if (area > PIXEL_LIMITS.maxPixelsPerCommand) {
    fail('LIMIT_EXCEEDED', `${path} exceeds the maximum pixel patch`, {
      area,
      limit: PIXEL_LIMITS.maxPixelsPerCommand,
    })
  }
}

function placeTarget(selection, targetWidth, targetHeight, bounds, anchor, quarter) {
  if (anchor === 'top-left') return { x: selection.x, y: selection.y }

  // A same-sized quarter turn uses the exact matrix path. Keeping this grid
  // anchor stable makes four turns of a non-square selection an identity.
  if (quarter !== null && targetWidth === selection.width && targetHeight === selection.height) {
    return { x: selection.x, y: selection.y }
  }

  const sourceCenterX = selection.x + (selection.width - 1) / 2
  const sourceCenterY = selection.y + (selection.height - 1) / 2
  return {
    x: Math.round(sourceCenterX - (bounds.width - 1) / 2),
    y: Math.round(sourceCenterY - (bounds.height - 1) / 2),
  }
}

function nearestSourceIndex(coordinate, sourceSize, targetSize) {
  const nearest = Math.floor(((coordinate + 0.5) * sourceSize) / targetSize)
  return Math.min(sourceSize - 1, Math.max(0, nearest))
}

function buildScaledSampler(cel, canvasWidth, selection, targetWidth, targetHeight) {
  const source = Array.from({ length: selection.width * selection.height }, (_, index) => {
    const x = index % selection.width
    const y = Math.floor(index / selection.width)
    return cel[(selection.y + y) * canvasWidth + selection.x + x]
  })
  return (x, y) => {
    const sourceX = nearestSourceIndex(x, selection.width, targetWidth)
    const sourceY = nearestSourceIndex(y, selection.height, targetHeight)
    return source[sourceY * selection.width + sourceX]
  }
}

function createTransformedSampler(scaled, targetWidth, targetHeight, angle, quarter, bounds) {
  if (quarter === 0) return (x, y) => scaled(x, y)
  if (quarter === 90) return (x, y) => scaled(y, targetHeight - 1 - x)
  if (quarter === 180) return (x, y) => scaled(targetWidth - 1 - x, targetHeight - 1 - y)
  if (quarter === 270) return (x, y) => scaled(targetWidth - 1 - y, x)

  const radians = (angle * Math.PI) / 180
  const cosine = Math.cos(radians)
  const sine = Math.sin(radians)
  const targetCenterX = (targetWidth - 1) / 2
  const targetCenterY = (targetHeight - 1) / 2
  const boundsCenterX = (bounds.width - 1) / 2
  const boundsCenterY = (bounds.height - 1) / 2
  return (x, y) => {
    const rotatedX = x - boundsCenterX
    const rotatedY = y - boundsCenterY
    // Inverse of clockwise screen-space rotation.
    const targetX = cosine * rotatedX + sine * rotatedY + targetCenterX
    const targetY = -sine * rotatedX + cosine * rotatedY + targetCenterY
    const nearestX = Math.round(targetX)
    const nearestY = Math.round(targetY)
    if (nearestX < 0 || nearestY < 0 || nearestX >= targetWidth || nearestY >= targetHeight) return null
    return scaled(nearestX, nearestY)
  }
}

/**
 * Create a bounded, nearest-neighbour pixel selection transform patch.
 * The cel, document revision, and document state are never mutated here.
 */
export function transformPixelSelection(cel, canvasWidth, canvasHeight, selectionInput, optionsInput = {}) {
  assertCanvasSize(canvasWidth, canvasHeight)
  assertCel(cel, canvasWidth, canvasHeight)
  const selection = assertSelection(selectionInput, canvasWidth, canvasHeight)
  const options = assertOptions(optionsInput, selection)
  const quarter = exactQuarterTurn(options.angle)
  const bounds = rotatedBounds(options.width, options.height, options.angle, quarter)
  assertOperationArea(bounds.width, bounds.height, 'rotated selection')

  const targetOrigin = placeTarget(selection, options.width, options.height, bounds, options.anchor, quarter)
  const visibleLeft = Math.max(0, targetOrigin.x)
  const visibleTop = Math.max(0, targetOrigin.y)
  const visibleRight = Math.min(canvasWidth, targetOrigin.x + bounds.width)
  const visibleBottom = Math.min(canvasHeight, targetOrigin.y + bounds.height)
  if (visibleLeft >= visibleRight || visibleTop >= visibleBottom) {
    fail('OUT_OF_BOUNDS', 'transformed selection is outside the pixel surface', { path: 'selection' })
  }

  const visibleSelection = {
    x: visibleLeft,
    y: visibleTop,
    width: visibleRight - visibleLeft,
    height: visibleBottom - visibleTop,
  }
  const clippedPixels = bounds.width * bounds.height - visibleSelection.width * visibleSelection.height
  const scaled = buildScaledSampler(cel, canvasWidth, selection, options.width, options.height)
  const transformed = createTransformedSampler(scaled, options.width, options.height, options.angle, quarter, bounds)
  const desired = new Map()
  const setDesired = (x, y, value) => desired.set(`${x}:${y}`, { x, y, value })

  if (options.mode === 'move') {
    for (let y = selection.y; y < selection.y + selection.height; y += 1) {
      for (let x = selection.x; x < selection.x + selection.width; x += 1) setDesired(x, y, null)
    }
  }
  for (let y = visibleTop; y < visibleBottom; y += 1) {
    for (let x = visibleLeft; x < visibleRight; x += 1) {
      const localX = x - targetOrigin.x
      const localY = y - targetOrigin.y
      setDesired(x, y, transformed(localX, localY))
    }
  }

  const pixels = []
  for (const point of desired.values()) {
    if (cel[point.y * canvasWidth + point.x] !== point.value) pixels.push(point)
  }
  if (pixels.length > PIXEL_LIMITS.maxPixelsPerCommand) {
    fail('LIMIT_EXCEEDED', 'transform patch exceeds the maximum pixel patch', {
      count: pixels.length,
      limit: PIXEL_LIMITS.maxPixelsPerCommand,
    })
  }

  return {
    pixels,
    selection: visibleSelection,
    report: {
      sourceWidth: selection.width,
      sourceHeight: selection.height,
      targetWidth: options.width,
      targetHeight: options.height,
      angle: options.angle,
      clippedPixels,
    },
  }
}
