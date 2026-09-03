import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Library, Workflow } from 'lucide-react'
import { SurfaceState } from './components/Home/SurfaceState'
import type { CanvasDocument } from './lib/canvasCore'
import {
  deserializePixelDocument,
  serializePixelDocument,
  type PixelDocument,
} from './lib/pixel'
import {
  addProjectDocument,
  createProjectCatalog,
  createWorkspaceProject,
  deserializeProjectCatalog,
  openWorkspaceProject,
  projectModeDocument,
  purgeExpiredProjects,
  serializeProjectCatalog,
  setProjectStatus,
  touchProjectDocument,
  type ProjectCatalog,
  type ProjectModeDocument,
  type WorkspaceProject,
} from './lib/project'
import {
  ProjectApiError,
  createWorkspaceRecoveryPoint,
  deserializeSmartVideoDocument,
  downloadWorkspaceProjectPackage,
  importWorkspaceProjectPackage,
  listWorkspaceRecoveryPoints,
  loadLocalProject,
  loadWorkspaceCatalog,
  loadWorkspaceModeDocument,
  saveWorkspaceCatalog,
  saveWorkspaceModeDocument,
  serializeSmartVideoDocument,
  previewWorkspaceProjectPackage,
  previewWorkspaceProjectPackageFile,
  restoreWorkspaceRecoveryPoint,
  type StoredProject,
  type WorkspaceRecoveryPoint,
} from './lib/projectApi'
import type { LibraryAsset, LibraryAssetInsertion } from './lib/libraryApi'
import {
  applyRuntimeRegistryMigration,
  configureRuntime,
  fetchClientState,
  fetchRuntimeDiagnostics,
  fetchRuntimeStatus,
  rollbackRuntimeRegistryMigration,
  saveClientState,
  startRuntime,
  stopRuntime,
} from './lib/videoApi'
import type { PixelSpriteSheetPayload } from './modes/pixel'
import type { SmartVideoPlanResult, SmartVideoRuntimeSummary } from './modes/video'
import {
  AeonQuillShell,
  createProductTarget,
  DEFAULT_BALANCED_PROJECT_ID,
  ModeErrorBoundary,
  parseProductHash,
  parseShellPreferences,
  parseSmartVideoSession,
  PRODUCT_SHELL_PREFERENCES_KEY,
  resolvePixelDraftEntry,
  serializeShellPreferences,
  serializeSmartVideoSession,
  SMART_VIDEO_SESSION_KEY,
  type LocalRuntimeSummary,
  type ModeAvailabilitySummary,
  type ProductLocation,
  type ProjectCreateInput,
  type ProductModeId,
  type RecentProjectSummary,
  type RuntimeHealth,
  type RuntimeSurfaceSummary,
  type ShellFeedback,
  type ShellPreferences,
  type SmartVideoSessionSummary,
} from './shell'
import {
  LazyAssetLibraryDialog,
  LazyBalancedWorkbench,
  LazyPixelModeWorkbench,
  LazyProjectRecoveryDialog,
  LazyRuntimeSettingsDialog,
  LazySmartVideoWorkbench,
  LazyWorkflowCenterDialog,
  preloadProductDialog,
  preloadProductMode,
} from './shell/lazyProductSurfaces'
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
  result?: SmartVideoPlanResult
  error?: string
}

type ProductNotice = {
  tone: 'success' | 'error' | 'info'
  message: string
}

const PIXEL_STORAGE_KEY = 'aeonquill:pixel-document:v1'
const PROJECT_CATALOG_STORAGE_KEY = 'aeonquill:project-catalog:v1'
const PROJECT_CATALOG_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/u

type ProjectCatalogSnapshot = {
  catalog: ProjectCatalog
  error?: string
}

const PRODUCT_MODE_LABELS: Record<ProductModeId, string> = {
  balanced: '均衡模式',
  pixel: '像素模式',
  'smart-video': '智能视频',
}

function formatPackageBytes(bytes: number | null) {
  if (bytes === null) return '待导出时计算'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`
}

function packagePreviewText(preview: Awaited<ReturnType<typeof previewWorkspaceProjectPackage>>, action: '导出' | '导入') {
  const bodies = preview.documents.bodiesByMode
  const registered = preview.documents.byMode
  const lines = [
    `${action}项目“${preview.project.title}”`,
    '',
    `正文：均衡 ${bodies.balanced}/${registered.balanced} · 像素 ${bodies.pixel}/${registered.pixel} · 智能视频 ${bodies['smart-video']}/${registered['smart-video']}`,
    `恢复点：${preview.recoveryPoints} · 项目资源：${preview.library.projectItems + preview.library.globalReferences} · 不可变资产：${preview.assets.count}`,
    `资产体积：${formatPackageBytes(preview.assets.bytes)} · 包体：${formatPackageBytes(preview.archiveBytes)}`,
  ]
  if (!preview.complete) lines.push('', '注意：该文件不是三模式完整包。')
  if (preview.conflicts?.length) lines.push('', `检测到 ${preview.conflicts.length} 个 ID 冲突，将创建独立副本。`)
  if (preview.warnings.length) lines.push('', ...preview.warnings.map((warning) => `• ${warning}`))
  lines.push('', `确认${action}？`)
  return lines.join('\n')
}

type RecoveryDialogState = {
  projectId: string
  projectTitle: string
  loading: boolean
  recoveryPoints: WorkspaceRecoveryPoint[]
  busyId?: string
  error?: string
  message?: string
}

type RoutedLibraryInsertion = LibraryAssetInsertion & {
  modeId: ProductModeId
  documentId?: string
}

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

function pixelStorageKey(documentId?: string) {
  return documentId ? `${PIXEL_STORAGE_KEY}:${documentId}` : PIXEL_STORAGE_KEY
}

function videoStorageKey(documentId?: string) {
  return documentId ? `${SMART_VIDEO_SESSION_KEY}:${documentId}` : SMART_VIDEO_SESSION_KEY
}

function hasCatalogDocument(catalog: ProjectCatalog, documentId: string) {
  return catalog.projects.some((project) => project.documents.some((document) => document.id === documentId))
}

function availableLegacyProjectId(catalog: ProjectCatalog, base: string) {
  if (!catalog.projects.some((project) => project.id === base)) return base
  let suffix = 2
  while (catalog.projects.some((project) => project.id === `${base}-${suffix}`)) suffix += 1
  return `${base}-${suffix}`
}

function readProjectCatalog(): ProjectCatalogSnapshot {
  try {
    const catalog = deserializeProjectCatalog(localStorage.getItem(PROJECT_CATALOG_STORAGE_KEY))
    return { catalog: purgeExpiredProjects(catalog) }
  } catch {
    return {
      catalog: createProjectCatalog(),
      error: '项目目录未通过格式校验。原始数据仍保留；新建项目前请先重试读取或导出诊断。',
    }
  }
}

function readPixelDraft(storageKey: string = PIXEL_STORAGE_KEY, expectedDocumentId?: string): PixelDraftSnapshot {
  let invalid = false
  const keys = storageKey === PIXEL_STORAGE_KEY ? [storageKey] : [storageKey, PIXEL_STORAGE_KEY]
  for (const key of keys) {
    try {
      const stored = localStorage.getItem(key)
      if (!stored) continue
      const document = deserializePixelDocument(stored)
      if (expectedDocumentId && document.id !== expectedDocumentId) continue
      return isMeaningfulPixelDraft(document)
        ? { status: 'ready', document }
        : { status: 'empty' }
    } catch {
      invalid = true
    }
  }
  return invalid
    ? {
        status: 'error',
        error: '现有像素草稿未通过格式校验。原数据仍保留，可重试读取或明确开始新草稿。',
      }
    : { status: 'empty' }
}

function readVideoSession(storageKey: string = SMART_VIDEO_SESSION_KEY, expectedDocumentId?: string): VideoSessionSnapshot {
  let invalid = false
  const keys = storageKey === SMART_VIDEO_SESSION_KEY ? [storageKey] : [storageKey, SMART_VIDEO_SESSION_KEY]
  for (const key of keys) {
    try {
      const stored = sessionStorage.getItem(key)
      if (!stored) continue
      const session = parseSmartVideoSession(stored)
      if (!session) {
        invalid = true
        continue
      }
      if (expectedDocumentId && session.projectId !== expectedDocumentId) continue
      return { status: 'ready', session }
    } catch {
      invalid = true
    }
  }
  return invalid
    ? {
        status: 'error',
        error: '此标签页中的智能视频会话摘要无效。原数据仍保留，不会被伪装成项目。',
      }
    : { status: 'empty' }
}

function smartVideoSessionFromResult(result: SmartVideoPlanResult): SmartVideoSessionSummary {
  return {
    version: 1,
    projectId: result.project.id,
    title: result.project.title,
    sourceKind: result.project.source.kind,
    sourceText: result.project.source.text,
    updatedAt: result.project.updatedAt,
    sceneCount: result.project.scenes.length,
    taskCount: result.plan.tasks.length,
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

function ModeModuleLoading({ modeId, modeLabel, onBack }: { modeId: ProductModeId; modeLabel: string; onBack: () => void }) {
  return (
    <main className="aq-product-state-host" data-mode-module-loading={modeId} aria-label={`${modeLabel}模块加载状态`}>
      <header className="aq-mode-gate__header">
        <button type="button" className="aq-mode-gate__back" onClick={onBack}>返回主页</button>
        <span>光阴砚 AEONQUILL · {modeLabel}</span>
      </header>
      <SurfaceState
        feedback={{
          status: 'loading',
          title: `正在载入${modeLabel}`,
          detail: '首次进入时只读取当前工作台；项目正文与本机资产不会因此改变。',
        }}
      />
    </main>
  )
}

function DeferredDialogLoading({ label }: { label: string }) {
  return (
    <div className="aq-deferred-surface-backdrop" role="presentation">
      <section className="aq-deferred-surface-card" role="dialog" aria-modal="true" aria-label={`正在载入${label}`}>
        <SurfaceState
          compact
          feedback={{
            status: 'loading',
            title: `正在载入${label}`,
            detail: '界面模块就绪后会自动打开。',
          }}
        />
      </section>
    </div>
  )
}

interface ProductModeHostProps {
  modeId: ProductModeId
  modeLabel: string
  routeKey: string
  notice: ProductNotice | null
  onBack: () => void
  onOpenLibrary: () => void
  onOpenWorkflowCenter: () => void
  children: ReactNode
}

function ProductModeHost({ modeId, modeLabel, routeKey: currentRouteKey, notice, onBack, onOpenLibrary, onOpenWorkflowCenter, children }: ProductModeHostProps) {
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
        <Suspense fallback={<ModeModuleLoading modeId={modeId} modeLabel={modeLabel} onBack={onBack} />}>
          {children}
        </Suspense>
      </ModeErrorBoundary>
      <button type="button" className="aq-product-library-launcher" onClick={onOpenLibrary} aria-label="打开跨模式资源库">
        <Library size={16} />
        <span>资源库</span>
      </button>
      <button type="button" className="aq-product-workflow-launcher" onClick={onOpenWorkflowCenter} aria-label="打开工作流中心">
        <Workflow size={16} />
        <span>工作流</span>
      </button>
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
  const initialProjectCatalog = useRef<ProjectCatalogSnapshot>(readProjectCatalog())
  const [route, setRoute] = useState<ProductLocation>(readRoute)
  const [preferences, setPreferences] = useState<ShellPreferences>(initialPreferences.current)
  const [projectCatalog, setProjectCatalog] = useState<ProjectCatalog>(initialProjectCatalog.current.catalog)
  const [projectCatalogError, setProjectCatalogError] = useState<string | undefined>(initialProjectCatalog.current.error)
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
  const [workflowCenterOpen, setWorkflowCenterOpen] = useState(false)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [settingsError, setSettingsError] = useState<string>()
  const [settingsMessage, setSettingsMessage] = useState<string>()
  const [recoveryDialog, setRecoveryDialog] = useState<RecoveryDialogState | null>(null)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [libraryOpenPending, setLibraryOpenPending] = useState(false)
  const [libraryInsertion, setLibraryInsertion] = useState<RoutedLibraryInsertion | null>(null)
  const [projectProbe, setProjectProbe] = useState<ProjectProbe>({
    projectId: initialPreferences.current.balancedProjectId,
    status: 'idle',
    project: null,
  })
  const [pixelDraft, setPixelDraft] = useState<PixelDraftSnapshot>(initialPixelDraft.current)
  const [videoSession, setVideoSession] = useState<VideoSessionSnapshot>(initialVideoSession.current)
  const [clientStateReady, setClientStateReady] = useState(false)
  const [entryIntentKey, setEntryIntentKey] = useState<string | null>(null)
  const [modeNotice, setModeNotice] = useState<ProductNotice | null>(null)
  const projectRequestRef = useRef(0)
  const announcedRecoveryRef = useRef<string | null>(null)
  const legacyBrowserMigrationRef = useRef(false)
  const clientStateHydratedRef = useRef(false)
  const clientStateDirtyRef = useRef(new Set<string>())
  const bridgeReadyRef = useRef(false)
  const projectCatalogRef = useRef(projectCatalog)
  const preferencesRef = useRef(preferences)
  const videoSessionRef = useRef(videoSession)
  const catalogBridgeSaveTimerRef = useRef<number | undefined>(undefined)
  const catalogBridgeSaveRef = useRef<string | undefined>(undefined)
  const catalogBridgeBaseRevisionRef = useRef<number | undefined>(undefined)
  const catalogBridgeSavePromiseRef = useRef<Promise<void> | null>(null)
  const pixelBridgeSaveTimerRef = useRef<number | undefined>(undefined)
  const pixelBridgeSaveRef = useRef<string | undefined>(undefined)
  const packageInputRef = useRef<HTMLInputElement>(null)
  const packageBusyRef = useRef(false)
  const [workspaceDocumentResolvedKey, setWorkspaceDocumentResolvedKey] = useState<string | null>(null)
  const currentRouteKey = routeKey(route)
  const activeWorkspaceProject = useMemo<WorkspaceProject | null>(() => {
    if (!route.projectId) return null
    return projectCatalog.projects.find((project) => project.id === route.projectId) ?? null
  }, [projectCatalog.projects, route.projectId])
  const activeModeDocument = useMemo<ProjectModeDocument | null>(() => {
    if (!activeWorkspaceProject || route.modeId === 'home') return null
    return projectModeDocument(activeWorkspaceProject, route.modeId)
  }, [activeWorkspaceProject, route.modeId])
  const activeWorkspaceProjectId = activeWorkspaceProject?.id
  const activeModeDocumentId = activeModeDocument?.id
  const activeModeDocumentMode = activeModeDocument?.modeId

  useEffect(() => {
    bridgeReadyRef.current = runtimeProbe.bridgeReady
  }, [runtimeProbe.bridgeReady])

  useEffect(() => {
    projectCatalogRef.current = projectCatalog
  }, [projectCatalog])

  useEffect(() => {
    preferencesRef.current = preferences
  }, [preferences])

  useEffect(() => {
    videoSessionRef.current = videoSession
  }, [videoSession])

  const flushProjectCatalogBridgeSave = useCallback((): Promise<void> => {
    if (!bridgeReadyRef.current) return Promise.resolve()
    const running = catalogBridgeSavePromiseRef.current
    if (running) {
      return running.then(() => catalogBridgeSaveRef.current ? flushProjectCatalogBridgeSave() : undefined)
    }
    const operation = (async () => {
      try {
        while (catalogBridgeSaveRef.current && bridgeReadyRef.current) {
          const value = catalogBridgeSaveRef.current
          const catalog = deserializeProjectCatalog(value)
          const baseRevision = catalogBridgeBaseRevisionRef.current ?? Math.max(0, catalog.revision - 1)
          const saved = await saveWorkspaceCatalog(catalog, baseRevision)
          catalogBridgeBaseRevisionRef.current = saved.catalog.revision
          await saveClientState('project-catalog', serializeProjectCatalog(saved.catalog)).catch(() => undefined)
          if (catalogBridgeSaveRef.current === value) {
            catalogBridgeSaveRef.current = undefined
            catalogBridgeBaseRevisionRef.current = undefined
            clientStateDirtyRef.current.delete('project-catalog')
            setProjectCatalogError(undefined)
          }
        }
      } catch (error) {
        const conflict = error instanceof ProjectApiError && error.code === 'WORKSPACE_CATALOG_CONFLICT'
        setProjectCatalogError(conflict
          ? '项目目录已在另一页面发生变化；当前浏览器副本仍保留，未覆盖 SQLite 权威数据。'
          : '项目目录仍保留在浏览器副本，但未能写入 SQLite 工作区；请检查桥接后重试。')
      }
    })()
    catalogBridgeSavePromiseRef.current = operation
    return operation.finally(() => {
      if (catalogBridgeSavePromiseRef.current === operation) catalogBridgeSavePromiseRef.current = null
    })
  }, [])

  const queueProjectCatalogBridgeSave = useCallback((serialized: string) => {
    catalogBridgeSaveRef.current = serialized
    if (catalogBridgeSaveTimerRef.current !== undefined) window.clearTimeout(catalogBridgeSaveTimerRef.current)
    catalogBridgeSaveTimerRef.current = window.setTimeout(() => {
      catalogBridgeSaveTimerRef.current = undefined
      void flushProjectCatalogBridgeSave()
    }, 260)
  }, [flushProjectCatalogBridgeSave])

  const commitProjectCatalog = useCallback((next: ProjectCatalog) => {
    if (catalogBridgeBaseRevisionRef.current === undefined) {
      catalogBridgeBaseRevisionRef.current = projectCatalogRef.current.revision
    }
    const serialized = serializeProjectCatalog(next)
    clientStateDirtyRef.current.add('project-catalog')
    catalogBridgeSaveRef.current = serialized
    projectCatalogRef.current = next
    setProjectCatalog(next)
    try {
      localStorage.setItem(PROJECT_CATALOG_STORAGE_KEY, serialized)
      setProjectCatalogError(undefined)
    } catch {
      setProjectCatalogError('项目目录仍保留在当前页面，但浏览器本机存储写入失败。刷新前请勿关闭页面。')
    }
    if (bridgeReadyRef.current) queueProjectCatalogBridgeSave(serialized)
  }, [queueProjectCatalogBridgeSave])

  useEffect(() => () => {
    if (catalogBridgeSaveTimerRef.current !== undefined) window.clearTimeout(catalogBridgeSaveTimerRef.current)
    if (catalogBridgeSaveRef.current && bridgeReadyRef.current) void flushProjectCatalogBridgeSave()
  }, [])

  useEffect(() => {
    if (!clientStateReady || legacyBrowserMigrationRef.current) return
    legacyBrowserMigrationRef.current = true
    let nextCatalog = projectCatalogRef.current
    let migrated = false
    const pixel = pixelDraft.document
    if (
      pixelDraft.status === 'ready'
      && pixel
      && PROJECT_CATALOG_ID_PATTERN.test(pixel.id)
      && !hasCatalogDocument(nextCatalog, pixel.id)
    ) {
      const created = createWorkspaceProject(nextCatalog, {
        title: pixel.name,
        description: '从旧像素单例非破坏迁移；原存储键继续保留。',
        color: 'blue',
        initialModeId: 'pixel',
        documentTitle: pixel.name,
      }, {
        projectId: availableLegacyProjectId(nextCatalog, 'legacy-pixel-project'),
        documentId: pixel.id,
      })
      nextCatalog = created.catalog
      migrated = true
    }
    const session = videoSession.session
    if (
      videoSession.status === 'ready'
      && session
      && PROJECT_CATALOG_ID_PATTERN.test(session.projectId)
      && !hasCatalogDocument(nextCatalog, session.projectId)
    ) {
      const created = createWorkspaceProject(nextCatalog, {
        title: session.title,
        description: '从旧智能视频会话摘要非破坏迁移；原存储键继续保留。',
        color: 'violet',
        initialModeId: 'smart-video',
        documentTitle: session.title,
      }, {
        projectId: availableLegacyProjectId(nextCatalog, 'legacy-video-project'),
        documentId: session.projectId,
      })
      nextCatalog = created.catalog
      migrated = true
    }
    if (migrated) commitProjectCatalog(nextCatalog)
  }, [clientStateReady, commitProjectCatalog, pixelDraft, videoSession])

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
    void preloadProductMode(modeId).catch(() => undefined)
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
    }
  }, [chooseMode])

  const handleCreateProject = useCallback((input: ProjectCreateInput) => {
    try {
      const created = createWorkspaceProject(projectCatalogRef.current, input)
      commitProjectCatalog(created.catalog)
      const nextRoute = { modeId: input.initialModeId, projectId: created.project.id } as const
      navigate(nextRoute)
      setEntryIntentKey(routeKey(nextRoute))
      setModeNotice({ tone: 'success', message: `已创建项目“${created.project.title}”，三种创作模式可在项目内继续扩展。` })
    } catch (error) {
      setProjectCatalogError(error instanceof Error ? error.message : '创建项目失败')
    }
  }, [commitProjectCatalog, navigate])

  const handleOpenProject = useCallback((projectId: string, modeId: ProductModeId) => {
    try {
      let nextCatalog = projectCatalogRef.current
      let project = nextCatalog.projects.find((candidate) => candidate.id === projectId)
      if (!project) throw new Error(`找不到项目 ${projectId}`)
      let document = projectModeDocument(project, modeId)
      if (!document) {
        const added = addProjectDocument(nextCatalog, projectId, {
          modeId,
          title: `${project.title} · ${modeId === 'balanced' ? '均衡画布' : modeId === 'pixel' ? '像素画布' : '智能视频'}`,
        })
        nextCatalog = added.catalog
        project = added.project
        document = added.document
      }
      nextCatalog = openWorkspaceProject(nextCatalog, projectId)
      commitProjectCatalog(nextCatalog)
      const nextRoute = { modeId, projectId } as const
      navigate(nextRoute)
      setEntryIntentKey(routeKey(nextRoute))
      if (modeId === 'balanced') updatePreferences({ balancedProjectId: document.id })
    } catch (error) {
      setProjectCatalogError(error instanceof Error ? error.message : '打开项目失败')
    }
  }, [commitProjectCatalog, navigate, updatePreferences])

  const handleProjectStatusChange = useCallback((projectId: string, status: 'active' | 'archived' | 'trashed') => {
    try {
      commitProjectCatalog(setProjectStatus(projectCatalogRef.current, projectId, status))
    } catch (error) {
      setProjectCatalogError(error instanceof Error ? error.message : '项目状态更新失败')
    }
  }, [commitProjectCatalog])

  const handleExportProjectPackage = useCallback(async (projectId: string) => {
    if (packageBusyRef.current) return
    packageBusyRef.current = true
    try {
      await flushProjectCatalogBridgeSave()
      const preview = await previewWorkspaceProjectPackage(projectId)
      if (!window.confirm(packagePreviewText(preview, '导出'))) return
      const blob = await downloadWorkspaceProjectPackage(projectId)
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${projectId}.aeonquill`
      anchor.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 0)
      window.alert(`完整项目包已导出：${formatPackageBytes(blob.size)}。`)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : '完整项目包导出失败')
    } finally {
      packageBusyRef.current = false
    }
  }, [flushProjectCatalogBridgeSave])

  const handleImportProjectPackage = useCallback(async (file: File) => {
    if (packageBusyRef.current) return
    packageBusyRef.current = true
    try {
      await flushProjectCatalogBridgeSave()
      const preview = await previewWorkspaceProjectPackageFile(file)
      if (!window.confirm(packagePreviewText(preview, '导入'))) return
      const result = await importWorkspaceProjectPackage(file, {
        conflictPolicy: preview.conflicts?.length ? 'copy' : 'reject',
      })
      const serializedCatalog = serializeProjectCatalog(result.catalog)
      if (catalogBridgeSaveTimerRef.current !== undefined) window.clearTimeout(catalogBridgeSaveTimerRef.current)
      catalogBridgeSaveRef.current = undefined
      catalogBridgeBaseRevisionRef.current = undefined
      clientStateDirtyRef.current.delete('project-catalog')
      projectCatalogRef.current = result.catalog
      setProjectCatalog(result.catalog)
      setProjectCatalogError(undefined)
      try { localStorage.setItem(PROJECT_CATALOG_STORAGE_KEY, serializedCatalog) } catch { /* SQLite remains canonical */ }
      void saveClientState('project-catalog', serializedCatalog).catch(() => undefined)
      const initialDocument = projectModeDocument(result.project, result.project.initialModeId)
      if (initialDocument?.modeId === 'balanced') updatePreferences({ balancedProjectId: initialDocument.id })
      const nextRoute = { modeId: result.project.initialModeId, projectId: result.project.id } as const
      navigate(nextRoute)
      setEntryIntentKey(routeKey(nextRoute))
      setModeNotice({
        tone: result.legacy ? 'info' : 'success',
        message: result.legacy
          ? '旧 `.miaohui` 已作为单个均衡文档导入；它不包含其他模式与项目资源关系。'
          : `完整项目“${result.project.title}”已原子恢复。`,
      })
    } catch (error) {
      window.alert(error instanceof Error ? error.message : '项目包导入失败')
    } finally {
      packageBusyRef.current = false
    }
  }, [flushProjectCatalogBridgeSave, navigate, updatePreferences])

  const refreshRecoveryDialog = useCallback(async (projectId: string) => {
    setRecoveryDialog((current) => current?.projectId === projectId
      ? { ...current, loading: true, error: undefined }
      : current)
    try {
      await flushProjectCatalogBridgeSave()
      const recoveryPoints = await listWorkspaceRecoveryPoints(projectId)
      setRecoveryDialog((current) => current?.projectId === projectId
        ? { ...current, loading: false, recoveryPoints, error: undefined }
        : current)
    } catch (error) {
      setRecoveryDialog((current) => current?.projectId === projectId
        ? { ...current, loading: false, error: error instanceof Error ? error.message : '恢复点读取失败' }
        : current)
    }
  }, [flushProjectCatalogBridgeSave])

  const handleOpenProjectRecovery = useCallback((projectId: string) => {
    const project = projectCatalogRef.current.projects.find(({ id }) => id === projectId)
    if (!project) {
      setProjectCatalogError(`找不到项目 ${projectId}`)
      return
    }
    void preloadProductDialog('recovery').catch(() => undefined)
    setRecoveryDialog({
      projectId,
      projectTitle: project.title,
      loading: true,
      recoveryPoints: [],
    })
    void refreshRecoveryDialog(projectId)
  }, [refreshRecoveryDialog])

  const handleCreateRecoveryPoint = useCallback(async () => {
    const current = recoveryDialog
    if (!current) return
    setRecoveryDialog({ ...current, busyId: 'create', error: undefined, message: undefined })
    try {
      await flushProjectCatalogBridgeSave()
      await createWorkspaceRecoveryPoint(current.projectId, { reason: 'user-manual-checkpoint' })
      const recoveryPoints = await listWorkspaceRecoveryPoints(current.projectId)
      setRecoveryDialog((latest) => latest?.projectId === current.projectId
        ? { ...latest, busyId: undefined, recoveryPoints, message: '已创建当前项目恢复点。' }
        : latest)
    } catch (error) {
      setRecoveryDialog((latest) => latest?.projectId === current.projectId
        ? { ...latest, busyId: undefined, error: error instanceof Error ? error.message : '恢复点创建失败' }
        : latest)
    }
  }, [flushProjectCatalogBridgeSave, recoveryDialog])

  const handleRestoreRecoveryPoint = useCallback(async (recoveryPoint: WorkspaceRecoveryPoint) => {
    const current = recoveryDialog
    if (!current || current.projectId !== recoveryPoint.projectId) return
    if (!window.confirm('确认恢复此快照？当前状态会先自动保存为新的恢复点，此操作不会删除已有快照。')) return
    setRecoveryDialog({ ...current, busyId: recoveryPoint.id, error: undefined, message: undefined })
    try {
      await flushProjectCatalogBridgeSave()
      const { restored } = await restoreWorkspaceRecoveryPoint(recoveryPoint.id)
      const serializedCatalog = serializeProjectCatalog(restored.catalog)
      catalogBridgeSaveRef.current = undefined
      catalogBridgeBaseRevisionRef.current = undefined
      clientStateDirtyRef.current.delete('project-catalog')
      projectCatalogRef.current = restored.catalog
      setProjectCatalog(restored.catalog)
      try { localStorage.setItem(PROJECT_CATALOG_STORAGE_KEY, serializedCatalog) } catch { /* SQLite remains canonical */ }
      void saveClientState('project-catalog', serializedCatalog).catch(() => undefined)
      if (restored.document?.modeId === 'pixel') {
        const document = deserializePixelDocument(restored.document.value)
        const serialized = serializePixelDocument(document)
        setPixelDraft(isMeaningfulPixelDraft(document) ? { status: 'ready', document } : { status: 'empty', document })
        try { localStorage.setItem(pixelStorageKey(document.id), serialized) } catch { /* SQLite remains canonical */ }
      } else if (restored.document?.modeId === 'smart-video') {
        const body = deserializeSmartVideoDocument(restored.document.value)
        const result = { project: body.project, plan: body.plan, production: body.production }
        const session = smartVideoSessionFromResult(result)
        setVideoSession({ status: 'ready', session, result })
        try { sessionStorage.setItem(videoStorageKey(session.projectId), serializeSmartVideoSession(session)) } catch { /* SQLite remains canonical */ }
      }
      const recoveryPoints = await listWorkspaceRecoveryPoints(current.projectId)
      const restoredProject = restored.catalog.projects.find(({ id }) => id === current.projectId)
      setRecoveryDialog((latest) => latest?.projectId === current.projectId
        ? {
            ...latest,
            busyId: undefined,
            projectTitle: restoredProject?.title ?? latest.projectTitle,
            recoveryPoints,
            message: '恢复完成；旧内容已作为新的文档 revision 写入，恢复前状态也已留档。',
          }
        : latest)
    } catch (error) {
      setRecoveryDialog((latest) => latest?.projectId === current.projectId
        ? { ...latest, busyId: undefined, error: error instanceof Error ? error.message : '恢复点应用失败' }
        : latest)
    }
  }, [flushProjectCatalogBridgeSave, recoveryDialog])

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
      fetchClientState('project-catalog'),
      loadWorkspaceCatalog(),
    ]).then(([shellResult, pixelResult, videoResult, catalogResult, workspaceCatalogResult]) => {
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
        if (
          state
          && !clientStateDirtyRef.current.has('pixel-document')
          && initialPixelDraft.current.status !== 'ready'
        ) {
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
        if (
          state
          && !clientStateDirtyRef.current.has('smart-video-session')
          && initialVideoSession.current.status !== 'ready'
        ) {
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

      const current = projectCatalogRef.current
      let authoritativeSerialized: string | undefined
      let authoritativeRevision: number | undefined
      if (workspaceCatalogResult.status === 'fulfilled') {
        authoritativeSerialized = serializeProjectCatalog(workspaceCatalogResult.value.catalog)
        authoritativeRevision = workspaceCatalogResult.value.catalog.revision
      } else if (catalogResult.status === 'fulfilled' && catalogResult.value) {
        authoritativeSerialized = catalogResult.value.value
      }
      if (authoritativeSerialized) {
        try {
          const raw = deserializeProjectCatalog(authoritativeSerialized)
          const restored = purgeExpiredProjects(raw)
          const currentSerialized = serializeProjectCatalog(current)
          const restoredSerialized = serializeProjectCatalog(restored)
          const dirty = clientStateDirtyRef.current.has('project-catalog')
          catalogBridgeBaseRevisionRef.current = authoritativeRevision ?? raw.revision
          if (dirty && currentSerialized === restoredSerialized) {
            clientStateDirtyRef.current.delete('project-catalog')
            catalogBridgeSaveRef.current = undefined
            catalogBridgeBaseRevisionRef.current = undefined
            setProjectCatalogError(undefined)
          } else if (dirty && current.revision > raw.revision) {
            queueProjectCatalogBridgeSave(currentSerialized)
          } else if (dirty) {
            setProjectCatalogError('项目目录在页面打开期间已于 SQLite 工作区发生变化；已保留浏览器副本，未自动覆盖权威数据。')
          } else if (restored.revision > current.revision || (restored.revision === current.revision && restoredSerialized === currentSerialized)) {
            projectCatalogRef.current = restored
            setProjectCatalog(restored)
            try { localStorage.setItem(PROJECT_CATALOG_STORAGE_KEY, restoredSerialized) } catch { /* SQLite remains canonical */ }
            setProjectCatalogError(undefined)
            if (restored.revision > raw.revision) queueProjectCatalogBridgeSave(restoredSerialized)
          } else if (current.revision > raw.revision) {
            queueProjectCatalogBridgeSave(currentSerialized)
          } else if (currentSerialized !== restoredSerialized) {
            setProjectCatalogError('浏览器与 SQLite 工作区存在同 revision 目录冲突；已保留浏览器副本，未自动覆盖任一侧。')
          }
        } catch {
          setProjectCatalogError('SQLite 工作区返回的项目目录未通过严格格式校验；已保留浏览器副本。')
        }
      } else {
        catalogBridgeBaseRevisionRef.current = 0
        queueProjectCatalogBridgeSave(serializeProjectCatalog(current))
        setProjectCatalogError('SQLite 工作区暂时无法读取；浏览器副本仍保留并等待重试。')
      }
    }).finally(() => {
      if (!disposed) setClientStateReady(true)
    })

    return () => { disposed = true }
  }, [queueProjectCatalogBridgeSave, runtimeProbe.bridgeReady])

  useEffect(() => {
    if (!runtimeProbe.checking && !runtimeProbe.bridgeReady) setClientStateReady(true)
  }, [runtimeProbe.bridgeReady, runtimeProbe.checking])

  useEffect(() => {
    if (
      !clientStateReady
      || !runtimeProbe.bridgeReady
      || route.modeId === 'home'
      || route.modeId === 'balanced'
      || !activeWorkspaceProjectId
      || !activeModeDocumentId
      || !activeModeDocumentMode
    ) {
      setWorkspaceDocumentResolvedKey(null)
      return
    }
    const loadingKey = `${activeWorkspaceProjectId}:${activeModeDocumentId}:${activeModeDocumentMode}`
    let disposed = false
    setWorkspaceDocumentResolvedKey((current) => current === loadingKey ? current : null)
    void (async () => {
      await flushProjectCatalogBridgeSave()
      return loadWorkspaceModeDocument(activeWorkspaceProjectId, activeModeDocumentId, activeModeDocumentMode)
    })()
      .then((stored) => {
        if (disposed) return
        if (activeModeDocumentMode === 'pixel') {
          if (stored) {
            const document = deserializePixelDocument(stored.value)
            const serialized = serializePixelDocument(document)
            setPixelDraft(isMeaningfulPixelDraft(document) ? { status: 'ready', document } : { status: 'empty', document })
            try { localStorage.setItem(pixelStorageKey(activeModeDocumentId), serialized) } catch { /* SQLite remains canonical */ }
          } else {
            setPixelDraft(readPixelDraft(pixelStorageKey(activeModeDocumentId), activeModeDocumentId))
          }
          return
        }
        if (stored) {
          const body = deserializeSmartVideoDocument(stored.value)
          const result = { project: body.project, plan: body.plan, production: body.production }
          const session = smartVideoSessionFromResult(result)
          setVideoSession({ status: 'ready', session, result })
          try { sessionStorage.setItem(videoStorageKey(activeModeDocumentId), serializeSmartVideoSession(session)) } catch { /* SQLite remains canonical */ }
        } else {
          setVideoSession(readVideoSession(videoStorageKey(activeModeDocumentId), activeModeDocumentId))
        }
      })
      .catch((error) => {
        if (disposed) return
        const fallback = activeModeDocumentMode === 'pixel'
          ? readPixelDraft(pixelStorageKey(activeModeDocumentId), activeModeDocumentId)
          : readVideoSession(videoStorageKey(activeModeDocumentId), activeModeDocumentId)
        if (activeModeDocumentMode === 'pixel') setPixelDraft(fallback as PixelDraftSnapshot)
        else setVideoSession(fallback as VideoSessionSnapshot)
        setModeNotice({
          tone: 'error',
          message: `SQLite 项目正文读取失败，当前使用浏览器恢复副本：${error instanceof Error ? error.message : '未知错误'}`,
        })
      })
      .finally(() => {
        if (!disposed) {
          setWorkspaceDocumentResolvedKey(loadingKey)
        }
      })
    return () => { disposed = true }
  }, [
    activeModeDocumentId,
    activeModeDocumentMode,
    activeWorkspaceProjectId,
    clientStateReady,
    flushProjectCatalogBridgeSave,
    route.modeId,
    runtimeProbe.bridgeReady,
  ])

  useEffect(() => {
    void refreshRuntime()
    if (route.modeId === 'balanced') return
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
      ? activeModeDocument?.id ?? route.projectId ?? preferences.balancedProjectId
      : preferences.balancedProjectId
    void refreshProject(projectId)
  }, [activeModeDocument?.id, preferences.balancedProjectId, refreshProject, route.modeId, route.projectId])

  useEffect(() => {
    if (
      !clientStateReady
      || projectProbe.status !== 'ready'
      || !projectProbe.project
      || projectProbe.project.revision <= 0
      || !PROJECT_CATALOG_ID_PATTERN.test(projectProbe.project.id)
      || hasCatalogDocument(projectCatalogRef.current, projectProbe.project.id)
    ) return

    try {
      const created = createWorkspaceProject(projectCatalogRef.current, {
        title: projectProbe.project.title,
        description: '从旧均衡画布非破坏迁移；原 ProjectStore 文档继续保留。',
        color: 'amber',
        initialModeId: 'balanced',
        documentTitle: projectProbe.project.title,
      }, {
        projectId: availableLegacyProjectId(projectCatalogRef.current, 'legacy-balanced-project'),
        documentId: projectProbe.project.id,
      })
      commitProjectCatalog(created.catalog)
    } catch (error) {
      setProjectCatalogError(error instanceof Error ? error.message : '旧均衡项目迁移失败')
    }
  }, [clientStateReady, commitProjectCatalog, projectProbe.project, projectProbe.status])

  useEffect(() => {
    if (route.modeId !== 'pixel') return
    setPixelDraft(readPixelDraft(pixelStorageKey(activeModeDocument?.id), activeModeDocument?.id))
  }, [activeModeDocument?.id, route.modeId])

  useEffect(() => {
    if (route.modeId !== 'smart-video') return
    setVideoSession(readVideoSession(videoStorageKey(activeModeDocument?.id), activeModeDocument?.id))
  }, [activeModeDocument?.id, route.modeId])

  const retryLocalContexts = useCallback(() => {
    const snapshot = readProjectCatalog()
    projectCatalogRef.current = snapshot.catalog
    setProjectCatalog(snapshot.catalog)
    setProjectCatalogError(snapshot.error)
    setPixelDraft(readPixelDraft(
      activeModeDocument?.modeId === 'pixel' ? pixelStorageKey(activeModeDocument.id) : PIXEL_STORAGE_KEY,
      activeModeDocument?.modeId === 'pixel' ? activeModeDocument.id : undefined,
    ))
    setVideoSession(readVideoSession(
      activeModeDocument?.modeId === 'smart-video' ? videoStorageKey(activeModeDocument.id) : SMART_VIDEO_SESSION_KEY,
      activeModeDocument?.modeId === 'smart-video' ? activeModeDocument.id : undefined,
    ))
    void refreshProject(preferences.balancedProjectId)
  }, [activeModeDocument, preferences.balancedProjectId, refreshProject])

  const openRuntimeSettings = useCallback(() => {
    void preloadProductDialog('settings').catch(() => undefined)
    setSettingsOpen(true)
    setSettingsError(undefined)
    setSettingsMessage(undefined)
    void refreshRuntime()
  }, [refreshRuntime])

  const openWorkflowCenter = useCallback(() => {
    void preloadProductDialog('workflow').catch(() => undefined)
    setWorkflowCenterOpen(true)
  }, [])

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

  const handleApplyRegistryMigration = useCallback(async (planId: string, beforeHash: string) => {
    if (settingsSaving) return
    setSettingsSaving(true)
    setSettingsError(undefined)
    setSettingsMessage(undefined)
    try {
      await applyRuntimeRegistryMigration(planId, beforeHash)
      setSettingsMessage('共享模型引用已安全改写为可迁移相对路径；模型文件没有移动或复制。')
      await refreshRuntime(true)
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : '共享模型引用修复失败')
    } finally {
      setSettingsSaving(false)
    }
  }, [refreshRuntime, settingsSaving])

  const handleRollbackRegistryMigration = useCallback(async (recordId: string) => {
    if (settingsSaving) return
    setSettingsSaving(true)
    setSettingsError(undefined)
    setSettingsMessage(undefined)
    try {
      await rollbackRuntimeRegistryMigration(recordId)
      setSettingsMessage('已恢复共享模型配置的迁移前版本。')
      await refreshRuntime(true)
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : '共享模型引用回滚失败')
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

  const recentProjects = useMemo<RecentProjectSummary[]>(() => projectCatalog.projects.map((project) => {
    const latestDocument = [...project.documents].sort((left, right) => right.updatedAt - left.updatedAt)[0]
    const documentCounts = project.documents.reduce<NonNullable<RecentProjectSummary['documentCounts']>>((counts, document) => {
      counts[document.modeId] = (counts[document.modeId] ?? 0) + 1
      return counts
    }, {})
    return {
      id: project.id,
      title: project.title,
      description: project.description || `${project.documents.length} 份创作文档`,
      modeId: latestDocument?.modeId ?? project.initialModeId,
      initialModeId: project.initialModeId,
      status: project.status,
      color: project.color,
      documentCounts,
      storageLabel: '浏览器本机',
      updatedAt: project.updatedAt,
      lastOpenedAt: project.lastOpenedAt,
      trashedAt: project.trashedAt,
      updatedLabel: relativeTime(project.updatedAt),
    }
  }), [projectCatalog.projects])

  const recentProjectsFeedback = useMemo<ShellFeedback | undefined>(() => {
    if (projectCatalogError) {
      return {
        status: 'error',
        title: recentProjects.length ? '项目目录存在未保存变更' : '无法读取项目目录',
        detail: projectCatalogError,
        actionLabel: '重试读取',
      }
    }
    if (recentProjects.length === 0) {
      return {
        status: 'empty',
        title: '尚未创建项目',
        detail: '创建一个项目后，可从同一项目进入均衡、像素与智能视频模式。',
      }
    }
    return undefined
  }, [projectCatalogError, recentProjects.length])

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
    const catalogDocumentId = activeWorkspaceProjectId && activeModeDocumentMode === 'pixel'
      ? activeModeDocumentId
      : undefined
    const storageKey = pixelStorageKey(catalogDocumentId)
    const usesLegacyBridge = !catalogDocumentId
    if (!isMeaningfulPixelDraft(next)) {
      const serialized = serializePixelDocument(next)
      if (usesLegacyBridge) clientStateDirtyRef.current.add('pixel-document')
      try { localStorage.setItem(storageKey, serialized) } catch { /* surfaced after the first meaningful edit */ }
      if (usesLegacyBridge) queuePixelBridgeSave(serialized)
      setPixelDraft({ status: 'empty', document: next })
      return
    }
    const serialized = serializePixelDocument(next)
    if (usesLegacyBridge) clientStateDirtyRef.current.add('pixel-document')
    let browserStored = true
    try {
      localStorage.setItem(storageKey, serialized)
    } catch {
      browserStored = false
    }
    if (usesLegacyBridge) queuePixelBridgeSave(serialized)
    const durablyStored = browserStored || bridgeReadyRef.current
    setPixelDraft(durablyStored
      ? { status: 'ready', document: next }
      : {
          status: 'error',
          document: next,
          error: '像素草稿仍在当前页面，但项目文档存储写入失败；刷新前请先导出。',
        })
    if (catalogDocumentId && activeWorkspaceProjectId) {
      if (bridgeReadyRef.current) {
        void saveWorkspaceModeDocument({
          projectId: activeWorkspaceProjectId,
          documentId: catalogDocumentId,
          modeId: 'pixel',
          revision: next.revision,
          value: serialized,
          reason: 'pixel-autosave',
        }).then(() => {
          setPixelDraft({ status: 'ready', document: next })
        }).catch((error) => {
          const conflict = error instanceof ProjectApiError && error.code === 'WORKSPACE_DOCUMENT_CONFLICT'
          setPixelDraft({
            status: 'error',
            document: next,
            error: conflict
              ? '像素文档已在另一页面更新；当前内存草稿仍保留，未覆盖 SQLite 版本。'
              : '像素草稿仍在当前页面，但写入 SQLite 项目正文失败；刷新前请先导出。',
          })
          setModeNotice({ tone: 'error', message: error instanceof Error ? error.message : '像素项目正文保存失败' })
        })
      }
      try {
        commitProjectCatalog(touchProjectDocument(
          projectCatalogRef.current,
          activeWorkspaceProjectId,
          catalogDocumentId,
          { title: next.name, revision: next.revision },
        ))
      } catch (error) {
        setProjectCatalogError(error instanceof Error ? error.message : '像素文档索引更新失败')
      }
    } else if (route.modeId === 'pixel' && route.projectId !== next.id) {
      replaceModeProjectReference('pixel', next.id)
    }
    if (!browserStored) {
      setModeNotice(bridgeReadyRef.current
        ? { tone: 'info', message: '浏览器配额不足；像素草稿将保存到 SQLite 工作区。' }
        : { tone: 'error', message: '像素草稿未能持久化；刷新前请先导出。' })
    }
  }, [activeModeDocumentId, activeModeDocumentMode, activeWorkspaceProjectId, commitProjectCatalog, queuePixelBridgeSave, replaceModeProjectReference, route.modeId, route.projectId])

  const handleVideoPlanReady = useCallback((result: SmartVideoPlanResult) => {
    const catalogDocumentId = activeWorkspaceProjectId && activeModeDocumentMode === 'smart-video'
      ? activeModeDocumentId
      : undefined
    const storageKey = videoStorageKey(catalogDocumentId)
    const usesLegacyBridge = !catalogDocumentId
    const session = smartVideoSessionFromResult(result)
    const serialized = serializeSmartVideoSession(session)
    if (usesLegacyBridge) clientStateDirtyRef.current.add('smart-video-session')
    let browserStored = true
    try {
      sessionStorage.setItem(storageKey, serialized)
    } catch {
      browserStored = false
    }
    const durablyStored = browserStored || bridgeReadyRef.current
    setVideoSession(durablyStored
      ? { status: 'ready', session, result }
      : {
          status: 'error',
          session,
          result,
          error: '智能视频计划仍在当前页面，但浏览器存储失败且本机桥接离线；刷新后无法恢复。',
        })
    if (catalogDocumentId && activeWorkspaceProjectId) {
      const catalogDocument = projectCatalogRef.current.projects
        .find(({ id }) => id === activeWorkspaceProjectId)
        ?.documents.find(({ id }) => id === catalogDocumentId)
      const documentRevision = Math.max(0, catalogDocument?.revision ?? 0) + 1
      if (bridgeReadyRef.current) {
        void saveWorkspaceModeDocument({
          projectId: activeWorkspaceProjectId,
          documentId: catalogDocumentId,
          modeId: 'smart-video',
          revision: documentRevision,
          value: serializeSmartVideoDocument(result),
          reason: 'smart-video-plan-autosave',
        }).catch((error) => {
          setVideoSession({
            status: 'error',
            session,
            result,
            error: error instanceof ProjectApiError && error.code === 'WORKSPACE_DOCUMENT_CONFLICT'
              ? '智能视频项目已在另一页面更新；当前计划仍保留，未覆盖 SQLite 版本。'
              : '智能视频计划仍在当前页面，但写入 SQLite 项目正文失败。',
          })
          setModeNotice({ tone: 'error', message: error instanceof Error ? error.message : '智能视频项目正文保存失败' })
        })
      }
      try {
        commitProjectCatalog(touchProjectDocument(
          projectCatalogRef.current,
          activeWorkspaceProjectId,
          catalogDocumentId,
          { title: result.project.title, revision: documentRevision },
        ))
      } catch (error) {
        setProjectCatalogError(error instanceof Error ? error.message : '智能视频文档索引更新失败')
      }
    } else if (route.modeId === 'smart-video' && route.projectId !== session.projectId) {
      replaceModeProjectReference('smart-video', session.projectId)
    }
    setModeNotice(durablyStored
      ? { tone: 'success', message: '剧本、分镜与执行计划已保存到 SQLite 项目正文。' }
      : { tone: 'error', message: '当前计划未能持久化；刷新后无法恢复。' })
    if (usesLegacyBridge && bridgeReadyRef.current) {
      void saveClientState('smart-video-session', serialized).catch(() => {
        setModeNotice({ tone: 'error', message: '智能视频会话未能写入本机用户数据；当前页面内容仍保留。' })
      })
    }
  }, [activeModeDocumentId, activeModeDocumentMode, activeWorkspaceProjectId, commitProjectCatalog, replaceModeProjectReference, route.modeId, route.projectId])

  const handleBalancedDocumentChange = useCallback((document: CanvasDocument) => {
    if (!activeWorkspaceProjectId || activeModeDocumentMode !== 'balanced' || !activeModeDocumentId) return
    try {
      commitProjectCatalog(touchProjectDocument(
        projectCatalogRef.current,
        activeWorkspaceProjectId,
        activeModeDocumentId,
        { title: document.title, revision: document.revision },
      ))
    } catch (error) {
      setProjectCatalogError(error instanceof Error ? error.message : '均衡文档索引更新失败')
    }
  }, [activeModeDocumentId, activeModeDocumentMode, activeWorkspaceProjectId, commitProjectCatalog])

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
      (!(activeModeDocument?.id ?? route.projectId) || (activeModeDocument?.id ?? route.projectId) === pixelDraft.document.id)
    ) message = `已恢复像素草稿“${pixelDraft.document.name}”。`
    if (
      route.modeId === 'smart-video' &&
      videoSession.status === 'ready' &&
      videoSession.session &&
      (!(activeModeDocument?.id ?? route.projectId) || (activeModeDocument?.id ?? route.projectId) === videoSession.session.projectId)
    ) message = `已恢复本机剧本输入“${videoSession.session.title}”。`
    if (!message) return
    announcedRecoveryRef.current = currentRouteKey
    setModeNotice({ tone: 'info', message })
  }, [activeModeDocument?.id, currentRouteKey, pixelDraft, preferences.balancedProjectId, projectProbe, route.modeId, route.projectId, videoSession])

  const goHome = useCallback(() => navigate({ modeId: 'home' }), [navigate])

  const openLibrary = useCallback(() => {
    void preloadProductDialog('library').catch(() => undefined)
    setLibraryOpenPending(true)
    if (!clientStateReady) setModeNotice({ tone: 'info', message: '正在同步 SQLite 项目目录，随后打开资源库。' })
  }, [clientStateReady])

  useEffect(() => {
    if (!libraryOpenPending || !clientStateReady) return
    let disposed = false
    void (async () => {
      await flushProjectCatalogBridgeSave()
      if (bridgeReadyRef.current) {
        const expectedProjectIds = projectCatalogRef.current.projects
          .filter((project) => project.status === 'active')
          .map((project) => project.id)
        let synchronized = expectedProjectIds.length === 0
        for (let attempt = 0; attempt < 5 && !synchronized; attempt += 1) {
          const authoritative = await loadWorkspaceCatalog()
          const remoteIds = new Set(authoritative.catalog.projects.map((project) => project.id))
          synchronized = expectedProjectIds.every((id) => remoteIds.has(id))
          if (!synchronized) {
            await flushProjectCatalogBridgeSave()
            await new Promise<void>((resolve) => window.setTimeout(resolve, 120 * (attempt + 1)))
          }
        }
        if (!synchronized) throw new Error('项目目录尚未完成 SQLite 同步，请稍后重试。')
      }
      if (!disposed) {
        setLibraryOpenPending(false)
        setModeNotice((current) => current?.message === '正在同步 SQLite 项目目录，随后打开资源库。' ? null : current)
        setLibraryOpen(true)
      }
    })().catch((error) => {
      if (!disposed) {
        setLibraryOpenPending(false)
        setModeNotice({ tone: 'error', message: error instanceof Error ? error.message : '项目目录同步失败，暂不能打开资源库。' })
      }
    })
    return () => { disposed = true }
  }, [clientStateReady, flushProjectCatalogBridgeSave, libraryOpenPending])

  const handleUseLibraryAsset = useCallback((asset: LibraryAsset) => {
    if (route.modeId === 'home') return
    const supportsAsset = asset.mediaKind === 'image' || (route.modeId === 'smart-video' && ['audio', 'video'].includes(asset.mediaKind))
    if (!supportsAsset) {
      setModeNotice({ tone: 'error', message: route.modeId === 'smart-video' ? '智能视频可投递图片、音频与视频资产。' : '当前模式只接受资源库图片投递。' })
      return
    }
    setLibraryInsertion({
      nonce: Date.now(),
      asset,
      modeId: route.modeId,
      documentId: activeModeDocumentId,
    })
    setLibraryOpen(false)
    setModeNotice({ tone: 'info', message: `正在把“${asset.title}”投递到${PRODUCT_MODE_LABELS[route.modeId]}。` })
  }, [activeModeDocumentId, route.modeId])

  const handleLibraryAssetConsumed = useCallback((nonce: number) => {
    setLibraryInsertion((current) => current?.nonce === nonce ? null : current)
  }, [])

  const libraryProjects = useMemo(() => projectCatalog.projects
    .filter((project) => project.status === 'active')
    .map((project) => ({ id: project.id, title: project.title })), [projectCatalog.projects])
  const activeLibraryInsertion = route.modeId !== 'home'
    && libraryInsertion?.modeId === route.modeId
    && libraryInsertion.documentId === activeModeDocumentId
    ? libraryInsertion
    : undefined
  const libraryDialog = libraryOpen ? (
    <Suspense fallback={<DeferredDialogLoading label="资源库" />}>
      <LazyAssetLibraryDialog
        open
        projects={libraryProjects}
        activeProjectId={activeWorkspaceProjectId ?? libraryProjects[0]?.id}
        modeLabel={route.modeId === 'home' ? undefined : PRODUCT_MODE_LABELS[route.modeId]}
        onClose={() => setLibraryOpen(false)}
        onUseAsset={route.modeId === 'home' ? undefined : handleUseLibraryAsset}
      />
    </Suspense>
  ) : null
  const workflowCenterDialog = workflowCenterOpen ? (
    <Suspense fallback={<DeferredDialogLoading label="工作流中心" />}>
      <LazyWorkflowCenterDialog
        open
        onClose={() => setWorkflowCenterOpen(false)}
        onOpenRuntimeSettings={openRuntimeSettings}
        projects={libraryProjects}
        activeProjectId={activeWorkspaceProjectId ?? libraryProjects[0]?.id}
      />
    </Suspense>
  ) : null

  if (route.modeId === 'balanced') {
    const requestedProjectId = activeModeDocument?.id ?? route.projectId ?? preferences.balancedProjectId ?? DEFAULT_BALANCED_PROJECT_ID
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
      const canCreate = requestedProjectId === DEFAULT_BALANCED_PROJECT_ID || Boolean(activeWorkspaceProject && activeModeDocument)
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
      <>
      <ProductModeHost modeId="balanced" modeLabel="均衡模式" routeKey={currentRouteKey} notice={modeNotice} onBack={goHome} onOpenLibrary={openLibrary} onOpenWorkflowCenter={openWorkflowCenter}>
        <LazyBalancedWorkbench
          key={requestedProjectId}
          projectId={requestedProjectId}
          workspaceProjectId={activeWorkspaceProjectId}
          projectTitle={activeWorkspaceProject?.title}
          initialDocument={projectProbe.project?.id === requestedProjectId ? projectProbe.project.document : undefined}
          onBack={goHome}
          onDocumentChange={handleBalancedDocumentChange}
          libraryAsset={activeLibraryInsertion}
          onLibraryAssetConsumed={handleLibraryAssetConsumed}
        />
      </ProductModeHost>
      {libraryDialog}
      {workflowCenterDialog}
      </>
    )
  }

  if (route.modeId === 'pixel') {
    const requestedProjectId = activeModeDocument?.id ?? route.projectId
    const requestedWorkspaceKey = activeWorkspaceProjectId && requestedProjectId
      ? `${activeWorkspaceProjectId}:${requestedProjectId}:pixel`
      : null
    if (requestedWorkspaceKey && workspaceDocumentResolvedKey !== requestedWorkspaceKey) {
      return (
        <ModeGate
          modeLabel="像素模式"
          feedback={{ status: 'loading', title: '正在读取像素项目正文', detail: '正在从 SQLite 工作区恢复此文档的图层、帧与调色板。' }}
          onBack={goHome}
        />
      )
    }
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
          onAction={() => setPixelDraft(readPixelDraft(pixelStorageKey(requestedProjectId), requestedProjectId))}
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
          onAction={() => setPixelDraft(readPixelDraft(pixelStorageKey(requestedProjectId), requestedProjectId))}
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
      <>
      <ProductModeHost modeId="pixel" modeLabel="像素模式" routeKey={currentRouteKey} notice={modeNotice} onBack={goHome} onOpenLibrary={openLibrary} onOpenWorkflowCenter={openWorkflowCenter}>
        <LazyPixelModeWorkbench
          key={requestedProjectId ?? 'pixel-legacy'}
          initialDocument={pixelEntry.hasMemoryDocument ? pixelDraft.document : undefined}
          projectId={requestedProjectId}
          projectName={activeWorkspaceProject?.title}
          onBack={goHome}
          onDocumentChange={handlePixelChange}
          onSpriteSheetReady={handleSpriteSheetExport}
          libraryAsset={activeLibraryInsertion}
          onLibraryAssetConsumed={handleLibraryAssetConsumed}
        />
      </ProductModeHost>
      {libraryDialog}
      {workflowCenterDialog}
      </>
    )
  }

  if (route.modeId === 'smart-video') {
    const requestedProjectId = activeModeDocument?.id ?? route.projectId
    const requestedWorkspaceKey = activeWorkspaceProjectId && requestedProjectId
      ? `${activeWorkspaceProjectId}:${requestedProjectId}:smart-video`
      : null
    if (requestedWorkspaceKey && workspaceDocumentResolvedKey !== requestedWorkspaceKey) {
      return (
        <ModeGate
          modeLabel="智能视频"
          feedback={{ status: 'loading', title: '正在读取智能视频项目正文', detail: '正在从 SQLite 工作区恢复剧本、分镜与执行计划。' }}
          onBack={goHome}
        />
      )
    }
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
          onAction={() => setVideoSession(readVideoSession(videoStorageKey(requestedProjectId), requestedProjectId))}
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
          onAction={() => setVideoSession(readVideoSession(videoStorageKey(requestedProjectId), requestedProjectId))}
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
      <>
      <ProductModeHost modeId="smart-video" modeLabel="智能视频" routeKey={currentRouteKey} notice={modeNotice} onBack={goHome} onOpenLibrary={openLibrary} onOpenWorkflowCenter={openWorkflowCenter}>
        <LazySmartVideoWorkbench
          key={requestedProjectId ?? 'video-legacy'}
          initialText={videoSession.status === 'ready' ? videoSession.session?.sourceText : undefined}
          initialKind={videoSession.status === 'ready' ? videoSession.session?.sourceKind : undefined}
          initialResult={videoSession.status === 'ready' ? videoSession.result : undefined}
          projectId={requestedProjectId}
          workspaceProjectId={activeWorkspaceProjectId ?? undefined}
          projectTitle={activeWorkspaceProject?.title}
          runtime={smartVideoRuntime}
          onBack={goHome}
          onPlanReady={handleVideoPlanReady}
          libraryAsset={activeLibraryInsertion}
          onLibraryAssetConsumed={handleLibraryAssetConsumed}
        />
      </ProductModeHost>
      {libraryDialog}
      {workflowCenterDialog}
      </>
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
        projectCatalogReady={clientStateReady}
        refreshingRuntime={refreshingRuntime}
        onModeSelect={chooseMode}
        onCreateProject={handleCreateProject}
        onOpenProject={handleOpenProject}
        onProjectStatusChange={handleProjectStatusChange}
        onOpenProjectRecovery={handleOpenProjectRecovery}
        onExportProject={(projectId) => void handleExportProjectPackage(projectId)}
        onImportProject={() => packageInputRef.current?.click()}
        onRetryProjects={retryLocalContexts}
        onOpenLibrary={openLibrary}
        onOpenWorkflowCenter={openWorkflowCenter}
        onOpenSettings={openRuntimeSettings}
        onRefreshRuntime={() => void refreshRuntime()}
        onRuntimeItemAction={(item) => void handleRuntimeAction(item)}
      />
      {libraryDialog}
      {workflowCenterDialog}
      {settingsOpen ? (
        <Suspense fallback={<DeferredDialogLoading label="设置" />}>
          <LazyRuntimeSettingsDialog
            open
            projects={projectCatalog.projects.map(({ id, title }) => ({ id, title }))}
            diagnostics={runtimeProbe.diagnostics}
            loading={refreshingRuntime}
            saving={settingsSaving}
            error={settingsError}
            message={settingsMessage}
            onClose={() => setSettingsOpen(false)}
            onRefresh={() => void refreshRuntime()}
            onConfigure={(request) => void handleRuntimeConfigure(request)}
            onApplyRegistryMigration={(planId, beforeHash) => void handleApplyRegistryMigration(planId, beforeHash)}
            onRollbackRegistryMigration={(recordId) => void handleRollbackRegistryMigration(recordId)}
          />
        </Suspense>
      ) : null}
      {recoveryDialog ? (
        <Suspense fallback={<DeferredDialogLoading label="恢复点" />}>
          <LazyProjectRecoveryDialog
            open
            projectTitle={recoveryDialog.projectTitle}
            recoveryPoints={recoveryDialog.recoveryPoints}
            loading={recoveryDialog.loading}
            busyId={recoveryDialog.busyId}
            error={recoveryDialog.error}
            message={recoveryDialog.message}
            onClose={() => setRecoveryDialog(null)}
            onRefresh={() => void refreshRecoveryDialog(recoveryDialog.projectId)}
            onCreate={() => void handleCreateRecoveryPoint()}
            onRestore={(recoveryPoint) => void handleRestoreRecoveryPoint(recoveryPoint)}
          />
        </Suspense>
      ) : null}
      <input
        ref={packageInputRef}
        className="aq-sr-only"
        type="file"
        accept=".aeonquill,.miaohui,application/vnd.aeonquill.project,application/vnd.miaohui.project"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void handleImportProjectPackage(file)
          event.target.value = ''
        }}
      />
    </>
  )
}
