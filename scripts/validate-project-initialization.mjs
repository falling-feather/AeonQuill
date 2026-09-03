import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { startIsolatedBridge } from './qa-runtime.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const reportPath = join(projectRoot, '.runtime', 'qa', 'project-initialization-v0757.json')
const modes = [
  {
    id: 'balanced',
    title: '原子均衡项目',
    option: /均衡模式 图像、文字与多模态创作/u,
    ready: (page) => page.getByLabel('无限画布'),
  },
  {
    id: 'pixel',
    title: '原子像素项目',
    option: /像素模式 精细像素绘制与动画/u,
    ready: (page) => page.getByLabel(/像素绘制区/u),
  },
  {
    id: 'smart-video',
    title: '原子智能视频项目',
    option: /智能视频 从灵感或剧本开始制片/u,
    ready: (page) => page.getByText('多智能体制片工作室', { exact: true }).first(),
  },
]

function observePage(page, issues) {
  page.on('pageerror', (error) => issues.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    const value = message.text()
    if ((message.type() === 'error' || message.type() === 'warning') && !value.includes('Failed to load resource')) {
      issues.push(`${message.type()}: ${value}`)
    }
  })
}

async function createProject(page, mode) {
  await page.locator('.aq-home-header').getByRole('button', { name: '创建新项目', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '创建新项目' })
  await dialog.waitFor({ state: 'visible' })
  await dialog.getByPlaceholder('输入项目名称').fill(mode.title)
  const option = dialog.getByRole('button', { name: mode.option })
  await option.click()
  assert.equal(await option.getAttribute('aria-pressed'), 'true')
  await dialog.getByRole('button', { name: '创建并进入', exact: true }).click()
  await dialog.waitFor({ state: 'hidden', timeout: 15_000 })
  await mode.ready(page).waitFor({ state: 'visible', timeout: 20_000 })
}

async function returnHome(page) {
  await page.locator('button[aria-label*="返回"]').first().click()
  await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
}

async function projectEvidence(page, title, modeId) {
  return page.evaluate(async ({ expectedTitle, expectedModeId }) => {
    const catalogResponse = await fetch('/api/workspace/catalog')
    const catalogPayload = await catalogResponse.json()
    const project = catalogPayload.catalog.projects.find((candidate) => candidate.title === expectedTitle)
    if (!project) throw new Error(`Missing project ${expectedTitle}`)
    const registration = project.documents.find((candidate) => candidate.modeId === expectedModeId)
    if (!registration) throw new Error(`Missing ${expectedModeId} registration`)
    const bodyResponse = await fetch(`/api/workspace/documents/${encodeURIComponent(registration.id)}?projectId=${encodeURIComponent(project.id)}&modeId=${encodeURIComponent(expectedModeId)}`)
    const bodyPayload = await bodyResponse.json()
    const previewResponse = await fetch(`/api/workspace/projects/${encodeURIComponent(project.id)}/package/preview`)
    const previewPayload = await previewResponse.json()
    return {
      projectId: project.id,
      documentId: registration.id,
      catalogRevision: catalogPayload.catalog.revision,
      registrationRevision: registration.revision,
      bodyStatus: bodyResponse.status,
      bodyRevision: bodyPayload.document?.revision,
      bodyModeId: bodyPayload.document?.modeId,
      previewStatus: previewResponse.status,
      preview: previewPayload.preview,
    }
  }, { expectedTitle: title, expectedModeId: modeId })
}

const bridge = await startIsolatedBridge('project-initialization')
const browserChannel = process.env.MIAOHUI_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined)
const report = {
  schemaVersion: 1,
  status: 'failed',
  generatedAt: new Date().toISOString(),
  browser: browserChannel || 'bundled-chromium',
  modes: [],
  addedMode: null,
  revisionZeroBackfill: null,
  issues: [],
}
let browser
let page

try {
  browser = await chromium.launch({ headless: true, ...(browserChannel ? { channel: browserChannel } : {}) })
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  observePage(page, report.issues)
  await page.goto(bridge.baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible', timeout: 15_000 })

  for (const mode of modes) {
    await createProject(page, mode)
    const created = await projectEvidence(page, mode.title, mode.id)
    assert.equal(created.bodyStatus, 200)
    assert.equal(created.registrationRevision, 0)
    assert.equal(created.bodyRevision, 0)
    assert.equal(created.bodyModeId, mode.id)
    assert.equal(created.previewStatus, 200)
    assert.equal(created.preview.complete, true)
    assert.equal(created.preview.documents.total, 1)
    assert.equal(created.preview.documents.bodiesByMode[mode.id], 1)
    assert.deepEqual(created.preview.documents.missingBodies, [])

    await returnHome(page)
    await page.evaluate(() => {
      localStorage.clear()
      sessionStorage.clear()
    })
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 })
    await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
    await page.getByText(mode.title, { exact: true }).click()
    await mode.ready(page).waitFor({ state: 'visible', timeout: 20_000 })
    assert.equal(await page.getByText(/找不到此|无法读取/u).count(), 0)

    const reopened = await projectEvidence(page, mode.title, mode.id)
    assert.equal(reopened.projectId, created.projectId)
    assert.equal(reopened.documentId, created.documentId)
    assert.equal(reopened.bodyRevision, 0)
    assert.equal(reopened.preview.complete, true)
    report.modes.push({
      id: mode.id,
      projectId: created.projectId,
      documentId: created.documentId,
      revision: reopened.bodyRevision,
      packageBodies: `${reopened.preview.documents.bodiesByMode[mode.id]}/${reopened.preview.documents.byMode[mode.id]}`,
      reopenedAfterBrowserClear: true,
    })
    await returnHome(page)
  }

  await page.getByRole('button', { name: '打开原子均衡项目项目操作', exact: true }).click()
  await page.getByRole('button', { name: '新建智能视频', exact: true }).click()
  await modes[2].ready(page).waitFor({ state: 'visible', timeout: 20_000 })
  const addedModeEvidence = await projectEvidence(page, '原子均衡项目', 'smart-video')
  assert.equal(addedModeEvidence.bodyRevision, 0)
  assert.equal(addedModeEvidence.preview.complete, true)
  assert.equal(addedModeEvidence.preview.documents.total, 2)
  assert.equal(addedModeEvidence.preview.documents.bodiesByMode['smart-video'], 1)
  await returnHome(page)
  await page.evaluate(() => {
    localStorage.clear()
    sessionStorage.clear()
  })
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
  await page.getByRole('button', { name: '打开原子均衡项目项目操作', exact: true }).click()
  await page.getByRole('button', { name: '打开智能视频', exact: true }).click()
  await modes[2].ready(page).waitFor({ state: 'visible', timeout: 20_000 })
  report.addedMode = {
    projectId: addedModeEvidence.projectId,
    documentId: addedModeEvidence.documentId,
    revision: addedModeEvidence.bodyRevision,
    packageBodies: `${addedModeEvidence.preview.documents.bodiesByMode['smart-video']}/${addedModeEvidence.preview.documents.byMode['smart-video']}`,
    reopenedAfterBrowserClear: true,
  }
  await returnHome(page)

  const backfill = await page.evaluate(async () => {
    const currentResponse = await fetch('/api/workspace/catalog')
    const current = await currentResponse.json()
    const now = Date.now()
    const projectId = 'project-revision-zero-backfill'
    const documentId = 'document-revision-zero-backfill'
    const catalog = {
      ...current.catalog,
      revision: current.catalog.revision + 1,
      projects: [...current.catalog.projects, {
        id: projectId,
        title: '历史空入口恢复',
        description: '模拟旧版离线创建后仅写入目录的 revision 0 项目。',
        color: 'blue',
        initialModeId: 'pixel',
        status: 'active',
        createdAt: now,
        updatedAt: now,
        lastOpenedAt: now,
        trashedAt: null,
        documents: [{
          id: documentId,
          modeId: 'pixel',
          title: '历史空入口恢复 · 像素画布',
          revision: 0,
          createdAt: now,
          updatedAt: now,
        }],
      }],
    }
    const response = await fetch('/api/workspace/catalog', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ catalog, baseRevision: current.catalog.revision, source: 'ui-backfill-fixture' }),
    })
    return { status: response.status, projectId, documentId }
  })
  assert.equal(backfill.status, 200)
  await page.evaluate(() => {
    localStorage.clear()
    sessionStorage.clear()
  })
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
  await page.getByText('历史空入口恢复', { exact: true }).click()
  await page.getByLabel(/像素绘制区/u).waitFor({ state: 'visible', timeout: 20_000 })
  const backfillEvidence = await projectEvidence(page, '历史空入口恢复', 'pixel')
  assert.equal(backfillEvidence.documentId, backfill.documentId)
  assert.equal(backfillEvidence.bodyRevision, 0)
  assert.equal(backfillEvidence.preview.complete, true)
  report.revisionZeroBackfill = {
    projectId: backfill.projectId,
    documentId: backfill.documentId,
    revision: backfillEvidence.bodyRevision,
    packageBodies: `${backfillEvidence.preview.documents.bodiesByMode.pixel}/${backfillEvidence.preview.documents.byMode.pixel}`,
    recoveredWithoutErrorGate: true,
  }

  assert.deepEqual(report.issues, [])
  report.status = 'passed'
  console.log('✓ Three modes create an atomic revision-zero body and reopen after browser storage is cleared')
} finally {
  report.generatedAt = new Date().toISOString()
  await mkdir(join(projectRoot, '.runtime', 'qa'), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await page?.close().catch(() => undefined)
  await browser?.close().catch(() => undefined)
  await bridge.stop()
}
