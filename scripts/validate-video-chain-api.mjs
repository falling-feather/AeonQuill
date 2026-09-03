import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { chromium } from 'playwright'
import {
  createWorkspaceProject,
  createProjectCatalog,
  touchProjectDocument,
} from '../src/lib/project/projectCatalog.mjs'
import { compileStoryProject, createGenerationPlan } from '../src/lib/story/storyProject.mjs'
import {
  applyVideoProductionCommand,
  createVideoProductionCommand,
  createVideoProductionProjectForStory,
} from '../src/lib/story/productionPipeline.mjs'
import { createLocalVideoCandidateTarget } from '../src/lib/story/localVideoCandidate.mjs'
import { REQUIRED_MODEL_FILES, REQUIRED_NODE_TYPES } from '../server/workflow-builder.mjs'
import { startFakeComfyRuntime } from './qa-fake-comfy.mjs'
import { startIsolatedBridge } from './qa-runtime.mjs'

const PROJECT_ID = 'video-chain-api-project'
const DOCUMENT_ID = 'video-chain-api-document'
const SCRIPT = `场景 1：雨夜山门
镜头 1：全景，沈砚提剑走入山门。
镜头 2：近景，剑锋映出远处的灯火。`
const execFileAsync = promisify(execFile)

function videoObjectInfo() {
  const objectInfo = Object.fromEntries(REQUIRED_NODE_TYPES.map((nodeType) => [nodeType, { input: { required: {} } }]))
  for (const [nodeType, inputName, filename] of REQUIRED_MODEL_FILES) {
    const required = objectInfo[nodeType].input.required
    const filenames = required[inputName]?.[0] || []
    if (!filenames.includes(filename)) filenames.push(filename)
    required[inputName] = [filenames, {}]
  }
  return objectInfo
}

async function requestJson(bridge, pathname, options = {}, expectedStatus = 200) {
  const response = await bridge.request(pathname, {
    ...options,
    headers: options.body ? { 'content-type': 'application/json', ...options.headers } : options.headers,
  })
  const payload = await response.json()
  assert.equal(response.status, expectedStatus, `${options.method || 'GET'} ${pathname}: ${JSON.stringify(payload)}`)
  return payload
}

async function waitForTerminal(bridge, jobId) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const { job } = await requestJson(bridge, `/api/jobs/${encodeURIComponent(jobId)}`)
    if (['completed', 'failed', 'cancelled'].includes(job.status) && job.scheduling?.finishedAt) return job
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Video chain fixture did not finish: ${jobId}`)
}

function command(project, type, payload, sequence) {
  return applyVideoProductionCommand(project, createVideoProductionCommand(project, type, payload, {
    id: `video-chain-api-${sequence}`,
    actor: 'user',
  }), { now: project.updatedAt + 1 })
}

function approveInputs(productionInput) {
  let production = productionInput
  const slots = [
    ...production.continuityGraph.views,
    ...production.continuityGraph.wardrobes,
    ...production.continuityGraph.locations,
    ...production.continuityGraph.frames,
  ]
  let sequence = 1
  for (const slot of slots) {
    production = command(production, 'continuity.asset.bind', {
      targetId: slot.id,
      binding: {
        libraryItemId: `library-chain-api-${sequence}`,
        libraryVersionId: `library-version-chain-api-${sequence}`,
        contentHash: sequence.toString(16).padStart(64, '0'),
        mimeType: 'image/png',
        scope: 'project',
        boundAt: production.updatedAt + 1,
      },
    }, sequence++)
    production = command(production, 'continuity.asset.approve', { targetId: slot.id }, sequence++)
  }
  return production
}

const qaRoot = resolve('.runtime', 'qa-temp')
await mkdir(qaRoot, { recursive: true })
const fixtureRoot = await mkdtemp(join(qaRoot, 'video-chain-media-'))
const fixtureVideoPath = join(fixtureRoot, 'fixture.mp4')
await execFileAsync(process.env.FFMPEG_PATH || 'ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'color=c=0x202938:s=608x352:d=1.0:r=24',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', fixtureVideoPath,
], { windowsHide: true, timeout: 30_000 })
const comfy = await startFakeComfyRuntime({
  objectInfo: videoObjectInfo(),
  output: {
    kind: 'video',
    filename: 'video-chain-fixture.mp4',
    mimeType: 'video/mp4',
    bytes: await readFile(fixtureVideoPath),
  },
})
const bridge = await startIsolatedBridge('video-chain-api', { comfyUrl: comfy.url })
let failure
let browser
try {
  const fixtureProjectNow = Date.now() - 60_000
  const created = createWorkspaceProject(createProjectCatalog(), {
    title: 'VIDEO-010 连续长片纵切',
    initialModeId: 'smart-video',
    color: 'violet',
  }, { projectId: PROJECT_ID, documentId: DOCUMENT_ID, now: fixtureProjectNow })
  let fixtureCatalog = created.catalog
  for (let revision = 1; revision <= 5; revision += 1) {
    fixtureCatalog = touchProjectDocument(fixtureCatalog, PROJECT_ID, DOCUMENT_ID, {
      revision,
    }, { now: fixtureProjectNow + revision })
  }
  const story = compileStoryProject({
    projectId: DOCUMENT_ID,
    kind: 'script',
    text: SCRIPT,
    aspectRatio: '16:9',
    frameStrategy: 'start-end',
    defaultShotSeconds: 5,
    now: 1_800_000_000_100,
  })
  const plan = createGenerationPlan(story, { now: story.updatedAt + 1 })
  const production = approveInputs(createVideoProductionProjectForStory(story, {
    generationMode: 'fast',
    characterMode: 'quick',
    now: story.updatedAt + 2,
  }))
  await requestJson(bridge, '/api/workspace/catalog', {
    method: 'PUT',
    body: JSON.stringify({ catalog: fixtureCatalog, baseRevision: 0, source: 'video-chain-api-qa' }),
  })
  await requestJson(bridge, `/api/workspace/documents/${DOCUMENT_ID}`, {
    method: 'PUT',
    body: JSON.stringify({
      projectId: PROJECT_ID,
      modeId: 'smart-video',
      baseRevision: null,
      revision: 1,
      value: JSON.stringify({ schemaVersion: 2, project: story, plan, production }),
      reason: 'video-chain-api-qa',
      forceRecovery: true,
    }),
  })

  const executionItemIds = ['execution-chain-api-001', 'execution-chain-api-002']
  const targets = production.continuityGraph.shots.slice(0, 2).map((shot, index) => createLocalVideoCandidateTarget({
    projectId: PROJECT_ID,
    documentId: DOCUMENT_ID,
    production,
    shotId: shot.id,
    executionItemId: executionItemIds[index],
  }))
  const request = {
    projectId: PROJECT_ID,
    title: '可信逐镜候选纵切',
    shots: targets.map((candidateTarget, index) => ({
      executionItemId: executionItemIds[index],
      candidateTarget,
      mode: 'text-to-video',
      duration: 5,
      prompt: index === 0 ? '雨夜山门，侠客提剑入场' : '剑锋特写，远处灯火倒映',
      scenario: 'cinematic',
      aspectRatio: '16:9',
      preset: 'fast',
      modelProfile: 'auto',
      seed: 700 + index,
      audio: false,
    })),
    transitionSeconds: 0.2,
    width: 1280,
    height: 720,
    fps: 24,
  }

  const unknownField = structuredClone(request)
  unknownField.shots[0].candidateBinding = { forged: true }
  const rejectedUnknown = await requestJson(bridge, '/api/jobs/video-chain', {
    method: 'POST',
    headers: { 'idempotency-key': 'video-chain-api-unknown-001' },
    body: JSON.stringify(unknownField),
  }, 400)
  assert.equal(rejectedUnknown.error.code, 'INVALID_VIDEO_CHAIN_SHOT_FIELDS')

  const malformedTarget = structuredClone(request)
  malformedTarget.shots[0].candidateTarget.forgedField = true
  const rejectedMalformedTarget = await requestJson(bridge, '/api/jobs/video-chain', {
    method: 'POST',
    headers: { 'idempotency-key': 'video-chain-api-malformed-target-001' },
    body: JSON.stringify(malformedTarget),
  }, 400)
  assert.equal(rejectedMalformedTarget.error.code, 'INVALID_LOCAL_CANDIDATE_FIELDS')

  const duplicate = structuredClone(request)
  duplicate.shots[1].executionItemId = duplicate.shots[0].executionItemId
  delete duplicate.shots[1].candidateTarget
  const rejectedDuplicate = await requestJson(bridge, '/api/jobs/video-chain', {
    method: 'POST',
    headers: { 'idempotency-key': 'video-chain-api-duplicate-001' },
    body: JSON.stringify(duplicate),
  }, 400)
  assert.equal(rejectedDuplicate.error.code, 'DUPLICATE_VIDEO_CHAIN_EXECUTION_ITEM')

  const stale = structuredClone(request)
  stale.shots[0].candidateTarget.productionRevision -= 1
  stale.shots[1].candidateTarget.productionRevision -= 1
  const rejectedStale = await requestJson(bridge, '/api/jobs/video-chain', {
    method: 'POST',
    headers: { 'idempotency-key': 'video-chain-api-stale-001' },
    body: JSON.stringify(stale),
  }, 409)
  assert.equal(rejectedStale.error.code, 'LOCAL_CANDIDATE_PRODUCTION_STALE')

  const submitted = await requestJson(bridge, '/api/jobs/video-chain', {
    method: 'POST',
    headers: { 'idempotency-key': 'video-chain-api-valid-001' },
    body: JSON.stringify(request),
  }, 202)
  assert.equal(submitted.job.workflowVersion, 'aeonquill-video-chain-v2')
  assert.deepEqual(submitted.job.videoChainManifest.shots.map(({ index, status, executionItemId }) => ({ index, status, executionItemId })), [
    { index: 0, status: 'planned', executionItemId: executionItemIds[0] },
    { index: 1, status: 'planned', executionItemId: executionItemIds[1] },
  ])
  assert.equal(JSON.stringify(submitted.job).includes('inputPath'), false)
  const completed = await waitForTerminal(bridge, submitted.job.id)
  assert.equal(completed.status, 'completed', JSON.stringify(completed.error || completed.logs))
  assert.deepEqual(completed.videoChainManifest.shots.map(({ status }) => status), ['completed', 'completed'])
  assert.equal(completed.videoChainManifest.shots.every(({ localCandidateBackfill }) => localCandidateBackfill?.status === 'ready'), true)
  const completedChildIds = completed.videoChainManifest.shots.map(({ childJobId }) => childJobId)
  assert.equal(new Set(completedChildIds).size, 2)
  assert.deepEqual(completed.finalCutMetadata.sourceJobIds, completedChildIds)
  assert.equal(['pass', 'review'].includes(completed.finalCutMetadata.qualityReport?.summary?.status), true)
  assert.equal(completed.finalCutMetadata.qualityReport?.summary?.manualReviewRequired, true)
  const downloadedQuality = await requestJson(bridge, `/api/jobs/${encodeURIComponent(completed.id)}/quality-report`)
  assert.equal(downloadedQuality.jobId, completed.id)
  assert.equal(downloadedQuality.qualityReport.asset.sha256, completed.finalCutMetadata.qualityReport.asset.sha256)
  assert.equal(JSON.stringify(downloadedQuality).match(/[A-Z]:\\|\\Users\\|outputPath|inputPath/iu), null)
  assert.match(completed.outputUrl, /^\/api\/assets\//u)
  assert.equal(comfy.prompts.size, 2)

  const jobsPath = join(bridge.runtimeDirectory, 'jobs.json')
  const persistedJobs = JSON.parse(await readFile(jobsPath, 'utf8'))
  const completedParent = persistedJobs.find(({ id }) => id === completed.id)
  assert.ok(completedParent)
  completedParent.status = 'failed'
  completedParent.phase = 'failed'
  completedParent.detail = 'VIDEO-010 fixture: final delivery interrupted after every shot completed'
  completedParent.error = {
    code: 'VIDEO_CHAIN_FIXTURE_FINAL_INTERRUPTION',
    title: '测试成片中断',
    message: '逐镜输出完整，模拟最终交付中断以验证断点复用。',
    suggestions: ['重试'],
  }
  await writeFile(jobsPath, JSON.stringify(persistedJobs, null, 2), 'utf8')
  await bridge.restart()

  const retry = await requestJson(bridge, `/api/jobs/${encodeURIComponent(completed.id)}/retry`, {
    method: 'POST',
    headers: { 'idempotency-key': 'video-chain-api-retry-001' },
  }, 202)
  const retried = await waitForTerminal(bridge, retry.job.id)
  assert.equal(retried.status, 'completed', JSON.stringify(retried.error || retried.logs))
  assert.deepEqual(retried.videoChainManifest.shots.map(({ status }) => status), ['reused', 'reused'])
  assert.deepEqual(retried.videoChainManifest.shots.map(({ childJobId }) => childJobId), completedChildIds)
  assert.deepEqual(retried.videoChainManifest.shots.map(({ reusedFromChildJobId }) => reusedFromChildJobId), completedChildIds)
  assert.equal(retried.videoChainManifest.shots.every(({ localCandidateBackfill }) => localCandidateBackfill?.status === 'ready'), true)
  assert.deepEqual(retried.finalCutMetadata.sourceJobIds, completedChildIds)
  assert.equal(['pass', 'review'].includes(retried.finalCutMetadata.qualityReport?.summary?.status), true)
  assert.equal(comfy.prompts.size, 2)
  assert.equal(JSON.stringify(retried).match(/[A-Z]:\\|\\Users\\|outputPath|inputPath/iu), null)

  const artifactDirectory = resolve('.runtime', 'qa')
  await mkdir(artifactDirectory, { recursive: true })
  const executablePath = process.platform === 'win32'
    ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    : undefined
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto(bridge.baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  const projectButton = page.locator('.aq-project-row-main').filter({ hasText: 'VIDEO-010 连续长片纵切' })
  await projectButton.waitFor({ state: 'visible', timeout: 10_000 })
  await projectButton.click()
  await page.getByRole('heading', { name: '多智能体制片工作室', exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  await page.locator('.aq-video-tool-rail').getByRole('button', { name: '执行', exact: true }).click()
  const manifests = page.getByLabel('连续长片逐镜执行清单')
  await manifests.first().waitFor({ state: 'visible', timeout: 10_000 })
  assert.ok(await manifests.count() >= 2)
  assert.ok(await page.getByText('可信断点复用', { exact: true }).count() >= 2)
  assert.ok(await page.getByText('候选已入库', { exact: true }).count() >= 2)
  const qualityReports = page.getByLabel('720P 成片质量报告')
  assert.ok(await qualityReports.count() >= 2)
  assert.ok(await page.getByText(/机器交付门通过/u).count() >= 2)
  assert.ok(await page.getByRole('link', { name: '质检 JSON', exact: true }).count() >= 2)
  await manifests.last().scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(artifactDirectory, 'video-chain-manifest-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(120)
  assert.equal(await page.locator('body').evaluate((body) => body.scrollWidth <= body.clientWidth), true)
  assert.equal(await page.locator('.aq-video-workbench').evaluate((body) => body.scrollWidth <= body.clientWidth), true)
  await manifests.last().scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(artifactDirectory, 'video-chain-manifest-mobile.png'), fullPage: true })
  assert.deepEqual(pageErrors, [])

  console.log('✓ VIDEO-010 isolated API and responsive UI validated strict targets, ordered backfill, final-cut order and trusted retry reuse')
} catch (error) {
  failure = error
} finally {
  await browser?.close().catch(() => {})
  await bridge.stop({ keepRuntime: Boolean(failure) }).catch(() => {})
  await comfy.close().catch(() => {})
  if (!failure) await rm(fixtureRoot, { recursive: true, force: true })
}

if (failure) throw failure
