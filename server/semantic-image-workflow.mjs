import { getImageEditPreset } from '../src/lib/imageEditPresets.mjs'
import { ARTIFACTS } from './workflow-artifacts.mjs'

export const QWEN_SEMANTIC_WORKFLOW_VERSION = getImageEditPreset('base40').version
export const QWEN_SEMANTIC_LIGHTNING4_WORKFLOW_VERSION = getImageEditPreset('lightning4').version
export const QWEN_SEMANTIC_PROMPT_VERSION = 'aeonquill-semantic-prompt-v1'

export const QWEN_SEMANTIC_MODELS = Object.freeze({
  diffusion: 'qwen_image_edit_2511_int8_convrot.safetensors',
  textEncoder: 'qwen_2.5_vl_7b_fp8_scaled.safetensors',
  vae: 'qwen_image_vae.safetensors',
})

const MASKED_WORKFLOWS = new Set(['region-edit', 'point-edit'])
const WORKFLOW_IDS = new Set([...MASKED_WORKFLOWS, 'portrait-adjust'])
const SAFE_COMFY_REFERENCE = /^[a-zA-Z0-9._/-]+$/u

const BASE_NODE_TYPES = Object.freeze({
  '101': 'LoadImage',
  '102': 'FluxKontextImageScale',
  '103': 'UNETLoader',
  '104': 'ModelSamplingAuraFlow',
  '105': 'CFGNorm',
  '106': 'CLIPLoader',
  '107': 'VAELoader',
  '108': 'TextEncodeQwenImageEditPlus',
  '109': 'FluxKontextMultiReferenceLatentMethod',
  '110': 'TextEncodeQwenImageEditPlus',
  '111': 'FluxKontextMultiReferenceLatentMethod',
  '112': 'VAEEncode',
  '113': 'KSampler',
  '114': 'VAEDecode',
  '118': 'SaveImage',
})

const MASK_NODE_TYPES = Object.freeze({
  '115': 'LoadImage',
  '116': 'ImageToMask',
  '117': 'ImageCompositeMasked',
})

export const QWEN_SEMANTIC_REQUIRED_NODE_TYPES = Object.freeze([
  ...new Set([...Object.values(BASE_NODE_TYPES), ...Object.values(MASK_NODE_TYPES)]),
])

function fail(code, message) {
  throw Object.assign(new Error(message), { code })
}
function assertManagedReference(value, label) {
  const reference = String(value || '').replace(/\\/gu, '/')
  if (
    !reference
    || !SAFE_COMFY_REFERENCE.test(reference)
    || reference.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    fail('INVALID_SEMANTIC_COMFY_REFERENCE', `${label} must be a managed ComfyUI input reference`)
  }
  return reference
}

function normalizeInstruction(value) {
  const instruction = typeof value === 'string' ? value.trim() : ''
  if (instruction.length < 2 || instruction.length > 2_000) {
    fail('INVALID_SEMANTIC_INSTRUCTION', 'Semantic edit instruction must contain 2-2000 characters')
  }
  return instruction
}

function normalizedIdentityStrength(value) {
  const strength = value === undefined ? 0.8 : Number(value)
  if (!Number.isFinite(strength) || strength < 0 || strength > 1) {
    fail('INVALID_SEMANTIC_IDENTITY_STRENGTH', 'Portrait identity strength must be from 0 to 1')
  }
  return strength
}

export function compileSemanticImagePrompt(workflowId, params = {}) {
  if (!WORKFLOW_IDS.has(workflowId)) {
    fail('SEMANTIC_WORKFLOW_NOT_EXECUTABLE', `Unsupported Qwen semantic workflow: ${workflowId}`)
  }
  const instruction = normalizeInstruction(params.instruction)
  if (workflowId === 'region-edit') {
    return {
      prompt: [
        'Picture 1 is the source image. Picture 2 is a black-and-white edit mask; white marks the only editable region.',
        `Within the white region only, perform this edit: ${instruction}`,
        'Keep the subject identity, camera, perspective, lighting direction and visual style coherent with Picture 1.',
        'Do not add borders, mask colors, guide marks, labels or explanatory text.',
      ].join(' '),
      instruction,
      identityStrength: undefined,
    }
  }
  if (workflowId === 'point-edit') {
    return {
      prompt: [
        'Picture 1 is the source image. Picture 2 is a black-and-white mask inferred from the user click; white marks the selected object.',
        `Edit that selected object according to: ${instruction}`,
        'Preserve all unselected content, subject identity, geometry, camera, lighting and style.',
        'Do not render the mask, points, outlines, labels or explanatory text.',
      ].join(' '),
      instruction,
      identityStrength: undefined,
    }
  }
  const identityStrength = normalizedIdentityStrength(params.identityStrength)
  const identityRule = identityStrength >= 0.85
    ? 'Preserve the person identity exactly: facial proportions, age, skin tone, hairline and distinguishing features must remain stable.'
    : identityStrength >= 0.55
      ? 'Strongly preserve identity, facial proportions, age and distinguishing features.'
      : 'Keep the person recognizably consistent while allowing the requested creative adjustment.'
  return {
    prompt: [
      'Picture 1 is the source portrait.',
      identityRule,
      `Perform this portrait adjustment: ${instruction}`,
      'Keep anatomy natural and retain the original camera, crop and background unless the instruction explicitly requests otherwise.',
      'Do not add labels, watermarks or explanatory text.',
    ].join(' '),
    instruction,
    identityStrength,
  }
}

function safeOutputPrefix(jobId) {
  const safeId = String(jobId || '').replace(/[^a-zA-Z0-9_-]/gu, '').slice(0, 80)
  if (!safeId) fail('INVALID_SEMANTIC_JOB', 'Semantic job id is empty')
  return `AEONQUILL/QWEN_EDIT_${safeId}`
}

function expectedNodeTypes(workflowId, presetId = 'base40') {
  const base = MASKED_WORKFLOWS.has(workflowId)
    ? { ...BASE_NODE_TYPES, ...MASK_NODE_TYPES }
    : BASE_NODE_TYPES
  return presetId === 'lightning4'
    ? { ...base, '119': 'LoraLoaderModelOnly' }
    : base
}

function artifactFilename(artifact) {
  const relativePath = String(artifact?.relativePath || '').replace(/\\/gu, '/')
  return relativePath.split('/').filter(Boolean).at(-1) || ''
}

function assertFixedSemanticImageWorkflowParameters(workflow, presetId) {
  const preset = getImageEditPreset(presetId)
  const sampling = workflow['104']
  const cfgNorm = workflow['105']
  const sampler = workflow['113']
  const expectedModel = presetId === 'lightning4' ? ['119', 0] : ['105', 0]
  if (
    !Array.isArray(sampling?.inputs?.model)
    || sampling.inputs.model[0] !== '103'
    || sampling.inputs.model[1] !== 0
    || sampling.inputs.shift !== preset.shift
  ) {
    fail('SEMANTIC_WORKFLOW_NOT_ALLOWED', 'Semantic workflow sampling shift does not match the fixed preset')
  }
  if (
    !Array.isArray(cfgNorm?.inputs?.model)
    || cfgNorm.inputs.model[0] !== '104'
    || cfgNorm.inputs.model[1] !== 0
    || cfgNorm.inputs.strength !== 1
    || cfgNorm.inputs.pre_cfg !== false
  ) {
    fail('SEMANTIC_WORKFLOW_NOT_ALLOWED', 'Semantic workflow CFGNorm does not match the fixed preset')
  }
  if (
    !Array.isArray(sampler?.inputs?.model)
    || sampler.inputs.model[0] !== expectedModel[0]
    || sampler.inputs.model[1] !== expectedModel[1]
    || sampler.inputs.steps !== preset.steps
    || sampler.inputs.cfg !== preset.cfg
    || sampler.inputs.sampler_name !== preset.sampler
    || sampler.inputs.scheduler !== preset.scheduler
    || sampler.inputs.denoise !== preset.denoise
  ) {
    fail('SEMANTIC_WORKFLOW_NOT_ALLOWED', 'Semantic workflow sampling parameters do not match the fixed preset')
  }
  if (presetId === 'lightning4') {
    const lora = workflow['119']
    const expectedLora = ARTIFACTS.qwenLightning4Lora
    if (
      lora?.class_type !== 'LoraLoaderModelOnly'
      || !Array.isArray(lora.inputs?.model)
      || lora.inputs.model[0] !== '105'
      || lora.inputs.model[1] !== 0
      || lora.inputs.lora_name !== artifactFilename(expectedLora)
      || lora.inputs.strength_model !== preset.loraStrength
    ) {
      fail('SEMANTIC_WORKFLOW_NOT_ALLOWED', 'Semantic Lightning LoRA node does not match the fixed artifact or strength')
    }
  }
}

export function assertAllowedSemanticImageWorkflow(workflowId, workflow, presetId = 'base40') {
  if (!WORKFLOW_IDS.has(workflowId) || !workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
    fail('SEMANTIC_WORKFLOW_NOT_ALLOWED', 'Semantic workflow must use a registered fixed template')
  }
  const preset = getImageEditPreset(presetId)
  const expected = expectedNodeTypes(workflowId, preset.id)
  const ids = new Set(Object.keys(workflow))
  if (ids.size !== Object.keys(expected).length) {
    fail('SEMANTIC_WORKFLOW_NOT_ALLOWED', 'Semantic workflow node count does not match the fixed template')
  }
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (expected[nodeId] !== node?.class_type) {
      fail('SEMANTIC_WORKFLOW_NOT_ALLOWED', `Unregistered semantic node mapping: ${nodeId}/${node?.class_type}`)
    }
    for (const value of Object.values(node.inputs || {})) {
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && !ids.has(value[0])) {
        fail('SEMANTIC_WORKFLOW_NOT_ALLOWED', `Semantic node ${nodeId} references missing node ${value[0]}`)
      }
    }
  }
  assertFixedSemanticImageWorkflowParameters(workflow, preset.id)
  return workflow
}

export function buildSemanticImageWorkflow({
  workflowId,
  preset: requestedPreset = 'base40',
  sourceImageName,
  maskImageName,
  instruction,
  identityStrength,
  seed = 0,
  jobId,
}) {
  if (!WORKFLOW_IDS.has(workflowId)) {
    fail('SEMANTIC_WORKFLOW_NOT_EXECUTABLE', `Unsupported semantic workflow: ${workflowId}`)
  }
  const preset = getImageEditPreset(requestedPreset)
  const source = assertManagedReference(sourceImageName, 'Source image')
  const masked = MASKED_WORKFLOWS.has(workflowId)
  const mask = masked ? assertManagedReference(maskImageName, 'Mask image') : undefined
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > Number.MAX_SAFE_INTEGER) {
    fail('INVALID_SEMANTIC_SEED', 'Semantic seed must be a safe non-negative integer')
  }
  const compiled = compileSemanticImagePrompt(workflowId, { instruction, identityStrength })
  const referenceInputs = masked ? { image1: ['102', 0], image2: ['115', 0] } : { image1: ['102', 0] }
  const decodedOutput = masked ? ['117', 0] : ['114', 0]
  const workflow = {
    '101': {
      class_type: 'LoadImage',
      inputs: { image: source },
      _meta: { title: '读取受管原图' },
    },
    '102': {
      class_type: 'FluxKontextImageScale',
      inputs: { image: ['101', 0] },
      _meta: { title: '规范化为约一百万像素' },
    },
    '103': {
      class_type: 'UNETLoader',
      inputs: { unet_name: QWEN_SEMANTIC_MODELS.diffusion, weight_dtype: 'default' },
      _meta: { title: 'Qwen Image Edit 2511 INT8 ConvRot' },
    },
    '104': {
      class_type: 'ModelSamplingAuraFlow',
      inputs: { model: ['103', 0], shift: preset.shift },
      _meta: { title: 'Qwen 2511 采样位移' },
    },
    '105': {
      class_type: 'CFGNorm',
      inputs: { model: ['104', 0], strength: 1, pre_cfg: false },
      _meta: { title: 'CFG 归一化' },
    },
    '106': {
      class_type: 'CLIPLoader',
      inputs: { clip_name: QWEN_SEMANTIC_MODELS.textEncoder, type: 'qwen_image', device: 'default' },
      _meta: { title: 'Qwen2.5-VL 7B FP8' },
    },
    '107': {
      class_type: 'VAELoader',
      inputs: { vae_name: QWEN_SEMANTIC_MODELS.vae },
      _meta: { title: 'Qwen Image VAE' },
    },
    '108': {
      class_type: 'TextEncodeQwenImageEditPlus',
      inputs: { clip: ['106', 0], prompt: '', vae: ['107', 0], ...referenceInputs },
      _meta: { title: '空负向条件' },
    },
    '109': {
      class_type: 'FluxKontextMultiReferenceLatentMethod',
      inputs: { conditioning: ['108', 0], reference_latents_method: 'index_timestep_zero' },
      _meta: { title: '负向参考潜变量方法' },
    },
    '110': {
      class_type: 'TextEncodeQwenImageEditPlus',
      inputs: { clip: ['106', 0], prompt: compiled.prompt, vae: ['107', 0], ...referenceInputs },
      _meta: { title: '光阴砚语义编辑提示词' },
    },
    '111': {
      class_type: 'FluxKontextMultiReferenceLatentMethod',
      inputs: { conditioning: ['110', 0], reference_latents_method: 'index_timestep_zero' },
      _meta: { title: '正向参考潜变量方法' },
    },
    '112': {
      class_type: 'VAEEncode',
      inputs: { pixels: ['102', 0], vae: ['107', 0] },
      _meta: { title: '编码来源图潜变量' },
    },
    ...(preset.id === 'lightning4' ? {
      '119': {
        class_type: 'LoraLoaderModelOnly',
        inputs: {
          model: ['105', 0],
          lora_name: artifactFilename(ARTIFACTS.qwenLightning4Lora),
          strength_model: preset.loraStrength,
        },
        _meta: { title: 'Qwen 2511 Lightning 4 步 LoRA' },
      },
    } : {}),
    '113': {
      class_type: 'KSampler',
      inputs: {
        model: [preset.id === 'lightning4' ? '119' : '105', 0],
        seed,
        steps: preset.steps,
        cfg: preset.cfg,
        sampler_name: preset.sampler,
        scheduler: preset.scheduler,
        positive: ['111', 0],
        negative: ['109', 0],
        latent_image: ['112', 0],
        denoise: preset.denoise,
      },
      _meta: { title: preset.id === 'lightning4' ? '实验模式 · Lightning 4 步' : '质量模式 · 40 步' },
    },
    '114': {
      class_type: 'VAEDecode',
      inputs: { samples: ['113', 0], vae: ['107', 0] },
      _meta: { title: '解码编辑结果' },
    },
    ...(masked ? {
      '115': {
        class_type: 'LoadImage',
        inputs: { image: mask },
        _meta: { title: '读取受管灰度蒙版' },
      },
      '116': {
        class_type: 'ImageToMask',
        inputs: { image: ['115', 0], channel: 'red' },
        _meta: { title: '灰度图转蒙版' },
      },
      '117': {
        class_type: 'ImageCompositeMasked',
        inputs: {
          destination: ['101', 0],
          source: ['114', 0],
          x: 0,
          y: 0,
          resize_source: true,
          mask: ['116', 0],
        },
        _meta: { title: '仅在蒙版内覆盖原图' },
      },
    } : {}),
    '118': {
      class_type: 'SaveImage',
      inputs: { images: decodedOutput, filename_prefix: safeOutputPrefix(jobId) },
      _meta: { title: '保存不可变语义派生图' },
    },
  }
  assertAllowedSemanticImageWorkflow(workflowId, workflow, preset.id)
  return {
    workflow,
    metadata: {
      version: preset.version,
      promptVersion: QWEN_SEMANTIC_PROMPT_VERSION,
      workflowId,
      preset: preset.id,
      model: QWEN_SEMANTIC_MODELS.diffusion,
      textEncoder: QWEN_SEMANTIC_MODELS.textEncoder,
      vae: QWEN_SEMANTIC_MODELS.vae,
      steps: preset.steps,
      cfg: preset.cfg,
      sampler: preset.sampler,
      scheduler: preset.scheduler,
      denoise: preset.denoise,
      shift: preset.shift,
      lora: preset.loraArtifactId
        ? {
            artifactId: preset.loraArtifactId,
            name: artifactFilename(ARTIFACTS.qwenLightning4Lora),
            strength: preset.loraStrength,
          }
        : null,
      seed,
      masked,
      outputNodeId: '118',
      instruction: compiled.instruction,
      identityStrength: compiled.identityStrength,
    },
  }
}
