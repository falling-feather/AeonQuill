const BASE40_VERSION = 'qwen-image-edit-2511-int8-v1'
const LIGHTNING4_VERSION = 'qwen-image-edit-2511-int8-lightning4-v1'

function preset(definition) {
  return Object.freeze({
    ...definition,
    workflowVersion: definition.version,
  })
}

export const IMAGE_EDIT_PRESETS = Object.freeze({
  base40: preset({
    id: 'base40',
    label: '标准 · 40 步',
    maturity: 'candidate',
    version: BASE40_VERSION,
    steps: 40,
    cfg: 4,
    sampler: 'euler',
    scheduler: 'simple',
    denoise: 1,
    shift: 3.1,
    loraStrength: 0,
    loraArtifactId: null,
  }),
  lightning4: preset({
    id: 'lightning4',
    label: 'Lightning · 4 步',
    maturity: 'experimental',
    version: LIGHTNING4_VERSION,
    steps: 4,
    cfg: 1,
    sampler: 'euler',
    scheduler: 'simple',
    denoise: 1,
    shift: 3.1,
    loraStrength: 1,
    loraArtifactId: 'qwen-image-edit-2511-lightning4-bf16-v1',
  }),
})

export function getImageEditPreset(value = 'base40') {
  if (typeof value !== 'string' || !Object.hasOwn(IMAGE_EDIT_PRESETS, value)) {
    throw Object.assign(new Error(`Unknown image edit preset: ${String(value)}`), {
      code: 'INVALID_IMAGE_EDIT_PRESET',
      status: 400,
    })
  }
  return IMAGE_EDIT_PRESETS[value]
}
