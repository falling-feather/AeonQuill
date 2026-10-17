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
import {
  WORKFLOW_CONTROL_FIELDS,
  validateWorkflowControlValue,
} from '../src/lib/workflowControls.mjs'
import {
  assertWorkflowWeightSetCompatible,
  assertWorkflowLoraBindingsCompatible,
  assertWorkflowLoraControlsMatchBindings,
  normalizeWorkflowLoraBindings,
  validateWorkflowWeightSet,
} from '../src/lib/workflowRecipes.mjs'
import {
  H3_WEIGHT_ARTIFACT_IDS,
  VIDEO_MODEL_PROFILES,
  VIDEO_WEIGHT_ARTIFACT_ROLES,
  VIDEO_WORKFLOW_REGISTRY_VERSION,
} from './video-workflow-registry.mjs'
import {
  APACHE_2,
  ARTIFACTS,
  H3_LICENSE,
} from './workflow-artifacts.mjs'

export const WORKFLOW_CENTER_VERSION = 'aeonquill-workflow-center-v2'
export const WORKFLOW_CENTER_STATE_VERSION = 1
export const CUSTOM_WORKFLOW_EXECUTION_VERSION = 'aeonquill-custom-workflow-execution-v1'
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
const DYNAMIC_INPUT_DENYLIST = /(?:^|_)(?:api|authorization|device|directory|file|filename|folder|format|key|model|path|prefix|secret|token|url|vae|ckpt|lora|clip|unet|controlnet)(?:_|$)/iu
const CUSTOM_OUTPUT_NODE = /^(?:SaveImage|SaveVideo|PreviewImage)$/u
const CUSTOM_IMAGE_INPUT_NODE = 'LoadImage'
const VIDEO_WEIGHT_SAMPLING_MODES = new Set(['base', 'turbo'])
const H3_SIGNAL_NODE_TYPES = new Set(['MiniMaxH3ImageToVideo', 'MiniMaxH3TurboLoRA', 'MiniMaxH3TurboSampler'])
const CUSTOM_MAPPING_ROLES = Object.freeze([
  'prompt', 'negativePrompt', 'sourceImage', 'lastFrame', ...Object.keys(WORKFLOW_CONTROL_FIELDS), 'output',
])
const WORKFLOW_CONTROL_ROLES = new Set(Object.keys(WORKFLOW_CONTROL_FIELDS))
const CONTROL_MAPPING_TARGETS = Object.freeze({
  cfg: Object.freeze({ nodeTypes: Object.freeze(['KSampler', 'KSamplerAdvanced']), inputName: 'cfg' }),
  denoise: Object.freeze({ nodeTypes: Object.freeze(['KSampler']), inputName: 'denoise' }),
  loraStrength: Object.freeze({ nodeTypes: Object.freeze(['LoraLoader', 'LoraLoaderModelOnly']), inputName: 'strength_model' }),
  loraClipStrength: Object.freeze({ nodeTypes: Object.freeze(['LoraLoader']), inputName: 'strength_clip' }),
  controlStrength: Object.freeze({ nodeTypes: Object.freeze(['ControlNetApply', 'ControlNetApplyAdvanced']), inputName: 'strength' }),
})
const STRICT_CONTROL_MAPPING_ROLES = new Set(Object.keys(CONTROL_MAPPING_TARGETS))

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
    id: 'qwen-edit-2511-quality',
    version: '1.0.0',
    category: 'image',
    title: 'Qwen 2511 语义编辑 · 质量模式',
    summary: '区域编辑、SAM 定点修改与人像调整共用 40 步固定模板；蒙版外像素由原图直接保留。',
    capabilities: ['region-edit', 'point-edit', 'portrait-adjust', 'reference-image', 'masked-composite'],
    maturity: 'candidate',
    minVramGb: 8,
    recommendedVramGb: 8,
    minSystemRamGb: 32,
    estimatedMinutes: '约一百万像素 40 步通常 8–30 分钟；8GB 显存将使用内存卸载',
    runtime: { minComfy: '0.30.2', python: '3.12', cuda: '12.9+' },
    license: Object.freeze({
      ...APACHE_2,
      sourceUrl: 'https://huggingface.co/Qwen/Qwen-Image-Edit-2511',
      notice: 'Qwen-Image-Edit-2511 模型卡标注 Apache-2.0；分发时保留许可证与 NOTICE。',
    }),
    artifacts: [
      ARTIFACTS.qwenImageEdit2511Int8,
      ARTIFACTS.qwenImageTextEncoderFp8,
      ARTIFACTS.qwenImageVae,
    ],
    requiredNodes: [
      'LoadImage', 'FluxKontextImageScale', 'UNETLoader', 'ModelSamplingAuraFlow', 'CFGNorm',
      'CLIPLoader', 'VAELoader', 'TextEncodeQwenImageEditPlus',
      'FluxKontextMultiReferenceLatentMethod', 'VAEEncode', 'KSampler', 'VAEDecode',
      'ImageToMask', 'ImageCompositeMasked', 'SaveImage',
    ],
    sourceUrl: 'https://docs.comfy.org/tutorials/image/qwen/qwen-image-edit-2511',
  }),
  Object.freeze({
    id: 'image-qwen-edit-2511-lightning4',
    version: '1.0.0',
    category: 'image',
    title: 'Qwen 2511 语义编辑 · Lightning 4 步',
    summary: '基于 INT8 ConvRot 与官方 4 步 Lightning LoRA 的实验档；标准 40 步档保持独立。',
    capabilities: ['region-edit', 'point-edit', 'portrait-adjust', 'reference-image', 'masked-composite', 'lightning4'],
    maturity: 'experimental',
    minVramGb: 8,
    recommendedVramGb: 24,
    minSystemRamGb: 32,
    estimatedMinutes: '待本机校准',
    runtime: { minComfy: '0.31.0', python: '3.12', cuda: '12.9+' },
    license: Object.freeze({
      ...APACHE_2,
      sourceUrl: 'https://huggingface.co/lightx2v/Qwen-Image-Edit-2511-Lightning/tree/d74eba145674fd7e31b949324e148e21e7118abd',
      notice: 'Qwen Image Edit 2511 与 Lightning LoRA 均按 Apache-2.0 来源条款保留许可证与 NOTICE。',
    }),
    artifacts: [
      ARTIFACTS.qwenImageEdit2511Int8,
      ARTIFACTS.qwenImageTextEncoderFp8,
      ARTIFACTS.qwenImageVae,
      ARTIFACTS.qwenLightning4Lora,
    ],
    requiredNodes: [
      'LoadImage', 'FluxKontextImageScale', 'UNETLoader', 'ModelSamplingAuraFlow', 'CFGNorm',
      'CLIPLoader', 'VAELoader', 'TextEncodeQwenImageEditPlus',
      'FluxKontextMultiReferenceLatentMethod', 'VAEEncode', 'LoraLoaderModelOnly', 'KSampler', 'VAEDecode',
      'ImageToMask', 'ImageCompositeMasked', 'SaveImage',
    ],
    sourceUrl: 'https://github.com/Comfy-Org/workflow_templates/blob/98fd32ca756dd9d72077fbe3457146d11cbc88cb/templates/image_qwen_image_edit_2511_int8.json',
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
  'MiniMaxH3TurboLoRA', 'MiniMaxH3TurboSampler', 'KSamplerSelect', 'KSampler', 'KSamplerAdvanced',
  'CLIPTextEncode', 'EmptyLatentImage', 'CheckpointLoaderSimple', 'LoraLoader', 'LoraLoaderModelOnly',
  'ControlNetApply', 'ControlNetApplyAdvanced',
  'LoadImage', 'SaveImage', 'PreviewImage', 'ImageScale', 'ImageScaleBy',
  'VAEEncode', 'VAEEncodeTiled', 'VAEDecodeTiled', 'RepeatLatentBatch',
  'ModelSamplingAuraFlow', 'CFGNorm', 'TextEncodeQwenImageEditPlus',
  'FluxKontextImageScale', 'FluxKontextMultiReferenceLatentMethod',
  'ImageToMask', 'ImageCompositeMasked',
  'ConditioningCombine', 'ConditioningConcat', 'ConditioningSetTimestepRange',
  'CreateVideo', 'SaveVideo',
]))

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function workflowError(message, code, status = 400, details) {
  return Object.assign(new Error(message), { code, status, ...(details ? { details } : {}) })
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function customMappingHash(mappings) {
  return createHash('sha256').update(canonicalJson(mappings || {})).digest('hex')
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

async function sha256File(pathname, signal) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(pathname)) {
    throwIfWeightVerificationAborted(signal)
    hash.update(chunk)
  }
  throwIfWeightVerificationAborted(signal)
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
    customWorkflows: Array.isArray(value.customWorkflows) ? value.customWorkflows.map((entry) => ({
      ...entry,
      mappingHash: typeof entry?.mappingHash === 'string' ? entry.mappingHash : customMappingHash(entry?.mappings),
    })) : [],
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

function registeredNodeCatalog(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Set)
    ? value
    : null
}

function registeredInputOptions(catalog, nodeType, inputName) {
  const specification = registeredInputSpecification(catalog, nodeType, inputName)
  const options = Array.isArray(specification) ? specification[0] : null
  return Array.isArray(options) && options.every((entry) => typeof entry === 'string') ? options : null
}

function registeredInputSpecification(catalog, nodeType, inputName) {
  const definition = catalog?.[nodeType]?.input
  for (const section of ['required', 'optional']) {
    const specification = definition?.[section]?.[inputName]
    if (Array.isArray(specification)) return specification
  }
  return null
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

function throwIfWeightVerificationAborted(signal) {
  if (signal?.aborted) {
    throw workflowError('固定权重复检已取消', 'WORKFLOW_WEIGHT_VERIFY_CANCELLED', 409)
  }
}

function artifactReferenceAliases(artifact) {
  const normalized = String(artifact?.relativePath || '').replace(/\\/gu, '/')
  const parts = normalized.split('/').filter(Boolean)
  if (parts[0] !== 'models' || parts.length < 3) return new Set()
  return new Set([parts.slice(2).join('/')])
}

function registeredArtifactMatchesValue(artifact, value) {
  return typeof value === 'string' && artifactReferenceAliases(artifact).has(value.replace(/\\/gu, '/'))
}

function collectModelReferences(workflow) {
  const references = []
  const visit = (value, nodeId, nodeType, inputName, depth = 0) => {
    if (depth > 8 || value === null || value === undefined) return
    if (typeof value === 'string') {
      if (MODEL_EXTENSION.test(value)) references.push({ nodeId, nodeType, inputName, value })
      return
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, nodeId, nodeType, inputName, depth + 1)
      return
    }
    if (typeof value !== 'object') return
    for (const [key, entry] of Object.entries(value)) visit(entry, nodeId, nodeType, key, depth + 1)
  }
  for (const [nodeId, node] of Object.entries(workflow || {})) {
    for (const [inputName, value] of Object.entries(node?.inputs || {})) visit(value, nodeId, node?.class_type, inputName)
  }
  return references
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
    if (CUSTOM_OUTPUT_NODE.test(node.class_type)) outputs.push({ nodeId, nodeType: node.class_type })
  }
  return { inputs, outputs }
}

function isApprovedControlMapping(role, nodeType, inputName) {
  const target = CONTROL_MAPPING_TARGETS[role]
  return Boolean(target && target.nodeTypes.includes(nodeType) && target.inputName === inputName)
}

function validateMappings(workflow, mappings, findings) {
  const allowedRoles = new Set(CUSTOM_MAPPING_ROLES)
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
  const mappedTargets = new Map()
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
      if (!CUSTOM_OUTPUT_NODE.test(node.class_type)) {
        findings.push({ severity: 'error', code: 'CUSTOM_WORKFLOW_OUTPUT_NODE', message: 'output 必须映射到受控输出节点' })
      }
    } else if (!Object.prototype.hasOwnProperty.call(node.inputs || {}, mapping.inputName)) {
      findings.push({ severity: 'error', code: 'CUSTOM_WORKFLOW_MAPPING_INPUT', message: `${role} 映射输入不存在` })
    } else {
      const target = `${mapping.nodeId}\0${mapping.inputName}`
      if (mappedTargets.has(target)) {
        findings.push({ severity: 'error', code: 'CUSTOM_WORKFLOW_MAPPING_CONFLICT', message: `${role} 与 ${mappedTargets.get(target)} 不能写入同一输入` })
      } else {
        mappedTargets.set(target, role)
      }
      const currentValue = node.inputs[mapping.inputName]
      if (['prompt', 'negativePrompt'].includes(role) && typeof currentValue !== 'string') {
        findings.push({ severity: 'error', code: 'CUSTOM_WORKFLOW_MAPPING_TYPE', message: `${role} 必须映射到文本输入` })
      }
      if (WORKFLOW_CONTROL_ROLES.has(role) && typeof currentValue !== 'number') {
        findings.push({ severity: 'error', code: 'CUSTOM_WORKFLOW_MAPPING_TYPE', message: `${role} 必须映射到数值输入` })
      }
      if (STRICT_CONTROL_MAPPING_ROLES.has(role) && !isApprovedControlMapping(role, node.class_type, mapping.inputName)) {
        findings.push({ severity: 'error', code: 'CUSTOM_WORKFLOW_MAPPING_ROLE_TARGET', message: `${role} 只能映射到批准的节点输入` })
      }
      if (['sourceImage', 'lastFrame'].includes(role) && (node.class_type !== CUSTOM_IMAGE_INPUT_NODE || mapping.inputName !== 'image')) {
        findings.push({ severity: 'error', code: 'CUSTOM_WORKFLOW_FILE_MAPPING', message: `${role} 只能映射到 LoadImage.image，由光阴砚上传受管资源` })
      }
      if (!['sourceImage', 'lastFrame'].includes(role)
        && !STRICT_CONTROL_MAPPING_ROLES.has(role)
        && DYNAMIC_INPUT_DENYLIST.test(mapping.inputName)) {
        findings.push({ severity: 'error', code: 'CUSTOM_WORKFLOW_MAPPING_SENSITIVE_INPUT', message: `${role} 不得映射到模型、文件、设备、格式或凭据输入` })
      }
    }
  }
  const managedFileMappings = new Set(['sourceImage', 'lastFrame'].flatMap((role) => {
    const mapping = mappings?.[role]
    return mapping ? [`${mapping.nodeId}\0${mapping.inputName}`] : []
  }))
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (node.class_type !== CUSTOM_IMAGE_INPUT_NODE || !Object.prototype.hasOwnProperty.call(node.inputs || {}, 'image')) continue
    if (!managedFileMappings.has(`${nodeId}\0image`)) {
      findings.push({ severity: 'error', code: 'CUSTOM_WORKFLOW_UNMAPPED_FILE_INPUT', message: `LoadImage 节点 ${nodeId} 必须映射为 sourceImage 或 lastFrame` })
    }
  }
}

function validateRegisteredMappingTypes(workflow, mappings, catalog, findings) {
  if (!catalog || !mappings || typeof mappings !== 'object' || Array.isArray(mappings)) return
  for (const [role, mapping] of Object.entries(mappings)) {
    if (role === 'output' || !mapping || typeof mapping !== 'object') continue
    const node = workflow[mapping.nodeId]
    if (!node || typeof mapping.inputName !== 'string') continue
    const specification = registeredInputSpecification(catalog, node.class_type, mapping.inputName)
    if (!specification) {
      findings.push({ severity: 'error', code: 'CUSTOM_WORKFLOW_MAPPING_RUNTIME_INPUT', message: `${role} 映射输入未在当前节点契约中注册` })
      continue
    }
    const inputType = specification[0]
    if (['prompt', 'negativePrompt'].includes(role) && inputType !== 'STRING') {
      findings.push({ severity: 'error', code: 'CUSTOM_WORKFLOW_MAPPING_RUNTIME_TYPE', message: `${role} 必须映射到运行时 STRING 输入` })
    }
    if (WORKFLOW_CONTROL_ROLES.has(role)) {
      const expectedType = WORKFLOW_CONTROL_FIELDS[role].integer ? 'INT' : 'FLOAT'
      if (inputType !== expectedType) {
        findings.push({ severity: 'error', code: 'CUSTOM_WORKFLOW_MAPPING_RUNTIME_TYPE', message: `${role} 必须映射到运行时 ${expectedType} 输入` })
      }
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
  const nodeCatalog = registeredNodeCatalog(registeredNodeTypes)
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
    if (!DEFAULT_SAFE_COMFY_NODE_TYPES.has(nodeType)) findings.push({ severity: 'error', code: 'CUSTOM_WORKFLOW_NODE_NOT_APPROVED', message: `${nodeType} 尚未进入光阴砚批准节点清单` })
    if (!registered.has(nodeType)) findings.push({ severity: 'error', code: 'CUSTOM_WORKFLOW_UNKNOWN_NODE', message: `${nodeType} 未在当前运行时注册` })
    if (!node.inputs || typeof node.inputs !== 'object' || Array.isArray(node.inputs)) {
      findings.push({ severity: 'error', code: 'CUSTOM_WORKFLOW_INPUTS', message: `节点 ${nodeId} 缺少 inputs 对象` })
      continue
    }
    for (const key of Object.keys(node.inputs)) {
      if (SECRET_INPUT.test(key)) findings.push({ severity: 'error', code: 'CUSTOM_WORKFLOW_SECRET_FIELD', message: `节点 ${nodeId}.${key} 可能包含密钥` })
      const value = node.inputs[key]
      if (nodeCatalog && typeof value === 'string' && MODEL_EXTENSION.test(value)) {
        const options = registeredInputOptions(nodeCatalog, nodeType, key)
        if (!options || !options.includes(value)) {
          findings.push({ severity: 'error', code: 'CUSTOM_WORKFLOW_MODEL_MISSING', message: `${nodeType}.${key} 引用的模型未出现在当前运行时选项中` })
        }
      }
    }
    scanInputValue(node.inputs, { findings, models }, `${nodeId}.inputs`)
  }
  validateMappings(parsed, mappings, findings)
  validateRegisteredMappingTypes(parsed, mappings, nodeCatalog, findings)
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

function assertManagedComfyFilename(value, role) {
  if (
    typeof value !== 'string'
    || !value
    || value.length > 240
    || value.includes('\0')
    || isAbsolute(value)
    || WINDOWS_ABSOLUTE.test(value)
    || UNC_PATH.test(value)
    || value.startsWith('/')
    || TRAVERSAL_SEGMENT.test(value)
    || value.split(/[\\/]/u).some((segment) => !segment || !/^[A-Za-z0-9._-]+$/u.test(segment))
  ) {
    throw workflowError(`${role} 必须来自光阴砚受管输入目录`, 'CUSTOM_WORKFLOW_INPUT_ASSET_INVALID')
  }
  return value.replace(/\\/gu, '/')
}

function normalizeExecutionValues(values, mappings) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw workflowError('自定义工作流执行参数必须是对象', 'CUSTOM_WORKFLOW_PARAMETERS_INVALID')
  }
  const allowed = new Set(CUSTOM_MAPPING_ROLES.filter((role) => role !== 'output'))
  const unknown = Object.keys(values).filter((role) => !allowed.has(role) || !mappings?.[role])
  if (unknown.length) {
    throw workflowError('执行参数包含未映射角色', 'CUSTOM_WORKFLOW_PARAMETER_NOT_MAPPED', 400, { roles: unknown })
  }
  const normalized = {}
  if (mappings.prompt) {
    const prompt = typeof values.prompt === 'string' ? values.prompt.trim() : ''
    if (!prompt || prompt.length > 8_000) throw workflowError('正向提示词需要 1–8000 个字符', 'CUSTOM_WORKFLOW_PROMPT_INVALID')
    normalized.prompt = prompt
  }
  if (mappings.negativePrompt && values.negativePrompt !== undefined) {
    if (typeof values.negativePrompt !== 'string' || values.negativePrompt.length > 8_000) {
      throw workflowError('负向提示词不能超过 8000 个字符', 'CUSTOM_WORKFLOW_PROMPT_INVALID')
    }
    normalized.negativePrompt = values.negativePrompt
  }
  for (const role of ['sourceImage', 'lastFrame']) {
    if (!mappings[role]) continue
    normalized[role] = assertManagedComfyFilename(values[role], role)
  }
  for (const role of WORKFLOW_CONTROL_ROLES) {
    if (!mappings[role] || values[role] === undefined) continue
    try {
      normalized[role] = validateWorkflowControlValue(role, values[role])
    } catch (error) {
      const code = error?.code === 'WORKFLOW_CONTROL_VALUE_RANGE'
        ? 'CUSTOM_WORKFLOW_PARAMETER_RANGE'
        : 'CUSTOM_WORKFLOW_PARAMETER_INVALID'
      throw workflowError(error?.message || `${role} 参数无效`, code)
    }
  }
  return normalized
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

  #custom(customId) {
    const entry = this.state.customWorkflows.find(({ id }) => id === customId)
    if (!entry) throw workflowError('自定义工作流不存在', 'CUSTOM_WORKFLOW_NOT_FOUND', 404)
    return entry
  }

  // @yao-pkg/pkg 6.22 misclassifies await inside private class methods as
  // top-level await. Keep async packaging-boundary methods conventionally
  // internal so the ESM-to-CJS transform includes this module in the snapshot.
  async runtimeRegistry() {
    const configuration = this.getRuntimeConfig() || {}
    return discoverRuntimeRegistry({
      comfyRoot: configuration.comfyRoot || this.getComfyRoot(),
      pythonPath: configuration.pythonPath,
      runtimePackageId: configuration.offlineRuntimePackageId,
      comfyArgs: configuration.comfyArgs,
      modelCategories: registryCategories(this.packs),
    })
  }

  _registeredArtifact(artifactId) {
    const matches = this.packs.flatMap((pack) => pack.artifacts || []).filter(({ id }) => id === artifactId)
    if (!matches.length) throw workflowError(`固定权重未在登记表中找到：${artifactId}`, 'WORKFLOW_WEIGHT_ARTIFACT_UNREGISTERED', 409, { artifactId })
    const [first] = matches
    if (matches.some((artifact) => artifact.sha256 !== first.sha256 || artifact.relativePath !== first.relativePath || artifact.bytes !== first.bytes)) {
      throw workflowError(`固定权重登记存在冲突：${artifactId}`, 'WORKFLOW_WEIGHT_ARTIFACT_CONFLICT', 409, { artifactId })
    }
    if (first.kind !== 'model' || typeof first.relativePath !== 'string' || !/^[a-f0-9]{64}$/u.test(first.sha256 || '')) {
      throw workflowError(`固定权重登记不完整：${artifactId}`, 'WORKFLOW_WEIGHT_ARTIFACT_INVALID', 409, { artifactId })
    }
    return first
  }

  _weightArtifact(role, artifactId) {
    const artifact = this._registeredArtifact(artifactId)
    return { role, id: artifact.id, sha256: artifact.sha256 }
  }

  getVideoWeightSet(profileId, samplingMode) {
    if (typeof profileId !== 'string' || !Object.hasOwn(VIDEO_MODEL_PROFILES, profileId)) {
      throw workflowError('固定 H3 模型 profile 未登记', 'VIDEO_WEIGHT_PROFILE_INVALID')
    }
    if (!VIDEO_WEIGHT_SAMPLING_MODES.has(samplingMode)) {
      throw workflowError('固定 H3 采样模式无效', 'VIDEO_WEIGHT_SAMPLING_MODE_INVALID')
    }
    const profile = VIDEO_MODEL_PROFILES[profileId]
    const ids = profile.artifactIds
    if (!ids || ids.base !== H3_WEIGHT_ARTIFACT_IDS.fp8Base && ids.base !== H3_WEIGHT_ARTIFACT_IDS.int8Base) {
      throw workflowError(`H3 profile 缺少已登记底模：${profileId}`, 'WORKFLOW_WEIGHT_PROFILE_INVALID', 409, { profileId })
    }
    const artifacts = [
      this._weightArtifact('base', ids.base),
      this._weightArtifact('text-encoder', ids.textEncoder),
      this._weightArtifact('video-vae', ids.videoVae),
      this._weightArtifact('audio-vae', ids.audioVae),
      ...(samplingMode === 'turbo' ? [this._weightArtifact('acceleration-lora', ids.accelerationLora)] : []),
    ]
    return validateWorkflowWeightSet({
      schemaVersion: 1,
      registryVersion: VIDEO_WORKFLOW_REGISTRY_VERSION,
      family: 'minimax-h3',
      profileId,
      samplingMode,
      artifacts,
    })
  }

  _customWeightSetForWorkflow(workflow) {
    const entries = Object.entries(workflow || {})
    const nodeTypes = new Set(entries.map(([, node]) => node?.class_type).filter((value) => typeof value === 'string'))
    const references = collectModelReferences(workflow)
    const knownArtifacts = this.packs.flatMap((pack) => pack.artifacts || []).filter((artifact) => artifact.kind === 'model')
    const h3ArtifactIds = new Set(Object.values(VIDEO_MODEL_PROFILES).flatMap((profile) => Object.values(profile.artifactIds || {})))
    const h3Signal = [...nodeTypes].some((nodeType) => H3_SIGNAL_NODE_TYPES.has(nodeType))
      || references.some(({ value }) => knownArtifacts.some((artifact) => h3ArtifactIds.has(artifact.id) && registeredArtifactMatchesValue(artifact, value)))
    if (!h3Signal) return null

    const fail = (message, details) => {
      throw workflowError(message, 'CUSTOM_WORKFLOW_WEIGHT_INCOMPATIBLE', 409, details)
    }
    const unetNodes = entries.filter(([, node]) => node?.class_type === 'UNETLoader')
    if (unetNodes.length !== 1 || typeof unetNodes[0][1]?.inputs?.unet_name !== 'string') {
      fail('H3 工作流必须有且只有一个登记的 UNETLoader.unet_name')
    }
    const baseValue = unetNodes[0][1].inputs.unet_name
    const profile = Object.values(VIDEO_MODEL_PROFILES).find((candidate) => {
      let artifact
      try {
        artifact = this._registeredArtifact(candidate.artifactIds?.base)
      } catch (error) {
        if (error.code === 'WORKFLOW_WEIGHT_ARTIFACT_UNREGISTERED') return false
        throw error
      }
      return registeredArtifactMatchesValue(artifact, baseValue)
    })
    if (!profile) fail('H3 底模未匹配到已登记 profile', { input: baseValue })
    const baseNodeId = unetNodes[0][0]
    const expectedByRole = new Map([
      ['base', this._registeredArtifact(profile.artifactIds.base)],
      ['text-encoder', this._registeredArtifact(profile.artifactIds.textEncoder)],
      ['video-vae', this._registeredArtifact(profile.artifactIds.videoVae)],
      ['audio-vae', this._registeredArtifact(profile.artifactIds.audioVae)],
    ])
    const rolePorts = new Map([
      ['base', ['UNETLoader', 'unet_name']],
      ['text-encoder', ['CLIPLoader', 'clip_name']],
      ['video-vae', ['VAELoader', 'vae_name']],
      ['audio-vae', ['VAELoader', 'vae_name']],
    ])
    const matchedRoles = new Set()
    for (const [role, artifact] of expectedByRole) {
      const [nodeType, inputName] = rolePorts.get(role)
      if (references.some((reference) => reference.nodeType === nodeType && reference.inputName === inputName && registeredArtifactMatchesValue(artifact, reference.value))) {
        matchedRoles.add(role)
      } else {
        fail(`H3 工作流缺少登记的 ${role} 加载端口`, { role, artifactId: artifact.id })
      }
    }

    const turboNodes = entries.filter(([, node]) => node?.class_type === 'MiniMaxH3TurboLoRA')
    if (turboNodes.length > 1) fail('H3 Turbo 工作流只能有一个加速 LoRA 节点')
    const samplingMode = turboNodes.length ? 'turbo' : 'base'
    if (!samplingMode || !VIDEO_WEIGHT_SAMPLING_MODES.has(samplingMode)) fail('H3 工作流采样模式无效')
    if (turboNodes.length) {
      const [turboNodeId, turboNode] = turboNodes[0]
      const turboArtifact = this._registeredArtifact(profile.artifactIds.accelerationLora)
      if (!registeredArtifactMatchesValue(turboArtifact, turboNode.inputs?.lora_name)) {
        fail('H3 Turbo 加速 LoRA 未匹配到登记权重', { input: turboNode.inputs?.lora_name })
      }
      if (!Array.isArray(turboNode.inputs?.model) || turboNode.inputs.model[0] !== baseNodeId || turboNode.inputs.model[1] !== 0) {
        fail('H3 Turbo 加速 LoRA 必须直接链接登记的底模输出', { turboNodeId, baseNodeId })
      }
      const consumed = entries.some(([, node]) => Object.values(node?.inputs || {}).some((value) => Array.isArray(value) && value[0] === turboNodeId && value[1] === 0))
      if (!consumed) fail('H3 Turbo 加速 LoRA 未连接到采样链', { turboNodeId })
      expectedByRole.set('acceleration-lora', turboArtifact)
      matchedRoles.add('acceleration-lora')
    }
    const singleNode = (classType) => {
      const matches = entries.filter(([, node]) => node?.class_type === classType)
      if (matches.length !== 1) fail(`H3 固定工作流必须有且只有一个 ${classType} 节点`)
      return matches[0]
    }
    const [guiderNodeId, guiderNode] = singleNode('BasicGuider')
    const [schedulerNodeId, schedulerNode] = singleNode('BasicScheduler')
    const [samplerNodeId, samplerNode] = singleNode('SamplerCustomAdvanced')
    const modelLinkTarget = turboNodes.length ? turboNodes[0][0] : baseNodeId
    if (!Array.isArray(guiderNode.inputs?.model) || guiderNode.inputs.model[0] !== modelLinkTarget || guiderNode.inputs.model[1] !== 0) {
      fail('H3 BasicGuider 未连接固定底模或 Turbo 加速输出', { guiderNodeId, modelLinkTarget })
    }
    if (!Array.isArray(schedulerNode.inputs?.model) || schedulerNode.inputs.model[0] !== modelLinkTarget || schedulerNode.inputs.model[1] !== 0) {
      fail('H3 BasicScheduler 未连接固定底模或 Turbo 加速输出', { schedulerNodeId, modelLinkTarget })
    }
    if (!Array.isArray(samplerNode.inputs?.guider) || samplerNode.inputs.guider[0] !== guiderNodeId || samplerNode.inputs.guider[1] !== 0
      || !Array.isArray(samplerNode.inputs?.sigmas) || samplerNode.inputs.sigmas[0] !== schedulerNodeId || samplerNode.inputs.sigmas[1] !== 0) {
      fail('H3 采样器未连接固定 Guider/Scheduler 链', { samplerNodeId, guiderNodeId, schedulerNodeId })
    }
    const samplerClass = turboNodes.length ? 'MiniMaxH3TurboSampler' : 'KSamplerSelect'
    const samplerEntries = entries.filter(([, node]) => node?.class_type === samplerClass)
    if (samplerEntries.length !== 1 || !Array.isArray(samplerNode.inputs?.sampler)
      || samplerNode.inputs.sampler[0] !== samplerEntries[0][0] || samplerNode.inputs.sampler[1] !== 0) {
      fail(`H3 采样器未连接登记的 ${samplerClass}`, { samplerNodeId, samplerClass })
    }
    const expectedIds = new Set([...expectedByRole.values()].map(({ id }) => id))
    for (const reference of references) {
      const matches = knownArtifacts.filter((artifact) => registeredArtifactMatchesValue(artifact, reference.value))
      if (!matches.length || !expectedIds.has(matches[0].id)) {
        fail('H3 工作流含未登记或不兼容的模型加载路径', reference)
      }
      const role = [...expectedByRole].find(([, artifact]) => artifact.id === matches[0].id)?.[0]
      const [expectedNodeType, expectedInputName] = rolePorts.get(role) || (role === 'acceleration-lora' ? ['MiniMaxH3TurboLoRA', 'lora_name'] : [])
      if (reference.nodeType !== expectedNodeType || reference.inputName !== expectedInputName) {
        fail('H3 登记权重连接到了错误的加载节点或端口', { reference, role })
      }
    }
    if (matchedRoles.size !== expectedByRole.size) fail('H3 工作流固定权重集合不完整')
    return this.getVideoWeightSet(profile.id, samplingMode)
  }

  _customLoraRequirementsForWorkflow(workflow, weightSet = null, mappings = null) {
    const entries = Object.entries(workflow || {})
    const loraEntries = []
    for (const [nodeId, node] of entries) {
      if (!['LoraLoader', 'LoraLoaderModelOnly'].includes(node?.class_type)) continue
      const value = node?.inputs?.lora_name
      if (typeof value !== 'string' || !value.trim()) continue
      const normalized = value.replace(/\\/gu, '/').replace(/^\/+/u, '')
      if (normalized && !normalized.split('/').some((part) => part === '.' || part === '..')) {
        loraEntries.push([nodeId, node, normalized])
      }
    }
    const names = [...new Set(loraEntries.map(([, , name]) => name))]
    if (!loraEntries.length) return null
    let family = weightSet?.family || null
    if (!family) {
      const qwenBaseNodes = new Set(entries
        .filter(([, node]) => node?.class_type === 'UNETLoader'
          && registeredArtifactMatchesValue(ARTIFACTS.qwenImageEdit2511Int8, node?.inputs?.unet_name))
        .map(([nodeId]) => nodeId))
      const mappedStrengthNodeId = mappings?.loraStrength?.nodeId
      const references = collectModelReferences(workflow)
      const connectedQwenLora = loraEntries.some(([nodeId, node]) => (
        nodeId === mappedStrengthNodeId
          && node?.inputs?.strength_model !== undefined
          && Array.isArray(node?.inputs?.model)
          && qwenBaseNodes.has(node.inputs.model[0])
      ))
      if (connectedQwenLora && references.some(({ value }) => registeredArtifactMatchesValue(ARTIFACTS.qwenImageEdit2511Int8, value))) {
        family = 'qwen-image-edit'
      }
    }
    return { family, names: names.sort() }
  }

  getCustomWeightSet(customId) {
    return this._customWeightSetForWorkflow(this.#custom(customId).workflow)
  }

  customLoraRequirements(customId) {
    const entry = this.#custom(customId)
    let weightSet = null
    try {
      weightSet = this._customWeightSetForWorkflow(entry.workflow)
    } catch {
      weightSet = null
    }
    return clone(this._customLoraRequirementsForWorkflow(entry.workflow, weightSet, entry.mappings))
  }

  async verifyRegisteredArtifacts(artifactIds, { signal } = {}) {
    throwIfWeightVerificationAborted(signal)
    if (!Array.isArray(artifactIds) || artifactIds.some((artifactId) => typeof artifactId !== 'string' || !artifactId)) {
      throw workflowError('固定权重 artifact 身份必须是非空字符串数组', 'WORKFLOW_WEIGHT_ARTIFACT_IDS_INVALID', 400)
    }
    const registry = await this.runtimeRegistry()
    throwIfWeightVerificationAborted(signal)
    if (!registry.configured) throw workflowError('请先配置 ComfyUI 运行时', 'WORKFLOW_RUNTIME_UNCONFIGURED', 409)
    const verified = []
    for (const artifactId of artifactIds) {
      throwIfWeightVerificationAborted(signal)
      const artifact = this._registeredArtifact(artifactId)
      const candidates = [...new Map(registeredArtifactCandidates(artifact, registry).map((candidate) => [
        process.platform === 'win32' ? resolve(candidate.targetPath).toLocaleLowerCase('en-US') : resolve(candidate.targetPath),
        candidate,
      ])).values()]
      let existingCount = 0
      for (const candidate of candidates) {
        throwIfWeightVerificationAborted(signal)
        const file = await pathStats(candidate.targetPath)
        if (!file) continue
        existingCount += 1
        if (!file.isFile()) {
          throw workflowError(`${artifact.label} 不是可用文件`, 'WORKFLOW_WEIGHT_KIND_MISMATCH', 409, { artifactId: artifact.id })
        }
        if (artifact.bytes && file.size !== artifact.bytes) {
          throw workflowError(`${artifact.label} 文件大小与登记值不一致`, 'WORKFLOW_WEIGHT_SIZE_MISMATCH', 409, { artifactId: artifact.id })
        }
        if (this._verifiedArtifact(artifact, candidate, file)) {
          continue
        }
        const digest = await sha256File(candidate.targetPath, signal)
        const afterHash = await pathStats(candidate.targetPath)
        if (!afterHash?.isFile() || afterHash.size !== file.size || afterHash.mtimeMs !== file.mtimeMs || afterHash.ctimeMs !== file.ctimeMs) {
          throw workflowError(`${artifact.label} 在哈希检查期间发生变化`, 'WORKFLOW_WEIGHT_CHANGED_DURING_VERIFY', 409, { artifactId: artifact.id })
        }
        if (digest !== artifact.sha256) {
          throw workflowError(`${artifact.label} SHA-256 与登记值不一致`, 'WORKFLOW_WEIGHT_HASH_MISMATCH', 409, { artifactId: artifact.id })
        }
        this.state.verifiedArtifacts[artifactVerificationKey(artifact, candidate.targetPath)] = {
          sha256: digest,
          bytes: file.size,
          mtimeMs: file.mtimeMs,
          ctimeMs: file.ctimeMs,
          verifiedAt: Date.now(),
        }
      }
      if (!existingCount) {
        throw workflowError(`${artifact.label} 尚未安装`, 'WORKFLOW_WEIGHT_MISSING', 409, { artifactId: artifact.id })
      }
      verified.push({ id: artifact.id, sha256: artifact.sha256, bytes: artifact.bytes })
    }
    await this.#save()
    return clone(verified)
  }

  async verifyWeightSet(weightSet, { signal } = {}) {
    throwIfWeightVerificationAborted(signal)
    let normalized
    try {
      normalized = validateWorkflowWeightSet(weightSet)
    } catch (error) {
      throw workflowError(error.message, 'WORKFLOW_WEIGHT_SET_INVALID', 400)
    }
    if (!normalized) throw workflowError('固定权重身份不能为空', 'WORKFLOW_WEIGHT_SET_INVALID', 400)
    const expected = this.getVideoWeightSet(normalized.profileId, normalized.samplingMode)
    try {
      assertWorkflowWeightSetCompatible(normalized, expected)
    } catch (error) {
      throw workflowError('固定权重登记与当前权威集合不一致', 'WORKFLOW_WEIGHT_SET_MISMATCH', 409, { expected, actual: normalized })
    }
    await this.verifyRegisteredArtifacts(expected.artifacts.map(({ id }) => id), { signal })
    return clone(expected)
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
      && verification?.mtimeMs === file.mtimeMs
      && verification?.ctimeMs === file.ctimeMs,
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
    const registry = await this.runtimeRegistry()
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
      customWorkflows: this.state.customWorkflows.map((entry) => this.customExecutionSummary(entry.id)),
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
    const registry = await this.runtimeRegistry()
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
        ctimeMs: targetStats.ctimeMs,
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
      ctimeMs: installed.ctimeMs,
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
      ctimeMs: file.ctimeMs,
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
      const registry = await this.runtimeRegistry()
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
    const registry = await this.runtimeRegistry()
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
          ctimeMs: file.ctimeMs,
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
    try {
      summary.weightSet = this._customWeightSetForWorkflow(result.workflow)
    } catch (error) {
      summary.weightSet = null
      summary.findings = [...summary.findings, {
        severity: 'error',
        code: error.code || 'CUSTOM_WORKFLOW_WEIGHT_INCOMPATIBLE',
        message: error.message,
      }]
      summary.canImport = false
    }
    return summary
  }

  async importCustom({ title, workflow, mappings, registeredNodeTypes }) {
    if (typeof title !== 'string' || !title.trim() || title.trim().length > 120) throw workflowError('自定义工作流名称必须为 1–120 字符', 'CUSTOM_WORKFLOW_TITLE')
    const inspection = inspectCustomWorkflow({ workflow, mappings, registeredNodeTypes })
    if (!inspection.canImport) throw workflowError('自定义工作流未通过安全检查', 'CUSTOM_WORKFLOW_REJECTED', 409, { findings: inspection.findings })
    const weightSet = this._customWeightSetForWorkflow(inspection.workflow)
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
      mappingHash: customMappingHash(inspection.mappings),
      enabled: false,
      source: 'user-api-json',
      createdAt: now,
      updatedAt: now,
      weightSet,
      workflow: inspection.workflow,
    }
    this.state.customWorkflows.push(entry)
    await this.#save()
    const { workflow: _workflow, ...summary } = entry
    return clone(summary)
  }

  async setCustomEnabled(customId, enabled, registeredNodeTypes) {
    const entry = this.#custom(customId)
    if (enabled) {
      const inspection = inspectCustomWorkflow({ workflow: entry.workflow, mappings: entry.mappings, registeredNodeTypes })
      const mappingHash = customMappingHash(entry.mappings)
      if (!inspection.canImport || inspection.hash !== entry.hash || mappingHash !== entry.mappingHash) {
        throw workflowError('工作流版本、映射或运行时依赖已变化，必须重新导入', 'CUSTOM_WORKFLOW_RECHECK_REQUIRED', 409, { findings: inspection.findings })
      }
      const weightSet = this._customWeightSetForWorkflow(inspection.workflow)
      if (JSON.stringify(weightSet) !== JSON.stringify(entry.weightSet ?? null)) {
        throw workflowError('工作流固定权重身份已经变化，必须重新导入', 'CUSTOM_WORKFLOW_WEIGHT_RECHECK_REQUIRED', 409, { weightSet })
      }
    }
    entry.enabled = Boolean(enabled)
    entry.updatedAt = Date.now()
    await this.#save()
    const { workflow: _workflow, ...summary } = entry
    return clone(summary)
  }

  customExecutionSummary(customId) {
    const { workflow, ...summary } = this.#custom(customId)
    const outputType = workflow[summary.mappings.output.nodeId]?.class_type || ''
    const outputMediaKind = /Video/u.test(outputType) ? 'video'
      : /Audio/u.test(outputType) ? 'audio'
        : /^(?:SaveImage|SaveAnimated)/u.test(outputType) ? 'image' : 'unknown'
    let weightSet = null
    let weightError = null
    try {
      weightSet = this._customWeightSetForWorkflow(workflow)
    } catch (error) {
      weightError = { code: error.code || 'CUSTOM_WORKFLOW_WEIGHT_INCOMPATIBLE', message: error.message }
    }
    const loraRequirements = this._customLoraRequirementsForWorkflow(workflow, weightSet, summary.mappings)
    return clone({
      ...summary,
      outputMediaKind,
      weightSet,
      ...(loraRequirements ? { loraRequirements } : {}),
      ...(weightError ? { weightError } : {}),
    })
  }

  prepareCustomExecution(customId, { values, registeredNodeTypes, executionId, loraBindings } = {}) {
    const entry = this.#custom(customId)
    if (!entry.enabled) throw workflowError('自定义工作流尚未启用', 'CUSTOM_WORKFLOW_NOT_ENABLED', 409)
    if (typeof executionId !== 'string' || !SAFE_ID.test(executionId)) {
      throw workflowError('自定义工作流执行标识无效', 'CUSTOM_WORKFLOW_EXECUTION_ID_INVALID')
    }
    const inspection = inspectCustomWorkflow({
      workflow: entry.workflow,
      mappings: entry.mappings,
      registeredNodeTypes,
    })
    const mappingHash = customMappingHash(entry.mappings)
    if (!inspection.canImport || inspection.hash !== entry.hash || mappingHash !== entry.mappingHash) {
      throw workflowError('工作流、映射、节点或模型已经变化，本次执行已拒绝', 'CUSTOM_WORKFLOW_RECHECK_REQUIRED', 409, {
        findings: inspection.findings,
      })
    }
    const weightSet = this._customWeightSetForWorkflow(entry.workflow)
    if (JSON.stringify(weightSet) !== JSON.stringify(entry.weightSet ?? null)) {
      throw workflowError('工作流固定权重身份已经变化，本次执行已拒绝', 'CUSTOM_WORKFLOW_WEIGHT_RECHECK_REQUIRED', 409, { weightSet })
    }
    const loraRequirements = this._customLoraRequirementsForWorkflow(entry.workflow, weightSet, entry.mappings)
    const normalizedLoraBindings = assertWorkflowLoraBindingsCompatible(loraBindings ?? [], {
      mappings: entry.mappings,
      loraRequirements,
    })
    const executionValues = { ...(values || {}) }
    if (normalizedLoraBindings.length) {
      if (executionValues.loraStrength === undefined) executionValues.loraStrength = normalizedLoraBindings[0].strength
      const clipBindings = normalizedLoraBindings.filter((binding) => binding.clipStrength !== undefined)
      if (clipBindings.length && executionValues.loraClipStrength === undefined) executionValues.loraClipStrength = clipBindings[0].clipStrength
      assertWorkflowLoraControlsMatchBindings(normalizedLoraBindings, executionValues)
    }
    const normalizedValues = normalizeExecutionValues(executionValues, entry.mappings)
    const prepared = clone(entry.workflow)
    for (const [role, value] of Object.entries(normalizedValues)) {
      const mapping = entry.mappings[role]
      prepared[mapping.nodeId].inputs[mapping.inputName] = value
    }
    const outputMapping = entry.mappings.output
    const outputNode = prepared[outputMapping.nodeId]
    if (Object.prototype.hasOwnProperty.call(outputNode.inputs, 'filename_prefix')) {
      outputNode.inputs.filename_prefix = `AEONQUILL_${executionId}`
    }
    return {
      workflow: prepared,
      metadata: {
        version: CUSTOM_WORKFLOW_EXECUTION_VERSION,
        customWorkflowId: entry.id,
        customWorkflowTitle: entry.title,
        workflowHash: entry.hash,
        mappingHash: entry.mappingHash,
        outputNodeId: outputMapping.nodeId,
        outputNodeType: outputNode.class_type,
        parameterRoles: Object.keys(normalizedValues).sort(),
        nodeCount: entry.nodeCount,
        weightSet,
        ...(normalizedLoraBindings.length ? { loraBindings: normalizedLoraBindings } : {}),
      },
    }
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
