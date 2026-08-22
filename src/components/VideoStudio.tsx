import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Check,
  Circle,
  Cpu,
  Dices,
  Film,
  Image as ImageIcon,
  LoaderCircle,
  Play,
  Power,
  RefreshCw,
  Square,
  Upload,
  Volume2,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react'
import type {
  CanvasElement,
  ProcessingJob,
  RuntimeStatus,
  H3ScenarioId,
  VideoGenerationMode,
  VideoJobPhase,
  VideoJobRequest,
} from '../types'
import {
  compileH3Prompt,
  H3_PROMPT_AGENT_VERSION,
  H3_SCENARIO_PRESETS,
} from '../lib/video/h3PromptAgent.mjs'

type StoredVideoRequest = Extract<
  NonNullable<ProcessingJob['request']>,
  { mode: VideoGenerationMode }
>

type VideoStudioProps = {
  selectedImage?: CanvasElement
  jobs: ProcessingJob[]
  runtime: RuntimeStatus | null
  runtimeLoading: boolean
  streamConnected: boolean
  submitting: boolean
  submitError: string | null
  reuseRequest?: StoredVideoRequest
  onRefreshRuntime: () => void
  onStartRuntime: () => void
  onStopRuntime: () => void
  onRuntimePolicyChange: (
    policy: NonNullable<RuntimeStatus['lifecycle']>['policy'],
    idleSeconds: number,
  ) => void
  onSubmit: (request: VideoJobRequest) => Promise<void>
  onCancelJob: (jobId: string) => void
}

const starterPrompts: Record<VideoGenerationMode, string> = {
  'text-to-video': '清晨薄雾中的海边小镇，暖色日光逐渐照亮屋顶，海鸟从远处缓慢掠过。',
  'image-to-video': '保持输入图片的主体身份、构图和整体风格，主体做自然、幅度较小的动作，光影轻微变化。',
}

const cameraLabels = {
  locked: '静止',
  'push-in': '推进',
  pan: '平移',
  orbit: '环绕',
  follow: '跟随',
} as const

const motionLabels = {
  subtle: '轻微',
  natural: '自然',
  dynamic: '强烈',
} as const

const durationFrames: Record<VideoJobRequest['duration'], number> = {
  5: 124,
  10: 243,
  15: 362,
}

const phaseGroups: Array<{ label: string; phases: VideoJobPhase[] }> = [
  { label: '准备', phases: ['queued', 'preparing'] },
  { label: '条件', phases: ['conditioning'] },
  { label: '采样', phases: ['sampling'] },
  { label: '解码', phases: ['decoding', 'encoding'] },
  { label: '精修', phases: ['restoring'] },
  { label: '保存', phases: ['saving', 'completed'] },
]

const pipelinePresets: Array<{
  id: VideoJobRequest['preset']
  label: string
  native: Record<VideoJobRequest['aspectRatio'], string>
  delivery: Record<VideoJobRequest['aspectRatio'], string>
  detail: string
  minVram: string
  risk: string
  allowedDurations: VideoJobRequest['duration'][]
  estimate: Partial<Record<VideoJobRequest['duration'], string>>
}> = [
  {
    id: 'fast',
    label: '快速动作预览',
    native: { '16:9': '608×352', '9:16': '352×608', '1:1': '448×448' },
    delivery: { '16:9': '608×352', '9:16': '352×608', '1:1': '448×448' },
    detail: '608×352 · 4 步 Turbo · 只看动作构图',
    minVram: '8 GB',
    risk: '低',
    allowedDurations: [5, 10, 15],
    estimate: { 5: '3–5 分钟', 10: '7–11 分钟', 15: '12–18 分钟' },
  },
  {
    id: 'balanced',
    label: '高清 Turbo',
    native: { '16:9': '1024×576', '9:16': '576×1024', '1:1': '768×768' },
    delivery: { '16:9': '1024×576', '9:16': '576×1024', '1:1': '768×768' },
    detail: '8 步 Turbo · 源像素为旧预览约 2.75 倍',
    minVram: '8 GB',
    risk: '中',
    allowedDurations: [5, 10],
    estimate: { 5: '11–16 分钟', 10: '20–28 分钟' },
  },
  {
    id: 'delivery720',
    label: '兼容 720P（插值）',
    native: { '16:9': '608×352', '9:16': '352×608', '1:1': '448×448' },
    delivery: { '16:9': '1280×720', '9:16': '720×1280', '1:1': '720×720' },
    detail: '旧 608×352 源片 · Lanczos · 不新增真实细节',
    minVram: '8 GB',
    risk: '中',
    allowedDurations: [5, 10, 15],
    estimate: { 5: '5–7 分钟', 10: '11–16 分钟', 15: '17–24 分钟' },
  },
  {
    id: 'nativeHigh',
    label: '原生 768P Turbo',
    native: { '16:9': '1344×768', '9:16': '768×1344', '1:1': '992×992' },
    delivery: { '16:9': '1344×768', '9:16': '768×1344', '1:1': '992×992' },
    detail: 'H3 官方原生画布 · 8 步 · 限 5 秒',
    minVram: '8 GB',
    risk: '高',
    allowedDurations: [5],
    estimate: { 5: '17–24 分钟' },
  },
  {
    id: 'cinemaBase',
    label: 'Base 20 步精修',
    native: { '16:9': '1024×576', '9:16': '576×1024', '1:1': '768×768' },
    delivery: { '16:9': '1024×576', '9:16': '576×1024', '1:1': '768×768' },
    detail: '官方 res_multistep · 无 Turbo LoRA · 声画优先',
    minVram: '8 GB',
    risk: '中高',
    allowedDurations: [5, 10],
    estimate: { 5: '15–30 分钟', 10: '30–55 分钟' },
  },
  {
    id: 'master720',
    label: '720P 时序精修母版',
    native: { '16:9': '1024×576', '9:16': '576×1024', '1:1': '768×768' },
    delivery: { '16:9': '1280×720', '9:16': '720×1280', '1:1': '720×720' },
    detail: 'Base 20 步 → 卸载 H3 → SeedVR2 分块修复',
    minVram: '8 GB',
    risk: '高',
    allowedDurations: [5, 10],
    estimate: { 5: '20–40 分钟', 10: '38–75 分钟' },
  },
]

function formatBytes(value = 0) {
  return `${(value / 1024 ** 3).toFixed(1)} GB`
}

function formatCountdown(timestamp?: number | null) {
  if (!timestamp) return null
  const seconds = Math.max(0, Math.ceil((timestamp - Date.now()) / 1000))
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

function phaseIndex(phase?: VideoJobPhase) {
  if (phase === 'failed' || phase === 'cancelled') return -1
  return phaseGroups.findIndex((group) => phase && group.phases.includes(phase))
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('无法读取末帧图片'))
    reader.readAsDataURL(file)
  })
}

export function VideoStudio({
  selectedImage,
  jobs,
  runtime,
  runtimeLoading,
  streamConnected,
  submitting,
  submitError,
  reuseRequest,
  onRefreshRuntime,
  onStartRuntime,
  onStopRuntime,
  onRuntimePolicyChange,
  onSubmit,
  onCancelJob,
}: VideoStudioProps) {
  const [mode, setMode] = useState<VideoGenerationMode>(selectedImage ? 'image-to-video' : 'text-to-video')
  const [prompt, setPrompt] = useState(starterPrompts[selectedImage ? 'image-to-video' : 'text-to-video'])
  const [aspectRatio, setAspectRatio] = useState<VideoJobRequest['aspectRatio']>('16:9')
  const [duration, setDuration] = useState<VideoJobRequest['duration']>(5)
  const [preset, setPreset] = useState<VideoJobRequest['preset']>('master720')
  const [scenario, setScenario] = useState<H3ScenarioId>('auto')
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 2_147_483_647))
  const [audio, setAudio] = useState(true)
  const [camera, setCamera] = useState<NonNullable<VideoJobRequest['director']>['camera']>('locked')
  const [motion, setMotion] = useState<NonNullable<VideoJobRequest['director']>['motion']>('natural')
  const [continuity, setContinuity] = useState(true)
  const [soundscape, setSoundscape] = useState('自然环境声与画面动作同步')
  const [music, setMusic] = useState('')
  const [constraints, setConstraints] = useState('无字幕、无水印、无突然变形、无重复主体')
  const [lastFrame, setLastFrame] = useState<{ name: string; dataUrl: string }>()
  const [countdown, setCountdown] = useState<string | null>(null)
  const lastFrameInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!selectedImage && mode === 'image-to-video') {
      setMode('text-to-video')
      setPrompt(starterPrompts['text-to-video'])
      setLastFrame(undefined)
    }
  }, [mode, selectedImage])

  useEffect(() => {
    if (!reuseRequest) return
    setMode(reuseRequest.mode)
    setPrompt(reuseRequest.prompt)
    setScenario(reuseRequest.scenario || 'auto')
    setAspectRatio(reuseRequest.aspectRatio)
    setDuration(reuseRequest.duration)
    setPreset(reuseRequest.preset)
    setSeed(reuseRequest.seed)
    setAudio(reuseRequest.audio)
    if (reuseRequest.director) {
      setCamera(reuseRequest.director.camera)
      setMotion(reuseRequest.director.motion)
      setContinuity(reuseRequest.director.continuity)
      setSoundscape(reuseRequest.director.soundscape)
      setMusic(reuseRequest.director.music || '')
      setConstraints(reuseRequest.director.constraints)
    }
  }, [reuseRequest])

  useEffect(() => {
    const update = () => setCountdown(formatCountdown(runtime?.lifecycle?.idleShutdownAt))
    update()
    const timer = window.setInterval(update, 1_000)
    return () => window.clearInterval(timer)
  }, [runtime?.lifecycle?.idleShutdownAt])

  const activeJob = useMemo(
    () => jobs
      .filter((job) => job.kind === 'video' && ['queued', 'running'].includes(job.status))
      .sort((a, b) => b.createdAt - a.createdAt)[0],
    [jobs],
  )
  const currentPhase = phaseIndex(activeJob?.phase)
  const lifecycle = runtime?.lifecycle
  const starting = lifecycle?.state === 'starting' || runtimeLoading
  const ready = Boolean(runtime?.connected && runtime?.ready)
  const director = { camera, motion, continuity, soundscape, music, constraints }
  const compiledPlan = useMemo(
    () => compileH3Prompt({
      mode,
      sourcePrompt: prompt.trim().length >= 2 ? prompt : '请补充视频主体与动作描述',
      scenario,
      aspectRatio,
      duration,
      frameCount: durationFrames[duration],
      audio,
      hasLastFrame: mode === 'image-to-video' && Boolean(lastFrame),
      director,
    }),
    [aspectRatio, audio, camera, constraints, continuity, duration, lastFrame, mode, motion, music, prompt, scenario, soundscape],
  )
  const selectedPreset = pipelinePresets.find((item) => item.id === preset) ?? pipelinePresets[0]
  const presetCapability = runtime?.videoCapabilities?.presets.find((item) => item.id === preset)
  const capabilityKnown = Boolean(runtime?.connected && runtime.videoCapabilities)
  const presetUnavailable = capabilityKnown && presetCapability?.available === false
  const vramGb = (runtime?.vramTotal || 0) / 1024 ** 3
  const insufficientVram = Boolean(runtime?.vramTotal && runtime.vramTotal + 64 * 1024 ** 2 < 8 * 1024 ** 3)
  const durationUnsupported = !selectedPreset.allowedDurations.includes(duration)
  const manualRuntimeUnavailable = lifecycle?.policy === 'manual' && !ready
  const canSubmit = prompt.trim().length >= 2
    && (mode !== 'image-to-video' || selectedImage)
    && !insufficientVram
    && !durationUnsupported
    && !presetUnavailable
    && !manualRuntimeUnavailable

  const changeMode = (nextMode: VideoGenerationMode) => {
    setMode(nextMode)
    setPrompt(starterPrompts[nextMode])
    if (nextMode === 'text-to-video') setLastFrame(undefined)
  }

  const changePreset = (nextPreset: (typeof pipelinePresets)[number]) => {
    setPreset(nextPreset.id)
    if (!nextPreset.allowedDurations.includes(duration)) setDuration(nextPreset.allowedDurations[0])
  }

  return (
    <div className="video-studio inspector-scroll">
      <div className="video-mode-tabs" role="tablist" aria-label="视频生成模式">
        <button type="button" role="tab" className={mode === 'text-to-video' ? 'is-active' : ''} aria-selected={mode === 'text-to-video'} onClick={() => changeMode('text-to-video')}>
          文生视频
        </button>
        <button type="button" role="tab" className={mode === 'image-to-video' ? 'is-active' : ''} aria-selected={mode === 'image-to-video'} onClick={() => changeMode('image-to-video')}>
          图生视频
        </button>
      </div>

      <section className={`runtime-strip ${ready ? 'is-ready' : 'is-offline'}`}>
        <span className="runtime-indicator">
          {starting ? <LoaderCircle className="is-spinning" size={16} /> : ready ? <Wifi size={16} /> : <WifiOff size={16} />}
        </span>
        <span>
          <strong>{starting ? '正在按需启动 ComfyUI' : ready ? 'ComfyUI 已就绪' : 'ComfyUI 当前休眠'}</strong>
          <small>
            {ready
              ? `${lifecycle?.owned ? '光阴砚托管' : '外部进程'} · ${formatBytes(runtime?.vramFree)} 可用`
              : lifecycle?.policy === 'manual' ? '手动模式，不会自动启动' : '提交任务时自动启动'}
          </small>
        </span>
        <button type="button" title="重新检测" aria-label="重新检测 ComfyUI" onClick={onRefreshRuntime}><RefreshCw size={14} /></button>
      </section>

      <div className="runtime-policy-row">
        <select
          aria-label="ComfyUI 运行策略"
          value={lifecycle?.policy || 'idle'}
          onChange={(event) => onRuntimePolicyChange(event.target.value as NonNullable<RuntimeStatus['lifecycle']>['policy'], (lifecycle?.idleTimeoutMs || 300_000) / 1000)}
        >
          <option value="idle">按需启动 · 空闲关闭</option>
          <option value="persistent">常驻运行</option>
          <option value="manual">完全手动</option>
        </select>
        <select
          aria-label="空闲关闭时间"
          value={(lifecycle?.idleTimeoutMs || 300_000) / 1000}
          disabled={lifecycle?.policy !== 'idle'}
          onChange={(event) => onRuntimePolicyChange('idle', Number(event.target.value))}
        >
          <option value={60}>1 分钟</option>
          <option value={300}>5 分钟</option>
          <option value={900}>15 分钟</option>
        </select>
        <button
          type="button"
          onClick={ready ? onStopRuntime : onStartRuntime}
          disabled={starting || (ready && !lifecycle?.canAutoStop) || manualRuntimeUnavailable}
        >
          {ready ? <Power size={13} /> : <Play size={13} />}
          {ready ? '关闭' : manualRuntimeUnavailable ? '外部启动' : '启动'}
        </button>
      </div>
      {countdown ? <p className="runtime-countdown">队列空闲，{countdown} 后自动关闭并释放模型显存</p> : null}

      {runtime?.connected ? (
        <div className="runtime-meta">
          <span><Cpu size={13} />{runtime.device?.replace(/^cuda:\d+\s*/, '').split(':')[0]}</span>
          <span>队列 {runtime.queueRunning + runtime.queuePending}</span>
          <span className={streamConnected ? 'is-live' : ''}>{streamConnected ? '实时同步' : '正在重连'}</span>
        </div>
      ) : null}

      {mode === 'image-to-video' ? (
        <section className="video-frame-pair">
          <div className={`video-frame-card ${selectedImage ? 'has-source' : 'is-missing'}`}>
            <span className="video-frame-label">首帧</span>
            {selectedImage?.src ? <img src={selectedImage.src} alt="图生视频首帧" /> : <i><ImageIcon size={18} /></i>}
            <small>{selectedImage?.name || '从画布选择图片'}</small>
          </div>
          <button type="button" className={`video-frame-card last-frame ${lastFrame ? 'has-source' : ''}`} onClick={() => lastFrameInput.current?.click()}>
            <span className="video-frame-label">末帧（可选）</span>
            {lastFrame ? <img src={lastFrame.dataUrl} alt="图生视频末帧" /> : <i><Upload size={18} /></i>}
            <small>{lastFrame?.name || '添加末帧约束'}</small>
            {lastFrame ? <b title="移除末帧" onClick={(event) => { event.stopPropagation(); setLastFrame(undefined) }}><X size={11} /></b> : null}
          </button>
          <input
            ref={lastFrameInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (!file) return
              void fileToDataUrl(file).then((dataUrl) => setLastFrame({ name: file.name, dataUrl }))
              event.currentTarget.value = ''
            }}
          />
        </section>
      ) : null}

      <section className="video-form-section director-section">
        <div className="video-section-label"><span>导演控制</span><small>H3 智能提示词编排</small></div>
        <div className="scenario-options" aria-label="H3 视频场景预设">
          {(Object.values(H3_SCENARIO_PRESETS) as Array<(typeof H3_SCENARIO_PRESETS)[H3ScenarioId]>).map((item) => (
            <button
              type="button"
              key={item.id}
              className={scenario === item.id ? 'is-active' : ''}
              aria-pressed={scenario === item.id}
              title={item.description}
              onClick={() => setScenario(item.id)}
            >
              <strong>{item.label}</strong>
              <small>{item.id === 'auto' ? `当前匹配：${H3_SCENARIO_PRESETS[compiledPlan.resolvedScenario].label}` : item.description}</small>
            </button>
          ))}
        </div>
        <textarea value={prompt} maxLength={8000} rows={4} onChange={(event) => setPrompt(event.target.value)} placeholder="描述主体、场景与动作……" />
        <div className="director-control-row">
          <span>镜头运动</span>
          <div>{(Object.keys(cameraLabels) as Array<keyof typeof cameraLabels>).map((value) => (
            <button type="button" key={value} className={camera === value ? 'is-active' : ''} onClick={() => setCamera(value)}>{cameraLabels[value]}</button>
          ))}</div>
        </div>
        <div className="director-control-row">
          <span>运动强度</span>
          <div>{(Object.keys(motionLabels) as Array<keyof typeof motionLabels>).map((value) => (
            <button type="button" key={value} className={motion === value ? 'is-active' : ''} onClick={() => setMotion(value)}>{motionLabels[value]}</button>
          ))}</div>
        </div>
        <label className="director-toggle">
          <span><strong>连贯性锁定</strong><small>身份、服装、构图、光线与风格保持稳定</small></span>
          <input type="checkbox" checked={continuity} onChange={(event) => setContinuity(event.target.checked)} />
          <i />
        </label>
        <label className="director-input"><span>声音氛围</span><input value={soundscape} disabled={!audio} onChange={(event) => setSoundscape(event.target.value)} /></label>
        <label className="director-input"><span>非画内音乐</span><input value={music} disabled={!audio} placeholder="留空则采用场景默认配乐；人像模式默认无配乐" onChange={(event) => setMusic(event.target.value)} /></label>
        <label className="director-input"><span>画面约束</span><input value={constraints} onChange={(event) => setConstraints(event.target.value)} /></label>
        {compiledPlan.warnings.map((warning) => <p className="pipeline-warning" key={warning}><AlertTriangle size={13} />{warning}</p>)}
        <details className="compiled-prompt">
          <summary>已编译提示词（{H3_PROMPT_AGENT_VERSION} · {compiledPlan.mode}）</summary>
          <pre>{compiledPlan.compiledPrompt}</pre>
        </details>
      </section>

      <section className="video-form-section">
        <span className="video-section-label">画幅</span>
        <div className="choice-segment is-three">
          {(['16:9', '9:16', '1:1'] as const).map((value) => (
            <button type="button" key={value} className={aspectRatio === value ? 'is-active' : ''} aria-pressed={aspectRatio === value} onClick={() => setAspectRatio(value)}>
              <i className={`ratio-icon ratio-${value.replace(':', '-')}`} />{value}
            </button>
          ))}
        </div>
      </section>

      <div className="video-setting-row">
        <section className="video-form-section">
          <span className="video-section-label">时长</span>
          <div className="choice-segment is-three compact">
            {([5, 10, 15] as const).map((value) => (
              <button type="button" key={value} disabled={!selectedPreset.allowedDurations.includes(value)} className={duration === value ? 'is-active' : ''} aria-pressed={duration === value} onClick={() => setDuration(value)}>{value}s</button>
            ))}
          </div>
        </section>
        <section className="video-form-section">
          <span className="video-section-label">原生音频</span>
          <button type="button" className={`audio-toggle ${audio ? 'is-active' : ''}`} aria-pressed={audio} onClick={() => setAudio((value) => !value)}>
            {audio ? <Volume2 size={15} /> : <Circle size={15} />}{audio ? '开启' : '关闭'}
          </button>
        </section>
      </div>

      <section className="video-form-section">
        <div className="video-section-label"><span>生成流水线</span><small>生成与交付尺寸分开</small></div>
        <div className="preset-options pipeline-options">
          {pipelinePresets.map((item) => {
            const capability = runtime?.videoCapabilities?.presets.find((candidate) => candidate.id === item.id)
            const unavailable = capabilityKnown && capability?.available === false
            return (
            <button type="button" key={item.id} className={preset === item.id ? 'is-active' : ''} aria-pressed={preset === item.id} aria-disabled={unavailable} title={unavailable ? '当前运行时缺少该档位所需模型或后处理器' : undefined} onClick={() => changePreset(item)}>
              <span><strong>{item.label}</strong>{item.id === compiledPlan.recommendedPreset ? <em>场景推荐</em> : null}</span>
              <small>{item.detail}</small>
              <dl>
                <div><dt>生成</dt><dd>{item.native[aspectRatio]}</dd></div>
                <div><dt>交付</dt><dd>{item.delivery[aspectRatio]}</dd></div>
                <div><dt>预计</dt><dd>{item.estimate[duration] || '当前时长不支持'}</dd></div>
                <div><dt>{unavailable ? '状态' : '显存 / 风险'}</dt><dd>{unavailable ? '依赖未就绪' : `${item.minVram} / ${item.risk}`}</dd></div>
              </dl>
            </button>
          )})}
        </div>
        {preset === 'delivery720' ? <p className="pipeline-note">兼容档只把文件尺寸放大到 720P；清晰度仍受 608×352 源片限制。</p> : null}
        {preset === 'master720' ? <p className="pipeline-note">母版档会保留 H3 原生片，卸载 H3 后再运行 SeedVR2；第二阶段失败不会覆盖原生母片。</p> : null}
        {presetUnavailable ? <p className="pipeline-warning"><AlertTriangle size={13} />当前运行时尚未注册此档位的完整模型或节点；系统不会静默降级。</p> : null}
        {insufficientVram ? <p className="pipeline-warning"><AlertTriangle size={13} />当前检测到约 {vramGb.toFixed(1)}GB 显存，全部 H3 档位至少需要标称 8GB。</p> : null}
      </section>

      <section className="seed-setting">
        <label><span>Seed</span><input type="number" min={0} value={seed} onChange={(event) => setSeed(Math.max(0, Number(event.target.value) || 0))} /></label>
        <button type="button" title="随机种子" aria-label="生成随机种子" onClick={() => setSeed(Math.floor(Math.random() * 2_147_483_647))}><Dices size={16} /></button>
      </section>

      {submitError ? <div className="video-inline-error" role="alert"><AlertTriangle size={15} /><span>{submitError}</span></div> : null}

      <button
        type="button"
        className="video-submit-button"
        disabled={!canSubmit || submitting}
        onClick={() => onSubmit({
          mode,
          prompt,
          scenario,
          aspectRatio,
          duration,
          preset,
          modelProfile: 'auto',
          seed,
          audio,
          director,
          sourceElementId: mode === 'image-to-video' ? selectedImage?.id : undefined,
          lastFrameImageDataUrl: mode === 'image-to-video' ? lastFrame?.dataUrl : undefined,
        })}
      >
        {submitting ? <LoaderCircle className="is-spinning" size={17} /> : <Film size={17} />}
        {submitting ? '正在准备任务…' : presetUnavailable ? '高质量依赖尚未就绪' : ready ? '生成视频' : manualRuntimeUnavailable ? '等待外部 ComfyUI' : '启动 ComfyUI 并生成'}
      </button>
      <p className="video-runtime-note">{ready
        ? `当前 ${selectedPreset.label} · ${selectedPreset.detail}${presetCapability?.availableProfiles?.[0] ? ` · ${presetCapability.availableProfiles[0]}` : ''}`
        : '首次冷启动需加载节点与模型，后续连续任务会复用进程。'}</p>

      {activeJob ? (
        <section className="active-video-job">
          <div className="active-job-heading"><span><LoaderCircle className="is-spinning" size={16} /><strong>{activeJob.label}</strong></span><b>{activeJob.progress}%</b></div>
          <div className="active-job-progress"><span style={{ width: `${activeJob.progress}%` }} /></div>
          <div className="stage-track">
            {phaseGroups.map((group, index) => {
              const complete = currentPhase > index || activeJob.phase === 'completed'
              const current = currentPhase === index
              return <span className={complete ? 'is-complete' : current ? 'is-current' : ''} key={group.label}><i>{complete ? <Check size={10} /> : current ? <LoaderCircle size={10} /> : null}</i>{group.label}</span>
            })}
          </div>
          <div className="active-job-detail"><span>{activeJob.detail}</span><button type="button" onClick={() => onCancelJob(activeJob.id)}><Square size={11} />取消</button></div>
        </section>
      ) : null}
    </div>
  )
}
