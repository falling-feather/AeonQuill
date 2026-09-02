import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

import { createProjectCatalog, createWorkspaceProject } from '../src/lib/project/projectCatalog.mjs'
import { startFakeComfyRuntime } from './qa-fake-comfy.mjs'
import { startIsolatedBridge } from './qa-runtime.mjs'

async function requestJson(bridge, pathname, options = {}, expected = 200) {
  const response = await bridge.request(pathname, {
    ...options,
    headers: options.body ? { 'content-type': 'application/json', ...options.headers } : options.headers,
  })
  const payload = await response.json()
  assert.equal(response.status, expected, `${options.method || 'GET'} ${pathname}: ${JSON.stringify(payload)}`)
  return payload
}

const comfy = await startFakeComfyRuntime()
const bridge = await startIsolatedBridge('custom-workflow-ui', { comfyUrl: comfy.url })
const artifactDirectory = fileURLToPath(new URL('../.runtime/qa', import.meta.url))
await mkdir(artifactDirectory, { recursive: true })
const executablePath = process.platform === 'win32'
  ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  : undefined
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const issues = []
let failure

page.on('pageerror', (error) => issues.push(`pageerror: ${error.message}`))
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') issues.push(`${message.type()}: ${message.text()}`)
})
page.on('response', (response) => {
  if (response.status() >= 400) issues.push(`http ${response.status()}: ${response.url()}`)
})

try {
  const created = createWorkspaceProject(createProjectCatalog(), {
    title: '受控工作流 UI 项目', initialModeId: 'balanced', color: 'violet',
  }, { projectId: 'project-custom-ui', documentId: 'document-custom-ui', now: 2_000 })
  await requestJson(bridge, '/api/workspace/catalog', {
    method: 'PUT', body: JSON.stringify({ catalog: created.catalog, baseRevision: 0, source: 'custom-workflow-ui-qa' }),
  })
  const imported = await requestJson(bridge, '/api/workflow-center/custom', {
    method: 'POST',
    body: JSON.stringify({
      title: 'UI 固定图片输出',
      workflow: {
        1: { class_type: 'CLIPTextEncode', inputs: { text: 'original' } },
        2: { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'original' } },
      },
      mappings: { prompt: { nodeId: '1', inputName: 'text' }, output: { nodeId: '2' } },
    }),
  }, 201)
  await requestJson(bridge, `/api/workflow-center/custom/${imported.customWorkflow.id}/enabled`, {
    method: 'POST', body: JSON.stringify({ enabled: true }),
  })

  await page.goto(bridge.baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '打开工作流中心', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: '工作流中心' })
  await dialog.waitFor({ state: 'visible' })
  await dialog.getByRole('tab', { name: '自定义 ComfyUI JSON', exact: true }).click()
  await dialog.getByText('UI 固定图片输出', { exact: true }).waitFor({ state: 'visible' })
  await dialog.getByRole('button', { name: '运行', exact: true }).click()

  const runner = dialog.getByRole('region', { name: '自定义工作流运行面板' })
  await runner.waitFor({ state: 'visible' })
  await runner.getByLabel('所属项目 *').selectOption('project-custom-ui')
  await runner.getByLabel('输出名称 *').fill('UI 受控执行产物')
  await runner.getByLabel('正向提示词 *').fill('complete-output from controlled UI')
  await runner.getByRole('button', { name: '提交统一任务', exact: true }).click()
  const outputLink = runner.getByRole('link', { name: '打开不可变输出', exact: true })
  await outputLink.waitFor({ state: 'visible', timeout: 20_000 })
  await runner.getByText(/completed/u).waitFor({ state: 'visible' })
  assert.equal(await runner.locator('progress').getAttribute('value'), '100')
  const outputHref = await outputLink.getAttribute('href')
  assert.ok(outputHref)
  const outputResponse = await page.context().request.get(new URL(outputHref, bridge.baseUrl).href)
  assert.equal(outputResponse.status(), 200)
  assert.equal(comfy.prompts.size, 1)
  const submitted = [...comfy.prompts.values()][0]
  assert.equal(submitted.workflow['1'].inputs.text, 'complete-output from controlled UI')
  assert.match(submitted.workflow['2'].inputs.filename_prefix, /^AEONQUILL_custom-run-[a-f0-9-]+$/u)
  assert.equal(await page.locator('body').evaluate((body) => body.scrollWidth <= body.clientWidth), true)
  assert.deepEqual(issues, [])
  await page.screenshot({ path: join(artifactDirectory, 'custom-workflow-run-completed.png'), fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await runner.scrollIntoViewIfNeeded()
  assert.equal(await page.locator('body').evaluate((body) => body.scrollWidth <= body.clientWidth), true)
  await page.screenshot({ path: join(artifactDirectory, 'custom-workflow-run-mobile.png'), fullPage: true })
  console.log('✓ Custom workflow UI submitted a controlled job and verified its immutable project output')
} catch (error) {
  failure = error
  await page.screenshot({ path: join(artifactDirectory, 'custom-workflow-ui-failure.png'), fullPage: true }).catch(() => undefined)
  console.error(JSON.stringify({
    url: page.url(),
    issues,
    body: (await page.locator('body').innerText().catch(() => '')).slice(0, 8000),
    artifactDirectory,
    bridgeLogs: bridge.logs(),
  }, null, 2))
} finally {
  await browser.close().catch(() => undefined)
  await bridge.stop({ keepRuntime: Boolean(failure) }).catch(() => undefined)
  await comfy.close().catch(() => undefined)
}

if (failure) throw failure
