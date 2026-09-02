import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  mkdir,
  open as openFile,
  readFile,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises'
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import {
  discoverRuntimeRegistry,
  registeredArtifactCandidates,
} from './runtime-registry.mjs'

export const WORKFLOW_CENTER_VERSION = 'aeonquill-workflow-center-v2'
export const WORKFLOW_CENTER_STATE_VERSION = 1
export const MAX_CUSTOM_WORKFLOW_BYTES = 2 * 1024 * 1024
export const MAX_CUSTOM_WORKFLOW_NODES = 240

const GIB = 1024 ** 3
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/u
const SAFE_NODE_ID = /^[A-Za-z0-9_.:-]{1,128}$/u
const MODEL_EXTENSION = /\.(?:safetensors|ckpt|pt|pth|bin|onnx|gguf)$/iu
const URL_VALUE = /^(?:https?|ftp|file|data):\/\//iu
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/u
const UNC_PATH = /^(?:\\\\|\/\/)/u
const TRAVERSAL_SEGMENT = /(?:^|[\\/])\.\.(?:[\\/]|$)/u
const SECRET_INPUT = /(?:api[_-]?key|access[_-]?token|secret|password|authorization|bearer)/iu
const NETWORK_NODE = /(?:http|websocket|webhook|download|upload|remote|url|api[_ -]?request|ftp|s3|cloud)/iu
const EXECUTION_NODE = /(?:python|script|shell|command|powershell|terminal|exec|eval|subprocess)/iu

const H3_LICENSE = Object.freeze({
  id: 'minimax-h3-community-license-2026-08',
  name: 'MiniMax-H3 Community License Agreement',
  spdx: null,
  acceptanceRequired: true,
  commercialUse: 'conditional',
  redistribution: 'not-bundled-by-aeonquill',
  sourceUrl: 'https://huggingface.co/Comfy-Org/MiniMax-H3',
  notice: '适用地区、署名和商业条款必须由使用者自行确认；AEONQUILL 轻量包不重分发 H3 权重。',
})

const APACHE_2 = Object.freeze({
  id: 'apache-2.0',
  name: 'Apache License 2.0',
  spdx: 'Apache-2.0',
  acceptanceRequired: false,
  commercialUse: 'permitted-with-notice',
  redistribution: 'permitted-with-license-and-notice',
  sourceUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
  notice: '保留许可证与 NOTICE，并分别核对模型上游条款。',
})

const ARTIFACTS = Object.freeze({
  h3Fp8: Object.freeze({
    id: 'h3-fl2va-fp8',
    kind: 'model',
    label: 'MiniMax H3 FL2VA FP8 scaled',
    relativePath: 'models/diffusion_models/minimax_h3_fl2va_pruned_fp8_scaled.safetensors',
    bytes: 20_958_205_608,
    sha256: '12944c1f7791637e7de12208aef04da82bd26b95271b1b47d817364315ade993',
    downloadUrl: 'https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_fl2va_pruned_fp8_scaled.safetensors',
    sourceUrl: 'https://huggingface.co/Comfy-Org/MiniMax-H3',
    licenseId: H3_LICENSE.id,
  }),
  h3Int8: Object.freeze({
    id: 'h3-fl2va-int8-convrot',
    kind: 'model',
    label: 'MiniMax H3 FL2VA INT8 ConvRot',
    relativePath: 'models/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors',
    bytes: 20_970_379_616,
    sha256: 'e889202c41dafb67b10d67b97f0d8541508036a6090af23425a5c2615d03c47a',
    downloadUrl: 'https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors',
    sourceUrl: 'https://huggingface.co/Comfy-Org/MiniMax-H3',
    licenseId: H3_LICENSE.id,
  }),
  h3TextEncoder: Object.freeze({
    id: 'h3-qwen3vl-nvfp4',
    kind: 'model',
    label: 'Qwen3-VL 32B MiniMax H3 NVFP4/AWQ',
    relativePath: 'models/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
    bytes: 15_687_142_551,
    sha256: '35a88d51044231fe332301d7a62aa81e3f2cba62febeb446e2c1e3e0ef76f2c6',
    downloadUrl: 'https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
    sourceUrl: 'https://huggingface.co/Comfy-Org/MiniMax-H3',
    licenseId: H3_LICENSE.id,
  }),
  h3VideoVae: Object.freeze({
    id: 'h3-video-vae',
    kind: 'model',
    label: 'MiniMax H3 Video VAE FP16',
    relativePath: 'models/vae/minimax_h3_video_vae_fp16.safetensors',
    bytes: 5_207_808_496,
    sha256: '7c1f131492e7eddacaac9069a61b81bdd39de5cc96561e677c5eab1cdce5e522',
    downloadUrl: 'https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_fp16.safetensors',
    sourceUrl: 'https://huggingface.co/Comfy-Org/MiniMax-H3',
    licenseId: H3_LICENSE.id,
  }),
  h3AudioVae: Object.freeze({
    id: 'h3-audio-vae',
    kind: 'model',
    label: 'MiniMax H3 Audio VAE FP32',
    relativePath: 'models/vae/minimax_h3_audio_vae_fp32.safetensors',
    bytes: 605_254_808,
    sha256: '8e505d95dd1561d47abd43d4238fd40d9bb1ae9e147ed0a4cba778d76ae4db48',
    downloadUrl: 'https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors',
    sourceUrl: 'https://huggingface.co/Comfy-Org/MiniMax-H3',
    licenseId: H3_LICENSE.id,
  }),
  h3TurboLora: Object.freeze({
    id: 'h3-turbo-lora-v4',
    kind: 'model',
    label: 'MiniMax H3 Turbo v4 LoRA',
    relativePath: 'models/loras/minimax_h3_turbo_v4_step600_ema.safetensors',
    bytes: 779_849_816,
    sha256: '5f3a626cd72c93a8b9318d6760c510bc5092d2ab13aaba1f932c5bab07a416d3',
    downloadUrl: 'https://huggingface.co/larryvrh/MiniMax-H3-Turbo-Lora/resolve/main/minimax_h3_turbo_v4_step600_ema.safetensors',
    sourceUrl: 'https://huggingface.co/larryvrh/MiniMax-H3-Turbo-Lora',
    licenseId: APACHE_2.id,
  }),
  seedVr2Model: Object.freeze({
    id: 'seedvr2-3b-int8-convrot',
    kind: 'model',
    label: 'SeedVR2 3B INT8 ConvRot',
    relativePath: 'models/diffusion_models/seedvr2_3b_int8_convrot.safetensors',
    bytes: 3_458_259_704,
    sha256: 'c3dec8bcc5916843a8a858572970597462e1f2dc598d6dfd818f6cd40f53a157',
    downloadUrl: 'https://huggingface.co/Comfy-Org/SeedVR2/resolve/main/diffusion_models/seedvr2_3b_int8_convrot.safetensors',
    sourceUrl: 'https://huggingface.co/Comfy-Org/SeedVR2',
    licenseId: APACHE_2.id,
  }),
  seedVr2Vae: Object.freeze({
    id: 'seedvr2-vae-fp16',
    kind: 'model',
    label: 'SeedVR2 EMA VAE FP16',
    relativePath: 'models/vae/seedvr2_ema_vae_fp16.safetensors',
    bytes: 501_324_814,
    sha256: '20678548f420d98d26f11442d3528f8b8c94e57ee046ef93dbb7633da8612ca1',
    downloadUrl: 'https://huggingface.co/Comfy-Org/SeedVR2/resolve/main/vae/seedvr2_ema_vae_fp16.safetensors',
    sourceUrl: 'https://huggingface.co/Comfy-Org/SeedVR2',
    licenseId: APACHE_2.id,
  }),
  samVitB: Object.freeze({
    id: 'sam-vit-b',
    kind: 'model',
    label: 'Segment Anything ViT-B',
    relativePath: 'models/sams/sam_vit_b_01ec64.pth',
    bytes: 375_042_383,
    sha256: 'ec2df62732614e57411cdcf32a23ffdf28910380d03139ee0f4fcbe91eb8c912',
    downloadUrl: 'https://dl.fbaipublicfiles.com/segment_anything/sam_vit_b_01ec64.pth',
    sourceUrl: 'https://github.com/facebookresearch/segment-anything',
    licenseId: APACHE_2.id,
  }),
  impactPack: Object.freeze({
    id: 'impact-pack',
    kind: 'manual-extension',
    label: 'ComfyUI Impact Pack',
    presentCandidates: ['custom_nodes/ComfyUI-Impact-Pack', 'custom_nodes/comfyui-impact-pack'],
    sourceUrl: 'https://github.com/ltdrdata/ComfyUI-Impact-Pack',
    licenseId: 'gpl-3.0-only',
    instruction: '通过 ComfyUI Manager 安装 Impact Pack，重启 ComfyUI 后复检。',
  }),
  fluxKontext: Object.freeze({
    id: 'flux-kontext-guided',
    kind: 'manual-model-set',
    label: 'Flux Kontext 受控区域编辑模型组',
    presentCandidates: [
      'models/diffusion_models/flux1-dev-kontext_fp8_scaled.safetensors',
      'models/unet/flux1-kontext-dev-Q4_K_M.gguf',
    ],
    sourceUrl: 'https://huggingface.co/Comfy-Org/flux1-kontext-dev_ComfyUI',
    licenseId: 'flux-kontext-upstream',
    instruction: '根据上游许可选择 FP8 或 GGUF 权重，并按来源页补齐文本编码器与 VAE；工作流中心不会猜测或重分发这些文件。',
  }),
})

const H3_COMMON = Object.freeze([
  ARTIFACTS.h3TextEncoder,
  ARTIFACTS.h3VideoVae,
  ARTIFACTS.h3AudioVae,
])

const H3_NODES = Object.freeze([
  'UNETLoader', 'CLIPLoader', 'VAELoader', 'MiniMaxH3ImageToVideo', 'RandomNoise',
  'BasicGuider', 'BasicScheduler', 'SamplerCustomAdvanced', 'VAEDecode', 'VAEDecodeAudio',
  'CreateVideo', 'SaveVideo', 'LoadImage',
])

const PACKS = Object.freeze([
  Object.freeze({
    id: 'h3-fast-fp8',
    version: '1.0.0',
    category: 'video',
    title: 'H3 极速 / 高清 Turbo · FP8',
    summary: '面向 RTX 4060 8GB 的稳定路径，覆盖预览、高清 Turbo、文生与首尾帧图生。',
    capabilities: ['t2v', 'i2v', 'first-last-frame', 'native-audio', 'turbo'],
    maturity: 'production',
    minVramGb: 8,
    recommendedVramGb: 8,
    minSystemRamGb: 32,
    estimatedMinutes: '5 秒约 3–16 分钟，取决于分辨率与步数',
    runtime: { minComfy: '0.30.0', python: '3.12', cuda: '12.9+' },
    license: H3_LICENSE,
    artifacts: [...H3_COMMON, ARTIFACTS.h3Fp8, ARTIFACTS.h3TurboLora],
    requiredNodes: [...H3_NODES, 'MiniMaxH3TurboLoRA', 'MiniMaxH3TurboSampler'],
    sourceUrl: 'https://huggingface.co/Comfy-Org/MiniMax-H3',
  }),
  Object.freeze({
    id: 'h3-quality-int8',
    version: '1.0.0',
    category: 'video',
    title: 'H3 质量母版 · INT8 ConvRot',
    summary: '优先 Base 20 步与高分辨率母片；4060 可运行但应接受约 15–55 分钟的单镜头时间。',
    capabilities: ['t2v', 'i2v', 'first-last-frame', 'native-audio', 'base-quality'],
    maturity: 'production',
    minVramGb: 8,
    recommendedVramGb: 8,
    minSystemRamGb: 32,
    estimatedMinutes: '5 秒约 15–30 分钟；10 秒约 30–55 分钟',
    runtime: { minComfy: '0.31.0', python: '3.12', torchCudaFloor: 130, cuda: '13.0+' },
    license: H3_LICENSE,
    artifacts: [...H3_COMMON, ARTIFACTS.h3Int8],
    requiredNodes: [...H3_NODES, 'KSamplerSelect'],
    sourceUrl: 'https://huggingface.co/Comfy-Org/MiniMax-H3',
  }),
  Object.freeze({
    id: 'seedvr2-master720',
    version: '1.0.0',
    category: 'video-postprocess',
    title: 'SeedVR2 720P 时序精修',
    summary: 'H3 原生母片完成并释放显存后，以 3B INT8 分块恢复到 720P。',
    capabilities: ['video-restoration', '720p', 'temporal-consistency'],
    maturity: 'candidate',
    minVramGb: 8,
    recommendedVramGb: 12,
    minSystemRamGb: 32,
    estimatedMinutes: '5 秒约 5–12 分钟；与 H3 Base 串行执行',
    runtime: { minComfy: '0.31.0', python: '3.12', torchCudaFloor: 130, cuda: '13.0+' },
    license: APACHE_2,
    artifacts: [ARTIFACTS.seedVr2Model, ARTIFACTS.seedVr2Vae],
    requiredNodes: [
      'LoadVideo', 'GetVideoComponents', 'ResizeImageMaskNode', 'SeedVR2Preprocess',
      'SeedVR2Conditioning', 'SeedVR2PostProcessing', 'SeedVR2TemporalChunk',
      'SeedVR2TemporalMerge', 'VAEEncodeTiled', 'VAEDecodeTiled', 'KSampler',
      'UNETLoader', 'VAELoader', 'CreateVideo', 'SaveVideo',
    ],
    sourceUrl: 'https://huggingface.co/Comfy-Org/SeedVR2',
  }),
  Object.freeze({
    id: 'sam-element-extract',
    version: '1.0.0',
    category: 'image',
    title: 'SAM 元素提取',
    summary: '正负点击选取主体，输出透明元素与灰度蒙版；适合均衡模式的语义局部编辑。',
    capabilities: ['semantic-selection', 'transparent-cutout', 'alpha-mask'],
    maturity: 'preview',
    minVramGb: 4,
    recommendedVramGb: 6,
    minSystemRamGb: 16,
    estimatedMinutes: '通常数秒到 3 分钟，首次冷启动更久',
    runtime: { minComfy: '0.30.0', python: '3.10+' },
    license: APACHE_2,
    artifacts: [ARTIFACTS.samVitB, ARTIFACTS.impactPack],
    requiredNodes: ['SAMLoader'],
    sourceUrl: 'https://github.com/facebookresearch/segment-anything',
  }),
  Object.freeze({
    id: 'flux-kontext-region-edit',
    version: '0.1.0',
    category: 'image',
    title: 'Flux Kontext 区域语义编辑',
    summary: '受控蒙版、参考图与文本条件的局部改写；当前仅提供依赖探测和安装引导。',
    capabilities: ['region-edit', 'reference-image', 'inpaint'],
    maturity: 'experimental',
    minVramGb: 8,
    recommendedVramGb: 12,
    minSystemRamGb: 32,
    estimatedMinutes: '依量化、尺寸和采样步数而异',
    runtime: { minComfy: '0.30.0', python: '3.10+' },
    license: Object.freeze({
      id: 'flux-kontext-upstream',
      name: 'Flux Kontext upstream terms',
      spdx: null,
      acceptanceRequired: true,
      commercialUse: 'verify-upstream-variant',
      redistribution: 'guided-only',
      sourceUrl: 'https://huggingface.co/Comfy-Org/flux1-kontext-dev_ComfyUI',
      notice: '不同权重与量化来源可能使用不同条款；选择具体来源后再确认商业用途。',
    }),
    artifacts: [ARTIFACTS.fluxKontext],
    requiredNodes: [
      'LoadImage', 'UNETLoader', 'DualCLIPLoader', 'VAELoader', 'CLIPTextEncode',
      'FluxKontextImageScale', 'ReferenceLatent', 'SamplerCustomAdvanced', 'VAEDecode', 'SaveImage',
    ],
    sourceUrl: 'https://huggingface.co/Comfy-Org/flux1-kontext-dev_ComfyUI',
  }),
])

export const DEFAULT_SAFE_COMFY_NODE_TYPES = Object.freeze(new Set([
  ...H3_NODES,
  'MiniMaxH3TurboLoRA', 'MiniMaxH3TurboSampler', 'KSamplerSelect', 'KSampler',
  'CLIPTextEncode', 'EmptyLatentImage', 'CheckpointLoaderSimple', 'LoraLoader',
  'LoadImage', 'SaveImage', 'PreviewImage', 'ImageScale', 'ImageScaleBy',
  'VAEEncode', 'VAEEncodeTiled', 'VAEDecodeTiled', 'RepeatLatentBatch',
  'ConditioningCombine', 'ConditioningConcat', 'ConditioningSetTimestepRange',
  'CreateVideo', 'SaveVideo',
]))

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function workflowError(message, code, status = 400, details) {
  return Object.assign(new Error(message), { code, status, ...(details ? { details } : {}) })
}

function assertSafeRelativePath(value, label = 'relativePath') {
  if (typeof value !== 'string' || !value || value.includes('\0') || isAbsolute(value) || WINDOWS_ABSOLUTE.test(value) || UNC_PATH.test(value) || TRAVERSAL_SEGMENT.test(value)) {
    throw workflowError(`${label} 必须是受控相对路径`, 'WORKFLOW_UNSAFE_PATH')
  }
  const normalized = value.replace(/\\/gu, '/')
  if (!normalized.startsWith('models/') || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw workflowError(`${label} 只能写入 ComfyUI/models`, 'WORKFLOW_UNSAFE_PATH')
  }
  return normalized
}

function resolveInside(root, relativePath) {
  const safe = assertSafeRelativePath(relativePath)
  const target = resolve(root, ...safe.split('/'))
  const resolvedRoot = resolve(root)
  if (!target.startsWith(`${resolvedRoot}${sep}`)) throw workflowError('工作流文件目标逃逸运行时目录', 'WORKFLOW_UNSAFE_PATH')
  return target
}

function numericParts(value) {
  return String(value || '').match(/\d+/gu)?.map(Number) || []
}

function versionAtLeast(actual, minimum) {
  const left = numericParts(actual)
  const right = numericParts(minimum)
  if (!left.length) return false
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] || 0) - (right[index] || 0)
    if (delta !== 0) return delta > 0
  }
  return true
}

async function pathStats(pathname) {
  try {
    return await stat(pathname)
  } catch {
    return null
  }
}

async function sha256File(pathname) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(pathname)) hash.update(chunk)
  return hash.digest('hex')
}

function stateTemplate() {
  return {
    schemaVersion: WORKFLOW_CENTER_STATE_VERSION,
    enabledPackIds: [],
    acceptedLicenses: {},
    verifiedArtifacts: {},
    customWorkflows: [],
    jobs: [],
  }
}

function normalizeState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== WORKFLOW_CENTER_STATE_VERSION) return stateTemplate()
  return {
    ...stateTemplate(),
    enabledPackIds: Array.isArray(value.enabledPackIds) ? value.enabledPackIds.filter((id) => typeof id === 'string' && SAFE_ID.test(id)) : [],
    acceptedLicenses: value.acceptedLicenses && typeof value.acceptedLicenses === 'object' && !Array.isArray(value.acceptedLicenses)
      ? value.acceptedLicenses
      : {},
    verifiedArtifacts: value.verifiedArtifacts && typeof value.verifiedArtifacts === 'object' && !Array.isArray(value.verifiedArtifacts)
      ? value.verifiedArtifacts
      : {},
    customWorkflows: Array.isArray(value.customWorkflows) ? value.customWorkflows : [],
    jobs: Array.isArray(value.jobs) ? value.jobs.slice(-30).map((job) => (
      job?.status === 'running' || job?.status === 'queued'
        ? { ...job, status: 'failed', error: { code: 'BRIDGE_RESTARTED', message: '应用重启中断了安装；已保留可续传分片。' }, updatedAt: Date.now() }
        : job
    )) : [],
  }
}

function artifactDownloadBytes(pack) {
  return pack.artifacts.reduce((total, artifact) => total + (artifact.downloadUrl ? Number(artifact.bytes || 0) : 0), 0)
}

function pendingDownloadBytes(artifacts) {
  return artifacts.reduce((total, artifact) => total + (!artifact.present && artifact.automatic ? Number(artifact.bytes || 0) : 0), 0)
}

function artifactVerificationKey(artifact, targetPath) {
  const normalized = process.platform === 'win32'
    ? resolve(targetPath).toLocaleLowerCase('en-US')
    : resolve(targetPath)
  const locationHash = createHash('sha256').update(normalized).digest('hex').slice(0, 24)
  return `${artifact.id}:${locationHash}`
}

function registryCategories(packs) {
  const categories = new Set(['custom_nodes'])
  for (const pack of packs) {
    for (const artifact of pack.artifacts) {
      const segments = artifact.relativePath?.replace(/\\/gu, '/').split('/').filter(Boolean)
      if (segments?.[0] === 'models' && segments[1]) categories.add(segments[1])
    }
  }
  return [...categories]
}

function requiredLicenseIds(pack) {
  const ids = new Set()
  if (pack.license?.acceptanceRequired) ids.add(pack.license.id)
  for (const artifact of pack.artifacts) {
    if (artifact.licenseId === H3_LICENSE.id) ids.add(H3_LICENSE.id)
  }
  return [...ids]
}

function publicArtifact(artifact, inspection) {
  const { location, ...publicInspection } = inspection
  return {
    id: artifact.id,
    kind: artifact.kind,
    label: artifact.label,
    bytes: artifact.bytes || null,
    relativePath: artifact.relativePath || null,
    sourceUrl: artifact.sourceUrl,
    licenseId: artifact.licenseId,
    expectedSha256: artifact.sha256 || null,
    automatic: Boolean(artifact.downloadUrl),
    instruction: artifact.instruction,
    ...publicInspection,
    location: location
      ? {
          rootId: location.rootId,
          rootLabel: location.rootLabel,
          source: location.source,
          category: location.category,
          shared: location.shared,
          portable: location.portable,
          referenceCount: location.references.length,
        }
      : null,
  }
}

function publicRegistry(registry) {
  const publicRoot = ({ path: _path, references: _references, ...root }) => root
  const publicWarning = ({ path: _path, configPath: _configPath, ...warning }) => warning
  return {
    version: registry.version,
    registryHash: registry.registryHash,
    configured: registry.configured,
    runtimePackageId: registry.runtimePackageId,
    python: registry.python ? { exists: registry.python.exists } : null,
    configFiles: registry.configFiles.map(({ path: _path, ...config }) => config),
    modelRoots: registry.modelRoots.map(publicRoot),
    nodeRoots: registry.nodeRoots.map(publicRoot),
    sharedRoots: registry.sharedRoots.map(publicRoot),
    warnings: registry.warnings.map(publicWarning),
  }
}

function hardwareRecommendation(pack, vramGb) {
  if (!vramGb) return { level: 'unknown', label: '检测显卡后给出推荐' }
  if (vramGb + 0.0625 < pack.minVramGb) return { level: 'blocked', label: `至少需要 ${pack.minVramGb}GB 显存` }
  if (vramGb + 0.0625 < pack.recommendedVramGb) return { level: 'caution', label: '可尝试，建议降低并行与分块' }
  if (pack.id === 'h3-quality-int8' && vramGb <= 8.1) return { level: 'recommended', label: '4060 质量优先推荐 · 耗时较长' }
  if (pack.id === 'h3-fast-fp8' && vramGb <= 8.1) return { level: 'recommended', label: '4060 稳定与快速推荐' }
  return { level: 'compatible', label: '硬件条件兼容' }
}

function inspectRuntimeGate(pack, runtime = {}) {
  const issues = []
  if (runtime.connected && pack.runtime?.minComfy && !versionAtLeast(runtime.comfyVersion, pack.runtime.minComfy)) {
    issues.push(`需要 ComfyUI ${pack.runtime.minComfy}+，当前为 ${runtime.comfyVersion || '未知'}`)
  }
  const torchCuda = /\+cu(\d+)/iu.exec(runtime.pytorchVersion || '')?.[1]
  if (runtime.connected && pack.runtime?.torchCudaFloor && (!torchCuda || Number(torchCuda) < pack.runtime.torchCudaFloor)) {
    issues.push(`需要 PyTorch cu${pack.runtime.torchCudaFloor}+，当前为 ${runtime.pytorchVersion || '未知'}`)
  }
  return issues
}

function normalizeRegisteredNodes(value) {
  if (value instanceof Set) return value
  if (Array.isArray(value)) return new Set(value.filter((entry) => typeof entry === 'string'))
  if (value && typeof value === 'object') return new Set(Object.keys(value))
  return new Set()
}

function parseWorkflowInput(workflow) {
  if (typeof workflow === 'string') {
    if (Buffer.byteLength(workflow) > MAX_CUSTOM_WORKFLOW_BYTES) throw workflowError('自定义工作流超过 2MB 上限', 'CUSTOM_WORKFLOW_TOO_LARGE', 413)
    try {
      return JSON.parse(workflow)
    } catch {
      throw workflowError('自定义工作流 JSON 无法解析', 'CUSTOM_WORKFLOW_INVALID_JSON')
    }
  }
  const serialized = JSON.stringify(workflow)
  if (!serialized || Buffer.byteLength(serialized) > MAX_CUSTOM_WORKFLOW_BYTES) throw workflowError('自定义工作流超过 2MB 上限', 'CUSTOM_WORKFLOW_TOO_LARGE', 413)
  return clone(workflow)
}

function scanInputValue(value, context, path = 'inputs', depth = 0) {
  if (depth > 8) {
    context.findings.push({ severity: 'error', code: 'CUSTOM_WORKFLOW_TOO_DEEP', message: `${path} 嵌套过深` })
    return
  }
  if (typeof value === 'string') {
    if (value.length > 16_384) context.findings.push({ severity: 'error', code: 'CUSTOM_WORKFLOW_STRING_TOO_LONG', message: `${path} 字符串过长` })
    if (URL_VALUE.test(value)) context.findings.push({ severity: 'error', code: 'CUSTOM_WORKFLOW_NETWORK_VALUE', message: `${path} 含网络地址` })
    if (WINDOWS_ABSOLUTE.test(value) || UNC_PATH.test(value) || value.startsWith('/') || TRAVERSAL_SEGMENT.test(value)) {
      context.findings.push({ severity: 'error', code: 'CUSTOM_WORKFLOW_UNSAFE_PATH', message: `${path} 含绝对路径或目录穿越` })
    }
    if (MODEL_EXTENSION.test(value)) context.models.add(value)
    return
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return
  if (Array.isArray(value)) {
    if (value.length > 2_048) {
      context.findings.push({ severity: 'error', code: 'CUSTOM_WORKFLOW_ARRAY_TOO_LARGE', message: `${path} 数组过大` })
      return
    }
    value.forEach((entry, index) => scanInputValue(entry, context, `${path}[${index}]`, depth + 1))
    return
  }
  if (!value || typeof value !== 'object') {
    context.findings.push({ severity: 'error', code: 'CUSTOM_WORKFLOW_INPUT_TYPE', message: `${path} 含不支持的输入类型` })
    return
  }
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_INPUT.test(key)) context.findings.push({ severity: 'error', code: 'CUSTOM_WORKFLOW_SECRET_FIELD', message: `${path}.${key} 可能包含密钥` })
    scanInputValue(entry, context, `${path}.${key}`, depth + 1)
  }
}

function mappingCandidates(workflow) {
  const inputs = []
  const outputs = []
  for (const [nodeId, node] of Object.entries(workflow)) {
    for (const [inputName, value] of Object.entries(node.inputs || {})) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        inputs.push({ nodeId, nodeType: node.class_type, inputName, valueType: typeof value })
      }
    }
    if (/^(?:SaveImage|SaveVideo|PreviewImage|CreateVideo)$/u.test(node.class_type)) outputs.push({ nodeId, nodeType: node.class_type })
  }
  return { inputs, outputs }
}

function validateMappings(workflow, mappings, findings) {
  const allowedRoles = new Set(['prompt', 'negativePrompt', 'sourceImage', 'lastFrame', 'seed', 'width', 'height', 'frames', 'steps', 'output'])
  if (!mappings || typeof mappings !== 'object' || Array.isArray(mappings)) {
    findings.push({ severity: 'error', code: 'CUSTOM_WORKFLOW_MAPPINGS_REQUIRED', message: '必须明确映射 prompt 与 output' })
    return
  }
  for (const role of Object.keys(mappings)) {
    if (!allowedRoles.has(role)) findings.push({ severity: 'error', code: 'CUSTOM_WORKFLOW_MAPPING_ROLE', message: `未知映射角色 ${role}` })
  }
  for (const required of ['prompt', 'output']) {
    if (!mappings[required]) findings.push({ severity: 'error', code: 'CUSTOM_WORKFLOW_MAPPING_REQUIRED', message: `缺少 ${required} 映射` })
  }
  for (const [role, mapping] of Object.entries(mappings)) {
    if (!allowedRoles.has(role)) continue
    const keys = mapping && typeof mapping === 'object' && !Array.isArray(mapping) ? Object.keys(mapping) : []
    const expected = role === 'output' ? ['nodeId'] : ['nodeId', 'inputName']
    if (!mapping || keys.some((key) => !expected.includes(key)) || expected.some((key) => typeof mapping[key] !== 'string')) {
      findings.push({ severity: 'error', code: 'CUSTOM_WORKFLOW_MAPPING_SHAPE', message: `${role} 映射字段无效` })
      continue
    }
    const node = workflow[mapping.nodeId]
    if (!node) {
      findings.push({ severity: 'error', code: 'CUSTOM_WORKFLOW_MAPPING_NODE', message: `${role} 映射节点不存在` })
      continue
    }
    if (role === 'output') {
      if (!/^(?:SaveImage|SaveVideo|PreviewImage|CreateVideo)$/u.test(node.class_type)) {
        findings.push({ severity: 'error', code: 'CUSTOM_WORKFLOW_OUTPUT_NODE', message: 'output 必须映射到受控输出节点' })
      }
    } else if (!Object.prototype.hasOwnProperty.call(node.inputs || {}, mapping.inputName)) {
      findings.push({ severity: 'error', code: 'CUSTOM_WORKFLOW_MAPPING_INPUT', message: `${role} 映射输入不存在` })
    }
  }
}

export function inspectCustomWorkflow({ workflow, mappings, registeredNodeTypes } = {}) {
  const parsed = parseWorkflowInput(workflow)
  const findings = []
  if (Array.isArray(parsed?.nodes)) {
    findings.push({ severity: 'error', code: 'CUSTOM_WORKFLOW_UI_FORMAT', message: '这是界面工作流格式；请在 ComfyUI 中导出“API 格式”JSON。' })
    return { version: WORKFLOW_CENTER_VERSION, hash: createHash('sha256').update(JSON.stringify(parsed)).digest('hex'), nodeCount: parsed.nodes.length, nodeTypes: [], models: [], mappings: null, candidates: { inputs: [], outputs: [] }, findings, canImport: false }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw workflowError('工作流根必须是 API 节点对象', 'CUSTOM_WORKFLOW_INVALID_ROOT')
  const entries = Object.entries(parsed)
  if (!entries.length || entries.length > MAX_CUSTOM_WORKFLOW_NODES) throw workflowError(`工作流节点数必须为 1–${MAX_CUSTOM_WORKFLOW_NODES}`, 'CUSTOM_WORKFLOW_NODE_LIMIT')
  const registered = registeredNodeTypes === undefined || registeredNodeTypes === null
    ? new Set(DEFAULT_SAFE_COMFY_NODE_TYPES)
    : normalizeRegisteredNodes(registeredNodeTypes)
  const nodeTypes = new Set()
  const models = new Set()
  for (const [nodeId, node] of entries) {
    if (!SAFE_NODE_ID.test(nodeId)) {
      findings.push({ severity: 'error', code: 'CUSTOM_WORKFLOW_NODE_ID', message: `节点 ID ${nodeId} 无效` })
      continue
    }
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      findings.push({ severity: 'error', code: 'CUSTOM_WORKFLOW_NODE_SHAPE', message: `节点 ${nodeId} 结构无效` })
      continue
    }
    const unknownKeys = Object.keys(node).filter((key) => !['class_type', 'inputs', '_meta'].includes(key))
    if (unknownKeys.length) findings.push({ severity: 'error', code: 'CUSTOM_WORKFLOW_NODE_FIELD', message: `节点 ${nodeId} 含未知字段` })
    const nodeType = node.class_type
    if (typeof nodeType !== 'string' || !SAFE_NODE_ID.test(nodeType)) {
      findings.push({ severity: 'error', code: 'CUSTOM_WORKFLOW_NODE_TYPE', message: `节点 ${nodeId} 类型无效` })
      continue
    }
    nodeTypes.add(nodeType)
    if (NETWORK_NODE.test(nodeType)) findings.push({ severity: 'error', code: 'CUSTOM_WORKFLOW_NETWORK_NODE', message: `${nodeType} 属于网络节点` })
    if (EXECUTION_NODE.test(nodeType)) findings.push({ severity: 'error', code: 'CUSTOM_WORKFLOW_EXECUTION_NODE', message: `${nodeType} 可执行任意代码` })
    if (!registered.has(nodeType)) findings.push({ severity: 'error', code: 'CUSTOM_WORKFLOW_UNKNOWN_NODE', message: `${nodeType} 未在当前运行时注册` })
    if (!node.inputs || typeof node.inputs !== 'object' || Array.isArray(node.inputs)) {
      findings.push({ severity: 'error', code: 'CUSTOM_WORKFLOW_INPUTS', message: `节点 ${nodeId} 缺少 inputs 对象` })
      continue
    }
    for (const key of Object.keys(node.inputs)) {
      if (SECRET_INPUT.test(key)) findings.push({ severity: 'error', code: 'CUSTOM_WORKFLOW_SECRET_FIELD', message: `节点 ${nodeId}.${key} 可能包含密钥` })
    }
    scanInputValue(node.inputs, { findings, models }, `${nodeId}.inputs`)
  }
  validateMappings(parsed, mappings, findings)
  const candidates = mappingCandidates(parsed)
  const hash = createHash('sha256').update(JSON.stringify(parsed)).digest('hex')
  return {
    version: WORKFLOW_CENTER_VERSION,
    hash,
    nodeCount: entries.length,
    nodeTypes: [...nodeTypes].sort(),
    models: [...models].sort(),
    mappings: mappings ? clone(mappings) : null,
    candidates,
    findings,
    canImport: !findings.some(({ severity }) => severity === 'error'),
    workflow: parsed,
  }
}

export class WorkflowCenterService {
  constructor({
    rootDirectory,
    getComfyRoot,
    getRuntimeConfig,
    packs = PACKS,
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (!rootDirectory) throw new Error('WorkflowCenterService requires rootDirectory')
    this.rootDirectory = resolve(rootDirectory)
    this.statePath = join(this.rootDirectory, 'state.json')
    this.downloadDirectory = join(this.rootDirectory, 'downloads')
    this.quarantineDirectory = join(this.rootDirectory, 'quarantine')
    this.getComfyRoot = getComfyRoot || (() => undefined)
    this.getRuntimeConfig = getRuntimeConfig || (() => ({ comfyRoot: this.getComfyRoot(), comfyArgs: [] }))
    this.packs = packs.map((pack) => clone(pack))
    this.fetchImpl = fetchImpl
    this.state = stateTemplate()
    this.listeners = new Set()
    this.controllers = new Map()
    this.saveChain = Promise.resolve()
  }

  async open() {
    await Promise.all([
      mkdir(this.rootDirectory, { recursive: true }),
      mkdir(this.downloadDirectory, { recursive: true }),
      mkdir(this.quarantineDirectory, { recursive: true }),
    ])
    try {
      this.state = normalizeState(JSON.parse(await readFile(this.statePath, 'utf8')))
    } catch {
      this.state = stateTemplate()
    }
    await this.#save()
  }

  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  #emit(job) {
    for (const listener of this.listeners) listener(clone(job))
  }

  #save() {
    this.saveChain = this.saveChain.catch(() => undefined).then(async () => {
      const temporary = `${this.statePath}.${process.pid}.tmp`
      await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8')
      await rename(temporary, this.statePath)
    })
    return this.saveChain
  }

  #pack(packId) {
    const pack = this.packs.find(({ id }) => id === packId)
    if (!pack) throw workflowError('工作流能力包不存在', 'WORKFLOW_PACK_NOT_FOUND', 404)
    return pack
  }

  // @yao-pkg/pkg 6.22 misclassifies await inside private class methods as
  // top-level await. Keep async packaging-boundary methods conventionally
  // internal so the ESM-to-CJS transform includes this module in the snapshot.
  async _runtimeRegistry() {
    const configuration = this.getRuntimeConfig() || {}
    return discoverRuntimeRegistry({
      comfyRoot: configuration.comfyRoot || this.getComfyRoot(),
      pythonPath: configuration.pythonPath,
      runtimePackageId: configuration.offlineRuntimePackageId,
      comfyArgs: configuration.comfyArgs,
      modelCategories: registryCategories(this.packs),
    })
  }

  _artifactLocation(candidate) {
    if (!candidate) return null
    return {
      rootId: candidate.root.id,
      rootPath: candidate.root.path,
      rootLabel: candidate.root.label || candidate.root.category,
      targetPath: candidate.targetPath,
      source: candidate.root.source,
      category: candidate.root.category,
      shared: candidate.root.shared,
      portable: candidate.root.portable,
      references: candidate.root.references,
    }
  }

  _verifiedArtifact(artifact, candidate, file) {
    const verification = this.state.verifiedArtifacts[artifactVerificationKey(artifact, candidate.targetPath)]
      || (candidate.root.source === 'configured-runtime' ? this.state.verifiedArtifacts[artifact.relativePath] : null)
    return Boolean(
      verification?.sha256 === artifact.sha256
      && verification?.bytes === file.size
      && verification?.mtimeMs === file.mtimeMs,
    )
  }

  async _inspectArtifact(artifact, registry) {
    if (!registry?.configured) return { present: false, verified: false, contentHash: null, location: null, status: 'runtime-unconfigured' }
    if (artifact.relativePath) {
      const candidates = registeredArtifactCandidates(artifact, registry)
      let firstMismatch = null
      for (const candidate of candidates) {
        const file = await pathStats(candidate.targetPath)
        if (!file) continue
        const location = this._artifactLocation(candidate)
        if (!file.isFile()) {
          firstMismatch ||= { present: false, verified: false, contentHash: null, location, status: 'wrong-kind' }
          continue
        }
        if (artifact.bytes && file.size !== artifact.bytes) {
          firstMismatch ||= { present: false, verified: false, contentHash: null, location, status: 'size-mismatch' }
          continue
        }
        const verified = this._verifiedArtifact(artifact, candidate, file)
        return {
          present: true,
          verified,
          contentHash: verified ? artifact.sha256 : null,
          location,
          status: verified ? 'verified' : 'present-unverified',
        }
      }
      return firstMismatch || { present: false, verified: false, contentHash: null, location: null, status: 'missing' }
    }
    const candidates = artifact.presentCandidates || []
    for (const candidate of candidates) {
      if (isAbsolute(candidate) || WINDOWS_ABSOLUTE.test(candidate) || TRAVERSAL_SEGMENT.test(candidate)) continue
      for (const registered of registeredArtifactCandidates({ relativePath: candidate }, registry)) {
        const entry = await pathStats(registered.targetPath)
        if (entry) return { present: true, verified: false, contentHash: null, location: this._artifactLocation(registered), status: 'present-manual' }
      }
    }
    return { present: false, verified: false, contentHash: null, location: null, status: 'manual-required' }
  }

  async catalog({ runtime = {}, objectInfo = null, hardware = null } = {}) {
    const registry = await this._runtimeRegistry()
    const comfyRoot = registry.comfyRoot
    const registeredNodes = normalizeRegisteredNodes(objectInfo)
    const vramTotal = Number(runtime.vramTotal || hardware?.vramTotal || 0)
    const vramGb = vramTotal > 0 ? vramTotal / GIB : 0
    const activeJobs = new Map(this.state.jobs.filter((job) => ['queued', 'running', 'waiting-user'].includes(job.status)).map((job) => [job.packId, job]))
    const packs = []
    for (const pack of this.packs) {
      const artifactStates = await Promise.all(pack.artifacts.map((artifact) => this._inspectArtifact(artifact, registry)))
      const artifacts = pack.artifacts.map((artifact, index) => publicArtifact(artifact, artifactStates[index]))
      const missingArtifacts = artifacts.filter(({ present }) => !present)
      const unverifiedArtifacts = artifacts.filter(({ present, verified, kind }) => present && !verified && kind === 'model')
      const missingNodes = runtime.connected ? pack.requiredNodes.filter((node) => !registeredNodes.has(node)) : []
      const runtimeIssues = inspectRuntimeGate(pack, runtime)
      const enabled = this.state.enabledPackIds.includes(pack.id)
      const installed = missingArtifacts.length === 0
      const integrityVerified = unverifiedArtifacts.length === 0
      const lifecycleState = runtime.lifecycle?.state || (runtime.connected ? 'external' : 'stopped')
      const waking = lifecycleState === 'starting'
      const hasError = lifecycleState === 'error'
        || runtimeIssues.length > 0
        || (enabled && !integrityVerified)
        || (enabled && runtime.connected && missingNodes.length > 0)
      const status = !installed
        ? 'uninstalled'
        : !enabled
          ? 'installed-disabled'
          : waking
            ? 'waking'
            : hasError
              ? 'error'
              : runtime.connected
                ? 'executable'
                : 'enabled-sleeping'
      const ready = status === 'executable'
      const downloadBytes = pendingDownloadBytes(artifacts)
      packs.push({
        ...pack,
        artifacts,
        downloadBytes,
        fullDownloadBytes: artifactDownloadBytes(pack),
        requiredLicenseIds: requiredLicenseIds(pack),
        acceptedLicense: requiredLicenseIds(pack).every((id) => Boolean(this.state.acceptedLicenses[id])),
        enabled,
        installed,
        integrityVerified,
        ready,
        status,
        missingArtifacts: missingArtifacts.map(({ id }) => id),
        unverifiedArtifacts: unverifiedArtifacts.map(({ id }) => id),
        missingNodes,
        runtimeIssues,
        runtimeConnected: Boolean(runtime.connected),
        lifecycleState,
        recommendation: hardwareRecommendation(pack, vramGb),
        activeJob: activeJobs.get(pack.id) || null,
      })
    }
    return {
      version: WORKFLOW_CENTER_VERSION,
      checkedAt: Date.now(),
      storage: {
        configured: Boolean(comfyRoot),
        location: comfyRoot ? 'runtime-registry' : 'not-configured',
        modelRoots: registry.modelRoots.length,
        sharedRoots: registry.sharedRoots.length,
      },
      hardware: {
        device: runtime.device || hardware?.name || null,
        vramTotal,
        vramGb: vramGb ? Number(vramGb.toFixed(1)) : null,
      },
      runtime: {
        connected: Boolean(runtime.connected),
        comfyVersion: runtime.comfyVersion || null,
        pytorchVersion: runtime.pytorchVersion || null,
        lifecycle: runtime.lifecycle || null,
      },
      registry: publicRegistry(registry),
      packs,
      customWorkflows: this.state.customWorkflows.map(({ workflow: _workflow, ...entry }) => clone(entry)),
      jobs: this.state.jobs.slice(-20).reverse(),
    }
  }

  jobs() {
    return this.state.jobs.slice().reverse().map(clone)
  }

  job(jobId) {
    return clone(this.state.jobs.find(({ id }) => id === jobId) || null)
  }

  async startInstall(packId, request = {}) {
    const allowed = new Set(['acceptedLicenseIds', 'acknowledgedDiskBytes'])
    if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some((key) => !allowed.has(key))) {
      throw workflowError('安装请求字段无效', 'WORKFLOW_INSTALL_REQUEST_INVALID')
    }
    const pack = this.#pack(packId)
    const requiredLicenses = requiredLicenseIds(pack)
    const accepted = new Set(Array.isArray(request.acceptedLicenseIds) ? request.acceptedLicenseIds : [])
    const missingLicenses = requiredLicenses.filter((id) => !accepted.has(id) && !this.state.acceptedLicenses[id])
    if (missingLicenses.length) throw workflowError('必须先确认模型许可证与适用范围', 'WORKFLOW_LICENSE_ACCEPTANCE_REQUIRED', 409, { licenseIds: missingLicenses })
    const registry = await this._runtimeRegistry()
    if (!registry.configured) throw workflowError('请先在本机设置中配置 ComfyUI 根目录', 'WORKFLOW_RUNTIME_UNCONFIGURED', 409)
    const artifactStates = await Promise.all(pack.artifacts.map((artifact) => this._inspectArtifact(artifact, registry)))
    const artifacts = pack.artifacts.map((artifact, index) => publicArtifact(artifact, artifactStates[index]))
    const diskBytes = pendingDownloadBytes(artifacts)
    if (!Number.isSafeInteger(request.acknowledgedDiskBytes) || request.acknowledgedDiskBytes < diskBytes) {
      throw workflowError('必须确认本次能力包的最大下载体量', 'WORKFLOW_DISK_ACK_REQUIRED', 409, { downloadBytes: diskBytes })
    }
    const existing = this.state.jobs.find((job) => job.packId === packId && ['queued', 'running'].includes(job.status))
    if (existing) return clone(existing)
    const now = Date.now()
    const job = {
      id: `wfjob-${randomUUID()}`,
      packId,
      status: 'queued',
      phase: 'queued',
      progress: 0,
      downloadedBytes: 0,
      totalBytes: diskBytes,
      currentArtifactId: null,
      createdAt: now,
      updatedAt: now,
      error: null,
    }
    for (const id of accepted) {
      if (requiredLicenses.includes(id)) this.state.acceptedLicenses[id] = { acceptedAt: now, packId }
    }
    this.state.jobs.push(job)
    this.state.jobs = this.state.jobs.slice(-30)
    await this.#save()
    this.#emit(job)
    const controller = new AbortController()
    this.controllers.set(job.id, controller)
    void this._runInstall(job.id, pack, controller.signal)
    return clone(job)
  }

  async _updateJob(jobId, patch) {
    const job = this.state.jobs.find(({ id }) => id === jobId)
    if (!job) return null
    Object.assign(job, patch, { updatedAt: Date.now() })
    await this.#save()
    this.#emit(job)
    return job
  }

  async _downloadArtifact(job, artifact, registry, signal, progressBase, totalBytes) {
    const comfyRoot = registry.comfyRoot
    const target = resolveInside(comfyRoot, artifact.relativePath)
    const targetStats = await pathStats(target)
    if (targetStats?.isFile()) {
      if (artifact.bytes && targetStats.size !== artifact.bytes) throw workflowError(`${artifact.label} 已存在但大小不匹配`, 'WORKFLOW_EXISTING_ARTIFACT_MISMATCH', 409, { artifactId: artifact.id })
      const existingHash = await sha256File(target)
      if (existingHash !== artifact.sha256) throw workflowError(`${artifact.label} 已存在但哈希不匹配`, 'WORKFLOW_EXISTING_ARTIFACT_MISMATCH', 409, { artifactId: artifact.id })
      this.state.verifiedArtifacts[artifact.relativePath] = {
        sha256: existingHash,
        bytes: targetStats.size,
        mtimeMs: targetStats.mtimeMs,
        verifiedAt: Date.now(),
      }
      return artifact.bytes || targetStats.size
    }
    await mkdir(dirname(target), { recursive: true })
    const partial = join(this.downloadDirectory, `${artifact.sha256}.part`)
    const partialStats = await pathStats(partial)
    const offset = partialStats?.isFile() ? partialStats.size : 0
    if (artifact.bytes && offset > artifact.bytes) throw workflowError(`${artifact.label} 的续传分片超出预期大小`, 'WORKFLOW_PARTIAL_INVALID', 409, { artifactId: artifact.id })
    const headers = offset ? { Range: `bytes=${offset}-` } : undefined
    const response = await this.fetchImpl(artifact.downloadUrl, { headers, signal, redirect: 'follow' })
    if (!response.ok && response.status !== 206) throw workflowError(`${artifact.label} 下载失败（HTTP ${response.status}）`, 'WORKFLOW_DOWNLOAD_HTTP', 502, { artifactId: artifact.id, status: response.status })
    const append = offset > 0 && response.status === 206
    const file = await openFile(partial, append ? 'a' : 'w')
    let received = append ? offset : 0
    let lastReportedAt = 0
    try {
      for await (const chunk of response.body) {
        if (signal.aborted) throw Object.assign(new Error('安装已取消'), { name: 'AbortError' })
        const bytes = Buffer.from(chunk)
        await file.write(bytes)
        received += bytes.length
        const downloadedBytes = progressBase + received
        const progress = totalBytes ? Math.min(99, Math.floor((downloadedBytes / totalBytes) * 100)) : 0
        const now = Date.now()
        if (now - lastReportedAt >= 500 || (artifact.bytes && received === artifact.bytes)) {
          lastReportedAt = now
          await this._updateJob(job.id, { downloadedBytes, progress, phase: 'downloading', currentArtifactId: artifact.id })
        }
      }
    } finally {
      await file.close()
    }
    if (artifact.bytes && received !== artifact.bytes) throw workflowError(`${artifact.label} 下载大小不完整`, 'WORKFLOW_DOWNLOAD_SIZE_MISMATCH', 502, { artifactId: artifact.id, expectedBytes: artifact.bytes, actualBytes: received })
    await this._updateJob(job.id, { phase: 'verifying', currentArtifactId: artifact.id })
    const digest = await sha256File(partial)
    if (digest !== artifact.sha256) {
      const quarantine = join(this.quarantineDirectory, `${artifact.id}-${Date.now()}.invalid`)
      await rename(partial, quarantine)
      throw workflowError(`${artifact.label} SHA-256 校验失败，已隔离且不会启用`, 'WORKFLOW_DOWNLOAD_HASH_MISMATCH', 409, { artifactId: artifact.id })
    }
    await rename(partial, target)
    const installed = await stat(target)
    this.state.verifiedArtifacts[artifactVerificationKey(artifact, target)] = {
      sha256: digest,
      bytes: installed.size,
      mtimeMs: installed.mtimeMs,
      verifiedAt: Date.now(),
    }
    return received
  }

  async _verifyExistingArtifact(job, artifact, inspection) {
    if (!inspection.present || !inspection.location?.targetPath) return false
    if (inspection.verified) return true
    await this._updateJob(job.id, { phase: 'verifying-existing', currentArtifactId: artifact.id })
    const digest = await sha256File(inspection.location.targetPath)
    if (digest !== artifact.sha256) {
      throw workflowError(`${artifact.label} 已存在，但 SHA-256 与能力包登记值不一致；为保护共享模型，未覆盖该文件`, 'WORKFLOW_ARTIFACT_HASH_MISMATCH', 409, {
        artifactId: artifact.id,
        rootId: inspection.location.rootId,
      })
    }
    const file = await stat(inspection.location.targetPath)
    this.state.verifiedArtifacts[artifactVerificationKey(artifact, inspection.location.targetPath)] = {
      sha256: digest,
      bytes: file.size,
      mtimeMs: file.mtimeMs,
      verifiedAt: Date.now(),
    }
    await this.#save()
    return true
  }

  async _runInstall(jobId, pack, signal) {
    const job = this.state.jobs.find(({ id }) => id === jobId)
    if (!job) return
    try {
      await this._updateJob(jobId, { status: 'running', phase: 'preflight', progress: 0 })
      let completedBytes = 0
      const registry = await this._runtimeRegistry()
      if (!registry.configured) throw workflowError('ComfyUI 运行时配置已失效', 'WORKFLOW_RUNTIME_UNCONFIGURED', 409)
      const automaticArtifacts = pack.artifacts.filter(({ downloadUrl }) => downloadUrl)
      for (const artifact of automaticArtifacts) {
        const inspection = await this._inspectArtifact(artifact, registry)
        if (inspection.present) {
          await this._verifyExistingArtifact(job, artifact, inspection)
          continue
        }
        const artifactBytes = await this._downloadArtifact(job, artifact, registry, signal, completedBytes, job.totalBytes)
        completedBytes += artifactBytes
      }
      const manualMissing = []
      for (const artifact of pack.artifacts.filter(({ downloadUrl }) => !downloadUrl)) {
        const state = await this._inspectArtifact(artifact, registry)
        if (!state.present) manualMissing.push({ id: artifact.id, label: artifact.label, instruction: artifact.instruction, sourceUrl: artifact.sourceUrl })
      }
      if (manualMissing.length) {
        await this._updateJob(jobId, {
          status: 'waiting-user',
          phase: 'manual-dependencies',
          progress: 100,
          downloadedBytes: completedBytes,
          currentArtifactId: null,
          manualMissing,
        })
        return
      }
      if (!this.state.enabledPackIds.includes(pack.id)) this.state.enabledPackIds.push(pack.id)
      await this._updateJob(jobId, {
        status: 'completed',
        phase: 'enabled',
        progress: 100,
        downloadedBytes: completedBytes,
        currentArtifactId: null,
        completedAt: Date.now(),
      })
    } catch (error) {
      const cancelled = error?.name === 'AbortError'
      await this._updateJob(jobId, {
        status: cancelled ? 'cancelled' : 'failed',
        phase: cancelled ? 'cancelled' : 'failed',
        error: { code: cancelled ? 'WORKFLOW_INSTALL_CANCELLED' : error?.code || 'WORKFLOW_INSTALL_FAILED', message: error?.message || '能力包安装失败', details: error?.details },
      })
    } finally {
      this.controllers.delete(jobId)
    }
  }

  async cancelInstall(jobId) {
    const job = this.state.jobs.find(({ id }) => id === jobId)
    if (!job) throw workflowError('安装任务不存在', 'WORKFLOW_INSTALL_JOB_NOT_FOUND', 404)
    if (!['queued', 'running'].includes(job.status)) throw workflowError('只有排队或运行中的安装可以取消', 'WORKFLOW_INSTALL_NOT_CANCELLABLE', 409)
    this.controllers.get(jobId)?.abort()
    return clone(job)
  }

  async enablePack(packId, { runtime = {}, objectInfo = null } = {}) {
    const pack = this.#pack(packId)
    const registry = await this._runtimeRegistry()
    if (!registry.configured) throw workflowError('请先配置 ComfyUI 运行时', 'WORKFLOW_RUNTIME_UNCONFIGURED', 409)
    const requiredLicenses = requiredLicenseIds(pack)
    if (requiredLicenses.some((id) => !this.state.acceptedLicenses[id])) throw workflowError('许可证尚未确认', 'WORKFLOW_LICENSE_ACCEPTANCE_REQUIRED', 409)
    for (const artifact of pack.artifacts) {
      const inspection = await this._inspectArtifact(artifact, registry)
      if (!inspection.present) throw workflowError(`${artifact.label} 尚未安装`, 'WORKFLOW_DEPENDENCY_MISSING', 409, { artifactId: artifact.id })
      if (artifact.relativePath && !inspection.verified) {
        const target = inspection.location?.targetPath
        if (!target) throw workflowError(`${artifact.label} 无法定位`, 'WORKFLOW_DEPENDENCY_MISSING', 409, { artifactId: artifact.id })
        const digest = await sha256File(target)
        if (digest !== artifact.sha256) throw workflowError(`${artifact.label} 校验失败`, 'WORKFLOW_ARTIFACT_HASH_MISMATCH', 409, { artifactId: artifact.id })
        const file = await stat(target)
        this.state.verifiedArtifacts[artifactVerificationKey(artifact, target)] = {
          sha256: digest,
          bytes: file.size,
          mtimeMs: file.mtimeMs,
          verifiedAt: Date.now(),
        }
      }
    }
    const runtimeIssues = inspectRuntimeGate(pack, runtime)
    if (runtimeIssues.length) throw workflowError(runtimeIssues.join('；'), 'WORKFLOW_RUNTIME_INCOMPATIBLE', 409)
    const registeredNodes = normalizeRegisteredNodes(objectInfo)
    if (runtime.connected) {
      const missingNodes = pack.requiredNodes.filter((node) => !registeredNodes.has(node))
      if (missingNodes.length) throw workflowError('当前 ComfyUI 仍缺少工作流节点', 'WORKFLOW_NODES_MISSING', 409, { missingNodes })
    }
    if (!this.state.enabledPackIds.includes(packId)) this.state.enabledPackIds.push(packId)
    await this.#save()
    return { packId, enabled: true, restartRecommended: pack.artifacts.some(({ kind }) => kind === 'manual-extension') }
  }

  async disablePack(packId) {
    this.#pack(packId)
    this.state.enabledPackIds = this.state.enabledPackIds.filter((id) => id !== packId)
    await this.#save()
    return { packId, enabled: false }
  }

  inspectCustom({ workflow, mappings, registeredNodeTypes }) {
    const result = inspectCustomWorkflow({ workflow, mappings, registeredNodeTypes })
    const { workflow: _workflow, ...summary } = result
    return summary
  }

  async importCustom({ title, workflow, mappings, registeredNodeTypes }) {
    if (typeof title !== 'string' || !title.trim() || title.trim().length > 120) throw workflowError('自定义工作流名称必须为 1–120 字符', 'CUSTOM_WORKFLOW_TITLE')
    const inspection = inspectCustomWorkflow({ workflow, mappings, registeredNodeTypes })
    if (!inspection.canImport) throw workflowError('自定义工作流未通过安全检查', 'CUSTOM_WORKFLOW_REJECTED', 409, { findings: inspection.findings })
    const now = Date.now()
    const existing = this.state.customWorkflows.find(({ hash }) => hash === inspection.hash)
    if (existing) return clone({ ...existing, workflow: undefined })
    const entry = {
      id: `custom-${randomUUID()}`,
      title: title.trim(),
      version: 1,
      hash: inspection.hash,
      nodeCount: inspection.nodeCount,
      nodeTypes: inspection.nodeTypes,
      models: inspection.models,
      mappings: inspection.mappings,
      enabled: false,
      source: 'user-api-json',
      createdAt: now,
      updatedAt: now,
      workflow: inspection.workflow,
    }
    this.state.customWorkflows.push(entry)
    await this.#save()
    const { workflow: _workflow, ...summary } = entry
    return clone(summary)
  }

  async setCustomEnabled(customId, enabled, registeredNodeTypes) {
    const entry = this.state.customWorkflows.find(({ id }) => id === customId)
    if (!entry) throw workflowError('自定义工作流不存在', 'CUSTOM_WORKFLOW_NOT_FOUND', 404)
    if (enabled) {
      const inspection = inspectCustomWorkflow({ workflow: entry.workflow, mappings: entry.mappings, registeredNodeTypes })
      if (!inspection.canImport || inspection.hash !== entry.hash) throw workflowError('工作流版本或运行时节点已变化，必须重新检查', 'CUSTOM_WORKFLOW_RECHECK_REQUIRED', 409, { findings: inspection.findings })
    }
    entry.enabled = Boolean(enabled)
    entry.updatedAt = Date.now()
    await this.#save()
    const { workflow: _workflow, ...summary } = entry
    return clone(summary)
  }

  async removeCustom(customId) {
    const before = this.state.customWorkflows.length
    this.state.customWorkflows = this.state.customWorkflows.filter(({ id }) => id !== customId)
    if (this.state.customWorkflows.length === before) throw workflowError('自定义工作流不存在', 'CUSTOM_WORKFLOW_NOT_FOUND', 404)
    await this.#save()
    return { id: customId, removed: true }
  }

  async close() {
    for (const controller of this.controllers.values()) controller.abort()
    this.controllers.clear()
    await this.saveChain
  }
}

export function builtinWorkflowPacks() {
  return clone(PACKS)
}
