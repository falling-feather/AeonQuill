import assert from 'node:assert/strict'
import test from 'node:test'
import {
  boundsIntersect,
  createCanvasSpatialIndex,
  elementIntersectsWorldBounds,
  elementWorldBounds,
  queryCanvasSpatialIndex,
  screenMarqueeWorldBounds,
  selectElementIdsInWorldBounds,
  viewportWorldBounds,
} from '../src/lib/canvasSpatialIndex.mjs'

function element(id, x, y, width = 100, height = 100, rotation = 0) {
  return { id, kind: 'shape', x, y, width, height, rotation }
}

test('world bounds include rotation and viewport overscan uses screen pixels', () => {
  const rotated = elementWorldBounds(element('rotated', 100, 100, 100, 40, 90))
  assert.deepEqual(rotated, { left: 130, top: 70, right: 170, bottom: 170 })
  assert.deepEqual(
    viewportWorldBounds({ x: -100, y: -50, zoom: 0.5 }, { width: 1_000, height: 500 }, 100),
    { left: 0, top: -100, right: 2_400, bottom: 1_300 },
  )
})

test('spatial query returns intersecting elements without false negatives', () => {
  const index = createCanvasSpatialIndex([
    element('inside', 20, 20),
    element('edge', 190, 190, 40, 40),
    element('outside', 900, 900),
  ], 128)
  const bounds = { left: 0, top: 0, right: 200, bottom: 200 }
  assert.deepEqual([...queryCanvasSpatialIndex(index, bounds)].sort(), ['edge', 'inside'])
  assert.equal(boundsIntersect(elementWorldBounds(element('edge', 190, 190, 40, 40)), bounds), true)
})

test('very large elements use the global bucket and remain queryable', () => {
  const index = createCanvasSpatialIndex([
    element('huge', -1_000_000, -1_000_000, 2_000_000, 2_000_000),
    element('small', 10, 10),
  ])
  assert.equal(index.globalIds.has('huge'), true)
  const matches = queryCanvasSpatialIndex(index, { left: 0, top: 0, right: 50, bottom: 50 })
  assert.deepEqual([...matches].sort(), ['huge', 'small'])
})

test('marquee preview coordinates and committed world bounds share one camera transform', () => {
  assert.deepEqual(
    screenMarqueeWorldBounds(
      { x: 460, y: 330 },
      { x: 220, y: 150 },
      { x: 100, y: 50, zoom: 2 },
    ),
    { left: 60, top: 50, right: 180, bottom: 140 },
  )
})

test('marquee selection follows the visible rotated rectangle instead of its unrotated box', () => {
  const rotated = { ...element('rotated', 100, 100, 100, 20, 90), visible: true }
  assert.equal(elementIntersectsWorldBounds(rotated, { left: 139, top: 61, right: 161, bottom: 80 }), true)
  assert.equal(elementIntersectsWorldBounds(rotated, { left: 100, top: 100, right: 120, bottom: 120 }), false)
  assert.deepEqual(
    selectElementIdsInWorldBounds([
      rotated,
      { ...element('hidden', 140, 65, 10, 10), visible: false },
      { ...element('canvas-background', 0, 0, 1_000, 1_000), visible: true },
    ], { left: 139, top: 61, right: 161, bottom: 80 }),
    ['rotated'],
  )
})
