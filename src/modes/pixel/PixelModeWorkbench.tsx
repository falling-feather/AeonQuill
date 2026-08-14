import {
  ArrowLeft,
  Copy,
  Download,
  Eraser,
  Eye,
  EyeOff,
  FileImage,
  Film,
  FolderOpen,
  Grid3X3,
  Layers,
  Lock,
  Pause,
  Pencil,
  Play,
  Plus,
  Redo2,
  Settings2,
  Trash2,
  Undo2,
  Unlock,
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
  createPixelCommand,
  createPixelDocument,
  createSpriteSheetMetadata,
  migratePixelDocument,
  renderPixelFrameRgba,
  safePixelFilename,
  serializePixelProject,
  type PixelCommand,
  type PixelCommandType,
  type PixelConversionReport,
  type PixelDitherMode,
  type PixelDocument,
  type PixelFitMode,
  type RgbaImage,
  type SpriteSheetMetadata,
} from '../../lib/pixel/index'
import {
  PixelBrowserError,
  decodePixelImageFile,
  downloadPixelExportBundle,
  downloadPixelText,
  readPixelProjectFile,
} from './pixelBrowser'
import './pixel-mode.css'

type PixelTool = 'pencil' | 'eraser'

type HistoryState = {
  document: PixelDocument
  undo: PixelCommand[]
  redo: PixelCommand[]
}

type PixelStrokeContext = {
  baseRevision: number
  frameId: string
  layerId: string
  tool: PixelTool
  colorId: string
  previewColor: string
  layerOpacity: number
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
  className?: string
  onBack?: () => void
  onDocumentChange?: (document: PixelDocument) => void
  onSpriteSheetReady?: (payload: PixelSpriteSheetPayload) => void | Promise<void>
}

function makeStarterDocument() {
  const base = createPixelDocument({
    id: 'aeonquill-pixel-starter',
    name: '光羽练习',
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
  className = '',
  onBack,
  onDocumentChange,
  onSpriteSheetReady,
}: PixelModeWorkbenchProps) {
  const [history, setHistory] = useState<HistoryState>(() => ({
    document: initialDocument ? migratePixelDocument(initialDocument) : makeStarterDocument(),
    undo: [],
    redo: [],
  }))
  const [tool, setTool] = useState<PixelTool>('pencil')
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
  const [previewFrameId, setPreviewFrameId] = useState<string | null>(null)
  const [strokePreviewRevision, setStrokePreviewRevision] = useState(0)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const importedSourceRef = useRef<ImportedSource | null>(null)
  const paintingRef = useRef(false)
  const strokeContextRef = useRef<PixelStrokeContext | null>(null)
  const strokePointsRef = useRef(new Map<string, { x: number; y: number }>())
  const commandSequenceRef = useRef(1)
  const document = history.document
  const historyRef = useRef(history)
  historyRef.current = history

  const replaceHistory = useCallback((next: HistoryState) => {
    historyRef.current = next
    setHistory(next)
  }, [])

  const stopPlayback = useCallback(() => {
    setIsPlaying(false)
    setPreviewFrameId(null)
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

  useEffect(() => {
    if (!isPlaying) return undefined
    const currentId = previewFrameId && document.frames.some((frame) => frame.id === previewFrameId)
      ? previewFrameId
      : document.activeFrameId
    if (previewFrameId !== currentId) {
      setPreviewFrameId(currentId)
      return undefined
    }
    const currentIndex = document.frames.findIndex((frame) => frame.id === currentId)
    const currentFrame = document.frames[currentIndex]
    if (!currentFrame) return undefined
    const timer = window.setTimeout(() => {
      const nextFrame = document.frames[(currentIndex + 1) % document.frames.length]
      setPreviewFrameId(nextFrame.id)
    }, currentFrame.durationMs)
    return () => window.clearTimeout(timer)
  }, [document.activeFrameId, document.frames, isPlaying, previewFrameId])

  const displayedFrameId = isPlaying && previewFrameId && document.frames.some((frame) => frame.id === previewFrameId)
    ? previewFrameId
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

  const stagePixelAtPointer = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const stroke = strokeContextRef.current
    if (!stroke) return
    const canvas = event.currentTarget
    const bounds = canvas.getBoundingClientRect()
    if (bounds.width <= 0 || bounds.height <= 0) return
    const x = Math.max(0, Math.min(canvas.width - 1, Math.floor(((event.clientX - bounds.left) / bounds.width) * canvas.width)))
    const y = Math.max(0, Math.min(canvas.height - 1, Math.floor(((event.clientY - bounds.top) / bounds.height) * canvas.height)))
    const pixelKey = `${x}:${y}`
    if (strokePointsRef.current.has(pixelKey)) return
    strokePointsRef.current.set(pixelKey, { x, y })
    const context = canvas.getContext('2d')
    if (!context) return
    context.save()
    if (stroke.tool === 'pencil') {
      context.globalAlpha = stroke.layerOpacity
      context.fillStyle = stroke.previewColor
      context.fillRect(x, y, 1, 1)
    } else {
      context.clearRect(x, y, 1, 1)
    }
    context.restore()
  }, [])

  const beginStroke = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    stopPlayback()
    const current = historyRef.current.document
    const activeLayer = current.layers.find((layer) => layer.id === current.activeLayerId)
    if (!activeLayer || activeLayer.locked) {
      setStatus(activeLayer ? `图层 ${activeLayer.name} 已锁定` : '当前图层不存在')
      return
    }
    strokeContextRef.current = {
      baseRevision: current.revision,
      frameId: current.activeFrameId,
      layerId: current.activeLayerId,
      tool,
      colorId: activeColorId,
      previewColor: current.palette.find((color) => color.id === activeColorId)?.color ?? '#000000FF',
      layerOpacity: activeLayer.opacity,
    }
    strokePointsRef.current.clear()
    paintingRef.current = true
    event.currentTarget.setPointerCapture(event.pointerId)
    stagePixelAtPointer(event)
  }, [activeColorId, stagePixelAtPointer, stopPlayback, tool])

  const finishStroke = useCallback(() => {
    const stroke = strokeContextRef.current
    const points = [...strokePointsRef.current.values()]
    paintingRef.current = false
    strokeContextRef.current = null
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

  const selectedLayer = document.layers.find((layer) => layer.id === document.activeLayerId) ?? document.layers[0]
  const selectedColor = document.palette.find((color) => color.id === activeColorId) ?? document.palette[0]
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

  return (
    <section
      className={`aq-pixel-mode ${className}`.trim()}
      aria-label="光阴砚像素模式工作台"
      onKeyDown={(event) => {
        if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
        if (event.key.toLowerCase() === 'b') setTool('pencil')
        if (event.key.toLowerCase() === 'e') setTool('eraser')
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
              setPreviewFrameId(document.activeFrameId)
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
            <div
              className="aq-pixel-stage"
              style={{
                '--aq-pixel-columns': document.width,
                '--aq-pixel-rows': document.height,
                aspectRatio: `${document.width} / ${document.height}`,
              } as CSSProperties}
            >
              <canvas
                ref={canvasRef}
                aria-label={`${document.width} 乘 ${document.height} 像素绘制区，当前图层 ${selectedLayer.name}`}
                onPointerDown={(event) => {
                  event.preventDefault()
                  beginStroke(event)
                }}
                onPointerMove={(event) => {
                  if (paintingRef.current) stagePixelAtPointer(event)
                }}
                onPointerUp={(event) => {
                  if (paintingRef.current) stagePixelAtPointer(event)
                  finishStroke()
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
                }}
                onPointerCancel={finishStroke}
              />
              <span className="aq-pixel-grid-overlay" aria-hidden="true" />
            </div>
          </div>

          <section className="aq-pixel-timeline" aria-label="动画帧">
            <div className="aq-pixel-panel-heading">
              <span><Film size={15} /> 帧时间线</span>
              <div>
                <label className="aq-pixel-duration" title="当前帧时长">
                  <input
                    key={`${document.activeFrameId}-${document.frames.find((frame) => frame.id === document.activeFrameId)?.durationMs}`}
                    type="number"
                    min={16}
                    max={60_000}
                    defaultValue={document.frames.find((frame) => frame.id === document.activeFrameId)?.durationMs}
                    onBlur={(event) => {
                      const durationMs = event.currentTarget.valueAsNumber
                      const currentDuration = document.frames.find((frame) => frame.id === document.activeFrameId)?.durationMs
                      if (Number.isSafeInteger(durationMs) && durationMs >= 16 && durationMs <= 60_000 && durationMs !== currentDuration) {
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
                  className={`${frame.id === document.activeFrameId ? 'is-active' : ''} ${isPlaying && frame.id === displayedFrameId ? 'is-previewing' : ''}`.trim()}
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
          <div className="aq-pixel-sprite-summary">
            <span>Sprite Sheet</span>
            <strong>{spriteMetadata.width} × {spriteMetadata.height}</strong>
            <p>{spriteMetadata.columns} 列 · {spriteMetadata.rows} 行 · {spriteMetadata.frames.length} 帧</p>
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
  createDefaultProject: makeStarterDocument,
  View: PixelModeWorkbench,
}
