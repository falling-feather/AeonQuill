const MAX_TOOL_PIXELS = 65_536

function fail(code, message, details) {
  const error = new Error(message)
  error.name = 'PixelToolError'
  error.code = code
  if (details !== undefined) error.details = details
  throw error
}

function assertInteger(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('INVALID_INTEGER', `${name} must be an integer between ${min} and ${max}`, { name, value })
  }
  return value
}

function assertSize(width, height) {
  assertInteger(width, 'width', 1, 512)
  assertInteger(height, 'height', 1, 512)
  if (width * height > 262_144) fail('LIMIT_EXCEEDED', 'Pixel surface is too large')
}

function assertPoint(point, width, height, name = 'point') {
  if (!point || typeof point !== 'object' || Array.isArray(point)) fail('INVALID_POINT', `${name} must be an object`)
  const keys = Object.keys(point)
  if (keys.some((key) => key !== 'x' && key !== 'y')) fail('UNKNOWN_FIELD', `${name} contains an unknown field`)
  return {
    x: assertInteger(point.x, `${name}.x`, 0, width - 1),
    y: assertInteger(point.y, `${name}.y`, 0, height - 1),
  }
}

function pushUnique(target, seen, x, y, width, height) {
  if (x < 0 || y < 0 || x >= width || y >= height) return
  const key = `${x}:${y}`
  if (seen.has(key)) return
  seen.add(key)
  target.push({ x, y })
  if (target.length > MAX_TOOL_PIXELS) fail('LIMIT_EXCEEDED', 'Tool operation exceeds the maximum pixel patch')
}

export function normalizePixelRect(startInput, endInput, width, height) {
  assertSize(width, height)
  const start = assertPoint(startInput, width, height, 'start')
  const end = assertPoint(endInput, width, height, 'end')
  const x = Math.min(start.x, end.x)
  const y = Math.min(start.y, end.y)
  return {
    x,
    y,
    width: Math.abs(end.x - start.x) + 1,
    height: Math.abs(end.y - start.y) + 1,
  }
}

export function rasterPixelLine(startInput, endInput, width, height) {
  assertSize(width, height)
  const start = assertPoint(startInput, width, height, 'start')
  const end = assertPoint(endInput, width, height, 'end')
  const points = []
  let x = start.x
  let y = start.y
  const dx = Math.abs(end.x - start.x)
  const sx = start.x < end.x ? 1 : -1
  const dy = -Math.abs(end.y - start.y)
  const sy = start.y < end.y ? 1 : -1
  let error = dx + dy
  while (true) {
    points.push({ x, y })
    if (x === end.x && y === end.y) break
    const doubled = 2 * error
    if (doubled >= dy) {
      error += dy
      x += sx
    }
    if (doubled <= dx) {
      error += dx
      y += sy
    }
  }
  return points
}

export function rasterPixelRectangle(startInput, endInput, width, height, options = {}) {
  const rect = normalizePixelRect(startInput, endInput, width, height)
  const fill = options?.fill === true
  const points = []
  const seen = new Set()
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      if (fill || x === rect.x || y === rect.y || x === rect.x + rect.width - 1 || y === rect.y + rect.height - 1) {
        pushUnique(points, seen, x, y, width, height)
      }
    }
  }
  return points
}

export function expandPixelBrush(pointsInput, width, height, options = {}) {
  assertSize(width, height)
  if (!Array.isArray(pointsInput) || pointsInput.length < 1) fail('INVALID_POINTS', 'points must not be empty')
  const size = assertInteger(options?.size ?? 1, 'size', 1, 16)
  const mirrorHorizontal = options?.mirrorHorizontal === true
  const mirrorVertical = options?.mirrorVertical === true
  const offset = Math.floor((size - 1) / 2)
  const points = []
  const seen = new Set()
  for (const [index, pointInput] of pointsInput.entries()) {
    const point = assertPoint(pointInput, width, height, `points[${index}]`)
    const centers = [{ x: point.x, y: point.y }]
    if (mirrorHorizontal) centers.push({ x: width - 1 - point.x, y: point.y })
    if (mirrorVertical) centers.push({ x: point.x, y: height - 1 - point.y })
    if (mirrorHorizontal && mirrorVertical) centers.push({ x: width - 1 - point.x, y: height - 1 - point.y })
    for (const center of centers) {
      for (let y = center.y - offset; y < center.y - offset + size; y += 1) {
        for (let x = center.x - offset; x < center.x - offset + size; x += 1) {
          pushUnique(points, seen, x, y, width, height)
        }
      }
    }
  }
  return points
}

export function floodFillPixels(cel, width, height, startInput, replacementValue) {
  assertSize(width, height)
  if (!Array.isArray(cel) || cel.length !== width * height) fail('INVALID_CEL', 'cel size does not match the pixel surface')
  if (replacementValue !== null && (typeof replacementValue !== 'string' || replacementValue.length < 1)) {
    fail('INVALID_VALUE', 'replacementValue must be a color id or null')
  }
  const start = assertPoint(startInput, width, height, 'start')
  const targetValue = cel[start.y * width + start.x]
  if (targetValue === replacementValue) return []
  const queue = [start]
  let cursor = 0
  const points = []
  const seen = new Set([`${start.x}:${start.y}`])
  while (cursor < queue.length) {
    const point = queue[cursor++]
    if (cel[point.y * width + point.x] !== targetValue) continue
    points.push(point)
    if (points.length > MAX_TOOL_PIXELS) fail('LIMIT_EXCEEDED', 'Flood fill exceeds the maximum pixel patch')
    for (const [x, y] of [[point.x - 1, point.y], [point.x + 1, point.y], [point.x, point.y - 1], [point.x, point.y + 1]]) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue
      const key = `${x}:${y}`
      if (seen.has(key)) continue
      seen.add(key)
      if (cel[y * width + x] === targetValue) queue.push({ x, y })
    }
  }
  return points
}

function assertRect(rectInput, width, height) {
  if (!rectInput || typeof rectInput !== 'object' || Array.isArray(rectInput)) fail('INVALID_RECT', 'selection must be an object')
  const rect = {
    x: assertInteger(rectInput.x, 'selection.x', 0, width - 1),
    y: assertInteger(rectInput.y, 'selection.y', 0, height - 1),
    width: assertInteger(rectInput.width, 'selection.width', 1, width),
    height: assertInteger(rectInput.height, 'selection.height', 1, height),
  }
  if (rect.x + rect.width > width || rect.y + rect.height > height) fail('OUT_OF_BOUNDS', 'selection exceeds the pixel surface')
  return rect
}

export function createSelectionPatch(cel, width, height, selectionInput, operation, options = {}) {
  assertSize(width, height)
  if (!Array.isArray(cel) || cel.length !== width * height) fail('INVALID_CEL', 'cel size does not match the pixel surface')
  const selection = assertRect(selectionInput, width, height)
  if (!['clear', 'flip-horizontal', 'flip-vertical', 'move', 'copy'].includes(operation)) {
    fail('INVALID_OPERATION', `Unsupported selection operation ${String(operation)}`)
  }
  const source = []
  for (let y = 0; y < selection.height; y += 1) {
    for (let x = 0; x < selection.width; x += 1) {
      source.push({ x, y, value: cel[(selection.y + y) * width + selection.x + x] })
    }
  }
  const patch = new Map()
  const set = (x, y, value) => patch.set(`${x}:${y}`, { x, y, value })
  if (operation === 'clear') {
    for (const point of source) set(selection.x + point.x, selection.y + point.y, null)
  } else if (operation === 'flip-horizontal' || operation === 'flip-vertical') {
    for (const point of source) {
      const sourceX = operation === 'flip-horizontal' ? selection.width - 1 - point.x : point.x
      const sourceY = operation === 'flip-vertical' ? selection.height - 1 - point.y : point.y
      const value = source[sourceY * selection.width + sourceX].value
      set(selection.x + point.x, selection.y + point.y, value)
    }
  } else {
    const dx = assertInteger(options?.dx ?? 0, 'dx', -width, width)
    const dy = assertInteger(options?.dy ?? 0, 'dy', -height, height)
    const targetX = selection.x + dx
    const targetY = selection.y + dy
    if (targetX < 0 || targetY < 0 || targetX + selection.width > width || targetY + selection.height > height) {
      fail('OUT_OF_BOUNDS', 'selection destination exceeds the pixel surface')
    }
    if (operation === 'move') {
      for (const point of source) set(selection.x + point.x, selection.y + point.y, null)
    }
    for (const point of source) set(targetX + point.x, targetY + point.y, point.value)
  }
  const changed = []
  for (const point of patch.values()) {
    if (cel[point.y * width + point.x] !== point.value) changed.push(point)
  }
  return changed
}

export function createSmartPixelCleanupPatch(cel, width, height, options = {}) {
  assertSize(width, height)
  if (!Array.isArray(cel) || cel.length !== width * height) fail('INVALID_CEL', 'cel size does not match the pixel surface')
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail('INVALID_OPTIONS', 'options must be an object')
  const unknown = Object.keys(options).filter((key) => !['removeIsolated', 'fillPinholes'].includes(key))
  if (unknown.length > 0) fail('UNKNOWN_FIELD', `options.${unknown[0]} is not allowed`)
  const removeIsolated = options.removeIsolated !== false
  const fillPinholes = options.fillPinholes !== false
  const pixels = []
  let isolatedRemoved = 0
  let pinholesFilled = 0
  const at = (x, y) => (x < 0 || y < 0 || x >= width || y >= height ? undefined : cel[y * width + x])
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = at(x, y)
      if (value === null && fillPinholes && x > 0 && y > 0 && x < width - 1 && y < height - 1) {
        const cardinal = [at(x - 1, y), at(x + 1, y), at(x, y - 1), at(x, y + 1)]
        if (cardinal[0] !== null && cardinal.every((colorId) => colorId === cardinal[0])) {
          pixels.push({ x, y, value: cardinal[0] })
          pinholesFilled += 1
        }
        continue
      }
      if (value === null || !removeIsolated) continue
      let occupiedNeighbors = 0
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue
          const neighbor = at(x + dx, y + dy)
          if (neighbor !== undefined && neighbor !== null) occupiedNeighbors += 1
        }
      }
      if (occupiedNeighbors === 0) {
        pixels.push({ x, y, value: null })
        isolatedRemoved += 1
      }
    }
  }
  return {
    pixels,
    report: {
      scannedPixels: width * height,
      isolatedRemoved,
      pinholesFilled,
      changedPixels: pixels.length,
    },
  }
}
