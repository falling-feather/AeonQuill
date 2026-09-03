import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowLeft as ArrowLeftSmall,
  Copy,
  Compass,
  Download,
  Eraser,
  Eye,
  EyeOff,
  FileImage,
  Film,
  FlipHorizontal2,
  FlipVertical2,
  FolderOpen,
  Grid3X3,
  Layers,
  Lock,
  Minus,
  Move,
  PaintBucket,
  Pause,
  Pencil,
  Pipette,
  Play,
  Plus,
  PackageOpen,
  Redo2,
  Settings2,
  Square,
  SquareDashedMousePointer,
  Sparkles,
  Trash2,
  Undo2,
  Unlock,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  PixelContractError,
  PIXEL_PROJECT_EXTENSION,
  PIXEL_PROJECT_MIME,
  applyPixelCommand,
  convertRgbaToPixelDocument,
  createBlankPixelArray,
  createPixelExportBundle,
  createPixelGameExportBundle,
  createPixelCommand,
  createPixelDocument,
  createSpriteSheetMetadata,
  createSelectionPatch,
  createSmartPixelCleanupPatch,
  expandPixelBrush,
  floodFillPixels,
  migratePixelDocument,
  normalizePixelRect,
  rasterPixelLine,
  rasterPixelRectangle,
  renderPixelFrameRgba,
  resolvePixelAnimationFrames,
  safePixelFilename,
  serializePixelProject,
  type PixelCommand,
  type PixelCommandType,
  type PixelAnimationDirection,
  type PixelConversionReport,
  type PixelDitherMode,
  type PixelDocument,
  type PixelFitMode,
  type PixelPoint,
  type PixelRect,
  type RgbaImage,
  type SpriteSheetMetadata,
} from '../../lib/pixel/index'
import type { LibraryAssetInsertion } from '../../lib/libraryApi'
import {
  PixelBrowserError,
  decodePixelImageFile,
  downloadPixelExportBundle,
  downloadPixelGameExportBundle,
  downloadPixelText,
  readPixelProjectFile,
} from './pixelBrowser'
import './pixel-mode.css'

type PixelTool = 'pencil' | 'eraser' | 'fill' | 'picker' | 'line' | 'rectangle' | 'marquee'

type HistoryState = {
  document: PixelDocument
  undo: PixelCommand[]
  redo: PixelCommand[]
}

type PixelStrokeContext = {
  baseRevision: number
  frameId: string
  layerId: string
  tool: 'pencil' | 'eraser'
  colorId: string
  previewColor: string
  layerOpacity: number
  brushSize: number
  mirrorHorizontal: boolean
  mirrorVertical: boolean
}

type PixelDragContext = {
  baseRevision: number
  frameId: string
  layerId: string
  tool: 'line' | 'rectangle' | 'marquee'
  colorId: string
  start: PixelPoint
  current: PixelPoint
}

type PixelImportSettings = {
  targetWidth: number
  targetHeight: number
  colorCount: number
  dither: PixelDitherMode
  fit: PixelFitMode
  paletteMode: 'generated' | 'current'
  alphaThreshold: number
}

type ImportedSource = RgbaImage & {
  sourceName: string
}

export type PixelSpriteSheetPayload = {
  document: PixelDocument
  metadata: SpriteSheetMetadata
  pixels: Uint8ClampedArray
}

export type PixelModeWorkbenchProps = {
  initialDocument?: PixelDocument
  projectId?: string
  projectName?: string
  className?: string
  onBack?: () => void
  onDocumentChange?: (document: PixelDocument) => void
  onSpriteSheetReady?: (payload: PixelSpriteSheetPayload) => void | Promise<void>
  libraryAsset?: LibraryAssetInsertion
  onLibraryAssetConsumed?: (nonce: number) => void
}

export function createDefaultPixelProject(input: { id?: string; name?: string } = {}) {
  const base = createPixelDocument({
    id: input.id ?? 'aeonquill-pixel-starter',
    name: input.name ?? '光羽练习',
    width: 16,
    height: 16,
  })
  const layers = [
    { id: 'silhouette', name: '轮廓', visible: true, locked: false, opacity: 1 },
    { id: 'light', name: '流光', visible: true, locked: false, opacity: 1 },
  ]
  const frameCoordinates = [
    [[3, 12], [4, 11], [5, 10], [6, 9], [7, 8], [8, 7], [9, 6], [10, 5], [11, 4], [12, 3]],
    [[3, 11], [4, 10], [5, 9], [6, 8], [7, 7], [8, 6], [9, 5], [10, 4], [11, 4], [12, 3]],
    [[3, 10], [4, 9], [5, 8], [6, 7], [7, 6], [8, 5], [9, 4], [10, 4], [11, 3], [12, 3]],
  ]
  const frames = frameCoordinates.map((coordinates, frameIndex) => {
    const silhouette = createBlankPixelArray(16, 16)
    const light = createBlankPixelArray(16, 16)
    for (const [index, [x, y]] of coordinates.entries()) {
      silhouette[y * 16 + x] = index % 3 === 0 ? 'violet' : 'ink'
      if (index > 2 && index < 8) light[(y - 1) * 16 + x] = index % 2 === 0 ? 'ember' : 'aether'
    }
    light[(12 - frameIndex) * 16 + 2] = 'ember'
    light[(13 - frameIndex) * 16 + 1] = 'paper'
    return {
      id: `frame-${frameIndex + 1}`,
      name: `姿态 ${frameIndex + 1}`,
      durationMs: 140,
      cels: { silhouette, light },
    }
  })
  return createPixelDocument({
    id: base.id,
    name: base.name,
    width: base.width,
    height: base.height,
    palette: base.palette,
    layers,
    frames,
    animationTags: [{
      id: 'light-loop',
      name: '流光循环',
      fromFrameId: 'frame-1',
      toFrameId: 'frame-3',
      direction: 'ping-pong',
      loop: true,
    }],
    activeLayerId: 'light',
    activeFrameId: 'frame-1',
  })
}

function uniqueId(prefix: string, existing: string[], revision: number) {
  let suffix = revision + 1
  let candidate = `${prefix}-${suffix}`
  while (existing.includes(candidate)) {
    suffix += 1
    candidate = `${prefix}-${suffix}`
  }
  return candidate
}

function putRgbaOnCanvas(
  target: CanvasRenderingContext2D,
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  opacity = 1,
  tint?: [number, number, number],
) {
  const buffer = window.document.createElement('canvas')
  buffer.width = width
  buffer.height = height
  const bufferContext = buffer.getContext('2d')
  if (!bufferContext) return
  const pixels = tint ? new Uint8ClampedArray(rgba) : rgba
  if (tint) {
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3] === 0) continue
      pixels[index] = tint[0]
      pixels[index + 1] = tint[1]
      pixels[index + 2] = tint[2]
    }
  }
  const imageData = bufferContext.createImageData(width, height)
  imageData.data.set(pixels)
  bufferContext.putImageData(imageData, 0, 0)
  target.save()
  target.globalAlpha = opacity
  target.imageSmoothingEnabled = false
  target.drawImage(buffer, 0, 0)
  target.restore()
}

function sourceDocumentName(filename: string) {
  const withoutExtension = filename.replace(/\.(png|webp)$/i, '').trim()
  return withoutExtension.slice(0, 120) || 'Imported pixel art'
}

function readablePixelError(error: unknown, fallback: string) {
  if (error instanceof PixelContractError || error instanceof PixelBrowserError) return error.message
  return error instanceof Error ? error.message : fallback
}

export function PixelModeWorkbench({
  initialDocument,
  projectId = 'aeonquill-pixel-starter',
  projectName = '光羽练习',
  className = '',
  onBack,
  onDocumentChange,
  onSpriteSheetReady,
  libraryAsset,
  onLibraryAssetConsumed,
}: PixelModeWorkbenchProps) {
  const [history, setHistory] = useState<HistoryState>(() => ({
    document: initialDocument
      ? migratePixelDocument(initialDocument)
      : createDefaultPixelProject({ id: projectId, name: projectName }),
    undo: [],
    redo: [],
  }))
  const [tool, setTool] = useState<PixelTool>('pencil')
  const [brushSize, setBrushSize] = useState(1)
  const [mirrorHorizontal, setMirrorHorizontal] = useState(false)
  const [mirrorVertical, setMirrorVertical] = useState(false)
  const [gridVisible, setGridVisible] = useState(true)
  const [zoom, setZoom] = useState(1)
  const [selection, setSelection] = useState<PixelRect | null>(null)
  const [dragDraft, setDragDraft] = useState<PixelDragContext | null>(null)
  const [activeColorId, setActiveColorId] = useState(() => history.document.palette[2]?.id ?? history.document.palette[0].id)
  const [status, setStatus] = useState('确定性编辑已就绪')
  const [importSettings, setImportSettings] = useState<PixelImportSettings>({
    targetWidth: 32,
    targetHeight: 32,
    colorCount: 8,
    dither: 'none',
    fit: 'contain',
    paletteMode: 'generated',
    alphaThreshold: 16,
  })
  const [importSourceSummary, setImportSourceSummary] = useState<{ name: string; width: number; height: number } | null>(null)
  const [lastConversion, setLastConversion] = useState<PixelConversionReport | null>(null)
  const [isImporting, setIsImporting] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [previewFrameCursor, setPreviewFrameCursor] = useState<number | null>(null)
  const [activeAnimationTagId, setActiveAnimationTagId] = useState<string | null>(
    () => history.document.animationTags[0]?.id ?? null,
  )
  const [batchDurationMs, setBatchDurationMs] = useState('140')
  const [strokePreviewRevision, setStrokePreviewRevision] = useState(0)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const importedSourceRef = useRef<ImportedSource | null>(null)
  const paintingRef = useRef(false)
  const strokeContextRef = useRef<PixelStrokeContext | null>(null)
  const strokePointsRef = useRef(new Map<string, { x: number; y: number }>())
  const lastStrokePointRef = useRef<PixelPoint | null>(null)
  const dragContextRef = useRef<PixelDragContext | null>(null)
  const commandSequenceRef = useRef(1)
  const consumedLibraryAssetRef = useRef<number | null>(null)
  const document = history.document
  const historyRef = useRef(history)
  historyRef.current = history

  const replaceHistory = useCallback((next: HistoryState) => {
    historyRef.current = next
    setHistory(next)
  }, [])

  const stopPlayback = useCallback(() => {
    setIsPlaying(false)
    setPreviewFrameCursor(null)
  }, [])

  const apply = useCallback((type: PixelCommandType, payload: Record<string, unknown>) => {
    stopPlayback()
    const current = historyRef.current
    try {
      const command = createPixelCommand(current.document, type, payload, {
        id: `pixel-ui-${commandSequenceRef.current++}`,
        actor: 'user',
      })
      const result = applyPixelCommand(current.document, command)
      replaceHistory({
        document: result.document,
        undo: [...current.undo, result.inverse],
        redo: [],
      })
      setStatus(`已应用：${type}`)
      return true
    } catch (error) {
      setStatus(error instanceof PixelContractError ? error.message : '像素命令执行失败')
      return false
    }
  }, [replaceHistory, stopPlayback])

  const undo = useCallback(() => {
    stopPlayback()
    const current = historyRef.current
    const inverse = current.undo.at(-1)
    if (!inverse) return
    try {
      const result = applyPixelCommand(current.document, inverse)
      replaceHistory({
        document: result.document,
        undo: current.undo.slice(0, -1),
        redo: [...current.redo, result.inverse],
      })
      setStatus('已撤销上一步')
    } catch (error) {
      setStatus(error instanceof PixelContractError ? error.message : '撤销失败')
    }
  }, [replaceHistory, stopPlayback])

  const redo = useCallback(() => {
    stopPlayback()
    const current = historyRef.current
    const command = current.redo.at(-1)
    if (!command) return
    try {
      const result = applyPixelCommand(current.document, command)
      replaceHistory({
        document: result.document,
        undo: [...current.undo, result.inverse],
        redo: current.redo.slice(0, -1),
      })
      setStatus('已重做上一步')
    } catch (error) {
      setStatus(error instanceof PixelContractError ? error.message : '重做失败')
    }
  }, [replaceHistory, stopPlayback])

  const installDocument = useCallback((nextDocument: PixelDocument, message: string) => {
    stopPlayback()
    replaceHistory({ document: nextDocument, undo: [], redo: [] })
    setActiveColorId(nextDocument.palette[0].id)
    setActiveAnimationTagId(nextDocument.animationTags[0]?.id ?? null)
    setBatchDurationMs(String(nextDocument.frames[0]?.durationMs ?? 140))
    setSelection(null)
    setDragDraft(null)
    dragContextRef.current = null
    setStatus(message)
  }, [replaceHistory, stopPlayback])

  const loadImageSource = useCallback(async (file: File) => {
    setIsImporting(true)
    setStatus('正在解码 PNG / WebP…')
    try {
      const source = await decodePixelImageFile(file)
      importedSourceRef.current = source
      setImportSourceSummary({ name: source.sourceName, width: source.width, height: source.height })
      setLastConversion(null)
      setStatus(`已载入 ${source.sourceName}，调整参数后执行确定性转换`)
    } catch (error) {
      setStatus(readablePixelError(error, '图像导入失败'))
    } finally {
      setIsImporting(false)
    }
  }, [])

  const convertImportedSource = useCallback(async () => {
    const source = importedSourceRef.current
    if (!source) {
      setStatus('请先选择 PNG 或 WebP 图像')
      return
    }
    setIsImporting(true)
    setStatus('正在执行确定性缩放、量化与抖动…')
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    try {
      const { paletteMode, ...conversionSettings } = importSettings
      const { sourceName, ...rgbaSource } = source
      const result = convertRgbaToPixelDocument(rgbaSource, {
        ...conversionSettings,
        palette: paletteMode === 'current' ? historyRef.current.document.palette : undefined,
        documentId: `import-${commandSequenceRef.current++}`,
        documentName: sourceDocumentName(sourceName),
      })
      installDocument(
        result.document,
        `转换完成：${result.report.targetWidth} × ${result.report.targetHeight} · ${result.report.paletteSize} 色 · ${result.report.dither}`,
      )
      setLastConversion(result.report)
    } catch (error) {
      setStatus(readablePixelError(error, '像素转换失败'))
    } finally {
      setIsImporting(false)
    }
  }, [importSettings, installDocument])

  const loadProject = useCallback(async (file: File) => {
    setIsImporting(true)
    setStatus('正在校验像素项目 schemaVersion…')
    try {
      const nextDocument = await readPixelProjectFile(file)
      importedSourceRef.current = null
      setImportSourceSummary(null)
      setLastConversion(null)
      installDocument(nextDocument, `项目已重新打开：${nextDocument.name} · schema v${nextDocument.schemaVersion}`)
    } catch (error) {
      setStatus(readablePixelError(error, '项目导入失败'))
    } finally {
      setIsImporting(false)
    }
  }, [installDocument])

  useEffect(() => {
    onDocumentChange?.(document)
  }, [document, onDocumentChange])

  const activeAnimationTag = document.animationTags.find((tag) => tag.id === activeAnimationTagId)
    ?? document.animationTags[0]
    ?? null
  const animationRangeFrameIds = useMemo(() => {
    if (!activeAnimationTag) return document.frames.map((frame) => frame.id)
    const fromIndex = document.frames.findIndex((frame) => frame.id === activeAnimationTag.fromFrameId)
    const toIndex = document.frames.findIndex((frame) => frame.id === activeAnimationTag.toFrameId)
    return document.frames.slice(fromIndex, toIndex + 1).map((frame) => frame.id)
  }, [activeAnimationTag, document.frames])
  const playbackFrameIds = useMemo(
    () => activeAnimationTag
      ? resolvePixelAnimationFrames(document, activeAnimationTag.id)
      : document.frames.map((frame) => frame.id),
    [activeAnimationTag, document],
  )

  useEffect(() => {
    if (!isPlaying) return undefined
    if (playbackFrameIds.length === 0) {
      setIsPlaying(false)
      setPreviewFrameCursor(null)
      return undefined
    }
    const nextCursor = previewFrameCursor !== null
      && previewFrameCursor >= 0
      && previewFrameCursor < playbackFrameIds.length
      ? previewFrameCursor
      : Math.max(0, playbackFrameIds.indexOf(document.activeFrameId))
    if (previewFrameCursor !== nextCursor) {
      setPreviewFrameCursor(nextCursor)
      return undefined
    }
    const currentFrame = document.frames.find((frame) => frame.id === playbackFrameIds[nextCursor])
    if (!currentFrame) return undefined
    const timer = window.setTimeout(() => {
      if (nextCursor + 1 < playbackFrameIds.length) {
        setPreviewFrameCursor(nextCursor + 1)
        return
      }
      if (activeAnimationTag?.loop ?? true) {
        setPreviewFrameCursor(0)
        return
      }
      setIsPlaying(false)
      setPreviewFrameCursor(null)
    }, currentFrame.durationMs)
    return () => window.clearTimeout(timer)
  }, [activeAnimationTag?.loop, document.activeFrameId, document.frames, isPlaying, playbackFrameIds, previewFrameCursor])

  const displayedFrameId = isPlaying && previewFrameCursor !== null && playbackFrameIds[previewFrameCursor]
    ? playbackFrameIds[previewFrameCursor]
    : document.activeFrameId

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.width = document.width
    canvas.height = document.height
    const context = canvas.getContext('2d')
    if (!context) return
    context.clearRect(0, 0, document.width, document.height)
    context.imageSmoothingEnabled = false

    const activeIndex = document.frames.findIndex((frame) => frame.id === displayedFrameId)
    if (!isPlaying && document.onionSkin.enabled) {
      for (let distance = document.onionSkin.previousFrames; distance >= 1; distance -= 1) {
        const frame = document.frames[activeIndex - distance]
        if (!frame) continue
        putRgbaOnCanvas(
          context,
          renderPixelFrameRgba(document, frame.id),
          document.width,
          document.height,
          document.onionSkin.opacity / distance,
          [226, 105, 120],
        )
      }
      for (let distance = document.onionSkin.nextFrames; distance >= 1; distance -= 1) {
        const frame = document.frames[activeIndex + distance]
        if (!frame) continue
        putRgbaOnCanvas(
          context,
          renderPixelFrameRgba(document, frame.id),
          document.width,
          document.height,
          document.onionSkin.opacity / distance,
          [80, 178, 213],
        )
      }
    }
    putRgbaOnCanvas(
      context,
      renderPixelFrameRgba(document, displayedFrameId),
      document.width,
      document.height,
    )
  }, [displayedFrameId, document, isPlaying, strokePreviewRevision])

  const pixelAtPointer = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget
    const bounds = canvas.getBoundingClientRect()
    if (bounds.width <= 0 || bounds.height <= 0) return null
    const x = Math.max(0, Math.min(canvas.width - 1, Math.floor(((event.clientX - bounds.left) / bounds.width) * canvas.width)))
    const y = Math.max(0, Math.min(canvas.height - 1, Math.floor(((event.clientY - bounds.top) / bounds.height) * canvas.height)))
    return { x, y }
  }, [])

  useEffect(() => {
    if (!libraryAsset || consumedLibraryAssetRef.current === libraryAsset.nonce) return
    consumedLibraryAssetRef.current = libraryAsset.nonce
    let disposed = false
    void (async () => {
      try {
        const response = await fetch(libraryAsset.asset.version.url, { credentials: 'same-origin' })
        if (!response.ok) throw new Error(`资源读取返回 HTTP ${response.status}`)
        let blob = await response.blob()
        let extension = libraryAsset.asset.version.extension
        if (!['image/png', 'image/webp'].includes(blob.type)) {
          const bitmap = await createImageBitmap(blob)
          try {
            const canvas = window.document.createElement('canvas')
            canvas.width = bitmap.width
            canvas.height = bitmap.height
            const context = canvas.getContext('2d')
            if (!context) throw new Error('浏览器无法规范化资源库图像')
            context.drawImage(bitmap, 0, 0)
            blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
              (value) => value ? resolve(value) : reject(new Error('无法编码像素导入 PNG')),
              'image/png',
            ))
            extension = 'png'
          } finally {
            bitmap.close()
          }
        }
        if (disposed) return
        await loadImageSource(new File([blob], `${libraryAsset.asset.title}.${extension}`, { type: blob.type }))
      } catch (error) {
        if (!disposed) setStatus(error instanceof Error ? error.message : '资源库图像投递失败')
      } finally {
        if (!disposed) onLibraryAssetConsumed?.(libraryAsset.nonce)
      }
    })()
    return () => { disposed = true }
  }, [libraryAsset, loadImageSource, onLibraryAssetConsumed])

  const stageStrokeAtPointer = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const stroke = strokeContextRef.current
    const point = pixelAtPointer(event)
    if (!stroke || !point) return
    const canvas = event.currentTarget
    const line = lastStrokePointRef.current
      ? rasterPixelLine(lastStrokePointRef.current, point, event.currentTarget.width, event.currentTarget.height)
      : [point]
    lastStrokePointRef.current = point
    const expanded = expandPixelBrush(line, event.currentTarget.width, event.currentTarget.height, {
      size: stroke.brushSize,
      mirrorHorizontal: stroke.mirrorHorizontal,
      mirrorVertical: stroke.mirrorVertical,
    })
    const context = canvas.getContext('2d')
    if (!context) return
    context.save()
    for (const pixel of expanded) {
      const pixelKey = `${pixel.x}:${pixel.y}`
      if (strokePointsRef.current.has(pixelKey)) continue
      strokePointsRef.current.set(pixelKey, pixel)
      if (stroke.tool === 'pencil') {
        context.globalAlpha = stroke.layerOpacity
        context.fillStyle = stroke.previewColor
        context.fillRect(pixel.x, pixel.y, 1, 1)
      } else {
        context.clearRect(pixel.x, pixel.y, 1, 1)
      }
    }
    context.restore()
  }, [pixelAtPointer])

  const beginCanvasGesture = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    stopPlayback()
    const current = historyRef.current.document
    const point = pixelAtPointer(event)
    if (!point) return

    if (tool === 'picker') {
      const frame = current.frames.find((item) => item.id === current.activeFrameId)
      const picked = [...current.layers].reverse().find((layer) => (
        layer.visible && layer.opacity > 0 && frame?.cels[layer.id]?.[point.y * current.width + point.x]
      ))
      const colorId = picked ? frame?.cels[picked.id]?.[point.y * current.width + point.x] : null
      if (colorId) {
        setActiveColorId(colorId)
        setTool('pencil')
        setStatus(`已吸取颜色：${current.palette.find((color) => color.id === colorId)?.name ?? colorId}`)
      } else {
        setStatus('该位置为透明像素')
      }
      return
    }

    if (tool === 'marquee') {
      const draft: PixelDragContext = {
        baseRevision: current.revision,
        frameId: current.activeFrameId,
        layerId: current.activeLayerId,
        tool,
        colorId: activeColorId,
        start: point,
        current: point,
      }
      dragContextRef.current = draft
      setDragDraft(draft)
      setSelection(null)
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }

    const activeLayer = current.layers.find((layer) => layer.id === current.activeLayerId)
    if (!activeLayer || activeLayer.locked) {
      setStatus(activeLayer ? `图层 ${activeLayer.name} 已锁定` : '当前图层不存在')
      return
    }

    if (tool === 'fill') {
      const frame = current.frames.find((item) => item.id === current.activeFrameId)
      const cel = frame?.cels[current.activeLayerId]
      if (!cel) return
      const points = floodFillPixels(cel, current.width, current.height, point, activeColorId)
      if (points.length === 0) {
        setStatus('填充区域已经是当前颜色')
        return
      }
      if (apply('pixels.paint', {
        frameId: current.activeFrameId,
        layerId: current.activeLayerId,
        pixels: points.map((pixel) => ({ ...pixel, colorId: activeColorId })),
      })) setStatus(`已填充 ${points.length} 个连续像素 · 1 个撤销单元`)
      return
    }

    if (tool === 'line' || tool === 'rectangle') {
      const draft: PixelDragContext = {
        baseRevision: current.revision,
        frameId: current.activeFrameId,
        layerId: current.activeLayerId,
        tool,
        colorId: activeColorId,
        start: point,
        current: point,
      }
      dragContextRef.current = draft
      setDragDraft(draft)
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }

    strokeContextRef.current = {
      baseRevision: current.revision,
      frameId: current.activeFrameId,
      layerId: current.activeLayerId,
      tool: tool === 'eraser' ? 'eraser' : 'pencil',
      colorId: activeColorId,
      previewColor: current.palette.find((color) => color.id === activeColorId)?.color ?? '#000000FF',
      layerOpacity: activeLayer.opacity,
      brushSize,
      mirrorHorizontal,
      mirrorVertical,
    }
    strokePointsRef.current.clear()
    lastStrokePointRef.current = null
    paintingRef.current = true
    event.currentTarget.setPointerCapture(event.pointerId)
    stageStrokeAtPointer(event)
  }, [activeColorId, apply, brushSize, mirrorHorizontal, mirrorVertical, pixelAtPointer, stageStrokeAtPointer, stopPlayback, tool])

  const updateCanvasGesture = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (paintingRef.current) {
      stageStrokeAtPointer(event)
      return
    }
    const draft = dragContextRef.current
    const point = pixelAtPointer(event)
    if (!draft || !point || (point.x === draft.current.x && point.y === draft.current.y)) return
    const next = { ...draft, current: point }
    dragContextRef.current = next
    setDragDraft(next)
  }, [pixelAtPointer, stageStrokeAtPointer])

  const finishStroke = useCallback(() => {
    const stroke = strokeContextRef.current
    const points = [...strokePointsRef.current.values()]
    paintingRef.current = false
    strokeContextRef.current = null
    lastStrokePointRef.current = null
    strokePointsRef.current.clear()
    setStrokePreviewRevision((revision) => revision + 1)
    if (!stroke || points.length === 0) return
    if (historyRef.current.document.revision !== stroke.baseRevision) {
      setStatus('笔划期间文档已变化，本次草稿未提交')
      return
    }
    const succeeded = stroke.tool === 'pencil'
      ? apply('pixels.paint', {
          frameId: stroke.frameId,
          layerId: stroke.layerId,
          pixels: points.map((point) => ({ ...point, colorId: stroke.colorId })),
        })
      : apply('pixels.erase', {
          frameId: stroke.frameId,
          layerId: stroke.layerId,
          pixels: points,
        })
    if (succeeded) setStatus(`已提交单笔：${points.length} 个唯一像素 · 1 个撤销单元`)
  }, [apply])

  const finishCanvasGesture = useCallback(() => {
    if (paintingRef.current) {
      finishStroke()
      return
    }
    const draft = dragContextRef.current
    dragContextRef.current = null
    setDragDraft(null)
    if (!draft) return
    const current = historyRef.current.document
    if (draft.baseRevision !== current.revision) {
      setStatus('拖拽期间文档已变化，本次草稿未提交')
      return
    }
    if (draft.tool === 'marquee') {
      const rect = normalizePixelRect(draft.start, draft.current, current.width, current.height)
      setSelection(rect)
      setStatus(`已选择 ${rect.width} × ${rect.height} 区域；方向键可逐像素移动`)
      return
    }
    const basePoints = draft.tool === 'line'
      ? rasterPixelLine(draft.start, draft.current, current.width, current.height)
      : rasterPixelRectangle(draft.start, draft.current, current.width, current.height)
    const points = expandPixelBrush(basePoints, current.width, current.height, {
      size: brushSize,
      mirrorHorizontal,
      mirrorVertical,
    })
    if (apply('pixels.paint', {
      frameId: draft.frameId,
      layerId: draft.layerId,
      pixels: points.map((point) => ({ ...point, colorId: draft.colorId })),
    })) setStatus(`已提交${draft.tool === 'line' ? '直线' : '矩形'}：${points.length} 个像素 · 1 个撤销单元`)
  }, [apply, brushSize, finishStroke, mirrorHorizontal, mirrorVertical])

  const applySelectionOperation = useCallback((
    operation: 'clear' | 'flip-horizontal' | 'flip-vertical' | 'move' | 'copy',
    options: { dx?: number; dy?: number } = {},
  ) => {
    if (!selection) return false
    const current = historyRef.current.document
    const activeLayer = current.layers.find((layer) => layer.id === current.activeLayerId)
    const frame = current.frames.find((item) => item.id === current.activeFrameId)
    const cel = frame?.cels[current.activeLayerId]
    if (!activeLayer || !cel) return false
    if (activeLayer.locked) {
      setStatus(`图层 ${activeLayer.name} 已锁定`)
      return false
    }
    try {
      const pixels = createSelectionPatch(cel, current.width, current.height, selection, operation, options)
      if (pixels.length === 0) {
        setStatus('该区域变换不会改变任何像素')
        return false
      }
      const succeeded = apply('pixels.patch', {
        frameId: current.activeFrameId,
        layerId: current.activeLayerId,
        pixels,
      })
      if (succeeded && (operation === 'move' || operation === 'copy')) {
        setSelection((value) => value ? { ...value, x: value.x + (options.dx ?? 0), y: value.y + (options.dy ?? 0) } : value)
      }
      if (succeeded) setStatus(`区域${operation === 'clear' ? '清除' : operation === 'copy' ? '复制' : operation === 'move' ? '移动' : '翻转'}完成 · ${pixels.length} 个混合像素 · 1 个撤销单元`)
      return succeeded
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '区域变换失败')
      return false
    }
  }, [apply, selection])

  const selectedLayer = document.layers.find((layer) => layer.id === document.activeLayerId) ?? document.layers[0]
  const selectedColor = document.palette.find((color) => color.id === activeColorId) ?? document.palette[0]
  const selectionPreview = useMemo(() => {
    if (!dragDraft) return selection
    return normalizePixelRect(dragDraft.start, dragDraft.current, document.width, document.height)
  }, [document.height, document.width, dragDraft, selection])
  const spriteMetadata = useMemo(
    () => createSpriteSheetMetadata(document, { columns: Math.min(4, document.frames.length), padding: 1, spacing: 1 }),
    [document],
  )

  const exportPixelProject = useCallback(async () => {
    setIsExporting(true)
    try {
      const current = historyRef.current.document
      const filename = `${safePixelFilename(current.name)}${PIXEL_PROJECT_EXTENSION}`
      downloadPixelText(serializePixelProject(current), filename, PIXEL_PROJECT_MIME)
      setStatus(`项目已导出：${filename} · ${PIXEL_PROJECT_MIME}`)
    } catch (error) {
      setStatus(readablePixelError(error, '项目导出失败'))
    } finally {
      setIsExporting(false)
    }
  }, [])

  const exportPixelBundle = useCallback(async () => {
    setIsExporting(true)
    try {
      const current = historyRef.current.document
      const bundle = createPixelExportBundle(current, {
        columns: Math.min(4, current.frames.length),
        padding: 1,
        spacing: 1,
      })
      await downloadPixelExportBundle(bundle, {
        includeSprite: !onSpriteSheetReady,
        includeMetadata: !onSpriteSheetReady,
      })
      await onSpriteSheetReady?.({ document: current, metadata: bundle.metadata.value, pixels: bundle.sprite.pixels })
      setStatus('成套导出完成：项目 JSON、当前帧 PNG、Sprite Sheet PNG 与 metadata')
    } catch (error) {
      setStatus(readablePixelError(error, '成套导出失败'))
    } finally {
      setIsExporting(false)
    }
  }, [onSpriteSheetReady])

  const cleanupActivePixelLayer = useCallback(() => {
    const current = historyRef.current.document
    const frame = current.frames.find((item) => item.id === current.activeFrameId)
    const layer = current.layers.find((item) => item.id === current.activeLayerId)
    const cel = frame?.cels[current.activeLayerId]
    if (!frame || !layer || !cel) {
      setStatus('当前帧或图层不可用')
      return
    }
    if (layer.locked) {
      setStatus(`图层 ${layer.name} 已锁定`)
      return
    }
    try {
      const cleanup = createSmartPixelCleanupPatch(cel, current.width, current.height)
      if (cleanup.pixels.length === 0) {
        setStatus('本地智能清理未发现孤立噪点或单像素针孔')
        return
      }
      if (apply('pixels.patch', { frameId: frame.id, layerId: layer.id, pixels: cleanup.pixels })) {
        setStatus(`智能清理完成：移除 ${cleanup.report.isolatedRemoved} 个孤点，填补 ${cleanup.report.pinholesFilled} 个针孔 · 1 个撤销单元`)
      }
    } catch (error) {
      setStatus(readablePixelError(error, '智能清理失败'))
    }
  }, [apply])

  const ensureEightDirectionSlots = useCallback(() => {
    const directions = [
      ['south', '南'], ['south-west', '西南'], ['west', '西'], ['north-west', '西北'],
      ['north', '北'], ['north-east', '东北'], ['east', '东'], ['south-east', '东南'],
    ] as const
    const sourceFrames = [...historyRef.current.document.frames]
    let changed = 0
    for (let index = 0; index < directions.length; index += 1) {
      const [, label] = directions[index]
      const current = historyRef.current.document
      const existing = current.frames[index]
      if (existing) {
        if (existing.name !== label && apply('frames.patch', { frameId: existing.id, patch: { name: label } })) changed += 1
        continue
      }
      const [directionId] = directions[index]
      const id = uniqueId(`direction-${directionId}`, current.frames.map((frame) => frame.id), current.revision)
      const copyFromFrameId = sourceFrames[index % sourceFrames.length]?.id ?? current.frames[0].id
      if (apply('frames.add', {
        frame: { id, name: label, durationMs: 140 },
        copyFromFrameId,
      })) changed += 1
    }
    setStatus(changed > 0
      ? `八方向槽已就绪：南、西南、西、西北、北、东北、东、东南 · ${changed} 项变更`
      : '当前前八帧已经是标准八方向槽')
  }, [apply])

  const createAnimationTag = useCallback(() => {
    const current = historyRef.current.document
    const id = uniqueId('animation', current.animationTags.map((tag) => tag.id), current.revision)
    const created = apply('animations.add', {
      tag: {
        id,
        name: `动画 ${current.animationTags.length + 1}`,
        fromFrameId: current.frames[0].id,
        toFrameId: current.frames.at(-1)?.id ?? current.frames[0].id,
        direction: 'forward',
        loop: true,
      },
    })
    if (created) {
      setActiveAnimationTagId(id)
      setStatus('已创建动画片段，可继续设定范围、方向与循环方式')
    }
  }, [apply])

  const patchActiveAnimationTag = useCallback((patch: Record<string, unknown>) => {
    const tagId = activeAnimationTag?.id
    if (!tagId) {
      setStatus('请先创建动画片段')
      return false
    }
    return apply('animations.patch', { tagId, patch })
  }, [activeAnimationTag?.id, apply])

  const removeActiveAnimationTag = useCallback(() => {
    const current = historyRef.current.document
    const tagId = activeAnimationTag?.id
    if (!tagId) return
    const fallback = current.animationTags.find((tag) => tag.id !== tagId)?.id ?? null
    if (apply('animations.remove', { tagId })) {
      setActiveAnimationTagId(fallback)
      setStatus('动画片段已删除；像素帧本身保持不变')
    }
  }, [activeAnimationTag?.id, apply])

  const applyAnimationDuration = useCallback(() => {
    if (!activeAnimationTag) {
      setStatus('请先创建动画片段，再批量设置时长')
      return
    }
    const durationMs = Number(batchDurationMs)
    if (!Number.isSafeInteger(durationMs) || durationMs < 20 || durationMs > 60_000) {
      setStatus('片段时长必须是 20—60000 ms 的整数')
      return
    }
    if (apply('frames.duration.set', {
      frames: animationRangeFrameIds.map((frameId) => ({ frameId, durationMs })),
    })) {
      setStatus(`已将「${activeAnimationTag.name}」的 ${animationRangeFrameIds.length} 帧统一设为 ${durationMs} ms · 可一次撤销`)
    }
  }, [activeAnimationTag, animationRangeFrameIds, apply, batchDurationMs])

  const copyActiveLayerAcrossAnimation = useCallback((mode: 'replace' | 'non-transparent') => {
    if (!activeAnimationTag) {
      setStatus('请先创建动画片段，再执行跨帧复制')
      return
    }
    const current = historyRef.current.document
    const targetFrameIds = animationRangeFrameIds.filter((frameId) => frameId !== current.activeFrameId)
    if (targetFrameIds.length === 0) {
      setStatus('当前动画片段没有可复制的目标帧')
      return
    }
    if (apply('cels.copy', {
      sourceFrameId: current.activeFrameId,
      targetFrameIds,
      layerIds: [current.activeLayerId],
      mode,
    })) {
      setStatus(`${mode === 'replace' ? '覆盖复制' : '透明合并'}完成：当前图层已同步到「${activeAnimationTag.name}」的 ${targetFrameIds.length} 个目标帧 · 可一次撤销`)
    }
  }, [activeAnimationTag, animationRangeFrameIds, apply])

  const exportPixelGameBundle = useCallback(async () => {
    setIsExporting(true)
    try {
      const current = historyRef.current.document
      const mapWidth = Math.max(1, Math.ceil(Math.sqrt(current.frames.length)))
      const mapHeight = Math.max(1, Math.ceil(current.frames.length / mapWidth))
      const bundle = createPixelGameExportBundle(current, {
        columns: Math.min(4, current.frames.length),
        padding: 1,
        spacing: 1,
        mapWidth,
        mapHeight,
        anchor: { x: Math.floor(current.width / 2), y: current.height },
        animationTagId: current.animationTags.some((tag) => tag.id === activeAnimationTagId)
          ? activeAnimationTagId ?? undefined
          : current.animationTags[0]?.id,
      })
      await downloadPixelGameExportBundle(bundle)
      setStatus('游戏资产包完成：项目、Sprite、八方向/锚点 manifest、Tiled Tileset/Tilemap 与离线预览页')
    } catch (error) {
      setStatus(readablePixelError(error, '游戏资产包导出失败'))
    } finally {
      setIsExporting(false)
    }
  }, [activeAnimationTagId])

  return (
    <section
      className={`aq-pixel-mode ${className}`.trim()}
      aria-label="光阴砚像素模式工作台"
      onKeyDown={(event) => {
        if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
        const key = event.key.toLowerCase()
        if (key === 'b') setTool('pencil')
        if (key === 'e') setTool('eraser')
        if (key === 'g') setTool('fill')
        if (key === 'i') setTool('picker')
        if (key === 'l') setTool('line')
        if (key === 'r') setTool('rectangle')
        if (key === 'm') setTool('marquee')
        if (key === 'escape') {
          setSelection(null)
          setDragDraft(null)
          dragContextRef.current = null
          setStatus('已取消区域选择')
        }
        if ((key === 'delete' || key === 'backspace') && selection) {
          event.preventDefault()
          applySelectionOperation('clear')
        }
        if (selection && ['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(key)) {
          event.preventDefault()
          const dx = key === 'arrowleft' ? -1 : key === 'arrowright' ? 1 : 0
          const dy = key === 'arrowup' ? -1 : key === 'arrowdown' ? 1 : 0
          applySelectionOperation(event.altKey ? 'copy' : 'move', { dx, dy })
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
          event.preventDefault()
          if (event.shiftKey) redo()
          else undo()
        }
      }}
    >
      <header className="aq-pixel-header">
        <div className="aq-pixel-brand">
          {onBack ? (
            <button type="button" className="aq-pixel-back" onClick={onBack} aria-label="返回光阴砚主页">
              <ArrowLeft size={17} />
            </button>
          ) : null}
          <span className="aq-pixel-brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <div>
            <span>AEONQUILL / PIXEL</span>
            <strong>像素模式</strong>
          </div>
        </div>
        <div className="aq-pixel-document-title">
          <span>{document.name}</span>
          <small>{document.width} × {document.height} · revision {document.revision}</small>
        </div>
        <div className="aq-pixel-history" aria-label="编辑历史">
          <button type="button" onClick={undo} disabled={history.undo.length === 0} aria-label="撤销">
            <Undo2 size={17} />
          </button>
          <button type="button" onClick={redo} disabled={history.redo.length === 0} aria-label="重做">
            <Redo2 size={17} />
          </button>
          <label className={`aq-pixel-file-action ${isImporting ? 'is-disabled' : ''}`}>
            <FolderOpen size={16} /> 打开项目
            <input
              type="file"
              accept=".aeonpixel.json,.pixel.json,application/json"
              disabled={isImporting}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0]
                event.currentTarget.value = ''
                if (file) void loadProject(file)
              }}
            />
          </label>
          <button type="button" className="aq-pixel-project-export" onClick={() => void exportPixelProject()} disabled={isExporting} aria-label="仅导出像素项目 JSON">
            <Download size={16} /> 项目
          </button>
          <button type="button" className="aq-pixel-export" onClick={() => void exportPixelBundle()} disabled={isExporting}>
            <Download size={16} /> 成套导出
          </button>
        </div>
      </header>

      <div className="aq-pixel-toolbar" aria-label="像素绘制工具">
        <div className="aq-pixel-tool-group">
          <button type="button" className={tool === 'pencil' ? 'is-active' : ''} onClick={() => setTool('pencil')}>
            <Pencil size={17} /> 铅笔 <kbd>B</kbd>
          </button>
          <button type="button" className={tool === 'eraser' ? 'is-active' : ''} onClick={() => setTool('eraser')}>
            <Eraser size={17} /> 橡皮 <kbd>E</kbd>
          </button>
          <button type="button" className={tool === 'fill' ? 'is-active' : ''} onClick={() => setTool('fill')}>
            <PaintBucket size={17} /> 填充 <kbd>G</kbd>
          </button>
          <button type="button" className={tool === 'picker' ? 'is-active' : ''} onClick={() => setTool('picker')}>
            <Pipette size={17} /> 吸管 <kbd>I</kbd>
          </button>
          <button type="button" className={tool === 'line' ? 'is-active' : ''} onClick={() => setTool('line')}>
            <Minus size={17} className="aq-pixel-line-icon" /> 直线 <kbd>L</kbd>
          </button>
          <button type="button" className={tool === 'rectangle' ? 'is-active' : ''} onClick={() => setTool('rectangle')}>
            <Square size={17} /> 矩形 <kbd>R</kbd>
          </button>
          <button type="button" className={tool === 'marquee' ? 'is-active' : ''} onClick={() => setTool('marquee')}>
            <SquareDashedMousePointer size={17} /> 选区 <kbd>M</kbd>
          </button>
        </div>
        <span className="aq-pixel-toolbar-divider" />
        <label className="aq-pixel-toggle">
          <input
            type="checkbox"
            checked={document.onionSkin.enabled}
            onChange={(event) => apply('onion-skin.set', { patch: { enabled: event.target.checked } })}
          />
          <span />
          洋葱皮
        </label>
        <button
          type="button"
          className={`aq-pixel-play ${isPlaying ? 'is-active' : ''}`}
          onClick={() => {
            if (isPlaying) stopPlayback()
            else {
              setPreviewFrameCursor(Math.max(0, playbackFrameIds.indexOf(document.activeFrameId)))
              setIsPlaying(true)
            }
          }}
          aria-pressed={isPlaying}
        >
          {isPlaying ? <Pause size={15} /> : <Play size={15} />}
          {isPlaying ? '停止预览' : '播放动画'}
        </button>
        <span className="aq-pixel-status" role="status">{status}</span>
      </div>

      <div className="aq-pixel-layout">
        <aside className="aq-pixel-panel aq-pixel-palette-panel">
          <section className="aq-pixel-import-card" aria-label="PNG 与 WebP 确定性像素转换">
            <div className="aq-pixel-import-heading">
              <span><Settings2 size={15} /> 图像转像素</span>
              <small>确定性</small>
            </div>
            <label className={`aq-pixel-source-picker ${isImporting ? 'is-disabled' : ''}`}>
              <FileImage size={16} />
              <span>{importSourceSummary ? '更换 PNG / WebP' : '选择 PNG / WebP'}</span>
              <input
                type="file"
                accept="image/png,image/webp,.png,.webp"
                disabled={isImporting}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0]
                  event.currentTarget.value = ''
                  if (file) void loadImageSource(file)
                }}
              />
            </label>
            {importSourceSummary ? (
              <p className="aq-pixel-source-summary">
                <strong title={importSourceSummary.name}>{importSourceSummary.name}</strong>
                <span>{importSourceSummary.width} × {importSourceSummary.height} RGBA · 仅保留会话内存</span>
              </p>
            ) : null}
            <div className="aq-pixel-import-grid">
              <label>
                <span>宽</span>
                <input
                  type="number"
                  min={1}
                  max={512}
                  value={importSettings.targetWidth}
                  onChange={(event) => setImportSettings((current) => ({
                    ...current,
                    targetWidth: Number.isFinite(event.target.valueAsNumber) ? event.target.valueAsNumber : current.targetWidth,
                  }))}
                />
              </label>
              <label>
                <span>高</span>
                <input
                  type="number"
                  min={1}
                  max={512}
                  value={importSettings.targetHeight}
                  onChange={(event) => setImportSettings((current) => ({
                    ...current,
                    targetHeight: Number.isFinite(event.target.valueAsNumber) ? event.target.valueAsNumber : current.targetHeight,
                  }))}
                />
              </label>
              <label>
                <span>色数</span>
                <input
                  type="number"
                  min={1}
                  max={256}
                  value={importSettings.colorCount}
                  disabled={importSettings.paletteMode === 'current'}
                  onChange={(event) => setImportSettings((current) => ({
                    ...current,
                    colorCount: Number.isFinite(event.target.valueAsNumber) ? event.target.valueAsNumber : current.colorCount,
                  }))}
                />
              </label>
              <label>
                <span>透明阈值</span>
                <input
                  type="number"
                  min={0}
                  max={255}
                  value={importSettings.alphaThreshold}
                  onChange={(event) => setImportSettings((current) => ({
                    ...current,
                    alphaThreshold: Number.isFinite(event.target.valueAsNumber) ? event.target.valueAsNumber : current.alphaThreshold,
                  }))}
                />
              </label>
            </div>
            <label className="aq-pixel-import-select">
              <span>缩放</span>
              <select
                value={importSettings.fit}
                onChange={(event) => setImportSettings((current) => ({ ...current, fit: event.target.value as PixelFitMode }))}
              >
                <option value="contain">完整留白</option>
                <option value="cover">居中裁满</option>
                <option value="stretch">拉伸铺满</option>
              </select>
            </label>
            <label className="aq-pixel-import-select">
              <span>调色板</span>
              <select
                value={importSettings.paletteMode}
                onChange={(event) => setImportSettings((current) => ({
                  ...current,
                  paletteMode: event.target.value as PixelImportSettings['paletteMode'],
                }))}
              >
                <option value="generated">从图像确定性提取</option>
                <option value="current">沿用当前 {document.palette.length} 色</option>
              </select>
            </label>
            <label className="aq-pixel-import-select">
              <span>抖动</span>
              <select
                value={importSettings.dither}
                onChange={(event) => setImportSettings((current) => ({ ...current, dither: event.target.value as PixelDitherMode }))}
              >
                <option value="none">无抖动</option>
                <option value="bayer4">Bayer 4×4</option>
                <option value="floyd-steinberg">Floyd–Steinberg</option>
              </select>
            </label>
            <button
              type="button"
              className="aq-pixel-convert"
              disabled={!importSourceSummary || isImporting}
              onClick={() => void convertImportedSource()}
            >
              {isImporting ? '处理中…' : '转换为严格 PixelDocument'}
            </button>
            {lastConversion ? (
              <p className="aq-pixel-conversion-report">
                {lastConversion.opaquePixels} 实像素 / {lastConversion.transparentPixels} 透明 · {lastConversion.paletteSize} 色
              </p>
            ) : null}
          </section>
          <div className="aq-pixel-panel-heading">
            <span><Grid3X3 size={15} /> 调色板</span>
            <small>{document.palette.length} 色</small>
          </div>
          <div className="aq-pixel-swatches" role="listbox" aria-label="像素调色板">
            {document.palette.map((color) => (
              <button
                type="button"
                role="option"
                aria-selected={color.id === activeColorId}
                className={color.id === activeColorId ? 'is-active' : ''}
                key={color.id}
                onClick={() => {
                  setActiveColorId(color.id)
                  setTool('pencil')
                }}
              >
                <span style={{ backgroundColor: color.color }} />
                <i>{color.name}</i>
              </button>
            ))}
          </div>
          <label className="aq-pixel-color-edit">
            <span>替换当前色</span>
            <input
              type="color"
              value={selectedColor.color.slice(0, 7)}
              onChange={(event) => apply('palette.replace', {
                colorId: selectedColor.id,
                color: `${event.target.value}FF`,
              })}
            />
            <code>{selectedColor.color}</code>
          </label>
          <div className="aq-pixel-contract-note">
            <strong>非破坏性入口</strong>
            <p>图层、帧和像素命令均返回逆命令；主线只需接管文档版本与资产落盘。</p>
          </div>
        </aside>

        <main className="aq-pixel-stage-column">
          <div className="aq-pixel-stage-wrap">
            <div className="aq-pixel-stage-controls" aria-label="笔刷与画布控制">
              <label className="aq-pixel-brush-size">
                <span>画笔</span>
                <select value={brushSize} onChange={(event) => setBrushSize(Number(event.target.value))}>
                  {[1, 2, 3, 4, 6, 8].map((size) => <option key={size} value={size}>{size}px</option>)}
                </select>
              </label>
              <span className="aq-pixel-control-divider" />
              <button
                type="button"
                className={mirrorHorizontal ? 'is-active' : ''}
                aria-pressed={mirrorHorizontal}
                onClick={() => setMirrorHorizontal((value) => !value)}
                title="水平对称绘制"
              ><FlipHorizontal2 size={15} /><span>水平对称</span></button>
              <button
                type="button"
                className={mirrorVertical ? 'is-active' : ''}
                aria-pressed={mirrorVertical}
                onClick={() => setMirrorVertical((value) => !value)}
                title="垂直对称绘制"
              ><FlipVertical2 size={15} /><span>垂直对称</span></button>
              <span className="aq-pixel-control-divider" />
              <button
                type="button"
                className={gridVisible ? 'is-active' : ''}
                aria-pressed={gridVisible}
                onClick={() => setGridVisible((value) => !value)}
                title="显示像素网格"
              ><Grid3X3 size={15} /><span>网格</span></button>
              <span className="aq-pixel-control-divider" />
              <button type="button" onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))} aria-label="缩小画布">
                <ZoomOut size={15} />
              </button>
              <output>{Math.round(zoom * 100)}%</output>
              <button type="button" onClick={() => setZoom((value) => Math.min(2, value + 0.25))} aria-label="放大画布">
                <ZoomIn size={15} />
              </button>
            </div>
            <div
              className="aq-pixel-stage"
              style={{
                '--aq-pixel-columns': document.width,
                '--aq-pixel-rows': document.height,
                aspectRatio: `${document.width} / ${document.height}`,
                width: `min(${Math.round(62 * zoom)}vh, ${Math.round(620 * zoom)}px)`,
              } as CSSProperties}
            >
              <canvas
                ref={canvasRef}
                tabIndex={0}
                aria-label={`${document.width} 乘 ${document.height} 像素绘制区，当前图层 ${selectedLayer.name}`}
                onPointerDown={(event) => {
                  event.preventDefault()
                  event.currentTarget.focus()
                  beginCanvasGesture(event)
                }}
                onPointerMove={updateCanvasGesture}
                onPointerUp={(event) => {
                  updateCanvasGesture(event)
                  finishCanvasGesture()
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
                }}
                onPointerCancel={finishCanvasGesture}
              />
              {gridVisible ? <span className="aq-pixel-grid-overlay" aria-hidden="true" /> : null}
              {selectionPreview ? (
                <span
                  className={`aq-pixel-marquee ${dragDraft && dragDraft.tool !== 'marquee' ? 'is-shape-preview' : ''}`.trim()}
                  aria-hidden="true"
                  style={{
                    left: `${(selectionPreview.x / document.width) * 100}%`,
                    top: `${(selectionPreview.y / document.height) * 100}%`,
                    width: `${(selectionPreview.width / document.width) * 100}%`,
                    height: `${(selectionPreview.height / document.height) * 100}%`,
                  }}
                />
              ) : null}
            </div>
            {selection ? (
              <div className="aq-pixel-selection-actions" aria-label="区域变换">
                <span><Move size={14} /> {selection.width}×{selection.height}</span>
                <button type="button" title="向左移动一像素" onClick={() => applySelectionOperation('move', { dx: -1 })}><ArrowLeftSmall size={14} /></button>
                <button type="button" title="向上移动一像素" onClick={() => applySelectionOperation('move', { dy: -1 })}><ArrowUp size={14} /></button>
                <button type="button" title="向下移动一像素" onClick={() => applySelectionOperation('move', { dy: 1 })}><ArrowDown size={14} /></button>
                <button type="button" title="向右移动一像素" onClick={() => applySelectionOperation('move', { dx: 1 })}><ArrowRight size={14} /></button>
                <span className="aq-pixel-control-divider" />
                <button type="button" title="复制并向右移动一像素" onClick={() => applySelectionOperation('copy', { dx: 1 })}><Copy size={14} /></button>
                <button type="button" title="水平翻转" onClick={() => applySelectionOperation('flip-horizontal')}><FlipHorizontal2 size={14} /></button>
                <button type="button" title="垂直翻转" onClick={() => applySelectionOperation('flip-vertical')}><FlipVertical2 size={14} /></button>
                <button type="button" className="is-danger" title="清除选区" onClick={() => applySelectionOperation('clear')}><Trash2 size={14} /></button>
              </div>
            ) : null}
          </div>

          <section className="aq-pixel-timeline" aria-label="动画帧">
            <div className="aq-pixel-panel-heading">
              <span><Film size={15} /> 帧时间线</span>
              <div>
                <label className="aq-pixel-duration" title="当前帧时长">
                  <input
                    key={`${document.activeFrameId}-${document.frames.find((frame) => frame.id === document.activeFrameId)?.durationMs}`}
                    type="number"
                    min={20}
                    max={60_000}
                    defaultValue={document.frames.find((frame) => frame.id === document.activeFrameId)?.durationMs}
                    onBlur={(event) => {
                      const durationMs = event.currentTarget.valueAsNumber
                      const currentDuration = document.frames.find((frame) => frame.id === document.activeFrameId)?.durationMs
                      if (Number.isSafeInteger(durationMs) && durationMs >= 20 && durationMs <= 60_000 && durationMs !== currentDuration) {
                        stopPlayback()
                        apply('frames.patch', { frameId: document.activeFrameId, patch: { durationMs } })
                      }
                    }}
                  />
                  ms
                </label>
                <button
                  type="button"
                  aria-label="复制当前帧"
                  onClick={() => {
                    stopPlayback()
                    const id = uniqueId('frame', document.frames.map((frame) => frame.id), document.revision)
                    apply('frames.add', {
                      frame: { id, name: `姿态 ${document.frames.length + 1}`, durationMs: 140 },
                      copyFromFrameId: document.activeFrameId,
                    })
                  }}
                ><Copy size={14} /></button>
                <button
                  type="button"
                  aria-label="添加空白帧"
                  onClick={() => {
                    stopPlayback()
                    const id = uniqueId('frame', document.frames.map((frame) => frame.id), document.revision)
                    apply('frames.add', { frame: { id, name: `姿态 ${document.frames.length + 1}`, durationMs: 140 } })
                  }}
                ><Plus size={14} /></button>
                <button
                  type="button"
                  aria-label="删除当前帧"
                  disabled={document.frames.length === 1}
                  onClick={() => {
                    stopPlayback()
                    apply('frames.remove', { frameId: document.activeFrameId })
                  }}
                ><Trash2 size={14} /></button>
              </div>
            </div>
            <div className="aq-pixel-frame-strip">
              {document.frames.map((frame, index) => (
                <button
                  type="button"
                  key={frame.id}
                  className={`${frame.id === document.activeFrameId ? 'is-active' : ''} ${isPlaying && frame.id === displayedFrameId ? 'is-previewing' : ''} ${activeAnimationTag && animationRangeFrameIds.includes(frame.id) ? 'is-in-animation' : ''}`.trim()}
                  aria-pressed={frame.id === document.activeFrameId}
                  onClick={() => {
                    stopPlayback()
                    apply('frames.select', { frameId: frame.id })
                  }}
                >
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <strong>{frame.name}</strong>
                  <small>{frame.durationMs} ms</small>
                </button>
              ))}
            </div>
            <div className="aq-pixel-animation-workbench" aria-label="动画片段">
              <div className="aq-pixel-animation-tags">
                <span>片段</span>
                <div>
                  {document.animationTags.map((tag) => (
                    <button
                      type="button"
                      key={tag.id}
                      className={tag.id === activeAnimationTag?.id ? 'is-active' : ''}
                      aria-pressed={tag.id === activeAnimationTag?.id}
                      aria-label={`选择动画片段 ${tag.name}`}
                      onClick={() => {
                        stopPlayback()
                        setActiveAnimationTagId(tag.id)
                        const firstFrameId = resolvePixelAnimationFrames(document, tag.id)[0]
                        const firstFrame = document.frames.find((frame) => frame.id === firstFrameId)
                        if (firstFrame) setBatchDurationMs(String(firstFrame.durationMs))
                        setStatus(`已选择动画片段：${tag.name}`)
                      }}
                    >{tag.name}</button>
                  ))}
                  <button type="button" className="is-add" onClick={createAnimationTag} aria-label="新建动画片段">
                    <Plus size={12} /> 新建
                  </button>
                </div>
              </div>
              {activeAnimationTag ? (
                <div className="aq-pixel-animation-editor">
                  <label className="is-name">
                    <span>片段名称</span>
                    <input
                      key={`${activeAnimationTag.id}-${activeAnimationTag.name}`}
                      type="text"
                      defaultValue={activeAnimationTag.name}
                      maxLength={80}
                      onBlur={(event) => {
                        const name = event.currentTarget.value.trim()
                        if (!name) {
                          event.currentTarget.value = activeAnimationTag.name
                          setStatus('片段名称不能为空')
                        } else if (name !== activeAnimationTag.name) {
                          patchActiveAnimationTag({ name })
                        }
                      }}
                    />
                  </label>
                  <label>
                    <span>起始帧</span>
                    <select
                      value={activeAnimationTag.fromFrameId}
                      onChange={(event) => patchActiveAnimationTag({ fromFrameId: event.currentTarget.value })}
                    >
                      {document.frames.map((frame, index) => (
                        <option
                          key={frame.id}
                          value={frame.id}
                          disabled={index > document.frames.findIndex((item) => item.id === activeAnimationTag.toFrameId)}
                        >{String(index + 1).padStart(2, '0')} · {frame.name}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>结束帧</span>
                    <select
                      value={activeAnimationTag.toFrameId}
                      onChange={(event) => patchActiveAnimationTag({ toFrameId: event.currentTarget.value })}
                    >
                      {document.frames.map((frame, index) => (
                        <option
                          key={frame.id}
                          value={frame.id}
                          disabled={index < document.frames.findIndex((item) => item.id === activeAnimationTag.fromFrameId)}
                        >{String(index + 1).padStart(2, '0')} · {frame.name}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>播放方向</span>
                    <select
                      value={activeAnimationTag.direction}
                      onChange={(event) => patchActiveAnimationTag({ direction: event.currentTarget.value as PixelAnimationDirection })}
                    >
                      <option value="forward">正向</option>
                      <option value="reverse">反向</option>
                      <option value="ping-pong">往返</option>
                    </select>
                  </label>
                  <label className="is-loop">
                    <span>循环播放</span>
                    <input
                      type="checkbox"
                      checked={activeAnimationTag.loop}
                      onChange={(event) => patchActiveAnimationTag({ loop: event.currentTarget.checked })}
                    />
                  </label>
                  <label className="is-duration">
                    <span>片段统一时长</span>
                    <span className="aq-pixel-animation-number">
                      <input
                        type="number"
                        min={20}
                        max={60_000}
                        value={batchDurationMs}
                        onChange={(event) => setBatchDurationMs(event.currentTarget.value)}
                      />
                      ms
                    </span>
                  </label>
                  <div className="aq-pixel-animation-actions">
                    <button type="button" onClick={applyAnimationDuration}>应用片段时长</button>
                    <button type="button" onClick={() => copyActiveLayerAcrossAnimation('replace')}>覆盖复制当前图层</button>
                    <button type="button" onClick={() => copyActiveLayerAcrossAnimation('non-transparent')}>透明合并当前图层</button>
                    <button type="button" className="is-danger" onClick={removeActiveAnimationTag} aria-label="删除当前动画片段">
                      <Trash2 size={12} /> 删除片段
                    </button>
                  </div>
                  <small className="aq-pixel-animation-summary">
                    {animationRangeFrameIds.length} 个基础帧 · 播放序列 {playbackFrameIds.length} 帧 · 当前源图层「{selectedLayer.name}」
                  </small>
                </div>
              ) : (
                <p className="aq-pixel-animation-empty">建立片段后，可以限定帧范围、往返播放、批量时长与跨帧图层复制。</p>
              )}
            </div>
          </section>
        </main>

        <aside className="aq-pixel-panel aq-pixel-layers-panel">
          <div className="aq-pixel-panel-heading">
            <span><Layers size={15} /> 图层</span>
            <div>
              <button
                type="button"
                aria-label="添加图层"
                onClick={() => {
                  const id = uniqueId('layer', document.layers.map((layer) => layer.id), document.revision)
                  apply('layers.add', {
                    layer: { id, name: `图层 ${document.layers.length + 1}`, visible: true, locked: false, opacity: 1 },
                  })
                }}
              ><Plus size={14} /></button>
              <button
                type="button"
                aria-label="删除当前图层"
                disabled={document.layers.length === 1}
                onClick={() => apply('layers.remove', { layerId: document.activeLayerId })}
              ><Trash2 size={14} /></button>
            </div>
          </div>
          <div className="aq-pixel-layer-list">
            {[...document.layers].reverse().map((layer) => (
              <div className={layer.id === document.activeLayerId ? 'is-active' : ''} key={layer.id}>
                <button
                  type="button"
                  className="aq-pixel-layer-main"
                  aria-pressed={layer.id === document.activeLayerId}
                  onClick={() => apply('layers.select', { layerId: layer.id })}
                >
                  <span className="aq-pixel-layer-thumb"><Grid3X3 size={14} /></span>
                  <span><strong>{layer.name}</strong><small>{Math.round(layer.opacity * 100)}%</small></span>
                </button>
                <button
                  type="button"
                  aria-label={layer.visible ? `隐藏 ${layer.name}` : `显示 ${layer.name}`}
                  onClick={() => apply('layers.patch', { layerId: layer.id, patch: { visible: !layer.visible } })}
                >{layer.visible ? <Eye size={14} /> : <EyeOff size={14} />}</button>
                <button
                  type="button"
                  aria-label={layer.locked ? `解锁 ${layer.name}` : `锁定 ${layer.name}`}
                  onClick={() => apply('layers.patch', { layerId: layer.id, patch: { locked: !layer.locked } })}
                >{layer.locked ? <Lock size={14} /> : <Unlock size={14} />}</button>
              </div>
            ))}
          </div>
          <div className="aq-pixel-layer-editor" aria-label="当前图层属性">
            <label>
              <span>图层名称</span>
              <input
                key={`${selectedLayer.id}-${selectedLayer.name}`}
                defaultValue={selectedLayer.name}
                maxLength={80}
                onBlur={(event) => {
                  const name = event.currentTarget.value.trim()
                  if (name && name !== selectedLayer.name) apply('layers.patch', { layerId: selectedLayer.id, patch: { name } })
                  else event.currentTarget.value = selectedLayer.name
                }}
              />
            </label>
            <label>
              <span>不透明度 <strong>{Math.round(selectedLayer.opacity * 100)}%</strong></span>
              <input
                key={`${selectedLayer.id}-${selectedLayer.opacity}`}
                type="range"
                min={0}
                max={100}
                step={1}
                defaultValue={Math.round(selectedLayer.opacity * 100)}
                onBlur={(event) => {
                  const opacity = event.currentTarget.valueAsNumber / 100
                  if (Number.isFinite(opacity) && opacity !== selectedLayer.opacity) {
                    apply('layers.patch', { layerId: selectedLayer.id, patch: { opacity } })
                  }
                }}
              />
            </label>
            <div>
              <button
                type="button"
                disabled={document.layers.findIndex((layer) => layer.id === selectedLayer.id) === document.layers.length - 1}
                onClick={() => {
                  const ids = document.layers.map((layer) => layer.id)
                  const index = ids.indexOf(selectedLayer.id)
                  if (index < 0 || index >= ids.length - 1) return
                  ;[ids[index], ids[index + 1]] = [ids[index + 1], ids[index]]
                  apply('layers.reorder', { layerIds: ids })
                }}
              ><ArrowUp size={14} /> 上移</button>
              <button
                type="button"
                disabled={document.layers.findIndex((layer) => layer.id === selectedLayer.id) <= 0}
                onClick={() => {
                  const ids = document.layers.map((layer) => layer.id)
                  const index = ids.indexOf(selectedLayer.id)
                  if (index <= 0) return
                  ;[ids[index], ids[index - 1]] = [ids[index - 1], ids[index]]
                  apply('layers.reorder', { layerIds: ids })
                }}
              ><ArrowDown size={14} /> 下移</button>
            </div>
          </div>
          <div className="aq-pixel-sprite-summary">
            <span>Sprite Sheet</span>
            <strong>{spriteMetadata.width} × {spriteMetadata.height}</strong>
            <p>{spriteMetadata.columns} 列 · {spriteMetadata.rows} 行 · {spriteMetadata.frames.length} 帧</p>
            <div className="aq-pixel-game-actions" aria-label="像素游戏资产工具">
              <button type="button" onClick={cleanupActivePixelLayer}>
                <Sparkles size={14} /> 本地智能清理
              </button>
              <button type="button" onClick={ensureEightDirectionSlots}>
                <Compass size={14} /> 补齐八方向
              </button>
              <button type="button" onClick={() => void exportPixelGameBundle()} disabled={isExporting}>
                <PackageOpen size={14} /> 游戏资产包
              </button>
            </div>
          </div>
        </aside>
      </div>
    </section>
  )
}

export const pixelModeModule = {
  id: 'pixel' as const,
  title: '像素模式',
  summary: '确定性的图层、帧、调色板与 Sprite 工作流。',
  maturity: 'preview' as const,
  runtimeRequirements: [] as string[],
  createDefaultProject: createDefaultPixelProject,
  View: PixelModeWorkbench,
}
