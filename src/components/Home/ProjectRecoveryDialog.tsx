import { Clock3, Loader2, Plus, RotateCcw, ShieldCheck, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { WorkspaceRecoveryPoint } from '../../lib/projectApi'

const MODE_LABELS = {
  balanced: '均衡画布',
  pixel: '像素文档',
  'smart-video': '智能视频',
} as const

type ProjectRecoveryDialogProps = {
  open: boolean
  projectTitle: string
  recoveryPoints: readonly WorkspaceRecoveryPoint[]
  loading: boolean
  busyId?: string
  error?: string
  message?: string
  onClose: () => void
  onRefresh: () => void
  onCreate: () => void
  onRestore: (recoveryPoint: WorkspaceRecoveryPoint) => void
}

function formatTimestamp(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(timestamp))
}

export function ProjectRecoveryDialog({
  open,
  projectTitle,
  recoveryPoints,
  loading,
  busyId,
  error,
  message,
  onClose,
  onRefresh,
  onCreate,
  onRestore,
}: ProjectRecoveryDialogProps) {
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus())
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyId) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [busyId, onClose, open])

  if (!open) return null

  return (
    <div className="aq-project-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target && !busyId) onClose()
    }}>
      <section className="aq-project-dialog aq-recovery-dialog" role="dialog" aria-modal="true" aria-labelledby="aq-recovery-dialog-title">
        <header>
          <div>
            <h2 id="aq-recovery-dialog-title">项目恢复点</h2>
            <p>“{projectTitle}”的 SQLite 快照；恢复会生成新 revision，不覆盖恢复点本身。</p>
          </div>
          <button ref={closeRef} type="button" className="aq-project-dialog__close" aria-label="关闭项目恢复点" onClick={onClose} disabled={Boolean(busyId)}>
            <X size={18} />
          </button>
        </header>

        <div className="aq-project-dialog__body aq-recovery-dialog__body">
          <div className="aq-recovery-dialog__notice">
            <ShieldCheck size={17} />
            <span>目录、像素/视频正文及均衡画布引用均按文档隔离；恢复前会自动再留一份可撤销快照。</span>
          </div>
          {error ? <div className="aq-recovery-dialog__error" role="alert">{error}</div> : null}
          {message ? <div className="aq-recovery-dialog__message" role="status">{message}</div> : null}
          {loading ? (
            <div className="aq-recovery-dialog__empty"><Loader2 className="is-spinning" size={22} /><span>正在读取恢复点…</span></div>
          ) : recoveryPoints.length === 0 ? (
            <div className="aq-recovery-dialog__empty"><Clock3 size={22} /><span>尚无恢复点。可立即创建，后续编辑也会按时间间隔自动留档。</span></div>
          ) : (
            <ul className="aq-recovery-list">
              {recoveryPoints.map((point) => (
                <li key={point.id}>
                  <span className="aq-recovery-list__icon"><Clock3 size={16} /></span>
                  <span className="aq-recovery-list__copy">
                    <strong>{point.modeId ? MODE_LABELS[point.modeId] : '项目目录'} · {formatTimestamp(point.createdAt)}</strong>
                    <small>{point.reason} · 目录 r{point.catalogRevision}{point.documentRevision === undefined ? '' : ` · 文档 r${point.documentRevision}`}</small>
                  </span>
                  <button type="button" disabled={Boolean(busyId)} onClick={() => onRestore(point)}>
                    {busyId === point.id ? <Loader2 className="is-spinning" size={14} /> : <RotateCcw size={14} />} 恢复
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <footer>
          <button type="button" className="aq-project-cancel" onClick={onRefresh} disabled={loading || Boolean(busyId)}>刷新</button>
          <button type="button" className="aq-project-create" onClick={onCreate} disabled={loading || Boolean(busyId)}><Plus size={15} /> 创建当前恢复点</button>
        </footer>
      </section>
    </div>
  )
}
