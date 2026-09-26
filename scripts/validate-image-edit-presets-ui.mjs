import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import { evaluateSemanticWorkflowCatalog } from '../server/semantic-workflow-registry.mjs'
import { ARTIFACTS } from '../server/workflow-artifacts.mjs'
import { startIsolatedBridge } from './qa-runtime.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const reportDirectory = join(projectRoot, '.runtime', 'qa')
await mkdir(reportDirectory, { recursive: true })
const bridge = await startIsolatedBridge('image-edit-presets-ui')
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const issues = []
const requests = []
let lightningInstalled = false
let failure
page.on('pageerror', (error) => issues.push(error.message))

// UI contract fixture only. Actual model timing/quality is recorded by the real-model benchmark.
const definitions = evaluateSemanticWorkflowCatalog().workflows
await page.route('**/api/semantic-workflows*', async (route) => {
  const artifacts = definitions.flatMap(({ requiredArtifacts }) => requiredArtifacts)
  if (lightningInstalled) artifacts.push(ARTIFACTS.qwenLightning4Lora.id)
  const catalog = evaluateSemanticWorkflowCatalog({
    artifacts,
    extensions: definitions.flatMap(({ requiredExtensions }) => requiredExtensions),
    runtime: { connected: false, lifecycle: { state: 'stopped' } },
  })
  await route.fulfill({ json: catalog })
})
await page.route('**/api/jobs/semantic-image', async (route) => {
  requests.push(route.request().postDataJSON())
  await route.fulfill({ status: 409, json: { error: { code: 'QA_CAPTURE', message: 'UI 请求已采集；未运行模型。' } } })
})

try {
  await page.goto(bridge.baseUrl, { waitUntil: 'domcontentloaded' })
  await page.locator('.aq-home-header').getByRole('button', { name: '创建新项目', exact: true }).click()
  const creation = page.getByRole('dialog', { name: '创建新项目' })
  await creation.getByPlaceholder('输入项目名称').fill('编辑档位 UI 回归')
  await creation.getByRole('button', { name: /均衡模式 图像、文字与多模态创作/u }).click()
  await creation.getByRole('button', { name: '创建并进入', exact: true }).click()
  await creation.waitFor({ state: 'hidden' })
  const canvas = page.getByLabel('无限画布')
  await canvas.waitFor({ state: 'visible' })
  const imageDataUrl = await page.evaluate(() => {
    const fixture = document.createElement('canvas')
    fixture.width = 128
    fixture.height = 128
    const context = fixture.getContext('2d')
    context.fillStyle = '#5787a0'
    context.fillRect(0, 0, 128, 128)
    return fixture.toDataURL('image/png')
  })
  await page.locator('input[accept="image/*"]').setInputFiles({
    name: 'preset-contract.png', mimeType: 'image/png', buffer: Buffer.from(imageDataUrl.split(',')[1], 'base64'),
  })
  await page.getByText('图片已添加到画布', { exact: true }).waitFor({ state: 'visible' })
  await page.getByRole('tab', { name: '编辑', exact: true }).click()
  await page.getByRole('button', { name: '蒙版修边', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '图像处理实验室' })
  await dialog.waitFor({ state: 'visible' })
  await dialog.getByRole('tab', { name: '人像调整', exact: true }).click()
  const select = dialog.getByRole('combobox', { name: '编辑档位' })
  const fastOption = select.locator('option[value="lightning4"]')
  await expect(select).toHaveValue('base40')
  await expect(fastOption).toHaveJSProperty('disabled', true)
  await dialog.getByLabel(/人像调整指令/u).fill('保持身份，将衣领改为深青色。')
  const submit = dialog.getByRole('button', { name: '提交正式处理', exact: true })
  await expect(submit).toBeEnabled()
  await submit.click()
  await expect(dialog.locator('.image-lab-error')).toContainText('UI 请求已采集')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].workflowId, 'portrait-adjust')
  assert.equal(Object.hasOwn(requests[0].params, 'preset'), false, 'Standard requests preserve the old wire shape')

  lightningInstalled = true
  await dialog.getByRole('button', { name: '刷新图像处理器状态' }).click()
  await expect(fastOption).toHaveJSProperty('disabled', false)
  await select.selectOption('lightning4')
  await expect(submit).toBeEnabled()
  await submit.click()
  await expect(dialog.locator('.image-lab-error')).toContainText('UI 请求已采集')
  assert.equal(requests.length, 2)
  assert.equal(requests[1].params.preset, 'lightning4')
  assert.equal(requests[1].params.instruction, requests[0].params.instruction)

  for (const mode of ['区域编辑', '定点修改']) {
    await dialog.getByRole('tab', { name: mode, exact: true }).click()
    await expect(select).toHaveValue('lightning4')
  }
  await dialog.getByRole('tab', { name: '元素提取', exact: true }).click()
  await expect(select).toHaveCount(0)
  await dialog.getByRole('tab', { name: '人像调整', exact: true }).click()
  await expect(select).toHaveValue('lightning4')

  // Losing a dependency must disable the selected preset instead of silently falling back.
  lightningInstalled = false
  await dialog.getByRole('button', { name: '刷新图像处理器状态' }).click()
  await expect(fastOption).toHaveJSProperty('disabled', true)
  await expect(select).toHaveValue('lightning4')
  await expect(submit).toBeDisabled()
  await select.selectOption('base40')
  await expect(submit).toBeEnabled()
  assert.equal(requests.length, 2)

  await page.screenshot({ path: join(reportDirectory, 'image-edit-presets-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(select).toBeVisible()
  assert.equal(await page.locator('body').evaluate((element) => element.scrollWidth <= element.clientWidth), true)
  const selectBox = await select.boundingBox()
  assert.ok(selectBox && selectBox.x >= 0 && selectBox.x + selectBox.width <= 390)
  await page.screenshot({ path: join(reportDirectory, 'image-edit-presets-mobile.png') })
  assert.deepEqual(issues, [])
} catch (error) {
  failure = error
  await page.screenshot({ path: join(reportDirectory, 'image-edit-presets-failure.png') }).catch(() => undefined)
} finally {
  await writeFile(join(reportDirectory, 'image-edit-presets-ui.json'), `${JSON.stringify({
    status: failure ? 'failed' : 'passed', generatedAt: new Date().toISOString(),
    scope: 'UI request contract with controlled capability fixture; no model inference or quality acceptance',
    requests: requests.map(({ workflowId, params }) => ({ workflowId, params })),
    checks: ['default-omits-preset', 'missing-dependency-disabled', 'on-demand-runtime-selection', 'selected-preset-request', 'no-silent-fallback', 'qwen-only-selector', 'desktop-and-390px'],
    issues, error: failure?.stack,
  }, null, 2)}\n`, 'utf8')
  await browser.close()
  await bridge.stop()
}
if (failure) throw failure
console.log('Image edit preset UI contract passed (desktop + 390px; no inference).')
