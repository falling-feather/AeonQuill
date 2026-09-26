import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { builtinWorkflowPacks, WorkflowCenterService } from '../server/workflow-center.mjs'

const PROFILE_ARTIFACTS = {
  base: {
    id: 'h3-fl2va-fp8',
    relativePath: 'models/diffusion_models/minimax_h3_fl2va_pruned_fp8_scaled.safetensors',
  },
  'text-encoder': {
    id: 'h3-qwen3vl-nvfp4',
    relativePath: 'models/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
  },
  'video-vae': {
    id: 'h3-video-vae',
    relativePath: 'models/vae/minimax_h3_video_vae_fp16.safetensors',
  },
  'audio-vae': {
    id: 'h3-audio-vae',
    relativePath: 'models/vae/minimax_h3_audio_vae_fp32.safetensors',
  },
  'acceleration-lora': {
    id: 'h3-turbo-lora-v4',
    relativePath: 'models/loras/minimax_h3_turbo_v4_step600_ema.safetensors',
  },
}

function fixturePack() {
  const artifacts = Object.values(PROFILE_ARTIFACTS).map(({ id, relativePath }) => {
    const payload = Buffer.from(`registered-fixture:${id}`)
    return {
      id,
      kind: 'model',
      label: id,
      relativePath,
      bytes: payload.length,
      sha256: createHash('sha256').update(payload).digest('hex'),
      sourceUrl: 'https://example.com/fixture',
      licenseId: 'fixture-license',
      payload,
    }
  })
  return {
    id: 'fixture-h3-pack',
    version: 'test',
    category: 'video',
    title: 'Fixture H3 pack',
    summary: 'Structural verification fixture',
    capabilities: ['test'],
    maturity: 'test',
    minVramGb: 1,
    recommendedVramGb: 1,
    minSystemRamGb: 1,
    estimatedMinutes: '<1',
    runtime: {},
    license: {
      id: 'fixture-license', name: 'Fixture', spdx: null, acceptanceRequired: false,
      commercialUse: 'test', redistribution: 'test', sourceUrl: 'https://example.com/license', notice: 'fixture',
    },
    artifacts,
    requiredNodes: [],
    sourceUrl: 'https://example.com/fixture',
  }
}

async function fixtureService() {
  const root = await mkdtemp(join(tmpdir(), 'aeonquill-fixed-weights-'))
  const comfyRoot = join(root, 'ComfyUI')
  const pack = fixturePack()
  for (const artifact of pack.artifacts) {
    const pathname = join(comfyRoot, artifact.relativePath)
    await mkdir(join(pathname, '..'), { recursive: true })
    await writeFile(pathname, artifact.payload)
  }
  const service = new WorkflowCenterService({
    rootDirectory: join(root, 'state'),
    getComfyRoot: () => comfyRoot,
    packs: [pack],
  })
  await service.open()
  return { root, service, pack }
}

function turboWorkflow() {
  return {
    1: { class_type: 'UNETLoader', inputs: { unet_name: 'minimax_h3_fl2va_pruned_fp8_scaled.safetensors' } },
    2: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: 'minimax_h3_video_vae_fp16.safetensors' } },
    4: { class_type: 'VAELoader', inputs: { vae_name: 'minimax_h3_audio_vae_fp32.safetensors' } },
    5: {
      class_type: 'MiniMaxH3TurboLoRA',
      inputs: { model: ['1', 0], lora_name: 'minimax_h3_turbo_v4_step600_ema.safetensors', strength: 1 },
    },
    6: { class_type: 'MiniMaxH3ImageToVideo', inputs: { prompt: 'fixture', clip: ['2', 0], vae: ['3', 0] } },
    8: { class_type: 'BasicGuider', inputs: { model: ['5', 0], conditioning: ['6', 0] } },
    9: { class_type: 'MiniMaxH3TurboSampler', inputs: {} },
    10: { class_type: 'BasicScheduler', inputs: { model: ['5', 0] } },
    11: { class_type: 'SamplerCustomAdvanced', inputs: { guider: ['8', 0], sampler: ['9', 0], sigmas: ['10', 0] } },
    7: { class_type: 'SaveVideo', inputs: { video: ['11', 0], filename_prefix: 'fixture' } },
  }
}

const turboMappings = {
  prompt: { nodeId: '6', inputName: 'prompt' },
  output: { nodeId: '7' },
}

test('fixed H3 weight sets bind all shared artifacts and keep the role order stable', async () => {
  const { root, service } = await fixtureService()
  try {
    const weightSet = service.getVideoWeightSet('fp8Scaled4060', 'turbo')
    assert.deepEqual(weightSet.artifacts.map(({ role }) => role), [
      'base', 'text-encoder', 'video-vae', 'audio-vae', 'acceleration-lora',
    ])
    assert.equal(weightSet.schemaVersion, 1)
    assert.equal(weightSet.registryVersion, 'aeonquill-h3-registry-v2')
    assert.equal(weightSet.family, 'minimax-h3')
    assert.equal(weightSet.profileId, 'fp8Scaled4060')
    assert.equal(weightSet.samplingMode, 'turbo')
    assert.equal(weightSet.artifacts[0].id, 'h3-fl2va-fp8')
    assert.match(weightSet.artifacts[0].sha256, /^[a-f0-9]{64}$/u)
    assert.equal(service.getVideoWeightSet('fp8Scaled4060', 'base').artifacts.length, 4)
    assert.throws(() => service.getVideoWeightSet('__proto__', 'base'), (error) => error.code === 'VIDEO_WEIGHT_PROFILE_INVALID')
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('non-H3 registered model families remain ordinary and an empty verification request fails explicitly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aeonquill-non-h3-'))
  const service = new WorkflowCenterService({ rootDirectory: join(root, 'state'), packs: builtinWorkflowPacks() })
  try {
    await service.open()
    const imported = await service.importCustom({
      title: 'Qwen 普通图',
      workflow: {
        1: { class_type: 'UNETLoader', inputs: { unet_name: 'qwen_image_edit_2511_int8_convrot.safetensors' } },
        2: { class_type: 'CLIPTextEncode', inputs: { text: 'fixture' } },
        3: { class_type: 'SaveImage', inputs: { images: ['2', 0] } },
      },
      mappings: { prompt: { nodeId: '2', inputName: 'text' }, output: { nodeId: '3' } },
      registeredNodeTypes: ['UNETLoader', 'CLIPTextEncode', 'SaveImage'],
    })
    assert.equal(service.getCustomWeightSet(imported.id), null)
    await assert.rejects(service.verifyWeightSet(null), (error) => error.code === 'WORKFLOW_WEIGHT_SET_INVALID')
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('fixed weight verification hashes every registered artifact and reuses unchanged metadata', async () => {
  const { root, service } = await fixtureService()
  try {
    const weightSet = service.getVideoWeightSet('fp8Scaled4060', 'turbo')
    const first = await service.verifyWeightSet(weightSet)
    assert.deepEqual(first, weightSet)
    const second = await service.verifyWeightSet(weightSet)
    assert.deepEqual(second, weightSet)
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('fixed verification fails closed when a registered file changes and honors cancellation', async () => {
  const { root, service, pack } = await fixtureService()
  try {
    const weightSet = service.getVideoWeightSet('fp8Scaled4060', 'turbo')
    await assert.rejects(service.verifyWeightSet(weightSet, { signal: AbortSignal.abort() }), (error) => error.code === 'WORKFLOW_WEIGHT_VERIFY_CANCELLED')
    const changed = pack.artifacts.find(({ id }) => id === 'h3-turbo-lora-v4')
    await writeFile(join(root, 'ComfyUI', changed.relativePath), Buffer.from('changed'.padEnd(changed.payload.length, '!')))
    await assert.rejects(service.verifyWeightSet(weightSet), (error) => error.code === 'WORKFLOW_WEIGHT_HASH_MISMATCH')
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('custom fixed H3 workflow identity requires registered loader ports and the Turbo model link', async () => {
  const { root, service } = await fixtureService()
  try {
    const imported = await service.importCustom({
      title: '固定 H3 Turbo', workflow: turboWorkflow(), mappings: turboMappings,
      registeredNodeTypes: ['UNETLoader', 'CLIPLoader', 'VAELoader', 'MiniMaxH3TurboLoRA', 'MiniMaxH3ImageToVideo', 'BasicGuider', 'MiniMaxH3TurboSampler', 'BasicScheduler', 'SamplerCustomAdvanced', 'SaveVideo'],
    })
    assert.deepEqual(service.getCustomWeightSet(imported.id), service.getVideoWeightSet('fp8Scaled4060', 'turbo'))

    const broken = turboWorkflow()
    broken[5].inputs.model = ['2', 0]
    await assert.rejects(service.importCustom({
      title: '错误 H3 链接', workflow: broken, mappings: turboMappings,
      registeredNodeTypes: ['UNETLoader', 'CLIPLoader', 'VAELoader', 'MiniMaxH3TurboLoRA', 'MiniMaxH3ImageToVideo', 'BasicGuider', 'MiniMaxH3TurboSampler', 'BasicScheduler', 'SamplerCustomAdvanced', 'SaveVideo'],
    }), (error) => error.code === 'CUSTOM_WORKFLOW_WEIGHT_INCOMPATIBLE')
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('custom H3 loaders reject category-prefixed references instead of treating them as basename aliases', async () => {
  const { root, service } = await fixtureService()
  try {
    const prefixed = turboWorkflow()
    prefixed[1].inputs.unet_name = 'diffusion_models/minimax_h3_fl2va_pruned_fp8_scaled.safetensors'
    await assert.rejects(service.importCustom({
      title: '错误类别前缀', workflow: prefixed, mappings: turboMappings,
      registeredNodeTypes: ['UNETLoader', 'CLIPLoader', 'VAELoader', 'MiniMaxH3TurboLoRA', 'MiniMaxH3ImageToVideo', 'BasicGuider', 'MiniMaxH3TurboSampler', 'BasicScheduler', 'SamplerCustomAdvanced', 'SaveVideo'],
    }), (error) => error.code === 'CUSTOM_WORKFLOW_WEIGHT_INCOMPATIBLE')
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('fixed verification rejects a bad default-root shadow even when a shared root has the correct same-named file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aeonquill-shadow-'))
  const comfyRoot = join(root, 'ComfyUI')
  const sharedRoot = join(root, 'shared')
  const pack = fixturePack()
  try {
    await mkdir(comfyRoot, { recursive: true })
    await mkdir(sharedRoot, { recursive: true })
    await writeFile(join(comfyRoot, 'extra_model_paths.yaml'), [
      'shared_fixture:',
      '  base_path: ../shared',
      '  diffusion_models: models/diffusion_models',
      '  text_encoders: models/text_encoders',
      '  vae: models/vae',
      '  loras: models/loras',
      '',
    ].join('\n'), 'utf8')
    for (const artifact of pack.artifacts) {
      const sharedPath = join(sharedRoot, artifact.relativePath)
      const defaultPath = join(comfyRoot, artifact.relativePath)
      await mkdir(join(sharedPath, '..'), { recursive: true })
      await mkdir(join(defaultPath, '..'), { recursive: true })
      await writeFile(sharedPath, artifact.payload)
      await writeFile(defaultPath, artifact.payload)
    }
    const shadowed = pack.artifacts.find(({ id }) => id === 'h3-turbo-lora-v4')
    await writeFile(join(comfyRoot, shadowed.relativePath), Buffer.from('shadow'.padEnd(shadowed.payload.length, '!')))
    const service = new WorkflowCenterService({
      rootDirectory: join(root, 'state'), getComfyRoot: () => comfyRoot, packs: [pack],
    })
    await service.open()
    try {
      await assert.rejects(service.verifyWeightSet(service.getVideoWeightSet('fp8Scaled4060', 'turbo')), (error) => error.code === 'WORKFLOW_WEIGHT_HASH_MISMATCH')
    } finally {
      await service.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ordinary workflows have no trusted fixed weight identity and hidden unknown LoRA is rejected from H3 identity', async () => {
  const { root, service } = await fixtureService()
  try {
    const ordinary = await service.importCustom({
      title: '普通图像',
      workflow: {
        1: { class_type: 'CLIPTextEncode', inputs: { text: 'fixture' } },
        2: { class_type: 'SaveImage', inputs: { images: ['1', 0] } },
      },
      mappings: { prompt: { nodeId: '1', inputName: 'text' }, output: { nodeId: '2' } },
      registeredNodeTypes: ['CLIPTextEncode', 'SaveImage'],
    })
    assert.equal(service.getCustomWeightSet(ordinary.id), null)

    const hidden = turboWorkflow()
    hidden[8] = { class_type: 'LoraLoader', inputs: { lora_name: 'unknown-character.safetensors', model: ['5', 0] } }
    await assert.rejects(service.importCustom({
      title: '隐藏未知 LoRA', workflow: hidden, mappings: turboMappings,
      registeredNodeTypes: ['UNETLoader', 'CLIPLoader', 'VAELoader', 'MiniMaxH3TurboLoRA', 'MiniMaxH3ImageToVideo', 'BasicGuider', 'MiniMaxH3TurboSampler', 'BasicScheduler', 'SamplerCustomAdvanced', 'SaveVideo', 'LoraLoader'],
    }), (error) => error.code === 'CUSTOM_WORKFLOW_WEIGHT_INCOMPATIBLE')
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})
