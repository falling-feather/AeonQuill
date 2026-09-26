export type ImageEditPresetId = 'base40' | 'lightning4'

export type ImageEditPresetMaturity = 'candidate' | 'experimental'

export type ImageEditPreset = Readonly<{
  id: ImageEditPresetId
  label: string
  maturity: ImageEditPresetMaturity
  version: string
  workflowVersion: string
  steps: number
  cfg: number
  sampler: 'euler'
  scheduler: 'simple'
  denoise: 1
  shift: 3.1
  loraStrength: number
  loraArtifactId: string | null
}>

export const IMAGE_EDIT_PRESETS: Readonly<Record<ImageEditPresetId, ImageEditPreset>>
export function getImageEditPreset(value?: unknown): ImageEditPreset
