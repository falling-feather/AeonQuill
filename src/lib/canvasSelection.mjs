import { elementWorldBounds } from './canvasSpatialIndex.mjs'

export const CANVAS_ALIGNMENT_WIDTH = 1_200
export const CANVAS_ALIGNMENT_HEIGHT = 800

const ALIGNMENTS = new Set(['left', 'center-x', 'right', 'top', 'center-y', 'bottom'])
const NOISE_EPSILON = 1e-8
const MAX_ID_LENGTH = 160

function fail(code, message, details) {
  const error = new Error(message)
  error.name = 'CanvasSelectionError'
  error.code = code
  if (details !== undefined) error.details = details
  throw error
}

function isValidId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_ID_LENGTH
    && value.trim().length > 0
    && !/[\u0000-\u001F\u007F]/u.test(value)
}

function assertElements(elements) {
  if (!Array.isArray(elements)) fail('INVALID_ELEMENTS', 'elements必须是数组')
  const byId = new Map()
  for (const [index, element] of elements.entries()) {
    if (!element || typeof element !== 'object' || Array.isArray(element) || !isValidId(element.id)) {
      fail('INVALID_ELEMENT_ID', 'elements[' + index + ']缺少有效ID')
    }
    if (byId.has(element.id)) fail('DUPLICATE_ELEMENT_ID', '元素ID重复：' + element.id)
    if (element.kind !== 'connector') {
      for (const key of ['x', 'y', 'width', 'height', 'rotation']) {
        if (!Number.isFinite(element[key])) {
          fail('INVALID_ELEMENT_GEOMETRY', element.id + '.' + key + '必须是有限数值')
        }
      }
      if (element.width <= 0 || element.height <= 0) {
        fail('INVALID_ELEMENT_GEOMETRY', element.id + '尺寸必须为正')
      }
    }
    byId.set(element.id, element)
  }
  return byId
}

function assertSelectionIds(selectedIds, byId) {
  if (!Array.isArray(selectedIds)) fail('INVALID_SELECTION', 'selectedIds必须是数组')
  const seen = new Set()
  for (const id of selectedIds) {
    if (!isValidId(id)) fail('INVALID_SELECTION_ID', '选中ID无效')
    if (seen.has(id)) fail('DUPLICATE_SELECTION_ID', '选中ID重复：' + id)
    if (!byId.has(id)) fail('SELECTION_ELEMENT_NOT_FOUND', '选中元素不存在：' + id)
    seen.add(id)
  }
  return seen
}

function clean(value) {
  return Math.abs(value) < NOISE_EPSILON ? 0 : value
}

function boundsFor(elements) {
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const element of elements) {
    const bounds = elementWorldBounds(element)
    left = Math.min(left, bounds.left)
    top = Math.min(top, bounds.top)
    right = Math.max(right, bounds.right)
    bottom = Math.max(bottom, bounds.bottom)
  }
  return { left, top, right, bottom }
}

function alignmentDelta(bounds, target, alignment) {
  if (alignment === 'left') return target.left - bounds.left
  if (alignment === 'center-x') {
    return ((target.left + target.right) / 2) - ((bounds.left + bounds.right) / 2)
  }
  if (alignment === 'right') return target.right - bounds.right
  if (alignment === 'top') return target.top - bounds.top
  if (alignment === 'center-y') {
    return ((target.top + target.bottom) / 2) - ((bounds.top + bounds.bottom) / 2)
  }
  return target.bottom - bounds.bottom
}

export function createCanvasAlignmentUpdates(elements, selectedIds, alignment) {
  const byId = assertElements(elements)
  if (typeof alignment !== 'string' || !ALIGNMENTS.has(alignment)) {
    fail('INVALID_ALIGNMENT', 'alignment无效')
  }
  const selected = assertSelectionIds(selectedIds, byId)
  const ordinary = elements.filter((element) => selected.has(element.id) && element.kind !== 'connector')
  if (!ordinary.length) fail('NO_SELECTABLE_ELEMENTS', '至少需要一个普通元件')
  if (ordinary.some((element) => element.locked === true)) {
    fail('ELEMENT_LOCKED', '选中的普通元件包含锁定元素')
  }

  const target = ordinary.length === 1
    ? { left: 0, top: 0, right: CANVAS_ALIGNMENT_WIDTH, bottom: CANVAS_ALIGNMENT_HEIGHT }
    : boundsFor(ordinary)
  const updates = []
  for (const element of ordinary) {
    const bounds = elementWorldBounds(element)
    const delta = alignmentDelta(bounds, target, alignment)
    if (Math.abs(delta) < NOISE_EPSILON) continue
    const isHorizontal = alignment === 'left' || alignment === 'center-x' || alignment === 'right'
    const key = isHorizontal ? 'x' : 'y'
    updates.push({
      id: element.id,
      patch: { [key]: clean(element[key] + delta) },
    })
  }
  return updates
}

function assertConnectionInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('INVALID_CONNECTION', '连接输入必须是对象')
  }
  const keys = Object.keys(input)
  if (
    keys.some((key) => !['id', 'fromId', 'toId'].includes(key))
    || !isValidId(input.id)
    || !isValidId(input.fromId)
    || !isValidId(input.toId)
  ) {
    fail('INVALID_CONNECTION', '连接输入字段无效')
  }
}

function clippedName(value) {
  return Array.from(value).slice(0, 120).join('')
}

export function createCanvasConnection(elements, input) {
  const byId = assertElements(elements)
  assertConnectionInput(input)
  if (byId.has(input.id)) fail('DUPLICATE_ELEMENT_ID', '元素ID重复：' + input.id)
  if (input.fromId === input.toId) fail('SELF_CONNECTION', '连接不能指向自身')
  const from = byId.get(input.fromId)
  const to = byId.get(input.toId)
  if (!from || !to) fail('CONNECTION_ENDPOINT_NOT_FOUND', '连接端点不存在')
  if (from.kind === 'connector' || to.kind === 'connector') {
    fail('INVALID_CONNECTION_ENDPOINT', '连接端点必须是普通元件')
  }
  if (typeof from.name !== 'string' || !from.name.trim() || typeof to.name !== 'string' || !to.name.trim()) {
    fail('INVALID_CONNECTION_ENDPOINT', '连接端点缺少名称')
  }
  if (elements.some((element) => (
    element.kind === 'connector'
    && element.fromId === input.fromId
    && element.toId === input.toId
  ))) {
    fail('DUPLICATE_CONNECTION', '同向连接已经存在')
  }

  const zIndexes = elements.map((element) => element.zIndex).filter(Number.isFinite)
  const zIndex = (zIndexes.length ? Math.max(...zIndexes) : 0) + 1
  if (!Number.isSafeInteger(zIndex) || zIndex > 1_000_000_000) {
    fail('Z_INDEX_EXHAUSTED', '连接层级已达到上限')
  }
  return {
    id: input.id,
    kind: 'connector',
    name: clippedName(from.name + ' → ' + to.name),
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    rotation: 0,
    opacity: 1,
    radius: 0,
    fill: 'transparent',
    stroke: '#6558d9',
    strokeWidth: 2,
    fromId: input.fromId,
    toId: input.toId,
    locked: false,
    visible: true,
    zIndex,
  }
}

function connectorPort(element, side) {
  const centerX = element.x + element.width / 2
  const centerY = element.y + element.height / 2
  const localX = side === 'right' ? element.width / 2 : -element.width / 2
  const radians = element.rotation * Math.PI / 180
  return {
    x: clean(centerX + localX * Math.cos(radians)),
    y: clean(centerY + localX * Math.sin(radians)),
  }
}

export function canvasConnectorPorts(from, to) {
  if (from && to && from.id === to.id) fail('SELF_CONNECTION', '连接不能指向自身')
  const byId = assertElements([from, to])
  const source = byId.get(from.id)
  const target = byId.get(to.id)
  if (source.kind === 'connector' || target.kind === 'connector') {
    fail('INVALID_CONNECTION_ENDPOINT', '连接端点必须是普通元件')
  }
  const sourcePort = connectorPort(source, 'right')
  const targetPort = connectorPort(target, 'left')
  return {
    x1: sourcePort.x,
    y1: sourcePort.y,
    x2: targetPort.x,
    y2: targetPort.y,
  }
}
