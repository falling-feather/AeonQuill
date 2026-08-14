import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const workflowDirectory = fileURLToPath(new URL('./workflows/', import.meta.url))

const WORKFLOW_FILES = {
  'text-to-video': 'minimax-h3-t2v.json',
  'image-to-video': 'minimax-h3-i2v.json',
}

export const WORKFLOW_VERSION = 'h3-turbo-v2'

const NATIVE_DIMENSIONS = {
  standard: {
    '16:9': { width: 608, height: 352 },
    '9:16': { width: 352, height: 608 },
    '1:1': { width: 448, height: 448 },
  },
  high: {
    '16:9': { width: 736, height: 416 },
    '9:16': { width: 416, height: 736 },
    '1:1': { width: 544, height: 544 },
  },
}

const DELIVERY_DIMENSIONS_720P = {
  '16:9': { width: 1280, height: 720 },
  '9:16': { width: 720, height: 1280 },
  '1:1': { width: 720, height: 720 },
}

export const VIDEO_DIMENSIONS = NATIVE_DIMENSIONS.standard

export const VIDEO_PRESETS = {
  fast: {
    id: 'fast',
    label: '快速预览',
    description: '4 步采样与低显存合并，适合 8GB 显卡先看动作。',
    steps: 4,
    lowVram: true,
  },
  balanced: {
    id: 'balanced',
    label: '8GB 细节',
    description: '6 步采样与低显存合并，改善快速运动拖影并保持 8GB 兼容。',
    steps: 6,
    lowVram: true,
    nativeScale: 'standard',
    delivery: 'native',
    minVramGb: 8,
    validation: '本机验证边界：608×352、4 步；6 步档位已通过契约检查，需继续积累实测。',
  },
  delivery720: {
    id: 'delivery720',
    label: '8GB · 720P 交付',
    description: '6 步低显存生成，再由 FFmpeg Lanczos 放大到 720P；提升交付尺寸但不等于原生 720P 细节。',
    steps: 6,
    lowVram: true,
    nativeScale: 'standard',
    delivery: '720p-lanczos',
    minVramGb: 8,
    validation: '生成链路兼容 8GB；720P 后处理不增加 H3 峰值显存。',
  },
  nativeHigh: {
    id: 'nativeHigh',
    label: '原生高清实验',
    description: '提高 H3 原生生成分辨率，预计需要至少 12GB 显存；4060 8GB 不推荐。',
    steps: 8,
    lowVram: true,
    nativeScale: 'high',
    delivery: 'native',
    minVramGb: 12,
    validation: '仅建立受控工作流和显存门槛，尚未在本机 8GB 环境执行。',
  },
}

VIDEO_PRESETS.fast.nativeScale = 'standard'
VIDEO_PRESETS.fast.delivery = 'native'
VIDEO_PRESETS.fast.minVramGb = 8
VIDEO_PRESETS.fast.validation = 'RTX 4060 8GB 已实测 608×352、124 帧、4 步、原生音频。'

export const VIDEO_DURATIONS = {
  5: 124,
  10: 243,
  15: 362,
}

export const REQUIRED_NODE_TYPES = [
  'UNETLoader',
  'CLIPLoader',
  'VAELoader',
  'MiniMaxH3TurboLoRA',
  'MiniMaxH3ImageToVideo',
  'RandomNoise',
  'BasicGuider',
  'MiniMaxH3TurboSampler',
  'BasicScheduler',
  'SamplerCustomAdvanced',
  'VAEDecode',
  'VAEDecodeAudio',
  'CreateVideo',
  'SaveVideo',
  'LoadImage',
]

const ALLOWED_NODE_TYPES_BY_ID = {
  '1': 'UNETLoader',
  '2': 'CLIPLoader',
  '3': 'VAELoader',
  '4': 'VAELoader',
  '5': 'MiniMaxH3TurboLoRA',
  '6': 'MiniMaxH3ImageToVideo',
  '7': 'RandomNoise',
  '8': 'BasicGuider',
  '9': 'MiniMaxH3TurboSampler',
  '10': 'BasicScheduler',
  '11': 'SamplerCustomAdvanced',
  '12': 'VAEDecode',
  '13': 'VAEDecodeAudio',
  '14': 'CreateVideo',
  '15': 'SaveVideo',
  '16': 'LoadImage',
  '17': 'LoadImage',
}

export const ALLOWED_WORKFLOW_NODE_TYPES = new Set(Object.values(ALLOWED_NODE_TYPES_BY_ID))

export function assertAllowedWorkflow(workflow) {
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
    throw Object.assign(new Error('Compiled workflow must be an object'), { code: 'WORKFLOW_NOT_ALLOWED' })
  }
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (!/^\d{1,4}$/.test(nodeId) || !node || typeof node !== 'object' || Array.isArray(node)) {
      throw Object.assign(new Error('Compiled workflow contains an invalid node'), { code: 'WORKFLOW_NOT_ALLOWED' })
    }
    if (ALLOWED_NODE_TYPES_BY_ID[nodeId] !== node.class_type) {
      throw Object.assign(new Error(`Compiled workflow contains an unregistered node mapping: ${nodeId}/${node.class_type}`), {
        code: 'WORKFLOW_NOT_ALLOWED',
      })
    }
  }
  return workflow
}

const templateCache = new Map()

async function readTemplate(mode) {
  if (!WORKFLOW_FILES[mode]) throw new Error(`Unsupported video mode: ${mode}`)
  if (!templateCache.has(mode)) {
    const source = await readFile(`${workflowDirectory}${WORKFLOW_FILES[mode]}`, 'utf8')
    templateCache.set(mode, JSON.parse(source))
  }
  return structuredClone(templateCache.get(mode))
}

function safeOutputPrefix(jobId, mode) {
  const safeId = jobId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)
  return `MiaoHui/${mode === 'image-to-video' ? 'I2V' : 'T2V'}_${safeId}`
}

export async function buildVideoWorkflow({
  mode,
  prompt,
  aspectRatio,
  duration,
  preset,
  seed,
  audio,
  inputImageName,
  lastFrameImageName,
  jobId,
  frameCount,
}) {
  const workflow = await readTemplate(mode)
  const presetConfig = VIDEO_PRESETS[preset]
  const dimensions = NATIVE_DIMENSIONS[presetConfig?.nativeScale || 'standard']?.[aspectRatio]
  const length = frameCount ?? VIDEO_DURATIONS[duration]

  if (!dimensions) throw new Error(`Unsupported aspect ratio: ${aspectRatio}`)
  if (!presetConfig) throw new Error(`Unsupported quality preset: ${preset}`)
  if (!length) throw new Error(`Unsupported duration: ${duration}`)
  if (mode === 'image-to-video' && !inputImageName) {
    throw new Error('Image-to-video workflow requires an uploaded first frame')
  }

  workflow['5'].inputs.low_vram = presetConfig.lowVram
  workflow['6'].inputs.prompt = prompt
  workflow['6'].inputs.width = dimensions.width
  workflow['6'].inputs.height = dimensions.height
  workflow['6'].inputs.length = length
  workflow['7'].inputs.noise_seed = seed
  workflow['10'].inputs.steps = presetConfig.steps
  workflow['15'].inputs.filename_prefix = safeOutputPrefix(jobId, mode)

  if (mode === 'image-to-video') workflow['16'].inputs.image = inputImageName
  if (mode === 'image-to-video' && lastFrameImageName) {
    workflow['17'] = {
      inputs: { image: lastFrameImageName },
      class_type: 'LoadImage',
      _meta: { title: 'Load optional last frame' },
    }
    workflow['6'].inputs.last_frame = ['17', 0]
  }

  if (!audio) {
    delete workflow['14'].inputs.audio
    delete workflow['13']
    delete workflow['4']
  }

  assertAllowedWorkflow(workflow)

  return {
    workflow,
    metadata: {
      version: WORKFLOW_VERSION,
      dimensions,
      frames: length,
      fps: 24,
      steps: presetConfig.steps,
      lowVram: presetConfig.lowVram,
      audio,
      delivery: presetConfig.delivery,
      deliveryDimensions: presetConfig.delivery === '720p-lanczos'
        ? DELIVERY_DIMENSIONS_720P[aspectRatio]
        : dimensions,
      minVramGb: presetConfig.minVramGb,
      validation: presetConfig.validation,
    },
  }
}

export function workflowCatalog() {
  return {
    version: WORKFLOW_VERSION,
    modes: [
      {
        id: 'text-to-video',
        label: '文生视频',
        description: '从文字描述创建带原生音频的视频。',
        requiresImage: false,
      },
      {
        id: 'image-to-video',
        label: '图生视频',
        description: '将画布图片规范化为首帧，再生成连续动作。',
        requiresImage: true,
      },
    ],
    aspectRatios: Object.entries(VIDEO_DIMENSIONS).map(([id, value]) => ({ id, ...value })),
    durations: Object.entries(VIDEO_DURATIONS).map(([seconds, frames]) => ({
      seconds: Number(seconds),
      frames,
    })),
    presets: Object.values(VIDEO_PRESETS),
  }
}
