import assert from 'node:assert/strict'
import { access, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

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
    await page.getByRole('button', { name: /像素模式 精细像素绘制与动画/ }).click()
  } else if (mode === 'smart-video') {
    await page.getByRole('button', { name: /智能视频 从灵感或剧本开始制片/ }).click()
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
observePage(page, issues)

try {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible' })
  assert.equal(await page.locator('body').evaluate((body) => body.scrollWidth <= body.clientWidth), true)

  await createProject(page, { title: '独立均衡项目', mode: 'balanced' })
  await page.getByLabel('无限画布').waitFor({ state: 'visible', timeout: 10_000 })
  assert.match(page.url(), /#\/balanced\?project=project-/u)
  await returnHome(page)

  await createProject(page, { title: '独立智能视频项目', mode: 'smart-video' })
  await page.getByText('多智能体制片工作室', { exact: true }).first().waitFor({ state: 'visible', timeout: 10_000 })
  assert.match(page.url(), /#\/smart-video\?project=project-/u)
  await returnHome(page)

  await createProject(page, { title: '独立像素项目', mode: 'pixel' })
  await page.getByLabel(/像素绘制区/u).waitFor({ state: 'visible', timeout: 10_000 })
  assert.match(page.url(), /#\/pixel\?project=project-/u)
  await returnHome(page)

  for (const title of ['独立均衡项目', '独立智能视频项目', '独立像素项目']) {
    await page.getByText(title, { exact: true }).waitFor({ state: 'visible' })
  }

  const catalog = await page.evaluate(() => JSON.parse(localStorage.getItem('aeonquill:project-catalog:v1')))
  assert.equal(catalog.schemaVersion, 1)
  assert.equal(catalog.projects.length, 3)
  assert.deepEqual(
    catalog.projects.map((project) => project.documents.map((document) => document.modeId)),
    [['balanced'], ['smart-video'], ['pixel']],
  )
  assert.equal(new Set(catalog.projects.flatMap((project) => project.documents.map((document) => document.id))).size, 3)

  await page.getByRole('button', { name: '打开独立像素项目项目操作', exact: true }).click()
  await page.getByRole('button', { name: '归档', exact: true }).click()
  await page.getByRole('button', { name: '已归档', exact: true }).click()
  await page.getByRole('button', { name: '恢复', exact: true }).click()
  await page.getByRole('button', { name: '全部项目', exact: true }).click()
  await page.getByText('独立像素项目', { exact: true }).waitFor({ state: 'visible' })

  await page.screenshot({
    path: join(artifactDirectory, 'project-center-v070-desktop.png'),
    type: 'png',
    fullPage: true,
  })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible' })
  assert.equal(await page.locator('body').evaluate((body) => body.scrollWidth <= body.clientWidth), true)
  await page.screenshot({
    path: join(artifactDirectory, 'project-center-v070-mobile.png'),
    type: 'png',
    fullPage: true,
  })

  assert.deepEqual(issues, [])
  console.log(JSON.stringify({
    ok: true,
    baseUrl,
    projects: catalog.projects.length,
    desktop: 'project-center-v070-desktop.png',
    mobile: 'project-center-v070-mobile.png',
  }, null, 2))
} finally {
  await browser.close()
}
