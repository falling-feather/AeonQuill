import { randomUUID } from 'node:crypto'
import { ComfyClient, findVideoOutput } from '../server/comfy-client.mjs'
import { buildVideoWorkflow } from '../server/workflow-builder.mjs'

function option(name, fallback) {
  const prefix = `--${name}=`
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback
}

function booleanOption(name, fallback) {
  const value = option(name, fallback ? 'true' : 'false')
  if (!['true', 'false'].includes(value)) throw new Error(`--${name} must be true or false`)
  return value === 'true'
}

function integerOption(name, fallback) {
  const value = Number(option(name, String(fallback)))
  if (!Number.isSafeInteger(value)) throw new Error(`--${name} must be an integer`)
  return value
}

function eventSummary(message) {
  if (message.type === 'progress') {
    return { type: message.type, node: message.data?.node, value: message.data?.value, max: message.data?.max }
  }
  if (message.type === 'executing') return { type: message.type, node: message.data?.node }
  if (message.type === 'execution_error') {
    return {
      type: message.type,
      node: message.data?.node_id,
      error: message.data?.exception_message,
    }
  }
  return null
}

async function main() {
  const baseUrl = option('base-url', process.env.COMFY_URL || 'http://127.0.0.1:8188')
  const preset = option('preset', 'cinemaBase')
  const modelProfile = option('model-profile', 'fp8Scaled4060')
  const duration = integerOption('duration', 5)
  const seed = integerOption('seed', 20260823)
  const prompt = option(
    'prompt',
    'A single continuous cinematic shot of a rain-soaked old bookshop at dawn. The camera slowly pushes toward a black inkstone on a wooden desk while warm window light reveals paper fibers, wet stone texture, and drifting dust. Motion is subtle and physically coherent; geometry, lighting direction, and material detail remain stable.',
  )
  const jobId = option('job-id', `quality-smoke-${preset}-${Date.now()}`)
  const clientId = `aeonquill-quality-smoke-${randomUUID()}`
  const comfy = new ComfyClient(baseUrl)
  const controller = new AbortController()
  const startedAt = Date.now()
  let tracker

  process.once('SIGINT', () => controller.abort())
  await comfy.freeMemory(controller.signal)
  const built = await buildVideoWorkflow({
    mode: 'text-to-video',
    prompt,
    scenario: 'cinematic',
    aspectRatio: option('aspect-ratio', '16:9'),
    duration,
    preset,
    seed,
    audio: booleanOption('audio', true),
    modelProfile,
    jobId,
  })
  const workflow = built.workflow
  const metadata = { ...built.metadata }
  const stepsOverride = option('steps', '')
  if (stepsOverride) {
    const steps = Number(stepsOverride)
    if (!Number.isSafeInteger(steps) || steps < 1 || steps > 25) throw new Error('--steps must be an integer from 1 to 25')
    workflow['10'].inputs.steps = steps
    metadata.steps = steps
    metadata.benchmarkOverride = true
  }

  console.log(JSON.stringify({ at: new Date().toISOString(), type: 'prepared', jobId, metadata }))
  tracker = await comfy.openExecutionTracker(clientId, (message) => {
    const summary = eventSummary(message)
    if (summary) console.log(JSON.stringify({ at: new Date().toISOString(), ...summary }))
  })
  try {
    const queued = await comfy.queuePrompt(workflow, clientId, controller.signal)
    console.log(JSON.stringify({ at: new Date().toISOString(), type: 'queued', promptId: queued.prompt_id, number: queued.number }))
    const history = await tracker.waitForPrompt(queued.prompt_id, controller.signal)
    const output = findVideoOutput(history)
    if (!output) throw new Error('H3 completed without a video output')
    console.log(JSON.stringify({
      completed: true,
      promptId: queued.prompt_id,
      output,
      elapsedSeconds: Number(((Date.now() - startedAt) / 1_000).toFixed(2)),
      metadata,
    }))
  } finally {
    tracker?.close()
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    completed: false,
    error: error instanceof Error ? error.message : String(error),
    code: error?.code,
    comfyData: error?.comfyData,
  }))
  process.exitCode = 1
})
