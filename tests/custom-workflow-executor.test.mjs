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
