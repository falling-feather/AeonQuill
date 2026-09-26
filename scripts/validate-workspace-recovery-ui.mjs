import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { startIsolatedBridge } from './qa-runtime.mjs'
import { createProjectCatalog, createWorkspaceProject, touchProjectDocument } from '../src/lib/project/projectCatalog.mjs'
import { compileStoryProject, createGenerationPlan } from '../src/lib/story/storyProject.mjs'
import { createVideoProductionProjectForStory, createVideoProductionCommand, applyVideoProductionCommand } from '../src/lib/story/productionPipeline.mjs'

const projectId = 'recovery-ui-project'
const documentId = 'recovery-ui-document'
const text = '灵感，不该散落在工具之间。'
const report = { kind: 'workspace-authoritative-recovery', status: 'running', delayMs: 600 }
const bridge = await startIsolatedBridge('workspace-recovery-ui')
let browser
let failure
async function request(path, body, method = 'POST', status = 200) {
  const response = await bridge.request(path, body ? { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {})
  const result = await response.json()
  assert.equal(response.status, status, JSON.stringify(result).slice(0, 500))
  return result
}
try {
  const created = createWorkspaceProject(createProjectCatalog(), { title: '正文恢复回归', initialModeId: 'smart-video', color: 'violet' }, { projectId, documentId, now: 1000 })
  const catalog = touchProjectDocument(created.catalog, projectId, documentId, { revision: 1 }, { now: 1001 })
  await request('/api/workspace/catalog', { catalog, baseRevision: 0 }, 'PUT')
  const bytes = await readFile('videos/aeonquill-flagship-ad/assets/voice/frame-01.wav')
  const { asset } = await request('/api/library/assets', { scope: 'project', projectId, title: '恢复音频', dataUrl: `data:audio/wav;base64,${bytes.toString('base64')}` }, 'POST', 201)
  const story = compileStoryProject({ projectId: documentId, title: '恢复正文', kind: 'script', text: `场景 1：工作台\n镜头 1：固定近景\n旁白：${text}`, aspectRatio: '16:9', frameStrategy: 'start-end', defaultShotSeconds: 5, now: 1002 })
  const plan = createGenerationPlan(story, { now: 1003 })
  let production = createVideoProductionProjectForStory(story, { now: 1004 })
  const cueId = production.soundTimeline.audioCues.find(({ kind }) => kind === 'narration').id
  const apply = (type, payload) => {
    production = applyVideoProductionCommand(production, createVideoProductionCommand(production, type, payload), { now: production.updatedAt + 1 })
  }
  apply('sound.cue.patch', { cueId, patch: { text, startMs: 0, endMs: 5000 } })
  apply('sound.asset.bind', { cueId, binding: { libraryItemId: asset.id, libraryVersionId: asset.version.id, contentHash: asset.version.assetId, mimeType: asset.version.mimeType, scope: 'project', boundAt: production.updatedAt + 1 } })
  await request(`/api/workspace/documents/${documentId}`, { projectId, modeId: 'smart-video', baseRevision: null, revision: 1, value: JSON.stringify({ schemaVersion: 2, project: story, plan, production }), reason: 'recovery-ui', forceRecovery: true }, 'PUT')
  const documentUrl = `/api/workspace/documents/${documentId}?projectId=${projectId}&modeId=smart-video`
  const before = (await request(documentUrl)).document.value
  browser = await chromium.launch({ headless: true, channel: 'msedge' })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(bridge.baseUrl)
  await page.locator('.aq-project-row-main').filter({ hasText: '正文恢复回归' }).click()
  const studio = page.getByRole('region', { name: '多智能体制片工作室' })
  await studio.getByRole('listitem').filter({ hasText: '声音字幕' }).click()
  await studio.getByRole('button', { name: '音频', exact: true }).click()
  await studio.locator(`[data-sound-cue="${cueId}"]`).getByRole('button', { name: '对齐片段', exact: true }).waitFor()
  let bodyReleasedAt = null
  await page.route(`**/api/workspace/documents/${documentId}?*`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    await new Promise((resolve) => setTimeout(resolve, report.delayMs))
    await route.continue()
    bodyReleasedAt = Date.now()
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await studio.waitFor({ state: 'visible' })
  const studioVisibleAt = Date.now()
  assert.ok(bodyReleasedAt !== null && studioVisibleAt >= bodyReleasedAt, 'Editor mounted from a session summary before the workspace body was restored')
  await studio.getByRole('listitem').filter({ hasText: '声音字幕' }).click()
  await studio.getByRole('button', { name: '音频', exact: true }).click()
  const card = studio.locator(`[data-sound-cue="${cueId}"]`)
  await card.getByRole('button', { name: '对齐片段', exact: true }).waitFor()
  assert.ok((await card.textContent()).includes(text), 'User-edited cue text must survive refresh')
  assert.equal((await request(documentUrl)).document.value, before, 'Reload must not autosave a rebuilt preview over the stored body')
  assert.deepEqual(errors, [])
  await mkdir('.runtime/qa', { recursive: true })
  await page.screenshot({ path: resolve('.runtime/qa/workspace-recovery-desktop.png') })
  Object.assign(report, { status: 'passed', bodyReleasedAt, studioVisibleAt, customCuePreserved: true, assetPreserved: true, storedBodyUnchanged: true, pageErrors: errors })
} catch (error) {
  failure = error
  Object.assign(report, { status: 'failed', error: { message: error.message, stack: error.stack } })
} finally {
  await browser?.close()
  await bridge.stop({ keepRuntime: Boolean(failure) })
  await mkdir('.runtime/qa', { recursive: true })
  await writeFile('.runtime/qa/workspace-recovery-ui.json', JSON.stringify(report, null, 2) + '\n', 'utf8')
}
if (failure) throw failure
console.log('✓ Workspace body loads before the editor; custom audio cue and asset survive refresh without inference')
