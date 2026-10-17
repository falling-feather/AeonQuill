import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { chromium } from 'playwright'

import {
  applyVideoProductionCommand,
  createVideoProductionCommand,
  createVideoProductionProjectForStory,
} from '../src/lib/story/productionPipeline.mjs'
import { compileStoryProject, createGenerationPlan } from '../src/lib/story/storyProject.mjs'
import { createProjectCatalog, createWorkspaceProject, touchProjectDocument } from '../src/lib/project/projectCatalog.mjs'
import { startIsolatedBridge } from './qa-runtime.mjs'

const execFileAsync = promisify(execFile)
const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const reportPath = resolve(projectRoot, '.runtime', 'qa', 'audio-remix-ui.json')
const PROJECT_ID = 'audio-remix-ui-project'
const DOCUMENT_ID = 'audio-remix-ui-document'
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'D:/钮/特殊工具库/ffmpeg/bin/ffmpeg.exe'
const FFPROBE_PATH = process.env.FFPROBE_PATH || 'D:/钮/特殊工具库/ffmpeg/bin/ffprobe.exe'

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

async function requestJson(bridge, pathname, options = {}, expectedStatus = 200) {
  const response = await bridge.request(pathname, {
    ...options,
    headers: options.body ? { 'content-type': 'application/json', ...options.headers } : options.headers,
  })
  const payload = await response.json().catch(() => ({}))
  assert.equal(response.status, expectedStatus, `${options.method || 'GET'} ${pathname}: ${JSON.stringify(payload)}`)
  return payload
}

async function createTone(filePath, frequency, durationSeconds = 4) {
  await execFileAsync(FFMPEG_PATH, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=48000:duration=${durationSeconds}`,
    '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', filePath,
  ], { windowsHide: true, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })
}

async function probeAudio(ffprobePath, filePath) {
  const { stdout } = await execFileAsync(ffprobePath, [
    '-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=sample_rate,channels,duration:format=duration',
    '-of', 'json', filePath,
  ], { windowsHide: true, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })
  const parsed = JSON.parse(stdout)
  const stream = parsed.streams?.[0] || {}
  return {
    sampleRate: Number(stream.sample_rate),
    channels: Number(stream.channels),
    duration: Number(stream.duration ?? parsed.format?.duration),
  }
}

function command(production, type, payload, sequence) {
  return applyVideoProductionCommand(
    production,
    createVideoProductionCommand(production, type, payload, {
      id: `audio-remix-ui-${sequence}`,
      actor: 'user',
    }),
    { now: production.updatedAt + 1 },
  )
}

function binding(asset, now) {
  return {
    libraryItemId: asset.id,
    libraryVersionId: asset.version.id,
    contentHash: asset.version.assetId,
    mimeType: asset.version.mimeType,
    scope: 'project',
    boundAt: now,
  }
}

async function waitForJob(bridge, jobId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let latest
  while (Date.now() < deadline) {
    latest = (await requestJson(bridge, `/api/jobs/${encodeURIComponent(jobId)}`)).job
    if (['completed', 'failed', 'cancelled'].includes(latest.status) && latest.scheduling?.finishedAt) return latest
    await delay(150)
  }
  throw new Error(`Sound Job did not finish: ${jobId}; latest=${JSON.stringify({ status: latest?.status, detail: latest?.detail })}`)
}

async function projectEvidence(bridge) {
  const { document } = await requestJson(bridge, `/api/workspace/documents/${DOCUMENT_ID}?projectId=${PROJECT_ID}&modeId=smart-video`)
  return { ...document, value: JSON.parse(document.value) }
}

async function soundJobList(bridge) {
  const { jobs } = await requestJson(bridge, '/api/jobs')
  return jobs.filter((job) => (
    job.kind === 'sound-render'
    && job.request?.projectId === PROJECT_ID
    && job.request?.documentId === DOCUMENT_ID
    && job.request?.action === 'render-local'
  )).sort((left, right) => right.createdAt - left.createdAt)
}

async function waitForUiJob(bridge, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let jobs = []
  while (Date.now() < deadline) {
    jobs = await soundJobList(bridge)
    const match = jobs.find(predicate)
    if (match) return match
    await delay(150)
  }
  throw new Error(`Timed out waiting for UI sound Job; jobs=${JSON.stringify(jobs.map(({ id, status, retryOf }) => ({ id, status, retryOf })))}`)
}

function observePage(page, issues) {
  page.on('pageerror', (error) => issues.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if ((message.type() === 'error' || message.type() === 'warning') && !message.text().includes('Failed to load resource')) {
      issues.push(`${message.type()}: ${message.text()}`)
    }
  })
  page.on('response', (response) => {
    if (response.status() >= 400) issues.push(`http ${response.status()}: ${response.url()}`)
  })
}

async function selectSoundNode(studio) {
  const node = studio.getByRole('listitem').filter({ hasText: '自动剪辑' }).first()
  await node.click()
  const sound = studio.getByRole('region', { name: '声音字幕时间线' })
  await sound.waitFor({ state: 'visible', timeout: 15_000 })
  const mixTab = sound.locator('nav[aria-label="声音工作区"] button').filter({ hasText: '样式/混音' }).first()
  const mixGrid = sound.locator('.aq-sound-mix-grid')
  for (let attempt = 0; attempt < 4 && !(await mixGrid.isVisible().catch(() => false)); attempt += 1) {
    await mixTab.evaluate((element) => element.click())
    await delay(250)
  }
  await mixGrid.waitFor({ state: 'visible', timeout: 5_000 })
  return sound
}

async function waitForVisible(locator, timeoutMs = 15_000) {
  await locator.waitFor({ state: 'visible', timeout: timeoutMs })
  return locator
}

const fixtureRoot = await mkdtemp(join(resolve(projectRoot, '.runtime', 'qa-temp'), 'audio-remix-ui-'))
let bridge
let browser
let page
let failure = null
const issues = []
const report = {
  schemaVersion: 1,
  kind: 'aeonquill.qa.audio-remix-ui',
  status: 'failed',
  generatedAt: new Date().toISOString(),
  projectId: PROJECT_ID,
  documentId: DOCUMENT_ID,
  fixtureRoot,
  fixtureBoundary: '本机 FFmpeg 正弦波夹具；结构与 Job 元数据证据不代表音质盲审。',
  checks: [],
}

try {
  await stat(FFMPEG_PATH)
  await stat(FFPROBE_PATH)

  const now = Date.now() - 60_000
  const created = createWorkspaceProject(createProjectCatalog(), {
    title: 'AUDIO-001 局部重混 UI', initialModeId: 'smart-video', color: 'violet',
  }, { projectId: PROJECT_ID, documentId: DOCUMENT_ID, now })
  const story = compileStoryProject({
    projectId: DOCUMENT_ID,
    title: '局部重混 UI 夹具',
    kind: 'script',
    text: '场景 1：庭院\n镜头 1：三人交谈\n甲：第一句测试。\n乙：第二句测试。\n丙：第三句保留。',
    aspectRatio: '16:9', frameStrategy: 'start-end', defaultShotSeconds: 5, now: now + 1,
  })
  const plan = createGenerationPlan(story, { now: story.updatedAt + 1 })
  let production = createVideoProductionProjectForStory(story, {
    generationMode: 'fast', characterMode: 'quick', now: story.updatedAt + 2,
  })
  const speechCues = production.soundTimeline.audioCues.filter(({ kind }) => kind === 'dialogue')
  assert.equal(speechCues.length, 3)
  const selectedCueIds = speechCues.slice(0, 2).map(({ id }) => id)
  const preservedCueId = speechCues[2].id
  let sequence = 1

  bridge = await startIsolatedBridge('audio-remix-ui', { environment: { FFMPEG_PATH, FFPROBE_PATH } })
  await requestJson(bridge, '/api/workspace/catalog', {
    method: 'PUT', body: JSON.stringify({ catalog: created.catalog, baseRevision: 0, source: 'audio-remix-ui' }),
  })
  const tonePaths = [440, 660, 880].map((frequency) => join(fixtureRoot, `tone-${frequency}.wav`))
  for (const [index, frequency] of [440, 660, 880].entries()) await createTone(tonePaths[index], frequency)
  const assets = []
  for (const [index, tonePath] of tonePaths.entries()) {
    const payload = await requestJson(bridge, '/api/library/assets', {
      method: 'POST',
      body: JSON.stringify({
        scope: 'project', projectId: PROJECT_ID, title: `局部重混 UI 音频 ${index + 1}`,
        description: 'AUDIO-001 deterministic local FFmpeg fixture', tags: ['qa', 'sound-remix'], collectionIds: [],
        dataUrl: `data:audio/wav;base64,${(await readFile(tonePath)).toString('base64')}`,
      }),
    }, 201)
    assets.push(payload.asset)
  }
  for (const cueId of selectedCueIds) {
    production = command(production, 'sound.asset.bind', {
      cueId, binding: binding(assets[selectedCueIds.indexOf(cueId)], production.updatedAt + 1),
    }, sequence++)
    production = command(production, 'sound.asset.approve', { cueId }, sequence++)
  }
  const firstCue = production.soundTimeline.audioCues.find(({ id }) => id === selectedCueIds[0])
  const secondCue = production.soundTimeline.audioCues.find(({ id }) => id === selectedCueIds[1])
  const preservedBefore = structuredClone(production.soundTimeline.audioCues.find(({ id }) => id === preservedCueId))
  const joinAtMs = firstCue.endMs - 40
  production = command(production, 'sound.cue.patch', { cueId: firstCue.id, patch: { endMs: joinAtMs } }, sequence++)
  production = command(production, 'sound.cue.patch', { cueId: secondCue.id, patch: { startMs: joinAtMs } }, sequence++)
  const preparedFirst = production.soundTimeline.audioCues.find(({ id }) => id === selectedCueIds[0])
  const preparedSecond = production.soundTimeline.audioCues.find(({ id }) => id === selectedCueIds[1])
  assert.equal(preparedSecond.startMs, preparedFirst.endMs)
  assert.equal(preparedFirst.status, 'approved')
  assert.equal(preparedSecond.status, 'approved')
  report.timelineFixture = production.soundTimeline.audioCues
    .filter(({ id }) => selectedCueIds.includes(id) || id === preservedCueId)
    .map(({ id, kind, startMs, endMs, status, asset }) => ({ id, kind, startMs, endMs, status, hasAsset: Boolean(asset) }))

  await requestJson(bridge, `/api/workspace/documents/${DOCUMENT_ID}`, {
    method: 'PUT',
    body: JSON.stringify({
      projectId: PROJECT_ID, modeId: 'smart-video', baseRevision: null, revision: 1,
      value: JSON.stringify({ schemaVersion: 2, project: story, plan, production }),
      reason: 'audio-remix-ui', forceRecovery: true,
    }),
  })

  const beforeTimeline = (await projectEvidence(bridge)).value.production.soundTimeline
  const missingAssetPath = join(bridge.runtimeDirectory, 'projects', 'assets', `${assets[0].version.assetId}.wav`)
  const missingBytes = await readFile(missingAssetPath)
  await rm(missingAssetPath)
  report.checks.push('real browser local remix submission with deterministic missing-file failure')

  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) })
  page = await browser.newPage({ viewport: { width: 1440, height: 980 } })
  observePage(page, issues)
  const soundRequests = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/jobs/sound-render')) soundRequests.push(request.postDataJSON())
  })
  await page.goto(bridge.baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.locator('.aq-project-row-main').filter({ hasText: 'AUDIO-001 局部重混 UI' }).click()
  const studio = page.getByRole('region', { name: '多智能体制片工作室' })
  await studio.waitFor({ state: 'visible', timeout: 20_000 })
  let sound = await selectSoundNode(studio)
  await sound.getByRole('button', { name: '渲染局部试听', exact: true }).click()
  const failedJob = await waitForUiJob(bridge, (job) => job.status === 'failed')
  const failedArticle = studio.getByRole('article').filter({ hasText: failedJob.id }).first()
  await waitForVisible(failedArticle.getByRole('button', { name: '重试原输入', exact: true }))
  assert.equal(soundRequests.at(-1)?.action, 'render-local')
  assert.deepEqual(soundRequests.at(-1)?.cueIds, selectedCueIds)
  assert.equal(soundRequests.at(-1)?.overlapMs, 120)
  report.checks.push('failed local remix is visible with a retry action')

  await page.reload({ waitUntil: 'domcontentloaded' })
  await studio.waitFor({ state: 'visible', timeout: 20_000 })
  sound = await selectSoundNode(studio)
  const refreshedFailedArticle = studio.getByRole('article').filter({ hasText: failedJob.id }).first()
  await waitForVisible(refreshedFailedArticle.getByRole('button', { name: '重试原输入', exact: true }))
  report.checks.push('refresh restores failed Job and original retry input')

  await writeFile(missingAssetPath, missingBytes)
  await refreshedFailedArticle.getByRole('button', { name: '重试原输入', exact: true }).click()
  const retriedJob = await waitForUiJob(bridge, (job) => job.retryOf === failedJob.id)
  const retriedTerminal = await waitForJob(bridge, retriedJob.id)
  assert.equal(retriedTerminal.status, 'completed', JSON.stringify(retriedTerminal.error || retriedTerminal.logs))
  assert.equal(retriedTerminal.soundRenderMetadata?.action, 'render-local')
  assert.deepEqual(retriedTerminal.soundRenderMetadata?.cueIds, selectedCueIds)
  assert.ok(retriedTerminal.soundRenderMetadata?.preservedCueIds.includes(preservedCueId))
  assert.equal(retriedTerminal.outputVersion?.mimeType, 'audio/wav')
  const retryOutput = await bridge.request(retriedTerminal.outputUrl)
  assert.equal(retryOutput.status, 200)
  const retryOutputPath = join(fixtureRoot, 'retry-output.wav')
  await writeFile(retryOutputPath, Buffer.from(await retryOutput.arrayBuffer()))
  const retryProbe = await probeAudio(FFPROBE_PATH, retryOutputPath)
  assert.equal(retryProbe.sampleRate, 48_000)
  assert.equal(retryProbe.channels, 2)
  const expectedDuration = (preparedSecond.endMs - preparedFirst.startMs) / 1_000
  assert(Math.abs(retryProbe.duration - expectedDuration) < 0.08, `${retryProbe.duration} vs ${expectedDuration}`)
  const afterRetryTimeline = (await projectEvidence(bridge)).value.production.soundTimeline
  assert.deepEqual(afterRetryTimeline, beforeTimeline)
  report.output = {
    jobId: retriedTerminal.id,
    retryOf: failedJob.id,
    mimeType: retriedTerminal.outputVersion.mimeType,
    bytes: retriedTerminal.outputVersion.bytes,
    sampleRate: retryProbe.sampleRate,
    channels: retryProbe.channels,
    durationSeconds: retryProbe.duration,
    expectedDurationSeconds: expectedDuration,
    segmentStartMs: retriedTerminal.soundRenderMetadata.segmentStartMs,
    segmentEndMs: retriedTerminal.soundRenderMetadata.segmentEndMs,
  }
  report.checks.push('retry succeeds with real FFmpeg metadata and leaves the timeline unchanged')

  await page.reload({ waitUntil: 'domcontentloaded' })
  await studio.waitFor({ state: 'visible', timeout: 20_000 })
  sound = await selectSoundNode(studio)
  const refreshedCompletedArticle = studio.getByRole('article').filter({ hasText: retriedTerminal.id }).first()
  await waitForVisible(refreshedCompletedArticle)
  report.checks.push('refresh restores completed retry Job and output metadata card')

  const timelineBeforeCancel = (await projectEvidence(bridge)).value.production.soundTimeline
  await sound.getByRole('button', { name: '渲染局部试听', exact: true }).click()
  const cancelCandidate = await waitForUiJob(bridge, (job) => job.id !== retriedTerminal.id && ['queued', 'running'].includes(job.status), 10_000)
  const cancelArticle = studio.getByRole('article').filter({ hasText: cancelCandidate.id }).first()
  const cancelButton = cancelArticle.getByRole('button', { name: '取消', exact: true })
  await waitForVisible(cancelButton, 10_000)
  await cancelButton.click()
  const cancelled = await waitForJob(bridge, cancelCandidate.id)
  assert.equal(cancelled.status, 'cancelled', JSON.stringify(cancelled))
  await delay(1_000)
  const timelineAfterCancel = (await projectEvidence(bridge)).value.production.soundTimeline
  assert.deepEqual(timelineAfterCancel, timelineBeforeCancel)
  report.checks.push('cancelled local remix remains cancelled and a late callback does not mutate the timeline')

  await page.reload({ waitUntil: 'domcontentloaded' })
  await studio.waitFor({ state: 'visible', timeout: 20_000 })
  sound = await selectSoundNode(studio)
  const refreshedCancelledArticle = studio.getByRole('article').filter({ hasText: cancelCandidate.id }).first()
  await waitForVisible(refreshedCancelledArticle.getByRole('button', { name: '重试原输入', exact: true }))
  await page.setViewportSize({ width: 390, height: 844 })
  await sound.scrollIntoViewIfNeeded()
  assert.equal(await page.locator('body').evaluate((body) => body.scrollWidth <= body.clientWidth), true)
  assert.deepEqual(issues, [])
  report.responsive = { viewport: '390x844', noHorizontalOverflow: true }
  report.status = 'passed'
  console.log('✓ Audio remix UI failed/retry/cancel/refresh and deterministic FFmpeg metadata passed')
} catch (error) {
  failure = error
  report.error = { name: error?.name, code: error?.code, message: error?.message, stack: error?.stack }
  report.issues = issues
  if (page) {
    report.visibleText = (await page.locator('body').innerText().catch(() => '')).slice(-12_000)
    report.failureScreenshot = resolve(projectRoot, '.runtime', 'qa', 'audio-remix-ui-failure.png')
    await page.screenshot({ path: report.failureScreenshot, fullPage: false }).catch(() => undefined)
  }
} finally {
  report.generatedAt = new Date().toISOString()
  report.issues = issues
  await mkdir(resolve(projectRoot, '.runtime', 'qa'), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify({ ...report, fixtureRoot: undefined }, null, 2)}\n`, 'utf8')
  await page?.close().catch(() => undefined)
  await browser?.close().catch(() => undefined)
  await bridge?.stop({ keepRuntime: false }).catch(() => undefined)
  await rm(fixtureRoot, { recursive: true, force: true }).catch(() => undefined)
}

if (failure) throw failure
