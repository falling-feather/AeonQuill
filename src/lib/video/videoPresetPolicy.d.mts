export type VideoPresetId = 'fast' | 'balanced' | 'delivery720' | 'nativeHigh' | 'cinemaBase' | 'master720' | 'nativeBase'
export type VideoAspectRatio = '16:9' | '9:16' | '1:1'
export type VideoDuration = 5 | 10 | 15
export type VideoDimensions = Readonly<Record<VideoAspectRatio, Readonly<{ width: number; height: number }>>>
export type VideoPresetPolicy = Readonly<{
  id: VideoPresetId; label: string; description: string; qualityClass: string
  steps: number; samplingMode: 'base' | 'turbo'; sampler: string; lowVram: boolean; loraStrength: number
  nativeScale: string; delivery: string; preserveNative: boolean; minVramGb: number; minSystemRamGb: number
  allowedDurations: readonly VideoDuration[]; preferredModelProfiles: readonly string[]; allowedModelProfiles?: readonly string[]
  estimatedMinutes: Readonly<Partial<Record<VideoDuration, string>>>; validation: string; postprocessor?: string
  memoryOptimizations?: Readonly<{ headChunks: number; feedForwardChunks: number; tokenThreshold: number }>
  requiredNodes?: readonly string[]
}>
export const VIDEO_PRESETS: Readonly<Record<VideoPresetId, VideoPresetPolicy>>
export const VIDEO_NATIVE_DIMENSIONS: Readonly<Record<string, VideoDimensions>>
export const VIDEO_DELIVERY_DIMENSIONS_720P: VideoDimensions
export const VIDEO_PRESET_IDS: readonly VideoPresetId[]
export const VIDEO_PRESET_DISPLAY_ORDER: readonly VideoPresetId[]
export function assertVideoPresetModelProfile(presetId: VideoPresetId, profileId: string): void
export type VideoPresetPresentation = Readonly<{
  id: VideoPresetId; label: string; native: Readonly<Record<VideoAspectRatio, string>>; delivery: Readonly<Record<VideoAspectRatio, string>>
  nativeSummary: string; nativeSummaryByAspect: Readonly<Record<VideoAspectRatio, string>>; detail: string; pipeline: string; minVram: string; risk: string
  allowedDurations: readonly VideoDuration[]; estimate: Readonly<Partial<Record<VideoDuration, string>>>
  profile: 'preview' | 'quality' | 'master' | 'compatibility'
}>
export const VIDEO_PRESET_PRESENTATIONS: Readonly<Record<VideoPresetId, VideoPresetPresentation>>
