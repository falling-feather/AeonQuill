import {
  PIXEL_METADATA_MIME,
  PIXEL_PROJECT_MIME,
  assertRgbaImage,
  deserializePixelProject,
  type PixelDocument,
  type PixelExportBundle,
  type RgbaImage,
} from '../../lib/pixel/index'

const IMAGE_MIME_TYPES = new Set(['image/png', 'image/webp'])
const IMAGE_EXTENSIONS = /\.(png|webp)$/i
const PROJECT_EXTENSIONS = /\.(aeonpixel\.json|pixel\.json|json)$/i
const MAX_IMAGE_FILE_BYTES = 32 * 1024 * 1024
const MAX_IMAGE_PIXELS = 16_777_216
const MAX_PROJECT_FILE_BYTES = 32 * 1024 * 1024

export class PixelBrowserError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'PixelBrowserError'
    this.code = code
  }
}

function assertImageFile(file: File) {
  if (!(file instanceof File)) throw new PixelBrowserError('INVALID_FILE', '请选择 PNG 或 WebP 文件')
  const recognizedType = IMAGE_MIME_TYPES.has(file.type)
  if (!recognizedType && !(file.type === '' && IMAGE_EXTENSIONS.test(file.name))) {
    throw new PixelBrowserError('UNSUPPORTED_IMAGE', '仅支持 PNG 与 WebP 图像')
  }
  if (file.size <= 0 || file.size > MAX_IMAGE_FILE_BYTES) {
    throw new PixelBrowserError('IMAGE_FILE_SIZE', '图像文件必须介于 1 B 与 32 MB 之间')
  }
}

async function decodeWithImageElement(file: File) {
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.decoding = 'async'
    image.src = url
    await image.decode()
    return image
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function decodePixelImageFile(file: File): Promise<RgbaImage & { sourceName: string }> {
  assertImageFile(file)
  let width = 0
  let height = 0
  let drawable: CanvasImageSource
  let bitmap: ImageBitmap | null = null
  if ('createImageBitmap' in window) {
    bitmap = await createImageBitmap(file)
    width = bitmap.width
    height = bitmap.height
    drawable = bitmap
  } else {
    const image = await decodeWithImageElement(file)
    width = image.naturalWidth
    height = image.naturalHeight
    drawable = image
  }
  try {
    if (width < 1 || height < 1 || width > 16_384 || height > 16_384 || width * height > MAX_IMAGE_PIXELS) {
      throw new PixelBrowserError('IMAGE_DIMENSIONS', '图像尺寸为空或超过浏览器安全上限')
    }
    const canvas = window.document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new PixelBrowserError('CANVAS_UNAVAILABLE', '浏览器无法创建图像解码画布')
    context.clearRect(0, 0, width, height)
    context.drawImage(drawable, 0, 0)
    const imageData = context.getImageData(0, 0, width, height)
    return { width, height, data: new Uint8ClampedArray(imageData.data), sourceName: file.name }
  } finally {
    bitmap?.close()
  }
}

export async function readPixelProjectFile(file: File): Promise<PixelDocument> {
  if (!(file instanceof File)) throw new PixelBrowserError('INVALID_FILE', '请选择像素项目 JSON')
  if (!PROJECT_EXTENSIONS.test(file.name)) throw new PixelBrowserError('UNSUPPORTED_PROJECT', '请选择 .aeonpixel.json 项目文件')
  if (file.size <= 0 || file.size > MAX_PROJECT_FILE_BYTES) {
    throw new PixelBrowserError('PROJECT_FILE_SIZE', '项目文件必须介于 1 B 与 32 MB 之间')
  }
  return deserializePixelProject(await file.text())
}

export async function rgbaToPngBlob(pixels: Uint8ClampedArray, width: number, height: number) {
  const rgba = assertRgbaImage({ width, height, data: pixels })
  const canvas = window.document.createElement('canvas')
  canvas.width = rgba.width
  canvas.height = rgba.height
  const context = canvas.getContext('2d')
  if (!context) throw new PixelBrowserError('CANVAS_UNAVAILABLE', '浏览器无法创建 PNG 编码画布')
  const imageData = context.createImageData(rgba.width, rgba.height)
  imageData.data.set(rgba.data)
  context.putImageData(imageData, 0, 0)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new PixelBrowserError('PNG_ENCODE_FAILED', 'PNG 编码失败')
  return blob
}

export function downloadPixelBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = window.document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  window.document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

export function downloadPixelText(text: string, filename: string, mime: string) {
  downloadPixelBlob(new Blob([text], { type: `${mime};charset=utf-8` }), filename)
}

export async function downloadPixelExportBundle(
  bundle: PixelExportBundle,
  options: { includeProject?: boolean; includeFrame?: boolean; includeSprite?: boolean; includeMetadata?: boolean } = {},
) {
  const includeProject = options.includeProject ?? true
  const includeFrame = options.includeFrame ?? true
  const includeSprite = options.includeSprite ?? true
  const includeMetadata = options.includeMetadata ?? true
  if (includeProject) downloadPixelText(bundle.project.text, bundle.project.filename, PIXEL_PROJECT_MIME)
  if (includeFrame) downloadPixelBlob(await rgbaToPngBlob(bundle.frame.pixels, bundle.frame.width, bundle.frame.height), bundle.frame.filename)
  if (includeSprite) downloadPixelBlob(await rgbaToPngBlob(bundle.sprite.pixels, bundle.sprite.width, bundle.sprite.height), bundle.sprite.filename)
  if (includeMetadata) downloadPixelText(bundle.metadata.text, bundle.metadata.filename, PIXEL_METADATA_MIME)
}
