import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { ComfyClient, findVideoOutput } from '../server/comfy-client.mjs'
import {
  assertAllowedVideoPostprocessWorkflow,
  buildSeedVr2VideoWorkflow,
} from '../server/video-postprocess-workflow.mjs'

function option(name, fallback = '') {
  const prefix = `--${name}=`
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback
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
    return { type: message.type, node: message.data?.node_id, error: message.data?.exception_message }
  }
  return null
}

async function main() {
  const inputOption = option('input')
  if (!inputOption) throw new Error('--input=<absolute source MP4> is required')
  const sourcePath = resolve(inputOption)
  await access(sourcePath)
  const baseUrl = option('base-url', process.env.COMFY_URL || 'http://127.0.0.1:8188')
  const framesPerChunk = integerOption('frames-per-chunk', 21)
  const vaeTileSize = integerOption('vae-tile-size', 384)
  const outputDimensions = {
    width: integerOption('width', 1280),
    height: integerOption('height', 720),
  }
  const seed = integerOption('seed', 20260823)
  const jobId = option('job-id', `seedvr2-smoke-${Date.now()}`)
  const managedInputName = `aeonquill-seedvr2-${randomUUID()}-${basename(sourcePath)}`.replace(/[^a-zA-Z0-9._-]/g, '-')
  const clientId = `aeonquill-seedvr2-smoke-${randomUUID()}`
  const comfy = new ComfyClient(baseUrl)
  const controller = new AbortController()
  const startedAt = Date.now()
  let tracker

  process.once('SIGINT', () => controller.abort())
  await comfy.freeMemory(controller.signal)
  const inputVideoName = await comfy.uploadVideo(sourcePath, managedInputName, controller.signal)
  const { workflow, metadata } = buildSeedVr2VideoWorkflow({
    inputVideoName,
    outputDimensions,
    seed,
    jobId,
    framesPerChunk,
    vaeTileSize,
  })
  assertAllowedVideoPostprocessWorkflow(workflow)
  console.log(JSON.stringify({
    at: new Date().toISOString(),
    type: 'prepared',
    sourcePath,
    inputVideoName,
    metadata,
  }))

  tracker = await comfy.openExecutionTracker(clientId, (message) => {
    const summary = eventSummary(message)
    if (summary) console.log(JSON.stringify({ at: new Date().toISOString(), ...summary }))
  })
  try {
    const queued = await comfy.queuePrompt(workflow, clientId, controller.signal)
    console.log(JSON.stringify({ at: new Date().toISOString(), type: 'queued', promptId: queued.prompt_id, number: queued.number }))
    const history = await tracker.waitForPrompt(queued.prompt_id, controller.signal)
    const output = findVideoOutput(history)
    if (!output) throw new Error('SeedVR2 completed without a video output')
    console.log(JSON.stringify({
      completed: true,
      promptId: queued.prompt_id,
      output,
      inputVideoName,
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
