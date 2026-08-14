import { useEffect, useRef } from 'react'
import {
  AlertTriangle,
  FolderOpen,
  History,
  Info,
  LoaderCircle,
  RotateCcw,
} from 'lucide-react'
import type { ShellFeedback } from '../../shell/contracts'

interface SurfaceStateProps {
  feedback: ShellFeedback
  compact?: boolean
  focusOnMount?: boolean
  onAction?: () => void
  onSecondaryAction?: () => void
}

const STATE_ICONS = {
  loading: LoaderCircle,
  empty: FolderOpen,
  error: AlertTriangle,
  recovered: History,
  info: Info,
} as const

export function SurfaceState({
  feedback,
  compact = false,
  focusOnMount = false,
  onAction,
  onSecondaryAction,
}: SurfaceStateProps) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  const Icon = STATE_ICONS[feedback.status]

  useEffect(() => {
    if (focusOnMount) headingRef.current?.focus()
  }, [focusOnMount, feedback.title])

  return (
    <div
      className={`aq-surface-state aq-surface-state--${feedback.status} ${compact ? 'is-compact' : ''}`}
      role={feedback.status === 'error' ? 'alert' : 'status'}
      aria-live={feedback.status === 'error' ? 'assertive' : 'polite'}
      aria-busy={feedback.status === 'loading' || undefined}
    >
      <span className="aq-surface-state__icon" aria-hidden="true">
        <Icon className={feedback.status === 'loading' ? 'is-spinning' : undefined} size={compact ? 18 : 25} strokeWidth={1.55} />
      </span>
      <div className="aq-surface-state__copy">
        <h3 ref={headingRef} tabIndex={focusOnMount ? -1 : undefined}>{feedback.title}</h3>
        {feedback.detail ? <p>{feedback.detail}</p> : null}
      </div>
      {feedback.actionLabel || feedback.secondaryActionLabel ? (
        <div className="aq-surface-state__actions">
          {feedback.actionLabel ? (
            <button type="button" className="aq-state-action" onClick={onAction} disabled={!onAction}>
              {feedback.status === 'error' ? <RotateCcw size={15} aria-hidden="true" /> : null}
              {feedback.actionLabel}
            </button>
          ) : null}
          {feedback.secondaryActionLabel ? (
            <button type="button" className="aq-state-action aq-state-action--quiet" onClick={onSecondaryAction} disabled={!onSecondaryAction}>
              {feedback.secondaryActionLabel}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
