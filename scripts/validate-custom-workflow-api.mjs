import assert from 'node:assert/strict'

import { createProjectCatalog, createWorkspaceProject } from '../src/lib/project/projectCatalog.mjs'
import { fakeComfyPng, startFakeComfyRuntime } from './qa-fake-comfy.mjs'
import { startIsolatedBridge } from './qa-runtime.mjs'

async function waitForTerminal(bridge, jobId) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const response = await bridge.request(`/api/jobs/${encodeURIComponent(jobId)}`)
    const { job } = await response.json()
    assert.equal(response.status, 200)
    if (['completed', 'failed', 'cancelled'].includes(job.status) && job.scheduling?.finishedAt) return job
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Custom workflow job did not finish: ${jobId}`)
}

async function requestJson(bridge, pathname, options = {}, expected = 200) {
  const response = await bridge.request(pathname, {
    ...options,
    headers: options.body ? { 'content-type': 'application/json', ...options.headers } : options.headers,
  })
  const payload = await response.json()
  assert.equal(response.status, expected, `${options.method || 'GET'} ${pathname}: ${JSON.stringify(payload)}`)
  return payload
}

const comfy = await startFakeComfyRuntime()
const bridge = await startIsolatedBridge('custom-workflow-api', { comfyUrl: comfy.url })
let failure
try {
  const created = createWorkspaceProject(createProjectCatalog(), {
    title: '自定义工作流 API 纵切', initialModeId: 'balanced', color: 'violet',
  }, { projectId: 'project-custom-api', documentId: 'document-custom-api', now: 1_000 })
  await requestJson(bridge, '/api/workspace/catalog', {
    method: 'PUT', body: JSON.stringify({ catalog: created.catalog, baseRevision: 0, source: 'custom-workflow-api-qa' }),
  })
  const custom = await requestJson(bridge, '/api/workflow-center/custom', {
    method: 'POST',
    body: JSON.stringify({
      title: 'API 固定图片输出',
      workflow: {
        1: { class_type: 'CLIPTextEncode', inputs: { text: 'original' } },
        2: { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'original' } },
      },
      mappings: { prompt: { nodeId: '1', inputName: 'text' }, output: { nodeId: '2' } },
    }),
  }, 201)
  assert.match(custom.customWorkflow.mappingHash, /^[a-f0-9]{64}$/u)
  await requestJson(bridge, `/api/workflow-center/custom/${custom.customWorkflow.id}/enabled`, {
    method: 'POST', body: JSON.stringify({ enabled: true }),
  })

  const recipeInput = {
    name: 'API 可复用配方', workflowId: custom.customWorkflow.id,
    workflowHash: custom.customWorkflow.hash, mappingHash: custom.customWorkflow.mappingHash, parameters: {},
  }
  const savedRecipe = await requestJson(bridge, '/api/workflow-center/recipes', {
    method: 'POST', body: JSON.stringify(recipeInput),
  }, 201)
  const recipeCatalog = await requestJson(bridge, '/api/workflow-center/recipes')
  assert.equal(recipeCatalog.recipes[0].id, savedRecipe.recipe.id)
  assert.equal(recipeCatalog.recipes[0].availability, 'ready')
  const resolvedRecipe = await requestJson(bridge, `/api/workflow-center/recipes/${savedRecipe.recipe.id}/resolve`, {
    method: 'POST', body: '{}',
  })
  assert.deepEqual(resolvedRecipe.recipe.parameters, {})
  const privateRecipe = await requestJson(bridge, '/api/workflow-center/recipes', {
    method: 'POST', body: JSON.stringify({ ...recipeInput, prompt: 'must not be retained' }),
  }, 400)
  assert.equal(privateRecipe.error.code, 'INVALID_WORKFLOW_RECIPE')

  const rejected = await requestJson(bridge, '/api/jobs/custom-workflow', {
    method: 'POST',
    body: JSON.stringify({ customWorkflowId: custom.customWorkflow.id, projectId: 'project-custom-api', title: '拒绝', prompt: 'x', arbitraryPath: 'D:\\escape' }),
  }, 400)
  assert.equal(rejected.error.code, 'CUSTOM_WORKFLOW_JOB_UNKNOWN_FIELD')

  const queued = await requestJson(bridge, '/api/jobs/custom-workflow', {
    method: 'POST',
    headers: { 'idempotency-key': 'custom-api-complete-0001' },
    body: JSON.stringify({ customWorkflowId: custom.customWorkflow.id, projectId: 'project-custom-api', title: '纵切输出', prompt: 'complete-output' }),
  }, 202)
  const completed = await waitForTerminal(bridge, queued.job.id)
  assert.equal(completed.status, 'completed')
  assert.equal(completed.kind, 'custom-workflow')
  assert.equal(completed.outputVersion.provenance.source, 'custom-comfy-workflow')
  assert.equal(completed.outputVersion.provenance.customWorkflowId, custom.customWorkflow.id)
  assert.match(completed.outputUrl, /^\/api\/project-assets\/[a-f0-9]{64}$/u)
  const outputResponse = await bridge.request(completed.outputUrl)
  assert.equal(outputResponse.status, 200)
  assert.deepEqual(Buffer.from(await outputResponse.arrayBuffer()), fakeComfyPng)
  const history = await requestJson(bridge, `/api/workflow-center/custom/${custom.customWorkflow.id}/runs?projectId=project-custom-api`)
  assert.equal(history.jobs.length, 1)
  assert.equal(history.jobs[0].id, completed.id)
  await requestJson(bridge, `/api/workflow-center/custom/${custom.customWorkflow.id}/runs?projectId=project-not-found`, {}, 404)

  const missing = await requestJson(bridge, '/api/jobs/custom-workflow', {
    method: 'POST',
    headers: { 'idempotency-key': 'custom-api-missing-0001' },
    body: JSON.stringify({ customWorkflowId: custom.customWorkflow.id, projectId: 'project-custom-api', title: '缺失输出', prompt: 'missing-output' }),
  }, 202)
  const failed = await waitForTerminal(bridge, missing.job.id)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error.code, 'CUSTOM_WORKFLOW_OUTPUT_MISSING')

  const cancellable = await requestJson(bridge, '/api/jobs/custom-workflow', {
    method: 'POST',
    headers: { 'idempotency-key': 'custom-api-cancel-0001' },
    body: JSON.stringify({ customWorkflowId: custom.customWorkflow.id, projectId: 'project-custom-api', title: '取消输出', prompt: 'wait-cancel' }),
  }, 202)
  const runningDeadline = Date.now() + 10_000
  while (Date.now() < runningDeadline) {
    const snapshot = await requestJson(bridge, `/api/jobs/${cancellable.job.id}`)
    if (snapshot.job.comfyPromptId) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const blockedDisable = await requestJson(bridge, `/api/workflow-center/custom/${custom.customWorkflow.id}/enabled`, {
    method: 'POST', body: JSON.stringify({ enabled: false }),
  }, 409)
  assert.equal(blockedDisable.error.code, 'CUSTOM_WORKFLOW_IN_USE')
  const blockedDelete = await requestJson(bridge, `/api/workflow-center/custom/${custom.customWorkflow.id}`, {
    method: 'DELETE',
  }, 409)
  assert.equal(blockedDelete.error.code, 'CUSTOM_WORKFLOW_IN_USE')
  await requestJson(bridge, `/api/jobs/${cancellable.job.id}/cancel`, { method: 'POST' })
  const cancelled = await waitForTerminal(bridge, cancellable.job.id)
  assert.equal(cancelled.status, 'cancelled')
  assert.ok(comfy.interrupted >= 1)

  const assets = await requestJson(bridge, '/api/library/assets?scope=project&projectId=project-custom-api')
  assert.equal(assets.assets.length, 1)
  assert.equal(assets.assets[0].version.assetId, completed.outputVersion.assetId)
  console.log(`✓ Custom workflow API executed, backfilled, failed closed and cancelled (${comfy.prompts.size} prompts)`)
} catch (error) {
  failure = error
} finally {
  await bridge.stop({ keepRuntime: Boolean(failure) }).catch(() => {})
  await comfy.close().catch(() => {})
}

if (failure) throw failure
