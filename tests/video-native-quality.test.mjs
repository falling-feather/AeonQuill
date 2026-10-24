import assert from 'node:assert/strict'
import test from 'node:test'
import { buildVideoWorkflow } from '../server/workflow-builder.mjs'
import { DEFAULT_RUNTIME_REQUIREMENTS, VIDEO_MODEL_PROFILES, inspectVideoCapabilities, resolveVideoModelProfile } from '../server/video-workflow-registry.mjs'
import { VIDEO_PRESET_IDS, VIDEO_PRESETS, VIDEO_PRESET_PRESENTATIONS } from '../src/lib/video/videoPresetPolicy.mjs'

function nativeRequest(overrides = {}) {
  return { mode: 'text-to-video', prompt: 'A fixed camera studying wet stone, fine paper fibres and warm reflected light.', scenario: 'cinematic', aspectRatio: '16:9', duration: 5, preset: 'nativeBase', modelProfile: 'int8ConvrotCu130', seed: 20261024, audio: true, jobId: 'native-base-regression', ...overrides }
}

function objectInfo() {
  const profiles = Object.values(VIDEO_MODEL_PROFILES)
  const info = Object.fromEntries([...DEFAULT_RUNTIME_REQUIREMENTS.requiredNodes, 'KSamplerSelect'].map(name => [name, {}]))
  info.UNETLoader = { input: { required: { unet_name: [profiles.map(p => p.unetName)] } } }
  info.CLIPLoader = { input: { required: { clip_name: [profiles.map(p => p.clipName)] } } }
  info.VAELoader = { input: { required: { vae_name: [profiles.flatMap(p => [p.videoVaeName, p.audioVaeName])] } } }
  info.MiniMaxH3TurboLoRA = { input: { required: { lora_name: [profiles.map(p => p.loraName)] } } }
  return info
}

test('native Base quality retains target-resolution sampling, 20 steps and original audio without Turbo or upscaling', async () => {
  for (const mode of ['text-to-video', 'image-to-video']) {
    const { workflow, metadata } = await buildVideoWorkflow(nativeRequest({ mode, ...(mode === 'image-to-video' ? { inputImageName: 'first.png', lastFrameImageName: 'last.png' } : {}) }))
    assert.deepEqual(metadata.dimensions, { width: 1344, height: 768 })
    assert.deepEqual(metadata.deliveryDimensions, metadata.dimensions)
    assert.equal(metadata.delivery, 'native')
    assert.equal(metadata.frames, 124)
    assert.equal(metadata.steps, 20)
    assert.equal(metadata.samplingMode, 'base')
    assert.equal(metadata.postprocessor, null)
    assert.equal(workflow['5'], undefined)
    assert.equal(workflow['9'].inputs.sampler_name, 'res_multistep')
    assert.equal(workflow['18'].class_type, 'MiniMaxLowVRAMAttention')
    assert.deepEqual(workflow['18'].inputs, { model: ['1', 0], head_chunks: 8 })
    assert.equal(workflow['19'].class_type, 'MiniMaxChunkFeedForward')
    assert.deepEqual(workflow['19'].inputs, { model: ['18', 0], chunks: 4, seq_threshold: 4096 })
    assert.deepEqual(workflow['8'].inputs.model, ['19', 0])
    assert.deepEqual(workflow['10'].inputs.model, ['19', 0])
    assert.deepEqual(workflow['14'].inputs.audio, ['13', 0])
    assert.equal(Object.values(workflow).some(node => /Upscal|Resize|Interpol/.test(node.class_type)), false)
  }
})

test('native Base rejects unvalidated quantization families and long clips instead of downgrading', async () => {
  await assert.rejects(buildVideoWorkflow(nativeRequest({ modelProfile: 'fp8Scaled4060' })), error => error.code === 'VIDEO_PRESET_MODEL_UNSUPPORTED')
  await assert.rejects(buildVideoWorkflow(nativeRequest({ duration: 10 })), error => error.code === 'VIDEO_PRESET_DURATION_UNSUPPORTED')
  await assert.rejects(buildVideoWorkflow(nativeRequest({ frameCount: 243 })), error => error.code === 'VIDEO_PRESET_FRAME_COUNT_UNSUPPORTED')
})

test('native Base requires both memory nodes, while existing presets remain available', () => {
  const info = objectInfo()
  const runtime = { comfyVersion: '0.31.0', pytorchVersion: '2.12.1+cu130' }
  const withoutNodes = inspectVideoCapabilities(info, runtime)
  const native = withoutNodes.presets.find(p => p.id === 'nativeBase')
  assert.ok(native)
  assert.equal(native.available, false)
  assert.deepEqual(new Set(native.missingNodes), new Set(['MiniMaxLowVRAMAttention', 'MiniMaxChunkFeedForward']))
  assert.equal(withoutNodes.presets.find(p => p.id === 'cinemaBase').available, true)
  assert.equal(withoutNodes.presets.find(p => p.id === 'nativeHigh').available, true)
  info.MiniMaxLowVRAMAttention = {}
  assert.equal(inspectVideoCapabilities(info, runtime).presets.find(p => p.id === 'nativeBase').available, false)
  info.MiniMaxChunkFeedForward = {}
  const available = inspectVideoCapabilities(info, runtime)
  assert.deepEqual(available.presets.find(p => p.id === 'nativeBase').availableProfiles, ['int8ConvrotCu130'])
  assert.equal(resolveVideoModelProfile('nativeBase', available), 'int8ConvrotCu130')
  assert.throws(() => resolveVideoModelProfile('nativeBase', available, 'fp8Scaled4060'), error => error.code === 'VIDEO_MODEL_PROFILE_UNAVAILABLE')
})

test('both UI consumers describe the actual sampling and delivery dimensions for every aspect ratio', async () => {
  for (const id of VIDEO_PRESET_IDS) {
    const spec = VIDEO_PRESETS[id]
    const presentation = VIDEO_PRESET_PRESENTATIONS[id]
    for (const aspectRatio of ['16:9', '9:16', '1:1']) {
      const { metadata } = await buildVideoWorkflow(nativeRequest({ preset: id, aspectRatio, modelProfile: spec.allowedModelProfiles?.[0] ?? 'fp8Scaled4060' }))
      const native = `${metadata.dimensions.width}×${metadata.dimensions.height}`
      assert.equal(presentation.native[aspectRatio], native)
      assert.equal(presentation.delivery[aspectRatio], `${metadata.deliveryDimensions.width}×${metadata.deliveryDimensions.height}`)
      assert.ok(presentation.nativeSummaryByAspect[aspectRatio].startsWith(native))
    }
  }
})
