import { patchSubtitleCue, assertSoundTimeline } from './soundTimeline.mjs'

export const SOUND_ALIGNMENT_SCHEMA_VERSION = 1

export const SOUND_ALIGNMENT_LIMITS = Object.freeze({
  maxCueId: 160,
  maxFingerprint: 160,
  maxAudioContentHash: 64,
  maxLanguage: 32,
  maxWords: 8_192,
  maxWordText: 256,
  maxTotalWordText: 2_000,
})

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const SHA256 = /^[a-f0-9]{64}$/u
const LANGUAGE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,3}$/u
const ALIGNMENT_SOURCES = new Set(['whisperx', 'manual'])

export class SoundAlignmentError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'SoundAlignmentError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

function fail(code, message, details) {
  throw new SoundAlignmentError(code, message, details)
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

function exactKeysWithOptional(value, required, optional, path) {
  const object = record(value, path)
  const expected = new Set([...required, ...optional])
  const unknown = Object.keys(object).filter((key) => !expected.has(key))
  const missing = required.filter((key) => !Object.hasOwn(object, key))
  if (unknown.length || missing.length) fail('INVALID_FIELDS', `${path} fields are invalid`, { unknown, missing })
  return object
}

function text(value, path, max, { allowEmpty = false, singleLine = false } = {}) {
  if (
    typeof value !== 'string'
    || value.length > max
    || (!allowEmpty && !value.trim())
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)
    || (singleLine && /[\r\n]/u.test(value))
  ) {
    fail('INVALID_TEXT', `${path} is invalid`)
  }
  return value
}

function safeId(value, path, max = 160) {
  if (typeof value !== 'string' || value.length > max || !SAFE_ID.test(value)) fail('INVALID_ID', `${path} is invalid`)
  return value
}

function integer(value, path, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('INVALID_INTEGER', `${path} is invalid`)
  return value
}

function confidence(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1 || Math.round(value * 1_000) !== value * 1_000) {
    fail('INVALID_CONFIDENCE', `${path} must be a number between 0 and 1 with at most three decimals`)
  }
  return value
}

function durationContext(durationMs) {
  if (durationMs === undefined) return null
  return integer(durationMs, 'durationMs', 1, 24 * 60 * 60 * 1_000)
}

function normalizeComparableText(value) {
  return String(value).normalize('NFKC').replace(/\s+/gu, '')
}

/**
 * Validate the transient alignment candidate. `durationMs` is deliberately a
 * caller supplied fact about the actual audio asset; it is not persisted in
 * the candidate protocol, so imported candidates cannot invent their bound.
 */
export function assertSoundAlignmentCandidate(input, { durationMs } = {}) {
  const value = exactKeys(input, [
    'schemaVersion', 'cueId', 'cueFingerprint', 'audioContentHash', 'language', 'source', 'words',
  ], 'soundAlignment')
  if (value.schemaVersion !== SOUND_ALIGNMENT_SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA', 'Unsupported sound alignment schema')
  safeId(value.cueId, 'soundAlignment.cueId', SOUND_ALIGNMENT_LIMITS.maxCueId)
  safeId(value.cueFingerprint, 'soundAlignment.cueFingerprint', SOUND_ALIGNMENT_LIMITS.maxFingerprint)
  if (typeof value.audioContentHash !== 'string' || value.audioContentHash.length !== SOUND_ALIGNMENT_LIMITS.maxAudioContentHash || !SHA256.test(value.audioContentHash)) {
    fail('INVALID_AUDIO_HASH', 'soundAlignment.audioContentHash must be a lowercase SHA-256')
  }
  if (typeof value.language !== 'string' || value.language.length > SOUND_ALIGNMENT_LIMITS.maxLanguage || !LANGUAGE.test(value.language)) {
    fail('INVALID_LANGUAGE', 'soundAlignment.language is invalid')
  }
  if (!ALIGNMENT_SOURCES.has(value.source)) fail('INVALID_SOURCE', 'soundAlignment.source is unsupported')
  if (!Array.isArray(value.words) || value.words.length === 0 || value.words.length > SOUND_ALIGNMENT_LIMITS.maxWords) {
    fail('INVALID_WORDS', 'soundAlignment.words must contain 1–8,192 words')
  }
  const actualDurationMs = durationContext(durationMs)
  let previousEndMs = 0
  let totalTextLength = 0
  value.words.forEach((rawWord, index) => {
    const path = `soundAlignment.words[${index}]`
    const word = exactKeysWithOptional(rawWord, ['text', 'startMs', 'endMs'], ['confidence'], path)
    text(word.text, `${path}.text`, SOUND_ALIGNMENT_LIMITS.maxWordText, { singleLine: true })
    totalTextLength += [...word.text].length
    if (totalTextLength > SOUND_ALIGNMENT_LIMITS.maxTotalWordText) fail('COLLECTION_LIMIT', 'soundAlignment word text is too long')
    integer(word.startMs, `${path}.startMs`, 0)
    integer(word.endMs, `${path}.endMs`, word.startMs + 1)
    if (index > 0 && word.startMs < previousEndMs) {
      fail('WORDS_OVERLAP', `${path} overlaps the preceding word`, { previousEndMs, startMs: word.startMs })
    }
    if (actualDurationMs !== null && word.endMs > actualDurationMs) {
      fail('WORD_OUT_OF_RANGE', `${path}.endMs exceeds the actual audio duration`, { durationMs: actualDurationMs, endMs: word.endMs })
    }
    if (Object.hasOwn(word, 'confidence')) confidence(word.confidence, `${path}.confidence`)
    previousEndMs = word.endMs
  })
  return clone(value)
}

function resolveAlignment(timelineInput, candidateInput, { durationMs } = {}) {
  const timeline = assertSoundTimeline(timelineInput)
  const actualDurationMs = durationContext(durationMs)
  if (actualDurationMs === null) fail('ALIGNMENT_AUDIO_DURATION_REQUIRED', 'Actual audio duration is required before applying an alignment candidate')
  const candidate = assertSoundAlignmentCandidate(candidateInput, { durationMs: actualDurationMs })
  const cue = timeline.audioCues.find(({ id }) => id === candidate.cueId)
  if (!cue) fail('ALIGNMENT_CUE_NOT_FOUND', `Alignment cue ${candidate.cueId} does not exist`)
  if (!['dialogue', 'narration'].includes(cue.kind)) fail('ALIGNMENT_CUE_NOT_SPEECH', `Alignment cue ${candidate.cueId} is not speech`)
  if (candidate.cueFingerprint !== cue.fingerprint) {
    fail('ALIGNMENT_CUE_FINGERPRINT_MISMATCH', 'Alignment candidate belongs to stale cue text or voice input', {
      cueId: cue.id,
      expected: cue.fingerprint,
      actual: candidate.cueFingerprint,
    })
  }
  if (!cue.asset) fail('ALIGNMENT_AUDIO_NOT_BOUND', `Alignment cue ${cue.id} has no immutable audio asset`)
  if (candidate.audioContentHash !== cue.asset.contentHash) {
    fail('ALIGNMENT_AUDIO_HASH_MISMATCH', 'Alignment candidate belongs to a replaced audio asset', {
      cueId: cue.id,
      expected: cue.asset.contentHash,
      actual: candidate.audioContentHash,
    })
  }
  const subtitle = timeline.subtitleCues.find(({ audioCueId }) => audioCueId === cue.id)
  if (!subtitle) fail('ALIGNMENT_SUBTITLE_NOT_FOUND', `Alignment cue ${cue.id} has no linked subtitle`)
  const relativeEndMs = candidate.words.at(-1).endMs
  const cueDurationMs = cue.endMs - cue.startMs
  if (relativeEndMs > cueDurationMs) {
    fail('ALIGNMENT_EXCEEDS_CUE_WINDOW', 'Aligned words extend beyond the selected cue window', {
      cueId: cue.id,
      cueDurationMs,
      relativeEndMs,
    })
  }
  const candidateText = normalizeComparableText(candidate.words.map(({ text: value }) => value).join(''))
  const cueText = normalizeComparableText(cue.text)
  if (candidateText !== cueText) {
    fail('ALIGNMENT_TEXT_DRIFT', 'Aligned words do not match the current cue text', {
      cueId: cue.id,
      expectedText: cue.text,
      actualText: candidate.words.map(({ text: value }) => value).join(''),
    })
  }
  return { timeline, candidate, cue, subtitle }
}

export function previewSoundAlignment(timelineInput, candidateInput, { durationMs } = {}) {
  const { candidate, cue, subtitle } = resolveAlignment(timelineInput, candidateInput, { durationMs })
  const firstWord = candidate.words[0]
  const lastWord = candidate.words.at(-1)
  const patch = {
    startMs: cue.startMs + firstWord.startMs,
    endMs: cue.startMs + lastWord.endMs,
  }
  return {
    cueId: cue.id,
    subtitleId: subtitle.id,
    cueFingerprint: cue.fingerprint,
    audioContentHash: cue.asset.contentHash,
    source: candidate.source,
    patch,
    words: candidate.words.map((word) => ({
      ...word,
      startMs: cue.startMs + word.startMs,
      endMs: cue.startMs + word.endMs,
    })),
  }
}

export function applySoundAlignment(timelineInput, candidateInput, { durationMs, now = Date.now() } = {}) {
  const preview = previewSoundAlignment(timelineInput, candidateInput, { durationMs })
  return patchSubtitleCue(timelineInput, preview.subtitleId, preview.patch, { now })
}
