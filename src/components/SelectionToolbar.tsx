import {
  BringToFront,
  Copy,
  Ellipsis,
  Link2,
  Lock,
  Trash2,
  Unlock,
} from 'lucide-react'
import type { CanvasElement } from '../types'
import { IconButton } from './ui/IconButton'

type SelectionToolbarProps = {
  element: CanvasElement
  zoom: number
  onDuplicate: () => void
  onToggleLock: () => void
  onBringToFront: () => void
  onDelete: () => void
}

export function SelectionToolbar({
  element,
  zoom,
  onDuplicate,
  onToggleLock,
  onBringToFront,
  onDelete,
}: SelectionToolbarProps) {
  return (
    <div
      className="selection-toolbar"
      data-ui-overlay
      style={{
        top: `${-54 / zoom}px`,
        transform: `translateX(-50%) scale(${1 / zoom})`,
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <IconButton label="复制" onClick={onDuplicate}>
        <Copy size={17} strokeWidth={1.75} />
      </IconButton>
      <span className="toolbar-divider" />
      <IconButton label={element.locked ? '解锁' : '锁定'} onClick={onToggleLock}>
        {element.locked ? <Lock size={17} /> : <Unlock size={17} />}
      </IconButton>
      <span className="toolbar-divider" />
      <IconButton label="移到最前" onClick={onBringToFront}>
        <BringToFront size={17} strokeWidth={1.75} />
      </IconButton>
      <IconButton label="创建连接" onClick={() => undefined} disabled>
        <Link2 size={17} strokeWidth={1.75} />
      </IconButton>
      <IconButton label="删除" onClick={onDelete}>
        <Trash2 size={17} strokeWidth={1.75} />
      </IconButton>
      <IconButton label="更多" onClick={() => undefined} disabled>
        <Ellipsis size={17} strokeWidth={1.75} />
      </IconButton>
    </div>
  )
}
