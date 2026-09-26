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
import { ARTIFACTS } from '../server/workflow-artifacts.mjs'

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
  if (options.preset) params.preset = options.preset
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
      workflowVersion: options.preset === 'lightning4'
        ? 'qwen-image-edit-2511-int8-lightning4-v1'
        : QWEN_SEMANTIC_WORKFLOW_VERSION,
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
    events: options.events || [],
    trackerClosed: false,
    preparedReference: null,
    detected: null,
    releaseCount: 0,
  }
  return {
    capture,
    async uploadAsset(filePath, filename, mimeType) {
      capture.events.push('uploadAsset')
      capture.uploads.push({ filePath, filename, mimeType })
      return filename
    },
    async prepareSamImage(reference) { capture.events.push('prepareSamImage'); capture.preparedReference = reference },
    async detectSamMask(params) {
      capture.events.push('detectSamMask')
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
      capture.events.push('queuePrompt')
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
        { id: 'region-edit', label: '元素 / 区域编辑', available: true, presets: options.lightningAvailable === false ? [] : [
          { id: 'base40', available: true },
          { id: 'lightning4', available: true, missingArtifacts: [], missingNodes: [] },
        ] },
        { id: 'point-edit', label: '定点修改', available: true, presets: options.lightningAvailable === false ? [] : [
          { id: 'base40', available: true },
          { id: 'lightning4', available: true, missingArtifacts: [], missingNodes: [] },
        ] },
        { id: 'portrait-adjust', label: '人像调整', available: true, presets: options.lightningAvailable === false ? [] : [
          { id: 'base40', available: true },
          { id: 'lightning4', available: true, missingArtifacts: [], missingNodes: [] },
        ] },
      ],
    }),
    imageProcessor: { async dimensions(filePath) { return dimensions(filePath) } },
    runProcess: async (_command, args) => { await writeFile(args.at(-1), png, { flag: 'wx' }) },
    ffmpegPath: 'ffmpeg-fixture',
    inputDirectory: target.inputDirectory,
    managedComfyInputRoot: target.managedComfyInputRoot,
    deliverOutput: async () => ({ status: 'copied', filename: 'semantic.png', directoryLabel: 'fixture' }),
    scheduleRuntimeIdleStop: async () => { idleStops += 1 },
    verifyArtifacts: options.verifyArtifacts,
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

test('lightning4 verifies all fixed artifacts before queueing and records preset provenance', async (t) => {
  const target = await fixture(t)
  const job = executionJob(target, 'semantic-lightning4-complete', 'region-edit', { preset: 'lightning4' })
  await addInputs(target, job)
  const events = []
  const comfy = fakeComfy({ outputs: { 118: { images: [{ filename: 'lightning.png', type: 'output' }] } } }, { events })
  const verifiedCalls = []
  const runner = executor(target, comfy, {
    verifyArtifacts: async (artifactIds) => {
      events.push('verifyArtifacts')
      verifiedCalls.push(artifactIds)
      return artifactIds.map((id) => {
        const artifact = Object.values(ARTIFACTS).find((candidate) => candidate.id === id)
        return { id, sha256: artifact.sha256, bytes: artifact.bytes }
      })
    },
  })

  await runner.instance.run(job.id, { signal: new AbortController().signal })

  const completed = target.store.get(job.id)
  assert.equal(completed.status, 'completed')
  assert.ok(events.indexOf('verifyArtifacts') >= 0)
  assert.ok(events.indexOf('verifyArtifacts') < events.indexOf('uploadAsset'))
  assert.ok(events.indexOf('verifyArtifacts') < events.indexOf('queuePrompt'))
  assert.deepEqual(verifiedCalls, [[
    'qwen-image-edit-2511-int8-convrot',
    'qwen-image-qwen25vl-7b-fp8',
    'qwen-image-vae',
    'qwen-image-edit-2511-lightning4-bf16-v1',
  ]])
  assert.equal(comfy.capture.queuedWorkflow['119'].class_type, 'LoraLoaderModelOnly')
  assert.equal(comfy.capture.queuedWorkflow['113'].inputs.steps, 4)
  assert.equal(completed.workflowVersion, 'qwen-image-edit-2511-int8-lightning4-v1')
  assert.equal(completed.workflowMetadata.preset, 'lightning4')
  assert.deepEqual(completed.workflowMetadata.verifiedArtifacts, [
    { id: ARTIFACTS.qwenImageEdit2511Int8.id, sha256: ARTIFACTS.qwenImageEdit2511Int8.sha256, bytes: ARTIFACTS.qwenImageEdit2511Int8.bytes },
    { id: ARTIFACTS.qwenImageTextEncoderFp8.id, sha256: ARTIFACTS.qwenImageTextEncoderFp8.sha256, bytes: ARTIFACTS.qwenImageTextEncoderFp8.bytes },
    { id: ARTIFACTS.qwenImageVae.id, sha256: ARTIFACTS.qwenImageVae.sha256, bytes: ARTIFACTS.qwenImageVae.bytes },
    { id: ARTIFACTS.qwenLightning4Lora.id, sha256: ARTIFACTS.qwenLightning4Lora.sha256, bytes: ARTIFACTS.qwenLightning4Lora.bytes },
  ])
  assert.equal(completed.outputVersion.provenance.preset, 'lightning4')
  assert.deepEqual(completed.outputVersion.provenance.verifiedArtifacts, completed.workflowMetadata.verifiedArtifacts)
})

test('lightning4 fails closed before queueing when artifact verification is unavailable or fails', async (t) => {
  const unavailableTarget = await fixture(t)
  const unavailableJob = executionJob(unavailableTarget, 'semantic-lightning4-no-verifier', 'region-edit', { preset: 'lightning4' })
  await addInputs(unavailableTarget, unavailableJob)
  const unavailableComfy = fakeComfy({ outputs: {} })
  const unavailableRunner = executor(unavailableTarget, unavailableComfy)
  await unavailableRunner.instance.run(unavailableJob.id, { signal: new AbortController().signal })
  assert.equal(unavailableTarget.store.get(unavailableJob.id).status, 'failed')
  assert.equal(unavailableTarget.store.get(unavailableJob.id).error.code, 'SEMANTIC_ARTIFACT_VERIFIER_UNAVAILABLE')
  assert.equal(unavailableComfy.capture.queuedWorkflow, null)

  const failedTarget = await fixture(t)
  const failedJob = executionJob(failedTarget, 'semantic-lightning4-bad-hash', 'region-edit', { preset: 'lightning4' })
  await addInputs(failedTarget, failedJob)
  const failedEvents = []
  const failedComfy = fakeComfy({ outputs: {} }, { events: failedEvents })
  const failedRunner = executor(failedTarget, failedComfy, {
    verifyArtifacts: async () => {
      failedEvents.push('verifyArtifacts')
      throw Object.assign(new Error('hash mismatch'), { code: 'WORKFLOW_WEIGHT_HASH_MISMATCH' })
    },
  })
  await failedRunner.instance.run(failedJob.id, { signal: new AbortController().signal })
  assert.equal(failedTarget.store.get(failedJob.id).status, 'failed')
  assert.equal(failedTarget.store.get(failedJob.id).error.code, 'WORKFLOW_WEIGHT_HASH_MISMATCH')
  assert.equal(failedComfy.capture.uploads.length, 0)
  assert.deepEqual(failedEvents, ['verifyArtifacts'])
  assert.equal(failedComfy.capture.queuedWorkflow, null)
})

test('lightning4 verifies before point-edit source upload and SAM work', async (t) => {
  const target = await fixture(t)
  const job = executionJob(target, 'semantic-lightning4-point-bad-hash', 'point-edit', { preset: 'lightning4' })
  await addInputs(target, job)
  const events = []
  const comfy = fakeComfy({ outputs: {} }, { events })
  const runner = executor(target, comfy, {
    verifyArtifacts: async () => {
      events.push('verifyArtifacts')
      throw Object.assign(new Error('hash mismatch'), { code: 'WORKFLOW_WEIGHT_HASH_MISMATCH' })
    },
  })

  await runner.instance.run(job.id, { signal: new AbortController().signal })

  assert.equal(target.store.get(job.id).status, 'failed')
  assert.equal(comfy.capture.uploads.length, 0)
  assert.deepEqual(events, ['verifyArtifacts'])
  assert.equal(comfy.capture.queuedWorkflow, null)
})

test('lightning4 rejects incomplete, duplicate, and forged verification identities before upload', async (t) => {
  const expected = [
    ARTIFACTS.qwenImageEdit2511Int8,
    ARTIFACTS.qwenImageTextEncoderFp8,
    ARTIFACTS.qwenImageVae,
    ARTIFACTS.qwenLightning4Lora,
  ]
  const cases = [
    expected.slice(0, 3).map(({ id, sha256, bytes }) => ({ id, sha256, bytes })),
    [
      ...expected.slice(0, 3).map(({ id, sha256, bytes }) => ({ id, sha256, bytes })),
      { id: expected[0].id, sha256: expected[0].sha256, bytes: expected[0].bytes },
    ],
    expected.map(({ id, sha256, bytes }) => ({ id, sha256: id === expected[0].id ? '0'.repeat(64) : sha256, bytes })),
  ]
  for (const [index, invalidResult] of cases.entries()) {
    const target = await fixture(t)
    const job = executionJob(target, `semantic-lightning4-invalid-${index}`, 'region-edit', { preset: 'lightning4' })
    await addInputs(target, job)
    const events = []
    const comfy = fakeComfy({ outputs: {} }, { events })
    const runner = executor(target, comfy, {
      verifyArtifacts: async () => {
        events.push('verifyArtifacts')
        return invalidResult
      },
    })

    await runner.instance.run(job.id, { signal: new AbortController().signal })

    assert.equal(target.store.get(job.id).status, 'failed')
    assert.equal(target.store.get(job.id).error.code, 'SEMANTIC_ARTIFACT_VERIFICATION_INVALID')
    assert.equal(comfy.capture.uploads.length, 0)
    assert.deepEqual(events, ['verifyArtifacts'])
    assert.equal(comfy.capture.queuedWorkflow, null)
  }
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
