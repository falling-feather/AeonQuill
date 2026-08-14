import {
  ArrowUpRight,
  Blend,
  Clapperboard,
  Grid3X3,
  type LucideIcon,
} from 'lucide-react'
import type { ModeAvailabilitySummary } from '../../shell/contracts'
import type { ModeManifest, ModeMaturity, ProductModeId } from '../../shell/modeRegistry'

const MODE_ICONS: Record<ProductModeId, LucideIcon> = {
  balanced: Blend,
  pixel: Grid3X3,
  'smart-video': Clapperboard,
}

const MATURITY_LABELS: Record<ModeMaturity, string> = {
  available: '稳定',
  preview: '预览版',
  planned: '规划中',
}

interface ModeCardProps {
  mode: ModeManifest
  selected: boolean
  availability?: ModeAvailabilitySummary
  onActivate: (id: ProductModeId) => void
  onPreview: (id: ProductModeId) => void
}

export function ModeCard({
  mode,
  selected,
  availability,
  onActivate,
  onPreview,
}: ModeCardProps) {
  const Icon = MODE_ICONS[mode.id]
  const unavailable = availability?.status === 'unavailable'
  const statusLabel = availability?.label ?? MATURITY_LABELS[mode.maturity]

  return (
    <button
      type="button"
      className={`aq-mode-card aq-mode-card--${mode.accent} ${selected ? 'is-selected' : ''}`}
      aria-current={selected ? 'page' : undefined}
      aria-disabled={unavailable || undefined}
      aria-describedby={`${mode.id}-mode-description`}
      onFocus={() => onPreview(mode.id)}
      onPointerEnter={() => onPreview(mode.id)}
      onClick={() => onActivate(mode.id)}
    >
      <span className="aq-mode-card__visual" aria-hidden="true">
        <Icon size={34} strokeWidth={1.35} />
        <span className="aq-mode-card__visual-lines" />
      </span>
      <span className="aq-mode-card__body">
        <span className="aq-mode-card__title-row">
          <strong>{mode.title}</strong>
          <span className={`aq-mode-card__status aq-mode-card__status--${availability?.status ?? mode.maturity}`}>
            <span aria-hidden="true" />
            {statusLabel}
          </span>
        </span>
        <span className="aq-mode-card__summary">{mode.summary}</span>
        <span id={`${mode.id}-mode-description`} className="aq-mode-card__description">
          {availability?.reason ?? mode.notice ?? mode.description}
        </span>
      </span>
      <span className="aq-mode-card__arrow" aria-hidden="true">
        <ArrowUpRight size={20} strokeWidth={1.7} />
      </span>
    </button>
  )
}
