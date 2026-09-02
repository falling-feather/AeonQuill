import {
  AlertTriangle,
  Box,
  Check,
  CheckCircle2,
  CircleSlash2,
  Cpu,
  Download,
  ExternalLink,
  FileJson2,
  Gauge,
  HardDrive,
  Image as ImageIcon,
  LoaderCircle,
  PauseCircle,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  Video,
  Workflow,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  cancelWorkflowInstall,
  disableWorkflowPack,
  enableWorkflowPack,
  fetchWorkflowCenterCatalog,
  importCustomWorkflow,
  inspectCustomWorkflow,
  installWorkflowPack,
  removeCustomWorkflow,
  setCustomWorkflowEnabled,
  type CustomWorkflowInspection,
  type CustomWorkflowMappingRole,
  type CustomWorkflowMappings,
  type WorkflowCenterCatalog,
  type WorkflowPack,
} from '../../lib/workflowCenterApi'
import './workflow-center.css'

interface WorkflowCenterDialogProps {
  open: boolean
  onClose: () => void
  onOpenRuntimeSettings?: () => void
}

type WorkflowTab = 'builtin' | 'custom'
type WorkflowCategory = 'all' | 'video' | 'image'

const STATUS_LABELS: Record<WorkflowPack['status'], string> = {
  uninstalled: '未安装',
  'installed-disabled': '已安装 · 未启用',
  'enabled-sleeping': '已启用 · 休眠',
  waking: '正在唤醒',
  executable: '可执行',
  error: '异常',
}

const CUSTOM_MAPPING_ROLES: Array<{ id: CustomWorkflowMappingRole; label: string; required?: boolean }> = [
  { id: 'prompt', label: '正向提示词', required: true },
  { id: 'output', label: '最终输出', required: true },
  { id: 'negativePrompt', label: '负向提示词' },
  { id: 'sourceImage', label: '首帧 / 输入图' },
  { id: 'lastFrame', label: '末帧' },
  { id: 'seed', label: '随机种子' },
  { id: 'width', label: '宽度' },
  { id: 'height', label: '高度' },
  { id: 'frames', label: '帧数' },
  { id: 'steps', label: '采样步数' },
]

function readableBytes(value: number | null | undefined) {
  if (!value) return '无需自动下载'
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(value >= 10 * 1024 ** 3 ? 1 : 2)} GB`
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${Math.round(value / 1024)} KB`
}

function packIcon(pack: WorkflowPack) {
  if (pack.category === 'image') return ImageIcon
  if (pack.category === 'video-postprocess') return Sparkles
  return Video
}

function statusTone(pack: WorkflowPack) {
  if (pack.ready) return 'ready'
  if (pack.status === 'error') return 'danger'
  if (pack.status === 'enabled-sleeping' || pack.status === 'installed-disabled') return 'idle'
  return 'warning'
}

function mappingValue(nodeId: string, inputName: string) {
  return `${nodeId}|${inputName}`
}

function parseMappingValue(value: string) {
  const separator = value.indexOf('|')
  return separator < 0 ? null : { nodeId: value.slice(0, separator), inputName: value.slice(separator + 1) }
}

function externalLink(url: string, label: string) {
  return (
    <a href={url} target="_blank" rel="noreferrer">
      {label}<ExternalLink size={12} aria-hidden="true" />
    </a>
  )
}

export function WorkflowCenterDialog({ open, onClose, onOpenRuntimeSettings }: WorkflowCenterDialogProps) {
  const dialogRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const [tab, setTab] = useState<WorkflowTab>('builtin')
  const [category, setCategory] = useState<WorkflowCategory>('all')
  const [query, setQuery] = useState('')
  const [catalog, setCatalog] = useState<WorkflowCenterCatalog | null>(null)
  const [selectedPackId, setSelectedPackId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [licenseAccepted, setLicenseAccepted] = useState(false)
  const [diskAccepted, setDiskAccepted] = useState(false)
  const [customTitle, setCustomTitle] = useState('')
  const [customFilename, setCustomFilename] = useState('')
  const [customWorkflow, setCustomWorkflow] = useState<unknown>(null)
  const [customMappings, setCustomMappings] = useState<CustomWorkflowMappings>({})
  const [customInspection, setCustomInspection] = useState<CustomWorkflowInspection | null>(null)
  const [customInspectionStale, setCustomInspectionStale] = useState(false)

  const refresh = useCallback(async (force = false) => {
    setLoading(true)
    setError(null)
    try {
      const next = await fetchWorkflowCenterCatalog(force)
      setCatalog(next)
      setSelectedPackId((current) => next.packs.some(({ id }) => id === current) ? current : next.packs[0]?.id ?? null)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '工作流目录读取失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void refresh(true)
    setMessage(null)
    setError(null)
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus())
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
      ) ?? []).filter((element) => element.offsetParent !== null)
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousOverflow
      previousFocus?.focus()
    }
  }, [onClose, open, refresh])

  const activeInstall = useMemo(
    () => catalog?.jobs.find(({ status }) => status === 'queued' || status === 'running') ?? null,
    [catalog?.jobs],
  )

  useEffect(() => {
    if (!open || !activeInstall) return
    const timer = window.setInterval(() => void refresh(false), 900)
    return () => window.clearInterval(timer)
  }, [activeInstall, open, refresh])

  useEffect(() => {
    setLicenseAccepted(false)
    setDiskAccepted(false)
    setError(null)
    setMessage(null)
  }, [selectedPackId])

  const visiblePacks = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('zh-CN')
    return (catalog?.packs ?? []).filter((pack) => {
      const categoryMatch = category === 'all'
        || (category === 'video' ? pack.category.startsWith('video') : pack.category === 'image')
      const queryMatch = !needle || `${pack.title} ${pack.summary} ${pack.capabilities.join(' ')}`.toLocaleLowerCase('zh-CN').includes(needle)
      return categoryMatch && queryMatch
    })
  }, [catalog?.packs, category, query])

  const selectedPack = catalog?.packs.find(({ id }) => id === selectedPackId) ?? visiblePacks[0] ?? null

  const selectedRegistryWarnings = useMemo(() => {
    const selectedRootIds = new Set(
      selectedPack?.artifacts.flatMap((artifact) => artifact.location ? [artifact.location.rootId] : []) ?? [],
    )
    const grouped = new Map<string, number>()
    for (const warning of catalog?.registry.warnings ?? []) {
      if (warning.rootId && !selectedRootIds.has(warning.rootId)) continue
      grouped.set(warning.message, (grouped.get(warning.message) ?? 0) + 1)
    }
    return [...grouped].map(([message, count]) => count > 1 ? `${message}（${count} 个相关目录）` : message)
  }, [catalog?.registry.warnings, selectedPack])

  const run = async (key: string, action: () => Promise<unknown>, success: string) => {
    setBusy(key)
    setError(null)
    setMessage(null)
    try {
      await action()
      setMessage(success)
      await refresh(true)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '工作流操作失败')
    } finally {
      setBusy(null)
    }
  }

  const installSelected = async () => {
    if (!selectedPack) return
    const acceptedIds = selectedPack.acceptedLicense || !selectedPack.license.acceptanceRequired || licenseAccepted
      ? selectedPack.requiredLicenseIds
      : []
    await run(
      `install:${selectedPack.id}`,
      () => installWorkflowPack(selectedPack, acceptedIds),
      `“${selectedPack.title}”已进入受控安装队列。`,
    )
  }

  const selectCustomFile = async (file: File | null) => {
    setError(null)
    setMessage(null)
    setCustomInspection(null)
    setCustomInspectionStale(false)
    setCustomMappings({})
    setCustomWorkflow(null)
    if (!file) return
    if (file.size > 2 * 1024 * 1024) {
      setError('自定义工作流 JSON 不能超过 2MB。')
      return
    }
    try {
      const parsed = JSON.parse(await file.text())
      setCustomFilename(file.name)
      setCustomTitle(file.name.replace(/\.json$/iu, '').slice(0, 120))
      setCustomWorkflow(parsed)
      setBusy('custom-inspect')
      const inspection = await inspectCustomWorkflow(parsed, {})
      setCustomInspection(inspection)
      setCustomInspectionStale(false)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '无法读取 JSON 文件')
    } finally {
      setBusy(null)
    }
  }

  const updateMapping = (role: CustomWorkflowMappingRole, value: string) => {
    setCustomInspectionStale(true)
    setCustomMappings((current) => {
      const next = { ...current }
      if (!value) delete next[role]
      else if (role === 'output') next.output = { nodeId: value }
      else {
        const parsed = parseMappingValue(value)
        if (parsed) next[role] = parsed
      }
      return next
    })
  }

  const inspectSelectedCustom = async () => {
    if (!customWorkflow) return
    await run('custom-inspect', async () => {
      const inspection = await inspectCustomWorkflow(customWorkflow, customMappings)
      setCustomInspection(inspection)
      setCustomInspectionStale(false)
      if (!inspection.canImport) throw new Error('安全检查尚未通过，请按检查项修正映射或工作流。')
    }, '工作流通过当前阶段的静态安全检查；导入时会启动 ComfyUI 复核真实节点。')
  }

  const importSelectedCustom = async () => {
    if (!customWorkflow || !customInspection?.canImport || customInspectionStale) return
    await run('custom-import', async () => {
      await importCustomWorkflow(customTitle, customWorkflow, customMappings)
      setCustomWorkflow(null)
      setCustomFilename('')
      setCustomTitle('')
      setCustomMappings({})
      setCustomInspection(null)
      setCustomInspectionStale(false)
    }, '自定义工作流已通过真实节点复检并加入受控目录。')
  }

  if (!open) return null

  return (
    <div className="aq-workflow-center-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section ref={dialogRef} className="aq-workflow-center" role="dialog" aria-modal="true" aria-labelledby="aq-workflow-center-title">
        <header className="aq-workflow-center__header">
          <div className="aq-workflow-center__brand">
            <span><Workflow size={21} /></span>
            <div>
              <p>LOCAL CAPABILITY ORCHESTRATION</p>
              <h2 id="aq-workflow-center-title">工作流中心</h2>
              <small>能力按需安装；模型、节点、许可和硬件状态全部可追踪。</small>
            </div>
          </div>
          <div className="aq-workflow-center__header-actions">
            <button type="button" onClick={() => void refresh(true)} disabled={loading}>
              <RefreshCw size={15} className={loading ? 'is-spinning' : undefined} />{loading ? '检测中' : '重新检测'}
            </button>
            <button ref={closeRef} type="button" className="is-close" onClick={onClose} aria-label="关闭工作流中心"><X size={20} /></button>
          </div>
        </header>

        <div className="aq-workflow-center__summary" aria-label="本机工作流摘要">
          <article><Cpu size={17} /><span><strong>{catalog?.hardware.device ?? '显卡待检测'}</strong><small>{catalog?.hardware.vramGb ? `${catalog.hardware.vramGb.toFixed(1)}GB 显存` : '启动检测后给出推荐'}</small></span></article>
          <article><HardDrive size={17} /><span><strong>{catalog?.storage.configured ? '运行时目录已登记' : '尚未配置运行时'}</strong><small>{catalog?.storage.configured ? `${catalog.storage.modelRoots} 个模型根 · ${catalog.storage.sharedRoots} 个共享根` : '下载只写入受控 ComfyUI/models 相对目录'}</small></span></article>
          <article><Gauge size={17} /><span><strong>{catalog?.runtime.connected ? `ComfyUI ${catalog.runtime.comfyVersion ?? ''}` : 'ComfyUI 当前休眠'}</strong><small>{catalog?.runtime.pytorchVersion ?? '按需启动，不常驻显存'}</small></span></article>
          <article><ShieldCheck size={17} /><span><strong>{catalog ? `${catalog.packs.filter(({ installed }) => installed).length}/${catalog.packs.length} 已安装 · ${catalog.packs.filter(({ ready }) => ready).length} 可执行` : '能力状态待检测'}</strong><small>休眠、未启用、唤醒、可执行与异常分别显示</small></span></article>
        </div>

        {(error || message) ? (
          <div className={`aq-workflow-center__feedback ${error ? 'is-error' : 'is-success'}`} role={error ? 'alert' : 'status'}>
            {error ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
            <span>{error ?? message}</span>
          </div>
        ) : null}

        <div className="aq-workflow-center__tabs" role="tablist" aria-label="工作流类型">
          <button type="button" role="tab" aria-selected={tab === 'builtin'} className={tab === 'builtin' ? 'is-active' : ''} onClick={() => setTab('builtin')}><Box size={15} />内置能力包</button>
          <button type="button" role="tab" aria-selected={tab === 'custom'} className={tab === 'custom' ? 'is-active' : ''} onClick={() => setTab('custom')}><FileJson2 size={15} />自定义 ComfyUI JSON</button>
        </div>

        {tab === 'builtin' ? (
          <div className="aq-workflow-center__body">
            <aside className="aq-workflow-center__catalog">
              <div className="aq-workflow-center__search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索能力、场景或模型" /></div>
              <div className="aq-workflow-center__filters" aria-label="工作流分类">
                {([['all', '全部'], ['video', '视频'], ['image', '图像']] as const).map(([id, label]) => (
                  <button key={id} type="button" className={category === id ? 'is-active' : ''} onClick={() => setCategory(id)}>{label}</button>
                ))}
              </div>
              <div className="aq-workflow-center__pack-list">
                {visiblePacks.map((pack) => {
                  const Icon = packIcon(pack)
                  return (
                    <button key={pack.id} type="button" className={`aq-workflow-pack-card ${pack.id === selectedPack?.id ? 'is-selected' : ''}`} onClick={() => setSelectedPackId(pack.id)}>
                      <span className="aq-workflow-pack-card__icon"><Icon size={18} /></span>
                      <span className="aq-workflow-pack-card__copy"><strong>{pack.title}</strong><small>{pack.summary}</small><em className={`is-${statusTone(pack)}`}>{STATUS_LABELS[pack.status]}</em></span>
                      {pack.recommendation.level === 'recommended' ? <i>推荐</i> : null}
                    </button>
                  )
                })}
                {!loading && !visiblePacks.length ? <p className="aq-workflow-center__empty">没有符合当前筛选的能力包。</p> : null}
              </div>
            </aside>

            <main className="aq-workflow-center__inspector">
              {selectedPack ? (
                <>
                  <div className="aq-workflow-inspector__heading">
                    <div><span className={`is-${statusTone(selectedPack)}`}>{STATUS_LABELS[selectedPack.status]}</span><h3>{selectedPack.title}</h3><p>{selectedPack.summary}</p></div>
                    <em className={`is-${selectedPack.recommendation.level}`}>{selectedPack.recommendation.label}</em>
                  </div>
                  <div className="aq-workflow-inspector__facts">
                    <span><b>{selectedPack.minVramGb}GB</b>最低显存</span>
                    <span><b>{selectedPack.minSystemRamGb}GB</b>最低内存</span>
                    <span><b>{readableBytes(selectedPack.downloadBytes)}</b>仍需下载</span>
                    <span><b>{selectedPack.estimatedMinutes}</b>预估生成</span>
                  </div>

                  <section className="aq-workflow-inspector__section">
                    <header><div><h4>依赖与完整性</h4><p>自动文件使用固定 SHA-256；手工扩展必须由运行时复检。</p></div><span>{selectedPack.artifacts.filter(({ present }) => present).length}/{selectedPack.artifacts.length}</span></header>
                    <div className="aq-workflow-artifacts">
                      {selectedPack.artifacts.map((artifact) => (
                        <article key={artifact.id}>
                          <span className={`is-${artifact.status}`}>{artifact.verified ? <Check size={14} /> : artifact.present ? <PauseCircle size={14} /> : <CircleSlash2 size={14} />}</span>
                          <div>
                            <strong>{artifact.label}</strong>
                            <small>{artifact.automatic ? `${readableBytes(artifact.bytes)} · ${artifact.present ? '已发现' : '待下载'}` : artifact.instruction ?? '手工依赖'}</small>
                            {artifact.location ? <small title={artifact.location.rootLabel}>{artifact.location.shared ? '共享根' : '当前运行时'} · {artifact.location.rootLabel}</small> : null}
                            {artifact.expectedSha256 ? <small title={artifact.expectedSha256}>SHA-256 {artifact.expectedSha256.slice(0, 12)}… · {artifact.verified ? '已校验' : artifact.present ? '启用时校验' : '登记值'}</small> : null}
                          </div>
                          {externalLink(artifact.sourceUrl, '来源')}
                        </article>
                      ))}
                    </div>
                    {selectedRegistryWarnings.map((warning) => <p key={warning} className="aq-workflow-inspector__warning">{warning}</p>)}
                    {selectedPack.missingNodes.length ? <p className="aq-workflow-inspector__warning">当前节点表还缺：{selectedPack.missingNodes.join('、')}</p> : null}
                    {selectedPack.runtimeIssues.map((issue) => <p key={issue} className="aq-workflow-inspector__warning">{issue}</p>)}
                  </section>

                  <section className="aq-workflow-inspector__license">
                    <div><ShieldCheck size={17} /><span><strong>{selectedPack.license.name}</strong><small>{selectedPack.license.notice}</small></span>{externalLink(selectedPack.license.sourceUrl, '查看条款')}</div>
                    {selectedPack.license.acceptanceRequired && !selectedPack.acceptedLicense ? (
                      <label><input type="checkbox" checked={licenseAccepted} onChange={(event) => setLicenseAccepted(event.target.checked)} />我已阅读上游条款，并确认适用地区、署名与商业使用责任。</label>
                    ) : null}
                    {selectedPack.downloadBytes > 0 && !selectedPack.installed ? (
                      <label><input type="checkbox" checked={diskAccepted} onChange={(event) => setDiskAccepted(event.target.checked)} />我确认最多下载 {readableBytes(selectedPack.downloadBytes)}；分片和模型写入已配置的运行时磁盘。</label>
                    ) : null}
                  </section>

                  {selectedPack.activeJob ? (
                    <section className="aq-workflow-install-progress">
                      <div><strong>{selectedPack.activeJob.status === 'waiting-user' ? '等待手工依赖' : '安装进行中'}</strong><span>{selectedPack.activeJob.progress}%</span></div>
                      <progress value={selectedPack.activeJob.progress} max={100} />
                      <p>{readableBytes(selectedPack.activeJob.downloadedBytes)} / {readableBytes(selectedPack.activeJob.totalBytes)} · {selectedPack.activeJob.phase}</p>
                      {selectedPack.activeJob.manualMissing?.map((item) => <p key={item.id}>{item.instruction} {externalLink(item.sourceUrl, '打开来源')}</p>)}
                      {['queued', 'running'].includes(selectedPack.activeJob.status) ? <button type="button" onClick={() => void run(`cancel:${selectedPack.activeJob?.id}`, () => cancelWorkflowInstall(selectedPack.activeJob!.id), '已发送取消请求；续传分片会保留。')}>取消安装</button> : null}
                    </section>
                  ) : null}

                  <footer className="aq-workflow-inspector__actions">
                    {!catalog?.storage.configured ? (
                      <button type="button" className="is-primary" onClick={() => { onClose(); onOpenRuntimeSettings?.() }}><HardDrive size={15} />先配置本机运行时</button>
                    ) : selectedPack.enabled ? (
                      <button type="button" onClick={() => void run(`disable:${selectedPack.id}`, () => disableWorkflowPack(selectedPack.id), `“${selectedPack.title}”已停用；模型文件保留。`)} disabled={Boolean(busy)}><PauseCircle size={15} />停用能力</button>
                    ) : selectedPack.installed && selectedPack.integrityVerified ? (
                      <button type="button" className="is-primary" onClick={() => void run(`enable:${selectedPack.id}`, () => enableWorkflowPack(selectedPack.id), `“${selectedPack.title}”已启用。`)} disabled={Boolean(busy)}><Play size={15} />启用能力</button>
                    ) : (
                      <button
                        type="button"
                        className="is-primary"
                        onClick={() => void installSelected()}
                        disabled={Boolean(busy) || Boolean(selectedPack.activeJob && ['queued', 'running'].includes(selectedPack.activeJob.status)) || (selectedPack.license.acceptanceRequired && !selectedPack.acceptedLicense && !licenseAccepted) || (selectedPack.downloadBytes > 0 && !selectedPack.installed && !diskAccepted)}
                      >
                        {busy === `install:${selectedPack.id}` ? <LoaderCircle size={15} className="is-spinning" /> : <Download size={15} />}
                        {selectedPack.installed ? '校验并启用' : selectedPack.downloadBytes > 0 ? '下载并安装' : '登记并查看步骤'}
                      </button>
                    )}
                    <small>停用不会删除模型；删除与共享模型清理由后续存储管理器单独确认。</small>
                  </footer>
                </>
              ) : <p className="aq-workflow-center__empty">选择一个能力包查看详情。</p>}
            </main>
          </div>
        ) : (
          <div className="aq-custom-workflow">
            <section className="aq-custom-workflow__import">
              <header><div><h3>导入受控 API 工作流</h3><p>只接受 ComfyUI“保存（API 格式）”；界面 JSON、未知节点与任意路径会被拒绝。</p></div><ShieldCheck size={19} /></header>
              <label className="aq-custom-workflow__file">
                <input type="file" accept="application/json,.json" onChange={(event) => void selectCustomFile(event.target.files?.[0] ?? null)} />
                <Upload size={20} /><span><strong>{customFilename || '选择 ComfyUI API JSON'}</strong><small>上限 2MB；导入后仍不会获得文件系统或网络权限</small></span>
              </label>
              {customWorkflow ? (
                <>
                  <label className="aq-custom-workflow__title"><span>工作流名称</span><input value={customTitle} maxLength={120} onChange={(event) => setCustomTitle(event.target.value)} /></label>
                  <div className="aq-custom-workflow__mappings">
                    {CUSTOM_MAPPING_ROLES.map(({ id, label, required }) => (
                      <label key={id}>
                        <span>{label}{required ? <b>*</b> : null}</span>
                        <select
                          value={id === 'output' ? customMappings.output?.nodeId ?? '' : customMappings[id] ? mappingValue(customMappings[id]!.nodeId, customMappings[id]!.inputName ?? '') : ''}
                          onChange={(event) => updateMapping(id, event.target.value)}
                        >
                          <option value="">{required ? '请选择' : '不映射'}</option>
                          {id === 'output'
                            ? customInspection?.candidates.outputs.map((candidate) => <option key={candidate.nodeId} value={candidate.nodeId}>{candidate.nodeId} · {candidate.nodeType}</option>)
                            : customInspection?.candidates.inputs.map((candidate) => <option key={`${candidate.nodeId}-${candidate.inputName}`} value={mappingValue(candidate.nodeId, candidate.inputName)}>{candidate.nodeId} · {candidate.nodeType}.{candidate.inputName}</option>)}
                        </select>
                      </label>
                    ))}
                  </div>
                  <div className="aq-custom-workflow__actions">
                    <button type="button" onClick={() => void inspectSelectedCustom()} disabled={Boolean(busy)}>{busy === 'custom-inspect' ? <LoaderCircle size={15} className="is-spinning" /> : <Search size={15} />}安全检查</button>
                    <button type="button" className="is-primary" onClick={() => void importSelectedCustom()} disabled={Boolean(busy) || !customInspection?.canImport || customInspectionStale || !customTitle.trim()}>{busy === 'custom-import' ? <LoaderCircle size={15} className="is-spinning" /> : <Check size={15} />}复检并导入</button>
                  </div>
                </>
              ) : null}
            </section>

            <aside className="aq-custom-workflow__report">
              <header><h3>安全检查报告</h3><span>{customInspection ? `${customInspection.nodeCount} 节点` : '等待文件'}</span></header>
              {customInspection ? (
                <>
                  <div className={`aq-custom-workflow__verdict ${customInspection.canImport && !customInspectionStale ? 'is-ready' : 'is-blocked'}`}>
                    {customInspection.canImport && !customInspectionStale ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
                    <span><strong>{customInspectionStale ? '映射已变更，请重新检查' : customInspection.canImport ? '静态检查通过' : '当前禁止导入'}</strong><small>SHA-256 {customInspection.hash.slice(0, 12)}… · {customInspection.nodeTypes.length} 种节点</small></span>
                  </div>
                  <ul>{customInspection.findings.map((finding, index) => <li key={`${finding.code}-${index}`} className={`is-${finding.severity}`}><span>{finding.code}</span><p>{finding.message}</p></li>)}</ul>
                  {!customInspection.findings.length ? <p className="aq-workflow-center__empty">未发现静态风险；导入时仍会启动 ComfyUI 核对真实节点注册表。</p> : null}
                  {customInspection.models.length ? <div className="aq-custom-workflow__models"><strong>模型引用</strong>{customInspection.models.map((model) => <code key={model}>{model}</code>)}</div> : null}
                </>
              ) : <p className="aq-workflow-center__empty">选择文件后先生成节点、路径、网络和映射报告。</p>}
            </aside>

            <section className="aq-custom-workflow__saved">
              <header><div><h3>已导入工作流</h3><p>启用前每次按当前 ComfyUI 节点表重检；此阶段不会直接执行任意 JSON。</p></div><FileJson2 size={18} /></header>
              <div>
                {(catalog?.customWorkflows ?? []).map((workflow) => (
                  <article key={workflow.id}>
                    <span className={workflow.enabled ? 'is-ready' : 'is-idle'}><FileJson2 size={16} /></span>
                    <div><strong>{workflow.title}</strong><small>{workflow.nodeCount} 节点 · {workflow.hash.slice(0, 10)}…</small></div>
                    <button type="button" onClick={() => void run(`custom-toggle:${workflow.id}`, () => setCustomWorkflowEnabled(workflow.id, !workflow.enabled), workflow.enabled ? '自定义工作流已停用。' : '自定义工作流已通过节点复检并启用。')} disabled={Boolean(busy)}>{workflow.enabled ? '停用' : '启用'}</button>
                    <button type="button" className="is-danger" onClick={() => void run(`custom-remove:${workflow.id}`, () => removeCustomWorkflow(workflow.id), '自定义工作流登记已删除。')} disabled={Boolean(busy)} aria-label={`删除 ${workflow.title}`}><Trash2 size={14} /></button>
                  </article>
                ))}
                {!catalog?.customWorkflows.length ? <p className="aq-workflow-center__empty">尚未导入自定义工作流。</p> : null}
              </div>
            </section>
          </div>
        )}
      </section>
    </div>
  )
}
