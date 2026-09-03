import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowLeft as ArrowLeftSmall,
  ClipboardCopy,
  ClipboardPaste,
  Copy,
  Compass,
  Crosshair,
  Download,
  Eraser,
  Eye,
  EyeOff,
  FileImage,
  Film,
  FlipHorizontal2,
  FlipVertical2,
  FolderOpen,
  Grid3X3,
  Layers,
  Lock,
  Minus,
  Move,
  PaintBucket,
  Pause,
  Pencil,
  Pipette,
  Play,
  Plus,
  PackageOpen,
  Redo2,
  Settings2,
  Scissors,
  Square,
  SquareDashedMousePointer,
  Sparkles,
  Trash2,
  Undo2,
  Unlock,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  PixelContractError,
  PIXEL_ANIMATION_EVENT_TYPES,
  PIXEL_BLEND_MODES,
  PIXEL_COLLISION_TYPES,
  PIXEL_LIMITS,
  PIXEL_PALETTE_CYCLE_DIRECTIONS,
  PIXEL_PROJECT_EXTENSION,
  PIXEL_PROJECT_MIME,
  PIXEL_TERRAIN_GRID_PRESETS,
  PIXEL_TILE_NEIGHBORS,
  applyPixelCommand,
  convertRgbaToPixelDocument,
  createBlankPixelArray,
  createDefaultPixelFrameGameplay,
  createPixelExportBundle,
  createPixelAnimationClipExportBundle,
  createPixelEngineBridgeExportBundle,
  createPixelGameExportBundle,
  createPixelSelectionClipboard,
  createPixelSelectionPastePatch,
  createPixelTerrainPreviewExportBundle,
  createPixelTerrainMapExportBundle,
  createPixelCommand,
  createPixelDocument,
  createSpriteSheetMetadata,
  createSelectionPatch,
  createSmartPixelCleanupPatch,
  expandPixelBrush,
  floodFillPixels,
  migratePixelDocument,
  normalizePixelRect,
  rasterPixelLine,
  rasterPixelRectangle,
  renderPixelFrameRgba,
  renderPixelTerrainPreviewRgba,
  renderPixelTerrainMapRgba,
  resolvePixelAnimationFrames,
  safePixelFilename,
  serializePixelProject,
  type PixelCommand,
  type PixelCommandType,
  type PixelAnimationDirection,
  type PixelAnimationEventType,
  type PixelBlendMode,
  type PixelCollisionShape,
  type PixelCollisionType,
  type PixelConversionReport,
  type PixelDitherMode,
  type PixelDocument,
  type PixelFitMode,
  type PixelFrameGameplay,
  type PixelPoint,
  type PixelPaletteCycleDirection,
  type PixelRect,
  type PixelSelectionClipboard,
  type PixelSelectionPasteMode,
  type PixelTerrainPreviewLayout,
  type PixelTerrainMapLayout,
  type RgbaImage,
  type SpriteSheetMetadata,
} from '../../lib/pixel/index'
import type { LibraryAssetInsertion } from '../../lib/libraryApi'
import { AgentPlanComposer } from '../../components/AgentPlanComposer'
import { AgentPlanReviewDialog } from '../../components/AgentPlanReviewDialog'
import {
  approveCreativePlan,
  createCreativePlan,
  executeApprovedCreativePlan,
  previewCreativePlan,
  type CreativePlan,
  type CreativePlanPreview,
  type CreativePlanReceipt,
} from '../../lib/agent/creativePlan.mjs'
import {
  commitWorkspaceCreativePlan,
  flushWorkspaceModeDocument,
  listWorkspaceCreativePlanReceipts,
} from '../../lib/projectApi'
import {
  PixelBrowserError,
  decodePixelImageFile,
  downloadPixelExportBundle,
  downloadPixelAnimationClipExportBundle,
  downloadPixelEngineBridgeExportBundle,
  downloadPixelGameExportBundle,
  downloadPixelTerrainPreviewExportBundle,
  downloadPixelTerrainMapExportBundle,
  downloadPixelText,
  readPixelProjectFile,
} from './pixelBrowser'
import './pixel-mode.css'

type PixelTool = 'pencil' | 'eraser' | 'fill' | 'picker' | 'line' | 'rectangle' | 'marquee'

const PIXEL_BLEND_LABELS: Record<PixelBlendMode, string> = {
  normal: '正常',
  multiply: '正片叠底',
  screen: '滤色',
  add: '线性加亮',
}

const PIXEL_COLLISION_LABELS: Record<PixelCollisionType, string> = {
  solid: '实体',
  hitbox: '攻击区',
  hurtbox: '受击区',
  interaction: '交互区',
}

const PIXEL_COLLISION_COLORS: Record<PixelCollisionType, string> = {
  solid: '#FFB020',
  hitbox: '#FF4D6D',
  hurtbox: '#4CC9F0',
  interaction: '#32B884',
}

const PIXEL_CYCLE_DIRECTION_LABELS: Record<PixelPaletteCycleDirection, string> = {
  forward: '正向轮换',
  reverse: '反向轮换',
  'ping-pong': '往返轮换',
}

const PIXEL_EVENT_TYPE_LABELS: Record<PixelAnimationEventType, string> = {
  marker: '标记',
  sfx: '音效',
  hit: '命中',
  custom: '自定义',
}

const PIXEL_TILE_GRID = [
  'north-west', 'north', 'north-east',
  'west', 'center', 'east',
  'south-west', 'south', 'south-east',
] as const

const PIXEL_TERRAIN_CELL_LABELS = ['西北', '北', '东北', '西', '本格', '东', '西南', '南', '东南'] as const

type HistoryState = {
  document: PixelDocument
  undo: PixelCommand[]
  redo: PixelCommand[]
}

type PixelStrokeContext = {
  baseRevision: number
  frameId: string
  layerId: string
  tool: 'pencil' | 'eraser'
  colorId: string
  previewColor: string
  layerOpacity: number
  brushSize: number
  mirrorHorizontal: boolean
  mirrorVertical: boolean
}

type TerrainPreviewRender = {
  pixels: Uint8ClampedArray
  width: number
  height: number
  layout: PixelTerrainPreviewLayout
}

type TerrainMapRender = {
  pixels: Uint8ClampedArray
  width: number
  height: number
  layout: PixelTerrainMapLayout
}

type TerrainMapStrokeContext = {
  pointerId: number
  terrainMapId: string
  width: number
  height: number
  terrainId: string | null
  original: Array<string | null>
  draft: Array<string | null>
  last: PixelPoint
}

type PixelDragContext = {
  baseRevision: number
  frameId: string
  layerId: string
  tool: 'line' | 'rectangle' | 'marquee'
  colorId: string
  start: PixelPoint
  current: PixelPoint
}

type PixelImportSettings = {
  targetWidth: number
  targetHeight: number
  colorCount: number
  dither: PixelDitherMode
  fit: PixelFitMode
  paletteMode: 'generated' | 'current'
  alphaThreshold: number
}

type ImportedSource = RgbaImage & {
  sourceName: string
}

export type PixelSpriteSheetPayload = {
  document: PixelDocument
  metadata: SpriteSheetMetadata
  pixels: Uint8ClampedArray
}

export type PixelModeWorkbenchProps = {
  initialDocument?: PixelDocument
  projectId?: string
  workspaceProjectId?: string
  projectName?: string
  className?: string
  onBack?: () => void
  onDocumentChange?: (document: PixelDocument) => void
  onSpriteSheetReady?: (payload: PixelSpriteSheetPayload) => void | Promise<void>
  libraryAsset?: LibraryAssetInsertion
  onLibraryAssetConsumed?: (nonce: number) => void
}

export function createDefaultPixelProject(input: { id?: string; name?: string } = {}) {
  const base = createPixelDocument({
    id: input.id ?? 'aeonquill-pixel-starter',
    name: input.name ?? '光羽练习',
    width: 16,
    height: 16,
  })
  const layers = [
    { id: 'silhouette', name: '轮廓', visible: true, locked: false, opacity: 1, groupId: null, blendMode: 'normal' as const },
    { id: 'light', name: '流光', visible: true, locked: false, opacity: 1, groupId: null, blendMode: 'normal' as const },
  ]
  const frameCoordinates = [
    [[3, 12], [4, 11], [5, 10], [6, 9], [7, 8], [8, 7], [9, 6], [10, 5], [11, 4], [12, 3]],
    [[3, 11], [4, 10], [5, 9], [6, 8], [7, 7], [8, 6], [9, 5], [10, 4], [11, 4], [12, 3]],
    [[3, 10], [4, 9], [5, 8], [6, 7], [7, 6], [8, 5], [9, 4], [10, 4], [11, 3], [12, 3]],
  ]
  const frames = frameCoordinates.map((coordinates, frameIndex) => {
    const silhouette = createBlankPixelArray(16, 16)
    const light = createBlankPixelArray(16, 16)
    for (const [index, [x, y]] of coordinates.entries()) {
      silhouette[y * 16 + x] = index % 3 === 0 ? 'violet' : 'ink'
      if (index > 2 && index < 8) light[(y - 1) * 16 + x] = index % 2 === 0 ? 'ember' : 'aether'
    }
    light[(12 - frameIndex) * 16 + 2] = 'ember'
    light[(13 - frameIndex) * 16 + 1] = 'paper'
    return {
      id: `frame-${frameIndex + 1}`,
      name: `姿态 ${frameIndex + 1}`,
      durationMs: 140,
      gameplay: createDefaultPixelFrameGameplay(16, 16),
      cels: { silhouette, light },
    }
  })
  return createPixelDocument({
    id: base.id,
    name: base.name,
    width: base.width,
    height: base.height,
    palette: base.palette,
    layers,
    frames,
    animationTags: [{
      id: 'light-loop',
      name: '流光循环',
      fromFrameId: 'frame-1',
      toFrameId: 'frame-3',
      direction: 'ping-pong',
      loop: true,
    }],
    activeLayerId: 'light',
    activeFrameId: 'frame-1',
  })
}

function uniqueId(prefix: string, existing: string[], revision: number) {
  let suffix = revision + 1
  let candidate = `${prefix}-${suffix}`
  while (existing.includes(candidate)) {
    suffix += 1
    candidate = `${prefix}-${suffix}`
  }
  return candidate
}

function putRgbaOnCanvas(
  target: CanvasRenderingContext2D,
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  opacity = 1,
  tint?: [number, number, number],
) {
  const buffer = window.document.createElement('canvas')
  buffer.width = width
  buffer.height = height
  const bufferContext = buffer.getContext('2d')
  if (!bufferContext) return
  const pixels = tint ? new Uint8ClampedArray(rgba) : rgba
  if (tint) {
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3] === 0) continue
      pixels[index] = tint[0]
      pixels[index + 1] = tint[1]
      pixels[index + 2] = tint[2]
    }
  }
  const imageData = bufferContext.createImageData(width, height)
  imageData.data.set(pixels)
  bufferContext.putImageData(imageData, 0, 0)
  target.save()
  target.globalAlpha = opacity
  target.imageSmoothingEnabled = false
  target.drawImage(buffer, 0, 0)
  target.restore()
}

function sourceDocumentName(filename: string) {
  const withoutExtension = filename.replace(/\.(png|webp)$/i, '').trim()
  return withoutExtension.slice(0, 120) || 'Imported pixel art'
}

function readablePixelError(error: unknown, fallback: string) {
  if (error instanceof PixelContractError || error instanceof PixelBrowserError) return error.message
  return error instanceof Error ? error.message : fallback
}

function terrainPreviewColor(terrainId: string) {
  let hash = 0x811c9dc5
  for (const character of terrainId) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193)
  }
  return `hsl(${Math.abs(hash) % 360} 72% 58%)`
}

export function PixelModeWorkbench({
  initialDocument,
  projectId = 'aeonquill-pixel-starter',
  workspaceProjectId,
  projectName = '光羽练习',
  className = '',
  onBack,
  onDocumentChange,
  onSpriteSheetReady,
  libraryAsset,
  onLibraryAssetConsumed,
}: PixelModeWorkbenchProps) {
  const [history, setHistory] = useState<HistoryState>(() => ({
    document: initialDocument
      ? migratePixelDocument(initialDocument)
      : createDefaultPixelProject({ id: projectId, name: projectName }),
    undo: [],
    redo: [],
  }))
  const [tool, setTool] = useState<PixelTool>('pencil')
  const [brushSize, setBrushSize] = useState(1)
  const [mirrorHorizontal, setMirrorHorizontal] = useState(false)
  const [mirrorVertical, setMirrorVertical] = useState(false)
  const [gridVisible, setGridVisible] = useState(true)
  const [gameOverlayVisible, setGameOverlayVisible] = useState(true)
  const [zoom, setZoom] = useState(1)
  const [selection, setSelection] = useState<PixelRect | null>(null)
  const [selectionClipboard, setSelectionClipboard] = useState<PixelSelectionClipboard | null>(null)
  const [selectionPasteMode, setSelectionPasteMode] = useState<PixelSelectionPasteMode>('replace')
  const [dragDraft, setDragDraft] = useState<PixelDragContext | null>(null)
  const [activeColorId, setActiveColorId] = useState(() => history.document.palette[2]?.id ?? history.document.palette[0].id)
  const [status, setStatus] = useState('确定性编辑已就绪')
  const [agentPlanReview, setAgentPlanReview] = useState<{
    plan: CreativePlan
    preview: CreativePlanPreview
  } | null>(null)
  const [agentPlanBusy, setAgentPlanBusy] = useState(false)
  const [agentPlanError, setAgentPlanError] = useState<string | null>(null)
  const [latestAgentReceipt, setLatestAgentReceipt] = useState<CreativePlanReceipt | null>(null)
  const [importSettings, setImportSettings] = useState<PixelImportSettings>({
    targetWidth: 32,
    targetHeight: 32,
    colorCount: 8,
    dither: 'none',
    fit: 'contain',
    paletteMode: 'generated',
    alphaThreshold: 16,
  })
  const [importSourceSummary, setImportSourceSummary] = useState<{ name: string; width: number; height: number } | null>(null)
  const [lastConversion, setLastConversion] = useState<PixelConversionReport | null>(null)
  const [isImporting, setIsImporting] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [previewFrameCursor, setPreviewFrameCursor] = useState<number | null>(null)
  const [activeAnimationTagId, setActiveAnimationTagId] = useState<string | null>(
    () => history.document.animationTags[0]?.id ?? null,
  )
  const [activePaletteCycleId, setActivePaletteCycleId] = useState<string | null>(
    () => history.document.paletteCycles[0]?.id ?? null,
  )
  const [paletteCycleElapsedMs, setPaletteCycleElapsedMs] = useState(0)
  const [batchDurationMs, setBatchDurationMs] = useState('140')
  const [terrainOccupancy, setTerrainOccupancy] = useState<boolean[]>(
    () => [...(PIXEL_TERRAIN_GRID_PRESETS.find((preset) => preset.id === 'solid')?.occupancy ?? Array(9).fill(true))],
  )
  const [activeTerrainMapId, setActiveTerrainMapId] = useState<string | null>(
    () => history.document.terrainMaps[0]?.id ?? null,
  )
  const [terrainMapBrushMode, setTerrainMapBrushMode] = useState<'paint' | 'erase'>('paint')
  const [terrainMapPaintTerrainId, setTerrainMapPaintTerrainId] = useState<string>(
    () => history.document.frames.find((frame) => frame.gameplay.tileRule)?.gameplay.tileRule?.terrainId ?? '',
  )
  const [terrainMapDraftCells, setTerrainMapDraftCells] = useState<Array<string | null> | null>(null)
  const [terrainMapWidthInput, setTerrainMapWidthInput] = useState('8')
  const [terrainMapHeightInput, setTerrainMapHeightInput] = useState('8')
  const [strokePreviewRevision, setStrokePreviewRevision] = useState(0)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const terrainPreviewCanvasRef = useRef<HTMLCanvasElement>(null)
  const terrainMapCanvasRef = useRef<HTMLCanvasElement>(null)
  const terrainMapStrokeRef = useRef<TerrainMapStrokeContext | null>(null)
  const importedSourceRef = useRef<ImportedSource | null>(null)
  const paintingRef = useRef(false)
  const strokeContextRef = useRef<PixelStrokeContext | null>(null)
  const strokePointsRef = useRef(new Map<string, { x: number; y: number }>())
  const lastStrokePointRef = useRef<PixelPoint | null>(null)
  const dragContextRef = useRef<PixelDragContext | null>(null)
  const commandSequenceRef = useRef(1)
  const consumedLibraryAssetRef = useRef<number | null>(null)
  const document = history.document
  const historyRef = useRef(history)
  historyRef.current = history

  const replaceHistory = useCallback((next: HistoryState) => {
    historyRef.current = next
    setHistory(next)
  }, [])

  const stopPlayback = useCallback(() => {
    setIsPlaying(false)
    setPreviewFrameCursor(null)
    setPaletteCycleElapsedMs(0)
  }, [])

  const apply = useCallback((type: PixelCommandType, payload: Record<string, unknown>) => {
    stopPlayback()
    const current = historyRef.current
    try {
      const command = createPixelCommand(current.document, type, payload, {
        id: `pixel-ui-${commandSequenceRef.current++}`,
        actor: 'user',
      })
      const result = applyPixelCommand(current.document, command)
      replaceHistory({
        document: result.document,
        undo: [...current.undo, result.inverse],
        redo: [],
      })
      setStatus(`已应用：${type}`)
      return true
    } catch (error) {
      setStatus(error instanceof PixelContractError ? error.message : '像素命令执行失败')
      return false
    }
  }, [replaceHistory, stopPlayback])

  const undo = useCallback(() => {
    stopPlayback()
    const current = historyRef.current
    const inverse = current.undo.at(-1)
    if (!inverse) return
    try {
      const result = applyPixelCommand(current.document, {
        ...inverse,
        id: `pixel-ui-undo-${commandSequenceRef.current++}`,
        baseRevision: current.document.revision,
      })
      replaceHistory({
        document: result.document,
        undo: current.undo.slice(0, -1),
        redo: [...current.redo, result.inverse],
      })
      setStatus('已撤销上一步')
    } catch (error) {
      setStatus(error instanceof PixelContractError ? error.message : '撤销失败')
    }
  }, [replaceHistory, stopPlayback])

  const redo = useCallback(() => {
    stopPlayback()
    const current = historyRef.current
    const command = current.redo.at(-1)
    if (!command) return
    try {
      const result = applyPixelCommand(current.document, {
        ...command,
        id: `pixel-ui-redo-${commandSequenceRef.current++}`,
        baseRevision: current.document.revision,
      })
      replaceHistory({
        document: result.document,
        undo: [...current.undo, result.inverse],
        redo: current.redo.slice(0, -1),
      })
      setStatus('已重做上一步')
    } catch (error) {
      setStatus(error instanceof PixelContractError ? error.message : '重做失败')
    }
  }, [replaceHistory, stopPlayback])

  const installDocument = useCallback((nextDocument: PixelDocument, message: string) => {
    stopPlayback()
    replaceHistory({ document: nextDocument, undo: [], redo: [] })
    setActiveColorId(nextDocument.palette[0].id)
    setActiveAnimationTagId(nextDocument.animationTags[0]?.id ?? null)
    setActivePaletteCycleId(nextDocument.paletteCycles[0]?.id ?? null)
    setBatchDurationMs(String(nextDocument.frames[0]?.durationMs ?? 140))
    setSelection(null)
    setSelectionClipboard(null)
    setSelectionPasteMode('replace')
    setDragDraft(null)
    dragContextRef.current = null
    setActiveTerrainMapId(nextDocument.terrainMaps[0]?.id ?? null)
    setTerrainMapPaintTerrainId(
      nextDocument.frames.find((frame) => frame.gameplay.tileRule)?.gameplay.tileRule?.terrainId ?? '',
    )
    setTerrainMapDraftCells(null)
    terrainMapStrokeRef.current = null
    setTerrainMapWidthInput(String(nextDocument.terrainMaps[0]?.width ?? 8))
    setTerrainMapHeightInput(String(nextDocument.terrainMaps[0]?.height ?? 8))
    setStatus(message)
  }, [replaceHistory, stopPlayback])

  const patchActiveFrameGameplay = useCallback((
    mutate: (gameplay: PixelFrameGameplay) => void,
    successMessage: string,
  ) => {
    const current = historyRef.current.document
    const frame = current.frames.find((item) => item.id === current.activeFrameId)
    if (!frame) {
      setStatus('当前帧不可用')
      return false
    }
    const gameplay = structuredClone(frame.gameplay)
    mutate(gameplay)
    const succeeded = apply('frames.patch', { frameId: frame.id, patch: { gameplay } })
    if (succeeded) setStatus(successMessage)
    return succeeded
  }, [apply])

  const patchActiveCollision = useCallback((collisionId: string, patch: Partial<PixelCollisionShape>) => (
    patchActiveFrameGameplay((gameplay) => {
      const collision = gameplay.collisions.find((item) => item.id === collisionId)
      if (collision) Object.assign(collision, patch)
    }, '碰撞区已更新 · 可撤销')
  ), [patchActiveFrameGameplay])

  const addActiveCollision = useCallback(() => {
    const current = historyRef.current.document
    const frame = current.frames.find((item) => item.id === current.activeFrameId)
    if (!frame) return
    const width = Math.min(4, current.width)
    const height = Math.min(4, current.height)
    const id = uniqueId('collision', frame.gameplay.collisions.map((collision) => collision.id), current.revision)
    patchActiveFrameGameplay((gameplay) => {
      gameplay.collisions.push({
        id,
        name: `碰撞区 ${gameplay.collisions.length + 1}`,
        type: 'solid',
        x: Math.max(0, Math.floor((current.width - width) / 2)),
        y: Math.max(0, current.height - height),
        width,
        height,
      })
    }, '已添加逐帧碰撞区 · 可撤销')
  }, [patchActiveFrameGameplay])

  const loadImageSource = useCallback(async (file: File) => {
    setIsImporting(true)
    setStatus('正在解码 PNG / WebP…')
    try {
      const source = await decodePixelImageFile(file)
      importedSourceRef.current = source
      setImportSourceSummary({ name: source.sourceName, width: source.width, height: source.height })
      setLastConversion(null)
      setStatus(`已载入 ${source.sourceName}，调整参数后执行确定性转换`)
    } catch (error) {
      setStatus(readablePixelError(error, '图像导入失败'))
    } finally {
      setIsImporting(false)
    }
  }, [])

  const convertImportedSource = useCallback(async () => {
    const source = importedSourceRef.current
    if (!source) {
      setStatus('请先选择 PNG 或 WebP 图像')
      return
    }
    setIsImporting(true)
    setStatus('正在执行确定性缩放、量化与抖动…')
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    try {
      const { paletteMode, ...conversionSettings } = importSettings
      const { sourceName, ...rgbaSource } = source
      const result = convertRgbaToPixelDocument(rgbaSource, {
        ...conversionSettings,
        palette: paletteMode === 'current' ? historyRef.current.document.palette : undefined,
        documentId: `import-${commandSequenceRef.current++}`,
        documentName: sourceDocumentName(sourceName),
      })
      installDocument(
        result.document,
        `转换完成：${result.report.targetWidth} × ${result.report.targetHeight} · ${result.report.paletteSize} 色 · ${result.report.dither}`,
      )
      setLastConversion(result.report)
    } catch (error) {
      setStatus(readablePixelError(error, '像素转换失败'))
    } finally {
      setIsImporting(false)
    }
  }, [importSettings, installDocument])

  const loadProject = useCallback(async (file: File) => {
    setIsImporting(true)
    setStatus('正在校验像素项目 schemaVersion…')
    try {
      const nextDocument = await readPixelProjectFile(file)
      importedSourceRef.current = null
      setImportSourceSummary(null)
      setLastConversion(null)
      installDocument(nextDocument, `项目已重新打开：${nextDocument.name} · schema v${nextDocument.schemaVersion}`)
    } catch (error) {
      setStatus(readablePixelError(error, '项目导入失败'))
    } finally {
      setIsImporting(false)
    }
  }, [installDocument])

  useEffect(() => {
    onDocumentChange?.(document)
  }, [document, onDocumentChange])

  useEffect(() => {
    if (!workspaceProjectId) return
    let disposed = false
    void listWorkspaceCreativePlanReceipts(workspaceProjectId, { documentId: projectId, limit: 1 })
      .then((receipts) => {
        if (!disposed) setLatestAgentReceipt(receipts[0] ?? null)
      })
      .catch(() => undefined)
    return () => { disposed = true }
  }, [projectId, workspaceProjectId])

  const activeAnimationTag = document.animationTags.find((tag) => tag.id === activeAnimationTagId)
    ?? document.animationTags[0]
    ?? null
  const activePaletteCycle = document.paletteCycles.find((cycle) => cycle.id === activePaletteCycleId)
    ?? document.paletteCycles[0]
    ?? null
  const animationRangeFrameIds = useMemo(() => {
    if (!activeAnimationTag) return document.frames.map((frame) => frame.id)
    const fromIndex = document.frames.findIndex((frame) => frame.id === activeAnimationTag.fromFrameId)
    const toIndex = document.frames.findIndex((frame) => frame.id === activeAnimationTag.toFrameId)
    return document.frames.slice(fromIndex, toIndex + 1).map((frame) => frame.id)
  }, [activeAnimationTag, document.frames])
  const playbackFrameIds = useMemo(
    () => activeAnimationTag
      ? resolvePixelAnimationFrames(document, activeAnimationTag.id)
      : document.frames.map((frame) => frame.id),
    [activeAnimationTag, document],
  )
  const activeAnimationEvents = useMemo(
    () => activeAnimationTag
      ? document.animationEvents.filter((event) => event.animationTagId === activeAnimationTag.id)
      : [],
    [activeAnimationTag, document.animationEvents],
  )

  useEffect(() => {
    if (!isPlaying || !document.paletteCycles.some((cycle) => cycle.enabled)) {
      setPaletteCycleElapsedMs(0)
      return undefined
    }
    const startedAt = performance.now()
    const timer = window.setInterval(() => {
      setPaletteCycleElapsedMs(Math.max(0, Math.floor(performance.now() - startedAt)))
    }, 32)
    return () => window.clearInterval(timer)
  }, [document.paletteCycles, isPlaying])

  useEffect(() => {
    if (!isPlaying) return undefined
    if (playbackFrameIds.length === 0) {
      setIsPlaying(false)
      setPreviewFrameCursor(null)
      return undefined
    }
    const nextCursor = previewFrameCursor !== null
      && previewFrameCursor >= 0
      && previewFrameCursor < playbackFrameIds.length
      ? previewFrameCursor
      : Math.max(0, playbackFrameIds.indexOf(document.activeFrameId))
    if (previewFrameCursor !== nextCursor) {
      setPreviewFrameCursor(nextCursor)
      return undefined
    }
    const currentFrame = document.frames.find((frame) => frame.id === playbackFrameIds[nextCursor])
    if (!currentFrame) return undefined
    const timer = window.setTimeout(() => {
      if (nextCursor + 1 < playbackFrameIds.length) {
        setPreviewFrameCursor(nextCursor + 1)
        return
      }
      if (activeAnimationTag?.loop ?? true) {
        setPreviewFrameCursor(0)
        return
      }
      setIsPlaying(false)
      setPreviewFrameCursor(null)
    }, currentFrame.durationMs)
    return () => window.clearTimeout(timer)
  }, [activeAnimationTag?.loop, document.activeFrameId, document.frames, isPlaying, playbackFrameIds, previewFrameCursor])

  const displayedFrameId = isPlaying && previewFrameCursor !== null && playbackFrameIds[previewFrameCursor]
    ? playbackFrameIds[previewFrameCursor]
    : document.activeFrameId

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.width = document.width
    canvas.height = document.height
    const context = canvas.getContext('2d')
    if (!context) return
    context.clearRect(0, 0, document.width, document.height)
    context.imageSmoothingEnabled = false

    const activeIndex = document.frames.findIndex((frame) => frame.id === displayedFrameId)
    if (!isPlaying && document.onionSkin.enabled) {
      for (let distance = document.onionSkin.previousFrames; distance >= 1; distance -= 1) {
        const frame = document.frames[activeIndex - distance]
        if (!frame) continue
        putRgbaOnCanvas(
          context,
          renderPixelFrameRgba(document, frame.id),
          document.width,
          document.height,
          document.onionSkin.opacity / distance,
          [226, 105, 120],
        )
      }
      for (let distance = document.onionSkin.nextFrames; distance >= 1; distance -= 1) {
        const frame = document.frames[activeIndex + distance]
        if (!frame) continue
        putRgbaOnCanvas(
          context,
          renderPixelFrameRgba(document, frame.id),
          document.width,
          document.height,
          document.onionSkin.opacity / distance,
          [80, 178, 213],
        )
      }
    }
    putRgbaOnCanvas(
      context,
      renderPixelFrameRgba(document, displayedFrameId, {
        paletteCycleElapsedMs: isPlaying ? paletteCycleElapsedMs : 0,
      }),
      document.width,
      document.height,
    )
    if (gameOverlayVisible) {
      const frame = document.frames.find((item) => item.id === displayedFrameId)
      if (frame) {
        context.save()
        for (const collision of frame.gameplay.collisions) {
          context.fillStyle = `${PIXEL_COLLISION_COLORS[collision.type]}33`
          context.strokeStyle = PIXEL_COLLISION_COLORS[collision.type]
          context.lineWidth = 0.5
          context.fillRect(collision.x, collision.y, collision.width, collision.height)
          context.strokeRect(
            collision.x + 0.25,
            collision.y + 0.25,
            Math.max(0.5, collision.width - 0.5),
            Math.max(0.5, collision.height - 0.5),
          )
        }
        const anchorX = Math.min(document.width - 0.25, Math.max(0.25, frame.gameplay.anchor.x))
        const anchorY = Math.min(document.height - 0.25, Math.max(0.25, frame.gameplay.anchor.y))
        context.strokeStyle = '#9A7BFF'
        context.lineWidth = 0.55
        context.beginPath()
        context.moveTo(Math.max(0, anchorX - 1.75), anchorY)
        context.lineTo(Math.min(document.width, anchorX + 1.75), anchorY)
        context.moveTo(anchorX, Math.max(0, anchorY - 1.75))
        context.lineTo(anchorX, Math.min(document.height, anchorY + 1.75))
        context.stroke()
        context.restore()
      }
    }
  }, [displayedFrameId, document, gameOverlayVisible, isPlaying, paletteCycleElapsedMs, strokePreviewRevision])

  const pixelAtPointer = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget
    const bounds = canvas.getBoundingClientRect()
    if (bounds.width <= 0 || bounds.height <= 0) return null
    const x = Math.max(0, Math.min(canvas.width - 1, Math.floor(((event.clientX - bounds.left) / bounds.width) * canvas.width)))
    const y = Math.max(0, Math.min(canvas.height - 1, Math.floor(((event.clientY - bounds.top) / bounds.height) * canvas.height)))
    return { x, y }
  }, [])

  useEffect(() => {
    if (!libraryAsset || consumedLibraryAssetRef.current === libraryAsset.nonce) return
    consumedLibraryAssetRef.current = libraryAsset.nonce
    let disposed = false
    void (async () => {
      try {
        const response = await fetch(libraryAsset.asset.version.url, { credentials: 'same-origin' })
        if (!response.ok) throw new Error(`资源读取返回 HTTP ${response.status}`)
        let blob = await response.blob()
        let extension = libraryAsset.asset.version.extension
        if (!['image/png', 'image/webp'].includes(blob.type)) {
          const bitmap = await createImageBitmap(blob)
          try {
            const canvas = window.document.createElement('canvas')
            canvas.width = bitmap.width
            canvas.height = bitmap.height
            const context = canvas.getContext('2d')
            if (!context) throw new Error('浏览器无法规范化资源库图像')
            context.drawImage(bitmap, 0, 0)
            blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
              (value) => value ? resolve(value) : reject(new Error('无法编码像素导入 PNG')),
              'image/png',
            ))
            extension = 'png'
          } finally {
            bitmap.close()
          }
        }
        if (disposed) return
        await loadImageSource(new File([blob], `${libraryAsset.asset.title}.${extension}`, { type: blob.type }))
      } catch (error) {
        if (!disposed) setStatus(error instanceof Error ? error.message : '资源库图像投递失败')
      } finally {
        if (!disposed) onLibraryAssetConsumed?.(libraryAsset.nonce)
      }
    })()
    return () => { disposed = true }
  }, [libraryAsset, loadImageSource, onLibraryAssetConsumed])

  const stageStrokeAtPointer = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const stroke = strokeContextRef.current
    const point = pixelAtPointer(event)
    if (!stroke || !point) return
    const canvas = event.currentTarget
    const line = lastStrokePointRef.current
      ? rasterPixelLine(lastStrokePointRef.current, point, event.currentTarget.width, event.currentTarget.height)
      : [point]
    lastStrokePointRef.current = point
    const expanded = expandPixelBrush(line, event.currentTarget.width, event.currentTarget.height, {
      size: stroke.brushSize,
      mirrorHorizontal: stroke.mirrorHorizontal,
      mirrorVertical: stroke.mirrorVertical,
    })
    const context = canvas.getContext('2d')
    if (!context) return
    context.save()
    for (const pixel of expanded) {
      const pixelKey = `${pixel.x}:${pixel.y}`
      if (strokePointsRef.current.has(pixelKey)) continue
      strokePointsRef.current.set(pixelKey, pixel)
      if (stroke.tool === 'pencil') {
        context.globalAlpha = stroke.layerOpacity
        context.fillStyle = stroke.previewColor
        context.fillRect(pixel.x, pixel.y, 1, 1)
      } else {
        context.clearRect(pixel.x, pixel.y, 1, 1)
      }
    }
    context.restore()
  }, [pixelAtPointer])

  const beginCanvasGesture = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    stopPlayback()
    const current = historyRef.current.document
    const point = pixelAtPointer(event)
    if (!point) return

    if (tool === 'picker') {
      const frame = current.frames.find((item) => item.id === current.activeFrameId)
      const groupById = new Map(current.layerGroups.map((group) => [group.id, group]))
      const picked = [...current.layers].reverse().find((layer) => (
        layer.visible
        && (layer.groupId === null || groupById.get(layer.groupId)?.visible !== false)
        && layer.opacity > 0
        && frame?.cels[layer.id]?.[point.y * current.width + point.x]
      ))
      const colorId = picked ? frame?.cels[picked.id]?.[point.y * current.width + point.x] : null
      if (colorId) {
        setActiveColorId(colorId)
        setTool('pencil')
        setStatus(`已吸取颜色：${current.palette.find((color) => color.id === colorId)?.name ?? colorId}`)
      } else {
        setStatus('该位置为透明像素')
      }
      return
    }

    if (tool === 'marquee') {
      const draft: PixelDragContext = {
        baseRevision: current.revision,
        frameId: current.activeFrameId,
        layerId: current.activeLayerId,
        tool,
        colorId: activeColorId,
        start: point,
        current: point,
      }
      dragContextRef.current = draft
      setDragDraft(draft)
      setSelection(null)
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }

    const activeLayer = current.layers.find((layer) => layer.id === current.activeLayerId)
    const activeGroup = activeLayer?.groupId === null
      ? null
      : current.layerGroups.find((group) => group.id === activeLayer?.groupId)
    if (!activeLayer || activeLayer.locked || activeGroup?.locked || activeGroup?.visible === false) {
      setStatus(activeLayer
        ? activeGroup?.visible === false
          ? `图层组 ${activeGroup.name} 已隐藏`
          : activeGroup?.locked ? `图层组 ${activeGroup.name} 已锁定` : `图层 ${activeLayer.name} 已锁定`
        : '当前图层不存在')
      return
    }

    if (tool === 'fill') {
      const frame = current.frames.find((item) => item.id === current.activeFrameId)
      const cel = frame?.cels[current.activeLayerId]
      if (!cel) return
      const points = floodFillPixels(cel, current.width, current.height, point, activeColorId)
      if (points.length === 0) {
        setStatus('填充区域已经是当前颜色')
        return
      }
      if (apply('pixels.paint', {
        frameId: current.activeFrameId,
        layerId: current.activeLayerId,
        pixels: points.map((pixel) => ({ ...pixel, colorId: activeColorId })),
      })) setStatus(`已填充 ${points.length} 个连续像素 · 1 个撤销单元`)
      return
    }

    if (tool === 'line' || tool === 'rectangle') {
      const draft: PixelDragContext = {
        baseRevision: current.revision,
        frameId: current.activeFrameId,
        layerId: current.activeLayerId,
        tool,
        colorId: activeColorId,
        start: point,
        current: point,
      }
      dragContextRef.current = draft
      setDragDraft(draft)
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }

    strokeContextRef.current = {
      baseRevision: current.revision,
      frameId: current.activeFrameId,
      layerId: current.activeLayerId,
      tool: tool === 'eraser' ? 'eraser' : 'pencil',
      colorId: activeColorId,
      previewColor: current.palette.find((color) => color.id === activeColorId)?.color ?? '#000000FF',
      layerOpacity: activeLayer.opacity,
      brushSize,
      mirrorHorizontal,
      mirrorVertical,
    }
    strokePointsRef.current.clear()
    lastStrokePointRef.current = null
    paintingRef.current = true
    event.currentTarget.setPointerCapture(event.pointerId)
    stageStrokeAtPointer(event)
  }, [activeColorId, apply, brushSize, mirrorHorizontal, mirrorVertical, pixelAtPointer, stageStrokeAtPointer, stopPlayback, tool])

  const updateCanvasGesture = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (paintingRef.current) {
      stageStrokeAtPointer(event)
      return
    }
    const draft = dragContextRef.current
    const point = pixelAtPointer(event)
    if (!draft || !point || (point.x === draft.current.x && point.y === draft.current.y)) return
    const next = { ...draft, current: point }
    dragContextRef.current = next
    setDragDraft(next)
  }, [pixelAtPointer, stageStrokeAtPointer])

  const finishStroke = useCallback(() => {
    const stroke = strokeContextRef.current
    const points = [...strokePointsRef.current.values()]
    paintingRef.current = false
    strokeContextRef.current = null
    lastStrokePointRef.current = null
    strokePointsRef.current.clear()
    setStrokePreviewRevision((revision) => revision + 1)
    if (!stroke || points.length === 0) return
    if (historyRef.current.document.revision !== stroke.baseRevision) {
      setStatus('笔划期间文档已变化，本次草稿未提交')
      return
    }
    const succeeded = stroke.tool === 'pencil'
      ? apply('pixels.paint', {
          frameId: stroke.frameId,
          layerId: stroke.layerId,
          pixels: points.map((point) => ({ ...point, colorId: stroke.colorId })),
        })
      : apply('pixels.erase', {
          frameId: stroke.frameId,
          layerId: stroke.layerId,
          pixels: points,
        })
    if (succeeded) setStatus(`已提交单笔：${points.length} 个唯一像素 · 1 个撤销单元`)
  }, [apply])

  const finishCanvasGesture = useCallback(() => {
    if (paintingRef.current) {
      finishStroke()
      return
    }
    const draft = dragContextRef.current
    dragContextRef.current = null
    setDragDraft(null)
    if (!draft) return
    const current = historyRef.current.document
    if (draft.baseRevision !== current.revision) {
      setStatus('拖拽期间文档已变化，本次草稿未提交')
      return
    }
    if (draft.tool === 'marquee') {
      const rect = normalizePixelRect(draft.start, draft.current, current.width, current.height)
      setSelection(rect)
      setStatus(`已选择 ${rect.width} × ${rect.height} 区域；方向键可逐像素移动`)
      return
    }
    const basePoints = draft.tool === 'line'
      ? rasterPixelLine(draft.start, draft.current, current.width, current.height)
      : rasterPixelRectangle(draft.start, draft.current, current.width, current.height)
    const points = expandPixelBrush(basePoints, current.width, current.height, {
      size: brushSize,
      mirrorHorizontal,
      mirrorVertical,
    })
    if (apply('pixels.paint', {
      frameId: draft.frameId,
      layerId: draft.layerId,
      pixels: points.map((point) => ({ ...point, colorId: draft.colorId })),
    })) setStatus(`已提交${draft.tool === 'line' ? '直线' : '矩形'}：${points.length} 个像素 · 1 个撤销单元`)
  }, [apply, brushSize, finishStroke, mirrorHorizontal, mirrorVertical])

  const applySelectionOperation = useCallback((
    operation: 'clear' | 'flip-horizontal' | 'flip-vertical' | 'move' | 'copy',
    options: { dx?: number; dy?: number } = {},
  ) => {
    if (!selection) return false
    const current = historyRef.current.document
    const activeLayer = current.layers.find((layer) => layer.id === current.activeLayerId)
    const frame = current.frames.find((item) => item.id === current.activeFrameId)
    const cel = frame?.cels[current.activeLayerId]
    if (!activeLayer || !cel) return false
    const activeGroup = activeLayer.groupId === null
      ? null
      : current.layerGroups.find((group) => group.id === activeLayer.groupId)
    if (activeLayer.locked || activeGroup?.locked || activeGroup?.visible === false) {
      setStatus(activeGroup?.visible === false
        ? `图层组 ${activeGroup.name} 已隐藏`
        : activeGroup?.locked ? `图层组 ${activeGroup.name} 已锁定` : `图层 ${activeLayer.name} 已锁定`)
      return false
    }
    try {
      const pixels = createSelectionPatch(cel, current.width, current.height, selection, operation, options)
      if (pixels.length === 0) {
        setStatus('该区域变换不会改变任何像素')
        return false
      }
      const succeeded = apply('pixels.patch', {
        frameId: current.activeFrameId,
        layerId: current.activeLayerId,
        pixels,
      })
      if (succeeded && (operation === 'move' || operation === 'copy')) {
        setSelection((value) => value ? { ...value, x: value.x + (options.dx ?? 0), y: value.y + (options.dy ?? 0) } : value)
      }
      if (succeeded) setStatus(`区域${operation === 'clear' ? '清除' : operation === 'copy' ? '复制' : operation === 'move' ? '移动' : '翻转'}完成 · ${pixels.length} 个混合像素 · 1 个撤销单元`)
      return succeeded
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '区域变换失败')
      return false
    }
  }, [apply, selection])

  const captureSelectionClipboard = useCallback((cut: boolean) => {
    if (!selection) {
      setStatus('请先框选要复制的像素区域')
      return false
    }
    const current = historyRef.current.document
    const activeLayer = current.layers.find((layer) => layer.id === current.activeLayerId)
    const frame = current.frames.find((item) => item.id === current.activeFrameId)
    const cel = frame?.cels[current.activeLayerId]
    if (!activeLayer || !frame || !cel) {
      setStatus('当前帧或图层不可用')
      return false
    }
    const activeGroup = activeLayer.groupId === null
      ? null
      : current.layerGroups.find((group) => group.id === activeLayer.groupId)
    if (cut && (activeLayer.locked || activeGroup?.locked || activeGroup?.visible === false)) {
      setStatus(activeGroup?.visible === false
        ? `图层组 ${activeGroup.name} 已隐藏`
        : activeGroup?.locked ? `图层组 ${activeGroup.name} 已锁定` : `图层 ${activeLayer.name} 已锁定`)
      return false
    }
    try {
      const nextClipboard = createPixelSelectionClipboard(cel, current.width, current.height, selection, {
        documentId: current.id,
        documentRevision: current.revision,
        frameId: frame.id,
        layerId: activeLayer.id,
      })
      let cutChanged = false
      if (cut) {
        const pixels = createSelectionPatch(cel, current.width, current.height, selection, 'clear')
          .filter((point) => cel[point.y * current.width + point.x] !== point.value)
        if (pixels.length > 0 && !apply('pixels.patch', {
          frameId: frame.id,
          layerId: activeLayer.id,
          pixels,
        })) return false
        cutChanged = pixels.length > 0
      }
      setSelectionClipboard(nextClipboard)
      setStatus(`${cut ? '剪切' : '复制'}到内存剪贴板：${nextClipboard.width}×${nextClipboard.height} · ${frame.name}/${activeLayer.name}${cut ? cutChanged ? ' · 1 个可撤销像素操作' : ' · 透明区域，无正文修订' : ''}`)
      return true
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '选区复制失败')
      return false
    }
  }, [apply, selection])

  const pasteSelectionClipboard = useCallback(() => {
    const clipboard = selectionClipboard
    if (!clipboard) {
      setStatus('内存剪贴板为空')
      return false
    }
    const current = historyRef.current.document
    const frame = current.frames.find((item) => item.id === current.activeFrameId)
    const layer = current.layers.find((item) => item.id === current.activeLayerId)
    const cel = frame?.cels[current.activeLayerId]
    if (!frame || !layer || !cel) {
      setStatus('当前帧或图层不可用')
      return false
    }
    const target = selection
      ? { x: selection.x, y: selection.y }
      : { x: clipboard.source.selection.x, y: clipboard.source.selection.y }
    try {
      const pixels = createPixelSelectionPastePatch(cel, current.width, current.height, clipboard, target, {
        mode: selectionPasteMode,
        allowedColorIds: current.palette.map((color) => color.id),
      })
      if (pixels.length === 0) {
        setStatus('剪贴板内容与目标区域一致，没有产生修订')
        return false
      }
      const succeeded = apply('pixels.patch', {
        frameId: frame.id,
        layerId: layer.id,
        pixels,
      })
      if (!succeeded) return false
      setSelection({ x: target.x, y: target.y, width: clipboard.width, height: clipboard.height })
      setStatus(`跨帧选区已粘贴到 ${frame.name}/${layer.name} · ${selectionPasteMode === 'replace' ? '透明像素覆盖' : '仅不透明像素'} · ${pixels.length} 像素 · 1 个撤销单元`)
      return true
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '选区粘贴失败')
      return false
    }
  }, [apply, selection, selectionClipboard, selectionPasteMode])

  const selectedLayer = document.layers.find((layer) => layer.id === document.activeLayerId) ?? document.layers[0]
  const selectedLayerGroup = selectedLayer.groupId === null
    ? null
    : document.layerGroups.find((group) => group.id === selectedLayer.groupId) ?? null
  const activeFrame = document.frames.find((frame) => frame.id === document.activeFrameId) ?? document.frames[0]
  const activeTerrainMap = document.terrainMaps.find((terrainMap) => terrainMap.id === activeTerrainMapId)
    ?? document.terrainMaps[0]
    ?? null
  const terrainIds = useMemo(() => [...new Set(document.frames.flatMap((frame) => (
    frame.gameplay.tileRule ? [frame.gameplay.tileRule.terrainId] : []
  )))], [document.frames])
  useEffect(() => {
    if (!terrainIds.includes(terrainMapPaintTerrainId)) setTerrainMapPaintTerrainId(terrainIds[0] ?? '')
  }, [terrainIds, terrainMapPaintTerrainId])
  useEffect(() => {
    const nextId = activeTerrainMap?.id ?? null
    if (activeTerrainMapId !== nextId) setActiveTerrainMapId(nextId)
    setTerrainMapDraftCells(null)
    terrainMapStrokeRef.current = null
    setTerrainMapWidthInput(String(activeTerrainMap?.width ?? 8))
    setTerrainMapHeightInput(String(activeTerrainMap?.height ?? 8))
  }, [activeTerrainMap?.height, activeTerrainMap?.id, activeTerrainMap?.width, activeTerrainMapId])
  const selectedColor = document.palette.find((color) => color.id === activeColorId) ?? document.palette[0]
  const selectionPreview = useMemo(() => {
    if (!dragDraft) return selection
    return normalizePixelRect(dragDraft.start, dragDraft.current, document.width, document.height)
  }, [document.height, document.width, dragDraft, selection])
  const spriteMetadata = useMemo(
    () => createSpriteSheetMetadata(document, { columns: Math.min(4, document.frames.length), padding: 1, spacing: 1 }),
    [document],
  )
  const terrainPreviewResult = useMemo<{
    preview: TerrainPreviewRender | null
    error: string | null
  }>(() => {
    const terrainId = activeFrame.gameplay.tileRule?.terrainId
    if (!terrainId) return { preview: null, error: null }
    try {
      return {
        preview: renderPixelTerrainPreviewRgba(document, { terrainId, occupancy: terrainOccupancy }),
        error: null,
      }
    } catch (error) {
      return { preview: null, error: readablePixelError(error, '九宫格 Terrain 预览不可用') }
    }
  }, [activeFrame.gameplay.tileRule?.terrainId, document, terrainOccupancy])
  const terrainMapPreviewResult = useMemo<{
    preview: TerrainMapRender | null
    error: string | null
  }>(() => {
    if (!activeTerrainMap) return { preview: null, error: null }
    const draft = terrainMapDraftCells?.length === activeTerrainMap.cells.length
      ? terrainMapDraftCells
      : undefined
    try {
      return {
        preview: renderPixelTerrainMapRgba(document, {
          terrainMapId: activeTerrainMap.id,
          ...(draft ? { cells: draft } : {}),
        }),
        error: null,
      }
    } catch (error) {
      return { preview: null, error: readablePixelError(error, 'Terrain Map 预览不可用') }
    }
  }, [activeTerrainMap, document, terrainMapDraftCells])

  useEffect(() => {
    const canvas = terrainPreviewCanvasRef.current
    const preview = terrainPreviewResult.preview
    if (!canvas || !preview) return
    canvas.width = preview.width
    canvas.height = preview.height
    const context = canvas.getContext('2d')
    if (!context) return
    context.imageSmoothingEnabled = false
    const image = context.createImageData(preview.width, preview.height)
    image.data.set(preview.pixels)
    context.putImageData(image, 0, 0)
  }, [terrainPreviewResult.preview])

  useEffect(() => {
    const canvas = terrainMapCanvasRef.current
    const preview = terrainMapPreviewResult.preview
    if (!canvas || !activeTerrainMap) return
    const fallbackCells = terrainMapDraftCells?.length === activeTerrainMap.cells.length
      ? terrainMapDraftCells
      : activeTerrainMap.cells
    canvas.width = preview?.width ?? activeTerrainMap.width
    canvas.height = preview?.height ?? activeTerrainMap.height
    const context = canvas.getContext('2d')
    if (!context) return
    context.imageSmoothingEnabled = false
    context.clearRect(0, 0, canvas.width, canvas.height)
    if (preview) {
      const image = context.createImageData(preview.width, preview.height)
      image.data.set(preview.pixels)
      context.putImageData(image, 0, 0)
    } else {
      fallbackCells.forEach((terrainId, index) => {
        if (terrainId === null) return
        context.fillStyle = terrainPreviewColor(terrainId)
        context.fillRect(index % activeTerrainMap.width, Math.floor(index / activeTerrainMap.width), 1, 1)
      })
    }
    const cellWidth = canvas.width / activeTerrainMap.width
    const cellHeight = canvas.height / activeTerrainMap.height
    context.strokeStyle = 'rgba(74, 65, 145, 0.38)'
    context.lineWidth = Math.max(0.15, Math.min(cellWidth, cellHeight) * 0.04)
    context.beginPath()
    for (let column = 1; column < activeTerrainMap.width; column += 1) {
      context.moveTo(column * cellWidth, 0)
      context.lineTo(column * cellWidth, canvas.height)
    }
    for (let row = 1; row < activeTerrainMap.height; row += 1) {
      context.moveTo(0, row * cellHeight)
      context.lineTo(canvas.width, row * cellHeight)
    }
    context.stroke()
  }, [activeTerrainMap, terrainMapDraftCells, terrainMapPreviewResult.preview])

  const exportPixelProject = useCallback(async () => {
    setIsExporting(true)
    try {
      const current = historyRef.current.document
      const filename = `${safePixelFilename(current.name)}${PIXEL_PROJECT_EXTENSION}`
      downloadPixelText(serializePixelProject(current), filename, PIXEL_PROJECT_MIME)
      setStatus(`项目已导出：${filename} · ${PIXEL_PROJECT_MIME}`)
    } catch (error) {
      setStatus(readablePixelError(error, '项目导出失败'))
    } finally {
      setIsExporting(false)
    }
  }, [])

  const exportPixelBundle = useCallback(async () => {
    setIsExporting(true)
    try {
      const current = historyRef.current.document
      const bundle = createPixelExportBundle(current, {
        columns: Math.min(4, current.frames.length),
        padding: 1,
        spacing: 1,
      })
      await downloadPixelExportBundle(bundle, {
        includeSprite: !onSpriteSheetReady,
        includeMetadata: !onSpriteSheetReady,
      })
      await onSpriteSheetReady?.({ document: current, metadata: bundle.metadata.value, pixels: bundle.sprite.pixels })
      setStatus('成套导出完成：项目 JSON、当前帧 PNG、Sprite Sheet PNG 与 metadata')
    } catch (error) {
      setStatus(readablePixelError(error, '成套导出失败'))
    } finally {
      setIsExporting(false)
    }
  }, [onSpriteSheetReady])

  const openAgentPlan = useCallback((plan: CreativePlan) => {
    try {
      const current = historyRef.current.document
      const preview = previewCreativePlan(current, plan, { workspaceRevision: current.revision })
      setAgentPlanError(null)
      setAgentPlanReview({ plan, preview })
      setStatus(plan.source.kind === 'byok-text'
        ? 'BYOK 文本计划已通过服务端预演；批准前不会修改像素正文'
        : '智能清理计划已生成；批准前不会修改像素正文')
    } catch (error) {
      setStatus(readablePixelError(error, '智能体计划无法生成预览'))
    }
  }, [])

  const cleanupActivePixelLayer = useCallback(() => {
    const current = historyRef.current.document
    const frame = current.frames.find((item) => item.id === current.activeFrameId)
    const layer = current.layers.find((item) => item.id === current.activeLayerId)
    const cel = frame?.cels[current.activeLayerId]
    if (!frame || !layer || !cel) {
      setStatus('当前帧或图层不可用')
      return
    }
    const group = layer.groupId === null ? null : current.layerGroups.find((item) => item.id === layer.groupId)
    if (layer.locked || group?.locked || group?.visible === false) {
      setStatus(group?.visible === false
        ? `图层组 ${group.name} 已隐藏`
        : group?.locked ? `图层组 ${group.name} 已锁定` : `图层 ${layer.name} 已锁定`)
      return
    }
    try {
      const cleanup = createSmartPixelCleanupPatch(cel, current.width, current.height)
      if (cleanup.pixels.length === 0) {
        setStatus('本地智能清理未发现孤立噪点或单像素针孔')
        return
      }
      const createdAt = Date.now()
      const plan = createCreativePlan({
        id: `pixel-plan-${crypto.randomUUID()}`,
        projectId: workspaceProjectId ?? projectId,
        documentId: current.id,
        modeId: 'pixel',
        baseRevision: current.revision,
        title: '像素图层智能清理',
        objective: `检查“${frame.name} / ${layer.name}”中的孤立噪点与单像素针孔，预览后再写入。`,
        source: { kind: 'deterministic-local', agentRole: 'pixel-cleanup-agent', modelId: null, requestHash: null },
        steps: [{
          id: `pixel-step-${crypto.randomUUID()}`,
          toolId: 'pixel.pixels.patch',
          summary: `移除 ${cleanup.report.isolatedRemoved} 个孤点，填补 ${cleanup.report.pinholesFilled} 个针孔`,
          input: { frameId: frame.id, layerId: layer.id, pixels: cleanup.pixels },
          sourceAssets: [],
        }],
        createdAt,
      })
      openAgentPlan(plan)
    } catch (error) {
      setStatus(readablePixelError(error, '智能清理失败'))
    }
  }, [openAgentPlan, projectId, workspaceProjectId])

  const rejectAgentPlan = useCallback(() => {
    if (agentPlanBusy) return
    setAgentPlanReview(null)
    setAgentPlanError(null)
    setStatus('已拒绝智能清理计划；像素正文保持不变')
  }, [agentPlanBusy])

  const approveAgentPlanReview = useCallback(async () => {
    if (!agentPlanReview || agentPlanBusy) return
    setAgentPlanBusy(true)
    setAgentPlanError(null)
    stopPlayback()
    try {
      const current = historyRef.current
      let localDocument = current.document
      const localInverses: PixelCommand[] = []
      for (const command of agentPlanReview.preview.commands as PixelCommand[]) {
        const localResult = applyPixelCommand(localDocument, command)
        localDocument = localResult.document
        localInverses.push(localResult.inverse)
      }
      const approved = await approveCreativePlan(agentPlanReview.plan)
      let next: PixelDocument
      let receipt: CreativePlanReceipt
      if (workspaceProjectId) {
        const result = await commitWorkspaceCreativePlan(approved)
        next = migratePixelDocument(JSON.parse(result.document.value))
        receipt = result.receipt
      } else {
        const result = await executeApprovedCreativePlan(current.document, approved, {
          workspaceRevision: current.document.revision,
        })
        next = migratePixelDocument(result.document)
        receipt = result.receipt
      }
      replaceHistory({
        document: next,
        undo: [...current.undo, ...localInverses],
        redo: [],
      })
      setLatestAgentReceipt(receipt)
      setAgentPlanReview(null)
      setStatus(`智能体计划已批准并提交 · ${localInverses.length} 个可撤销步骤 · 执行回执已保存`)
    } catch (error) {
      setAgentPlanError(readablePixelError(error, '智能清理计划提交失败'))
    } finally {
      setAgentPlanBusy(false)
    }
  }, [agentPlanBusy, agentPlanReview, replaceHistory, stopPlayback, workspaceProjectId])

  const ensureEightDirectionSlots = useCallback(() => {
    const directions = [
      ['south', '南'], ['south-west', '西南'], ['west', '西'], ['north-west', '西北'],
      ['north', '北'], ['north-east', '东北'], ['east', '东'], ['south-east', '东南'],
    ] as const
    const sourceFrames = [...historyRef.current.document.frames]
    let changed = 0
    for (let index = 0; index < directions.length; index += 1) {
      const [, label] = directions[index]
      const current = historyRef.current.document
      const existing = current.frames[index]
      if (existing) {
        if (existing.name !== label && apply('frames.patch', { frameId: existing.id, patch: { name: label } })) changed += 1
        continue
      }
      const [directionId] = directions[index]
      const id = uniqueId(`direction-${directionId}`, current.frames.map((frame) => frame.id), current.revision)
      const copyFromFrameId = sourceFrames[index % sourceFrames.length]?.id ?? current.frames[0].id
      if (apply('frames.add', {
        frame: { id, name: label, durationMs: 140 },
        copyFromFrameId,
      })) changed += 1
    }
    setStatus(changed > 0
      ? `八方向槽已就绪：南、西南、西、西北、北、东北、东、东南 · ${changed} 项变更`
      : '当前前八帧已经是标准八方向槽')
  }, [apply])

  const createPaletteCycle = useCallback(() => {
    const current = historyRef.current.document
    const claimed = new Set(current.paletteCycles.flatMap((cycle) => cycle.colorIds))
    const available = current.palette.filter((color) => !claimed.has(color.id))
    if (available.length < 2) {
      setStatus('新循环至少需要两个尚未被其他循环占用的颜色')
      return
    }
    const id = uniqueId('palette-cycle', current.paletteCycles.map((cycle) => cycle.id), current.revision)
    if (apply('palette-cycles.add', {
      cycle: {
        id,
        name: `色彩循环 ${current.paletteCycles.length + 1}`,
        colorIds: available.slice(0, 2).map((color) => color.id),
        stepDurationMs: 120,
        direction: 'forward',
        enabled: true,
      },
    })) {
      setActivePaletteCycleId(id)
      setStatus('已建立调色板循环；播放动画即可实时预览，不会写入像素或增加修订号')
    }
  }, [apply])

  const patchActivePaletteCycle = useCallback((patch: Record<string, unknown>) => {
    if (!activePaletteCycle) {
      setStatus('请先建立调色板循环')
      return false
    }
    return apply('palette-cycles.patch', { cycleId: activePaletteCycle.id, patch })
  }, [activePaletteCycle, apply])

  const togglePaletteCycleColor = useCallback((colorId: string) => {
    if (!activePaletteCycle) return
    const ownedByOther = historyRef.current.document.paletteCycles.some(
      (cycle) => cycle.id !== activePaletteCycle.id && cycle.colorIds.includes(colorId),
    )
    if (ownedByOther) {
      setStatus('同一颜色不能同时属于两个调色板循环')
      return
    }
    const included = activePaletteCycle.colorIds.includes(colorId)
    if (included && activePaletteCycle.colorIds.length <= 2) {
      setStatus('调色板循环至少需要保留两个颜色')
      return
    }
    const colorIds = included
      ? activePaletteCycle.colorIds.filter((id) => id !== colorId)
      : [...activePaletteCycle.colorIds, colorId]
    if (patchActivePaletteCycle({ colorIds })) setStatus(`循环色序已更新：${colorIds.length} 色 · 可撤销`)
  }, [activePaletteCycle, patchActivePaletteCycle])

  const removeActivePaletteCycle = useCallback(() => {
    if (!activePaletteCycle) return
    const current = historyRef.current.document
    const fallback = current.paletteCycles.find((cycle) => cycle.id !== activePaletteCycle.id)?.id ?? null
    if (apply('palette-cycles.remove', { cycleId: activePaletteCycle.id })) {
      setActivePaletteCycleId(fallback)
      setStatus('调色板循环已删除；原始色板与像素索引保持不变')
    }
  }, [activePaletteCycle, apply])

  const createAnimationTag = useCallback(() => {
    const current = historyRef.current.document
    const id = uniqueId('animation', current.animationTags.map((tag) => tag.id), current.revision)
    const created = apply('animations.add', {
      tag: {
        id,
        name: `动画 ${current.animationTags.length + 1}`,
        fromFrameId: current.frames[0].id,
        toFrameId: current.frames.at(-1)?.id ?? current.frames[0].id,
        direction: 'forward',
        loop: true,
      },
    })
    if (created) {
      setActiveAnimationTagId(id)
      setStatus('已创建动画片段，可继续设定范围、方向与循环方式')
    }
  }, [apply])

  const patchActiveAnimationTag = useCallback((patch: Record<string, unknown>) => {
    const tagId = activeAnimationTag?.id
    if (!tagId) {
      setStatus('请先创建动画片段')
      return false
    }
    return apply('animations.patch', { tagId, patch })
  }, [activeAnimationTag?.id, apply])

  const removeActiveAnimationTag = useCallback(() => {
    const current = historyRef.current.document
    const tagId = activeAnimationTag?.id
    if (!tagId) return
    const fallback = current.animationTags.find((tag) => tag.id !== tagId)?.id ?? null
    if (apply('animations.remove', { tagId })) {
      setActiveAnimationTagId(fallback)
      setStatus('动画片段已删除；像素帧本身保持不变')
    }
  }, [activeAnimationTag?.id, apply])

  const createAnimationEvent = useCallback(() => {
    if (!activeAnimationTag) {
      setStatus('请先建立动画片段，再添加事件')
      return
    }
    const current = historyRef.current.document
    const frameId = animationRangeFrameIds.includes(current.activeFrameId)
      ? current.activeFrameId
      : animationRangeFrameIds[0]
    const id = uniqueId('animation-event', current.animationEvents.map((event) => event.id), current.revision)
    if (apply('animation-events.add', {
      event: {
        id,
        name: `事件 ${activeAnimationEvents.length + 1}`,
        type: 'marker',
        animationTagId: activeAnimationTag.id,
        frameId,
        value: '',
      },
    })) setStatus(`已在「${current.frames.find((frame) => frame.id === frameId)?.name ?? frameId}」添加动画事件 · 可撤销`)
  }, [activeAnimationEvents.length, activeAnimationTag, animationRangeFrameIds, apply])

  const patchAnimationEvent = useCallback((eventId: string, patch: Record<string, unknown>) => (
    apply('animation-events.patch', { eventId, patch })
  ), [apply])

  const removeAnimationEvent = useCallback((eventId: string) => {
    if (apply('animation-events.remove', { eventId })) setStatus('动画事件已删除 · 可撤销')
  }, [apply])

  const applyAnimationDuration = useCallback(() => {
    if (!activeAnimationTag) {
      setStatus('请先创建动画片段，再批量设置时长')
      return
    }
    const durationMs = Number(batchDurationMs)
    if (!Number.isSafeInteger(durationMs) || durationMs < 20 || durationMs > 60_000) {
      setStatus('片段时长必须是 20—60000 ms 的整数')
      return
    }
    if (apply('frames.duration.set', {
      frames: animationRangeFrameIds.map((frameId) => ({ frameId, durationMs })),
    })) {
      setStatus(`已将「${activeAnimationTag.name}」的 ${animationRangeFrameIds.length} 帧统一设为 ${durationMs} ms · 可一次撤销`)
    }
  }, [activeAnimationTag, animationRangeFrameIds, apply, batchDurationMs])

  const copyActiveLayerAcrossAnimation = useCallback((mode: 'replace' | 'non-transparent') => {
    if (!activeAnimationTag) {
      setStatus('请先创建动画片段，再执行跨帧复制')
      return
    }
    const current = historyRef.current.document
    const targetFrameIds = animationRangeFrameIds.filter((frameId) => frameId !== current.activeFrameId)
    if (targetFrameIds.length === 0) {
      setStatus('当前动画片段没有可复制的目标帧')
      return
    }
    if (apply('cels.copy', {
      sourceFrameId: current.activeFrameId,
      targetFrameIds,
      layerIds: [current.activeLayerId],
      mode,
    })) {
      setStatus(`${mode === 'replace' ? '覆盖复制' : '透明合并'}完成：当前图层已同步到「${activeAnimationTag.name}」的 ${targetFrameIds.length} 个目标帧 · 可一次撤销`)
    }
  }, [activeAnimationTag, animationRangeFrameIds, apply])

  const selectTerrainPreset = useCallback((presetId: string) => {
    const preset = PIXEL_TERRAIN_GRID_PRESETS.find((item) => item.id === presetId)
    if (!preset) return
    setTerrainOccupancy([...preset.occupancy])
    setStatus(`九宫格预设已切换为「${preset.label}」· 仅更新预览`)
  }, [])

  const toggleTerrainCell = useCallback((index: number) => {
    setTerrainOccupancy((current) => current.map((occupied, cellIndex) => (
      cellIndex === index ? !occupied : occupied
    )))
    setStatus('九宫格占用图已更新 · 未修改项目 revision')
  }, [])

  const applyTerrainCenterMask = useCallback(() => {
    const center = terrainPreviewResult.preview?.layout.cells[4]
    if (!center?.occupied || center.expectedBitmask === null) {
      setStatus('请先启用九宫格中心格，再应用本格 Terrain 规则')
      return
    }
    const bitmask = center.expectedBitmask
    patchActiveFrameGameplay((gameplay) => {
      if (gameplay.tileRule) gameplay.tileRule.bitmask = bitmask
    }, `已把九宫格中心期望 Mask ${bitmask} 应用到活动帧 · 可一次撤销`)
  }, [patchActiveFrameGameplay, terrainPreviewResult.preview])

  const exportTerrainPreview = useCallback(async () => {
    const current = historyRef.current.document
    const frame = current.frames.find((item) => item.id === current.activeFrameId)
    const terrainId = frame?.gameplay.tileRule?.terrainId
    if (!terrainId) {
      setStatus('请先为活动帧启用 Terrain，再导出九宫格预览包')
      return
    }
    setIsExporting(true)
    try {
      const bundle = createPixelTerrainPreviewExportBundle(current, { terrainId, occupancy: terrainOccupancy })
      await downloadPixelTerrainPreviewExportBundle(bundle)
      setStatus(`九宫格预览包完成：${bundle.manifest.value.exactCount} 格精确、${bundle.manifest.value.fallbackCount} 格降级`)
    } catch (error) {
      setStatus(readablePixelError(error, '九宫格预览包导出失败'))
    } finally {
      setIsExporting(false)
    }
  }, [terrainOccupancy])

  const createTerrainMap = useCallback(() => {
    const current = historyRef.current.document
    const terrainId = current.frames.find((frame) => frame.id === current.activeFrameId)?.gameplay.tileRule?.terrainId
      ?? current.frames.find((frame) => frame.gameplay.tileRule)?.gameplay.tileRule?.terrainId
    if (!terrainId) {
      setStatus('请先为至少一帧启用 Terrain 规则，再创建持久化地图')
      return
    }
    const id = uniqueId('terrain-map', current.terrainMaps.map((terrainMap) => terrainMap.id), current.revision)
    const width = 8
    const height = 8
    if (apply('terrain-maps.add', {
        terrainMap: {
          id,
          name: `Terrain Map ${current.terrainMaps.length + 1}`,
          width,
          height,
          cells: Array(width * height).fill(null),
        },
      })) {
        setActiveTerrainMapId(id)
        setTerrainMapPaintTerrainId(terrainId)
      setTerrainMapWidthInput(String(width))
      setTerrainMapHeightInput(String(height))
      setStatus(`已创建 8×8 Terrain Map「${id}」· 项目内持久化 · 可撤销`)
    }
  }, [apply])

  const removeActiveTerrainMap = useCallback(() => {
    if (!activeTerrainMap) return
    const current = historyRef.current.document
    const fallback = current.terrainMaps.find((terrainMap) => terrainMap.id !== activeTerrainMap.id)?.id ?? null
    if (apply('terrain-maps.remove', { terrainMapId: activeTerrainMap.id })) {
      setActiveTerrainMapId(fallback)
      setTerrainMapDraftCells(null)
      setStatus(`Terrain Map「${activeTerrainMap.name}」已删除 · 可撤销`)
    }
  }, [activeTerrainMap, apply])

  const resizeActiveTerrainMap = useCallback(() => {
    if (!activeTerrainMap) return
    const width = Number(terrainMapWidthInput)
    const height = Number(terrainMapHeightInput)
    if (
      !Number.isSafeInteger(width)
      || !Number.isSafeInteger(height)
      || width < 1
      || height < 1
      || width > PIXEL_LIMITS.maxTerrainMapWidth
      || height > PIXEL_LIMITS.maxTerrainMapHeight
      || width * height > PIXEL_LIMITS.maxTerrainMapCells
    ) {
      setStatus(`Terrain Map 必须为 1—64，且总格数不超过 ${PIXEL_LIMITS.maxTerrainMapCells}`)
      return
    }
    if (width === activeTerrainMap.width && height === activeTerrainMap.height) {
      setStatus('Terrain Map 尺寸未变化，没有产生修订')
      return
    }
    setTerrainMapDraftCells(null)
    terrainMapStrokeRef.current = null
    if (apply('terrain-maps.resize', { terrainMapId: activeTerrainMap.id, width, height })) {
      setStatus(`Terrain Map 已按左上锚点调整为 ${width}×${height} · 可撤销`)
    }
  }, [activeTerrainMap, apply, terrainMapHeightInput, terrainMapWidthInput])

  const patchAllTerrainMapCells = useCallback((terrainId: string | null) => {
    if (!activeTerrainMap) return
    if (terrainId !== null && !terrainIds.includes(terrainId)) {
      setStatus('请先为至少一帧登记可用的 Terrain ID')
      return
    }
    const cells = activeTerrainMap.cells.flatMap((current, index) => (
      current === terrainId
        ? []
        : [{ x: index % activeTerrainMap.width, y: Math.floor(index / activeTerrainMap.width), terrainId }]
    ))
    if (cells.length === 0) {
      setStatus(terrainId === null ? 'Terrain Map 已经为空，没有产生修订' : `Terrain Map 已经全部是 ${terrainId}`)
      return
    }
    if (apply('terrain-maps.cells.patch', { terrainMapId: activeTerrainMap.id, cells })) {
      setStatus(`${terrainId === null ? '清空' : `以 ${terrainId} 填满`} Terrain Map · ${cells.length} 格 · 1 个撤销单元`)
    }
  }, [activeTerrainMap, apply, terrainIds])

  const terrainMapCellAtPointer = useCallback((
    event: ReactPointerEvent<HTMLCanvasElement>,
    terrainMap: NonNullable<typeof activeTerrainMap>,
  ) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    if (bounds.width <= 0 || bounds.height <= 0) return null
    return {
      x: Math.max(0, Math.min(terrainMap.width - 1, Math.floor(((event.clientX - bounds.left) / bounds.width) * terrainMap.width))),
      y: Math.max(0, Math.min(terrainMap.height - 1, Math.floor(((event.clientY - bounds.top) / bounds.height) * terrainMap.height))),
    }
  }, [])

  const paintTerrainMapStroke = useCallback((context: TerrainMapStrokeContext, target: PixelPoint) => {
    for (const point of rasterPixelLine(context.last, target, context.width, context.height)) {
      context.draft[point.y * context.width + point.x] = context.terrainId
    }
    context.last = target
    setTerrainMapDraftCells([...context.draft])
  }, [])

  const beginTerrainMapStroke = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!activeTerrainMap || event.button !== 0) return
    const targetTerrainId = terrainMapBrushMode === 'paint' ? terrainMapPaintTerrainId : null
    if (terrainMapBrushMode === 'paint' && (targetTerrainId === null || !terrainIds.includes(targetTerrainId))) {
      setStatus('当前没有可用于 Terrain 画笔的帧规则')
      return
    }
    const point = terrainMapCellAtPointer(event, activeTerrainMap)
    if (!point) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const context: TerrainMapStrokeContext = {
      pointerId: event.pointerId,
      terrainMapId: activeTerrainMap.id,
      width: activeTerrainMap.width,
      height: activeTerrainMap.height,
      terrainId: targetTerrainId,
      original: [...activeTerrainMap.cells],
      draft: [...activeTerrainMap.cells],
      last: point,
    }
    terrainMapStrokeRef.current = context
    paintTerrainMapStroke(context, point)
  }, [activeTerrainMap, paintTerrainMapStroke, terrainIds, terrainMapBrushMode, terrainMapCellAtPointer, terrainMapPaintTerrainId])

  const continueTerrainMapStroke = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const context = terrainMapStrokeRef.current
    if (!context || context.pointerId !== event.pointerId) return
    const current = historyRef.current.document.terrainMaps.find((terrainMap) => terrainMap.id === context.terrainMapId)
    if (!current || current.width !== context.width || current.height !== context.height) return
    const point = terrainMapCellAtPointer(event, current)
    if (!point || (point.x === context.last.x && point.y === context.last.y)) return
    event.preventDefault()
    paintTerrainMapStroke(context, point)
  }, [paintTerrainMapStroke, terrainMapCellAtPointer])

  const finishTerrainMapStroke = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const context = terrainMapStrokeRef.current
    if (!context || context.pointerId !== event.pointerId) return
    terrainMapStrokeRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    const current = historyRef.current.document.terrainMaps.find((terrainMap) => terrainMap.id === context.terrainMapId)
    setTerrainMapDraftCells(null)
    if (!current || current.width !== context.width || current.height !== context.height) {
      setStatus('Terrain Map 在绘制期间发生变化，本次草稿已安全丢弃')
      return
    }
    const cells = context.draft.flatMap((terrainId, index) => (
      terrainId === context.original[index]
        ? []
        : [{ x: index % context.width, y: Math.floor(index / context.width), terrainId }]
    ))
    if (cells.length === 0) {
      setStatus('Terrain 画笔没有改变格子，项目 revision 保持不变')
      return
    }
    if (apply('terrain-maps.cells.patch', { terrainMapId: context.terrainMapId, cells })) {
      setStatus(`Terrain ${context.terrainId === null ? '橡皮' : `${context.terrainId} 画笔`}完成 · ${cells.length} 格 · 1 个撤销单元`)
    }
  }, [apply])

  const cancelTerrainMapStroke = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const context = terrainMapStrokeRef.current
    if (!context || context.pointerId !== event.pointerId) return
    terrainMapStrokeRef.current = null
    setTerrainMapDraftCells(null)
    setStatus('Terrain 绘制已取消，项目 revision 保持不变')
  }, [])

  const exportTerrainMap = useCallback(async () => {
    if (!activeTerrainMap) return
    setIsExporting(true)
    try {
      const current = historyRef.current.document
      const bundle = createPixelTerrainMapExportBundle(current, { terrainMapId: activeTerrainMap.id })
      await downloadPixelTerrainMapExportBundle(bundle)
      setStatus(`Terrain Map 已导出：PNG、来源 Atlas、严格 JSON 与内嵌 Tileset 的 Tiled TMJ`)
    } catch (error) {
      setStatus(readablePixelError(error, 'Terrain Map 导出失败'))
    } finally {
      setIsExporting(false)
    }
  }, [activeTerrainMap])

  const exportPixelGameBundle = useCallback(async () => {
    setIsExporting(true)
    try {
      const current = historyRef.current.document
      const mapWidth = Math.max(1, Math.ceil(Math.sqrt(current.frames.length)))
      const mapHeight = Math.max(1, Math.ceil(current.frames.length / mapWidth))
      const bundle = createPixelGameExportBundle(current, {
        columns: Math.min(4, current.frames.length),
        padding: 1,
        spacing: 1,
        mapWidth,
        mapHeight,
        animationTagId: current.animationTags.some((tag) => tag.id === activeAnimationTagId)
          ? activeAnimationTagId ?? undefined
          : current.animationTags[0]?.id,
      })
      await downloadPixelGameExportBundle(bundle)
      setStatus('游戏资产包完成：项目、Sprite、八方向/锚点 manifest、Tiled Tileset/Tilemap 与离线预览页')
    } catch (error) {
      setStatus(readablePixelError(error, '游戏资产包导出失败'))
    } finally {
      setIsExporting(false)
    }
  }, [activeAnimationTagId])

  const exportPixelEngineBridge = useCallback(async () => {
    setIsExporting(true)
    try {
      const current = historyRef.current.document
      const mapWidth = Math.max(1, Math.ceil(Math.sqrt(current.frames.length)))
      const mapHeight = Math.max(1, Math.ceil(current.frames.length / mapWidth))
      const bundle = createPixelEngineBridgeExportBundle(current, {
        columns: Math.min(4, current.frames.length),
        padding: 1,
        spacing: 1,
        mapWidth,
        mapHeight,
        pixelsPerUnit: current.height,
        animationTagId: current.animationTags.some((tag) => tag.id === activeAnimationTagId)
          ? activeAnimationTagId ?? undefined
          : current.animationTags[0]?.id,
      })
      await downloadPixelEngineBridgeExportBundle(bundle)
      setStatus('引擎桥接包完成：Sprite、来源清单、Godot/Unity 导入脚本、RPG Maker MZ 3×4 角色图与说明')
    } catch (error) {
      setStatus(readablePixelError(error, '引擎桥接包导出失败'))
    } finally {
      setIsExporting(false)
    }
  }, [activeAnimationTagId])

  const exportActiveAnimationClip = useCallback(async () => {
    const current = historyRef.current.document
    const tag = current.animationTags.find((item) => item.id === activeAnimationTagId) ?? current.animationTags[0]
    if (!tag) {
      setStatus('请先建立动画片段，再导出活动片段包')
      return
    }
    setIsExporting(true)
    try {
      const fromIndex = current.frames.findIndex((frame) => frame.id === tag.fromFrameId)
      const toIndex = current.frames.findIndex((frame) => frame.id === tag.toFrameId)
      const bundle = createPixelAnimationClipExportBundle(current, tag.id, {
        columns: Math.min(4, toIndex - fromIndex + 1),
        padding: 1,
        spacing: 1,
      })
      await downloadPixelAnimationClipExportBundle(bundle)
      setStatus(`活动片段包完成：「${tag.name}」专属 Atlas、精确播放序列、事件与调色板循环 metadata`)
    } catch (error) {
      setStatus(readablePixelError(error, '活动片段包导出失败'))
    } finally {
      setIsExporting(false)
    }
  }, [activeAnimationTagId])

  return (
    <section
      className={`aq-pixel-mode ${className}`.trim()}
      aria-label="光阴砚像素模式工作台"
      onKeyDown={(event) => {
        if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
        const key = event.key.toLowerCase()
        if (event.ctrlKey || event.metaKey) {
          if (key === 'c' && selection) {
            event.preventDefault()
            captureSelectionClipboard(false)
            return
          }
          if (key === 'x' && selection) {
            event.preventDefault()
            captureSelectionClipboard(true)
            return
          }
          if (key === 'v' && selectionClipboard) {
            event.preventDefault()
            pasteSelectionClipboard()
            return
          }
        }
        if (key === 'b') setTool('pencil')
        if (key === 'e') setTool('eraser')
        if (key === 'g') setTool('fill')
        if (key === 'i') setTool('picker')
        if (key === 'l') setTool('line')
        if (key === 'r') setTool('rectangle')
        if (key === 'm') setTool('marquee')
        if (key === 'escape') {
          setSelection(null)
          setDragDraft(null)
          dragContextRef.current = null
          setStatus('已取消区域选择')
        }
        if ((key === 'delete' || key === 'backspace') && selection) {
          event.preventDefault()
          applySelectionOperation('clear')
        }
        if (selection && ['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(key)) {
          event.preventDefault()
          const dx = key === 'arrowleft' ? -1 : key === 'arrowright' ? 1 : 0
          const dy = key === 'arrowup' ? -1 : key === 'arrowdown' ? 1 : 0
          applySelectionOperation(event.altKey ? 'copy' : 'move', { dx, dy })
        }
        if ((event.ctrlKey || event.metaKey) && key === 'z') {
          event.preventDefault()
          if (event.shiftKey) redo()
          else undo()
        }
      }}
    >
      <header className="aq-pixel-header">
        <div className="aq-pixel-brand">
          {onBack ? (
            <button type="button" className="aq-pixel-back" onClick={onBack} aria-label="返回光阴砚主页">
              <ArrowLeft size={17} />
            </button>
          ) : null}
          <span className="aq-pixel-brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <div>
            <span>AEONQUILL / PIXEL</span>
            <strong>像素模式</strong>
          </div>
        </div>
        <div className="aq-pixel-document-title">
          <span>{document.name}</span>
          <small>{document.width} × {document.height} · revision {document.revision}</small>
        </div>
        <div className="aq-pixel-history" aria-label="编辑历史">
          <AgentPlanComposer
            projectId={workspaceProjectId}
            documentId={document.id}
            modeId="pixel"
            baseRevision={document.revision}
            launcherLabel="文本智能体"
            onBeforeCompose={() => flushWorkspaceModeDocument(document.id)}
            onPlan={openAgentPlan}
          />
          <button type="button" onClick={undo} disabled={history.undo.length === 0} aria-label="撤销">
            <Undo2 size={17} />
          </button>
          <button type="button" onClick={redo} disabled={history.redo.length === 0} aria-label="重做">
            <Redo2 size={17} />
          </button>
          <label className={`aq-pixel-file-action ${isImporting ? 'is-disabled' : ''}`}>
            <FolderOpen size={16} /> 打开项目
            <input
              type="file"
              accept=".aeonpixel.json,.pixel.json,application/json"
              disabled={isImporting}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0]
                event.currentTarget.value = ''
                if (file) void loadProject(file)
              }}
            />
          </label>
          <button type="button" className="aq-pixel-project-export" onClick={() => void exportPixelProject()} disabled={isExporting} aria-label="仅导出像素项目 JSON">
            <Download size={16} /> 项目
          </button>
          <button type="button" className="aq-pixel-export" onClick={() => void exportPixelBundle()} disabled={isExporting}>
            <Download size={16} /> 成套导出
          </button>
        </div>
      </header>

      <div className="aq-pixel-toolbar" aria-label="像素绘制工具">
        <div className="aq-pixel-tool-group">
          <button type="button" className={tool === 'pencil' ? 'is-active' : ''} onClick={() => setTool('pencil')}>
            <Pencil size={17} /> 铅笔 <kbd>B</kbd>
          </button>
          <button type="button" className={tool === 'eraser' ? 'is-active' : ''} onClick={() => setTool('eraser')}>
            <Eraser size={17} /> 橡皮 <kbd>E</kbd>
          </button>
          <button type="button" className={tool === 'fill' ? 'is-active' : ''} onClick={() => setTool('fill')}>
            <PaintBucket size={17} /> 填充 <kbd>G</kbd>
          </button>
          <button type="button" className={tool === 'picker' ? 'is-active' : ''} onClick={() => setTool('picker')}>
            <Pipette size={17} /> 吸管 <kbd>I</kbd>
          </button>
          <button type="button" className={tool === 'line' ? 'is-active' : ''} onClick={() => setTool('line')}>
            <Minus size={17} className="aq-pixel-line-icon" /> 直线 <kbd>L</kbd>
          </button>
          <button type="button" className={tool === 'rectangle' ? 'is-active' : ''} onClick={() => setTool('rectangle')}>
            <Square size={17} /> 矩形 <kbd>R</kbd>
          </button>
          <button type="button" className={tool === 'marquee' ? 'is-active' : ''} onClick={() => setTool('marquee')}>
            <SquareDashedMousePointer size={17} /> 选区 <kbd>M</kbd>
          </button>
        </div>
        <span className="aq-pixel-toolbar-divider" />
        <label className="aq-pixel-toggle">
          <input
            type="checkbox"
            checked={document.onionSkin.enabled}
            onChange={(event) => apply('onion-skin.set', { patch: { enabled: event.target.checked } })}
          />
          <span />
          洋葱皮
        </label>
        <button
          type="button"
          className={`aq-pixel-play ${isPlaying ? 'is-active' : ''}`}
          onClick={() => {
            if (isPlaying) stopPlayback()
            else {
              setPreviewFrameCursor(Math.max(0, playbackFrameIds.indexOf(document.activeFrameId)))
              setIsPlaying(true)
            }
          }}
          aria-pressed={isPlaying}
        >
          {isPlaying ? <Pause size={15} /> : <Play size={15} />}
          {isPlaying ? '停止预览' : '播放动画'}
        </button>
        <span className="aq-pixel-status" role="status">{status}</span>
      </div>

      <div className="aq-pixel-layout">
        <aside className="aq-pixel-panel aq-pixel-palette-panel">
          <section className="aq-pixel-import-card" aria-label="PNG 与 WebP 确定性像素转换">
            <div className="aq-pixel-import-heading">
              <span><Settings2 size={15} /> 图像转像素</span>
              <small>确定性</small>
            </div>
            <label className={`aq-pixel-source-picker ${isImporting ? 'is-disabled' : ''}`}>
              <FileImage size={16} />
              <span>{importSourceSummary ? '更换 PNG / WebP' : '选择 PNG / WebP'}</span>
              <input
                type="file"
                accept="image/png,image/webp,.png,.webp"
                disabled={isImporting}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0]
                  event.currentTarget.value = ''
                  if (file) void loadImageSource(file)
                }}
              />
            </label>
            {importSourceSummary ? (
              <p className="aq-pixel-source-summary">
                <strong title={importSourceSummary.name}>{importSourceSummary.name}</strong>
                <span>{importSourceSummary.width} × {importSourceSummary.height} RGBA · 仅保留会话内存</span>
              </p>
            ) : null}
            <div className="aq-pixel-import-grid">
              <label>
                <span>宽</span>
                <input
                  type="number"
                  min={1}
                  max={512}
                  value={importSettings.targetWidth}
                  onChange={(event) => setImportSettings((current) => ({
                    ...current,
                    targetWidth: Number.isFinite(event.target.valueAsNumber) ? event.target.valueAsNumber : current.targetWidth,
                  }))}
                />
              </label>
              <label>
                <span>高</span>
                <input
                  type="number"
                  min={1}
                  max={512}
                  value={importSettings.targetHeight}
                  onChange={(event) => setImportSettings((current) => ({
                    ...current,
                    targetHeight: Number.isFinite(event.target.valueAsNumber) ? event.target.valueAsNumber : current.targetHeight,
                  }))}
                />
              </label>
              <label>
                <span>色数</span>
                <input
                  type="number"
                  min={1}
                  max={256}
                  value={importSettings.colorCount}
                  disabled={importSettings.paletteMode === 'current'}
                  onChange={(event) => setImportSettings((current) => ({
                    ...current,
                    colorCount: Number.isFinite(event.target.valueAsNumber) ? event.target.valueAsNumber : current.colorCount,
                  }))}
                />
              </label>
              <label>
                <span>透明阈值</span>
                <input
                  type="number"
                  min={0}
                  max={255}
                  value={importSettings.alphaThreshold}
                  onChange={(event) => setImportSettings((current) => ({
                    ...current,
                    alphaThreshold: Number.isFinite(event.target.valueAsNumber) ? event.target.valueAsNumber : current.alphaThreshold,
                  }))}
                />
              </label>
            </div>
            <label className="aq-pixel-import-select">
              <span>缩放</span>
              <select
                value={importSettings.fit}
                onChange={(event) => setImportSettings((current) => ({ ...current, fit: event.target.value as PixelFitMode }))}
              >
                <option value="contain">完整留白</option>
                <option value="cover">居中裁满</option>
                <option value="stretch">拉伸铺满</option>
              </select>
            </label>
            <label className="aq-pixel-import-select">
              <span>调色板</span>
              <select
                value={importSettings.paletteMode}
                onChange={(event) => setImportSettings((current) => ({
                  ...current,
                  paletteMode: event.target.value as PixelImportSettings['paletteMode'],
                }))}
              >
                <option value="generated">从图像确定性提取</option>
                <option value="current">沿用当前 {document.palette.length} 色</option>
              </select>
            </label>
            <label className="aq-pixel-import-select">
              <span>抖动</span>
              <select
                value={importSettings.dither}
                onChange={(event) => setImportSettings((current) => ({ ...current, dither: event.target.value as PixelDitherMode }))}
              >
                <option value="none">无抖动</option>
                <option value="bayer4">Bayer 4×4</option>
                <option value="floyd-steinberg">Floyd–Steinberg</option>
              </select>
            </label>
            <button
              type="button"
              className="aq-pixel-convert"
              disabled={!importSourceSummary || isImporting}
              onClick={() => void convertImportedSource()}
            >
              {isImporting ? '处理中…' : '转换为严格 PixelDocument'}
            </button>
            {lastConversion ? (
              <p className="aq-pixel-conversion-report">
                {lastConversion.opaquePixels} 实像素 / {lastConversion.transparentPixels} 透明 · {lastConversion.paletteSize} 色
              </p>
            ) : null}
          </section>
          <div className="aq-pixel-panel-heading">
            <span><Grid3X3 size={15} /> 调色板</span>
            <small>{document.palette.length} 色</small>
          </div>
          <div className="aq-pixel-swatches" role="listbox" aria-label="像素调色板">
            {document.palette.map((color) => (
              <button
                type="button"
                role="option"
                aria-selected={color.id === activeColorId}
                className={color.id === activeColorId ? 'is-active' : ''}
                key={color.id}
                onClick={() => {
                  setActiveColorId(color.id)
                  setTool('pencil')
                }}
              >
                <span style={{ backgroundColor: color.color }} />
                <i>{color.name}</i>
              </button>
            ))}
          </div>
          <label className="aq-pixel-color-edit">
            <span>替换当前色</span>
            <input
              type="color"
              value={selectedColor.color.slice(0, 7)}
              onChange={(event) => apply('palette.replace', {
                colorId: selectedColor.id,
                color: `${event.target.value}FF`,
              })}
            />
            <code>{selectedColor.color}</code>
          </label>
          <section className="aq-pixel-cycle-card" aria-label="调色板循环">
            <div className="aq-pixel-cycle-heading">
              <span><Sparkles size={14} /> 调色板循环</span>
              <button type="button" onClick={createPaletteCycle} aria-label="新建调色板循环">
                <Plus size={12} /> 新建
              </button>
            </div>
            {document.paletteCycles.length > 0 ? (
              <>
                <div className="aq-pixel-cycle-tabs">
                  {document.paletteCycles.map((cycle) => (
                    <button
                      type="button"
                      key={cycle.id}
                      className={cycle.id === activePaletteCycle?.id ? 'is-active' : ''}
                      aria-pressed={cycle.id === activePaletteCycle?.id}
                      aria-label={`选择调色板循环 ${cycle.name}`}
                      onClick={() => setActivePaletteCycleId(cycle.id)}
                    >{cycle.name}</button>
                  ))}
                </div>
                {activePaletteCycle ? (
                  <div className="aq-pixel-cycle-editor">
                    <label>
                      <span>名称</span>
                      <input
                        key={`${activePaletteCycle.id}-${activePaletteCycle.name}`}
                        aria-label="调色板循环名称"
                        defaultValue={activePaletteCycle.name}
                        maxLength={80}
                        onBlur={(event) => {
                          const name = event.currentTarget.value.trim()
                          if (!name) event.currentTarget.value = activePaletteCycle.name
                          else if (name !== activePaletteCycle.name) patchActivePaletteCycle({ name })
                        }}
                      />
                    </label>
                    <div className="aq-pixel-cycle-row">
                      <label>
                        <span>方向</span>
                        <select
                          aria-label="调色板循环方向"
                          value={activePaletteCycle.direction}
                          onChange={(event) => patchActivePaletteCycle({
                            direction: event.currentTarget.value as PixelPaletteCycleDirection,
                          })}
                        >
                          {PIXEL_PALETTE_CYCLE_DIRECTIONS.map((direction) => (
                            <option key={direction} value={direction}>{PIXEL_CYCLE_DIRECTION_LABELS[direction]}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        <span>步长</span>
                        <input
                          key={`${activePaletteCycle.id}-${activePaletteCycle.stepDurationMs}`}
                          type="number"
                          min={20}
                          max={60_000}
                          aria-label="调色板循环步长"
                          defaultValue={activePaletteCycle.stepDurationMs}
                          onBlur={(event) => {
                            const stepDurationMs = Number(event.currentTarget.value)
                            if (Number.isSafeInteger(stepDurationMs) && stepDurationMs >= 20 && stepDurationMs <= 60_000) {
                              if (stepDurationMs !== activePaletteCycle.stepDurationMs) patchActivePaletteCycle({ stepDurationMs })
                            } else event.currentTarget.value = String(activePaletteCycle.stepDurationMs)
                          }}
                        />
                      </label>
                    </div>
                    <div className="aq-pixel-cycle-colors" aria-label="循环颜色顺序">
                      {document.palette.map((color) => {
                        const order = activePaletteCycle.colorIds.indexOf(color.id)
                        const ownedByOther = document.paletteCycles.some(
                          (cycle) => cycle.id !== activePaletteCycle.id && cycle.colorIds.includes(color.id),
                        )
                        return (
                          <button
                            type="button"
                            key={color.id}
                            className={order >= 0 ? 'is-active' : ''}
                            disabled={ownedByOther}
                            aria-pressed={order >= 0}
                            aria-label={`${order >= 0 ? '从循环移除颜色' : '将颜色加入循环'} ${color.name}`}
                            title={ownedByOther ? '已被其他循环占用' : color.name}
                            onClick={() => togglePaletteCycleColor(color.id)}
                          >
                            <span style={{ backgroundColor: color.color }} />
                            {order >= 0 ? <b>{order + 1}</b> : null}
                          </button>
                        )
                      })}
                    </div>
                    <div className="aq-pixel-cycle-footer">
                      <label>
                        <input
                          type="checkbox"
                          checked={activePaletteCycle.enabled}
                          onChange={(event) => patchActivePaletteCycle({ enabled: event.currentTarget.checked })}
                        /> 启用预览
                      </label>
                      <button type="button" className="is-danger" onClick={removeActivePaletteCycle} aria-label="删除当前调色板循环">
                        <Trash2 size={12} /> 删除
                      </button>
                    </div>
                    <small>{activePaletteCycle.colorIds.length} 色 · 播放时实时轮换 · 不改写原像素</small>
                  </div>
                ) : null}
              </>
            ) : <p className="aq-pixel-cycle-empty">用颜色索引驱动火焰、水面与霓虹动画，无需复制像素帧。</p>}
          </section>
          <div className="aq-pixel-contract-note">
            <strong>非破坏性入口</strong>
            <p>图层、帧和像素命令均返回逆命令；主线只需接管文档版本与资产落盘。</p>
          </div>
        </aside>

        <main className="aq-pixel-stage-column">
          <div className="aq-pixel-stage-wrap">
            <div className="aq-pixel-stage-controls" aria-label="笔刷与画布控制">
              <label className="aq-pixel-brush-size">
                <span>画笔</span>
                <select value={brushSize} onChange={(event) => setBrushSize(Number(event.target.value))}>
                  {[1, 2, 3, 4, 6, 8].map((size) => <option key={size} value={size}>{size}px</option>)}
                </select>
              </label>
              <span className="aq-pixel-control-divider" />
              <button
                type="button"
                className={mirrorHorizontal ? 'is-active' : ''}
                aria-pressed={mirrorHorizontal}
                onClick={() => setMirrorHorizontal((value) => !value)}
                title="水平对称绘制"
              ><FlipHorizontal2 size={15} /><span>水平对称</span></button>
              <button
                type="button"
                className={mirrorVertical ? 'is-active' : ''}
                aria-pressed={mirrorVertical}
                onClick={() => setMirrorVertical((value) => !value)}
                title="垂直对称绘制"
              ><FlipVertical2 size={15} /><span>垂直对称</span></button>
              <span className="aq-pixel-control-divider" />
              <button
                type="button"
                className={gridVisible ? 'is-active' : ''}
                aria-pressed={gridVisible}
                onClick={() => setGridVisible((value) => !value)}
                title="显示像素网格"
              ><Grid3X3 size={15} /><span>网格</span></button>
              <button
                type="button"
                className={gameOverlayVisible ? 'is-active' : ''}
                aria-pressed={gameOverlayVisible}
                onClick={() => setGameOverlayVisible((value) => !value)}
                title="显示锚点与碰撞区"
              ><Crosshair size={15} /><span>游戏辅助线</span></button>
              <span className="aq-pixel-control-divider" />
              <button type="button" onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))} aria-label="缩小画布">
                <ZoomOut size={15} />
              </button>
              <output>{Math.round(zoom * 100)}%</output>
              <button type="button" onClick={() => setZoom((value) => Math.min(2, value + 0.25))} aria-label="放大画布">
                <ZoomIn size={15} />
              </button>
            </div>
            <div
              className="aq-pixel-stage"
              style={{
                '--aq-pixel-columns': document.width,
                '--aq-pixel-rows': document.height,
                aspectRatio: `${document.width} / ${document.height}`,
                width: `min(${Math.round(62 * zoom)}vh, ${Math.round(620 * zoom)}px)`,
              } as CSSProperties}
            >
              <canvas
                ref={canvasRef}
                tabIndex={0}
                aria-label={`${document.width} 乘 ${document.height} 像素绘制区，当前图层 ${selectedLayer.name}`}
                onPointerDown={(event) => {
                  event.preventDefault()
                  event.currentTarget.focus()
                  beginCanvasGesture(event)
                }}
                onPointerMove={updateCanvasGesture}
                onPointerUp={(event) => {
                  updateCanvasGesture(event)
                  finishCanvasGesture()
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
                }}
                onPointerCancel={finishCanvasGesture}
              />
              {gridVisible ? <span className="aq-pixel-grid-overlay" aria-hidden="true" /> : null}
              {selectionPreview ? (
                <span
                  className={`aq-pixel-marquee ${dragDraft && dragDraft.tool !== 'marquee' ? 'is-shape-preview' : ''}`.trim()}
                  aria-hidden="true"
                  style={{
                    left: `${(selectionPreview.x / document.width) * 100}%`,
                    top: `${(selectionPreview.y / document.height) * 100}%`,
                    width: `${(selectionPreview.width / document.width) * 100}%`,
                    height: `${(selectionPreview.height / document.height) * 100}%`,
                  }}
                />
              ) : null}
            </div>
            {selection || selectionClipboard ? (
              <div className="aq-pixel-selection-actions" aria-label="区域变换与跨帧剪贴板">
                {selection ? (
                  <>
                    <span><Move size={14} /> {selection.width}×{selection.height}</span>
                    <button type="button" title="向左移动一像素" onClick={() => applySelectionOperation('move', { dx: -1 })}><ArrowLeftSmall size={14} /></button>
                    <button type="button" title="向上移动一像素" onClick={() => applySelectionOperation('move', { dy: -1 })}><ArrowUp size={14} /></button>
                    <button type="button" title="向下移动一像素" onClick={() => applySelectionOperation('move', { dy: 1 })}><ArrowDown size={14} /></button>
                    <button type="button" title="向右移动一像素" onClick={() => applySelectionOperation('move', { dx: 1 })}><ArrowRight size={14} /></button>
                    <span className="aq-pixel-control-divider" />
                    <button type="button" title="复制并向右移动一像素" onClick={() => applySelectionOperation('copy', { dx: 1 })}><Copy size={14} /></button>
                    <button type="button" title="水平翻转" onClick={() => applySelectionOperation('flip-horizontal')}><FlipHorizontal2 size={14} /></button>
                    <button type="button" title="垂直翻转" onClick={() => applySelectionOperation('flip-vertical')}><FlipVertical2 size={14} /></button>
                    <button type="button" className="is-danger" title="清除选区" onClick={() => applySelectionOperation('clear')}><Trash2 size={14} /></button>
                    <span className="aq-pixel-control-divider" />
                  </>
                ) : null}
                <button
                  type="button"
                  aria-label="复制选区到剪贴板"
                  title="复制选区到跨帧剪贴板（Ctrl+C）"
                  disabled={!selection}
                  onClick={() => captureSelectionClipboard(false)}
                ><ClipboardCopy size={14} /></button>
                <button
                  type="button"
                  aria-label="剪切选区到剪贴板"
                  title="剪切选区到跨帧剪贴板（Ctrl+X）"
                  disabled={!selection}
                  onClick={() => captureSelectionClipboard(true)}
                ><Scissors size={14} /></button>
                {selectionClipboard ? (
                  <span
                    className="aq-pixel-clipboard-badge"
                    title={`来源 ${selectionClipboard.source.frameId}/${selectionClipboard.source.layerId} · revision ${selectionClipboard.source.documentRevision}`}
                  ><ClipboardCopy size={13} /> {selectionClipboard.width}×{selectionClipboard.height}</span>
                ) : null}
                <button
                  type="button"
                  aria-label="粘贴跨帧剪贴板"
                  title="粘贴到当前选区左上角；无选区时使用来源原位坐标（Ctrl+V）"
                  disabled={!selectionClipboard}
                  onClick={pasteSelectionClipboard}
                ><ClipboardPaste size={14} /></button>
                <button
                  type="button"
                  className={selectionPasteMode === 'replace' ? 'is-active' : ''}
                  aria-label={selectionPasteMode === 'replace' ? '粘贴模式：透明像素覆盖' : '粘贴模式：仅不透明像素'}
                  aria-pressed={selectionPasteMode === 'replace'}
                  title="切换粘贴时是否用透明像素覆盖目标"
                  disabled={!selectionClipboard}
                  onClick={() => setSelectionPasteMode((value) => value === 'replace' ? 'opaque-only' : 'replace')}
                ><span>{selectionPasteMode === 'replace' ? '覆盖透明' : '仅不透明'}</span></button>
              </div>
            ) : null}
          </div>

          <section className="aq-pixel-timeline" aria-label="动画帧">
            <div className="aq-pixel-panel-heading">
              <span><Film size={15} /> 帧时间线</span>
              <div>
                <label className="aq-pixel-duration" title="当前帧时长">
                  <input
                    key={`${document.activeFrameId}-${document.frames.find((frame) => frame.id === document.activeFrameId)?.durationMs}`}
                    type="number"
                    min={20}
                    max={60_000}
                    defaultValue={document.frames.find((frame) => frame.id === document.activeFrameId)?.durationMs}
                    onBlur={(event) => {
                      const durationMs = event.currentTarget.valueAsNumber
                      const currentDuration = document.frames.find((frame) => frame.id === document.activeFrameId)?.durationMs
                      if (Number.isSafeInteger(durationMs) && durationMs >= 20 && durationMs <= 60_000 && durationMs !== currentDuration) {
                        stopPlayback()
                        apply('frames.patch', { frameId: document.activeFrameId, patch: { durationMs } })
                      }
                    }}
                  />
                  ms
                </label>
                <button
                  type="button"
                  aria-label="复制当前帧"
                  onClick={() => {
                    stopPlayback()
                    const id = uniqueId('frame', document.frames.map((frame) => frame.id), document.revision)
                    apply('frames.add', {
                      frame: { id, name: `姿态 ${document.frames.length + 1}`, durationMs: 140 },
                      copyFromFrameId: document.activeFrameId,
                    })
                  }}
                ><Copy size={14} /></button>
                <button
                  type="button"
                  aria-label="添加空白帧"
                  onClick={() => {
                    stopPlayback()
                    const id = uniqueId('frame', document.frames.map((frame) => frame.id), document.revision)
                    apply('frames.add', { frame: { id, name: `姿态 ${document.frames.length + 1}`, durationMs: 140 } })
                  }}
                ><Plus size={14} /></button>
                <button
                  type="button"
                  aria-label="删除当前帧"
                  disabled={document.frames.length === 1}
                  onClick={() => {
                    stopPlayback()
                    apply('frames.remove', { frameId: document.activeFrameId })
                  }}
                ><Trash2 size={14} /></button>
              </div>
            </div>
            <div className="aq-pixel-frame-strip">
              {document.frames.map((frame, index) => (
                <button
                  type="button"
                  key={frame.id}
                  className={`${frame.id === document.activeFrameId ? 'is-active' : ''} ${isPlaying && frame.id === displayedFrameId ? 'is-previewing' : ''} ${activeAnimationTag && animationRangeFrameIds.includes(frame.id) ? 'is-in-animation' : ''}`.trim()}
                  aria-pressed={frame.id === document.activeFrameId}
                  onClick={() => {
                    stopPlayback()
                    apply('frames.select', { frameId: frame.id })
                  }}
                >
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <strong>{frame.name}</strong>
                  <small>{frame.durationMs} ms</small>
                  {activeAnimationEvents.some((event) => event.frameId === frame.id) ? (
                    <em className="aq-pixel-frame-event-badge" title="动画事件数">
                      {activeAnimationEvents.filter((event) => event.frameId === frame.id).length}
                    </em>
                  ) : null}
                </button>
              ))}
            </div>
            <div className="aq-pixel-animation-workbench" aria-label="动画片段">
              <div className="aq-pixel-animation-tags">
                <span>片段</span>
                <div>
                  {document.animationTags.map((tag) => (
                    <button
                      type="button"
                      key={tag.id}
                      className={tag.id === activeAnimationTag?.id ? 'is-active' : ''}
                      aria-pressed={tag.id === activeAnimationTag?.id}
                      aria-label={`选择动画片段 ${tag.name}`}
                      onClick={() => {
                        stopPlayback()
                        setActiveAnimationTagId(tag.id)
                        const firstFrameId = resolvePixelAnimationFrames(document, tag.id)[0]
                        const firstFrame = document.frames.find((frame) => frame.id === firstFrameId)
                        if (firstFrame) setBatchDurationMs(String(firstFrame.durationMs))
                        setStatus(`已选择动画片段：${tag.name}`)
                      }}
                    >{tag.name}</button>
                  ))}
                  <button type="button" className="is-add" onClick={createAnimationTag} aria-label="新建动画片段">
                    <Plus size={12} /> 新建
                  </button>
                </div>
              </div>
              {activeAnimationTag ? (
                <div className="aq-pixel-animation-editor">
                  <label className="is-name">
                    <span>片段名称</span>
                    <input
                      key={`${activeAnimationTag.id}-${activeAnimationTag.name}`}
                      type="text"
                      defaultValue={activeAnimationTag.name}
                      maxLength={80}
                      onBlur={(event) => {
                        const name = event.currentTarget.value.trim()
                        if (!name) {
                          event.currentTarget.value = activeAnimationTag.name
                          setStatus('片段名称不能为空')
                        } else if (name !== activeAnimationTag.name) {
                          patchActiveAnimationTag({ name })
                        }
                      }}
                    />
                  </label>
                  <label>
                    <span>起始帧</span>
                    <select
                      value={activeAnimationTag.fromFrameId}
                      onChange={(event) => patchActiveAnimationTag({ fromFrameId: event.currentTarget.value })}
                    >
                      {document.frames.map((frame, index) => (
                        <option
                          key={frame.id}
                          value={frame.id}
                          disabled={index > document.frames.findIndex((item) => item.id === activeAnimationTag.toFrameId)}
                        >{String(index + 1).padStart(2, '0')} · {frame.name}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>结束帧</span>
                    <select
                      value={activeAnimationTag.toFrameId}
                      onChange={(event) => patchActiveAnimationTag({ toFrameId: event.currentTarget.value })}
                    >
                      {document.frames.map((frame, index) => (
                        <option
                          key={frame.id}
                          value={frame.id}
                          disabled={index < document.frames.findIndex((item) => item.id === activeAnimationTag.fromFrameId)}
                        >{String(index + 1).padStart(2, '0')} · {frame.name}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>播放方向</span>
                    <select
                      value={activeAnimationTag.direction}
                      onChange={(event) => patchActiveAnimationTag({ direction: event.currentTarget.value as PixelAnimationDirection })}
                    >
                      <option value="forward">正向</option>
                      <option value="reverse">反向</option>
                      <option value="ping-pong">往返</option>
                    </select>
                  </label>
                  <label className="is-loop">
                    <span>循环播放</span>
                    <input
                      type="checkbox"
                      checked={activeAnimationTag.loop}
                      onChange={(event) => patchActiveAnimationTag({ loop: event.currentTarget.checked })}
                    />
                  </label>
                  <label className="is-duration">
                    <span>片段统一时长</span>
                    <span className="aq-pixel-animation-number">
                      <input
                        type="number"
                        min={20}
                        max={60_000}
                        value={batchDurationMs}
                        onChange={(event) => setBatchDurationMs(event.currentTarget.value)}
                      />
                      ms
                    </span>
                  </label>
                  <div className="aq-pixel-animation-actions">
                    <button type="button" onClick={applyAnimationDuration}>应用片段时长</button>
                    <button type="button" onClick={() => copyActiveLayerAcrossAnimation('replace')}>覆盖复制当前图层</button>
                    <button type="button" onClick={() => copyActiveLayerAcrossAnimation('non-transparent')}>透明合并当前图层</button>
                    <button type="button" onClick={() => void exportActiveAnimationClip()} disabled={isExporting}>
                      <Download size={12} /> 活动片段包
                    </button>
                    <button type="button" className="is-danger" onClick={removeActiveAnimationTag} aria-label="删除当前动画片段">
                      <Trash2 size={12} /> 删除片段
                    </button>
                  </div>
                  <small className="aq-pixel-animation-summary">
                    {animationRangeFrameIds.length} 个基础帧 · 播放序列 {playbackFrameIds.length} 帧 · {activeAnimationEvents.length} 个事件 · 当前源图层「{selectedLayer.name}」
                  </small>
                  <section className="aq-pixel-event-editor" aria-label="动画事件">
                    <div className="aq-pixel-event-heading">
                      <span><Crosshair size={13} /> 动画事件</span>
                      <button type="button" onClick={createAnimationEvent} aria-label="添加动画事件">
                        <Plus size={12} /> 添加事件
                      </button>
                    </div>
                    {activeAnimationEvents.length > 0 ? (
                      <div className="aq-pixel-event-list">
                        {activeAnimationEvents.map((animationEvent) => (
                          <div className="aq-pixel-event-row" key={animationEvent.id} data-event-id={animationEvent.id}>
                            <label className="is-name">
                              <span>名称</span>
                              <input
                                key={`${animationEvent.id}-${animationEvent.name}`}
                                aria-label={`事件名称 ${animationEvent.name}`}
                                defaultValue={animationEvent.name}
                                maxLength={64}
                                onBlur={(event) => {
                                  const name = event.currentTarget.value.trim()
                                  if (!name) event.currentTarget.value = animationEvent.name
                                  else if (name !== animationEvent.name) patchAnimationEvent(animationEvent.id, { name })
                                }}
                              />
                            </label>
                            <label>
                              <span>类型</span>
                              <select
                                aria-label={`事件类型 ${animationEvent.name}`}
                                value={animationEvent.type}
                                onChange={(event) => patchAnimationEvent(animationEvent.id, {
                                  type: event.currentTarget.value as PixelAnimationEventType,
                                })}
                              >
                                {PIXEL_ANIMATION_EVENT_TYPES.map((eventType) => (
                                  <option key={eventType} value={eventType}>{PIXEL_EVENT_TYPE_LABELS[eventType]}</option>
                                ))}
                              </select>
                            </label>
                            <label>
                              <span>触发帧</span>
                              <select
                                aria-label={`事件触发帧 ${animationEvent.name}`}
                                value={animationEvent.frameId}
                                onChange={(event) => patchAnimationEvent(animationEvent.id, { frameId: event.currentTarget.value })}
                              >
                                {document.frames.filter((frame) => animationRangeFrameIds.includes(frame.id)).map((frame) => (
                                  <option key={frame.id} value={frame.id}>{frame.name}</option>
                                ))}
                              </select>
                            </label>
                            <label className="is-value">
                              <span>载荷</span>
                              <input
                                key={`${animationEvent.id}-${animationEvent.value}`}
                                aria-label={`事件载荷 ${animationEvent.name}`}
                                defaultValue={animationEvent.value}
                                maxLength={160}
                                placeholder="例如 sfx.sword"
                                onBlur={(event) => {
                                  if (event.currentTarget.value !== animationEvent.value) {
                                    patchAnimationEvent(animationEvent.id, { value: event.currentTarget.value })
                                  }
                                }}
                              />
                            </label>
                            <button
                              type="button"
                              className="is-danger"
                              aria-label={`删除动画事件 ${animationEvent.name}`}
                              onClick={() => removeAnimationEvent(animationEvent.id)}
                            ><Trash2 size={12} /></button>
                          </div>
                        ))}
                      </div>
                    ) : <p>为关键帧绑定标记、音效、命中或自定义载荷；导出时保留稳定 ID。</p>}
                  </section>
                </div>
              ) : (
                <p className="aq-pixel-animation-empty">建立片段后，可以限定帧范围、往返播放、批量时长与跨帧图层复制。</p>
              )}
            </div>
          </section>
        </main>

        <aside className="aq-pixel-panel aq-pixel-layers-panel">
          <section className="aq-pixel-group-section" aria-label="图层组">
            <div className="aq-pixel-panel-heading">
              <span><FolderOpen size={15} /> 图层组</span>
              <button
                type="button"
                aria-label="添加图层组"
                onClick={() => {
                  const id = uniqueId('group', document.layerGroups.map((group) => group.id), document.revision)
                  apply('groups.add', {
                    group: { id, name: `图层组 ${document.layerGroups.length + 1}`, visible: true, locked: false },
                  })
                }}
              ><Plus size={14} /></button>
            </div>
            {document.layerGroups.length > 0 ? (
              <div className="aq-pixel-group-list">
                {document.layerGroups.map((group) => {
                  const groupLayerCount = document.layers.filter((layer) => layer.groupId === group.id).length
                  return (
                    <div className={selectedLayerGroup?.id === group.id ? 'is-active' : ''} key={group.id} data-group-id={group.id}>
                      <span className="aq-pixel-group-icon"><FolderOpen size={14} /></span>
                      <label>
                        <input
                          aria-label={`${group.name}名称`}
                          key={`${group.id}-${group.name}`}
                          defaultValue={group.name}
                          maxLength={80}
                          onBlur={(event) => {
                            const name = event.currentTarget.value.trim()
                            if (name && name !== group.name) apply('groups.patch', { groupId: group.id, patch: { name } })
                            else event.currentTarget.value = group.name
                          }}
                        />
                        <small>{groupLayerCount} 个图层</small>
                      </label>
                      <button
                        type="button"
                        aria-label={group.visible ? `隐藏图层组 ${group.name}` : `显示图层组 ${group.name}`}
                        onClick={() => apply('groups.patch', { groupId: group.id, patch: { visible: !group.visible } })}
                      >{group.visible ? <Eye size={13} /> : <EyeOff size={13} />}</button>
                      <button
                        type="button"
                        aria-label={group.locked ? `解锁图层组 ${group.name}` : `锁定图层组 ${group.name}`}
                        onClick={() => apply('groups.patch', { groupId: group.id, patch: { locked: !group.locked } })}
                      >{group.locked ? <Lock size={13} /> : <Unlock size={13} />}</button>
                      <button
                        type="button"
                        aria-label={`删除图层组 ${group.name}`}
                        onClick={() => apply('groups.remove', { groupId: group.id })}
                      ><Trash2 size={13} /></button>
                    </div>
                  )
                })}
              </div>
            ) : (
              <p className="aq-pixel-group-empty">建立图层组后，可统一显隐、锁定并整理角色部件。</p>
            )}
          </section>
          <div className="aq-pixel-panel-heading">
            <span><Layers size={15} /> 图层</span>
            <div>
              <button
                type="button"
                aria-label="添加图层"
                onClick={() => {
                  const id = uniqueId('layer', document.layers.map((layer) => layer.id), document.revision)
                  apply('layers.add', {
                    layer: {
                      id,
                      name: `图层 ${document.layers.length + 1}`,
                      visible: true,
                      locked: false,
                      opacity: 1,
                      groupId: selectedLayerGroup?.id ?? null,
                      blendMode: 'normal',
                    },
                  })
                }}
              ><Plus size={14} /></button>
              <button
                type="button"
                aria-label="删除当前图层"
                disabled={document.layers.length === 1}
                onClick={() => apply('layers.remove', { layerId: document.activeLayerId })}
              ><Trash2 size={14} /></button>
            </div>
          </div>
          <div className="aq-pixel-layer-list">
            {[...document.layers].reverse().map((layer) => (
              <div className={layer.id === document.activeLayerId ? 'is-active' : ''} key={layer.id}>
                <button
                  type="button"
                  className="aq-pixel-layer-main"
                  aria-pressed={layer.id === document.activeLayerId}
                  onClick={() => apply('layers.select', { layerId: layer.id })}
                >
                  <span className="aq-pixel-layer-thumb"><Grid3X3 size={14} /></span>
                  <span>
                    <strong>{layer.name}</strong>
                    <small>{Math.round(layer.opacity * 100)}% · {PIXEL_BLEND_LABELS[layer.blendMode]}</small>
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={layer.visible ? `隐藏 ${layer.name}` : `显示 ${layer.name}`}
                  onClick={() => apply('layers.patch', { layerId: layer.id, patch: { visible: !layer.visible } })}
                >{layer.visible ? <Eye size={14} /> : <EyeOff size={14} />}</button>
                <button
                  type="button"
                  aria-label={layer.locked ? `解锁 ${layer.name}` : `锁定 ${layer.name}`}
                  onClick={() => apply('layers.patch', { layerId: layer.id, patch: { locked: !layer.locked } })}
                >{layer.locked ? <Lock size={14} /> : <Unlock size={14} />}</button>
              </div>
            ))}
          </div>
          <div className="aq-pixel-layer-editor" aria-label="当前图层属性">
            <label>
              <span>图层名称</span>
              <input
                key={`${selectedLayer.id}-${selectedLayer.name}`}
                defaultValue={selectedLayer.name}
                maxLength={80}
                onBlur={(event) => {
                  const name = event.currentTarget.value.trim()
                  if (name && name !== selectedLayer.name) apply('layers.patch', { layerId: selectedLayer.id, patch: { name } })
                  else event.currentTarget.value = selectedLayer.name
                }}
              />
            </label>
            <label>
              <span>不透明度 <strong>{Math.round(selectedLayer.opacity * 100)}%</strong></span>
              <input
                key={`${selectedLayer.id}-${selectedLayer.opacity}`}
                type="range"
                min={0}
                max={100}
                step={1}
                defaultValue={Math.round(selectedLayer.opacity * 100)}
                onBlur={(event) => {
                  const opacity = event.currentTarget.valueAsNumber / 100
                  if (Number.isFinite(opacity) && opacity !== selectedLayer.opacity) {
                    apply('layers.patch', { layerId: selectedLayer.id, patch: { opacity } })
                  }
                }}
              />
            </label>
            <div className="aq-pixel-layer-routing">
              <label>
                <span>所属图层组</span>
                <select
                  aria-label="所属图层组"
                  value={selectedLayer.groupId ?? ''}
                  onChange={(event) => apply('layers.patch', {
                    layerId: selectedLayer.id,
                    patch: { groupId: event.currentTarget.value || null },
                  })}
                >
                  <option value="">不分组</option>
                  {document.layerGroups.map((group) => <option value={group.id} key={group.id}>{group.name}</option>)}
                </select>
              </label>
              <label>
                <span>混合模式</span>
                <select
                  aria-label="混合模式"
                  value={selectedLayer.blendMode}
                  onChange={(event) => apply('layers.patch', {
                    layerId: selectedLayer.id,
                    patch: { blendMode: event.currentTarget.value as PixelBlendMode },
                  })}
                >
                  {PIXEL_BLEND_MODES.map((mode) => <option value={mode} key={mode}>{PIXEL_BLEND_LABELS[mode]}</option>)}
                </select>
              </label>
            </div>
            <div>
              <button
                type="button"
                disabled={document.layers.findIndex((layer) => layer.id === selectedLayer.id) === document.layers.length - 1}
                onClick={() => {
                  const ids = document.layers.map((layer) => layer.id)
                  const index = ids.indexOf(selectedLayer.id)
                  if (index < 0 || index >= ids.length - 1) return
                  ;[ids[index], ids[index + 1]] = [ids[index + 1], ids[index]]
                  apply('layers.reorder', { layerIds: ids })
                }}
              ><ArrowUp size={14} /> 上移</button>
              <button
                type="button"
                disabled={document.layers.findIndex((layer) => layer.id === selectedLayer.id) <= 0}
                onClick={() => {
                  const ids = document.layers.map((layer) => layer.id)
                  const index = ids.indexOf(selectedLayer.id)
                  if (index <= 0) return
                  ;[ids[index], ids[index - 1]] = [ids[index - 1], ids[index]]
                  apply('layers.reorder', { layerIds: ids })
                }}
              ><ArrowDown size={14} /> 下移</button>
            </div>
          </div>
          <section className="aq-pixel-gameplay-editor" aria-label="当前帧游戏元数据">
            <div className="aq-pixel-gameplay-heading">
              <span><Crosshair size={15} /> 游戏元数据</span>
              <small>{activeFrame.name}</small>
            </div>
            <div className="aq-pixel-anchor-editor">
              <span>逐帧锚点</span>
              {(['x', 'y'] as const).map((axis) => (
                <label key={axis}>
                  <span>{axis.toUpperCase()}</span>
                  <input
                    key={`${activeFrame.id}-anchor-${axis}-${activeFrame.gameplay.anchor[axis]}`}
                    aria-label={`锚点 ${axis.toUpperCase()}`}
                    type="number"
                    min={0}
                    max={axis === 'x' ? document.width : document.height}
                    defaultValue={activeFrame.gameplay.anchor[axis]}
                    onBlur={(event) => {
                      const value = event.currentTarget.valueAsNumber
                      const limit = axis === 'x' ? document.width : document.height
                      if (!Number.isSafeInteger(value) || value < 0 || value > limit) {
                        event.currentTarget.value = String(activeFrame.gameplay.anchor[axis])
                        setStatus(`锚点 ${axis.toUpperCase()} 必须是 0—${limit} 的整数`)
                        return
                      }
                      if (value !== activeFrame.gameplay.anchor[axis]) {
                        patchActiveFrameGameplay((gameplay) => { gameplay.anchor[axis] = value }, '逐帧锚点已更新 · 可撤销')
                      }
                    }}
                  />
                </label>
              ))}
            </div>
            <div className="aq-pixel-collision-editor">
              <div className="aq-pixel-gameplay-subheading">
                <span>碰撞区 <small>{activeFrame.gameplay.collisions.length}/8</small></span>
                <button
                  type="button"
                  aria-label="添加碰撞区"
                  disabled={activeFrame.gameplay.collisions.length >= 8}
                  onClick={addActiveCollision}
                ><Plus size={13} /> 添加</button>
              </div>
              {activeFrame.gameplay.collisions.length > 0 ? (
                <div className="aq-pixel-collision-list">
                  {activeFrame.gameplay.collisions.map((collision) => (
                    <article key={collision.id} style={{ '--aq-collision-color': PIXEL_COLLISION_COLORS[collision.type] } as CSSProperties}>
                      <div className="aq-pixel-collision-main">
                        <span aria-hidden="true" />
                        <input
                          key={`${collision.id}-${collision.name}`}
                          aria-label={`${collision.name}名称`}
                          defaultValue={collision.name}
                          maxLength={48}
                          onBlur={(event) => {
                            const name = event.currentTarget.value.trim()
                            if (!name) {
                              event.currentTarget.value = collision.name
                              setStatus('碰撞区名称不能为空')
                            } else if (name !== collision.name) patchActiveCollision(collision.id, { name })
                          }}
                        />
                        <select
                          aria-label={`${collision.name}类型`}
                          value={collision.type}
                          onChange={(event) => patchActiveCollision(collision.id, { type: event.currentTarget.value as PixelCollisionType })}
                        >
                          {PIXEL_COLLISION_TYPES.map((type) => <option key={type} value={type}>{PIXEL_COLLISION_LABELS[type]}</option>)}
                        </select>
                        <button
                          type="button"
                          aria-label={`删除碰撞区 ${collision.name}`}
                          onClick={() => patchActiveFrameGameplay((gameplay) => {
                            gameplay.collisions = gameplay.collisions.filter((item) => item.id !== collision.id)
                          }, '碰撞区已删除 · 可撤销')}
                        ><Trash2 size={12} /></button>
                      </div>
                      <div className="aq-pixel-collision-geometry">
                        {(['x', 'y', 'width', 'height'] as const).map((field) => (
                          <label key={field}>
                            <span>{field === 'width' ? 'W' : field === 'height' ? 'H' : field.toUpperCase()}</span>
                            <input
                              key={`${collision.id}-${field}-${collision[field]}`}
                              aria-label={`${collision.name} ${field}`}
                              type="number"
                              min={field === 'width' || field === 'height' ? 1 : 0}
                              max={field === 'x' || field === 'width' ? document.width : document.height}
                              defaultValue={collision[field]}
                              onBlur={(event) => {
                                const value = event.currentTarget.valueAsNumber
                                if (!Number.isSafeInteger(value) || value < 0) {
                                  event.currentTarget.value = String(collision[field])
                                  setStatus('碰撞区几何参数必须是有效整数')
                                  return
                                }
                                if (value !== collision[field] && !patchActiveCollision(collision.id, { [field]: value })) {
                                  event.currentTarget.value = String(collision[field])
                                }
                              }}
                            />
                          </label>
                        ))}
                      </div>
                    </article>
                  ))}
                </div>
              ) : <p className="aq-pixel-gameplay-empty">当前帧尚未设置碰撞区；导出仍会保留空数组。</p>}
            </div>
            <div className="aq-pixel-tile-rule-editor">
              <div className="aq-pixel-gameplay-subheading">
                <span>8 邻域 Tileset</span>
                <button
                  type="button"
                  aria-pressed={activeFrame.gameplay.tileRule !== null}
                  className={activeFrame.gameplay.tileRule ? 'is-active' : ''}
                  onClick={() => patchActiveFrameGameplay((gameplay) => {
                    gameplay.tileRule = gameplay.tileRule ? null : { terrainId: 'terrain-1', bitmask: 0 }
                  }, activeFrame.gameplay.tileRule ? '当前帧地形规则已停用 · 可撤销' : '当前帧地形规则已启用 · 可撤销')}
                >{activeFrame.gameplay.tileRule ? '停用' : '启用'}</button>
              </div>
              {activeFrame.gameplay.tileRule ? (
                <div className="aq-pixel-tile-rule-body">
                  <label>
                    <span>Terrain ID</span>
                    <input
                      key={`${activeFrame.id}-${activeFrame.gameplay.tileRule.terrainId}`}
                      aria-label="Terrain ID"
                      defaultValue={activeFrame.gameplay.tileRule.terrainId}
                      maxLength={64}
                      onBlur={(event) => {
                        const terrainId = event.currentTarget.value.trim()
                        if (terrainId !== activeFrame.gameplay.tileRule?.terrainId && !patchActiveFrameGameplay((gameplay) => {
                          if (gameplay.tileRule) gameplay.tileRule.terrainId = terrainId
                        }, '地形标识已更新 · 可撤销')) event.currentTarget.value = activeFrame.gameplay.tileRule?.terrainId ?? ''
                      }}
                    />
                  </label>
                  <div className="aq-pixel-neighbor-grid" aria-label="8 邻域位掩码">
                    {PIXEL_TILE_GRID.map((neighborId) => {
                      if (neighborId === 'center') return <span key={neighborId} title="当前图块">本格</span>
                      const neighbor = PIXEL_TILE_NEIGHBORS.find((item) => item.id === neighborId)
                      if (!neighbor) return null
                      const enabled = (activeFrame.gameplay.tileRule?.bitmask ?? 0) & neighbor.bit
                      return (
                        <button
                          type="button"
                          key={neighbor.id}
                          className={enabled ? 'is-active' : ''}
                          aria-pressed={Boolean(enabled)}
                          aria-label={`${neighbor.label}邻居`}
                          title={`${neighbor.label} · bit ${neighbor.bit}`}
                          onClick={() => patchActiveFrameGameplay((gameplay) => {
                            if (gameplay.tileRule) gameplay.tileRule.bitmask ^= neighbor.bit
                          }, `Tileset ${neighbor.label}邻居规则已切换 · 可撤销`)}
                        >{neighbor.label}</button>
                      )
                    })}
                  </div>
                  <output>Mask {activeFrame.gameplay.tileRule.bitmask}</output>
                  <section className="aq-pixel-terrain-composer" aria-label="Terrain 九宫格自动推断">
                    <div className="aq-pixel-terrain-heading">
                      <span><Grid3X3 size={13} /> 九宫格自动推断</span>
                      {terrainPreviewResult.preview ? (
                        <output aria-label="九宫格匹配摘要">
                          {terrainPreviewResult.preview.layout.exactCount} 精确 · {terrainPreviewResult.preview.layout.fallbackCount} 降级
                        </output>
                      ) : null}
                    </div>
                    <div className="aq-pixel-terrain-presets" aria-label="九宫格形状预设">
                      {PIXEL_TERRAIN_GRID_PRESETS.map((preset) => (
                        <button
                          type="button"
                          key={preset.id}
                          aria-label={`选择九宫格预设 ${preset.label}`}
                          onClick={() => selectTerrainPreset(preset.id)}
                        >{preset.label}</button>
                      ))}
                    </div>
                    <div className="aq-pixel-terrain-composer-body">
                      <div className="aq-pixel-terrain-occupancy" aria-label="九宫格占用图">
                        {terrainOccupancy.map((occupied, index) => {
                          const previewCell = terrainPreviewResult.preview?.layout.cells[index]
                          return (
                            <button
                              type="button"
                              key={PIXEL_TERRAIN_CELL_LABELS[index]}
                              className={`${occupied ? 'is-active' : ''} ${previewCell?.occupied && !previewCell.exact ? 'is-fallback' : ''}`.trim()}
                              aria-pressed={occupied}
                              aria-label={`切换九宫格 ${PIXEL_TERRAIN_CELL_LABELS[index]}`}
                              title={previewCell?.occupied
                                ? `期望 Mask ${previewCell.expectedBitmask} · ${previewCell.exact ? '精确匹配' : `降级到 ${previewCell.matchedBitmask}`}`
                                : '透明空格'}
                              onClick={() => toggleTerrainCell(index)}
                            >
                              <span>{PIXEL_TERRAIN_CELL_LABELS[index]}</span>
                              <small>{previewCell?.expectedBitmask ?? '—'}</small>
                            </button>
                          )
                        })}
                      </div>
                      {terrainPreviewResult.preview ? (
                        <figure className="aq-pixel-terrain-preview">
                          <canvas
                            ref={terrainPreviewCanvasRef}
                            aria-label={`Terrain ${terrainPreviewResult.preview.layout.terrainId} 九宫格像素预览`}
                          />
                          <figcaption>
                            {terrainPreviewResult.preview.width}×{terrainPreviewResult.preview.height} · 角点需两条正交边同时存在
                          </figcaption>
                        </figure>
                      ) : (
                        <p className="aq-pixel-terrain-error">{terrainPreviewResult.error ?? '启用 Terrain 后可自动编排九宫格。'}</p>
                      )}
                    </div>
                    {terrainPreviewResult.preview?.layout.fallbackCount ? (
                      <p className="aq-pixel-terrain-warning" role="status">
                        缺少部分精确 Mask，已按位差、帧顺序和稳定 ID 确定性降级；导出 JSON 会逐格标明。
                      </p>
                    ) : null}
                    <div className="aq-pixel-terrain-actions">
                      <button
                        type="button"
                        disabled={!terrainPreviewResult.preview?.layout.cells[4]?.occupied}
                        onClick={applyTerrainCenterMask}
                      >应用本格 Mask</button>
                      <button type="button" disabled={!terrainPreviewResult.preview || isExporting} onClick={() => void exportTerrainPreview()}>
                        <Download size={12} /> 导出九宫格预览
                      </button>
                    </div>
                  </section>
                </div>
              ) : <p className="aq-pixel-gameplay-empty">按帧启用后，可生成 Tiled WangSet 与确定性 8 邻域规则。</p>}
            </div>
            <div className="aq-pixel-terrain-map-editor" aria-label="持久化 Terrain Map 编辑器">
              <div className="aq-pixel-gameplay-subheading">
                <span><Grid3X3 size={13} /> Terrain Map <small>{document.terrainMaps.length}/{PIXEL_LIMITS.maxTerrainMaps}</small></span>
                <button
                  type="button"
                  aria-label="新建 Terrain Map"
                  disabled={document.terrainMaps.length >= PIXEL_LIMITS.maxTerrainMaps}
                  onClick={createTerrainMap}
                ><Plus size={12} /> 新建</button>
              </div>
              {document.terrainMaps.length > 0 ? (
                <div className="aq-pixel-terrain-map-tabs" aria-label="Terrain Map 列表">
                  {document.terrainMaps.map((terrainMap) => (
                    <button
                      type="button"
                      key={terrainMap.id}
                      className={terrainMap.id === activeTerrainMap?.id ? 'is-active' : ''}
                      aria-pressed={terrainMap.id === activeTerrainMap?.id}
                      onClick={() => setActiveTerrainMapId(terrainMap.id)}
                    >{terrainMap.name}</button>
                  ))}
                </div>
              ) : null}
              {activeTerrainMap ? (
                <div className="aq-pixel-terrain-map-card">
                  <div className="aq-pixel-terrain-map-fields">
                    <label>
                      <span>地图名称</span>
                      <input
                        key={`${activeTerrainMap.id}-${activeTerrainMap.name}`}
                        aria-label="Terrain Map 名称"
                        defaultValue={activeTerrainMap.name}
                        maxLength={80}
                        onBlur={(event) => {
                          const name = event.currentTarget.value.trim()
                          if (!name) {
                            event.currentTarget.value = activeTerrainMap.name
                            setStatus('Terrain Map 名称不能为空')
                          } else if (name !== activeTerrainMap.name) {
                            apply('terrain-maps.patch', { terrainMapId: activeTerrainMap.id, patch: { name } })
                          }
                        }}
                      />
                    </label>
                    <label>
                      <span>画笔 Terrain</span>
                      <select
                        aria-label="Terrain Map 画笔 Terrain"
                        value={terrainMapPaintTerrainId}
                        disabled={terrainIds.length === 0}
                        onChange={(event) => {
                          setTerrainMapPaintTerrainId(event.currentTarget.value)
                          setTerrainMapBrushMode('paint')
                        }}
                      >
                        {terrainIds.length === 0 ? <option value="">暂无帧规则</option> : null}
                        {terrainIds.map((terrainId) => <option key={terrainId} value={terrainId}>{terrainId}</option>)}
                      </select>
                    </label>
                  </div>
                  <div className="aq-pixel-terrain-map-size" aria-label="Terrain Map 尺寸">
                    <label>
                      <span>宽</span>
                      <input
                        aria-label="Terrain Map 宽度"
                        type="number"
                        min={1}
                        max={PIXEL_LIMITS.maxTerrainMapWidth}
                        value={terrainMapWidthInput}
                        onChange={(event) => setTerrainMapWidthInput(event.currentTarget.value)}
                      />
                    </label>
                    <label>
                      <span>高</span>
                      <input
                        aria-label="Terrain Map 高度"
                        type="number"
                        min={1}
                        max={PIXEL_LIMITS.maxTerrainMapHeight}
                        value={terrainMapHeightInput}
                        onChange={(event) => setTerrainMapHeightInput(event.currentTarget.value)}
                      />
                    </label>
                    <button type="button" aria-label="应用 Terrain Map 尺寸" onClick={resizeActiveTerrainMap}>应用尺寸</button>
                  </div>
                  <div className="aq-pixel-terrain-map-tools" aria-label="Terrain Map 画笔工具">
                    <button
                      type="button"
                      className={terrainMapBrushMode === 'paint' ? 'is-active' : ''}
                      aria-pressed={terrainMapBrushMode === 'paint'}
                      disabled={terrainIds.length === 0}
                      onClick={() => setTerrainMapBrushMode('paint')}
                    ><Pencil size={12} /> 画笔</button>
                    <button
                      type="button"
                      className={terrainMapBrushMode === 'erase' ? 'is-active' : ''}
                      aria-pressed={terrainMapBrushMode === 'erase'}
                      onClick={() => setTerrainMapBrushMode('erase')}
                    ><Eraser size={12} /> 橡皮</button>
                    <button type="button" disabled={!terrainMapPaintTerrainId} onClick={() => patchAllTerrainMapCells(terrainMapPaintTerrainId)}><PaintBucket size={12} /> 当前 Terrain 填满</button>
                    <button type="button" onClick={() => patchAllTerrainMapCells(null)}>清空</button>
                  </div>
                  <figure className="aq-pixel-terrain-map-preview">
                    <canvas
                      ref={terrainMapCanvasRef}
                      aria-label="Terrain Map 画布"
                      style={{ aspectRatio: `${activeTerrainMap.width} / ${activeTerrainMap.height}` }}
                      onPointerDown={beginTerrainMapStroke}
                      onPointerMove={continueTerrainMapStroke}
                      onPointerUp={finishTerrainMapStroke}
                      onPointerCancel={cancelTerrainMapStroke}
                      onContextMenu={(event) => event.preventDefault()}
                    />
                    <figcaption>
                      {activeTerrainMap.width}×{activeTerrainMap.height} · {activeTerrainMap.cells.filter((terrainId) => terrainId !== null).length} 个持久化格
                      {' · '}{new Set(activeTerrainMap.cells.filter((terrainId) => terrainId !== null)).size} 种 Terrain
                      {terrainMapDraftCells ? ' · 正在预览笔触' : ''}
                    </figcaption>
                  </figure>
                  {terrainMapPreviewResult.preview ? (
                    <output className="aq-pixel-terrain-map-match" aria-label="Terrain Map 匹配摘要">
                      {terrainMapPreviewResult.preview.layout.terrainIds.length} 种 Terrain · {terrainMapPreviewResult.preview.layout.exactCount} 精确 · {terrainMapPreviewResult.preview.layout.fallbackCount} 降级
                    </output>
                  ) : (
                    <p className="aq-pixel-terrain-warning" role="status">
                      {terrainMapPreviewResult.error ?? '空地图可继续编辑；从画笔 Terrain 选择帧规则后即可混合绘制。'}
                    </p>
                  )}
                  <div className="aq-pixel-terrain-map-actions">
                    <button type="button" className="is-danger" onClick={removeActiveTerrainMap}><Trash2 size={12} /> 删除地图</button>
                    <button
                      type="button"
                      disabled={!terrainMapPreviewResult.preview || isExporting}
                      onClick={() => void exportTerrainMap()}
                    ><Download size={12} /> 导出 PNG / JSON / TMJ</button>
                  </div>
                </div>
              ) : (
                <p className="aq-pixel-gameplay-empty">
                  先为帧登记 Terrain ID，再新建 1—64 格宽高的地图；可在同一地图切换多种 Terrain 连续绘制，跨种类边界独立推导。
                </p>
              )}
            </div>
          </section>
          <div className="aq-pixel-sprite-summary">
            <span>Sprite Sheet</span>
            <strong>{spriteMetadata.width} × {spriteMetadata.height}</strong>
            <p>{spriteMetadata.columns} 列 · {spriteMetadata.rows} 行 · {spriteMetadata.frames.length} 帧</p>
            <div className="aq-pixel-game-actions" aria-label="像素游戏资产工具">
              <button type="button" onClick={cleanupActivePixelLayer}>
                <Sparkles size={14} /> 本地智能清理
              </button>
              <button type="button" onClick={ensureEightDirectionSlots}>
                <Compass size={14} /> 补齐八方向
              </button>
              <button type="button" onClick={() => void exportPixelGameBundle()} disabled={isExporting}>
                <PackageOpen size={14} /> 游戏资产包
              </button>
              <button type="button" onClick={() => void exportPixelEngineBridge()} disabled={isExporting}>
                <Download size={14} /> 引擎桥接包
              </button>
            </div>
          </div>
        </aside>
      </div>
      <AgentPlanReviewDialog
        plan={agentPlanReview?.plan ?? null}
        preview={agentPlanReview?.preview ?? null}
        busy={agentPlanBusy}
        error={agentPlanError}
        latestReceipt={latestAgentReceipt}
        onApprove={approveAgentPlanReview}
        onReject={rejectAgentPlan}
      />
    </section>
  )
}

export const pixelModeModule = {
  id: 'pixel' as const,
  title: '像素模式',
  summary: '确定性的图层、帧、调色板与 Sprite 工作流。',
  maturity: 'preview' as const,
  runtimeRequirements: [] as string[],
  createDefaultProject: createDefaultPixelProject,
  View: PixelModeWorkbench,
}
