import { Feather, FilePlus2, Library, Settings } from 'lucide-react'

interface HomeHeaderProps {
  onOpenSettings?: () => void
  onOpenLibrary?: () => void
  onCreateProject?: () => void
}

export function HomeHeader({ onOpenSettings, onOpenLibrary, onCreateProject }: HomeHeaderProps) {
  return (
    <header className="aq-home-header">
      <div className="aq-home-header__brand" aria-label="光阴砚 AEONQUILL">
        <span className="aq-home-header__mark" aria-hidden="true">
          <Feather size={19} strokeWidth={1.7} />
        </span>
        <span className="aq-home-header__cn">光阴砚</span>
        <span className="aq-home-header__en">AEONQUILL</span>
      </div>
      <div className="aq-home-header__actions">
        <button
          type="button"
          className="aq-header-action"
          onClick={onOpenLibrary}
          aria-label="打开资源库"
        >
          <Library size={17} strokeWidth={1.8} aria-hidden="true" />
          <span>资源库</span>
        </button>
        <button
          type="button"
          className="aq-header-action"
          onClick={onOpenSettings}
          aria-label="打开设置"
        >
          <Settings size={17} strokeWidth={1.8} aria-hidden="true" />
          <span>设置</span>
        </button>
        <button type="button" className="aq-primary-action" onClick={onCreateProject}>
          <FilePlus2 size={17} strokeWidth={1.8} aria-hidden="true" />
          创建新项目
        </button>
      </div>
    </header>
  )
}
