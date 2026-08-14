import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Clock3,
  Crop,
  Eraser,
  Eye,
  EyeOff,
  Frame,
  GripVertical,
  Image,
  ImageUp,
  Layers3,
  LoaderCircle,
  Lock,
  MoreHorizontal,
  Paintbrush,
  Palette,
  Shapes,
  SlidersHorizontal,
  Sparkles,
  StickyNote,
  Type,
  Unlock,
  Video,
  RotateCcw,
  ScanSearch,
  Square,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { resolveImageResource } from '../lib/assetVariants'
import {
  isImageJobOutput,
  type CanvasElement,
  type ElementKind,
  type ImageToolId,
  type ProcessingJob,
  type RuntimeStatus,
  type VideoJobRequest,
} from '../types'
import { VideoStudio } from './VideoStudio'

type InspectorProps = {
  elements: CanvasElement[]
  selectedIds: string[]
  jobs: ProcessingJob[]
  runtime: RuntimeStatus | null
  runtimeLoading: boolean
  streamConnected: boolean
  videoSubmitting: boolean
  videoSubmitError: string | null
  onSelect: (id: string) => void
  onUpdate: (id: string, patch: Partial<CanvasElement>) => void
  onToggleVisible: (id: string) => void
  onToggleLock: (id: string) => void
  onOpenPixel: (id: string) => void
  onOpenImageTool: (id: string, tool: ImageToolId) => void
  onClearJobs: () => void
  onRefreshRuntime: () => void
  onStartRuntime: () => void
  onStopRuntime: () => void
  onRuntimePolicyChange: (
    policy: NonNullable<RuntimeStatus['lifecycle']>['policy'],
    idleSeconds: number,
  ) => void
  onSubmitVideo: (request: VideoJobRequest) => Promise<void>
  onCancelJob: (jobId: string) => void
  onRetryJob: (jobId: string) => void
}

const kindIcons: Record<ElementKind, LucideIcon> = {
  poster: Image,
  pixel: Layers3,
  note: StickyNote,
  palette: Palette,
  text: Type,
  shape: Shapes,
  frame: Frame,
  image: Image,
  video: Video,
  connector: Circle,
}

const imageTools: Array<{
  id: ImageToolId
  label: string
  hint: string
  icon: LucideIcon
}> = [
  { id: 'adjust', label: '调整', hint: '色彩参数', icon: SlidersHorizontal },
  { id: 'crop', label: '裁剪', hint: '画幅与焦点', icon: Crop },
  { id: 'remove-background', label: '去背景', hint: '本机模型 / 草稿回退', icon: Eraser },
  { id: 'element-extract', label: '元素提取', hint: 'ComfyUI · SAM 点击分割', icon: ScanSearch },
  { id: 'region-adjust', label: '区域调整', hint: '语义蒙版 · 本机确定性合成', icon: Paintbrush },
  { id: 'mask-refine', label: '蒙版修边', hint: '移除 / 恢复 Alpha', icon: Paintbrush },
  { id: 'pixelate', label: '像素化', hint: '量化与抖动', icon: Layers3 },
  { id: 'upscale', label: '超分放大', hint: 'Real-ESRGAN / Lanczos / 草稿', icon: ImageUp },
  { id: 'sharpen', label: '细节锐化', hint: '本机确定性处理', icon: Sparkles },
  { id: 'alpha-cleanup', label: '透明边缘', hint: 'Alpha 噪点清理', icon: Eraser },
  { id: 'more', label: '更多', hint: '能力注册表', icon: MoreHorizontal },
]

function NumberField({
  label,
  value,
  suffix,
  onChange,
}: {
  label: string
  value: number
  suffix?: string
  onChange: (value: number) => void
}) {
  return (
    <label className="property-field">
      <span>{label}</span>
      <input
        type="number"
        value={Math.round(value)}
        onChange={(event) => onChange(Number(event.target.value) || 0)}
      />
      {suffix ? <em>{suffix}</em> : null}
    </label>
  )
}

function AlignGlyph({ type }: { type: 'left' | 'center-x' | 'center-y' | 'right' }) {
  if (type === 'left' || type === 'right') {
    const edge = type === 'left' ? 5 : 19
    const barX = type === 'left' ? 7 : 9
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d={`M${edge} 4V20`} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d={`M${barX} 7H17M${barX} 12H14M${barX} 17H19`} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    )
  }
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {type === 'center-x' ? (
        <>
          <path d="M12 4V20" stroke="currentColor" strokeWidth="1.6" strokeDasharray="2 2" />
          <rect x="5" y="7" width="14" height="4" rx="1" stroke="currentColor" strokeWidth="1.5" />
          <rect x="8" y="14" width="8" height="4" rx="1" stroke="currentColor" strokeWidth="1.5" />
        </>
      ) : (
        <>
          <path d="M4 12H20" stroke="currentColor" strokeWidth="1.6" strokeDasharray="2 2" />
          <rect x="6" y="5" width="5" height="14" rx="1" stroke="currentColor" strokeWidth="1.5" />
          <rect x="14" y="8" width="4" height="8" rx="1" stroke="currentColor" strokeWidth="1.5" />
        </>
      )}
    </svg>
  )
}

type LayerListProps = {
  elements: CanvasElement[]
  selectedIds: string[]
  onSelect: (id: string) => void
  onToggleVisible: (id: string) => void
  onToggleLock: (id: string) => void
}

function LayerList({
  elements,
  selectedIds,
  onSelect,
  onToggleVisible,
  onToggleLock,
}: LayerListProps) {
  return (
    <div className="layer-list">
      {[...elements]
        .sort((a, b) => b.zIndex - a.zIndex)
        .map((element) => {
          const Icon = kindIcons[element.kind]
          const selected = selectedIds.includes(element.id)
          return (
            <div
              key={element.id}
              className={`layer-row ${selected ? 'is-selected' : ''} ${!element.visible ? 'is-muted' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => onSelect(element.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') onSelect(element.id)
              }}
            >
              <GripVertical className="layer-grip" size={14} />
              <Icon size={16} strokeWidth={1.65} />
              <span>{element.name}</span>
              <button
                type="button"
                aria-label={element.visible ? `隐藏${element.name}` : `显示${element.name}`}
                title={element.visible ? '隐藏' : '显示'}
                onClick={(event) => {
                  event.stopPropagation()
                  onToggleVisible(element.id)
                }}
              >
                {element.visible ? <Eye size={15} /> : <EyeOff size={15} />}
              </button>
              <button
                type="button"
                aria-label={element.locked ? `解锁${element.name}` : `锁定${element.name}`}
                title={element.locked ? '解锁' : '锁定'}
                onClick={(event) => {
                  event.stopPropagation()
                  onToggleLock(element.id)
                }}
              >
                {element.locked ? <Lock size={14} /> : <Unlock size={14} />}
              </button>
            </div>
          )
        })}
    </div>
  )
}

function ImageCapabilityPanel({
  selected,
  onOpenImageTool,
  onUpdate,
}: {
  selected: CanvasElement
  onOpenImageTool: InspectorProps['onOpenImageTool']
  onUpdate: InspectorProps['onUpdate']
}) {
  const stack = selected.processingStack ?? []
  const dimensions =
    selected.naturalWidth && selected.naturalHeight
      ? `${selected.naturalWidth} × ${selected.naturalHeight}`
      : '画布资产'

  return (
    <>
      <div className="selected-asset-card">
        <span className="asset-thumbnail">
          {selected.src ? (
            <img
              src={resolveImageResource(selected.src, 'thumbnail').src}
              alt=""
              loading="lazy"
              decoding="async"
            />
          ) : <Image size={18} />}
        </span>
        <span>
          <strong>{selected.name}</strong>
          <small>{dimensions} · v{selected.assetVersion ?? 1}</small>
        </span>
      </div>

      <section className="quick-tool-section" aria-label="快捷处理">
        <div className="inspector-section-heading">
          <span>快捷处理</span>
          <small>本地预览优先</small>
        </div>
        <div className="quick-tool-grid">
          {imageTools.map(({ id, label, hint, icon: Icon }) => (
            <button
              type="button"
              key={id}
              title={hint}
              onClick={() => onOpenImageTool(selected.id, id)}
            >
              <Icon size={18} strokeWidth={1.65} />
              <span>{label}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="processing-stack-section">
        <div className="inspector-section-heading">
          <span>处理栈</span>
          {stack.length ? (
            <button
              type="button"
              onClick={() => onUpdate(selected.id, {
                processingStack: [],
                adjustments: { brightness: 100, contrast: 100, saturation: 100 },
                src: selected.sourceSrc ?? selected.src,
              })}
            >
              清空
            </button>
          ) : null}
        </div>
        {stack.length ? (
          <div className="processing-stack-list">
            {stack.map((step, index) => (
              <div className="processing-stack-row" key={step.id}>
                <span className="stack-order">{index + 1}</span>
                <span>
                  <strong>{step.label}</strong>
                  <small>{step.detail}</small>
                </span>
                <label className="mini-switch" title={step.enabled ? '停用此步骤' : '启用此步骤'}>
                  <input
                    type="checkbox"
                    checked={step.enabled}
                    aria-label={`${step.enabled ? '停用' : '启用'}${step.label}`}
                    onChange={(event) => onUpdate(selected.id, {
                      processingStack: stack.map((item) =>
                        item.id === step.id ? { ...item, enabled: event.target.checked } : item,
                      ),
                    })}
                  />
                  <i />
                </label>
              </div>
            ))}
          </div>
        ) : (
          <div className="processing-empty">
            <Sparkles size={17} />
            <span>应用处理后，会在这里形成可开关的非破坏步骤。</span>
          </div>
        )}
      </section>
    </>
  )
}

function JobPanel({ jobs, onClearJobs, onCancelJob, onRetryJob, onReuseJob }: {
  jobs: ProcessingJob[]
  onClearJobs: () => void
  onCancelJob: (jobId: string) => void
  onRetryJob: (jobId: string) => void
  onReuseJob: (job: ProcessingJob) => void
}) {
  const sortedJobs = [...jobs].sort((a, b) => b.createdAt - a.createdAt)
  return (
    <div className="inspector-scroll">
      <div className="jobs-header">
        <span>
          <strong>处理任务</strong>
          <small>{jobs.length ? `${jobs.length} 条本地任务` : '等待新的处理任务'}</small>
        </span>
        {jobs.length ? (
          <button type="button" onClick={onClearJobs}>清空</button>
        ) : null}
      </div>
      {sortedJobs.length ? (
        <div className="job-list">
          {sortedJobs.map((job) => {
            const running = job.status === 'running' || job.status === 'queued'
            const failed = job.status === 'failed'
            const cancelled = job.status === 'cancelled'
            const usage = [...(job.costEvents ?? [])].reverse().find((event) => event.type === 'usage')
            return (
              <article className={`job-card is-${job.status}`} key={job.id}>
                <div className="job-card-heading">
                  {running ? (
                    <LoaderCircle className="is-spinning" size={16} />
                  ) : failed ? (
                    <AlertTriangle size={16} />
                  ) : cancelled ? (
                    <Square size={15} />
                  ) : (
                    <CheckCircle2 size={16} />
                  )}
                  <span>
                    <strong>{job.label}</strong>
                    <small>{job.detail}</small>
                  </span>
                  <time>
                    <Clock3 size={11} />
                    {new Date(job.createdAt).toLocaleTimeString('zh-CN', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </time>
                </div>
                <div className="job-progress" aria-label={`${job.progress}%`}>
                  <span style={{ width: `${job.progress}%` }} />
                </div>
                {job.scheduling ? (
                  <div className="job-metadata" aria-label="调度信息">
                    <span>{job.scheduling.resourceClass.toUpperCase()}</span>
                    <span>优先级 {job.scheduling.priority}</span>
                    <span>尝试 {job.scheduling.attempt}/{job.scheduling.maxAttempts}</span>
                    {usage ? <span>{(usage.quantity / 1000).toFixed(1)}s 本机算力</span> : null}
                  </div>
                ) : null}
                {job.kind === 'video' && job.workflowMetadata && 'dimensions' in job.workflowMetadata ? (
                  <div className="job-metadata">
                    <span>{job.workflowMetadata.dimensions.width}×{job.workflowMetadata.dimensions.height}</span>
                    <span>{job.workflowMetadata.steps} 步</span>
                    <span>{Math.round(job.workflowMetadata.frames / job.workflowMetadata.fps)}s</span>
                    <span>{job.workflowMetadata.audio ? '音视频' : '静音'}</span>
                  </div>
                ) : null}
                {job.kind === 'image' && isImageJobOutput(job.output) ? (
                  <div className="job-metadata">
                    <span>{job.output.width}×{job.output.height}</span>
                    <span>{job.output.provider}</span>
                    <span>{Math.max(1, Math.round(job.output.bytes / 1024))} KB</span>
                  </div>
                ) : null}
                {job.outputVersion ? (
                  <div className="job-metadata" title={job.outputVersion.id}>
                    <span>不可变输出 v{job.outputVersion.version}</span>
                    <span>SHA {job.outputVersion.assetId.slice(0, 8)}</span>
                  </div>
                ) : null}
                {job.error ? (
                  <div className="job-error-block">
                    <span className="job-error-code">{job.error.code}</span>
                    <strong>{job.error.title}</strong>
                    <p>{job.error.message}</p>
                    {job.error.suggestions?.length ? (
                      <ul>
                        {job.error.suggestions.map((suggestion) => <li key={suggestion}>{suggestion}</li>)}
                      </ul>
                    ) : null}
                  </div>
                ) : null}
                {job.logs?.length ? (
                  <details className="job-log-details">
                    <summary>运行日志 · {job.logs.length}</summary>
                    <div>
                      {job.logs.slice(-8).map((log) => (
                        <p className={`is-${log.level}`} key={`${log.at}-${log.message}`}>
                          <time>{new Date(log.at).toLocaleTimeString('zh-CN', { hour12: false })}</time>
                          <span>{log.message}</span>
                        </p>
                      ))}
                    </div>
                  </details>
                ) : null}
                {job.kind === 'video' ? (
                  <div className="job-actions">
                    {running ? (
                      <button type="button" onClick={() => onCancelJob(job.id)}>
                        <Square size={12} />取消
                      </button>
                    ) : (
                      <>
                        {(failed || cancelled) ? (
                          <button type="button" className="is-primary" onClick={() => onRetryJob(job.id)}>
                            <RotateCcw size={13} />快速重试
                          </button>
                        ) : null}
                        {job.request ? (
                          <button type="button" onClick={() => onReuseJob(job)}>
                            <Sparkles size={13} />复用参数
                          </button>
                        ) : null}
                      </>
                    )}
                  </div>
                ) : job.kind === 'image' ? (
                  <div className="job-actions">
                    {running ? (
                      <button type="button" onClick={() => onCancelJob(job.id)}>
                        <Square size={12} />取消
                      </button>
                    ) : failed || cancelled ? (
                      <button type="button" className="is-primary" onClick={() => onRetryJob(job.id)}>
                        <RotateCcw size={13} />重新处理
                      </button>
                    ) : job.outputUrl ? (
                      <a href={job.outputUrl} download={job.output?.filename}>下载结果</a>
                    ) : null}
                  </div>
                ) : null}
              </article>
            )
          })}
        </div>
      ) : (
        <div className="inspector-empty jobs-empty">
          <LoaderCircle size={28} strokeWidth={1.4} />
          <strong>还没有处理任务</strong>
          <p>从“编辑”页启动像素化、去背景或放大预览，进度会集中显示在这里。</p>
        </div>
      )}
    </div>
  )
}

export function Inspector(props: InspectorProps) {
  const {
    elements,
    selectedIds,
    jobs,
    runtime,
    runtimeLoading,
    streamConnected,
    videoSubmitting,
    videoSubmitError,
    onSelect,
    onUpdate,
    onToggleVisible,
    onToggleLock,
    onOpenPixel,
    onOpenImageTool,
    onClearJobs,
    onRefreshRuntime,
    onStartRuntime,
    onStopRuntime,
    onRuntimePolicyChange,
    onSubmitVideo,
    onCancelJob,
    onRetryJob,
  } = props
  const [tab, setTab] = useState<'edit' | 'video' | 'layers' | 'jobs'>('edit')
  const [reuseRequest, setReuseRequest] = useState<Extract<
    NonNullable<ProcessingJob['request']>,
    { mode: VideoJobRequest['mode'] }
  >>()
  const selected = elements.find((element) => element.id === selectedIds[0])
  const selectedImage = selected?.kind === 'image' ? selected : undefined

  useEffect(() => {
    if (selectedIds.length) {
      setTab((current) => current === 'video' || current === 'jobs' ? current : 'edit')
    }
  }, [selectedIds])

  const update = (patch: Partial<CanvasElement>) => {
    if (selected) onUpdate(selected.id, patch)
  }

  return (
    <aside className="inspector-panel" aria-label="属性与任务面板">
      <div className="inspector-tabs" role="tablist">
        {([
          ['edit', '编辑'],
          ['video', '视频'],
          ['layers', '图层'],
          ['jobs', '任务'],
        ] as const).map(([id, label]) => (
          <button
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? 'is-active' : ''}
            key={id}
            onClick={() => setTab(id)}
          >
            {label}
            {id === 'jobs' && jobs.some((job) => job.status === 'running' || job.status === 'queued') ? (
              <i className="tab-status-dot" />
            ) : null}
          </button>
        ))}
      </div>

      {tab === 'edit' ? (
        <div className="inspector-scroll">
          {selected && selected.kind !== 'connector' ? (
            <>
              {selected.kind === 'image' ? (
                <ImageCapabilityPanel
                  selected={selected}
                  onOpenImageTool={onOpenImageTool}
                  onUpdate={onUpdate}
                />
              ) : null}

              <details className="inspector-section" open>
                <summary>位置与尺寸</summary>
                <div className="property-grid">
                  <NumberField label="X" value={selected.x} suffix="px" onChange={(x) => update({ x })} />
                  <NumberField label="Y" value={selected.y} suffix="px" onChange={(y) => update({ y })} />
                  <NumberField label="W" value={selected.width} suffix="px" onChange={(width) => update({ width: Math.max(24, width) })} />
                  <NumberField label="H" value={selected.height} suffix="px" onChange={(height) => update({ height: Math.max(24, height) })} />
                </div>
                <div className="rotation-row">
                  <span>旋转</span>
                  <input
                    type="number"
                    value={Math.round(selected.rotation)}
                    onChange={(event) => update({ rotation: Number(event.target.value) || 0 })}
                  />
                  <em>°</em>
                </div>
                <div className="alignment-row" aria-label="画布对齐">
                  <span>对齐</span>
                  <button type="button" aria-label="左对齐画布" title="左对齐画布" onClick={() => update({ x: 0 })}>
                    <AlignGlyph type="left" />
                  </button>
                  <button
                    type="button"
                    aria-label="水平居中"
                    title="水平居中"
                    onClick={() => update({ x: Math.round((1200 - selected.width) / 2) })}
                  >
                    <AlignGlyph type="center-x" />
                  </button>
                  <button
                    type="button"
                    aria-label="垂直居中"
                    title="垂直居中"
                    onClick={() => update({ y: Math.round((800 - selected.height) / 2) })}
                  >
                    <AlignGlyph type="center-y" />
                  </button>
                  <button
                    type="button"
                    aria-label="右对齐画布"
                    title="右对齐画布"
                    onClick={() => update({ x: Math.round(1200 - selected.width) })}
                  >
                    <AlignGlyph type="right" />
                  </button>
                </div>
              </details>

              <details className="inspector-section" open>
                <summary>外观</summary>
                {selected.kind !== 'image' ? (
                  <div className="color-control">
                    <label>
                      <input
                        type="color"
                        value={selected.fill.startsWith('#') ? selected.fill : '#ffffff'}
                        onChange={(event) => update({ fill: event.target.value })}
                      />
                      <span>{selected.fill.toUpperCase()}</span>
                    </label>
                  </div>
                ) : null}
                <div className="stroke-control">
                  <span>描边</span>
                  <label className="stroke-color-field">
                    <input
                      type="color"
                      value={selected.stroke.startsWith('#') ? selected.stroke : '#333333'}
                      onChange={(event) => update({ stroke: event.target.value })}
                    />
                    <b>{selected.stroke.startsWith('#') ? selected.stroke.toUpperCase() : '无'}</b>
                  </label>
                  <label className="stroke-width-field">
                    <input
                      type="number"
                      min="0"
                      max="24"
                      value={selected.strokeWidth ?? 1}
                      onChange={(event) => update({ strokeWidth: Math.max(0, Number(event.target.value) || 0) })}
                    />
                    <em>px</em>
                  </label>
                </div>
                <label className="range-control">
                  <span>圆角</span>
                  <input
                    type="range"
                    min="0"
                    max="48"
                    value={selected.radius}
                    onChange={(event) => update({ radius: Number(event.target.value) })}
                  />
                  <output>{Math.round(selected.radius)} px</output>
                </label>
                <label className="range-control">
                  <span>不透明度</span>
                  <input
                    type="range"
                    min="10"
                    max="100"
                    value={Math.round(selected.opacity * 100)}
                    onChange={(event) => update({ opacity: Number(event.target.value) / 100 })}
                  />
                  <output>{Math.round(selected.opacity * 100)}%</output>
                </label>
                {selected.kind === 'text' || selected.kind === 'note' ? (
                  <label className="content-control">
                    <span>内容</span>
                    <textarea
                      rows={3}
                      value={selected.content ?? ''}
                      onChange={(event) => update({ content: event.target.value })}
                    />
                  </label>
                ) : null}
                {selected.kind === 'pixel' ? (
                  <button type="button" className="wide-action" onClick={() => onOpenPixel(selected.id)}>
                    编辑 {selected.pixelWidth ?? 12} × {selected.pixelHeight ?? 12} 像素画
                  </button>
                ) : null}
              </details>
            </>
          ) : (
            <div className="inspector-empty">
              <MousePointerGlyph />
              <strong>选择一个元件</strong>
              <p>选择图片可进入处理实验室，选择其他内容可调整位置与外观。</p>
            </div>
          )}
        </div>
      ) : tab === 'video' ? (
        <VideoStudio
          selectedImage={selectedImage}
          jobs={jobs}
          runtime={runtime}
          runtimeLoading={runtimeLoading}
          streamConnected={streamConnected}
          submitting={videoSubmitting}
          submitError={videoSubmitError}
          onRefreshRuntime={onRefreshRuntime}
          onStartRuntime={onStartRuntime}
          onStopRuntime={onStopRuntime}
          onRuntimePolicyChange={onRuntimePolicyChange}
          reuseRequest={reuseRequest}
          onSubmit={onSubmitVideo}
          onCancelJob={onCancelJob}
        />
      ) : tab === 'layers' ? (
        <div className="inspector-scroll layers-only">
          <div className="layers-heading">画布图层 · {elements.length}</div>
          <LayerList
            elements={elements}
            selectedIds={selectedIds}
            onSelect={onSelect}
            onToggleVisible={onToggleVisible}
            onToggleLock={onToggleLock}
          />
        </div>
      ) : (
        <JobPanel
          jobs={jobs}
          onClearJobs={onClearJobs}
          onCancelJob={onCancelJob}
          onRetryJob={onRetryJob}
          onReuseJob={(job) => {
            if (job.request && 'mode' in job.request) setReuseRequest(job.request)
            if (job.sourceElementId) onSelect(job.sourceElementId)
            setTab('video')
          }}
        />
      )}
    </aside>
  )
}

function MousePointerGlyph() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true">
      <path d="M6 4L21 16L13.8 17.2L10.2 24L6 4Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  )
}
