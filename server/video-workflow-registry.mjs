export const VIDEO_WORKFLOW_REGISTRY_VERSION = 'aeonquill-h3-registry-v1'

export const DEFAULT_VIDEO_MODEL_PROFILE = 'fp8Scaled4060'

export const VIDEO_MODEL_PROFILES = Object.freeze({
  fp8Scaled4060: Object.freeze({
    id: 'fp8Scaled4060',
    label: 'FP8 · RTX 4060 稳定路径',
    state: 'production',
    precision: 'DiT FP8 scaled + Qwen3-VL NVFP4/AWQ + VAE FP16/FP32',
    description: '与当前 ComfyUI 0.30.2、PyTorch 2.8.0+cu129 离线运行时一致，作为 8GB Ada 显卡的默认生产路径。',
    minVramGb: 8,
    minSystemRamGb: 32,
    unetName: 'minimax_h3_fl2va_pruned_fp8_scaled.safetensors',
    clipName: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
    videoVaeName: 'minimax_h3_video_vae_fp16.safetensors',
    audioVaeName: 'minimax_h3_audio_vae_fp32.safetensors',
    loraName: 'minimax_h3_turbo_v4_step600_ema.safetensors',
    runtime: Object.freeze({ comfy: '0.30.2', torch: '2.8.0+cu129', cuda: '12.9' }),
  }),
})

export const VIDEO_MODEL_CANDIDATES = Object.freeze([
  Object.freeze({
    id: 'int8ConvrotCu130',
    label: 'INT8 ConvRot · cu130 迁移候选',
    state: 'runtime-upgrade-required',
    precision: 'DiT INT8 ConvRot + Qwen3-VL NVFP4/AWQ',
    modelName: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors',
    requirements: ['ComfyUI 0.31.0+', 'PyTorch/CUDA cu130', '重新执行完整运行时与 4060 回归'],
    reason: '官方 ComfyUI 模型卡优先推荐 INT8 ConvRot，但当前锁定的 cu129 运行时不满足加载前提，因此不能静默替换。',
  }),
  Object.freeze({
    id: 'w4a8MixedExperimental',
    label: 'W4A8/INT4 混合量化 · 研究候选',
    state: 'research-only',
    precision: 'Asymmetric W4A8 / mixed INT4-INT8',
    requirements: ['ComfyUI 0.31.0+', '新量化内核', '固定来源与 SHA-256', '画质/速度/显存对照样本'],
    reason: '文件更小，但社区版本仍在快速变化，当前没有足够本机质量证据，暂不进入默认软件运行时。',
  }),
])

const STANDARD_DIMENSIONS = Object.freeze({
  '16:9': Object.freeze({ width: 608, height: 352 }),
  '9:16': Object.freeze({ width: 352, height: 608 }),
  '1:1': Object.freeze({ width: 448, height: 448 }),
})

const HIGH_DIMENSIONS = Object.freeze({
  '16:9': Object.freeze({ width: 736, height: 416 }),
  '9:16': Object.freeze({ width: 416, height: 736 }),
  '1:1': Object.freeze({ width: 544, height: 544 }),
})

export const VIDEO_NATIVE_DIMENSIONS = Object.freeze({
  standard: STANDARD_DIMENSIONS,
  high: HIGH_DIMENSIONS,
})

export const VIDEO_DELIVERY_DIMENSIONS_720P = Object.freeze({
  '16:9': Object.freeze({ width: 1280, height: 720 }),
  '9:16': Object.freeze({ width: 720, height: 1280 }),
  '1:1': Object.freeze({ width: 720, height: 720 }),
})

export const VIDEO_PRESETS = Object.freeze({
  fast: Object.freeze({
    id: 'fast',
    label: '8GB 快速预览',
    description: '4 步 Turbo 与低显存合并，作为 OOM 后的确定降档和动作草稿。',
    steps: 4,
    lowVram: true,
    loraStrength: 1,
    nativeScale: 'standard',
    delivery: 'native',
    preserveNative: true,
    minVramGb: 8,
    validation: 'RTX 4060 Laptop 8GB 已完成 608×352、124 帧、4 步、原生音频真实生成。',
  }),
  balanced: Object.freeze({
    id: 'balanced',
    label: '8GB 均衡质量',
    description: '6 步 Turbo 与低显存合并，改善 4 步在快速动作和音频上的拖影。',
    steps: 6,
    lowVram: true,
    loraStrength: 1,
    nativeScale: 'standard',
    delivery: 'native',
    preserveNative: true,
    minVramGb: 8,
    validation: '6 步位于 Turbo v4 推荐的 4–8 步有效区间；保持 simple scheduler 与 strength 1.0。',
  }),
  delivery720: Object.freeze({
    id: 'delivery720',
    label: '8GB · 720P 成片',
    description: '8 步低显存生成，保留原生中间片，再由 FFmpeg Lanczos 形成可交付 720P。',
    steps: 8,
    lowVram: true,
    loraStrength: 1,
    nativeScale: 'standard',
    delivery: '720p-lanczos',
    preserveNative: true,
    minVramGb: 8,
    validation: '8 步是 Turbo v4 建议的质量上限；720P 后处理不增加 H3 采样峰值显存。',
  }),
  nativeHigh: Object.freeze({
    id: 'nativeHigh',
    label: '原生高清实验',
    description: '8 步与更高 H3 原生分辨率，保留为 12GB+ 实验路径，不允许 8GB 误提交。',
    steps: 8,
    lowVram: true,
    loraStrength: 1,
    nativeScale: 'high',
    delivery: 'native',
    preserveNative: true,
    minVramGb: 12,
    validation: '仅完成受控契约和显存门槛；RTX 4060 8GB 不执行此档。',
  }),
})

export function videoModelProfile(profileId = DEFAULT_VIDEO_MODEL_PROFILE) {
  const profile = VIDEO_MODEL_PROFILES[profileId]
  if (!profile) throw Object.assign(new Error(`Unsupported video model profile: ${profileId}`), { code: 'VIDEO_MODEL_PROFILE_NOT_ALLOWED' })
  return profile
}

export function videoWorkflowRegistryCatalog() {
  return {
    version: VIDEO_WORKFLOW_REGISTRY_VERSION,
    defaultModelProfile: DEFAULT_VIDEO_MODEL_PROFILE,
    modelProfiles: Object.values(VIDEO_MODEL_PROFILES),
    modelCandidates: VIDEO_MODEL_CANDIDATES,
    presets: Object.values(VIDEO_PRESETS),
  }
}
