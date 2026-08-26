import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { startIsolatedBridge } from './qa-runtime.mjs'

const libraryPng = await readFile(new URL('../src/assets/sample-summer-character.png', import.meta.url))

const bridge = await startIsolatedBridge('asset-library-ui')
const artifactDirectory = fileURLToPath(new URL('../.runtime/qa', import.meta.url))
await mkdir(artifactDirectory, { recursive: true })
const executablePath = process.platform === 'win32'
  ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  : undefined
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const issues = []

page.on('pageerror', (error) => issues.push(`pageerror: ${error.message}`))
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') issues.push(`${message.type()}: ${message.text()}`)
})
page.on('response', (response) => {
  if (response.status() >= 400) {
    issues.push(`http ${response.status()}: ${response.url()}`)
  }
})

async function returnHome() {
  await page.locator('button[aria-label*="返回"]').first().click()
  await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible' })
}

async function openLibrary() {
  await page.getByRole('button', { name: /打开.*资源库/u }).first().click()
  await page.getByRole('dialog', { name: '资源库' }).waitFor({ state: 'visible' })
}

try {
  await page.goto(bridge.baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible' })
  await page.locator('.aq-home-header').getByRole('button', { name: '创建新项目', exact: true }).click()
  await page.getByPlaceholder('输入项目名称').fill('资源库联调项目')
  await page.getByRole('button', { name: '创建并进入', exact: true }).click()
  await page.getByLabel('无限画布').waitFor({ state: 'visible', timeout: 10_000 })

  await openLibrary()
  const dialog = page.getByRole('dialog', { name: '资源库' })
  await dialog.getByRole('button', { name: '导入资源', exact: true }).click()
  await dialog.locator('input[type="file"]').setInputFiles({
    name: 'library-qa.png',
    mimeType: 'image/png',
    buffer: libraryPng,
  })
  await dialog.getByLabel('名称').fill('资源库联调图像')
  await dialog.getByLabel('标签').fill('联调, 跨模式')
  await dialog.getByRole('button', { name: '写入全局资源库', exact: true }).click()
  await dialog.getByText('“资源库联调图像”已写入全局资源库。', { exact: true }).waitFor({ state: 'visible' })
  await page.screenshot({ path: join(artifactDirectory, 'asset-library-dialog-desktop.png'), fullPage: true })
  await dialog.getByRole('button', { name: '用于均衡模式', exact: true }).click()
  await dialog.waitFor({ state: 'hidden', timeout: 5_000 })
  await page.locator('img[alt="资源库联调图像"]').waitFor({ state: 'visible', timeout: 10_000 })

  await returnHome()
  await openLibrary()
  await dialog.getByRole('heading', { name: '资源库联调图像', exact: true }).waitFor({ state: 'visible' })
  await dialog.getByRole('button', { name: '关闭资源库', exact: true }).click()

  await page.getByRole('button', { name: '打开资源库联调项目项目操作', exact: true }).click()
  await page.getByRole('button', { name: '新建像素模式', exact: true }).click()
  await page.getByLabel(/像素绘制区/u).waitFor({ state: 'visible', timeout: 10_000 })
  await openLibrary()
  await dialog.getByRole('tab', { name: '项目资源', exact: true }).click()
  await dialog.getByRole('heading', { name: '资源库联调图像', exact: true }).waitFor({ state: 'visible' })
  await dialog.getByRole('button', { name: '用于像素模式', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await page.getByText(/已载入 资源库联调图像\.png，调整参数后执行确定性转换/u).waitFor({ state: 'visible', timeout: 10_000 })

  await returnHome()
  await page.getByRole('button', { name: '打开资源库联调项目项目操作', exact: true }).click()
  await page.getByRole('button', { name: '新建智能视频', exact: true }).click()
  await page.getByText('多智能体制片工作室', { exact: true }).first().waitFor({ state: 'visible', timeout: 10_000 })
  await openLibrary()
  await dialog.getByRole('tab', { name: '项目资源', exact: true }).click()
  await dialog.getByRole('heading', { name: '资源库联调图像', exact: true }).waitFor({ state: 'visible' })
  await dialog.getByRole('button', { name: '用于智能视频', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await page.getByText('首帧已规范化', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  await page.getByText(/资源库联调图像\.png · sha256:/u).waitFor({ state: 'visible', timeout: 10_000 })

  assert.equal(await page.locator('body').evaluate((body) => body.scrollWidth <= body.clientWidth), true)
  assert.deepEqual(issues, [])
  await page.screenshot({ path: join(artifactDirectory, 'asset-library-desktop.png'), fullPage: true })
  console.log('✓ Resource library links one immutable asset into balanced, pixel, and smart-video modes')
} catch (error) {
  await page.screenshot({ path: join(artifactDirectory, 'asset-library-failure.png'), fullPage: true }).catch(() => undefined)
  const workspace = await page.evaluate(async () => {
    const response = await fetch('/api/workspace/catalog', { credentials: 'same-origin' })
    return { status: response.status, body: await response.json().catch(() => null) }
  }).catch(() => null)
  console.error(JSON.stringify({ url: page.url(), issues, workspace, body: (await page.locator('body').innerText().catch(() => '')).slice(0, 5000), artifactDirectory }, null, 2))
  throw error
} finally {
  await browser.close().catch(() => undefined)
  await bridge.stop({ keepRuntime: false })
}
