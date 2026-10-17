import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createPixelDocument,
  renderPixelFrameRgba,
} from '../src/lib/pixel/pixelCore.mjs'
import {
  AsepriteFormatError,
  decodeAseprite,
  encodeAseprite,
} from '../src/lib/pixel/pixelAseprite.mjs'

const MAGIC = 0xA5E0
const FRAME_MAGIC = 0xF1FA
const CHUNK_LAYER = 0x2004
const CHUNK_CEL = 0x2005
const CHUNK_TAGS = 0x2018
const CHUNK_PALETTE = 0x2019

function concatBytes(...parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0)
  const output = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}

class FixtureWriter {
  constructor() {
    this.parts = []
    this.length = 0
  }

  add(bytes) {
    const value = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes)
    this.parts.push(value)
    this.length += value.length
  }

  u8(value) {
    this.add([value & 0xFF])
  }

  u16(value) {
    const bytes = new Uint8Array(2)
    new DataView(bytes.buffer).setUint16(0, value, true)
    this.add(bytes)
  }

  i16(value) {
    const bytes = new Uint8Array(2)
    new DataView(bytes.buffer).setInt16(0, value, true)
    this.add(bytes)
  }

  u32(value) {
    const bytes = new Uint8Array(4)
    new DataView(bytes.buffer).setUint32(0, value, true)
    this.add(bytes)
  }

  string(value) {
    const bytes = new TextEncoder().encode(value)
    this.u16(bytes.length)
    this.add(bytes)
  }

  zeros(count) {
    this.add(new Uint8Array(count))
  }

  build() {
    return concatBytes(...this.parts)
  }
}

function chunk(type, payload) {
  const writer = new FixtureWriter()
  writer.u32(payload.length + 6)
  writer.u16(type)
  writer.add(payload)
  return writer.build()
}

function layerChunk({ name, flags = 3, type = 0, childLevel = 0, blend = 0, opacity = 255 }) {
  const writer = new FixtureWriter()
  writer.u16(flags)
  writer.u16(type)
  writer.u16(childLevel)
  writer.u16(0)
  writer.u16(0)
  writer.u16(blend)
  writer.u8(opacity)
  writer.zeros(3)
  writer.string(name)
  if (type === 2) writer.u32(1)
  return chunk(CHUNK_LAYER, writer.build())
}

function celChunk({ layer = 0, x = 0, y = 0, opacity = 255, type = 0, width = 1, height = 1, pixels = [], framePosition = 0 }) {
  const writer = new FixtureWriter()
  writer.u16(layer)
  writer.i16(x)
  writer.i16(y)
  writer.u8(opacity)
  writer.u16(type)
  writer.i16(0)
  writer.zeros(5)
  if (type === 0 || type === 2) {
    writer.u16(width)
    writer.u16(height)
    writer.add(pixels)
  } else if (type === 1) {
    writer.u16(framePosition)
  }
  return chunk(CHUNK_CEL, writer.build())
}

function paletteChunk(entries) {
  const writer = new FixtureWriter()
  writer.u32(entries.length)
  writer.u32(0)
  writer.u32(entries.length - 1)
  writer.zeros(8)
  for (const entry of entries) {
    writer.u16(entry.name ? 1 : 0)
    writer.u8(entry.r)
    writer.u8(entry.g)
    writer.u8(entry.b)
    writer.u8(entry.a)
    if (entry.name) writer.string(entry.name)
  }
  return chunk(CHUNK_PALETTE, writer.build())
}

function tagsChunk(tags) {
  const writer = new FixtureWriter()
  writer.u16(tags.length)
  writer.zeros(8)
  for (const tag of tags) {
    writer.u16(tag.from)
    writer.u16(tag.to)
    writer.u8(tag.direction)
    writer.u16(tag.repeat)
    writer.zeros(6)
    writer.zeros(3)
    writer.u8(0)
    writer.string(tag.name)
  }
  return chunk(CHUNK_TAGS, writer.build())
}

function frame(chunks, duration = 80) {
  const body = concatBytes(...chunks)
  const writer = new FixtureWriter()
  writer.u32(body.length + 16)
  writer.u16(FRAME_MAGIC)
  writer.u16(chunks.length)
  writer.u16(duration)
  writer.zeros(2)
  writer.u32(chunks.length)
  writer.add(body)
  return writer.build()
}

function asepriteFile({ width, height, colorDepth = 32, frames, flags = 3, speed = 100, transparentIndex = 0, colorCount = 0 }) {
  const frameBytes = frames.map((item) => item instanceof Uint8Array ? item : frame(item.chunks, item.duration))
  const fileSize = 128 + frameBytes.reduce((sum, item) => sum + item.length, 0)
  const writer = new FixtureWriter()
  writer.u32(fileSize)
  writer.u16(MAGIC)
  writer.u16(frameBytes.length)
  writer.u16(width)
  writer.u16(height)
  writer.u16(colorDepth)
  writer.u32(flags)
  writer.u16(speed)
  writer.zeros(8)
  writer.u8(transparentIndex)
  writer.zeros(3)
  writer.u16(colorCount)
  writer.u8(1)
  writer.u8(1)
  writer.i16(0)
  writer.i16(0)
  writer.u16(0)
  writer.u16(0)
  writer.zeros(84)
  for (const bytes of frameBytes) writer.add(bytes)
  return writer.build()
}

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'))
  const reader = stream.getReader()
  const parts = []
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    parts.push(value)
  }
  return concatBytes(...parts)
}

function rgba(...values) {
  return Uint8Array.from(values)
}

function paletteColor(document, color) {
  return document.palette.find((entry) => entry.color === color)
}

async function assertDecodeCode(bytes, code) {
  await assert.rejects(
    decodeAseprite(bytes),
    (error) => error instanceof AsepriteFormatError && error.code === code,
  )
}

test('按官方布局解码 32 位 raw cel、UTF-8 图层名和带符号裁剪矩形', async () => {
  const fixture = asepriteFile({
    width: 3,
    height: 3,
    frames: [frame([
      layerChunk({ name: '绘制' }),
      chunk(0x7FFF, Uint8Array.from([1, 2, 3])),
      celChunk({
        x: -1,
        y: 1,
        width: 3,
        height: 2,
        pixels: rgba(
          0, 0, 0, 0, 255, 0, 0, 255, 0, 255, 0, 255,
          0, 0, 255, 255, 255, 255, 255, 128, 0, 0, 0, 0,
        ),
      }),
    ])],
  })
  const original = fixture.slice()
  assert.equal(new DataView(fixture.buffer).getUint16(4, true), MAGIC)
  assert.equal(new DataView(fixture.buffer).getUint16(128 + 4, true), FRAME_MAGIC)
  const { document, warnings } = await decodeAseprite(fixture, { documentId: 'utf8-fixture', documentName: '手工样本' })
  const padded = new Uint8Array(fixture.length + 4)
  padded.set(fixture, 2)
  const fromView = await decodeAseprite(padded.subarray(2, 2 + fixture.length))
  assert.equal(fromView.document.width, 3)
  assert.deepEqual(fixture, original)
  assert.equal(document.id, 'utf8-fixture')
  assert.equal(document.name, '手工样本')
  assert.equal(document.layers[0].name, '绘制')
  assert.ok(warnings.some((message) => message.includes('0x7FFF')))
  const red = paletteColor(document, '#FF0000FF')
  const green = paletteColor(document, '#00FF00FF')
  const whiteHalf = paletteColor(document, '#FFFFFF80')
  assert.ok(red && green && whiteHalf)
  assert.deepEqual(document.frames[0].cels['layer-1'], [
    null, null, null,
    red.id, green.id, null,
    whiteHalf.id, null, null,
  ])
})

test('解码 indexed 调色板、zlib compressed cel、前向保持的 linked cel 和标签方向', async () => {
  const compressedPixels = await deflate(Uint8Array.from([1, 0]))
  const fixture = asepriteFile({
    width: 2,
    height: 1,
    colorDepth: 8,
    transparentIndex: 0,
    colorCount: 3,
    frames: [
      frame([
        layerChunk({ name: 'Indexed' }),
        paletteChunk([
          { r: 0, g: 0, b: 0, a: 0, name: 'Transparent' },
          { r: 255, g: 0, b: 0, a: 255, name: '红' },
          { r: 0, g: 0, b: 255, a: 255, name: 'Blue' },
        ]),
        tagsChunk([
          { from: 0, to: 1, direction: 1, repeat: 1, name: 'Reverse' },
          { from: 0, to: 1, direction: 2, repeat: 0, name: 'Ping' },
        ]),
        celChunk({ type: 2, width: 2, height: 1, pixels: compressedPixels }),
      ], 90),
      frame([celChunk({ type: 1, framePosition: 0 })], 110),
    ],
  })
  const { document, warnings } = await decodeAseprite(fixture)
  assert.deepEqual(document.palette.map((color) => [color.name, color.color]), [
    ['Transparent', '#00000000'],
    ['红', '#FF0000FF'],
    ['Blue', '#0000FFFF'],
  ])
  assert.deepEqual(document.frames.map((frame) => frame.durationMs), [90, 110])
  assert.deepEqual(document.frames[0].cels['layer-1'], ['color-2', null])
  assert.deepEqual(document.frames[1].cels['layer-1'], ['color-2', null])
  assert.deepEqual(document.animationTags.map((tag) => [tag.name, tag.direction, tag.loop]), [
    ['Reverse', 'reverse', false],
    ['Ping', 'ping-pong', true],
  ])
  assert.deepEqual(warnings, [])
})

test('解码 16 位 grayscale cel 并保留灰度 alpha', async () => {
  const fixture = asepriteFile({
    width: 2,
    height: 1,
    colorDepth: 16,
    frames: [frame([
      layerChunk({ name: 'Gray' }),
      celChunk({ pixels: Uint8Array.from([10, 255, 200, 128]), width: 2, height: 1 }),
    ])],
  })
  // The helper defaults to a raw cel, as required for this independent fixture.
  const { document } = await decodeAseprite(fixture)
  assert.ok(paletteColor(document, '#0A0A0AFF'))
  assert.ok(paletteColor(document, '#C8C8C880'))
  assert.deepEqual(document.frames[0].cels['layer-1'], ['color-1', 'color-2'])
})

test('解码一层 group scope、visible/locked、group opacity 和四种可映射 blend mode', async () => {
  const fixture = asepriteFile({
    width: 1,
    height: 1,
    frames: [frame([
      layerChunk({ name: 'Group', flags: 1, type: 1, opacity: 128 }),
      layerChunk({ name: 'Child', flags: 3, childLevel: 1, blend: 16 }),
      celChunk({ layer: 1, pixels: rgba(255, 0, 0, 255) }),
    ])],
  })
  const { document, warnings } = await decodeAseprite(fixture)
  assert.deepEqual(document.layerGroups, [{ id: 'group-1', name: 'Group', visible: true, locked: true }])
  assert.deepEqual(document.layers[0], {
    id: 'layer-1',
    name: 'Child',
    visible: true,
    locked: false,
    opacity: 1,
    groupId: 'group-1',
    blendMode: 'add',
  })
  assert.deepEqual(Array.from(renderPixelFrameRgba(document, 'frame-1')), [255, 0, 0, 128])
  assert.ok(warnings.some((message) => message.includes('opacity 已展平')))
})

test('Aseprite round-trip 保留可映射像素、图层、时序、标签，并报告 AEONQUILL 专属字段', async () => {
  const document = createPixelDocument({
    id: 'roundtrip',
    name: 'Round trip',
    width: 2,
    height: 1,
    palette: [
      { id: 'red', name: 'Red', color: '#FF0000FF' },
      { id: 'blue', name: 'Blue', color: '#0000FFFF' },
    ],
    paletteCycles: [{ id: 'cycle', name: 'Cycle', colorIds: ['red', 'blue'], stepDurationMs: 80, direction: 'ping-pong', enabled: true }],
    layers: [{ id: 'ink', name: 'Ink', visible: true, locked: false, opacity: 1, groupId: null, blendMode: 'screen' }],
    frames: [
      { id: 'idle-1', name: 'Idle 1', durationMs: 80, cels: { ink: ['red', null] } },
      { id: 'idle-2', name: 'Idle 2', durationMs: 150, cels: { ink: [null, 'blue'] } },
    ],
    animationTags: [{ id: 'idle', name: 'Idle', fromFrameId: 'idle-1', toFrameId: 'idle-2', direction: 'ping-pong', loop: true }],
  })
  const before = JSON.stringify(document)
  const encoded = await encodeAseprite(document)
  assert.equal(JSON.stringify(document), before)
  assert.ok(encoded.bytes instanceof Uint8Array)
  assert.ok(encoded.warnings.some((message) => message.includes('paletteCycles')))
  const reopened = await decodeAseprite(encoded.bytes, { documentId: 'roundtrip-opened', documentName: 'Round trip opened' })
  assert.deepEqual(reopened.document.celLinks, [])
  assert.deepEqual(reopened.document.palette.map((color) => color.color), document.palette.map((color) => color.color))
  assert.deepEqual(reopened.document.layers.map(({ name, opacity, blendMode }) => ({ name, opacity, blendMode })), [
    { name: 'Ink', opacity: 1, blendMode: 'screen' },
  ])
  assert.deepEqual(reopened.document.frames.map((frame) => frame.durationMs), [80, 150])
  assert.deepEqual(reopened.document.animationTags.map(({ name, direction, loop }) => ({ name, direction, loop })), [
    { name: 'Idle', direction: 'ping-pong', loop: true },
  ])
  assert.deepEqual(Array.from(renderPixelFrameRgba(reopened.document, 'frame-1')), Array.from(renderPixelFrameRgba(document, 'idle-1')))
  assert.deepEqual(Array.from(renderPixelFrameRgba(reopened.document, 'frame-2')), Array.from(renderPixelFrameRgba(document, 'idle-2')))
})

test('拒绝截断、尺寸溢出、raw 长度错误、压缩炸弹、forward/cycle linked cel 和 unsupported blend/nesting', async () => {
  const valid = asepriteFile({
    width: 1,
    height: 1,
    frames: [frame([layerChunk({ name: 'Layer' }), celChunk({ pixels: rgba(1, 2, 3, 255) })])],
  })
  await assertDecodeCode(valid.slice(0, -1), 'TRUNCATED')
  const overflow = valid.slice()
  new DataView(overflow.buffer).setUint32(128, 0xFFFFFFFF, true)
  await assertDecodeCode(overflow, 'INVALID_FRAME_SIZE')
  const badRaw = asepriteFile({
    width: 2,
    height: 1,
    frames: [frame([layerChunk({ name: 'Layer' }), celChunk({ width: 2, height: 1, pixels: rgba(1, 2, 3, 255) })])],
  })
  await assertDecodeCode(badRaw, 'INVALID_RAW_LENGTH')
  const hugePixels = new Uint8Array(4096)
  const bomb = asepriteFile({
    width: 1,
    height: 1,
    frames: [frame([
      layerChunk({ name: 'Layer' }),
      celChunk({ type: 2, width: 1, height: 1, pixels: await deflate(hugePixels) }),
    ])],
  })
  await assertDecodeCode(bomb, 'DECOMPRESSION_LIMIT')
  const dimensionOverflow = asepriteFile({
    width: 1,
    height: 1,
    frames: [frame([layerChunk({ name: 'Layer' }), celChunk({ width: 513, height: 1 })])],
  })
  await assertDecodeCode(dimensionOverflow, 'CEL_DIMENSION_LIMIT')
  const forward = asepriteFile({
    width: 1,
    height: 1,
    frames: [
      frame([layerChunk({ name: 'Layer' }), celChunk({ pixels: rgba(1, 2, 3, 255) })]),
      frame([celChunk({ type: 1, framePosition: 2 })]),
      frame([celChunk({ type: 1, framePosition: 0 })]),
    ],
  })
  await assertDecodeCode(forward, 'INVALID_FORWARD_LINK')
  const cycle = asepriteFile({
    width: 1,
    height: 1,
    frames: [frame([layerChunk({ name: 'Layer' }), celChunk({ type: 1, framePosition: 0 })])],
  })
  await assertDecodeCode(cycle, 'LINK_CYCLE')
  const unsupportedBlend = asepriteFile({
    width: 1,
    height: 1,
    frames: [frame([layerChunk({ name: 'Layer', blend: 3 }), celChunk({ pixels: rgba(1, 2, 3, 255) })])],
  })
  await assertDecodeCode(unsupportedBlend, 'UNSUPPORTED_BLEND_MODE')
  const nestedGroup = asepriteFile({
    width: 1,
    height: 1,
    frames: [frame([
      layerChunk({ name: 'Outer', type: 1 }),
      layerChunk({ name: 'Inner', type: 1, childLevel: 1 }),
    ])],
  })
  await assertDecodeCode(nestedGroup, 'UNSUPPORTED_NESTING')
})

test('颜色超过 256 色时明确拒绝且不自动量化', async () => {
  const pixels = new Uint8Array(17 * 16 * 4)
  for (let index = 0; index < 17 * 16; index += 1) {
    const offset = index * 4
    pixels[offset] = index & 0xFF
    pixels[offset + 1] = (index >> 8) & 0xFF
    pixels[offset + 2] = 17
    pixels[offset + 3] = 255
  }
  const fixture = asepriteFile({
    width: 17,
    height: 16,
    frames: [frame([layerChunk({ name: 'Many colors' }), celChunk({ width: 17, height: 16, pixels })])],
  })
  await assertDecodeCode(fixture, 'COLOR_LIMIT_EXCEEDED')
})

test('缺少 cel 的帧保持透明，不继承前一帧像素', async () => {
  const fixture = asepriteFile({
    width: 1,
    height: 1,
    frames: [
      frame([
        layerChunk({ name: 'Layer' }),
        celChunk({ pixels: rgba(255, 0, 0, 255) }),
      ], 80),
      frame([], 120),
    ],
  })
  const { document } = await decodeAseprite(fixture)
  assert.deepEqual(document.frames[0].cels['layer-1'], ['color-1'])
  assert.deepEqual(document.frames[1].cels['layer-1'], [null])
})

test('indexed palette 按帧冻结，后续 palette chunk 不会改色早帧', async () => {
  const fixture = asepriteFile({
    width: 1,
    height: 1,
    colorDepth: 8,
    transparentIndex: 0,
    colorCount: 2,
    frames: [
      frame([
        layerChunk({ name: 'Indexed' }),
        paletteChunk([
          { r: 0, g: 0, b: 0, a: 0, name: 'Transparent' },
          { r: 255, g: 0, b: 0, a: 255, name: 'Red' },
        ]),
        celChunk({ width: 1, height: 1, pixels: Uint8Array.from([1]) }),
      ], 80),
      frame([
        paletteChunk([
          { r: 0, g: 0, b: 0, a: 0, name: 'Transparent' },
          { r: 0, g: 0, b: 255, a: 255, name: 'Blue' },
        ]),
        celChunk({ width: 1, height: 1, pixels: Uint8Array.from([1]) }),
      ], 120),
    ],
  })
  const { document } = await decodeAseprite(fixture)
  const paletteById = new Map(document.palette.map((color) => [color.id, color.color]))
  const firstColor = paletteById.get(document.frames[0].cels['layer-1'][0])
  const secondColor = paletteById.get(document.frames[1].cels['layer-1'][0])
  assert.equal(firstColor, '#FF0000FF')
  assert.equal(secondColor, '#0000FFFF')
  assert.notEqual(firstColor, secondColor)
})

test('显式 linked cel 链只有物化像素相等时才导入 celLinks', async () => {
  const linkedFixture = asepriteFile({
    width: 1,
    height: 1,
    frames: [
      frame([layerChunk({ name: 'Layer' }), celChunk({ pixels: rgba(255, 0, 0, 255) })], 80),
      frame([celChunk({ type: 1, framePosition: 0 })], 90),
      frame([celChunk({ type: 1, framePosition: 1 })], 100),
    ],
  })
  const linked = await decodeAseprite(linkedFixture)
  assert.equal(linked.document.celLinks.length, 1)
  assert.deepEqual(linked.document.celLinks[0].frameIds, ['frame-1', 'frame-2', 'frame-3'])
  assert.deepEqual(linked.document.frames[0].cels['layer-1'], linked.document.frames[2].cels['layer-1'])

  const differentFixture = asepriteFile({
    width: 1,
    height: 1,
    frames: [
      frame([layerChunk({ name: 'Layer' }), celChunk({ pixels: rgba(255, 0, 0, 255) })], 80),
      frame([celChunk({ type: 1, framePosition: 0, opacity: 128 })], 90),
    ],
  })
  const different = await decodeAseprite(differentFixture)
  assert.deepEqual(different.document.celLinks, [])
  assert.ok(different.warnings.some((message) => message.includes('未保留关联')))
})

test('encodeAseprite 对 celLinks 只写最早帧 raw/compressed，其余帧写 linked cel 并可往返', async () => {
  const source = createPixelDocument({
    id: 'linked-encode',
    name: 'Linked encode',
    width: 1,
    height: 1,
    palette: [{ id: 'red', name: 'Red', color: '#FF0000FF' }],
    layers: [{ id: 'ink', name: 'Ink', visible: true, locked: false, opacity: 1, groupId: null, blendMode: 'normal' }],
    frames: [
      { id: 'f1', name: 'F1', durationMs: 80, cels: { ink: ['red'] } },
      { id: 'f2', name: 'F2', durationMs: 90, cels: { ink: ['red'] } },
      { id: 'f3', name: 'F3', durationMs: 100, cels: { ink: ['red'] } },
    ],
    celLinks: [{ id: 'link-1', layerId: 'ink', frameIds: ['f1', 'f2', 'f3'] }],
  })
  const encoded = await encodeAseprite(source)
  const reopened = await decodeAseprite(encoded.bytes)
  assert.equal(reopened.document.celLinks.length, 1)
  assert.deepEqual(reopened.document.celLinks[0].frameIds, ['frame-1', 'frame-2', 'frame-3'])
  assert.deepEqual(reopened.document.frames.map((frame) => frame.durationMs), [80, 90, 100])
})
