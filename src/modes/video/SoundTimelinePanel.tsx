import {
  Check,
  ChevronLeft,
  ChevronRight,
  FileAudio2,
  Music2,
  Save,
  SlidersHorizontal,
  Subtitles,
  UserRoundCog,
  Volume2,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type {
  SoundAudioCue,
  SoundSubtitleCue,
  SoundTimeline,
  SoundVoiceProfile,
} from '../../lib/story/soundTimeline.mjs'
import { soundTimelineSummary } from '../../lib/story/soundTimeline.mjs'
import type { VideoProductionCommandType, VideoProductionProject } from '../../lib/story/productionPipeline.mjs'

type SoundTimelinePanelProps = {
  project: VideoProductionProject
  assetTargetId: string | null
  onChooseAsset: (cueId: string) => void
  onCommand: (type: VideoProductionCommandType, payload?: Record<string, unknown>, successMessage?: string) => void
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

function CueEditor({ cue, selected, onChooseAsset, onCommand }: {
  cue: SoundAudioCue
  selected: boolean
  onChooseAsset: (cueId: string) => void
  onCommand: SoundTimelinePanelProps['onCommand']
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
        {cue.status === 'ready' ? <button type="button" className="is-approve" onClick={() => onCommand('sound.asset.approve', { cueId: cue.id }, `已批准${CUE_LABELS[cue.kind]}音频。`)}><Check size={13} /> 批准</button> : null}
        {cue.asset ? <button type="button" onClick={() => onCommand('sound.asset.unbind', { cueId: cue.id }, `已移除${CUE_LABELS[cue.kind]}音频。`)}>移除</button> : null}
      </footer>
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

function MixEditor({ timeline, onCommand }: { timeline: SoundTimeline; onCommand: SoundTimelinePanelProps['onCommand'] }) {
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

export function SoundTimelinePanel({ project, assetTargetId, onChooseAsset, onCommand }: SoundTimelinePanelProps) {
  const timeline = project.soundTimeline
  const summary = useMemo(() => soundTimelineSummary(timeline), [timeline])
  const [tab, setTab] = useState<SoundTab>('audio')
  const [filter, setFilter] = useState<CueFilter>('all')
  const [page, setPage] = useState(0)
  const [subtitlePage, setSubtitlePage] = useState(0)
  const filteredCues = useMemo(() => timeline.audioCues.filter((cue) => (
    filter === 'all' || (filter === 'speech' ? cue.kind === 'dialogue' || cue.kind === 'narration' : cue.kind === filter)
  )), [filter, timeline.audioCues])
  const pageCount = Math.max(1, Math.ceil(filteredCues.length / 8))
  const pagedCues = filteredCues.slice(page * 8, page * 8 + 8)
  const subtitlePageCount = Math.max(1, Math.ceil(timeline.subtitleCues.length / 8))
  const pagedSubtitles = timeline.subtitleCues.slice(subtitlePage * 8, subtitlePage * 8 + 8)

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
          <div className="aq-sound-list">
            {pagedCues.map((cue) => <CueEditor key={`${cue.id}:${cue.revision}`} cue={cue} selected={assetTargetId === cue.id} onChooseAsset={onChooseAsset} onCommand={onCommand} />)}
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

      {tab === 'mix' ? <MixEditor key={`${timeline.subtitleStyle.revision}:${timeline.mix.revision}`} timeline={timeline} onCommand={onCommand} /> : null}
      <p className="aq-sound-truth">当前版本只保存受控声线、音频版本、时间码、字幕和混音规格；不会假装已经完成 TTS、自动对齐或最终烧录。下一执行版本将消费同一份已批准时间线。</p>
    </section>
  )
}

export default SoundTimelinePanel
