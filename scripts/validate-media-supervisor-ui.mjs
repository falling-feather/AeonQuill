import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { createProjectCatalog, createWorkspaceProject } from '../src/lib/project/projectCatalog.mjs'
import { compileStoryProject, createGenerationPlan } from '../src/lib/story/storyProject.mjs'
import { createVideoProductionProjectForStory } from '../src/lib/story/productionPipeline.mjs'
import { startFakeComfyRuntime } from './qa-fake-comfy.mjs'
import { startIsolatedBridge } from './qa-runtime.mjs'

// The Browser skill is unavailable in this session. Use the installed Edge
// against an isolated bridge; model output is a fixture, never quality evidence.
const projectId = 'media-supervisor-ui-project'
const documentId = 'media-supervisor-ui-document'
const output = resolve('.runtime/qa')
const report = { status: 'failed', generatedAt: new Date().toISOString(), issues: [], checks: [] }
await mkdir(output, { recursive: true })
const comfy = await startFakeComfyRuntime()
const bridge = await startIsolatedBridge('media-supervisor-ui', { comfyUrl: comfy.url })
let browser
let page

async function json(pathname, options = {}, expected = 200) {
  const response = await bridge.request(pathname, { ...options, headers: { 'content-type': 'application/json', ...options.headers } })
  const body = await response.json()
  assert.equal(response.status, expected, `${pathname}: ${JSON.stringify(body)}`)
  return body
}

async function evidence() {
  const { document } = await json(`/api/workspace/documents/${documentId}?projectId=${projectId}&modeId=smart-video`)
  return { ...document, value: JSON.parse(document.value) }
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 20_000
  let latest
  while (Date.now() < deadline) {
    latest = await evidence()
    if (predicate(latest)) return latest
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error(`${label}; runs=${JSON.stringify(latest?.value.production.mediaRuns)}`)
}

try {
  const created = createWorkspaceProject(createProjectCatalog(), { title: '跨媒体执行验收', initialModeId: 'smart-video', color: 'violet' }, { projectId, documentId, now: Date.now() - 60_000 })
  const story = compileStoryProject({ projectId: documentId, kind: 'script', text: '场景 1：清晨庭院\n镜头 1：树叶在风中摇动。\n镜头 2：近景，一杯热茶。', aspectRatio: '16:9', frameStrategy: 'start-end', defaultShotSeconds: 5, now: Date.now() - 30_000 })
  const production = createVideoProductionProjectForStory(story, { now: story.updatedAt + 1 })
  for (const node of production.nodes) {
    if (node.id === 'asset-producer') { node.status = 'ready'; break }
    node.status = 'approved'
    node.outputSummary ||= '已批准的前期创作内容'
  }
  await json('/api/workspace/catalog', { method: 'PUT', body: JSON.stringify({ catalog: created.catalog, baseRevision: 0, source: 'media-supervisor-ui' }) })
  await json(`/api/workspace/documents/${documentId}`, { method: 'PUT', body: JSON.stringify({ projectId, modeId: 'smart-video', baseRevision: null, revision: 1, value: JSON.stringify({ schemaVersion: 2, project: story, plan: createGenerationPlan(story), production }), reason: 'media-supervisor-ui', forceRecovery: true }) })
  const imported = await json('/api/workflow-center/custom', { method: 'POST', body: JSON.stringify({
    title: '受控素材输出', workflow: {
      1: { class_type: 'CLIPTextEncode', inputs: { text: 'source' } },
      2: { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'source' } },
    }, mappings: { prompt: { nodeId: '1', inputName: 'text' }, output: { nodeId: '2' } },
  }) }, 201)
  await json(`/api/workflow-center/custom/${imported.customWorkflow.id}/enabled`, { method: 'POST', body: JSON.stringify({ enabled: true }) })
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) })
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.on('pageerror', (error) => report.issues.push(error.message))
  const submissions = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/jobs/custom-workflow')) submissions.push(request.postDataJSON())
  })
  await page.goto(bridge.baseUrl, { waitUntil: 'domcontentloaded' })
  await page.locator('.aq-project-row-main').filter({ hasText: '跨媒体执行验收' }).click()
  const studio = page.getByRole('region', { name: '多智能体制片工作室' })
  await studio.waitFor({ state: 'visible' })
  const media = studio.getByRole('region', { name: '媒体执行提议' })
  await media.getByRole('combobox', { name: /素材工作流/u }).selectOption(imported.customWorkflow.id)
  await media.getByRole('button', { name: /图像素材/u }).click()
  await media.locator('.is-proposed').waitFor({ state: 'visible' })
  assert.equal(comfy.prompts.size, 0)
  await media.getByRole('button', { name: '拒绝', exact: true }).click()
  await waitFor((entry) => entry.value.production.mediaRuns[0]?.status === 'rejected', 'rejection did not persist')
  assert.equal(comfy.prompts.size, 0)
  report.checks.push('proposal and rejection create no media job')

  await media.getByRole('button', { name: /图像素材/u }).click()
  await media.getByRole('button', { name: '确认并排队', exact: true }).click()
  const completed = await waitFor((entry) => entry.value.production.mediaRuns.some((run) => run.status === 'completed'), 'confirmed media did not complete')
  assert.equal(comfy.prompts.size, 1)
  assert.equal(submissions.length, 1)
  const run = completed.value.production.mediaRuns.find((entry) => entry.status === 'completed')
  const { job } = await json(`/api/jobs/${run.jobId}`)
  assert.equal(job.status, 'completed')
  assert.deepEqual(job.mediaBinding, { projectId, documentId, runId: run.id, inputFingerprint: run.inputFingerprint })
  assert.notEqual(completed.value.production.nodes.find(({ id }) => id === 'asset-producer').status, 'approved')
  report.checks.push('explicit confirmation creates one scoped Job; completion requires human approval')
  report.job = { id: job.id, kind: job.kind, status: job.status, mediaBinding: job.mediaBinding }

  await page.reload({ waitUntil: 'domcontentloaded' })
  await studio.waitFor({ state: 'visible' })
  await media.locator('.is-completed').waitFor({ state: 'visible' })
  assert.equal((await evidence()).value.production.mediaRuns.find((entry) => entry.id === run.id).jobId, job.id)
  assert.equal(comfy.prompts.size, 1)
  report.checks.push('refresh restores execution without repeating it')
  await media.scrollIntoViewIfNeeded()
  await page.screenshot({ path: resolve(output, 'media-supervisor-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await media.scrollIntoViewIfNeeded()
  assert.equal(await page.locator('body').evaluate((body) => body.scrollWidth <= body.clientWidth), true)
  await page.screenshot({ path: resolve(output, 'media-supervisor-mobile.png') })
  assert.deepEqual(report.issues, [])
  report.status = 'passed'
  console.log('✓ Media proposal, rejection, real bridge queue, scoped completion, refresh and narrow layout passed')
} catch (error) {
  report.error = error.stack
  if (page) {
    report.visibleText = (await page.locator('body').innerText().catch(() => '')).slice(-10_000)
    await page.screenshot({ path: resolve(output, 'media-supervisor-failure.png') }).catch(() => {})
  }
  throw error
} finally {
  await writeFile(resolve(output, 'media-supervisor-ui.json'), JSON.stringify(report, null, 2))
  await browser?.close()
  await bridge.stop()
  await comfy.close()
}
