import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Bot,
  CheckCircle2,
  KeyRound,
  Loader2,
  RefreshCw,
  Send,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react'
import {
  AgentAdapterApiError,
  clearTextAgentAdapter,
  configureTextAgentAdapter,
  fetchAgentAdapterStatus,
  requestCreativePlan,
  type AgentAdapterStatus,
} from '../lib/agentAdapterApi'
import type { CreativePlan } from '../lib/agent/creativePlan.mjs'
import './agent-plan-composer.css'

type CreativeModeId = 'balanced' | 'pixel' | 'smart-video'

const MODE_LABELS: Record<CreativeModeId, string> = {
  balanced: '均衡模式',
  pixel: '像素模式',
  'smart-video': '智能视频',
}

type AdapterForm = {
  providerLabel: string
  endpoint: string
  model: string
  apiKey: string
  jsonMode: 'json-object' | 'prompt-only'
  timeoutMs: number
}

type AgentPlanComposerProps = {
  projectId?: string
  documentId: string
  modeId: CreativeModeId
  baseRevision: number
  launcherLabel?: string
  launcherClassName?: string
  onBeforeCompose?: () => void | Promise<void>
  onPlan: (plan: CreativePlan) => void
}

function messageOf(error: unknown) {
  if (error instanceof AgentAdapterApiError) {
    return `${error.code ? `${error.code}：` : ''}${error.message}`
  }
  return error instanceof Error ? error.message : '文本智能体请求失败'
}

export function AgentPlanComposer({
  projectId,
  documentId,
  modeId,
  baseRevision,
  launcherLabel = '文本智能体规划',
  launcherClassName,
  onBeforeCompose,
  onPlan,
}: AgentPlanComposerProps) {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<AgentAdapterStatus>({ text: { configured: false, persistence: 'memory-only' } })
  const [busy, setBusy] = useState<'status' | 'configure' | 'clear' | 'compose' | null>(null)
  const [editingConfiguration, setEditingConfiguration] = useState(true)
  const [notice, setNotice] = useState<{ tone: 'info' | 'error'; message: string } | null>(null)
  const [instruction, setInstruction] = useState('')
  const [form, setForm] = useState<AdapterForm>({
    providerLabel: 'OpenAI-compatible',
    endpoint: '',
    model: '',
    apiKey: '',
    jsonMode: 'json-object',
    timeoutMs: 60_000,
  })
  const dialogRef = useRef<HTMLDivElement>(null)
  const busyRef = useRef(busy)
  busyRef.current = busy

  const loadStatus = async () => {
    setBusy('status')
    setNotice(null)
    try {
      const next = await fetchAgentAdapterStatus()
      setStatus(next)
      setEditingConfiguration(!next.text.configured)
    } catch (error) {
      setNotice({ tone: 'error', message: messageOf(error) })
    } finally {
      setBusy(null)
    }
  }

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    dialogRef.current?.focus()
    void loadStatus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && busyRef.current === null) setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      previous?.focus?.()
    }
    // Opening starts a fresh status probe; busy must not reinstall this listener.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const configure = async () => {
    setBusy('configure')
    setNotice(null)
    try {
      const next = await configureTextAgentAdapter(form)
      setStatus(next)
      setForm((current) => ({ ...current, apiKey: '' }))
      setEditingConfiguration(false)
      setNotice({ tone: 'info', message: '适配器已在本次 sidecar 运行内启用；密钥未写入浏览器、项目或日志。' })
    } catch (error) {
      setNotice({ tone: 'error', message: messageOf(error) })
    } finally {
      setBusy(null)
    }
  }

  const clear = async () => {
    setBusy('clear')
    setNotice(null)
    try {
      const next = await clearTextAgentAdapter()
      setStatus(next)
      setEditingConfiguration(true)
      setNotice({ tone: 'info', message: '本次运行中的文本 API 密钥已从 sidecar 内存清除。' })
    } catch (error) {
      setNotice({ tone: 'error', message: messageOf(error) })
    } finally {
      setBusy(null)
    }
  }

  const compose = async () => {
    if (!projectId) {
      setNotice({ tone: 'error', message: '当前正文尚未登记到本地工作区，不能建立权威计划。' })
      return
    }
    const normalizedInstruction = instruction.trim()
    if (!normalizedInstruction) {
      setNotice({ tone: 'error', message: '请先描述希望智能体规划的修改。' })
      return
    }
    setBusy('compose')
    setNotice(null)
    try {
      await onBeforeCompose?.()
      const result = await requestCreativePlan({
        projectId,
        documentId,
        modeId,
        baseRevision,
        instruction: normalizedInstruction,
      })
      if (
        result.plan.projectId !== projectId
        || result.plan.documentId !== documentId
        || result.plan.modeId !== modeId
        || result.plan.baseRevision !== baseRevision
      ) {
        throw new Error('服务端返回的计划身份与当前正文不一致，已拒绝打开审批。')
      }
      onPlan(result.plan)
      setInstruction('')
      setOpen(false)
    } catch (error) {
      setNotice({ tone: 'error', message: messageOf(error) })
    } finally {
      setBusy(null)
    }
  }

  const configurationValid = Boolean(
    form.providerLabel.trim()
    && form.endpoint.trim()
    && form.model.trim()
    && form.apiKey.trim(),
  )

  return (
    <>
      <button
        type="button"
        className={['aq-agent-composer-launch', launcherClassName].filter(Boolean).join(' ')}
        aria-haspopup="dialog"
        aria-label={launcherLabel}
        disabled={!projectId}
        title={projectId ? '让 BYOK 文本模型生成只读计划' : '请先创建并进入正式项目'}
        onClick={() => setOpen(true)}
      >
        <Bot size={15} /> {launcherLabel}
      </button>

      {open && typeof document !== 'undefined' ? createPortal((
        <div className="aq-agent-composer-backdrop" role="presentation" data-ui-overlay>
          <div
            ref={dialogRef}
            className="aq-agent-composer-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="aq-agent-composer-title"
            tabIndex={-1}
          >
            <header className="aq-agent-composer-header">
              <span><Bot size={21} /></span>
              <div>
                <p>BYOK · CONTROLLED PLANNING</p>
                <h2 id="aq-agent-composer-title">文本智能体规划</h2>
              </div>
              <button type="button" aria-label="关闭文本智能体规划" disabled={busy !== null} onClick={() => setOpen(false)}><X size={18} /></button>
            </header>

            <div className="aq-agent-composer-identity">
              <span>{MODE_LABELS[modeId]}</span>
              <code>{documentId}</code>
              <span>正文 r{baseRevision}</span>
            </div>

            <section className="aq-agent-composer-disclosure" aria-label="发送上下文说明">
              <ShieldCheck size={18} />
              <div>
                <strong>发送前披露</strong>
                <p>会发送你的指令、当前正文的有界结构摘要与安全工具说明；不会发送 API 密钥、本机路径、媒体 URL、图片/视频字节或私有任务路径。</p>
              </div>
            </section>

            <section className="aq-agent-composer-adapter" aria-label="文本 API 配置">
              <header>
                <div>
                  <KeyRound size={15} />
                  <span>文本 API</span>
                  <b className={status.text.configured ? 'is-ready' : ''}>
                    {busy === 'status' ? '检测中' : status.text.configured ? '本次运行已启用' : '未配置'}
                  </b>
                </div>
                <button type="button" aria-label="重新检测文本 API" disabled={busy !== null} onClick={() => void loadStatus()}><RefreshCw size={14} /></button>
              </header>

              {status.text.configured && !editingConfiguration ? (
                <div className="aq-agent-composer-adapter-summary">
                  <CheckCircle2 size={17} />
                  <div>
                    <strong>{status.text.providerLabel} · {status.text.model}</strong>
                    <small>{status.text.endpointLabel} · 密钥仅驻留 sidecar 内存</small>
                  </div>
                  <button type="button" disabled={busy !== null} onClick={() => setEditingConfiguration(true)}>更换</button>
                  <button type="button" className="is-danger" disabled={busy !== null} onClick={() => void clear()}>
                    {busy === 'clear' ? <Loader2 size={13} className="is-spinning" /> : <Trash2 size={13} />} 清除
                  </button>
                </div>
              ) : (
                <div className="aq-agent-composer-form">
                  <label><span>服务名称</span><input value={form.providerLabel} maxLength={80} onChange={(event) => setForm((current) => ({ ...current, providerLabel: event.target.value }))} /></label>
                  <label className="is-wide"><span>OpenAI-compatible 接口</span><input value={form.endpoint} placeholder="https://provider.example/v1" spellCheck={false} onChange={(event) => setForm((current) => ({ ...current, endpoint: event.target.value }))} /></label>
                  <label><span>模型 ID</span><input value={form.model} placeholder="model-id" spellCheck={false} onChange={(event) => setForm((current) => ({ ...current, model: event.target.value }))} /></label>
                  <label><span>API Key</span><input type="password" value={form.apiKey} autoComplete="off" placeholder="只驻留本次运行内存" onChange={(event) => setForm((current) => ({ ...current, apiKey: event.target.value }))} /></label>
                  <label><span>JSON 约束</span><select value={form.jsonMode} onChange={(event) => setForm((current) => ({ ...current, jsonMode: event.target.value as AdapterForm['jsonMode'] }))}><option value="json-object">JSON object</option><option value="prompt-only">仅提示约束</option></select></label>
                  <label><span>超时</span><select value={form.timeoutMs} onChange={(event) => setForm((current) => ({ ...current, timeoutMs: Number(event.target.value) }))}><option value={30_000}>30 秒</option><option value={60_000}>60 秒</option><option value={120_000}>120 秒</option><option value={180_000}>180 秒</option></select></label>
                  <div className="aq-agent-composer-form-actions">
                    {status.text.configured ? <button type="button" disabled={busy !== null} onClick={() => setEditingConfiguration(false)}>取消更换</button> : null}
                    <button type="button" className="is-primary" disabled={busy !== null || !configurationValid} onClick={() => void configure()}>
                      {busy === 'configure' ? <Loader2 size={14} className="is-spinning" /> : <KeyRound size={14} />}
                      {status.text.configured ? '替换本次配置' : '仅本次运行启用'}
                    </button>
                  </div>
                </div>
              )}
            </section>

            <label className="aq-agent-composer-instruction">
              <span>希望如何修改当前正文</span>
              <textarea
                value={instruction}
                maxLength={4_000}
                placeholder={modeId === 'balanced'
                  ? '例如：创建一个品牌标题和一张说明便签，并排放在画布中央。'
                  : modeId === 'pixel'
                    ? '例如：把当前调色板的 Ember 调整成更明亮的橙红色。'
                    : '例如：关闭自动推进，并强化剧本设计节点的武侠动作设计要求。'}
                onChange={(event) => setInstruction(event.target.value)}
              />
              <small>{instruction.length.toLocaleString()} / 4,000</small>
            </label>

            {notice ? <p className={`aq-agent-composer-notice is-${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.message}</p> : null}

            <footer className="aq-agent-composer-footer">
              <p>模型只能返回白名单工具计划。服务端会重读正文并在副本上预演；下一步仍需你在独立审批面明确批准。</p>
              <button
                type="button"
                className="is-primary"
                disabled={busy !== null || !status.text.configured || !instruction.trim()}
                onClick={() => void compose()}
              >
                {busy === 'compose' ? <Loader2 size={15} className="is-spinning" /> : <Send size={15} />}
                {busy === 'compose' ? '正在生成与校验' : '生成只读计划'}
              </button>
            </footer>
          </div>
        </div>
      ), document.body) : null}
    </>
  )
}
