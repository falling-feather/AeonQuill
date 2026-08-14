import {
  Box,
  Cpu,
  Database,
  HardDrive,
  Link2,
  RefreshCw,
  type LucideIcon,
} from 'lucide-react'
import type {
  LocalRuntimeSummary,
  RuntimeHealth,
  RuntimeSurfaceId,
  RuntimeSurfaceSummary,
} from '../../shell/contracts'
import { SurfaceState } from './SurfaceState'

const RUNTIME_ICONS: Record<RuntimeSurfaceId, LucideIcon> = {
  bridge: Link2,
  comfyui: Box,
  gpu: Cpu,
  models: Database,
  storage: HardDrive,
}

const HEALTH_LABELS: Record<RuntimeHealth, string> = {
  ready: '可用',
  busy: '任务中',
  starting: '启动中',
  offline: '离线',
  unavailable: '不可用',
  checking: '检查中',
}

interface RuntimeItemProps {
  item: RuntimeSurfaceSummary
  onAction?: (item: RuntimeSurfaceSummary) => void
}

function RuntimeItem({ item, onAction }: RuntimeItemProps) {
  const Icon = RUNTIME_ICONS[item.id]
  const hasAction = Boolean(item.actionLabel && onAction)

  const content = (
    <>
      <span className="aq-runtime-item__icon" aria-hidden="true">
        <Icon size={20} strokeWidth={1.55} />
      </span>
      <span className="aq-runtime-item__copy">
        <strong>{item.label}</strong>
        {item.detail ? <span>{item.detail}</span> : null}
        {typeof item.usagePercent === 'number' ? (
          <span
            className="aq-runtime-item__meter"
            role="progressbar"
            aria-label={`${item.label}使用量`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.max(0, Math.min(100, item.usagePercent))}
          >
            <span style={{ width: `${Math.max(0, Math.min(100, item.usagePercent))}%` }} />
          </span>
        ) : null}
      </span>
      <span className={`aq-health aq-health--${item.status}`}>
        <span aria-hidden="true" />
        {item.statusLabel || HEALTH_LABELS[item.status]}
      </span>
    </>
  )

  if (hasAction) {
    return (
      <button
        type="button"
        className="aq-runtime-item aq-runtime-item--action"
        onClick={() => onAction?.(item)}
        aria-label={`${item.label}：${item.actionLabel}`}
      >
        {content}
      </button>
    )
  }

  return <div className="aq-runtime-item">{content}</div>
}

interface RuntimeSummaryProps {
  runtime: LocalRuntimeSummary
  refreshing?: boolean
  onRefresh?: () => void
  onItemAction?: (item: RuntimeSurfaceSummary) => void
}

export function RuntimeSummary({
  runtime,
  refreshing = false,
  onRefresh,
  onItemAction,
}: RuntimeSummaryProps) {
  return (
    <section className="aq-runtime" aria-labelledby="aq-runtime-title" aria-live="polite">
      <div className="aq-runtime__heading">
        <div className="aq-runtime__title">
          <span className="aq-runtime__title-icon" aria-hidden="true">
            <Link2 size={18} strokeWidth={1.7} />
          </span>
          <div>
            <h2 id="aq-runtime-title">本地运行时</h2>
            <span className={`aq-health aq-health--${runtime.status}`}>
              <span aria-hidden="true" />
              {runtime.statusLabel || HEALTH_LABELS[runtime.status]}
            </span>
          </div>
        </div>
        <div className="aq-runtime__actions">
          {runtime.lastCheckedLabel ? <span>{runtime.lastCheckedLabel}</span> : null}
          <button
            type="button"
            className="aq-quiet-action"
            onClick={onRefresh}
            disabled={refreshing}
          >
            <RefreshCw
              size={15}
              strokeWidth={1.8}
              className={refreshing ? 'is-spinning' : undefined}
              aria-hidden="true"
            />
            {refreshing ? '检查中' : '刷新'}
          </button>
        </div>
      </div>
      {runtime.feedback ? (
        <SurfaceState
          feedback={runtime.feedback}
          compact
          onAction={runtime.feedback.actionLabel ? onRefresh : undefined}
        />
      ) : null}
      {runtime.detail ? <p className="aq-runtime__detail">{runtime.detail}</p> : null}
      <div className="aq-runtime__items">
        {runtime.items.map((item) => (
          <RuntimeItem key={item.id} item={item} onAction={onItemAction} />
        ))}
      </div>
      {runtime.privacyNote ? <p className="aq-runtime__privacy">{runtime.privacyNote}</p> : null}
    </section>
  )
}
