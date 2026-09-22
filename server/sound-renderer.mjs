import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'

import { assertSoundTimeline, soundTimelineReady } from '../src/lib/story/soundTimeline.mjs'
import { createRestrictedChildEnvironment } from './security.mjs'

export const SOUND_RENDERER_VERSION = 'aeonquill-sound-render-v1'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const SPEECH_KINDS = new Set(['dialogue', 'narration'])
const AUDIO_MIME_TYPES = new Set(['audio/mpeg', 'audio/wav'])
const REQUEST_FIELDS = Object.freeze({
  'prepare-speech': new Set([
    'action', 'projectId', 'documentId', 'productionRevision', 'soundTimelineRevision',
    'title', 'format', 'speechBudgetUsd',
  ]),
  'render-mix': new Set([
    'action', 'projectId', 'documentId', 'productionRevision', 'soundTimelineRevision', 'title',
  ]),
  'render-local': new Set([
    'action', 'projectId', 'documentId', 'productionRevision', 'soundTimelineRevision', 'title', 'cueIds', 'overlapMs',
  ]),
})

export class SoundRendererError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message)
    this.name = 'SoundRendererError'
    this.code = code
    this.status = status
    if (details !== undefined) this.details = details
  }
}

function fail(code, message, status = 400, details = undefined) {
  throw new SoundRendererError(code, message, status, details)
}

function exactObject(input, allowed, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('INVALID_SOUND_RENDER_REQUEST', `${label} must be an object`)
  }
  const unknown = Object.keys(input).filter((key) => !allowed.has(key))
  const missing = [...allowed].filter((key) => !Object.hasOwn(input, key))
  if (unknown.length || missing.length) {
    fail('INVALID_SOUND_RENDER_REQUEST', `${label} fields are invalid`, 400, { unknown, missing })
  }
  return input
}

function identifier(value, label) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    fail('INVALID_SOUND_RENDER_REQUEST', `${label} is not a managed identifier`)
  }
  return value
}

function revision(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('INVALID_SOUND_RENDER_REQUEST', `${label} must be an integer >= 0`)
  }
  return value
}

function title(value) {
  if (typeof value !== 'string') fail('INVALID_SOUND_RENDER_REQUEST', 'title must be a string')
  const normalized = value.trim()
  if (!normalized || normalized.length > 120 || /[^\P{Cc}\n\t]/u.test(normalized)) {
    fail('INVALID_SOUND_RENDER_REQUEST', 'title must contain 1–120 safe characters')
  }
  return normalized
}

function finite(value, label, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    fail('INVALID_SOUND_RENDER_REQUEST', `${label} must be between ${minimum} and ${maximum}`)
  }
  return value
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function digest(value) {
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex')
}

export function validateSoundRenderRequest(input) {
  const action = input?.action
  const fields = Object.hasOwn(REQUEST_FIELDS, action) ? REQUEST_FIELDS[action] : null
  if (!fields) fail('INVALID_SOUND_RENDER_REQUEST', 'Unsupported sound render action')
  const value = exactObject(input, fields, 'Sound render request')
  const common = {
    action,
    projectId: identifier(value.projectId, 'projectId'),
    documentId: identifier(value.documentId, 'documentId'),
    productionRevision: revision(value.productionRevision, 'productionRevision'),
    soundTimelineRevision: revision(value.soundTimelineRevision, 'soundTimelineRevision'),
    title: title(value.title),
  }
  if (action === 'prepare-speech') {
    if (!['mp3', 'wav'].includes(value.format)) fail('INVALID_SOUND_RENDER_REQUEST', 'format must be mp3 or wav')
    return {
      ...common,
      format: value.format,
      speechBudgetUsd: finite(value.speechBudgetUsd, 'speechBudgetUsd', 0, 1_000),
    }
  }
  if (action === 'render-local') return { ...common, ...localRemixOptions({ cueIds: value.cueIds, overlapMs: value.overlapMs }) }
  return common
}

function timelineIdentity(timeline) {
  return {
    storyProjectId: timeline.storyProjectId,
    storyRevision: timeline.storyRevision,
    soundTimelineRevision: timeline.revision,
    durationMs: timeline.durationMs,
  }
}

export function compileSpeechSynthesisPlan(input) {
  const timeline = assertSoundTimeline(input)
  const voices = new Map(timeline.voiceProfiles.map((profile) => [profile.id, profile]))
  const cues = timeline.audioCues
    .filter((cue) => SPEECH_KINDS.has(cue.kind) && cue.asset === null)
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs || left.id.localeCompare(right.id))
    .map((cue) => {
      const voice = voices.get(cue.voiceProfileId)
      if (!voice || voice.status !== 'approved') {
        fail('SOUND_VOICE_NOT_APPROVED', `Speech cue ${cue.id} requires an approved voice profile`, 409, {
          cueId: cue.id,
          voiceProfileId: cue.voiceProfileId,
        })
      }
      return {
        cueId: cue.id,
        cueFingerprint: cue.fingerprint,
        kind: cue.kind,
        speakerLabel: cue.speakerLabel,
        text: cue.text,
        startMs: cue.startMs,
        endMs: cue.endMs,
        voiceProfileId: voice.id,
        providerLabel: voice.providerLabel,
        voiceId: voice.voiceId,
        language: voice.language,
        speed: voice.speed,
      }
    })
  const identity = timelineIdentity(timeline)
  return {
    kind: 'aeonquill.speech-synthesis-plan',
    schemaVersion: 1,
    version: SOUND_RENDERER_VERSION,
    ...identity,
    timelineDigest: digest(timeline),
    cueCount: cues.length,
    characterCount: cues.reduce((total, cue) => total + [...cue.text].length, 0),
    cues,
  }
}

function approvedMixCues(timeline) {
  return timeline.audioCues
    .filter((cue) => cue.status === 'approved' && cue.asset !== null)
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs || left.id.localeCompare(right.id))
}

export function compileSoundMixPlan(input) {
  const timeline = assertSoundTimeline(input)
  if (!soundTimelineReady(timeline)) {
    fail('SOUND_TIMELINE_NOT_APPROVED', 'Sound mix requires approved voices, required audio, subtitles, subtitle style, and mix settings', 409)
  }
  const cues = approvedMixCues(timeline).map((cue) => ({
    cueId: cue.id,
    kind: cue.kind,
    text: cue.text,
    startMs: cue.startMs,
    endMs: cue.endMs,
    gainDb: cue.gainDb,
    fadeInMs: cue.fadeInMs,
    fadeOutMs: cue.fadeOutMs,
    asset: { ...cue.asset },
  }))
  const subtitles = timeline.subtitleCues
    .slice()
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs || left.id.localeCompare(right.id))
    .map((cue) => ({
      id: cue.id,
      audioCueId: cue.audioCueId,
      text: cue.text,
      startMs: cue.startMs,
      endMs: cue.endMs,
    }))
  const identity = timelineIdentity(timeline)
  return {
    kind: 'aeonquill.sound-mix-plan',
    schemaVersion: 1,
    version: SOUND_RENDERER_VERSION,
    ...identity,
    timelineDigest: digest(timeline),
    cues,
    subtitles,
    subtitleStyle: { ...timeline.subtitleStyle },
    mix: { ...timeline.mix },
  }
}

function localRemixOptions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_SOUND_LOCAL_REMIX_PLAN', 'Local remix options must be an object')
  }
  const unknown = Object.keys(value).filter((key) => !['cueIds', 'overlapMs'].includes(key))
  if (unknown.length || !Object.hasOwn(value, 'cueIds')) {
    fail('INVALID_SOUND_LOCAL_REMIX_PLAN', 'Local remix options fields are invalid', { unknown })
  }
  if (!Array.isArray(value.cueIds) || value.cueIds.length !== 2 || value.cueIds[0] === value.cueIds[1]) {
    fail('INVALID_SOUND_LOCAL_REMIX_PLAN', 'Local remix requires two distinct cue ids')
  }
  value.cueIds.forEach((cueId, index) => identifier(cueId, `cueIds[${index}]`))
  const overlapMs = value.overlapMs ?? 120
  if (!Number.isSafeInteger(overlapMs) || overlapMs < 1 || overlapMs > 10_000) {
    fail('INVALID_SOUND_LOCAL_REMIX_PLAN', 'overlapMs must be an integer between 1 and 10,000')
  }
  return { cueIds: value.cueIds.slice(), overlapMs }
}

function approvedCueForLocalRemix(cue) {
  if (!cue || cue.status !== 'approved' || cue.asset === null) {
    fail('SOUND_CUE_NOT_APPROVED', 'Local remix only accepts approved immutable audio cues', 409, { cueId: cue?.id })
  }
  return cue
}

function adjacentSameKindCues(timeline, cueIds) {
  const first = timeline.audioCues.find(({ id }) => id === cueIds[0])
  const second = timeline.audioCues.find(({ id }) => id === cueIds[1])
  if (!first || !second) fail('UNKNOWN_SOUND_CUE', 'Local remix references an unknown audio cue', 404)
  approvedCueForLocalRemix(first)
  approvedCueForLocalRemix(second)
  if (first.kind !== second.kind) fail('SOUND_CUE_KIND_MISMATCH', 'Crossfade cues must have the same kind', 409, { cueIds })
  const sortedSameKind = timeline.audioCues
    .filter(({ kind }) => kind === first.kind)
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs || left.id.localeCompare(right.id))
  const firstIndex = sortedSameKind.findIndex(({ id }) => id === first.id)
  const secondIndex = sortedSameKind.findIndex(({ id }) => id === second.id)
  if (Math.abs(firstIndex - secondIndex) !== 1) {
    fail('SOUND_CUES_NOT_ADJACENT', 'Crossfade cues must be adjacent same-kind timeline cues', 409, { cueIds })
  }
  const left = first.startMs <= second.startMs ? first : second
  const right = left.id === first.id ? second : first
  if (right.startMs > left.endMs) {
    fail('SOUND_CUES_NOT_ADJACENT', 'Crossfade cues must touch or overlap in the timeline', 409, { cueIds })
  }
  return { left, right }
}

/**
 * Compile a local-only crossfade plan. The plan carries approved asset
 * identities for exactly two adjacent same-kind cues; every other cue is
 * listed as preserved so callers cannot silently widen the remixed region.
 */
export function compileLocalSoundRemixPlan(input, options) {
  const timeline = assertSoundTimeline(input)
  const { cueIds, overlapMs } = localRemixOptions(options)
  const { left, right } = adjacentSameKindCues(timeline, cueIds)
  const maxOverlapMs = Math.min(left.endMs - left.startMs, right.endMs - right.startMs)
  if (overlapMs > maxOverlapMs) {
    fail('INVALID_SOUND_LOCAL_REMIX_PLAN', 'Crossfade overlap exceeds one of the cue durations', 400, { overlapMs, maxOverlapMs })
  }
  const segmentStartMs = left.startMs
  const segmentEndMs = right.endMs
  const selectedIds = [left.id, right.id]
  const cues = [left, right].map((cue, index) => ({
    cueId: cue.id,
    kind: cue.kind,
    startMs: cue.startMs,
    endMs: cue.endMs,
    gainDb: cue.gainDb,
    fadeInMs: cue.fadeInMs,
    fadeOutMs: cue.fadeOutMs,
    crossfadeInMs: index === 1 ? overlapMs : 0,
    crossfadeOutMs: index === 0 ? overlapMs : 0,
    asset: { ...cue.asset },
  }))
  return {
    kind: 'aeonquill.sound-local-remix-plan',
    schemaVersion: 1,
    version: SOUND_RENDERER_VERSION,
    timelineDigest: digest(timeline),
    soundTimelineRevision: timeline.revision,
    durationMs: timeline.durationMs,
    segmentStartMs,
    segmentEndMs,
    cueIds: selectedIds,
    overlapMs,
    cues,
    preservedCueIds: timeline.audioCues.filter(({ id }) => !selectedIds.includes(id)).map(({ id }) => id),
  }
}

function timestamp(milliseconds, separator) {
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000)
  const seconds = Math.floor((milliseconds % 60_000) / 1_000)
  const fraction = milliseconds % 1_000
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${separator}${String(fraction).padStart(3, '0')}`
}

function normalizedSubtitleText(value) {
  return String(value).replace(/\r\n?/gu, '\n').trim()
}

export function renderSrtSubtitles(plan) {
  return `${plan.subtitles.map((cue, index) => [
    String(index + 1),
    `${timestamp(cue.startMs, ',')} --> ${timestamp(cue.endMs, ',')}`,
    normalizedSubtitleText(cue.text),
  ].join('\n')).join('\n\n')}\n`
}

export function renderVttSubtitles(plan) {
  const body = plan.subtitles.map((cue) => [
    `${timestamp(cue.startMs, '.')} --> ${timestamp(cue.endMs, '.')}`,
    normalizedSubtitleText(cue.text),
  ].join('\n')).join('\n\n')
  return `WEBVTT\n\n${body}${body ? '\n' : ''}`
}

function assTimestamp(milliseconds) {
  const centiseconds = Math.round(milliseconds / 10)
  const hours = Math.floor(centiseconds / 360_000)
  const minutes = Math.floor((centiseconds % 360_000) / 6_000)
  const seconds = Math.floor((centiseconds % 6_000) / 100)
  const fraction = centiseconds % 100
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(fraction).padStart(2, '0')}`
}

function escapeAssText(value) {
  return normalizedSubtitleText(value)
    .replace(/\\/gu, '\\\\')
    .replace(/\{/gu, '\\{')
    .replace(/\}/gu, '\\}')
    .replace(/\n/gu, '\\N')
}

export function renderAssSubtitles(plan, { width = 1280, height = 720 } = {}) {
  const style = plan.subtitleStyle
  const fontSize = Math.round(42 * style.fontScalePercent / 100)
  const margin = Math.round(height * style.safeMarginPercent / 100)
  const alignment = style.position === 'top' ? 8 : 2
  const borderStyle = style.background === 'box' ? 3 : 1
  const outline = style.background === 'none' ? 0 : style.background === 'shadow' ? 2 : 1
  const shadow = style.background === 'shadow' ? 2 : 0
  const background = style.background === 'box' ? '&H80000000' : '&H00000000'
  const events = plan.subtitles.map((cue) => (
    `Dialogue: 0,${assTimestamp(cue.startMs)},${assTimestamp(cue.endMs)},Default,,0,0,0,,${escapeAssText(cue.text)}`
  )).join('\n')
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,Microsoft YaHei,${fontSize},&H00FFFFFF,&H000000FF,&H00141414,${background},0,0,0,0,100,100,0,0,${borderStyle},${outline},${shadow},${alignment},${margin},${margin},${margin},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    events,
    '',
  ].join('\n')
}

function fixedSeconds(milliseconds) {
  return (milliseconds / 1_000).toFixed(3)
}

function mergeIntervals(intervals) {
  const sorted = intervals.filter(([start, end]) => end > start).sort((left, right) => left[0] - right[0] || left[1] - right[1])
  const merged = []
  for (const interval of sorted) {
    const last = merged.at(-1)
    if (!last || interval[0] > last[1]) merged.push([...interval])
    else last[1] = Math.max(last[1], interval[1])
  }
  return merged
}

function cueDuckingFilters(cue, speechWindows, duckingDb) {
  if (!['music', 'ambience'].includes(cue.kind) || duckingDb === 0) return []
  const local = mergeIntervals(speechWindows.map(([start, end]) => [
    Math.max(start, cue.startMs) - cue.startMs,
    Math.min(end, cue.endMs) - cue.startMs,
  ]))
  return local.map(([start, end]) => (
    `volume=${duckingDb.toFixed(1)}dB:enable='between(t,${fixedSeconds(start)},${fixedSeconds(end)})'`
  ))
}

export function buildSoundMixFilter(plan) {
  if (!plan || plan.kind !== 'aeonquill.sound-mix-plan' || plan.schemaVersion !== 1) {
    fail('INVALID_SOUND_MIX_PLAN', 'Sound mix plan is invalid')
  }
  const speechWindows = mergeIntervals(plan.cues
    .filter((cue) => SPEECH_KINDS.has(cue.kind))
    .map((cue) => [cue.startMs, cue.endMs]))
  const filters = [
    `[0:a:0]atrim=duration=${fixedSeconds(plan.durationMs)},asetpts=PTS-STARTPTS,` +
    'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[base]',
  ]
  plan.cues.forEach((cue, index) => {
    const durationMs = cue.endMs - cue.startMs
    const chain = [
      'aresample=48000',
      'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo',
      'asetpts=PTS-STARTPTS',
      `apad=whole_dur=${fixedSeconds(durationMs)}`,
      `atrim=duration=${fixedSeconds(durationMs)}`,
      `volume=${cue.gainDb.toFixed(1)}dB`,
      ...cueDuckingFilters(cue, speechWindows, plan.mix.dialogueDuckingDb),
    ]
    if (cue.fadeInMs > 0) chain.push(`afade=t=in:st=0:d=${fixedSeconds(cue.fadeInMs)}`)
    if (cue.fadeOutMs > 0) {
      chain.push(`afade=t=out:st=${fixedSeconds(durationMs - cue.fadeOutMs)}:d=${fixedSeconds(cue.fadeOutMs)}`)
    }
    chain.push(`adelay=${cue.startMs}:all=1`)
    filters.push(`[${index + 1}:a:0]${chain.join(',')}[cue${index}]`)
  })
  const inputs = ['[base]', ...plan.cues.map((_, index) => `[cue${index}]`)].join('')
  const limiter = 10 ** (plan.mix.truePeakDbtp / 20)
  filters.push(
    `${inputs}amix=inputs=${plan.cues.length + 1}:duration=longest:normalize=0,` +
    `loudnorm=I=${plan.mix.targetLufs.toFixed(1)}:TP=${plan.mix.truePeakDbtp.toFixed(1)}:LRA=11,` +
    `alimiter=limit=${limiter.toFixed(6)},atrim=duration=${fixedSeconds(plan.durationMs)},` +
    'aresample=48000,aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=stereo[aout]',
  )
  return { filter: filters.join(';'), durationSeconds: plan.durationMs / 1_000 }
}

export function buildLocalSoundRemixFilter(plan) {
  if (
    !plan
    || plan.kind !== 'aeonquill.sound-local-remix-plan'
    || plan.schemaVersion !== 1
    || !Array.isArray(plan.cues)
    || plan.cues.length !== 2
    || !Array.isArray(plan.cueIds)
    || plan.cueIds.length !== 2
    || plan.cueIds[0] !== plan.cues[0].cueId
    || plan.cueIds[1] !== plan.cues[1].cueId
  ) {
    fail('INVALID_SOUND_LOCAL_REMIX_PLAN', 'Local sound remix plan is invalid')
  }
  const durationMs = plan.segmentEndMs - plan.segmentStartMs
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || !Number.isSafeInteger(plan.overlapMs) || plan.overlapMs < 1 || plan.overlapMs >= durationMs) {
    fail('INVALID_SOUND_LOCAL_REMIX_PLAN', 'Local sound remix duration or overlap is invalid')
  }
  const [left, right] = plan.cues
  const leftDurationMs = left.endMs - left.startMs
  const rightDurationMs = right.endMs - right.startMs
  const leftFadeDurationMs = durationMs - rightDurationMs + plan.overlapMs
  if (
    !Number.isSafeInteger(leftDurationMs)
    || !Number.isSafeInteger(rightDurationMs)
    || !Number.isSafeInteger(leftFadeDurationMs)
    || leftDurationMs <= 0
    || rightDurationMs <= 0
    || leftFadeDurationMs <= 0
    || left.crossfadeOutMs !== plan.overlapMs
    || right.crossfadeInMs !== plan.overlapMs
  ) {
    fail('INVALID_SOUND_LOCAL_REMIX_PLAN', 'Local sound remix cue windows are invalid')
  }
  const leftChain = [
    'aresample=48000',
    'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo',
    'asetpts=PTS-STARTPTS',
    leftFadeDurationMs >= leftDurationMs
      ? `apad=whole_dur=${fixedSeconds(leftFadeDurationMs)},atrim=duration=${fixedSeconds(leftFadeDurationMs)}`
      : `atrim=duration=${fixedSeconds(leftFadeDurationMs)}`,
    `volume=${left.gainDb.toFixed(1)}dB`,
  ]
  const rightChain = [
    'aresample=48000',
    'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo',
    'asetpts=PTS-STARTPTS',
    `atrim=duration=${fixedSeconds(rightDurationMs)}`,
    `volume=${right.gainDb.toFixed(1)}dB`,
  ]
  const overlapSeconds = fixedSeconds(plan.overlapMs)
  const segmentSeconds = fixedSeconds(durationMs)
  const filter = [
    `[0:a:0]${leftChain.join(',')}[local-left]`,
    `[1:a:0]${rightChain.join(',')}[local-right]`,
    `[local-left][local-right]acrossfade=d=${overlapSeconds}:c1=tri:c2=tri,` +
      `atrim=duration=${segmentSeconds},` +
      'aresample=48000,aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=stereo[local-out]',
  ].join(';')
  return { filter, durationSeconds: durationMs / 1_000 }
}

function terminate(child) {
  if (!child?.pid) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      env: createRestrictedChildEnvironment(),
    }).unref()
  } else {
    child.kill('SIGKILL')
  }
}

function runCommand(executable, args, { signal, timeoutMs, onStdout } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted) return rejectPromise(signal.reason || Object.assign(new Error('Task was cancelled'), { name: 'AbortError' }))
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: createRestrictedChildEnvironment(),
    })
    const stdout = []
    let stderr = ''
    let settled = false
    const settle = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      callback(value)
    }
    const onAbort = () => {
      terminate(child)
      settle(rejectPromise, signal.reason || Object.assign(new Error('Task was cancelled'), { name: 'AbortError' }))
    }
    child.stdout.on('data', (chunk) => {
      stdout.push(chunk)
      onStdout?.(chunk.toString('utf8'))
    })
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-32_000) })
    const timer = setTimeout(() => {
      terminate(child)
      settle(rejectPromise, Object.assign(new Error('Sound render process timed out'), { code: 'SOUND_RENDER_TIMEOUT' }))
    }, timeoutMs ?? 60 * 60 * 1_000)
    signal?.addEventListener('abort', onAbort, { once: true })
    child.once('error', (error) => settle(rejectPromise, error))
    child.once('exit', (code) => {
      if (code === 0) settle(resolvePromise, { stdout: Buffer.concat(stdout).toString('utf8'), stderr })
      else settle(rejectPromise, Object.assign(new Error(`Sound render process exited with code ${code}: ${stderr.slice(-2_000)}`), {
        code: 'SOUND_RENDER_EXECUTION_ERROR',
      }))
    })
  })
}

function progressSeconds(buffer) {
  const matches = [...String(buffer).matchAll(/out_time_ms=(\d+)/gu)]
  return matches.length ? Number(matches.at(-1)[1]) / 1_000_000 : null
}

export async function probeAudioAsset(ffprobePath, inputPath, signal) {
  const { stdout } = await runCommand(ffprobePath, [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type,codec_name,sample_rate,channels',
    '-of', 'json',
    inputPath,
  ], { signal, timeoutMs: 30_000 })
  let payload
  try { payload = JSON.parse(stdout) } catch { fail('SOUND_RENDER_PROBE_FAILED', 'FFprobe returned invalid JSON', 500) }
  const audio = payload.streams?.find((stream) => stream.codec_type === 'audio')
  const duration = Number(payload.format?.duration)
  if (!audio || !Number.isFinite(duration) || duration <= 0) {
    fail('SOUND_ASSET_INVALID', 'A sound timeline asset does not contain a valid audio stream', 409)
  }
  return {
    duration,
    audioCodec: String(audio.codec_name || ''),
    sampleRate: Number(audio.sample_rate || 0),
    channels: Number(audio.channels || 0),
  }
}

export async function renderSoundMix({ ffmpegPath, ffprobePath, inputPaths, outputPath, plan, signal, onProgress }) {
  if (!Array.isArray(inputPaths) || inputPaths.length !== plan.cues.length) {
    fail('SOUND_ASSET_COUNT_MISMATCH', 'Resolved audio assets do not match the sound mix plan', 409)
  }
  const inputProbes = []
  for (let index = 0; index < inputPaths.length; index += 1) {
    inputProbes.push(await probeAudioAsset(ffprobePath, inputPaths[index], signal))
    onProgress?.({ phase: 'validating', progress: 8 + Math.round(((index + 1) / Math.max(1, inputPaths.length)) * 16) })
  }
  const graph = buildSoundMixFilter(plan)
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-t', graph.durationSeconds.toFixed(3), '-i', 'anullsrc=r=48000:cl=stereo',
  ]
  inputPaths.forEach((inputPath) => args.push('-i', inputPath))
  args.push(
    '-filter_complex', graph.filter,
    '-map', '[aout]',
    '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2',
    '-progress', 'pipe:1', '-nostats',
    outputPath,
  )
  let progressBuffer = ''
  await runCommand(ffmpegPath, args, {
    signal,
    timeoutMs: 60 * 60 * 1_000,
    onStdout(chunk) {
      progressBuffer = `${progressBuffer}${chunk}`.slice(-8_000)
      const seconds = progressSeconds(progressBuffer)
      if (seconds !== null) {
        onProgress?.({
          phase: 'encoding',
          progress: Math.min(94, 25 + Math.round((seconds / Math.max(1, graph.durationSeconds)) * 69)),
        })
      }
    },
  })
  const outputProbe = await probeAudioAsset(ffprobePath, outputPath, signal)
  if (outputProbe.sampleRate !== 48_000 || outputProbe.channels !== 2) {
    fail('SOUND_RENDER_QA_FAILED', 'Rendered sound mix is not 48kHz stereo', 500, { outputProbe })
  }
  if (Math.abs(outputProbe.duration - graph.durationSeconds) > 0.08) {
    fail('SOUND_RENDER_QA_FAILED', 'Rendered sound mix duration differs from the approved timeline', 500, {
      expectedDuration: graph.durationSeconds,
      outputDuration: outputProbe.duration,
    })
  }
  return {
    version: SOUND_RENDERER_VERSION,
    timelineDigest: plan.timelineDigest,
    durationMs: plan.durationMs,
    cueCount: plan.cues.length,
    subtitleCount: plan.subtitles.length,
    inputProbes,
    outputProbe,
    mix: {
      targetLufs: plan.mix.targetLufs,
      truePeakDbtp: plan.mix.truePeakDbtp,
      dialogueDuckingDb: plan.mix.dialogueDuckingDb,
      sampleRate: 48_000,
      channels: 2,
    },
  }
}

export async function renderLocalSoundRemix({ ffmpegPath, ffprobePath, inputPaths, outputPath, plan, signal, onProgress }) {
  if (!Array.isArray(inputPaths) || inputPaths.length !== 2) {
    fail('SOUND_LOCAL_REMIX_INPUT_MISMATCH', 'Local remix requires exactly two resolved audio inputs', 409)
  }
  const graph = buildLocalSoundRemixFilter(plan)
  onProgress?.({ phase: 'validating', progress: 10 })
  await runCommand(ffmpegPath, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', inputPaths[0],
    '-i', inputPaths[1],
    '-filter_complex', graph.filter,
    '-map', '[local-out]',
    '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2',
    outputPath,
  ], {
    signal,
    timeoutMs: 15 * 60 * 1_000,
  })
  const outputProbe = await probeAudioAsset(ffprobePath, outputPath, signal)
  if (outputProbe.sampleRate !== 48_000 || outputProbe.channels !== 2) {
    fail('SOUND_RENDER_QA_FAILED', 'Local remix is not 48kHz stereo', 500, { outputProbe })
  }
  if (Math.abs(outputProbe.duration - graph.durationSeconds) > 0.08) {
    fail('SOUND_RENDER_QA_FAILED', 'Local remix duration differs from its bounded segment', 500, {
      expectedDuration: graph.durationSeconds,
      outputDuration: outputProbe.duration,
    })
  }
  onProgress?.({ phase: 'completed', progress: 100 })
  return {
    version: SOUND_RENDERER_VERSION,
    timelineDigest: plan.timelineDigest,
    soundTimelineRevision: plan.soundTimelineRevision,
    segmentStartMs: plan.segmentStartMs,
    segmentEndMs: plan.segmentEndMs,
    cueIds: plan.cueIds.slice(),
    outputProbe,
  }
}

export function assertResolvedSoundAsset(binding, resolved) {
  if (!binding || !resolved || binding.libraryItemId !== resolved.libraryItemId || binding.libraryVersionId !== resolved.libraryVersionId) {
    fail('SOUND_ASSET_IDENTITY_MISMATCH', 'Resolved sound asset does not match its approved binding', 409)
  }
  if (binding.contentHash !== resolved.contentHash || binding.mimeType !== resolved.mimeType || !AUDIO_MIME_TYPES.has(resolved.mimeType)) {
    fail('SOUND_ASSET_HASH_MISMATCH', 'Resolved sound asset hash or media type does not match its approved binding', 409)
  }
  return resolved
}
