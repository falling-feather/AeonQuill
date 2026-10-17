import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyCanvasCommand,
  assertCanvasDocument,
  createCanvasCommand,
  createCanvasDocument,
  executeCanvasTool,
} from '../src/lib/canvasCore.mjs'
import {
  CANVAS_ALIGNMENT_HEIGHT,
  CANVAS_ALIGNMENT_WIDTH,
  canvasConnectorPorts,
  createCanvasAlignmentUpdates,
  createCanvasConnection,
} from '../src/lib/canvasSelection.mjs'
import { elementWorldBounds } from '../src/lib/canvasSpatialIndex.mjs'

function element(id, x, y, width = 100, height = 80, rotation = 0, extra = {}) {
  return {
    id,
    kind: 'shape',
    name: id,
    x,
    y,
    width,
    height,
    rotation,
    opacity: 1,
    radius: 8,
    fill: '#fff',
    stroke: '#000',
    strokeWidth: 1,
    locked: false,
    visible: true,
    zIndex: 1,
    ...extra,
  }
}

function selectionDocument(elements) {
  return createCanvasDocument({
    id: 'selection-test',
    title: 'Selection test',
    elements,
    camera: { x: 0, y: 0, zoom: 1 },
    now: 100,
  })
}

function errorCode(code) {
  return (error) => error?.code === code
}

test('单个普通元件按旋转视觉边界对齐到1200×800画布', () => {
  const item = element('single', 100, 120, 100, 40, 90)
  assert.deepEqual(
    createCanvasAlignmentUpdates([item], ['single'], 'left'),
    [{ id: 'single', patch: { x: -30 } }],
  )
  assert.deepEqual(
    createCanvasAlignmentUpdates([item], ['single'], 'center-x'),
    [{ id: 'single', patch: { x: 550 } }],
  )
  assert.deepEqual(
    createCanvasAlignmentUpdates([item], ['single'], 'right'),
    [{ id: 'single', patch: { x: 1130 } }],
  )
  assert.deepEqual(
    createCanvasAlignmentUpdates([item], ['single'], 'top'),
    [{ id: 'single', patch: { y: 30 } }],
  )
  assert.deepEqual(
    createCanvasAlignmentUpdates([item], ['single'], 'center-y'),
    [{ id: 'single', patch: { y: 380 } }],
  )
  assert.deepEqual(
    createCanvasAlignmentUpdates([item], ['single'], 'bottom'),
    [{ id: 'single', patch: { y: 730 } }],
  )
  assert.equal(CANVAS_ALIGNMENT_WIDTH, 1200)
  assert.equal(CANVAS_ALIGNMENT_HEIGHT, 800)
})

test('多选对齐使用包含旋转AABB的整体视觉边界并保持输入不变', () => {
  const rotated = element('rotated', 100, 100, 100, 40, 90)
  const plain = element('plain', 300, 200, 80, 60)
  const connector = {
    ...element('connector-1', 0, 0, 0, 0, 0, { kind: 'connector', name: 'link', fromId: 'rotated', toId: 'plain' }),
  }
  const elements = [rotated, plain, connector]
  const before = structuredClone(elements)
  assert.deepEqual(elementWorldBounds(rotated), { left: 130, top: 70, right: 170, bottom: 170 })
  assert.deepEqual(
    createCanvasAlignmentUpdates(elements, ['rotated', 'plain', 'connector-1'], 'left'),
    [{ id: 'plain', patch: { x: 130 } }],
  )
  assert.deepEqual(
    createCanvasAlignmentUpdates(elements, ['rotated', 'plain'], 'center-x'),
    [
      { id: 'rotated', patch: { x: 205 } },
      { id: 'plain', patch: { x: 215 } },
    ],
  )
  assert.deepEqual(elements, before)
})

test('连接器不参加对齐、无变化返回空数组，锁定元件失败且不部分更新', () => {
  const aligned = element('aligned', 0, 40)
  const alignedTwo = element('aligned-two', 0, 160)
  const connector = {
    ...element('edge', 0, 0, 0, 0, 0, { kind: 'connector', fromId: 'aligned', toId: 'aligned-two' }),
  }
  assert.deepEqual(
    createCanvasAlignmentUpdates([aligned, alignedTwo, connector], ['aligned', 'aligned-two', 'edge'], 'left'),
    [],
  )
  assert.throws(
    () => createCanvasAlignmentUpdates([aligned, alignedTwo, connector], ['edge'], 'left'),
    errorCode('NO_SELECTABLE_ELEMENTS'),
  )

  const locked = element('locked', 100, 100, 80, 50, 15, { locked: true })
  const movable = element('movable', 300, 100)
  const before = structuredClone([locked, movable])
  assert.throws(
    () => createCanvasAlignmentUpdates([locked, movable], ['locked', 'movable'], 'right'),
    errorCode('ELEMENT_LOCKED'),
  )
  assert.deepEqual([locked, movable], before)
})

test('选择参数在执行任何更新前拒绝非法对齐和重复或失效ID', () => {
  const items = [element('a', 10, 10), element('b', 20, 20)]
  assert.throws(() => createCanvasAlignmentUpdates(items, ['a'], 'diagonal'), errorCode('INVALID_ALIGNMENT'))
  assert.throws(() => createCanvasAlignmentUpdates(items, ['a', 'a'], 'left'), errorCode('DUPLICATE_SELECTION_ID'))
  assert.throws(() => createCanvasAlignmentUpdates(items, ['missing'], 'left'), errorCode('SELECTION_ELEMENT_NOT_FOUND'))
  assert.throws(
    () => createCanvasAlignmentUpdates([items[0], { ...items[0] }], ['a'], 'left'),
    errorCode('DUPLICATE_ELEMENT_ID'),
  )
})

test('创建连接器产生可直接通过核心文档校验的完整元素并允许锁定端点', () => {
  const source = element('source', 20, 30, 80, 40, 0, {
    name: '源节点'.repeat(60),
    locked: true,
    zIndex: 4,
  })
  const target = element('target', 300, 100, 80, 40, 0, { name: '目标', zIndex: 9 })
  const connector = createCanvasConnection([source, target], {
    id: 'connection-1',
    fromId: 'source',
    toId: 'target',
  })
  assert.equal(connector.kind, 'connector')
  assert.equal(connector.name.length <= 120, true)
  assert.equal(connector.x, 0)
  assert.equal(connector.y, 0)
  assert.equal(connector.width, 0)
  assert.equal(connector.height, 0)
  assert.equal(connector.rotation, 0)
  assert.equal(connector.opacity, 1)
  assert.equal(connector.radius, 0)
  assert.equal(connector.fill, 'transparent')
  assert.equal(connector.stroke, '#6558d9')
  assert.equal(connector.strokeWidth, 2)
  assert.equal(connector.fromId, 'source')
  assert.equal(connector.toId, 'target')
  assert.equal(connector.locked, false)
  assert.equal(connector.visible, true)
  assert.equal(connector.zIndex, 10)
  assertCanvasDocument(selectionDocument([source, target, connector]))
})

test('连接器拒绝自连、同向重复、ID冲突和连接器端点，但允许反向连接', () => {
  const source = element('source', 0, 0)
  const target = element('target', 200, 0)
  const existing = {
    ...element('existing', 0, 0, 0, 0, 0, {
      kind: 'connector',
      fromId: 'source',
      toId: 'target',
    }),
  }
  const elements = [source, target, existing]
  assert.throws(
    () => createCanvasConnection(elements, { id: 'self', fromId: 'source', toId: 'source' }),
    errorCode('SELF_CONNECTION'),
  )
  assert.throws(
    () => createCanvasConnection(elements, { id: 'duplicate', fromId: 'source', toId: 'target' }),
    errorCode('DUPLICATE_CONNECTION'),
  )
  assert.throws(
    () => createCanvasConnection(elements, { id: 'source', fromId: 'target', toId: 'source' }),
    errorCode('DUPLICATE_ELEMENT_ID'),
  )
  assert.throws(
    () => createCanvasConnection(elements, { id: 'bad-endpoint', fromId: 'existing', toId: 'target' }),
    errorCode('INVALID_CONNECTION_ENDPOINT'),
  )
  const reverse = createCanvasConnection(elements, { id: 'reverse', fromId: 'target', toId: 'source' })
  assert.equal(reverse.fromId, 'target')
  assert.equal(reverse.toId, 'source')
})

test('连接端口按两端旋转后的右中点和左中点计算并消除微小浮点噪音', () => {
  const source = element('source', 10, 20, 80, 40, 90)
  const target = element('target', 200, 20, 80, 40, -90)
  assert.deepEqual(canvasConnectorPorts(source, target), {
    x1: 50,
    y1: 80,
    x2: 240,
    y2: 80,
  })
  assert.throws(
    () => canvasConnectorPorts(source, { ...source }),
    errorCode('SELF_CONNECTION'),
  )
  assert.throws(
    () => canvasConnectorPorts({ ...source, kind: 'connector' }, target),
    errorCode('INVALID_CONNECTION_ENDPOINT'),
  )
})

test('核心add和patch各推进一次revision，逆向命令恢复对齐与连接状态', () => {
  const source = element('source', 100, 40, 80, 40, 0)
  const target = element('target', 350, 120, 80, 40, 0)
  const base = selectionDocument([source, target])
  const connector = createCanvasConnection(base.elements, {
    id: 'connection',
    fromId: 'source',
    toId: 'target',
  })
  const withConnector = applyCanvasCommand(
    base,
    createCanvasCommand(base, 'elements.add', { elements: [connector] }, { id: 'add-connection', actor: 'user' }),
    { now: 101 },
  )
  assert.equal(withConnector.revision, 1)
  assert.equal(withConnector.elements.length, 3)

  const updates = createCanvasAlignmentUpdates(
    withConnector.elements,
    ['source', 'target', 'connection'],
    'left',
  )
  assert.deepEqual(updates, [{ id: 'target', patch: { x: 100 } }])
  const patched = executeCanvasTool(withConnector, {
    toolId: 'canvas.elements.patch',
    callId: 'align-left',
    actor: 'user',
    input: { updates },
  }, { now: 102 })
  assert.equal(patched.revision, 2)
  assert.equal(patched.elements.find((item) => item.id === 'target').x, 100)

  const restored = applyCanvasCommand(
    patched,
    createCanvasCommand(patched, 'elements.patch', {
      updates: [{ id: 'target', patch: { x: target.x } }],
    }, { id: 'undo-align', actor: 'user' }),
    { now: 103 },
  )
  assert.equal(restored.revision, 3)
  assert.equal(restored.elements.find((item) => item.id === 'target').x, target.x)
  const withoutConnector = executeCanvasTool(restored, {
    toolId: 'canvas.elements.remove',
    callId: 'undo-connection',
    actor: 'user',
    input: { ids: ['connection'] },
  }, { now: 104 })
  assert.equal(withoutConnector.revision, 4)
  assert.deepEqual(withoutConnector.elements, [source, target])
})
