import { stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

export const SEMANTIC_WORKFLOW_CATALOG_VERSION = 'semantic-image-v1'
export const SEMANTIC_ELEMENT_EXTRACT_OPERATION = 'semantic-element-extract'

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
    candidates: ['models/sams/sam_vit_b_01ec64.pth'],
    minBytes: 350_000_000,
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
    version: 'flux-kontext-region-v0',
    label: '元素 / 区域编辑',
    description: '使用受控 Flux Kontext 与局部合成模板修改选定区域，保持未选区域可追踪。',
    maturity: 'experimental',
    implemented: false,
    executor: { kind: 'comfy-workflow', adapter: 'flux-kontext-region-v0' },
    requiredExtensions: ['gguf-loader', 'crop-and-stitch'],
    requiredArtifacts: ['flux-kontext-model', 'flux-t5', 'flux-clip-l', 'flux-vae'],
    requiredNodes: [
      'LoadImage',
      'UNETLoader',
      'UnetLoaderGGUF',
      'DualCLIPLoader',
      'VAELoader',
      'CLIPTextEncode',
      'FluxKontextImageScale',
      'ReferenceLatent',
      'SamplerCustomAdvanced',
      'VAEDecode',
      'SaveImage',
    ],
    allowedNodeTypes: [
      'LoadImage',
      'UNETLoader',
      'UnetLoaderGGUF',
      'DualCLIPLoader',
      'VAELoader',
      'CLIPTextEncode',
      'FluxGuidance',
      'FluxKontextImageScale',
      'ReferenceLatent',
      'VAEEncode',
      'EmptySD3LatentImage',
      'ModelSamplingFlux',
      'RandomNoise',
      'KSamplerSelect',
      'BasicScheduler',
      'BasicGuider',
      'SamplerCustomAdvanced',
      'VAEDecode',
      'SaveImage',
    ],
    resources: { class: 'gpu', minVramGb: 8, recommendedVramGb: 12, timeoutSeconds: 1_800 },
    inputs: {
      sourceImage: { type: 'image', required: true },
      mask: { type: 'mask', required: true },
      instruction: { type: 'string', minLength: 2, maxLength: 2_000 },
      seed: { type: 'integer', min: 0, max: Number.MAX_SAFE_INTEGER },
    },
    outputs: ['edited-image'],
  },
  {
    id: 'point-edit',
    version: 'sam-kontext-point-v0',
    label: '定点修改',
    description: '把点击提示编译为蒙版，再进入受控局部编辑与合成流程。',
    maturity: 'planned',
    implemented: false,
    executor: { kind: 'composite', adapter: 'sam-kontext-point-v0' },
    requiredExtensions: ['impact-pack', 'gguf-loader', 'crop-and-stitch'],
    requiredArtifacts: ['sam-vit-b', 'flux-kontext-model', 'flux-t5', 'flux-clip-l', 'flux-vae'],
    requiredNodes: ['SAMLoader', 'ReferenceLatent', 'SamplerCustomAdvanced', 'SaveImage'],
    allowedNodeTypes: ['SAMLoader', 'ReferenceLatent', 'SamplerCustomAdvanced', 'SaveImage'],
    resources: { class: 'gpu', minVramGb: 8, recommendedVramGb: 12, timeoutSeconds: 2_100 },
    inputs: {
      sourceImage: { type: 'image', required: true },
      positivePoints: { type: 'normalized-points', minItems: 1, maxItems: 32 },
      negativePoints: { type: 'normalized-points', minItems: 0, maxItems: 32 },
      instruction: { type: 'string', minLength: 2, maxLength: 2_000 },
    },
    outputs: ['edited-image', 'alpha-mask'],
  },
  {
    id: 'portrait-adjust',
    version: 'impact-faceid-v0',
    label: '人像调整',
    description: '面向人脸局部细化、表情与身份约束的实验工作流；模型许可和真实人像基准完成前不开放执行。',
    maturity: 'planned',
    implemented: false,
    executor: { kind: 'comfy-workflow', adapter: 'impact-faceid-v0' },
    requiredExtensions: ['impact-pack', 'ipadapter'],
    requiredArtifacts: ['portrait-detector', 'portrait-ipadapter', 'portrait-clip-vision'],
    requiredNodes: ['FaceDetailer', 'SAMLoader', 'IPAdapterAdvanced'],
    allowedNodeTypes: ['FaceDetailer', 'SAMLoader', 'IPAdapterAdvanced', 'LoadImage', 'SaveImage'],
    resources: { class: 'gpu', minVramGb: 8, recommendedVramGb: 12, timeoutSeconds: 1_800 },
    inputs: {
      sourceImage: { type: 'image', required: true },
      instruction: { type: 'string', minLength: 2, maxLength: 1_000 },
      identityStrength: { type: 'number', min: 0, max: 1, default: 0.75 },
    },
    outputs: ['edited-image'],
  },
]

function clone(value) {
  return structuredClone(value)
}

function assertInsideRoot(rootDirectory, relativePath) {
  const root = resolve(rootDirectory)
  const candidate = resolve(root, relativePath)
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw Object.assign(new Error('Semantic workflow capability path escaped the ComfyUI root'), {
      code: 'SEMANTIC_CAPABILITY_PATH_INVALID',
    })
  }
  return candidate
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

export async function probeLocalSemanticCapabilities(comfyRoot) {
  const extensions = new Set()
  const artifacts = new Set()
  if (typeof comfyRoot !== 'string' || !comfyRoot) return { extensions, artifacts }

  await Promise.all([
    ...Object.entries(EXTENSIONS).map(async ([id, candidates]) => {
      for (const relativePath of candidates) {
        if (await directoryExists(assertInsideRoot(comfyRoot, relativePath))) {
          extensions.add(id)
          return
        }
      }
    }),
    ...Object.entries(ARTIFACTS).map(async ([id, descriptor]) => {
      for (const relativePath of descriptor.candidates) {
        if (await artifactExists(assertInsideRoot(comfyRoot, relativePath), descriptor.minBytes)) {
          artifacts.add(id)
          return
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

    return publicDefinition(definition, {
      available,
      installed,
      status,
      message,
      missingExtensions,
      missingArtifacts,
      missingNodes,
    })
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

export async function probeSemanticWorkflowCatalog({ comfyRoot, objectInfo, runtime } = {}) {
  const local = await probeLocalSemanticCapabilities(comfyRoot)
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

export function validateElementExtractRequest(body) {
  assertOnlyKeys(body, ['workflowId', 'sourceImageDataUrl', 'sourceElementId', 'params'], 'request')
  if (body.workflowId !== 'element-extract') {
    throw Object.assign(new Error('Only the registered element-extract workflow is executable'), {
      status: 400,
      code: 'SEMANTIC_WORKFLOW_NOT_EXECUTABLE',
    })
  }
  const params = body.params ?? {}
  assertOnlyKeys(params, ['positivePoints', 'negativePoints', 'threshold'], 'params')
  const positivePoints = normalizedPoints(params.positivePoints, 'positivePoints')
  const negativePoints = normalizedPoints(params.negativePoints, 'negativePoints')
  if (!positivePoints.length) {
    throw Object.assign(new Error('element-extract requires at least one positive point'), {
      status: 400,
      code: 'INVALID_SEMANTIC_POINTS',
    })
  }
  if (positivePoints.length + negativePoints.length > 32) {
    throw Object.assign(new Error('element-extract accepts at most 32 points in total'), {
      status: 400,
      code: 'INVALID_SEMANTIC_POINTS',
    })
  }
  const threshold = params.threshold === undefined ? 0.9 : Number(params.threshold)
  if (!Number.isFinite(threshold) || threshold < 0.5 || threshold > 0.99) {
    throw Object.assign(new Error('threshold must be from 0.5 to 0.99'), {
      status: 400,
      code: 'INVALID_SEMANTIC_THRESHOLD',
    })
  }
  return {
    operation: SEMANTIC_ELEMENT_EXTRACT_OPERATION,
    workflowId: 'element-extract',
    workflowVersion: 'impact-sam-v1',
    params: { positivePoints, negativePoints, threshold },
    sourceElementId: typeof body.sourceElementId === 'string'
      ? body.sourceElementId.slice(0, 200)
      : undefined,
  }
}

export function semanticWorkflowDefinitions() {
  return clone(DEFINITIONS)
}
