import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertPixelSystemClipboard,
  createPixelSystemClipboard,
  deserializePixelSystemClipboard,
  pastePixelSystemClipboard,
  pixelSystemClipboardFromRgba,
  pixelSystemClipboardToRgba,
  serializePixelSystemClipboard,
} from '../src/lib/pixel/pixelSystemClipboard.mjs'
import { assertPixelDocument, createPixelDocument } from '../src/lib/pixel/pixelCore.mjs'

const palette = [
  { id: 'red', name: 'Red', color: '#FF0000FF' },
  { id: 'green', name: 'Green', color: '#00FF00FF' },
  { id: 'red-half', name: 'Red half', color: '#FF000080' },
]

function makeDocument(overrides = {}) {
  return createPixelDocument({
    id: 'clipboard-document',
    name: 'Clipboard document',
    width: 4,
    height: 3,
    palette,
    layers: [
      { id: 'ink', name: 'Ink', visible: true, locked: false, opacity: 1 },
      { id: 'shade', name: 'Shade', visible: true, locked: false, opacity: 1 },
    ],
    frames: [
      {
        id: 'frame-1',
        name: 'Frame 1',
        durationMs: 120,
        cels: {
          ink: ['red', null, 'green', null, null, 'red-half', null, null, null, null, null, null],
          shade: Array(12).fill(null),
        },
      },
      {
        id: 'frame-2',
        name: 'Frame 2',
        durationMs: 120,
        cels: {
          ink: Array(12).fill(null),
          shade: Array(12).fill(null),
        },
      },
    ],
    ...overrides,
  })
}

function expectCode(callback, code) {
  assert.throws(callback, (error) => error?.code === code)
}

test('creates a system clipboard from the active Cel with canonical deduplicated RGBA colors', () => {
  const document = makeDocument()
  const before = structuredClone(document)
  const clipboard = createPixelSystemClipboard(document, { x: 0, y: 0, width: 3, height: 2 })
  assert.deepEqual(clipboard, {
    kind: 'aeonquill.pixel-system-clipboard',
    schemaVersion: 1,
    width: 3,
    height: 2,
    colors: ['#ff0000ff', '#00ff00ff', '#ff000080'],
    pixels: [0, null, 1, null, 2, null],
  })
  assert.deepEqual(document, before)
})

test('round-trips exact RGBA bytes and rejects more than 256 non-transparent colors', () => {
  const rgba = new Uint8ClampedArray([
    255, 0, 0, 255,
    0, 0, 0, 0,
    1, 2, 3, 128,
    255, 0, 0, 255,
  ])
  const clipboard = pixelSystemClipboardFromRgba(2, 2, rgba)
  assert.deepEqual(clipboard.colors, ['#ff0000ff', '#01020380'])
  assert.deepEqual(clipboard.pixels, [0, null, 1, 0])
  assert.deepEqual(Array.from(pixelSystemClipboardToRgba(clipboard).rgba), Array.from(rgba))

  const tooMany = new Uint8Array(257 * 4)
  for (let index = 0; index < 257; index += 1) {
    tooMany[index * 4] = index & 0xFF
    tooMany[index * 4 + 1] = (index >> 8) & 0xFF
    tooMany[index * 4 + 2] = 1
    tooMany[index * 4 + 3] = 255
  }
  expectCode(() => pixelSystemClipboardFromRgba(257, 1, tooMany), 'PALETTE_LIMIT')
})

test('strictly validates, clones, serializes and rejects malformed or oversized payloads', () => {
  const valid = {
    kind: 'aeonquill.pixel-system-clipboard',
    schemaVersion: 1,
    width: 2,
    height: 1,
    colors: ['#abcdef80'],
    pixels: [0, null],
  }
  const copy = assertPixelSystemClipboard(valid)
  copy.colors[0] = '#000000ff'
  copy.pixels[0] = null
  assert.deepEqual(valid.colors, ['#abcdef80'])
  assert.deepEqual(valid.pixels, [0, null])
  const text = serializePixelSystemClipboard(valid)
  assert.equal(text, JSON.stringify(valid))
  assert.deepEqual(deserializePixelSystemClipboard(text), valid)
  expectCode(() => assertPixelSystemClipboard({ ...valid, extra: true }), 'UNKNOWN_FIELD')
  expectCode(() => assertPixelSystemClipboard({ ...valid, colors: ['#abcdef80', '#abcdef80'] }), 'DUPLICATE_COLOR')
  expectCode(() => assertPixelSystemClipboard({ ...valid, colors: ['#abcdef00'], pixels: [0, null] }), 'INVALID_COLOR')
  expectCode(() => deserializePixelSystemClipboard('{'), 'INVALID_JSON')
  expectCode(() => deserializePixelSystemClipboard(JSON.stringify({ kind: 'other', schemaVersion: 1 })), 'UNSUPPORTED_CLIPBOARD')
  expectCode(() => deserializePixelSystemClipboard('x'.repeat(1_048_577)), 'TEXT_TOO_LARGE')
})

test('pastes across palettes by RGBA, preserves transparency modes, and adds only used colors', () => {
  const document = makeDocument()
  document.palette = [
    { id: 'different-red-id', name: 'Different red id', color: '#FF0000FF' },
    { id: 'existing-green', name: 'Existing green', color: '#00FF00FF' },
  ]
  document.frames = document.frames.map((frame) => ({
    ...frame,
    cels: {
      ink: frame.cels.ink.map((colorId) => colorId === 'red' ? 'different-red-id' : colorId === 'green' ? 'existing-green' : null),
      shade: [...frame.cels.shade],
    },
  }))
  assertPixelDocument(document)
  const clipboard = {
    kind: 'aeonquill.pixel-system-clipboard',
    schemaVersion: 1,
    width: 2,
    height: 2,
    colors: ['#ff0000ff', '#12345680'],
    pixels: [0, null, 1, null],
  }
  const before = structuredClone(document)
  const pasted = pastePixelSystemClipboard(document, clipboard, { x: 2, y: 1 })
  assert.deepEqual(pasted.selection, { x: 2, y: 1, width: 2, height: 2 })
  assert.equal(pasted.changedPixels, 2)
  assert.deepEqual(pasted.addedColors.map(({ color }) => color), ['#12345680'])
  assert.equal(pasted.document.revision, before.revision + 1)
  assert.equal(pasted.document.palette.some(({ color }) => color === '#12345680'), true)
  assert.equal(pasted.document.palette.some(({ color }) => color.toLowerCase() === '#ff0000ff'), true)
  assert.deepEqual(pasted.document.frames[0].cels.ink.slice(6, 12), [
    'different-red-id', null, null, null, 'clipboard-color-12345680', null,
  ])
  assert.deepEqual(document, before)

  const opaque = pastePixelSystemClipboard(document, clipboard, { x: 0, y: 1 }, { mode: 'opaque-only' })
  assert.equal(opaque.document.frames[0].cels.ink[1], null)
  assert.equal(opaque.changedPixels, 2)
})

test('pastes atomically at boundaries, respects locks, fans out linked Cels, and does not revise on no-op', () => {
  const linked = makeDocument()
  linked.frames[1].cels.ink = [...linked.frames[0].cels.ink]
  linked.celLinks = [{ id: 'linked', layerId: 'ink', frameIds: ['frame-1', 'frame-2'] }]
  assertPixelDocument(linked)
  const clipboard = {
    kind: 'aeonquill.pixel-system-clipboard',
    schemaVersion: 1,
    width: 1,
    height: 1,
    colors: ['#ff000080'],
    pixels: [0],
  }
  const pasted = pastePixelSystemClipboard(linked, clipboard, { x: 3, y: 2 })
  assert.equal(pasted.document.frames[0].cels.ink[11], 'red-half')
  assert.equal(pasted.document.frames[1].cels.ink[11], 'red-half')
  assert.equal(pasted.changedPixels, 1)
  assert.equal(pasted.document.revision, 1)

  const noOp = pastePixelSystemClipboard(pasted.document, clipboard, { x: 3, y: 2 })
  assert.equal(noOp.changedPixels, 0)
  assert.equal(noOp.document.revision, pasted.document.revision)
  assert.deepEqual(noOp.addedColors, [])

  expectCode(() => pastePixelSystemClipboard(linked, clipboard, { x: 4, y: 2 }), 'OUT_OF_BOUNDS')
  const locked = structuredClone(linked)
  locked.layers = locked.layers.map((layer) => layer.id === 'ink' ? { ...layer, locked: true } : layer)
  assertPixelDocument(locked)
  expectCode(() => pastePixelSystemClipboard(locked, clipboard, { x: 0, y: 0 }), 'LAYER_LOCKED')
  const hiddenGroup = structuredClone(linked)
  hiddenGroup.layerGroups = [{ id: 'hidden', name: 'Hidden', visible: false, locked: false }]
  hiddenGroup.layers = hiddenGroup.layers.map((layer) => layer.id === 'ink' ? { ...layer, groupId: 'hidden' } : layer)
  assertPixelDocument(hiddenGroup)
  expectCode(() => pastePixelSystemClipboard(hiddenGroup, clipboard, { x: 0, y: 0 }), 'LAYER_GROUP_HIDDEN')
})

test('palette overflow rejects before changing the input document', () => {
  const document = makeDocument()
  document.palette = Array.from({ length: 256 }, (_, index) => ({
      id: `color-${index}`,
      name: `Color ${index}`,
      color: `#${index.toString(16).padStart(2, '0')}0000FF`,
    }))
  document.frames = document.frames.map((frame) => ({
    ...frame,
    cels: { ink: Array(12).fill(null), shade: Array(12).fill(null) },
  }))
  assertPixelDocument(document)
  const clipboard = pixelSystemClipboardFromRgba(2, 1, new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]))
  const before = structuredClone(document)
  expectCode(() => pastePixelSystemClipboard(document, clipboard, { x: 0, y: 0 }), 'PALETTE_LIMIT')
  assert.deepEqual(document, before)
})
