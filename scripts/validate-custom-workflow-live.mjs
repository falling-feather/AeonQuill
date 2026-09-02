import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createProjectCatalog, createWorkspaceProject } from '../src/lib/project/projectCatalog.mjs'
import { startIsolatedBridge } from './qa-runtime.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const comfyRoot = process.env.AEONQUILL_COMFY_ROOT
const pythonPath = process.env.AEONQUILL_COMFY_PYTHON
if (!comfyRoot || !pythonPath) {
  throw new Error('Set AEONQUILL_COMFY_ROOT and AEONQUILL_COMFY_PYTHON to run the live custom workflow validation')
}
await Promise.all([stat(join(comfyRoot, 'main.py')), stat(pythonPath)])

const qaRoot = resolve(projectRoot, '.runtime')
await mkdir(qaRoot, { recursive: true })
const liveRuntime = join(qaRoot, `custom-workflow-live-${process.pid}`)
const comfyUrl = process.env.COMFY_URL || 'http://127.0.0.1:8188'

function assertSafeLiveRuntime(pathname) {
  const candidate = resolve(pathname)
  if (!candidate.startsWith(`${qaRoot}${sep}`) || !basename(candidate).startsWith('custom-workflow-live-')) {
    throw new Error(`Refusing to clean unexpected live QA directory: ${candidate}`)
  }
}

async function cleanStaleDirectories(root, prefix) {
  const absoluteRoot = resolve(root)
  for (const entry of await readdir(absoluteRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue
    const target = resolve(absoluteRoot, entry.name)
    if (!target.startsWith(`${absoluteRoot}${sep}`) || basename(target) !== entry.name) {
      throw new Error(`Refusing to clean unexpected live QA directory: ${target}`)
    }
    await rm(target, { recursive: true, force: true })
  }
}

await Promise.all([
  cleanStaleDirectories(qaRoot, 'custom-workflow-live-'),
  cleanStaleDirectories(tmpdir(), 'miaohui-custom-workflow-live-'),
])
await mkdir(liveRuntime, { recursive: false })
const inputPng = await readFile(join(projectRoot, 'src', 'assets', 'sample-summer-character.png'))

async function requestJson(bridge, pathname, options = {}, expected = 200) {
  const response = await bridge.request(pathname, {
    ...options,
    headers: options.body ? { 'content-type': 'application/json', ...options.headers } : options.headers,
  })
  const payload = await response.json()
  assert.equal(response.status, expected, `${options.method || 'GET'} ${pathname}: ${JSON.stringify(payload)}`)
  return payload
}

async function waitForTerminal(bridge, jobId) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const { job } = await requestJson(bridge, `/api/jobs/${encodeURIComponent(jobId)}`)
    if (['completed', 'failed', 'cancelled'].includes(job.status) && job.scheduling?.finishedAt) return job
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
  }
  throw new Error(`Live custom workflow job did not finish: ${jobId}`)
}

let bridge
let failure
try {
  bridge = await startIsolatedBridge('custom-workflow-live', {
    comfyUrl,
    comfyPolicy: 'idle',
    environment: {
      MIAOHUI_RUNTIME_DIR: liveRuntime,
      AEONQUILL_COMFY_ROOT: comfyRoot,
      AEONQUILL_COMFY_PYTHON: pythonPath,
      AEONQUILL_COMFY_POLICY: 'idle',
      AEONQUILL_COMFY_IDLE_SECONDS: '30',
      COMFY_URL: comfyUrl,
    },
  })
  const created = createWorkspaceProject(createProjectCatalog(), {
    title: '真实 ComfyUI 自定义纵切', initialModeId: 'balanced', color: 'violet',
  }, { projectId: 'project-custom-live', documentId: 'document-custom-live', now: 3_000 })
  await requestJson(bridge, '/api/workspace/catalog', {
    method: 'PUT', body: JSON.stringify({ catalog: created.catalog, baseRevision: 0, source: 'custom-workflow-live-qa' }),
  })
  const input = await requestJson(bridge, '/api/library/assets', {
    method: 'POST',
    body: JSON.stringify({
      scope: 'project',
      projectId: 'project-custom-live',
      title: '真实 ComfyUI 输入图',
      tags: ['qa', 'custom-workflow'],
      collectionIds: [],
      dataUrl: `data:image/png;base64,${inputPng.toString('base64')}`,
    }),
  }, 201)
  const imported = await requestJson(bridge, '/api/workflow-center/custom', {
    method: 'POST',
    body: JSON.stringify({
      title: '真实 LoadImage PreviewImage',
      workflow: {
        1: { class_type: 'LoadImage', inputs: { image: 'placeholder.png' } },
        2: { class_type: 'PreviewImage', inputs: { images: ['1', 0] } },
        3: { class_type: 'CLIPTextEncode', inputs: { text: 'orphan prompt mapping' } },
      },
      mappings: {
        prompt: { nodeId: '3', inputName: 'text' },
        sourceImage: { nodeId: '1', inputName: 'image' },
        output: { nodeId: '2' },
      },
    }),
  }, 201)
  await requestJson(bridge, `/api/workflow-center/custom/${imported.customWorkflow.id}/enabled`, {
    method: 'POST', body: JSON.stringify({ enabled: true }),
  })
  const queued = await requestJson(bridge, '/api/jobs/custom-workflow', {
    method: 'POST',
    headers: { 'idempotency-key': 'custom-live-preview-0001' },
    body: JSON.stringify({
      customWorkflowId: imported.customWorkflow.id,
      projectId: 'project-custom-live',
      title: '真实 PreviewImage 输出',
      prompt: 'live protocol traversal',
      sourceLibraryItemId: input.asset.id,
    }),
  }, 202)
  const completed = await waitForTerminal(bridge, queued.job.id)
  assert.equal(completed.status, 'completed', JSON.stringify(completed.error || completed.logs))
  assert.equal(completed.outputVersion.provenance.source, 'custom-comfy-workflow')
  assert.equal(completed.outputVersion.mimeType, 'image/png')
  assert.ok(completed.outputVersion.bytes > 0)
  const outputResponse = await bridge.request(completed.outputUrl)
  assert.equal(outputResponse.status, 200)
  assert.ok((await outputResponse.arrayBuffer()).byteLength > 0)
  console.log(`✓ Live ComfyUI custom workflow completed via LoadImage → PreviewImage (${completed.outputVersion.bytes} bytes)`)
} catch (error) {
  failure = error
  console.error(JSON.stringify({ error: error.message, bridgeLogs: bridge?.logs() }, null, 2))
} finally {
  await bridge?.stop({ keepRuntime: false }).catch(() => undefined)
  assertSafeLiveRuntime(liveRuntime)
  await rm(liveRuntime, { recursive: true, force: true }).catch(() => undefined)
}

if (failure) throw failure
