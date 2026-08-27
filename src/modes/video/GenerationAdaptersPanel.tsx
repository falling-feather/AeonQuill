import { AlertTriangle, CheckCircle2, Film, Image as ImageIcon, KeyRound, Loader2, PlugZap, Square, Volume2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import {
  cancelGenerationJob,
  clearGenerationAdapter,
  configureGenerationAdapter,
  createAdapterVideoJob,
  fetchGenerationAdapterStatus,
  fetchGenerationJob,
  generateAdapterImage,
  generateAdapterSpeech,
  type GenerationAdapterConfig,
  type GenerationAdapterStatus,
  type GenerationCapability,
  type GenerationResult,
} from '../../lib/generationAdapterApi'
import type { ProcessingJob } from '../../types'

type GenerationAdaptersPanelProps = {
  projectId?: string
  projectTitle: string
  defaultPrompt: string
}

type AdapterForm = GenerationAdapterConfig

const EMPTY_STATUS: GenerationAdapterStatus = {
  image: { configured: false, persistence: 'memory-only', profile: 'openai-compatible-images-v1' },
  video: { configured: false, persistence: 'memory-only', profile: 'openai-compatible-videos-v1' },
  speech: { configured: false, persistence: 'memory-only', profile: 'openai-compatible-speech-v1' },
}

const CAPABILITY_META = {
  image: { label: '图像 API', unit: '$ / 张', Icon: ImageIcon },
  video: { label: '视频 API', unit: '$ / 秒', Icon: Film },
  speech: { label: 'TTS API', unit: '$ / 千字', Icon: Volume2 },
} satisfies Record<GenerationCapability, { label: string; unit: string; Icon: typeof ImageIcon }>

function createForm(capability: GenerationCapability): AdapterForm {
  return {
    providerLabel: 'OpenAI-compatible',
    endpoint: '',
    model: '',
    apiKey: '',
    timeoutMs: capability === 'video' ? 30 * 60_000 : 60_000,
    maxCostUsd: capability === 'video' ? 10 : 2,
    costRateUsd: 0,
    ...(capability === 'video' ? { pollIntervalMs: 1_000 } : {}),
  }
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : '生成适配器操作失败'
}

function money(value: number | null) {
  return value === null ? '未回报' : `$${value.toFixed(4)}`
}

export function GenerationAdaptersPanel({ projectId, projectTitle, defaultPrompt }: GenerationAdaptersPanelProps) {
  const [status, setStatus] = useState<GenerationAdapterStatus>(EMPTY_STATUS)
  const [forms, setForms] = useState<Record<GenerationCapability, AdapterForm>>({
    image: createForm('image'),
    video: createForm('video'),
    speech: createForm('speech'),
  })
  const [busy, setBusy] = useState<string | null>('status')
  const [notice, setNotice] = useState('三类密钥都只驻留本次 sidecar 内存；生成结果写入当前项目资源库。')
  const [imagePrompt, setImagePrompt] = useState(defaultPrompt.slice(0, 2_000))
  const [speechText, setSpeechText] = useState(defaultPrompt.slice(0, 1_000))
  const [videoPrompt, setVideoPrompt] = useState(defaultPrompt.slice(0, 2_000))
  const [imageReference, setImageReference] = useState('')
  const [videoReference, setVideoReference] = useState('')
  const [lastResult, setLastResult] = useState<GenerationResult | null>(null)
  const [videoJob, setVideoJob] = useState<ProcessingJob | null>(null)

  useEffect(() => {
    let disposed = false
    void fetchGenerationAdapterStatus()
      .then((value) => { if (!disposed) setStatus(value) })
      .catch((error) => { if (!disposed) setNotice(messageOf(error)) })
      .finally(() => { if (!disposed) setBusy(null) })
    return () => { disposed = true }
  }, [])

  useEffect(() => {
    if (!videoJob || ['completed', 'failed', 'cancelled'].includes(videoJob.status)) return
    let disposed = false
    let timer = 0
    const poll = async () => {
      try {
        const payload = await fetchGenerationJob(videoJob.id)
        if (disposed) return
        setVideoJob(payload.job)
        if (!['completed', 'failed', 'cancelled'].includes(payload.job.status)) timer = window.setTimeout(() => void poll(), 1_000)
      } catch (error) {
        if (!disposed) setNotice(messageOf(error))
      }
    }
    timer = window.setTimeout(() => void poll(), 700)
    return () => {
      disposed = true
      window.clearTimeout(timer)
    }
  }, [videoJob?.id, videoJob?.status])

  const generatedAsset = useMemo(() => {
    if (lastResult) return lastResult.asset
    if (videoJob?.status === 'completed' && videoJob.libraryAsset) return videoJob.libraryAsset as unknown as GenerationResult['asset']
    return null
  }, [lastResult, videoJob])

  const patchForm = (capability: GenerationCapability, patch: Partial<AdapterForm>) => {
    setForms((current) => ({ ...current, [capability]: { ...current[capability], ...patch } }))
  }

  const saveAdapter = async (capability: GenerationCapability) => {
    setBusy(`${capability}-save`)
    setNotice(`正在配置${CAPABILITY_META[capability].label}；密钥不会落盘。`)
    try {
      const next = await configureGenerationAdapter(capability, forms[capability])
      setStatus(next)
      patchForm(capability, { apiKey: '' })
      setNotice(`${CAPABILITY_META[capability].label}已在本次运行中启用。`)
    } catch (error) {
      setNotice(messageOf(error))
    } finally {
      setBusy(null)
    }
  }

  const removeAdapter = async (capability: GenerationCapability) => {
    setBusy(`${capability}-clear`)
    try {
      setStatus(await clearGenerationAdapter(capability))
      setNotice(`${CAPABILITY_META[capability].label}的会话密钥已清除。`)
    } catch (error) {
      setNotice(messageOf(error))
    } finally {
      setBusy(null)
    }
  }

  const runImage = async () => {
    if (!projectId) return setNotice('当前项目尚未完成 SQLite 同步，暂不能写入资源库。')
    setBusy('image-run')
    setLastResult(null)
    try {
      const result = await generateAdapterImage({
        projectId,
        title: `${projectTitle} · API 图像`,
        prompt: imagePrompt,
        size: '1536x1024',
        quality: 'high',
        budgetUsd: forms.image.maxCostUsd,
        ...(imageReference.trim() ? { referenceAssetId: imageReference.trim() } : {}),
      })
      setLastResult(result)
      setNotice(`图像已进入项目资源库；预计 ${money(result.usage.estimatedCostUsd)}，上游回报 ${money(result.usage.actualCostUsd)}。`)
    } catch (error) {
      setNotice(messageOf(error))
    } finally {
      setBusy(null)
    }
  }

  const runSpeech = async () => {
    if (!projectId) return setNotice('当前项目尚未完成 SQLite 同步，暂不能写入资源库。')
    setBusy('speech-run')
    setLastResult(null)
    try {
      const result = await generateAdapterSpeech({
        projectId,
        title: `${projectTitle} · API 配音`,
        text: speechText,
        voice: 'alloy',
        format: 'mp3',
        speed: 1,
        budgetUsd: forms.speech.maxCostUsd,
      })
      setLastResult(result)
      setNotice(`配音已进入项目资源库；预计 ${money(result.usage.estimatedCostUsd)}，上游回报 ${money(result.usage.actualCostUsd)}。`)
    } catch (error) {
      setNotice(messageOf(error))
    } finally {
      setBusy(null)
    }
  }

  const runVideo = async () => {
    if (!projectId) return setNotice('当前项目尚未完成 SQLite 同步，暂不能创建外部视频任务。')
    setBusy('video-run')
    setVideoJob(null)
    try {
      const payload = await createAdapterVideoJob({
        projectId,
        title: `${projectTitle} · API 视频`,
        prompt: videoPrompt,
        size: '1280x720',
        durationSeconds: 5,
        budgetUsd: forms.video.maxCostUsd,
        ...(videoReference.trim() ? { referenceAssetId: videoReference.trim() } : {}),
      })
      setVideoJob(payload.job)
      setNotice('外部视频已进入统一 Job 队列；可以取消，完成后会自动写入项目资源库。')
    } catch (error) {
      setNotice(messageOf(error))
    } finally {
      setBusy(null)
    }
  }

  const cancelVideo = async () => {
    if (!videoJob) return
    setBusy('video-cancel')
    try {
      const payload = await cancelGenerationJob(videoJob.id)
      setVideoJob(payload.job)
      setNotice('外部视频任务已取消。')
    } catch (error) {
      setNotice(messageOf(error))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="aq-generation-adapters" aria-label="图像视频语音 BYOK 适配器">
      <header>
        <span><PlugZap size={14} /> 生成 API 适配器</span>
        <b>{Object.values(status).filter((item) => item.configured).length} / 3 已启用</b>
      </header>
      <p className="aq-generation-adapters-boundary"><KeyRound size={13} /> 固定请求/响应协议、费用上限、MIME 与大小复检；密钥不进入项目、浏览器、日志或导出。</p>
      <div className="aq-generation-adapter-list">
        {(Object.keys(CAPABILITY_META) as GenerationCapability[]).map((capability) => {
          const meta = CAPABILITY_META[capability]
          const entry = status[capability]
          const form = forms[capability]
          const Icon = meta.Icon
          return (
            <details key={capability} className={entry.configured ? 'is-ready' : ''}>
              <summary>
                <span><Icon size={14} /> {meta.label}</span>
                <small>{entry.configured ? `${entry.providerLabel} · ${entry.model}` : '未配置'}</small>
                {entry.configured ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
              </summary>
              <div className="aq-generation-adapter-config">
                <label><span>服务名称</span><input value={form.providerLabel} maxLength={80} onChange={(event) => patchForm(capability, { providerLabel: event.target.value })} /></label>
                <label><span>HTTPS / 回环基址</span><input value={form.endpoint} placeholder="https://provider.example/v1" spellCheck={false} onChange={(event) => patchForm(capability, { endpoint: event.target.value })} /></label>
                <label><span>模型</span><input value={form.model} placeholder="model-id" spellCheck={false} onChange={(event) => patchForm(capability, { model: event.target.value })} /></label>
                <label><span>API Key</span><input type="password" value={form.apiKey} autoComplete="off" placeholder="仅本次运行" onChange={(event) => patchForm(capability, { apiKey: event.target.value })} /></label>
                <label><span>{meta.unit}</span><input type="number" min="0" max="100" step="0.0001" value={form.costRateUsd} onChange={(event) => patchForm(capability, { costRateUsd: Number(event.target.value) })} /></label>
                <label><span>单次费用上限 $</span><input type="number" min="0" max="1000" step="0.01" value={form.maxCostUsd} onChange={(event) => patchForm(capability, { maxCostUsd: Number(event.target.value) })} /></label>
              </div>
              <footer className="aq-generation-adapter-actions">
                {entry.configured ? <button type="button" onClick={() => void removeAdapter(capability)} disabled={busy !== null}>清除会话</button> : null}
                <button type="button" className="is-save" onClick={() => void saveAdapter(capability)} disabled={busy !== null || !form.endpoint.trim() || !form.model.trim() || !form.apiKey.trim()}>
                  {busy === `${capability}-save` ? <Loader2 size={13} className="is-spinning" /> : <KeyRound size={13} />}
                  {entry.configured ? '替换配置' : '本次运行启用'}
                </button>
              </footer>
              {capability === 'image' ? (
                <div className="aq-generation-adapter-smoke">
                  <textarea value={imagePrompt} maxLength={6_000} onChange={(event) => setImagePrompt(event.target.value)} aria-label="API 图像提示词" />
                  <input value={imageReference} onChange={(event) => setImageReference(event.target.value)} placeholder="可选：参考资源 SHA-256" spellCheck={false} />
                  <button type="button" onClick={() => void runImage()} disabled={!entry.configured || busy !== null || !imagePrompt.trim()}>{busy === 'image-run' ? <Loader2 size={13} className="is-spinning" /> : <ImageIcon size={13} />} 生成并入库</button>
                </div>
              ) : capability === 'speech' ? (
                <div className="aq-generation-adapter-smoke">
                  <textarea value={speechText} maxLength={8_000} onChange={(event) => setSpeechText(event.target.value)} aria-label="API 配音文本" />
                  <button type="button" onClick={() => void runSpeech()} disabled={!entry.configured || busy !== null || !speechText.trim()}>{busy === 'speech-run' ? <Loader2 size={13} className="is-spinning" /> : <Volume2 size={13} />} 合成并入库</button>
                </div>
              ) : (
                <div className="aq-generation-adapter-smoke">
                  <textarea value={videoPrompt} maxLength={6_000} onChange={(event) => setVideoPrompt(event.target.value)} aria-label="API 视频提示词" />
                  <input value={videoReference} onChange={(event) => setVideoReference(event.target.value)} placeholder="可选：首帧资源 SHA-256" spellCheck={false} />
                  <button type="button" onClick={() => void runVideo()} disabled={!entry.configured || busy !== null || !videoPrompt.trim()}>{busy === 'video-run' ? <Loader2 size={13} className="is-spinning" /> : <Film size={13} />} 创建 5 秒 720P 任务</button>
                  {videoJob ? <div className={`aq-generation-job is-${videoJob.status}`}><span>{videoJob.status} · {videoJob.progress}%</span><small>{videoJob.detail}</small>{!['completed', 'failed', 'cancelled'].includes(videoJob.status) ? <button type="button" onClick={() => void cancelVideo()} disabled={busy !== null}><Square size={11} />取消</button> : null}</div> : null}
                </div>
              )}
            </details>
          )
        })}
      </div>
      <p className="aq-generation-adapter-notice" role="status">{notice}</p>
      {generatedAsset ? <a className="aq-generation-asset-result" href={generatedAsset.version.url} target="_blank" rel="noreferrer"><CheckCircle2 size={13} /> {generatedAsset.title} · {(generatedAsset.version.bytes / 1024 / 1024).toFixed(2)} MiB</a> : null}
    </section>
  )
}
