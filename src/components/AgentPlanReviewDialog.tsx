import { useEffect, useRef } from 'react'
import { CheckCircle2, FileClock, Loader2, ShieldCheck, Sparkles, X } from 'lucide-react'
import type { CreativePlan, CreativePlanPreview, CreativePlanReceipt } from '../lib/agent/creativePlan.mjs'
import './agent-plan-review.css'

const MODE_LABELS = {
  balanced: '均衡模式',
  pixel: '像素模式',
  'smart-video': '智能视频',
} as const

type AgentPlanReviewDialogProps = {
  plan: CreativePlan | null
  preview: CreativePlanPreview | null
  busy?: boolean
  error?: string | null
  latestReceipt?: CreativePlanReceipt | null
  onApprove: () => void | Promise<void>
  onReject: () => void
}

export function AgentPlanReviewDialog({
  plan,
  preview,
  busy = false,
  error,
  latestReceipt,
  onApprove,
  onReject,
}: AgentPlanReviewDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!plan) return
    const previous = document.activeElement as HTMLElement | null
    dialogRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onReject()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      previous?.focus?.()
    }
  }, [busy, onReject, plan])

  if (!plan || !preview) return null
  return (
    <div className="aq-agent-plan-backdrop" role="presentation" data-ui-overlay>
      <div
        ref={dialogRef}
        className="aq-agent-plan-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="aq-agent-plan-title"
        tabIndex={-1}
      >
        <header>
          <span className="aq-agent-plan-mark"><Sparkles size={20} /></span>
          <div>
            <p>CONTROLLED AGENT PLAN</p>
            <h2 id="aq-agent-plan-title">{plan.title}</h2>
          </div>
          <button type="button" aria-label="拒绝并关闭智能体计划" disabled={busy} onClick={onReject}><X size={18} /></button>
        </header>

        <div className="aq-agent-plan-meta">
          <span>{MODE_LABELS[plan.modeId]}</span>
          <span>正文 r{preview.baseRevision} → r{preview.resultRevision}</span>
          <span>{plan.source.kind === 'byok-text' ? 'BYOK 文本提案' : '本机确定性计划'}</span>
        </div>

        <section className="aq-agent-plan-objective">
          <ShieldCheck size={17} />
          <div><strong>执行目标</strong><p>{plan.objective}</p></div>
        </section>

        <ol className="aq-agent-plan-steps" aria-label="智能体计划步骤">
          {preview.summaries.map((step, index) => (
            <li key={step.stepId}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <div><strong>{step.summary}</strong><code>{step.toolId}</code></div>
              <CheckCircle2 size={16} />
            </li>
          ))}
        </ol>

        {latestReceipt ? (
          <aside className="aq-agent-plan-receipt">
            <FileClock size={15} />
            <span>本模式最近回执：{latestReceipt.title} · {latestReceipt.planSha256.slice(0, 10)}</span>
          </aside>
        ) : null}
        {error ? <p className="aq-agent-plan-error" role="alert">{error}</p> : null}

        <footer>
          <p>拒绝不会写入正文；批准后服务端会重新校验计划与当前 revision，并保留恢复点和 SHA-256 回执。</p>
          <div>
            <button type="button" disabled={busy} onClick={onReject}>拒绝并保留原稿</button>
            <button type="button" className="is-primary" disabled={busy} onClick={() => void onApprove()}>
              {busy ? <Loader2 size={15} className="is-spinning" /> : <ShieldCheck size={15} />}
              {busy ? '正在权威提交' : '批准并执行'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}
