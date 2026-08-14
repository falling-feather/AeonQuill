import { useEffect, useRef, useState } from 'react'
import {
  CheckCircle2,
  ChevronDown,
  Download,
  House,
  LoaderCircle,
  PanelRight,
  Redo2,
  RotateCcw,
  Share2,
  Upload,
  Undo2,
} from 'lucide-react'
import { IconButton } from './ui/IconButton'

type TopBarProps = {
  onHome?: () => void
  projectTitle?: string
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  onShare: () => void
  onExport: () => void
  onImport: () => void
  onReset: () => void
  onToggleInspector: () => void
  saveStatus: 'saving' | 'saved'
}

export function TopBar({
  onHome,
  projectTitle = '本地创作项目',
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onShare,
  onExport,
  onImport,
  onReset,
  onToggleInspector,
  saveStatus,
}: TopBarProps) {
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setProjectMenuOpen(false)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [])

  return (
    <header className="top-bar">
      <div className="brand-block">
        {onHome ? (
          <IconButton
            label="返回光阴砚主页"
            className="home-mode-button"
            onClick={onHome}
          >
            <House size={17} strokeWidth={1.8} />
          </IconButton>
        ) : null}
        <div className="brand-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <strong className="brand-name">光阴砚 <span>AEONQUILL</span></strong>
        <div className="top-separator" />
        <div className="project-menu" ref={menuRef}>
          <button
            type="button"
            className="project-trigger"
            aria-expanded={projectMenuOpen}
            onClick={() => setProjectMenuOpen((open) => !open)}
          >
            {projectTitle} <ChevronDown size={14} strokeWidth={1.8} />
          </button>
          {projectMenuOpen ? (
            <div className="project-popover" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setProjectMenuOpen(false)
                  onExport()
                }}
              >
                <Download size={15} /> 下载完整项目包
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setProjectMenuOpen(false)
                  onImport()
                }}
              >
                <Upload size={15} /> 导入项目包
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setProjectMenuOpen(false)
                  onReset()
                }}
              >
                <RotateCcw size={15} /> 恢复示例画布
              </button>
            </div>
          ) : null}
        </div>
        <span className={`save-status is-${saveStatus}`} role="status">
          {saveStatus === 'saving' ? (
            <LoaderCircle size={13} />
          ) : (
            <CheckCircle2 size={13} />
          )}
          {saveStatus === 'saving' ? '正在保存' : '已保存'}
        </span>
      </div>

      <div className="history-actions" aria-label="历史操作">
        <IconButton label="撤销" text="撤销" disabled={!canUndo} onClick={onUndo}>
          <Undo2 size={18} strokeWidth={1.8} />
        </IconButton>
        <IconButton label="重做" text="重做" disabled={!canRedo} onClick={onRedo}>
          <Redo2 size={18} strokeWidth={1.8} />
        </IconButton>
      </div>

      <div className="top-actions">
        <IconButton
          label="打开属性面板"
          className="mobile-inspector-button"
          onClick={onToggleInspector}
        >
          <PanelRight size={18} strokeWidth={1.8} />
        </IconButton>
        <button type="button" className="button button-secondary" onClick={onShare}>
          <Share2 size={17} strokeWidth={1.8} />
          分享
        </button>
        <button type="button" className="button button-primary" onClick={onExport}>
          <Download size={17} strokeWidth={1.8} />
          导出
        </button>
      </div>
    </header>
  )
}
