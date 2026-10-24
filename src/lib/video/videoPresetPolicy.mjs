export const VIDEO_DURATION_FRAMES = Object.freeze({ 5: 124, 8: 192, 10: 243, 12: 294, 15: 362 })
export const VIDEO_DURATION_OPTIONS = Object.freeze(Object.keys(VIDEO_DURATION_FRAMES).map(Number))

const LONG_NATIVE_MEMORY = Object.freeze({ headChunks: 28, feedForwardChunks: 16, tokenThreshold: 4096 })

const PREVIEW_DIMENSIONS = Object.freeze({
  '16:9': Object.freeze({ width: 608, height: 352 }),
  '9:16': Object.freeze({ width: 352, height: 608 }),
  '1:1': Object.freeze({ width: 448, height: 448 }),
})

const QUALITY_DIMENSIONS = Object.freeze({
  '16:9': Object.freeze({ width: 1024, height: 576 }),
  '9:16': Object.freeze({ width: 576, height: 1024 }),
  '1:1': Object.freeze({ width: 768, height: 768 }),
})

const NATIVE_768_DIMENSIONS = Object.freeze({
  '16:9': Object.freeze({ width: 1344, height: 768 }),
  '9:16': Object.freeze({ width: 768, height: 1344 }),
  '1:1': Object.freeze({ width: 992, height: 992 }),
})

export const VIDEO_NATIVE_DIMENSIONS = Object.freeze({
  preview: PREVIEW_DIMENSIONS,
  standard: PREVIEW_DIMENSIONS,
  quality: QUALITY_DIMENSIONS,
  high: NATIVE_768_DIMENSIONS,
  native768: NATIVE_768_DIMENSIONS,
})

export const VIDEO_DELIVERY_DIMENSIONS_720P = Object.freeze({
  '16:9': Object.freeze({ width: 1280, height: 720 }),
  '9:16': Object.freeze({ width: 720, height: 1280 }),
  '1:1': Object.freeze({ width: 720, height: 720 }),
})

const COMMON_PRESET = Object.freeze({
  loraStrength: 1,
  preserveNative: true,
  minVramGb: 8,
  minSystemRamGb: 32,
})

export const VIDEO_PRESETS = Object.freeze({
  fast: Object.freeze({
    ...COMMON_PRESET,
    id: 'fast',
    label: '快速动作预览',
    qualityClass: 'preview',
    description: '608×352、4 步 Turbo；只用于验证提示词、动作和构图。',
    steps: 4,
    samplingMode: 'turbo',
    sampler: 'larry_turbo',
    lowVram: true,
    nativeScale: 'preview',
    delivery: 'native',
    allowedDurations: Object.freeze([5, 10, 15]),
    preferredModelProfiles: Object.freeze(['fp8Scaled4060', 'int8ConvrotCu130']),
    estimatedMinutes: Object.freeze({ 5: '3–5', 10: '7–11', 15: '12–18' }),
    validation: '当前 RTX 4060 Laptop 已完成 608×352、124 帧、4 步、原生音频真实生成。',
  }),
  balanced: Object.freeze({
    ...COMMON_PRESET,
    id: 'balanced',
    label: '高清 Turbo',
    qualityClass: 'quality',
    description: '1024×576、8 步 Turbo；源像素约为旧预览的 2.75 倍，优先用于高质量迭代。',
    steps: 8,
    samplingMode: 'turbo',
    sampler: 'larry_turbo',
    lowVram: true,
    nativeScale: 'quality',
    delivery: 'native',
    allowedDurations: Object.freeze([5, 10]),
    preferredModelProfiles: Object.freeze(['int8ConvrotCu130', 'fp8Scaled4060']),
    estimatedMinutes: Object.freeze({ 5: '11–16', 10: '20–28' }),
    validation: '社区同规格 1024×576、243 帧、4 步在同款 4060 约 10.8 分钟；8 步按质量优先预留更长时间。',
  }),
  delivery720: Object.freeze({
    ...COMMON_PRESET,
    id: 'delivery720',
    label: '兼容 720P（插值）',
    qualityClass: 'compatibility',
    description: '旧版 608×352、8 步 Turbo 后做 Lanczos；只保证文件尺寸，不宣称新增真实细节。',
    steps: 8,
    samplingMode: 'turbo',
    sampler: 'larry_turbo',
    lowVram: true,
    nativeScale: 'preview',
    delivery: '720p-lanczos',
    allowedDurations: Object.freeze([5, 10, 15]),
    preferredModelProfiles: Object.freeze(['fp8Scaled4060', 'int8ConvrotCu130']),
    estimatedMinutes: Object.freeze({ 5: '5–7', 10: '11–16', 15: '17–24' }),
    validation: '兼容既有项目与低耗时交付；UI 必须持续标注为插值而非原生 720P。',
  }),
  nativeHigh: Object.freeze({
    ...COMMON_PRESET,
    id: 'nativeHigh',
    label: '原生 768P Turbo',
    qualityClass: 'native-master',
    description: '1344×768、8 步 Turbo、5 秒；H3 官方 16:9 原生画布，直接增加生成信息量。',
    steps: 8,
    samplingMode: 'turbo',
    sampler: 'larry_turbo',
    lowVram: true,
    nativeScale: 'native768',
    delivery: 'native',
    allowedDurations: Object.freeze([5]),
    preferredModelProfiles: Object.freeze(['int8ConvrotCu130', 'fp8Scaled4060']),
    estimatedMinutes: Object.freeze({ 5: '17–24' }),
    validation: '本机RTX4060 Laptop 8GB、INT8/cu130已完成1344×768、124帧、8步与原生音频真实生成，约20分22秒；不开放10/15秒。',
  }),
  cinemaBase: Object.freeze({
    ...COMMON_PRESET,
    id: 'cinemaBase',
    label: 'Base 20 步精修',
    qualityClass: 'base-master',
    description: '1024×576、官方 res_multistep/simple、20 步；不挂 Turbo LoRA，优先声画与运动质量。',
    steps: 20,
    samplingMode: 'base',
    sampler: 'res_multistep',
    lowVram: false,
    loraStrength: 0,
    nativeScale: 'quality',
    delivery: 'native',
    allowedDurations: Object.freeze([5, 10]),
    preferredModelProfiles: Object.freeze(['int8ConvrotCu130', 'fp8Scaled4060']),
    estimatedMinutes: Object.freeze({ 5: '15–30', 10: '30–55' }),
    validation: '本机 124 帧 Base20：FP8/cu129 为 1309.04 秒，INT8/cu130 为 899.49 秒；同款 4060 的 243 帧社区实测为 2762.89 秒。',
  }),
  nativeBase: Object.freeze({
    ...COMMON_PRESET,
    id: 'nativeBase',
    label: '原生 768P Base20（实验）',
    qualityClass: 'base-master',
    description: '原生母片，Base20不挂Turbo；5/8/12秒实验档，长片段使用更强分块，耗时显著增加。',
    steps: 20,
    samplingMode: 'base',
    sampler: 'res_multistep',
    lowVram: true,
    loraStrength: 0,
    nativeScale: 'native768',
    delivery: 'native',
    allowedDurations: Object.freeze([5, 8, 12]),
    preferredModelProfiles: Object.freeze(['int8ConvrotCu130']),
    allowedModelProfiles: Object.freeze(['int8ConvrotCu130']),
    memoryOptimizations: Object.freeze({ headChunks: 8, feedForwardChunks: 4, tokenThreshold: 4096 }),
    memoryOptimizationsByDuration: Object.freeze({ 8: LONG_NATIVE_MEMORY, 12: LONG_NATIVE_MEMORY }),
    executionTimeoutMsByDuration: Object.freeze({ 8: 4 * 60 * 60 * 1000, 12: 8 * 60 * 60 * 1000 }),
    requiredNodes: Object.freeze(['MiniMaxLowVRAMAttention', 'MiniMaxChunkFeedForward']),
    estimatedMinutes: Object.freeze({ 5: '35–65', 8: '60–150', 12: '120–300' }),
    validation: '实验档：需要固定版本KJ低显存节点及INT8/cu130；真实画质和耗时以本机报告为准。',
  }),
  master720: Object.freeze({
    ...COMMON_PRESET,
    id: 'master720',
    label: '720P 时序精修母版',
    qualityClass: 'restored-master',
    description: '先以 1024×576、Base 20 步生成，再卸载 H3，用 SeedVR2 3B INT8 分块修复到真实 720P 文件。',
    steps: 20,
    samplingMode: 'base',
    sampler: 'res_multistep',
    lowVram: false,
    loraStrength: 0,
    nativeScale: 'quality',
    delivery: '720p-seedvr2',
    postprocessor: 'seedvr2_3b_int8',
    allowedDurations: Object.freeze([5, 10]),
    preferredModelProfiles: Object.freeze(['int8ConvrotCu130', 'fp8Scaled4060']),
    estimatedMinutes: Object.freeze({ 5: '20–40', 10: '38–75' }),
    validation: '本机 124 帧完整母版：FP8/cu129 约 28 分钟，INT8/cu130 约 20 分钟；SeedVR2 不可用时禁止静默退回 Lanczos。',
  }),
})

export const VIDEO_PRESET_IDS = Object.freeze(Object.keys(VIDEO_PRESETS))
export const VIDEO_PRESET_DISPLAY_ORDER = Object.freeze(['master720', 'cinemaBase', 'nativeBase', 'balanced', 'nativeHigh', 'fast', 'delivery720'])

export function videoExecutionTimeoutMs(presetId, duration) {
  return VIDEO_PRESETS[presetId]?.executionTimeoutMsByDuration?.[duration] ?? 2 * 60 * 60 * 1000
}

export function assertVideoPresetModelProfile(presetId, profileId) {
  const preset = VIDEO_PRESETS[presetId]
  if (preset?.allowedModelProfiles && !preset.allowedModelProfiles.includes(profileId)) {
    throw Object.assign(new Error(`${preset.label} only supports ${preset.allowedModelProfiles.join(', ')}`), { code: 'VIDEO_PRESET_MODEL_UNSUPPORTED' })
  }
}

function dimensionLabels(dimensions) {
  return Object.fromEntries(Object.entries(dimensions).map(([aspect, size]) => [aspect, `${size.width}×${size.height}`]))
}

export const VIDEO_PRESET_PRESENTATIONS = Object.freeze(Object.fromEntries(Object.values(VIDEO_PRESETS).map(preset => {
  const native = dimensionLabels(VIDEO_NATIVE_DIMENSIONS[preset.nativeScale])
  const delivery = preset.delivery.startsWith('720p-') ? dimensionLabels(VIDEO_DELIVERY_DIMENSIONS_720P) : native
  const nativeSummaryByAspect = Object.fromEntries(Object.keys(native).map(aspect => [aspect, `${native[aspect]} · ${preset.samplingMode === 'base' ? 'Base' : 'Turbo'} ${preset.steps} 步${preset.delivery === 'native' ? '' : ` → ${preset.postprocessor ? 'SeedVR2' : 'Lanczos'} ${delivery[aspect]}`}`]))
  const profile = preset.qualityClass === 'preview' ? 'preview' : preset.qualityClass === 'compatibility' ? 'compatibility' : preset.samplingMode === 'base' ? 'master' : 'quality'
  return [preset.id, Object.freeze({ id: preset.id, label: preset.label, native, delivery,
    nativeSummary: nativeSummaryByAspect['16:9'], nativeSummaryByAspect,
    detail: preset.description, pipeline: preset.description, minVram: `${preset.minVramGb} GB`,
    risk: preset.qualityClass === 'preview' ? '低' : preset.nativeScale === 'native768' || preset.postprocessor ? '高' : '中',
    allowedDurations: preset.allowedDurations, profile,
    estimate: Object.fromEntries(Object.entries(preset.estimatedMinutes).map(([seconds, value]) => [seconds, `${value} 分钟`])),
  })]
})))
