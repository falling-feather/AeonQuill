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
  VideoGenerationMode,
  VideoJobPhase,
  VideoJobRequest,
} from '../types'

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

const phaseGroups: Array<{ label: string; phases: VideoJobPhase[] }> = [
  { label: '准备', phases: ['queued', 'preparing'] },
  { label: '条件', phases: ['conditioning'] },
  { label: '采样', phases: ['sampling'] },
  { label: '解码', phases: ['decoding', 'encoding'] },
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
}> = [
  {
    id: 'fast',
    label: '8GB 稳定预览',
    native: { '16:9': '608×352', '9:16': '352×608', '1:1': '448×448' },
    delivery: { '16:9': '608×352', '9:16': '352×608', '1:1': '448×448' },
    detail: '4 步 · 低显存 · 本机已验证',
    minVram: '8 GB',
    risk: '低',
  },
  {
    id: 'balanced',
    label: '8GB 细节',
    native: { '16:9': '608×352', '9:16': '352×608', '1:1': '448×448' },
    delivery: { '16:9': '608×352', '9:16': '352×608', '1:1': '448×448' },
    detail: '6 步 · 改善快速运动拖影',
    minVram: '8 GB',
    risk: '中',
  },
  {
    id: 'delivery720',
    label: '8GB · 720P 交付',
    native: { '16:9': '608×352', '9:16': '352×608', '1:1': '448×448' },
    delivery: { '16:9': '1280×720', '9:16': '720×1280', '1:1': '720×720' },
    detail: '6 步生成 · FFmpeg Lanczos 交付',
    minVram: '8 GB',
    risk: '中',
  },
  {
    id: 'nativeHigh',
    label: '原生高清实验',
    native: { '16:9': '736×416', '9:16': '416×736', '1:1': '544×544' },
    delivery: { '16:9': '736×416', '9:16': '416×736', '1:1': '544×544' },
    detail: '8 步 · 未在 8GB 本机执行',
    minVram: '12 GB+',
    risk: '高',
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

function compileDirectorPrompt(
  prompt: string,
  director: NonNullable<VideoJobRequest['director']>,
  audio: boolean,
) {
  const camera = {
    locked: 'locked-off camera, stable composition',
    'push-in': 'slow cinematic push-in',
    pan: 'smooth lateral pan',
    orbit: 'controlled gentle orbit around the subject',
    follow: 'smooth follow camera keeping the subject centered',
  }[director.camera]
  const motion = {
    subtle: 'subtle motion with small displacement',
    natural: 'natural medium motion with believable weight',
    dynamic: 'dynamic fast motion with clear anticipation and follow-through',
  }[director.motion]
  const continuity = director.continuity
    ? 'Preserve subject identity, clothing, scene geometry, lighting direction and visual style. No scene cut, no sudden morphing.'
    : 'Allow creative scene evolution while retaining the main subject.'
  const sound = audio
    ? director.soundscape || 'natural synchronized ambience matching the visible action'
    : 'No audio track.'
  const constraints = director.constraints || 'No subtitles, no watermark, no extra limbs, no duplicate subjects.'
  return `integrated_multimodal_description:\n${prompt.trim()}\nCamera: ${camera}. Motion: ${motion}.\nContinuity: ${continuity}\nVisual constraints: ${constraints}\noverall_soundscape: ${sound}`
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
  const [preset, setPreset] = useState<VideoJobRequest['preset']>('fast')
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 2_147_483_647))
  const [audio, setAudio] = useState(true)
  const [camera, setCamera] = useState<NonNullable<VideoJobRequest['director']>['camera']>('locked')
  const [motion, setMotion] = useState<NonNullable<VideoJobRequest['director']>['motion']>('natural')
  const [continuity, setContinuity] = useState(true)
  const [soundscape, setSoundscape] = useState('自然环境声与画面动作同步')
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
    setPrompt(
      reuseRequest.prompt
        .replace(/^integrated_multimodal_description:\s*/i, '')
        .split('\nCamera:')[0]
        .split('\noverall_soundscape:')[0],
    )
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
  const director = { camera, motion, continuity, soundscape, constraints }
  const compiledPrompt = useMemo(
    () => compileDirectorPrompt(prompt, director, audio),
    [audio, camera, constraints, continuity, motion, prompt, soundscape],
  )
  const selectedPreset = pipelinePresets.find((item) => item.id === preset) ?? pipelinePresets[0]
  const vramGb = (runtime?.vramTotal || 0) / 1024 ** 3
  const risky = selectedPreset.id === 'nativeHigh' && vramGb > 0 && vramGb < 12
  const manualRuntimeUnavailable = lifecycle?.policy === 'manual' && !ready
  const canSubmit = prompt.trim().length >= 2
    && (mode !== 'image-to-video' || selectedImage)
    && !risky
    && !manualRuntimeUnavailable

  const changeMode = (nextMode: VideoGenerationMode) => {
    setMode(nextMode)
    setPrompt(starterPrompts[nextMode])
    if (nextMode === 'text-to-video') setLastFrame(undefined)
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
              ? `${lifecycle?.owned ? '妙绘托管' : '外部进程'} · ${formatBytes(runtime?.vramFree)} 可用`
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
        <div className="video-section-label"><span>导演控制</span><small>确定性提示词编译</small></div>
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
        <label className="director-input"><span>画面约束</span><input value={constraints} onChange={(event) => setConstraints(event.target.value)} /></label>
        <details className="compiled-prompt"><summary>已编译提示词（预览）</summary><pre>{compiledPrompt}</pre></details>
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
              <button type="button" key={value} className={duration === value ? 'is-active' : ''} aria-pressed={duration === value} onClick={() => setDuration(value)}>{value}s</button>
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
          {pipelinePresets.map((item) => (
            <button type="button" key={item.id} className={preset === item.id ? 'is-active' : ''} aria-pressed={preset === item.id} onClick={() => setPreset(item.id)}>
              <span><strong>{item.label}</strong>{item.id === 'fast' ? <em>推荐</em> : null}</span>
              <small>{item.detail}</small>
              <dl>
                <div><dt>生成</dt><dd>{item.native[aspectRatio]}</dd></div>
                <div><dt>交付</dt><dd>{item.delivery[aspectRatio]}</dd></div>
                <div><dt>最低显存</dt><dd>{item.minVram}</dd></div>
                <div><dt>风险</dt><dd>{item.risk}</dd></div>
              </dl>
            </button>
          ))}
        </div>
        {preset === 'delivery720' ? <p className="pipeline-note">720P 档使用确定性放大获得标准交付尺寸，不宣称生成了原生 720P 细节。</p> : null}
        {risky ? <p className="pipeline-warning"><AlertTriangle size={13} />当前检测到约 {vramGb.toFixed(1)}GB 显存，原生高清实验档要求至少 12GB。</p> : null}
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
          prompt: compiledPrompt,
          aspectRatio,
          duration,
          preset,
          seed,
          audio,
          director,
          sourceElementId: mode === 'image-to-video' ? selectedImage?.id : undefined,
          lastFrameImageDataUrl: mode === 'image-to-video' ? lastFrame?.dataUrl : undefined,
        })}
      >
        {submitting ? <LoaderCircle className="is-spinning" size={17} /> : <Film size={17} />}
        {submitting ? '正在准备任务…' : ready ? '生成视频' : manualRuntimeUnavailable ? '等待外部 ComfyUI' : '启动 ComfyUI 并生成'}
      </button>
      <p className="video-runtime-note">{ready ? `当前 ${selectedPreset.label} · ${selectedPreset.detail}` : '首次冷启动需加载节点与模型，后续连续任务会复用进程。'}</p>

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
