import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import BalancedWorkbench from './App'
import { RuntimeSettingsDialog, SurfaceState } from './components/Home'
import {
  deserializePixelDocument,
  serializePixelDocument,
  type PixelDocument,
} from './lib/pixel'
import { loadLocalProject, type StoredProject } from './lib/projectApi'
import {
  configureRuntime,
  fetchClientState,
  fetchRuntimeDiagnostics,
  fetchRuntimeStatus,
  saveClientState,
  startRuntime,
  stopRuntime,
} from './lib/videoApi'
import {
  PixelModeWorkbench,
  type PixelSpriteSheetPayload,
} from './modes/pixel'
import {
  SmartVideoWorkbench,
  type SmartVideoPlanResult,
  type SmartVideoRuntimeSummary,
} from './modes/video'
import {
  AeonQuillShell,
  createProductTarget,
  DEFAULT_BALANCED_PROJECT_ID,
  ModeErrorBoundary,
  parseProductHash,
  parseShellPreferences,
  parseSmartVideoSession,
  PRODUCT_SHELL_PREFERENCES_KEY,
  resolveCollectionState,
  resolvePixelDraftEntry,
  serializeShellPreferences,
  serializeSmartVideoSession,
  SMART_VIDEO_SESSION_KEY,
  type LocalRuntimeSummary,
  type ModeAvailabilitySummary,
  type ProductLocation,
  type ProductModeId,
  type RecentProjectSummary,
  type RuntimeHealth,
  type RuntimeSurfaceSummary,
  type ShellFeedback,
  type ShellPreferences,
  type SmartVideoSessionSummary,
} from './shell'
import type {
  RuntimeConfigurationRequest,
  RuntimeDiagnostics,
  RuntimeStatus,
} from './types'
import './product-app.css'

type RuntimeProbe = {
  bridgeReady: boolean
  checking: boolean
  checkedAt?: number
  runtime: RuntimeStatus | null
  diagnostics: RuntimeDiagnostics | null
  error?: string
}

type ProjectProbe = {
  projectId: string
  status: 'idle' | 'loading' | 'ready' | 'empty' | 'error'
  project: StoredProject | null
  error?: string
}

type PixelDraftSnapshot = {
  status: 'empty' | 'ready' | 'error'
  document?: PixelDocument
  error?: string
}

type VideoSessionSnapshot = {
  status: 'empty' | 'ready' | 'error'
  session?: SmartVideoSessionSummary
  error?: string
}

type ProductNotice = {
  tone: 'success' | 'error' | 'info'
  message: string
}

const PIXEL_STORAGE_KEY = 'aeonquill:pixel-document:v1'

function readRoute(): ProductLocation {
  return parseProductHash(window.location.hash)
}

function routeKey(route: Pick<ProductLocation, 'modeId' | 'projectId'>) {
  return `${route.modeId}:${route.projectId ?? ''}`
}

function readShellPreferences() {
  try {
    return parseShellPreferences(localStorage.getItem(PRODUCT_SHELL_PREFERENCES_KEY))
  } catch {
    return parseShellPreferences(null)
  }
}

function isMeaningfulPixelDraft(document: PixelDocument) {
  return document.id !== 'aeonquill-pixel-starter' || document.revision > 0
}

function readPixelDraft(): PixelDraftSnapshot {
  try {
    const stored = localStorage.getItem(PIXEL_STORAGE_KEY)
    if (!stored) return { status: 'empty' }
    const document = deserializePixelDocument(stored)
    return isMeaningfulPixelDraft(document)
      ? { status: 'ready', document }
      : { status: 'empty' }
  } catch {
    return {
      status: 'error',
      error: '现有像素草稿未通过格式校验。原数据仍保留，可重试读取或明确开始新草稿。',
    }
  }
}

function readVideoSession(): VideoSessionSnapshot {
  try {
    const stored = sessionStorage.getItem(SMART_VIDEO_SESSION_KEY)
    if (!stored) return { status: 'empty' }
    const session = parseSmartVideoSession(stored)
    return session
      ? { status: 'ready', session }
      : {
          status: 'error',
          error: '此标签页中的智能视频会话摘要无效。未把它伪装成可恢复项目。',
        }
  } catch {
    return {
      status: 'error',
      error: '浏览器拒绝读取智能视频会话存储。当前仍可开始新故事，但刷新后不会恢复。',
    }
  }
}

function formatBytes(value?: number) {
  if (!value || value <= 0) return '未报告'
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`
  return `${Math.round(value / 1024 ** 2)} MB`
}

function relativeTime(timestamp?: number) {
  if (!timestamp) return '尚未保存'
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
  if (seconds < 60) return '刚刚更新'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(timestamp)
}

function runtimeHealth(probe: RuntimeProbe): RuntimeHealth {
  if (probe.checking && !probe.checkedAt) return 'checking'
  if (!probe.bridgeReady) return 'offline'
  if (probe.runtime?.lifecycle?.state === 'starting') return 'starting'
  if ((probe.runtime?.queueRunning ?? 0) + (probe.runtime?.queuePending ?? 0) > 0) return 'busy'
  return 'ready'
}

function makeRuntimeSummary(probe: RuntimeProbe): LocalRuntimeSummary {
  const runtime = probe.runtime
  const diagnostics = probe.diagnostics
  const imageProcessors = diagnostics?.capabilities.image.available ?? 0
  const storageReady = diagnostics
    ? diagnostics.storage.dataWritable && diagnostics.storage.configWritable
    : probe.bridgeReady
  const queueCount = (runtime?.queueRunning ?? 0) + (runtime?.queuePending ?? 0)
  const lifecycle = runtime?.lifecycle
  const initialCheck = probe.checking && !probe.checkedAt
  const comfyNeedsConfiguration = diagnostics?.capabilities.comfyui.status === 'needs-configuration'
  const comfyStatus: RuntimeHealth = initialCheck
    ? 'checking'
    : comfyNeedsConfiguration
      ? 'unavailable'
    : lifecycle?.state === 'starting'
      ? 'starting'
      : runtime?.connected && runtime.ready
        ? queueCount > 0 ? 'busy' : 'ready'
        : runtime?.connected ? 'unavailable' : 'offline'
  const missingCount = (runtime?.missingNodes?.length ?? 0) + (runtime?.missingModels?.length ?? 0)
  const usedVram = runtime?.vramTotal && runtime.vramFree !== undefined
    ? Math.max(0, runtime.vramTotal - runtime.vramFree)
    : undefined
  const items: RuntimeSurfaceSummary[] = [
    {
      id: 'bridge',
      label: '本机服务桥接',
      status: initialCheck ? 'checking' : probe.bridgeReady ? 'ready' : 'offline',
      statusLabel: initialCheck ? '检查中' : probe.bridgeReady ? '已连接' : '未连接',
      detail: probe.bridgeReady ? '项目、任务与资产接口可用' : probe.error ?? '请通过本地应用启动服务',
    },
    {
      id: 'comfyui',
      label: 'ComfyUI',
      status: comfyStatus,
      statusLabel: comfyStatus === 'busy'
        ? `队列 ${queueCount}`
        : comfyStatus === 'ready'
          ? '已就绪'
          : comfyStatus === 'starting'
            ? '启动中'
            : comfyNeedsConfiguration ? '待配置' : comfyStatus === 'unavailable' ? '依赖不完整' : comfyStatus === 'checking' ? '检查中' : '休眠',
      detail: comfyNeedsConfiguration
        ? '在设置中自动发现或指定本机 ComfyUI'
        : runtime?.connected
        ? `${lifecycle?.owned ? '光阴砚托管' : '外部进程'} · ${runtime.comfyVersion ?? '版本未知'}`
        : '按需启动；规划与浏览器编辑仍可离线使用',
      actionLabel: comfyNeedsConfiguration
        ? '配置'
        : lifecycle?.owned && runtime?.connected ? '关闭' : !runtime?.connected && probe.bridgeReady ? '启动' : undefined,
    },
    {
      id: 'gpu',
      label: '图形处理器',
      status: runtime?.device ? queueCount ? 'busy' : 'ready' : initialCheck ? 'checking' : 'offline',
      statusLabel: runtime?.device ? queueCount ? '任务中' : '可用' : initialCheck ? '检查中' : '待检测',
      detail: runtime?.device
        ? `${runtime.device} · ${formatBytes(runtime.vramFree)} 可用`
        : '启动 ComfyUI 后读取显存状态',
      usagePercent: usedVram !== undefined && runtime?.vramTotal
        ? Math.round((usedVram / runtime.vramTotal) * 100)
        : undefined,
    },
    {
      id: 'models',
      label: '图像与模型依赖',
      status: initialCheck
        ? 'checking'
        : imageProcessors > 0 || runtime?.ready
          ? 'ready'
          : missingCount || diagnostics ? 'unavailable' : 'offline',
      statusLabel: imageProcessors > 0
        ? `图像 ${imageProcessors} 项`
        : runtime?.ready ? '视频契约满足' : missingCount ? `缺少 ${missingCount}` : initialCheck ? '检查中' : '待配置',
      detail: missingCount
        ? `${runtime?.missingNodes?.length ?? 0} 个节点、${runtime?.missingModels?.length ?? 0} 个模型待处理；${imageProcessors} 项图像执行器可用`
        : imageProcessors > 0
          ? `${imageProcessors}/${diagnostics?.capabilities.image.total ?? imageProcessors} 项本机图像执行器可用`
          : runtime?.ready ? '当前视频工作流依赖已通过探测' : '未探测到正式图像执行器；视频运行时当前休眠',
    },
    {
      id: 'storage',
      label: '项目与资产存储',
      status: initialCheck ? 'checking' : storageReady ? 'ready' : probe.bridgeReady ? 'unavailable' : 'offline',
      statusLabel: initialCheck ? '检查中' : storageReady ? '本机可写' : probe.bridgeReady ? '权限异常' : '未连接',
      detail: storageReady ? '项目、客户端状态与不可变资产由当前用户数据目录管理' : '浏览器仍保留有限离线草稿',
    },
  ]

  const baseStatus = runtimeHealth(probe)
  const status: RuntimeHealth = baseStatus === 'ready' && diagnostics && (!storageReady || imageProcessors === 0)
    ? 'unavailable'
    : baseStatus
  const feedback: ShellFeedback | undefined = initialCheck
    ? {
        status: 'loading',
        title: '正在检查本机运行时',
        detail: '正在读取桥接、ComfyUI、显卡和模型的真实状态。',
      }
    : probe.error
      ? {
          status: 'error',
          title: probe.bridgeReady ? '运行时操作未完成' : '未连接本机服务',
          detail: probe.error,
          actionLabel: '重新检查',
        }
      : lifecycle?.state === 'starting'
        ? {
            status: 'loading',
            title: 'ComfyUI 正在按需启动',
            detail: '模型与节点探测完成后会自动更新；无需重复点击。',
          }
        : undefined

  return {
    status,
    statusLabel: status === 'checking'
      ? '正在检查'
      : status === 'busy'
        ? '正在创作'
        : status === 'starting'
          ? '正在启动'
          : status === 'ready'
            ? '本机可用'
            : status === 'unavailable' && probe.bridgeReady ? '部分能力待配置' : '浏览器离线模式',
    detail: probe.bridgeReady
      ? imageProcessors > 0
        ? `${imageProcessors} 项本机图像处理可直接使用；GPU 工作流按任务启动并在空闲后释放。`
        : '画布与像素编辑可用，但尚未探测到正式本机图像执行器；请打开设置查看诊断。'
      : '像素与画布基础编辑仍可使用，ComfyUI 与本机资产能力暂不可用。',
    lastCheckedLabel: probe.checkedAt ? relativeTime(probe.checkedAt) : undefined,
    privacyNote: '本地工作流、素材与模型默认留在此设备；只有明确配置的文本或生成 API 才会访问外部服务。',
    feedback,
    items,
  }
}

function makeSmartVideoRuntime(probe: RuntimeProbe): SmartVideoRuntimeSummary {
  const runtime = probe.runtime
  const queueCount = (runtime?.queueRunning ?? 0) + (runtime?.queuePending ?? 0)
  if (probe.diagnostics?.capabilities.comfyui.status === 'needs-configuration') {
    return { state: 'offline', label: 'ComfyUI 待配置', detail: '先在主页设置中自动发现或指定本机运行时' }
  }
  if (runtime?.lifecycle?.state === 'error') {
    return { state: 'error', label: 'ComfyUI 异常', detail: runtime.lifecycle.lastError ?? runtime.message }
  }
  if (runtime?.lifecycle?.state === 'starting') return { state: 'starting', label: 'ComfyUI 启动中', detail: '正在加载节点与模型' }
  if (runtime?.connected && runtime.ready) {
    return queueCount
      ? { state: 'busy', label: `ComfyUI 队列 ${queueCount}`, detail: runtime.device }
      : { state: 'ready', label: 'ComfyUI 已就绪', detail: runtime.device }
  }
  return {
    state: 'offline',
    label: probe.bridgeReady ? 'ComfyUI 休眠' : '本机桥接离线',
    detail: '当前页面只生成受控计划，不会隐式启动模型',
  }
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

async function exportSpriteSheet(payload: PixelSpriteSheetPayload) {
  const { metadata, pixels, document: pixelDocument } = payload
  const canvas = document.createElement('canvas')
  canvas.width = metadata.width
  canvas.height = metadata.height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('浏览器无法创建 Sprite Sheet 画布')
  context.imageSmoothingEnabled = false
  const imageData = context.createImageData(metadata.width, metadata.height)
  imageData.data.set(pixels)
  context.putImageData(imageData, 0, 0)
  const image = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('无法编码 Sprite Sheet PNG')), 'image/png')
  })
  const safeName = pixelDocument.name.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-|-$/g, '') || 'aeonquill-sprite'
  downloadBlob(image, `${safeName}.png`)
  downloadBlob(
    new Blob([JSON.stringify(metadata, null, 2)], { type: 'application/json' }),
    `${safeName}.sprite.json`,
  )
}

interface ModeGateProps {
  modeLabel: string
  feedback: ShellFeedback
  onAction?: () => void
  onSecondaryAction?: () => void
  onBack: () => void
}

function ModeGate({ modeLabel, feedback, onAction, onSecondaryAction, onBack }: ModeGateProps) {
  return (
    <main className="aq-product-state-host" aria-label={`${modeLabel}进入状态`}>
      <header className="aq-mode-gate__header">
        <button type="button" className="aq-mode-gate__back" onClick={onBack}>返回主页</button>
        <span>光阴砚 AEONQUILL · {modeLabel}</span>
      </header>
      <SurfaceState
        feedback={feedback}
        focusOnMount
        onAction={onAction}
        onSecondaryAction={onSecondaryAction}
      />
    </main>
  )
}

interface ProductModeHostProps {
  modeId: ProductModeId
  modeLabel: string
  routeKey: string
  notice: ProductNotice | null
  onBack: () => void
  children: ReactNode
}

function ProductModeHost({ modeId, modeLabel, routeKey: currentRouteKey, notice, onBack, children }: ProductModeHostProps) {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      hostRef.current?.querySelector<HTMLButtonElement>('button[aria-label*="返回"]')?.focus()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [])

  return (
    <div ref={hostRef} className="aq-product-mode-host" data-product-mode={modeId}>
      <ModeErrorBoundary modeLabel={modeLabel} resetKey={currentRouteKey} onBack={onBack}>
        {children}
      </ModeErrorBoundary>
      {notice ? (
        <div className={`aq-product-notice is-${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
          {notice.message}
        </div>
      ) : null}
    </div>
  )
}

export default function ProductApp() {
  const initialPreferences = useRef<ShellPreferences>(readShellPreferences())
  const initialPixelDraft = useRef<PixelDraftSnapshot>(readPixelDraft())
  const initialVideoSession = useRef<VideoSessionSnapshot>(readVideoSession())
  const [route, setRoute] = useState<ProductLocation>(readRoute)
  const [preferences, setPreferences] = useState<ShellPreferences>(initialPreferences.current)
  const [selectedModeId, setSelectedModeId] = useState<ProductModeId>(() =>
    route.modeId === 'home' ? initialPreferences.current.selectedModeId : route.modeId,
  )
  const [runtimeProbe, setRuntimeProbe] = useState<RuntimeProbe>({
    bridgeReady: false,
    checking: true,
    runtime: null,
    diagnostics: null,
  })
  const [refreshingRuntime, setRefreshingRuntime] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [settingsError, setSettingsError] = useState<string>()
  const [settingsMessage, setSettingsMessage] = useState<string>()
  const [projectProbe, setProjectProbe] = useState<ProjectProbe>({
    projectId: initialPreferences.current.balancedProjectId,
    status: 'idle',
    project: null,
  })
  const [pixelDraft, setPixelDraft] = useState<PixelDraftSnapshot>(initialPixelDraft.current)
  const [videoSession, setVideoSession] = useState<VideoSessionSnapshot>(initialVideoSession.current)
  const [entryIntentKey, setEntryIntentKey] = useState<string | null>(null)
  const [modeNotice, setModeNotice] = useState<ProductNotice | null>(null)
  const projectRequestRef = useRef(0)
  const announcedRecoveryRef = useRef<string | null>(null)
  const clientStateHydratedRef = useRef(false)
  const clientStateDirtyRef = useRef(new Set<string>())
  const bridgeReadyRef = useRef(false)
  const preferencesRef = useRef(preferences)
  const videoSessionRef = useRef(videoSession)
  const pixelBridgeSaveTimerRef = useRef<number | undefined>(undefined)
  const pixelBridgeSaveRef = useRef<string | undefined>(undefined)
  const currentRouteKey = routeKey(route)

  useEffect(() => {
    bridgeReadyRef.current = runtimeProbe.bridgeReady
  }, [runtimeProbe.bridgeReady])

  useEffect(() => {
    preferencesRef.current = preferences
  }, [preferences])

  useEffect(() => {
    videoSessionRef.current = videoSession
  }, [videoSession])

  const updatePreferences = useCallback((patch: Partial<ShellPreferences>) => {
    setPreferences((current) => {
      const next = parseShellPreferences(serializeShellPreferences({ ...current, ...patch }))
      const serialized = serializeShellPreferences(next)
      clientStateDirtyRef.current.add('shell-preferences')
      try {
        localStorage.setItem(PRODUCT_SHELL_PREFERENCES_KEY, serialized)
      } catch {
        // Preferences remain valid for the current page even if storage is unavailable.
      }
      if (bridgeReadyRef.current) void saveClientState('shell-preferences', serialized).catch(() => undefined)
      return next
    })
  }, [])

  const chooseMode = useCallback((modeId: ProductModeId) => {
    setSelectedModeId(modeId)
    updatePreferences({ selectedModeId: modeId })
  }, [updatePreferences])

  const navigate = useCallback((next: { modeId: 'home' | ProductModeId; projectId?: string }, replace = false) => {
    const target = createProductTarget(window.location.pathname, window.location.search, next)
    window.history[replace ? 'replaceState' : 'pushState']({ aeonquillRoute: next.modeId }, '', target)
    const normalized: ProductLocation = { ...next, canonical: true }
    setRoute(normalized)
    setEntryIntentKey(null)
    if (next.modeId !== 'home') {
      chooseMode(next.modeId)
      if (next.modeId === 'balanced' && next.projectId) {
        updatePreferences({ balancedProjectId: next.projectId })
      }
    }
  }, [chooseMode, updatePreferences])

  const replaceModeProjectReference = useCallback((modeId: ProductModeId, projectId: string) => {
    const next = { modeId, projectId }
    const target = createProductTarget(window.location.pathname, window.location.search, next)
    window.history.replaceState({ aeonquillRoute: modeId }, '', target)
    setRoute({ ...next, canonical: true })
    if (modeId === 'balanced') updatePreferences({ balancedProjectId: projectId })
  }, [updatePreferences])

  useEffect(() => {
    const syncRoute = () => {
      const next = readRoute()
      if (!next.canonical) {
        const homeTarget = createProductTarget(window.location.pathname, window.location.search, { modeId: 'home' })
        window.history.replaceState({ aeonquillRoute: 'home' }, '', homeTarget)
        setRoute({ modeId: 'home', canonical: true })
        setEntryIntentKey(null)
        return
      }
      setRoute(next)
      setEntryIntentKey(null)
      if (next.modeId !== 'home') chooseMode(next.modeId)
    }

    syncRoute()
    window.addEventListener('popstate', syncRoute)
    window.addEventListener('hashchange', syncRoute)
    return () => {
      window.removeEventListener('popstate', syncRoute)
      window.removeEventListener('hashchange', syncRoute)
    }
  }, [chooseMode])

  useEffect(() => {
    if (route.modeId !== 'home') return
    const frame = window.requestAnimationFrame(() => document.getElementById('aq-home-title')?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [route.modeId])

  const refreshRuntime = useCallback(async (background = false) => {
    if (!background) {
      setRefreshingRuntime(true)
      setRuntimeProbe((current) => ({ ...current, checking: true, error: undefined }))
    }
    try {
      const [runtime, diagnostics] = await Promise.all([
        fetchRuntimeStatus(true),
        fetchRuntimeDiagnostics(true),
      ])
      setRuntimeProbe({ bridgeReady: true, checking: false, checkedAt: Date.now(), runtime, diagnostics })
    } catch (error) {
      setRuntimeProbe({
        bridgeReady: false,
        checking: false,
        checkedAt: Date.now(),
        runtime: null,
        diagnostics: null,
        error: error instanceof Error ? error.message : '无法连接本机服务',
      })
    } finally {
      if (!background) setRefreshingRuntime(false)
    }
  }, [])

  useEffect(() => {
    if (!runtimeProbe.bridgeReady || clientStateHydratedRef.current) return
    clientStateHydratedRef.current = true
    let disposed = false

    void Promise.allSettled([
      fetchClientState('shell-preferences'),
      fetchClientState('pixel-document'),
      fetchClientState('smart-video-session'),
    ]).then(([shellResult, pixelResult, videoResult]) => {
      if (disposed) return

      if (shellResult.status === 'fulfilled') {
        const state = shellResult.value
        if (state && !clientStateDirtyRef.current.has('shell-preferences')) {
          const restored = parseShellPreferences(state.value)
          setPreferences(restored)
          if (route.modeId === 'home') setSelectedModeId(restored.selectedModeId)
          try { localStorage.setItem(PRODUCT_SHELL_PREFERENCES_KEY, state.value) } catch { /* bridge remains canonical */ }
        } else if (clientStateDirtyRef.current.has('shell-preferences')) {
          void saveClientState('shell-preferences', serializeShellPreferences(preferencesRef.current)).catch(() => undefined)
        } else if (!state) {
          void saveClientState('shell-preferences', serializeShellPreferences(initialPreferences.current)).catch(() => undefined)
        }
      }

      if (pixelResult.status === 'fulfilled') {
        const state = pixelResult.value
        if (state && !clientStateDirtyRef.current.has('pixel-document')) {
          try {
            const document = deserializePixelDocument(state.value)
            setPixelDraft(isMeaningfulPixelDraft(document) ? { status: 'ready', document } : { status: 'empty' })
            try { localStorage.setItem(PIXEL_STORAGE_KEY, state.value) } catch { /* large state remains bridge-backed */ }
          } catch {
            // Keep the already validated browser fallback if a newer client cannot read this state.
          }
        } else if (clientStateDirtyRef.current.has('pixel-document') && pixelBridgeSaveRef.current) {
          void saveClientState('pixel-document', pixelBridgeSaveRef.current).catch(() => undefined)
        } else if (!state && initialPixelDraft.current.status === 'ready' && initialPixelDraft.current.document) {
          void saveClientState('pixel-document', serializePixelDocument(initialPixelDraft.current.document)).catch(() => undefined)
        }
      }

      if (videoResult.status === 'fulfilled') {
        const state = videoResult.value
        if (state && !clientStateDirtyRef.current.has('smart-video-session')) {
          const session = parseSmartVideoSession(state.value)
          if (session) {
            setVideoSession({ status: 'ready', session })
            try { sessionStorage.setItem(SMART_VIDEO_SESSION_KEY, state.value) } catch { /* bridge remains canonical */ }
          }
        } else if (
          clientStateDirtyRef.current.has('smart-video-session')
          && videoSessionRef.current.session
        ) {
          void saveClientState('smart-video-session', serializeSmartVideoSession(videoSessionRef.current.session)).catch(() => undefined)
        } else if (!state && initialVideoSession.current.status === 'ready' && initialVideoSession.current.session) {
          void saveClientState('smart-video-session', serializeSmartVideoSession(initialVideoSession.current.session)).catch(() => undefined)
        }
      }
    })

    return () => { disposed = true }
  }, [runtimeProbe.bridgeReady])

  useEffect(() => {
    if (route.modeId === 'balanced') return
    void refreshRuntime()
    const timer = window.setInterval(() => void refreshRuntime(true), 15_000)
    return () => window.clearInterval(timer)
  }, [refreshRuntime, route.modeId])

  const refreshProject = useCallback(async (projectId: string) => {
    const requestId = projectRequestRef.current + 1
    projectRequestRef.current = requestId
    setProjectProbe((current) => ({
      projectId,
      status: 'loading',
      project: current.projectId === projectId ? current.project : null,
    }))
    try {
      const project = await loadLocalProject(projectId)
      if (projectRequestRef.current !== requestId) return
      if (!project) {
        setProjectProbe({ projectId, status: 'empty', project: null })
        return
      }
      setProjectProbe({ projectId, status: 'ready', project })
      updatePreferences({ balancedProjectId: project.id })
    } catch (error) {
      if (projectRequestRef.current !== requestId) return
      setProjectProbe({
        projectId,
        status: 'error',
        project: null,
        error: error instanceof Error ? error.message : '无法读取本机项目',
      })
    }
  }, [updatePreferences])

  useEffect(() => {
    const projectId = route.modeId === 'balanced'
      ? route.projectId ?? preferences.balancedProjectId
      : preferences.balancedProjectId
    void refreshProject(projectId)
  }, [preferences.balancedProjectId, refreshProject, route.modeId, route.projectId])

  const retryLocalContexts = useCallback(() => {
    setPixelDraft(readPixelDraft())
    setVideoSession(readVideoSession())
    void refreshProject(preferences.balancedProjectId)
  }, [preferences.balancedProjectId, refreshProject])

  const openRuntimeSettings = useCallback(() => {
    setSettingsOpen(true)
    setSettingsError(undefined)
    setSettingsMessage(undefined)
    void refreshRuntime()
  }, [refreshRuntime])

  const handleRuntimeConfigure = useCallback(async (request: RuntimeConfigurationRequest) => {
    if (settingsSaving) return
    setSettingsSaving(true)
    setSettingsError(undefined)
    setSettingsMessage(undefined)
    try {
      const result = await configureRuntime(request)
      setRuntimeProbe((current) => ({
        ...current,
        bridgeReady: true,
        diagnostics: result.diagnostics,
        checkedAt: result.diagnostics.checkedAt,
        error: undefined,
      }))
      setSettingsMessage(result.message)
      if (!result.restartRequired) void refreshRuntime(true)
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : '本机设置保存失败')
    } finally {
      setSettingsSaving(false)
    }
  }, [refreshRuntime, settingsSaving])

  const handleRuntimeAction = useCallback(async (item: RuntimeSurfaceSummary) => {
    if (item.id !== 'comfyui' || refreshingRuntime) return
    if (item.actionLabel === '配置') {
      openRuntimeSettings()
      return
    }
    setRefreshingRuntime(true)
    setRuntimeProbe((current) => ({ ...current, error: undefined }))
    try {
      const runtime = runtimeProbe.runtime?.connected && runtimeProbe.runtime.lifecycle?.owned
        ? await stopRuntime()
        : await startRuntime()
      setRuntimeProbe((current) => ({
        ...current,
        bridgeReady: true,
        checking: false,
        checkedAt: Date.now(),
        runtime,
      }))
      void fetchRuntimeDiagnostics(true).then((diagnostics) => {
        setRuntimeProbe((current) => ({ ...current, diagnostics }))
      }).catch(() => undefined)
    } catch (error) {
      setRuntimeProbe((current) => ({
        ...current,
        checking: false,
        checkedAt: Date.now(),
        error: error instanceof Error ? error.message : '运行时操作失败',
      }))
    } finally {
      setRefreshingRuntime(false)
    }
  }, [openRuntimeSettings, refreshingRuntime, runtimeProbe.runtime])

  const runtimeSummary = useMemo(() => makeRuntimeSummary(runtimeProbe), [runtimeProbe])
  const smartVideoRuntime = useMemo(() => makeSmartVideoRuntime(runtimeProbe), [runtimeProbe])
  const modeAvailability = useMemo<Partial<Record<ProductModeId, ModeAvailabilitySummary>>>(() => ({
    balanced: runtimeProbe.bridgeReady && (runtimeProbe.diagnostics?.capabilities.image.available ?? 0) > 0
      ? { status: 'available', label: `本机增强 ${runtimeProbe.diagnostics?.capabilities.image.available} 项` }
      : runtimeProbe.bridgeReady
        ? { status: 'degraded', label: '画布可用', reason: '未探测到正式本机图像处理器，请在设置中检查依赖' }
      : { status: 'degraded', label: '浏览器模式', reason: '本机任务与资产服务暂未连接' },
    pixel: { status: 'available', label: '确定性内核可用' },
    'smart-video': runtimeProbe.runtime?.connected && runtimeProbe.runtime.ready
      ? { status: 'available', label: '规划与本地工作流可用' }
      : { status: 'degraded', label: '规划模式', reason: 'ComfyUI 将在实际生成阶段按需启动' },
  }), [runtimeProbe])

  const recentProjects = useMemo<RecentProjectSummary[]>(() => {
    const projects: RecentProjectSummary[] = []
    if (projectProbe.status === 'ready' && projectProbe.project && projectProbe.project.revision > 0) {
      projects.push({
        id: projectProbe.project.id,
        title: projectProbe.project.title,
        modeId: 'balanced',
        updatedLabel: relativeTime(projectProbe.project.updatedAt),
        description: `${projectProbe.project.document.elements.length} 个画布元件 · revision ${projectProbe.project.revision}`,
      })
    }
    if (pixelDraft.status === 'ready' && pixelDraft.document) {
      projects.push({
        id: pixelDraft.document.id,
        title: pixelDraft.document.name,
        modeId: 'pixel',
        updatedLabel: '本机草稿',
        description: `${pixelDraft.document.width} × ${pixelDraft.document.height} · ${pixelDraft.document.frames.length} 帧 · ${pixelDraft.document.layers.length} 图层`,
      })
    }
    if (videoSession.status === 'ready' && videoSession.session) {
      projects.push({
        id: videoSession.session.projectId,
        title: videoSession.session.title,
        modeId: 'smart-video',
        updatedLabel: relativeTime(videoSession.session.updatedAt),
        description: `${videoSession.session.sceneCount} 个场景 · ${videoSession.session.taskCount} 个受控任务 · 本机会话摘要`,
      })
    }
    return projects.sort((left, right) => left.modeId === 'balanced' ? -1 : right.modeId === 'balanced' ? 1 : 0)
  }, [pixelDraft, projectProbe, videoSession])

  const recentProjectsFeedback = useMemo<ShellFeedback | undefined>(() => {
    const contextErrors = [projectProbe.error, pixelDraft.error, videoSession.error].filter(Boolean) as string[]
    const recoveredCount = recentProjects.length
    const state = resolveCollectionState({
      loading: projectProbe.status === 'idle' || projectProbe.status === 'loading',
      error: contextErrors.length > 0,
      itemCount: recentProjects.length,
      recoveredCount,
    })
    if (state === 'ready') return undefined
    if (state === 'loading') {
      return {
        status: 'loading',
        title: '正在读取本机项目',
        detail: '最近项目只来自 ProjectStore 与已存在的模式草稿，不会插入演示项目。',
      }
    }
    if (state === 'error') {
      return {
        status: 'error',
        title: recentProjects.length ? '部分本机上下文未能读取' : '无法读取最近项目',
        detail: contextErrors.join('；'),
        actionLabel: '重试读取',
      }
    }
    if (state === 'empty') {
      return {
        status: 'empty',
        title: '尚无可恢复的项目或草稿',
        detail: '进入上方模式后，只有真实保存或产生修改的内容才会出现在这里。',
      }
    }
    return {
      status: 'recovered',
      title: `已恢复 ${recoveredCount} 条本机创作上下文`,
      detail: '均衡项目来自 ProjectStore；像素草稿与智能视频会话由当前用户数据目录和浏览器回退共同恢复。',
    }
  }, [pixelDraft.error, projectProbe.error, projectProbe.status, recentProjects.length, videoSession.error])

  const queuePixelBridgeSave = useCallback((serialized: string) => {
    pixelBridgeSaveRef.current = serialized
    if (pixelBridgeSaveTimerRef.current !== undefined) window.clearTimeout(pixelBridgeSaveTimerRef.current)
    pixelBridgeSaveTimerRef.current = window.setTimeout(() => {
      pixelBridgeSaveTimerRef.current = undefined
      const value = pixelBridgeSaveRef.current
      if (!value || !bridgeReadyRef.current) return
      void saveClientState('pixel-document', value).then(() => {
        if (pixelBridgeSaveRef.current === value) pixelBridgeSaveRef.current = undefined
      }).catch(() => {
        setPixelDraft((current) => current.document
          ? { ...current, status: 'error', error: '像素草稿仍在当前页面，但本机持久化失败；刷新前请先导出。' }
          : current)
        setModeNotice({ tone: 'error', message: '像素草稿未能写入本机用户数据；刷新前请先导出。' })
      })
    }, 300)
  }, [])

  useEffect(() => () => {
    if (pixelBridgeSaveTimerRef.current !== undefined) window.clearTimeout(pixelBridgeSaveTimerRef.current)
    const value = pixelBridgeSaveRef.current
    if (value && bridgeReadyRef.current) void saveClientState('pixel-document', value).catch(() => undefined)
  }, [])

  const handlePixelChange = useCallback((next: PixelDocument) => {
    if (!isMeaningfulPixelDraft(next)) {
      const serialized = serializePixelDocument(next)
      clientStateDirtyRef.current.add('pixel-document')
      try { localStorage.setItem(PIXEL_STORAGE_KEY, serialized) } catch { /* bridge remains canonical */ }
      queuePixelBridgeSave(serialized)
      setPixelDraft({ status: 'empty', document: next })
      return
    }
    const serialized = serializePixelDocument(next)
    clientStateDirtyRef.current.add('pixel-document')
    let browserStored = true
    try {
      localStorage.setItem(PIXEL_STORAGE_KEY, serialized)
    } catch {
      browserStored = false
    }
    queuePixelBridgeSave(serialized)
    setPixelDraft(bridgeReadyRef.current || browserStored
      ? { status: 'ready', document: next }
      : {
          status: 'error',
          document: next,
          error: '像素草稿仍在当前页面，但浏览器存储失败且本机桥接离线；刷新前请先导出。',
        })
    if (route.modeId === 'pixel' && route.projectId !== next.id) {
      replaceModeProjectReference('pixel', next.id)
    }
    if (!browserStored) {
      setModeNotice(bridgeReadyRef.current
        ? { tone: 'info', message: '浏览器配额不足；像素草稿将保存到本机用户数据。' }
        : { tone: 'error', message: '像素草稿未能持久化；刷新前请先导出。' })
    }
  }, [queuePixelBridgeSave, replaceModeProjectReference, route.modeId, route.projectId])

  const handleVideoPlanReady = useCallback((result: SmartVideoPlanResult) => {
    const session: SmartVideoSessionSummary = {
      version: 1,
      projectId: result.project.id,
      title: result.project.title,
      sourceKind: result.project.source.kind,
      sourceText: result.project.source.text,
      updatedAt: result.project.updatedAt,
      sceneCount: result.project.scenes.length,
      taskCount: result.plan.tasks.length,
    }
    const serialized = serializeSmartVideoSession(session)
    clientStateDirtyRef.current.add('smart-video-session')
    let browserStored = true
    try {
      sessionStorage.setItem(SMART_VIDEO_SESSION_KEY, serialized)
    } catch {
      browserStored = false
    }
    setVideoSession(bridgeReadyRef.current || browserStored
      ? { status: 'ready', session }
      : {
          status: 'error',
          session,
          error: '智能视频计划仍在当前页面，但浏览器存储失败且本机桥接离线；刷新后无法恢复。',
        })
    if (route.modeId === 'smart-video' && route.projectId !== session.projectId) {
      replaceModeProjectReference('smart-video', session.projectId)
    }
    setModeNotice(bridgeReadyRef.current || browserStored
      ? { tone: 'success', message: '剧本输入与计划摘要已保存到本机创作会话。' }
      : { tone: 'error', message: '当前计划未能持久化；刷新后无法恢复。' })
    if (bridgeReadyRef.current) {
      void saveClientState('smart-video-session', serialized).catch(() => {
        setModeNotice({ tone: 'error', message: '智能视频会话未能写入本机用户数据；当前页面内容仍保留。' })
      })
    }
  }, [replaceModeProjectReference, route.modeId, route.projectId])

  const handleSpriteSheetExport = useCallback(async (payload: PixelSpriteSheetPayload) => {
    try {
      await exportSpriteSheet(payload)
      setModeNotice({ tone: 'success', message: 'Sprite Sheet PNG 与元数据已导出。' })
    } catch (error) {
      setModeNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Sprite Sheet 导出失败' })
      throw error
    }
  }, [])

  useEffect(() => {
    if (!modeNotice) return
    const timer = window.setTimeout(() => setModeNotice(null), modeNotice.tone === 'error' ? 6_000 : 4_000)
    return () => window.clearTimeout(timer)
  }, [modeNotice])

  useEffect(() => {
    if (route.modeId === 'home' || announcedRecoveryRef.current === currentRouteKey) return
    let message: string | undefined
    if (
      route.modeId === 'balanced' &&
      projectProbe.status === 'ready' &&
      projectProbe.project?.id === (route.projectId ?? preferences.balancedProjectId)
    ) message = `已从本机项目恢复“${projectProbe.project.title}”。`
    if (
      route.modeId === 'pixel' &&
      pixelDraft.status === 'ready' &&
      pixelDraft.document &&
      (!route.projectId || route.projectId === pixelDraft.document.id)
    ) message = `已恢复像素草稿“${pixelDraft.document.name}”。`
    if (
      route.modeId === 'smart-video' &&
      videoSession.status === 'ready' &&
      videoSession.session &&
      (!route.projectId || route.projectId === videoSession.session.projectId)
    ) message = `已恢复本机剧本输入“${videoSession.session.title}”。`
    if (!message) return
    announcedRecoveryRef.current = currentRouteKey
    setModeNotice({ tone: 'info', message })
  }, [currentRouteKey, pixelDraft, preferences.balancedProjectId, projectProbe, route.modeId, route.projectId, videoSession])

  const goHome = useCallback(() => navigate({ modeId: 'home' }), [navigate])

  const openMode = useCallback((modeId: ProductModeId) => {
    if (modeId === 'balanced') {
      navigate({
        modeId,
        projectId: projectProbe.status === 'ready' && projectProbe.project
          ? projectProbe.project.id
          : undefined,
      })
      return
    }
    if (modeId === 'pixel') {
      navigate({
        modeId,
        projectId: pixelDraft.status === 'ready' ? pixelDraft.document?.id : undefined,
      })
      return
    }
    navigate({
      modeId,
      projectId: videoSession.status === 'ready' ? videoSession.session?.projectId : undefined,
    })
  }, [navigate, pixelDraft, projectProbe, videoSession])

  if (route.modeId === 'balanced') {
    const requestedProjectId = route.projectId ?? preferences.balancedProjectId ?? DEFAULT_BALANCED_PROJECT_ID
    const matchingProbe = projectProbe.projectId === requestedProjectId
    if (!matchingProbe || projectProbe.status === 'idle' || projectProbe.status === 'loading') {
      return (
        <ModeGate
          modeLabel="均衡模式"
          feedback={{
            status: 'loading',
            title: '正在读取均衡项目',
            detail: `正在从本机 ProjectStore 核对项目引用 ${requestedProjectId}。`,
          }}
          onBack={goHome}
        />
      )
    }
    if (projectProbe.status === 'error' && entryIntentKey !== currentRouteKey) {
      return (
        <ModeGate
          modeLabel="均衡模式"
          feedback={{
            status: 'error',
            title: '本机项目暂时无法读取',
            detail: projectProbe.error ?? '请检查本机桥接后重试；也可以明确使用浏览器恢复副本进入。',
            actionLabel: '重试本机项目',
            secondaryActionLabel: '使用浏览器草稿',
          }}
          onAction={() => void refreshProject(requestedProjectId)}
          onSecondaryAction={() => {
            setEntryIntentKey(currentRouteKey)
            setModeNotice({ tone: 'info', message: '正在使用浏览器恢复副本；本机项目服务仍未连接。' })
          }}
          onBack={goHome}
        />
      )
    }
    if (projectProbe.status === 'empty' && entryIntentKey !== currentRouteKey) {
      const canCreate = requestedProjectId === DEFAULT_BALANCED_PROJECT_ID
      return (
        <ModeGate
          modeLabel="均衡模式"
          feedback={canCreate ? {
            status: 'empty',
            title: '尚无已保存的均衡项目',
            detail: '进入后会由现有画布内核建立本机项目；主页不会提前伪造最近项目。',
            actionLabel: '创建本机画布',
            secondaryActionLabel: '返回主页',
          } : {
            status: 'error',
            title: '找不到此均衡项目',
            detail: `ProjectStore 中没有引用 ${requestedProjectId}。`,
            actionLabel: '重新读取',
            secondaryActionLabel: '返回主页',
          }}
          onAction={canCreate ? () => setEntryIntentKey(currentRouteKey) : () => void refreshProject(requestedProjectId)}
          onSecondaryAction={goHome}
          onBack={goHome}
        />
      )
    }
    return (
      <ProductModeHost modeId="balanced" modeLabel="均衡模式" routeKey={currentRouteKey} notice={modeNotice} onBack={goHome}>
        <BalancedWorkbench onBack={goHome} />
      </ProductModeHost>
    )
  }

  if (route.modeId === 'pixel') {
    const requestedProjectId = route.projectId
    const pixelEntry = resolvePixelDraftEntry({
      requestedProjectId,
      status: pixelDraft.status,
      documentId: pixelDraft.document?.id,
    })
    const requestedDraftMissing = pixelEntry.requestedDraftMissing
    if (requestedDraftMissing && entryIntentKey !== currentRouteKey) {
      return (
        <ModeGate
          modeLabel="像素模式"
          feedback={{
            status: 'error',
            title: pixelDraft.status === 'error' ? '像素草稿无法读取' : '找不到此像素草稿',
            detail: pixelDraft.error ?? `浏览器中没有与 ${requestedProjectId} 匹配的像素文档。`,
            actionLabel: '重试读取',
            secondaryActionLabel: '返回主页',
          }}
          onAction={() => setPixelDraft(readPixelDraft())}
          onSecondaryAction={goHome}
          onBack={goHome}
        />
      )
    }
    if (pixelEntry.unreadable && entryIntentKey !== currentRouteKey) {
      return (
        <ModeGate
          modeLabel="像素模式"
          feedback={{
            status: 'error',
            title: '像素草稿无法读取',
            detail: pixelDraft.error,
            actionLabel: '重试读取',
            secondaryActionLabel: '忽略并开始新草稿',
          }}
          onAction={() => setPixelDraft(readPixelDraft())}
          onSecondaryAction={() => setEntryIntentKey(currentRouteKey)}
          onBack={goHome}
        />
      )
    }
    if (pixelDraft.status === 'empty' && entryIntentKey !== currentRouteKey) {
      return (
        <ModeGate
          modeLabel="像素模式"
          feedback={{
            status: 'empty',
            title: '尚无可恢复的像素草稿',
            detail: '只有实际产生修改并通过严格 PixelDocument 校验后，草稿才会进入最近项目。',
            actionLabel: '开始像素草稿',
            secondaryActionLabel: '返回主页',
          }}
          onAction={() => setEntryIntentKey(currentRouteKey)}
          onSecondaryAction={goHome}
          onBack={goHome}
        />
      )
    }
    return (
      <ProductModeHost modeId="pixel" modeLabel="像素模式" routeKey={currentRouteKey} notice={modeNotice} onBack={goHome}>
        <PixelModeWorkbench
          initialDocument={pixelEntry.hasMemoryDocument ? pixelDraft.document : undefined}
          onBack={goHome}
          onDocumentChange={handlePixelChange}
          onSpriteSheetReady={handleSpriteSheetExport}
        />
      </ProductModeHost>
    )
  }

  if (route.modeId === 'smart-video') {
    const requestedProjectId = route.projectId
    const requestedSessionMissing = requestedProjectId && (
      videoSession.status !== 'ready' || videoSession.session?.projectId !== requestedProjectId
    )
    if (requestedSessionMissing && entryIntentKey !== currentRouteKey) {
      return (
        <ModeGate
          modeLabel="智能视频"
          feedback={{
            status: 'error',
            title: videoSession.status === 'error' ? '智能视频会话无法读取' : '找不到此智能视频会话',
            detail: videoSession.error ?? '智能视频只保存本机会话摘要；它尚未冒充正式 ProjectStore 项目。',
            actionLabel: '重试读取',
            secondaryActionLabel: '返回主页',
          }}
          onAction={() => setVideoSession(readVideoSession())}
          onSecondaryAction={goHome}
          onBack={goHome}
        />
      )
    }
    if (videoSession.status === 'error' && entryIntentKey !== currentRouteKey) {
      return (
        <ModeGate
          modeLabel="智能视频"
          feedback={{
            status: 'error',
            title: '智能视频会话无法读取',
            detail: videoSession.error,
            actionLabel: '重试读取',
            secondaryActionLabel: '忽略并开始新故事',
          }}
          onAction={() => setVideoSession(readVideoSession())}
          onSecondaryAction={() => setEntryIntentKey(currentRouteKey)}
          onBack={goHome}
        />
      )
    }
    if (videoSession.status === 'empty' && entryIntentKey !== currentRouteKey) {
      return (
        <ModeGate
          modeLabel="智能视频"
          feedback={{
            status: 'empty',
            title: '尚无可恢复的智能视频会话',
            detail: '开始后，主动编译过的剧本输入和计划摘要会保存到本机用户数据；完整计划尚未写入正式项目。',
            actionLabel: '开始新故事',
            secondaryActionLabel: '返回主页',
          }}
          onAction={() => setEntryIntentKey(currentRouteKey)}
          onSecondaryAction={goHome}
          onBack={goHome}
        />
      )
    }
    return (
      <ProductModeHost modeId="smart-video" modeLabel="智能视频" routeKey={currentRouteKey} notice={modeNotice} onBack={goHome}>
        <SmartVideoWorkbench
          initialText={videoSession.status === 'ready' ? videoSession.session?.sourceText : undefined}
          initialKind={videoSession.status === 'ready' ? videoSession.session?.sourceKind : undefined}
          runtime={smartVideoRuntime}
          onBack={goHome}
          onPlanReady={handleVideoPlanReady}
        />
      </ProductModeHost>
    )
  }

  return (
    <>
      <AeonQuillShell
        selectedModeId={selectedModeId}
        modeAvailability={modeAvailability}
        runtime={runtimeSummary}
        recentProjects={recentProjects}
        recentProjectsFeedback={recentProjectsFeedback}
        refreshingRuntime={refreshingRuntime}
        onModeSelect={chooseMode}
        onModeOpen={openMode}
        onCreateProject={openMode}
        onOpenProject={(projectId, modeId) => navigate({ modeId, projectId })}
        onRetryProjects={retryLocalContexts}
        onOpenSettings={openRuntimeSettings}
        onRefreshRuntime={() => void refreshRuntime()}
        onRuntimeItemAction={(item) => void handleRuntimeAction(item)}
      />
      <RuntimeSettingsDialog
        open={settingsOpen}
        diagnostics={runtimeProbe.diagnostics}
        loading={refreshingRuntime}
        saving={settingsSaving}
        error={settingsError}
        message={settingsMessage}
        onClose={() => setSettingsOpen(false)}
        onRefresh={() => void refreshRuntime()}
        onConfigure={(request) => void handleRuntimeConfigure(request)}
      />
    </>
  )
}
