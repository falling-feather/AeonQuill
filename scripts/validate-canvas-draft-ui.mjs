import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { chromium } from 'playwright'

import { startIsolatedBridge } from './qa-runtime.mjs'

const artifactDirectory = fileURLToPath(new URL('../.runtime/qa', import.meta.url))
const reportPath = join(artifactDirectory, 'canvas-draft-ui-report.json')
await mkdir(artifactDirectory, { recursive: true })

const executablePath = process.platform === 'win32'
  ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  : undefined
if (executablePath && !existsSync(executablePath)) throw new Error('未找到 Microsoft Edge')

const bridge = await startIsolatedBridge('canvas-draft-ui')
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
})
const context = await browser.newContext({
  acceptDownloads: true,
  viewport: { width: 1440, height: 1000 },
})
const page = await context.newPage()
const issues = []
const checks = []
let failure
let failCanvasWrites = false
let quotaEnabled = false
let delayImport = false
let importSeen
let importGate
let failedPutCount = 0
let projectId
let documentId
const dialogs = []

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

await page.addInitScript(() => {
  const originalSetItem = Storage.prototype.setItem
  Object.defineProperty(window, '__aeonquillQaQuota', {
    configurable: true,
    writable: true,
    value: false,
  })
  Storage.prototype.setItem = function qaSetItem(key, value) {
    if (window.__aeonquillQaQuota && this === window.localStorage) {
      throw new DOMException('Quota exceeded', 'QuotaExceededError')
    }
    return originalSetItem.call(this, key, value)
  }
})

await page.route('**/api/projects/current', async (route) => {
  if (failCanvasWrites && route.request().method() === 'PUT') {
    failedPutCount += 1
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'QA 注入：ProjectStore 暂时不可用' } }),
    })
    return
  }
  await route.continue()
})

await page.route('**/api/projects/import*', async (route) => {
  if (!delayImport) {
    await route.continue()
    return
  }
  importSeen?.resolve()
  await importGate?.promise
  await route.continue()
})

page.on('pageerror', (error) => issues.push('pageerror: ' + error.message))
page.on('dialog', async (dialog) => {
  dialogs.push({ type: dialog.type(), message: dialog.message().slice(0, 240) })
  await dialog.accept()
})
page.on('console', (message) => {
  const injected503 = failCanvasWrites
    && message.type() === 'error'
    && message.text().includes('503')
  if ((message.type() === 'error' || message.type() === 'warning') && !injected503) {
    issues.push(message.type() + ': ' + message.text())
  }
})
page.on('response', (response) => {
  const method = response.request().method()
  const injected = response.status() === 503
    && method === 'PUT'
    && response.url().endsWith('/api/projects/current')
  if (response.status() >= 400 && !injected) issues.push('http ' + response.status() + ': ' + response.url())
})

async function requestJson(pathname, options = {}, expected = 200) {
  const response = await bridge.request(pathname, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  })
  const payload = await response.json()
  assert.equal(response.status, expected, pathname + ': ' + JSON.stringify(payload))
  return payload
}

async function loadCatalog() {
  return (await requestJson('/api/workspace/catalog')).catalog
}

async function loadCanvasDocument() {
  const payload = await requestJson('/api/projects/current?id=' + encodeURIComponent(documentId))
  return payload.project?.document ?? null
}

async function waitUntil(label, predicate, timeout = 15_000) {
  const deadline = Date.now() + timeout
  let lastError
  while (Date.now() < deadline) {
    try {
      const result = await predicate()
      if (result) return result
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(label + '超时' + (lastError instanceof Error ? '：' + lastError.message : ''))
}

async function waitCanvas() {
  await page.locator('.canvas-area[aria-label="无限画布"]').waitFor({ state: 'visible', timeout: 20_000 })
  await page.locator('.canvas-viewport').waitFor({ state: 'visible', timeout: 20_000 })
}

async function waitSaveStatus(text) {
  await page.locator('.save-status').filter({ hasText: text }).waitFor({ state: 'visible', timeout: 12_000 })
}

async function ensureInspectorOpen() {
  const panel = page.locator('.inspector-panel')
  if (!(await panel.isVisible())) await page.getByRole('button', { name: '打开属性面板', exact: true }).click()
  await panel.waitFor({ state: 'visible' })
  return panel
}

function shapeLocator(id) {
  return page.locator('[data-canvas-element][data-element-id="' + id + '"]')
}

async function createProject(title) {
  await page.getByRole('button', { name: '创建新项目', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: '创建新项目' })
  await dialog.getByLabel(/项目名称/u).fill(title)
  await dialog.getByRole('button', { name: '创建并进入', exact: true }).click()
  await waitCanvas()
  const catalog = await waitUntil('项目目录创建', async () => {
    const next = await loadCatalog()
    return next.projects.find((item) => item.title === title) ? next : null
  })
  const project = catalog.projects.find((item) => item.title === title)
  assert.ok(project)
  projectId = project.id
  documentId = project.documents.find((item) => item.modeId === 'balanced').id
}

async function addShape() {
  const viewport = page.locator('.canvas-viewport')
  const box = await viewport.boundingBox()
  assert.ok(box)
  await page.getByRole('button', { name: '形状（S）', exact: true }).click()
  await page.mouse.click(box.x + box.width * 0.35, box.y + box.height * 0.35)
  const shape = page.locator('[data-canvas-element][data-element-kind="shape"]').last()
  await shape.waitFor({ state: 'visible', timeout: 10_000 })
  return shape.getAttribute('data-element-id')
}

async function selectShape(id) {
  const shape = shapeLocator(id)
  await shape.waitFor({ state: 'visible' })
  await shape.click()
}

async function setShapeX(id, value) {
  await selectShape(id)
  const inspector = await ensureInspectorOpen()
  const position = inspector.locator('details.inspector-section').filter({ hasText: '位置与尺寸' })
  await position.locator('label.property-field').nth(0).locator('input').fill(String(value))
}

async function openFirstProject(title) {
  await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
  const catalog = await loadCatalog()
  const project = catalog.projects.find((item) => item.title === title)
  assert.ok(project)
  projectId = project.id
  documentId = project.documents.find((item) => item.modeId === 'balanced').id
  await page.locator('button.aq-project-row-main').filter({ hasText: title }).click()
  await waitCanvas()
}

async function exportFullProjectFromHome(title) {
  await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
  const actionButton = page.getByRole('button', { name: `打开${title}项目操作`, exact: true })
  await actionButton.waitFor({ state: 'visible', timeout: 12_000 })
  await actionButton.click()
  const downloadPromise = page.waitForEvent('download', { timeout: 30_000 })
  await page.getByRole('button', { name: '导出完整项目包', exact: true }).click()
  const download = await downloadPromise
  const packagePath = await download.path()
  assert.ok(packagePath)
  const envelope = JSON.parse(gunzipSync(await readFile(packagePath)).toString('utf8'))
  assert.equal(envelope.magic, 'AEONQUILL_PROJECT_PACKAGE')
  assert.equal(envelope.packageSchemaVersion, 1)
  const payload = envelope.payload
  assert.ok(payload && typeof payload === 'object')
  const registration = payload.project.documents.find((document) => document.id === documentId)
  const documentEntry = payload.documents.find((document) => document.documentId === documentId)
  const balanced = payload.balancedProjects.find((document) => document.documentId === documentId)
  assert.ok(registration)
  assert.ok(documentEntry)
  assert.ok(balanced)
  assert.equal(registration.revision, documentEntry.revision)
  assert.equal(documentEntry.revision, balanced.revision)
  assert.equal(JSON.parse(documentEntry.value).revision, documentEntry.revision)
  assert.equal(balanced.document.revision, balanced.revision)
  assert.equal(issues.some((issue) => issue.includes('SOURCE_CORRUPT')), false)
  return { payload, registration, documentEntry, balanced, bytes: (await readFile(packagePath)).length }
}

async function setFailureMode({ server, browser }) {
  failCanvasWrites = server
  quotaEnabled = browser
  await page.evaluate((value) => { window.__aeonquillQaQuota = value }, browser)
}

try {
  const title = 'QA-007 Canvas Draft'
  await page.goto(bridge.baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
  await createProject(title)
  const shapeId = await addShape()
  assert.ok(shapeId)
  await waitSaveStatus('已保存')
  checks.push('initial project and real canvas element created')

  await setFailureMode({ server: true, browser: true })
  const immediateEditStarted = Date.now()
  await setShapeX(shapeId, 420)
  await page.getByRole('button', { name: '返回光阴砚主页', exact: true }).click()
  const immediateLeaveMs = Date.now() - immediateEditStarted
  await openFirstProject(title)
  const recoveredShape = shapeLocator(shapeId)
  await recoveredShape.waitFor({ state: 'visible', timeout: 12_000 })
  assert.equal(await recoveredShape.evaluate((node) => Number.parseFloat(node.style.left)), 420)
  checks.push('edit followed by immediate leave/reopen retained the session draft')

  await page.getByRole('button', { name: '返回光阴砚主页', exact: true }).click()
  await createProject('QA-007 Other Project')
  await page.getByRole('button', { name: '返回光阴砚主页', exact: true }).click()
  await openFirstProject(title)
  assert.equal(await shapeLocator(shapeId).count(), 1)
  checks.push('switching to another project and returning retained the original draft')

  await setShapeX(shapeId, 470)
  await waitSaveStatus('保存失败')
  assert.ok(failedPutCount > 0)
  checks.push('localStorage quota plus PUT 503 showed 保存失败 · 草稿保留')

  await setFailureMode({ server: false, browser: false })
  await page.getByRole('button', { name: '重试保存', exact: true }).click()
  await waitSaveStatus('已保存')
  const persistedAfterRetry = await waitUntil('重试保存写入 SQLite', async () => {
    const document = await loadCanvasDocument()
    return document?.elements.some((element) => element.id === shapeId && element.x === 470) ? document : null
  })
  assert.ok(persistedAfterRetry.revision > 0)
  checks.push('retry saved the retained draft to SQLite')

  await setFailureMode({ server: true, browser: false })
  await setShapeX(shapeId, 520)
  await waitSaveStatus('仅浏览器草稿')
  checks.push('SQLite failure with working localStorage showed 仅浏览器草稿')
  await setFailureMode({ server: false, browser: false })
  await page.getByRole('button', { name: '重试保存', exact: true }).click()
  await waitSaveStatus('已保存')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitCanvas()
  const afterReload = await loadCanvasDocument()
  assert.equal(afterReload.elements.find((element) => element.id === shapeId)?.x, 520)
  checks.push('successful retry and reload restored the SQLite document')

  await setShapeX(shapeId, 605)
  await page.getByRole('button', { name: '返回光阴砚主页', exact: true }).click()
  const immediateFullExport = await exportFullProjectFromHome(title)
  const immediateFullExportElement = immediateFullExport.balanced.document.elements.find((element) => element.id === shapeId)
  assert.equal(immediateFullExportElement?.x, 605)
  assert.equal(immediateFullExport.registration.revision, immediateFullExport.balanced.revision)
  checks.push('edit followed by immediate Home navigation exported a complete package with the new element and matching catalog/document revisions')

  await openFirstProject(title)
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出画布', exact: true }).click()
  const download = await downloadPromise
  const packagePath = await download.path()
  assert.ok(packagePath)

  importSeen = deferred()
  importGate = deferred()
  delayImport = true
  const importInput = page.locator('input[type="file"][accept*=".miaohui"]')
  await importInput.setInputFiles(packagePath)
  await importSeen.promise
  await setShapeX(shapeId, 575)
  importGate.resolve()
  await page.getByText(/导入期间出现了新编辑，已保留较新草稿/u).waitFor({ state: 'visible', timeout: 15_000 })
  await waitSaveStatus('已保存')
  const afterConcurrentImport = await waitUntil('并发编辑保存', async () => {
    const document = await loadCanvasDocument()
    return document?.elements.find((element) => element.id === shapeId)?.x === 575 ? document : null
  })
  assert.ok(afterConcurrentImport.revision > persistedAfterRetry.revision)
  checks.push('import delayed behind a concurrent edit and preserved the newer revision')

  delayImport = false
  await importInput.setInputFiles(packagePath)
  await page.getByText('均衡画布兼容包已校验并导入').waitFor({ state: 'visible', timeout: 15_000 })
  await page.getByRole('button', { name: '返回光阴砚主页', exact: true }).click()
  const postCompatImportFullExport = await exportFullProjectFromHome(title)
  const postCompatImportElement = postCompatImportFullExport.balanced.document.elements.find((element) => element.id === shapeId)
  assert.equal(postCompatImportElement?.x, 605)
  assert.equal(postCompatImportFullExport.registration.revision, postCompatImportFullExport.balanced.revision)
  checks.push('compatibility import followed by immediate Home navigation exported a complete package with matching catalog/document revisions')

  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.locator('body').evaluate((body) => body.scrollWidth <= body.clientWidth), true)
  await page.screenshot({ path: join(artifactDirectory, 'canvas-draft-ui-mobile.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.screenshot({ path: join(artifactDirectory, 'canvas-draft-ui-desktop.png'), fullPage: true })
  checks.push('1440/390 layouts had no horizontal overflow')
  assert.deepEqual(issues, [])
  console.log('✓ Canvas draft UI persistence, failure recovery, project switching, reload, package ordering, and responsive checks passed')
  var report = {
    schemaVersion: 1,
    status: 'passed',
    immediateLeaveMs,
    failedPutCount,
    fullExportRevisions: [immediateFullExport.balanced.revision, postCompatImportFullExport.balanced.revision],
    dialogCount: dialogs.length,
    checks,
    issues,
    artifacts: [
      '.runtime/qa/canvas-draft-ui-desktop.png',
      '.runtime/qa/canvas-draft-ui-mobile.png',
    ],
    noGpu: true,
  }
} catch (error) {
  failure = error
  await page.screenshot({ path: join(artifactDirectory, 'canvas-draft-ui-failure.png'), fullPage: true }).catch(() => undefined)
  console.error(JSON.stringify({
    url: page.url(),
    issues,
    failedPutCount,
    body: (await page.locator('body').innerText().catch(() => '')).slice(0, 10_000),
    bridgeLogs: bridge.logs(),
  }, null, 2))
  var report = {
    schemaVersion: 1,
    status: 'failed',
    failedPutCount,
    checks,
    issues,
    error: error instanceof Error ? error.message : String(error),
    artifacts: ['.runtime/qa/canvas-draft-ui-failure.png'],
    noGpu: true,
  }
} finally {
  await context.close().catch(() => undefined)
  await browser.close().catch(() => undefined)
  await bridge.stop({ keepRuntime: Boolean(failure) }).catch(() => undefined)
}

await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8')
if (failure) throw failure
