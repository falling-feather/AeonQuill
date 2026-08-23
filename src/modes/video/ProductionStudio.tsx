import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  Clock3,
  Download,
  Loader2,
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
  createVideoProductionCommand,
  createVideoProductionProject,
  productionProgress,
  serializeVideoProductionProject,
  type VideoProductionCommandType,
  type VideoProductionNode,
  type VideoProductionNodeStatus,
  type VideoProductionProject,
} from '../../lib/story/productionPipeline.mjs'
import type { FrameStrategy, StoryAspectRatio, StorySourceKind } from '../../lib/story/storyProject.mjs'
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

export function ProductionStudio({ active, runtimeLabel, onBridgeToStory }: ProductionStudioProps) {
  const [project, setProject] = useState<VideoProductionProject>(() => createVideoProductionProject())
  const [selectedNodeId, setSelectedNodeId] = useState('screenwriter')
  const [brief, setBrief] = useState(project.brief)
  const [durationMinutes, setDurationMinutes] = useState(project.settings.durationMinutes)
  const [genre, setGenre] = useState(project.settings.genre)
  const [aspectRatio, setAspectRatio] = useState<StoryAspectRatio>(project.settings.aspectRatio)
  const [instructionsDraft, setInstructionsDraft] = useState('')
  const [outputDraft, setOutputDraft] = useState('')
  const [notice, setNotice] = useState('剧本大纲等待用户审批；未批准节点不会越级。')
  const sequenceRef = useRef(1)

  const selectedNode = project.nodes.find((node) => node.id === selectedNodeId) ?? project.nodes[0]
  const progress = useMemo(() => productionProgress(project), [project])
  const canBridge = useMemo(() => canBridgeProductionToStory(project), [project])
  const hasReviewGate = project.nodes.some((node) => node.status === 'review')
  const nodeById = useMemo(() => new Map(project.nodes.map((node) => [node.id, node])), [project.nodes])

  useEffect(() => {
    setInstructionsDraft(selectedNode.instructions)
    setOutputDraft(selectedNode.outputSummary)
  }, [selectedNode.id, selectedNode.instructions, selectedNode.outputSummary])

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
      setProject(next)
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
      setProject(next)
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
      const next = createVideoProductionProject({ brief, durationMinutes, genre, aspectRatio, now: Date.now() })
      setProject(next)
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
            <button type="button" onClick={createProject}><Sparkles size={15} /> 建立生产图</button>
          </div>
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
          <p><strong>执行边界</strong> 当前多智能体层是本地、确定性、可审批的编排状态机；文本模型和语音 Adapter 尚未连接。只有“分镜导演”产物获批后，镜头才可同步到既有严格 StoryProject，并继续经过 H3 执行清单、帧资产、显存和固定工作流复检。</p>
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

        <div className="aq-production-node-actions">
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
