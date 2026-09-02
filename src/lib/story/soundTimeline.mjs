export const SOUND_TIMELINE_SCHEMA_VERSION = 1

export const SOUND_TIMELINE_LIMITS = Object.freeze({
  maxDurationMs: 30 * 60 * 1_000,
  maxVoiceProfiles: 64,
  maxAudioCues: 2_048,
  maxSubtitleCues: 2_048,
  maxCueText: 2_000,
})

const GRAPH_KIND = 'aeonquill.sound-timeline'
const AUDIO_KINDS = new Set(['dialogue', 'narration', 'music', 'ambience', 'sfx'])
const SPEECH_KINDS = new Set(['dialogue', 'narration'])
const AUDIO_STATUSES = new Set(['planned', 'ready', 'approved'])
const VOICE_STATUSES = new Set(['draft', 'configured', 'approved'])
const SUBTITLE_STATUSES = new Set(['draft', 'approved'])
const MIX_STATUSES = new Set(['draft', 'approved'])
const AUDIO_MIME_TYPES = new Set(['audio/mpeg', 'audio/wav'])
const ASSET_SCOPES = new Set(['project', 'global-reference'])
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const SHA256 = /^[a-f0-9]{64}$/u

export class SoundTimelineError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'SoundTimelineError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

function fail(code, message, details) {
  throw new SoundTimelineError(code, message, details)
}

function clone(value) {
  return globalThis.structuredClone(value)
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function record(value, path) {
  if (!isRecord(value)) fail('INVALID_OBJECT', `${path} must be an object`)
  return value
}

function exactKeys(value, keys, path) {
  const object = record(value, path)
  const expected = new Set(keys)
  const unknown = Object.keys(object).filter((key) => !expected.has(key))
  const missing = keys.filter((key) => !Object.hasOwn(object, key))
  if (unknown.length || missing.length) fail('INVALID_FIELDS', `${path} fields are invalid`, { unknown, missing })
  return object
}

function safeId(value, path, nullable = false) {
  if (nullable && value === null) return value
  if (typeof value !== 'string' || !SAFE_ID.test(value)) fail('INVALID_ID', `${path} is invalid`)
  return value
}

function text(value, path, max = SOUND_TIMELINE_LIMITS.maxCueText, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim()) || /[^\P{Cc}\n\t]/u.test(value)) {
    fail('INVALID_TEXT', `${path} is invalid`)
  }
  return value
}

function integer(value, path, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('INVALID_INTEGER', `${path} is invalid`)
  return value
}

function finite(value, path, min, max, precision = 1) {
  const scale = 10 ** precision
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || Math.round(value * scale) !== value * scale) {
    fail('INVALID_NUMBER', `${path} is invalid`)
  }
  return value
}

function token(value) {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36).padStart(7, '0')
}

function stableId(prefix, ...parts) {
  return `${prefix}-${token(parts.map((part) => String(part).normalize('NFKC').trim().toLocaleLowerCase('zh-CN')).join('\u241f'))}`
}

function cueFingerprint(cue) {
  return `sound-input-${token([
    cue.kind,
    cue.speakerCharacterId ?? '',
    cue.speakerLabel ?? '',
    cue.text,
    cue.voiceProfileId ?? '',
  ].join('|'))}`
}

export function assertSoundAssetBinding(input) {
  const asset = exactKeys(input, ['libraryItemId', 'libraryVersionId', 'contentHash', 'mimeType', 'scope', 'boundAt'], 'soundAsset')
  safeId(asset.libraryItemId, 'soundAsset.libraryItemId')
  safeId(asset.libraryVersionId, 'soundAsset.libraryVersionId')
  if (typeof asset.contentHash !== 'string' || !SHA256.test(asset.contentHash)) fail('INVALID_CONTENT_HASH', 'soundAsset.contentHash must be a lowercase SHA-256')
  if (!AUDIO_MIME_TYPES.has(asset.mimeType)) fail('INVALID_ASSET_MIME', 'Sound timeline assets must be MP3 or WAV audio')
  if (!ASSET_SCOPES.has(asset.scope)) fail('INVALID_ASSET_SCOPE', 'soundAsset.scope is unsupported')
  integer(asset.boundAt, 'soundAsset.boundAt', 1)
  return asset
}

function assertVoiceProfile(input, path) {
  const profile = exactKeys(input, ['id', 'characterId', 'speaker', 'providerLabel', 'voiceId', 'language', 'speed', 'status', 'revision', 'updatedAt'], path)
  safeId(profile.id, `${path}.id`)
  safeId(profile.characterId, `${path}.characterId`, true)
  text(profile.speaker, `${path}.speaker`, 120)
  text(profile.providerLabel, `${path}.providerLabel`, 120, true)
  text(profile.voiceId, `${path}.voiceId`, 160, true)
  text(profile.language, `${path}.language`, 32)
  finite(profile.speed, `${path}.speed`, 0.5, 2, 2)
  if (!VOICE_STATUSES.has(profile.status)) fail('INVALID_VOICE_STATUS', `${path}.status is unsupported`)
  const configured = Boolean(profile.providerLabel.trim() && profile.voiceId.trim())
  if ((profile.status === 'draft') !== !configured) fail('VOICE_STATUS_MISMATCH', `${path}.status does not match its provider configuration`)
  integer(profile.revision, `${path}.revision`, 0)
  integer(profile.updatedAt, `${path}.updatedAt`, 1)
}

function assertAudioCue(input, path, context) {
  const cue = exactKeys(input, [
    'id', 'kind', 'sceneId', 'shotId', 'speakerCharacterId', 'speakerLabel', 'text',
    'startMs', 'endMs', 'gainDb', 'fadeInMs', 'fadeOutMs', 'voiceProfileId', 'required',
    'asset', 'status', 'fingerprint', 'revision', 'updatedAt',
  ], path)
  safeId(cue.id, `${path}.id`)
  if (!AUDIO_KINDS.has(cue.kind)) fail('INVALID_AUDIO_KIND', `${path}.kind is unsupported`)
  safeId(cue.sceneId, `${path}.sceneId`, true)
  safeId(cue.shotId, `${path}.shotId`, true)
  safeId(cue.speakerCharacterId, `${path}.speakerCharacterId`, true)
  if (cue.speakerLabel !== null) text(cue.speakerLabel, `${path}.speakerLabel`, 120)
  text(cue.text, `${path}.text`)
  integer(cue.startMs, `${path}.startMs`, 0, context.durationMs - 1)
  integer(cue.endMs, `${path}.endMs`, cue.startMs + 1, context.durationMs)
  finite(cue.gainDb, `${path}.gainDb`, -60, 12, 1)
  integer(cue.fadeInMs, `${path}.fadeInMs`, 0, cue.endMs - cue.startMs)
  integer(cue.fadeOutMs, `${path}.fadeOutMs`, 0, cue.endMs - cue.startMs)
  if (cue.fadeInMs + cue.fadeOutMs > cue.endMs - cue.startMs) fail('INVALID_FADE', `${path} fades exceed cue duration`)
  safeId(cue.voiceProfileId, `${path}.voiceProfileId`, true)
  if (typeof cue.required !== 'boolean') fail('INVALID_BOOLEAN', `${path}.required must be boolean`)
  if (SPEECH_KINDS.has(cue.kind)) {
    if (!cue.voiceProfileId || !context.voiceIds.has(cue.voiceProfileId)) fail('DANGLING_VOICE', `${path}.voiceProfileId is unknown`)
    if (!cue.speakerLabel) fail('INVALID_SPEAKER', `${path}.speakerLabel is required for speech`)
  } else if (cue.voiceProfileId !== null || cue.speakerCharacterId !== null || cue.speakerLabel !== null) {
    fail('INVALID_SPEAKER', `${path} non-speech cue cannot bind a voice`)
  }
  if (cue.speakerCharacterId !== null) {
    const voice = context.voices.find(({ id }) => id === cue.voiceProfileId)
    if (voice?.characterId !== cue.speakerCharacterId) fail('VOICE_CHARACTER_MISMATCH', `${path} voice belongs to another character`)
  }
  if (cue.asset !== null) assertSoundAssetBinding(cue.asset)
  if (!AUDIO_STATUSES.has(cue.status)) fail('INVALID_AUDIO_STATUS', `${path}.status is unsupported`)
  const expectedStatus = cue.asset === null ? 'planned' : cue.status === 'approved' ? 'approved' : 'ready'
  if (cue.status !== expectedStatus) fail('AUDIO_STATUS_MISMATCH', `${path}.status does not match its asset`)
  safeId(cue.fingerprint, `${path}.fingerprint`)
  if (cue.fingerprint !== cueFingerprint(cue)) fail('AUDIO_FINGERPRINT_MISMATCH', `${path}.fingerprint is inconsistent`)
  integer(cue.revision, `${path}.revision`, 0)
  integer(cue.updatedAt, `${path}.updatedAt`, 1)
}

function assertSubtitleCue(input, path, context) {
  const cue = exactKeys(input, ['id', 'audioCueId', 'shotId', 'speakerCharacterId', 'text', 'startMs', 'endMs', 'status', 'revision', 'updatedAt'], path)
  safeId(cue.id, `${path}.id`)
  safeId(cue.audioCueId, `${path}.audioCueId`)
  safeId(cue.shotId, `${path}.shotId`)
  safeId(cue.speakerCharacterId, `${path}.speakerCharacterId`, true)
  text(cue.text, `${path}.text`)
  integer(cue.startMs, `${path}.startMs`, 0, context.durationMs - 1)
  integer(cue.endMs, `${path}.endMs`, cue.startMs + 1, context.durationMs)
  if (!SUBTITLE_STATUSES.has(cue.status)) fail('INVALID_SUBTITLE_STATUS', `${path}.status is unsupported`)
  const audioCue = context.audioById.get(cue.audioCueId)
  if (!audioCue || !SPEECH_KINDS.has(audioCue.kind)) fail('DANGLING_AUDIO_CUE', `${path}.audioCueId must reference speech`)
  if (audioCue.shotId !== cue.shotId || audioCue.speakerCharacterId !== cue.speakerCharacterId) fail('SUBTITLE_AUDIO_MISMATCH', `${path} does not match its speech cue`)
  integer(cue.revision, `${path}.revision`, 0)
  integer(cue.updatedAt, `${path}.updatedAt`, 1)
}

function assertSubtitleStyle(input, path) {
  const style = exactKeys(input, ['position', 'maxLines', 'safeMarginPercent', 'fontScalePercent', 'background', 'status', 'revision', 'updatedAt'], path)
  if (!['bottom', 'top'].includes(style.position)) fail('INVALID_SUBTITLE_STYLE', `${path}.position is unsupported`)
  integer(style.maxLines, `${path}.maxLines`, 1, 2)
  integer(style.safeMarginPercent, `${path}.safeMarginPercent`, 5, 20)
  integer(style.fontScalePercent, `${path}.fontScalePercent`, 70, 140)
  if (!['shadow', 'box', 'none'].includes(style.background)) fail('INVALID_SUBTITLE_STYLE', `${path}.background is unsupported`)
  if (!SUBTITLE_STATUSES.has(style.status)) fail('INVALID_SUBTITLE_STATUS', `${path}.status is unsupported`)
  integer(style.revision, `${path}.revision`, 0)
  integer(style.updatedAt, `${path}.updatedAt`, 1)
}

function assertMix(input, path) {
  const mix = exactKeys(input, ['targetLufs', 'truePeakDbtp', 'dialogueDuckingDb', 'sampleRate', 'channels', 'status', 'revision', 'updatedAt'], path)
  finite(mix.targetLufs, `${path}.targetLufs`, -24, -9, 1)
  finite(mix.truePeakDbtp, `${path}.truePeakDbtp`, -3, -0.1, 1)
  finite(mix.dialogueDuckingDb, `${path}.dialogueDuckingDb`, -18, 0, 1)
  if (mix.sampleRate !== 48_000 || mix.channels !== 2) fail('INVALID_MIX_FORMAT', `${path} must remain 48kHz stereo`)
  if (!MIX_STATUSES.has(mix.status)) fail('INVALID_MIX_STATUS', `${path}.status is unsupported`)
  integer(mix.revision, `${path}.revision`, 0)
  integer(mix.updatedAt, `${path}.updatedAt`, 1)
}

export function assertSoundTimeline(input) {
  const graph = exactKeys(input, [
    'kind', 'schemaVersion', 'storyProjectId', 'storyRevision', 'durationMs', 'voiceProfiles',
    'audioCues', 'subtitleCues', 'subtitleStyle', 'mix', 'revision', 'createdAt', 'updatedAt',
  ], 'soundTimeline')
  if (graph.kind !== GRAPH_KIND || graph.schemaVersion !== SOUND_TIMELINE_SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA', 'Unsupported sound timeline schema')
  safeId(graph.storyProjectId, 'soundTimeline.storyProjectId', true)
  if (graph.storyRevision !== null) integer(graph.storyRevision, 'soundTimeline.storyRevision', 0)
  if ((graph.storyProjectId === null) !== (graph.storyRevision === null)) fail('STORY_IDENTITY_MISMATCH', 'storyProjectId and storyRevision must both be null or present')
  integer(graph.durationMs, 'soundTimeline.durationMs', 1, SOUND_TIMELINE_LIMITS.maxDurationMs)
  if (!Array.isArray(graph.voiceProfiles) || graph.voiceProfiles.length > SOUND_TIMELINE_LIMITS.maxVoiceProfiles) fail('COLLECTION_LIMIT', 'soundTimeline.voiceProfiles is invalid')
  if (!Array.isArray(graph.audioCues) || graph.audioCues.length > SOUND_TIMELINE_LIMITS.maxAudioCues) fail('COLLECTION_LIMIT', 'soundTimeline.audioCues is invalid')
  if (!Array.isArray(graph.subtitleCues) || graph.subtitleCues.length > SOUND_TIMELINE_LIMITS.maxSubtitleCues) fail('COLLECTION_LIMIT', 'soundTimeline.subtitleCues is invalid')

  graph.voiceProfiles.forEach((profile, index) => assertVoiceProfile(profile, `soundTimeline.voiceProfiles[${index}]`))
  const voiceIds = new Set(graph.voiceProfiles.map(({ id }) => id))
  const characterIds = graph.voiceProfiles.map(({ characterId }) => characterId).filter(Boolean)
  if (voiceIds.size !== graph.voiceProfiles.length || new Set(characterIds).size !== characterIds.length) fail('DUPLICATE_VOICE', 'soundTimeline voice mappings must be unique')
  const audioContext = { durationMs: graph.durationMs, voices: graph.voiceProfiles, voiceIds }
  graph.audioCues.forEach((cue, index) => assertAudioCue(cue, `soundTimeline.audioCues[${index}]`, audioContext))
  const audioById = new Map(graph.audioCues.map((cue) => [cue.id, cue]))
  if (audioById.size !== graph.audioCues.length) fail('DUPLICATE_ID', 'soundTimeline.audioCues contains duplicate ids')
  const subtitleContext = { durationMs: graph.durationMs, audioById }
  graph.subtitleCues.forEach((cue, index) => assertSubtitleCue(cue, `soundTimeline.subtitleCues[${index}]`, subtitleContext))
  if (new Set(graph.subtitleCues.map(({ id }) => id)).size !== graph.subtitleCues.length) fail('DUPLICATE_ID', 'soundTimeline.subtitleCues contains duplicate ids')
  if (new Set(graph.subtitleCues.map(({ audioCueId }) => audioCueId)).size !== graph.subtitleCues.length) fail('DUPLICATE_SUBTITLE', 'Speech cues may have only one subtitle')
  const allIds = [...voiceIds, ...audioById.keys(), ...graph.subtitleCues.map(({ id }) => id)]
  if (new Set(allIds).size !== allIds.length) fail('DUPLICATE_ID', 'soundTimeline contains an id collision')
  assertSubtitleStyle(graph.subtitleStyle, 'soundTimeline.subtitleStyle')
  assertMix(graph.mix, 'soundTimeline.mix')
  integer(graph.revision, 'soundTimeline.revision', 0)
  integer(graph.createdAt, 'soundTimeline.createdAt', 1)
  integer(graph.updatedAt, 'soundTimeline.updatedAt', graph.createdAt)
  return graph
}

function validPrevious(input) {
  if (!input) return null
  try { return clone(assertSoundTimeline(input)) } catch { return null }
}

function extractSpecialLines(action, labels) {
  const labelPattern = labels.join('|')
  const pattern = new RegExp(`(?:^|\\s)(?:${labelPattern})[：:]\\s*(.{1,500}?)(?=\\s[^：:\\s]{1,24}[：:]|$)`, 'giu')
  return [...String(action).matchAll(pattern)].map((match) => match[1].trim()).filter(Boolean)
}

function speechWindows(entries, startMs, endMs) {
  if (!entries.length) return []
  const pad = Math.min(150, Math.floor((endMs - startMs) * 0.05))
  const windowStart = startMs + pad
  const windowEnd = Math.max(windowStart + entries.length, endMs - pad)
  const weights = entries.map(({ text: value }) => Math.max(4, Math.min(48, [...value].length)))
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  let cursor = windowStart
  return entries.map((entry, index) => {
    const remainingEnd = index === entries.length - 1
      ? windowEnd
      : Math.max(cursor + 1, Math.round(windowStart + (windowEnd - windowStart) * weights.slice(0, index + 1).reduce((sum, weight) => sum + weight, 0) / total))
    const result = { ...entry, startMs: cursor, endMs: remainingEnd }
    cursor = remainingEnd
    return result
  })
}

function previousAssetState(previousCue, fingerprint) {
  if (!previousCue || previousCue.fingerprint !== fingerprint || !previousCue.asset) return { asset: null, status: 'planned' }
  return { asset: clone(previousCue.asset), status: previousCue.status === 'approved' ? 'approved' : 'ready' }
}

function makeAudioCue(input, previousCue, now, preserveTiming) {
  const base = {
    id: input.id,
    kind: input.kind,
    sceneId: input.sceneId ?? null,
    shotId: input.shotId ?? null,
    speakerCharacterId: input.speakerCharacterId ?? null,
    speakerLabel: input.speakerLabel ?? null,
    text: input.text,
    startMs: preserveTiming && previousCue ? previousCue.startMs : input.startMs,
    endMs: preserveTiming && previousCue ? previousCue.endMs : input.endMs,
    gainDb: previousCue?.gainDb ?? input.gainDb ?? (SPEECH_KINDS.has(input.kind) ? 0 : -6),
    fadeInMs: previousCue?.fadeInMs ?? input.fadeInMs ?? (input.kind === 'music' ? 800 : 80),
    fadeOutMs: previousCue?.fadeOutMs ?? input.fadeOutMs ?? (input.kind === 'music' ? 800 : 80),
    voiceProfileId: input.voiceProfileId ?? null,
    required: input.required === true,
  }
  base.fingerprint = cueFingerprint(base)
  return {
    ...base,
    ...previousAssetState(previousCue, base.fingerprint),
    revision: previousCue?.revision ?? 0,
    updatedAt: now,
  }
}

function previousById(items) {
  return new Map((items ?? []).map((item) => [item.id, item]))
}

export function createSoundTimeline({ story = null, durationMs = null, now = Date.now(), previous = null } = {}) {
  integer(now, 'now', 1)
  const prior = validPrevious(previous)
  const computedDuration = story
    ? story.scenes.reduce((total, scene) => total + scene.shots.reduce((shotTotal, shot) => shotTotal + shot.durationSeconds * 1_000, 0), 0)
    : durationMs
  integer(computedDuration, 'durationMs', 1, SOUND_TIMELINE_LIMITS.maxDurationMs)
  const sameStoryRevision = Boolean(prior && story && prior.storyProjectId === story.id && prior.storyRevision === story.revision)
  const priorVoices = previousById(prior?.voiceProfiles)
  const priorAudio = previousById(prior?.audioCues)
  const priorSubtitles = previousById(prior?.subtitleCues)
  const voiceProfiles = []
  const characterVoiceById = new Map()
  for (const character of story?.characters ?? []) {
    const id = stableId('voice', character.id, character.name)
    const previousProfile = priorVoices.get(id)
    const profile = {
      id,
      characterId: character.id,
      speaker: character.name,
      providerLabel: previousProfile?.providerLabel ?? '',
      voiceId: previousProfile?.voiceId ?? '',
      language: previousProfile?.language ?? story.source.language ?? 'zh-CN',
      speed: previousProfile?.speed ?? 1,
      status: previousProfile?.status ?? 'draft',
      revision: previousProfile?.revision ?? 0,
      updatedAt: now,
    }
    voiceProfiles.push(profile)
    characterVoiceById.set(character.id, profile.id)
  }

  const narrationLines = (story?.scenes ?? []).flatMap((scene) => scene.shots.flatMap((shot) => extractSpecialLines(shot.action, ['旁白', '画外音', 'narrator'])))
  let narratorVoiceId = null
  if (narrationLines.length) {
    narratorVoiceId = stableId('voice', story.id, 'narrator')
    const previousProfile = priorVoices.get(narratorVoiceId)
    voiceProfiles.push({
      id: narratorVoiceId,
      characterId: null,
      speaker: '旁白',
      providerLabel: previousProfile?.providerLabel ?? '',
      voiceId: previousProfile?.voiceId ?? '',
      language: previousProfile?.language ?? story.source.language ?? 'zh-CN',
      speed: previousProfile?.speed ?? 1,
      status: previousProfile?.status ?? 'draft',
      revision: previousProfile?.revision ?? 0,
      updatedAt: now,
    })
  }

  const audioCues = []
  const subtitleCues = []
  let cursor = 0
  for (const scene of story?.scenes ?? []) {
    const sceneStart = cursor
    for (const shot of scene.shots) {
      const shotStart = cursor
      const shotEnd = shotStart + shot.durationSeconds * 1_000
      const narration = extractSpecialLines(shot.action, ['旁白', '画外音', 'narrator']).map((value, index) => ({
        kind: 'narration',
        text: value,
        speaker: '旁白',
        speakerCharacterId: null,
        voiceProfileId: narratorVoiceId,
        sourceIndex: index,
      }))
      const dialogue = shot.dialogue.map((line, index) => {
        const character = story.characters.find(({ name, aliases }) => name === line.speaker || aliases.includes(line.speaker))
        return {
          kind: 'dialogue',
          text: line.text,
          speaker: line.speaker,
          speakerCharacterId: character?.id ?? null,
          voiceProfileId: characterVoiceById.get(character?.id) ?? null,
          sourceIndex: index,
        }
      }).filter(({ voiceProfileId }) => voiceProfileId)
      const speech = speechWindows([...narration, ...dialogue], shotStart, shotEnd)
      for (const entry of speech) {
        const cueId = stableId('sound', shot.id, entry.kind, entry.sourceIndex, entry.speaker, entry.text)
        const priorCue = priorAudio.get(cueId)
        const cue = makeAudioCue({
          id: cueId,
          kind: entry.kind,
          sceneId: scene.id,
          shotId: shot.id,
          speakerCharacterId: entry.speakerCharacterId,
          speakerLabel: entry.speaker,
          text: entry.text,
          startMs: entry.startMs,
          endMs: entry.endMs,
          voiceProfileId: entry.voiceProfileId,
          required: true,
          gainDb: 0,
          fadeInMs: 20,
          fadeOutMs: 40,
        }, priorCue, now, sameStoryRevision)
        audioCues.push(cue)
        const subtitleId = stableId('subtitle', cueId)
        const priorSubtitle = priorSubtitles.get(subtitleId)
        subtitleCues.push({
          id: subtitleId,
          audioCueId: cueId,
          shotId: shot.id,
          speakerCharacterId: entry.speakerCharacterId,
          text: sameStoryRevision && priorSubtitle ? priorSubtitle.text : entry.text,
          startMs: sameStoryRevision && priorSubtitle ? priorSubtitle.startMs : entry.startMs,
          endMs: sameStoryRevision && priorSubtitle ? priorSubtitle.endMs : entry.endMs,
          status: sameStoryRevision && priorSubtitle?.status === 'approved' ? 'approved' : 'draft',
          revision: priorSubtitle?.revision ?? 0,
          updatedAt: now,
        })
      }
      const soundEffects = extractSpecialLines(shot.action, ['音效', 'sfx'])
      soundEffects.forEach((value, index) => {
        const cueId = stableId('sound', shot.id, 'sfx', index, value)
        audioCues.push(makeAudioCue({
          id: cueId,
          kind: 'sfx',
          sceneId: scene.id,
          shotId: shot.id,
          text: value,
          startMs: shotStart,
          endMs: shotEnd,
          required: false,
          gainDb: -3,
          fadeInMs: 20,
          fadeOutMs: 80,
        }, priorAudio.get(cueId), now, sameStoryRevision))
      })
      cursor = shotEnd
    }
    const ambienceId = stableId('sound', scene.id, 'ambience')
    audioCues.push(makeAudioCue({
      id: ambienceId,
      kind: 'ambience',
      sceneId: scene.id,
      text: `${scene.heading} · 连续环境底噪与空间声场`,
      startMs: sceneStart,
      endMs: cursor,
      required: false,
      gainDb: -12,
      fadeInMs: 400,
      fadeOutMs: 400,
    }, priorAudio.get(ambienceId), now, sameStoryRevision))
  }

  const musicId = stableId('sound', story?.id ?? 'unbound', 'music-bed')
  audioCues.push(makeAudioCue({
    id: musicId,
    kind: 'music',
    text: story ? `${story.title} · 全片情绪音乐床` : '全片情绪音乐床',
    startMs: 0,
    endMs: computedDuration,
    required: false,
    gainDb: -14,
    fadeInMs: 800,
    fadeOutMs: 800,
  }, priorAudio.get(musicId), now, sameStoryRevision))

  const priorStyle = prior?.subtitleStyle
  const priorMix = prior?.mix
  const graph = {
    kind: GRAPH_KIND,
    schemaVersion: SOUND_TIMELINE_SCHEMA_VERSION,
    storyProjectId: story?.id ?? null,
    storyRevision: story?.revision ?? null,
    durationMs: computedDuration,
    voiceProfiles,
    audioCues,
    subtitleCues,
    subtitleStyle: {
      position: priorStyle?.position ?? 'bottom',
      maxLines: priorStyle?.maxLines ?? 2,
      safeMarginPercent: priorStyle?.safeMarginPercent ?? 8,
      fontScalePercent: priorStyle?.fontScalePercent ?? 100,
      background: priorStyle?.background ?? 'shadow',
      status: sameStoryRevision && priorStyle?.status === 'approved' ? 'approved' : 'draft',
      revision: priorStyle?.revision ?? 0,
      updatedAt: now,
    },
    mix: {
      targetLufs: priorMix?.targetLufs ?? -14,
      truePeakDbtp: priorMix?.truePeakDbtp ?? -1.5,
      dialogueDuckingDb: priorMix?.dialogueDuckingDb ?? -9,
      sampleRate: 48_000,
      channels: 2,
      status: sameStoryRevision && priorMix?.status === 'approved' ? 'approved' : 'draft',
      revision: priorMix?.revision ?? 0,
      updatedAt: now,
    },
    revision: prior ? prior.revision + 1 : 0,
    createdAt: prior?.createdAt ?? now,
    updatedAt: now,
  }
  return clone(assertSoundTimeline(graph))
}

function editGraph(input, now, mutator) {
  const graph = clone(assertSoundTimeline(input))
  integer(now, 'now', graph.updatedAt)
  mutator(graph)
  graph.revision += 1
  graph.updatedAt = now
  return clone(assertSoundTimeline(graph))
}

function findAudioCue(graph, cueId) {
  safeId(cueId, 'cueId')
  const cue = graph.audioCues.find(({ id }) => id === cueId)
  if (!cue) fail('UNKNOWN_AUDIO_CUE', `Unknown audio cue ${cueId}`)
  return cue
}

export function configureVoiceProfile(input, profileId, patch, { now = Date.now() } = {}) {
  return editGraph(input, now, (graph) => {
    safeId(profileId, 'profileId')
    const profile = graph.voiceProfiles.find(({ id }) => id === profileId)
    if (!profile) fail('UNKNOWN_VOICE', `Unknown voice profile ${profileId}`)
    const value = record(patch, 'patch')
    const allowed = new Set(['providerLabel', 'voiceId', 'language', 'speed'])
    const unknown = Object.keys(value).filter((key) => !allowed.has(key))
    if (unknown.length || !Object.keys(value).length) fail('INVALID_FIELDS', 'Voice patch is invalid', { unknown })
    if (value.providerLabel !== undefined) profile.providerLabel = text(value.providerLabel, 'patch.providerLabel', 120, true)
    if (value.voiceId !== undefined) profile.voiceId = text(value.voiceId, 'patch.voiceId', 160, true)
    if (value.language !== undefined) profile.language = text(value.language, 'patch.language', 32)
    if (value.speed !== undefined) profile.speed = finite(value.speed, 'patch.speed', 0.5, 2, 2)
    profile.status = profile.providerLabel.trim() && profile.voiceId.trim() ? 'configured' : 'draft'
    profile.revision += 1
    profile.updatedAt = now
    for (const cue of graph.audioCues.filter(({ voiceProfileId }) => voiceProfileId === profile.id)) {
      cue.asset = null
      cue.status = 'planned'
      cue.revision += 1
      cue.updatedAt = now
    }
  })
}

export function approveVoiceProfile(input, profileId, { now = Date.now() } = {}) {
  return editGraph(input, now, (graph) => {
    safeId(profileId, 'profileId')
    const profile = graph.voiceProfiles.find(({ id }) => id === profileId)
    if (!profile) fail('UNKNOWN_VOICE', `Unknown voice profile ${profileId}`)
    if (profile.status !== 'configured') fail('VOICE_NOT_CONFIGURED', `${profileId} is not ready for approval`)
    profile.status = 'approved'
    profile.revision += 1
    profile.updatedAt = now
  })
}

export function bindSoundAsset(input, cueId, binding, { now = Date.now() } = {}) {
  const asset = clone(assertSoundAssetBinding(binding))
  return editGraph(input, now, (graph) => {
    const cue = findAudioCue(graph, cueId)
    cue.asset = asset
    cue.status = 'ready'
    cue.revision += 1
    cue.updatedAt = now
  })
}

export function approveSoundAsset(input, cueId, { now = Date.now() } = {}) {
  return editGraph(input, now, (graph) => {
    const cue = findAudioCue(graph, cueId)
    if (!cue.asset || cue.status !== 'ready') fail('ASSET_NOT_READY', `${cueId} has no reviewable audio asset`)
    cue.status = 'approved'
    cue.revision += 1
    cue.updatedAt = now
  })
}

export function unbindSoundAsset(input, cueId, { now = Date.now() } = {}) {
  return editGraph(input, now, (graph) => {
    const cue = findAudioCue(graph, cueId)
    cue.asset = null
    cue.status = 'planned'
    cue.revision += 1
    cue.updatedAt = now
  })
}

export function patchSoundCue(input, cueId, patch, { now = Date.now() } = {}) {
  return editGraph(input, now, (graph) => {
    const cue = findAudioCue(graph, cueId)
    const value = record(patch, 'patch')
    const allowed = new Set(['text', 'startMs', 'endMs', 'gainDb', 'fadeInMs', 'fadeOutMs'])
    const unknown = Object.keys(value).filter((key) => !allowed.has(key))
    if (unknown.length || !Object.keys(value).length) fail('INVALID_FIELDS', 'Audio cue patch is invalid', { unknown })
    const previousText = cue.text
    const previousStart = cue.startMs
    const previousEnd = cue.endMs
    if (value.text !== undefined) cue.text = text(value.text, 'patch.text')
    if (value.startMs !== undefined) cue.startMs = integer(value.startMs, 'patch.startMs', 0, graph.durationMs - 1)
    if (value.endMs !== undefined) cue.endMs = integer(value.endMs, 'patch.endMs', cue.startMs + 1, graph.durationMs)
    if (cue.endMs <= cue.startMs) fail('INVALID_RANGE', 'Audio cue end must follow its start')
    const duration = cue.endMs - cue.startMs
    if (value.gainDb !== undefined) cue.gainDb = finite(value.gainDb, 'patch.gainDb', -60, 12, 1)
    if (value.fadeInMs !== undefined) cue.fadeInMs = integer(value.fadeInMs, 'patch.fadeInMs', 0, duration)
    if (value.fadeOutMs !== undefined) cue.fadeOutMs = integer(value.fadeOutMs, 'patch.fadeOutMs', 0, duration)
    if (cue.fadeInMs + cue.fadeOutMs > duration) fail('INVALID_FADE', 'Audio cue fades exceed its duration')
    cue.fingerprint = cueFingerprint(cue)
    if (cue.text !== previousText) {
      cue.asset = null
      cue.status = 'planned'
    }
    cue.revision += 1
    cue.updatedAt = now
    const subtitle = graph.subtitleCues.find(({ audioCueId }) => audioCueId === cue.id)
    if (subtitle && (cue.text !== previousText || cue.startMs !== previousStart || cue.endMs !== previousEnd)) {
      subtitle.text = cue.text
      subtitle.startMs = cue.startMs
      subtitle.endMs = cue.endMs
      subtitle.status = 'draft'
      subtitle.revision += 1
      subtitle.updatedAt = now
    }
  })
}

export function patchSubtitleCue(input, subtitleId, patch, { now = Date.now() } = {}) {
  return editGraph(input, now, (graph) => {
    safeId(subtitleId, 'subtitleId')
    const cue = graph.subtitleCues.find(({ id }) => id === subtitleId)
    if (!cue) fail('UNKNOWN_SUBTITLE', `Unknown subtitle ${subtitleId}`)
    const value = record(patch, 'patch')
    const allowed = new Set(['text', 'startMs', 'endMs'])
    const unknown = Object.keys(value).filter((key) => !allowed.has(key))
    if (unknown.length || !Object.keys(value).length) fail('INVALID_FIELDS', 'Subtitle patch is invalid', { unknown })
    if (value.text !== undefined) cue.text = text(value.text, 'patch.text')
    if (value.startMs !== undefined) cue.startMs = integer(value.startMs, 'patch.startMs', 0, graph.durationMs - 1)
    if (value.endMs !== undefined) cue.endMs = integer(value.endMs, 'patch.endMs', cue.startMs + 1, graph.durationMs)
    if (cue.endMs <= cue.startMs) fail('INVALID_RANGE', 'Subtitle end must follow its start')
    cue.status = 'draft'
    cue.revision += 1
    cue.updatedAt = now
  })
}

export function approveSubtitleCue(input, subtitleId, { now = Date.now() } = {}) {
  return editGraph(input, now, (graph) => {
    safeId(subtitleId, 'subtitleId')
    const cue = graph.subtitleCues.find(({ id }) => id === subtitleId)
    if (!cue) fail('UNKNOWN_SUBTITLE', `Unknown subtitle ${subtitleId}`)
    cue.status = 'approved'
    cue.revision += 1
    cue.updatedAt = now
  })
}

export function approveAllSubtitles(input, { now = Date.now() } = {}) {
  return editGraph(input, now, (graph) => {
    graph.subtitleCues.forEach((cue) => {
      cue.status = 'approved'
      cue.revision += 1
      cue.updatedAt = now
    })
  })
}

export function patchSubtitleStyle(input, patch, { now = Date.now() } = {}) {
  return editGraph(input, now, (graph) => {
    const value = record(patch, 'patch')
    const allowed = new Set(['position', 'maxLines', 'safeMarginPercent', 'fontScalePercent', 'background'])
    const unknown = Object.keys(value).filter((key) => !allowed.has(key))
    if (unknown.length || !Object.keys(value).length) fail('INVALID_FIELDS', 'Subtitle style patch is invalid', { unknown })
    if (value.position !== undefined) {
      if (!['bottom', 'top'].includes(value.position)) fail('INVALID_SUBTITLE_STYLE', 'patch.position is unsupported')
      graph.subtitleStyle.position = value.position
    }
    if (value.maxLines !== undefined) graph.subtitleStyle.maxLines = integer(value.maxLines, 'patch.maxLines', 1, 2)
    if (value.safeMarginPercent !== undefined) graph.subtitleStyle.safeMarginPercent = integer(value.safeMarginPercent, 'patch.safeMarginPercent', 5, 20)
    if (value.fontScalePercent !== undefined) graph.subtitleStyle.fontScalePercent = integer(value.fontScalePercent, 'patch.fontScalePercent', 70, 140)
    if (value.background !== undefined) {
      if (!['shadow', 'box', 'none'].includes(value.background)) fail('INVALID_SUBTITLE_STYLE', 'patch.background is unsupported')
      graph.subtitleStyle.background = value.background
    }
    graph.subtitleStyle.status = 'draft'
    graph.subtitleStyle.revision += 1
    graph.subtitleStyle.updatedAt = now
  })
}

export function approveSubtitleStyle(input, { now = Date.now() } = {}) {
  return editGraph(input, now, (graph) => {
    graph.subtitleStyle.status = 'approved'
    graph.subtitleStyle.revision += 1
    graph.subtitleStyle.updatedAt = now
  })
}

export function patchSoundMix(input, patch, { now = Date.now() } = {}) {
  return editGraph(input, now, (graph) => {
    const value = record(patch, 'patch')
    const allowed = new Set(['targetLufs', 'truePeakDbtp', 'dialogueDuckingDb'])
    const unknown = Object.keys(value).filter((key) => !allowed.has(key))
    if (unknown.length || !Object.keys(value).length) fail('INVALID_FIELDS', 'Mix patch is invalid', { unknown })
    if (value.targetLufs !== undefined) graph.mix.targetLufs = finite(value.targetLufs, 'patch.targetLufs', -24, -9, 1)
    if (value.truePeakDbtp !== undefined) graph.mix.truePeakDbtp = finite(value.truePeakDbtp, 'patch.truePeakDbtp', -3, -0.1, 1)
    if (value.dialogueDuckingDb !== undefined) graph.mix.dialogueDuckingDb = finite(value.dialogueDuckingDb, 'patch.dialogueDuckingDb', -18, 0, 1)
    graph.mix.status = 'draft'
    graph.mix.revision += 1
    graph.mix.updatedAt = now
  })
}

export function approveSoundMix(input, { now = Date.now() } = {}) {
  return editGraph(input, now, (graph) => {
    graph.mix.status = 'approved'
    graph.mix.revision += 1
    graph.mix.updatedAt = now
  })
}

export function soundTimelineReady(input) {
  const graph = assertSoundTimeline(input)
  return graph.audioCues.filter(({ required }) => required).every(({ status }) => status === 'approved')
    && graph.subtitleCues.every(({ status }) => status === 'approved')
    && graph.subtitleStyle.status === 'approved'
    && graph.mix.status === 'approved'
}

export function soundTimelineSummary(input) {
  const graph = assertSoundTimeline(input)
  const requiredAudio = graph.audioCues.filter(({ required }) => required)
  return {
    durationMs: graph.durationMs,
    voices: graph.voiceProfiles.length,
    approvedVoices: graph.voiceProfiles.filter(({ status }) => status === 'approved').length,
    audioCues: graph.audioCues.length,
    requiredAudio: requiredAudio.length,
    approvedRequiredAudio: requiredAudio.filter(({ status }) => status === 'approved').length,
    subtitleCues: graph.subtitleCues.length,
    approvedSubtitles: graph.subtitleCues.filter(({ status }) => status === 'approved').length,
    subtitleStyleApproved: graph.subtitleStyle.status === 'approved',
    mixApproved: graph.mix.status === 'approved',
    ready: soundTimelineReady(graph),
  }
}
