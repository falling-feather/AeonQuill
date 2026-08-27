import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  Clock3,
  Download,
  Loader2,
  KeyRound,
  Pause,
  Play,
  RefreshCw,
  Save,
  ShieldCheck,
  Sparkles,
  Square,
  Users,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  VideoProductionError,
  advanceVideoProduction,
  applyVideoProductionCommand,
  canBridgeProductionToStory,
  createApprovedStorySource,
  createLocalAgentProposal,
  createVideoProductionCommand,
  createVideoProductionProposalCommand,
  createVideoProductionProject,
  productionProgress,
  serializeVideoProductionProject,
  type VideoProductionCommandType,
  type VideoProductionNode,
  type VideoProductionNodeStatus,
  type VideoProductionProject,
  type VideoGenerationMode,
  type VideoCharacterMode,
} from '../../lib/story/productionPipeline.mjs'
import type { FrameStrategy, StoryAspectRatio, StorySourceKind } from '../../lib/story/storyProject.mjs'
import {
  clearTextAgentAdapter,
  configureTextAgentAdapter,
  fetchAgentAdapterStatus,
  requestAgentProposal,
  type AgentAdapterStatus,
} from '../../lib/agentAdapterApi'
import './production-studio.css'

export type ApprovedProductionStorySource = {
  title: string
  kind: StorySourceKind
  text: string
  aspectRatio: StoryAspectRatio
  frameStrategy: FrameStrategy
  defaultShotSeconds: number
}

type ProductionStudioProps = {
  active: boolean
  runtimeLabel: string
  project: VideoProductionProject
  onProjectChange: (project: VideoProductionProject) => void
  onBridgeToStory: (source: ApprovedProductionStorySource) => void
}

const STATUS_META: Record<VideoProductionNodeStatus, { label: string; tone: string }> = {
  waiting: { label: '等待依赖', tone: 'muted' },
  ready: { label: '可开始', tone: 'ready' },
  running: { label: '运行中', tone: 'running' },
  paused: { label: '已暂停', tone: 'paused' },
  review: { label: '待用户审批', tone: 'review' },
  approved: { label: '已批准', tone: 'approved' },
  revision: { label: '需返工', tone: 'revision' },
  failed: { label: '失败', tone: 'failed' },
}

function messageOf(error: unknown) {
  if (error instanceof VideoProductionError) return `${error.code} · ${error.message}`
  return error instanceof Error ? error.message : '制片命令执行失败'
}

function formatProductionHours(lowMinutes: number, highMinutes: number) {
  return `${Math.round(lowMinutes / 60)}–${Math.round(highMinutes / 60)} 小时`
}

function downloadProject(project: VideoProductionProject) {
  const blob = new Blob([serializeVideoProductionProject(project, { pretty: true })], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${project.id}.aeon-production.json`
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

function NodeStatusIcon({ status }: { status: VideoProductionNodeStatus }) {
  if (status === 'approved') return <CheckCircle2 size={14} />
  if (status === 'running') return <Loader2 size={14} className="is-spinning" />
  if (status === 'paused') return <Pause size={14} />
  if (status === 'review') return <Clock3 size={14} />
  if (status === 'failed' || status === 'revision') return <AlertTriangle size={14} />
  return <CircleDashed size={14} />
}

export function ProductionStudio({ active, runtimeLabel, project, onProjectChange, onBridgeToStory }: ProductionStudioProps) {
  const [selectedNodeId, setSelectedNodeId] = useState('screenwriter')
  const [brief, setBrief] = useState(project.brief)
  const [durationMinutes, setDurationMinutes] = useState(project.settings.durationMinutes)
  const [genre, setGenre] = useState(project.settings.genre)
  const [aspectRatio, setAspectRatio] = useState<StoryAspectRatio>(project.settings.aspectRatio)
  const [generationMode, setGenerationMode] = useState<VideoGenerationMode>(project.settings.generationMode)
  const [characterMode, setCharacterMode] = useState<VideoCharacterMode>(project.settings.characterMode)
  const [instructionsDraft, setInstructionsDraft] = useState('')
  const [outputDraft, setOutputDraft] = useState('')
  const [notice, setNotice] = useState('剧本大纲等待用户审批；未批准节点不会越级。')
  const sequenceRef = useRef(1)
  const projectRef = useRef(project)
  const [adapterStatus, setAdapterStatus] = useState<AgentAdapterStatus>({ text: { configured: false, persistence: 'memory-only' } })
  const [adapterBusy, setAdapterBusy] = useState<'load' | 'save' | 'clear' | 'propose' | null>('load')
  const [adapterNotice, setAdapterNotice] = useState('密钥只驻留本次 sidecar 内存，关闭应用即清除。')
  const [adapterForm, setAdapterForm] = useState<{
    providerLabel: string
    endpoint: string
    model: string
    apiKey: string
    jsonMode: 'json-object' | 'prompt-only'
    timeoutMs: number
  }>({
    providerLabel: 'OpenAI-compatible',
    endpoint: '',
    model: '',
    apiKey: '',
    jsonMode: 'json-object',
    timeoutMs: 60_000,
  })

  const selectedNode = project.nodes.find((node) => node.id === selectedNodeId) ?? project.nodes[0]
  const progress = useMemo(() => productionProgress(project), [project])
  const canBridge = useMemo(() => canBridgeProductionToStory(project), [project])
  const hasReviewGate = project.nodes.some((node) => node.status === 'review')
  const nodeById = useMemo(() => new Map(project.nodes.map((node) => [node.id, node])), [project.nodes])
  const selectedChangeCards = useMemo(
    () => project.changeCards.filter((card) => card.nodeId === selectedNode.id).slice().reverse(),
    [project.changeCards, selectedNode.id],
  )

  useEffect(() => {
    projectRef.current = project
  }, [project])

  useEffect(() => {
    let disposed = false
    void fetchAgentAdapterStatus()
      .then((status) => {
        if (!disposed) setAdapterStatus(status)
      })
      .catch((error) => {
        if (!disposed) setAdapterNotice(messageOf(error))
      })
      .finally(() => {
        if (!disposed) setAdapterBusy(null)
      })
    return () => { disposed = true }
  }, [])

  useEffect(() => {
    setInstructionsDraft(selectedNode.instructions)
    setOutputDraft(selectedNode.outputSummary)
  }, [selectedNode.id, selectedNode.instructions, selectedNode.outputSummary])

  useEffect(() => {
    setBrief(project.brief)
    setDurationMinutes(project.settings.durationMinutes)
    setGenre(project.settings.genre)
    setAspectRatio(project.settings.aspectRatio)
    setGenerationMode(project.settings.generationMode)
    setCharacterMode(project.settings.characterMode)
  }, [project.id])

  const execute = (
    type: VideoProductionCommandType,
    payload: Record<string, unknown> = {},
    successMessage?: string,
  ) => {
    try {
      const command = createVideoProductionCommand(project, type, payload, {
        id: `production-ui-${sequenceRef.current++}`,
        actor: 'user',
      })
      const next = applyVideoProductionCommand(project, command, { now: Math.max(Date.now(), project.updatedAt) })
      onProjectChange(next)
      setNotice(successMessage ?? '制片状态已更新。')
      return next
    } catch (error) {
      setNotice(messageOf(error))
      return null
    }
  }

  const runNext = () => {
    try {
      const next = advanceVideoProduction(project, { now: Math.max(Date.now(), project.updatedAt) })
      onProjectChange(next)
      const nextProgress = productionProgress(next)
      if (nextProgress.currentNodeId) setSelectedNodeId(nextProgress.currentNodeId)
      setNotice(next.nodes.find((node) => node.status === 'running')
        ? '下一节点已开始；再次点击会提交当前节点的本地示范产物供审批。'
        : '当前节点已提交审批。')
    } catch (error) {
      setNotice(messageOf(error))
    }
  }

  const createProject = () => {
    try {
      const next = createVideoProductionProject({ brief, durationMinutes, genre, aspectRatio, generationMode, characterMode, now: Date.now() })
      onProjectChange(next)
      setSelectedNodeId('screenwriter')
      setNotice('已建立新的本地生产图；剧本设计节点等待用户审批。')
    } catch (error) {
      setNotice(messageOf(error))
    }
  }

  const saveNodeEdit = () => {
    execute('node.edit', {
      nodeId: selectedNode.id,
      instructions: instructionsDraft,
      outputSummary: outputDraft,
    }, '已保存人工编辑；任何受影响的下游节点均已标记过期。')
  }

  const requestLocalProposal = () => {
    try {
      const command = createVideoProductionProposalCommand(
        project,
        selectedNode.id,
        createLocalAgentProposal(project, selectedNode.id),
        { id: `production-ui-${sequenceRef.current++}`, actor: 'orchestrator' },
      )
      const next = applyVideoProductionCommand(project, command, { now: Math.max(Date.now(), project.updatedAt) })
      onProjectChange(next)
      setNotice('本地角色智能体已生成变更卡；正式节点尚未改变，请接受或拒绝。')
    } catch (error) {
      setNotice(messageOf(error))
    }
  }

  const configureAdapter = async () => {
    setAdapterBusy('save')
    try {
      const status = await configureTextAgentAdapter(adapterForm)
      setAdapterStatus(status)
      setAdapterForm((current) => ({ ...current, apiKey: '' }))
      setAdapterNotice('文本适配器已在本次运行中启用；密钥未写入浏览器或项目。')
    } catch (error) {
      setAdapterNotice(messageOf(error))
    } finally {
      setAdapterBusy(null)
    }
  }

  const clearAdapter = async () => {
    setAdapterBusy('clear')
    try {
      const status = await clearTextAgentAdapter()
      setAdapterStatus(status)
      setAdapterNotice('本次运行中的文本 API 密钥已从 sidecar 内存清除。')
    } catch (error) {
      setAdapterNotice(messageOf(error))
    } finally {
      setAdapterBusy(null)
    }
  }

  const requestByokProposal = async () => {
    const baseRevision = project.revision
    setAdapterBusy('propose')
    try {
      const result = await requestAgentProposal(project, selectedNode.id)
      const current = projectRef.current
      if (current.revision !== baseRevision) {
        setAdapterNotice('模型返回期间生产项目已变化；提案未写入，请重新请求。')
        return
      }
      const command = createVideoProductionProposalCommand(current, selectedNode.id, result.proposal, {
        id: `production-ui-${sequenceRef.current++}`,
        actor: 'orchestrator',
      })
      const next = applyVideoProductionCommand(current, command, { now: Math.max(Date.now(), current.updatedAt) })
      onProjectChange(next)
      setAdapterNotice(`${result.adapter.providerLabel} · ${result.adapter.model} 已返回变更卡${result.usage?.totalTokens !== null && result.usage?.totalTokens !== undefined ? ` · ${result.usage.totalTokens} tokens` : ''}；尚未修改正式节点。`)
    } catch (error) {
      setAdapterNotice(messageOf(error))
    } finally {
      setAdapterBusy(null)
    }
  }

  const bridgeToStory = () => {
    try {
      onBridgeToStory(createApprovedStorySource(project))
      setNotice('已把审批后的 120 镜头脚本同步到严格故事/分镜工作区。')
    } catch (error) {
      setNotice(messageOf(error))
    }
  }

  return (
    <section
      className={`aq-production-studio${active ? '' : ' is-hidden'}`}
      aria-label="多智能体制片工作室"
      hidden={!active}
    >
      <div className="aq-production-main">
        <header className="aq-production-heading">
          <div>
            <p>多智能体制片工作室</p>
            <h2>{project.title}</h2>
          </div>
          <dl>
            <div><dt>总时长</dt><dd>{project.settings.durationMinutes} min</dd></div>
            <div><dt>场景</dt><dd>{project.estimates.sceneCount}</dd></div>
            <div><dt>镜头</dt><dd>约 {project.estimates.shotCount}</dd></div>
            <div><dt>生成批次</dt><dd>{project.estimates.batchCount}</dd></div>
            <div><dt>生产策略</dt><dd>{project.settings.generationMode === 'quality' ? '质量' : '极速'} / {project.settings.characterMode === 'professional' ? '专业人物' : '快速人物'}</dd></div>
            <div className="is-wide"><dt>4060 · 720P 单卡生成</dt><dd>{formatProductionHours(project.estimates.generationMinutesLow, project.estimates.generationMinutesHigh)}</dd></div>
          </dl>
        </header>

        <section className="aq-production-brief" aria-label="制片需求">
          <label>
            <span>创作需求</span>
            <textarea value={brief} maxLength={4_000} onChange={(event) => setBrief(event.target.value)} />
          </label>
          <div>
            <label><span>分钟</span><input type="number" min={1} max={30} value={durationMinutes} onChange={(event) => setDurationMinutes(event.target.valueAsNumber)} /></label>
            <label><span>类型</span><input value={genre} maxLength={40} onChange={(event) => setGenre(event.target.value)} /></label>
            <label><span>画幅</span><select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value as StoryAspectRatio)}><option value="16:9">16:9</option><option value="9:16">9:16</option><option value="1:1">1:1</option></select></label>
            <label><span>生成方案</span><select value={generationMode} onChange={(event) => setGenerationMode(event.target.value as VideoGenerationMode)}><option value="fast">极速 · 全链预演</option><option value="quality">质量 · 母版精修</option></select></label>
            <label><span>人物方案</span><select value={characterMode} onChange={(event) => setCharacterMode(event.target.value as VideoCharacterMode)}><option value="quick">快速 · 单立绘</option><option value="professional">专业 · 三视图/服饰状态</option></select></label>
            <button type="button" onClick={createProject}><Sparkles size={15} /> 建立生产图</button>
          </div>
          <aside className="aq-production-recommendation">
            <strong>系统建议：{project.settings.recommendation.generationMode === 'quality' ? '质量' : '极速'} + {project.settings.recommendation.characterMode === 'professional' ? '专业人物' : '快速人物'}</strong>
            <span>当前选择由你决定；建议不会静默覆盖。</span>
            {project.settings.recommendation.reasons.map((reason) => <small key={reason}>{reason}</small>)}
          </aside>
        </section>

        <section className="aq-production-control-bar" aria-label="全局生产控制">
          <div className="aq-production-progress">
            <span>总体进度</span>
            <div><i style={{ width: `${progress.percent}%` }} /></div>
            <strong>{progress.percent}% · {progress.approved}/{progress.total} 已批准</strong>
          </div>
          <div className="aq-production-blocker">
            <span>当前门禁</span>
            <strong>{progress.blocker ?? '无；可运行下一节点'}</strong>
          </div>
          <label className="aq-production-auto">
            <span>自动推进</span>
            <input
              type="checkbox"
              checked={project.autoAdvance}
              onChange={(event) => execute('project.patch', { autoAdvance: event.target.checked }, event.target.checked ? '已启用：批准后自动启动下一个可运行节点。' : '已关闭自动推进。')}
            />
          </label>
          <button
            type="button"
            className="is-secondary"
            onClick={() => execute(project.globalPaused ? 'project.resume' : 'project.pause', {}, project.globalPaused ? '全链路已恢复。' : '全链路已安全暂停。')}
          >{project.globalPaused ? <Play size={15} /> : <Pause size={15} />}{project.globalPaused ? '恢复全链路' : '暂停全链路'}</button>
          <button type="button" className="is-primary" onClick={runNext} disabled={project.globalPaused || hasReviewGate}><Play size={15} /> {hasReviewGate ? '等待节点审批' : '运行下一节点'}</button>
        </section>

        <div className="aq-production-track-wrap">
          <div className="aq-production-track" role="list" aria-label="制片智能体依赖图">
            {project.nodes.map((node, index) => {
              const meta = STATUS_META[node.status]
              return (
                <article
                  key={node.id}
                  role="listitem"
                  className={`${node.id === selectedNode.id ? 'is-selected' : ''} is-${meta.tone}`.trim()}
                  onClick={() => setSelectedNodeId(node.id)}
                >
                  <header>
                    <span>{node.order}</span>
                    <strong>{node.title}</strong>
                    {index < project.nodes.length - 1 ? <ChevronRight className="aq-production-arrow" size={16} /> : null}
                  </header>
                  <span className={`aq-production-node-status is-${meta.tone}`}><NodeStatusIcon status={node.status} />{meta.label}</span>
                  <p>{node.purpose}</p>
                  <div>
                    <small>产物</small>
                    <code>{node.artifact}</code>
                  </div>
                  <footer>
                    <small>{node.stale ? '下游过期' : node.outputSummary ? `revision ${node.revision}` : '尚无产物'}</small>
                    <span>{node.adapter}</span>
                  </footer>
                </article>
              )
            })}
          </div>
        </div>

        <div className={`aq-production-notice ${notice.includes('INVALID') || notice.includes('失败') || notice.includes('不能') ? 'is-error' : ''}`} role="status">
          <ShieldCheck size={15} />
          <span>{notice}</span>
        </div>

        <section className="aq-production-truth">
          <ShieldCheck size={16} />
          <p><strong>执行边界</strong> 本地角色建议与可选 BYOK 文本模型都只能生成结构化变更卡；密钥仅驻留本次 sidecar 内存，提案未经用户接受不会改写节点。只有“分镜导演”产物获批后，镜头才可同步到严格 StoryProject，并继续经过 H3 执行清单、帧资产、显存和固定工作流复检。</p>
          <button type="button" onClick={() => downloadProject(project)}><Download size={14} /> 导出生产图</button>
          <button type="button" className="is-bridge" disabled={!canBridge} onClick={bridgeToStory}><Check size={14} /> 同步已批分镜</button>
        </section>
      </div>

      <aside className="aq-production-inspector" aria-label="当前制片节点">
        <div className="aq-production-inspector-title">
          <span>当前节点 {selectedNode.order} / {project.nodes.length}</span>
          <span className={`aq-production-node-status is-${STATUS_META[selectedNode.status].tone}`}><NodeStatusIcon status={selectedNode.status} />{STATUS_META[selectedNode.status].label}</span>
        </div>
        <h3>{selectedNode.title}</h3>
        <p className="aq-production-role"><Users size={14} /> {selectedNode.role} · {selectedNode.adapter}</p>

        <section className="aq-production-dependencies">
          <span>依赖节点</span>
          <div>{selectedNode.dependsOn.length ? selectedNode.dependsOn.map((dependencyId) => {
            const dependency = nodeById.get(dependencyId)
            return <span key={dependencyId} className={dependency?.status === 'approved' ? 'is-approved' : ''}>{dependency?.order} {dependency?.title}<small>{dependency ? STATUS_META[dependency.status].label : '未知'}</small></span>
          }) : <span className="is-approved">无前置依赖<small>可独立执行</small></span>}</div>
        </section>

        {selectedNode.id === 'character-designer' ? (
          <section className="aq-production-character-sessions" aria-label="人物一致性会话">
            <span>人物一致性会话 · {project.settings.characterMode === 'professional' ? '专业' : '快速'}</span>
            {project.characterProfiles.map((profile) => (
              <article key={profile.id}>
                <header><strong>{profile.name}</strong><small>{profile.status === 'approved' ? '已批准' : '待完善'} · revision {profile.revision}</small></header>
                <p>{profile.identityLock}</p>
                <div>{profile.views.map((view) => <span key={view.id}>{view.view === 'front' ? '正面' : view.view === 'side' ? '侧面' : view.view === 'back' ? '背面' : view.view}<small>{view.status}</small></span>)}</div>
                <footer>{profile.wardrobeStates.map((wardrobe) => <span key={wardrobe.id}>{wardrobe.label}<small>{wardrobe.trigger}</small></span>)}</footer>
              </article>
            ))}
          </section>
        ) : null}

        <label className="aq-production-editor-field">
          <span>执行指令（可编辑）</span>
          <textarea value={instructionsDraft} maxLength={4_000} onChange={(event) => setInstructionsDraft(event.target.value)} />
          <small>{instructionsDraft.length} / 4,000</small>
        </label>
        <label className="aq-production-editor-field">
          <span>输出摘要（可编辑）</span>
          <textarea value={outputDraft} maxLength={12_000} onChange={(event) => setOutputDraft(event.target.value)} />
          <small>{outputDraft.length} / 12,000</small>
        </label>

        <section className="aq-production-history">
          <span>节点记录</span>
          <div>
            {project.events.filter((event) => event.nodeId === selectedNode.id || event.nodeId === null).slice(-4).reverse().map((event) => (
              <p key={event.id}><i /><span>{event.message}<small>{new Date(event.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</small></span></p>
            ))}
          </div>
        </section>

        <section className="aq-production-change-cards" aria-label="节点变更卡">
          <div><span>结构化变更卡</span><small>{selectedChangeCards.filter((card) => card.status === 'proposed').length} 待处理</small></div>
          {selectedChangeCards.length ? selectedChangeCards.slice(0, 4).map((card) => (
            <article key={card.id} className={`is-${card.status}`}>
              <header><strong>{card.title}</strong><span>{card.source === 'byok-text' ? 'BYOK' : '本地'} · {card.status}</span></header>
              <p>{card.rationale}</p>
              {card.proposedOutputSummary ? <small>{card.proposedOutputSummary}</small> : null}
              {card.status === 'proposed' ? (
                <footer>
                  <button type="button" onClick={() => execute('proposal.reject', { cardId: card.id }, '变更卡已拒绝；正式节点未改变。')}>拒绝</button>
                  <button type="button" className="is-accept" onClick={() => execute('proposal.accept', { cardId: card.id }, '变更卡已接受；节点进入审批，下游已失效。')}>接受变更</button>
                </footer>
              ) : null}
            </article>
          )) : <p className="is-empty">还没有提案。智能体只能先创建卡片，不能静默覆盖节点。</p>}
        </section>

        <section className="aq-production-adapter" aria-label="BYOK 文本智能体">
          <header>
            <span><KeyRound size={14} /> BYOK 文本智能体</span>
            <b className={adapterStatus.text.configured ? 'is-ready' : ''}>{adapterBusy === 'load' ? '读取中' : adapterStatus.text.configured ? '本次运行已启用' : '未配置'}</b>
          </header>
          {adapterStatus.text.configured ? (
            <div className="aq-production-adapter-summary">
              <strong>{adapterStatus.text.providerLabel} · {adapterStatus.text.model}</strong>
              <small>{adapterStatus.text.endpointLabel} · 内存临时密钥</small>
            </div>
          ) : null}
          <div className="aq-production-adapter-form">
            <label><span>名称</span><input value={adapterForm.providerLabel} maxLength={80} onChange={(event) => setAdapterForm((current) => ({ ...current, providerLabel: event.target.value }))} /></label>
            <label><span>HTTPS 接口基址</span><input value={adapterForm.endpoint} placeholder="https://provider.example/v1" spellCheck={false} onChange={(event) => setAdapterForm((current) => ({ ...current, endpoint: event.target.value }))} /></label>
            <label><span>模型</span><input value={adapterForm.model} placeholder="model-id" spellCheck={false} onChange={(event) => setAdapterForm((current) => ({ ...current, model: event.target.value }))} /></label>
            <label><span>API Key</span><input type="password" value={adapterForm.apiKey} autoComplete="off" placeholder="只驻留本次运行内存" onChange={(event) => setAdapterForm((current) => ({ ...current, apiKey: event.target.value }))} /></label>
            <label><span>JSON 模式</span><select value={adapterForm.jsonMode} onChange={(event) => setAdapterForm((current) => ({ ...current, jsonMode: event.target.value as 'json-object' | 'prompt-only' }))}><option value="json-object">JSON object</option><option value="prompt-only">仅提示约束</option></select></label>
          </div>
          <p role="status">{adapterNotice}</p>
          <footer>
            {adapterStatus.text.configured ? <button type="button" onClick={() => void clearAdapter()} disabled={adapterBusy !== null}>{adapterBusy === 'clear' ? <Loader2 size={13} className="is-spinning" /> : null}清除会话密钥</button> : null}
            <button type="button" className="is-save" onClick={() => void configureAdapter()} disabled={adapterBusy !== null || !adapterForm.endpoint.trim() || !adapterForm.model.trim() || !adapterForm.apiKey.trim()}>{adapterBusy === 'save' ? <Loader2 size={13} className="is-spinning" /> : <KeyRound size={13} />}{adapterStatus.text.configured ? '替换配置' : '仅本次运行启用'}</button>
          </footer>
        </section>

        <div className="aq-production-node-actions">
          {!['waiting', 'failed'].includes(selectedNode.status) ? <button type="button" className="is-agent" onClick={requestLocalProposal}><Sparkles size={14} /> 请求本地建议</button> : null}
          {adapterStatus.text.configured && !['waiting', 'failed'].includes(selectedNode.status) ? <button type="button" className="is-byok" onClick={() => void requestByokProposal()} disabled={adapterBusy !== null}>{adapterBusy === 'propose' ? <Loader2 size={14} className="is-spinning" /> : <KeyRound size={14} />} 请求 BYOK 建议</button> : null}
          {selectedNode.status === 'ready' || selectedNode.status === 'revision' ? <button type="button" onClick={() => execute('node.start', { nodeId: selectedNode.id }, `${selectedNode.title}已开始。`)}><Play size={14} /> 开始节点</button> : null}
          {selectedNode.status === 'running' ? <button type="button" onClick={() => execute('node.pause', { nodeId: selectedNode.id }, `${selectedNode.title}已暂停。`)}><Pause size={14} /> 暂停节点</button> : null}
          {selectedNode.status === 'paused' ? <button type="button" onClick={() => execute('node.resume', { nodeId: selectedNode.id }, `${selectedNode.title}已恢复。`)}><Play size={14} /> 恢复节点</button> : null}
          {selectedNode.status === 'running' || selectedNode.status === 'paused' || selectedNode.status === 'revision' ? <button type="button" onClick={() => execute('node.submit-review', { nodeId: selectedNode.id, outputSummary: outputDraft || `${selectedNode.title}已形成待审核产物。` }, `${selectedNode.title}已提交审批。`)}><Square size={14} /> 提交审批</button> : null}
          {selectedNode.status === 'failed' ? <button type="button" onClick={() => execute('node.reset', { nodeId: selectedNode.id }, `${selectedNode.title}已重置。`)}><RefreshCw size={14} /> 重置节点</button> : null}
          <button type="button" onClick={saveNodeEdit}><Save size={14} /> 保存编辑</button>
          {(selectedNode.status === 'review' || selectedNode.status === 'approved') ? <button type="button" className="is-revision" onClick={() => execute('node.request-revision', { nodeId: selectedNode.id }, `${selectedNode.title}已退回返工。`)}><RefreshCw size={14} /> 要求返工</button> : null}
          {selectedNode.status === 'review' ? <button type="button" className="is-approve" onClick={() => execute('node.approve', { nodeId: selectedNode.id }, `${selectedNode.title}已批准；下游门禁已重新计算。`)}><Check size={14} /> 批准并继续</button> : null}
        </div>

        <div className="aq-production-runtime-note">
          <ShieldCheck size={14} />
          <p><strong>{runtimeLabel}</strong><span>编排本身不启动 ComfyUI；只有真实素材/H3 节点执行时才进入共享 GPU 队列。</span></p>
        </div>
      </aside>
    </section>
  )
}

export default ProductionStudio
