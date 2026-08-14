import { useCallback, useEffect, useMemo, useState } from 'react'
import BalancedWorkbench from './App'
import {
  deserializePixelDocument,
  serializePixelDocument,
  type PixelDocument,
} from './lib/pixel'
import { loadLocalProject, type StoredProject } from './lib/projectApi'
import {
  fetchRuntimeStatus,
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
  type LocalRuntimeSummary,
  type ModeAvailabilitySummary,
  type ProductModeId,
  type RecentProjectSummary,
  type RuntimeHealth,
  type RuntimeSurfaceSummary,
} from './shell'
import type { RuntimeStatus } from './types'
import './product-app.css'

type ProductRoute = 'home' | ProductModeId

type RuntimeProbe = {
  bridgeReady: boolean
  checking: boolean
  checkedAt?: number
  runtime: RuntimeStatus | null
  error?: string
}

const PIXEL_STORAGE_KEY = 'aeonquill:pixel-document:v1'

function routeFromLocation(): ProductRoute {
  const candidate = window.location.hash.replace(/^#\/?/, '')
  return candidate === 'balanced' || candidate === 'pixel' || candidate === 'smart-video'
    ? candidate
    : 'home'
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
  if (probe.checking) return 'checking'
  if (!probe.bridgeReady) return 'offline'
  if (probe.runtime?.lifecycle?.state === 'starting') return 'starting'
  if ((probe.runtime?.queueRunning ?? 0) + (probe.runtime?.queuePending ?? 0) > 0) return 'busy'
  return 'ready'
}

function makeRuntimeSummary(probe: RuntimeProbe): LocalRuntimeSummary {
  const runtime = probe.runtime
  const queueCount = (runtime?.queueRunning ?? 0) + (runtime?.queuePending ?? 0)
  const lifecycle = runtime?.lifecycle
  const comfyStatus: RuntimeHealth = probe.checking
    ? 'checking'
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
      status: probe.checking ? 'checking' : probe.bridgeReady ? 'ready' : 'offline',
      statusLabel: probe.checking ? '检查中' : probe.bridgeReady ? '已连接' : '未连接',
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
            : comfyStatus === 'unavailable' ? '依赖不完整' : comfyStatus === 'checking' ? '检查中' : '休眠',
      detail: runtime?.connected
        ? `${lifecycle?.owned ? '光阴砚托管' : '外部进程'} · ${runtime.comfyVersion ?? '版本未知'}`
        : '按需启动；规划与浏览器编辑仍可离线使用',
      actionLabel: lifecycle?.owned && runtime?.connected ? '关闭' : !runtime?.connected ? '启动' : undefined,
    },
    {
      id: 'gpu',
      label: '图形处理器',
      status: runtime?.device ? queueCount ? 'busy' : 'ready' : probe.checking ? 'checking' : 'offline',
      statusLabel: runtime?.device ? queueCount ? '任务中' : '可用' : probe.checking ? '检查中' : '待检测',
      detail: runtime?.device
        ? `${runtime.device} · ${formatBytes(runtime.vramFree)} 可用`
        : '启动 ComfyUI 后读取显存状态',
      usagePercent: usedVram !== undefined && runtime?.vramTotal
        ? Math.round((usedVram / runtime.vramTotal) * 100)
        : undefined,
    },
    {
      id: 'models',
      label: '本地模型与节点',
      status: probe.checking ? 'checking' : runtime?.ready ? 'ready' : missingCount ? 'unavailable' : 'offline',
      statusLabel: runtime?.ready ? '契约满足' : missingCount ? `缺少 ${missingCount}` : probe.checking ? '检查中' : '待运行',
      detail: missingCount
        ? `${runtime?.missingNodes?.length ?? 0} 个节点、${runtime?.missingModels?.length ?? 0} 个模型待处理`
        : runtime?.ready ? '当前视频工作流依赖已通过探测' : '运行时休眠时不占用显存',
    },
    {
      id: 'storage',
      label: '项目与资产存储',
      status: probe.checking ? 'checking' : probe.bridgeReady ? 'ready' : 'offline',
      statusLabel: probe.checking ? '检查中' : probe.bridgeReady ? '本机可用' : '未连接',
      detail: probe.bridgeReady ? '不可变资产版本与项目快照由本机服务管理' : '浏览器仍保留有限离线草稿',
    },
  ]

  const status = runtimeHealth(probe)
  return {
    status,
    statusLabel: status === 'checking'
      ? '正在检查'
      : status === 'busy' ? '正在创作' : status === 'starting' ? '正在启动' : status === 'ready' ? '本机可用' : '浏览器离线模式',
    detail: probe.bridgeReady
      ? '确定性编辑可直接使用；GPU 工作流按任务启动并在空闲后释放。'
      : '像素与画布基础编辑仍可使用，ComfyUI 与本机资产能力暂不可用。',
    lastCheckedLabel: probe.checkedAt ? relativeTime(probe.checkedAt) : undefined,
    privacyNote: '本地工作流、素材与模型默认留在此设备；只有明确配置的文本或生成 API 才会访问外部服务。',
    items,
  }
}

function makeSmartVideoRuntime(probe: RuntimeProbe): SmartVideoRuntimeSummary {
  const runtime = probe.runtime
  const queueCount = (runtime?.queueRunning ?? 0) + (runtime?.queuePending ?? 0)
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

function loadPixelDraft() {
  try {
    const stored = localStorage.getItem(PIXEL_STORAGE_KEY)
    return stored ? deserializePixelDocument(stored) : undefined
  } catch {
    return undefined
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

export default function ProductApp() {
  const [route, setRoute] = useState<ProductRoute>(routeFromLocation)
  const [selectedModeId, setSelectedModeId] = useState<ProductModeId>('balanced')
  const [runtimeProbe, setRuntimeProbe] = useState<RuntimeProbe>({
    bridgeReady: false,
    checking: true,
    runtime: null,
  })
  const [refreshingRuntime, setRefreshingRuntime] = useState(false)
  const [storedProject, setStoredProject] = useState<StoredProject | null>(null)
  const [pixelDocument, setPixelDocument] = useState<PixelDocument | undefined>(loadPixelDraft)
  const [videoPlan, setVideoPlan] = useState<SmartVideoPlanResult | null>(null)
  const [modeNotice, setModeNotice] = useState<string | null>(null)

  const navigate = useCallback((next: ProductRoute) => {
    const target = next === 'home'
      ? `${window.location.pathname}${window.location.search}`
      : `${window.location.pathname}${window.location.search}#/${next}`
    window.history.pushState({ aeonquillRoute: next }, '', target)
    setRoute(next)
    if (next !== 'home') setSelectedModeId(next)
  }, [])

  useEffect(() => {
    const syncRoute = () => setRoute(routeFromLocation())
    window.addEventListener('popstate', syncRoute)
    window.addEventListener('hashchange', syncRoute)
    return () => {
      window.removeEventListener('popstate', syncRoute)
      window.removeEventListener('hashchange', syncRoute)
    }
  }, [])

  const refreshRuntime = useCallback(async () => {
    setRefreshingRuntime(true)
    setRuntimeProbe((current) => ({ ...current, checking: true, error: undefined }))
    try {
      const runtime = await fetchRuntimeStatus(true)
      const checkedAt = Date.now()
      setRuntimeProbe({ bridgeReady: true, checking: false, checkedAt, runtime })
      try {
        setStoredProject(await loadLocalProject())
      } catch {
        setStoredProject(null)
      }
    } catch (error) {
      setRuntimeProbe({
        bridgeReady: false,
        checking: false,
        checkedAt: Date.now(),
        runtime: null,
        error: error instanceof Error ? error.message : '无法连接本机服务',
      })
      setStoredProject(null)
    } finally {
      setRefreshingRuntime(false)
    }
  }, [])

  useEffect(() => {
    if (route === 'balanced') return
    void refreshRuntime()
    const timer = window.setInterval(() => void refreshRuntime(), 15_000)
    return () => window.clearInterval(timer)
  }, [refreshRuntime, route])

  const handleRuntimeAction = useCallback(async (item: RuntimeSurfaceSummary) => {
    if (item.id !== 'comfyui' || refreshingRuntime) return
    setRefreshingRuntime(true)
    try {
      const runtime = runtimeProbe.runtime?.connected && runtimeProbe.runtime.lifecycle?.owned
        ? await stopRuntime()
        : await startRuntime()
      setRuntimeProbe({ bridgeReady: true, checking: false, checkedAt: Date.now(), runtime })
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
  }, [refreshingRuntime, runtimeProbe.runtime])

  const runtimeSummary = useMemo(() => makeRuntimeSummary(runtimeProbe), [runtimeProbe])
  const smartVideoRuntime = useMemo(() => makeSmartVideoRuntime(runtimeProbe), [runtimeProbe])
  const modeAvailability = useMemo<Partial<Record<ProductModeId, ModeAvailabilitySummary>>>(() => ({
    balanced: runtimeProbe.bridgeReady
      ? { status: 'available', label: '本机增强已连接' }
      : { status: 'degraded', label: '浏览器模式', reason: '本机任务与资产服务暂未连接' },
    pixel: { status: 'available', label: '确定性内核可用' },
    'smart-video': runtimeProbe.runtime?.connected && runtimeProbe.runtime.ready
      ? { status: 'available', label: '规划与本地工作流可用' }
      : { status: 'degraded', label: '规划模式', reason: 'ComfyUI 将在实际生成阶段按需启动' },
  }), [runtimeProbe])

  const recentProjects = useMemo<RecentProjectSummary[]>(() => {
    const projects: RecentProjectSummary[] = []
    if (storedProject) {
      projects.push({
        id: storedProject.id,
        title: storedProject.title,
        modeId: 'balanced',
        updatedLabel: relativeTime(storedProject.updatedAt),
        description: `${storedProject.document.elements.length} 个画布元件 · revision ${storedProject.revision}`,
      })
    }
    if (pixelDocument) {
      projects.push({
        id: pixelDocument.id,
        title: pixelDocument.name,
        modeId: 'pixel',
        updatedLabel: '本机草稿',
        description: `${pixelDocument.width} × ${pixelDocument.height} · ${pixelDocument.frames.length} 帧 · ${pixelDocument.layers.length} 图层`,
      })
    }
    if (videoPlan) {
      projects.push({
        id: videoPlan.project.id,
        title: videoPlan.project.title,
        modeId: 'smart-video',
        updatedLabel: relativeTime(videoPlan.project.updatedAt),
        description: `${videoPlan.project.scenes.length} 个场景 · ${videoPlan.plan.tasks.length} 个受控任务`,
      })
    }
    return projects
  }, [pixelDocument, storedProject, videoPlan])

  const handlePixelChange = useCallback((next: PixelDocument) => {
    setPixelDocument(next)
    try {
      localStorage.setItem(PIXEL_STORAGE_KEY, serializePixelDocument(next))
    } catch {
      // The current session still owns the document when browser storage is full.
    }
  }, [])

  const handleSpriteSheetExport = useCallback(async (payload: PixelSpriteSheetPayload) => {
    try {
      await exportSpriteSheet(payload)
      setModeNotice('Sprite Sheet PNG 与元数据已导出')
    } catch (error) {
      setModeNotice(error instanceof Error ? error.message : 'Sprite Sheet 导出失败')
    }
  }, [])

  useEffect(() => {
    if (!modeNotice) return
    const timer = window.setTimeout(() => setModeNotice(null), 3_000)
    return () => window.clearTimeout(timer)
  }, [modeNotice])

  if (route === 'balanced') return <BalancedWorkbench onBack={() => navigate('home')} />
  if (route === 'pixel') {
    return (
      <div className="aq-product-mode-host">
        <PixelModeWorkbench
          initialDocument={pixelDocument}
          onBack={() => navigate('home')}
          onDocumentChange={handlePixelChange}
          onSpriteSheetReady={(payload) => void handleSpriteSheetExport(payload)}
        />
        {modeNotice ? <div className="aq-product-notice" role="status">{modeNotice}</div> : null}
      </div>
    )
  }
  if (route === 'smart-video') {
    return (
      <div className="aq-product-mode-host">
        <SmartVideoWorkbench
          initialText={videoPlan?.project.source.text}
          initialKind={videoPlan?.project.source.kind}
          runtime={smartVideoRuntime}
          onBack={() => navigate('home')}
          onPlanReady={setVideoPlan}
        />
      </div>
    )
  }

  return (
    <AeonQuillShell
      selectedModeId={selectedModeId}
      modeAvailability={modeAvailability}
      runtime={runtimeSummary}
      recentProjects={recentProjects}
      refreshingRuntime={refreshingRuntime}
      onModeSelect={setSelectedModeId}
      onModeOpen={navigate}
      onCreateProject={navigate}
      onOpenProject={(projectId) => {
        const project = recentProjects.find(({ id }) => id === projectId)
        navigate(project?.modeId ?? 'balanced')
      }}
      onOpenSettings={() => document.getElementById('aq-runtime-title')?.scrollIntoView({ behavior: 'smooth' })}
      onRefreshRuntime={() => void refreshRuntime()}
      onRuntimeItemAction={(item) => void handleRuntimeAction(item)}
    />
  )
}
