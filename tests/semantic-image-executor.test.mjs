import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { JobStore } from '../server/job-store.mjs'
import { ProjectStore } from '../server/project-store.mjs'
import {
  findSemanticImageOutput,
  SemanticImageExecutor,
} from '../server/semantic-image-executor.mjs'
import { QWEN_SEMANTIC_WORKFLOW_VERSION } from '../server/semantic-image-workflow.mjs'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAFAgIACQFe3gAAAABJRU5ErkJggg==',
  'base64',
)

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'aeonquill-semantic-executor-'))
  const inputDirectory = join(root, 'inputs')
  const managedComfyInputRoot = join(root, 'comfy-input')
  const projectStore = await new ProjectStore(join(root, 'projects')).open()
  const store = new JobStore(join(root, 'jobs.json'))
  await Promise.all([
    store.load(),
    mkdir(inputDirectory, { recursive: true }),
    mkdir(managedComfyInputRoot, { recursive: true }),
  ])
  t.after(async () => {
    projectStore.close()
    await rm(root, { recursive: true, force: true })
  })
  return { root, inputDirectory, managedComfyInputRoot, projectStore, store }
}

function executionJob(target, id, workflowId, options = {}) {
  const operation = `semantic-${workflowId}`
  const inputPath = join(target.inputDirectory, `${id}-input.png`)
  const maskPath = workflowId === 'region-edit'
    ? join(target.inputDirectory, `${id}-mask.png`)
    : undefined
  const params = workflowId === 'region-edit'
    ? { instruction: '把披风改为深青色，保持人物姿态', seed: 42, maskChannel: 'alpha' }
    : workflowId === 'point-edit'
      ? {
          instruction: '将选中的纸伞改成朱红色', seed: 43, threshold: 0.9,
          positivePoints: [{ x: 0.5, y: 0.4 }], negativePoints: [{ x: 0.1, y: 0.1 }],
        }
      : { instruction: '调整为微笑表情并保留人物身份', seed: 44, identityStrength: 0.9 }
  return {
    id,
    kind: 'image',
    tool: operation,
    label: workflowId,
    status: 'queued',
    phase: 'queued',
    progress: 0,
    detail: 'fixture',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    inputPath,
    maskPath,
    sourceElementId: 'canvas-image-1',
    request: {
      operation,
      workflowId,
      workflowVersion: QWEN_SEMANTIC_WORKFLOW_VERSION,
      projectId: 'project-semantic',
      sourceAssetId: 'a'.repeat(64),
      ...(workflowId === 'region-edit' ? { maskAssetId: 'b'.repeat(64) } : {}),
      title: options.title || '语义派生图',
      sourceElementId: 'canvas-image-1',
      params,
    },
    logs: [],
  }
}

function fakeComfy(history, options = {}) {
  const capture = {
    queuedWorkflow: null,
    uploads: [],
    trackerClosed: false,
    preparedReference: null,
    detected: null,
    releaseCount: 0,
  }
  return {
    capture,
    async uploadAsset(filePath, filename, mimeType) {
      capture.uploads.push({ filePath, filename, mimeType })
      return filename
    },
    async prepareSamImage(reference) { capture.preparedReference = reference },
    async detectSamMask(params) {
      capture.detected = params
      return options.maskBytes || png
    },
    async releaseSam() { capture.releaseCount += 1 },
    async openExecutionTracker() {
      if (options.tracker) return options.tracker(capture)
      return {
        async waitForPrompt() { return history },
        close() { capture.trackerClosed = true },
      }
    },
    async queuePrompt(workflow) {
      capture.queuedWorkflow = workflow
      return { prompt_id: 'prompt-semantic', number: 1 }
    },
    async fetchOutput() {
      return new Response(png, {
        headers: { 'content-type': 'image/png', 'content-length': String(png.length) },
      })
    },
  }
}

function executor(target, comfy, options = {}) {
  let idleStops = 0
  const dimensions = options.dimensions || (() => ({ width: 1, height: 1 }))
  const instance = new SemanticImageExecutor({
    store: target.store,
    projectStore: target.projectStore,
    comfy,
    runtimeManager: { async ensureReady() {} },
    inspectSemanticWorkflows: async () => ({
      workflows: [
        { id: 'region-edit', label: '元素 / 区域编辑', available: true },
        { id: 'point-edit', label: '定点修改', available: true },
        { id: 'portrait-adjust', label: '人像调整', available: true },
      ],
    }),
    imageProcessor: { async dimensions(filePath) { return dimensions(filePath) } },
    runProcess: async (_command, args) => { await writeFile(args.at(-1), png, { flag: 'wx' }) },
    ffmpegPath: 'ffmpeg-fixture',
    inputDirectory: target.inputDirectory,
    managedComfyInputRoot: target.managedComfyInputRoot,
    deliverOutput: async () => ({ status: 'copied', filename: 'semantic.png', directoryLabel: 'fixture' }),
    scheduleRuntimeIdleStop: async () => { idleStops += 1 },
    delay: async () => {},
  })
  return { instance, idleStops: () => idleStops }
}

async function addInputs(target, job) {
  await writeFile(job.inputPath, png)
  if (job.maskPath) await writeFile(job.maskPath, png)
  await target.store.add(job)
}

test('region edit submits the fixed masked graph and persists an immutable project asset with provenance', async (t) => {
  const target = await fixture(t)
  const job = executionJob(target, 'semantic-region-complete', 'region-edit')
  await addInputs(target, job)
  const comfy = fakeComfy({ outputs: { 118: { images: [{ filename: 'region.png', type: 'output' }] } } })
  const runner = executor(target, comfy)

  await runner.instance.run(job.id, { signal: new AbortController().signal })

  const completed = target.store.get(job.id)
  assert.equal(completed.status, 'completed')
  assert.equal(completed.outputVersion.assetId, completed.libraryAsset.version.assetId)
  assert.equal(completed.outputVersion.provenance.source, 'semantic-qwen-image-edit')
  assert.equal(completed.outputVersion.provenance.workflowId, 'region-edit')
  assert.equal(completed.outputVersion.provenance.sourceAssetId, 'a'.repeat(64))
  assert.equal(completed.outputVersion.provenance.maskAssetId, 'b'.repeat(64))
  assert.equal(comfy.capture.queuedWorkflow['117'].class_type, 'ImageCompositeMasked')
  assert.equal(comfy.capture.queuedWorkflow['113'].inputs.steps, 40)
  assert.equal(comfy.capture.trackerClosed, true)
  assert.equal(runner.idleStops(), 1)
  const assets = target.projectStore.listLibraryAssets({ scope: 'project', projectId: 'project-semantic' })
  assert.equal(assets.length, 1)
  assert.equal(assets[0].version.url, completed.outputUrl)
  assert.equal(JSON.stringify(completed).includes('sourceImageDataUrl'), false)
  assert.equal(JSON.stringify(completed).includes('maskImageDataUrl'), false)
})

test('point edit converts normalized clicks to pixels and stores its generated SAM mask', async (t) => {
  const target = await fixture(t)
  const job = executionJob(target, 'semantic-point-complete', 'point-edit')
  await addInputs(target, job)
  const comfy = fakeComfy({ outputs: { 118: { images: [{ filename: 'point.png', type: 'output' }] } } })
  const runner = executor(target, comfy, { dimensions: () => ({ width: 101, height: 51 }) })

  await runner.instance.run(job.id, { signal: new AbortController().signal })

  const completed = target.store.get(job.id)
  assert.equal(completed.status, 'completed')
  assert.deepEqual(comfy.capture.detected.positivePoints, [[50, 20]])
  assert.deepEqual(comfy.capture.detected.negativePoints, [[10, 5]])
  assert.equal(comfy.capture.preparedReference, `aeonquill-${job.id}-source.png`)
  assert.equal(comfy.capture.releaseCount, 1)
  assert.equal(completed.maskLibraryAsset.version.provenance.source, 'semantic-point-mask')
  assert.equal(completed.maskUrl, completed.maskLibraryAsset.version.url)
  assert.equal(target.projectStore.listLibraryAssets({ scope: 'project', projectId: 'project-semantic' }).length, 2)
})

test('region edit fails closed before queueing when mask dimensions differ from its source', async (t) => {
  const target = await fixture(t)
  const job = executionJob(target, 'semantic-region-invalid-mask', 'region-edit')
  await addInputs(target, job)
  const comfy = fakeComfy({ outputs: {} })
  const runner = executor(target, comfy, {
    dimensions: (filePath) => filePath === job.maskPath ? { width: 2, height: 1 } : { width: 1, height: 1 },
  })

  await runner.instance.run(job.id, { signal: new AbortController().signal })

  const failed = target.store.get(job.id)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error.code, 'SEMANTIC_MASK_DIMENSIONS')
  assert.equal(comfy.capture.queuedWorkflow, null)
  assert.equal(target.projectStore.listLibraryAssets({ scope: 'project', projectId: 'project-semantic' }).length, 0)
})

test('semantic executor observes cancellation, closes the tracker and always schedules idle stop', async (t) => {
  const target = await fixture(t)
  const job = executionJob(target, 'semantic-portrait-cancel', 'portrait-adjust')
  await addInputs(target, job)
  let trackerReady
  const ready = new Promise((resolve) => { trackerReady = resolve })
  const comfy = fakeComfy({}, {
    tracker: (capture) => ({
      waitForPrompt(_promptId, signal) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true })
          trackerReady()
        })
      },
      close() { capture.trackerClosed = true },
    }),
  })
  const runner = executor(target, comfy)
  const controller = new AbortController()

  const running = runner.instance.run(job.id, { signal: controller.signal })
  await ready
  controller.abort()
  await running

  assert.equal(target.store.get(job.id).status, 'cancelled')
  assert.equal(comfy.capture.trackerClosed, true)
  assert.equal(runner.idleStops(), 1)
  assert.equal(target.projectStore.listLibraryAssets({ scope: 'project', projectId: 'project-semantic' }).length, 0)
})

test('semantic output finder accepts only the fixed output node and safe supported image paths', () => {
  assert.deepEqual(findSemanticImageOutput({
    outputs: {
      117: { images: [{ filename: 'wrong.png', type: 'output' }] },
      118: { images: [{ filename: 'result.webp', subfolder: 'safe', type: 'output' }] },
    },
  }), { filename: 'result.webp', subfolder: 'safe', type: 'output', mimeType: 'image/webp' })
  assert.equal(findSemanticImageOutput({ outputs: { 118: { images: [{ filename: '../escape.png', type: 'output' }] } } }), null)
  assert.equal(findSemanticImageOutput({ outputs: { 118: { images: [{ filename: 'result.gif', type: 'output' }] } } }), null)
  assert.equal(findSemanticImageOutput({ outputs: { 999: { images: [{ filename: 'result.png', type: 'output' }] } } }), null)
})
