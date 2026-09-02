export const SOUND_TIMELINE_SCHEMA_VERSION: 1
export const SOUND_TIMELINE_LIMITS: Readonly<{
  maxDurationMs: number
  maxVoiceProfiles: number
  maxAudioCues: number
  maxSubtitleCues: number
  maxCueText: number
}>

export type SoundAssetBinding = {
  libraryItemId: string
  libraryVersionId: string
  contentHash: string
  mimeType: 'audio/mpeg' | 'audio/wav'
  scope: 'project' | 'global-reference'
  boundAt: number
}

export type SoundVoiceProfile = {
  id: string
  characterId: string | null
  speaker: string
  providerLabel: string
  voiceId: string
  language: string
  speed: number
  status: 'draft' | 'configured' | 'approved'
  revision: number
  updatedAt: number
}

export type SoundAudioCue = {
  id: string
  kind: 'dialogue' | 'narration' | 'music' | 'ambience' | 'sfx'
  sceneId: string | null
  shotId: string | null
  speakerCharacterId: string | null
  speakerLabel: string | null
  text: string
  startMs: number
  endMs: number
  gainDb: number
  fadeInMs: number
  fadeOutMs: number
  voiceProfileId: string | null
  required: boolean
  asset: SoundAssetBinding | null
  status: 'planned' | 'ready' | 'approved'
  fingerprint: string
  revision: number
  updatedAt: number
}

export type SoundSubtitleCue = {
  id: string
  audioCueId: string
  shotId: string
  speakerCharacterId: string | null
  text: string
  startMs: number
  endMs: number
  status: 'draft' | 'approved'
  revision: number
  updatedAt: number
}

export type SoundTimeline = {
  kind: 'aeonquill.sound-timeline'
  schemaVersion: 1
  storyProjectId: string | null
  storyRevision: number | null
  durationMs: number
  voiceProfiles: SoundVoiceProfile[]
  audioCues: SoundAudioCue[]
  subtitleCues: SoundSubtitleCue[]
  subtitleStyle: {
    position: 'bottom' | 'top'
    maxLines: 1 | 2
    safeMarginPercent: number
    fontScalePercent: number
    background: 'shadow' | 'box' | 'none'
    status: 'draft' | 'approved'
    revision: number
    updatedAt: number
  }
  mix: {
    targetLufs: number
    truePeakDbtp: number
    dialogueDuckingDb: number
    sampleRate: 48000
    channels: 2
    status: 'draft' | 'approved'
    revision: number
    updatedAt: number
  }
  revision: number
  createdAt: number
  updatedAt: number
}

export class SoundTimelineError extends Error {
  code: string
  details?: unknown
}

export function assertSoundAssetBinding<T extends SoundAssetBinding>(input: T): T
export function assertSoundTimeline<T extends SoundTimeline>(input: T): T
export function createSoundTimeline(input?: { story?: unknown; durationMs?: number | null; now?: number; previous?: SoundTimeline | null }): SoundTimeline
export function configureVoiceProfile(input: SoundTimeline, profileId: string, patch: Partial<Pick<SoundVoiceProfile, 'providerLabel' | 'voiceId' | 'language' | 'speed'>>, options?: { now?: number }): SoundTimeline
export function approveVoiceProfile(input: SoundTimeline, profileId: string, options?: { now?: number }): SoundTimeline
export function bindSoundAsset(input: SoundTimeline, cueId: string, binding: SoundAssetBinding, options?: { now?: number }): SoundTimeline
export function approveSoundAsset(input: SoundTimeline, cueId: string, options?: { now?: number }): SoundTimeline
export function unbindSoundAsset(input: SoundTimeline, cueId: string, options?: { now?: number }): SoundTimeline
export function patchSoundCue(input: SoundTimeline, cueId: string, patch: Partial<Pick<SoundAudioCue, 'text' | 'startMs' | 'endMs' | 'gainDb' | 'fadeInMs' | 'fadeOutMs'>>, options?: { now?: number }): SoundTimeline
export function patchSubtitleCue(input: SoundTimeline, subtitleId: string, patch: Partial<Pick<SoundSubtitleCue, 'text' | 'startMs' | 'endMs'>>, options?: { now?: number }): SoundTimeline
export function approveSubtitleCue(input: SoundTimeline, subtitleId: string, options?: { now?: number }): SoundTimeline
export function approveAllSubtitles(input: SoundTimeline, options?: { now?: number }): SoundTimeline
export function patchSubtitleStyle(input: SoundTimeline, patch: Partial<Omit<SoundTimeline['subtitleStyle'], 'status' | 'revision' | 'updatedAt'>>, options?: { now?: number }): SoundTimeline
export function approveSubtitleStyle(input: SoundTimeline, options?: { now?: number }): SoundTimeline
export function patchSoundMix(input: SoundTimeline, patch: Partial<Pick<SoundTimeline['mix'], 'targetLufs' | 'truePeakDbtp' | 'dialogueDuckingDb'>>, options?: { now?: number }): SoundTimeline
export function approveSoundMix(input: SoundTimeline, options?: { now?: number }): SoundTimeline
export function soundTimelineReady(input: SoundTimeline): boolean
export function soundTimelineSummary(input: SoundTimeline): {
  durationMs: number
  voices: number
  approvedVoices: number
  audioCues: number
  requiredAudio: number
  approvedRequiredAudio: number
  subtitleCues: number
  approvedSubtitles: number
  subtitleStyleApproved: boolean
  mixApproved: boolean
  ready: boolean
}
