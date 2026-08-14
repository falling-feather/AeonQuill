import { Minus, Plus, RotateCcw, Undo2 } from 'lucide-react'
import { memo, useEffect, useRef, useState } from 'react'
import type { SemanticPoint } from '../types'

type PointMode = 'positive' | 'negative'

type SemanticPointEditorProps = {
  source: string
  label: string
  positivePoints: SemanticPoint[]
  negativePoints: SemanticPoint[]
  disabled?: boolean
  onChange: (points: { positivePoints: SemanticPoint[]; negativePoints: SemanticPoint[] }) => void
}

const MAX_POINTS = 32

export const SemanticPointEditor = memo(function SemanticPointEditor({
  source,
  label,
  positivePoints,
  negativePoints,
  disabled = false,
  onChange,
}: SemanticPointEditorProps) {
  const [mode, setMode] = useState<PointMode>('positive')
  const [imageRatio, setImageRatio] = useState(1)
  const [surfaceSize, setSurfaceSize] = useState({ width: 1, height: 1 })
  const editorRef = useRef<HTMLDivElement | null>(null)
  const pointCount = positivePoints.length + negativePoints.length

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const resize = () => {
      const availableWidth = Math.max(1, editor.clientWidth - 16)
      const availableHeight = Math.max(1, editor.clientHeight - 84)
      const next = availableWidth / availableHeight > imageRatio
        ? { width: Math.round(availableHeight * imageRatio), height: availableHeight }
        : { width: availableWidth, height: Math.round(availableWidth / imageRatio) }
      setSurfaceSize(next)
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(editor)
    return () => observer.disconnect()
  }, [imageRatio])

  const addPoint = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0 || pointCount >= MAX_POINTS) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const point = {
      x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
      y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)),
    }
    onChange(mode === 'positive'
      ? { positivePoints: [...positivePoints, point], negativePoints }
      : { positivePoints, negativePoints: [...negativePoints, point] })
  }

  const undo = () => {
    if (mode === 'positive' && positivePoints.length) {
      onChange({ positivePoints: positivePoints.slice(0, -1), negativePoints })
    } else if (mode === 'negative' && negativePoints.length) {
      onChange({ positivePoints, negativePoints: negativePoints.slice(0, -1) })
    } else if (negativePoints.length) {
      onChange({ positivePoints, negativePoints: negativePoints.slice(0, -1) })
    } else if (positivePoints.length) {
      onChange({ positivePoints: positivePoints.slice(0, -1), negativePoints })
    }
  }

  return (
    <div ref={editorRef} className="semantic-point-editor">
      <div className="semantic-point-toolbar" role="group" aria-label="语义元素点击提示">
        <button
          type="button"
          className={mode === 'positive' ? 'is-active is-positive' : ''}
          disabled={disabled || pointCount >= MAX_POINTS}
          onClick={() => setMode('positive')}
        >
          <Plus size={14} />
          选择元素
        </button>
        <button
          type="button"
          className={mode === 'negative' ? 'is-active is-negative' : ''}
          disabled={disabled || pointCount >= MAX_POINTS}
          onClick={() => setMode('negative')}
        >
          <Minus size={14} />
          排除背景
        </button>
        <button
          type="button"
          className="semantic-history-button"
          aria-label="撤销上一个点击提示"
          disabled={disabled || pointCount === 0}
          onClick={undo}
        >
          <Undo2 size={14} />
        </button>
        <button
          type="button"
          className="semantic-history-button"
          aria-label="清空点击提示"
          disabled={disabled || pointCount === 0}
          onClick={() => onChange({ positivePoints: [], negativePoints: [] })}
        >
          <RotateCcw size={14} />
        </button>
      </div>

      <div
        className="semantic-point-surface"
        style={{ width: `${surfaceSize.width}px`, height: `${surfaceSize.height}px` }}
        role="application"
        aria-label={`在${label}上点击以选择要提取的元素`}
        onPointerDown={addPoint}
        onContextMenu={(event) => event.preventDefault()}
      >
        <img
          src={source}
          alt={`${label}语义选择预览`}
          draggable={false}
          onLoad={(event) => {
            const image = event.currentTarget
            if (image.naturalWidth > 0 && image.naturalHeight > 0) {
              setImageRatio(image.naturalWidth / image.naturalHeight)
            }
          }}
        />
        {positivePoints.map((point, index) => (
          <span
            className="semantic-point-marker is-positive"
            key={`positive-${index}-${point.x}-${point.y}`}
            style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
            aria-hidden="true"
          >
            <Plus size={12} />
          </span>
        ))}
        {negativePoints.map((point, index) => (
          <span
            className="semantic-point-marker is-negative"
            key={`negative-${index}-${point.x}-${point.y}`}
            style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
            aria-hidden="true"
          >
            <Minus size={12} />
          </span>
        ))}
        {pointCount === 0 ? (
          <span className="semantic-point-empty">点击元素内部，可补充背景排除点</span>
        ) : null}
      </div>

      <div className="semantic-point-status" aria-live="polite">
        <span>元素点 {positivePoints.length}</span>
        <span>排除点 {negativePoints.length}</span>
        <span>最多 {MAX_POINTS} 点</span>
      </div>
    </div>
  )
})
