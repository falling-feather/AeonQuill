export const SOUND_ALIGNMENT_SCHEMA_VERSION: 1
export const SOUND_ALIGNMENT_LIMITS: Readonly<{
  maxCueId: number
  maxFingerprint: number
  maxAudioContentHash: number
  maxLanguage: number
  maxWords: number
  maxWordText: number
  maxTotalWordText: number
}>

export type SoundAlignmentWord = {
  text: string
  startMs: number
  endMs: number
  confidence?: number
}

export type SoundAlignmentCandidate = {
  schemaVersion: 1
  cueId: string
  cueFingerprint: string
  audioContentHash: string
  language: string
  source: 'whisperx' | 'manual'
  words: SoundAlignmentWord[]
}

export type SoundAlignmentPreview = {
  cueId: string
  subtitleId: string
  cueFingerprint: string
  audioContentHash: string
  source: SoundAlignmentCandidate['source']
  patch: { startMs: number; endMs: number }
  words: SoundAlignmentWord[]
}

export class SoundAlignmentError extends Error {
  code: string
  details?: unknown
}

export function assertSoundAlignmentCandidate<T extends SoundAlignmentCandidate>(input: T, options?: { durationMs?: number }): T
export function previewSoundAlignment(input: import('./soundTimeline.mjs').SoundTimeline, candidate: SoundAlignmentCandidate, options?: { durationMs?: number }): SoundAlignmentPreview
export function applySoundAlignment(input: import('./soundTimeline.mjs').SoundTimeline, candidate: SoundAlignmentCandidate, options?: { durationMs?: number; now?: number }): import('./soundTimeline.mjs').SoundTimeline
