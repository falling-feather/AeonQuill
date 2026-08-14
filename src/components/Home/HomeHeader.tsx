import { Feather, Settings } from 'lucide-react'

interface HomeHeaderProps {
  onOpenSettings?: () => void
}

export function HomeHeader({ onOpenSettings }: HomeHeaderProps) {
  return (
    <header className="aq-home-header">
      <div className="aq-home-header__brand" aria-label="光阴砚 AEONQUILL">
        <span className="aq-home-header__mark" aria-hidden="true">
          <Feather size={19} strokeWidth={1.7} />
        </span>
        <span className="aq-home-header__cn">光阴砚</span>
        <span className="aq-home-header__en">AEONQUILL</span>
      </div>
      <button
        type="button"
        className="aq-header-action"
        onClick={onOpenSettings}
        aria-label="打开设置"
      >
        <Settings size={17} strokeWidth={1.8} aria-hidden="true" />
        <span>设置</span>
      </button>
    </header>
  )
}
