import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_VIDEO_MODEL_PROFILE,
  VIDEO_DELIVERY_DIMENSIONS_720P,
  VIDEO_MODEL_PROFILES,
  VIDEO_NATIVE_DIMENSIONS,
  VIDEO_PRESETS,
  VIDEO_WORKFLOW_REGISTRY_VERSION,
  videoModelProfile,
  videoWorkflowRegistryCatalog,
} from './video-workflow-registry.mjs'
import {
  compileH3Prompt,
  h3PromptAgentCatalog,
} from '../src/lib/video/h3PromptAgent.mjs'

const workflowDirectory = fileURLToPath(new URL('./workflows/', import.meta.url))

const WORKFLOW_FILES = {
  'text-to-video': 'minimax-h3-t2v.json',
  'image-to-video': 'minimax-h3-i2v.json',
}

export const WORKFLOW_VERSION = 'h3-multiscene-fp8-v3'
export const VIDEO_DIMENSIONS = VIDEO_NATIVE_DIMENSIONS.standard
export { VIDEO_PRESETS }

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

export async function validateBundledWorkflowTemplates() {
  const checks = []
  for (const mode of Object.keys(WORKFLOW_FILES)) {
    const template = await readTemplate(mode)
    assertAllowedWorkflow(template)
    checks.push({
      mode,
      filename: WORKFLOW_FILES[mode],
      nodes: Object.keys(template).length,
    })
  }
  return {
    version: WORKFLOW_VERSION,
    templates: checks,
  }
}

function safeOutputPrefix(jobId, mode) {
  const safeId = jobId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)
  return `AEONQUILL/${mode === 'image-to-video' ? 'I2V' : 'T2V'}_${safeId}`
}

export async function buildVideoWorkflow({
  mode,
  prompt,
  scenario = 'auto',
  aspectRatio,
  duration,
  preset,
  seed,
  audio,
  director,
  modelProfile = DEFAULT_VIDEO_MODEL_PROFILE,
  inputImageName,
  lastFrameImageName,
  jobId,
  frameCount,
}) {
  const workflow = await readTemplate(mode)
  const presetConfig = VIDEO_PRESETS[preset]
  const profile = videoModelProfile(modelProfile)
  const dimensions = VIDEO_NATIVE_DIMENSIONS[presetConfig?.nativeScale || 'standard']?.[aspectRatio]
  const length = frameCount ?? VIDEO_DURATIONS[duration]

  if (!dimensions) throw new Error(`Unsupported aspect ratio: ${aspectRatio}`)
  if (!presetConfig) throw new Error(`Unsupported quality preset: ${preset}`)
  if (!length) throw new Error(`Unsupported duration: ${duration}`)
  if (mode === 'image-to-video' && !inputImageName) {
    throw new Error('Image-to-video workflow requires an uploaded first frame')
  }

  const promptPlan = compileH3Prompt({
    mode,
    sourcePrompt: prompt,
    scenario,
    aspectRatio,
    duration,
    frameCount: length,
    audio,
    hasLastFrame: Boolean(lastFrameImageName),
    director,
  })

  workflow['1'].inputs.unet_name = profile.unetName
  workflow['2'].inputs.clip_name = profile.clipName
  workflow['3'].inputs.vae_name = profile.videoVaeName
  workflow['4'].inputs.vae_name = profile.audioVaeName
  workflow['5'].inputs.lora_name = profile.loraName
  workflow['5'].inputs.strength = presetConfig.loraStrength
  workflow['5'].inputs.low_vram = presetConfig.lowVram
  workflow['6'].inputs.prompt = promptPlan.compiledPrompt
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
      registryVersion: VIDEO_WORKFLOW_REGISTRY_VERSION,
      modelProfile: profile.id,
      modelPrecision: profile.precision,
      dimensions,
      frames: length,
      fps: 24,
      steps: presetConfig.steps,
      loraStrength: presetConfig.loraStrength,
      lowVram: presetConfig.lowVram,
      audio,
      delivery: presetConfig.delivery,
      preserveNative: presetConfig.preserveNative,
      deliveryDimensions: presetConfig.delivery === '720p-lanczos'
        ? VIDEO_DELIVERY_DIMENSIONS_720P[aspectRatio]
        : dimensions,
      minVramGb: presetConfig.minVramGb,
      validation: presetConfig.validation,
      promptAgent: {
        version: promptPlan.agentVersion,
        mode: promptPlan.mode,
        requestedScenario: promptPlan.requestedScenario,
        resolvedScenario: promptPlan.resolvedScenario,
        effectiveDurationSeconds: promptPlan.effectiveDurationSeconds,
        warnings: promptPlan.warnings,
      },
    },
  }
}

export function workflowCatalog() {
  const registry = videoWorkflowRegistryCatalog()
  return {
    version: WORKFLOW_VERSION,
    registry,
    promptAgent: h3PromptAgentCatalog(),
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
    presets: registry.presets,
  }
}

export const REQUIRED_MODEL_FILES = Object.freeze(Object.values(VIDEO_MODEL_PROFILES).flatMap((profile) => [
  ['UNETLoader', 'unet_name', profile.unetName],
  ['CLIPLoader', 'clip_name', profile.clipName],
  ['VAELoader', 'vae_name', profile.videoVaeName],
  ['VAELoader', 'vae_name', profile.audioVaeName],
  ['MiniMaxH3TurboLoRA', 'lora_name', profile.loraName],
]))
