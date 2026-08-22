export const VIDEO_WORKFLOW_REGISTRY_VERSION = 'aeonquill-h3-registry-v2'

export const DEFAULT_VIDEO_MODEL_PROFILE = 'fp8Scaled4060'
export const AUTOMATIC_VIDEO_MODEL_PROFILE = 'auto'

const COMMON_MODEL_FILES = Object.freeze({
  clipName: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
  videoVaeName: 'minimax_h3_video_vae_fp16.safetensors',
  audioVaeName: 'minimax_h3_audio_vae_fp32.safetensors',
  loraName: 'minimax_h3_turbo_v4_step600_ema.safetensors',
})

export const VIDEO_MODEL_PROFILES = Object.freeze({
  fp8Scaled4060: Object.freeze({
    id: 'fp8Scaled4060',
    label: 'FP8 · RTX 4060 稳定路径',
    state: 'production',
    precision: 'DiT FP8 scaled + Qwen3-VL NVFP4/AWQ + VAE FP16/FP32',
    description: '当前 D 盘 ComfyUI 0.30.2 / cu129 运行时的稳定回退；可执行 Turbo 与 Base，两种结果都保留原生母片。',
    minVramGb: 8,
    minSystemRamGb: 32,
    unetName: 'minimax_h3_fl2va_pruned_fp8_scaled.safetensors',
    ...COMMON_MODEL_FILES,
    runtimeGate: Object.freeze({ minComfy: '0.30.0' }),
    runtime: Object.freeze({ comfy: '0.30.2', torch: '2.8.0+cu129', cuda: '12.9' }),
  }),
  int8ConvrotCu130: Object.freeze({
    id: 'int8ConvrotCu130',
    label: 'INT8 ConvRot · cu130 高质量路径',
    state: 'candidate',
    precision: 'DiT INT8 ConvRot + Qwen3-VL NVFP4/AWQ + VAE FP16/FP32',
    description: '官方 ComfyUI 首选量化路径；只有 ComfyUI 0.31+、PyTorch cu130+ 和模型均就绪时才自动启用。',
    minVramGb: 8,
    minSystemRamGb: 32,
    unetName: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors',
    ...COMMON_MODEL_FILES,
    runtimeGate: Object.freeze({ minComfy: '0.31.0', torchCudaFloor: 130 }),
    runtime: Object.freeze({ comfy: '0.31.0+', torch: 'cu130+', cuda: '13.0+' }),
  }),
})

export const VIDEO_MODEL_CANDIDATES = Object.freeze([
  Object.freeze({
    id: 'w4a8MixedExperimental',
    label: 'W4A8/INT4 混合量化 · 研究候选',
    state: 'research-only',
    precision: 'Asymmetric W4A8 / mixed INT4-INT8',
    requirements: ['ComfyUI 0.31.0+', '固定来源与 SHA-256', '画质/速度/显存对照样本'],
    reason: '文件更小，但社区内核和权重仍快速变化；在固定样本证明不损伤细节与时序前不进入自动路由。',
  }),
])

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

export const VIDEO_POSTPROCESSORS = Object.freeze({
  seedvr2_3b_int8: Object.freeze({
    id: 'seedvr2_3b_int8',
    label: 'SeedVR2 3B INT8 时序修复',
    state: 'candidate',
    description: 'H3 完成并释放模型后，对短片分块执行一次时序一致的生成式修复，再以原音频和帧率封装。',
    modelName: 'seedvr2_3b_int8_convrot.safetensors',
    vaeName: 'seedvr2_ema_vae_fp16.safetensors',
    minVramGb: 8,
    minSystemRamGb: 32,
    requiredNodes: Object.freeze([
      'LoadVideo', 'GetVideoComponents', 'ResizeImageMaskNode', 'SeedVR2Preprocess',
      'SeedVR2Conditioning', 'SeedVR2PostProcessing', 'SeedVR2TemporalChunk',
      'SeedVR2TemporalMerge', 'VAEEncodeTiled', 'VAEDecodeTiled', 'KSampler',
      'UNETLoader', 'VAELoader', 'CreateVideo', 'SaveVideo',
    ]),
  }),
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
    validation: '同款 4060 Laptop 的 1344×768、124 帧、4 步社区实测为 537.49 秒；10/15 秒在 8GB 上被禁止。',
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

function numericParts(value) {
  return String(value || '').match(/\d+/g)?.map(Number) || []
}

function versionAtLeast(actual, minimum) {
  const left = numericParts(actual)
  const right = numericParts(minimum)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] || 0) - (right[index] || 0)
    if (delta !== 0) return delta > 0
  }
  return true
}

function optionIncludes(objectInfo, nodeType, inputName, filename) {
  const definition = objectInfo?.[nodeType]?.input
  const options = definition?.required?.[inputName]?.[0] || definition?.optional?.[inputName]?.[0]
  return Array.isArray(options) && options.includes(filename)
}

function profileRequirements(profile, samplingMode = 'base') {
  const requiredNodes = [
    'UNETLoader', 'CLIPLoader', 'VAELoader', 'MiniMaxH3ImageToVideo', 'RandomNoise',
    'BasicGuider', 'BasicScheduler', 'SamplerCustomAdvanced', 'VAEDecode', 'VAEDecodeAudio',
    'CreateVideo', 'SaveVideo', 'LoadImage',
  ]
  const requiredModels = [
    ['UNETLoader', 'unet_name', profile.unetName],
    ['CLIPLoader', 'clip_name', profile.clipName],
    ['VAELoader', 'vae_name', profile.videoVaeName],
    ['VAELoader', 'vae_name', profile.audioVaeName],
  ]
  if (samplingMode === 'turbo') {
    requiredNodes.push('MiniMaxH3TurboLoRA', 'MiniMaxH3TurboSampler')
    requiredModels.push(['MiniMaxH3TurboLoRA', 'lora_name', profile.loraName])
  } else {
    requiredNodes.push('KSamplerSelect')
  }
  return { requiredNodes, requiredModels }
}

export function inspectVideoCapabilities(objectInfo = {}, runtime = {}) {
  const modelProfiles = Object.values(VIDEO_MODEL_PROFILES).map((profile) => {
    const modes = {}
    for (const samplingMode of ['base', 'turbo']) {
      const requirements = profileRequirements(profile, samplingMode)
      const missingNodes = requirements.requiredNodes.filter((node) => !objectInfo[node])
      const missingModels = requirements.requiredModels
        .filter(([nodeType, inputName, filename]) => !optionIncludes(objectInfo, nodeType, inputName, filename))
        .map(([, , filename]) => filename)
      const runtimeIssues = []
      if (profile.runtimeGate?.minComfy && !versionAtLeast(runtime.comfyVersion, profile.runtimeGate.minComfy)) {
        runtimeIssues.push(`需要 ComfyUI ${profile.runtimeGate.minComfy}+`)
      }
      const torchCuda = /\+cu(\d+)/i.exec(runtime.pytorchVersion || '')?.[1]
      if (profile.runtimeGate?.torchCudaFloor && (!torchCuda || Number(torchCuda) < profile.runtimeGate.torchCudaFloor)) {
        runtimeIssues.push(`需要 PyTorch cu${profile.runtimeGate.torchCudaFloor}+`)
      }
      modes[samplingMode] = {
        available: missingNodes.length === 0 && missingModels.length === 0 && runtimeIssues.length === 0,
        missingNodes,
        missingModels,
        runtimeIssues,
      }
    }
    return { id: profile.id, label: profile.label, state: profile.state, modes }
  })

  const postprocessors = Object.values(VIDEO_POSTPROCESSORS).map((postprocessor) => {
    const missingNodes = postprocessor.requiredNodes.filter((node) => !objectInfo[node])
    const missingModels = [
      ['UNETLoader', 'unet_name', postprocessor.modelName],
      ['VAELoader', 'vae_name', postprocessor.vaeName],
    ].filter(([nodeType, inputName, filename]) => !optionIncludes(objectInfo, nodeType, inputName, filename))
      .map(([, , filename]) => filename)
    return {
      id: postprocessor.id,
      label: postprocessor.label,
      state: postprocessor.state,
      available: missingNodes.length === 0 && missingModels.length === 0,
      missingNodes,
      missingModels,
    }
  })

  const profilesById = new Map(modelProfiles.map((profile) => [profile.id, profile]))
  const postprocessorsById = new Map(postprocessors.map((postprocessor) => [postprocessor.id, postprocessor]))
  const presets = Object.values(VIDEO_PRESETS).map((preset) => {
    const availableProfiles = preset.preferredModelProfiles.filter((id) => profilesById.get(id)?.modes[preset.samplingMode]?.available)
    const postprocessor = preset.postprocessor ? postprocessorsById.get(preset.postprocessor) : null
    return {
      id: preset.id,
      available: availableProfiles.length > 0 && (!postprocessor || postprocessor.available),
      availableProfiles,
      postprocessor: postprocessor ? {
        id: postprocessor.id,
        available: postprocessor.available,
        missingNodes: postprocessor.missingNodes,
        missingModels: postprocessor.missingModels,
      } : null,
    }
  })
  return { modelProfiles, postprocessors, presets }
}

export function resolveVideoModelProfile(presetId, capabilities, requested = AUTOMATIC_VIDEO_MODEL_PROFILE) {
  const preset = VIDEO_PRESETS[presetId]
  if (!preset) throw Object.assign(new Error(`Unsupported quality preset: ${presetId}`), { code: 'VIDEO_PRESET_NOT_ALLOWED' })
  const presetCapability = capabilities?.presets?.find((candidate) => candidate.id === presetId)
  const candidates = requested === AUTOMATIC_VIDEO_MODEL_PROFILE ? preset.preferredModelProfiles : [requested]
  const profileId = candidates.find((candidate) => presetCapability?.availableProfiles?.includes(candidate))
  if (!profileId) {
    throw Object.assign(new Error(`No compatible ${preset.samplingMode} model profile is available for ${preset.label}`), {
      code: 'VIDEO_MODEL_PROFILE_UNAVAILABLE',
      details: { requested, preset: presetId },
    })
  }
  return profileId
}

export function videoModelProfile(profileId = DEFAULT_VIDEO_MODEL_PROFILE) {
  const profile = VIDEO_MODEL_PROFILES[profileId]
  if (!profile) throw Object.assign(new Error(`Unsupported video model profile: ${profileId}`), { code: 'VIDEO_MODEL_PROFILE_NOT_ALLOWED' })
  return profile
}

export function videoWorkflowRegistryCatalog(capabilities) {
  return {
    version: VIDEO_WORKFLOW_REGISTRY_VERSION,
    defaultModelProfile: DEFAULT_VIDEO_MODEL_PROFILE,
    automaticModelProfile: AUTOMATIC_VIDEO_MODEL_PROFILE,
    modelProfiles: Object.values(VIDEO_MODEL_PROFILES),
    modelCandidates: VIDEO_MODEL_CANDIDATES,
    postprocessors: Object.values(VIDEO_POSTPROCESSORS),
    presets: Object.values(VIDEO_PRESETS),
    ...(capabilities ? { capabilities } : {}),
  }
}

export const DEFAULT_RUNTIME_REQUIREMENTS = Object.freeze(profileRequirements(
  VIDEO_MODEL_PROFILES[DEFAULT_VIDEO_MODEL_PROFILE],
  'turbo',
))
