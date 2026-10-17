import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createProjectCatalog, createWorkspaceProject } from '../src/lib/project/projectCatalog.mjs'
import {
  CustomWorkflowExecutor,
  findMappedCustomWorkflowOutput,
  validateCustomWorkflowJobRequest,
} from '../server/custom-workflow-executor.mjs'
import { JobStore } from '../server/job-store.mjs'
import { ProjectStore } from '../server/project-store.mjs'
import { WorkflowCenterService } from '../server/workflow-center.mjs'
import { WorkspaceStore } from '../server/workspace-store.mjs'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAFAgIACQFe3gAAAABJRU5ErkJggg==', 'base64')
const objectInfo = {
  CLIPTextEncode: { input: { required: { text: ['STRING', {}] } } },
  EmptyLatentImage: { input: { required: { width: ['INT', {}], height: ['INT', {}], batch_size: ['INT', {}] } } },
  LoadImage: { input: { required: { image: ['STRING', {}] } } },
  SaveImage: { input: { required: {} } },
}
const workflow = {
  1: { class_type: 'CLIPTextEncode', inputs: { text: 'original' } },
  2: { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'original-prefix' } },
}
const mappings = { prompt: { nodeId: '1', inputName: 'text' }, output: { nodeId: '2' } }
const weightSet = {
  schemaVersion: 1, registryVersion: 'aeonquill-h3-registry-v2', family: 'minimax-h3',
  profileId: 'fp8Scaled4060', samplingMode: 'base',
  artifacts: ['base', 'text-encoder', 'video-vae', 'audio-vae'].map((role, index) => ({ role, id: `test-${index}`, sha256: String(index + 1).repeat(64) })),
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'aeonquill-custom-executor-'))
  const projectStore = await new ProjectStore(join(root, 'projects')).open()
  const workspaceStore = await new WorkspaceStore(join(root, 'workspaces')).open()
  const workflowCenter = new WorkflowCenterService({ rootDirectory: join(root, 'workflow-center'), packs: [] })
  const store = new JobStore(join(root, 'jobs.json'))
  const inputRoot = join(root, 'comfy-input')
  await Promise.all([workflowCenter.open(), store.load(), mkdir(inputRoot, { recursive: true })])
  const created = createWorkspaceProject(createProjectCatalog(), {
    title: '自定义工作流项目', initialModeId: 'balanced', color: 'violet',
  }, { projectId: 'project-custom', documentId: 'document-custom', now: 1_000 })
  workspaceStore.saveCatalog(created.catalog, { baseRevision: 0, now: 1_100, source: 'fixture' })
  const imported = await workflowCenter.importCustom({ title: '固定输出图片', workflow, mappings, registeredNodeTypes: objectInfo })
  await workflowCenter.setCustomEnabled(imported.id, true, objectInfo)
  t.after(async () => {
    await workflowCenter.close()
    workspaceStore.close()
    projectStore.close()
    await rm(root, { recursive: true, force: true })
  })
  return { root, inputRoot, projectStore, workspaceStore, workflowCenter, store, imported }
}

function executionJob(id, customWorkflowId) {
  const now = Date.now()
  return {
    id,
    kind: 'custom-workflow',
    tool: 'custom-comfy-workflow',
    label: '自定义工作流',
    status: 'running',
    phase: 'preparing',
    progress: 0,
    detail: 'fixture',
    createdAt: now,
    updatedAt: now,
    request: {
      customWorkflowId,
      projectId: 'project-custom',
      title: '水墨输出',
      prompt: '一只纸鹤掠过墨色群山',
    },
    logs: [],
  }
}

test('reviewed workflow identities cannot silently change before queueing', async (t) => {
  const target = await fixture(t)
  const request = executionJob('identity-job', target.imported.id).request
  assert.throws(() => validateCustomWorkflowJobRequest({ ...request, workflowHash: '0'.repeat(64) }, target), { code: 'CUSTOM_WORKFLOW_INPUT_CHANGED' })
  const validated = validateCustomWorkflowJobRequest({ ...request, workflowHash: target.imported.hash, mappingHash: target.imported.mappingHash }, target)
  assert.match(validated.request.workflowHash, /^[a-f0-9]{64}$/u)
  assert.equal(validated.request.workflowHash, target.imported.hash)
  assert.equal(validated.request.mappingHash, target.imported.mappingHash)
})

test('queue pins registered weight identity and rejects a mismatching client snapshot', async (t) => {
  const target = await fixture(t)
  const original = target.workflowCenter.customExecutionSummary.bind(target.workflowCenter)
  target.workflowCenter.customExecutionSummary = (id) => ({ ...original(id), weightSet })
  const body = executionJob('weight-request', target.imported.id).request
  const validated = validateCustomWorkflowJobRequest(body, target)
  assert.deepEqual(validated.request.weightSet, weightSet)
  assert.notEqual(validated.request.weightSet, weightSet)
  const changed = structuredClone(weightSet)
  changed.artifacts[0].sha256 = 'e'.repeat(64)
  assert.throws(() => validateCustomWorkflowJobRequest({ ...body, weightSet: changed }, target), { code: 'WORKFLOW_RECIPE_WEIGHT_STALE' })
})

test('failed physical weight verification prevents queueing a fixed-model job', async (t) => {
  const target = await fixture(t)
  const original = target.workflowCenter.customExecutionSummary.bind(target.workflowCenter)
  target.workflowCenter.customExecutionSummary = (id) => ({ ...original(id), weightSet })
  let verified = 0
  target.workflowCenter.verifyWeightSet = async (actual) => {
    assert.deepEqual(actual, weightSet)
    verified += 1
    throw Object.assign(new Error('model contents changed'), { code: 'WORKFLOW_MODEL_HASH_MISMATCH' })
  }
  const job = executionJob('weight-verification', target.imported.id)
  job.request.weightSet = structuredClone(weightSet)
  await target.store.add(job)
  const comfy = fakeComfy({ outputs: { 2: { images: [{ filename: 'result.png', subfolder: '', type: 'output' }] } } })
  const executor = new CustomWorkflowExecutor({
    ...target, comfy, runtimeManager: { async ensureReady() {} },
    inspectRuntime: async () => ({ connected: true }), managedComfyInputRoot: target.inputRoot,
  })
  await executor.run(job.id, { signal: new AbortController().signal })
  assert.equal(verified, 1)
  assert.equal(comfy.capture.queuedWorkflow, null)
  assert.equal(comfy.capture.uploads.length, 0)
  assert.equal(target.store.get(job.id).status, 'failed')
  assert.equal(target.store.get(job.id).error.code, 'WORKFLOW_MODEL_HASH_MISMATCH')
})

test('verified weights reach job metadata and asset provenance without accepting a changed queued identity', async (t) => {
  const target = await fixture(t)
  const original = target.workflowCenter.customExecutionSummary.bind(target.workflowCenter)
  target.workflowCenter.customExecutionSummary = (id) => ({ ...original(id), weightSet })
  let verified = 0
  target.workflowCenter.verifyWeightSet = async (actual) => { verified += 1; return structuredClone(actual) }
  const comfy = fakeComfy({ outputs: { 2: { images: [{ filename: 'result.png', subfolder: '', type: 'output' }] } } })
  const executor = new CustomWorkflowExecutor({
    ...target, comfy, runtimeManager: { async ensureReady() {} },
    inspectRuntime: async () => ({ connected: true }), managedComfyInputRoot: target.inputRoot,
  })
  const job = executionJob('verified-weight-result', target.imported.id)
  job.request.weightSet = structuredClone(weightSet)
  await target.store.add(job)
  await executor.run(job.id, { signal: new AbortController().signal })
  const completed = target.store.get(job.id)
  assert.equal(completed.status, 'completed')
  assert.deepEqual(completed.workflowMetadata.weightSet, weightSet)
  assert.deepEqual(completed.outputVersion.provenance.weightSet, weightSet)
  assert.equal(completed.workflowMetadata.weightsVerified, true)
  assert.equal(verified, 1)
  const stale = executionJob('stale-weight-request', target.imported.id)
  stale.request.weightSet = structuredClone(weightSet)
  stale.request.weightSet.artifacts[0].sha256 = 'e'.repeat(64)
  await target.store.add(stale)
  comfy.capture.queuedWorkflow = null
  await executor.run(stale.id, { signal: new AbortController().signal })
  assert.equal(comfy.capture.queuedWorkflow, null)
  assert.equal(verified, 1)
  assert.equal(target.store.get(stale.id).error.code, 'WORKFLOW_RECIPE_WEIGHT_STALE')
})

function fakeComfy(history) {
  const capture = { queuedWorkflow: null, trackerClosed: false, uploads: [] }
  return {
    capture,
    async objectInfo() { return objectInfo },
    async uploadAsset(filePath, filename, mimeType) {
      capture.uploads.push({ filePath, filename, mimeType })
      return filename
    },
    async openExecutionTracker() {
      return {
        async waitForPrompt() { return history },
        close() { capture.trackerClosed = true },
      }
    },
    async queuePrompt(queuedWorkflow) {
      capture.queuedWorkflow = queuedWorkflow
      return { prompt_id: 'prompt-fixture', number: 1 }
    },
    async fetchOutput() {
      return new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(png.length) } })
    },
  }
}

test('custom workflow executor submits the mapped node and backfills an immutable project asset with provenance', async (t) => {
  const target = await fixture(t)
  const job = executionJob('custom-run-complete', target.imported.id)
  await target.store.add(job)
  const comfy = fakeComfy({ outputs: { 2: { images: [{ filename: 'result.png', subfolder: '', type: 'output' }] } } })
  let idleStops = 0
  const executor = new CustomWorkflowExecutor({
    workflowCenter: target.workflowCenter,
    store: target.store,
    projectStore: target.projectStore,
    comfy,
    runtimeManager: { async ensureReady() {} },
    inspectRuntime: async () => ({ connected: true }),
    managedComfyInputRoot: target.inputRoot,
    deliverOutput: async () => ({ status: 'copied', filename: 'custom-run-complete.png', directoryLabel: 'fixture-output' }),
    scheduleRuntimeIdleStop: async () => { idleStops += 1 },
  })
  await executor.run(job.id, { signal: new AbortController().signal })
  const completed = target.store.get(job.id)
  assert.equal(completed.status, 'completed')
  assert.equal(completed.outputVersion.assetId, completed.libraryAsset.version.assetId)
  assert.equal(completed.outputVersion.provenance.source, 'custom-comfy-workflow')
  assert.equal(completed.outputVersion.provenance.customWorkflowId, target.imported.id)
  assert.equal(comfy.capture.queuedWorkflow['1'].inputs.text, job.request.prompt)
  assert.equal(comfy.capture.queuedWorkflow['2'].inputs.filename_prefix, `AEONQUILL_${job.id}`)
  assert.equal(comfy.capture.trackerClosed, true)
  assert.equal(idleStops, 1)
  const assets = target.projectStore.listLibraryAssets({ scope: 'project', projectId: 'project-custom' })
  assert.equal(assets.length, 1)
  assert.equal(assets[0].version.url, completed.outputUrl)
})

test('custom workflow executor fails closed when the mapped output node returns no supported asset', async (t) => {
  const target = await fixture(t)
  const job = executionJob('custom-run-missing', target.imported.id)
  await target.store.add(job)
  const comfy = fakeComfy({ outputs: { 99: { images: [{ filename: 'wrong.png', subfolder: '', type: 'output' }] } } })
  const executor = new CustomWorkflowExecutor({
    workflowCenter: target.workflowCenter,
    store: target.store,
    projectStore: target.projectStore,
    comfy,
    runtimeManager: { async ensureReady() {} },
    inspectRuntime: async () => ({ connected: true }),
    managedComfyInputRoot: target.inputRoot,
  })
  await executor.run(job.id, { signal: new AbortController().signal })
  assert.equal(target.store.get(job.id).status, 'failed')
  assert.equal(target.store.get(job.id).error.code, 'CUSTOM_WORKFLOW_OUTPUT_MISSING')
  assert.equal(target.projectStore.listLibraryAssets({ scope: 'project', projectId: 'project-custom' }).length, 0)
})

test('custom workflow executor observes cancellation and always runs the idle-stop hook', async (t) => {
  const target = await fixture(t)
  const job = executionJob('custom-run-cancel', target.imported.id)
  await target.store.add(job)
  let idleStops = 0
  let signalTrackerReady
  const trackerReady = new Promise((resolve) => { signalTrackerReady = resolve })
  const comfy = {
    async objectInfo() { return objectInfo },
    async openExecutionTracker() {
      return {
        waitForPrompt(_promptId, signal) {
          return new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true })
            signalTrackerReady()
          })
        },
        close() {},
      }
    },
    async queuePrompt() { return { prompt_id: 'prompt-cancel', number: 1 } },
  }
  const executor = new CustomWorkflowExecutor({
    workflowCenter: target.workflowCenter,
    store: target.store,
    projectStore: target.projectStore,
    comfy,
    runtimeManager: { async ensureReady() {} },
    inspectRuntime: async () => ({ connected: true }),
    managedComfyInputRoot: target.inputRoot,
    scheduleRuntimeIdleStop: async () => { idleStops += 1 },
  })
  const controller = new AbortController()
  const running = executor.run(job.id, { signal: controller.signal })
  await trackerReady
  controller.abort()
  await running
  assert.equal(target.store.get(job.id).status, 'cancelled')
  assert.equal(idleStops, 1)
})

test('custom workflow request validation binds execution to an active project and mapped roles', async (t) => {
  const target = await fixture(t)
  const valid = validateCustomWorkflowJobRequest({
    customWorkflowId: target.imported.id,
    projectId: 'project-custom',
    title: '输出',
    prompt: '受控提示词',
  }, target)
  assert.equal(valid.request.projectId, 'project-custom')
  assert.throws(
    () => validateCustomWorkflowJobRequest({ ...valid.request, width: 512 }, target),
    (error) => error.code === 'CUSTOM_WORKFLOW_PARAMETER_NOT_MAPPED',
  )
  assert.throws(
    () => validateCustomWorkflowJobRequest({ ...valid.request, projectId: 'project-foreign' }, target),
    (error) => error.code === 'WORKSPACE_PROJECT_NOT_FOUND',
  )
})

test('custom workflow summary proves Qwen LoRA family only through a connected registered base loader', async (t) => {
  const target = await fixture(t)
  const qwenObjectInfo = {
    ...objectInfo,
    UNETLoader: { input: { required: { unet_name: [['qwen_image_edit_2511_int8_convrot.safetensors']] } } },
    LoraLoaderModelOnly: { input: { required: { model: ['MODEL', {}], lora_name: [['sub/style.safetensors']], strength_model: ['FLOAT', {}] } } },
  }
  const qwenWorkflow = {
    1: { class_type: 'UNETLoader', inputs: { unet_name: 'qwen_image_edit_2511_int8_convrot.safetensors' } },
    2: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: 'sub/style.safetensors', strength_model: 1 } },
    3: { class_type: 'CLIPTextEncode', inputs: { text: 'original' } },
    4: { class_type: 'SaveImage', inputs: { images: ['3', 0] } },
  }
  const mappings = {
    prompt: { nodeId: '3', inputName: 'text' },
    loraStrength: { nodeId: '2', inputName: 'strength_model' },
    output: { nodeId: '4' },
  }
  const imported = await target.workflowCenter.importCustom({
    title: 'Qwen LoRA 绑定',
    workflow: qwenWorkflow,
    mappings,
    registeredNodeTypes: qwenObjectInfo,
  })
  await target.workflowCenter.setCustomEnabled(imported.id, true, qwenObjectInfo)
  const summary = target.workflowCenter.customExecutionSummary(imported.id)
  assert.deepEqual(summary.loraRequirements, { family: 'qwen-image-edit', names: ['sub/style.safetensors'] })

  const orphan = structuredClone(qwenWorkflow)
  orphan[2].inputs.model = ['99', 0]
  const orphanImported = await target.workflowCenter.importCustom({
    title: '孤立 Qwen LoRA',
    workflow: orphan,
    mappings,
    registeredNodeTypes: qwenObjectInfo,
  })
  await target.workflowCenter.setCustomEnabled(orphanImported.id, true, qwenObjectInfo)
  assert.deepEqual(target.workflowCenter.customExecutionSummary(orphanImported.id).loraRequirements, {
    family: null,
    names: ['sub/style.safetensors'],
  })
})

test('custom workflow job canonicalizes binding strength and rejects missing mappings', async (t) => {
  const target = await fixture(t)
  const original = target.workflowCenter.customExecutionSummary.bind(target.workflowCenter)
  target.workflowCenter.customExecutionSummary = (id) => {
    const summary = original(id)
    return {
      ...summary,
      mappings: { ...summary.mappings, loraStrength: { nodeId: '1', inputName: 'strength_model' } },
      loraRequirements: { family: 'sd15', names: ['style.safetensors'] },
    }
  }
  const binding = { id: 'binding-style', family: 'sd15', sha256: 'a'.repeat(64), role: 'style', strength: 0.75 }
  const body = {
    ...executionJob('lora-validation', target.imported.id).request,
    loraBindings: [binding],
  }
  const validated = validateCustomWorkflowJobRequest(body, target)
  assert.equal(validated.request.loraStrength, 0.75)
  assert.deepEqual(validated.request.loraBindings, [binding])
  target.workflowCenter.customExecutionSummary = (id) => {
    const summary = original(id)
    return { ...summary, loraRequirements: { family: 'sd15', names: ['style.safetensors'] } }
  }
  assert.throws(() => validateCustomWorkflowJobRequest(body, target), { code: 'LORA_STRENGTH_MAPPING_MISSING' })
})

test('executor rejects a LoRA job before waking runtime when verifier is absent', async (t) => {
  const target = await fixture(t)
  const original = target.workflowCenter.customExecutionSummary.bind(target.workflowCenter)
  target.workflowCenter.customExecutionSummary = (id) => {
    const summary = original(id)
    return {
      ...summary,
      mappings: { ...summary.mappings, loraStrength: { nodeId: '1', inputName: 'strength_model' } },
      loraRequirements: { family: 'sd15', names: ['style.safetensors'] },
    }
  }
  const job = executionJob('lora-no-verifier', target.imported.id)
  job.request.loraBindings = [{ id: 'binding-style', family: 'sd15', sha256: 'a'.repeat(64), role: 'style', strength: 1 }]
  job.request.loraStrength = 1
  await target.store.add(job)
  let ensureReadyCalls = 0
  const comfy = fakeComfy({ outputs: { 2: { images: [{ filename: 'result.png', type: 'output' }] } } })
  const executor = new CustomWorkflowExecutor({
    ...target,
    comfy,
    runtimeManager: { async ensureReady() { ensureReadyCalls += 1 } },
    inspectRuntime: async () => ({ connected: true }),
    managedComfyInputRoot: target.inputRoot,
  })
  await executor.run(job.id, { signal: new AbortController().signal })
  assert.equal(ensureReadyCalls, 0)
  assert.equal(comfy.capture.queuedWorkflow, null)
  assert.equal(target.store.get(job.id).error.code, 'CUSTOM_WORKFLOW_LORA_VERIFIER_UNAVAILABLE')
})

test('executor records verified LoRA bindings in workflow metadata and output provenance', async (t) => {
  const target = await fixture(t)
  const originalSummary = target.workflowCenter.customExecutionSummary.bind(target.workflowCenter)
  target.workflowCenter.customExecutionSummary = (id) => {
    const summary = originalSummary(id)
    return {
      ...summary,
      mappings: { ...summary.mappings, loraStrength: { nodeId: '1', inputName: 'strength_model' } },
      loraRequirements: { family: 'sd15', names: ['style.safetensors'] },
    }
  }
  const binding = { id: 'binding-style', family: 'sd15', sha256: 'a'.repeat(64), role: 'style', strength: 1 }
  const job = executionJob('lora-verified', target.imported.id)
  job.request.loraBindings = [binding]
  job.request.loraStrength = 1
  await target.store.add(job)
  const preparedWorkflow = structuredClone(workflow)
  const originalPrepare = target.workflowCenter.prepareCustomExecution.bind(target.workflowCenter)
  target.workflowCenter.prepareCustomExecution = () => ({
    workflow: preparedWorkflow,
    metadata: {
      version: 'aeonquill-custom-workflow-execution-v1',
      customWorkflowId: target.imported.id,
      customWorkflowTitle: target.imported.title,
      workflowHash: target.imported.hash,
      mappingHash: target.imported.mappingHash,
      outputNodeId: '2',
      outputNodeType: 'SaveImage',
      parameterRoles: ['loraStrength', 'prompt'],
      nodeCount: 2,
      weightSet: null,
    },
  })
  t.after(() => { target.workflowCenter.prepareCustomExecution = originalPrepare })
  const record = { binding: structuredClone(binding), modelName: 'style.safetensors', createdAt: 1 }
  const comfy = fakeComfy({ outputs: { 2: { images: [{ filename: 'result.png', type: 'output' }] } } })
  const executor = new CustomWorkflowExecutor({
    ...target,
    comfy,
    verifyLoraBindings: async () => [record],
    runtimeManager: { async ensureReady() {} },
    inspectRuntime: async () => ({ connected: true }),
    managedComfyInputRoot: target.inputRoot,
  })
  await executor.run(job.id, { signal: new AbortController().signal })
  const completed = target.store.get(job.id)
  assert.equal(completed.status, 'completed')
  assert.equal(completed.workflowMetadata.loraBindingsVerified, true)
  assert.deepEqual(completed.workflowMetadata.loraBindings, [record])
  assert.deepEqual(completed.outputVersion.provenance.loraBindings, [record])
})

test('custom image input only accepts project-visible assets and injects a managed ComfyUI filename', async (t) => {
  const target = await fixture(t)
  const imageWorkflow = {
    0: { class_type: 'LoadImage', inputs: { image: 'placeholder.png' } },
    1: { class_type: 'CLIPTextEncode', inputs: { text: 'original' } },
    2: { class_type: 'SaveImage', inputs: { images: ['0', 0], filename_prefix: 'original-prefix' } },
    3: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
  }
  const imageMappings = {
    prompt: { nodeId: '1', inputName: 'text' },
    sourceImage: { nodeId: '0', inputName: 'image' },
    width: { nodeId: '3', inputName: 'width' },
    output: { nodeId: '2' },
  }
  const imported = await target.workflowCenter.importCustom({
    title: '受管输入工作流', workflow: imageWorkflow, mappings: imageMappings, registeredNodeTypes: objectInfo,
  })
  await target.workflowCenter.setCustomEnabled(imported.id, true, objectInfo)
  const projectAsset = await target.projectStore.createLibraryAsset({
    scope: 'project', projectId: 'project-custom', title: '项目输入图', tags: [], collectionIds: [],
    dataUrl: `data:image/png;base64,${png.toString('base64')}`,
  }, { source: 'fixture' })
  const globalAsset = await target.projectStore.createLibraryAsset({
    scope: 'global', title: '未链接全局输入图', tags: [], collectionIds: [],
    dataUrl: `data:image/png;base64,${png.toString('base64')}`,
  }, { source: 'fixture' })

  const validated = validateCustomWorkflowJobRequest({
    customWorkflowId: imported.id,
    projectId: 'project-custom',
    title: '受管输入输出',
    prompt: '保持主体构图',
    sourceLibraryItemId: projectAsset.id,
    width: 720,
  }, target)
  assert.equal(validated.request.sourceLibraryItemId, projectAsset.id)
  assert.equal(validated.request.sourceContentHash, projectAsset.version.assetId)
  assert.throws(() => validateCustomWorkflowJobRequest({ ...validated.request, sourceContentHash: '0'.repeat(64) }, target), { code: 'CUSTOM_WORKFLOW_INPUT_CHANGED' })
  assert.equal(validated.request.width, 720)
  assert.throws(
    () => validateCustomWorkflowJobRequest({ ...validated.request, width: 32 }, target),
    (error) => error.code === 'CUSTOM_WORKFLOW_PARAMETER_RANGE',
  )
  assert.throws(
    () => validateCustomWorkflowJobRequest({ ...validated.request, sourceLibraryItemId: globalAsset.id }, target),
    (error) => error.code === 'LIBRARY_ITEM_FORBIDDEN',
  )

  const job = executionJob('custom-run-input', imported.id)
  job.request = validated.request
  await target.store.add(job)
  const comfy = fakeComfy({ outputs: { 2: { images: [{ filename: 'input-result.png', type: 'output' }] } } })
  const executor = new CustomWorkflowExecutor({
    workflowCenter: target.workflowCenter,
    store: target.store,
    projectStore: target.projectStore,
    comfy,
    runtimeManager: { async ensureReady() {} },
    inspectRuntime: async () => ({ connected: true }),
    managedComfyInputRoot: target.inputRoot,
  })
  await executor.run(job.id, { signal: new AbortController().signal })
  assert.equal(target.store.get(job.id).status, 'completed')
  assert.equal(comfy.capture.uploads.length, 1)
  assert.match(comfy.capture.queuedWorkflow['0'].inputs.image, /^aeonquill-custom-run-input-source\.png$/u)
  assert.equal(comfy.capture.queuedWorkflow['3'].inputs.width, 720)
})

test('mapped output finder ignores other nodes, unsafe paths and unsupported formats', () => {
  assert.deepEqual(findMappedCustomWorkflowOutput({
    outputs: {
      1: { images: [{ filename: 'other.png', type: 'output' }] },
      2: { images: [{ filename: 'result.png', subfolder: 'safe', type: 'output' }] },
    },
  }, '2'), { filename: 'result.png', subfolder: 'safe', type: 'output', mimeType: 'image/png' })
  assert.equal(findMappedCustomWorkflowOutput({ outputs: { 2: { images: [{ filename: '../escape.png', type: 'output' }] } } }, '2'), null)
  assert.equal(findMappedCustomWorkflowOutput({ outputs: { 2: { images: [{ filename: 'result.gif', type: 'output' }] } } }, '2'), null)
})
