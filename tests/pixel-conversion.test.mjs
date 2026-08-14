import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  PixelContractError,
  createPixelDocument,
  serializePixelDocument,
} from '../src/lib/pixel/pixelCore.mjs'
import {
  PIXEL_METADATA_MIME,
  PIXEL_PNG_MIME,
  PIXEL_PROJECT_MIME,
  convertRgbaToPixelDocument,
  createPixelExportBundle,
  deserializePixelProject,
  extractDeterministicPalette,
  pixelDocumentsSemanticallyEqual,
  resizeRgbaImage,
  serializePixelProject,
} from '../src/lib/pixel/pixelConversion.mjs'

const fixedRgba = JSON.parse(readFileSync(new URL('./fixtures/pixel-rgba-4x4.json', import.meta.url), 'utf8'))
const fixedProjectText = readFileSync(new URL('./fixtures/pixel-project-v1.aeonpixel.json', import.meta.url), 'utf8')

function expectContractError(callback, code) {
  assert.throws(callback, (error) => error instanceof PixelContractError && error.code === code)
}

test('fixed RGBA conversion is deterministic and matches the checked contract hash', () => {
  const options = {
    targetWidth: 6,
    targetHeight: 5,
    colorCount: 6,
    dither: 'floyd-steinberg',
    ditherStrength: 0.75,
    fit: 'contain',
    alphaThreshold: 16,
    documentId: 'fixture-conversion',
    documentName: 'Fixture conversion',
  }
  const first = convertRgbaToPixelDocument(fixedRgba, options)
  const second = convertRgbaToPixelDocument(fixedRgba, options)
  assert.deepEqual(first, second)
  const digest = createHash('sha256').update(serializePixelDocument(first.document)).digest('hex')
  assert.equal(digest, 'ad2c3bdfef7a8160f2731eaa15bd4f6656663c0d6cec8748bcc0fd4942437d8c')
  assert.deepEqual(first.report, {
    sourceWidth: 4,
    sourceHeight: 4,
    targetWidth: 6,
    targetHeight: 5,
    opaquePixels: 19,
    transparentPixels: 11,
    paletteSize: 6,
    paletteMode: 'generated',
    dither: 'floyd-steinberg',
    fit: 'contain',
    alphaThreshold: 16,
  })
})

test('transparent source pixels remain semantic null cells at the explicit threshold', () => {
  const converted = convertRgbaToPixelDocument(fixedRgba, {
    targetWidth: 4,
    targetHeight: 4,
    colorCount: 8,
    dither: 'none',
    fit: 'stretch',
    alphaThreshold: 16,
  })
  const pixels = converted.document.frames[0].cels.imported
  assert.equal(pixels[3], null)
  assert.equal(pixels[10], null, 'alpha 15 is transparent')
  assert.notEqual(pixels[11], null, 'alpha 16 is retained')
  assert.equal(pixels[15], null)
  assert.equal(converted.report.transparentPixels, 3)
  assert.equal(serializePixelDocument(converted.document).includes('data:image/'), false)
})

test('fully transparent pixels and contain padding stay null when alpha threshold is zero', () => {
  const converted = convertRgbaToPixelDocument({
    width: 2,
    height: 1,
    data: [255, 0, 255, 0, 0, 255, 0, 1],
  }, {
    targetWidth: 4,
    targetHeight: 4,
    colorCount: 2,
    dither: 'none',
    fit: 'contain',
    alphaThreshold: 0,
  })
  const pixels = converted.document.frames[0].cels.imported
  assert.equal(pixels[0], null, 'contain padding remains transparent')
  assert.equal(pixels[4], null, 'alpha 0 remains transparent even at threshold 0')
  assert.notEqual(pixels[6], null, 'alpha 1 remains eligible when threshold is 0')
  assert.equal(converted.report.transparentPixels, 12)
})

test('fixed palette and every dither mode are repeatable without mutating inputs', () => {
  const palette = [
    { id: 'black', name: 'Black', color: '#000000FF' },
    { id: 'white', name: 'White', color: '#FFFFFFFF' },
    { id: 'cyan', name: 'Cyan', color: '#00FFFFFF' },
  ]
  const snapshot = JSON.stringify({ fixedRgba, palette })
  for (const dither of ['none', 'bayer4', 'floyd-steinberg']) {
    const options = {
      targetWidth: 4,
      targetHeight: 4,
      palette,
      colorCount: 2,
      dither,
      ditherStrength: 0.8,
      fit: 'stretch',
      alphaThreshold: 16,
    }
    const first = convertRgbaToPixelDocument(fixedRgba, options)
    const second = convertRgbaToPixelDocument(fixedRgba, options)
    assert.deepEqual(first.document.frames[0].cels.imported, second.document.frames[0].cels.imported)
    assert.deepEqual(first.document.palette, palette)
    assert.equal(first.report.paletteMode, 'fixed')
  }
  assert.equal(JSON.stringify({ fixedRgba, palette }), snapshot)
})

test('nearest-neighbour resize and palette extraction are isolated pure functions', () => {
  const source = {
    width: 2,
    height: 1,
    data: [255, 0, 0, 255, 0, 0, 255, 255],
  }
  const resized = resizeRgbaImage(source, { width: 4, height: 2, fit: 'stretch' })
  assert.deepEqual([...resized.data.slice(0, 16)], [
    255, 0, 0, 255,
    255, 0, 0, 255,
    0, 0, 255, 255,
    0, 0, 255, 255,
  ])
  assert.deepEqual(
    extractDeterministicPalette(source.data, { colorCount: 2, alphaThreshold: 1 }).map((color) => color.color),
    ['#0000FFFF', '#FF0000FF'],
  )
  assert.deepEqual(source.data, [255, 0, 0, 255, 0, 0, 255, 255])
})

test('contain preserves at least one source pixel at extreme aspect ratios', () => {
  const vertical = {
    width: 1,
    height: 512,
    data: new Uint8ClampedArray(1 * 512 * 4).fill(255),
  }
  const horizontal = resizeRgbaImage(vertical, { width: 512, height: 1, fit: 'contain' })
  let opaque = 0
  for (let offset = 3; offset < horizontal.data.length; offset += 4) {
    if (horizontal.data[offset] > 0) opaque += 1
  }
  assert.equal(opaque, 1)

  const wide = {
    width: 512,
    height: 1,
    data: new Uint8ClampedArray(512 * 1 * 4).fill(255),
  }
  const verticalTarget = resizeRgbaImage(wide, { width: 1, height: 512, fit: 'contain' })
  opaque = 0
  for (let offset = 3; offset < verticalTarget.data.length; offset += 4) {
    if (verticalTarget.data[offset] > 0) opaque += 1
  }
  assert.equal(opaque, 1)
})

test('invalid RGBA, conversion options, and schema-less projects are rejected', () => {
  expectContractError(
    () => convertRgbaToPixelDocument({ width: 2, height: 2, data: [0, 0, 0, 255] }),
    'INVALID_RGBA',
  )
  expectContractError(
    () => convertRgbaToPixelDocument(fixedRgba, { targetWidth: 0 }),
    'INVALID_INTEGER',
  )
  expectContractError(
    () => convertRgbaToPixelDocument(fixedRgba, { dither: 'random-noise' }),
    'INVALID_DITHER',
  )
  expectContractError(
    () => deserializePixelProject(JSON.stringify({ width: 1, height: 1 })),
    'MISSING_SCHEMA_VERSION',
  )
  expectContractError(
    () => deserializePixelProject(JSON.stringify({ schemaVersion: 99 })),
    'UNSUPPORTED_SCHEMA',
  )
})

test('project JSON round-trip is semantically exact and schema v0 migrates explicitly', () => {
  const converted = convertRgbaToPixelDocument(fixedRgba, {
    targetWidth: 4,
    targetHeight: 4,
    colorCount: 5,
    dither: 'bayer4',
    fit: 'stretch',
    documentId: 'round-trip',
    documentName: 'Round trip',
  }).document
  const serialized = serializePixelProject(converted)
  const reopened = deserializePixelProject(serialized)
  assert.equal(pixelDocumentsSemanticallyEqual(converted, reopened), true)
  assert.equal(serializePixelDocument(converted), serializePixelDocument(reopened))
  assert.equal(serialized.includes('base64'), false)
  assert.equal(serialized.includes('data:'), false)

  const migrated = deserializePixelProject(JSON.stringify({
    schemaVersion: 0,
    id: 'legacy-fixture',
    name: 'Legacy fixture',
    width: 2,
    height: 1,
    palette: ['transparent', '#112233', '#AABBCCDD'],
    pixels: [1, 2],
    frameDurationMs: 90,
  }))
  assert.equal(migrated.schemaVersion, 1)
  assert.deepEqual(migrated.frames[0].cels['layer-1'], ['color-1', 'color-2'])
})

test('fixed browser project sample passes strict schema validation without embedded binary data', () => {
  const project = deserializePixelProject(fixedProjectText)
  assert.equal(project.id, 'browser-round-trip-fixture')
  assert.equal(project.revision, 4)
  assert.deepEqual(project.frames.map((frame) => [frame.id, frame.durationMs]), [['idle', 90], ['blink', 150]])
  assert.equal(fixedProjectText.includes('base64'), false)
  assert.equal(fixedProjectText.includes('data:'), false)
  assert.equal(pixelDocumentsSemanticallyEqual(project, deserializePixelProject(serializePixelProject(project))), true)
})

test('export bundle shares one sprite layout fact across PNG pixels and metadata', () => {
  const document = createPixelDocument({
    id: 'bundle-fixture',
    name: 'Bundle fixture',
    width: 2,
    height: 1,
    palette: [
      { id: 'red', name: 'Red', color: '#FF0000FF' },
      { id: 'blue', name: 'Blue', color: '#0000FFFF' },
    ],
    layers: [{ id: 'ink', name: 'Ink', visible: true, locked: false, opacity: 1 }],
    frames: [
      { id: 'idle', name: 'Idle', durationMs: 80, cels: { ink: ['red', null] } },
      { id: 'blink', name: 'Blink', durationMs: 130, cels: { ink: [null, 'blue'] } },
      { id: 'turn', name: 'Turn', durationMs: 210, cels: { ink: ['blue', 'red'] } },
    ],
    activeLayerId: 'ink',
    activeFrameId: 'blink',
  })
  const bundle = createPixelExportBundle(document, { columns: 2, padding: 1, spacing: 1 })
  assert.equal(bundle.project.mime, PIXEL_PROJECT_MIME)
  assert.equal(bundle.frame.mime, PIXEL_PNG_MIME)
  assert.equal(bundle.sprite.mime, PIXEL_PNG_MIME)
  assert.equal(bundle.metadata.mime, PIXEL_METADATA_MIME)
  assert.deepEqual(bundle.layout.cells, bundle.metadata.value.frames)
  assert.deepEqual(JSON.parse(bundle.metadata.text), bundle.metadata.value)
  assert.equal(bundle.sprite.width, bundle.layout.width)
  assert.equal(bundle.sprite.height, bundle.layout.height)
  assert.equal(bundle.sprite.pixels.length, bundle.layout.width * bundle.layout.height * 4)
  assert.deepEqual(bundle.metadata.value.frames.map((frame) => frame.frameId), ['idle', 'blink', 'turn'])
  assert.deepEqual(bundle.metadata.value.frames.map((frame) => frame.durationMs), [80, 130, 210])
  assert.equal(pixelDocumentsSemanticallyEqual(document, deserializePixelProject(bundle.project.text)), true)
})
