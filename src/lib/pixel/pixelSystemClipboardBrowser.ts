import {
  assertPixelSystemClipboard,
  pixelSystemClipboardFromRgba,
  pixelSystemClipboardToRgba,
  serializePixelSystemClipboard,
  type PixelSystemClipboard,
} from './pixelSystemClipboard.mjs'

const MAX_PNG_BYTES = 8 * 1024 * 1024
const MAX_TEXT_BYTES = 1024 * 1024

function clipboardError(message: string): never { throw new Error(message) }

function pngBlob(payload: PixelSystemClipboard): Promise<Blob> {
  const { width, height, rgba } = pixelSystemClipboardToRgba(payload)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) clipboardError('无法准备剪贴板 PNG，请使用内存剪贴板')
  const image = context.createImageData(width, height)
  image.data.set(rgba)
  context.putImageData(image, 0, 0)
  return new Promise((resolve, reject) => canvas.toBlob((blob) => {
    if (blob) resolve(blob)
    else reject(new Error('无法编码剪贴板 PNG'))
  }, 'image/png'))
}

export async function writePixelSystemClipboard(payload: PixelSystemClipboard): Promise<'png-and-text' | 'text'> {
  const text = serializePixelSystemClipboard(payload)
  if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
    // Start the permission-bearing write during the click's user activation;
    // ClipboardItem accepts the PNG encoding promise.
    await navigator.clipboard.write([new ClipboardItem({
      'image/png': pngBlob(payload),
      'text/plain': new Blob([text], { type: 'text/plain' }),
    })])
    return 'png-and-text'
  }
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return 'text'
  }
  return clipboardError('此浏览器未提供系统剪贴板写入，请使用内存复制/粘贴')
}

async function decodePng(blob: Blob): Promise<PixelSystemClipboard> {
  if (blob.size < 24 || blob.size > MAX_PNG_BYTES) clipboardError('剪贴板 PNG 为空、损坏或超过 8MiB')
  const header = new Uint8Array(await blob.slice(0, 24).arrayBuffer())
  const magic = [137, 80, 78, 71, 13, 10, 26, 10]
  if (magic.some((value, index) => header[index] !== value)
    || String.fromCharCode(...header.subarray(12, 16)) !== 'IHDR') clipboardError('剪贴板图片不是有效 PNG')
  const view = new DataView(header.buffer)
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  if (width < 1 || height < 1 || width > 512 || height > 512 || width * height > 65_536) {
    clipboardError('剪贴板图片最多 512×512、65536 像素；更大图片请使用图像转像素')
  }
  const bitmap = await createImageBitmap(blob)
  try {
    if (bitmap.width !== width || bitmap.height !== height) clipboardError('剪贴板 PNG 尺寸不一致')
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) clipboardError('无法读取剪贴板图片')
    context.drawImage(bitmap, 0, 0)
    return pixelSystemClipboardFromRgba(width, height, context.getImageData(0, 0, width, height).data)
  } finally { bitmap.close() }
}

function ownPixelText(text: string): PixelSystemClipboard | null {
  if (text.length > MAX_TEXT_BYTES) clipboardError('剪贴板文本超过 1Mi 字符')
  let value: unknown
  try { value = JSON.parse(text) } catch { return null }
  if (!value || typeof value !== 'object' || !('kind' in value) || value.kind !== 'aeonquill.pixel-system-clipboard') return null
  // Our protocol must pass its strict validator; malformed data never silently
  // falls through to another representation of the same clipboard item.
  return assertPixelSystemClipboard(value)
}

export async function readPixelSystemClipboard(data?: DataTransfer): Promise<PixelSystemClipboard> {
  if (data) {
    // Snapshot event-owned data before awaiting PNG decoding.
    const text = data.getData('text/plain')
    const image = [...data.files].find((file) => file.type === 'image/png')
    const own = text ? ownPixelText(text) : null
    if (own) return own
    if (image) return decodePng(image)
    return clipboardError('剪贴板没有像素数据或 PNG 图片')
  }
  if (!navigator.clipboard?.read) clipboardError('此浏览器未提供剪贴板读取，请在画布上使用系统粘贴快捷键，或使用内存剪贴板')
  const items = await navigator.clipboard.read()
  if (items.length > 8) clipboardError('剪贴板项目过多，请只复制一张图片或一份像素选区')
  for (const item of items) {
    if (!item.types.includes('text/plain')) continue
    const blob = await item.getType('text/plain')
    if (blob.size > MAX_TEXT_BYTES) clipboardError('剪贴板像素文本超过 1MiB')
    const own = ownPixelText(await blob.text())
    if (own) return own
  }
  const image = items.find((item) => item.types.includes('image/png'))
  if (image) return decodePng(await image.getType('image/png'))
  return clipboardError('剪贴板没有像素数据或 PNG 图片；文本粘贴可用于普通输入框')
}
