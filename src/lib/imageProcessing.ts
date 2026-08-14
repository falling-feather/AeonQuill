import type {
  CropSettings,
  ImageAdjustments,
  MaskDraft,
  MaskRecipe,
  MaskStroke,
  PixelDraft,
} from '../types'

export const DEFAULT_IMAGE_ADJUSTMENTS: ImageAdjustments = {
  brightness: 100,
  contrast: 100,
  saturation: 100,
}

type PixelPreviewSettings = {
  outputSize: number
  colorCount: number
  ditherStrength: number
  edgePreserve: boolean
}

type BackgroundPreviewSettings = {
  threshold: number
  softness: number
}

type UpscalePreviewSettings = {
  scale: number
  smooth: boolean
}

type RGB = {
  r: number
  g: number
  b: number
}

const BAYER_4X4 = [
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
]

const MASK_PREVIEW_MAX_EDGE = 1_024
const MASK_OUTPUT_MAX_PIXELS = 24_000_000
const MASK_MAX_STROKES = 512
const MASK_MAX_POINTS = 20_000

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function channelToHex(value: number) {
  return Math.round(clamp(value, 0, 255)).toString(16).padStart(2, '0')
}

function rgbToHex(color: RGB) {
  return `#${channelToHex(color.r)}${channelToHex(color.g)}${channelToHex(color.b)}`
}

function colorDistance(a: RGB, b: RGB) {
  const redMean = (a.r + b.r) / 2
  const red = a.r - b.r
  const green = a.g - b.g
  const blue = a.b - b.b
  return (
    (2 + redMean / 256) * red * red +
    4 * green * green +
    (2 + (255 - redMean) / 256) * blue * blue
  )
}

function nearestPaletteIndex(color: RGB, palette: RGB[]) {
  let bestIndex = 0
  let bestDistance = Number.POSITIVE_INFINITY
  for (let index = 0; index < palette.length; index += 1) {
    const distance = colorDistance(color, palette[index])
    if (distance < bestDistance) {
      bestDistance = distance
      bestIndex = index
    }
  }
  return bestIndex
}

function createCanvas(width: number, height: number) {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  return canvas
}

function getContext(canvas: HTMLCanvasElement) {
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('当前浏览器无法创建图像处理画布')
  return context
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('无法读取当前图片'))
    image.src = src
  })
}

function drawContained(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  width: number,
  height: number,
) {
  const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight)
  const drawWidth = image.naturalWidth * scale
  const drawHeight = image.naturalHeight * scale
  context.drawImage(
    image,
    (width - drawWidth) / 2,
    (height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  )
}

function brushStamp(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  hardness: number,
  value: 0 | 255,
) {
  const gradient = context.createRadialGradient(x, y, 0, x, y, radius)
  const color = value === 255 ? '255,255,255' : '0,0,0'
  gradient.addColorStop(0, 'rgba(' + color + ',1)')
  gradient.addColorStop(
    Math.min(0.999, Math.max(0.001, hardness)),
    'rgba(' + color + ',1)',
  )
  gradient.addColorStop(1, 'rgba(' + color + ',0)')
  context.fillStyle = gradient
  context.beginPath()
  context.arc(x, y, radius, 0, Math.PI * 2)
  context.fill()
}

function drawMaskStroke(
  context: CanvasRenderingContext2D,
  stroke: MaskStroke,
  width: number,
  height: number,
) {
  if (!stroke.points.length) return
  const minimumDimension = Math.min(width, height)
  const radius = Math.max(0.75, clamp(stroke.size, 0.001, 0.75) * minimumDimension / 2)
  const hardness = clamp(stroke.hardness, 0, 1)
  const value = stroke.mode === 'restore' ? 255 : 0
  const spacing = Math.max(0.6, radius * 0.22)
  let previous = stroke.points[0]
  brushStamp(
    context,
    clamp(previous.x, 0, 1) * width,
    clamp(previous.y, 0, 1) * height,
    radius,
    hardness,
    value,
  )
  for (let index = 1; index < stroke.points.length; index += 1) {
    const point = stroke.points[index]
    const startX = clamp(previous.x, 0, 1) * width
    const startY = clamp(previous.y, 0, 1) * height
    const endX = clamp(point.x, 0, 1) * width
    const endY = clamp(point.y, 0, 1) * height
    const distance = Math.hypot(endX - startX, endY - startY)
    const steps = Math.max(1, Math.ceil(distance / spacing))
    for (let step = 1; step <= steps; step += 1) {
      const progress = step / steps
      brushStamp(
        context,
        startX + (endX - startX) * progress,
        startY + (endY - startY) * progress,
        radius,
        hardness,
        value,
      )
    }
    previous = point
  }
}

function boundedMaskStrokes(recipe: MaskRecipe) {
  const strokes = recipe.schemaVersion === 1 ? recipe.strokes.slice(0, MASK_MAX_STROKES) : []
  let pointCount = 0
  return strokes.flatMap((stroke) => {
    if (pointCount >= MASK_MAX_POINTS) return []
    const points = stroke.points.slice(0, MASK_MAX_POINTS - pointCount)
    pointCount += points.length
    return [{ ...stroke, points }]
  })
}

async function renderMaskRecipe(
  src: string,
  recipe: MaskRecipe,
  options: { maxEdge?: number; maxPixels: number },
): Promise<MaskDraft> {
  const image = await loadImage(src)
  const naturalPixels = image.naturalWidth * image.naturalHeight
  if (!options.maxEdge && naturalPixels > options.maxPixels) {
    throw new Error('图片过大，浏览器蒙版输出上限为 2400 万像素；请先缩小或裁剪')
  }
  const scale = options.maxEdge
    ? Math.min(1, options.maxEdge / Math.max(image.naturalWidth, image.naturalHeight))
    : 1
  const width = Math.max(1, Math.round(image.naturalWidth * scale))
  const height = Math.max(1, Math.round(image.naturalHeight * scale))
  if (width * height > options.maxPixels) throw new Error('蒙版处理尺寸超过浏览器安全上限')

  const outputCanvas = createCanvas(width, height)
  const outputContext = getContext(outputCanvas)
  outputContext.imageSmoothingEnabled = true
  outputContext.imageSmoothingQuality = 'high'
  outputContext.drawImage(image, 0, 0, width, height)
  const output = outputContext.getImageData(0, 0, width, height)

  const maskCanvas = createCanvas(width, height)
  const maskContext = getContext(maskCanvas)
  const baseMask = maskContext.createImageData(width, height)
  for (let index = 0; index < output.data.length; index += 4) {
    const alpha = output.data[index + 3]
    baseMask.data[index] = alpha
    baseMask.data[index + 1] = alpha
    baseMask.data[index + 2] = alpha
    baseMask.data[index + 3] = 255
  }
  maskContext.putImageData(baseMask, 0, 0)
  for (const stroke of boundedMaskStrokes(recipe)) {
    drawMaskStroke(maskContext, stroke, width, height)
  }

  const finalMask = maskContext.getImageData(0, 0, width, height)
  let changedAlpha = 0
  for (let index = 0; index < output.data.length; index += 4) {
    const nextAlpha = finalMask.data[index]
    changedAlpha += Math.abs(nextAlpha - output.data[index + 3])
    output.data[index + 3] = nextAlpha
  }
  outputContext.putImageData(output, 0, 0)
  return {
    recipe,
    previewUrl: outputCanvas.toDataURL('image/png'),
    width,
    height,
    changedPercent: Number((changedAlpha / (width * height * 255) * 100).toFixed(2)),
  }
}

function extractBaselinePalette(data: Uint8ClampedArray, colorCount: number) {
  const samples: RGB[] = []
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] < 32) continue
    samples.push({
      r: data[index],
      g: data[index + 1],
      b: data[index + 2],
    })
  }

  if (!samples.length) return [{ r: 45, g: 45, b: 47 }]

  const mean = samples.reduce(
    (sum, color) => ({
      r: sum.r + color.r / samples.length,
      g: sum.g + color.g / samples.length,
      b: sum.b + color.b / samples.length,
    }),
    { r: 0, g: 0, b: 0 },
  )
  const centroids: RGB[] = [{ ...mean }]
  const targetCount = Math.max(2, Math.min(colorCount, samples.length))

  while (centroids.length < targetCount) {
    let next = samples[0]
    let farthestDistance = -1
    for (const sample of samples) {
      const distance = Math.min(...centroids.map((centroid) => colorDistance(sample, centroid)))
      if (distance > farthestDistance) {
        farthestDistance = distance
        next = sample
      }
    }
    if (farthestDistance <= 0) break
    centroids.push({ ...next })
  }

  for (let iteration = 0; iteration < 9; iteration += 1) {
    const buckets = centroids.map(() => ({ r: 0, g: 0, b: 0, count: 0 }))
    for (const sample of samples) {
      const bucket = buckets[nearestPaletteIndex(sample, centroids)]
      bucket.r += sample.r
      bucket.g += sample.g
      bucket.b += sample.b
      bucket.count += 1
    }
    buckets.forEach((bucket, index) => {
      if (!bucket.count) return
      centroids[index] = {
        r: bucket.r / bucket.count,
        g: bucket.g / bucket.count,
        b: bucket.b / bucket.count,
      }
    })
  }

  const unique = new Map<string, RGB>()
  centroids.forEach((color) => {
    const normalized = {
      r: Math.round(color.r),
      g: Math.round(color.g),
      b: Math.round(color.b),
    }
    unique.set(rgbToHex(normalized), normalized)
  })
  return [...unique.values()]
}

function renderPixelPreview(
  width: number,
  height: number,
  pixels: string[],
  palette: string[],
) {
  const canvas = createCanvas(width, height)
  const context = getContext(canvas)
  context.clearRect(0, 0, width, height)
  pixels.forEach((pixel, index) => {
    if (pixel === '.' || pixel === '0') return
    context.fillStyle = palette[Number(pixel)] ?? '#2d2d2f'
    context.fillRect(index % width, Math.floor(index / width), 1, 1)
  })
  return canvas.toDataURL('image/png')
}

export function imageAdjustmentFilter(adjustments?: ImageAdjustments) {
  const value = adjustments ?? DEFAULT_IMAGE_ADJUSTMENTS
  return `brightness(${value.brightness}%) contrast(${value.contrast}%) saturate(${value.saturation}%)`
}

export async function createPixelDraft(
  src: string,
  settings: PixelPreviewSettings,
): Promise<PixelDraft> {
  const image = await loadImage(src)
  const size = clamp(Math.round(settings.outputSize), 12, 64)
  const canvas = createCanvas(size, size)
  const context = getContext(canvas)
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, size, size)
  context.imageSmoothingEnabled = !settings.edgePreserve
  context.imageSmoothingQuality = 'high'
  drawContained(context, image, size, size)

  const imageData = context.getImageData(0, 0, size, size)
  const paletteRgb = extractBaselinePalette(imageData.data, settings.colorCount)
  const palette = ['transparent', ...paletteRgb.map(rgbToHex)]
  const pixels: string[] = []
  const ditherAmount = clamp(settings.ditherStrength, 0, 100) * 0.32

  for (let pixelIndex = 0; pixelIndex < size * size; pixelIndex += 1) {
    const dataIndex = pixelIndex * 4
    if (imageData.data[dataIndex + 3] < 32) {
      pixels.push('.')
      continue
    }
    const x = pixelIndex % size
    const y = Math.floor(pixelIndex / size)
    const threshold = ((BAYER_4X4[(y % 4) * 4 + (x % 4)] + 0.5) / 16 - 0.5) * ditherAmount
    const color = {
      r: clamp(imageData.data[dataIndex] + threshold, 0, 255),
      g: clamp(imageData.data[dataIndex + 1] + threshold, 0, 255),
      b: clamp(imageData.data[dataIndex + 2] + threshold, 0, 255),
    }
    pixels.push(String(nearestPaletteIndex(color, paletteRgb) + 1))
  }

  return {
    width: size,
    height: size,
    pixels,
    palette,
    previewUrl: renderPixelPreview(size, size, pixels, palette),
  }
}

export async function createBackgroundPreview(
  src: string,
  settings: BackgroundPreviewSettings,
) {
  const image = await loadImage(src)
  const scale = Math.min(1, 720 / Math.max(image.naturalWidth, image.naturalHeight))
  const width = Math.max(1, Math.round(image.naturalWidth * scale))
  const height = Math.max(1, Math.round(image.naturalHeight * scale))
  const canvas = createCanvas(width, height)
  const context = getContext(canvas)
  context.drawImage(image, 0, 0, width, height)

  const imageData = context.getImageData(0, 0, width, height)
  const threshold = clamp(settings.threshold, 200, 254)
  const softness = Math.max(1, clamp(settings.softness, 0, 48))
  for (let index = 0; index < imageData.data.length; index += 4) {
    const red = imageData.data[index]
    const green = imageData.data[index + 1]
    const blue = imageData.data[index + 2]
    const lowestChannel = Math.min(red, green, blue)
    const colorSpread = Math.max(red, green, blue) - lowestChannel
    if (colorSpread > 28) continue
    if (lowestChannel >= threshold) {
      imageData.data[index + 3] = 0
    } else if (lowestChannel > threshold - softness) {
      const alpha = ((threshold - lowestChannel) / softness) * imageData.data[index + 3]
      imageData.data[index + 3] = Math.round(alpha)
    }
  }
  context.putImageData(imageData, 0, 0)
  return { url: canvas.toDataURL('image/png'), width, height }
}

export async function createCropPreview(src: string, settings: CropSettings) {
  const image = await loadImage(src)
  const aspectMap: Record<CropSettings['aspect'], number> = {
    '1:1': 1,
    '4:3': 4 / 3,
    '3:4': 3 / 4,
    '16:9': 16 / 9,
  }
  const ratio = aspectMap[settings.aspect]
  const width = ratio >= 1 ? 640 : Math.round(640 * ratio)
  const height = ratio >= 1 ? Math.round(640 / ratio) : 640
  const canvas = createCanvas(width, height)
  const context = getContext(canvas)
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'

  const coverScale = Math.max(width / image.naturalWidth, height / image.naturalHeight)
  const scale = coverScale * clamp(settings.zoom, 1, 2.5)
  const drawWidth = image.naturalWidth * scale
  const drawHeight = image.naturalHeight * scale
  const x = (width - drawWidth) * (clamp(settings.positionX, 0, 100) / 100)
  const y = (height - drawHeight) * (clamp(settings.positionY, 0, 100) / 100)
  context.drawImage(image, x, y, drawWidth, drawHeight)

  return { url: canvas.toDataURL('image/png'), width, height }
}

export async function createUpscalePreview(
  src: string,
  settings: UpscalePreviewSettings,
) {
  const image = await loadImage(src)
  const requestedScale = clamp(settings.scale, 2, 4)
  const safetyScale = Math.min(
    requestedScale,
    2048 / Math.max(image.naturalWidth, image.naturalHeight),
  )
  const scale = Math.max(1, safetyScale)
  const width = Math.max(1, Math.round(image.naturalWidth * scale))
  const height = Math.max(1, Math.round(image.naturalHeight * scale))
  const canvas = createCanvas(width, height)
  const context = getContext(canvas)
  context.imageSmoothingEnabled = settings.smooth
  context.imageSmoothingQuality = 'high'
  context.drawImage(image, 0, 0, width, height)
  return { url: canvas.toDataURL('image/png'), width, height, scale }
}

export function createEmptyMaskRecipe(): MaskRecipe {
  return { schemaVersion: 1, strokes: [] }
}

export async function createMaskPreview(src: string, recipe: MaskRecipe): Promise<MaskDraft> {
  return renderMaskRecipe(src, recipe, {
    maxEdge: MASK_PREVIEW_MAX_EDGE,
    maxPixels: MASK_PREVIEW_MAX_EDGE * MASK_PREVIEW_MAX_EDGE,
  })
}

export async function createMaskRefinement(src: string, recipe: MaskRecipe): Promise<MaskDraft> {
  return renderMaskRecipe(src, recipe, { maxPixels: MASK_OUTPUT_MAX_PIXELS })
}
