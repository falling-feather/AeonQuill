import assert from 'node:assert/strict'
import { mkdir, stat, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

import { startIsolatedBridge } from './qa-runtime.mjs'

const bridge = await startIsolatedBridge('storage-lifecycle-ui')
const artifactDirectory = fileURLToPath(new URL('../.runtime/qa', import.meta.url))
await mkdir(artifactDirectory, { recursive: true })
const previewPath = join(bridge.runtimeDirectory, 'cache', 'previews', 'ui-expired-preview.webp')
await mkdir(dirname(previewPath), { recursive: true })
await writeFile(previewPath, 'expired preview cache')
const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1_000)
await utimes(previewPath, old, old)

const executablePath = process.platform === 'win32'
  ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  : undefined
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
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
  await page.getByRole('button', { name: '打开设置', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '本机能力与设置' })
  await dialog.waitFor({ state: 'visible' })
  await dialog.getByRole('heading', { name: '空间与保留策略', exact: true }).waitFor({ state: 'visible' })
  await dialog.getByText('可重建预览缓存', { exact: true }).waitFor({ state: 'visible' })
  await dialog.getByText(/模型移除须通过反向引用门/u).waitFor({ state: 'visible' }).catch(() => undefined)
  const cleanupButton = dialog.getByRole('button', { name: '确认并开始安全清理', exact: true })
  assert.equal(await cleanupButton.isDisabled(), true)
  await dialog.getByRole('button', { name: '选择全部候选', exact: true }).click()
  assert.equal(await cleanupButton.isEnabled(), true)
  await cleanupButton.click()
  await dialog.getByText(/已实际回收/u).waitFor({ state: 'visible', timeout: 20_000 })
  await dialog.getByText('当前没有满足安全条件的到期文件。', { exact: true }).waitFor({ state: 'visible' })
  await assert.rejects(stat(previewPath), (error) => error.code === 'ENOENT')
  assert.equal(await dialog.getByText(/最终交付始终受保护/u).isVisible(), true)
  assert.equal(await page.locator('body').evaluate((body) => body.scrollWidth <= body.clientWidth), true)
  await page.screenshot({ path: join(artifactDirectory, 'storage-lifecycle-desktop.png'), fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.locator('body').evaluate((body) => body.scrollWidth <= body.clientWidth), true)
  await page.screenshot({ path: join(artifactDirectory, 'storage-lifecycle-mobile.png'), fullPage: true })
  assert.deepEqual(issues, [])
  console.log('✓ Storage lifecycle UI reviewed candidates, acknowledged cleanup, tracked progress and remained responsive')
} catch (error) {
  await page.screenshot({ path: join(artifactDirectory, 'storage-lifecycle-failure.png'), fullPage: true }).catch(() => undefined)
  console.error(JSON.stringify({ issues, body: (await page.locator('body').innerText().catch(() => '')).slice(0, 8000) }, null, 2))
  throw error
} finally {
  await browser.close().catch(() => undefined)
  await bridge.stop({ keepRuntime: false })
}
