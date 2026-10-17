import {
  assertPixelDocument,
  applyPixelCommand,
  clonePixelDocument,
  createPixelCommand,
} from './pixelCore.mjs'
import {
  createPixelSelectionClipboard,
  createPixelSelectionPastePatch,
} from './pixelTools.mjs'

export const PIXEL_SYSTEM_CLIPBOARD_KIND = 'aeonquill.pixel-system-clipboard'
export const PIXEL_SYSTEM_CLIPBOARD_SCHEMA_VERSION = 1
export const PIXEL_SYSTEM_CLIPBOARD_MAX_TEXT_CHARACTERS = 1_048_576
export const PIXEL_SYSTEM_CLIPBOARD_MAX_COLORS = 256
export const PIXEL_SYSTEM_CLIPBOARD_MAX_CELLS = 65_536

const COLOR_PATTERN = /^#[0-9a-f]{8}$/u

export class PixelSystemClipboardError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'PixelSystemClipboardError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

function fail(code, message, details) {
  throw new PixelSystemClipboardError(code, message, details)
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertRecord(value, path) {
  if (!isRecord(value)) fail('INVALID_OBJECT', `${path} must be a plain object`, { path })
  return value
}

function assertKnownFields(value, allowed, path) {
  const unknown = Object.keys(value).find((key) => !allowed.has(key))
  if (unknown) fail('UNKNOWN_FIELD', `${path}.${unknown} is not allowed`, { path: `${path}.${unknown}` })
}

function assertInteger(value, path, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('INVALID_INTEGER', `${path} must be an integer between ${min} and ${max}`, { path, value })
  }
  return value
}

function assertSize(width, height, path = '') {
  assertInteger(width, `${path}width`, 1, 512)
  assertInteger(height, `${path}height`, 1, 512)
  const cells = width * height
  if (cells > PIXEL_SYSTEM_CLIPBOARD_MAX_CELLS) {
    fail('LIMIT_EXCEEDED', `Clipboard contains ${cells} cells; the maximum is ${PIXEL_SYSTEM_CLIPBOARD_MAX_CELLS}`, {
      cells,
      limit: PIXEL_SYSTEM_CLIPBOARD_MAX_CELLS,
    })
  }
  return cells
}

function assertPoint(input, path) {
  const point = assertRecord(input, path)
  assertKnownFields(point, new Set(['x', 'y']), path)
  return {
    x: assertInteger(point.x, `${path}.x`, 0, 511),
    y: assertInteger(point.y, `${path}.y`, 0, 511),
  }
}

function assertCanonicalColor(value, path) {
  if (typeof value !== 'string' || !COLOR_PATTERN.test(value)) {
    fail('INVALID_COLOR', `${path} must be a canonical lowercase #rrggbbaa color`, { path, value })
  }
  if (value.slice(-2) === '00') {
    fail('INVALID_COLOR', `${path} must not contain a fully transparent color; use null pixels`, { path, value })
  }
  return value
}

function canonicalColor(value, path = 'color') {
  if (typeof value !== 'string' || !/^#[0-9A-Fa-f]{8}$/u.test(value)) {
    fail('INVALID_COLOR', `${path} must use #RRGGBBAA`, { path, value })
  }
  const normalized = value.toLowerCase()
  if (normalized.slice(-2) === '00') {
    return null
  }
  return normalized
}

function colorBytes(color) {
  return [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
    Number.parseInt(color.slice(7, 9), 16),
  ]
}

function assertRgbaInput(width, height, rgba) {
  const cells = assertSize(width, height)
  if (!(rgba instanceof Uint8Array || rgba instanceof Uint8ClampedArray)) {
    fail('INVALID_RGBA', 'rgba must be a Uint8Array or Uint8ClampedArray')
  }
  if (rgba.length !== cells * 4) {
    fail('INVALID_RGBA', `rgba must contain exactly ${cells * 4} channel bytes`, {
      expected: cells * 4,
      actual: rgba.length,
    })
  }
  return cells
}

function createColorTableFromRgba(width, height, rgba) {
  const cells = assertRgbaInput(width, height, rgba)
  const colors = []
  const colorIndexes = new Map()
  const pixels = Array.from({ length: cells }, () => null)
  for (let index = 0; index < cells; index += 1) {
    const offset = index * 4
    const alpha = rgba[offset + 3]
    if (alpha === 0) continue
    const color = `#${[rgba[offset], rgba[offset + 1], rgba[offset + 2], alpha]
      .map((channel) => channel.toString(16).padStart(2, '0'))
      .join('')}`
    let colorIndex = colorIndexes.get(color)
    if (colorIndex === undefined) {
      colorIndex = colors.length
      colors.push(color)
      colorIndexes.set(color, colorIndex)
      if (colors.length > PIXEL_SYSTEM_CLIPBOARD_MAX_COLORS) {
        fail('PALETTE_LIMIT', '系统剪贴板包含超过 256 种不透明颜色，请先使用图像转换', {
          colors: colors.length,
          limit: PIXEL_SYSTEM_CLIPBOARD_MAX_COLORS,
        })
      }
    }
    pixels[index] = colorIndex
  }
  return assertPixelSystemClipboard({
    kind: PIXEL_SYSTEM_CLIPBOARD_KIND,
    schemaVersion: PIXEL_SYSTEM_CLIPBOARD_SCHEMA_VERSION,
    width,
    height,
    colors,
    pixels,
  })
}

export function assertPixelSystemClipboard(input) {
  const clipboard = assertRecord(input, 'clipboard')
  assertKnownFields(clipboard, new Set(['kind', 'schemaVersion', 'width', 'height', 'colors', 'pixels']), 'clipboard')
  if (clipboard.kind !== PIXEL_SYSTEM_CLIPBOARD_KIND || clipboard.schemaVersion !== PIXEL_SYSTEM_CLIPBOARD_SCHEMA_VERSION) {
    fail('UNSUPPORTED_CLIPBOARD', 'Clipboard kind or schemaVersion is unsupported', {
      kind: clipboard.kind,
      schemaVersion: clipboard.schemaVersion,
    })
  }
  const cells = assertSize(clipboard.width, clipboard.height, 'clipboard.')
  if (!Array.isArray(clipboard.colors) || clipboard.colors.length > PIXEL_SYSTEM_CLIPBOARD_MAX_COLORS) {
    fail('INVALID_COLORS', `clipboard.colors must contain 0-${PIXEL_SYSTEM_CLIPBOARD_MAX_COLORS} colors`)
  }
  const colors = clipboard.colors.map((value, index) => assertCanonicalColor(value, `clipboard.colors[${index}]`))
  if (new Set(colors).size !== colors.length) fail('DUPLICATE_COLOR', 'clipboard.colors must not contain duplicate colors')
  if (!Array.isArray(clipboard.pixels) || clipboard.pixels.length !== cells) {
    fail('INVALID_PIXELS', `clipboard.pixels must contain exactly ${cells} values`, {
      expected: cells,
      actual: Array.isArray(clipboard.pixels) ? clipboard.pixels.length : undefined,
    })
  }
  const pixels = clipboard.pixels.map((value, index) => {
    if (value === null) return null
    return assertInteger(value, `clipboard.pixels[${index}]`, 0, colors.length - 1)
  })
  return {
    kind: PIXEL_SYSTEM_CLIPBOARD_KIND,
    schemaVersion: PIXEL_SYSTEM_CLIPBOARD_SCHEMA_VERSION,
    width: clipboard.width,
    height: clipboard.height,
    colors: [...colors],
    pixels,
  }
}

export function createPixelSystemClipboard(documentInput, selectionInput) {
  const document = assertPixelDocument(documentInput)
  const frame = document.frames.find((item) => item.id === document.activeFrameId)
  const layer = document.layers.find((item) => item.id === document.activeLayerId)
  const selectionClipboard = createPixelSelectionClipboard(
    frame.cels[layer.id],
    document.width,
    document.height,
    selectionInput,
    {
      documentId: document.id,
      documentRevision: document.revision,
      frameId: frame.id,
      layerId: layer.id,
    },
  )
  const paletteById = new Map(document.palette.map((color) => [color.id, color.color]))
  const colors = []
  const colorIndexes = new Map()
  const pixels = selectionClipboard.pixels.map((colorId, index) => {
    if (colorId === null) return null
    const color = canonicalColor(paletteById.get(colorId), `document.palette color for pixel ${index}`)
    if (color === null) return null
    let colorIndex = colorIndexes.get(color)
    if (colorIndex === undefined) {
      colorIndex = colors.length
      colors.push(color)
      colorIndexes.set(color, colorIndex)
    }
    return colorIndex
  })
  return assertPixelSystemClipboard({
    kind: PIXEL_SYSTEM_CLIPBOARD_KIND,
    schemaVersion: PIXEL_SYSTEM_CLIPBOARD_SCHEMA_VERSION,
    width: selectionClipboard.width,
    height: selectionClipboard.height,
    colors,
    pixels,
  })
}

export function serializePixelSystemClipboard(input) {
  const clipboard = assertPixelSystemClipboard(input)
  const text = JSON.stringify(clipboard)
  if (text.length > PIXEL_SYSTEM_CLIPBOARD_MAX_TEXT_CHARACTERS) {
    fail('TEXT_TOO_LARGE', `Serialized clipboard exceeds ${PIXEL_SYSTEM_CLIPBOARD_MAX_TEXT_CHARACTERS} characters`, {
      characters: text.length,
      limit: PIXEL_SYSTEM_CLIPBOARD_MAX_TEXT_CHARACTERS,
    })
  }
  return text
}

export function deserializePixelSystemClipboard(text) {
  if (typeof text !== 'string') fail('INVALID_SERIALIZED_CLIPBOARD', 'Serialized clipboard must be text')
  if (text.length > PIXEL_SYSTEM_CLIPBOARD_MAX_TEXT_CHARACTERS) {
    fail('TEXT_TOO_LARGE', `Serialized clipboard exceeds ${PIXEL_SYSTEM_CLIPBOARD_MAX_TEXT_CHARACTERS} characters`, {
      characters: text.length,
      limit: PIXEL_SYSTEM_CLIPBOARD_MAX_TEXT_CHARACTERS,
    })
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    fail('INVALID_JSON', 'Serialized clipboard is not valid JSON', { cause: String(error) })
  }
  return assertPixelSystemClipboard(parsed)
}

export function pixelSystemClipboardFromRgba(width, height, rgba) {
  return createColorTableFromRgba(width, height, rgba)
}

export function pixelSystemClipboardToRgba(input) {
  const clipboard = assertPixelSystemClipboard(input)
  const rgba = new Uint8ClampedArray(clipboard.width * clipboard.height * 4)
  for (let index = 0; index < clipboard.pixels.length; index += 1) {
    const colorIndex = clipboard.pixels[index]
    if (colorIndex === null) continue
    const [red, green, blue, alpha] = colorBytes(clipboard.colors[colorIndex])
    const offset = index * 4
    rgba[offset] = red
    rgba[offset + 1] = green
    rgba[offset + 2] = blue
    rgba[offset + 3] = alpha
  }
  return { width: clipboard.width, height: clipboard.height, rgba }
}

function createUniqueClipboardColorId(palette, color) {
  const usedIds = new Set(palette.map((entry) => entry.id))
  const base = `clipboard-color-${color.slice(1)}`
  let id = base
  let suffix = 2
  while (usedIds.has(id)) id = `${base}-${suffix++}`
  return id
}

function createAddedColor(palette, color) {
  return {
    id: createUniqueClipboardColorId(palette, color),
    name: `Clipboard ${color}`,
    color,
  }
}

export function pastePixelSystemClipboard(documentInput, clipboardInput, targetInput, optionsInput = {}) {
  const document = assertPixelDocument(documentInput)
  const clipboard = assertPixelSystemClipboard(clipboardInput)
  const target = assertPoint(targetInput, 'target')
  if (target.x + clipboard.width > document.width || target.y + clipboard.height > document.height) {
    fail('OUT_OF_BOUNDS', 'Clipboard destination exceeds the pixel surface', { target, width: clipboard.width, height: clipboard.height })
  }
  const options = assertRecord(optionsInput, 'options')
  assertKnownFields(options, new Set(['mode']), 'options')
  const mode = options.mode ?? 'replace'
  if (mode !== 'replace' && mode !== 'opaque-only') fail('INVALID_MODE', 'options.mode must be replace or opaque-only', { mode })

  const frame = document.frames.find((item) => item.id === document.activeFrameId)
  const layer = document.layers.find((item) => item.id === document.activeLayerId)
  const sourceCel = frame.cels[layer.id]
  const paletteByColor = new Map()
  for (const color of document.palette) {
    const canonical = canonicalColor(color.color, `document.palette.${color.id}`)
    if (canonical !== null && !paletteByColor.has(canonical)) paletteByColor.set(canonical, color.id)
  }

  const usedIndexes = new Set()
  for (const colorIndex of clipboard.pixels) {
    if (colorIndex !== null) usedIndexes.add(colorIndex)
  }
  const addedColors = []
  const palette = [...document.palette]
  const colorIds = clipboard.colors.map((color, index) => {
    if (paletteByColor.has(color)) return paletteByColor.get(color)
    if (!usedIndexes.has(index)) return null
    if (palette.length + addedColors.length >= 256) {
      fail('PALETTE_LIMIT', '粘贴需要超过 256 种调色板颜色，请先使用图像转换', {
        limit: 256,
        color,
      })
    }
    const added = createAddedColor([...palette, ...addedColors], color)
    addedColors.push(added)
    paletteByColor.set(color, added.id)
    return added.id
  })

  const mappedClipboard = {
    kind: 'aeonquill.pixel-selection-clipboard',
    schemaVersion: 1,
    width: clipboard.width,
    height: clipboard.height,
    pixels: clipboard.pixels.map((colorIndex) => colorIndex === null ? null : colorIds[colorIndex]),
    source: {
      documentId: document.id,
      documentRevision: document.revision,
      frameId: frame.id,
      layerId: layer.id,
      canvasWidth: document.width,
      canvasHeight: document.height,
      selection: { x: target.x, y: target.y, width: clipboard.width, height: clipboard.height },
    },
  }
  const candidate = clonePixelDocument(document)
  candidate.palette = [...palette, ...addedColors]
  const changed = createPixelSelectionPastePatch(
    sourceCel,
    document.width,
    document.height,
    mappedClipboard,
    target,
    { mode, allowedColorIds: candidate.palette.map((color) => color.id) },
  )
  const selection = { x: target.x, y: target.y, width: clipboard.width, height: clipboard.height }
  const commandPayload = { frameId: frame.id, layerId: layer.id, pixels: changed }
  if (changed.length === 0) {
    const noOpDocument = addedColors.length === 0 ? candidate : clonePixelDocument(document)
    createPixelCommand(noOpDocument, 'pixels.patch', {
      frameId: frame.id,
      layerId: layer.id,
      pixels: [{ x: target.x, y: target.y, value: sourceCel[target.y * document.width + target.x] }],
    }, { id: `pixel-system-clipboard-validate-${document.revision + 1}`, actor: 'user' })
    return { document: noOpDocument, selection, changedPixels: 0, addedColors: [] }
  }
  const command = createPixelCommand(candidate, 'pixels.patch', commandPayload, {
    id: `pixel-system-clipboard-${document.revision + 1}`,
    actor: 'user',
  })
  const result = applyPixelCommand(candidate, command)
  return {
    document: result.document,
    selection,
    changedPixels: changed.length,
    addedColors: addedColors.map((color) => ({ ...color })),
  }
}
