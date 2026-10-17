import {
  AlertTriangle,
  CheckCircle2,
  FileKey2,
  Info,
  LoaderCircle,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  fetchLoraCatalog,
  inspectLoraModel,
  resolveLoraModelBinding,
  saveLoraModelBinding,
  type ManagedLoraBinding,
  type ManagedLoraCatalog,
  type ManagedLoraInspection,
} from '../../lib/workflowCenterApi'
import { LORA_BASE_FAMILIES } from '../../lib/loraCompatibility.mjs'
import type { LoraBaseFamily } from '../../lib/loraCompatibility.mjs'
import './lora-bindings.css'

export interface LoraBindingsPanelProps {
  onUseBinding?: (record: ManagedLoraBinding) => void
}

const FAMILY_LABELS: Record<LoraBaseFamily, string> = {
  sd15: 'SD 1.5 / 1.x',
  sdxl: 'SDXL',
  flux: 'Flux',
  'qwen-image-edit': 'Qwen Image Edit',
  'minimax-h3': 'MiniMax H3',
}

const ROLE_LABELS = {
  style: '风格 LoRA',
  character: '角色 LoRA',
} as const

type BusyState = 'catalog' | 'inspect' | 'save' | string | null

function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 1 : 2) + ' GB'
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(1) + ' MB'
  if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB'
  return bytes + ' B'
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

function parseTriggerWords(value: string) {
  const words = value.split(/[,\n]/u).map((word) => word.trim()).filter(Boolean)
  return words.length ? words : undefined
}

function compatibilityLabel(value: ManagedLoraInspection['inspection']['compatibility']) {
  if (value === 'compatible') return '格式与家族匹配'
  if (value === 'incompatible') return '明确不兼容'
  return '家族信息不足'
}

function compatibilityClass(value: ManagedLoraInspection['inspection']['compatibility']) {
  return value === 'compatible' ? 'is-compatible' : value === 'incompatible' ? 'is-incompatible' : 'is-unverified'
}

function familyLabel(value: LoraBaseFamily | null) {
  return value ? FAMILY_LABELS[value] : '未知'
}

export function LoraBindingsPanel({ onUseBinding }: LoraBindingsPanelProps) {
  const mountedRef = useRef(true)
  const catalogRequestRef = useRef(0)
  const inspectionRequestRef = useRef(0)
  const resolveRequestRef = useRef(0)
  const [catalog, setCatalog] = useState<ManagedLoraCatalog | null>(null)
  const [selectedModelId, setSelectedModelId] = useState('')
  const [expectedFamily, setExpectedFamily] = useState<LoraBaseFamily>('sd15')
  const [role, setRole] = useState<'style' | 'character'>('style')
  const [strength, setStrength] = useState('1')
  const [clipStrength, setClipStrength] = useState('')
  const [triggerText, setTriggerText] = useState('')
  const [inspection, setInspection] = useState<ManagedLoraInspection | null>(null)
  const [busy, setBusy] = useState<BusyState>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const selectedModel = useMemo(
    () => catalog?.models.find((model) => model.id === selectedModelId) ?? null,
    [catalog?.models, selectedModelId],
  )
  const canSave = Boolean(
    selectedModel
      && inspection
      && inspection.model.id === selectedModel.id
      && inspection.inspection.compatibility === 'compatible'
      && inspection.inspection.family === expectedFamily
      && busy !== 'save',
  )

  const refreshCatalog = useCallback(async () => {
    const requestId = ++catalogRequestRef.current
    inspectionRequestRef.current += 1
    resolveRequestRef.current += 1
    setInspection(null)
    setBusy('catalog')
    setError(null)
    setMessage(null)
    try {
      const next = await fetchLoraCatalog()
      if (!mountedRef.current || requestId !== catalogRequestRef.current) return
      setCatalog(next)
      setSelectedModelId((current) => next.models.some((model) => model.id === current) ? current : next.models[0]?.id ?? '')
      setInspection(null)
    } catch (reason) {
      if (!mountedRef.current || requestId !== catalogRequestRef.current) return
      setError(errorMessage(reason, 'LoRA目录读取失败'))
    } finally {
      if (mountedRef.current && requestId === catalogRequestRef.current) setBusy(null)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void refreshCatalog()
    return () => {
      mountedRef.current = false
      catalogRequestRef.current += 1
      inspectionRequestRef.current += 1
      resolveRequestRef.current += 1
    }
  }, [refreshCatalog])

  useEffect(() => {
    inspectionRequestRef.current += 1
    resolveRequestRef.current += 1
    setInspection(null)
    setMessage(null)
    setBusy((current) => current === 'inspect' ? null : current)
  }, [selectedModelId, expectedFamily, role, strength, clipStrength, triggerText])

  const inspectSelected = useCallback(async () => {
    if (!selectedModel) return
    const requestId = ++inspectionRequestRef.current
    setBusy('inspect')
    setError(null)
    setMessage(null)
    try {
      const next = await inspectLoraModel(selectedModel.id, expectedFamily)
      if (!mountedRef.current || requestId !== inspectionRequestRef.current) return
      setInspection(next)
      if (next.inspection.compatibility === 'compatible') {
        setMessage('检查通过，可以登记这个 LoRA。')
      } else {
        setMessage('检查完成，但当前不能登记：' + compatibilityLabel(next.inspection.compatibility))
      }
    } catch (reason) {
      if (!mountedRef.current || requestId !== inspectionRequestRef.current) return
      setInspection(null)
      setError(errorMessage(reason, 'LoRA兼容性检查失败'))
    } finally {
      if (mountedRef.current && requestId === inspectionRequestRef.current) setBusy(null)
    }
  }, [expectedFamily, selectedModel])

  const saveBinding = useCallback(async () => {
    if (!selectedModel || !inspection || !canSave) return
    const parsedStrength = Number(strength)
    const parsedClipStrength = clipStrength.trim() ? Number(clipStrength) : undefined
    const triggerWords = parseTriggerWords(triggerText)
    setBusy('save')
    setError(null)
    setMessage(null)
    try {
      const saved = await saveLoraModelBinding({
        modelId: selectedModel.id,
        role,
        expectedFamily,
        strength: parsedStrength,
        ...(parsedClipStrength === undefined ? {} : { clipStrength: parsedClipStrength }),
        ...(triggerWords === undefined ? {} : { triggerWords }),
      })
      if (!mountedRef.current) return
      setCatalog((current) => {
        if (!current) return current
        const bindings = [...current.bindings.filter((entry) => entry.binding.id !== saved.binding.id), saved]
        return { ...current, bindings }
      })
      setMessage('LoRA已登记，可在下方复核文件后交给配方入口。')
    } catch (reason) {
      if (mountedRef.current) setError(errorMessage(reason, 'LoRA登记失败'))
    } finally {
      if (mountedRef.current) setBusy(null)
    }
  }, [canSave, clipStrength, expectedFamily, inspection, role, selectedModel, strength, triggerText])

  const resolveBinding = useCallback(async (record: ManagedLoraBinding) => {
    const requestId = ++resolveRequestRef.current
    setBusy('resolve:' + record.binding.id)
    setError(null)
    setMessage(null)
    try {
      const resolved = await resolveLoraModelBinding(record.binding.id, record.binding.family)
      if (!mountedRef.current || requestId !== resolveRequestRef.current) return
      if (onUseBinding) {
        onUseBinding(resolved)
        setMessage('文件复核通过，已交给配方入口。')
      } else {
        setMessage('文件复核通过；当前面板只负责登记，尚未连接配方应用入口。')
      }
    } catch (reason) {
      if (!mountedRef.current || requestId !== resolveRequestRef.current) return
      setError(errorMessage(reason, 'LoRA文件复核失败，绑定未应用'))
    } finally {
      if (mountedRef.current && requestId === resolveRequestRef.current) setBusy(null)
    }
  }, [onUseBinding])

  const models = catalog?.models ?? []
  const bindings = catalog?.bindings ?? []
  const inspectionDetails = inspection?.inspection ?? null
  const inspectionBusy = busy === 'inspect'
  const saving = busy === 'save'

  return (
    <section className="aq-lora-bindings" aria-labelledby="aq-lora-bindings-title">
      <header className="aq-lora-bindings__header">
        <div>
          <p className="aq-lora-bindings__eyebrow">受管 LoRA</p>
          <h3 id="aq-lora-bindings-title">导入与配方绑定</h3>
          <p>只读取已配置的受管目录，不接受任意文件路径，也不会启动训练任务。</p>
        </div>
        <button type="button" className="aq-lora-bindings__refresh" onClick={() => void refreshCatalog()} disabled={busy === 'catalog'}>
          <RefreshCw size={15} className={busy === 'catalog' ? 'is-spinning' : undefined} aria-hidden="true" />
          刷新目录
        </button>
      </header>

      {error ? <div className="aq-lora-bindings__feedback is-error" role="alert"><AlertTriangle size={16} aria-hidden="true" /><span>{error}</span></div> : null}
      {message ? <div className="aq-lora-bindings__feedback is-message" role="status"><CheckCircle2 size={16} aria-hidden="true" /><span>{message}</span></div> : null}

      <div className="aq-lora-bindings__layout">
        <aside className="aq-lora-bindings__models" aria-label="受管 LoRA 文件">
          <div className="aq-lora-bindings__section-heading">
            <div><strong>受管文件</strong><small>{models.length} 个</small></div>
            <FileKey2 size={17} aria-hidden="true" />
          </div>
          {busy === 'catalog' && !catalog ? (
            <div className="aq-lora-bindings__empty"><LoaderCircle size={18} className="is-spinning" />正在读取目录…</div>
          ) : models.length ? (
            <div className="aq-lora-bindings__model-list">
              {models.map((model) => (
                <button
                  type="button"
                  key={model.id}
                  className={'aq-lora-bindings__model' + (selectedModelId === model.id ? ' is-selected' : '')}
                  onClick={() => setSelectedModelId(model.id)}
                  aria-pressed={selectedModelId === model.id}
                >
                  <span>{model.name}</span>
                  <small>{formatBytes(model.bytes)}</small>
                </button>
              ))}
            </div>
          ) : (
            <div className="aq-lora-bindings__empty">
              <Info size={18} />
              <strong>没有可用的受管 LoRA</strong>
              <span>请在本机设置中配置 LoRA 目录，将 safetensors 文件放入该目录后刷新。</span>
            </div>
          )}
          {catalog?.warnings.length ? (
            <details className="aq-lora-bindings__warnings">
              <summary><AlertTriangle size={14} />目录提示 · {catalog.warnings.length}</summary>
              <ul>{catalog.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
            </details>
          ) : null}
        </aside>

        <div className="aq-lora-bindings__workspace">
          <div className="aq-lora-bindings__section-heading">
            <div><strong>检查与登记</strong><small>{selectedModel ? selectedModel.name : '请选择一个受管文件'}</small></div>
            <ShieldCheck size={17} aria-hidden="true" />
          </div>
          <div className="aq-lora-bindings__form">
            <label>
              <span>目标底模家族</span>
              <select value={expectedFamily} onChange={(event) => setExpectedFamily(event.target.value as LoraBaseFamily)}>
                {LORA_BASE_FAMILIES.map((family) => <option value={family} key={family}>{FAMILY_LABELS[family]}</option>)}
              </select>
            </label>
            <label>
              <span>登记角色</span>
              <select value={role} onChange={(event) => setRole(event.target.value as 'style' | 'character')}>
                <option value="style">{ROLE_LABELS.style}</option>
                <option value="character">{ROLE_LABELS.character}</option>
              </select>
            </label>
            <label>
              <span>模型强度</span>
              <input type="number" min="-2" max="2" step="0.05" value={strength} onChange={(event) => setStrength(event.target.value)} />
            </label>
            <label>
              <span>CLIP 强度（可选）</span>
              <input type="number" min="-2" max="2" step="0.05" value={clipStrength} placeholder="留空沿用工作流" onChange={(event) => setClipStrength(event.target.value)} />
            </label>
            <label className="is-wide">
              <span>触发词（可选，用逗号或换行分隔）</span>
              <textarea value={triggerText} maxLength={1024} rows={2} placeholder="例如：aeon-character" onChange={(event) => setTriggerText(event.target.value)} />
            </label>
          </div>
          <div className="aq-lora-bindings__actions">
            <button type="button" className="is-primary" onClick={() => void inspectSelected()} disabled={!selectedModel || inspectionBusy || saving}>
              {inspectionBusy ? <LoaderCircle size={15} className="is-spinning" /> : <Search size={15} />}
              检查兼容性
            </button>
            <button type="button" onClick={() => void saveBinding()} disabled={!canSave || saving}>
              {saving ? <LoaderCircle size={15} className="is-spinning" /> : <Save size={15} />}
              保存绑定
            </button>
          </div>

          {inspectionDetails ? (
            <article className="aq-lora-bindings__inspection">
              <div className={'aq-lora-bindings__verdict ' + compatibilityClass(inspectionDetails.compatibility)}>
                <strong>{compatibilityLabel(inspectionDetails.compatibility)}</strong>
                <span>目标：{FAMILY_LABELS[expectedFamily]} · 实际：{familyLabel(inspectionDetails.family)}</span>
              </div>
              <dl>
                <div><dt>SHA-256</dt><dd><code>{inspectionDetails.sha256.slice(0, 16)}…</code></dd></div>
                <div><dt>文件大小</dt><dd>{formatBytes(inspectionDetails.bytes)}</dd></div>
                <div><dt>Tensor</dt><dd>{inspectionDetails.tensorCount}</dd></div>
                <div><dt>Rank</dt><dd>{inspectionDetails.rank ? inspectionDetails.rank.min === inspectionDetails.rank.max ? inspectionDetails.rank.min : inspectionDetails.rank.min + '–' + inspectionDetails.rank.max : '未识别'}</dd></div>
              </dl>
              {inspectionDetails.familyEvidence.length ? <p className="aq-lora-bindings__evidence">家族依据：{inspectionDetails.familyEvidence.join(' · ')}</p> : null}
              {inspectionDetails.warnings.length ? (
                <ul className="aq-lora-bindings__inspection-warnings">{inspectionDetails.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
              ) : null}
            </article>
          ) : (
            <div className="aq-lora-bindings__hint"><Search size={16} />字段改变后需要重新检查；格式和文件家族匹配后可保存绑定，完整张量适配与实际效果仍需受控执行验证。</div>
          )}

          <p className="aq-lora-bindings__training-note">本机训练暂未启用；当前可管理已有 LoRA，训练需先准备明确主题、授权素材和验证集。</p>
        </div>
      </div>

      <section className="aq-lora-bindings__saved" aria-labelledby="aq-lora-bindings-saved-title">
        <div className="aq-lora-bindings__section-heading">
          <div><strong id="aq-lora-bindings-saved-title">已登记绑定</strong><small>{bindings.length} 个</small></div>
          <FileKey2 size={17} aria-hidden="true" />
        </div>
        {bindings.length ? (
          <div className="aq-lora-bindings__saved-list">
            {bindings.map((record) => {
              const resolving = busy === 'resolve:' + record.binding.id
              return (
                <article key={record.binding.id} className="aq-lora-bindings__saved-card">
                  <div>
                    <strong>{record.modelName}</strong>
                    <small>{ROLE_LABELS[record.binding.role]} · {FAMILY_LABELS[record.binding.family]} · 强度 {record.binding.strength}</small>
                    <code title={record.binding.sha256}>{record.binding.sha256.slice(0, 16)}…</code>
                  </div>
                  <button type="button" onClick={() => void resolveBinding(record)} disabled={Boolean(busy)}>
                    {resolving ? <LoaderCircle size={14} className="is-spinning" /> : <ShieldCheck size={14} />}
                    复核并用于配方
                  </button>
                </article>
              )
            })}
          </div>
        ) : (
          <p className="aq-lora-bindings__empty aq-lora-bindings__saved-empty">还没有登记绑定。先从上方选择受管文件并完成兼容性检查。</p>
        )}
        {!onUseBinding && bindings.length ? <p className="aq-lora-bindings__saved-note">当前未连接配方应用入口，按钮会复核文件并保持登记，不会虚称已应用。</p> : null}
      </section>
    </section>
  )
}
