import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_RUNTIME_REQUIREMENTS,
  inspectVideoCapabilities,
  resolveVideoModelProfile,
  VIDEO_POSTPROCESSORS,
} from '../server/video-workflow-registry.mjs'
import {
  assertAllowedVideoPostprocessWorkflow,
  buildSeedVr2VideoWorkflow,
  VIDEO_POSTPROCESS_WORKFLOW_VERSION,
} from '../server/video-postprocess-workflow.mjs'

function combo(options) {
  return { input: { required: { value: [options] } } }
}

function objectInfo({ seedVr = false, int8 = false } = {}) {
  const info = {}
  for (const node of new Set([
    ...DEFAULT_RUNTIME_REQUIREMENTS.requiredNodes,
    'KSamplerSelect',
    ...VIDEO_POSTPROCESSORS.seedvr2_3b_int8.requiredNodes,
  ])) info[node] = combo([])
  info.UNETLoader = {
    input: { required: { unet_name: [[
      'minimax_h3_fl2va_pruned_fp8_scaled.safetensors',
      ...(int8 ? ['minimax_h3_fl2va_pruned_int8_convrot.safetensors'] : []),
      ...(seedVr ? ['seedvr2_3b_int8_convrot.safetensors'] : []),
    ]] } },
  }
  info.CLIPLoader = {
    input: { required: { clip_name: [['qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors']] } },
  }
  info.VAELoader = {
    input: { required: { vae_name: [[
      'minimax_h3_video_vae_fp16.safetensors',
      'minimax_h3_audio_vae_fp32.safetensors',
      ...(seedVr ? ['seedvr2_ema_vae_fp16.safetensors'] : []),
    ]] } },
  }
  info.MiniMaxH3TurboLoRA = {
    input: { required: { lora_name: [['minimax_h3_turbo_v4_step600_ema.safetensors']] } },
  }
  return info
}

test('capability routing keeps cu129 on FP8 and never lets an optional candidate break stable presets', () => {
  const capabilities = inspectVideoCapabilities(objectInfo({ int8: true }), {
    comfyVersion: '0.30.2',
    pytorchVersion: '2.8.0+cu129',
  })
  const int8 = capabilities.modelProfiles.find((profile) => profile.id === 'int8ConvrotCu130')
  assert.equal(int8.modes.base.available, false)
  assert.ok(int8.modes.base.runtimeIssues.some((issue) => issue.includes('cu130')))
  assert.equal(capabilities.presets.find((preset) => preset.id === 'cinemaBase').available, true)
  assert.equal(resolveVideoModelProfile('cinemaBase', capabilities), 'fp8Scaled4060')
  assert.equal(capabilities.presets.find((preset) => preset.id === 'master720').available, false)
})

test('master720 becomes available only when both SeedVR2 model files and nodes are registered', () => {
  const capabilities = inspectVideoCapabilities(objectInfo({ seedVr: true }), {
    comfyVersion: '0.30.2',
    pytorchVersion: '2.8.0+cu129',
  })
  const master = capabilities.presets.find((preset) => preset.id === 'master720')
  assert.equal(master.available, true)
  assert.equal(master.postprocessor.available, true)
  assert.equal(resolveVideoModelProfile('master720', capabilities), 'fp8Scaled4060')
})

test('builds a bounded 720p SeedVR2 workflow with temporal chunks and source audio', () => {
  const { workflow, metadata } = buildSeedVr2VideoWorkflow({
    inputVideoName: 'aeonquill-native.mp4',
    outputDimensions: { width: 1280, height: 720 },
    seed: 9,
    jobId: 'video-contract-001',
  })
  assertAllowedVideoPostprocessWorkflow(workflow)
  assert.equal(Object.keys(workflow).length, 15)
  assert.equal(workflow['103'].inputs['resize_type.width'], 1280)
  assert.equal(workflow['103'].inputs['resize_type.height'], 720)
  assert.equal(workflow['107'].inputs['chunking_mode.frames_per_chunk'], 21)
  assert.equal(workflow['106'].inputs.tile_size, 384)
  assert.equal(workflow['112'].inputs.tile_size, 384)
  assert.deepEqual(workflow['114'].inputs.audio, ['102', 1])
  assert.equal(metadata.version, VIDEO_POSTPROCESS_WORKFLOW_VERSION)
  assert.equal(metadata.steps, 1)
})

test('rejects unmanaged video paths and invalid temporal chunk sizes', () => {
  assert.throws(() => buildSeedVr2VideoWorkflow({
    inputVideoName: '../outside.mp4', outputDimensions: { width: 1280, height: 720 }, seed: 1, jobId: 'bad-path',
  }), (error) => error.code === 'INVALID_VIDEO_POSTPROCESS_INPUT')
  assert.throws(() => buildSeedVr2VideoWorkflow({
    inputVideoName: 'source.mp4', outputDimensions: { width: 1280, height: 720 }, seed: 1, jobId: 'bad-chunk', framesPerChunk: 20,
  }), (error) => error.code === 'INVALID_VIDEO_POSTPROCESS_CHUNK')
  assert.throws(() => buildSeedVr2VideoWorkflow({
    inputVideoName: 'source.mp4', outputDimensions: { width: 1280, height: 720 }, seed: 1, jobId: 'bad-tile', vaeTileSize: 300,
  }), (error) => error.code === 'INVALID_VIDEO_POSTPROCESS_TILE')
})
