import { assertVideoPresetModelProfile, VIDEO_DURATION_FRAMES } from '../src/lib/video/videoPresetPolicy.mjs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_RUNTIME_REQUIREMENTS,
  DEFAULT_VIDEO_MODEL_PROFILE,
  VIDEO_DELIVERY_DIMENSIONS_720P,
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

export const WORKFLOW_VERSION = 'h3-quality-matrix-v4'
export const VIDEO_DIMENSIONS = VIDEO_NATIVE_DIMENSIONS.preview
export { VIDEO_PRESETS }

export const VIDEO_DURATIONS = VIDEO_DURATION_FRAMES

export const REQUIRED_NODE_TYPES = [...new Set([...DEFAULT_RUNTIME_REQUIREMENTS.requiredNodes, 'KSamplerSelect'])]

const ALLOWED_NODE_TYPES_BY_ID = {
  '1': 'UNETLoader',
  '2': 'CLIPLoader',
  '3': 'VAELoader',
  '4': 'VAELoader',
  '5': new Set(['MiniMaxH3TurboLoRA']),
  '6': 'MiniMaxH3ImageToVideo',
  '7': 'RandomNoise',
  '8': 'BasicGuider',
  '9': new Set(['MiniMaxH3TurboSampler', 'KSamplerSelect']),
  '10': 'BasicScheduler',
  '11': 'SamplerCustomAdvanced',
  '12': 'VAEDecode',
  '13': 'VAEDecodeAudio',
  '14': 'CreateVideo',
  '15': 'SaveVideo',
  '16': 'LoadImage',
  '17': 'LoadImage',
  '18': 'MiniMaxLowVRAMAttention',
  '19': 'MiniMaxChunkFeedForward',
}

export const ALLOWED_WORKFLOW_NODE_TYPES = new Set(Object.values(ALLOWED_NODE_TYPES_BY_ID).flatMap((value) => value instanceof Set ? [...value] : [value]))

export function assertAllowedWorkflow(workflow) {
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
    throw Object.assign(new Error('Compiled workflow must be an object'), { code: 'WORKFLOW_NOT_ALLOWED' })
  }
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (!/^\d{1,4}$/.test(nodeId) || !node || typeof node !== 'object' || Array.isArray(node)) {
      throw Object.assign(new Error('Compiled workflow contains an invalid node'), { code: 'WORKFLOW_NOT_ALLOWED' })
    }
    const allowed = ALLOWED_NODE_TYPES_BY_ID[nodeId]
    if (!(allowed instanceof Set ? allowed.has(node.class_type) : allowed === node.class_type)) {
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
  if (!presetConfig.allowedDurations.includes(Number(duration))) {
    throw Object.assign(new Error(`${presetConfig.label} only supports ${presetConfig.allowedDurations.join(' or ')} second clips`), {
      code: 'VIDEO_PRESET_DURATION_UNSUPPORTED',
    })
  }
  const maxFrames = VIDEO_DURATIONS[duration]
  if (!Number.isSafeInteger(length) || length < 5 || length > maxFrames) {
    throw Object.assign(new Error(`${presetConfig.label} supports at most ${maxFrames} frames`), {
      code: 'VIDEO_PRESET_FRAME_COUNT_UNSUPPORTED',
    })
  }
  assertVideoPresetModelProfile(preset, profile.id)
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
  if (presetConfig.samplingMode === 'turbo') {
    workflow['5'].inputs.lora_name = profile.loraName
    workflow['5'].inputs.strength = presetConfig.loraStrength
    workflow['5'].inputs.low_vram = presetConfig.lowVram
  } else {
    delete workflow['5']
    workflow['8'].inputs.model = ['1', 0]
    workflow['9'] = {
      inputs: { sampler_name: presetConfig.sampler },
      class_type: 'KSamplerSelect',
      _meta: { title: 'H3 Base 采样器' },
    }
    workflow['10'].inputs.model = ['1', 0]
  }
  const memory = presetConfig.memoryOptimizationsByDuration?.[duration] ?? presetConfig.memoryOptimizations
  if (memory) {
    workflow['18'] = { class_type: 'MiniMaxLowVRAMAttention', inputs: { model: workflow['8'].inputs.model, head_chunks: memory.headChunks } }
    workflow['19'] = { class_type: 'MiniMaxChunkFeedForward', inputs: { model: ['18', 0], chunks: memory.feedForwardChunks, seq_threshold: memory.tokenThreshold } }
    workflow['8'].inputs.model = ['19', 0]
    workflow['10'].inputs.model = ['19', 0]
  }
  workflow['6'].inputs.prompt = promptPlan.compiledPrompt
  workflow['6'].inputs.width = dimensions.width
  workflow['6'].inputs.height = dimensions.height
  workflow['6'].inputs.length = length
  workflow['7'].inputs.noise_seed = seed
  workflow['10'].inputs.steps = presetConfig.steps
  workflow['15'].inputs.filename_prefix = safeOutputPrefix(jobId, mode)
  const sourceCrf = ['base-master', 'restored-master'].includes(presetConfig.qualityClass)
    ? 8
    : ['quality', 'native-master'].includes(presetConfig.qualityClass) ? 12 : null
  if (sourceCrf !== null) {
    workflow['15'].inputs.format = 'mp4'
    workflow['15'].inputs.codec = 'h264'
    workflow['15'].inputs['codec.encoding'] = 're-encode'
    workflow['15'].inputs['codec.encoding.crf'] = sourceCrf
  }

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
      samplingMode: presetConfig.samplingMode,
      sampler: presetConfig.sampler,
      loraStrength: presetConfig.loraStrength,
      lowVram: presetConfig.lowVram,
      ...(memory ? { memoryOptimizations: memory } : {}),
      audio,
      delivery: presetConfig.delivery,
      preserveNative: presetConfig.preserveNative,
      deliveryDimensions: presetConfig.delivery.startsWith('720p-')
        ? VIDEO_DELIVERY_DIMENSIONS_720P[aspectRatio]
        : dimensions,
      qualityClass: presetConfig.qualityClass,
      allowedDurations: presetConfig.allowedDurations,
      estimatedMinutes: presetConfig.estimatedMinutes[duration],
      postprocessor: presetConfig.postprocessor || null,
      sourceEncoding: sourceCrf === null ? 'auto' : `h264-crf${sourceCrf}`,
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

export function workflowCatalog(capabilities) {
  const registry = videoWorkflowRegistryCatalog(capabilities)
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

export const REQUIRED_MODEL_FILES = DEFAULT_RUNTIME_REQUIREMENTS.requiredModels
