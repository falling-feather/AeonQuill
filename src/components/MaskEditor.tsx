import { Eraser, Paintbrush, RotateCcw, Undo2 } from 'lucide-react'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { createEmptyMaskRecipe, createMaskPreview } from '../lib/imageProcessing'
import type { MaskBrushMode, MaskDraft, MaskPoint, MaskRecipe, MaskStroke } from '../types'

type MaskEditorProps = {
  source: string
  label: string
  disabled?: boolean
  onChange: (draft: MaskDraft | null) => void
}

type SurfaceSize = {
  width: number
  height: number
}

const MAX_STROKES = 512
const MAX_POINTS = 20_000
const MAX_POINTS_PER_STROKE = 2_048
const MIN_POINT_DISTANCE = 0.002
const EDITOR_HORIZONTAL_PADDING = 24
const EDITOR_VERTICAL_CHROME = 86

function makeStrokeId() {
  return `mask-${crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`
}

function pointFromPointer(event: React.PointerEvent<HTMLCanvasElement>): MaskPoint {
  const bounds = event.currentTarget.getBoundingClientRect()
  return {
    x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
    y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)),
  }
}

function drawLiveStroke(canvas: HTMLCanvasElement, stroke: MaskStroke) {
  const context = canvas.getContext('2d')
  if (!context) return
  context.clearRect(0, 0, canvas.width, canvas.height)
  if (!stroke.points.length) return

  const minimumDimension = Math.min(canvas.width, canvas.height)
  context.strokeStyle = stroke.mode === 'remove'
    ? 'rgba(255,73,99,.76)'
    : 'rgba(76,209,153,.8)'
  context.fillStyle = context.strokeStyle
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.lineWidth = Math.max(1, stroke.size * minimumDimension)
  context.beginPath()
  stroke.points.forEach((point, index) => {
    const x = point.x * canvas.width
    const y = point.y * canvas.height
    if (index === 0) context.moveTo(x, y)
    else context.lineTo(x, y)
  })
  context.stroke()

  if (stroke.points.length === 1) {
    const [point] = stroke.points
    context.beginPath()
    context.arc(
      point.x * canvas.width,
      point.y * canvas.height,
      context.lineWidth / 2,
      0,
      Math.PI * 2,
    )
    context.fill()
  }
}

export const MaskEditor = memo(function MaskEditor({
  source,
  label,
  disabled = false,
  onChange,
}: MaskEditorProps) {
  const [recipe, setRecipe] = useState<MaskRecipe>(() => createEmptyMaskRecipe())
  const [preview, setPreview] = useState<MaskDraft | null>(null)
  const [surfaceSize, setSurfaceSize] = useState<SurfaceSize>({ width: 1, height: 1 })
  const [brushMode, setBrushMode] = useState<MaskBrushMode>('remove')
  const [brushSize, setBrushSize] = useState(8)
  const [hardness, setHardness] = useState(82)
  const [rendering, setRendering] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const editorRef = useRef<HTMLDivElement | null>(null)
  const overlayRef = useRef<HTMLCanvasElement | null>(null)
  const cursorRef = useRef<HTMLSpanElement | null>(null)
  const activeStrokeRef = useRef<MaskStroke | null>(null)
  const renderSequenceRef = useRef(0)

  useEffect(() => {
    const sequence = ++renderSequenceRef.current
    setRendering(true)
    setError(null)
    void createMaskPreview(source, recipe)
      .then((next) => {
        if (sequence !== renderSequenceRef.current) return
        setPreview(next)
        onChange(next)
      })
      .catch((reason) => {
        if (sequence !== renderSequenceRef.current) return
        const message = reason instanceof Error ? reason.message : '蒙版预览生成失败'
        setError(message)
        onChange(null)
      })
      .finally(() => {
        if (sequence === renderSequenceRef.current) setRendering(false)
      })
  }, [onChange, recipe, source])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !preview) return

    const updateSurfaceSize = () => {
      const availableWidth = Math.max(1, editor.clientWidth - EDITOR_HORIZONTAL_PADDING)
      const availableHeight = Math.max(1, editor.clientHeight - EDITOR_VERTICAL_CHROME)
      const ratio = preview.width / preview.height
      const nextSize = availableWidth / availableHeight > ratio
        ? { width: Math.round(availableHeight * ratio), height: availableHeight }
        : { width: availableWidth, height: Math.round(availableWidth / ratio) }
      setSurfaceSize((current) => (
        current.width === nextSize.width && current.height === nextSize.height
          ? current
          : nextSize
      ))
    }

    updateSurfaceSize()
    const observer = new ResizeObserver(updateSurfaceSize)
    observer.observe(editor)
    return () => observer.disconnect()
  }, [preview?.height, preview?.width])

  const updateCursor = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const cursor = cursorRef.current
    if (!cursor) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const diameter = Math.max(6, brushSize / 100 * Math.min(bounds.width, bounds.height))
    cursor.style.width = `${diameter}px`
    cursor.style.height = `${diameter}px`
    cursor.style.left = `${event.clientX - bounds.left}px`
    cursor.style.top = `${event.clientY - bounds.top}px`
    cursor.style.opacity = '1'
    cursor.dataset.mode = brushMode
  }, [brushMode, brushSize])

  const commitActiveStroke = useCallback((canvas: HTMLCanvasElement) => {
    const stroke = activeStrokeRef.current
    activeStrokeRef.current = null
    canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
    if (!stroke?.points.length) return

    setRecipe((current) => {
      const currentPointCount = current.strokes.reduce(
        (total, item) => total + item.points.length,
        0,
      )
      if (current.strokes.length >= MAX_STROKES || currentPointCount >= MAX_POINTS) {
        setError('蒙版笔画已达到安全上限；请应用当前结果后继续编辑')
        return current
      }
      const availablePoints = MAX_POINTS - currentPointCount
      return {
        schemaVersion: 1,
        strokes: [
          ...current.strokes,
          {
            ...stroke,
            points: stroke.points.slice(0, availablePoints),
          },
        ],
      }
    })
  }, [])

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled || event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    updateCursor(event)
    const stroke: MaskStroke = {
      id: makeStrokeId(),
      mode: brushMode,
      size: brushSize / 100,
      hardness: hardness / 100,
      points: [pointFromPointer(event)],
    }
    activeStrokeRef.current = stroke
    drawLiveStroke(event.currentTarget, stroke)
  }, [brushMode, brushSize, disabled, hardness, updateCursor])

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    updateCursor(event)
    const stroke = activeStrokeRef.current
    if (!stroke || !event.currentTarget.hasPointerCapture(event.pointerId)) return
    const point = pointFromPointer(event)
    const previous = stroke.points.at(-1)
    if (
      previous
      && Math.hypot(point.x - previous.x, point.y - previous.y) < MIN_POINT_DISTANCE
    ) return
    if (stroke.points.length >= MAX_POINTS_PER_STROKE) return
    stroke.points.push(point)
    drawLiveStroke(event.currentTarget, stroke)
  }, [updateCursor])

  const handlePointerEnd = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    commitActiveStroke(event.currentTarget)
  }, [commitActiveStroke])

  const reset = useCallback(() => {
    activeStrokeRef.current = null
    const canvas = overlayRef.current
    if (canvas) canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
    setRecipe(createEmptyMaskRecipe())
  }, [])

  return (
    <div ref={editorRef} className="mask-editor">
      <div className="mask-editor-toolbar" aria-label="蒙版修边工具">
        <div className="mask-mode-switch" role="group" aria-label="蒙版笔刷模式">
          <button
            type="button"
            className={brushMode === 'remove' ? 'is-active is-remove' : ''}
            disabled={disabled}
            onClick={() => setBrushMode('remove')}
          >
            <Eraser size={14} />
            移除
          </button>
          <button
            type="button"
            className={brushMode === 'restore' ? 'is-active is-restore' : ''}
            disabled={disabled}
            onClick={() => setBrushMode('restore')}
          >
            <Paintbrush size={14} />
            恢复
          </button>
        </div>

        <label>
          <span>直径 {brushSize}%</span>
          <input
            type="range"
            min={1}
            max={30}
            value={brushSize}
            disabled={disabled}
            onChange={(event) => setBrushSize(Number(event.target.value))}
          />
        </label>
        <label>
          <span>硬度 {hardness}%</span>
          <input
            type="range"
            min={0}
            max={100}
            value={hardness}
            disabled={disabled}
            onChange={(event) => setHardness(Number(event.target.value))}
          />
        </label>

        <button
          type="button"
          className="mask-history-button"
          disabled={disabled || recipe.strokes.length === 0}
          onClick={() => setRecipe((current) => ({
            schemaVersion: 1,
            strokes: current.strokes.slice(0, -1),
          }))}
          title="撤销上一笔"
          aria-label="撤销上一笔蒙版"
        >
          <Undo2 size={14} />
        </button>
        <button
          type="button"
          className="mask-history-button"
          disabled={disabled || recipe.strokes.length === 0}
          onClick={reset}
          title="重置蒙版"
          aria-label="重置全部蒙版笔画"
        >
          <RotateCcw size={14} />
        </button>
      </div>

      <div
        className="mask-editor-surface"
        style={{
          width: `${surfaceSize.width}px`,
          height: `${surfaceSize.height}px`,
        }}
      >
        {preview ? <img src={preview.previewUrl} alt={`${label}蒙版修边预览`} /> : null}
        {rendering ? <span className="mask-rendering">更新 Alpha 预览…</span> : null}
        {error ? <span className="mask-rendering is-error">{error}</span> : null}
        <canvas
          ref={overlayRef}
          width={preview?.width ?? 1}
          height={preview?.height ?? 1}
          aria-label="在图片上拖动以移除或恢复蒙版"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
          onPointerLeave={() => {
            if (cursorRef.current && !activeStrokeRef.current) {
              cursorRef.current.style.opacity = '0'
            }
          }}
        />
        <span ref={cursorRef} className="mask-brush-cursor" aria-hidden="true" />
      </div>

      <div className="mask-editor-status" aria-live="polite">
        <span>{recipe.strokes.length} 笔修正</span>
        <span>Alpha 改变 {preview?.changedPercent ?? 0}%</span>
        <span>原图始终保留</span>
      </div>
    </div>
  )
})
