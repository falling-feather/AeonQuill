import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
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
import { startIsolatedBridge } from './qa-runtime.mjs'

const PROJECT_ID = 'speech-alignment-ui-project'
const DOCUMENT_ID = 'speech-alignment-ui-document'
const KNOWN_TEXT = '灵感，不该散落在工具之间。'
const AUDIO_PATH = resolve('videos', 'aeonquill-flagship-ad', 'assets', 'voice', 'frame-01.wav')
const PYTHON_PATH = resolve('.runtime', 'tools', 'speech-alignment', 'venv', 'Scripts', 'python.exe')
const MODEL_PATH = resolve('.runtime', 'models', 'speech-alignment', 'zh')
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'D:/钮/特殊工具库/ffmpeg/bin/ffmpeg.exe'
const FFPROBE_PATH = process.env.FFPROBE_PATH || 'D:/钮/特殊工具库/ffmpeg/bin/ffprobe.exe'
const REPORT_PATH = resolve('.runtime', 'qa', 'speech-alignment-ui.json')
const EDGE_PATHS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

function command(production, type, payload, sequence) {
  return applyVideoProductionCommand(
    production,
    createVideoProductionCommand(production, type, payload, {
      id: `speech-alignment-ui-${sequence}`,
      actor: 'user',
    }),
    { now: production.updatedAt + 1 },
  )
}

async function requestJson(bridge, pathname, options = {}, expectedStatus = 200) {
  const response = await bridge.request(pathname, {
    ...options,
    headers: options.body
      ? { 'content-type': 'application/json', ...options.headers }
      : options.headers,
  })
  const payload = await response.json().catch(() => ({}))
  assert.equal(response.status, expectedStatus, `${options.method || 'GET'} ${pathname}: ${JSON.stringify(payload)}`)
  return payload
}

async function probeAudio(ffprobePath, inputPath) {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const { stdout } = await run(ffprobePath, [
    '-v', 'error', '-show_entries', 'format=duration:stream=sample_rate,channels', '-of', 'json', inputPath,
  ], { windowsHide: true, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })
  const value = JSON.parse(stdout)
  return {
    durationMs: Math.round(Number(value.format?.duration) * 1_000),
    sampleRate: Number(value.streams?.[0]?.sample_rate),
    channels: Number(value.streams?.[0]?.channels),
  }
}

async function waitForSpeechJob(bridge, cueId, timeoutMs = 11 * 60_000) {
  const deadline = Date.now() + timeoutMs
  let seen = null
  while (Date.now() < deadline) {
    const payload = await requestJson(bridge, '/api/jobs')
    const jobs = payload.jobs.filter((job) => job.kind === 'speech-alignment' && job.request?.cueId === cueId)
    jobs.sort((left, right) => right.createdAt - left.createdAt)
    seen = jobs[0] ?? seen
    if (seen?.status === 'completed') return seen
    if (seen?.status === 'failed' || seen?.status === 'cancelled') {
      const error = new Error(seen.error?.message || `Speech alignment job ${seen.id} ${seen.status}`)
      error.code = seen.error?.code || `SPEECH_ALIGNMENT_${String(seen.status).toUpperCase()}`
      throw error
    }
    await delay(500)
  }
  throw new Error(`Speech alignment job did not finish within ${timeoutMs}ms`)
}

async function getWorkspaceDocument(bridge) {
  return requestJson(bridge, `/api/workspace/documents/${encodeURIComponent(DOCUMENT_ID)}?projectId=${encodeURIComponent(PROJECT_ID)}&modeId=smart-video`)
}

async function waitForWorkspaceDocument(bridge, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  let latest
  while (Date.now() < deadline) {
    latest = await getWorkspaceDocument(bridge)
    if (predicate(latest.document)) return latest
    await delay(150)
  }
  throw new Error(`Workspace document did not reach the expected state: ${JSON.stringify(latest?.document?.value).slice(0, 500)}`)
}

async function findEdgePath() {
  for (const candidate of EDGE_PATHS) {
    if (await stat(candidate).then(() => true, () => false)) return candidate
  }
  return null
}

async function writeReport(report) {
  await mkdir(resolve('.runtime', 'qa'), { recursive: true })
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  if (report.status === 'unavailable') process.exitCode = 2
}

const pathChecks = await Promise.all([
  stat(AUDIO_PATH).then(() => true, () => false),
  stat(PYTHON_PATH).then(() => true, () => false),
  stat(MODEL_PATH).then(() => true, () => false),
  stat(FFMPEG_PATH).then(() => true, () => false),
  stat(FFPROBE_PATH).then(() => true, () => false),
])
const [audioAvailable, pythonAvailable, modelAvailable, ffmpegAvailable, ffprobeAvailable] = pathChecks
const edgePath = await findEdgePath()
const baseReport = {
  schemaVersion: 1,
  kind: 'aeonquill.qa.speech-alignment-ui',
  projectId: PROJECT_ID,
  documentId: DOCUMENT_ID,
  input: { audioPath: AUDIO_PATH, knownText: KNOWN_TEXT },
  configuration: { pythonPath: PYTHON_PATH, modelPath: MODEL_PATH, ffmpegPath: FFMPEG_PATH, ffprobePath: FFPROBE_PATH, edgePath },
  machine: { pathChecks: { audioAvailable, pythonAvailable, modelAvailable, ffmpegAvailable, ffprobeAvailable, edgeAvailable: Boolean(edgePath) } },
  manual: {
    status: 'manual-required',
    checks: [
      { id: 'audio-listen', status: 'manual-required', description: '在 Edge 中试听实际音频，确认声音与词序一致。' },
      { id: 'word-visual-review', status: 'manual-required', description: '人工复核每个词的置信度、入点和出点是否符合语音。' },
    ],
  },
}

if (!audioAvailable || !pythonAvailable || !modelAvailable || !ffmpegAvailable || !ffprobeAvailable || !edgePath) {
  const report = {
    ...baseReport,
    status: 'unavailable',
    unavailable: 'Required audio, WhisperX Python/model, FFmpeg/FFprobe, or system Edge path is unavailable.',
  }
  await writeReport({ ...report, manual: { ...report.manual, status: 'blocked' } })
  console.log(`SPEECH_ALIGNMENT_UI_UNAVAILABLE: ${JSON.stringify(report.machine.pathChecks)}`)
} else {
  const qaRoot = resolve('.runtime', 'qa-temp')
  await mkdir(qaRoot, { recursive: true })
  const fixtureRoot = await mkdtemp(join(qaRoot, 'speech-alignment-ui-'))
  let bridge
  let browser
  let failure = null
  let report = baseReport
  const pageErrors = []
  try {
    const audioProbe = await probeAudio(FFPROBE_PATH, AUDIO_PATH)
    const primaryNow = Date.now() - 60_000
    const created = createWorkspaceProject(createProjectCatalog(), {
      title: 'SPEECH-ALIGNMENT UI 验收',
      initialModeId: 'smart-video',
      color: 'violet',
    }, { projectId: PROJECT_ID, documentId: DOCUMENT_ID, now: primaryNow })
    const fixtureCatalog = touchProjectDocument(created.catalog, PROJECT_ID, DOCUMENT_ID, { revision: 1 }, { now: primaryNow + 1 })
    const story = compileStoryProject({
      projectId: DOCUMENT_ID,
      title: '灵感对齐 UI 验收',
      kind: 'script',
      text: `场景 1：工作台\n镜头 1：固定近景\n旁白：${KNOWN_TEXT}`,
      aspectRatio: '16:9',
      frameStrategy: 'start-end',
      defaultShotSeconds: 5,
      now: 1_800_000_000_100,
    })
    const plan = createGenerationPlan(story, { now: story.updatedAt + 1 })
    let production = createVideoProductionProjectForStory(story, { generationMode: 'fast', characterMode: 'quick', now: story.updatedAt + 2 })
    const cue = production.soundTimeline.audioCues.find(({ kind }) => kind === 'narration' || kind === 'dialogue')
    assert.ok(cue)
    production = command(production, 'sound.cue.patch', {
      cueId: cue.id,
      patch: { text: KNOWN_TEXT, startMs: 0, endMs: 5_000 },
    }, 1)

    bridge = await startIsolatedBridge('speech-alignment-ui', {
      environment: {
        AEONQUILL_ALIGNMENT_PYTHON: PYTHON_PATH,
        AEONQUILL_ALIGNMENT_MODEL: MODEL_PATH,
        FFMPEG_PATH,
        FFPROBE_PATH,
      },
    })
    const readiness = await requestJson(bridge, '/api/speech-alignment/status')
    report = { ...report, machine: { ...report.machine, audioProbe, readiness } }
    if (!readiness.available) {
      report = { ...report, status: 'unavailable', unavailable: readiness.reason || 'WhisperX probe reported unavailable.' }
      console.log(`SPEECH_ALIGNMENT_UI_UNAVAILABLE: ${report.unavailable}`)
    } else {
      const dataUrl = `data:audio/wav;base64,${(await readFile(AUDIO_PATH)).toString('base64')}`
      const imported = await requestJson(bridge, '/api/library/assets', {
        method: 'POST',
        body: JSON.stringify({
          scope: 'project', projectId: PROJECT_ID, title: 'frame-01.wav · 真实对齐音频',
          description: 'SPEECH-ALIGNMENT UI real audio fixture', tags: ['qa', 'speech-alignment'], dataUrl,
        }),
      }, 201)
      const asset = imported.asset
      production = command(production, 'sound.asset.bind', {
        cueId: cue.id,
        binding: {
          libraryItemId: asset.id,
          libraryVersionId: asset.version.id,
          contentHash: asset.version.assetId,
          mimeType: asset.version.mimeType,
          scope: 'project',
          boundAt: production.updatedAt + 1,
        },
      }, 2)
      const documentValue = JSON.stringify({ schemaVersion: 2, project: story, plan, production })
      await requestJson(bridge, '/api/workspace/catalog', {
        method: 'PUT',
        body: JSON.stringify({ catalog: fixtureCatalog, baseRevision: 0, source: 'speech-alignment-ui-qa' }),
      })
      await requestJson(bridge, `/api/workspace/documents/${encodeURIComponent(DOCUMENT_ID)}`, {
        method: 'PUT',
        body: JSON.stringify({
          projectId: PROJECT_ID, modeId: 'smart-video', baseRevision: null, revision: 1,
          value: documentValue, reason: 'speech-alignment-ui-qa', forceRecovery: true,
        }),
      })
      const beforeAlignment = await getWorkspaceDocument(bridge)
      const beforeAlignmentValue = beforeAlignment.document.value
      const beforeTimeline = JSON.parse(beforeAlignmentValue).production.soundTimeline
      const beforeSubtitle = beforeTimeline.subtitleCues.find(({ audioCueId }) => audioCueId === cue.id)
      assert.equal(beforeSubtitle.text, KNOWN_TEXT)
      assert.equal(beforeSubtitle.status, 'draft')

      browser = await chromium.launch({ headless: true, executablePath: edgePath })
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
      page.on('pageerror', (error) => pageErrors.push(`pageerror: ${error.message}`))
      page.on('console', (message) => { if (['error', 'warning'].includes(message.type())) pageErrors.push(`${message.type()}: ${message.text()}`) })
      await page.goto(bridge.baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
      await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
      await page.locator('.aq-project-row-main').filter({ hasText: 'SPEECH-ALIGNMENT UI 验收' }).click()
      const studio = page.getByRole('region', { name: '多智能体制片工作室' })
      await studio.waitFor({ state: 'visible', timeout: 20_000 })
      await studio.getByRole('listitem').filter({ hasText: '声音字幕' }).click()
      const soundTimeline = studio.getByRole('region', { name: '声音字幕时间线' })
      await soundTimeline.waitFor({ state: 'visible', timeout: 20_000 })
      await soundTimeline.getByRole('button', { name: '音频', exact: true }).click()
      const cueCard = soundTimeline.locator(`[data-sound-cue="${cue.id}"]`)
      await cueCard.waitFor({ state: 'visible', timeout: 20_000 })
      await cueCard.getByRole('button', { name: '对齐片段', exact: true }).click()
      const alignmentCard = soundTimeline.locator(`[data-alignment-cue="${cue.id}"]`)
      await alignmentCard.waitFor({ state: 'visible', timeout: 20_000 })
      const durationInput = alignmentCard.getByLabel('实际音频时长（秒）')
      assert.equal(Number(await durationInput.inputValue()), 5)
      await alignmentCard.getByRole('button', { name: '调用本地对齐', exact: true }).click()

      const completedJob = await (async () => {
        const deadline = Date.now() + 11 * 60_000
        while (Date.now() < deadline) {
          const jobs = (await requestJson(bridge, '/api/jobs')).jobs
          const match = jobs.filter((job) => job.kind === 'speech-alignment' && job.request?.cueId === cue.id).sort((left, right) => right.createdAt - left.createdAt)[0]
          if (match?.status === 'completed') return match
          if (match?.status === 'failed' || match?.status === 'cancelled') throw new Error(match.error?.message || `Alignment job ${match.status}`)
          await delay(500)
        }
        throw new Error('Speech alignment UI job timeout')
      })()
      await alignmentCard.getByText('本地对齐候选已返回；请逐词检查并明确应用。', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
      const result = await requestJson(bridge, `/api/jobs/${encodeURIComponent(completedJob.id)}/alignment`)
      assert.equal(completedJob.kind, 'speech-alignment')
      assert.equal(completedJob.status, 'completed')
      assert.equal(completedJob.scheduling.resourceClass, 'cpu')
      assert.equal(result.candidate.source, 'whisperx')
      assert(result.candidate.words.length > 0)
      assert(result.candidate.words.map(({ text }) => text).join('').replace(/[\s,，]/gu, '').includes('灵感'))
      const actualDurationShown = Number(await durationInput.inputValue())
      assert(Math.abs(actualDurationShown * 1_000 - result.durationMs) <= 10)
      assert(Math.abs(result.durationMs - audioProbe.durationMs) <= 120)

      const beforeApply = await getWorkspaceDocument(bridge)
      assert.equal(beforeApply.document.value, beforeAlignmentValue)
      const firstStart = alignmentCard.getByLabel('第 1 个词入点')
      const firstEnd = alignmentCard.getByLabel('第 1 个词出点')
      const secondStart = alignmentCard.getByLabel('第 2 个词入点')
      const nextStart = Number(await secondStart.inputValue())
      const editedStart = Math.min(0.123, Math.max(0.001, nextStart / 3))
      const editedEnd = Math.max(editedStart + 0.001, Math.min(0.456, nextStart - 0.001))
      await firstStart.fill(editedStart.toFixed(3))
      await firstStart.press('Tab')
      await firstEnd.fill(editedEnd.toFixed(3))
      await firstEnd.press('Tab')
      assert.match(await firstStart.inputValue(), /\./u)
      assert.match(await firstEnd.inputValue(), /\./u)
      await alignmentCard.getByText('时间预览', { exact: true }).waitFor({ state: 'visible' })
      await alignmentCard.getByRole('button', { name: '明确应用时间', exact: true }).click()
      await studio.getByText(/对齐时间已应用到关联字幕/u).waitFor({ state: 'visible', timeout: 20_000 })

      const appliedDocument = await waitForWorkspaceDocument(bridge, (document) => {
        const timeline = JSON.parse(document.value).production.soundTimeline
        const subtitle = timeline.subtitleCues.find(({ audioCueId }) => audioCueId === cue.id)
        return subtitle?.status === 'draft'
          && subtitle.text === KNOWN_TEXT
          && subtitle.startMs !== beforeSubtitle.startMs
          && subtitle.endMs !== beforeSubtitle.endMs
      })
      const appliedTimeline = JSON.parse(appliedDocument.document.value).production.soundTimeline
      const appliedCue = appliedTimeline.audioCues.find(({ id }) => id === cue.id)
      const appliedSubtitle = appliedTimeline.subtitleCues.find(({ audioCueId }) => audioCueId === cue.id)
      assert.equal(appliedCue.asset.contentHash, asset.version.assetId)
      assert.equal(appliedCue.text, KNOWN_TEXT)
      assert.equal(appliedSubtitle.text, KNOWN_TEXT)
      assert.equal(appliedSubtitle.status, 'draft')
      assert.notEqual(appliedSubtitle.startMs, beforeSubtitle.startMs)
      assert.notEqual(appliedSubtitle.endMs, beforeSubtitle.endMs)

      const jobsBeforeRefresh = (await requestJson(bridge, '/api/jobs')).jobs.filter((job) => job.kind === 'speech-alignment' && job.request?.cueId === cue.id)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await studio.waitFor({ state: 'visible', timeout: 20_000 })
      await studio.getByRole('listitem').filter({ hasText: '声音字幕' }).click()
      const refreshedSoundTimeline = studio.getByRole('region', { name: '声音字幕时间线' })
      await refreshedSoundTimeline.getByRole('button', { name: '音频', exact: true }).click()
      const refreshedCard = refreshedSoundTimeline.locator(`[data-sound-cue="${cue.id}"]`)
      await refreshedCard.getByRole('button', { name: '对齐片段', exact: true }).click()
      const refreshedAlignment = refreshedSoundTimeline.locator(`[data-alignment-cue="${cue.id}"]`)
      await refreshedAlignment.getByRole('button', { name: '调用本地对齐', exact: true }).click()
      await refreshedAlignment.getByText('本地对齐候选已返回；请逐词检查并明确应用。', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
      const jobsAfterRefresh = (await requestJson(bridge, '/api/jobs')).jobs.filter((job) => job.kind === 'speech-alignment' && job.request?.cueId === cue.id)
      assert.deepEqual(jobsAfterRefresh.map(({ id }) => id).sort(), jobsBeforeRefresh.map(({ id }) => id).sort())

      await page.setViewportSize({ width: 390, height: 844 })
      await page.waitForTimeout(150)
      const overflow = await page.evaluate(() => ({
        body: document.body.scrollWidth > document.body.clientWidth,
        workbench: Boolean(document.querySelector('.aq-video-workbench') && document.querySelector('.aq-video-workbench').scrollWidth > document.querySelector('.aq-video-workbench').clientWidth),
      }))
      assert.equal(overflow.body, false)
      assert.equal(overflow.workbench, false)

      report = {
        ...report,
        status: 'pass-with-manual',
        machine: {
          ...report.machine,
          job: {
            id: completedJob.id,
            status: completedJob.status,
            kind: completedJob.kind,
            resourceClass: completedJob.scheduling.resourceClass,
            source: result.candidate.source,
            wordCount: result.candidate.words.length,
            actualDurationMs: result.durationMs,
            audioDurationMs: audioProbe.durationMs,
          },
          ui: {
            actualDurationShownMs: actualDurationShown * 1_000,
            wordsVisible: result.candidate.words.length,
            decimalWordTimingCommitted: true,
            workspaceSubtitleUnchangedBeforeApply: true,
            subtitleAppliedExplicitly: true,
            subtitleStatusAfterApply: appliedSubtitle.status,
            subtitleTextAfterApply: appliedSubtitle.text,
            reusedCompletedJobAfterRefresh: true,
            jobsBeforeRefresh: jobsBeforeRefresh.map(({ id }) => id),
            jobsAfterRefresh: jobsAfterRefresh.map(({ id }) => id),
            narrowOverflow: overflow,
            pageErrors,
          },
        },
      }
      console.log(`✓ Speech alignment UI validated WhisperX Job ${completedJob.id}, explicit subtitle apply, refresh reuse, and narrow layout`)
    }
  } catch (error) {
    failure = error
    if (error?.code === 'SPEECH_ALIGNMENT_UNAVAILABLE' || /WhisperX|speech alignment.*unavailable|dependencies or local model/iu.test(error?.message || '')) {
      report = { ...report, status: 'unavailable', unavailable: error.message, machine: { ...report.machine, pageErrors } }
      console.log(`SPEECH_ALIGNMENT_UI_UNAVAILABLE: ${error.message}`)
      failure = null
    } else {
      report = { ...report, status: 'failed', error: { name: error?.name, code: error?.code, message: error?.message, stack: error?.stack }, machine: { ...report.machine, pageErrors } }
    }
  } finally {
    await browser?.close().catch(() => {})
    await bridge?.stop({ keepRuntime: false }).catch(() => {})
    await rm(fixtureRoot, { recursive: true, force: true }).catch(() => {})
    await writeReport(report)
  }
  if (failure) throw failure
}
