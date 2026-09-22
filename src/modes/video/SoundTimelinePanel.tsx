import {
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  FileAudio2,
  Loader2,
  Music2,
  RotateCcw,
  Save,
  SlidersHorizontal,
  Square,
  Subtitles,
  UserRoundCog,
  Volume2,
  WandSparkles,
} from 'lucide-react'
import { useEffect, useMemo, useState, type ChangeEvent } from 'react'
import './SoundTimelinePanel.css'
import type { ProcessingJob } from '../../types'
import type {
  SoundAudioCue,
  SoundSubtitleCue,
  SoundTimeline,
  SoundVoiceProfile,
} from '../../lib/story/soundTimeline.mjs'
import { soundTimelineSummary } from '../../lib/story/soundTimeline.mjs'
import {
  assertSoundAlignmentCandidate,
  previewSoundAlignment,
} from '../../lib/story/soundAlignment.mjs'
import type {
  SoundAlignmentCandidate,
  SoundAlignmentPreview,
} from '../../lib/story/soundAlignment.mjs'
import type { VideoProductionCommandType, VideoProductionProject } from '../../lib/story/productionPipeline.mjs'
import type { SpeechAlignmentResult } from '../../lib/speechAlignmentApi'

export type SpeechAlignmentRequest = {
  cueId: string
  cueFingerprint: string
  audioContentHash: string
  text: string
  language: string
  durationMs: number
}

export type LocalSoundRemixRequest = {
  cueIds: [string, string]
  overlapMs: number
}

export type SoundTimelinePanelProps = {
  project: VideoProductionProject
  assetTargetId: string | null
  onChooseAsset: (cueId: string) => void
  onCommand: (type: VideoProductionCommandType, payload?: Record<string, unknown>, successMessage?: string) => void
  jobs: ProcessingJob[]
  executionAvailable: boolean
  busy: 'prepare-speech' | 'render-mix' | 'cancel' | 'retry' | null
  onPrepareSpeech: (format: 'mp3' | 'wav', speechBudgetUsd: number) => void
  onRenderMix: () => void
  onCancelJob: (jobId: string) => void
  onRetryJob: (jobId: string) => void
  onRunSpeechAlignment?: (request: SpeechAlignmentRequest) => Promise<SpeechAlignmentResult>
  onApplyLocalRemix?: (request: LocalSoundRemixRequest) => void | Promise<void>
  alignmentBusy?: boolean
}

type SoundTab = 'voices' | 'audio' | 'subtitles' | 'mix'
type CueFilter = 'all' | 'speech' | 'music' | 'ambience' | 'sfx'

const CUE_LABELS: Record<SoundAudioCue['kind'], string> = {
  dialogue: '对白',
  narration: '旁白',
  music: '音乐',
  ambience: '环境声',
  sfx: '音效',
}

function seconds(value: number) {
  return (value / 1_000).toFixed(2)
}

function milliseconds(value: string) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.round(parsed * 1_000) : Number.NaN
}

function VoiceEditor({ profile, onCommand }: {
  profile: SoundVoiceProfile
  onCommand: SoundTimelinePanelProps['onCommand']
}) {
  const [providerLabel, setProviderLabel] = useState(profile.providerLabel)
  const [voiceId, setVoiceId] = useState(profile.voiceId)
  const [language, setLanguage] = useState(profile.language)
  const [speed, setSpeed] = useState(String(profile.speed))
  const changed = providerLabel !== profile.providerLabel
    || voiceId !== profile.voiceId
    || language !== profile.language
    || Number(speed) !== profile.speed
  return (
    <article className={`aq-sound-voice-card is-${profile.status}`}>
      <header>
        <div><strong>{profile.speaker}</strong><small>{profile.characterId ? '角色声线' : '旁白声线'}</small></div>
        <span>{profile.status === 'approved' ? '已批准' : profile.status === 'configured' ? '待试听批准' : '待配置'}</span>
      </header>
      <div className="aq-sound-form-grid">
        <label><span>服务标签</span><input value={providerLabel} maxLength={120} placeholder="OpenAI-compatible" onChange={(event) => setProviderLabel(event.target.value)} /></label>
        <label><span>Voice ID</span><input value={voiceId} maxLength={160} placeholder="alloy / provider voice" onChange={(event) => setVoiceId(event.target.value)} /></label>
        <label><span>语言</span><input value={language} maxLength={32} onChange={(event) => setLanguage(event.target.value)} /></label>
        <label><span>语速</span><input type="number" min={0.5} max={2} step={0.05} value={speed} onChange={(event) => setSpeed(event.target.value)} /></label>
      </div>
      <footer>
        <button type="button" disabled={!changed || !providerLabel.trim() || !voiceId.trim() || !Number.isFinite(Number(speed))} onClick={() => onCommand('sound.voice.configure', {
          profileId: profile.id,
          patch: { providerLabel, voiceId, language, speed: Number(speed) },
        }, `已更新“${profile.speaker}”声线；关联的旧配音会自动失效。`)}><Save size={13} /> 保存声线</button>
        {profile.status === 'configured' ? <button type="button" className="is-approve" onClick={() => onCommand('sound.voice.approve', { profileId: profile.id }, `已批准“${profile.speaker}”声线。`)}><Check size={13} /> 批准</button> : null}
      </footer>
    </article>
  )
}

function CueEditor({ cue, selected, onChooseAsset, onCommand, alignmentSelected = false, onSelectAlignment }: {
  cue: SoundAudioCue
  selected: boolean
  onChooseAsset: (cueId: string) => void
  onCommand: SoundTimelinePanelProps['onCommand']
  alignmentSelected?: boolean
  onSelectAlignment?: () => void
}) {
  const [text, setText] = useState(cue.text)
  const [start, setStart] = useState(seconds(cue.startMs))
  const [end, setEnd] = useState(seconds(cue.endMs))
  const [gain, setGain] = useState(String(cue.gainDb))
  const [fadeIn, setFadeIn] = useState(seconds(cue.fadeInMs))
  const [fadeOut, setFadeOut] = useState(seconds(cue.fadeOutMs))
  const numeric = [milliseconds(start), milliseconds(end), Number(gain), milliseconds(fadeIn), milliseconds(fadeOut)]
  const changed = text !== cue.text
    || milliseconds(start) !== cue.startMs
    || milliseconds(end) !== cue.endMs
    || Number(gain) !== cue.gainDb
    || milliseconds(fadeIn) !== cue.fadeInMs
    || milliseconds(fadeOut) !== cue.fadeOutMs
  return (
    <article className={`aq-sound-cue-card is-${cue.status}${selected ? ' is-target' : ''}`} data-sound-cue={cue.id}>
      <header>
        <div><strong>{CUE_LABELS[cue.kind]}{cue.speakerLabel ? ` · ${cue.speakerLabel}` : ''}</strong><small>{seconds(cue.startMs)}–{seconds(cue.endMs)} 秒 · {cue.gainDb} dB</small></div>
        <span>{cue.status === 'approved' ? '已批准' : cue.status === 'ready' ? '待批准' : cue.required ? '必需音频' : '可选音频'}</span>
      </header>
      <p>{cue.text}</p>
      {cue.asset ? <code>sha256:{cue.asset.contentHash.slice(0, 12)}… · {cue.asset.mimeType}</code> : null}
      <details>
        <summary><SlidersHorizontal size={13} /> 编辑时间与混音参数</summary>
        <div className="aq-sound-form-grid">
          <label className="is-wide"><span>内容/生成提示</span><textarea value={text} maxLength={2_000} onChange={(event) => setText(event.target.value)} /></label>
          <label><span>开始（秒）</span><input inputMode="decimal" value={start} onChange={(event) => setStart(event.target.value)} /></label>
          <label><span>结束（秒）</span><input inputMode="decimal" value={end} onChange={(event) => setEnd(event.target.value)} /></label>
          <label><span>增益 dB</span><input type="number" min={-60} max={12} step={0.1} value={gain} onChange={(event) => setGain(event.target.value)} /></label>
          <label><span>淡入（秒）</span><input inputMode="decimal" value={fadeIn} onChange={(event) => setFadeIn(event.target.value)} /></label>
          <label><span>淡出（秒）</span><input inputMode="decimal" value={fadeOut} onChange={(event) => setFadeOut(event.target.value)} /></label>
        </div>
        <button type="button" disabled={!changed || numeric.some((value) => !Number.isFinite(value)) || !text.trim()} onClick={() => onCommand('sound.cue.patch', {
          cueId: cue.id,
          patch: {
            text,
            startMs: milliseconds(start),
            endMs: milliseconds(end),
            gainDb: Number(gain),
            fadeInMs: milliseconds(fadeIn),
            fadeOutMs: milliseconds(fadeOut),
          },
        }, `已保存${CUE_LABELS[cue.kind]}片段；关联审批按变更范围失效。`)}><Save size={13} /> 保存片段</button>
      </details>
      <footer>
        <button type="button" className={selected ? 'is-selected' : ''} onClick={() => onChooseAsset(cue.id)}><FileAudio2 size={13} /> {cue.asset ? '替换资源' : '选择音频'}</button>
        {['dialogue', 'narration'].includes(cue.kind) && cue.asset && onSelectAlignment ? <button type="button" className={alignmentSelected ? 'is-selected' : ''} onClick={onSelectAlignment}>对齐片段</button> : null}
        {cue.status === 'ready' ? <button type="button" className="is-approve" onClick={() => onCommand('sound.asset.approve', { cueId: cue.id }, `已批准${CUE_LABELS[cue.kind]}音频。`)}><Check size={13} /> 批准</button> : null}
        {cue.asset ? <button type="button" onClick={() => onCommand('sound.asset.unbind', { cueId: cue.id }, `已移除${CUE_LABELS[cue.kind]}音频。`)}>移除</button> : null}
      </footer>
    </article>
  )
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '对齐候选无效'
}

function AlignmentTimeInput({ value, label, onCommit }: { value: number; label: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(seconds(value))
  useEffect(() => setDraft(seconds(value)), [value])
  return <input inputMode="decimal" value={draft} aria-label={label} onChange={(event) => setDraft(event.target.value)} onBlur={() => onCommit(draft)} />
}

function AlignmentEditor({
  timeline,
  cue,
  onCommand,
  onRunSpeechAlignment,
  alignmentBusy = false,
}: {
  timeline: SoundTimeline
  cue: SoundAudioCue
  onCommand: SoundTimelinePanelProps['onCommand']
  onRunSpeechAlignment?: SoundTimelinePanelProps['onRunSpeechAlignment']
  alignmentBusy?: boolean
}) {
  const voice = timeline.voiceProfiles.find(({ id }) => id === cue.voiceProfileId)
  const [duration, setDuration] = useState(seconds(cue.endMs - cue.startMs))
  const [candidate, setCandidate] = useState<SoundAlignmentCandidate | null>(null)
  const [message, setMessage] = useState('')
  const [running, setRunning] = useState(false)
  const durationMs = milliseconds(duration)
  const previewState = useMemo(() => {
    if (!candidate) return { preview: null as SoundAlignmentPreview | null, error: '' }
    if (!Number.isSafeInteger(durationMs) || durationMs < 1) return { preview: null, error: '请输入有效的实际音频时长。' }
    try {
      return { preview: previewSoundAlignment(timeline, candidate, { durationMs }), error: '' }
    } catch (error) {
      return { preview: null, error: errorMessage(error) }
    }
  }, [candidate, durationMs, timeline])

  useEffect(() => {
    setDuration(seconds(cue.endMs - cue.startMs))
    setCandidate(null)
    setMessage('')
  }, [cue.id])

  const updateWord = (index: number, field: 'text' | 'startMs' | 'endMs', value: string) => {
    setCandidate((current) => {
      if (!current) return current
      const words = current.words.map((word, wordIndex) => {
        if (wordIndex !== index) return word
        if (field === 'text') return { ...word, text: value }
        return { ...word, [field]: milliseconds(value) }
      })
      return { ...current, words }
    })
    setMessage('')
  }

  const importCandidate = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const parsed = JSON.parse(await file.text()) as SoundAlignmentCandidate
      const next = assertSoundAlignmentCandidate(parsed, { durationMs })
      if (next.cueId !== cue.id) throw new Error('候选不属于当前选定语音片段。')
      setCandidate(next)
      setMessage('已载入暂态候选；确认预览后才会修改字幕时间。')
    } catch (error) {
      setCandidate(null)
      setMessage(errorMessage(error))
    }
  }

  const runAlignment = async () => {
    if (!onRunSpeechAlignment || !cue.asset || !Number.isSafeInteger(durationMs) || durationMs < 1) return
    setRunning(true)
    setMessage('正在请求本地对齐；不会自动批准音频或字幕。')
    try {
      const result = await onRunSpeechAlignment({
        cueId: cue.id,
        cueFingerprint: cue.fingerprint,
        audioContentHash: cue.asset.contentHash,
        text: cue.text,
        language: voice?.language ?? 'zh-CN',
        durationMs,
      })
      if (result) {
        const next = assertSoundAlignmentCandidate(result.candidate, { durationMs: result.durationMs })
        setDuration(seconds(result.durationMs))
        setCandidate(next)
        setMessage('本地对齐候选已返回；请逐词检查并明确应用。')
      }
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setRunning(false)
    }
  }

  return (
    <article className="aq-sound-alignment-card" data-alignment-cue={cue.id}>
      <header>
        <div><strong>语音强制对齐</strong><small>{cue.speakerLabel ?? '语音'} · 候选只绑定当前 cue 与音频哈希</small></div>
        <span>{candidate?.source === 'whisperx' ? '本地 WhisperX' : candidate ? '手动候选' : '未载入'}</span>
      </header>
      <div className="aq-sound-alignment-controls">
        <label><span>实际音频时长（秒）</span><input inputMode="decimal" value={duration} onChange={(event) => setDuration(event.target.value)} /></label>
      </div>
      <p className="aq-sound-alignment-note">相对音频起点的词时间会换算为绝对字幕时间；候选不会写入正文，应用前可逐词修正。</p>
      <div className="aq-sound-alignment-actions">
        <button type="button" disabled={!onRunSpeechAlignment || !cue.asset || !Number.isSafeInteger(durationMs) || durationMs < 1 || running || alignmentBusy} onClick={() => { void runAlignment() }}>
          {running || alignmentBusy ? '对齐中…' : '调用本地对齐'}
        </button>
        <label className="aq-sound-alignment-import"><span>导入 JSON</span><input type="file" accept="application/json,.json" onChange={(event) => { void importCandidate(event) }} /></label>
        <button type="button" className="is-primary" disabled={!previewState.preview} onClick={() => {
          if (!previewState.preview) return
          onCommand('sound.subtitle.patch', {
            subtitleId: previewState.preview.subtitleId,
            patch: previewState.preview.patch,
          }, '对齐时间已应用到关联字幕；字幕仍需人工批准。')
        }}>明确应用时间</button>
      </div>
      {message ? <p className="aq-sound-alignment-message">{message}</p> : null}
      {previewState.error ? <p className="aq-sound-alignment-error">{previewState.error}</p> : null}
      {previewState.preview ? (
        <div className="aq-sound-alignment-preview">
          <header><strong>时间预览</strong><span>{seconds(previewState.preview.patch.startMs)}–{seconds(previewState.preview.patch.endMs)} 秒 · 不会自动批准</span></header>
          <div className="aq-sound-alignment-words">
            {candidate?.words.map((word, index) => (
              <div key={index}>
                <input value={word.text} aria-label={`第 ${index + 1} 个词`} onChange={(event) => updateWord(index, 'text', event.target.value)} />
                <AlignmentTimeInput value={word.startMs} label={`第 ${index + 1} 个词入点`} onCommit={(value) => updateWord(index, 'startMs', value)} />
                <AlignmentTimeInput value={word.endMs} label={`第 ${index + 1} 个词出点`} onCommit={(value) => updateWord(index, 'endMs', value)} />
                <small>{word.confidence === undefined ? '—' : `${Math.round(word.confidence * 100)}%`}</small>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </article>
  )
}

function SubtitleEditor({ cue, onCommand }: { cue: SoundSubtitleCue; onCommand: SoundTimelinePanelProps['onCommand'] }) {
  const [text, setText] = useState(cue.text)
  const [start, setStart] = useState(seconds(cue.startMs))
  const [end, setEnd] = useState(seconds(cue.endMs))
  const valid = Number.isFinite(milliseconds(start)) && Number.isFinite(milliseconds(end)) && text.trim()
  const changed = text !== cue.text || milliseconds(start) !== cue.startMs || milliseconds(end) !== cue.endMs
  return (
    <article className={`aq-sound-subtitle-card is-${cue.status}`} data-subtitle-cue={cue.id}>
      <header><strong>{seconds(cue.startMs)}–{seconds(cue.endMs)} 秒</strong><span>{cue.status === 'approved' ? '已批准' : '待校对'}</span></header>
      <textarea value={text} maxLength={2_000} onChange={(event) => setText(event.target.value)} />
      <div className="aq-sound-subtitle-times">
        <label><span>入</span><input inputMode="decimal" value={start} onChange={(event) => setStart(event.target.value)} /></label>
        <label><span>出</span><input inputMode="decimal" value={end} onChange={(event) => setEnd(event.target.value)} /></label>
      </div>
      <footer>
        <button type="button" disabled={!changed || !valid} onClick={() => onCommand('sound.subtitle.patch', {
          subtitleId: cue.id,
          patch: { text, startMs: milliseconds(start), endMs: milliseconds(end) },
        }, '字幕文本与时间码已保存，等待重新批准。')}><Save size={13} /> 保存</button>
        {cue.status === 'draft' ? <button type="button" className="is-approve" onClick={() => onCommand('sound.subtitle.approve', { subtitleId: cue.id }, '当前字幕已批准。')}><Check size={13} /> 批准</button> : null}
      </footer>
    </article>
  )
}

function LocalRemixEditor({ timeline, onApplyLocalRemix }: {
  timeline: SoundTimeline
  onCommand: SoundTimelinePanelProps['onCommand']
  onApplyLocalRemix?: SoundTimelinePanelProps['onApplyLocalRemix']
}) {
  const pairs = useMemo(() => {
    const result: Array<{ left: SoundAudioCue; right: SoundAudioCue }> = []
    const grouped = new Map<SoundAudioCue['kind'], SoundAudioCue[]>()
    for (const cue of timeline.audioCues) {
      const group = grouped.get(cue.kind) ?? []
      group.push(cue)
      grouped.set(cue.kind, group)
    }
    for (const group of grouped.values()) {
      group.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs || left.id.localeCompare(right.id))
      for (let index = 0; index + 1 < group.length; index += 1) {
        const left = group[index]
        const right = group[index + 1]
        if (right.startMs <= left.endMs && left.status === 'approved' && right.status === 'approved' && left.asset && right.asset) result.push({ left, right })
      }
    }
    return result
  }, [timeline.audioCues])
  const [pairKey, setPairKey] = useState('')
  const [overlap, setOverlap] = useState('120')
  const [applying, setApplying] = useState(false)
  const [message, setMessage] = useState('')
  const pair = pairs.find(({ left, right }) => `${left.id}:${right.id}` === pairKey) ?? pairs[0] ?? null
  const overlapMs = Number(overlap)
  const maxOverlapMs = pair ? Math.min(pair.left.endMs - pair.left.startMs, pair.right.endMs - pair.right.startMs) : 0
  const valid = Boolean(pair)
    && Number.isSafeInteger(overlapMs)
    && overlapMs >= 1
    && overlapMs <= maxOverlapMs
    && overlapMs <= 10_000
    && Boolean(onApplyLocalRemix)

  useEffect(() => {
    if (!pairKey && pairs[0]) setPairKey(`${pairs[0].left.id}:${pairs[0].right.id}`)
    if (pairKey && !pairs.some(({ left, right }) => `${left.id}:${right.id}` === pairKey)) setPairKey('')
  }, [pairKey, pairs])

  const apply = async () => {
    if (!pair || !valid) return
    setApplying(true)
    try {
      const request: LocalSoundRemixRequest = { cueIds: [pair.left.id, pair.right.id], overlapMs }
      if (onApplyLocalRemix) {
        await onApplyLocalRemix(request)
        setMessage('局部试听已排队，完成后可在声音任务中播放。')
      }
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setApplying(false)
    }
  }

  return (
    <article className="aq-sound-local-remix-card">
      <header><div><strong>局部交叉淡化试听</strong><small>选择两条相邻、同类且已批准的音频</small></div><span>{pairs.length ? `${pairs.length} 组可用` : '暂无可用组'}</span></header>
      {pair ? (
        <>
          <div className="aq-sound-form-grid">
            <label className="is-wide"><span>相邻 cue</span><select value={`${pair.left.id}:${pair.right.id}`} onChange={(event) => setPairKey(event.target.value)}>{pairs.map(({ left, right }) => <option key={`${left.id}:${right.id}`} value={`${left.id}:${right.id}`}>{CUE_LABELS[left.kind]} · {seconds(left.startMs)}–{seconds(left.endMs)} → {seconds(right.startMs)}–{seconds(right.endMs)}</option>)}</select></label>
            <label><span>交叉淡化时长（毫秒）</span><input type="number" min={1} max={maxOverlapMs} step={1} value={overlap} onChange={(event) => setOverlap(event.target.value)} /></label>
          </div>
          <p className="aq-sound-local-remix-preview">预览：{pair.left.text} → {pair.right.text} · 仅重混 {seconds(pair.left.startMs)}–{seconds(pair.right.endMs)} 秒 · 其余 {timeline.audioCues.length - 2} 条 cue 保留。</p>
          <footer><button type="button" className="is-primary" disabled={!valid || applying} onClick={() => { void apply() }}>{applying ? '提交中…' : '渲染局部试听'}</button></footer>
        </>
      ) : <p className="aq-sound-local-remix-empty">先绑定并批准两条相邻的同类音频，即可试听过渡效果。</p>}
      {message ? <p role="status">{message}</p> : null}
    </article>
  )
}

function MixEditor({ timeline, onCommand, onApplyLocalRemix }: { timeline: SoundTimeline; onCommand: SoundTimelinePanelProps['onCommand']; onApplyLocalRemix?: SoundTimelinePanelProps['onApplyLocalRemix'] }) {
  const style = timeline.subtitleStyle
  const mix = timeline.mix
  const [position, setPosition] = useState(style.position)
  const [maxLines, setMaxLines] = useState(String(style.maxLines))
  const [safeMargin, setSafeMargin] = useState(String(style.safeMarginPercent))
  const [fontScale, setFontScale] = useState(String(style.fontScalePercent))
  const [background, setBackground] = useState(style.background)
  const [targetLufs, setTargetLufs] = useState(String(mix.targetLufs))
  const [truePeak, setTruePeak] = useState(String(mix.truePeakDbtp))
  const [ducking, setDucking] = useState(String(mix.dialogueDuckingDb))
  const styleChanged = position !== style.position || Number(maxLines) !== style.maxLines || Number(safeMargin) !== style.safeMarginPercent || Number(fontScale) !== style.fontScalePercent || background !== style.background
  const mixChanged = Number(targetLufs) !== mix.targetLufs || Number(truePeak) !== mix.truePeakDbtp || Number(ducking) !== mix.dialogueDuckingDb
  return (
    <div className="aq-sound-mix-grid">
      <LocalRemixEditor timeline={timeline} onCommand={onCommand} onApplyLocalRemix={onApplyLocalRemix} />
      <article>
        <header><div><strong>字幕安全区与样式</strong><small>不会把字幕交给 H3 生成</small></div><span>{style.status === 'approved' ? '已批准' : '待批准'}</span></header>
        <div className="aq-sound-form-grid">
          <label><span>位置</span><select value={position} onChange={(event) => setPosition(event.target.value as typeof position)}><option value="bottom">底部</option><option value="top">顶部</option></select></label>
          <label><span>最多行数</span><select value={maxLines} onChange={(event) => setMaxLines(event.target.value)}><option value="1">1 行</option><option value="2">2 行</option></select></label>
          <label><span>安全边距 %</span><input type="number" min={5} max={20} step={1} value={safeMargin} onChange={(event) => setSafeMargin(event.target.value)} /></label>
          <label><span>字号比例 %</span><input type="number" min={70} max={140} step={1} value={fontScale} onChange={(event) => setFontScale(event.target.value)} /></label>
          <label className="is-wide"><span>底板</span><select value={background} onChange={(event) => setBackground(event.target.value as typeof background)}><option value="shadow">描边/阴影</option><option value="box">半透明底板</option><option value="none">无底板</option></select></label>
        </div>
        <footer>
          <button type="button" disabled={!styleChanged} onClick={() => onCommand('sound.subtitle-style.patch', { patch: { position, maxLines: Number(maxLines), safeMarginPercent: Number(safeMargin), fontScalePercent: Number(fontScale), background } }, '字幕样式已更新，等待批准。')}><Save size={13} /> 保存样式</button>
          {style.status === 'draft' ? <button type="button" className="is-approve" onClick={() => onCommand('sound.subtitle-style.approve', {}, '字幕安全区与样式已批准。')}><Check size={13} /> 批准样式</button> : null}
        </footer>
      </article>
      <article>
        <header><div><strong>最终混音规格</strong><small>固定 48kHz · 双声道</small></div><span>{mix.status === 'approved' ? '已批准' : '待批准'}</span></header>
        <div className="aq-sound-form-grid">
          <label><span>目标 LUFS</span><input type="number" min={-24} max={-9} step={0.1} value={targetLufs} onChange={(event) => setTargetLufs(event.target.value)} /></label>
          <label><span>真峰值 dBTP</span><input type="number" min={-3} max={-0.1} step={0.1} value={truePeak} onChange={(event) => setTruePeak(event.target.value)} /></label>
          <label className="is-wide"><span>对白闪避 dB</span><input type="number" min={-18} max={0} step={0.1} value={ducking} onChange={(event) => setDucking(event.target.value)} /></label>
        </div>
        <footer>
          <button type="button" disabled={!mixChanged} onClick={() => onCommand('sound.mix.patch', { patch: { targetLufs: Number(targetLufs), truePeakDbtp: Number(truePeak), dialogueDuckingDb: Number(ducking) } }, '混音规格已更新，等待批准。')}><Save size={13} /> 保存混音</button>
          {mix.status === 'draft' ? <button type="button" className="is-approve" onClick={() => onCommand('sound.mix.approve', {}, '最终混音规格已批准。')}><Check size={13} /> 批准混音</button> : null}
        </footer>
      </article>
    </div>
  )
}

export function SoundTimelinePanel({
  project,
  assetTargetId,
  onChooseAsset,
  onCommand,
  jobs,
  executionAvailable,
  busy,
  onPrepareSpeech,
  onRenderMix,
  onCancelJob,
  onRetryJob,
  onRunSpeechAlignment,
  onApplyLocalRemix,
  alignmentBusy = false,
}: SoundTimelinePanelProps) {
  const timeline = project.soundTimeline
  const summary = useMemo(() => soundTimelineSummary(timeline), [timeline])
  const missingSpeech = useMemo(() => timeline.audioCues.filter((cue) => (
    ['dialogue', 'narration'].includes(cue.kind) && cue.asset === null
  )).length, [timeline.audioCues])
  const [speechFormat, setSpeechFormat] = useState<'mp3' | 'wav'>('mp3')
  const [speechBudget, setSpeechBudget] = useState('5')
  const [tab, setTab] = useState<SoundTab>('audio')
  const [filter, setFilter] = useState<CueFilter>('all')
  const [page, setPage] = useState(0)
  const [subtitlePage, setSubtitlePage] = useState(0)
  const [alignmentCueId, setAlignmentCueId] = useState<string | null>(null)
  const filteredCues = useMemo(() => timeline.audioCues.filter((cue) => (
    filter === 'all' || (filter === 'speech' ? cue.kind === 'dialogue' || cue.kind === 'narration' : cue.kind === filter)
  )), [filter, timeline.audioCues])
  const pageCount = Math.max(1, Math.ceil(filteredCues.length / 8))
  const pagedCues = filteredCues.slice(page * 8, page * 8 + 8)
  const subtitlePageCount = Math.max(1, Math.ceil(timeline.subtitleCues.length / 8))
  const pagedSubtitles = timeline.subtitleCues.slice(subtitlePage * 8, subtitlePage * 8 + 8)
  const alignmentCue = timeline.audioCues.find((cue) => cue.id === alignmentCueId && ['dialogue', 'narration'].includes(cue.kind) && cue.asset)
  const recentJobs = jobs.slice().sort((left, right) => right.createdAt - left.createdAt).slice(0, 4)
  const activeJob = recentJobs.find(({ status }) => status === 'queued' || status === 'running')
  const numericSpeechBudget = Number(speechBudget)

  useEffect(() => {
    if (alignmentCueId && !alignmentCue) setAlignmentCueId(null)
  }, [alignmentCue, alignmentCueId])

  useEffect(() => {
    if (page >= pageCount) setPage(Math.max(0, pageCount - 1))
  }, [page, pageCount])

  useEffect(() => {
    if (subtitlePage >= subtitlePageCount) setSubtitlePage(Math.max(0, subtitlePageCount - 1))
  }, [subtitlePage, subtitlePageCount])

  return (
    <section className="aq-sound-timeline" aria-label="声音字幕时间线">
      <header className="aq-sound-heading">
        <div><span>声音字幕时间线</span><small>{seconds(summary.durationMs)} 秒 · 绝对时间码</small></div>
        <b className={summary.ready ? 'is-ready' : ''}>{summary.ready ? '声音门已就绪' : '等待资产/审批'}</b>
      </header>
      <div className="aq-sound-summary">
        <span><Volume2 size={13} />必需音频 {summary.approvedRequiredAudio}/{summary.requiredAudio}</span>
        <span><Subtitles size={13} />字幕 {summary.approvedSubtitles}/{summary.subtitleCues}</span>
        <span><UserRoundCog size={13} />声线 {summary.approvedVoices}/{summary.voices}</span>
        <span><Music2 size={13} />音频槽 {summary.audioCues}</span>
      </div>
      <section className="aq-sound-execution" aria-label="声音执行控制">
        <header>
          <div><strong>受控声音执行</strong><small>外部配音 → 人工试听批准 → 本地混音/字幕 → 成片任务</small></div>
          <span>{activeJob ? `${activeJob.progress}% · ${activeJob.status === 'queued' ? '排队' : '执行中'}` : '当前空闲'}</span>
        </header>
        <div className="aq-sound-execution-actions">
          <label><span>配音格式</span><select value={speechFormat} onChange={(event) => setSpeechFormat(event.target.value as 'mp3' | 'wav')}><option value="mp3">MP3</option><option value="wav">WAV</option></select></label>
          <label><span>总预算 USD</span><input type="number" min={0} max={1000} step={0.1} value={speechBudget} onChange={(event) => setSpeechBudget(event.target.value)} /></label>
          <button
            type="button"
            disabled={!executionAvailable || Boolean(activeJob) || busy !== null || missingSpeech === 0 || !Number.isFinite(numericSpeechBudget) || numericSpeechBudget < 0 || numericSpeechBudget > 1_000}
            onClick={() => onPrepareSpeech(speechFormat, numericSpeechBudget)}
          >
            {busy === 'prepare-speech' ? <Loader2 size={14} className="is-spinning" /> : <WandSparkles size={14} />}
            生成 {missingSpeech} 条缺失对白
          </button>
          <button
            type="button"
            className="is-primary"
            disabled={!executionAvailable || Boolean(activeJob) || busy !== null || !summary.ready}
            onClick={onRenderMix}
          >
            {busy === 'render-mix' ? <Loader2 size={14} className="is-spinning" /> : <Volume2 size={14} />}
            渲染混音与字幕
          </button>
        </div>
        {!executionAvailable ? <p className="is-warning">请先在项目中心创建并保存智能视频项目，声音 Job 不接受临时会话或任意路径。</p> : null}
        {missingSpeech === 0 ? <p>全部对白已有音频版本；仍需逐条试听批准，系统不会自动代签。</p> : <p>只生成尚未绑定的对白/旁白；已经存在的音乐、环境声和音效不会被覆盖。</p>}
        {recentJobs.length ? (
          <div className="aq-sound-job-list">
            {recentJobs.map((job) => {
              const metadata = job.soundRenderMetadata
              const preparesSpeech = metadata?.action === 'prepare-speech'
              return (
                <article key={job.id} className={`is-${job.status}`}>
                  <header><strong>{preparesSpeech ? '批量配音' : metadata?.action === 'render-local' ? '局部交叉淡化' : '混音与字幕'}</strong><span>{job.progress}%</span></header>
                  <code>{job.id}</code>
                  <p>{job.detail}</p>
                  <div className="aq-sound-job-progress"><i style={{ width: `${Math.max(0, Math.min(100, job.progress))}%` }} /></div>
                  {preparesSpeech && metadata ? <small>已回填 {metadata.generatedBindings.length}/{metadata.requestedCueCount ?? 0} 条 · 预计 ${Number(metadata.estimatedCostUsd ?? 0).toFixed(4)}</small> : null}
                  {metadata?.action === 'render-local' && job.outputUrl ? <audio controls preload="none" src={job.outputUrl} aria-label="局部交叉淡化试听" /> : null}
                  {!preparesSpeech && metadata?.subtitles ? (
                    <div className="aq-sound-job-links">
                      {job.outputUrl ? <a href={job.outputUrl} target="_blank" rel="noreferrer"><Volume2 size={13} />试听 WAV</a> : null}
                      <a href={metadata.subtitles.srt.url} download><Download size={13} />SRT</a>
                      <a href={metadata.subtitles.vtt.url} download><Download size={13} />VTT</a>
                    </div>
                  ) : null}
                  {job.error ? <small className="is-error">{job.error.code} · {job.error.message}</small> : null}
                  <footer>
                    {['queued', 'running'].includes(job.status) ? <button type="button" disabled={busy !== null} onClick={() => onCancelJob(job.id)}><Square size={12} />取消</button> : null}
                    {['failed', 'cancelled'].includes(job.status) ? <button type="button" disabled={busy !== null} onClick={() => onRetryJob(job.id)}><RotateCcw size={12} />重试原输入</button> : null}
                  </footer>
                </article>
              )
            })}
          </div>
        ) : null}
      </section>
      <nav aria-label="声音工作区">
        {([
          ['voices', '声线', UserRoundCog],
          ['audio', '音频', FileAudio2],
          ['subtitles', '字幕', Subtitles],
          ['mix', '样式/混音', SlidersHorizontal],
        ] as const).map(([id, label, Icon]) => <button key={id} type="button" className={tab === id ? 'is-active' : ''} onClick={() => setTab(id)}><Icon size={13} />{label}</button>)}
      </nav>

      {tab === 'voices' ? (
        <div className="aq-sound-list">
          {timeline.voiceProfiles.length ? timeline.voiceProfiles.map((profile) => <VoiceEditor key={`${profile.id}:${profile.revision}`} profile={profile} onCommand={onCommand} />) : <p className="is-empty">当前故事没有对白或旁白声线。</p>}
        </div>
      ) : null}

      {tab === 'audio' ? (
        <>
          <label className="aq-sound-filter"><span>音轨</span><select value={filter} onChange={(event) => { setFilter(event.target.value as CueFilter); setPage(0) }}><option value="all">全部</option><option value="speech">对白/旁白</option><option value="music">音乐</option><option value="ambience">环境声</option><option value="sfx">音效</option></select></label>
          {alignmentCue ? <AlignmentEditor timeline={timeline} cue={alignmentCue} onCommand={onCommand} onRunSpeechAlignment={onRunSpeechAlignment} alignmentBusy={alignmentBusy} /> : <p className="aq-sound-alignment-empty">先在已绑定音频的对白/旁白 cue 上选择“对齐片段”，再导入候选或调用本地对齐。</p>}
          <div className="aq-sound-list">
            {pagedCues.map((cue) => <CueEditor key={`${cue.id}:${cue.revision}`} cue={cue} selected={assetTargetId === cue.id} onChooseAsset={onChooseAsset} onCommand={onCommand} alignmentSelected={alignmentCueId === cue.id} onSelectAlignment={['dialogue', 'narration'].includes(cue.kind) && cue.asset ? () => setAlignmentCueId(cue.id) : undefined} />)}
          </div>
          {pageCount > 1 ? <footer className="aq-sound-pagination"><button type="button" disabled={page === 0} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={13} />上一页</button><span>{page + 1} / {pageCount}</span><button type="button" disabled={page + 1 >= pageCount} onClick={() => setPage((value) => value + 1)}>下一页<ChevronRight size={13} /></button></footer> : null}
        </>
      ) : null}

      {tab === 'subtitles' ? (
        <>
          <div className="aq-sound-bulk"><p>逐条校对文本与入出时间；批量批准不会生成媒体，只关闭人工文本门。</p><button type="button" disabled={!timeline.subtitleCues.length || timeline.subtitleCues.every(({ status }) => status === 'approved')} onClick={() => onCommand('sound.subtitles.approve-all', {}, '当前全部字幕已批量批准。')}><Check size={13} /> 批准全部字幕</button></div>
          <div className="aq-sound-list">
            {pagedSubtitles.length ? pagedSubtitles.map((cue) => <SubtitleEditor key={`${cue.id}:${cue.revision}`} cue={cue} onCommand={onCommand} />) : <p className="is-empty">当前故事没有可编译的对白或旁白字幕。</p>}
          </div>
          {subtitlePageCount > 1 ? <footer className="aq-sound-pagination"><button type="button" disabled={subtitlePage === 0} onClick={() => setSubtitlePage((value) => value - 1)}><ChevronLeft size={13} />上一页</button><span>{subtitlePage + 1} / {subtitlePageCount}</span><button type="button" disabled={subtitlePage + 1 >= subtitlePageCount} onClick={() => setSubtitlePage((value) => value + 1)}>下一页<ChevronRight size={13} /></button></footer> : null}
        </>
      ) : null}

      {tab === 'mix' ? <MixEditor key={`${timeline.subtitleStyle.revision}:${timeline.mix.revision}`} timeline={timeline} onCommand={onCommand} onApplyLocalRemix={onApplyLocalRemix} /> : null}
      <p className="aq-sound-truth">TTS 成品会以不可变项目资源回填，但必须人工试听批准；混音只消费已批准版本，输出 48kHz 双声道 WAV、SRT、VTT 与供成片器烧录的 ASS。任何时间线变更都会使旧提交因修订号不一致而失败关闭。</p>
    </section>
  )
}

export default SoundTimelinePanel
