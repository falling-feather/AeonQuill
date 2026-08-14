import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, X } from 'lucide-react'
import { CanvasWorkspace } from './components/CanvasWorkspace'
import { ImageLab, type ImageLabResult } from './components/ImageLab'
import { Inspector } from './components/Inspector'
import { PixelEditor } from './components/PixelEditor'
import { PromptBar } from './components/PromptBar'
import { ToolRail } from './components/ToolRail'
import { TopBar } from './components/TopBar'
import {
  APP_STORAGE_KEY,
  defaultPixelPalette,
  defaultSpritePixels,
  LEGACY_APP_STORAGE_KEYS,
  seedCamera,
  seedElements,
} from './data/seed'
import {
  assertCanvasDocument,
  cloneCanvasDocument,
  commitCanvasPreview,
  createCanvasDocument,
  executeCanvasTool,
  migrateCanvasDocument,
  type CanvasActor,
  type CanvasDocument,
} from './lib/canvasCore'
import {
  isImageJobOutput,
  type Camera,
  type CanvasElement,
  type ImageLabMode,
  type ImageOperationId,
  type ImageToolId,
  type ProcessingJob,
  type ProcessingStep,
  type RuntimeStatus,
  type ToolId,
  type VideoJobRequest,
} from './types'
import {
  cancelVideoJob,
  clearFinishedJobs,
  createVideoJob,
  ensureLocalSession,
  fetchRuntimeStatus,
  fetchVideoJobs,
  normalizeVideoFirstFrame,
  retryVideoJob,
  startRuntime,
  stopRuntime,
  subscribeVideoJobs,
  updateRuntimePolicy,
  VIDEO_DIMENSIONS,
} from './lib/videoApi'
import {
  downloadLocalProjectPackage,
  importLocalProjectPackage,
  loadLocalProject,
  saveLocalProject,
} from './lib/projectApi'

function cloneElements(elements: CanvasElement[]) {
  return elements.map((element) => ({
    ...element,
    pixels: element.pixels ? [...element.pixels] : undefined,
    palette: element.palette ? [...element.palette] : undefined,
    adjustments: element.adjustments ? { ...element.adjustments } : undefined,
    crop: element.crop ? { ...element.crop } : undefined,
    processingStack: element.processingStack?.map((step) => ({ ...step })),
    jobError: element.jobError ? {
      ...element.jobError,
      suggestions: element.jobError.suggestions ? [...element.jobError.suggestions] : undefined,
      details: element.jobError.details ? { ...element.jobError.details } : undefined,
    } : undefined,
  }))
}

function loadProject(): CanvasDocument {
  for (const key of [APP_STORAGE_KEY, ...LEGACY_APP_STORAGE_KEYS]) {
    try {
      const stored = localStorage.getItem(key)
      if (!stored) continue
      return migrateCanvasDocument(JSON.parse(stored), {
        id: 'local-project',
        title: '妙绘本地画布',
      })
    } catch {
      // Try the next compatible storage generation before falling back to seed data.
    }
  }
  return createCanvasDocument({
    id: 'local-project',
    title: '光阴砚本地项目',
    elements: cloneElements(seedElements),
    camera: { ...seedCamera },
  })
}

function makeId(prefix: string) {
  return `${prefix}-${crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`
}

function getMaxZ(elements: CanvasElement[]) {
  return Math.max(0, ...elements.map((element) => element.zIndex))
}

const processingLabels: Record<ImageLabMode, string> = {
  adjust: '色彩调整',
  crop: '画幅裁剪',
  'remove-background': '背景移除草稿',
  'element-extract': 'SAM 元素提取',
  'mask-refine': '蒙版修边',
  pixelate: '像素化草稿',
  upscale: '浏览器放大',
  sharpen: '细节锐化',
  'alpha-cleanup': '透明边缘清理',
}

const imageOperationLabels: Record<ImageOperationId, string> = {
  'upscale-lanczos': 'Lanczos 超分放大',
  pixelate: '调色板像素化',
  sharpen: '细节锐化',
  'alpha-cleanup': '透明边缘清理',
  'remove-background': 'AI 去背景',
  'upscale-realesrgan': 'Real-ESRGAN 超分',
  'semantic-element-extract': 'SAM 元素提取',
}

function App() {
  const initialProject = useRef(loadProject())
  const [canvasDocument, setCanvasDocument] = useState<CanvasDocument>(initialProject.current)
  const documentRef = useRef(canvasDocument)
  const elements = canvasDocument.elements
  const camera = canvasDocument.camera
  const elementsRef = useRef(elements)
  const [selectedIds, setSelectedIds] = useState<string[]>(() =>
    initialProject.current.elements.some((element) => element.id === 'image-summer-character')
      ? ['image-summer-character']
      : [],
  )
  const [activeTool, setActiveTool] = useState<ToolId>('select')
  const [pixelEditorId, setPixelEditorId] = useState<string | null>(null)
  const [imageLab, setImageLab] = useState<{
    elementId: string
    mode: ImageLabMode
  } | null>(null)
  const [jobs, setJobs] = useState<ProcessingJob[]>([])
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null)
  const [runtimeLoading, setRuntimeLoading] = useState(true)
  const [streamConnected, setStreamConnected] = useState(false)
  const [videoSubmitting, setVideoSubmitting] = useState(false)
  const [videoSubmitError, setVideoSubmitError] = useState<string | null>(null)
  const [saveStatus, setSaveStatus] = useState<'saving' | 'saved'>('saved')
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [historyCounts, setHistoryCounts] = useState({ past: 0, future: 0 })
  const pastRef = useRef<CanvasDocument[]>([])
  const futureRef = useRef<CanvasDocument[]>([])
  const viewportRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const projectInputRef = useRef<HTMLInputElement>(null)
  const persistenceReadyRef = useRef(false)
  const lastPersistedRevisionRef = useRef(canvasDocument.revision)
  const jobStatusRef = useRef(new Map<string, ProcessingJob['status']>())
  const appliedImageJobIdsRef = useRef(new Set<string>())

  const replaceDocument = useCallback((next: CanvasDocument) => {
    const validated = assertCanvasDocument(next)
    documentRef.current = validated
    elementsRef.current = validated.elements
    setCanvasDocument(validated)
  }, [])

  const previewElements = useCallback((next: CanvasElement[]) => {
    const preview = { ...documentRef.current, elements: next }
    documentRef.current = preview
    elementsRef.current = next
    setCanvasDocument(preview)
  }, [])

  const previewCamera = useCallback((next: Camera) => {
    const preview = { ...documentRef.current, camera: next }
    documentRef.current = preview
    setCanvasDocument(preview)
  }, [])

  const syncHistoryCounts = useCallback(() => {
    setHistoryCounts({ past: pastRef.current.length, future: futureRef.current.length })
  }, [])

  const recordSnapshot = useCallback(
    (before: CanvasElement[]) => {
      const preview = documentRef.current
      if (JSON.stringify(before) === JSON.stringify(preview.elements)) return
      const base = assertCanvasDocument({ ...preview, elements: cloneElements(before) })
      const committed = commitCanvasPreview(base, preview, {
        id: makeId('transform'),
        actor: 'user',
      })
      pastRef.current = [...pastRef.current, cloneCanvasDocument(base)].slice(-80)
      futureRef.current = []
      replaceDocument(committed)
      syncHistoryCounts()
    },
    [replaceDocument, syncHistoryCounts],
  )

  const commitCanvasTool = useCallback((
    toolId: string,
    input: Record<string, unknown>,
    actor: CanvasActor = 'user',
    recordHistory = true,
  ) => {
    const before = documentRef.current
    const next = executeCanvasTool(before, {
      toolId,
      callId: makeId(actor === 'agent' ? 'agent-call' : 'canvas-command'),
      actor,
      input,
    })
    if (
      JSON.stringify(before.elements) === JSON.stringify(next.elements) &&
      JSON.stringify(before.camera) === JSON.stringify(next.camera)
    ) return false
    if (recordHistory) {
      pastRef.current = [...pastRef.current, cloneCanvasDocument(before)].slice(-80)
      futureRef.current = []
    }
    replaceDocument(next)
    if (recordHistory) syncHistoryCounts()
    return true
  }, [replaceDocument, syncHistoryCounts])

  const commitElements = useCallback(
    (
      updater: (current: CanvasElement[]) => CanvasElement[],
      actor: CanvasActor = 'tool',
      recordHistory = true,
    ) => {
      const next = updater(elementsRef.current)
      commitCanvasTool('canvas.elements.replace', { elements: next }, actor, recordHistory)
    },
    [commitCanvasTool],
  )

  const undo = useCallback(() => {
    const previous = pastRef.current.at(-1)
    if (!previous) return
    const current = documentRef.current
    pastRef.current = pastRef.current.slice(0, -1)
    futureRef.current = [cloneCanvasDocument(current), ...futureRef.current].slice(0, 80)
    replaceDocument(assertCanvasDocument({
      ...cloneCanvasDocument(previous),
      camera: current.camera,
      revision: current.revision + 1,
      createdAt: current.createdAt,
      updatedAt: Date.now(),
    }))
    syncHistoryCounts()
  }, [replaceDocument, syncHistoryCounts])

  const redo = useCallback(() => {
    const next = futureRef.current[0]
    if (!next) return
    const current = documentRef.current
    futureRef.current = futureRef.current.slice(1)
    pastRef.current = [...pastRef.current, cloneCanvasDocument(current)].slice(-80)
    replaceDocument(assertCanvasDocument({
      ...cloneCanvasDocument(next),
      camera: current.camera,
      revision: current.revision + 1,
      createdAt: current.createdAt,
      updatedAt: Date.now(),
    }))
    syncHistoryCounts()
  }, [replaceDocument, syncHistoryCounts])

  const showToast = useCallback((message: string) => {
    setToast(message)
  }, [])

  useEffect(() => {
    if (!toast) return
    const timeout = window.setTimeout(() => setToast(null), 2600)
    return () => window.clearTimeout(timeout)
  }, [toast])

  useEffect(() => {
    if (persistenceReadyRef.current && canvasDocument.revision === lastPersistedRevisionRef.current) return
    persistenceReadyRef.current = true
    setSaveStatus('saving')
    let disposed = false
    const timeout = window.setTimeout(() => {
      void (async () => {
        try {
          localStorage.setItem(APP_STORAGE_KEY, JSON.stringify(canvasDocument))
          lastPersistedRevisionRef.current = canvasDocument.revision
        } catch {
          if (!disposed) showToast('图片较大，本地自动保存空间不足')
        }
        try {
          const stored = await saveLocalProject(canvasDocument)
          if (
            !disposed &&
            documentRef.current.revision === canvasDocument.revision &&
            JSON.stringify(stored.document) !== JSON.stringify(documentRef.current)
          ) {
            localStorage.setItem(APP_STORAGE_KEY, JSON.stringify(stored.document))
            lastPersistedRevisionRef.current = stored.document.revision
            replaceDocument(assertCanvasDocument(stored.document))
          }
        } catch {
          // localStorage remains the offline fallback when the local bridge is unavailable.
        } finally {
          if (!disposed && documentRef.current.revision === canvasDocument.revision) setSaveStatus('saved')
        }
      })()
    }, 260)
    return () => {
      disposed = true
      window.clearTimeout(timeout)
    }
  }, [canvasDocument, replaceDocument, showToast])

  useEffect(() => {
    setSelectedIds((current) => current.filter((id) => elements.some((element) => element.id === id)))
  }, [elements])

  const updateElement = useCallback(
    (id: string, patch: Partial<CanvasElement>) => {
      commitCanvasTool('canvas.elements.patch', { updates: [{ id, patch }] }, 'user')
    },
    [commitCanvasTool],
  )

  const deleteSelection = useCallback(() => {
    if (!selectedIds.length) return
    const deletableIds = selectedIds.filter(
      (id) => !elementsRef.current.find((element) => element.id === id)?.locked,
    )
    if (!deletableIds.length) {
      showToast('请先解锁元件')
      return
    }
    commitCanvasTool('canvas.elements.remove', { ids: deletableIds }, 'user')
    setSelectedIds([])
  }, [commitCanvasTool, selectedIds, showToast])

  const duplicateSelection = useCallback(() => {
    if (!selectedIds.length) return
    const selected = elementsRef.current.filter(
      (element) => selectedIds.includes(element.id) && element.kind !== 'connector',
    )
    if (!selected.length) return
    const nextIds: string[] = []
    const maxZ = getMaxZ(elementsRef.current)
    const duplicates = selected.map((element, index) => {
        const id = makeId(element.kind)
        nextIds.push(id)
        return {
          ...element,
          id,
          name: `${element.name} 副本`,
          x: element.x + 28,
          y: element.y + 28,
          zIndex: maxZ + index + 1,
          locked: false,
          pixels: element.pixels ? [...element.pixels] : undefined,
          palette: element.palette ? [...element.palette] : undefined,
          adjustments: element.adjustments ? { ...element.adjustments } : undefined,
          crop: element.crop ? { ...element.crop } : undefined,
          processingStack: element.processingStack?.map((step) => ({ ...step })),
        }
      })
    commitCanvasTool('canvas.elements.add', { elements: duplicates }, 'user')
    setSelectedIds(nextIds)
  }, [commitCanvasTool, selectedIds])

  const toggleLock = useCallback(
    (id: string) => {
      const element = elementsRef.current.find((candidate) => candidate.id === id)
      if (element) commitCanvasTool('canvas.elements.patch', {
        updates: [{ id, patch: { locked: !element.locked } }],
      }, 'user')
    },
    [commitCanvasTool],
  )

  const toggleVisible = useCallback(
    (id: string) => {
      const element = elementsRef.current.find((candidate) => candidate.id === id)
      if (element) commitCanvasTool('canvas.elements.patch', {
        updates: [{ id, patch: { visible: !element.visible } }],
      }, 'user')
    },
    [commitCanvasTool],
  )

  const bringToFront = useCallback(
    (id: string) => {
      commitCanvasTool('canvas.elements.patch', {
        updates: [{ id, patch: { zIndex: getMaxZ(elementsRef.current) + 1 } }],
      }, 'user')
    },
    [commitCanvasTool],
  )

  const getViewportCenter = useCallback(() => {
    const viewport = viewportRef.current
    const width = viewport?.clientWidth ?? 900
    const height = viewport?.clientHeight ?? 700
    return {
      x: (width / 2 - camera.x) / camera.zoom,
      y: (height / 2 - camera.y) / camera.zoom,
    }
  }, [camera])

  const createAt = useCallback(
    (tool: ToolId, point: { x: number; y: number }, content?: string) => {
      if (tool === 'select' || tool === 'pan' || tool === 'image') return
      const zIndex = getMaxZ(elementsRef.current) + 1
      const id = makeId(tool)
      let element: CanvasElement
      if (tool === 'frame') {
        element = {
          id,
          kind: 'frame',
          name: '新画框',
          x: point.x - 180,
          y: point.y - 130,
          width: 360,
          height: 260,
          rotation: 0,
          opacity: 1,
          radius: 8,
          fill: '#ffffff',
          stroke: '#aeb4c0',
          locked: false,
          visible: true,
          zIndex,
        }
      } else if (tool === 'text') {
        element = {
          id,
          kind: 'text',
          name: '文字',
          x: point.x - 100,
          y: point.y - 32,
          width: 200,
          height: 64,
          rotation: 0,
          opacity: 1,
          radius: 0,
          fill: '#17181c',
          stroke: 'transparent',
          content: content || '输入一段文字',
          locked: false,
          visible: true,
          zIndex,
        }
      } else if (tool === 'note') {
        element = {
          id,
          kind: 'note',
          name: '便签',
          x: point.x - 105,
          y: point.y - 85,
          width: 210,
          height: 170,
          rotation: -1,
          opacity: 1,
          radius: 0,
          fill: '#cbb7ff',
          stroke: '#cbb7ff',
          content: content || '写下一个新想法',
          locked: false,
          visible: true,
          zIndex,
        }
      } else if (tool === 'shape') {
        element = {
          id,
          kind: 'shape',
          name: '圆角形状',
          x: point.x - 70,
          y: point.y - 70,
          width: 140,
          height: 140,
          rotation: 0,
          opacity: 1,
          radius: 24,
          fill: '#6465f1',
          stroke: '#4e4fce',
          locked: false,
          visible: true,
          zIndex,
        }
      } else {
        element = {
          id,
          kind: 'pixel',
          name: '像素角色',
          x: point.x - 110,
          y: point.y - 110,
          width: 220,
          height: 220,
          rotation: 0,
          opacity: 1,
          radius: 10,
          fill: '#ffffff',
          stroke: '#d5d8df',
          pixels: [...defaultSpritePixels],
          palette: [...defaultPixelPalette],
          pixelWidth: 12,
          pixelHeight: 12,
          locked: false,
          visible: true,
          zIndex,
        }
      }
      commitCanvasTool('canvas.elements.add', { elements: [element] }, 'user')
      setSelectedIds([id])
      setActiveTool('select')
    },
    [commitCanvasTool],
  )

  const addImageFile = useCallback(
    (file: File, point: { x: number; y: number }) => {
      if (!file.type.startsWith('image/')) {
        showToast('请选择图片文件')
        return
      }
      const reader = new FileReader()
      reader.onload = () => {
        const src = String(reader.result)
        const image = new Image()
        image.onload = () => {
          const maxWidth = 360
          const scale = Math.min(1, maxWidth / image.naturalWidth)
          const width = Math.max(120, image.naturalWidth * scale)
          const height = Math.max(90, image.naturalHeight * scale)
          const id = makeId('image')
          const element: CanvasElement = {
            id,
            kind: 'image',
            name: file.name.replace(/\.[^.]+$/, '') || '导入图片',
            x: point.x - width / 2,
            y: point.y - height / 2,
            width,
            height,
            rotation: 0,
            opacity: 1,
            radius: 8,
            fill: '#ffffff',
            stroke: '#d5d8df',
            src,
            sourceSrc: src,
            naturalWidth: image.naturalWidth,
            naturalHeight: image.naturalHeight,
            assetId: makeId('asset'),
            assetVersion: 1,
            adjustments: { brightness: 100, contrast: 100, saturation: 100 },
            processingStack: [],
            locked: false,
            visible: true,
            zIndex: getMaxZ(elementsRef.current) + 1,
          }
          commitCanvasTool('canvas.elements.add', { elements: [element] }, 'user')
          setSelectedIds([id])
          setActiveTool('select')
          showToast('图片已添加到画布')
        }
        image.src = src
      }
      reader.readAsDataURL(file)
    },
    [commitCanvasTool, showToast],
  )

  const handleToolSelect = useCallback(
    (tool: ToolId) => {
      if (tool === 'image') {
        fileInputRef.current?.click()
        return
      }
      setActiveTool(tool)
    },
    [],
  )

  const exportProject = useCallback(async () => {
    try {
      await saveLocalProject(documentRef.current).catch(() => null)
      const blob = await downloadLocalProjectPackage(documentRef.current.id)
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${documentRef.current.id}.miaohui`
      anchor.click()
      URL.revokeObjectURL(url)
      showToast('完整项目包已导出')
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : '项目包导出失败')
    }
  }, [showToast])

  const importProject = useCallback(async (file: File) => {
    try {
      const stored = await importLocalProjectPackage(file, documentRef.current.id)
      const restored = assertCanvasDocument(stored.document)
      pastRef.current = []
      futureRef.current = []
      syncHistoryCounts()
      localStorage.setItem(APP_STORAGE_KEY, JSON.stringify(restored))
      lastPersistedRevisionRef.current = restored.revision
      persistenceReadyRef.current = true
      replaceDocument(restored)
      setSelectedIds([])
      setActiveTool('select')
      showToast('项目包已校验并导入')
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : '项目包导入失败')
    }
  }, [replaceDocument, showToast, syncHistoryCounts])

  const shareProject = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href)
      showToast('画布链接已复制')
    } catch {
      showToast('当前浏览器未允许复制，请手动复制地址')
    }
  }, [showToast])

  const resetProject = useCallback(() => {
    if (!window.confirm('恢复示例画布？当前本地更改会被替换。')) return
    commitCanvasTool('canvas.document.reset', {
      elements: cloneElements(seedElements),
      camera: { ...seedCamera },
    }, 'user')
    setSelectedIds(['image-summer-character'])
    setActiveTool('select')
    setJobs([])
    showToast('已恢复示例画布')
  }, [commitCanvasTool, showToast])

  const arrangeElements = useCallback(() => {
    const movable = elementsRef.current.filter((element) => element.kind !== 'connector' && !element.locked)
    const positions = new Map(
      movable.map((element, index) => [
        element.id,
        { x: 190 + (index % 3) * 320, y: 130 + Math.floor(index / 3) * 330 },
      ]),
    )
    const updates = movable.map((element) => ({ id: element.id, patch: positions.get(element.id)! }))
    if (updates.length) commitCanvasTool('canvas.elements.patch', { updates }, 'user')
    showToast('已整理可移动元件')
  }, [commitCanvasTool, showToast])

  const openImageTool = useCallback(
    (id: string, tool: ImageToolId) => {
      const element = elementsRef.current.find((item) => item.id === id)
      if (!element || element.kind !== 'image') {
        showToast('请先选择一张图片')
        return
      }
      if (tool === 'more') {
        showToast('更多处理器将通过统一能力注册表接入')
        return
      }
      setImageLab({ elementId: id, mode: tool })
    },
    [showToast],
  )

  const updateJob = useCallback((job: ProcessingJob) => {
    setJobs((current) => {
      const existing = current.findIndex((item) => item.id === job.id)
      if (existing === -1) return [job, ...current].slice(0, 30)
      const next = [...current]
      next[existing] = job
      return next
    })
  }, [])

  const replaceVideoJobs = useCallback((videoJobs: ProcessingJob[]) => {
    setJobs((current) => [
      ...videoJobs,
      ...current.filter((job) =>
        !videoJobs.some((remoteJob) => remoteJob.id === job.id) && job.kind !== 'video',
      ),
    ].sort((a, b) => b.createdAt - a.createdAt).slice(0, 60))
  }, [])

  const refreshRuntime = useCallback(async () => {
    setRuntimeLoading(true)
    try {
      setRuntime(await fetchRuntimeStatus(true))
    } catch (reason) {
      setRuntime({
        connected: false,
        ready: false,
        queueRunning: 0,
        queuePending: 0,
        message: reason instanceof Error ? reason.message : '本地桥接服务未启动',
      })
    } finally {
      setRuntimeLoading(false)
    }
  }, [])

  useEffect(() => {
    let disposed = false
    let unsubscribe = () => {}
    const initializeLocalBridge = async () => {
      try {
        await ensureLocalSession()
        if (disposed) return
        try {
          const stored = await loadLocalProject(documentRef.current.id)
          if (disposed) return
          if (stored && stored.revision >= documentRef.current.revision) {
            const restored = assertCanvasDocument(stored.document)
            pastRef.current = []
            futureRef.current = []
            syncHistoryCounts()
            localStorage.setItem(APP_STORAGE_KEY, JSON.stringify(restored))
            lastPersistedRevisionRef.current = restored.revision
            persistenceReadyRef.current = true
            replaceDocument(restored)
          }
        } catch {
          // First run has no SQLite project yet; the normal autosave creates it.
        }
        if (disposed) return
        const videoJobs = await fetchVideoJobs()
        if (!disposed) replaceVideoJobs(videoJobs)
        if (!disposed) await refreshRuntime()
        if (disposed) return
        const cleanup = await subscribeVideoJobs((event) => {
          if (disposed) return
          if (event.type === 'jobs.snapshot') {
            replaceVideoJobs(event.jobs)
          } else if (event.type === 'job.updated') {
            updateJob(event.job)
          } else if (event.type === 'jobs.cleared') {
            setJobs((current) => current.filter((job) => !event.ids.includes(job.id)))
          } else if (event.type === 'runtime.updated') {
            setRuntime(event.runtime)
          }
        }, setStreamConnected)
        if (disposed) cleanup()
        else unsubscribe = cleanup
      } catch {
        if (!disposed) setStreamConnected(false)
      }
    }
    void initializeLocalBridge()
    const runtimeTimer = window.setInterval(() => {
      void fetchRuntimeStatus()
        .then((status) => {
          if (!disposed) setRuntime(status)
        })
        .catch(() => {
          if (!disposed) setRuntime((current) => current ? { ...current, connected: false, ready: false } : current)
        })
    }, 8_000)
    return () => {
      disposed = true
      unsubscribe()
      window.clearInterval(runtimeTimer)
    }
  }, [refreshRuntime, replaceDocument, replaceVideoJobs, syncHistoryCounts, updateJob])

  useEffect(() => {
    const videoJobs = new Map(
      jobs.filter((job) => job.kind === 'video').map((job) => [job.id, job]),
    )
    let changed = false
    const nextElements = elementsRef.current.map((element) => {
      if (element.kind !== 'video' || !element.jobId) return element
      const job = videoJobs.get(element.jobId)
      if (!job) return element
      if (
        element.jobStatus === job.status &&
        element.jobPhase === job.phase &&
        element.jobProgress === job.progress &&
        element.jobDetail === job.detail &&
        element.videoSrc === job.outputUrl &&
        element.jobError?.code === job.error?.code
      ) return element
      changed = true
      return {
        ...element,
        jobStatus: job.status,
        jobPhase: job.phase,
        jobProgress: job.progress,
        jobDetail: job.detail,
        jobError: job.error,
        videoSrc: job.outputUrl ?? element.videoSrc,
        assetId: job.outputVersion?.logicalAssetId ?? element.assetId,
        assetVersion: job.outputVersion?.version ?? element.assetVersion,
        assetVersionId: job.outputVersion?.id ?? element.assetVersionId,
      }
    })
    if (changed) {
      commitCanvasTool('canvas.elements.replace', { elements: nextElements }, 'system', false)
    }

    for (const job of videoJobs.values()) {
      const previous = jobStatusRef.current.get(job.id)
      if (previous && !['completed', 'failed', 'cancelled'].includes(previous)) {
        if (job.status === 'completed') showToast('视频生成完成，结果已回填画布')
        if (job.status === 'failed') showToast(job.error?.title || '视频生成失败')
        if (job.status === 'cancelled') showToast('视频任务已取消')
      }
      jobStatusRef.current.set(job.id, job.status)
    }
  }, [commitCanvasTool, jobs, showToast])

  useEffect(() => {
    for (const element of elementsRef.current) {
      if (element.kind === 'image' && element.jobId) appliedImageJobIdsRef.current.add(element.jobId)
    }
    const completed = jobs.filter((job) =>
      job.kind === 'image' &&
      job.status === 'completed' &&
      Boolean(job.outputUrl) &&
      isImageJobOutput(job.output) &&
      !appliedImageJobIdsRef.current.has(job.id) &&
      !elementsRef.current.some((element) => element.jobId === job.id),
    )
    if (!completed.length) return

    const additions: CanvasElement[] = []
    let maxZ = getMaxZ(elementsRef.current)
    for (const job of completed) {
      const source = elementsRef.current.find((element) =>
        element.id === job.sourceElementId && element.kind === 'image',
      )
      if (!source || !isImageJobOutput(job.output) || !job.outputUrl) continue
      const operation = job.tool as ImageOperationId
      const operationLabel = imageOperationLabels[operation] ?? job.label
      const derivativeCount = elementsRef.current.filter(
        (element) => element.sourceElementId === source.id,
      ).length + additions.filter((element) => element.sourceElementId === source.id).length
      const aspect = job.output.width / job.output.height
      const width = aspect >= 1 ? 340 : Math.max(210, 340 * aspect)
      const height = aspect >= 1 ? 340 / aspect : 340
      const imageId = makeId('image')
      maxZ += 2
      additions.push(
        {
          id: makeId('connector'),
          kind: 'connector',
          name: '本机处理关联',
          x: 0,
          y: 0,
          width: 0,
          height: 0,
          rotation: 0,
          opacity: 1,
          radius: 0,
          fill: 'transparent',
          stroke: '#6558d9',
          strokeWidth: 2,
          fromId: source.id,
          toId: imageId,
          jobId: job.id,
          locked: true,
          visible: true,
          zIndex: maxZ - 1,
        },
        {
          id: imageId,
          kind: 'image',
          name: `${source.name} · ${operationLabel}`,
          x: source.x + source.width + 190,
          y: source.y + derivativeCount * 34,
          width,
          height,
          rotation: 0,
          opacity: 1,
          radius: 8,
          fill: '#ffffff',
          stroke: '#d5d8df',
          strokeWidth: 1,
          src: job.outputUrl,
          sourceSrc: source.src,
          naturalWidth: job.output.width,
          naturalHeight: job.output.height,
          assetId: job.outputVersion?.logicalAssetId ?? job.output.filename,
          assetVersion: job.outputVersion?.version ?? 1,
          assetVersionId: job.outputVersion?.id,
          sourceElementId: source.id,
          jobId: job.id,
          adjustments: { brightness: 100, contrast: 100, saturation: 100 },
          processingStack: [{
            id: makeId('step'),
            type: operation,
            label: operationLabel,
            detail: `${job.output.width} × ${job.output.height} · ${job.output.provider}`,
            enabled: true,
            createdAt: job.completedAt ?? Date.now(),
            outputSrc: job.outputUrl,
          }],
          locked: false,
          visible: true,
          zIndex: maxZ,
        },
      )
      appliedImageJobIdsRef.current.add(job.id)
    }
    if (!additions.length) return
    commitElements((current) => [...current, ...additions], 'system', false)
    showToast(`${additions.length / 2} 个图像处理结果已作为派生版本加入画布`)
  }, [commitElements, jobs, showToast])

  const addVideoPlaceholder = useCallback(
    (job: ProcessingJob, request: VideoJobRequest, source?: CanvasElement) => {
      const dimensions = VIDEO_DIMENSIONS[request.aspectRatio]
      const scale = Math.min(410 / dimensions.width, 350 / dimensions.height)
      const width = Math.round(dimensions.width * scale)
      const height = Math.round(dimensions.height * scale)
      const center = getViewportCenter()
      const videoId = makeId('video')
      const maxZ = getMaxZ(elementsRef.current)
      const videoNode: CanvasElement = {
        id: videoId,
        kind: 'video',
        name: `${job.label} · ${request.aspectRatio}`,
        x: source ? source.x + source.width + 180 : center.x - width / 2,
        y: source ? source.y : center.y - height / 2,
        width,
        height,
        rotation: 0,
        opacity: 1,
        radius: 10,
        fill: '#11131a',
        stroke: '#cfd2db',
        strokeWidth: 1,
        posterSrc: source?.src,
        sourceElementId: source?.id,
        jobId: job.id,
        jobStatus: job.status,
        jobPhase: job.phase,
        jobProgress: job.progress,
        jobDetail: job.detail,
        locked: false,
        visible: true,
        zIndex: maxZ + 1,
      }
      const additions: CanvasElement[] = [videoNode]
      if (source) {
        additions.unshift({
          id: makeId('connector'),
          kind: 'connector',
          name: '视频生成关联',
          x: 0,
          y: 0,
          width: 0,
          height: 0,
          rotation: 0,
          opacity: 1,
          radius: 0,
          fill: 'transparent',
          stroke: '#6558d9',
          strokeWidth: 2,
          fromId: source.id,
          toId: videoId,
          locked: true,
          visible: true,
          zIndex: maxZ,
        })
      }
      commitElements((current) => [...current, ...additions])
      if (!source) setSelectedIds([videoId])
    },
    [commitElements, getViewportCenter],
  )

  const submitVideo = useCallback(async (request: VideoJobRequest) => {
    setVideoSubmitting(true)
    setVideoSubmitError(null)
    try {
      const source = request.mode === 'image-to-video'
        ? elementsRef.current.find((element) => element.id === request.sourceElementId && element.kind === 'image')
        : undefined
      if (request.mode === 'image-to-video' && (!source || !source.src)) {
        throw new Error('请先在画布中选择一张图片')
      }
      const sourceImageDataUrl = source?.src
        ? await normalizeVideoFirstFrame(source.src, request.aspectRatio)
        : undefined
      const lastFrameImageDataUrl = request.lastFrameImageDataUrl
        ? await normalizeVideoFirstFrame(request.lastFrameImageDataUrl, request.aspectRatio)
        : undefined
      const job = await createVideoJob({ ...request, sourceImageDataUrl, lastFrameImageDataUrl })
      updateJob(job)
      addVideoPlaceholder(job, request, source)
      showToast('视频任务已提交到本机 ComfyUI')
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '视频任务提交失败'
      setVideoSubmitError(message)
      showToast(message)
    } finally {
      setVideoSubmitting(false)
    }
  }, [addVideoPlaceholder, showToast, updateJob])

  const changeRuntimePolicy = useCallback(async (
    policy: NonNullable<RuntimeStatus['lifecycle']>['policy'],
    idleSeconds: number,
  ) => {
    try {
      setRuntime(await updateRuntimePolicy(policy, idleSeconds))
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : '运行时策略更新失败')
    }
  }, [showToast])

  const startComfyRuntime = useCallback(async () => {
    setRuntimeLoading(true)
    try {
      setRuntime(await startRuntime())
      showToast('ComfyUI 已就绪')
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : 'ComfyUI 启动失败')
    } finally {
      setRuntimeLoading(false)
    }
  }, [showToast])

  const stopComfyRuntime = useCallback(async () => {
    setRuntimeLoading(true)
    try {
      setRuntime(await stopRuntime())
      showToast('ComfyUI 已关闭')
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : 'ComfyUI 关闭失败')
    } finally {
      setRuntimeLoading(false)
    }
  }, [showToast])

  const cancelJob = useCallback(async (jobId: string) => {
    try {
      updateJob(await cancelVideoJob(jobId))
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : '取消任务失败')
    }
  }, [showToast, updateJob])

  const retryJob = useCallback(async (jobId: string) => {
    try {
      const retried = await retryVideoJob(jobId)
      updateJob(retried)
      let reused = false
      commitElements((current) => current.map((element) => {
        if (element.kind !== 'video' || element.jobId !== jobId) return element
        reused = true
        return {
          ...element,
          jobId: retried.id,
          jobStatus: retried.status,
          jobPhase: retried.phase,
          jobProgress: retried.progress,
          jobDetail: retried.detail,
          jobError: undefined,
          videoSrc: undefined,
        }
      }))
      if (!reused && retried.kind === 'video' && retried.request && 'mode' in retried.request) {
        addVideoPlaceholder(retried, retried.request)
      }
      showToast(retried.kind === 'image' ? '图像任务已重新提交' : '已使用快速预设重新提交')
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : '重试任务失败')
    }
  }, [addVideoPlaceholder, commitElements, showToast, updateJob])

  const clearJobs = useCallback(async () => {
    try {
      await clearFinishedJobs()
    } catch {
      // The local image jobs can still be cleared while the bridge is offline.
    }
    setJobs((current) => current.filter((job) => job.status === 'running' || job.status === 'queued'))
  }, [])

  const applyImageLabResult = useCallback(
    (result: ImageLabResult) => {
      if (!imageLab) return
      const source = elementsRef.current.find((element) => element.id === imageLab.elementId)
      if (!source || source.kind !== 'image') {
        setImageLab(null)
        return
      }

      const createdAt = Date.now()
      const step: ProcessingStep = {
        id: makeId('step'),
        type: imageLab.mode,
        label: processingLabels[imageLab.mode],
        detail: result.detail,
        enabled: true,
        createdAt,
        outputSrc: result.kind === 'derived-image' ? result.src : undefined,
        maskRecipe: result.kind === 'derived-image' ? result.maskRecipe : undefined,
      }

      if (result.kind === 'adjust') {
        commitElements((current) =>
          current.map((element) =>
            element.id === source.id
              ? {
                  ...element,
                  adjustments: { ...result.adjustments },
                  processingStack: [
                    ...(element.processingStack ?? []).filter((item) => item.type !== 'adjust'),
                    step,
                  ],
                }
              : element,
          ),
        )
        setSelectedIds([source.id])
        showToast('色彩调整已作为非破坏步骤应用')
      } else if (result.kind === 'pixel') {
        const existingDerivatives = elementsRef.current.filter(
          (element) => element.sourceElementId === source.id,
        ).length
        const pixelId = makeId('pixel')
        const connectorId = makeId('connector')
        const maxZ = getMaxZ(elementsRef.current)
        const pixelNode: CanvasElement = {
          id: pixelId,
          kind: 'pixel',
          name: `${source.name} · ${result.draft.width}px`,
          x: source.x + source.width + 190,
          y: source.y + 30 + existingDerivatives * 28,
          width: 294,
          height: 316,
          rotation: 0,
          opacity: 1,
          radius: 10,
          fill: '#ffffff',
          stroke: '#d5d8df',
          strokeWidth: 1,
          pixels: [...result.draft.pixels],
          palette: [...result.draft.palette],
          pixelWidth: result.draft.width,
          pixelHeight: result.draft.height,
          sourceElementId: source.id,
          locked: false,
          visible: true,
          zIndex: maxZ + 1,
        }
        const connector: CanvasElement = {
          id: connectorId,
          kind: 'connector',
          name: '处理关联',
          x: 0,
          y: 0,
          width: 0,
          height: 0,
          rotation: 0,
          opacity: 1,
          radius: 0,
          fill: 'transparent',
          stroke: '#545760',
          strokeWidth: 2,
          fromId: source.id,
          toId: pixelId,
          locked: true,
          visible: true,
          zIndex: maxZ,
        }
        commitElements((current) => [...current, connector, pixelNode])
        setSelectedIds([pixelId])
        showToast(`${result.draft.width} × ${result.draft.height} 像素草稿已添加`)
      } else {
        const existingDerivatives = elementsRef.current.filter(
          (element) => element.sourceElementId === source.id,
        ).length
        const imageId = makeId('image')
        const connectorId = makeId('connector')
        const maxZ = getMaxZ(elementsRef.current)
        const aspect = result.width > 0 && result.height > 0
          ? result.width / result.height
          : source.width / source.height
        const displayWidth = aspect >= 1 ? 340 : Math.max(220, 340 * aspect)
        const displayHeight = aspect >= 1 ? 340 / aspect : 340
        const derived: CanvasElement = {
          id: imageId,
          kind: 'image',
          name: `${source.name} · ${processingLabels[result.mode]}`,
          x: source.x + source.width + 190,
          y: source.y + existingDerivatives * 32,
          width: displayWidth,
          height: displayHeight,
          rotation: 0,
          opacity: 1,
          radius: 8,
          fill: '#ffffff',
          stroke: '#d5d8df',
          strokeWidth: 1,
          src: result.src,
          sourceSrc: source.src,
          naturalWidth: result.width,
          naturalHeight: result.height,
          assetId: makeId('asset'),
          assetVersion: (source.assetVersion ?? 1) + 1,
          sourceElementId: source.id,
          adjustments: { brightness: 100, contrast: 100, saturation: 100 },
          processingStack: [step],
          locked: false,
          visible: true,
          zIndex: maxZ + 1,
        }
        const connector: CanvasElement = {
          id: connectorId,
          kind: 'connector',
          name: '处理关联',
          x: 0,
          y: 0,
          width: 0,
          height: 0,
          rotation: 0,
          opacity: 1,
          radius: 0,
          fill: 'transparent',
          stroke: '#545760',
          strokeWidth: 2,
          fromId: source.id,
          toId: imageId,
          locked: true,
          visible: true,
          zIndex: maxZ,
        }
        commitElements((current) => [...current, connector, derived])
        setSelectedIds([imageId])
        showToast(`${processingLabels[result.mode]}结果已作为新版本添加`)
      }

      setImageLab(null)
    },
    [commitElements, imageLab, showToast],
  )

  const runPrompt = useCallback(
    (prompt: string) => {
      const center = getViewportCenter()
      const selectedImage = elementsRef.current.find(
        (element) => element.id === selectedIds[0] && element.kind === 'image',
      )
      if (/排列|整理|对齐/.test(prompt)) {
        arrangeElements()
      } else if (/去背景|抠图|移除背景/.test(prompt) && selectedImage) {
        openImageTool(selectedImage.id, 'remove-background')
      } else if (/裁剪|画幅/.test(prompt) && selectedImage) {
        openImageTool(selectedImage.id, 'crop')
      } else if (/放大|超分|高清/.test(prompt) && selectedImage) {
        openImageTool(selectedImage.id, 'upscale')
      } else if (/调整|亮度|对比度|饱和度/.test(prompt) && selectedImage) {
        openImageTool(selectedImage.id, 'adjust')
      } else if (/像素/.test(prompt) && selectedImage) {
        openImageTool(selectedImage.id, 'pixelate')
      } else if (/像素/.test(prompt)) {
        createAt('pixel', center)
        showToast('已创建像素角色，可双击编辑')
      } else if (/文字|标题/.test(prompt)) {
        createAt('text', center, prompt.replace(/添加|创建|文字|标题/g, '').trim() || '新的文字')
      } else if (/形状|方块|圆形|圆/.test(prompt)) {
        createAt('shape', center)
      } else {
        const noteContent = prompt.replace(/添加|创建|一张|紫色|便签/g, '').trim() || '新的想法'
        createAt('note', center, noteContent)
        showToast('已将指令变成便签')
      }
    },
    [arrangeElements, createAt, getViewportCenter, openImageTool, selectedIds, showToast],
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      const editing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target.isContentEditable
      if (editing || pixelEditorId || imageLab) return

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        redo()
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') {
        event.preventDefault()
        duplicateSelection()
        return
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        deleteSelection()
        return
      }
      if (event.key === 'Escape') {
        setActiveTool('select')
        setSelectedIds([])
        return
      }
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) && selectedIds.length) {
        event.preventDefault()
        const amount = event.shiftKey ? 10 : 1
        const delta = {
          x: event.key === 'ArrowLeft' ? -amount : event.key === 'ArrowRight' ? amount : 0,
          y: event.key === 'ArrowUp' ? -amount : event.key === 'ArrowDown' ? amount : 0,
        }
        const updates = elementsRef.current
          .filter((element) => selectedIds.includes(element.id) && !element.locked)
          .map((element) => ({
            id: element.id,
            patch: { x: element.x + delta.x, y: element.y + delta.y },
          }))
        if (updates.length) commitCanvasTool('canvas.elements.patch', { updates }, 'user')
        return
      }
      const shortcut: Record<string, ToolId> = {
        v: 'select',
        f: 'frame',
        t: 'text',
        n: 'note',
        s: 'shape',
        p: 'pixel',
      }
      if (!event.ctrlKey && !event.metaKey && shortcut[event.key.toLowerCase()]) {
        setActiveTool(shortcut[event.key.toLowerCase()])
      }
      if (!event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'i') {
        fileInputRef.current?.click()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [commitCanvasTool, deleteSelection, duplicateSelection, imageLab, pixelEditorId, redo, selectedIds, undo])

  const editingPixel = elements.find((element) => element.id === pixelEditorId)
  const editingImage = elements.find((element) => element.id === imageLab?.elementId)

  return (
    <div className="app-shell">
      <TopBar
        canUndo={historyCounts.past > 0}
        canRedo={historyCounts.future > 0}
        onUndo={undo}
        onRedo={redo}
        onShare={shareProject}
        onExport={exportProject}
        onImport={() => projectInputRef.current?.click()}
        onReset={resetProject}
        onToggleInspector={() => setInspectorOpen((open) => !open)}
        saveStatus={saveStatus}
      />

      <main className="workspace-shell">
        <ToolRail activeTool={activeTool} onSelect={handleToolSelect} />
        <section className="canvas-area" aria-label="无限画布">
          <CanvasWorkspace
            elements={elements}
            selectedIds={selectedIds}
            camera={camera}
            activeTool={activeTool}
            viewportRef={viewportRef}
            onSelect={setSelectedIds}
            onElementsPreview={previewElements}
            onTransformCommit={recordSnapshot}
            onCameraChange={previewCamera}
            onToolChange={setActiveTool}
            onCreateAt={createAt}
            onDeleteSelection={deleteSelection}
            onDuplicateSelection={duplicateSelection}
            onToggleLock={toggleLock}
            onBringToFront={bringToFront}
            onOpenPixel={setPixelEditorId}
            onImageDrop={addImageFile}
          />
          <PromptBar onSubmit={runPrompt} />
        </section>

        <div className={`inspector-drawer ${inspectorOpen ? 'is-open' : ''}`}>
          <Inspector
            elements={elements}
            selectedIds={selectedIds}
            jobs={jobs}
            runtime={runtime}
            runtimeLoading={runtimeLoading}
            streamConnected={streamConnected}
            videoSubmitting={videoSubmitting}
            videoSubmitError={videoSubmitError}
            onSelect={(id) => setSelectedIds([id])}
            onUpdate={updateElement}
            onToggleVisible={toggleVisible}
            onToggleLock={toggleLock}
            onOpenPixel={setPixelEditorId}
            onOpenImageTool={openImageTool}
            onClearJobs={clearJobs}
            onRefreshRuntime={refreshRuntime}
            onStartRuntime={startComfyRuntime}
            onStopRuntime={stopComfyRuntime}
            onRuntimePolicyChange={changeRuntimePolicy}
            onSubmitVideo={submitVideo}
            onCancelJob={cancelJob}
            onRetryJob={retryJob}
          />
        </div>
        {inspectorOpen ? (
          <button
            type="button"
            className="drawer-backdrop"
            aria-label="关闭属性面板"
            onClick={() => setInspectorOpen(false)}
          />
        ) : null}
      </main>

      <input
        ref={fileInputRef}
        className="visually-hidden"
        type="file"
        accept="image/*"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) addImageFile(file, getViewportCenter())
          event.target.value = ''
        }}
      />

      <input
        ref={projectInputRef}
        className="visually-hidden"
        type="file"
        accept=".miaohui,application/vnd.miaohui.project"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void importProject(file)
          event.target.value = ''
        }}
      />

      {editingPixel && editingPixel.kind === 'pixel' ? (
        <PixelEditor
          element={editingPixel}
          onClose={() => setPixelEditorId(null)}
          onSave={(pixels) => {
            updateElement(editingPixel.id, { pixels })
            setPixelEditorId(null)
            showToast('像素画已更新')
          }}
        />
      ) : null}

      {editingImage && editingImage.kind === 'image' && imageLab ? (
        <ImageLab
          element={editingImage}
          initialMode={imageLab.mode}
          onClose={() => setImageLab(null)}
          onApply={applyImageLabResult}
          onJobUpdate={updateJob}
        />
      ) : null}

      {toast ? (
        <div className="toast" role="status">
          <CheckCircle2 size={17} />
          <span>{toast}</span>
          <button type="button" aria-label="关闭提示" onClick={() => setToast(null)}>
            <X size={15} />
          </button>
        </div>
      ) : null}
    </div>
  )
}

export default App
