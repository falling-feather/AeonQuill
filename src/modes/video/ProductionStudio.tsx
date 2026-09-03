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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ProcessingJob } from '../../types'
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
import { continuityGraphSummary } from '../../lib/story/continuityGraph.mjs'
import type { FrameStrategy, StoryAspectRatio, StorySourceKind } from '../../lib/story/storyProject.mjs'
import type { LibraryAsset, LibraryAssetInsertion } from '../../lib/libraryApi'
import { flushWorkspaceModeDocument } from '../../lib/projectApi'
import { cancelVideoJob, createSoundRenderJob, retryVideoJob } from '../../lib/videoApi'
import {
  clearTextAgentAdapter,
  configureTextAgentAdapter,
  fetchAgentAdapterStatus,
  requestAgentProposal,
  type AgentAdapterStatus,
} from '../../lib/agentAdapterApi'
import { GenerationAdaptersPanel, type VideoCandidateContext } from './GenerationAdaptersPanel'
import { SoundTimelinePanel } from './SoundTimelinePanel'
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
  workspaceProjectId?: string
  workspaceDocumentId?: string
  project: VideoProductionProject
  onProjectChange: (project: VideoProductionProject) => void
  onBridgeToStory: (source: ApprovedProductionStorySource) => void
  libraryAsset?: LibraryAssetInsertion
  onLibraryAssetConsumed?: (nonce: number) => void
  jobs: ProcessingJob[]
  onJobTracked: (job: ProcessingJob) => void
}

type ContinuitySlotView = {
  id: string
  group: '人物视图' | '服饰状态' | '地点基准' | '镜头帧'
  title: string
  detail: string
  status: 'planned' | 'ready' | 'approved'
  assetHash: string | null
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

const REVIEW_DIMENSIONS = [
  ['identity', '身份一致'],
  ['wardrobe', '服饰连续'],
  ['location', '场景连续'],
  ['sharpness', '清晰度'],
  ['motion', '运动质量'],
] as const

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

export function ProductionStudio({ active, runtimeLabel, workspaceProjectId, workspaceDocumentId, project, onProjectChange, onBridgeToStory, libraryAsset, onLibraryAssetConsumed, jobs, onJobTracked }: ProductionStudioProps) {
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
  const [continuityTargetId, setContinuityTargetId] = useState<string | null>(null)
  const [soundTargetId, setSoundTargetId] = useState<string | null>(null)
  const [candidateTargetShotId, setCandidateTargetShotId] = useState<string | null>(null)
  const [continuityGroup, setContinuityGroup] = useState<ContinuitySlotView['group']>('人物视图')
  const [continuityPage, setContinuityPage] = useState(0)
  const [continuityShotId, setContinuityShotId] = useState(project.continuityGraph.shots[0]?.id ?? '')
  const [reviewDecision, setReviewDecision] = useState<'accept' | 'retry'>('accept')
  const [reviewNotes, setReviewNotes] = useState('')
  const [reviewScores, setReviewScores] = useState({ identity: 4, wardrobe: 4, location: 4, sharpness: 4, motion: 4 })
  const sequenceRef = useRef(1)
  const projectRef = useRef(project)
  const consumedLibraryAssetRef = useRef<number | null>(null)
  const consumedSoundBindingsRef = useRef(new Set<string>())
  const [soundJobBusy, setSoundJobBusy] = useState<'prepare-speech' | 'render-mix' | 'cancel' | 'retry' | null>(null)
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
  const continuitySummary = useMemo(() => continuityGraphSummary(project.continuityGraph), [project.continuityGraph])
  const continuityShot = project.continuityGraph.shots.find(({ id }) => id === continuityShotId) ?? project.continuityGraph.shots[0] ?? null
  const continuitySlots = useMemo<ContinuitySlotView[]>(() => {
    const graph = project.continuityGraph
    const characters = new Map(graph.characters.map((character) => [character.id, character]))
    const shots = new Map(graph.shots.map((shot) => [shot.id, shot]))
    return [
      ...graph.views.map((slot) => ({
        id: slot.id,
        group: '人物视图' as const,
        title: `${characters.get(slot.characterId)?.name ?? '角色'} · ${slot.view === 'front' ? '正面' : slot.view === 'side' ? '侧面' : slot.view === 'back' ? '背面' : slot.view}`,
        detail: slot.required ? '必需参考' : '可选参考',
        status: slot.status,
        assetHash: slot.asset?.contentHash ?? null,
      })),
      ...graph.wardrobes.map((slot) => ({
        id: slot.id,
        group: '服饰状态' as const,
        title: `${characters.get(slot.characterId)?.name ?? '角色'} · ${slot.label}`,
        detail: slot.trigger,
        status: slot.status,
        assetHash: slot.asset?.contentHash ?? null,
      })),
      ...graph.locations.map((slot) => ({
        id: slot.id,
        group: '地点基准' as const,
        title: slot.name,
        detail: slot.visualPrompt,
        status: slot.status,
        assetHash: slot.asset?.contentHash ?? null,
      })),
      ...graph.frames.map((slot) => ({
        id: slot.id,
        group: '镜头帧' as const,
        title: `${shots.get(slot.shotId)?.label ?? '镜头'} · ${slot.role === 'first-frame' ? '首帧' : '尾帧'}`,
        detail: slot.required ? '质量模式必需' : '极速模式可选',
        status: slot.status,
        assetHash: slot.asset?.contentHash ?? null,
      })),
    ]
  }, [project.continuityGraph])
  const filteredContinuitySlots = continuitySlots.filter(({ group }) => group === continuityGroup)
  const continuityPageCount = Math.max(1, Math.ceil(filteredContinuitySlots.length / 24))
  const pagedContinuitySlots = filteredContinuitySlots.slice(continuityPage * 24, continuityPage * 24 + 24)
  const continuityLatestReview = continuityShot?.latestReviewId
    ? project.continuityGraph.reviews.find(({ id }) => id === continuityShot.latestReviewId) ?? null
    : null
  const continuityCandidates = useMemo(() => continuityShot
    ? project.continuityGraph.candidates.filter(({ shotId }) => shotId === continuityShot.id)
    : [], [continuityShot, project.continuityGraph.candidates])
  const continuityLatestCandidate = continuityLatestReview?.candidateId
    ? project.continuityGraph.candidates.find(({ id }) => id === continuityLatestReview.candidateId) ?? null
    : null
  const videoCandidateContext: VideoCandidateContext | undefined = continuityShot && continuityShot.status !== 'blocked'
    ? {
        shotId: continuityShot.id,
        inputFingerprint: continuityShot.inputFingerprint,
        generationMode: project.settings.generationMode,
      }
    : undefined
  const canBridge = useMemo(() => canBridgeProductionToStory(project), [project])
  const hasReviewGate = project.nodes.some((node) => node.status === 'review')
  const nodeById = useMemo(() => new Map(project.nodes.map((node) => [node.id, node])), [project.nodes])
  const selectedChangeCards = useMemo(
    () => project.changeCards.filter((card) => card.nodeId === selectedNode.id).slice().reverse(),
    [project.changeCards, selectedNode.id],
  )
  const soundJobs = useMemo(() => jobs.filter((job) => (
    job.kind === 'sound-render'
    && job.request
    && 'documentId' in job.request
    && job.request.documentId === workspaceDocumentId
  )), [jobs, workspaceDocumentId])

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

  useEffect(() => {
    if (!continuityShotId && project.continuityGraph.shots[0]) setContinuityShotId(project.continuityGraph.shots[0].id)
  }, [continuityShotId, project.continuityGraph.shots])

  useEffect(() => {
    if (continuityPage >= continuityPageCount) setContinuityPage(Math.max(0, continuityPageCount - 1))
  }, [continuityPage, continuityPageCount])

  const execute = useCallback((
    type: VideoProductionCommandType,
    payload: Record<string, unknown> = {},
    successMessage?: string,
  ) => {
    try {
      const current = projectRef.current
      const command = createVideoProductionCommand(current, type, payload, {
        id: `production-ui-${sequenceRef.current++}`,
        actor: 'user',
      })
      const next = applyVideoProductionCommand(current, command, { now: Math.max(Date.now(), current.updatedAt) })
      projectRef.current = next
      onProjectChange(next)
      setNotice(successMessage ?? '制片状态已更新。')
      return next
    } catch (error) {
      setNotice(messageOf(error))
      return null
    }
  }, [onProjectChange])

  useEffect(() => {
    let next = projectRef.current
    let applied = 0
    for (const job of soundJobs) {
      for (const generated of job.soundRenderMetadata?.generatedBindings ?? []) {
        const bindingKey = `${job.id}:${generated.cueId}:${generated.contentHash}`
        if (consumedSoundBindingsRef.current.has(bindingKey)) continue
        const cue = next.soundTimeline.audioCues.find(({ id }) => id === generated.cueId)
        if (!cue || cue.fingerprint !== generated.cueFingerprint || cue.asset !== null) {
          consumedSoundBindingsRef.current.add(bindingKey)
          continue
        }
        try {
          const command = createVideoProductionCommand(next, 'sound.asset.bind', {
            cueId: cue.id,
            binding: {
              libraryItemId: generated.libraryItemId,
              libraryVersionId: generated.libraryVersionId,
              contentHash: generated.contentHash,
              mimeType: generated.mimeType,
              scope: generated.scope,
              boundAt: generated.boundAt,
            },
          }, {
            id: `production-sound-${sequenceRef.current++}`,
            actor: 'orchestrator',
          })
          next = applyVideoProductionCommand(next, command, { now: Math.max(Date.now(), next.updatedAt) })
          consumedSoundBindingsRef.current.add(bindingKey)
          applied += 1
        } catch (error) {
          setNotice(messageOf(error))
        }
      }
    }
    if (applied) {
      projectRef.current = next
      onProjectChange(next)
      setNotice(`已把 ${applied} 条 TTS 产物回填到声音时间线；请逐条试听并人工批准。`)
    }
  }, [onProjectChange, soundJobs])

  const submitSoundJob = async (action: 'prepare-speech' | 'render-mix', options: { format?: 'mp3' | 'wav'; speechBudgetUsd?: number } = {}) => {
    if (!workspaceProjectId || !workspaceDocumentId) {
      setNotice('当前智能视频尚未写入 SQLite 项目，不能创建受管声音任务。')
      return
    }
    setSoundJobBusy(action)
    try {
      await flushWorkspaceModeDocument(workspaceDocumentId)
      const current = projectRef.current
      const identity = {
        action,
        projectId: workspaceProjectId,
        documentId: workspaceDocumentId,
        productionRevision: current.revision,
        soundTimelineRevision: current.soundTimeline.revision,
        title: `${current.title} · ${action === 'prepare-speech' ? '批量配音' : '混音字幕'}`.slice(0, 120),
      } as const
      const job = action === 'prepare-speech'
        ? await createSoundRenderJob({
            ...identity,
            action,
            format: options.format ?? 'mp3',
            speechBudgetUsd: options.speechBudgetUsd ?? 5,
          }, { priority: 38 })
        : await createSoundRenderJob({ ...identity, action }, { priority: 42 })
      onJobTracked(job)
      setNotice(action === 'prepare-speech'
        ? '批量配音已进入统一 Job；每条成品会自动回填，但仍需你试听批准。'
        : '混音与字幕已进入统一 CPU Job；完成后可作为成片输入。')
    } catch (error) {
      setNotice(messageOf(error))
    } finally {
      setSoundJobBusy(null)
    }
  }

  const cancelSoundJob = async (jobId: string) => {
    setSoundJobBusy('cancel')
    try {
      onJobTracked(await cancelVideoJob(jobId))
      setNotice('声音任务已取消；已写入的不可变配音资源仍保留。')
    } catch (error) {
      setNotice(messageOf(error))
    } finally {
      setSoundJobBusy(null)
    }
  }

  const retrySoundJob = async (jobId: string) => {
    setSoundJobBusy('retry')
    try {
      onJobTracked(await retryVideoJob(jobId))
      setNotice('声音任务已重新排队；若时间线已变化，服务端会拒绝旧输入。')
    } catch (error) {
      setNotice(messageOf(error))
    } finally {
      setSoundJobBusy(null)
    }
  }

  useEffect(() => {
    if (!active || !libraryAsset || consumedLibraryAssetRef.current === libraryAsset.nonce) return
    if (!continuityTargetId && !soundTargetId && !candidateTargetShotId) {
      setNotice('资源已就绪。请先选择连续性图片槽位、声音时间线槽位或镜头视频候选，再完成绑定。')
      return
    }
    consumedLibraryAssetRef.current = libraryAsset.nonce
    const asset = libraryAsset.asset
    try {
      const binding = {
        libraryItemId: asset.id,
        libraryVersionId: asset.version.id,
        contentHash: asset.version.assetId,
        mimeType: asset.version.mimeType,
        scope: asset.relationship === 'project-owned' ? 'project' : 'global-reference',
        boundAt: Math.max(Date.now(), project.updatedAt),
      }
      if (soundTargetId) {
        if (asset.mediaKind !== 'audio') throw new Error('声音时间线槽位只接受资源库中的音频资产')
        if (!['audio/mpeg', 'audio/wav'].includes(asset.version.mimeType)) throw new Error('声音时间线仅支持 MP3 或 WAV')
        const next = execute('sound.asset.bind', { cueId: soundTargetId, binding }, `已把“${asset.title}”绑定到声音时间线；请试听后人工批准。`)
        if (next) setSoundTargetId(null)
      } else if (candidateTargetShotId) {
        if (asset.mediaKind !== 'video') throw new Error('镜头候选只接受资源库中的视频资产')
        if (!['video/mp4', 'video/webm'].includes(asset.version.mimeType)) throw new Error('镜头候选仅支持 MP4 或 WebM')
        const currentShot = projectRef.current.continuityGraph.shots.find(({ id }) => id === candidateTargetShotId)
        if (!currentShot) throw new Error('目标镜头已不存在')
        const next = execute('continuity.candidate.register', {
          shotId: currentShot.id,
          label: asset.title.slice(0, 160),
          source: 'imported',
          generationMode: projectRef.current.settings.generationMode,
          inputFingerprint: currentShot.inputFingerprint,
          binding,
        }, `已把“${asset.title}”登记为镜头候选；请显式选择后再复核。`)
        if (next) setCandidateTargetShotId(null)
      } else {
        if (asset.mediaKind !== 'image') throw new Error('连续性槽位只接受资源库中的图片资产')
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(asset.version.mimeType)) throw new Error('连续性槽位仅支持 PNG、JPEG 或 WebP')
        const next = execute('continuity.asset.bind', { targetId: continuityTargetId, binding }, `已把“${asset.title}”绑定到连续性槽位；请检查后人工批准。`)
        if (next) setContinuityTargetId(null)
      }
    } catch (error) {
      setNotice(messageOf(error))
    } finally {
      onLibraryAssetConsumed?.(libraryAsset.nonce)
    }
    // 资源投递按 nonce 消费一次；项目变化由命令回填，不能导致重复绑定。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, libraryAsset?.nonce, candidateTargetShotId, continuityTargetId, soundTargetId])

  const chooseContinuityAsset = (targetId: string) => {
    setSoundTargetId(null)
    setCandidateTargetShotId(null)
    setContinuityTargetId(targetId)
    setNotice('槽位已选中。请打开页面顶部“资源库”，选择一个图片版本并点击“插入当前模式”。')
  }

  const chooseSoundAsset = (cueId: string) => {
    setContinuityTargetId(null)
    setCandidateTargetShotId(null)
    setSoundTargetId(cueId)
    setNotice('音频槽位已选中。请打开页面顶部“资源库”，选择 MP3/WAV 明确版本并点击“插入当前模式”。')
  }

  const chooseCandidateAsset = (shotId: string) => {
    setContinuityTargetId(null)
    setSoundTargetId(null)
    setCandidateTargetShotId(shotId)
    setNotice('镜头候选入口已选中。请从页面顶部“资源库”插入 MP4/WebM 明确版本。')
  }

  const registerGeneratedVideoCandidate = useCallback((asset: LibraryAsset, context: VideoCandidateContext) => {
    const binding = {
      libraryItemId: asset.id,
      libraryVersionId: asset.version.id,
      contentHash: asset.version.assetId,
      mimeType: asset.version.mimeType,
      scope: asset.relationship === 'project-owned' ? 'project' : 'global-reference',
      boundAt: Math.max(Date.now(), projectRef.current.updatedAt),
    }
    execute('continuity.candidate.register', {
      shotId: context.shotId,
      label: asset.title.slice(0, 160),
      source: 'byok-video',
      generationMode: context.generationMode,
      inputFingerprint: context.inputFingerprint,
      binding,
    }, `“${asset.title}”已入库并登记为镜头候选；请显式选择后人工复核。`)
  }, [execute])

  const submitContinuityReview = () => {
    if (!continuityShot) return
    execute('continuity.review.record', {
      shotId: continuityShot.id,
      reviewerId: 'local-user',
      scores: reviewScores,
      decision: reviewDecision,
      notes: reviewNotes,
    }, reviewDecision === 'accept' ? '已接受当前镜头；这是人工结论，不是自动评分阈值。' : '已登记定向重生；只需重跑当前镜头。')
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

        {selectedNode.id === 'character-designer' || selectedNode.id === 'asset-producer' ? (
          <section className="aq-continuity-assets" aria-label="连续性资产槽位">
            <header>
              <div>
                <span>连续性资产图</span>
                <small>{continuitySummary.approvedAssets}/{continuitySummary.requiredAssets} 个必需资产已批准</small>
              </div>
              <b>{continuitySummary.blockedShots} 镜头受阻</b>
            </header>
            <p>先选定槽位，再从页面顶部“资源库”插入明确版本。项目只保存资源 ID、版本与内容哈希，不保存临时 URL。</p>
            <label className="aq-continuity-filter">
              <span>资产组</span>
              <select value={continuityGroup} onChange={(event) => { setContinuityGroup(event.target.value as ContinuitySlotView['group']); setContinuityPage(0) }}>
                {(['人物视图', '服饰状态', '地点基准', '镜头帧'] as const).map((group) => (
                  <option key={group} value={group}>{group} · {continuitySlots.filter((slot) => slot.group === group).length}</option>
                ))}
              </select>
            </label>
            <div className="aq-continuity-slot-list">
              {pagedContinuitySlots.length ? pagedContinuitySlots.map((slot) => (
                <article key={slot.id} className={`is-${slot.status}${continuityTargetId === slot.id ? ' is-target' : ''}`} data-continuity-target={slot.id}>
                  <div>
                    <strong>{slot.title}</strong>
                    <small>{slot.detail}</small>
                    {slot.assetHash ? <code>sha256:{slot.assetHash.slice(0, 12)}…</code> : null}
                  </div>
                  <span>{slot.status === 'approved' ? '已批准' : slot.status === 'ready' ? '待批准' : '待绑定'}</span>
                  <footer>
                    <button type="button" className={continuityTargetId === slot.id ? 'is-selected' : ''} onClick={() => chooseContinuityAsset(slot.id)}>{slot.assetHash ? '替换版本' : '选择资源'}</button>
                    {slot.status === 'ready' ? <button type="button" className="is-approve" onClick={() => execute('continuity.asset.approve', { targetId: slot.id }, `已批准“${slot.title}”。`)}>批准</button> : null}
                    {slot.status !== 'planned' ? <button type="button" onClick={() => execute('continuity.asset.unbind', { targetId: slot.id }, `已移除“${slot.title}”；相关镜头复核已失效。`)}>移除</button> : null}
                  </footer>
                </article>
              )) : <p className="is-empty">当前故事尚未生成这一类资产槽位。</p>}
            </div>
            {continuityPageCount > 1 ? (
              <footer className="aq-continuity-pagination">
                <button type="button" disabled={continuityPage === 0} onClick={() => setContinuityPage((page) => Math.max(0, page - 1))}>上一页</button>
                <span>{continuityPage + 1} / {continuityPageCount}</span>
                <button type="button" disabled={continuityPage + 1 >= continuityPageCount} onClick={() => setContinuityPage((page) => Math.min(continuityPageCount - 1, page + 1))}>下一页</button>
              </footer>
            ) : null}
          </section>
        ) : null}

        {(selectedNode.id === 'video-director' || selectedNode.id === 'quality-controller') && project.continuityGraph.shots.length ? (
          <section className="aq-continuity-review" aria-label="镜头人工复核">
            <header>
              <div><span>镜头候选与人工复核</span><small>候选不自动覆盖 · 未校准 · 人工决定</small></div>
              <b>{continuitySummary.approvedShots}/{continuitySummary.shots} 已接受 · {continuitySummary.currentCandidates} 当前候选</b>
            </header>
            <label>
              <span>镜头</span>
              <select value={continuityShot?.id ?? ''} onChange={(event) => setContinuityShotId(event.target.value)}>
                {project.continuityGraph.shots.map((shot) => <option key={shot.id} value={shot.id}>{shot.label} · {shot.status}</option>)}
              </select>
            </label>
            {continuityShot ? (
              <>
                {continuityShot.characterBindings.map((binding) => {
                  const character = project.continuityGraph.characters.find(({ id }) => id === binding.characterId)
                  const wardrobes = project.continuityGraph.wardrobes.filter(({ characterId }) => characterId === binding.characterId)
                  return (
                    <label key={binding.characterId}>
                      <span>{character?.name ?? '角色'}服饰</span>
                      <select value={binding.wardrobeId} onChange={(event) => execute('continuity.wardrobe.assign', { shotId: continuityShot.id, characterId: binding.characterId, wardrobeId: event.target.value }, '已切换镜头服饰；旧复核如受影响已自动失效。')}>
                        {wardrobes.map((wardrobe) => <option key={wardrobe.id} value={wardrobe.id}>{wardrobe.label} · {wardrobe.status}</option>)}
                      </select>
                    </label>
                  )
                })}
                <section className="aq-continuity-candidates" aria-label="当前镜头视频候选">
                  <header>
                    <div>
                      <strong>视频候选池</strong>
                      <small>{continuityCandidates.length} 个历史版本；上游变化后旧候选保留但不可误用</small>
                    </div>
                    <button
                      type="button"
                      className={candidateTargetShotId === continuityShot.id ? 'is-selected' : ''}
                      disabled={continuityShot.status === 'blocked'}
                      onClick={() => chooseCandidateAsset(continuityShot.id)}
                    >{candidateTargetShotId === continuityShot.id ? '等待资源库视频' : '从资源库添加候选'}</button>
                  </header>
                  <div>
                    {continuityCandidates.length ? continuityCandidates.map((candidate) => {
                      const stale = candidate.inputFingerprint !== continuityShot.inputFingerprint
                      const selected = candidate.id === continuityShot.selectedCandidateId
                      const sourceLabel = candidate.source === 'comfyui-h3' ? '本地 H3' : candidate.source === 'byok-video' ? 'BYOK 视频' : '资源库导入'
                      return (
                        <article key={candidate.id} className={`${selected ? 'is-current' : ''}${stale ? ' is-stale' : ''}`} data-video-candidate={candidate.id}>
                          <div>
                            <strong>#{candidate.attempt} · {candidate.label}</strong>
                            <small>{sourceLabel} · {candidate.generationMode === 'quality' ? '质量模式' : '极速模式'} · {stale ? '输入已变化' : '匹配当前输入'}</small>
                            <code>sha256:{candidate.asset.contentHash.slice(0, 12)}…</code>
                          </div>
                          <span>{selected ? '当前选择' : stale ? '历史/过期' : '可选择'}</span>
                          <button
                            type="button"
                            disabled={selected || stale || continuityShot.status === 'blocked'}
                            onClick={() => execute('continuity.candidate.select', { shotId: continuityShot.id, candidateId: candidate.id }, `已选择候选 #${candidate.attempt}；现在可记录人工复核。`)}
                          >{selected ? '已选中' : stale ? '不可用于当前输入' : '设为当前'}</button>
                        </article>
                      )
                    }) : <p>暂无候选。可从资源库添加，或在下方用视频 API 生成；登记后仍需手动“设为当前”。</p>}
                  </div>
                </section>
                <div className="aq-continuity-score-grid">
                  {REVIEW_DIMENSIONS.map(([key, label]) => (
                    <label key={key}><span>{label}</span><input type="number" min={0} max={5} step={0.1} value={reviewScores[key]} onChange={(event) => {
                      const score = event.currentTarget.valueAsNumber
                      if (!Number.isFinite(score)) return
                      setReviewScores((scores) => ({ ...scores, [key]: Math.max(0, Math.min(5, Math.round(score * 10) / 10)) }))
                    }} /></label>
                  ))}
                </div>
                <label><span>人工结论</span><select value={reviewDecision} onChange={(event) => setReviewDecision(event.target.value as 'accept' | 'retry')}><option value="accept">接受镜头</option><option value="retry">定向重生</option></select></label>
                <label><span>复核备注</span><textarea value={reviewNotes} maxLength={2_000} placeholder="说明接受依据或需要修正的具体问题" onChange={(event) => setReviewNotes(event.target.value)} /></label>
                <button type="button" className="aq-continuity-submit" disabled={['blocked', 'candidate-required'].includes(continuityShot.status)} onClick={submitContinuityReview}>{continuityShot.status === 'blocked' ? '必需资产尚未批准' : continuityShot.status === 'candidate-required' ? '请先选择当前视频候选' : '记录人工结论'}</button>
                {continuityLatestReview ? (
                  <article className={`aq-continuity-review-result is-${continuityLatestReview.decision}`}>
                    <strong>第 {continuityLatestReview.attempt} 次 · 候选 #{continuityLatestCandidate?.attempt ?? '—'} · {continuityLatestReview.decision === 'accept' ? '已接受' : '需定向重生'}</strong>
                    {continuityLatestReview.notes ? <p>{continuityLatestReview.notes}</p> : null}
                    {continuityLatestReview.reasons.map((reason) => <small key={reason}>{reason}</small>)}
                    {continuityLatestReview.recommendedActions.map((action) => <small key={action}>{action}</small>)}
                  </article>
                ) : null}
              </>
            ) : null}
          </section>
        ) : null}

        {['editor', 'sound-director', 'quality-controller'].includes(selectedNode.id) ? (
          <SoundTimelinePanel
            project={project}
            assetTargetId={soundTargetId}
            onChooseAsset={chooseSoundAsset}
            onCommand={(type, payload = {}, successMessage) => { execute(type, payload, successMessage) }}
            jobs={soundJobs}
            executionAvailable={Boolean(workspaceProjectId && workspaceDocumentId)}
            busy={soundJobBusy}
            onPrepareSpeech={(format, speechBudgetUsd) => { void submitSoundJob('prepare-speech', { format, speechBudgetUsd }) }}
            onRenderMix={() => { void submitSoundJob('render-mix') }}
            onCancelJob={(jobId) => { void cancelSoundJob(jobId) }}
            onRetryJob={(jobId) => { void retrySoundJob(jobId) }}
          />
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

        <GenerationAdaptersPanel
          projectId={workspaceProjectId}
          projectTitle={project.title}
          defaultPrompt={project.brief}
          videoCandidateContext={videoCandidateContext}
          onVideoAssetReady={registerGeneratedVideoCandidate}
        />

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
