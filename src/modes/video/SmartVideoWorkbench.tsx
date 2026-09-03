import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  Clapperboard,
  Clock3,
  FileCheck2,
  Film,
  HardDrive,
  Image as ImageIcon,
  Layers3,
  ListChecks,
  Loader2,
  LockKeyhole,
  Play,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Send,
  ShieldCheck,
  Sparkles,
  Square,
  Upload,
  Users,
  Wifi,
  X,
  XCircle,
} from 'lucide-react'
import {
  StoryContractError,
  compileStoryProject,
  createGenerationPlan,
  type FrameStrategy,
  type GenerationPlan,
  type GenerationTaskStage,
  type StoryAspectRatio,
  type StoryProject,
  type StorySourceKind,
} from '../../lib/story/storyProject.mjs'
import {
  MANAGED_FRAME_ASSET_SCHEMA_VERSION,
  STORY_EXECUTION_LIMITS,
  compileConfirmedVideoRequests,
  createExecutionRuntimeSnapshot,
  createVideoExecutionChecklist,
  createVideoExecutionConfirmation,
  type ExecutionRuntimeSnapshot,
  type ManagedFrameAsset,
  type ManagedAssetPayload,
  type VideoExecutionChecklist,
  type VideoExecutionConfirmation,
  type VideoExecutionMode,
  type VideoExecutionPreset,
  type VideoFrameMode,
} from '../../lib/story/storyExecution.mjs'
import {
  createVideoProductionProjectForStory,
  synchronizeVideoProductionProjectForStory,
  type VideoProductionProject,
} from '../../lib/story/productionPipeline.mjs'
import {
  createLocalVideoCandidateJobBinding,
  createLocalVideoCandidateTarget,
} from '../../lib/story/localVideoCandidate.mjs'
import { flushWorkspaceModeDocument } from '../../lib/projectApi'
import {
  cancelVideoJob,
  createFinalCutJob,
  createVideoChainJob,
  createVideoJob,
  fetchRuntimeStatus,
  fetchVideoJobs,
  normalizeVideoFirstFrame,
  retryVideoJob,
  startRuntime,
  subscribeVideoJobs,
  type JobEvent,
} from '../../lib/videoApi'
import type { ProcessingJob, RuntimeStatus } from '../../types'
import type { LibraryAssetInsertion } from '../../lib/libraryApi'
import { ProductionStudio, type ApprovedProductionStorySource } from './ProductionStudio'
import './smart-video-workbench.css'

const starterScript = `场景 1：雨夜·旧城书店
镜头 1：全景，雨水沿着老街招牌落下，阿砚推开书店木门。
阿砚：我只想找回被遗忘的那一页。
镜头 2：缓慢推进到柜台，店主把一枚发光的墨锭推到灯下。
店主：写下名字，时间就会替你翻页。

场景 2：黎明·河岸
镜头 1：中景跟拍，阿砚沿河岸奔跑，手中墨锭映出不断变化的旧照片。
镜头 2：特写，阿砚停下，把墨锭按在空白纸面，晨光从纸上铺开。`

export type SmartVideoRuntimeSummary = {
  state: 'offline' | 'starting' | 'ready' | 'busy' | 'error'
  label: string
  detail?: string
}

export type SmartVideoPlanResult = {
  project: StoryProject
  plan: GenerationPlan
  production: VideoProductionProject
}

export type SmartVideoWorkbenchProps = {
  initialText?: string
  initialKind?: StorySourceKind
  initialResult?: SmartVideoPlanResult
  projectId?: string
  workspaceProjectId?: string
  projectTitle?: string
  runtime?: SmartVideoRuntimeSummary
  onBack?: () => void
  onPlanReady?: (result: SmartVideoPlanResult) => void
  libraryAsset?: LibraryAssetInsertion
  onLibraryAssetConsumed?: (nonce: number) => void
}

type FrameAssetState = {
  contract: ManagedFrameAsset
  dataUrl: string
  fileName: string
}

type PlannedShot = {
  scene: StoryProject['scenes'][number]
  shot: StoryProject['scenes'][number]['shots'][number]
}

type VideoWorkspaceSection = 'production' | 'source' | 'plan' | 'execution'

const VIDEO_EXECUTION_PRESET_GUIDANCE: Record<VideoExecutionPreset, {
  label: string
  native: string
  pipeline: string
  estimate: Partial<Record<5 | 10 | 15, string>>
  allowedDurations: readonly number[]
  profile: 'preview' | 'quality' | 'master' | 'compatibility'
}> = {
  fast: {
    label: '快速动作预览',
    native: '608×352 · Turbo 4 步',
    pipeline: '用于抽卡、构图和动作验证，不作为高清成片。',
    estimate: { 5: '3–5 分钟', 10: '7–11 分钟', 15: '12–18 分钟' },
    allowedDurations: [5, 10, 15],
    profile: 'preview',
  },
  balanced: {
    label: '高清 Turbo',
    native: '1024×576 · Turbo 8 步',
    pipeline: '以更高源像素快速筛选可用镜头，保留 H3 原生音频。',
    estimate: { 5: '11–16 分钟', 10: '20–28 分钟' },
    allowedDurations: [5, 10],
    profile: 'quality',
  },
  cinemaBase: {
    label: 'Base 20 步精修',
    native: '1024×576 · res_multistep / simple · 20 步',
    pipeline: '移除 Turbo LoRA，以 Base 采样优先保护运动、材质与原生声画。',
    estimate: { 5: '15–30 分钟', 10: '30–55 分钟' },
    allowedDurations: [5, 10],
    profile: 'master',
  },
  master720: {
    label: '720P 时序精修母版',
    native: '1024×576 Base 20 步 → SeedVR2 3B INT8 → 1280×720',
    pipeline: '先保留 H3 原生母片，再卸载 H3、分块修复完整时序并回填原音频。',
    estimate: { 5: '20–40 分钟', 10: '38–75 分钟' },
    allowedDurations: [5, 10],
    profile: 'master',
  },
  nativeHigh: {
    label: '原生 768P Turbo',
    native: '1344×768 · Turbo 8 步',
    pipeline: 'H3 原生短边 768 画布；8GB 设备仅开放 5 秒，避免时空注意力越界。',
    estimate: { 5: '17–24 分钟' },
    allowedDurations: [5],
    profile: 'quality',
  },
  delivery720: {
    label: '兼容 720P 插值',
    native: '608×352 · Turbo 8 步 → Lanczos 1280×720',
    pipeline: '仅保证交付文件尺寸，不宣称新增真实纹理；只用于旧项目兼容。',
    estimate: { 5: '5–7 分钟', 10: '11–16 分钟', 15: '17–24 分钟' },
    allowedDurations: [5, 10, 15],
    profile: 'compatibility',
  },
}

const VIDEO_EXECUTION_PRESET_ORDER: VideoExecutionPreset[] = [
  'master720',
  'cinemaBase',
  'balanced',
  'nativeHigh',
  'fast',
  'delivery720',
]

function modelProfileLabel(profileId: string | undefined) {
  if (profileId === 'int8ConvrotCu130') return 'INT8 ConvRot · cu130'
  if (profileId === 'fp8Scaled4060') return 'FP8 scaled · 稳定路径'
  return '等待自动路由'
}

const stageIcons: Record<GenerationTaskStage, typeof Users> = {
  references: Users,
  frames: ImageIcon,
  videos: Film,
}

function createPreviewPlan(
  text: string,
  kind: StorySourceKind,
  aspectRatio: StoryAspectRatio,
  frameStrategy: FrameStrategy,
  projectId?: string,
  projectTitle?: string,
  production?: VideoProductionProject,
): SmartVideoPlanResult {
  const now = Date.now()
  const project = compileStoryProject({
    kind,
    text,
    projectId,
    title: projectTitle,
    aspectRatio,
    frameStrategy,
    defaultShotSeconds: 5,
    now,
  })
  return {
    project,
    plan: createGenerationPlan(project, { now }),
    production: production
      ? synchronizeVideoProductionProjectForStory(production, project, { now })
      : createVideoProductionProjectForStory(project, { now }),
  }
}

function errorMessage(error: unknown) {
  if (error instanceof StoryContractError) return `${error.code} · ${error.message}`
  return error instanceof Error ? error.message : '无法处理当前请求'
}

function statusLabel(status: 'needs-reference' | 'reference-planned' | 'ready') {
  if (status === 'ready') return '基准已确认'
  if (status === 'reference-planned') return '基准待生成'
  return '缺少基准'
}

function assetSlotKey(shotId: string, role: ManagedFrameAsset['role']) {
  return `${shotId}:${role}`
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('无法读取选中的图片'))
    reader.readAsDataURL(file)
  })
}

async function hashDataUrl(dataUrl: string) {
  const commaIndex = dataUrl.indexOf(',')
  if (commaIndex < 0) throw new Error('规范化图片不是有效的数据 URL')
  const binary = atob(dataUrl.slice(commaIndex + 1))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

function formatVram(bytes: number | undefined) {
  if (!bytes) return '待检测'
  return `${(bytes / 1024 ** 3).toFixed(1)}GB`
}

function jobStatusLabel(job: ProcessingJob) {
  if (job.status === 'completed') return '已完成'
  if (job.status === 'failed') return '失败'
  if (job.status === 'cancelled') return '已取消'
  if (job.status === 'running') return '生成中'
  return '排队中'
}

function chainShotStatusLabel(status: NonNullable<ProcessingJob['videoChainManifest']>['shots'][number]['status']) {
  if (status === 'completed') return '新生成完成'
  if (status === 'reused') return '可信断点复用'
  if (status === 'failed') return '镜头失败'
  if (status === 'queued') return '执行中'
  return '待执行'
}

function deliveryQualityStatusLabel(status: NonNullable<NonNullable<ProcessingJob['finalCutMetadata']>['qualityReport']>['summary']['status']) {
  if (status === 'pass') return '机器交付门通过'
  if (status === 'review') return '机器门通过 · 待人工复核'
  return '交付门未通过'
}

function upsertJob(jobs: ProcessingJob[], updated: ProcessingJob) {
  const existingIndex = jobs.findIndex(({ id }) => id === updated.id)
  if (existingIndex < 0) return [updated, ...jobs]
  const next = [...jobs]
  next[existingIndex] = updated
  return next
}

function runtimeSnapshotFromFailure(message: string): ExecutionRuntimeSnapshot {
  return createExecutionRuntimeSnapshot({ message }, { bridgeAvailable: false })
}

export function SmartVideoWorkbench({
  initialText = starterScript,
  initialKind = 'script',
  initialResult,
  projectId,
  workspaceProjectId,
  projectTitle,
  runtime = { state: 'offline', label: 'ComfyUI 休眠', detail: '生成阶段才会按策略启动' },
  onBack,
  onPlanReady,
  libraryAsset,
  onLibraryAssetConsumed,
}: SmartVideoWorkbenchProps) {
  const [kind, setKind] = useState<StorySourceKind>(initialResult?.project.source.kind ?? initialKind)
  const [text, setText] = useState(initialResult?.project.source.text ?? initialText)
  const [aspectRatio, setAspectRatio] = useState<StoryAspectRatio>(initialResult?.project.settings.aspectRatio ?? '16:9')
  const [frameStrategy, setFrameStrategy] = useState<FrameStrategy>(initialResult?.project.settings.frameStrategy ?? 'start-end')
  const [result, setResult] = useState<SmartVideoPlanResult>(() => initialResult
    ?? createPreviewPlan(initialText, initialKind, '16:9', 'start-end', projectId, projectTitle))
  const firstShotId = result.project.scenes[0]?.shots[0]?.id ?? ''
  const [error, setError] = useState<string | null>(null)
  const [executionError, setExecutionError] = useState<string | null>(null)
  const [activeSceneId, setActiveSceneId] = useState(result.project.scenes[0]?.id ?? '')
  const [selectedShotIds, setSelectedShotIds] = useState<string[]>(firstShotId ? [firstShotId] : [])
  const [executionMode, setExecutionMode] = useState<VideoExecutionMode>('text-to-video')
  const [imageFrameMode, setImageFrameMode] = useState<Exclude<VideoFrameMode, 'none'>>('first')
  const [preset, setPreset] = useState<VideoExecutionPreset>('master720')
  const [audio, setAudio] = useState(true)
  const [frameAssets, setFrameAssets] = useState<Record<string, FrameAssetState>>({})
  const [assetBusy, setAssetBusy] = useState<string | null>(null)
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null)
  const [runtimeBusy, setRuntimeBusy] = useState(false)
  const [bridgeMessage, setBridgeMessage] = useState<string | null>(null)
  const [streamConnected, setStreamConnected] = useState(false)
  const [jobs, setJobs] = useState<ProcessingJob[]>([])
  const [checklist, setChecklist] = useState<VideoExecutionChecklist | null>(null)
  const [confirmation, setConfirmation] = useState<VideoExecutionConfirmation | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [actionBusy, setActionBusy] = useState<string | null>(null)
  const [latestJobIdByItem, setLatestJobIdByItem] = useState<Record<string, string>>({})
  const [submittedJobIds, setSubmittedJobIds] = useState<string[]>([])
  const [activeWorkspace, setActiveWorkspace] = useState<VideoWorkspaceSection>('production')
  const consumedLibraryAssetRef = useRef<number | null>(null)

  function revealWorkspace(section: VideoWorkspaceSection) {
    setActiveWorkspace(section)
    if (section !== 'production') {
      window.setTimeout(() => {
        document.getElementById(`aq-video-${section}-workspace`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, 0)
    }
  }

  useEffect(() => {
    let disposed = false
    let closeStream: (() => void) | undefined

    const handleEvent = (event: JobEvent) => {
      if (event.type === 'jobs.snapshot') setJobs(event.jobs)
      if (event.type === 'job.updated') setJobs((current) => upsertJob(current, event.job))
      if (event.type === 'jobs.cleared') setJobs((current) => current.filter(({ id }) => !event.ids.includes(id)))
      if (event.type === 'runtime.updated') setRuntimeStatus(event.runtime)
    }

    const connect = async () => {
      const [runtimeResult, jobsResult] = await Promise.allSettled([
        fetchRuntimeStatus(),
        fetchVideoJobs(),
      ])
      if (disposed) return
      if (runtimeResult.status === 'fulfilled') {
        setRuntimeStatus(runtimeResult.value)
        setBridgeMessage(null)
      } else {
        setBridgeMessage(errorMessage(runtimeResult.reason))
      }
      if (jobsResult.status === 'fulfilled') setJobs(jobsResult.value)
      try {
        const unsubscribe = await subscribeVideoJobs(handleEvent, setStreamConnected)
        if (disposed) unsubscribe()
        else closeStream = unsubscribe
      } catch (nextError) {
        if (!disposed) setBridgeMessage(errorMessage(nextError))
      }
    }

    void connect()
    return () => {
      disposed = true
      closeStream?.()
    }
  }, [])

  const activeScene = result.project.scenes.find(({ id }) => id === activeSceneId)
    ?? result.project.scenes[0]
  const plannedShots = useMemo<PlannedShot[]>(
    () => result.project.scenes.flatMap((scene) => scene.shots.map((shot) => ({ scene, shot }))),
    [result.project.scenes],
  )
  const selectedShotSet = useMemo(() => new Set(selectedShotIds), [selectedShotIds])
  const selectedShots = useMemo(
    () => plannedShots.filter(({ shot }) => selectedShotSet.has(shot.id)),
    [plannedShots, selectedShotSet],
  )
  const presetGuidance = VIDEO_EXECUTION_PRESET_GUIDANCE[preset]
  const presetCapability = runtimeStatus?.videoCapabilities?.presets.find(({ id }) => id === preset)
  const selectedDuration = selectedShots[0]?.shot.durationSeconds
  const selectedEstimate = presetGuidance.estimate[selectedDuration as 5 | 10 | 15]
  const unsupportedDuration = selectedShots.some(({ shot }) => !presetGuidance.allowedDurations.includes(shot.durationSeconds))
  const activeModelProfile = presetCapability?.availableProfiles[0]
  const shotCount = plannedShots.length
  const totalSeconds = useMemo(
    () => plannedShots.reduce((total, { shot }) => total + shot.durationSeconds, 0),
    [plannedShots],
  )
  const taskCounts = useMemo(() => new Map(
    result.plan.stages.map((stage) => [
      stage.id,
      result.plan.tasks.filter((task) => task.stage === stage.id).length,
    ]),
  ), [result.plan])
  const readyCount = checklist?.items.filter(({ status }) => status === 'ready').length ?? 0
  const blockedCount = checklist?.items.filter(({ status }) => status === 'blocked').length ?? 0
  const jobById = useMemo(() => new Map(jobs.map((job) => [job.id, job])), [jobs])
  const chainWorkspaceId = workspaceProjectId ?? projectId ?? result.project.id
  const submittedJobs = useMemo(() => {
    const sessionJobs = submittedJobIds.map((id) => jobById.get(id)).filter((job): job is ProcessingJob => Boolean(job))
    const seen = new Set(sessionJobs.map(({ id }) => id))
    const restoredChains = jobs.filter((job) => (
      ['video-chain', 'final-cut'].includes(job.kind ?? '')
      && job.request
      && 'projectId' in job.request
      && job.request.projectId === chainWorkspaceId
      && !seen.has(job.id)
    )).slice(0, 8)
    return [...sessionJobs, ...restoredChains]
  }, [chainWorkspaceId, jobById, jobs, submittedJobIds])
  const completedShotJobs = useMemo(
    () => submittedJobs.filter((job) => ['video', 'provider-video'].includes(job.kind ?? '') && job.status === 'completed' && job.outputUrl),
    [submittedJobs],
  )
  const finalCutJobs = useMemo(
    () => submittedJobs.filter((job) => job.kind === 'final-cut'),
    [submittedJobs],
  )
  const completedSoundMixJob = useMemo(() => jobs
    .filter((job) => (
      job.kind === 'sound-render'
      && job.status === 'completed'
      && job.request
      && 'documentId' in job.request
      && job.request.documentId === (projectId ?? result.project.id)
      && 'soundTimelineRevision' in job.request
      && job.request.soundTimelineRevision === result.production.soundTimeline.revision
      && job.soundRenderMetadata?.action === 'render-mix'
      && job.outputUrl
    ))
    .sort((left, right) => right.createdAt - left.createdAt)[0], [jobs, projectId, result.production.soundTimeline.revision, result.project.id])

  const invalidateExecution = () => {
    setChecklist(null)
    setConfirmation(null)
    setAcknowledged(false)
  }

  const compile = () => {
    try {
      const next = createPreviewPlan(text, kind, aspectRatio, frameStrategy, projectId, projectTitle)
      const nextFirstShotId = next.project.scenes[0]?.shots[0]?.id ?? ''
      setResult(next)
      setActiveSceneId(next.project.scenes[0]?.id ?? '')
      setSelectedShotIds(nextFirstShotId ? [nextFirstShotId] : [])
      setFrameAssets({})
      invalidateExecution()
      setError(null)
      setExecutionError(null)
      onPlanReady?.(next)
    } catch (nextError) {
      setError(errorMessage(nextError))
    }
  }

  const toggleShot = (shotId: string) => {
    if (!selectedShotSet.has(shotId) && selectedShotIds.length >= STORY_EXECUTION_LIMITS.maxItems) {
      setExecutionError(`单次清单最多包含 ${STORY_EXECUTION_LIMITS.maxItems} 个镜头。`)
      return
    }
    setSelectedShotIds((current) => current.includes(shotId)
      ? current.filter((id) => id !== shotId)
      : [...current, shotId])
    invalidateExecution()
    setExecutionError(null)
  }

  const updateExecutionMode = (mode: VideoExecutionMode) => {
    setExecutionMode(mode)
    invalidateExecution()
    setExecutionError(null)
  }

  const importFrame = async (shotId: string, role: ManagedFrameAsset['role'], file: File) => {
    const slot = assetSlotKey(shotId, role)
    setAssetBusy(slot)
    setExecutionError(null)
    try {
      if (file.size <= 0 || file.size > 20 * 1024 * 1024) throw new Error('帧图片必须小于 20MB')
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
        throw new Error('帧图片仅支持 PNG、JPEG 或 WebP')
      }
      const source = await readFileAsDataUrl(file)
      const normalized = await normalizeVideoFirstFrame(source, result.project.settings.aspectRatio)
      const digest = await hashDataUrl(normalized)
      const roleToken = role === 'first-frame' ? 'first' : 'last'
      const contract: ManagedFrameAsset = {
        schemaVersion: MANAGED_FRAME_ASSET_SCHEMA_VERSION,
        bindingId: `frame-${roleToken}-${shotId}-${digest.slice(0, 16)}`,
        assetVersionId: `sha256:${digest}`,
        role,
        mimeType: 'image/png',
        status: 'ready',
      }
      setFrameAssets((current) => ({
        ...current,
        [slot]: { contract, dataUrl: normalized, fileName: file.name },
      }))
      invalidateExecution()
    } catch (nextError) {
      setExecutionError(errorMessage(nextError))
    } finally {
      setAssetBusy(null)
    }
  }

  const removeFrame = (shotId: string, role: ManagedFrameAsset['role']) => {
    const slot = assetSlotKey(shotId, role)
    setFrameAssets((current) => {
      const next = { ...current }
      delete next[slot]
      return next
    })
    invalidateExecution()
  }

  const loadRuntimeSnapshot = async () => {
    try {
      const status = await fetchRuntimeStatus(true)
      setRuntimeStatus(status)
      setBridgeMessage(null)
      return createExecutionRuntimeSnapshot(status)
    } catch (nextError) {
      const message = errorMessage(nextError)
      setBridgeMessage(message)
      return runtimeSnapshotFromFailure(message)
    }
  }

  const buildChecklist = (runtimeSnapshot: ExecutionRuntimeSnapshot, createdAt: number) => {
    const selections = selectedShots.map(({ shot }) => {
      const first = frameAssets[assetSlotKey(shot.id, 'first-frame')]
      const last = frameAssets[assetSlotKey(shot.id, 'last-frame')]
      const frameMode: VideoFrameMode = executionMode === 'text-to-video' ? 'none' : imageFrameMode
      return {
        shotId: shot.id,
        mode: executionMode,
        frameMode,
        preset,
        audio,
        firstFrameBindingId: executionMode === 'image-to-video' ? first?.contract.bindingId ?? null : null,
        lastFrameBindingId: executionMode === 'image-to-video' && imageFrameMode === 'first-last'
          ? last?.contract.bindingId ?? null
          : null,
      }
    })
    const referencedBindingIds = new Set(selections.flatMap(({ firstFrameBindingId, lastFrameBindingId }) =>
      [firstFrameBindingId, lastFrameBindingId].filter((id): id is string => Boolean(id))))
    const assets = Object.values(frameAssets)
      .map(({ contract }) => contract)
      .filter(({ bindingId }) => referencedBindingIds.has(bindingId))
    return createVideoExecutionChecklist(result.project, result.plan, {
      schemaVersion: 1,
      selections,
    }, {
      now: createdAt,
      runtime: runtimeSnapshot,
      assets,
    })
  }

  const prepareChecklist = async () => {
    setActionBusy('prepare')
    setExecutionError(null)
    try {
      const snapshot = await loadRuntimeSnapshot()
      const next = buildChecklist(snapshot, Date.now())
      setChecklist(next)
      setConfirmation(null)
      setAcknowledged(false)
    } catch (nextError) {
      setExecutionError(errorMessage(nextError))
    } finally {
      setActionBusy(null)
    }
  }

  const refreshRuntime = async () => {
    setRuntimeBusy(true)
    setExecutionError(null)
    try {
      await loadRuntimeSnapshot()
      invalidateExecution()
    } finally {
      setRuntimeBusy(false)
    }
  }

  const launchRuntime = async () => {
    setRuntimeBusy(true)
    setExecutionError(null)
    try {
      const status = await startRuntime()
      setRuntimeStatus(status)
      setBridgeMessage(null)
      invalidateExecution()
    } catch (nextError) {
      setExecutionError(errorMessage(nextError))
    } finally {
      setRuntimeBusy(false)
    }
  }

  const refreshChecklistBeforeAction = async (current: VideoExecutionChecklist) => {
    const snapshot = await loadRuntimeSnapshot()
    const refreshed = buildChecklist(snapshot, current.createdAt)
    if (refreshed.digest !== current.digest) {
      setChecklist(refreshed)
      setConfirmation(null)
      setAcknowledged(false)
      throw new Error('运行环境、镜头参数或帧资产已变化，请重新检查并确认清单。')
    }
    return refreshed
  }

  const confirmChecklist = async () => {
    if (!checklist) return
    setActionBusy('confirm')
    setExecutionError(null)
    try {
      if (!acknowledged) throw new Error('请先勾选“我已核对可执行镜头与固定工作流”。')
      const current = await refreshChecklistBeforeAction(checklist)
      const readyIds = current.items.filter(({ status }) => status === 'ready').map(({ id }) => id)
      if (!readyIds.length) throw new Error('当前清单没有可执行镜头，请先解除阻塞。')
      setConfirmation(createVideoExecutionConfirmation(current, { itemIds: readyIds, now: Date.now() }))
    } catch (nextError) {
      setExecutionError(errorMessage(nextError))
    } finally {
      setActionBusy(null)
    }
  }

  const submitConfirmed = async () => {
    if (!checklist || !confirmation) return
    setActionBusy('submit')
    setExecutionError(null)
    try {
      const current = await refreshChecklistBeforeAction(checklist)
      const confirmedItems = current.items.filter(({ id }) => confirmation.confirmedItemIds.includes(id))
      const requiredBindingIds = new Set(confirmedItems.flatMap(({ assetBindings }) => [
        assetBindings.firstFrame?.bindingId,
        assetBindings.lastFrame?.bindingId,
      ].filter((id): id is string => Boolean(id))))
      const payloads: ManagedAssetPayload[] = Object.values(frameAssets)
        .filter(({ contract }) => requiredBindingIds.has(contract.bindingId))
        .map(({ contract, dataUrl }) => ({
          bindingId: contract.bindingId,
          assetVersionId: contract.assetVersionId,
          dataUrl,
        }))
      const submissions = compileConfirmedVideoRequests(current, confirmation, payloads)
      const workspaceDocumentId = projectId ?? result.project.id
      const continuityShotByStoryShotId = new Map(result.production.continuityGraph.shots
        .filter(({ storyShotId }) => Boolean(storyShotId))
        .map((shot) => [shot.storyShotId as string, shot]))
      const candidateEligibleItems = new Set(current.items
        .filter((item) => {
          const continuityShot = continuityShotByStoryShotId.get(item.shotId)
          return Boolean(continuityShot && continuityShot.status !== 'blocked')
        })
        .map(({ id }) => id))
      if (workspaceProjectId && candidateEligibleItems.size) {
        await flushWorkspaceModeDocument(workspaceDocumentId)
      }
      let candidateBoundCount = 0
      for (const submission of submissions) {
        const item = current.items.find(({ id }) => id === submission.itemId)
        const continuityShot = item ? continuityShotByStoryShotId.get(item.shotId) : undefined
        const candidateBinding = workspaceProjectId && item && continuityShot && candidateEligibleItems.has(item.id)
          ? createLocalVideoCandidateJobBinding({
              projectId: workspaceProjectId,
              documentId: workspaceDocumentId,
              production: result.production,
              shotId: continuityShot.id,
              executionItemId: item.id,
              submissionId: submission.idempotencyKey,
            })
          : undefined
        const job = await createVideoJob({
          ...submission.request,
          ...(candidateBinding ? { candidateBinding } : {}),
        }, {
          idempotencyKey: submission.idempotencyKey,
          priority: 45,
        })
        if (candidateBinding) candidateBoundCount += 1
        setJobs((existing) => upsertJob(existing, job))
        setLatestJobIdByItem((existing) => ({ ...existing, [submission.itemId]: job.id }))
        setSubmittedJobIds((existing) => existing.includes(job.id) ? existing : [...existing, job.id])
      }
      if (candidateBoundCount) {
        setBridgeMessage(`${candidateBoundCount} 个本地 H3 任务已绑定到明确镜头；完成后将自动入库并进入候选池。`)
      }
    } catch (nextError) {
      setExecutionError(errorMessage(nextError))
    } finally {
      setActionBusy(null)
    }
  }

  const cancelJob = async (itemId: string, jobId: string) => {
    setActionBusy(`cancel:${jobId}`)
    setExecutionError(null)
    try {
      const job = await cancelVideoJob(jobId)
      setJobs((existing) => upsertJob(existing, job))
      setLatestJobIdByItem((existing) => ({ ...existing, [itemId]: job.id }))
    } catch (nextError) {
      setExecutionError(errorMessage(nextError))
    } finally {
      setActionBusy(null)
    }
  }

  const retryJob = async (itemId: string, jobId: string) => {
    setActionBusy(`retry:${jobId}`)
    setExecutionError(null)
    try {
      const job = await retryVideoJob(jobId)
      setJobs((existing) => upsertJob(existing, job))
      setLatestJobIdByItem((existing) => ({ ...existing, [itemId]: job.id }))
      setSubmittedJobIds((existing) => existing.includes(job.id) ? existing : [...existing, job.id])
    } catch (nextError) {
      setExecutionError(errorMessage(nextError))
    } finally {
      setActionBusy(null)
    }
  }

  const liveRuntimeLabel = bridgeMessage
    ? '桥接不可用'
    : runtimeStatus?.connected
      ? runtimeStatus.ready ? 'H3 已就绪' : 'H3 依赖缺失'
      : runtimeStatus?.lifecycle?.state === 'starting' ? 'ComfyUI 启动中' : 'ComfyUI 休眠'

  const bridgeProductionSource = (source: ApprovedProductionStorySource) => {
    try {
      const next = createPreviewPlan(
        source.text,
        source.kind,
        source.aspectRatio,
        source.frameStrategy,
        projectId,
        projectTitle,
        result.production,
      )
      const nextFirstShotId = next.project.scenes[0]?.shots[0]?.id ?? ''
      setKind(source.kind)
      setText(source.text)
      setAspectRatio(source.aspectRatio)
      setFrameStrategy(source.frameStrategy)
      setResult(next)
      setActiveSceneId(next.project.scenes[0]?.id ?? '')
      setSelectedShotIds(nextFirstShotId ? [nextFirstShotId] : [])
      setFrameAssets({})
      invalidateExecution()
      setError(null)
      setExecutionError(null)
      onPlanReady?.(next)
      revealWorkspace('plan')
    } catch (nextError) {
      setError(errorMessage(nextError))
    }
  }

  const submitContinuousFilm = async () => {
    if (!checklist || !confirmation) return
    setActionBusy('video-chain')
    setExecutionError(null)
    try {
      const current = await refreshChecklistBeforeAction(checklist)
      const confirmedItems = current.items.filter(({ id }) => confirmation.confirmedItemIds.includes(id))
      if (confirmedItems.length < 2) throw new Error('连续成片至少需要确认两个镜头。')
      if (confirmedItems.some(({ mode }) => mode !== 'text-to-video')) {
        throw new Error('当前一键连续成片以首镜文生视频启动；请切换为文生视频后重新检查清单。')
      }
      const submissions = compileConfirmedVideoRequests(current, confirmation, [])
      const workspaceDocumentId = projectId ?? result.project.id
      const itemById = new Map(current.items.map((item) => [item.id, item]))
      const continuityShotByStoryShotId = new Map(result.production.continuityGraph.shots
        .filter(({ storyShotId }) => Boolean(storyShotId))
        .map((shot) => [shot.storyShotId as string, shot]))
      const targetableSubmissionIds = new Set(submissions
        .filter(({ itemId }) => {
          const item = itemById.get(itemId)
          const continuityShot = item ? continuityShotByStoryShotId.get(item.shotId) : undefined
          return Boolean(workspaceProjectId && continuityShot && continuityShot.status !== 'blocked')
        })
        .map(({ itemId }) => itemId))
      if (workspaceProjectId && targetableSubmissionIds.size) {
        await flushWorkspaceModeDocument(workspaceDocumentId)
      }
      let candidateTargetCount = 0
      const job = await createVideoChainJob({
        projectId: workspaceProjectId ?? projectId ?? result.project.id,
        title: `${projectTitle ?? result.project.title} · 连续长片`,
        shots: submissions.map(({ itemId, request }) => {
          const item = itemById.get(itemId)
          const continuityShot = item ? continuityShotByStoryShotId.get(item.shotId) : undefined
          const candidateTarget = workspaceProjectId && continuityShot && targetableSubmissionIds.has(itemId)
            ? createLocalVideoCandidateTarget({
                projectId: workspaceProjectId,
                documentId: workspaceDocumentId,
                production: result.production,
                shotId: continuityShot.id,
                executionItemId: itemId,
              })
            : undefined
          const {
            sourceImageDataUrl: _sourceImageDataUrl,
            lastFrameImageDataUrl: _lastFrameImageDataUrl,
            candidateBinding: _candidateBinding,
            mode: _mode,
            duration: _duration,
            ...shot
          } = request
          if (candidateTarget) candidateTargetCount += 1
          return {
            ...shot,
            executionItemId: itemId,
            ...(candidateTarget ? { candidateTarget } : {}),
            mode: 'text-to-video' as const,
            duration: 5 as const,
          }
        }),
        transitionSeconds: 0.24,
        width: 1280,
        height: 720,
        fps: 24,
      }, { priority: 35 })
      setJobs((existing) => upsertJob(existing, job))
      setSubmittedJobIds((existing) => existing.includes(job.id) ? existing : [...existing, job.id])
      if (candidateTargetCount) {
        setBridgeMessage(`${candidateTargetCount} 个连续长片子任务已绑定明确镜头；每镜完成后会独立入库并进入候选池。`)
      }
    } catch (nextError) {
      setExecutionError(errorMessage(nextError))
    } finally {
      setActionBusy(null)
    }
  }

  const submitFinalCut = async () => {
    if (completedShotJobs.length < 2) return
    setActionBusy('final-cut')
    setExecutionError(null)
    try {
      const job = await createFinalCutJob({
        sourceJobIds: completedShotJobs.map(({ id }) => id),
        projectId: workspaceProjectId ?? projectId,
        ...(completedSoundMixJob ? { soundRenderJobId: completedSoundMixJob.id } : {}),
        title: `${projectTitle ?? result.project.title} · 720P 成片`,
        transitionSeconds: 0.24,
        width: 1280,
        height: 720,
        fps: 24,
      }, { priority: 40 })
      setJobs((existing) => upsertJob(existing, job))
      setSubmittedJobIds((existing) => existing.includes(job.id) ? existing : [...existing, job.id])
    } catch (nextError) {
      setExecutionError(errorMessage(nextError))
    } finally {
      setActionBusy(null)
    }
  }

  const updateProductionProject = (production: VideoProductionProject) => {
    const alignedProduction = production.continuityGraph.storyProjectId === result.project.id
      && production.continuityGraph.storyRevision === result.project.revision
      && production.soundTimeline.storyProjectId === result.project.id
      && production.soundTimeline.storyRevision === result.project.revision
      ? production
      : synchronizeVideoProductionProjectForStory(production, result.project, {
          now: Math.max(Date.now(), production.updatedAt, result.project.updatedAt),
        })
    const next = { ...result, production: alignedProduction }
    setResult(next)
    onPlanReady?.(next)
  }

  const prepareLocalCandidateShot = (continuityShotId: string) => {
    const continuityShot = result.production.continuityGraph.shots.find(({ id }) => id === continuityShotId)
    const storyShotId = continuityShot?.storyShotId
    if (!continuityShot || !storyShotId || !plannedShots.some(({ shot }) => shot.id === storyShotId)) {
      setExecutionError('目标镜头与当前故事分镜不再一致，请先重新同步生产图。')
      return
    }
    setSelectedShotIds([storyShotId])
    invalidateExecution()
    setExecutionError(null)
    setBridgeMessage(`已只选择“${continuityShot.label}”；重新检查清单后可提交本地 H3 定向重生。`)
    revealWorkspace('execution')
  }

  useEffect(() => {
    if (!libraryAsset || consumedLibraryAssetRef.current === libraryAsset.nonce) return
    if (activeWorkspace === 'production') return
    consumedLibraryAssetRef.current = libraryAsset.nonce
    let disposed = false
    void (async () => {
      try {
        if (libraryAsset.asset.mediaKind !== 'image') throw new Error('故事/分镜/执行区只接受图片；音频与视频请在“多智能体”工作区绑定到声音槽位或镜头候选。')
        const shotId = selectedShotIds[0] ?? result.project.scenes[0]?.shots[0]?.id
        if (!shotId) throw new Error('当前剧本还没有可绑定的镜头')
        const response = await fetch(libraryAsset.asset.version.url, { credentials: 'same-origin' })
        if (!response.ok) throw new Error(`资源读取返回 HTTP ${response.status}`)
        const blob = await response.blob()
        if (disposed) return
        setExecutionMode('image-to-video')
        setImageFrameMode('first')
        setSelectedShotIds([shotId])
        revealWorkspace('execution')
        await importFrame(
          shotId,
          'first-frame',
          new File([blob], `${libraryAsset.asset.title}.${libraryAsset.asset.version.extension}`, {
            type: libraryAsset.asset.version.mimeType,
          }),
        )
        if (!disposed) setBridgeMessage(`已把资源库图像“${libraryAsset.asset.title}”绑定为首帧。`)
      } catch (nextError) {
        if (!disposed) setExecutionError(errorMessage(nextError))
      } finally {
        if (!disposed) onLibraryAssetConsumed?.(libraryAsset.nonce)
      }
    })()
    return () => { disposed = true }
    // 资源投递严格按 nonce 消费一次；镜头变化不应重复导入同一版本。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libraryAsset?.nonce, activeWorkspace])

  return (
    <section className="aq-video-workbench" aria-label="智能视频工作台">
      <header className="aq-video-header">
        <div className="aq-video-heading">
          {onBack ? (
            <button type="button" className="aq-video-icon-button" onClick={onBack} aria-label="返回产品主页">
              <ArrowLeft size={18} />
            </button>
          ) : null}
          <span className="aq-video-mode-mark"><Clapperboard size={20} /></span>
          <div>
            <p>AEONQUILL · 智能视频</p>
            <h1>{activeWorkspace === 'production' ? '多智能体制片工作室' : '故事编排与受控执行'}</h1>
          </div>
        </div>
        <div className="aq-video-header-status">
          <span className={`aq-video-runtime is-${runtime.state}`}><i />{runtime.label}</span>
          <span className="aq-video-safe-badge"><ShieldCheck size={14} /> Powered by MiniMax H3 · 固定工作流</span>
        </div>
      </header>

      <div className="aq-video-body">
        <nav className="aq-video-tool-rail" aria-label="智能视频工作区导航">
          <button type="button" className={activeWorkspace === 'production' ? 'is-active' : ''} aria-current={activeWorkspace === 'production' ? 'page' : undefined} onClick={() => revealWorkspace('production')}>
            <Users size={19} />
            <span>制片</span>
          </button>
          <button type="button" className={activeWorkspace === 'source' ? 'is-active' : ''} aria-current={activeWorkspace === 'source' ? 'page' : undefined} onClick={() => revealWorkspace('source')}>
            <ScrollText size={19} />
            <span>故事</span>
          </button>
          <button type="button" className={activeWorkspace === 'plan' ? 'is-active' : ''} aria-current={activeWorkspace === 'plan' ? 'page' : undefined} onClick={() => revealWorkspace('plan')}>
            <Clapperboard size={19} />
            <span>分镜</span>
          </button>
          <button type="button" className={activeWorkspace === 'execution' ? 'is-active' : ''} aria-current={activeWorkspace === 'execution' ? 'page' : undefined} onClick={() => revealWorkspace('execution')}>
            <ListChecks size={19} />
            <span>执行</span>
          </button>
        </nav>
        <ProductionStudio
          active={activeWorkspace === 'production'}
          runtimeLabel={liveRuntimeLabel}
          workspaceProjectId={workspaceProjectId}
          workspaceDocumentId={projectId ?? result.project.id}
          project={result.production}
          onProjectChange={updateProductionProject}
          onBridgeToStory={bridgeProductionSource}
          libraryAsset={libraryAsset}
          onLibraryAssetConsumed={onLibraryAssetConsumed}
          jobs={jobs}
          onJobTracked={(job) => setJobs((existing) => upsertJob(existing, job))}
          onPrepareLocalShot={prepareLocalCandidateShot}
        />
        {activeWorkspace !== 'production' ? (
          <>
        <aside className="aq-video-source-panel" aria-label="故事输入">
          <div id="aq-video-source-workspace" className="aq-video-panel-title">
            <span><ScrollText size={17} /> 故事源</span>
            <small>{text.length.toLocaleString()} / 60,000</small>
          </div>

          <div className="aq-video-segmented" role="tablist" aria-label="输入类型">
            <button
              type="button"
              role="tab"
              aria-selected={kind === 'idea'}
              className={kind === 'idea' ? 'is-active' : ''}
              onClick={() => setKind('idea')}
            >
              <Sparkles size={15} /> 灵感
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={kind === 'script'}
              className={kind === 'script' ? 'is-active' : ''}
              onClick={() => setKind('script')}
            >
              <Clapperboard size={15} /> 预设剧本
            </button>
          </div>

          <label className="aq-video-script-field">
            <span>{kind === 'idea' ? '描述核心人物、冲突和视觉气质' : '使用“场景 / 镜头 / 角色：对白”组织文本'}</span>
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              spellCheck={false}
              aria-describedby="aq-video-schema-note"
            />
          </label>

          <div className="aq-video-settings-grid">
            <label>
              <span>画幅</span>
              <select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value as StoryAspectRatio)}>
                <option value="16:9">16:9 · 横屏</option>
                <option value="9:16">9:16 · 竖屏</option>
                <option value="1:1">1:1 · 方形</option>
              </select>
            </label>
            <label>
              <span>帧策略</span>
              <select value={frameStrategy} onChange={(event) => setFrameStrategy(event.target.value as FrameStrategy)}>
                <option value="start-end">首帧 + 末帧</option>
                <option value="keyframe">单关键帧</option>
              </select>
            </label>
          </div>

          {error ? (
            <div className="aq-video-error" role="alert">
              <AlertTriangle size={16} />
              <span>{error}</span>
            </div>
          ) : null}

          <button type="button" className="aq-video-compile-button" onClick={compile}>
            <Sparkles size={17} />
            编译故事计划
          </button>

          <div id="aq-video-schema-note" className="aq-video-safety-note">
            <ShieldCheck size={16} />
            <p>
              <strong>计划与执行双重校验</strong>
              文本模型字段先过严格 Schema；执行清单只映射现有 MiniMax H3 文生/图生参数，不接收工作流 JSON、本机路径或任意 workflow ID。
            </p>
          </div>
        </aside>

        <main className="aq-video-plan-panel">
          <div id="aq-video-plan-workspace" className="aq-video-plan-summary">
            <div>
              <p>结构化项目</p>
              <h2>{result.project.title}</h2>
            </div>
            <dl>
              <div><dt>场景</dt><dd>{result.project.scenes.length}</dd></div>
              <div><dt>镜头</dt><dd>{shotCount}</dd></div>
              <div><dt>预计时长</dt><dd>{totalSeconds}s</dd></div>
              <div><dt>计划任务</dt><dd>{result.plan.tasks.length}</dd></div>
            </dl>
          </div>

          <section className="aq-video-pipeline" aria-label="任务阶段">
            {result.plan.stages.map((stage, index) => {
              const Icon = stageIcons[stage.id]
              return (
                <div className="aq-video-stage" key={stage.id}>
                  <span><Icon size={18} /></span>
                  <div>
                    <small>阶段 {stage.order}</small>
                    <strong>{stage.label}</strong>
                    <p>{taskCounts.get(stage.id) ?? 0} 个计划任务</p>
                  </div>
                  {index < result.plan.stages.length - 1 ? <ChevronRight className="aq-video-stage-arrow" size={18} /> : null}
                </div>
              )
            })}
          </section>

          <div className="aq-video-plan-grid">
            <section className="aq-video-scenes" aria-label="场景与镜头">
              <div className="aq-video-section-heading">
                <span><Layers3 size={17} /> 分镜结构</span>
                <small>勾选 1–{STORY_EXECUTION_LIMITS.maxItems} 个镜头</small>
              </div>
              <div className="aq-video-scene-tabs" role="tablist" aria-label="场景">
                {result.project.scenes.map((scene) => (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={scene.id === activeScene?.id}
                    className={scene.id === activeScene?.id ? 'is-active' : ''}
                    key={scene.id}
                    onClick={() => setActiveSceneId(scene.id)}
                  >
                    <small>{String(scene.ordinal).padStart(2, '0')}</small>
                    <span>{scene.heading}</span>
                  </button>
                ))}
              </div>

              {activeScene ? (
                <div className="aq-video-shot-list">
                  <div className="aq-video-scene-context">
                    <div><span>地点基准</span><code>{activeScene.locationId}</code></div>
                    <p>{activeScene.summary}</p>
                  </div>
                  {activeScene.shots.map((shot) => {
                    const selected = selectedShotSet.has(shot.id)
                    return (
                      <article className={`aq-video-shot-card${selected ? ' is-selected' : ''}`} key={shot.id}>
                        <label className="aq-video-shot-select" title="加入执行清单">
                          <input type="checkbox" checked={selected} onChange={() => toggleShot(shot.id)} />
                          <span>{selected ? <Check size={13} /> : null}</span>
                        </label>
                        <div className="aq-video-shot-number">{String(shot.ordinal).padStart(2, '0')}</div>
                        <div className="aq-video-shot-content">
                          <div>
                            <h3>{shot.title}</h3>
                            <span><Clock3 size={13} /> {shot.durationSeconds}s</span>
                          </div>
                          <p>{shot.action}</p>
                          <footer>
                            <span>{shot.camera.framing} · {shot.camera.movement}</span>
                            <span>{shot.frameRoles.join(' + ')}</span>
                            <code>{shot.id}</code>
                          </footer>
                        </div>
                      </article>
                    )
                  })}
                </div>
              ) : null}
            </section>

            <aside className="aq-video-continuity" aria-label="一致性资产">
              <div className="aq-video-section-heading">
                <span><Users size={17} /> 一致性基准</span>
                <small>{result.project.characters.length + result.project.locations.length} 项</small>
              </div>
              <div className="aq-video-continuity-group">
                <h3>角色</h3>
                {result.project.characters.length ? result.project.characters.map((character) => (
                  <div className="aq-video-identity-card" key={character.id}>
                    <span className="aq-video-avatar">{character.name.slice(0, 1)}</span>
                    <div><strong>{character.name}</strong><small>{statusLabel(character.consistencyStatus)}</small></div>
                    <CircleDashed size={16} />
                  </div>
                )) : <p className="aq-video-empty">尚未从对白中识别角色，可在后续角色圣经中补充。</p>}
              </div>
              <div className="aq-video-continuity-group">
                <h3>场景</h3>
                {result.project.locations.map((location) => (
                  <div className="aq-video-identity-card" key={location.id}>
                    <span className="aq-video-avatar is-location"><Layers3 size={15} /></span>
                    <div><strong>{location.name}</strong><small>{statusLabel(location.consistencyStatus)}</small></div>
                    <CircleDashed size={16} />
                  </div>
                ))}
              </div>
              <div className="aq-video-runtime-card">
                <div>
                  <span className={`aq-video-runtime-dot is-${bridgeMessage ? 'error' : runtime.state}`} />
                  <p><strong>{liveRuntimeLabel}</strong><small>{runtimeStatus?.device ?? bridgeMessage ?? runtime.detail}</small></p>
                </div>
                <div className="aq-video-runtime-rule">
                  <Wifi size={15} /> SSE {streamConnected ? '已连接' : '重连中'}
                </div>
              </div>
            </aside>
          </div>

          <section id="aq-video-execution-workspace" className="aq-video-execution" aria-label="受控执行清单">
            <div className="aq-video-execution-heading">
              <div>
                <span><ListChecks size={18} /> 执行清单</span>
                <small>计划任务 → 可执行任务 → 用户确认 → 已提交 Job</small>
              </div>
              <div className="aq-video-runtime-actions">
                <button type="button" onClick={refreshRuntime} disabled={runtimeBusy}>
                  <RefreshCw size={14} className={runtimeBusy ? 'is-spinning' : ''} /> 复检
                </button>
                {!runtimeStatus?.connected ? (
                  <button type="button" onClick={launchRuntime} disabled={runtimeBusy}>
                    <Play size={14} /> 启动 H3
                  </button>
                ) : null}
              </div>
            </div>

            <div className="aq-video-execution-stats">
              <div><ScrollText size={16} /><span>计划镜头<strong>{selectedShots.length}</strong></span></div>
              <div><CheckCircle2 size={16} /><span>可执行<strong>{readyCount}</strong></span></div>
              <div><XCircle size={16} /><span>阻塞<strong>{blockedCount}</strong></span></div>
              <div><Send size={16} /><span>已提交 Job<strong>{submittedJobs.length}</strong></span></div>
            </div>

            <div className="aq-video-execution-controls">
              <label>
                <span>生成模式</span>
                <select value={executionMode} onChange={(event) => updateExecutionMode(event.target.value as VideoExecutionMode)}>
                  <option value="text-to-video">文生视频 · T2V</option>
                  <option value="image-to-video">图生视频 · I2V</option>
                </select>
              </label>
              {executionMode === 'image-to-video' ? (
                <label>
                  <span>帧约束</span>
                  <select
                    value={imageFrameMode}
                    onChange={(event) => {
                      setImageFrameMode(event.target.value as Exclude<VideoFrameMode, 'none'>)
                      invalidateExecution()
                    }}
                  >
                    <option value="first">首帧</option>
                    <option value="first-last">首帧 + 末帧</option>
                  </select>
                </label>
              ) : null}
              <label>
                <span>质量 / 显存</span>
                <select
                  value={preset}
                  onChange={(event) => {
                    setPreset(event.target.value as VideoExecutionPreset)
                    invalidateExecution()
                  }}
                >
                  {VIDEO_EXECUTION_PRESET_ORDER.map((presetId) => {
                    const item = VIDEO_EXECUTION_PRESET_GUIDANCE[presetId]
                    const capability = runtimeStatus?.videoCapabilities?.presets.find(({ id }) => id === presetId)
                    return (
                      <option key={presetId} value={presetId} disabled={capability?.available === false}>
                        {item.label} · 8GB{capability?.available === false ? ' · 未就绪' : ''}
                      </option>
                    )
                  })}
                </select>
              </label>
              <label className="aq-video-audio-toggle">
                <input
                  type="checkbox"
                  checked={audio}
                  onChange={(event) => {
                    setAudio(event.target.checked)
                    invalidateExecution()
                  }}
                />
                <span>生成原生音频</span>
              </label>
              <div className="aq-video-hardware-pill">
                <HardDrive size={14} /> {formatVram(runtimeStatus?.vramTotal)} · {liveRuntimeLabel}
              </div>
            </div>

            <div className={`aq-video-quality-brief is-${presetGuidance.profile}${presetCapability?.available === false ? ' is-unavailable' : ''}`} aria-live="polite">
              <div>
                <span><Sparkles size={15} /></span>
                <p>
                  <strong>{presetGuidance.label}</strong>
                  <small>{presetGuidance.native}</small>
                </p>
                <b>{presetCapability?.available === false ? '当前运行时未就绪' : modelProfileLabel(activeModelProfile)}</b>
              </div>
              <p>{presetGuidance.pipeline}</p>
              <footer>
                <span>单镜头预计 {selectedEstimate ?? '需按镜头时长复核'}</span>
                <span>支持 {presetGuidance.allowedDurations.join(' / ')} 秒</span>
                {preset === 'master720' ? <span>SeedVR2 失败仍保留 Base 母片</span> : null}
              </footer>
              {unsupportedDuration ? (
                <div className="aq-video-quality-warning"><AlertTriangle size={14} /> 当前选择包含不受此档位支持的镜头时长，请先拆分镜头或改用兼容档。</div>
              ) : null}
              {presetCapability?.available === false ? (
                <div className="aq-video-quality-warning"><AlertTriangle size={14} /> 请复检运行时，或切换到未标记“未就绪”的质量档位。</div>
              ) : null}
            </div>

            <div className="aq-video-execution-shots">
              {selectedShots.length ? selectedShots.map(({ scene, shot }) => {
                const firstAsset = frameAssets[assetSlotKey(shot.id, 'first-frame')]
                const lastAsset = frameAssets[assetSlotKey(shot.id, 'last-frame')]
                return (
                  <article key={shot.id}>
                    <div className="aq-video-execution-shot-title">
                      <span>{String(scene.ordinal).padStart(2, '0')}.{String(shot.ordinal).padStart(2, '0')}</span>
                      <div><strong>{shot.title}</strong><small>{scene.heading} · {shot.id}</small></div>
                      <button type="button" onClick={() => toggleShot(shot.id)} aria-label={`移除 ${shot.title}`}><X size={14} /></button>
                    </div>
                    {executionMode === 'text-to-video' ? (
                      <div className="aq-video-no-frame"><Sparkles size={14} /> 文生视频不需要帧资产；提示词由故事与镜头确定性生成。</div>
                    ) : (
                      <div className="aq-video-frame-slots">
                        {([
                          { role: 'first-frame' as const, label: '首帧', asset: firstAsset },
                          ...(imageFrameMode === 'first-last'
                            ? [{ role: 'last-frame' as const, label: '末帧', asset: lastAsset }]
                            : []),
                        ]).map(({ role, label, asset }) => {
                          const slot = assetSlotKey(shot.id, role)
                          return (
                            <div className={`aq-video-frame-slot${asset ? ' has-asset' : ''}`} key={role}>
                              <div>
                                <span>{asset ? <FileCheck2 size={15} /> : <ImageIcon size={15} />}</span>
                                <p>
                                  <strong>{label}{asset ? '已规范化' : '缺失'}</strong>
                                  <small>{asset ? `${asset.fileName} · ${asset.contract.assetVersionId.slice(0, 18)}…` : 'PNG / JPEG / WebP，最大 20MB'}</small>
                                </p>
                              </div>
                              <div>
                                <label className="aq-video-upload-button">
                                  {assetBusy === slot ? <Loader2 size={14} className="is-spinning" /> : <Upload size={14} />}
                                  {asset ? '替换' : '导入'}
                                  <input
                                    type="file"
                                    accept="image/png,image/jpeg,image/webp"
                                    disabled={assetBusy !== null}
                                    onChange={(event) => {
                                      const file = event.currentTarget.files?.[0]
                                      event.currentTarget.value = ''
                                      if (file) void importFrame(shot.id, role, file)
                                    }}
                                  />
                                </label>
                                {asset ? <button type="button" onClick={() => removeFrame(shot.id, role)}><X size={14} /></button> : null}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </article>
                )
              }) : (
                <p className="aq-video-execution-empty">请先在分镜结构中勾选至少一个镜头。</p>
              )}
            </div>

            {executionError ? (
              <div className="aq-video-error aq-video-execution-error" role="alert">
                <AlertTriangle size={16} /><span>{executionError}</span>
              </div>
            ) : null}

            <div className="aq-video-execution-actions">
              <button
                type="button"
                className="is-secondary"
                onClick={prepareChecklist}
                disabled={!selectedShots.length || actionBusy !== null || presetCapability?.available === false || unsupportedDuration}
              >
                {actionBusy === 'prepare' ? <Loader2 size={15} className="is-spinning" /> : <ListChecks size={15} />}
                生成执行清单
              </button>
              <span><LockKeyhole size={14} /> 清单不含 Data URL、文件路径或 ComfyUI 节点 JSON</span>
            </div>

            {checklist ? (
              <div className="aq-video-checklist">
                <div className="aq-video-checklist-heading">
                  <div>
                    <span>清单 {checklist.id}</span>
                    <code>digest {checklist.digest.slice(0, 16)}…</code>
                  </div>
                  <small>{new Date(checklist.createdAt).toLocaleString()}</small>
                </div>
                <div className="aq-video-checklist-items">
                  {checklist.items.map((item) => {
                    const jobId = latestJobIdByItem[item.id]
                    const job = jobId ? jobById.get(jobId) : undefined
                    return (
                      <article className={`aq-video-checklist-item is-${item.status}`} key={item.id}>
                        <div className="aq-video-checklist-status">
                          {item.status === 'ready' ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
                        </div>
                        <div className="aq-video-checklist-content">
                          <div>
                            <strong>{item.label}</strong>
                            <span>{item.status === 'ready' ? '可执行' : '已阻塞'}</span>
                          </div>
                          <p>{item.request.prompt}</p>
                          <footer>
                            <code>{item.workflowId}</code>
                            <span>{item.request.duration}s · {item.request.preset} · seed {item.request.seed}</span>
                          </footer>
                          {item.blocks.length ? (
                            <ul>{item.blocks.map((reason) => <li key={reason.code}><b>{reason.code}</b>{reason.message}</li>)}</ul>
                          ) : null}
                          {job ? (
                            <div className={`aq-video-job is-${job.status}`}>
                              <div>
                                <span>{jobStatusLabel(job)} · {job.progress}%</span>
                                <code>{job.id}</code>
                              </div>
                              <div className="aq-video-job-progress"><i style={{ width: `${job.progress}%` }} /></div>
                              <p>{job.error ? `${job.error.code} · ${job.error.message}` : job.detail}</p>
                              {job.delivery ? (
                                <p className={`aq-video-job-delivery is-${job.delivery.status}`}>
                                  {job.delivery.status === 'copied'
                                    ? `已输出到 ${job.delivery.directoryLabel ?? '所选目录'}${job.delivery.filename ? ` · ${job.delivery.filename}` : ''}`
                                    : job.delivery.message ?? '输出副本写入失败，内部资产仍可用'}
                                </p>
                              ) : null}
                              {job.intermediateOutputs?.map((output) => (
                                <p className="aq-video-job-delivery" key={output.filename}>
                                  <a href={output.outputUrl} target="_blank" rel="noreferrer">
                                    打开{output.label} · {output.dimensions.width}×{output.dimensions.height}
                                  </a>
                                </p>
                              ))}
                              <div className="aq-video-job-actions">
                                {['queued', 'running'].includes(job.status) ? (
                                  <button type="button" onClick={() => void cancelJob(item.id, job.id)} disabled={actionBusy !== null}>
                                    {actionBusy === `cancel:${job.id}` ? <Loader2 size={13} className="is-spinning" /> : <Square size={13} />} 取消
                                  </button>
                                ) : null}
                                {['failed', 'cancelled'].includes(job.status) ? (
                                  <button type="button" onClick={() => void retryJob(item.id, job.id)} disabled={actionBusy !== null}>
                                    {actionBusy === `retry:${job.id}` ? <Loader2 size={13} className="is-spinning" /> : <RotateCcw size={13} />} 快速重试
                                  </button>
                                ) : null}
                                {job.status === 'completed' && job.outputUrl ? <a href={job.outputUrl} target="_blank" rel="noreferrer">打开 MP4</a> : null}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      </article>
                    )
                  })}
                </div>

                <div className="aq-video-confirmation">
                  <label>
                    <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
                    <span>我已核对 {readyCount} 个可执行镜头、{blockedCount} 个阻塞镜头及固定 H3 工作流</span>
                  </label>
                  <div>
                    <button
                      type="button"
                      className="is-secondary"
                      onClick={confirmChecklist}
                      disabled={!readyCount || actionBusy !== null}
                    >
                      {actionBusy === 'confirm' ? <Loader2 size={15} className="is-spinning" /> : <ShieldCheck size={15} />}
                      确认清单
                    </button>
                    <button
                      type="button"
                      className="is-primary"
                      onClick={submitConfirmed}
                      disabled={!confirmation || actionBusy !== null}
                    >
                      {actionBusy === 'submit' ? <Loader2 size={15} className="is-spinning" /> : <Send size={15} />}
                      提交 {confirmation?.confirmedItemIds.length ?? 0} 个 Job
                    </button>
                    <button
                      type="button"
                      className="is-primary aq-video-chain-button"
                      onClick={submitContinuousFilm}
                      disabled={!confirmation || confirmation.confirmedItemIds.length < 2 || actionBusy !== null}
                    >
                      {actionBusy === 'video-chain' ? <Loader2 size={15} className="is-spinning" /> : <Clapperboard size={15} />}
                      一键连续生成并成片
                    </button>
                  </div>
                  {confirmation ? (
                    <small><CheckCircle2 size={13} /> 已锁定确认指纹 {confirmation.digest.slice(0, 16)}…；任何字段变化都需要重新确认。</small>
                  ) : null}
                </div>
              </div>
            ) : null}

            {submittedJobs.length ? (
              <div className="aq-video-submitted-ledger">
                <div>
                  <Send size={15} />
                  <strong>已提交 Job</strong>
                  <small>来自当前工作台会话，状态由共享 SSE 更新</small>
                  <button
                    type="button"
                    className="aq-video-final-cut-button"
                    disabled={completedShotJobs.length < 2 || finalCutJobs.some(({ status }) => ['queued', 'running'].includes(status)) || actionBusy !== null}
                    onClick={submitFinalCut}
                  >
                    {actionBusy === 'final-cut' ? <Loader2 size={14} className="is-spinning" /> : <Clapperboard size={14} />}
                    合成 {completedShotJobs.length} 镜 720P 成片{completedSoundMixJob ? ' · 已接声音' : ''}
                  </button>
                </div>
                <div>
                  {submittedJobs.map((job) => (
                    <article key={job.id} className={job.videoChainManifest ? 'has-chain-manifest' : undefined}>
                      <span className={`is-${job.status}`}><i />{jobStatusLabel(job)}</span>
                      <code>{job.id}</code>
                      <p>{job.detail}</p>
                      <b>{job.progress}%</b>
                      {job.status === 'completed' && job.outputUrl ? <a href={job.outputUrl} target="_blank" rel="noreferrer">打开 MP4</a> : null}
                      {job.videoChainManifest ? (
                        <ol className="aq-video-chain-manifest" aria-label="连续长片逐镜执行清单">
                          {job.videoChainManifest.shots.map((entry) => {
                            const childJob = entry.childJobId ? jobById.get(entry.childJobId) : undefined
                            const backfillLabel = entry.localCandidateBackfill?.status === 'ready'
                              ? '候选已入库'
                              : entry.localCandidateBackfill?.status === 'rejected'
                                ? `候选回填拒绝 · ${entry.localCandidateBackfill.code}`
                                : entry.candidateTarget
                                  ? '已绑定候选目标'
                                  : '仅生成成片镜头'
                            return (
                              <li key={`${entry.index}:${entry.executionItemId}`} className={`is-${entry.status}`}>
                                <span><i />第 {entry.index + 1} 镜</span>
                                <strong>{chainShotStatusLabel(entry.status)}</strong>
                                <code title={entry.executionItemId}>{entry.executionItemId}</code>
                                <small>{backfillLabel}</small>
                                {childJob?.outputUrl ? <a href={childJob.outputUrl} target="_blank" rel="noreferrer">镜头 MP4</a> : null}
                              </li>
                            )
                          })}
                        </ol>
                      ) : null}
                      {job.finalCutMetadata?.qualityReport ? (() => {
                        const quality = job.finalCutMetadata.qualityReport
                        const attention = quality.checks.filter(({ status }) => status === 'fail').slice(0, 4)
                        const loudness = quality.signals.loudness.integratedLufs
                        return (
                          <section className={`aq-video-delivery-quality is-${quality.summary.status}`} aria-label="720P 成片质量报告">
                            <header>
                              <span><ShieldCheck size={11} />{deliveryQualityStatusLabel(quality.summary.status)}</span>
                              <div>
                                <code>{quality.profileVersion}</code>
                                <a href={`/api/jobs/${encodeURIComponent(job.id)}/quality-report`} target="_blank" rel="noreferrer">质检 JSON</a>
                              </div>
                            </header>
                            <dl>
                              <div><dt>画面</dt><dd>{quality.media.width}×{quality.media.height} · {quality.media.frameRate.toFixed(2)}fps</dd></div>
                              <div><dt>时长</dt><dd>{quality.media.durationSeconds.toFixed(2)}s</dd></div>
                              <div><dt>响度</dt><dd>{loudness === null ? '未测得' : `${loudness.toFixed(1)} LUFS`}</dd></div>
                              <div><dt>画面信号</dt><dd>黑场 {quality.signals.black.totalSeconds.toFixed(2)}s · 静帧 {quality.signals.freeze.longestSeconds.toFixed(2)}s</dd></div>
                            </dl>
                            {attention.length ? (
                              <ul>
                                {attention.map((item) => <li key={item.id}>{item.label}：{item.message}</li>)}
                              </ul>
                            ) : <p>结构、声画规格与自动回归信号均未发现异常。</p>}
                            <footer>{quality.summary.statement}</footer>
                          </section>
                        )
                      })() : null}
                    </article>
                  ))}
                </div>
              </div>
            ) : null}
          </section>
        </main>
          </>
        ) : null}
      </div>

      {activeWorkspace === 'production' ? (
        <footer className="aq-video-footer">
          <div><ShieldCheck size={15} /> 本地制片状态机 · 节点审批后才会继续，不会假装已调用外部模型或生成成片</div>
          <button type="button" onClick={() => revealWorkspace('execution')}><ListChecks size={15} /> 查看 H3 执行边界</button>
        </footer>
      ) : (
        <footer className="aq-video-footer">
          <div>
            <ShieldCheck size={15} />
            {selectedShots.length} 个计划镜头 · {readyCount} 个可执行 · {blockedCount} 个阻塞 · {submittedJobs.length} 个已提交 Job
          </div>
          <button type="button" onClick={prepareChecklist} disabled={!selectedShots.length || actionBusy !== null}>
            {actionBusy === 'prepare' ? <Loader2 size={15} className="is-spinning" /> : <ListChecks size={15} />}
            检查执行依赖
          </button>
        </footer>
      )}
    </section>
  )
}

export default SmartVideoWorkbench
