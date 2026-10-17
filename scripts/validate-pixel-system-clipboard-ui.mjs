import assert from 'node:assert/strict'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { startIsolatedBridge } from './qa-runtime.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const artifactDirectory = join(projectRoot, '.runtime', 'qa')
const reportPath = join(artifactDirectory, 'pixel-system-clipboard-ui.json')
const logPath = join(artifactDirectory, 'pixel-system-clipboard-ui.log')
const desktopScreenshotPath = join(artifactDirectory, 'pixel-system-clipboard-ui-desktop.png')
const mobileScreenshotPath = join(artifactDirectory, 'pixel-system-clipboard-ui-mobile.png')
const failureScreenshotPath = join(artifactDirectory, 'pixel-system-clipboard-ui-failure.png')
const projectTitleA = 'PIXEL-SYSTEM-CLIPBOARD A'
const projectTitleB = 'PIXEL-SYSTEM-CLIPBOARD B'
const EDGE_PATHS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]

const bridgeExecutableArgument = process.argv.find((argument) => argument.startsWith('--bridge-executable='))
const bridgeExecutableRaw = bridgeExecutableArgument?.slice('--bridge-executable='.length) ?? null
if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/validate-pixel-system-clipboard-ui.mjs [--bridge-executable=<absolute exe path>]')
  process.exit(0)
}
if (process.argv.includes('--bridge-executable')) throw new Error('--bridge-executable must use --bridge-executable=<absolute exe path>')

let bridgeExecutable = null
if (bridgeExecutableRaw !== null) {
  if (!bridgeExecutableRaw || !isAbsolute(bridgeExecutableRaw)) throw new Error('--bridge-executable must be absolute')
  bridgeExecutable = resolve(bridgeExecutableRaw)
  await access(bridgeExecutable)
}

const report = {
  schemaVersion: 1,
  kind: 'aeonquill.qa.pixel-system-clipboard-ui',
  status: 'failed',
  generatedAt: new Date().toISOString(),
  browser: 'Microsoft Edge executable via Playwright',
  bridge: { runtime: 'startIsolatedBridge', type: bridgeExecutable ? 'self-contained-sidecar' : 'source', file: bridgeExecutable ? basename(bridgeExecutable) : 'server/index.mjs', baseUrl: null },
  projects: null,
  phases: [],
  clipboardBefore: null,
  clipboardAfter: null,
  responsive: null,
  persistence: null,
  pageErrors: [],
  consoleErrors: [],
  consoleWarnings: [],
  denial: null,
  error: null,
  screenshots: [desktopScreenshotPath, mobileScreenshotPath, failureScreenshotPath],
}

const logLines = []
const pageErrors = []
const consoleErrors = []
const consoleWarnings = []
const persistenceRequests = []
let bridge
let browser
let context
let page
let deniedBrowser
let deniedPage
let originalClipboard

function log(message) {
  logLines.push(`${new Date().toISOString()} ${message}`)
  console.log(message)
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function hashText(value) {
  return hashBytes(Buffer.from(value, 'utf8'))
}

function observePage(target, { collect = true } = {}) {
  target.on('pageerror', (error) => { if (collect) pageErrors.push(error.message) })
  target.on('console', (message) => {
    if (!collect) return
    if (message.type() === 'error') consoleErrors.push(message.text())
    else if (message.type() === 'warning') consoleWarnings.push(message.text())
  })
  target.on('response', (response) => {
    if (response.request().method() === 'PUT' && response.url().includes('/api/workspace/documents/')) {
      persistenceRequests.push({ status: response.status() })
    }
  })
  target.on('requestfailed', (request) => {
    if (request.url().includes('/api/workspace/documents/')) persistenceRequests.push({ status: 'failed', error: request.failure()?.errorText ?? 'request failed' })
  })
}

async function findEdgePath() {
  for (const candidate of EDGE_PATHS) {
    try { await access(candidate); return candidate } catch { /* try next */ }
  }
  return null
}

async function requestJson(pathname, options = {}, expectedStatus = 200) {
  const response = await bridge.request(pathname, {
    ...options,
    headers: options.body ? { 'content-type': 'application/json', ...options.headers } : options.headers,
  })
  const payload = await response.json().catch(() => ({}))
  assert.equal(response.status, expectedStatus, `${options.method ?? 'GET'} ${pathname}: ${JSON.stringify(payload).slice(0, 320)}`)
  return payload
}

async function findWorkspaceProject(title) {
  const payload = await requestJson('/api/workspace/catalog')
  const project = payload.catalog?.projects?.find((candidate) => candidate.title === title)
  assert.ok(project, `Project ${title} was not persisted in the workspace catalog`)
  const registration = project.documents?.find((candidate) => candidate.modeId === 'pixel')
  assert.ok(registration, `Project ${title} has no pixel registration`)
  return { project, registration }
}

async function readWorkspaceDocument(projectId, documentId) {
  const payload = await requestJson(`/api/workspace/documents/${encodeURIComponent(documentId)}?projectId=${encodeURIComponent(projectId)}&modeId=pixel`)
  assert.ok(payload.document?.value, 'Workspace response did not include a document body')
  return { record: payload.document, document: JSON.parse(payload.document.value) }
}

async function waitForWorkspaceRevision(projectId, documentId, revision, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let latest = null
  while (Date.now() < deadline) {
    latest = await readWorkspaceDocument(projectId, documentId)
    if (latest.record.revision === revision && latest.document.revision === revision) return latest
    await delay(120)
  }
  throw new Error(`Workspace document did not reach revision ${revision}; latest ${latest?.record?.revision}`)
}

async function uiRevision(targetPage = page) {
  const text = await targetPage.locator('.aq-pixel-document-title small').textContent()
  const match = /revision\s+(\d+)/u.exec(text ?? '')
  return match ? Number(match[1]) : null
}

async function waitForUiRevision(revision, targetPage = page) {
  await targetPage.waitForFunction((expected) => {
    const text = document.querySelector('.aq-pixel-document-title small')?.textContent ?? ''
    const match = /revision\s+(\d+)/u.exec(text)
    return match ? Number(match[1]) === expected : false
  }, revision, { timeout: 20_000 })
}

async function waitForStatus(pattern, targetPage = page) {
  await targetPage.getByRole('status').filter({ hasText: pattern }).last().waitFor({ state: 'visible', timeout: 20_000 })
}

async function canvasInfo(targetPage = page) {
  const canvas = targetPage.locator('canvas[aria-label*="像素绘制区"]').first()
  await canvas.waitFor({ state: 'visible', timeout: 20_000 })
  const label = await canvas.getAttribute('aria-label')
  const match = /^(\d+) 乘 (\d+) 像素绘制区/u.exec(label ?? '')
  assert.ok(match, `Unexpected canvas label: ${label}`)
  const box = await canvas.boundingBox()
  assert.ok(box && box.width > 0 && box.height > 0, 'Pixel canvas has no visible bounds')
  return { canvas, width: Number(match[1]), height: Number(match[2]), box }
}

function canvasCellPoint(info, x, y) {
  return {
    x: info.box.x + ((x + 0.5) / info.width) * info.box.width,
    y: info.box.y + ((y + 0.5) / info.height) * info.box.height,
  }
}

async function clickCanvasCells(cells, targetPage = page) {
  const info = await canvasInfo(targetPage)
  for (const cell of cells) {
    const point = canvasCellPoint(info, cell.x, cell.y)
    await targetPage.mouse.move(point.x, point.y)
    await targetPage.mouse.down()
    await targetPage.mouse.up()
    await delay(50)
  }
}

async function dragSelection(x1, y1, x2, y2, targetPage = page) {
  const info = await canvasInfo(targetPage)
  const start = canvasCellPoint(info, x1, y1)
  const end = canvasCellPoint(info, x2, y2)
  await targetPage.locator('.aq-pixel-toolbar').getByRole('button', { name: /选区/u }).click()
  await targetPage.mouse.move(start.x, start.y)
  await targetPage.mouse.down()
  await targetPage.mouse.move(end.x, end.y, { steps: 8 })
  await targetPage.mouse.up()
  await targetPage.locator('.aq-pixel-selection-actions').getByText(`${x2 - x1 + 1}×${y2 - y1 + 1}`, { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
}

async function createProjectThroughUi(title) {
  await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
  await page.locator('.aq-home-header').getByRole('button', { name: '创建新项目', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '创建新项目', exact: true })
  await dialog.waitFor({ state: 'visible' })
  await dialog.getByPlaceholder('输入项目名称').fill(title)
  const pixelOption = dialog.getByRole('button', { name: /像素模式 精细像素绘制与动画/u })
  await pixelOption.click()
  assert.equal(await pixelOption.getAttribute('aria-pressed'), 'true')
  await dialog.getByRole('button', { name: '创建并进入', exact: true }).click()
  await dialog.waitFor({ state: 'hidden', timeout: 20_000 })
  await page.getByLabel(/像素绘制区/u).waitFor({ state: 'visible', timeout: 20_000 })
  return findWorkspaceProject(title)
}

async function openProject(title) {
  await page.getByRole('button', { name: '返回光阴砚主页', exact: true }).click()
  await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
  await page.locator('.aq-project-row-main').filter({ hasText: title }).click()
  await page.getByLabel(/像素绘制区/u).waitFor({ state: 'visible', timeout: 20_000 })
}

async function setNativeColorInput(value, targetPage = page) {
  await targetPage.evaluate((nextValue) => {
    const input = document.querySelector('.aq-pixel-color-edit input[type="color"]')
    if (!(input instanceof HTMLInputElement)) throw new Error('Active palette color input is missing')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (!setter) throw new Error('Native color input value setter is unavailable')
    setter.call(input, nextValue)
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, value)
}

async function snapshotClipboard() {
  return page.evaluate(async () => {
    let text = null
    let pngBase64 = null
    try { text = await navigator.clipboard.readText() } catch { /* permission or empty clipboard */ }
    try {
      const items = await navigator.clipboard.read()
      for (const item of items) {
        if (!item.types.includes('image/png')) continue
        const bytes = new Uint8Array(await (await item.getType('image/png')).arrayBuffer())
        let binary = ''
        for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index])
        pngBase64 = btoa(binary)
        break
      }
    } catch { /* best effort */ }
    return { text, pngBase64 }
  })
}

async function readClipboardState() {
  return page.evaluate(async () => {
    const text = await navigator.clipboard.readText()
    const items = await navigator.clipboard.read()
    const types = items.flatMap((item) => item.types)
    return { text, types }
  })
}

async function restoreClipboard(snapshot) {
  if (!snapshot) return
  await page.evaluate(async (value) => {
    if (value.pngBase64) {
      const binary = atob(value.pngBase64)
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
      await navigator.clipboard.write([new ClipboardItem({
        'image/png': new Blob([bytes], { type: 'image/png' }),
        'text/plain': new Blob([value.text ?? ''], { type: 'text/plain' }),
      })])
      return
    }
    await navigator.clipboard.writeText(value.text ?? '')
  }, snapshot).catch(() => undefined)
}

async function writeExternalPng(width, height, pixels) {
  await page.evaluate(async ({ width: nextWidth, height: nextHeight, pixels: nextPixels }) => {
    const canvas = document.createElement('canvas')
    canvas.width = nextWidth
    canvas.height = nextHeight
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas 2D context unavailable for PNG clipboard fixture')
    const image = context.createImageData(nextWidth, nextHeight)
    image.data.set(nextPixels)
    context.putImageData(image, 0, 0)
    const blob = await new Promise((resolvePromise, rejectPromise) => canvas.toBlob((value) => value ? resolvePromise(value) : rejectPromise(new Error('PNG encoding failed')), 'image/png'))
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
  }, { width, height, pixels: [...pixels] })
}

async function assertNoHorizontalOverflow(targetPage = page) {
  return targetPage.evaluate(() => ({
    viewport: window.innerWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }))
}

function withoutRevision(document) {
  const copy = structuredClone(document)
  delete copy.revision
  return copy
}

function activePixel(document, index = 0) {
  const frame = document.frames.find(({ id }) => id === document.activeFrameId)
  return frame.cels[document.activeLayerId][index]
}

const edgePath = await findEdgePath()
if (!edgePath) throw new Error('Microsoft Edge executable was not found in standard Windows locations')

try {
  await mkdir(artifactDirectory, { recursive: true })
  bridge = await startIsolatedBridge('pixel-system-clipboard-ui', {
    comfyPolicy: 'manual',
    ...(bridgeExecutable ? { executablePath: bridgeExecutable } : {}),
  })
  report.bridge.baseUrl = bridge.baseUrl
  browser = await chromium.launch({ headless: true, executablePath: edgePath, args: ['--disable-gpu'] })
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: bridge.baseUrl })
  page = await context.newPage()
  observePage(page)
  await page.goto(bridge.baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
  assert.equal(await page.evaluate(() => Boolean(document.querySelector('vite-error-overlay,#webpack-dev-server-client-error-overlay'))), false)
  originalClipboard = await snapshotClipboard()
  report.clipboardBefore = {
    textCharacters: originalClipboard.text?.length ?? null,
    textHash: originalClipboard.text ? hashText(originalClipboard.text) : null,
    pngBytes: originalClipboard.pngBase64 ? Buffer.from(originalClipboard.pngBase64, 'base64').length : null,
    pngHash: originalClipboard.pngBase64 ? hashBytes(Buffer.from(originalClipboard.pngBase64, 'base64')) : null,
  }

  const createdA = await createProjectThroughUi(projectTitleA)
  const initialA = await waitForWorkspaceRevision(createdA.project.id, createdA.registration.id, 0)
  const toolbar = page.locator('.aq-pixel-toolbar')
  await toolbar.getByRole('button', { name: /铅笔/u }).click()
  await clickCanvasCells([{ x: 0, y: 0 }])
  await waitForUiRevision(1)
  const paintedA = await waitForWorkspaceRevision(createdA.project.id, createdA.registration.id, 1)
  await dragSelection(0, 0, 1, 1)
  await page.getByRole('button', { name: '复制到系统剪贴板', exact: true }).click()
  await waitForStatus('已复制 PNG 与精确像素数据')
  const copiedClipboard = await readClipboardState()
  assert.ok(copiedClipboard.types.includes('image/png'), `System clipboard types did not include image/png: ${JSON.stringify(copiedClipboard.types)}`)
  assert.ok(copiedClipboard.types.includes('text/plain'), `System clipboard types did not include text/plain: ${JSON.stringify(copiedClipboard.types)}`)
  const copiedPayload = JSON.parse(copiedClipboard.text)
  assert.equal(copiedPayload.kind, 'aeonquill.pixel-system-clipboard')
  assert.equal(copiedPayload.schemaVersion, 1)
  assert.deepEqual(copiedPayload.pixels.slice(0, 2), [0, null])
  report.phases.push({
    name: 'png-and-text-system-write-read',
    status: 'passed',
    projectId: createdA.project.id,
    sourceRevision: paintedA.document.revision,
    clipboardTypes: copiedClipboard.types,
    textCharacters: copiedClipboard.text.length,
    payload: { width: copiedPayload.width, height: copiedPayload.height, colors: copiedPayload.colors, pixels: copiedPayload.pixels },
  })

  await page.getByRole('button', { name: '返回光阴砚主页', exact: true }).click()
  await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
  await createProjectThroughUi(projectTitleB)
  const createdB = await findWorkspaceProject(projectTitleB)
  report.projects = {
    a: { projectId: createdA.project.id, documentId: createdA.registration.id, title: projectTitleA },
    b: { projectId: createdB.project.id, documentId: createdB.registration.id, title: projectTitleB },
  }
  const initialB = await waitForWorkspaceRevision(createdB.project.id, createdB.registration.id, 0)
  log(`B created: uiRevision=${await uiRevision()} workspaceRevision=${initialB.document.revision}`)
  const firstSwatch = page.getByRole('listbox', { name: '像素调色板', exact: true }).getByRole('option').first()
  await firstSwatch.click()
  await setNativeColorInput('#00FF00')
  log(`B recolor dispatched: uiRevision=${await uiRevision()}`)
  await waitForUiRevision(1)
  const recoloredB = await waitForWorkspaceRevision(createdB.project.id, createdB.registration.id, 1)
  const sourceColor = copiedPayload.colors[copiedPayload.pixels.find((value) => value !== null)]
  const bSameIdColor = recoloredB.document.palette.find((color) => color.id === 'ink')?.color.toLowerCase()
  assert.notEqual(bSameIdColor, sourceColor, 'Project B must use a different color for the same palette id')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '粘贴系统剪贴板', exact: true }).click()
  await waitForStatus('系统剪贴板已粘贴')
  await waitForUiRevision(2)
  const pastedB = await waitForWorkspaceRevision(createdB.project.id, createdB.registration.id, 2)
  const pastedIdB = activePixel(pastedB.document)
  const pastedColorB = pastedB.document.palette.find((color) => color.id === pastedIdB)?.color.toLowerCase()
  assert.equal(pastedColorB, sourceColor)
  assert.notEqual(pastedIdB, 'ink', 'Cross-palette paste must not reuse a same-id color with a different RGBA')
  assert.equal(activePixel(pastedB.document, 1), null)
  report.phases.push({ name: 'cross-project-rgba-identity-and-no-selection-target', status: 'passed', sourceColor, sameIdColor: bSameIdColor, pastedColor: pastedColorB, pastedId: pastedIdB, target: { x: 0, y: 0 } })

  await dragSelection(4, 4, 5, 5)
  const beforeSelectedPaste = await readWorkspaceDocument(createdB.project.id, createdB.registration.id)
  await page.getByRole('button', { name: '粘贴系统剪贴板', exact: true }).click()
  await waitForStatus('系统剪贴板已粘贴')
  await waitForUiRevision(3)
  const selectedPasted = await waitForWorkspaceRevision(createdB.project.id, createdB.registration.id, 3)
  assert.equal(activePixel(selectedPasted.document, 4 + selectedPasted.document.width * 4), pastedIdB)
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await waitForUiRevision(4)
  const selectedUndo = await waitForWorkspaceRevision(createdB.project.id, createdB.registration.id, 4)
  assert.deepEqual(withoutRevision(selectedUndo.document), withoutRevision(beforeSelectedPaste.document))
  await page.getByRole('button', { name: '重做', exact: true }).click()
  await waitForUiRevision(5)
  const selectedRedo = await waitForWorkspaceRevision(createdB.project.id, createdB.registration.id, 5)
  assert.equal(activePixel(selectedRedo.document, 4 + selectedRedo.document.width * 4), pastedIdB)
  report.phases.push({ name: 'selection-target-one-snapshot-undo-redo', status: 'passed', beforeRevision: 2, pasteRevision: 3, undoRevision: 4, redoRevision: 5, paletteRestoredOnUndo: true })

  await page.keyboard.press('Escape')
  await writeExternalPng(2, 2, [255, 0, 0, 128, 0, 0, 0, 0, 0, 0, 255, 255, 0, 0, 0, 0])
  const pngOnlyClipboard = await readClipboardState()
  assert.deepEqual(pngOnlyClipboard.types, ['image/png'])
  await page.getByRole('button', { name: '粘贴系统剪贴板', exact: true }).click()
  await waitForStatus('系统剪贴板已粘贴')
  await waitForUiRevision(6)
  const pngPasted = await waitForWorkspaceRevision(createdB.project.id, createdB.registration.id, 6)
  const pngColors = pngPasted.document.palette.map((color) => color.color.toLowerCase())
  assert.ok(pngColors.includes('#ff000080'))
  assert.ok(pngColors.includes('#0000ffff'))
  assert.notEqual(activePixel(pngPasted.document, 0), null)
  assert.equal(activePixel(pngPasted.document, 1), null)
  report.phases.push({ name: 'png-only-external-half-transparent-and-transparent', status: 'passed', clipboardTypes: pngOnlyClipboard.types, revision: 6, colors: ['#ff000080', '#0000ffff'] })

  const beforeTooMany = await readWorkspaceDocument(createdB.project.id, createdB.registration.id)
  const tooManyPixels = []
  for (let index = 0; index < 257; index += 1) tooManyPixels.push(index & 0xFF, (index >> 8) & 0xFF, 1, 255)
  await writeExternalPng(257, 1, tooManyPixels)
  await page.getByRole('button', { name: '粘贴系统剪贴板', exact: true }).click()
  await waitForStatus(/256|图像转换/u)
  await delay(400)
  const afterTooMany = await readWorkspaceDocument(createdB.project.id, createdB.registration.id)
  assert.equal(afterTooMany.document.revision, beforeTooMany.document.revision)
  assert.deepEqual(withoutRevision(afterTooMany.document), withoutRevision(beforeTooMany.document))
  await page.getByRole('button', { name: '复制选区到剪贴板', exact: true }).click()
  await waitForStatus('复制到内存剪贴板')
  report.phases.push({ name: 'over-256-png-rejection-is-atomic-memory-clipboard-stays-usable', status: 'passed', revisionUnchanged: true, memoryCopyStatus: 'passed' })

  await page.screenshot({ path: desktopScreenshotPath, fullPage: true })
  const desktopOverflow = await assertNoHorizontalOverflow()
  assert.ok(desktopOverflow.documentScrollWidth <= desktopOverflow.viewport, JSON.stringify(desktopOverflow))
  assert.ok(desktopOverflow.bodyScrollWidth <= desktopOverflow.viewport, JSON.stringify(desktopOverflow))
  await page.setViewportSize({ width: 390, height: 844 })
  await delay(300)
  const mobileOverflow = await assertNoHorizontalOverflow()
  assert.ok(mobileOverflow.documentScrollWidth <= mobileOverflow.viewport, JSON.stringify(mobileOverflow))
  assert.ok(mobileOverflow.bodyScrollWidth <= mobileOverflow.viewport, JSON.stringify(mobileOverflow))
  await page.screenshot({ path: mobileScreenshotPath, fullPage: true })
  report.responsive = { desktop: desktopOverflow, mobile: mobileOverflow }
  await page.setViewportSize({ width: 1440, height: 900 })

  const persistedBeforeRefresh = await readWorkspaceDocument(createdB.project.id, createdB.registration.id)
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.getByLabel(/像素绘制区/u).waitFor({ state: 'visible', timeout: 20_000 })
  await waitForUiRevision(persistedBeforeRefresh.document.revision)
  const afterRefresh = await waitForWorkspaceRevision(createdB.project.id, createdB.registration.id, persistedBeforeRefresh.document.revision)
  assert.deepEqual(withoutRevision(afterRefresh.document), withoutRevision(persistedBeforeRefresh.document))
  await openProject(projectTitleB)
  await waitForUiRevision(persistedBeforeRefresh.document.revision)
  const afterReopen = await waitForWorkspaceRevision(createdB.project.id, createdB.registration.id, persistedBeforeRefresh.document.revision)
  assert.deepEqual(withoutRevision(afterReopen.document), withoutRevision(persistedBeforeRefresh.document))
  report.persistence = { finalRevision: persistedBeforeRefresh.document.revision, refreshReopen: 'passed', workspacePutCount: persistenceRequests.length }
  report.phases.push({ name: 'refresh-and-project-reopen-persistence', status: 'passed', revision: persistedBeforeRefresh.document.revision })

  deniedBrowser = await chromium.launch({ headless: false, executablePath: edgePath, args: ['--disable-gpu', '--deny-permission-prompts'] })
  const deniedContext = await deniedBrowser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })
  await deniedContext.grantPermissions([], { origin: bridge.baseUrl })
  deniedPage = await deniedContext.newPage()
  observePage(deniedPage, { collect: false })
  await deniedPage.goto(page.url(), { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await deniedPage.getByLabel(/像素绘制区/u).waitFor({ state: 'visible', timeout: 20_000 })
  await dragSelection(0, 0, 0, 0, deniedPage)
  const deniedBefore = await readWorkspaceDocument(createdB.project.id, createdB.registration.id)
  await deniedPage.getByRole('button', { name: '复制到系统剪贴板', exact: true }).click()
  await delay(1200)
  log(`Denied system copy status: ${await deniedPage.locator('.aq-pixel-status').textContent()}`)
  await deniedPage.waitForFunction(() => /系统复制失败|permission denied|权限|内存剪贴板仍可使用/iu.test(document.querySelector('.aq-pixel-status')?.textContent ?? ''), null, { timeout: 15_000 })
  const deniedAfter = await readWorkspaceDocument(createdB.project.id, createdB.registration.id)
  assert.equal(deniedAfter.document.revision, deniedBefore.document.revision)
  await deniedPage.getByRole('button', { name: '复制选区到剪贴板', exact: true }).click()
  await deniedPage.getByRole('status').filter({ hasText: '复制到内存剪贴板' }).last().waitFor({ state: 'visible', timeout: 15_000 })
  await deniedContext.close()
  report.denial = { status: 'passed', deniedSystemCopyDidNotRevise: true, memoryCopyAfterDenial: true }
  report.phases.push({ name: 'permission-denial-fallback', status: 'passed' })

  report.clipboardAfter = await page.evaluate(async () => ({ text: await navigator.clipboard.readText().catch(() => null), types: await navigator.clipboard.read().then((items) => items.flatMap((item) => item.types)).catch(() => []) }))
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(consoleErrors, [])
  report.pageErrors = pageErrors
  report.consoleErrors = consoleErrors
  report.consoleWarnings = consoleWarnings
  report.status = 'passed'
  log('PASS pixel-system-clipboard UI flow')
} catch (error) {
  report.error = { name: error?.name ?? 'Error', message: error?.message ?? String(error) }
  report.error.ui = await page?.evaluate(() => ({
    title: document.querySelector('.aq-pixel-document-title')?.textContent ?? null,
    status: document.querySelector('.aq-pixel-status')?.textContent ?? null,
  })).catch(() => null)
  report.error.deniedUi = await deniedPage?.evaluate(() => ({
    title: document.querySelector('.aq-pixel-document-title')?.textContent ?? null,
    status: document.querySelector('.aq-pixel-status')?.textContent ?? null,
  })).catch(() => null)
  report.pageErrors = pageErrors
  report.consoleErrors = consoleErrors
  report.consoleWarnings = consoleWarnings
  log(`FAIL ${report.error.name}: ${report.error.message}`)
  if (page) await page.screenshot({ path: failureScreenshotPath, fullPage: true }).catch(() => undefined)
} finally {
  await restoreClipboard(originalClipboard).catch(() => undefined)
  report.pageErrors = pageErrors
  report.consoleErrors = consoleErrors
  report.consoleWarnings = consoleWarnings
  await mkdir(artifactDirectory, { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await writeFile(logPath, `${logLines.join('\n')}\n`, 'utf8')
  await page?.close().catch(() => undefined)
  await context?.close().catch(() => undefined)
  await deniedBrowser?.close().catch(() => undefined)
  await browser?.close().catch(() => undefined)
  await bridge?.stop({ keepRuntime: false }).catch(() => undefined)
}

if (report.status !== 'passed') throw new Error(report.error?.message ?? 'Pixel system clipboard UI validation failed')
console.log(`✓ Pixel system clipboard UI validation passed; report ${reportPath}`)
