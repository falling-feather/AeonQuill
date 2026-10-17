import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { CanvasElement } from '../types'

export function CanvasConnectionDialog({ elements, sourceId, onCreate, onClose }: {
  elements: CanvasElement[]
  sourceId: string
  onCreate: (fromId: string, toId: string) => void
  onClose: () => void
}) {
  const candidates = elements.filter((element) => element.kind !== 'connector')
  const [fromId, setFromId] = useState(sourceId)
  const [toId, setToId] = useState(candidates.find((element) => element.id !== sourceId)?.id ?? '')
  const [error, setError] = useState<string | null>(null)
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement
    panel.current?.querySelector('select')?.focus()
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [])
  return <div className="modal-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <div className="aq-canvas-connection" role="dialog" aria-modal="true" aria-label="创建画布连接" ref={panel}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.stopPropagation(); onClose() }
        if (event.key !== 'Tab') return
        const fields = [...(panel.current?.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('select, button:not(:disabled)') ?? [])]
        const first = fields[0], last = fields.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }}>
      <header><h2>创建连接</h2><button type="button" className="modal-close" aria-label="关闭创建连接" onClick={onClose}><X size={18} /></button></header>
      <p>连接随元件的位置和旋转更新，可选择、改向或删除。</p>
      <label>起点<select aria-label="连接起点" value={fromId} onChange={(event) => { setFromId(event.target.value); setError(null) }}>{candidates.map((element) => <option key={element.id} value={element.id}>{element.name}</option>)}</select></label>
      <label>终点<select aria-label="连接终点" value={toId} onChange={(event) => { setToId(event.target.value); setError(null) }}><option value="">请选择元件</option>{candidates.filter((element) => element.id !== fromId).map((element) => <option key={element.id} value={element.id}>{element.name}</option>)}</select></label>
      {error ? <p role="alert">{error}</p> : null}
      <footer><button type="button" onClick={onClose}>取消</button><button type="button" disabled={!fromId || !toId || fromId === toId} onClick={() => {
        try { onCreate(fromId, toId); onClose() } catch (reason) { setError(reason instanceof Error ? reason.message : '连接创建失败') }
      }}>创建连接</button></footer>
    </div>
  </div>
}
