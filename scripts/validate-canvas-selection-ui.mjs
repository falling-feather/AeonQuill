import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

import { elementWorldBounds } from '../src/lib/canvasSpatialIndex.mjs'
import { startIsolatedBridge } from './qa-runtime.mjs'

const artifactDirectory = fileURLToPath(new URL('../.runtime/qa', import.meta.url))
await mkdir(artifactDirectory, { recursive: true })

const executablePath = process.platform === 'win32'
  ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  : undefined
if (executablePath && !existsSync(executablePath)) {
  throw new Error('未找到 Microsoft Edge：' + executablePath)
}

const bridge = await startIsolatedBridge('canvas-selection-ui')
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
let failure

page.on('pageerror', (error) => issues.push('pageerror: ' + error.message))
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') {
    issues.push(message.type() + ': ' + message.text())
  }
})
page.on('response', (response) => {
  if (response.status() >= 400) issues.push('http ' + response.status() + ': ' + response.url())
})

function delay(duration) {
  return new Promise((resolve) => setTimeout(resolve, duration))
}

async function requestJson(pathname, options = {}, expected = 200) {
  const response = await bridge.request(pathname, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  })
  const payload = await response.json()
  assert.equal(response.status, expected, (options.method || 'GET') + ' ' + pathname + ': ' + JSON.stringify(payload))
  return payload
}

async function loadCatalog() {
  const payload = await requestJson('/api/workspace/catalog')
  return payload.catalog
}

async function loadCanvasDocument(documentId) {
  const payload = await requestJson('/api/projects/current?id=' + encodeURIComponent(documentId))
  assert.ok(payload.project, '均衡画布项目正文应已保存')
  return payload.project.document
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
    await delay(120)
  }
  throw new Error(label + '超时' + (lastError instanceof Error ? '：' + lastError.message : ''))
}

async function waitForDocument(documentId, predicate, label = '均衡文档保存') {
  return waitUntil(label, async () => {
    const document = await loadCanvasDocument(documentId)
    return predicate(document) ? document : null
  })
}

async function waitForCanvas() {
  await page.locator('.canvas-area[aria-label="无限画布"]').waitFor({ state: 'visible', timeout: 20_000 })
  await page.locator('.canvas-viewport').waitFor({ state: 'visible', timeout: 20_000 })
}

function elementSignature(document) {
  return document.elements.map((element) => ({
    id: element.id,
    kind: element.kind,
    name: element.name,
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
    rotation: element.rotation,
    opacity: element.opacity,
    radius: element.radius,
    fill: element.fill,
    stroke: element.stroke,
    strokeWidth: element.strokeWidth,
    fromId: element.fromId,
    toId: element.toId,
    locked: element.locked,
    visible: element.visible,
    zIndex: element.zIndex,
  }))
}

function shapeLocator(id) {
  return page.locator('[data-canvas-element][data-element-id="' + id + '"]')
}

async function shapeIds() {
  return page.locator('[data-canvas-element][data-element-kind="shape"]').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-element-id')).filter(Boolean))
}

async function ensureInspectorOpen() {
  const panel = page.locator('.inspector-panel')
  if (!(await panel.isVisible())) {
    await page.getByRole('button', { name: '打开属性面板', exact: true }).click()
  }
  await panel.waitFor({ state: 'visible' })
  return panel
}

async function clickShape(id, modifiers = []) {
  const shape = shapeLocator(id)
  await shape.waitFor({ state: 'visible' })
  await shape.click({ modifiers })
}

async function clearSelection() {
  const box = await page.locator('.canvas-viewport').boundingBox()
  assert.ok(box)
  await page.mouse.click(box.x + box.width - 24, box.y + 28)
}

async function selectOnly(id) {
  await clearSelection()
  await clickShape(id)
}

function assertVisualLeftAligned(shapes, ids) {
  const selected = ids.map((id) => shapes.find((shape) => shape.id === id))
  assert.equal(selected.some((shape) => !shape), false, '对齐后的两个元件仍应渲染')
  const bounds = selected.map((shape) => elementWorldBounds(shape))
  assert.ok(Math.abs(bounds[0].left - bounds[1].left) < 1e-6, '两个选中元件的旋转视觉左边界应相同')
}

async function openConnectionDialog(sourceId) {
  await selectOnly(sourceId)
  const toolbar = page.locator('.selection-toolbar')
  await toolbar.getByRole('button', { name: '创建连接', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '创建画布连接' })
  await dialog.waitFor({ state: 'visible' })
  return dialog
}

async function createConnection(sourceId, targetId) {
  const dialog = await openConnectionDialog(sourceId)
  await dialog.getByLabel('连接起点', { exact: true }).selectOption(sourceId)
  await dialog.getByLabel('连接终点', { exact: true }).selectOption(targetId)
  await dialog.getByRole('button', { name: '创建连接', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await page.locator('g[role="button"][aria-label^="连接 "]').first().waitFor({ state: 'visible' })
}

async function connectorPath() {
  const connector = page.locator('g[role="button"][aria-label^="连接 "]').first()
  await connector.waitFor({ state: 'visible' })
  return connector.locator('path').nth(1).getAttribute('d')
}

async function assertNoHorizontalOverflow() {
  assert.equal(
    await page.locator('body').evaluate((body) => body.scrollWidth <= body.clientWidth),
    true,
    '当前视口不应出现横向溢出',
  )
}

try {
  const projectTitle = 'FE-005 画布选择 UI'
  await page.goto(bridge.baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
  const createButton = page.getByRole('button', { name: '创建新项目', exact: true }).first()
  await createButton.waitFor({ state: 'visible' })
  await waitUntil('项目目录同步', async () => createButton.isEnabled())
  await createButton.click()
  const createDialog = page.getByRole('dialog', { name: '创建新项目' })
  await createDialog.getByLabel(/项目名称/u).fill(projectTitle)
  await createDialog.getByRole('button', { name: '创建并进入', exact: true }).click()
  await waitForCanvas()

  const catalog = await waitUntil('项目创建保存', async () => {
    const next = await loadCatalog()
    return next.projects.find((project) => project.title === projectTitle) ? next : null
  })
  const project = catalog.projects.find((candidate) => candidate.title === projectTitle)
  assert.ok(project)
  const balancedRegistration = project.documents.find((document) => document.modeId === 'balanced')
  assert.ok(balancedRegistration)
  const documentId = balancedRegistration.id

  const viewport = page.locator('.canvas-viewport')
  const viewportBox = await viewport.boundingBox()
  assert.ok(viewportBox)
  const createPoints = [
    { x: viewportBox.x + viewportBox.width * 0.2, y: viewportBox.y + viewportBox.height * 0.22 },
    { x: viewportBox.x + viewportBox.width * 0.5, y: viewportBox.y + viewportBox.height * 0.45 },
    { x: viewportBox.x + viewportBox.width * 0.78, y: viewportBox.y + viewportBox.height * 0.66 },
  ]
  for (const point of createPoints) {
    await page.getByRole('button', { name: '形状（S）', exact: true }).click()
    await page.mouse.click(point.x, point.y)
    await page.locator('[data-canvas-element][data-canvas-element][data-element-kind="shape"]').nth(
      (await shapeIds()).length - 1,
    ).waitFor({ state: 'visible' })
  }
  const createdShapeIds = await shapeIds()
  assert.equal(createdShapeIds.length, 3, '应通过真实画布操作创建三个普通元件')
  const firstShapeId = createdShapeIds[0]
  const secondShapeId = createdShapeIds[1]
  const thirdShapeId = createdShapeIds[2]

  await selectOnly(firstShapeId)
  await page.locator('.rotation-row input').fill('28')
  const beforeAlign = await waitForDocument(
    documentId,
    (document) => document.elements.find((element) => element.id === firstShapeId)?.rotation === 28,
    '旋转保存',
  )
  await selectOnly(firstShapeId)
  await clickShape(secondShapeId, ['Shift'])
  const leftAlign = page.getByRole('button', { name: '左对齐所选', exact: true })
  await leftAlign.waitFor({ state: 'visible' })
  assert.equal(await leftAlign.isDisabled(), false)
  const alignRevision = beforeAlign.revision
  await leftAlign.click()
  const afterAlign = await waitForDocument(
    documentId,
    (document) => document.revision === alignRevision + 1
      && document.elements.find((element) => element.id === firstShapeId)?.rotation === 28,
    '多选对齐单revision保存',
  )
  assertVisualLeftAligned(afterAlign.elements, [firstShapeId, secondShapeId])

  await page.getByRole('button', { name: '撤销', exact: true }).click()
  const afterUndo = await waitForDocument(
    documentId,
    (document) => document.revision === afterAlign.revision + 1,
    '对齐撤销单revision保存',
  )
  assert.deepEqual(afterUndo.elements, beforeAlign.elements, '一次撤销应完整恢复多选对齐前的元件')
  await page.getByRole('button', { name: '重做', exact: true }).click()
  const afterRedo = await waitForDocument(
    documentId,
    (document) => document.revision === afterUndo.revision + 1,
    '对齐重做单revision保存',
  )
  assert.deepEqual(afterRedo.elements, afterAlign.elements, '一次重做应完整恢复多选对齐后的元件')

  await selectOnly(firstShapeId)
  await page.locator('.selection-toolbar').getByRole('button', { name: '锁定', exact: true }).click()
  await selectOnly(firstShapeId)
  await clickShape(secondShapeId, ['Shift'])
  assert.equal(await leftAlign.isDisabled(), true, '锁定与未锁定混选时对齐按钮应禁用')
  await selectOnly(firstShapeId)
  await page.locator('.selection-toolbar').getByRole('button', { name: '解锁', exact: true }).click()

  await createConnection(firstShapeId, secondShapeId)
  const connectionSelector = 'g[role="button"][aria-label^="连接 "]'
  assert.equal(await page.locator(connectionSelector).count(), 1)
  const connectedDocument = await waitForDocument(
    documentId,
    (document) => document.elements.some((element) =>
      element.kind === 'connector' && element.fromId === firstShapeId && element.toId === secondShapeId),
    '连接创建保存',
  )
  const initialConnector = connectedDocument.elements.find((element) => element.kind === 'connector')
  assert.ok(initialConnector)
  assert.equal(initialConnector.stroke, '#6558d9')
  assert.equal(initialConnector.strokeWidth, 2)
  assert.equal(initialConnector.locked, false)

  const duplicateDialog = await openConnectionDialog(firstShapeId)
  await duplicateDialog.getByLabel('连接起点', { exact: true }).selectOption(firstShapeId)
  await duplicateDialog.getByLabel('连接终点', { exact: true }).selectOption(secondShapeId)
  await duplicateDialog.getByRole('button', { name: '创建连接', exact: true }).click()
  await duplicateDialog.getByRole('alert').getByText(/同向连接已经存在/u).waitFor({ state: 'visible' })
  assert.equal(await page.locator(connectionSelector).count(), 1, '同向重复连接不应新增')
  await duplicateDialog.getByRole('button', { name: '取消', exact: true }).click()

  const selfDialog = await openConnectionDialog(firstShapeId)
  const selfTarget = selfDialog.getByLabel('连接终点', { exact: true })
  assert.equal(await selfTarget.locator('option[value="' + firstShapeId + '"]').count(), 0, '终点候选不应允许自连')
  await selfDialog.getByLabel('连接起点', { exact: true }).selectOption(secondShapeId)
  assert.equal(await selfTarget.locator('option[value="' + secondShapeId + '"]').count(), 0, '交换起点后仍不应允许自连')
  await selfDialog.getByRole('button', { name: '取消', exact: true }).click()

  await page.locator(connectionSelector).first().click()
  const inspector = await ensureInspectorOpen()
  const relation = inspector.getByRole('region', { name: '连接关系', exact: true })
  await relation.waitFor({ state: 'visible' })
  const swappedRevision = connectedDocument.revision
  await relation.getByRole('button', { name: '交换连接方向', exact: true }).click()
  const swapped = await waitForDocument(
    documentId,
    (document) => document.revision === swappedRevision + 1
      && document.elements.some((element) =>
        element.kind === 'connector' && element.fromId === secondShapeId && element.toId === firstShapeId),
    '连接方向交换保存',
  )
  assert.ok(swapped)
  await relation.getByRole('button', { name: '锁定连接', exact: true }).click()
  await relation.getByRole('button', { name: '解锁连接', exact: true }).waitFor({ state: 'visible' })
  assert.equal(await relation.getByRole('button', { name: '删除连接', exact: true }).isDisabled(), true)
  await relation.getByRole('button', { name: '解锁连接', exact: true }).click()
  await relation.getByRole('button', { name: '删除连接', exact: true }).click()
  await waitUntil('连接删除', async () => (await page.locator(connectionSelector).count()) === 0)

  await createConnection(firstShapeId, secondShapeId)
  const pathBeforeMove = await connectorPath()
  const sourceDocument = await loadCanvasDocument(documentId)
  const sourceBeforeMove = sourceDocument.elements.find((element) => element.id === firstShapeId)
  assert.ok(sourceBeforeMove)
  await selectOnly(firstShapeId)
  const positionDetails = page.locator('details.inspector-section').filter({ hasText: '位置与尺寸' })
  await positionDetails.locator('label.property-field').nth(0).locator('input').fill(
    String(Math.round(sourceBeforeMove.x + 60)),
  )
  await page.locator('.rotation-row input').fill('33')
  await waitForDocument(
    documentId,
    (document) => {
      const source = document.elements.find((element) => element.id === firstShapeId)
      return source?.rotation === 33 && source.x === Math.round(sourceBeforeMove.x + 60)
    },
    '端点位置旋转保存',
  )
  const pathAfterMove = await waitUntil('连接端口跟随位置旋转', async () => {
    const current = await connectorPath()
    return current && current !== pathBeforeMove ? current : null
  })
  assert.notEqual(pathAfterMove, pathBeforeMove)

  const imageBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  )
  await page.locator('input[type="file"][accept="image/*"]').setInputFiles({
    name: 'canvas-selection-fixture.png',
    mimeType: 'image/png',
    buffer: imageBytes,
  })
  const imageNode = page.locator('[data-canvas-element][data-element-kind="image"]').last()
  await imageNode.waitFor({ state: 'visible', timeout: 10_000 })
  await imageNode.click()
  await ensureInspectorOpen()
  await page.getByRole('button', { name: '全部工具', exact: true }).click()
  const imageLab = page.getByRole('dialog', { name: '图像处理实验室' })
  await imageLab.waitFor({ state: 'visible', timeout: 10_000 })
  assert.equal(await imageLab.getByRole('heading', { name: '图像处理实验室', exact: true }).isVisible(), true)
  await imageLab.getByRole('button', { name: '关闭图像处理实验室', exact: true }).click()
  await imageLab.waitFor({ state: 'hidden' })

  const persistedBeforeReopen = await waitForDocument(
    documentId,
    (document) => document.elements.some((element) => element.kind === 'connector')
      && document.elements.some((element) => element.kind === 'image'),
    '均衡画布保存',
  )
  await page.getByRole('button', { name: '返回光阴砚主页', exact: true }).click()
  await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
  await page.locator('button.aq-project-row-main').filter({ hasText: projectTitle }).click()
  await waitForCanvas()
  const reopened = await waitForDocument(
    documentId,
    (document) => JSON.stringify(elementSignature(document)) === JSON.stringify(elementSignature(persistedBeforeReopen)),
    '保存重开恢复画布',
  )
  assert.deepEqual(elementSignature(reopened), elementSignature(persistedBeforeReopen))

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出画布', exact: true }).click()
  const download = await downloadPromise
  const packagePath = await download.path()
  assert.ok(packagePath, '导出画布应产生兼容包下载')
  await page.locator('input[type="file"][accept*=".miaohui"]').setInputFiles(packagePath)
  await page.getByText('均衡画布兼容包已校验并导入', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
  const imported = await waitForDocument(
    documentId,
    (document) => JSON.stringify(elementSignature(document)) === JSON.stringify(elementSignature(persistedBeforeReopen)),
    '兼容包往返恢复画布',
  )
  assert.deepEqual(elementSignature(imported), elementSignature(persistedBeforeReopen))

  await page.setViewportSize({ width: 390, height: 844 })
  await ensureInspectorOpen()
  await assertNoHorizontalOverflow()
  await page.screenshot({ path: join(artifactDirectory, 'canvas-selection-ui-mobile.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.screenshot({ path: join(artifactDirectory, 'canvas-selection-ui-desktop.png'), fullPage: true })

  const endpointBeforeDelete = await loadCanvasDocument(documentId)
  assert.equal(endpointBeforeDelete.elements.filter((element) => element.kind === 'connector').length, 1)
  await selectOnly(firstShapeId)
  await page.locator('.selection-toolbar').getByRole('button', { name: '删除', exact: true }).click()
  await waitUntil('端点删除级联', async () => {
    const current = await loadCanvasDocument(documentId)
    return !current.elements.some((element) => element.id === firstShapeId)
      && !current.elements.some((element) => element.kind === 'connector')
      && current.elements.some((element) => element.id === secondShapeId)
  })

  assert.deepEqual(issues, [])
  console.log('✓ Canvas selection/connection UI passed: real creation, shift multi-select, visual AABB alignment, undo/redo revisions, lock gate, connection dialog/Inspector, port follow, persistence/package round-trip, cascade delete, image lab launch, and 1440/390 layouts')
} catch (error) {
  failure = error
  await page.screenshot({
    path: join(artifactDirectory, 'canvas-selection-ui-failure.png'),
    fullPage: true,
  }).catch(() => undefined)
  console.error(JSON.stringify({
    url: page.url(),
    issues,
    body: (await page.locator('body').innerText().catch(() => '')).slice(0, 10_000),
    artifactDirectory,
    bridgeLogs: bridge.logs(),
  }, null, 2))
} finally {
  await context.close().catch(() => undefined)
  await browser.close().catch(() => undefined)
  await bridge.stop({ keepRuntime: Boolean(failure) }).catch(() => undefined)
}

if (failure) throw failure
