import {
  Frame,
  Grid3X3,
  ImagePlus,
  MousePointer2,
  Shapes,
  StickyNote,
  Type,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ToolId } from '../types'

type ToolRailProps = {
  activeTool: ToolId
  onSelect: (tool: ToolId) => void
}

const tools: Array<{ id: ToolId; label: string; icon: LucideIcon; shortcut: string }> = [
  { id: 'select', label: '选择', icon: MousePointer2, shortcut: 'V' },
  { id: 'frame', label: '画框', icon: Frame, shortcut: 'F' },
  { id: 'text', label: '文字', icon: Type, shortcut: 'T' },
  { id: 'note', label: '便签', icon: StickyNote, shortcut: 'N' },
  { id: 'shape', label: '形状', icon: Shapes, shortcut: 'S' },
  { id: 'image', label: '图片', icon: ImagePlus, shortcut: 'I' },
  { id: 'pixel', label: '像素画', icon: Grid3X3, shortcut: 'P' },
]

export function ToolRail({ activeTool, onSelect }: ToolRailProps) {
  return (
    <nav className="tool-rail" aria-label="画布工具">
      {tools.map(({ id, label, icon: Icon, shortcut }) => (
        <button
          type="button"
          key={id}
          className={`tool-button ${activeTool === id ? 'is-active' : ''}`}
          aria-label={`${label}（${shortcut}）`}
          aria-pressed={activeTool === id}
          title={`${label} · ${shortcut}`}
          onClick={() => onSelect(id)}
        >
          <Icon size={22} strokeWidth={1.65} />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  )
}
