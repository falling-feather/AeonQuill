import { buildVideoWorkflow, REQUIRED_NODE_TYPES } from './workflow-builder.mjs'

const comfyUrl = (process.env.COMFY_URL || 'http://127.0.0.1:8188').replace(/\/$/, '')

const cases = [
  {
    mode: 'text-to-video',
    prompt: 'Workflow contract validation.',
    aspectRatio: '16:9',
    duration: 5,
    preset: 'fast',
    seed: 1,
    audio: true,
    jobId: 'validate-t2v',
  },
  {
    mode: 'image-to-video',
    prompt: 'Workflow contract validation.',
    aspectRatio: '9:16',
    duration: 5,
    preset: 'balanced',
    seed: 2,
    audio: false,
    inputImageName: 'contract-only.png',
    lastFrameImageName: 'contract-last.png',
    jobId: 'validate-i2v',
  },
  {
    mode: 'text-to-video',
    prompt: 'Workflow contract validation.',
    aspectRatio: '16:9',
    duration: 5,
    preset: 'delivery720',
    seed: 3,
    audio: true,
    jobId: 'validate-delivery720',
  },
]

async function main() {
  const response = await fetch(`${comfyUrl}/object_info`)
  if (!response.ok) throw new Error(`ComfyUI object_info returned HTTP ${response.status}`)
  const objectInfo = await response.json()
  const missingTypes = REQUIRED_NODE_TYPES.filter((type) => !objectInfo[type])
  if (missingTypes.length) throw new Error(`Missing ComfyUI node types: ${missingTypes.join(', ')}`)

  for (const testCase of cases) {
    const { workflow, metadata } = await buildVideoWorkflow(testCase)
    const errors = []
    for (const [nodeId, node] of Object.entries(workflow)) {
      const definition = objectInfo[node.class_type]
      if (!definition) {
        errors.push(`node ${nodeId}: unknown class ${node.class_type}`)
        continue
      }
      const required = Object.keys(definition.input?.required || {})
      for (const inputName of required) {
        if (!(inputName in node.inputs)) errors.push(`node ${nodeId}: missing input ${inputName}`)
      }
    }
    if (errors.length) throw new Error(`${testCase.mode} failed:\n${errors.join('\n')}`)
    console.log(`✓ ${testCase.mode}: ${Object.keys(workflow).length} nodes, ${metadata.dimensions.width}×${metadata.dimensions.height}, ${metadata.steps} steps`)
  }

  const modelChecks = [
    ['UNETLoader', 'unet_name', 'minimax_h3_fl2va_pruned_fp8_scaled.safetensors'],
    ['CLIPLoader', 'clip_name', 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'],
    ['VAELoader', 'vae_name', 'minimax_h3_video_vae_fp16.safetensors'],
    ['VAELoader', 'vae_name', 'minimax_h3_audio_vae_fp32.safetensors'],
    ['MiniMaxH3TurboLoRA', 'lora_name', 'minimax_h3_turbo_v4_step600_ema.safetensors'],
  ]
  for (const [nodeType, input, filename] of modelChecks) {
    const options = objectInfo[nodeType]?.input?.required?.[input]?.[0]
    if (!Array.isArray(options) || !options.includes(filename)) {
      throw new Error(`Missing model ${filename} for ${nodeType}.${input}`)
    }
  }
  console.log('✓ Required H3 model files are registered')
}

main().catch((error) => {
  console.error(`Workflow validation failed: ${error.message}`)
  process.exitCode = 1
})
