import assert from 'node:assert/strict'
import { access, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createPixelDocument, serializePixelDocument } from '../src/lib/pixel/pixelCore.mjs'
import { serializeSmartVideoSession } from '../src/shell/productShellState.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const baseUrl = process.env.AEONQUILL_PROJECT_CENTER_URL || 'http://127.0.0.1:4173/'
const artifactDirectory = join(projectRoot, '.runtime', 'qa')

async function firstExisting(paths) {
  for (const path of paths) {
    try {
      await access(path)
      return path
    } catch {
      // Continue to the next already-installed browser candidate.
    }
  }
  return undefined
}

function observePage(page, issues) {
  page.on('pageerror', (error) => issues.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    const text = message.text()
    if ((message.type() === 'error' || message.type() === 'warning') && !text.includes('Failed to load resource')) {
      issues.push(`${message.type()}: ${text}`)
    }
  })
}

async function openCreateDialog(page) {
  await page.locator('.aq-home-header').getByRole('button', { name: '创建新项目', exact: true }).click()
  await page.getByRole('dialog', { name: '创建新项目' }).waitFor({ state: 'visible' })
}

async function createProject(page, { title, mode }) {
  await openCreateDialog(page)
  await page.getByPlaceholder('输入项目名称').fill(title)
  if (mode === 'pixel') {
    const option = page.getByRole('button', { name: /像素模式 精细像素绘制与动画/ })
    await option.click()
    assert.equal(await option.getAttribute('aria-pressed'), 'true')
  } else if (mode === 'smart-video') {
    const option = page.getByRole('button', { name: /智能视频 从灵感或剧本开始制片/ })
    await option.click()
    assert.equal(await option.getAttribute('aria-pressed'), 'true')
  }
  await page.getByRole('button', { name: '创建并进入', exact: true }).click()
}

async function returnHome(page) {
  await page.locator('button[aria-label*="返回"]').first().click()
  await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible' })
}

await mkdir(artifactDirectory, { recursive: true })
const executablePath = await firstExisting([
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
])
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
const issues = []
let legacyContext
observePage(page, issues)

try {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '导入完整项目包', exact: true }).waitFor({ state: 'visible' })
  assert.equal(await page.locator('body').evaluate((body) => body.scrollWidth <= body.clientWidth), true)

  await createProject(page, { title: '独立均衡项目', mode: 'balanced' })
  await page.getByLabel('无限画布').waitFor({ state: 'visible', timeout: 10_000 })
  assert.match(page.url(), /#\/balanced\?project=project-/u)
  await returnHome(page)

  await createProject(page, { title: '独立智能视频项目', mode: 'smart-video' })
  await page.getByText('多智能体制片工作室', { exact: true }).first().waitFor({ state: 'visible', timeout: 10_000 })
  assert.match(page.url(), /#\/smart-video\?project=project-/u)
  await page.getByRole('button', { name: '故事', exact: true }).click()
  const videoSource = page.locator('.aq-video-script-field textarea')
  await videoSource.fill('场景：雨夜码头。镜头：女侠收伞回望，远处灯火沿水面延展。')
  await page.getByRole('button', { name: '编译故事计划', exact: true }).click()
  await page.getByText('计划与执行双重校验', { exact: true }).waitFor({ state: 'visible' })
  await returnHome(page)

  await createProject(page, { title: '独立像素项目', mode: 'pixel' })
  await page.getByLabel(/像素绘制区/u).waitFor({ state: 'visible', timeout: 10_000 })
  assert.match(page.url(), /#\/pixel\?project=project-/u)
  await returnHome(page)

  for (const title of ['独立均衡项目', '独立智能视频项目', '独立像素项目']) {
    await page.getByText(title, { exact: true }).waitFor({ state: 'visible' })
  }

  await page.getByText('独立智能视频项目', { exact: true }).click()
  await page.getByRole('button', { name: '故事', exact: true }).click()
  assert.equal(await page.locator('.aq-video-script-field textarea').inputValue(), '场景:雨夜码头。镜头:女侠收伞回望,远处灯火沿水面延展。')
  await returnHome(page)

  await page.getByRole('button', { name: '打开独立均衡项目项目操作', exact: true }).click()
  await page.getByRole('button', { name: '新建像素模式', exact: true }).click()
  await page.getByLabel(/像素绘制区/u).waitFor({ state: 'visible', timeout: 10_000 })
  assert.match(page.url(), /#\/pixel\?project=project-/u)
  await returnHome(page)
  const balancedProjectRow = page.locator('.aq-project-rows > li').filter({ hasText: '独立均衡项目' })
  assert.equal(await balancedProjectRow.locator('.aq-project-counts').innerText(), '1 / 1 / 0')

  await page.getByRole('button', { name: '打开独立均衡项目项目操作', exact: true }).click()
  await page.getByRole('button', { name: '导出完整项目包', exact: true }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '打开像素模式', exact: true }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '打开独立均衡项目项目操作', exact: true }).click()

  const catalog = await page.evaluate(() => JSON.parse(localStorage.getItem('aeonquill:project-catalog:v1')))
  assert.equal(catalog.schemaVersion, 1)
  assert.equal(catalog.projects.length, 3)
  assert.deepEqual(
    catalog.projects.map((project) => project.documents.map((document) => document.modeId)),
    [['balanced', 'pixel'], ['smart-video'], ['pixel']],
  )
  assert.equal(new Set(catalog.projects.flatMap((project) => project.documents.map((document) => document.id))).size, 4)

  await page.getByRole('button', { name: '打开独立均衡项目项目操作', exact: true }).click()
  await page.getByRole('button', { name: '恢复点', exact: true }).click()
  const recoveryDialog = page.getByRole('dialog', { name: '项目恢复点' })
  await recoveryDialog.waitFor({ state: 'visible' })
  await recoveryDialog.getByRole('button', { name: '创建当前恢复点', exact: true }).click()
  await recoveryDialog.getByText('已创建当前项目恢复点。', { exact: true }).waitFor({ state: 'visible' })
  assert.equal(await recoveryDialog.locator('.aq-recovery-list > li').count() >= 1, true)
  await recoveryDialog.getByRole('button', { name: '关闭项目恢复点', exact: true }).click()

  await page.getByRole('button', { name: '打开独立像素项目项目操作', exact: true }).click()
  await page.getByRole('button', { name: '归档', exact: true }).click()
  await page.getByRole('button', { name: '已归档', exact: true }).click()
  await page.getByRole('button', { name: '恢复', exact: true }).click()
  await page.getByRole('button', { name: '全部项目', exact: true }).click()
  await page.getByText('独立像素项目', { exact: true }).waitFor({ state: 'visible' })

  await page.screenshot({
    path: join(artifactDirectory, 'project-center-v073-desktop.png'),
    type: 'png',
    fullPage: true,
  })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible' })
  assert.equal(await page.locator('body').evaluate((body) => body.scrollWidth <= body.clientWidth), true)
  await page.screenshot({
    path: join(artifactDirectory, 'project-center-v073-mobile.png'),
    type: 'png',
    fullPage: true,
  })

  legacyContext = await browser.newContext({ viewport: { width: 1180, height: 760 } })
  const legacyIssues = []
  const legacyPage = await legacyContext.newPage()
  observePage(legacyPage, legacyIssues)
  const legacyPixel = serializePixelDocument(createPixelDocument({
    id: 'legacy-pixel-document',
    name: '旧像素草稿',
    width: 8,
    height: 8,
    revision: 3,
  }))
  const legacyVideo = serializeSmartVideoSession({
    version: 1,
    projectId: 'legacy-video-document',
    title: '旧视频会话',
    sourceKind: 'idea',
    sourceText: '旧版单例智能视频创意。',
    updatedAt: 1_728_000_000_000,
    sceneCount: 2,
    taskCount: 5,
  })
  await legacyContext.addInitScript(({ pixelValue, videoValue }) => {
    localStorage.setItem('aeonquill:pixel-document:v1', pixelValue)
    sessionStorage.setItem('aeonquill:smart-video-session:v1', videoValue)
  }, { pixelValue: legacyPixel, videoValue: legacyVideo })
  await legacyPage.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await legacyPage.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible' })
  await legacyPage.getByText('旧像素草稿', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  await legacyPage.getByText('旧视频会话', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  const migrationResult = await legacyPage.evaluate(() => {
    const migratedCatalog = JSON.parse(localStorage.getItem('aeonquill:project-catalog:v1'))
    return {
      projects: migratedCatalog.projects.map((project) => ({
        title: project.title,
        documents: project.documents.map((document) => ({ id: document.id, modeId: document.modeId })),
      })),
      legacyPixelPreserved: localStorage.getItem('aeonquill:pixel-document:v1') !== null,
      legacyVideoPreserved: sessionStorage.getItem('aeonquill:smart-video-session:v1') !== null,
    }
  })
  const migratedLegacyProjects = migrationResult.projects.filter(({ title }) => title.startsWith('旧'))
  assert.deepEqual(migratedLegacyProjects, [
    { title: '旧像素草稿', documents: [{ id: 'legacy-pixel-document', modeId: 'pixel' }] },
    { title: '旧视频会话', documents: [{ id: 'legacy-video-document', modeId: 'smart-video' }] },
  ])
  assert.equal(migrationResult.projects.some(({ title }) => title === '独立均衡项目'), true)
  assert.equal(migrationResult.legacyPixelPreserved, true)
  assert.equal(migrationResult.legacyVideoPreserved, true)
  await legacyPage.getByText('旧像素草稿', { exact: true }).click()
  await legacyPage.getByLabel(/像素绘制区/u).waitFor({ state: 'visible', timeout: 10_000 })
  assert.deepEqual(legacyIssues, [])

  const packageApi = await page.evaluate(async (projectId) => {
    const previewResponse = await fetch(`/api/workspace/projects/${encodeURIComponent(projectId)}/package/preview`)
    const preview = await previewResponse.json()
    const packageResponse = await fetch(`/api/workspace/projects/${encodeURIComponent(projectId)}/package`)
    const bundle = await packageResponse.arrayBuffer()
    const importPreviewResponse = await fetch('/api/workspace/packages/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: bundle,
    })
    const importPreview = await importPreviewResponse.json()
    const importResponse = await fetch('/api/workspace/packages/import?conflictPolicy=copy', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: bundle,
    })
    const imported = await importResponse.json()
    return {
      previewStatus: previewResponse.status,
      packageStatus: packageResponse.status,
      previewImportStatus: importPreviewResponse.status,
      importStatus: importResponse.status,
      preview: preview.preview,
      importPreview: importPreview.preview,
      result: imported.result,
    }
  }, catalog.projects[0].id)
  assert.equal(packageApi.previewStatus, 200)
  assert.equal(packageApi.packageStatus, 200)
  assert.equal(packageApi.previewImportStatus, 200)
  assert.equal(packageApi.importStatus, 201)
  assert.equal(packageApi.preview.format, 'aeonquill-project')
  assert.equal(packageApi.importPreview.conflicts.some(({ kind }) => kind === 'project'), true)
  assert.notEqual(packageApi.result.project.id, catalog.projects[0].id)

  assert.deepEqual(issues, [])
  console.log(JSON.stringify({
    ok: true,
    baseUrl,
    projects: catalog.projects.length,
    documents: 4,
    migratedLegacyProjects: migratedLegacyProjects.length,
    packageRoundTrip: true,
    desktop: 'project-center-v073-desktop.png',
    mobile: 'project-center-v073-mobile.png',
  }, null, 2))
} catch (error) {
  await page.screenshot({
    path: join(artifactDirectory, 'project-center-failure.png'),
    type: 'png',
    fullPage: true,
  }).catch(() => undefined)
  console.error(JSON.stringify({ url: page.url(), issues, body: (await page.locator('body').innerText().catch(() => '')).slice(0, 4000) }, null, 2))
  throw error
} finally {
  await legacyContext?.close()
  await browser.close()
}
