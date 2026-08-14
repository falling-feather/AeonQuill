import {
  Check,
  Crop,
  Eraser,
  Grid3X3,
  ImageUp,
  Info,
  Paintbrush,
  SlidersHorizontal,
  Sparkles,
  RefreshCw,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createImageJob, fetchImageTools, normalizeImageSource } from '../lib/imageApi'
import {
  createBackgroundPreview,
  createCropPreview,
  createMaskRefinement,
  createPixelDraft,
  createUpscalePreview,
  DEFAULT_IMAGE_ADJUSTMENTS,
  imageAdjustmentFilter,
} from '../lib/imageProcessing'
import type {
  CanvasElement,
  CropSettings,
  ImageAdjustments,
  ImageOperationId,
  ImageLabMode,
  ImageToolCapability,
  ImageToolManifest,
  PixelDraft,
  ProcessingJob,
  MaskDraft,
  MaskRecipe,
} from '../types'
import { MaskEditor } from './MaskEditor'

export type ImageLabResult =
  | {
      kind: 'adjust'
      adjustments: ImageAdjustments
      detail: string
    }
  | {
      kind: 'derived-image'
      mode: Exclude<ImageLabMode, 'adjust' | 'pixelate'>
      src: string
      width: number
      height: number
      detail: string
      maskRecipe?: MaskRecipe
    }
  | {
      kind: 'pixel'
      draft: PixelDraft
      detail: string
    }

type ImageLabProps = {
  element: CanvasElement
  initialMode: ImageLabMode
  onClose: () => void
  onApply: (result: ImageLabResult) => void
  onJobUpdate: (job: ProcessingJob) => void
}

const modeDefinitions: Array<{
  id: ImageLabMode
  label: string
  icon: typeof SlidersHorizontal
}> = [
  { id: 'adjust', label: '调整', icon: SlidersHorizontal },
  { id: 'crop', label: '裁剪', icon: Crop },
  { id: 'pixelate', label: '像素化', icon: Grid3X3 },
  { id: 'remove-background', label: '去背景', icon: Eraser },
  { id: 'mask-refine', label: '蒙版修边', icon: Paintbrush },
  { id: 'upscale', label: '放大', icon: ImageUp },
  { id: 'sharpen', label: '锐化', icon: Sparkles },
  { id: 'alpha-cleanup', label: '透明边缘', icon: Eraser },
]

const modeCopy: Record<ImageLabMode, {
  jobLabel: string
  previewLabel: string
  chains: string[]
}> = {
  adjust: {
    jobLabel: '色彩调整预览',
    previewLabel: '调整预览',
    chains: ['读取调整参数', '组合非破坏滤镜', '更新画布草稿'],
  },
  crop: {
    jobLabel: '裁剪预览',
    previewLabel: '裁剪预览',
    chains: ['画幅换算', '焦点定位', '输出裁切'],
  },
  pixelate: {
    jobLabel: '像素化预览',
    previewLabel: '像素预览',
    chains: ['缩放取样', '调色板量化', '边缘清理'],
  },
  'remove-background': {
    jobLabel: '背景移除草稿',
    previewLabel: '透明背景草稿',
    chains: ['背景估计', 'Alpha 草稿', '边缘柔化'],
  },
  'mask-refine': {
    jobLabel: '蒙版边缘修正',
    previewLabel: '可逆蒙版',
    chains: ['记录归一化笔画', '重建 Alpha 蒙版', '输出全分辨率派生图'],
  },
  upscale: {
    jobLabel: '浏览器放大预览',
    previewLabel: '放大预览',
    chains: ['画布扩展', '插值预览', '结果编码'],
  },
  sharpen: {
    jobLabel: '细节锐化',
    previewLabel: '锐化结果',
    chains: ['读取像素', '反遮罩锐化', '无损 PNG 输出'],
  },
  'alpha-cleanup': {
    jobLabel: '透明边缘清理',
    previewLabel: 'Alpha 清理结果',
    chains: ['读取透明通道', '清理半透明噪点', '无损 PNG 输出'],
  },
}

const localPreviewModes = new Set<ImageLabMode>([
  'adjust',
  'crop',
  'pixelate',
  'remove-background',
  'mask-refine',
  'upscale',
])

function capabilityHint(capability?: ImageToolCapability) {
  if (!capability) return '本地服务尚未返回此处理器'
  if (capability.available) {
    return capability.deterministic
      ? `${capability.provider} · 确定性本机处理`
      : `${capability.provider} · 本机模型处理`
  }
  if (capability.id === 'remove-background') return '未检测到 rembg；可先使用浅色背景浏览器草稿'
  if (capability.id === 'upscale-realesrgan') return '未检测到 Real-ESRGAN 可执行文件与模型'
  return capability.unavailableReason ?? '当前处理器不可用'
}

const delay = (duration: number) =>
  new Promise<void>((resolve) => {
    window.setTimeout(resolve, duration)
  })

function makeId(prefix: string) {
  return `${prefix}-${crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`
}

function RangeSetting({
  label,
  value,
  min,
  max,
  suffix = '%',
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  suffix?: string
  onChange: (value: number) => void
}) {
  return (
    <label className="lab-range-setting">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output>{value}{suffix}</output>
    </label>
  )
}

function ToggleSetting({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="lab-toggle-setting">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <i aria-hidden="true" />
    </label>
  )
}

export function ImageLab({
  element,
  initialMode,
  onClose,
  onApply,
  onJobUpdate,
}: ImageLabProps) {
  const [mode, setMode] = useState<ImageLabMode>(initialMode)
  const [adjustments, setAdjustments] = useState<ImageAdjustments>(
    element.adjustments ?? DEFAULT_IMAGE_ADJUSTMENTS,
  )
  const [crop, setCrop] = useState<CropSettings>(
    element.crop ?? {
      aspect: '1:1',
      zoom: 1,
      positionX: 50,
      positionY: 50,
    },
  )
  const [pixelSettings, setPixelSettings] = useState({
    outputSize: 32,
    colorCount: 8,
    ditherStrength: 50,
    edgePreserve: true,
    outputScale: 4,
    dither: 'bayer',
    alphaThreshold: 96,
  })
  const [backgroundSettings, setBackgroundSettings] = useState({
    threshold: 244,
    softness: 18,
  })
  const [upscaleSettings, setUpscaleSettings] = useState({
    scale: 2,
    smooth: true,
    sharpen: 0.25,
    tileSize: 0,
  })
  const [sharpenSettings, setSharpenSettings] = useState({ radius: 5, amount: 0.65 })
  const [alphaSettings, setAlphaSettings] = useState({ transparentBelow: 24, opaqueAbove: 232 })
  const [alphaMatting, setAlphaMatting] = useState(true)
  const [upscaleProcessor, setUpscaleProcessor] = useState<ImageOperationId>('upscale-realesrgan')
  const [executionMode, setExecutionMode] = useState<'local' | 'server'>('local')
  const [toolManifest, setToolManifest] = useState<ImageToolManifest | null>(null)
  const [capabilityLoading, setCapabilityLoading] = useState(true)
  const [capabilityError, setCapabilityError] = useState<string | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewDimensions, setPreviewDimensions] = useState({ width: 0, height: 0 })
  const [pixelDraft, setPixelDraft] = useState<PixelDraft | null>(null)
  const [maskDraft, setMaskDraft] = useState<MaskDraft | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const source = element.src ?? ''
  const definition = modeCopy[mode]
  const capabilities = useMemo(
    () => new Map(toolManifest?.operations.map((capability) => [capability.id, capability]) ?? []),
    [toolManifest],
  )
  const remoteOperation: ImageOperationId | null = mode === 'upscale'
    ? upscaleProcessor
    : mode === 'pixelate' || mode === 'remove-background' || mode === 'sharpen' || mode === 'alpha-cleanup'
      ? mode
      : null
  const activeCapability = remoteOperation ? capabilities.get(remoteOperation) : undefined
  const hasLocalPreview = localPreviewModes.has(mode)
  const canRunRemote = Boolean(activeCapability?.available)
  const isMaskEditor = mode === 'mask-refine'

  const handleMaskChange = useCallback((draft: MaskDraft | null) => {
    setMaskDraft(draft)
    setPreviewDimensions(draft ? { width: draft.width, height: draft.height } : { width: 0, height: 0 })
    setProgress(draft?.recipe.strokes.length ? 84 : 28)
  }, [])

  const refreshCapabilities = async (refresh = false) => {
    setCapabilityLoading(true)
    setCapabilityError(null)
    try {
      const manifest = await fetchImageTools(refresh)
      setToolManifest(manifest)
      const realEsrgan = manifest.operations.find((item) => item.id === 'upscale-realesrgan')
      const lanczos = manifest.operations.find((item) => item.id === 'upscale-lanczos')
      if (!realEsrgan?.available && lanczos?.available) setUpscaleProcessor('upscale-lanczos')
    } catch (reason) {
      setToolManifest(null)
      setCapabilityError(reason instanceof Error ? reason.message : '无法读取本地图像能力')
    } finally {
      setCapabilityLoading(false)
    }
  }

  useEffect(() => {
    void refreshCapabilities()
  }, [])

  useEffect(() => {
    if (mode === 'adjust' || mode === 'crop') {
      setExecutionMode('local')
      return
    }
    if (activeCapability?.available) {
      setExecutionMode('server')
    } else if (hasLocalPreview) {
      setExecutionMode('local')
    }
  }, [activeCapability?.available, hasLocalPreview, mode, remoteOperation])

  useEffect(() => {
    setPreviewUrl(null)
    setPixelDraft(null)
    setMaskDraft(null)
    setPreviewDimensions({ width: 0, height: 0 })
    setError(null)
    setProgress(0)
  }, [mode, executionMode, pixelSettings.outputSize, pixelSettings.colorCount, pixelSettings.ditherStrength, pixelSettings.edgePreserve, backgroundSettings.threshold, backgroundSettings.softness, crop.aspect, crop.zoom, crop.positionX, crop.positionY, upscaleSettings.scale, upscaleSettings.smooth])

  const previewSource = useMemo(() => {
    if (mode === 'adjust') return source
    if (mode === 'pixelate') return pixelDraft?.previewUrl ?? null
    if (mode === 'mask-refine') return maskDraft?.previewUrl ?? null
    return previewUrl
  }, [maskDraft, mode, pixelDraft, previewUrl, source])

  const reportJob = (
    jobId: string,
    createdAt: number,
    status: ProcessingJob['status'],
    nextProgress: number,
    detail: string,
  ) => {
    setProgress(nextProgress)
    onJobUpdate({
      id: jobId,
      kind: 'image',
      tool: mode,
      label: definition.jobLabel,
      status,
      progress: nextProgress,
      detail,
      createdAt,
    })
  }

  const generatePreview = async () => {
    if (!source || isGenerating || !hasLocalPreview) return
    const jobId = makeId('job')
    const createdAt = Date.now()
    setIsGenerating(true)
    setError(null)
    reportJob(jobId, createdAt, 'running', 12, '准备浏览器处理器')

    try {
      let resultDimensions = { width: 0, height: 0 }
      await delay(120)
      reportJob(jobId, createdAt, 'running', 38, definition.chains[0])
      await delay(80)

      if (mode === 'adjust') {
        await delay(160)
      } else if (mode === 'pixelate') {
        const draft = await createPixelDraft(source, pixelSettings)
        setPixelDraft(draft)
        resultDimensions = { width: draft.width, height: draft.height }
        setPreviewDimensions(resultDimensions)
      } else if (mode === 'remove-background') {
        const result = await createBackgroundPreview(source, backgroundSettings)
        setPreviewUrl(result.url)
        resultDimensions = { width: result.width, height: result.height }
        setPreviewDimensions(resultDimensions)
      } else if (mode === 'crop') {
        const result = await createCropPreview(source, crop)
        setPreviewUrl(result.url)
        resultDimensions = { width: result.width, height: result.height }
        setPreviewDimensions(resultDimensions)
      } else if (mode === 'upscale') {
        const result = await createUpscalePreview(source, upscaleSettings)
        setPreviewUrl(result.url)
        resultDimensions = { width: result.width, height: result.height }
        setPreviewDimensions(resultDimensions)
      } else {
        throw new Error('此能力需要本地图像服务，不能在浏览器中预览')
      }

      reportJob(jobId, createdAt, 'running', 84, definition.chains[1])
      await delay(180)
      reportJob(
        jobId,
        createdAt,
        'completed',
        100,
        mode === 'adjust'
          ? '参数草稿已更新'
          : `${resultDimensions.width || '草稿'} × ${resultDimensions.height || '草稿'} 预览已生成`,
      )
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '预览生成失败'
      setError(message)
      reportJob(jobId, createdAt, 'failed', 100, message)
    } finally {
      setIsGenerating(false)
    }
  }

  const submitRemoteJob = async () => {
    if (!source || isGenerating || !remoteOperation || !activeCapability?.available) return
    setIsGenerating(true)
    setProgress(8)
    setError(null)
    try {
      const params: Record<string, unknown> = remoteOperation === 'pixelate'
        ? {
            targetSize: pixelSettings.outputSize,
            colors: pixelSettings.colorCount,
            outputScale: pixelSettings.outputScale,
            dither: pixelSettings.dither,
            alphaThreshold: pixelSettings.alphaThreshold,
          }
        : remoteOperation === 'upscale-lanczos'
          ? {
              scale: upscaleSettings.scale,
              sharpen: upscaleSettings.sharpen,
            }
          : remoteOperation === 'upscale-realesrgan'
            ? {
                scale: upscaleSettings.scale,
                model: activeCapability.models?.[0],
                tileSize: upscaleSettings.tileSize,
              }
            : remoteOperation === 'sharpen'
              ? sharpenSettings
              : remoteOperation === 'alpha-cleanup'
                ? alphaSettings
                : {
                    alphaMatting,
                    foregroundThreshold: backgroundSettings.threshold,
                    backgroundThreshold: Math.max(0, 255 - backgroundSettings.threshold),
                    erodeSize: Math.round(backgroundSettings.softness / 2),
                  }
      setProgress(24)
      const sourceImageDataUrl = await normalizeImageSource(source)
      setProgress(52)
      const job = await createImageJob({
        operation: remoteOperation,
        sourceImageDataUrl,
        sourceElementId: element.id,
        params,
      })
      onJobUpdate(job)
      setProgress(100)
      onClose()
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '图像任务提交失败'
      setError(`${message}。可刷新能力状态，或切换到浏览器草稿。`)
      setProgress(0)
    } finally {
      setIsGenerating(false)
    }
  }

  const applyResult = async () => {
    if (mode === 'adjust') {
      onApply({
        kind: 'adjust',
        adjustments,
        detail: `亮度 ${adjustments.brightness}% · 对比度 ${adjustments.contrast}% · 饱和度 ${adjustments.saturation}%`,
      })
      return
    }
    if (mode === 'pixelate') {
      if (pixelDraft) {
        onApply({
          kind: 'pixel',
          draft: pixelDraft,
          detail: `${pixelDraft.width} × ${pixelDraft.height} · ${pixelSettings.colorCount} 色`,
        })
      }
      return
    }
    if (mode === 'mask-refine') {
      if (!maskDraft?.recipe.strokes.length) return
      const jobId = makeId('job')
      const createdAt = Date.now()
      setIsGenerating(true)
      setError(null)
      reportJob(jobId, createdAt, 'running', 20, '读取原图与归一化笔画')
      try {
        const result = await createMaskRefinement(source, maskDraft.recipe)
        reportJob(jobId, createdAt, 'running', 86, '重建全分辨率 Alpha')
        onApply({
          kind: 'derived-image',
          mode,
          src: result.previewUrl,
          width: result.width,
          height: result.height,
          detail: `${result.recipe.strokes.length} 笔 · Alpha 改变 ${result.changedPercent}%`,
          maskRecipe: result.recipe,
        })
        reportJob(jobId, createdAt, 'completed', 100, `${result.width} × ${result.height} 蒙版结果已创建`)
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : '蒙版输出失败'
        setError(message)
        reportJob(jobId, createdAt, 'failed', 100, message)
      } finally {
        setIsGenerating(false)
      }
      return
    }
    if (!previewUrl) return
    const detail =
      mode === 'crop'
        ? `${crop.aspect} · ${Math.round(crop.zoom * 100)}%`
        : mode === 'remove-background'
          ? `白底草稿 · 阈值 ${backgroundSettings.threshold}`
          : `${upscaleSettings.scale}× · ${upscaleSettings.smooth ? '平滑' : '最近邻'}`
    onApply({
      kind: 'derived-image',
      mode,
      src: previewUrl,
      width: previewDimensions.width,
      height: previewDimensions.height,
      detail,
    })
  }

  const canApply =
    mode === 'adjust' ||
    (mode === 'pixelate'
      ? Boolean(pixelDraft)
      : mode === 'mask-refine'
        ? Boolean(maskDraft?.recipe.strokes.length)
        : Boolean(previewUrl))

  return (
    <div
      className="modal-backdrop image-lab-backdrop"
      role="presentation"
      onPointerDown={() => {
        if (!isGenerating) onClose()
      }}
    >
      <section
        className="image-lab"
        role="dialog"
        aria-modal="true"
        aria-labelledby="image-lab-title"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="image-lab-header">
          <div>
            <h2 id="image-lab-title">图像处理实验室</h2>
            <p>先生成草稿预览，满意后再应用到画布</p>
          </div>
          <button
            type="button"
            className="modal-close"
            aria-label="关闭图像处理实验室"
            disabled={isGenerating}
            onClick={onClose}
          >
            <X size={19} />
          </button>
        </header>

        <div className="image-lab-tabs" role="tablist" aria-label="图像处理模式">
          {modeDefinitions.map(({ id, label, icon: Icon }) => (
            <button
              type="button"
              role="tab"
              aria-selected={mode === id}
              className={mode === id ? 'is-active' : ''}
              key={id}
              disabled={isGenerating}
              onClick={() => setMode(id)}
            >
              <Icon size={17} strokeWidth={1.65} />
              {label}
            </button>
          ))}
        </div>

        <div className="image-lab-body">
          <div className={`image-compare-area mode-${mode}`}>
            <figure className="image-preview-frame">
              <figcaption>原图</figcaption>
              <div className="image-preview-stage">
                <img src={source} alt={`${element.name}原图`} />
              </div>
            </figure>

            <div className="compare-divider" aria-hidden="true">
              <span>‹</span><span>›</span>
            </div>

            <figure className={`image-preview-frame is-result mode-${mode}`}>
              <figcaption>{definition.previewLabel}</figcaption>
              <div className="image-preview-stage">
                {isMaskEditor ? (
                  <MaskEditor
                    source={source}
                    label={element.name}
                    disabled={isGenerating}
                    onChange={handleMaskChange}
                  />
                ) : previewSource ? (
                  <img
                    src={previewSource}
                    alt={`${element.name}${definition.previewLabel}`}
                    className={mode === 'pixelate' ? 'is-pixelated' : ''}
                    style={
                      mode === 'adjust'
                        ? { filter: imageAdjustmentFilter(adjustments) }
                        : undefined
                    }
                  />
                ) : (
                  <div className="preview-empty">
                    <Sparkles size={26} strokeWidth={1.5} />
                    <strong>等待生成草稿</strong>
                    <span>参数变化不会覆盖画布原图</span>
                  </div>
                )}
              </div>
            </figure>
          </div>

          <aside className="image-lab-settings">
            <div className="lab-settings-scroll">
              <section className="lab-capability-card" aria-label="处理器状态">
                <div>
                  <span className={`capability-status ${activeCapability?.available ? 'is-ready' : 'is-local'}`}>
                    {isMaskEditor
                      ? '本地正式处理可用'
                      : capabilityLoading
                      ? '检测中'
                      : activeCapability?.available
                        ? '本机正式处理可用'
                        : hasLocalPreview
                          ? '浏览器草稿可用'
                          : '处理器不可用'}
                  </span>
                  {!isMaskEditor ? (
                    <button
                      type="button"
                      aria-label="刷新图像处理器状态"
                      title="刷新处理器状态"
                      disabled={capabilityLoading || isGenerating}
                      onClick={() => void refreshCapabilities(true)}
                    >
                      <RefreshCw className={capabilityLoading ? 'is-spinning' : ''} size={14} />
                    </button>
                  ) : null}
                </div>
                <strong>
                  {isMaskEditor
                    ? '浏览器蒙版笔刷'
                    : activeCapability?.label ?? (hasLocalPreview ? '浏览器快速预览' : '等待安装处理器')}
                </strong>
                <p>
                  {isMaskEditor
                    ? '归一化笔画 · 全分辨率确定性重放'
                    : capabilityError ?? capabilityHint(activeCapability)}
                </p>
                {remoteOperation ? (
                  <div className="lab-engine-switch" role="group" aria-label="处理方式">
                    <button
                      type="button"
                      className={executionMode === 'local' ? 'is-active' : ''}
                      disabled={!hasLocalPreview || isGenerating}
                      onClick={() => setExecutionMode('local')}
                    >
                      浏览器草稿
                    </button>
                    <button
                      type="button"
                      className={executionMode === 'server' ? 'is-active' : ''}
                      disabled={!canRunRemote || isGenerating}
                      onClick={() => setExecutionMode('server')}
                    >
                      本机正式处理
                    </button>
                  </div>
                ) : null}
              </section>

              {mode === 'adjust' ? (
                <div className="lab-setting-group">
                  <RangeSetting
                    label="亮度"
                    value={adjustments.brightness}
                    min={50}
                    max={150}
                    onChange={(brightness) => setAdjustments((current) => ({ ...current, brightness }))}
                  />
                  <RangeSetting
                    label="对比度"
                    value={adjustments.contrast}
                    min={50}
                    max={160}
                    onChange={(contrast) => setAdjustments((current) => ({ ...current, contrast }))}
                  />
                  <RangeSetting
                    label="饱和度"
                    value={adjustments.saturation}
                    min={0}
                    max={180}
                    onChange={(saturation) => setAdjustments((current) => ({ ...current, saturation }))}
                  />
                  <button
                    type="button"
                    className="lab-reset-button"
                    onClick={() => setAdjustments(DEFAULT_IMAGE_ADJUSTMENTS)}
                  >
                    恢复默认参数
                  </button>
                </div>
              ) : null}

              {mode === 'crop' ? (
                <div className="lab-setting-group">
                  <label className="lab-select-setting">
                    <span>输出画幅</span>
                    <select
                      value={crop.aspect}
                      onChange={(event) => setCrop((current) => ({
                        ...current,
                        aspect: event.target.value as CropSettings['aspect'],
                      }))}
                    >
                      <option value="1:1">1 : 1</option>
                      <option value="4:3">4 : 3</option>
                      <option value="3:4">3 : 4</option>
                      <option value="16:9">16 : 9</option>
                    </select>
                  </label>
                  <RangeSetting
                    label="画面缩放"
                    value={Math.round(crop.zoom * 100)}
                    min={100}
                    max={220}
                    onChange={(zoom) => setCrop((current) => ({ ...current, zoom: zoom / 100 }))}
                  />
                  <RangeSetting
                    label="水平焦点"
                    value={crop.positionX}
                    min={0}
                    max={100}
                    onChange={(positionX) => setCrop((current) => ({ ...current, positionX }))}
                  />
                  <RangeSetting
                    label="垂直焦点"
                    value={crop.positionY}
                    min={0}
                    max={100}
                    onChange={(positionY) => setCrop((current) => ({ ...current, positionY }))}
                  />
                </div>
              ) : null}

              {mode === 'pixelate' ? (
                <div className="lab-setting-group">
                  <label className="lab-select-setting">
                    <span>输出尺寸</span>
                    <select
                      value={pixelSettings.outputSize}
                      onChange={(event) => setPixelSettings((current) => ({
                        ...current,
                        outputSize: Number(event.target.value),
                      }))}
                    >
                      {[16, 24, 32, 48, 64].map((size) => (
                        <option value={size} key={size}>{size} × {size}</option>
                      ))}
                    </select>
                  </label>
                  <label className="lab-select-setting">
                    <span>颜色数量</span>
                    <select
                      value={pixelSettings.colorCount}
                      onChange={(event) => setPixelSettings((current) => ({
                        ...current,
                        colorCount: Number(event.target.value),
                      }))}
                    >
                      {[4, 6, 8, 12, 16].map((count) => (
                        <option value={count} key={count}>{count} 色</option>
                      ))}
                    </select>
                  </label>
                  {executionMode === 'local' ? (
                    <>
                      <RangeSetting
                        label="草稿抖动强度"
                        value={pixelSettings.ditherStrength}
                        min={0}
                        max={100}
                        onChange={(ditherStrength) => setPixelSettings((current) => ({
                          ...current,
                          ditherStrength,
                        }))}
                      />
                      <ToggleSetting
                        label="草稿边缘保留"
                        checked={pixelSettings.edgePreserve}
                        onChange={(edgePreserve) => setPixelSettings((current) => ({
                          ...current,
                          edgePreserve,
                        }))}
                      />
                    </>
                  ) : (
                    <>
                      <label className="lab-select-setting">
                        <span>抖动算法</span>
                        <select
                          value={pixelSettings.dither}
                          onChange={(event) => setPixelSettings((current) => ({
                            ...current,
                            dither: event.target.value,
                          }))}
                        >
                          <option value="none">无抖动</option>
                          <option value="bayer">Bayer · 规则纹理</option>
                          <option value="floyd_steinberg">Floyd–Steinberg</option>
                          <option value="sierra2_4a">Sierra Lite</option>
                          <option value="atkinson">Atkinson</option>
                        </select>
                      </label>
                      <label className="lab-select-setting">
                        <span>输出像素倍率</span>
                        <select
                          value={pixelSettings.outputScale}
                          onChange={(event) => setPixelSettings((current) => ({
                            ...current,
                            outputScale: Number(event.target.value),
                          }))}
                        >
                          {[1, 2, 4, 8].map((scale) => (
                            <option value={scale} key={scale}>{scale}× 最近邻</option>
                          ))}
                        </select>
                      </label>
                      <RangeSetting
                        label="Alpha 阈值"
                        value={pixelSettings.alphaThreshold}
                        min={0}
                        max={255}
                        suffix=""
                        onChange={(alphaThreshold) => setPixelSettings((current) => ({
                          ...current,
                          alphaThreshold,
                        }))}
                      />
                    </>
                  )}
                </div>
              ) : null}

              {mode === 'remove-background' ? (
                <div className="lab-setting-group">
                  <div className="lab-info-callout">
                    <Info size={16} />
                    <p>
                      {activeCapability?.available
                        ? 'rembg 在本机执行主体分割；原图不会上传到外部服务。'
                        : '当前仅提供白色/浅色纯背景草稿；安装 rembg 后才会开放正式主体分割。'}
                    </p>
                  </div>
                  <ToggleSetting
                    label="Alpha Matting"
                    checked={alphaMatting}
                    onChange={setAlphaMatting}
                  />
                  <RangeSetting
                    label="背景阈值"
                    value={backgroundSettings.threshold}
                    min={210}
                    max={254}
                    suffix=""
                    onChange={(threshold) => setBackgroundSettings((current) => ({
                      ...current,
                      threshold,
                    }))}
                  />
                  <RangeSetting
                    label="边缘柔化"
                    value={backgroundSettings.softness}
                    min={0}
                    max={40}
                    suffix=" px"
                    onChange={(softness) => setBackgroundSettings((current) => ({
                      ...current,
                      softness,
                    }))}
                  />
                </div>
              ) : null}

              {mode === 'mask-refine' ? (
                <div className="lab-setting-group">
                  <div className="lab-info-callout">
                    <Info size={16} />
                    <p>红色笔刷移除 Alpha，绿色笔刷恢复像素；笔画以归一化坐标保存，可在全分辨率重新执行。</p>
                  </div>
                  <div className="mask-recipe-summary">
                    <span>笔画</span>
                    <strong>{maskDraft?.recipe.strokes.length ?? 0}</strong>
                    <span>Alpha 改变</span>
                    <strong>{maskDraft?.changedPercent ?? 0}%</strong>
                  </div>
                </div>
              ) : null}

              {mode === 'upscale' ? (
                <div className="lab-setting-group">
                  <div className="lab-info-callout">
                    <Info size={16} />
                    <p>
                      {activeCapability?.id === 'upscale-realesrgan' && activeCapability.available
                        ? 'Real-ESRGAN 使用本地模型恢复纹理；不同素材仍建议先做小图测试。'
                        : activeCapability?.available
                          ? 'Lanczos 是确定性高质量重采样，不会生成不存在的纹理。'
                          : '浏览器模式仅做插值草稿，不代表 AI 超分辨率质量。'}
                    </p>
                  </div>
                  <label className="lab-select-setting">
                    <span>正式处理器</span>
                    <select
                      value={upscaleProcessor}
                      onChange={(event) => setUpscaleProcessor(event.target.value as ImageOperationId)}
                    >
                      <option value="upscale-realesrgan">
                        Real-ESRGAN {capabilities.get('upscale-realesrgan')?.available ? '· 可用' : '· 未安装'}
                      </option>
                      <option value="upscale-lanczos">
                        Lanczos {capabilities.get('upscale-lanczos')?.available ? '· 可用' : '· 不可用'}
                      </option>
                    </select>
                  </label>
                  <label className="lab-select-setting">
                    <span>放大倍数</span>
                    <select
                      value={upscaleSettings.scale}
                      onChange={(event) => setUpscaleSettings((current) => ({
                        ...current,
                        scale: Number(event.target.value),
                      }))}
                    >
                      <option value={2}>2×</option>
                      <option value={3}>3×</option>
                      <option value={4}>4×</option>
                    </select>
                  </label>
                  {executionMode === 'local' ? (
                    <ToggleSetting
                      label="草稿平滑插值"
                      checked={upscaleSettings.smooth}
                      onChange={(smooth) => setUpscaleSettings((current) => ({ ...current, smooth }))}
                    />
                  ) : upscaleProcessor === 'upscale-lanczos' ? (
                    <RangeSetting
                      label="细节锐化"
                      value={Math.round(upscaleSettings.sharpen * 100)}
                      min={0}
                      max={150}
                      onChange={(sharpen) => setUpscaleSettings((current) => ({ ...current, sharpen: sharpen / 100 }))}
                    />
                  ) : null}
                </div>
              ) : null}

              {mode === 'sharpen' ? (
                <div className="lab-setting-group">
                  <div className="lab-info-callout">
                    <Info size={16} />
                    <p>使用 FFmpeg 反遮罩锐化。过高强度会强化噪点与压缩边缘。</p>
                  </div>
                  <label className="lab-select-setting">
                    <span>作用半径</span>
                    <select
                      value={sharpenSettings.radius}
                      onChange={(event) => setSharpenSettings((current) => ({ ...current, radius: Number(event.target.value) }))}
                    >
                      <option value={3}>3 px · 细节</option>
                      <option value={5}>5 px · 均衡</option>
                      <option value={7}>7 px · 强轮廓</option>
                    </select>
                  </label>
                  <RangeSetting
                    label="锐化强度"
                    value={Math.round(sharpenSettings.amount * 100)}
                    min={10}
                    max={250}
                    onChange={(amount) => setSharpenSettings((current) => ({ ...current, amount: amount / 100 }))}
                  />
                </div>
              ) : null}

              {mode === 'alpha-cleanup' ? (
                <div className="lab-setting-group">
                  <div className="lab-info-callout">
                    <Info size={16} />
                    <p>清除透明 PNG 边缘的低 Alpha 噪点，并将高 Alpha 区域固化。</p>
                  </div>
                  <RangeSetting
                    label="透明阈值"
                    value={alphaSettings.transparentBelow}
                    min={0}
                    max={127}
                    suffix=""
                    onChange={(transparentBelow) => setAlphaSettings((current) => ({ ...current, transparentBelow }))}
                  />
                  <RangeSetting
                    label="实色阈值"
                    value={alphaSettings.opaqueAbove}
                    min={128}
                    max={255}
                    suffix=""
                    onChange={(opaqueAbove) => setAlphaSettings((current) => ({ ...current, opaqueAbove }))}
                  />
                </div>
              ) : null}

              <div className="lab-processing-chain">
                {definition.chains.map((label, index) => (
                  <div key={label}>
                    <span>{index + 1}</span>
                    <strong>{label}</strong>
                    <i className={progress >= (index + 1) * 28 ? 'is-complete' : ''} />
                  </div>
                ))}
              </div>
            </div>
          </aside>
        </div>

        {error ? <div className="image-lab-error" role="alert">{error}</div> : null}

        <footer className="image-lab-footer">
          <div className="lab-local-note">
            <Info size={16} />
            <span>
              {executionMode === 'server'
                ? '原图仅发送到本机桥接服务，完成后创建派生版本'
                : mode === 'mask-refine'
                  ? '蒙版笔画与派生 PNG 会随项目保存，原始资产不覆盖'
                  : '浏览器草稿不会覆盖画布原图'}
            </span>
          </div>
          {isGenerating ? (
            <div className="lab-progress" aria-label={`处理进度 ${progress}%`}>
              <span style={{ width: `${progress}%` }} />
            </div>
          ) : null}
          <div className="image-lab-actions">
            <button
              type="button"
              className="button button-secondary"
              disabled={isGenerating}
              onClick={onClose}
            >
              取消
            </button>
            {executionMode === 'local' && mode !== 'mask-refine' ? (
              <button
                type="button"
                className="button button-outline-accent"
                disabled={isGenerating || !hasLocalPreview}
                onClick={generatePreview}
              >
                <Sparkles size={16} />
                {isGenerating ? `${progress}%` : '生成草稿'}
              </button>
            ) : null}
            <button
              type="button"
              className="button button-primary"
              disabled={isGenerating || (executionMode === 'server' ? !canRunRemote : !canApply)}
              onClick={executionMode === 'server' ? submitRemoteJob : () => void applyResult()}
            >
              <Check size={16} />
              {isGenerating
                ? `${progress}%`
                : executionMode === 'server'
                  ? '提交正式处理'
                  : '应用到画布'}
            </button>
          </div>
        </footer>
      </section>
    </div>
  )
}
