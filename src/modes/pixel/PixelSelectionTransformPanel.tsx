import { useEffect, useMemo, useRef, useState } from 'react'
import type { PixelDocument } from '../../lib/pixel/pixelCore.mjs'
import type { PixelRect } from '../../lib/pixel/pixelTools.mjs'
import { transformPixelSelection, type PixelTransformResult } from '../../lib/pixel/pixelTransform.mjs'

type Props = {
  document: PixelDocument
  selection: PixelRect
  onClose(): void
  onApply(result: PixelTransformResult, revision: number): void
}

export function PixelSelectionTransformPanel({ document, selection, onClose, onApply }: Props) {
  const [width, setWidth] = useState(selection.width)
  const [height, setHeight] = useState(selection.height)
  const [angle, setAngle] = useState(0)
  const [mode, setMode] = useState<'move' | 'copy'>('move')
  const [anchor, setAnchor] = useState<'center' | 'top-left'>('center')
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const options = useMemo(() => ({ width, height, angle, mode, anchor }), [width, height, angle, mode, anchor])
  const candidate = useMemo(() => {
    try {
      const frame = document.frames.find(({ id }) => id === document.activeFrameId)
      if (!frame) throw new Error('当前帧不可用')
      return { result: transformPixelSelection(frame.cels[document.activeLayerId], document.width, document.height, selection, options), error: null }
    } catch (error) {
      return { result: null, error: error instanceof Error ? error.message : '变换参数无效' }
    }
  }, [document, selection, options])

  useEffect(() => {
    const canvas = canvasRef.current
    const result = candidate.result
    if (!canvas || !result) return
    const frame = document.frames.find(({ id }) => id === document.activeFrameId)
    if (!frame) return
    const cel = frame.cels[document.activeLayerId].slice()
    for (const point of result.pixels) cel[point.y * document.width + point.x] = point.value
    const colors = new Map(document.palette.map(({ id, color }) => [id, color]))
    const rect = result.selection
    const bytes = new Uint8ClampedArray(rect.width * rect.height * 4)
    for (let y = 0; y < rect.height; y += 1) for (let x = 0; x < rect.width; x += 1) {
      const colorId = cel[(rect.y + y) * document.width + rect.x + x]
      const hex = colorId === null ? null : colors.get(colorId)
      if (!hex) continue
      const offset = (y * rect.width + x) * 4
      for (let channel = 0; channel < 4; channel += 1) bytes[offset + channel] = Number.parseInt(hex.slice(1 + channel * 2, 3 + channel * 2), 16)
    }
    canvas.width = rect.width
    canvas.height = rect.height
    canvas.getContext('2d')?.putImageData(new ImageData(bytes, rect.width, rect.height), 0, 0)
  }, [candidate.result, document])

  return <section className="aq-pixel-transform-panel" role="dialog" aria-label="选区旋转与缩放" onKeyDown={(event) => { if (event.key === 'Escape') onClose() }}>
    <header><strong>选区旋转与缩放</strong><button type="button" onClick={onClose} aria-label="关闭选区变换">×</button></header>
    <p>预览当前图层。应用前不会修改像素；结果使用整数像素，不增加模糊颜色。</p>
    <div className="aq-pixel-transform-fields">
      <label>目标宽<input aria-label="变换目标宽" type="number" min={1} max={512} value={Number.isFinite(width) ? width : ''} onChange={(event) => setWidth(event.target.valueAsNumber)} /></label>
      <label>目标高<input aria-label="变换目标高" type="number" min={1} max={512} value={Number.isFinite(height) ? height : ''} onChange={(event) => setHeight(event.target.valueAsNumber)} /></label>
      <label>旋转角度<input aria-label="变换旋转角度" type="number" min={-360} max={360} value={Number.isFinite(angle) ? angle : ''} onChange={(event) => setAngle(event.target.valueAsNumber)} /></label>
      <label>原区域<select aria-label="变换原区域处理" value={mode} onChange={(event) => setMode(event.target.value as 'move' | 'copy')}><option value="move">移动内容</option><option value="copy">保留副本</option></select></label>
      <label>锚点<select aria-label="变换锚点" value={anchor} onChange={(event) => setAnchor(event.target.value as 'center' | 'top-left')}><option value="center">选区中心</option><option value="top-left">左上角</option></select></label>
    </div>
    <div className="aq-pixel-transform-angles">{[0, 90, 180, 270].map((value) => <button key={value} type="button" onClick={() => setAngle(value)}>{value}°</button>)}</div>
    {candidate.error ? <p role="alert">{candidate.error}</p> : <>
      <canvas ref={canvasRef} aria-label="选区变换预览" />
      <p>{candidate.result?.selection.width} × {candidate.result?.selection.height} 可见区域 · {candidate.result?.pixels.length} 像素变化 · 裁剪 {candidate.result?.report.clippedPixels} 像素</p>
    </>}
    <footer><button type="button" onClick={onClose}>取消</button><button type="button" disabled={!candidate.result?.pixels.length} onClick={() => { if (candidate.result) onApply(candidate.result, document.revision) }}>应用变换</button></footer>
  </section>
}
