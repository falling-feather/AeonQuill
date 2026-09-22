import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { startIsolatedBridge } from './qa-runtime.mjs'

const bridge = await startIsolatedBridge('workflow-center-ui')
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
  if (response.status() >= 400) issues.push(`http ${response.status()}: ${response.url()}`)
})

try {
  await page.goto(bridge.baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '打开工作流中心', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '工作流中心' })
  await dialog.waitFor({ state: 'visible' })
  await dialog.getByRole('tab', { name: '内置能力包', exact: true }).click()
  await dialog.getByRole('button', { name: /H3 质量母版/u }).click()
  await dialog.getByRole('heading', { name: 'H3 质量母版 · INT8 ConvRot', exact: true }).waitFor({ state: 'visible' })
  await dialog.getByText('MiniMax-H3 Community License Agreement', { exact: true }).waitFor({ state: 'visible' })
  await dialog.getByText(/下载只写入受控 ComfyUI\/models 相对目录/u).waitFor({ state: 'visible' })
  assert.equal(await dialog.getByRole('button', { name: '先配置本机运行时', exact: true }).isVisible(), true)
  assert.equal(await page.locator('body').evaluate((body) => body.scrollWidth <= body.clientWidth), true)
  await page.screenshot({ path: join(artifactDirectory, 'workflow-center-desktop.png'), fullPage: true })

  await dialog.getByRole('tab', { name: '自定义 ComfyUI JSON', exact: true }).click()
  const safeWorkflow = Buffer.from(JSON.stringify({
    1: { class_type: 'CLIPTextEncode', inputs: { text: '水墨产品广告' } },
    2: { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'AEONQUILL' } },
  }))
  await dialog.locator('input[type="file"]').setInputFiles({ name: 'safe-api-workflow.json', mimeType: 'application/json', buffer: safeWorkflow })
  await dialog.getByText('2 节点', { exact: true }).waitFor({ state: 'visible' })
  await dialog.getByLabel(/正向提示词/u).selectOption('1|text')
  await dialog.getByLabel(/最终输出/u).selectOption('2')
  await dialog.getByRole('button', { name: '安全检查', exact: true }).click()
  await dialog.getByText('静态检查通过', { exact: true }).waitFor({ state: 'visible' })
  await dialog.getByText('ComfyUI 当前休眠；导入时将按策略启动并以真实节点表再次检查。', { exact: true }).waitFor({ state: 'visible' })
  assert.equal(await dialog.getByRole('button', { name: '复检并导入', exact: true }).isEnabled(), true)
  assert.deepEqual(issues, [])

  await page.setViewportSize({ width: 390, height: 844 })
  await dialog.getByRole('tab', { name: '内置能力包', exact: true }).click()
  await dialog.getByRole('button', { name: /H3 极速/u }).click()
  await page.waitForTimeout(150)
  assert.equal(await page.locator('body').evaluate((body) => body.scrollWidth <= body.clientWidth), true)
  await page.screenshot({ path: join(artifactDirectory, 'workflow-center-mobile.png'), fullPage: true })
  console.log('✓ Workflow center renders real catalog, license/runtime gates, custom mapping scan, and responsive layouts')
} catch (error) {
  await page.screenshot({ path: join(artifactDirectory, 'workflow-center-failure.png'), fullPage: true }).catch(() => undefined)
  console.error(JSON.stringify({ url: page.url(), issues, body: (await page.locator('body').innerText().catch(() => '')).slice(0, 6000), artifactDirectory }, null, 2))
  throw error
} finally {
  await browser.close().catch(() => undefined)
  await bridge.stop({ keepRuntime: false })
}
