import {
  ArrowLeft,
  Copy,
  Download,
  Eraser,
  Eye,
  EyeOff,
  Film,
  Grid3X3,
  Layers,
  Lock,
  Pencil,
  Plus,
  Redo2,
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
  applyPixelCommand,
  createBlankPixelArray,
  createPixelCommand,
  createPixelDocument,
  createSpriteSheetMetadata,
  migratePixelDocument,
  renderPixelFrameRgba,
  renderSpriteSheetRgba,
  type PixelCommand,
  type PixelCommandType,
  type PixelDocument,
  type SpriteSheetMetadata,
} from '../../lib/pixel/index'
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
  onSpriteSheetReady?: (payload: PixelSpriteSheetPayload) => void
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
  const [strokePreviewRevision, setStrokePreviewRevision] = useState(0)
  const canvasRef = useRef<HTMLCanvasElement>(null)
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

  const apply = useCallback((type: PixelCommandType, payload: Record<string, unknown>) => {
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
  }, [replaceHistory])

  const undo = useCallback(() => {
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
  }, [replaceHistory])

  const redo = useCallback(() => {
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
  }, [replaceHistory])

  useEffect(() => {
    onDocumentChange?.(document)
  }, [document, onDocumentChange])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.width = document.width
    canvas.height = document.height
    const context = canvas.getContext('2d')
    if (!context) return
    context.clearRect(0, 0, document.width, document.height)
    context.imageSmoothingEnabled = false

    const activeIndex = document.frames.findIndex((frame) => frame.id === document.activeFrameId)
    if (document.onionSkin.enabled) {
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
      renderPixelFrameRgba(document, document.activeFrameId),
      document.width,
      document.height,
    )
  }, [document, strokePreviewRevision])

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
  }, [activeColorId, stagePixelAtPointer, tool])

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

  const exportSpriteSheet = () => {
    const output = renderSpriteSheetRgba(document, {
      columns: Math.min(4, document.frames.length),
      padding: 1,
      spacing: 1,
    })
    onSpriteSheetReady?.({ document, metadata: output.metadata, pixels: output.pixels })
    setStatus(onSpriteSheetReady ? 'Sprite Sheet 已交给宿主导出层' : 'Sprite Sheet RGBA 与元数据已在内存中生成')
  }

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
          <button type="button" className="aq-pixel-export" onClick={exportSpriteSheet}>
            <Download size={16} /> 导出契约
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
        <span className="aq-pixel-status" role="status">{status}</span>
      </div>

      <div className="aq-pixel-layout">
        <aside className="aq-pixel-panel aq-pixel-palette-panel">
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
                <button
                  type="button"
                  aria-label="复制当前帧"
                  onClick={() => {
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
                    const id = uniqueId('frame', document.frames.map((frame) => frame.id), document.revision)
                    apply('frames.add', { frame: { id, name: `姿态 ${document.frames.length + 1}`, durationMs: 140 } })
                  }}
                ><Plus size={14} /></button>
                <button
                  type="button"
                  aria-label="删除当前帧"
                  disabled={document.frames.length === 1}
                  onClick={() => apply('frames.remove', { frameId: document.activeFrameId })}
                ><Trash2 size={14} /></button>
              </div>
            </div>
            <div className="aq-pixel-frame-strip">
              {document.frames.map((frame, index) => (
                <button
                  type="button"
                  key={frame.id}
                  className={frame.id === document.activeFrameId ? 'is-active' : ''}
                  aria-pressed={frame.id === document.activeFrameId}
                  onClick={() => apply('frames.select', { frameId: frame.id })}
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
