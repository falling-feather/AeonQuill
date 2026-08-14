import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Check, Eraser, Pencil, RotateCcw, Trash2, X } from 'lucide-react'
import type { CanvasElement } from '../types'
import { PixelSprite } from './CanvasElementView'

type PixelEditorProps = {
  element: CanvasElement
  onClose: () => void
  onSave: (pixels: string[]) => void
}

export function PixelEditor({ element, onClose, onSave }: PixelEditorProps) {
  const width = element.pixelWidth ?? 12
  const height = element.pixelHeight ?? 12
  const pixelCount = width * height
  const originalPixels =
    element.pixels?.length === pixelCount
      ? element.pixels
      : Array.from({ length: pixelCount }, (_, index) => element.pixels?.[index] ?? '.')
  const palette = element.palette ?? ['transparent', '#2d2d2f', '#ffd0aa', '#2d2d2f', '#f8f7f1', '#ff6f61']
  const [pixels, setPixels] = useState([...originalPixels])
  const [colorIndex, setColorIndex] = useState(String(Math.max(1, palette.length - 1)))
  const [tool, setTool] = useState<'pencil' | 'eraser'>('pencil')
  const paintingRef = useRef(false)

  useEffect(() => {
    const stopPainting = () => {
      paintingRef.current = false
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('pointerup', stopPainting)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerup', stopPainting)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const paint = (index: number) => {
    setPixels((current) => {
      const next = [...current]
      next[index] = tool === 'eraser' ? '.' : colorIndex
      return next
    })
  }

  return (
    <div className="modal-backdrop" role="presentation" onPointerDown={onClose}>
      <section
        className="pixel-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pixel-editor-title"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="pixel-editor-header">
          <div>
            <h2 id="pixel-editor-title">像素画编辑器</h2>
            <p>{width} × {height} · 最近邻预览</p>
          </div>
          <button type="button" className="modal-close" aria-label="关闭" onClick={onClose}>
            <X size={19} />
          </button>
        </header>

        <div className="pixel-editor-body">
          <div className="pixel-editor-workbench">
            <div className="pixel-tool-row" aria-label="像素工具">
              <button
                type="button"
                className={tool === 'pencil' ? 'is-active' : ''}
                onClick={() => setTool('pencil')}
              >
                <Pencil size={16} /> 铅笔
              </button>
              <button
                type="button"
                className={tool === 'eraser' ? 'is-active' : ''}
                onClick={() => setTool('eraser')}
              >
                <Eraser size={16} /> 橡皮
              </button>
              <span className="pixel-tool-spacer" />
              <button type="button" onClick={() => setPixels([...originalPixels])}>
                <RotateCcw size={16} /> 还原
              </button>
              <button type="button" onClick={() => setPixels(Array.from({ length: pixelCount }, () => '.'))}>
                <Trash2 size={16} /> 清空
              </button>
            </div>

            <div
              className="pixel-edit-grid"
              aria-label="像素绘制区域"
              style={{
                '--pixel-columns': width,
                '--pixel-rows': height,
                aspectRatio: `${width} / ${height}`,
              } as CSSProperties}
              onPointerLeave={() => {
                paintingRef.current = false
              }}
            >
              {pixels.map((pixel, index) => (
                <button
                  type="button"
                  key={index}
                  aria-label={`像素 ${Math.floor(index / width) + 1}, ${(index % width) + 1}`}
                  style={{
                    background:
                      pixel === '.' || pixel === '0'
                        ? 'transparent'
                        : palette[Number(pixel)] || '#2d2d2f',
                  }}
                  onPointerDown={(event) => {
                    event.preventDefault()
                    paintingRef.current = true
                    paint(index)
                  }}
                  onPointerEnter={() => {
                    if (paintingRef.current) paint(index)
                  }}
                />
              ))}
            </div>

            <div className="pixel-palette" aria-label="调色板">
              {palette.map((color, index) => (
                <button
                  type="button"
                  key={`${color}-${index}`}
                  aria-label={index === 0 ? '透明色' : color}
                  title={index === 0 ? '透明色' : color}
                  className={`${index === 0 ? 'transparent-swatch' : ''} ${colorIndex === String(index) && tool === 'pencil' ? 'is-active' : ''}`}
                  style={index === 0 ? undefined : { background: color }}
                  onClick={() => {
                    if (index === 0) setTool('eraser')
                    else {
                      setTool('pencil')
                      setColorIndex(String(index))
                    }
                  }}
                />
              ))}
            </div>
          </div>

          <aside className="pixel-preview-panel">
            <span>实时预览</span>
            <div className="pixel-preview-stage">
              <PixelSprite pixels={pixels} palette={palette} width={width} height={height} />
            </div>
            <p>像素在画布缩放时始终保持清晰边缘。</p>
          </aside>
        </div>

        <footer className="pixel-editor-footer">
          <button type="button" className="button button-secondary" onClick={onClose}>
            取消
          </button>
          <button type="button" className="button button-primary" onClick={() => onSave(pixels)}>
            <Check size={17} /> 应用更改
          </button>
        </footer>
      </section>
    </div>
  )
}
