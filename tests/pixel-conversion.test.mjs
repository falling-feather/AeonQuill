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
  PIXEL_CONVERSION_PRESETS,
  PIXEL_PNG_MIME,
  PIXEL_PROJECT_MIME,
  convertRgbaToPixelDocument,
  createPixelExportBundle,
  deserializePixelProject,
  extractDeterministicPalette,
  normalizePixelConversionOptions,
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
  assert.equal(digest, '25ed0b2b5c6ae50ecc761676350b3d8f89aba301ec4631b84cbbd1467dbfe8a9')
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
    resample: 'nearest',
    colorMatch: 'rgb',
    alphaMode: 'threshold',
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

test('normalization exposes the deterministic conversion algorithms and rejects unknown values', () => {
  assert.deepEqual(normalizePixelConversionOptions({}).resample, 'nearest')
  assert.deepEqual(normalizePixelConversionOptions({}).colorMatch, 'rgb')
  assert.deepEqual(normalizePixelConversionOptions({}).alphaMode, 'threshold')
  assert.deepEqual(normalizePixelConversionOptions({
    resample: 'area',
    colorMatch: 'oklab',
    alphaMode: 'preserve',
  }), {
    targetWidth: 32,
    targetHeight: 32,
    colorCount: 8,
    palette: null,
    dither: 'none',
    ditherStrength: 1,
    fit: 'contain',
    alphaThreshold: 16,
    documentId: 'imported-pixel',
    documentName: 'Imported pixel art',
    resample: 'area',
    colorMatch: 'oklab',
    alphaMode: 'preserve',
  })
  expectContractError(() => normalizePixelConversionOptions({ resample: 'bilinear' }), 'INVALID_RESAMPLE')
  expectContractError(() => normalizePixelConversionOptions({ colorMatch: 'hsv' }), 'INVALID_COLOR_MATCH')
  expectContractError(() => normalizePixelConversionOptions({ alphaMode: 'blend' }), 'INVALID_ALPHA_MODE')
})

test('conversion presets are immutable normalized recipes and do not change legacy defaults', () => {
  assert.deepEqual(Object.keys(PIXEL_CONVERSION_PRESETS), ['pixel-art', 'illustration', 'soft-alpha'])
  for (const [id, preset] of Object.entries(PIXEL_CONVERSION_PRESETS)) {
    assert.equal(preset.id, id)
    assert.equal(typeof preset.label, 'string')
    assert.equal(Object.isFrozen(preset), true)
    assert.equal(Object.isFrozen(preset.settings), true)
    const normalized = normalizePixelConversionOptions(preset.settings)
    assert.deepEqual({
      resample: normalized.resample,
      colorMatch: normalized.colorMatch,
      alphaMode: normalized.alphaMode,
      dither: normalized.dither,
    }, preset.settings)
  }
  assert.deepEqual({
    resample: normalizePixelConversionOptions({}).resample,
    colorMatch: normalizePixelConversionOptions({}).colorMatch,
    alphaMode: normalizePixelConversionOptions({}).alphaMode,
    dither: normalizePixelConversionOptions({}).dither,
  }, { resample: 'nearest', colorMatch: 'rgb', alphaMode: 'threshold', dither: 'none' })
  assert.throws(() => { PIXEL_CONVERSION_PRESETS['pixel-art'].settings.resample = 'area' }, TypeError)
})

test('area resize averages opaque black and white in linear sRGB', () => {
  const resized = resizeRgbaImage({
    width: 2,
    height: 2,
    data: [
      0, 0, 0, 255, 255, 255, 255, 255,
      255, 255, 255, 255, 0, 0, 0, 255,
    ],
  }, { width: 1, height: 1, fit: 'stretch', resample: 'area' })
  assert.deepEqual([...resized.data], [188, 188, 188, 255])
})

test('area resize ignores hidden RGB when averaging transparent edges', () => {
  const resized = resizeRgbaImage({
    width: 2,
    height: 1,
    data: [255, 255, 255, 255, 0, 0, 0, 0],
  }, { width: 1, height: 1, fit: 'stretch', resample: 'area' })
  assert.deepEqual([...resized.data], [255, 255, 255, 128])
})

test('area resize preserves exact pixels at 1:1 and while enlarging a single pixel', () => {
  const source = { width: 1, height: 1, data: [37, 101, 203, 77] }
  assert.deepEqual([...resizeRgbaImage(source, {
    width: 1,
    height: 1,
    fit: 'stretch',
    resample: 'area',
  }).data], source.data)
  assert.deepEqual([...resizeRgbaImage(source, {
    width: 3,
    height: 2,
    fit: 'stretch',
    resample: 'area',
  }).data], Array.from({ length: 6 }, () => source.data).flat())
})

test('preserve palette extraction keeps same RGB colors with distinct alpha and skips fully transparent pixels', () => {
  const palette = extractDeterministicPalette([
    255, 0, 0, 64,
    255, 0, 0, 192,
    0, 255, 0, 0,
  ], { colorCount: 2, alphaThreshold: 240, alphaMode: 'preserve' })
  assert.deepEqual(palette.map((color) => color.color), ['#FF000040', '#FF0000C0'])
})

test('weighted median cut separates a dominant terminal color instead of mixing it into the background', () => {
  const rgba = new Uint8ClampedArray(20 * 4).fill(255)
  rgba.set([255, 0, 0, 255], 0)
  rgba.set([0, 255, 0, 255], 4)
  const before = rgba.slice()
  for (const alphaMode of ['threshold', 'preserve']) {
    const palette = extractDeterministicPalette(rgba, { colorCount: 2, alphaMode })
    assert.deepEqual(palette.map(({ color }) => color), ['#808000FF', '#FFFFFFFF'])
  }
  assert.deepEqual(rgba, before)
})

test('preserve conversion matches fixed palette entries by alpha and reports selected algorithms', () => {
  const palette = [
    { id: 'light-red', name: 'Light red', color: '#FF000040' },
    { id: 'dark-red', name: 'Dark red', color: '#FF0000C0' },
  ]
  const converted = convertRgbaToPixelDocument({
    width: 2,
    height: 1,
    data: [255, 0, 0, 64, 255, 0, 0, 192],
  }, {
    targetWidth: 2,
    targetHeight: 1,
    palette,
    fit: 'stretch',
    alphaMode: 'preserve',
    colorMatch: 'rgb',
  })
  assert.deepEqual(converted.document.palette, palette)
  assert.deepEqual(converted.document.frames[0].cels.imported, ['light-red', 'dark-red'])
  assert.equal(converted.report.resample, 'nearest')
  assert.equal(converted.report.colorMatch, 'rgb')
  assert.equal(converted.report.alphaMode, 'preserve')
})

test('oklab matching can select a different perceptual neighbor than legacy RGB distance', () => {
  const source = { width: 1, height: 1, data: [5, 157, 98, 255] }
  const palette = [
    { id: 'blue', name: 'Blue', color: '#2E1FD9FF' },
    { id: 'red', name: 'Red', color: '#F4301AFF' },
  ]
  const rgb = convertRgbaToPixelDocument(source, {
    targetWidth: 1,
    targetHeight: 1,
    palette,
    fit: 'stretch',
    colorMatch: 'rgb',
  })
  const oklab = convertRgbaToPixelDocument(source, {
    targetWidth: 1,
    targetHeight: 1,
    palette,
    fit: 'stretch',
    colorMatch: 'oklab',
  })
  assert.deepEqual(rgb.document.frames[0].cels.imported, ['blue'])
  assert.deepEqual(oklab.document.frames[0].cels.imported, ['red'])
})

test('oklab threshold matching keeps legacy fixed-palette alpha semantics', () => {
  const converted = convertRgbaToPixelDocument({
    width: 1,
    height: 1,
    data: [255, 0, 0, 255],
  }, {
    targetWidth: 1,
    targetHeight: 1,
    palette: [
      { id: 'transparent-red', name: 'Transparent red', color: '#FF000000' },
      { id: 'opaque-red', name: 'Opaque red', color: '#FF0000FF' },
    ],
    fit: 'stretch',
    colorMatch: 'oklab',
    alphaMode: 'threshold',
  })
  assert.deepEqual(converted.document.frames[0].cels.imported, ['transparent-red'])
})

test('area, oklab, and preserve conversion remain deterministic for frozen input', () => {
  const source = Object.freeze({
    width: 2,
    height: 2,
    data: Object.freeze([
      5, 157, 98, 32, 244, 48, 26, 224,
      5, 157, 98, 32, 0, 0, 0, 0,
    ]),
  })
  const options = {
    targetWidth: 3,
    targetHeight: 3,
    colorCount: 2,
    fit: 'contain',
    resample: 'area',
    colorMatch: 'oklab',
    alphaMode: 'preserve',
  }
  const before = JSON.stringify(source)
  const first = convertRgbaToPixelDocument(source, options)
  const second = convertRgbaToPixelDocument(source, options)
  assert.deepEqual(first, second)
  assert.equal(JSON.stringify(source), before)
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

  const schemaEight = JSON.parse(serializePixelDocument(converted))
  schemaEight.schemaVersion = 8
  delete schemaEight.celLinks
  const migratedSchemaEight = deserializePixelProject(JSON.stringify(schemaEight))
  assert.equal(migratedSchemaEight.schemaVersion, 9)
  assert.deepEqual(migratedSchemaEight.celLinks, [])

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
  assert.equal(migrated.schemaVersion, 9)
  assert.deepEqual(migrated.frames[0].cels['layer-1'], ['color-1', 'color-2'])
  assert.deepEqual(migrated.frames[0].gameplay, { anchor: { x: 1, y: 1 }, collisions: [], tileRule: null })
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
  assert.deepEqual(
    bundle.layout.cells,
    bundle.metadata.value.frames.map(({ gameplay: _gameplay, ...frame }) => frame),
  )
  assert.deepEqual(JSON.parse(bundle.metadata.text), bundle.metadata.value)
  assert.equal(bundle.sprite.width, bundle.layout.width)
  assert.equal(bundle.sprite.height, bundle.layout.height)
  assert.equal(bundle.sprite.pixels.length, bundle.layout.width * bundle.layout.height * 4)
  assert.deepEqual(bundle.metadata.value.frames.map((frame) => frame.frameId), ['idle', 'blink', 'turn'])
  assert.deepEqual(bundle.metadata.value.frames.map((frame) => frame.durationMs), [80, 130, 210])
  assert.deepEqual(bundle.metadata.value.frames.map((frame) => frame.gameplay.anchor), [
    { x: 1, y: 1 },
    { x: 1, y: 1 },
    { x: 1, y: 1 },
  ])
  assert.equal(pixelDocumentsSemanticallyEqual(document, deserializePixelProject(bundle.project.text)), true)
})
