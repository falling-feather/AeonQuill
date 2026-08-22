import { VIDEO_POSTPROCESSORS } from './video-workflow-registry.mjs'

export const VIDEO_POSTPROCESS_WORKFLOW_VERSION = 'seedvr2-temporal-720p-v1'

const ALLOWED_NODE_TYPES_BY_ID = Object.freeze({
  '101': 'LoadVideo',
  '102': 'GetVideoComponents',
  '103': 'ResizeImageMaskNode',
  '104': 'SeedVR2Preprocess',
  '105': 'VAELoader',
  '106': 'VAEEncodeTiled',
  '107': 'SeedVR2TemporalChunk',
  '108': 'UNETLoader',
  '109': 'SeedVR2Conditioning',
  '110': 'KSampler',
  '111': 'SeedVR2TemporalMerge',
  '112': 'VAEDecodeTiled',
  '113': 'SeedVR2PostProcessing',
  '114': 'CreateVideo',
  '115': 'SaveVideo',
})

export const REQUIRED_SEEDVR2_NODE_TYPES = Object.freeze(Object.values(ALLOWED_NODE_TYPES_BY_ID))

function fail(code, message) {
  throw Object.assign(new Error(message), { code })
}

export function assertAllowedVideoPostprocessWorkflow(workflow) {
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
    fail('VIDEO_POSTPROCESS_WORKFLOW_NOT_ALLOWED', 'Post-process workflow must be an object')
  }
  const ids = new Set(Object.keys(workflow))
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (ALLOWED_NODE_TYPES_BY_ID[nodeId] !== node?.class_type) {
      fail('VIDEO_POSTPROCESS_WORKFLOW_NOT_ALLOWED', `Unregistered post-process node mapping: ${nodeId}/${node?.class_type}`)
    }
    for (const value of Object.values(node.inputs || {})) {
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && !ids.has(value[0])) {
        fail('VIDEO_POSTPROCESS_WORKFLOW_NOT_ALLOWED', `Node ${nodeId} references missing node ${value[0]}`)
      }
    }
  }
  return workflow
}

function safeOutputPrefix(jobId) {
  const safeId = String(jobId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)
  if (!safeId) fail('INVALID_VIDEO_POSTPROCESS_JOB', 'Post-process job id is empty')
  return `AEONQUILL/SEEDVR2_${safeId}`
}

export function buildSeedVr2VideoWorkflow({
  inputVideoName,
  outputDimensions,
  seed,
  jobId,
  framesPerChunk = 21,
  vaeTileSize = 384,
  temporalOverlap = 1,
  colorCorrection = 'wavelet',
}) {
  const profile = VIDEO_POSTPROCESSORS.seedvr2_3b_int8
  if (!/^[a-zA-Z0-9._/-]+$/.test(String(inputVideoName || '')) || String(inputVideoName).includes('..')) {
    fail('INVALID_VIDEO_POSTPROCESS_INPUT', 'SeedVR2 input must be a managed ComfyUI video reference')
  }
  const width = Number(outputDimensions?.width)
  const height = Number(outputDimensions?.height)
  if (![width, height].every((value) => Number.isSafeInteger(value) && value >= 256 && value <= 4096)) {
    fail('INVALID_VIDEO_POSTPROCESS_DIMENSIONS', 'SeedVR2 output dimensions must be integers from 256 to 4096')
  }
  if (!Number.isSafeInteger(framesPerChunk) || framesPerChunk < 5 || (framesPerChunk - 1) % 4 !== 0) {
    fail('INVALID_VIDEO_POSTPROCESS_CHUNK', 'SeedVR2 frames per chunk must follow 4n+1 and be at least 5')
  }
  if (!Number.isSafeInteger(vaeTileSize) || vaeTileSize < 128 || vaeTileSize > 1024 || vaeTileSize % 64 !== 0) {
    fail('INVALID_VIDEO_POSTPROCESS_TILE', 'SeedVR2 VAE tile size must be a 64-pixel multiple from 128 to 1024')
  }
  if (!Number.isSafeInteger(temporalOverlap) || temporalOverlap < 0 || temporalOverlap > 8) {
    fail('INVALID_VIDEO_POSTPROCESS_OVERLAP', 'SeedVR2 temporal overlap must be an integer from 0 to 8')
  }
  if (!['lab', 'wavelet', 'adain', 'none'].includes(colorCorrection)) {
    fail('INVALID_VIDEO_POSTPROCESS_COLOR', 'Unsupported SeedVR2 color correction')
  }

  const workflow = {
    '101': {
      class_type: 'LoadVideo',
      inputs: { file: inputVideoName },
      _meta: { title: '读取 H3 原生母片' },
    },
    '102': {
      class_type: 'GetVideoComponents',
      inputs: { video: ['101', 0] },
      _meta: { title: '保留原音频与帧率' },
    },
    '103': {
      class_type: 'ResizeImageMaskNode',
      inputs: {
        input: ['102', 0],
        resize_type: 'scale dimensions',
        'resize_type.width': width,
        'resize_type.height': height,
        'resize_type.crop': 'disabled',
        scale_method: 'lanczos',
      },
      _meta: { title: '建立 720P 修复画布' },
    },
    '104': {
      class_type: 'SeedVR2Preprocess',
      inputs: { resized_images: ['103', 0] },
      _meta: { title: 'SeedVR2 预处理' },
    },
    '105': {
      class_type: 'VAELoader',
      inputs: { vae_name: profile.vaeName },
      _meta: { title: 'SeedVR2 VAE' },
    },
    '106': {
      class_type: 'VAEEncodeTiled',
      inputs: {
        pixels: ['104', 0],
        vae: ['105', 0],
        tile_size: vaeTileSize,
        overlap: 64,
        temporal_size: 16,
        temporal_overlap: 4,
      },
      _meta: { title: '低显存分块编码' },
    },
    '107': {
      class_type: 'SeedVR2TemporalChunk',
      inputs: {
        latent: ['106', 0],
        temporal_overlap: temporalOverlap,
        chunking_mode: 'manual',
        'chunking_mode.frames_per_chunk': framesPerChunk,
      },
      _meta: { title: `${framesPerChunk} 帧时序块` },
    },
    '108': {
      class_type: 'UNETLoader',
      inputs: { unet_name: profile.modelName, weight_dtype: 'default' },
      _meta: { title: 'SeedVR2 3B INT8' },
    },
    '109': {
      class_type: 'SeedVR2Conditioning',
      inputs: { model: ['108', 0], vae_conditioning: ['107', 0] },
      _meta: { title: '时序修复条件' },
    },
    '110': {
      class_type: 'KSampler',
      inputs: {
        model: ['108', 0],
        seed: Math.max(0, Number(seed) || 0),
        steps: 1,
        cfg: 1,
        sampler_name: 'euler',
        scheduler: 'simple',
        positive: ['109', 0],
        negative: ['109', 1],
        latent_image: ['107', 0],
        denoise: 1,
      },
      _meta: { title: 'SeedVR2 一步修复' },
    },
    '111': {
      class_type: 'SeedVR2TemporalMerge',
      inputs: { latents: ['110', 0], temporal_overlap: ['107', 1] },
      _meta: { title: '时序块交叠合并' },
    },
    '112': {
      class_type: 'VAEDecodeTiled',
      inputs: {
        samples: ['111', 0],
        vae: ['105', 0],
        tile_size: vaeTileSize,
        overlap: 64,
        temporal_size: 16,
        temporal_overlap: 4,
      },
      _meta: { title: '低显存分块解码' },
    },
    '113': {
      class_type: 'SeedVR2PostProcessing',
      inputs: {
        images: ['112', 0],
        original_resized_images: ['103', 0],
        color_correction_method: colorCorrection,
      },
      _meta: { title: '对齐与颜色稳定' },
    },
    '114': {
      class_type: 'CreateVideo',
      inputs: {
        images: ['113', 0],
        audio: ['102', 1],
        fps: ['102', 2],
        bit_depth: ['102', 3],
      },
      _meta: { title: '回填原音频与帧率' },
    },
    '115': {
      class_type: 'SaveVideo',
      inputs: {
        video: ['114', 0],
        filename_prefix: safeOutputPrefix(jobId),
        format: 'mp4',
        codec: 'auto',
      },
      _meta: { title: '保存 SeedVR2 720P 母版' },
    },
  }
  assertAllowedVideoPostprocessWorkflow(workflow)
  return {
    workflow,
    metadata: {
      version: VIDEO_POSTPROCESS_WORKFLOW_VERSION,
      postprocessor: profile.id,
      model: profile.modelName,
      vae: profile.vaeName,
      outputDimensions: { width, height },
      framesPerChunk,
      vaeTileSize,
      temporalOverlap,
      colorCorrection,
      steps: 1,
      sampler: 'euler',
      scheduler: 'simple',
    },
  }
}
