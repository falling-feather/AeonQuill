import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
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

const h3Workflow = JSON.parse(await readFile(new URL('../server/workflows/minimax-h3-t2v.json', import.meta.url), 'utf8'))
const h3ObjectInfo = {}
for (const node of Object.values(h3Workflow)) {
  const required = h3ObjectInfo[node.class_type]?.input.required ?? {}
  for (const [key, value] of Object.entries(node.inputs)) {
    if (typeof value === 'string' && value.endsWith('.safetensors')) {
      const values = required[key]?.[0] ?? []
      required[key] = [[...new Set([...values, value])], {}]
    } else required[key] = [typeof value === 'number' ? 'INT' : typeof value === 'boolean' ? 'BOOLEAN' : 'STRING', {}]
  }
  h3ObjectInfo[node.class_type] = { input: { required } }
}
const comfy = await startFakeComfyRuntime({ objectInfo: {
  ...h3ObjectInfo,
  CLIPTextEncode: { input: { required: { text: ['STRING', {}] } } },
  SaveImage: { input: { required: {} } },
  EmptyLatentImage: { input: { required: { width: ['INT', { min: 64, max: 8192 }], height: ['INT', { min: 64, max: 8192 }], batch_size: ['INT', {}] } } },
} })
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
        3: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
      },
      mappings: { prompt: { nodeId: '1', inputName: 'text' }, output: { nodeId: '2' }, width: { nodeId: '3', inputName: 'width' } },
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
  assert.equal(await dialog.getByRole('tab', { name: '创作任务', exact: true }).getAttribute('aria-selected'), 'true')
  await dialog.getByRole('button', { name: /UI 固定图片输出/u }).click()

  const runner = dialog.getByRole('region', { name: '自定义工作流运行面板' })
  await runner.waitFor({ state: 'visible' })
  await runner.getByLabel('宽度', { exact: true }).fill('768')
  await runner.getByLabel('配方名称', { exact: true }).fill('本机 768 配方')
  await runner.getByRole('button', { name: '保存配方', exact: true }).click()
  await dialog.getByText(/配方已保存/u).waitFor({ state: 'visible' })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '打开工作流中心', exact: true }).first().click()
  await dialog.getByRole('tab', { name: /我的配方/u }).click()
  await dialog.getByRole('heading', { name: '本机 768 配方', exact: true }).waitFor({ state: 'visible' })
  await dialog.getByRole('button', { name: '应用配方', exact: true }).click()
  await runner.waitFor({ state: 'visible' })
  assert.equal(await runner.getByLabel('宽度', { exact: true }).inputValue(), '768')
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
  assert.equal(submitted.workflow['3'].inputs.width, 768)
  assert.match(submitted.workflow['2'].inputs.filename_prefix, /^AEONQUILL_custom-run-[a-f0-9-]+$/u)
  assert.equal(await page.locator('body').evaluate((body) => body.scrollWidth <= body.clientWidth), true)
  assert.deepEqual(issues, [])
  await page.screenshot({ path: join(artifactDirectory, 'custom-workflow-run-completed.png'), fullPage: true })

  const queuedResponse = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/api/jobs/custom-workflow'))
  await runner.getByLabel('正向提示词 *').fill('complete-output second candidate')
  await runner.getByRole('button', { name: '提交统一任务', exact: true }).click()
  const second = await (await queuedResponse).json()
  await runner.getByText(`${second.job.id} · completed`, { exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
  const candidates = runner.getByRole('region', { name: '工作流候选比较' })
  await candidates.getByRole('button', { name: '滑杆对比', exact: true }).click()
  const slider = candidates.getByRole('slider', { name: '对比位置', exact: true })
  await slider.focus()
  await slider.press('Home')
  await slider.press('ArrowRight')
  assert.equal(await slider.inputValue(), '1')
  assert.equal(comfy.prompts.size, 2)
  await page.screenshot({ path: join(artifactDirectory, 'workflow-recipes-candidates-desktop.png'), fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await runner.scrollIntoViewIfNeeded()
  assert.equal(await page.locator('body').evaluate((body) => body.scrollWidth <= body.clientWidth), true)
  await page.screenshot({ path: join(artifactDirectory, 'custom-workflow-run-mobile.png'), fullPage: true })
  assert.deepEqual(issues, [])

  // Real app/API round-trip; the Comfy node catalog is a fixture. This does not
  // execute H3 or claim physical model verification or generation quality.
  const h3Imported = await requestJson(bridge, '/api/workflow-center/custom', {
    method: 'POST', body: JSON.stringify({ title: 'UI H3 固定权重', workflow: h3Workflow,
      mappings: { prompt: { nodeId: '6', inputName: 'prompt' }, output: { nodeId: '15' } } }),
  }, 201)
  await requestJson(bridge, `/api/workflow-center/custom/${h3Imported.customWorkflow.id}/enabled`, {
    method: 'POST', body: JSON.stringify({ enabled: true }),
  })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '打开工作流中心', exact: true }).first().click()
  await dialog.getByRole('button', { name: /UI H3 固定权重/u }).click()
  const weights = runner.getByLabel('固定模型配方', { exact: true })
  await weights.locator('summary').click()
  assert.equal(await weights.locator('li').count(), 5)
  await weights.getByText(/Turbo 加速 LoRA/u).waitFor({ state: 'visible' })
  await runner.getByLabel('配方名称', { exact: true }).fill('H3 加速登记配方')
  await runner.getByRole('button', { name: '保存配方', exact: true }).click()
  await dialog.getByText(/配方已保存/u).waitFor({ state: 'visible' })
  const saved = (await requestJson(bridge, '/api/workflow-center/recipes')).recipes.find(({ name }) => name === 'H3 加速登记配方')
  assert.deepEqual(saved.weightSet, h3Imported.customWorkflow.weightSet)
  assert.equal(saved.weightSet.artifacts.at(-1).role, 'acceleration-lora')
  await page.screenshot({ path: join(artifactDirectory, 'workflow-fixed-weights-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await weights.scrollIntoViewIfNeeded()
  assert.equal(await page.locator('body').evaluate((body) => body.scrollWidth <= body.clientWidth), true)
  await page.screenshot({ path: join(artifactDirectory, 'workflow-fixed-weights-mobile.png'), fullPage: true })
  assert.equal(comfy.prompts.size, 2, 'Registering a weight recipe must not generate media')
  assert.deepEqual(issues, [])
  console.log('✓ Workflow recipes/candidates and fixed H3 weight identity passed in desktop and narrow layouts; model quality is not assessed')
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
