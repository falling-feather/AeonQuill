import { stat } from 'node:fs/promises'
import {
  QWEN_SEMANTIC_WORKFLOW_VERSION,
} from './semantic-image-workflow.mjs'
import {
  getImageEditPreset,
  IMAGE_EDIT_PRESETS,
} from '../src/lib/imageEditPresets.mjs'
import { ARTIFACTS as REGISTERED_ARTIFACTS } from './workflow-artifacts.mjs'
import {
  discoverRuntimeRegistry,
  registeredArtifactCandidates,
} from './runtime-registry.mjs'

export const SEMANTIC_WORKFLOW_CATALOG_VERSION = 'semantic-image-v2'
export const SEMANTIC_ELEMENT_EXTRACT_OPERATION = 'semantic-element-extract'
export const SEMANTIC_REGION_EDIT_OPERATION = 'semantic-region-edit'
export const SEMANTIC_POINT_EDIT_OPERATION = 'semantic-point-edit'
export const SEMANTIC_PORTRAIT_ADJUST_OPERATION = 'semantic-portrait-adjust'

export const SEMANTIC_QWEN_OPERATIONS = Object.freeze(new Set([
  SEMANTIC_REGION_EDIT_OPERATION,
  SEMANTIC_POINT_EDIT_OPERATION,
  SEMANTIC_PORTRAIT_ADJUST_OPERATION,
]))

const EXTENSIONS = {
  'impact-pack': ['custom_nodes/ComfyUI-Impact-Pack', 'custom_nodes/comfyui-impact-pack'],
  'gguf-loader': ['custom_nodes/ComfyUI-GGUF'],
  'crop-and-stitch': [
    'custom_nodes/ComfyUI-Inpaint-CropAndStitch',
    'custom_nodes/comfyui-inpaint-cropandstitch',
  ],
  ipadapter: ['custom_nodes/ComfyUI_IPAdapter_plus', 'custom_nodes/comfyui_ipadapter_plus'],
}

const ARTIFACTS = {
  'sam-vit-b': {
    candidates: [REGISTERED_ARTIFACTS.samVitB.relativePath],
    minBytes: 350_000_000,
  },
  'qwen-image-edit-2511-int8': {
    candidates: [REGISTERED_ARTIFACTS.qwenImageEdit2511Int8.relativePath],
    minBytes: 20_000_000_000,
  },
  'qwen-image-text-encoder-fp8': {
    candidates: [REGISTERED_ARTIFACTS.qwenImageTextEncoderFp8.relativePath],
    minBytes: 9_000_000_000,
  },
  'qwen-image-vae': {
    candidates: [REGISTERED_ARTIFACTS.qwenImageVae.relativePath],
    minBytes: 250_000_000,
  },
  'qwen-image-edit-2511-lightning4-bf16-v1': {
    candidates: [REGISTERED_ARTIFACTS.qwenLightning4Lora.relativePath],
    minBytes: REGISTERED_ARTIFACTS.qwenLightning4Lora.bytes,
  },
  'flux-kontext-model': {
    candidates: [
      'models/diffusion_models/flux1-dev-kontext_fp8_scaled.safetensors',
      'models/unet/flux1-dev-kontext_fp8_scaled.safetensors',
      'models/diffusion_models/flux1-kontext-dev-Q4_K_M.gguf',
      'models/unet/flux1-kontext-dev-Q4_K_M.gguf',
    ],
    minBytes: 5_000_000_000,
  },
  'flux-t5': {
    candidates: ['models/clip/t5xxl_fp16.safetensors', 'models/clip/t5xxl_fp8_e4m3fn.safetensors'],
    minBytes: 1_000_000_000,
  },
  'flux-clip-l': {
    candidates: ['models/clip/clip_l.safetensors'],
    minBytes: 100_000_000,
  },
  'flux-vae': {
    candidates: ['models/vae/flux-ae.safetensors', 'models/vae/ae.safetensors'],
    minBytes: 100_000_000,
  },
  'portrait-detector': {
    candidates: [
      'models/ultralytics/bbox/face_yolov8m.pt',
      'models/ultralytics/bbox/face_yolov8n.pt',
    ],
    minBytes: 1_000_000,
  },
  'portrait-ipadapter': {
    candidates: [
      'models/ipadapter/ip-adapter-faceid-plusv2_sd15.bin',
      'models/ipadapter/ip-adapter-faceid-plusv2_sdxl.bin',
    ],
    minBytes: 1_000_000,
  },
  'portrait-clip-vision': {
    candidates: [
      'models/clip_vision/CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors',
      'models/clip_vision/CLIP-ViT-bigG-14-laion2B-39B-b160k.safetensors',
    ],
    minBytes: 100_000_000,
  },
}

const DEFINITIONS = [
  {
    id: 'element-extract',
    operation: SEMANTIC_ELEMENT_EXTRACT_OPERATION,
    version: 'impact-sam-v1',
    label: '元素提取',
    description: '通过正负点击提示调用本机 SAM，输出透明元素与可复用蒙版。',
    maturity: 'preview',
    implemented: true,
    executor: { kind: 'comfy-extension-api', adapter: 'impact-sam-v1' },
    requiredExtensions: ['impact-pack'],
    requiredArtifacts: ['sam-vit-b'],
    requiredNodes: ['SAMLoader'],
    allowedNodeTypes: ['SAMLoader', 'LoadImage', 'MaskToImage', 'SaveImage'],
    resources: { class: 'gpu', minVramGb: 4, recommendedVramGb: 6, timeoutSeconds: 180 },
    inputs: {
      sourceImage: { type: 'image', required: true, maxBytes: 20 * 1024 * 1024 },
      positivePoints: { type: 'normalized-points', minItems: 1, maxItems: 32 },
      negativePoints: { type: 'normalized-points', minItems: 0, maxItems: 32 },
      threshold: { type: 'number', min: 0.5, max: 0.99, default: 0.9 },
    },
    outputs: ['transparent-image', 'alpha-mask'],
  },
  {
    id: 'region-edit',
    operation: SEMANTIC_REGION_EDIT_OPERATION,
    version: QWEN_SEMANTIC_WORKFLOW_VERSION,
    label: '元素 / 区域编辑',
    description: '使用 Qwen Image Edit 2511 与受控蒙版合成修改选定区域，未选区域直接保留原图像素。',
    maturity: 'preview',
    implemented: true,
    executor: { kind: 'comfy-workflow', adapter: QWEN_SEMANTIC_WORKFLOW_VERSION },
    requiredExtensions: [],
    requiredArtifacts: ['qwen-image-edit-2511-int8', 'qwen-image-text-encoder-fp8', 'qwen-image-vae'],
    requiredNodes: [
      'LoadImage',
      'UNETLoader',
      'ModelSamplingAuraFlow',
      'CFGNorm',
      'CLIPLoader',
      'VAELoader',
      'FluxKontextImageScale',
      'TextEncodeQwenImageEditPlus',
      'FluxKontextMultiReferenceLatentMethod',
      'VAEEncode',
      'KSampler',
      'VAEDecode',
      'ImageToMask',
      'ImageCompositeMasked',
      'SaveImage',
    ],
    allowedNodeTypes: [
      'LoadImage',
      'UNETLoader',
      'ModelSamplingAuraFlow',
      'CFGNorm',
      'CLIPLoader',
      'VAELoader',
      'FluxKontextImageScale',
      'TextEncodeQwenImageEditPlus',
      'FluxKontextMultiReferenceLatentMethod',
      'VAEEncode',
      'KSampler',
      'VAEDecode',
      'ImageToMask',
      'ImageCompositeMasked',
      'SaveImage',
    ],
    resources: { class: 'gpu', minVramGb: 8, recommendedVramGb: 8, timeoutSeconds: 3_600 },
    inputs: {
      sourceImage: { type: 'image', required: true },
      mask: { type: 'mask', required: true },
      instruction: { type: 'string', minLength: 2, maxLength: 2_000 },
      seed: { type: 'integer', min: 0, max: Number.MAX_SAFE_INTEGER },
      maskChannel: { type: 'enum', values: ['alpha', 'luma'], default: 'alpha' },
    },
    outputs: ['edited-image'],
  },
  {
    id: 'point-edit',
    operation: SEMANTIC_POINT_EDIT_OPERATION,
    version: QWEN_SEMANTIC_WORKFLOW_VERSION,
    label: '定点修改',
    description: '把正负点击通过本机 SAM 编译为蒙版，再进入 Qwen 2511 固定局部编辑与原图合成流程。',
    maturity: 'preview',
    implemented: true,
    executor: { kind: 'composite', adapter: `impact-sam+${QWEN_SEMANTIC_WORKFLOW_VERSION}` },
    requiredExtensions: ['impact-pack'],
    requiredArtifacts: [
      'sam-vit-b',
      'qwen-image-edit-2511-int8',
      'qwen-image-text-encoder-fp8',
      'qwen-image-vae',
    ],
    requiredNodes: [
      'SAMLoader', 'LoadImage', 'FluxKontextImageScale', 'UNETLoader', 'ModelSamplingAuraFlow',
      'CFGNorm', 'CLIPLoader', 'VAELoader', 'TextEncodeQwenImageEditPlus',
      'FluxKontextMultiReferenceLatentMethod', 'VAEEncode', 'KSampler', 'VAEDecode',
      'ImageToMask', 'ImageCompositeMasked', 'SaveImage',
    ],
    allowedNodeTypes: [
      'SAMLoader', 'LoadImage', 'FluxKontextImageScale', 'UNETLoader', 'ModelSamplingAuraFlow',
      'CFGNorm', 'CLIPLoader', 'VAELoader', 'TextEncodeQwenImageEditPlus',
      'FluxKontextMultiReferenceLatentMethod', 'VAEEncode', 'KSampler', 'VAEDecode',
      'ImageToMask', 'ImageCompositeMasked', 'SaveImage',
    ],
    resources: { class: 'gpu', minVramGb: 8, recommendedVramGb: 8, timeoutSeconds: 3_900 },
    inputs: {
      sourceImage: { type: 'image', required: true },
      positivePoints: { type: 'normalized-points', minItems: 1, maxItems: 32 },
      negativePoints: { type: 'normalized-points', minItems: 0, maxItems: 32 },
      instruction: { type: 'string', minLength: 2, maxLength: 2_000 },
      threshold: { type: 'number', min: 0.5, max: 0.99, default: 0.9 },
      seed: { type: 'integer', min: 0, max: Number.MAX_SAFE_INTEGER },
    },
    outputs: ['edited-image', 'alpha-mask'],
  },
  {
    id: 'portrait-adjust',
    operation: SEMANTIC_PORTRAIT_ADJUST_OPERATION,
    version: QWEN_SEMANTIC_WORKFLOW_VERSION,
    label: '人像调整',
    description: '使用 Qwen Image Edit 2511 的人物一致性能力进行表情、服饰与光线调整，并写入身份约束来源。',
    maturity: 'experimental',
    implemented: true,
    executor: { kind: 'comfy-workflow', adapter: QWEN_SEMANTIC_WORKFLOW_VERSION },
    requiredExtensions: [],
    requiredArtifacts: ['qwen-image-edit-2511-int8', 'qwen-image-text-encoder-fp8', 'qwen-image-vae'],
    requiredNodes: [
      'LoadImage', 'FluxKontextImageScale', 'UNETLoader', 'ModelSamplingAuraFlow', 'CFGNorm',
      'CLIPLoader', 'VAELoader', 'TextEncodeQwenImageEditPlus',
      'FluxKontextMultiReferenceLatentMethod', 'VAEEncode', 'KSampler', 'VAEDecode', 'SaveImage',
    ],
    allowedNodeTypes: [
      'LoadImage', 'FluxKontextImageScale', 'UNETLoader', 'ModelSamplingAuraFlow', 'CFGNorm',
      'CLIPLoader', 'VAELoader', 'TextEncodeQwenImageEditPlus',
      'FluxKontextMultiReferenceLatentMethod', 'VAEEncode', 'KSampler', 'VAEDecode', 'SaveImage',
    ],
    resources: { class: 'gpu', minVramGb: 8, recommendedVramGb: 8, timeoutSeconds: 3_600 },
    inputs: {
      sourceImage: { type: 'image', required: true },
      instruction: { type: 'string', minLength: 2, maxLength: 1_000 },
      identityStrength: { type: 'number', min: 0, max: 1, default: 0.75 },
    },
    outputs: ['edited-image'],
  },
]

const QWEN_WORKFLOW_IDS = new Set(['region-edit', 'point-edit', 'portrait-adjust'])

function presetRequirements(presetId) {
  const preset = getImageEditPreset(presetId)
  return {
    preset,
    artifactIds: preset.loraArtifactId ? [preset.loraArtifactId] : [],
    nodeTypes: preset.loraArtifactId ? ['LoraLoaderModelOnly'] : [],
  }
}

function clone(value) {
  return structuredClone(value)
}

async function directoryExists(pathname) {
  try {
    return (await stat(pathname)).isDirectory()
  } catch {
    return false
  }
}

async function artifactExists(pathname, minBytes) {
  try {
    const info = await stat(pathname)
    return info.isFile() && info.size >= minBytes
  } catch {
    return false
  }
}

export async function probeLocalSemanticCapabilities(comfyRoot, { runtimeRegistry } = {}) {
  const extensions = new Set()
  const artifacts = new Set()
  const registry = runtimeRegistry ?? await discoverRuntimeRegistry({ comfyRoot })
  if (!registry?.configured) return { extensions, artifacts }

  const registeredCandidates = (relativePath) => registeredArtifactCandidates({ relativePath }, registry)

  await Promise.all([
    ...Object.entries(EXTENSIONS).map(async ([id, candidates]) => {
      for (const relativePath of candidates) {
        for (const candidate of registeredCandidates(relativePath)) {
          if (await directoryExists(candidate.targetPath)) {
            extensions.add(id)
            return
          }
        }
      }
    }),
    ...Object.entries(ARTIFACTS).map(async ([id, descriptor]) => {
      for (const relativePath of descriptor.candidates) {
        for (const candidate of registeredCandidates(relativePath)) {
          if (await artifactExists(candidate.targetPath, descriptor.minBytes)) {
            artifacts.add(id)
            return
          }
        }
      }
    }),
  ])

  return { extensions, artifacts }
}

function publicDefinition(definition, evaluation) {
  return {
    ...clone(definition),
    ...evaluation,
  }
}

export function evaluateSemanticWorkflowCatalog({
  extensions = new Set(),
  artifacts = new Set(),
  objectInfo,
  runtime = {},
} = {}) {
  const extensionSet = extensions instanceof Set ? extensions : new Set(extensions)
  const artifactSet = artifacts instanceof Set ? artifacts : new Set(artifacts)
  const nodeTypes = new Set(Object.keys(objectInfo || {}))
  const connected = runtime.connected === true || Boolean(objectInfo)

  const workflows = DEFINITIONS.map((definition) => {
    const missingExtensions = definition.requiredExtensions.filter((id) => !extensionSet.has(id))
    const missingArtifacts = definition.requiredArtifacts.filter((id) => !artifactSet.has(id))
    const missingNodes = connected
      ? definition.requiredNodes.filter((id) => !nodeTypes.has(id))
      : []
    const installed = missingExtensions.length === 0 && missingArtifacts.length === 0
    const available = definition.implemented && installed && connected && missingNodes.length === 0

    let status = 'ready'
    let message = '本机工作流已就绪'
    if (!definition.implemented) {
      status = 'template-pending'
      message = '依赖盘点已登记，受控模板和质量门禁尚未完成'
    } else if (!installed) {
      status = 'missing-dependency'
      message = '缺少本机扩展或模型文件'
    } else if (!connected) {
      status = 'runtime-stopped'
      message = '本机依赖已安装；启动 ComfyUI 后可执行'
    } else if (missingNodes.length) {
      status = 'node-mismatch'
      message = 'ComfyUI 已连接，但节点注册与受控契约不匹配'
    }

    const evaluated = publicDefinition(definition, {
      available,
      installed,
      status,
      message,
      missingExtensions,
      missingArtifacts,
      missingNodes,
    })
    if (!QWEN_WORKFLOW_IDS.has(definition.id)) return evaluated

    const presets = Object.values(IMAGE_EDIT_PRESETS).map((presetDefinition) => {
      const requirements = presetRequirements(presetDefinition.id)
      const presetMissingArtifacts = [...new Set([
        ...definition.requiredArtifacts,
        ...requirements.artifactIds,
      ])].filter((id) => !artifactSet.has(id))
      const presetMissingNodes = connected
        ? [...new Set([...definition.requiredNodes, ...requirements.nodeTypes])].filter((id) => !nodeTypes.has(id))
        : []
      const presetInstalled = missingExtensions.length === 0 && presetMissingArtifacts.length === 0
      const presetAvailable = definition.implemented && presetInstalled && connected && presetMissingNodes.length === 0

      let presetStatus = 'ready'
      let presetMessage = '本机工作流已就绪'
      if (!definition.implemented) {
        presetStatus = 'template-pending'
        presetMessage = '依赖盘点已登记，受控模板和质量门禁尚未完成'
      } else if (!presetInstalled) {
        presetStatus = 'missing-dependency'
        presetMessage = '缺少本机扩展或模型文件'
      } else if (!connected) {
        presetStatus = 'runtime-stopped'
        presetMessage = '本机依赖已安装；启动 ComfyUI 后可执行'
      } else if (presetMissingNodes.length) {
        presetStatus = 'node-mismatch'
        presetMessage = 'ComfyUI 已连接，但节点注册与受控契约不匹配'
      }

      return {
        id: presetDefinition.id,
        label: presetDefinition.label,
        maturity: presetDefinition.maturity,
        installed: presetInstalled,
        status: presetStatus,
        available: presetAvailable,
        message: presetMessage,
        missingArtifacts: presetMissingArtifacts,
        missingNodes: presetMissingNodes,
      }
    })

    return { ...evaluated, presets }
  })

  return {
    version: SEMANTIC_WORKFLOW_CATALOG_VERSION,
    checkedAt: Date.now(),
    runtime: {
      connected,
      lifecycle: runtime.lifecycle?.state || runtime.lifecycle?.policy || 'unknown',
      device: runtime.device || undefined,
      vramTotal: Number(runtime.vramTotal || 0),
    },
    workflows,
  }
}

export async function probeSemanticWorkflowCatalog({ comfyRoot, objectInfo, runtime, runtimeRegistry } = {}) {
  const local = await probeLocalSemanticCapabilities(comfyRoot, { runtimeRegistry })
  return evaluateSemanticWorkflowCatalog({ ...local, objectInfo, runtime })
}

function assertOnlyKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error(`${label} must be an object`), { status: 400, code: 'INVALID_SEMANTIC_REQUEST' })
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw Object.assign(new Error(`${label} contains an unsupported field: ${key}`), {
        status: 400,
        code: 'INVALID_SEMANTIC_REQUEST',
      })
    }
  }
}

function normalizedPoints(value, label) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 32) {
    throw Object.assign(new Error(`${label} must contain at most 32 points`), {
      status: 400,
      code: 'INVALID_SEMANTIC_POINTS',
    })
  }
  return value.map((point, index) => {
    assertOnlyKeys(point, ['x', 'y'], `${label}[${index}]`)
    const x = Number(point.x)
    const y = Number(point.y)
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
      throw Object.assign(new Error(`${label}[${index}] must use normalized coordinates from 0 to 1`), {
        status: 400,
        code: 'INVALID_SEMANTIC_POINTS',
      })
    }
    return { x, y }
  })
}

const PROJECT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/u
const ASSET_ID = /^[a-f0-9]{64}$/u
const IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,/iu

function semanticError(code, message, status = 400) {
  throw Object.assign(new Error(message), { status, code })
}

function normalizeProjectId(value, required) {
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string' || !PROJECT_ID.test(value)) {
    semanticError('INVALID_SEMANTIC_PROJECT', 'Semantic workflow requires a valid project id')
  }
  return value
}

function normalizeSource(body, prefix, { required = true } = {}) {
  const dataField = `${prefix}ImageDataUrl`
  const assetField = `${prefix}AssetId`
  const dataUrl = body[dataField]
  const assetId = body[assetField]
  const count = Number(dataUrl !== undefined) + Number(assetId !== undefined)
  if ((required && count !== 1) || (!required && count > 1)) {
    semanticError(
      'INVALID_SEMANTIC_INPUT',
      `${prefix} image must use exactly one managed asset id or supported data URL`,
    )
  }
  if (!count) return { kind: 'none' }
  if (dataUrl !== undefined) {
    if (typeof dataUrl !== 'string' || !IMAGE_DATA_URL.test(dataUrl)) {
      semanticError('INVALID_SEMANTIC_INPUT', `${dataField} must be a PNG, JPEG or WebP data URL`)
    }
    return { kind: 'upload' }
  }
  if (typeof assetId !== 'string' || !ASSET_ID.test(assetId)) {
    semanticError('INVALID_SEMANTIC_INPUT', `${assetField} must be a lowercase SHA-256 asset id`)
  }
  return { kind: 'asset', assetId }
}

function normalizeInstruction(value, maximum = 2_000) {
  const instruction = typeof value === 'string' ? value.trim() : ''
  if (instruction.length < 2 || instruction.length > maximum) {
    semanticError('INVALID_SEMANTIC_INSTRUCTION', `instruction must contain 2-${maximum} characters`)
  }
  return instruction
}

function normalizeSeed(value) {
  const seed = value === undefined ? 0 : Number(value)
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > Number.MAX_SAFE_INTEGER) {
    semanticError('INVALID_SEMANTIC_SEED', 'seed must be a safe non-negative integer')
  }
  return seed
}

function normalizeThreshold(value) {
  const threshold = value === undefined ? 0.9 : Number(value)
  if (!Number.isFinite(threshold) || threshold < 0.5 || threshold > 0.99) {
    semanticError('INVALID_SEMANTIC_THRESHOLD', 'threshold must be from 0.5 to 0.99')
  }
  return threshold
}

function normalizePointsParams(params, { instruction = false, seed = false } = {}) {
  const positivePoints = normalizedPoints(params.positivePoints, 'positivePoints')
  const negativePoints = normalizedPoints(params.negativePoints, 'negativePoints')
  if (!positivePoints.length) {
    semanticError('INVALID_SEMANTIC_POINTS', 'Semantic point workflow requires at least one positive point')
  }
  if (positivePoints.length + negativePoints.length > 32) {
    semanticError('INVALID_SEMANTIC_POINTS', 'Semantic point workflow accepts at most 32 points in total')
  }
  return {
    positivePoints,
    negativePoints,
    threshold: normalizeThreshold(params.threshold),
    ...(instruction ? { instruction: normalizeInstruction(params.instruction) } : {}),
    ...(seed ? { seed: normalizeSeed(params.seed) } : {}),
  }
}

function commonRequest(body, workflowId, operation, {
  projectRequired = true,
  maskRequired = false,
  workflowVersion,
} = {}) {
  const projectId = normalizeProjectId(body.projectId, projectRequired)
  const source = normalizeSource(body, 'source')
  const mask = normalizeSource(body, 'mask', { required: maskRequired })
  if ((source.kind === 'asset' || mask.kind === 'asset') && !projectId) {
    semanticError('INVALID_SEMANTIC_PROJECT', 'Managed semantic assets require project context')
  }
  const title = body.title === undefined ? undefined : String(body.title).trim()
  if (title !== undefined && (!title || title.length > 120)) {
    semanticError('INVALID_SEMANTIC_TITLE', 'Semantic output title must contain 1-120 characters')
  }
  return {
    operation,
    workflowId,
    workflowVersion: workflowVersion || (workflowId === 'element-extract' ? 'impact-sam-v1' : QWEN_SEMANTIC_WORKFLOW_VERSION),
    ...(projectId ? { projectId } : {}),
    ...(source.assetId ? { sourceAssetId: source.assetId } : {}),
    ...(mask.assetId ? { maskAssetId: mask.assetId } : {}),
    ...(title ? { title } : {}),
    sourceElementId: typeof body.sourceElementId === 'string'
      ? body.sourceElementId.slice(0, 200)
      : undefined,
  }
}

export function validateSemanticImageRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    semanticError('INVALID_SEMANTIC_REQUEST', 'Semantic request must be an object')
  }
  const workflowId = body.workflowId
  if (!DEFINITIONS.some((definition) => definition.id === workflowId && definition.implemented)) {
    semanticError('SEMANTIC_WORKFLOW_NOT_EXECUTABLE', 'Semantic workflow is not registered for execution')
  }
  const commonKeys = ['workflowId', 'projectId', 'sourceImageDataUrl', 'sourceAssetId', 'sourceElementId', 'title', 'params']
  const params = body.params ?? {}
  if (workflowId === 'element-extract') {
    assertOnlyKeys(body, commonKeys, 'request')
    assertOnlyKeys(params, ['positivePoints', 'negativePoints', 'threshold'], 'params')
    return {
      ...commonRequest(body, workflowId, SEMANTIC_ELEMENT_EXTRACT_OPERATION, { projectRequired: false }),
      params: normalizePointsParams(params),
    }
  }
  if (workflowId === 'region-edit') {
    assertOnlyKeys(body, [...commonKeys, 'maskImageDataUrl', 'maskAssetId'], 'request')
    assertOnlyKeys(params, ['instruction', 'seed', 'maskChannel', 'preset'], 'params')
    const preset = getImageEditPreset(params.preset)
    const maskChannel = params.maskChannel === undefined ? 'alpha' : params.maskChannel
    if (!['alpha', 'luma'].includes(maskChannel)) {
      semanticError('INVALID_SEMANTIC_MASK', 'maskChannel must be alpha or luma')
    }
    return {
      ...commonRequest(body, workflowId, SEMANTIC_REGION_EDIT_OPERATION, { maskRequired: true, workflowVersion: preset.version }),
      params: {
        instruction: normalizeInstruction(params.instruction),
        seed: normalizeSeed(params.seed),
        maskChannel,
        ...(preset.id === 'base40' ? {} : { preset: preset.id }),
      },
    }
  }
  if (workflowId === 'point-edit') {
    assertOnlyKeys(body, commonKeys, 'request')
    assertOnlyKeys(params, ['positivePoints', 'negativePoints', 'threshold', 'instruction', 'seed', 'preset'], 'params')
    const preset = getImageEditPreset(params.preset)
    return {
      ...commonRequest(body, workflowId, SEMANTIC_POINT_EDIT_OPERATION, { workflowVersion: preset.version }),
      params: {
        ...normalizePointsParams(params, { instruction: true, seed: true }),
        ...(preset.id === 'base40' ? {} : { preset: preset.id }),
      },
    }
  }
  assertOnlyKeys(body, commonKeys, 'request')
  assertOnlyKeys(params, ['instruction', 'identityStrength', 'seed', 'preset'], 'params')
  const preset = getImageEditPreset(params.preset)
  const identityStrength = params.identityStrength === undefined ? 0.8 : Number(params.identityStrength)
  if (!Number.isFinite(identityStrength) || identityStrength < 0 || identityStrength > 1) {
    semanticError('INVALID_SEMANTIC_IDENTITY_STRENGTH', 'identityStrength must be from 0 to 1')
  }
  return {
    ...commonRequest(body, workflowId, SEMANTIC_PORTRAIT_ADJUST_OPERATION, { workflowVersion: preset.version }),
    params: {
      instruction: normalizeInstruction(params.instruction, 1_000),
      identityStrength,
      seed: normalizeSeed(params.seed),
      ...(preset.id === 'base40' ? {} : { preset: preset.id }),
    },
  }
}

export function validateElementExtractRequest(body) {
  if (body?.workflowId !== 'element-extract') {
    semanticError('SEMANTIC_WORKFLOW_NOT_EXECUTABLE', 'Only element-extract is accepted by this compatibility validator')
  }
  return validateSemanticImageRequest(body)
}

export function semanticWorkflowDefinitions() {
  return clone(DEFINITIONS)
}
