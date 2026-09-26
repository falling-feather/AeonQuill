import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertAllowedSemanticImageWorkflow,
  buildSemanticImageWorkflow,
  compileSemanticImagePrompt,
  QWEN_SEMANTIC_MODELS,
  QWEN_SEMANTIC_WORKFLOW_VERSION,
} from '../server/semantic-image-workflow.mjs'

test('region edit compiles a fixed 40-step Qwen graph and composites only through the mask', () => {
  const built = buildSemanticImageWorkflow({
    workflowId: 'region-edit',
    sourceImageName: 'aeonquill-source.png',
    maskImageName: 'aeonquill-mask.png',
    instruction: '把衣服改成深蓝色丝绸',
    seed: 42,
    jobId: 'image-region-1',
  })
  assert.equal(built.metadata.version, QWEN_SEMANTIC_WORKFLOW_VERSION)
  assert.equal(built.metadata.masked, true)
  assert.equal(built.workflow['103'].inputs.unet_name, QWEN_SEMANTIC_MODELS.diffusion)
  assert.equal(built.workflow['113'].inputs.steps, 40)
  assert.equal(built.workflow['113'].inputs.cfg, 4)
  assert.equal(built.workflow['113'].inputs.seed, 42)
  assert.deepEqual(built.workflow['117'].inputs.destination, ['101', 0])
  assert.deepEqual(built.workflow['117'].inputs.source, ['114', 0])
  assert.deepEqual(built.workflow['117'].inputs.mask, ['116', 0])
  assert.equal(built.workflow['117'].inputs.resize_source, true)
  assert.deepEqual(built.workflow['118'].inputs.images, ['117', 0])
  assert.match(built.workflow['110'].inputs.prompt, /white region only/u)
  assert.match(built.workflow['110'].inputs.prompt, /深蓝色丝绸/u)
})
test('point edit passes the inferred mask as a second visual reference', () => {
  const built = buildSemanticImageWorkflow({
    workflowId: 'point-edit',
    sourceImageName: 'safe/source.png',
    maskImageName: 'safe/mask.png',
    instruction: '把雨伞换成竹伞',
    seed: 7,
    jobId: 'point-7',
  })
  assert.deepEqual(built.workflow['110'].inputs.image1, ['102', 0])
  assert.deepEqual(built.workflow['110'].inputs.image2, ['115', 0])
  assert.match(built.workflow['110'].inputs.prompt, /user click/u)
  assert.match(built.workflow['110'].inputs.prompt, /竹伞/u)
})

test('portrait adjust uses the unmasked fixed graph and compiles identity strength into constraints', () => {
  const built = buildSemanticImageWorkflow({
    workflowId: 'portrait-adjust',
    sourceImageName: 'portrait.png',
    instruction: '让人物微笑并保留自然皮肤纹理',
    identityStrength: 0.92,
    seed: 0,
    jobId: 'portrait-1',
  })
  assert.equal(built.metadata.masked, false)
  assert.equal('115' in built.workflow, false)
  assert.deepEqual(built.workflow['118'].inputs.images, ['114', 0])
  assert.match(built.workflow['110'].inputs.prompt, /Preserve the person identity exactly/u)
  assert.equal(built.metadata.identityStrength, 0.92)
})

test('lightning4 inserts the fixed model-only LoRA and switches to its sampler parameters', () => {
  const built = buildSemanticImageWorkflow({
    workflowId: 'region-edit',
    preset: 'lightning4',
    sourceImageName: 'source.png',
    maskImageName: 'mask.png',
    instruction: '把衣服改成银色',
    seed: 9,
    jobId: 'lightning-4',
  })
  assert.equal(built.metadata.preset, 'lightning4')
  assert.equal(built.metadata.version, 'qwen-image-edit-2511-int8-lightning4-v1')
  assert.equal(built.metadata.lora.strength, 1)
  assert.equal(built.workflow['119'].class_type, 'LoraLoaderModelOnly')
  assert.deepEqual(built.workflow['119'].inputs.model, ['105', 0])
  assert.equal(built.workflow['119'].inputs.lora_name, 'Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors')
  assert.equal(built.workflow['119'].inputs.strength_model, 1)
  assert.deepEqual(built.workflow['113'].inputs.model, ['119', 0])
  assert.equal(built.workflow['113'].inputs.steps, 4)
  assert.equal(built.workflow['113'].inputs.cfg, 1)
  assert.equal(built.workflow['113'].inputs.sampler_name, 'euler')
  assert.equal(built.workflow['113'].inputs.scheduler, 'simple')
  assert.equal(built.workflow['104'].inputs.shift, 3.1)
})

test('lightning4 fixed graph rejects changed LoRA strength and sampling parameters', () => {
  const built = buildSemanticImageWorkflow({
    workflowId: 'portrait-adjust',
    preset: 'lightning4',
    sourceImageName: 'portrait.png',
    instruction: '调整光线',
    jobId: 'lightning-tamper',
  })
  built.workflow['119'].inputs.strength_model = 0.5
  assert.throws(
    () => assertAllowedSemanticImageWorkflow('portrait-adjust', built.workflow, 'lightning4'),
    (error) => error.code === 'SEMANTIC_WORKFLOW_NOT_ALLOWED',
  )

  const second = buildSemanticImageWorkflow({
    workflowId: 'portrait-adjust',
    preset: 'lightning4',
    sourceImageName: 'portrait.png',
    instruction: '调整光线',
    jobId: 'lightning-tamper-steps',
  })
  second.workflow['113'].inputs.steps = 40
  assert.throws(
    () => assertAllowedSemanticImageWorkflow('portrait-adjust', second.workflow, 'lightning4'),
    (error) => error.code === 'SEMANTIC_WORKFLOW_NOT_ALLOWED',
  )
})

test('fixed Qwen graph rejects model links that bypass the registered sampling chain', () => {
  const built = buildSemanticImageWorkflow({
    workflowId: 'portrait-adjust',
    sourceImageName: 'portrait.png',
    instruction: '调整光线',
    jobId: 'sampling-link-tamper',
  })
  built.workflow['104'].inputs.model = ['106', 0]
  assert.throws(
    () => assertAllowedSemanticImageWorkflow('portrait-adjust', built.workflow),
    (error) => error.code === 'SEMANTIC_WORKFLOW_NOT_ALLOWED',
  )

  const lightning = buildSemanticImageWorkflow({
    workflowId: 'portrait-adjust',
    preset: 'lightning4',
    sourceImageName: 'portrait.png',
    instruction: '调整光线',
    jobId: 'sampling-link-tamper-lightning',
  })
  lightning.workflow['105'].inputs.model = ['106', 0]
  assert.throws(
    () => assertAllowedSemanticImageWorkflow('portrait-adjust', lightning.workflow, 'lightning4'),
    (error) => error.code === 'SEMANTIC_WORKFLOW_NOT_ALLOWED',
  )
})

test('semantic workflow builder rejects traversal, invalid parameters and graph tampering', () => {
  assert.throws(
    () => buildSemanticImageWorkflow({
      workflowId: 'region-edit', sourceImageName: '../source.png', maskImageName: 'mask.png',
      instruction: '修改颜色', jobId: 'bad-1',
    }),
    (error) => error.code === 'INVALID_SEMANTIC_COMFY_REFERENCE',
  )
  assert.throws(
    () => compileSemanticImagePrompt('portrait-adjust', { instruction: '修改', identityStrength: 2 }),
    (error) => error.code === 'INVALID_SEMANTIC_IDENTITY_STRENGTH',
  )
  const built = buildSemanticImageWorkflow({
    workflowId: 'portrait-adjust', sourceImageName: 'source.png', instruction: '调整光线', jobId: 'safe-1',
  })
  built.workflow['999'] = { class_type: 'HttpDownloadNode', inputs: { url: 'https://example.invalid' } }
  assert.throws(
    () => assertAllowedSemanticImageWorkflow('portrait-adjust', built.workflow),
    (error) => error.code === 'SEMANTIC_WORKFLOW_NOT_ALLOWED',
  )
})
