const DEFAULT_CELL_SIZE = 512
const MAX_CELLS_PER_ELEMENT = 1_024
const MAX_QUERY_CELLS = 16_384

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback
}

export function elementWorldBounds(element) {
  const x = finite(element.x)
  const y = finite(element.y)
  const width = Math.max(0, finite(element.width))
  const height = Math.max(0, finite(element.height))
  const rotation = finite(element.rotation) * Math.PI / 180
  if (!rotation) return { left: x, top: y, right: x + width, bottom: y + height }
  const centerX = x + width / 2
  const centerY = y + height / 2
  const cosine = Math.abs(Math.cos(rotation))
  const sine = Math.abs(Math.sin(rotation))
  const halfWidth = (width * cosine + height * sine) / 2
  const halfHeight = (width * sine + height * cosine) / 2
  return {
    left: centerX - halfWidth,
    top: centerY - halfHeight,
    right: centerX + halfWidth,
    bottom: centerY + halfHeight,
  }
}

export function viewportWorldBounds(camera, viewportSize, overscanScreenPixels = 240) {
  const zoom = Math.max(0.0001, finite(camera.zoom, 1))
  const overscan = Math.max(0, finite(overscanScreenPixels)) / zoom
  const left = -finite(camera.x) / zoom
  const top = -finite(camera.y) / zoom
  return {
    left: left - overscan,
    top: top - overscan,
    right: left + Math.max(0, finite(viewportSize.width)) / zoom + overscan,
    bottom: top + Math.max(0, finite(viewportSize.height)) / zoom + overscan,
  }
}

export function boundsIntersect(a, b) {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top
}

export function screenMarqueeRect(start, end) {
  const left = Math.min(finite(start?.x), finite(end?.x))
  const top = Math.min(finite(start?.y), finite(end?.y))
  return {
    left,
    top,
    width: Math.abs(finite(end?.x) - finite(start?.x)),
    height: Math.abs(finite(end?.y) - finite(start?.y)),
  }
}

export function screenMarqueeWorldBounds(start, end, camera) {
  const zoom = Math.max(0.0001, finite(camera?.zoom, 1))
  const cameraX = finite(camera?.x)
  const cameraY = finite(camera?.y)
  const rect = screenMarqueeRect(start, end)
  return {
    left: (rect.left - cameraX) / zoom,
    top: (rect.top - cameraY) / zoom,
    right: (rect.left + rect.width - cameraX) / zoom,
    bottom: (rect.top + rect.height - cameraY) / zoom,
  }
}

function rotatedElementCorners(element) {
  const x = finite(element.x)
  const y = finite(element.y)
  const width = Math.max(0, finite(element.width))
  const height = Math.max(0, finite(element.height))
  const centerX = x + width / 2
  const centerY = y + height / 2
  const radians = finite(element.rotation) * Math.PI / 180
  const cosine = Math.cos(radians)
  const sine = Math.sin(radians)
  return [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ].map((point) => {
    const dx = point.x - centerX
    const dy = point.y - centerY
    return {
      x: centerX + dx * cosine - dy * sine,
      y: centerY + dx * sine + dy * cosine,
    }
  })
}

function projectionsOverlap(pointsA, pointsB, axis) {
  let minA = Infinity
  let maxA = -Infinity
  let minB = Infinity
  let maxB = -Infinity
  for (const point of pointsA) {
    const projection = point.x * axis.x + point.y * axis.y
    minA = Math.min(minA, projection)
    maxA = Math.max(maxA, projection)
  }
  for (const point of pointsB) {
    const projection = point.x * axis.x + point.y * axis.y
    minB = Math.min(minB, projection)
    maxB = Math.max(maxB, projection)
  }
  return maxA >= minB && maxB >= minA
}

export function elementIntersectsWorldBounds(element, bounds) {
  if (!boundsIntersect(elementWorldBounds(element), bounds)) return false
  if (!finite(element.rotation)) return true
  const elementCorners = rotatedElementCorners(element)
  const boundsCorners = [
    { x: bounds.left, y: bounds.top },
    { x: bounds.right, y: bounds.top },
    { x: bounds.right, y: bounds.bottom },
    { x: bounds.left, y: bounds.bottom },
  ]
  const edge = {
    x: elementCorners[1].x - elementCorners[0].x,
    y: elementCorners[1].y - elementCorners[0].y,
  }
  const side = {
    x: elementCorners[3].x - elementCorners[0].x,
    y: elementCorners[3].y - elementCorners[0].y,
  }
  const axes = [
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: -edge.y, y: edge.x },
    { x: -side.y, y: side.x },
  ]
  return axes.every((axis) => projectionsOverlap(elementCorners, boundsCorners, axis))
}

export function selectElementIdsInWorldBounds(elements, bounds) {
  return elements
    .filter((element) => (
      element?.visible !== false
      && element.kind !== 'connector'
      && element.id !== 'canvas-background'
      && elementIntersectsWorldBounds(element, bounds)
    ))
    .map((element) => element.id)
}

function cellRange(bounds, cellSize) {
  return {
    minX: Math.floor(bounds.left / cellSize),
    minY: Math.floor(bounds.top / cellSize),
    maxX: Math.floor(bounds.right / cellSize),
    maxY: Math.floor(bounds.bottom / cellSize),
  }
}

function rangeCellCount(range) {
  return (range.maxX - range.minX + 1) * (range.maxY - range.minY + 1)
}

function cellKey(x, y) {
  return `${x}:${y}`
}

export function createCanvasSpatialIndex(elements, cellSize = DEFAULT_CELL_SIZE) {
  if (!Number.isFinite(cellSize) || cellSize < 64 || cellSize > 8_192) {
    throw new Error('Spatial index cell size must be between 64 and 8192')
  }
  const cells = new Map()
  const boundsById = new Map()
  const globalIds = new Set()
  const allIds = []
  for (const element of elements) {
    if (!element?.id || element.kind === 'connector') continue
    const bounds = elementWorldBounds(element)
    boundsById.set(element.id, bounds)
    allIds.push(element.id)
    const range = cellRange(bounds, cellSize)
    if (rangeCellCount(range) > MAX_CELLS_PER_ELEMENT) {
      globalIds.add(element.id)
      continue
    }
    for (let x = range.minX; x <= range.maxX; x += 1) {
      for (let y = range.minY; y <= range.maxY; y += 1) {
        const key = cellKey(x, y)
        const bucket = cells.get(key) || new Set()
        bucket.add(element.id)
        cells.set(key, bucket)
      }
    }
  }
  return { cellSize, cells, boundsById, globalIds, allIds }
}

export function queryCanvasSpatialIndex(index, bounds) {
  const candidates = new Set(index.globalIds)
  const range = cellRange(bounds, index.cellSize)
  if (rangeCellCount(range) > MAX_QUERY_CELLS) {
    for (const id of index.allIds) candidates.add(id)
  } else {
    for (let x = range.minX; x <= range.maxX; x += 1) {
      for (let y = range.minY; y <= range.maxY; y += 1) {
        for (const id of index.cells.get(cellKey(x, y)) || []) candidates.add(id)
      }
    }
  }
  const matches = new Set()
  for (const id of candidates) {
    const elementBounds = index.boundsById.get(id)
    if (elementBounds && boundsIntersect(elementBounds, bounds)) matches.add(id)
  }
  return matches
}
