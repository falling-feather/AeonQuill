import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { createProjectCatalog, createWorkspaceProject } from '../src/lib/project/projectCatalog.mjs'
import { compileStoryProject, createGenerationPlan } from '../src/lib/story/storyProject.mjs'
import { createVideoProductionProjectForStory } from '../src/lib/story/productionPipeline.mjs'
import { fakeComfyPng, startFakeComfyRuntime } from './qa-fake-comfy.mjs'
import { startIsolatedBridge } from './qa-runtime.mjs'

// The Browser skill is unavailable in this session. Use the installed Edge
// against an isolated bridge; model output is a fixture, never quality evidence.
const projectId = 'media-supervisor-ui-project'
const documentId = 'media-supervisor-ui-document'
const output = resolve('.runtime/qa')
const report = { status: 'failed', generatedAt: new Date().toISOString(), issues: [], checks: [] }
const referencePng = `data:image/png;base64,${fakeComfyPng.toString('base64')}`
const lastFramePng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
await mkdir(output, { recursive: true })
const comfy = await startFakeComfyRuntime({
  objectInfo: {
    CLIPTextEncode: { input: { required: { text: ['STRING', {}] } } },
    SaveImage: { input: { required: {} } },
    LoadImage: { input: { required: { image: ['STRING', {}] } } },
  },
})
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
  const mapped = await json('/api/workflow-center/custom', { method: 'POST', body: JSON.stringify({
    title: '受控双参考素材输出', workflow: {
      1: { class_type: 'CLIPTextEncode', inputs: { text: 'source' } },
      2: { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'source' } },
      3: { class_type: 'LoadImage', inputs: { image: 'source.png' } },
      4: { class_type: 'LoadImage', inputs: { image: 'last.png' } },
    }, mappings: {
      prompt: { nodeId: '1', inputName: 'text' },
      sourceImage: { nodeId: '3', inputName: 'image' },
      lastFrame: { nodeId: '4', inputName: 'image' },
      output: { nodeId: '2' },
    },
  }) }, 201)
  await json(`/api/workflow-center/custom/${mapped.customWorkflow.id}/enabled`, { method: 'POST', body: JSON.stringify({ enabled: true }) })
  const sourceAsset = await json('/api/library/assets', { method: 'POST', body: JSON.stringify({
    scope: 'project', projectId, title: '双参考首帧', description: 'AI-006 UI fixture', tags: ['qa'], dataUrl: referencePng,
  }) }, 201)
  const lastFrameAsset = await json('/api/library/assets', { method: 'POST', body: JSON.stringify({
    scope: 'project', projectId, title: '双参考末帧', description: 'AI-006 UI fixture', tags: ['qa'], dataUrl: lastFramePng,
  }) }, 201)
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) })
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.on('pageerror', (error) => report.issues.push(error.message))
  const submissions = []
  const soundSubmissions = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/jobs/custom-workflow')) submissions.push(request.postDataJSON())
    if (request.method() === 'POST' && request.url().endsWith('/api/jobs/sound-render')) soundSubmissions.push(request.postDataJSON())
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
  assert.deepEqual(run.preparation, { kind: 'image', workflowId: imported.customWorkflow.id })
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

  await media.getByRole('combobox', { name: /素材工作流/u }).selectOption(mapped.customWorkflow.id)
  await media.getByRole('combobox', { name: '参考图', exact: true }).selectOption(sourceAsset.asset.id)
  await media.getByRole('combobox', { name: '第二张参考图', exact: true }).selectOption(lastFrameAsset.asset.id)
  await media.getByRole('button', { name: /图像素材/u }).click()
  const proposedWithReferences = await waitFor(
    (entry) => entry.value.production.mediaRuns.some((candidate) => candidate.status === 'proposed' && candidate.preparation?.workflowId === mapped.customWorkflow.id),
    'double-reference proposal did not persist',
  )
  const referenceRun = proposedWithReferences.value.production.mediaRuns.find((candidate) => candidate.status === 'proposed' && candidate.preparation?.workflowId === mapped.customWorkflow.id)
  assert.deepEqual(referenceRun.preparation, {
    kind: 'image',
    workflowId: mapped.customWorkflow.id,
    sourceLibraryItemId: sourceAsset.asset.id,
    sourceContentHash: sourceAsset.asset.version.assetId,
    lastFrameLibraryItemId: lastFrameAsset.asset.id,
    lastFrameContentHash: lastFrameAsset.asset.version.assetId,
  })
  report.checks.push('first proposal records both reference IDs and version hashes')

  await page.reload({ waitUntil: 'domcontentloaded' })
  await studio.waitFor({ state: 'visible' })
  await media.locator('.is-proposed').last().waitFor({ state: 'visible' })
  await media.getByRole('button', { name: '确认并排队', exact: true }).last().click()
  const referenceCompleted = await waitFor(
    (entry) => entry.value.production.mediaRuns.some((candidate) => candidate.status === 'completed' && candidate.preparation?.workflowId === mapped.customWorkflow.id),
    'double-reference media did not complete after refresh',
  )
  const referenceCompletedRun = referenceCompleted.value.production.mediaRuns.find((candidate) => candidate.status === 'completed' && candidate.preparation?.workflowId === mapped.customWorkflow.id)
  const referenceSubmission = submissions.find(({ mediaBinding }) => mediaBinding?.runId === referenceCompletedRun.id)
  assert.equal(referenceSubmission?.customWorkflowId, mapped.customWorkflow.id)
  assert.equal(referenceSubmission?.sourceLibraryItemId, sourceAsset.asset.id)
  assert.equal(referenceSubmission?.sourceContentHash, sourceAsset.asset.version.assetId)
  assert.equal(referenceSubmission?.lastFrameLibraryItemId, lastFrameAsset.asset.id)
  assert.equal(referenceSubmission?.lastFrameContentHash, lastFrameAsset.asset.version.assetId)
  assert.equal(comfy.prompts.size, 2)
  report.checks.push('refresh restores the saved workflow and both reference versions for one confirmed Job')

  await media.getByRole('combobox', { name: /素材工作流/u }).selectOption(mapped.customWorkflow.id)
  await media.getByRole('combobox', { name: '参考图', exact: true }).selectOption(sourceAsset.asset.id)
  await media.getByRole('combobox', { name: '第二张参考图', exact: true }).selectOption(lastFrameAsset.asset.id)
  await media.getByRole('button', { name: /图像素材/u }).click()
  const staleProposal = await waitFor(
    (entry) => entry.value.production.mediaRuns.some((candidate) => candidate.status === 'proposed' && candidate.preparation?.workflowId === mapped.customWorkflow.id),
    'version-change proposal did not persist',
  )
  const staleRun = staleProposal.value.production.mediaRuns.find((candidate) => candidate.status === 'proposed' && candidate.preparation?.workflowId === mapped.customWorkflow.id)
  await json(`/api/library/assets/${encodeURIComponent(sourceAsset.asset.id)}/versions`, {
    method: 'POST', body: JSON.stringify({ projectId, dataUrl: lastFramePng }),
  }, 201)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await studio.waitFor({ state: 'visible' })
  await media.locator('.is-proposed').last().waitFor({ state: 'visible' })
  await media.getByRole('button', { name: '确认并排队', exact: true }).last().click()
  await page.waitForFunction(() => document.body.innerText.includes('参考图版本已变化'), null, { timeout: 5_000 })
  const afterVersionChange = await evidence()
  assert.equal(afterVersionChange.value.production.mediaRuns.find((candidate) => candidate.id === staleRun.id)?.status, 'proposed')
  assert.equal(comfy.prompts.size, 2)
  report.checks.push('changed reference version is rejected before a new Job and leaves the proposal intact')

  const speechFixture = await evidence()
  const speechProduction = speechFixture.value.production
  const soundNodeIndex = speechProduction.nodes.findIndex(({ id }) => id === 'sound-director')
  assert.ok(soundNodeIndex >= 0)
  const fixtureNow = Math.max(Date.now(), speechProduction.updatedAt)
  speechProduction.nodes.forEach((node, index) => {
    node.status = index < soundNodeIndex ? 'approved' : index === soundNodeIndex ? 'ready' : 'waiting'
    node.stale = false
    node.error = null
    node.updatedAt = fixtureNow
  })
  speechProduction.mediaRuns = []
  speechProduction.revision += 1
  speechProduction.updatedAt = fixtureNow
  const documentRevision = Number.isSafeInteger(speechFixture.revision) ? speechFixture.revision : 1
  await json(`/api/workspace/documents/${documentId}`, {
    method: 'PUT',
    body: JSON.stringify({
      projectId,
      modeId: 'smart-video',
      baseRevision: documentRevision,
      revision: documentRevision + 1,
      value: JSON.stringify({ ...speechFixture.value, production: speechProduction }),
      reason: 'media-supervisor-speech-budget-fixture',
      forceRecovery: true,
    }),
  })
  const catalogSnapshot = await json('/api/workspace/catalog')
  const nextCatalog = structuredClone(catalogSnapshot.catalog)
  const catalogProject = nextCatalog.projects.find(({ id }) => id === projectId)
  const catalogDocument = catalogProject?.documents.find(({ id }) => id === documentId)
  assert.ok(catalogDocument)
  catalogDocument.revision = documentRevision + 1
  nextCatalog.revision = catalogSnapshot.catalog.revision + 1
  await json('/api/workspace/catalog', {
    method: 'PUT',
    body: JSON.stringify({ catalog: nextCatalog, baseRevision: catalogSnapshot.catalog.revision, source: 'media-supervisor-speech-budget-fixture' }),
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await studio.waitFor({ state: 'visible' })
  const speechBudget = media.getByRole('spinbutton', { name: '本次配音费用上限（美元）', exact: true })
  await speechBudget.waitFor({ state: 'visible' })
  await speechBudget.fill('13.75')
  await media.getByRole('button', { name: /对白生成/u }).click()
  await new Promise((done) => setTimeout(done, 500))
  const speechAfterClick = await evidence()
  if (!speechAfterClick.value.production.mediaRuns.some((candidate) => candidate.status === 'proposed' && candidate.kind === 'prepare-speech')) {
    const notices = await media.locator('.aq-production-notice').allInnerTexts().catch(() => [])
    throw new Error(`non-default speech budget proposal did not persist; notices=${JSON.stringify(notices)}`)
  }
  const speechProposal = await waitFor(
    (entry) => entry.value.production.mediaRuns.some((candidate) => candidate.status === 'proposed' && candidate.kind === 'prepare-speech'),
    'non-default speech budget proposal did not persist',
  )
  const speechRun = speechProposal.value.production.mediaRuns.find((candidate) => candidate.status === 'proposed' && candidate.kind === 'prepare-speech')
  assert.deepEqual(speechRun.preparation, { kind: 'prepare-speech', speechBudgetUsd: 13.75 })
  report.checks.push('non-default speech budget is persisted as a preparation descriptor')

  await page.reload({ waitUntil: 'domcontentloaded' })
  await studio.waitFor({ state: 'visible' })
  await media.locator('.is-proposed').last().waitFor({ state: 'visible' })
  await media.getByRole('button', { name: '确认并排队', exact: true }).last().click()
  const soundDeadline = Date.now() + 5_000
  while (soundSubmissions.length < 1 && Date.now() < soundDeadline) await new Promise((done) => setTimeout(done, 50))
  assert.equal(soundSubmissions.length, 1)
  assert.equal(soundSubmissions[0].action, 'prepare-speech')
  assert.equal(soundSubmissions[0].speechBudgetUsd, 13.75)
  const afterSpeechConfirm = await evidence()
  assert.equal(afterSpeechConfirm.value.production.mediaRuns.find((candidate) => candidate.id === speechRun.id)?.status, 'proposed')
  assert.equal(comfy.prompts.size, 2)
  report.checks.push('refresh restores the non-default speech budget; unconfigured TTS rejects before creating a Job')
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
