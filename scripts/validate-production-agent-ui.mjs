import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { startIsolatedBridge } from './qa-runtime.mjs'

const bridge = await startIsolatedBridge('production-agent-ui')
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

async function createSmartVideoProject() {
  await page.locator('.aq-home-header').getByRole('button', { name: '创建新项目', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '创建新项目' })
  await dialog.getByPlaceholder('输入项目名称').fill('P3 旗舰广告')
  await dialog.getByRole('button', { name: /智能视频 从灵感或剧本开始制片/u }).click()
  await dialog.getByRole('button', { name: '创建并进入', exact: true }).click()
}

try {
  await page.goto(bridge.baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible' })
  await createSmartVideoProject()
  const studio = page.getByRole('region', { name: '多智能体制片工作室' })
  await studio.waitFor({ state: 'visible', timeout: 10_000 })

  await studio.getByLabel('生成方案').selectOption('quality')
  await studio.getByLabel('人物方案').selectOption('professional')
  await studio.getByRole('button', { name: '建立生产图', exact: true }).click()
  await studio.getByText('质量 / 专业人物', { exact: true }).waitFor({ state: 'visible' })

  await studio.getByText('人物设定', { exact: true }).first().click()
  const characterSession = studio.getByRole('region', { name: '人物一致性会话' })
  await characterSession.getByText(/^正面/u).waitFor({ state: 'visible' })
  await characterSession.getByText(/^侧面/u).waitFor({ state: 'visible' })
  await characterSession.getByText(/^背面/u).waitFor({ state: 'visible' })

  await studio.getByText('剧本设计', { exact: true }).first().click()
  await studio.getByRole('button', { name: '请求本地建议', exact: true }).click()
  await studio.getByText('剧本设计 · 本地受控建议', { exact: true }).waitFor({ state: 'visible' })
  await studio.getByRole('button', { name: '接受变更', exact: true }).click()
  await studio.getByText(/accepted/u).waitFor({ state: 'visible' })

  const adapter = studio.getByRole('region', { name: 'BYOK 文本智能体' })
  await adapter.getByLabel('HTTPS 接口基址').fill('http://127.0.0.1:65534/v1')
  await adapter.getByLabel('模型').fill('qa-model')
  await adapter.getByLabel('API Key').fill('qa-secret-12345678')
  await adapter.getByRole('button', { name: '仅本次运行启用', exact: true }).click()
  await adapter.getByText('本次运行已启用', { exact: true }).waitFor({ state: 'visible' })
  assert.equal((await adapter.innerText()).includes('qa-secret-12345678'), false)
  await adapter.getByRole('button', { name: '清除会话密钥', exact: true }).click()
  await adapter.getByText('未配置', { exact: true }).waitFor({ state: 'visible' })

  await page.waitForTimeout(700)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByText('多智能体制片工作室', { exact: true }).first().waitFor({ state: 'visible', timeout: 10_000 })
  const restoredStudio = page.getByRole('region', { name: '多智能体制片工作室' })
  await restoredStudio.getByText('质量 / 专业人物', { exact: true }).waitFor({ state: 'visible' })
  await restoredStudio.getByText('剧本设计', { exact: true }).first().click()
  await restoredStudio.getByText('剧本设计 · 本地受控建议', { exact: true }).waitFor({ state: 'visible' })
  await page.screenshot({ path: join(artifactDirectory, 'production-agent-desktop.png'), fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(150)
  assert.equal(await page.locator('body').evaluate((body) => body.scrollWidth <= body.clientWidth), true)
  assert.equal(await page.locator('.aq-video-workbench').evaluate((body) => body.scrollWidth <= body.clientWidth), true)
  await page.screenshot({ path: join(artifactDirectory, 'production-agent-mobile.png'), fullPage: true })
  assert.deepEqual(issues, [])
  console.log('✓ Production profiles, professional character constraints, review-only agent cards, memory-only BYOK, reload persistence, and responsive layout passed')
} catch (error) {
  await page.screenshot({ path: join(artifactDirectory, 'production-agent-failure.png'), fullPage: true }).catch(() => undefined)
  console.error(JSON.stringify({ url: page.url(), issues, body: (await page.locator('body').innerText().catch(() => '')).slice(0, 8000), artifactDirectory }, null, 2))
  throw error
} finally {
  await browser.close().catch(() => undefined)
  await bridge.stop({ keepRuntime: false })
}
