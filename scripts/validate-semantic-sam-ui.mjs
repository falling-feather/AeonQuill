import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

import { createCanvasDocument } from '../src/lib/canvasCore.mjs'
import { createProjectCatalog, createWorkspaceProject } from '../src/lib/project/projectCatalog.mjs'
import { evaluateSemanticWorkflowCatalog, semanticWorkflowDefinitions } from '../server/semantic-workflow-registry.mjs'
import { startIsolatedBridge } from './qa-runtime.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const reportPath = resolve(projectRoot, '.runtime', 'qa', 'semantic-sam-ui.json')
const projectId = 'semantic-sam-ui-project'
const documentId = 'semantic-sam-ui-document'
const title = 'SEMANTIC-SAM UI 请求契约'
const sourcePath = resolve(projectRoot, 'src', 'assets', 'sample-summer-character.png')

function dataUrl(bytes, mime = 'image/png') {
  return `data:${mime};base64,${bytes.toString('base64')}`
}

async function requestJson(bridge, pathname, options = {}, expectedStatus = 200) {
  const response = await bridge.request(pathname, {
    ...options,
    headers: options.body ? { 'content-type': 'application/json', ...options.headers } : options.headers,
  })
  const payload = await response.json().catch(() => ({}))
  assert.equal(response.status, expectedStatus, `${options.method || 'GET'} ${pathname}: ${JSON.stringify(payload)}`)
  return payload
}

function semanticFixtureCatalog() {
  const definitions = semanticWorkflowDefinitions()
  return evaluateSemanticWorkflowCatalog({
    extensions: new Set(definitions.flatMap(({ requiredExtensions }) => requiredExtensions)),
    artifacts: new Set(definitions.flatMap(({ requiredArtifacts }) => requiredArtifacts)),
    objectInfo: Object.fromEntries(definitions.flatMap(({ requiredNodes }) => requiredNodes).map((node) => [node, {}])),
    runtime: { connected: true, lifecycle: { state: 'external' }, device: 'fixture', vramTotal: 8 * 1024 ** 3 },
  })
}

function imageElement({ id, name, src, assetId, assetVersionId }) {
  return {
    id, kind: 'image', name,
    x: id.endsWith('managed') ? 80 : 680, y: 80, width: 480, height: 480,
    rotation: 0, opacity: 1, radius: 8, fill: '#ffffff', stroke: '#d5d8df', strokeWidth: 1,
    src, sourceSrc: src, naturalWidth: 1256, naturalHeight: 1256,
    ...(assetId ? { assetId, assetVersion: 1, assetVersionId } : {}),
    adjustments: { brightness: 100, contrast: 100, saturation: 100 },
    processingStack: [], locked: false, visible: true, zIndex: id.endsWith('managed') ? 1 : 2,
  }
}

async function clickSemanticPoints(dialog) {
  const surface = dialog.getByRole('application', { name: /点击以选择要提取/u })
  await surface.click({ position: { x: 220, y: 220 } })
  await dialog.getByRole('button', { name: '排除背景', exact: true }).click()
  await surface.click({ position: { x: 28, y: 28 } })
  await dialog.getByText('元素点 1', { exact: true }).waitFor({ state: 'visible' })
  await dialog.getByText('排除点 1', { exact: true }).waitFor({ state: 'visible' })
}

async function openElementLab(page, imageName) {
  const layers = page.getByRole('tab', { name: '图层', exact: true })
  await layers.click()
  await page.getByRole('button', { name: imageName, exact: true }).click().catch(async () => {
    await page.locator('.layer-row').filter({ hasText: imageName }).click()
  })
  await page.getByRole('tab', { name: '编辑', exact: true }).click()
  const inspector = page.getByRole('complementary', { name: '属性与任务面板' })
  await inspector.getByRole('button', { name: '元素提取', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '图像处理实验室' })
  await dialog.waitFor({ state: 'visible', timeout: 15_000 })
  await dialog.getByRole('tab', { name: '元素提取', exact: true }).click()
  return dialog
}

const report = {
  schemaVersion: 1,
  kind: 'aeonquill.qa.semantic-sam-ui',
  status: 'failed',
  generatedAt: new Date().toISOString(),
  scope: 'Browser request contract only; semantic Job endpoint is captured and rejected before GPU/model execution.',
  project: { projectId, documentId, title },
  requests: [],
  checks: [],
  issues: [],
}
let bridge
let browser
let page
let failure = null

try {
  const sourceBytes = await readFile(sourcePath)
  const sourceDataUrl = dataUrl(sourceBytes)
  const created = createWorkspaceProject(createProjectCatalog(), {
    title, initialModeId: 'balanced', color: 'violet',
  }, { projectId, documentId, now: Date.now() - 30_000 })
  bridge = await startIsolatedBridge('semantic-sam-ui')
  await requestJson(bridge, '/api/workspace/catalog', {
    method: 'PUT',
    body: JSON.stringify({ catalog: created.catalog, baseRevision: 0, source: 'semantic-sam-ui' }),
  })
  const sourceAsset = await requestJson(bridge, '/api/library/assets', {
    method: 'POST',
    body: JSON.stringify({
      scope: 'project', projectId, title: 'SAM 受管输入', description: 'UI request contract fixture',
      tags: ['qa', 'semantic-sam'], collectionIds: [], dataUrl: sourceDataUrl,
    }),
  }, 201)
  const managedSrc = `/api/project-assets/${sourceAsset.asset.version.assetId}`
  const canvas = createCanvasDocument({
    id: documentId,
    title,
    now: Date.now() - 20_000,
    camera: { x: 0, y: 0, zoom: 1 },
    elements: [
      imageElement({ id: 'sam-image-managed', name: 'SAM 受管图片', src: managedSrc, assetId: sourceAsset.asset.version.assetId, assetVersionId: sourceAsset.asset.version.id }),
      imageElement({ id: 'sam-image-upload', name: 'SAM 裸上传图片', src: sourceDataUrl }),
    ],
  })
  await requestJson(bridge, '/api/workspace/documents/initialize', {
    method: 'POST',
    body: JSON.stringify({
      catalog: created.catalog,
      baseRevision: 0,
      document: { projectId, documentId, modeId: 'balanced', revision: 0, value: JSON.stringify(canvas) },
      source: 'semantic-sam-ui',
    }),
  }, 201)

  const catalog = semanticFixtureCatalog()
  const captured = []
  const issues = report.issues
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) })
  page = await browser.newPage({ viewport: { width: 1440, height: 980 } })
  page.on('pageerror', (error) => issues.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if ((message.type() === 'error' || message.type() === 'warning') && !message.text().includes('Failed to load resource')) issues.push(`${message.type()}: ${message.text()}`)
  })
  await page.route('**/api/semantic-workflows*', async (route) => route.fulfill({ status: 200, json: catalog }))
  await page.route('**/api/image-tools*', async (route) => route.fulfill({
    status: 200,
    json: { version: 'qa', checkedAt: Date.now(), operations: [] },
  }))
  await page.route('**/api/jobs/semantic-image', async (route) => {
    captured.push(route.request().postDataJSON())
    await route.fulfill({
      status: 409,
      json: { error: { code: 'QA_CAPTURE', message: 'SAM UI 请求已采集；本轮不执行真实 Job。' } },
    })
  })
  await page.goto(bridge.baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.locator('.aq-project-row-main').filter({ hasText: title }).click()
  await page.getByLabel('无限画布').waitFor({ state: 'visible', timeout: 15_000 })

  let dialog = await openElementLab(page, 'SAM 受管图片')
  await clickSemanticPoints(dialog)
  await dialog.getByRole('button', { name: '提交正式处理', exact: true }).click()
  await dialog.locator('.image-lab-error').waitFor({ state: 'visible', timeout: 10_000 })
  assert.equal(captured.length, 1)
  const managedRequest = captured[0]
  assert.equal(managedRequest.workflowId, 'element-extract')
  assert.equal(managedRequest.projectId, projectId)
  assert.equal(managedRequest.sourceAssetId, sourceAsset.asset.version.assetId)
  assert.equal('sourceImageDataUrl' in managedRequest, false)
  assert.equal(managedRequest.sourceElementId, 'sam-image-managed')
  assert.equal(managedRequest.params.positivePoints.length, 1)
  assert.equal(managedRequest.params.negativePoints.length, 1)
  report.requests.push({
    kind: 'managed-source',
    workflowId: managedRequest.workflowId,
    projectId: managedRequest.projectId,
    sourceAssetId: managedRequest.sourceAssetId,
    hasSourceImageDataUrl: 'sourceImageDataUrl' in managedRequest,
    sourceElementId: managedRequest.sourceElementId,
    positivePoints: managedRequest.params.positivePoints,
    negativePoints: managedRequest.params.negativePoints,
  })
  report.checks.push('managed image sends projectId + sourceAssetId, omits duplicate dataURL, and preserves sourceElementId')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })

  dialog = await openElementLab(page, 'SAM 裸上传图片')
  await clickSemanticPoints(dialog)
  await dialog.getByRole('button', { name: '提交正式处理', exact: true }).click()
  await dialog.locator('.image-lab-error').waitFor({ state: 'visible', timeout: 10_000 })
  assert.equal(captured.length, 2)
  const uploadRequest = captured[1]
  assert.equal(uploadRequest.workflowId, 'element-extract')
  assert.equal(uploadRequest.projectId, projectId)
  assert.equal(typeof uploadRequest.sourceImageDataUrl, 'string')
  assert.match(uploadRequest.sourceImageDataUrl, /^data:image\/png;base64,/u)
  assert.equal('sourceAssetId' in uploadRequest, false)
  assert.equal(uploadRequest.sourceElementId, 'sam-image-upload')
  assert.equal(uploadRequest.params.positivePoints.length, 1)
  assert.equal(uploadRequest.params.negativePoints.length, 1)
  report.requests.push({
    kind: 'bare-data-url',
    workflowId: uploadRequest.workflowId,
    projectId: uploadRequest.projectId,
    hasSourceImageDataUrl: true,
    sourceImageDataUrlBytes: Buffer.byteLength(uploadRequest.sourceImageDataUrl, 'utf8'),
    hasSourceAssetId: 'sourceAssetId' in uploadRequest,
    sourceElementId: uploadRequest.sourceElementId,
    positivePoints: uploadRequest.params.positivePoints,
    negativePoints: uploadRequest.params.negativePoints,
  })
  report.checks.push('bare dataURL still sends projectId, preserves sourceElementId, and omits sourceAssetId')
  report.checks.push('positive and negative points were created through real ImageLab pointer clicks')
  assert.deepEqual(report.issues, [])
  report.status = 'passed'
  console.log('✓ SAM ImageLab managed/upload request contracts passed without model execution')
} catch (error) {
  failure = error
  report.error = { name: error?.name, code: error?.code, message: error?.message, stack: error?.stack }
  report.issues = report.issues
} finally {
  report.generatedAt = new Date().toISOString()
  await mkdir(resolve(projectRoot, '.runtime', 'qa'), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await page?.close().catch(() => undefined)
  await browser?.close().catch(() => undefined)
  await bridge?.stop({ keepRuntime: false }).catch(() => undefined)
}

if (failure) throw failure
