import assert from 'node:assert/strict'
import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { startIsolatedBridge } from './qa-runtime.mjs'
import { createCanvasDocument } from '../src/lib/canvasCore.mjs'
import { createProjectCatalog, createWorkspaceProject } from '../src/lib/project/projectCatalog.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const artifactDirectory = join(projectRoot, '.runtime', 'qa')
const reportPath = join(artifactDirectory, 'image-effects-ui.json')
const logPath = join(artifactDirectory, 'image-effects-ui.log')
const desktopScreenshotPath = join(artifactDirectory, 'image-effects-ui-desktop.png')
const mobileScreenshotPath = join(artifactDirectory, 'image-effects-ui-mobile.png')
const failureScreenshotPath = join(artifactDirectory, 'image-effects-ui-failure.png')
const projectTitle = 'IMAGE-EFFECTS FE-006 UI'
const projectId = 'image-effects-fe006-project'
const documentId = 'image-effects-fe006-document'
const EDGE_PATHS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]
const bridgeExecutableArgument = process.argv.find((argument) => argument.startsWith('--bridge-executable='))
const bridgeExecutableRaw = bridgeExecutableArgument?.slice('--bridge-executable='.length) ?? null

if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/validate-image-effects-ui.mjs [--bridge-executable=<absolute exe path>]')
  process.exit(0)
}
if (process.argv.includes('--bridge-executable')) {
  throw new Error('--bridge-executable must use the form --bridge-executable=<absolute exe path>')
}

let bridgeExecutable = null
if (bridgeExecutableRaw !== null) {
  if (!bridgeExecutableRaw || !isAbsolute(bridgeExecutableRaw)) {
    throw new Error('--bridge-executable must be an absolute executable path')
  }
  bridgeExecutable = resolve(bridgeExecutableRaw)
  try {
    await access(bridgeExecutable)
  } catch (error) {
    throw new Error(`--bridge-executable does not exist: ${bridgeExecutable}`, { cause: error })
  }
}

const bridgeType = bridgeExecutable ? 'self-contained-sidecar' : 'source'
const bridgeFile = bridgeExecutable ? basename(bridgeExecutable) : 'server/index.mjs'
const report = {
  schemaVersion: 1,
  kind: 'aeonquill.qa.image-effects-ui',
  status: 'failed',
  generatedAt: new Date().toISOString(),
  browser: 'Microsoft Edge via Playwright',
  bridge: { runtime: 'startIsolatedBridge', type: bridgeType, file: bridgeFile, baseUrl: null },
  project: { projectId, documentId, title: projectTitle },
  fixtures: null,
  phases: [],
  persistence: null,
  responsive: null,
  pageErrors: [],
  consoleErrors: [],
  consoleWarnings: [],
  screenshots: [desktopScreenshotPath, mobileScreenshotPath],
  error: null,
}

const logLines = []
const pageErrors = []
const consoleErrors = []
const consoleWarnings = []
const requestFailures = []
const persistenceRequests = []
let bridge
let browser
let context
let page
let slowSourceUrl
let slowLatchActive = false
let slowLatchPromise = null
let slowLatchRelease = null
let slowPendingRequests = 0
let slowRequestCount = 0

function log(message) {
  logLines.push(`${new Date().toISOString()} ${message}`)
  console.log(message)
}

function armSlowLatch() {
  slowLatchActive = true
  slowLatchPromise = new Promise((resolvePromise) => { slowLatchRelease = resolvePromise })
}

async function releaseSlowLatch() {
  slowLatchActive = false
  slowLatchRelease?.()
  slowLatchRelease = null
  slowLatchPromise = null
  await delay(80)
}

async function waitForSlowPending(timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (slowPendingRequests > 0) return
    await delay(25)
  }
  throw new Error(`Slow fixture did not reach the pending response latch; requests=${slowRequestCount}`)
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function textHash(value) {
  return hashBytes(Buffer.from(value, 'utf8')).slice(0, 16)
}

function dataUrlBytes(value) {
  const match = /^data:[^,]*;base64,(.*)$/u.exec(value ?? '')
  return match ? Buffer.from(match[1], 'base64') : Buffer.from(String(value ?? ''), 'utf8')
}

function dataUrlHash(value) {
  return hashBytes(dataUrlBytes(value))
}

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0)
  return Buffer.concat([length, typeBytes, data, checksum])
}

function createRgbaPng(width, height, pixelAt) {
  const raw = Buffer.alloc(height * (width * 4 + 1))
  const transparent = { pixels: 0, semiTransparent: 0, opaque: 0 }
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (width * 4 + 1)
    raw[rowOffset] = 0
    for (let x = 0; x < width; x += 1) {
      const pixel = pixelAt(x, y)
      if (pixel[3] === 0) transparent.pixels += 1
      else if (pixel[3] === 255) transparent.opaque += 1
      else transparent.semiTransparent += 1
      Buffer.from(pixel).copy(raw, rowOffset + 1 + x * 4)
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  const bytes = Buffer.concat([
    Buffer.from('\x89PNG\r\n\x1a\n', 'binary'),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
  return {
    bytes,
    width,
    height,
    dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
    rgbaStats: { pixels: width * height, ...transparent },
  }
}

function makeFixtures() {
  const alpha = createRgbaPng(16, 12, (x, y) => {
    const edge = x === 0 || y === 0 || x === 15 || y === 11
    const alphaValue = edge ? 0 : ((x + y) % 4 === 0 ? 128 : 255)
    return [40 + x * 11, 80 + y * 9, 210 - x * 7, alphaValue]
  })
  const other = createRgbaPng(10, 6, (x, y) => {
    const alphaValue = x === 0 || y === 5 ? 0 : ((x * 3 + y) % 4 === 0 ? 140 : 255)
    return [220 - x * 12, 40 + y * 25, 70 + x * 8, alphaValue]
  })
  const slow = createRgbaPng(768, 512, (x, y) => {
    const alphaValue = x < 6 || y < 6 || x > 761 || y > 505 ? 0 : ((x + y) % 5 === 0 ? 128 : 255)
    return [30 + (x % 200), 60 + (y % 160), 150 + ((x + y) % 90), alphaValue]
  })
  const budget = createRgbaPng(1024, 1024, (x, y) => {
    const edge = x < 4 || y < 4 || x > 1019 || y > 1019
    return [100, 150, 210, edge ? 0 : 255]
  })
  return { alpha, other, slow, budget }
}

function imageElement({ id, name, src, sourceSrc = src, naturalWidth, naturalHeight, x, y, width, height, zIndex, processingStack = [], adjustments }) {
  return {
    id,
    kind: 'image',
    name,
    x,
    y,
    width,
    height,
    rotation: 0,
    opacity: 1,
    radius: 8,
    fill: '#ffffff',
    stroke: '#d5d8df',
    strokeWidth: 1,
    src,
    sourceSrc,
    naturalWidth,
    naturalHeight,
    adjustments: adjustments ?? { brightness: 100, contrast: 100, saturation: 100 },
    processingStack,
    locked: false,
    visible: true,
    zIndex,
  }
}

function makeCanvasFixture(fixtures, now, slowSource = fixtures.slow.dataUrl) {
  const legacyAdjustments = { brightness: 118, contrast: 88, saturation: 126 }
  const fixedCheckpoint = {
    id: 'step-legacy-checkpoint',
    type: 'upscale-lanczos',
    label: '模型固定结果',
    detail: '受限 fixture checkpoint · 不可重放',
    enabled: true,
    createdAt: now,
    outputSrc: fixtures.alpha.dataUrl,
  }
  const legacyAdjust = {
    id: 'step-legacy-adjust',
    type: 'adjust',
    label: '旧 CSS 调整',
    detail: '旧文档无 parameters',
    enabled: true,
    createdAt: now + 1,
  }
  const oldCrop = {
    id: 'step-old-crop',
    type: 'crop',
    label: '旧裁剪结果',
    detail: '旧文档无 parameters',
    enabled: true,
    createdAt: now,
    outputSrc: fixtures.other.dataUrl,
  }
  const slowCheckpoint = {
    id: 'step-slow-checkpoint',
    type: 'upscale-lanczos',
    label: 'Slow fixture checkpoint',
    detail: '受限 fixture checkpoint',
    enabled: true,
    createdAt: now,
    outputSrc: fixtures.slow.dataUrl,
  }
  const budgetElements = Array.from({ length: 33 }, (_, index) => imageElement({
    id: `image-budget-${String(index + 1).padStart(2, '0')}`,
    name: `Budget ${String(index + 1).padStart(2, '0')}`,
    src: fixtures.budget.dataUrl,
    naturalWidth: fixtures.budget.width,
    naturalHeight: fixtures.budget.height,
    x: 20 + (index % 11) * 80,
    y: 480 + Math.floor(index / 11) * 80,
    width: 70,
    height: 70,
    zIndex: 10 + index,
  }))
  return createCanvasDocument({
    id: documentId,
    title: projectTitle,
    camera: { x: 0, y: 0, zoom: 1 },
    now,
    elements: [
      imageElement({ id: 'image-alpha-a', name: 'Alpha A', src: fixtures.alpha.dataUrl, naturalWidth: fixtures.alpha.width, naturalHeight: fixtures.alpha.height, x: 40, y: 40, width: 300, height: 225, zIndex: 1 }),
      imageElement({ id: 'image-alpha-b', name: 'Alpha B', src: fixtures.other.dataUrl, naturalWidth: fixtures.other.width, naturalHeight: fixtures.other.height, x: 390, y: 40, width: 260, height: 156, zIndex: 2 }),
      imageElement({ id: 'image-legacy', name: 'Legacy Checkpoint', src: fixtures.alpha.dataUrl, naturalWidth: fixtures.alpha.width, naturalHeight: fixtures.alpha.height, x: 690, y: 40, width: 240, height: 180, zIndex: 3, processingStack: [fixedCheckpoint, legacyAdjust], adjustments: legacyAdjustments }),
      imageElement({ id: 'image-broken', name: 'Read Failure Fixture', src: 'data:image/png;base64,iVBORw0KGgo=', naturalWidth: fixtures.alpha.width, naturalHeight: fixtures.alpha.height, x: 40, y: 330, width: 260, height: 195, zIndex: 4 }),
      imageElement({ id: 'image-slow', name: 'Slow Alpha Fixture', src: fixtures.slow.dataUrl, sourceSrc: slowSource, naturalWidth: fixtures.slow.width, naturalHeight: fixtures.slow.height, x: 350, y: 300, width: 300, height: 200, zIndex: 5, processingStack: [slowCheckpoint] }),
      imageElement({ id: 'image-old-crop', name: 'Legacy Crop', src: fixtures.alpha.dataUrl, naturalWidth: fixtures.other.width, naturalHeight: fixtures.other.height, x: 690, y: 280, width: 240, height: 300, zIndex: 6, processingStack: [oldCrop] }),
      ...budgetElements,
    ],
  })
}

function summarizeImage(document, id) {
  const image = document.elements.find((element) => element.id === id)
  assert.ok(image, `Missing image ${id}`)
  return {
    id,
    srcHash: dataUrlHash(image.src),
    sourceHash: dataUrlHash(image.sourceSrc),
    naturalWidth: image.naturalWidth,
    naturalHeight: image.naturalHeight,
    locked: image.locked,
    steps: (image.processingStack ?? []).map((step) => ({
      id: step.id,
      type: step.type,
      enabled: step.enabled,
      parameters: step.parameters ? structuredClone(step.parameters) : undefined,
      hasMaskRecipe: Boolean(step.maskRecipe),
      outputHash: step.outputSrc ? dataUrlHash(step.outputSrc) : null,
    })),
  }
}

function parseRevision(text) {
  const match = /revision\s+(\d+)/u.exec(text ?? '')
  return match ? Number(match[1]) : null
}

async function requestJson(pathname, options = {}, expectedStatus = 200) {
  const response = await bridge.request(pathname, {
    ...options,
    headers: options.body ? { 'content-type': 'application/json', ...options.headers } : options.headers,
  })
  const payload = await response.json().catch(() => ({}))
  assert.equal(response.status, expectedStatus, `${options.method ?? 'GET'} ${pathname}: ${JSON.stringify(payload).slice(0, 400)}`)
  return payload
}

async function readWorkspaceDocument() {
  const payload = await requestJson(`/api/workspace/documents/${encodeURIComponent(documentId)}?projectId=${encodeURIComponent(projectId)}&modeId=balanced`)
  assert.ok(payload.document?.value, 'Workspace response did not contain a document value')
  const workspaceDocument = JSON.parse(payload.document.value)
  const localPayload = await requestJson(`/api/projects/current?id=${encodeURIComponent(documentId)}`)
  const localDocument = localPayload.project?.document
  if (localDocument && localDocument.revision >= workspaceDocument.revision) {
    return {
      record: { ...payload.document, revision: localDocument.revision, source: 'project-store' },
      document: localDocument,
    }
  }
  return { record: payload.document, document: workspaceDocument }
}

async function waitForWorkspaceRevision(expectedRevision, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let latest
  while (Date.now() < deadline) {
    latest = await readWorkspaceDocument()
    if (latest.record.revision === expectedRevision && latest.document.revision === expectedRevision) return latest
    await delay(120)
  }
  throw new Error(`Workspace document did not reach revision ${expectedRevision}; latest ${latest?.record?.revision}`)
}

async function waitForWorkspaceDocument(predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let latest
  while (Date.now() < deadline) {
    latest = await readWorkspaceDocument()
    if (predicate(latest.document, latest.record)) return latest
    await delay(120)
  }
  throw new Error(`Workspace document predicate did not pass; latest revision ${latest?.record?.revision}`)
}

async function findEdgePath() {
  for (const candidate of EDGE_PATHS) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // Continue through standard Windows Edge locations.
    }
  }
  return null
}

async function uiRevision() {
  const value = await page.locator('.save-status').textContent().catch(() => '')
  const title = await page.locator('.project-trigger').textContent().catch(() => '')
  return { saveStatus: value?.trim() ?? '', title: title?.trim() ?? '' }
}

async function observePage(target) {
  target.on('pageerror', (error) => pageErrors.push(error.message))
  target.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
    else if (message.type() === 'warning') consoleWarnings.push(message.text())
  })
  target.on('requestfailed', (request) => {
    requestFailures.push({ url: request.url(), error: request.failure()?.errorText ?? 'request failed' })
  })
  target.on('response', (response) => {
    if (response.request().method() !== 'PUT') return
    const url = response.url()
    if (url.includes('/api/workspace/documents/')) {
      const entry = { kind: 'workspace-document', status: response.status(), url, at: Date.now() }
      persistenceRequests.push(entry)
      void response.json().then((body) => { entry.code = body?.error?.code ?? null }).catch(() => undefined)
    } else if (url.includes('/api/projects/current')) {
      const entry = { kind: 'project-store', status: response.status(), url, at: Date.now() }
      persistenceRequests.push(entry)
      void response.json().then((body) => { entry.code = body?.error?.code ?? null }).catch(() => undefined)
    } else if (url.includes('/api/workspace/catalog')) {
      const entry = { kind: 'workspace-catalog', status: response.status(), url, at: Date.now() }
      persistenceRequests.push(entry)
      void response.json().then((body) => { entry.code = body?.error?.code ?? null }).catch(() => undefined)
    }
  })
}

async function selectElement(id, modifiers = [], force = false) {
  const locator = page.locator(`[data-canvas-element][data-element-id="${id}"]`)
  await locator.waitFor({ state: 'visible', timeout: 20_000 })
  await locator.click({ modifiers, force })
  await page.getByLabel('属性与任务面板', { exact: true }).waitFor({ state: 'visible' })
  await page.waitForFunction(({ elementId, multi }) => {
    const selected = [...document.querySelectorAll('[data-canvas-element].is-selected')]
    return selected.some((element) => element.getAttribute('data-element-id') === elementId)
      && (multi || selected.length === 1)
  }, { elementId: id, multi: modifiers.length > 0 }, { timeout: 5_000 })
  return locator
}

async function selectOnly(id) {
  const selectedCount = await page.locator('[data-canvas-element].is-selected').count()
  if (selectedCount > 1) {
    await page.locator('.canvas-viewport').click({ position: { x: 20, y: 20 } })
    await page.waitForFunction(() => document.querySelectorAll('[data-canvas-element].is-selected').length === 0, undefined, { timeout: 5_000 })
  }
  return selectElement(id)
}

async function addSelection(id, force = false) {
  return selectElement(id, ['Shift'], force)
}

function effectsSection() {
  return page.getByLabel('图像效果栈', { exact: true })
}

async function waitForEffectsSection() {
  const section = effectsSection()
  await section.waitFor({ state: 'visible', timeout: 20_000 })
  return section
}

async function openImageLab(toolLabel) {
  const quick = page.getByLabel('快捷处理', { exact: true })
  await quick.getByRole('button', { name: toolLabel, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '图像处理实验室', exact: true })
  await dialog.waitFor({ state: 'visible', timeout: 20_000 })
  return dialog
}

async function closeImageLab(dialog) {
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await dialog.waitFor({ state: 'hidden', timeout: 20_000 })
}

function rangeIn(dialog, label) {
  return dialog.locator('label.lab-range-setting').filter({ hasText: label }).locator('input[type="range"]')
}

async function setRange(dialog, label, value) {
  const range = rangeIn(dialog, label)
  await range.evaluate((element, nextValue) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (!setter) throw new Error('Range input value setter is unavailable')
    setter.call(element, String(nextValue))
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  }, value)
  assert.equal(await range.inputValue(), String(value), `Range ${label} did not accept ${value}`)
}

async function waitForResultImage(dialog, expectedWidth = null, expectedHeight = null) {
  const image = dialog.locator('figure.is-result img').first()
  await image.waitFor({ state: 'visible', timeout: 20_000 })
  await page.waitForFunction(({ selector, width, height }) => {
    const element = document.querySelector(selector)
    return Boolean(element && element.naturalWidth > 0 && (!width || element.naturalWidth === width) && (!height || element.naturalHeight === height))
  }, { selector: 'figure.is-result img', width: expectedWidth, height: expectedHeight }, { timeout: 20_000 })
  return image
}

async function waitForGenerateIdle(dialog) {
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')]
      .find((element) => element.textContent?.includes('生成草稿'))
    return Boolean(button && !button.disabled)
  }, undefined, { timeout: 20_000 })
}

async function waitForResultGone() {
  await page.waitForFunction(() => !document.querySelector('figure.is-result img'), undefined, { timeout: 5_000 })
}

async function applyImageLab(dialog, expectedRevision) {
  const apply = dialog.getByRole('button', { name: '应用到画布', exact: true })
  await apply.waitFor({ state: 'visible', timeout: 20_000 })
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')]
      .find((element) => element.textContent?.includes('应用到画布'))
    return Boolean(button && !button.disabled)
  }, undefined, { timeout: 20_000 })
  await apply.click()
  await dialog.waitFor({ state: 'hidden', timeout: 30_000 })
  return waitForWorkspaceRevision(expectedRevision)
}

async function imageEvidence(src) {
  return page.evaluate((value) => new Promise((resolvePromise, rejectPromise) => {
    const image = new Image()
    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) { rejectPromise(new Error('Image evidence canvas unavailable')); return }
      context.drawImage(image, 0, 0)
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data
      let hash = 0x811c9dc5
      let transparent = 0
      let semiTransparent = 0
      let opaque = 0
      for (let index = 0; index < data.length; index += 4) {
        for (let channel = 0; channel < 4; channel += 1) {
          hash ^= data[index + channel]
          hash = Math.imul(hash, 0x01000193)
        }
        if (data[index + 3] === 0) transparent += 1
        else if (data[index + 3] === 255) opaque += 1
        else semiTransparent += 1
      }
      resolvePromise({
        width: canvas.width,
        height: canvas.height,
        pixelHash: (hash >>> 0).toString(16).padStart(8, '0'),
        transparent,
        semiTransparent,
        opaque,
      })
    }
    image.onerror = () => rejectPromise(new Error('Image evidence could not decode source'))
    image.src = value
  }), src)
}

async function assertNoHorizontalOverflow() {
  return page.evaluate(() => ({
    viewport: window.innerWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }))
}

async function marqueeSelectElements(ids) {
  const boxes = await Promise.all(ids.map(async (id) => {
    const box = await page.locator(`[data-canvas-element][data-element-id="${id}"]`).boundingBox()
    assert.ok(box, `Missing bounding box for ${id}`)
    return box
  }))
  const left = Math.min(...boxes.map((box) => box.x)) - 8
  const top = Math.min(...boxes.map((box) => box.y)) - 8
  const right = Math.max(...boxes.map((box) => box.x + box.width)) + 8
  const bottom = Math.max(...boxes.map((box) => box.y + box.height)) + 8
  await page.mouse.move(left, top)
  await page.mouse.down()
  await page.mouse.move(right, bottom, { steps: 12 })
  await page.mouse.up()
  await page.waitForFunction(() => document.querySelectorAll('[data-canvas-element].is-selected').length > 0, undefined, { timeout: 5_000 })
}

async function waitForToast(pattern) {
  await page.getByRole('status').filter({ hasText: pattern }).last().waitFor({ state: 'visible', timeout: 20_000 })
}

async function exportProjectPackage() {
  const downloadPromise = page.waitForEvent('download', { timeout: 20_000 })
  await page.getByRole('button', { name: '导出画布', exact: true }).click()
  const download = await downloadPromise
  const path = await download.path()
  assert.ok(path, 'Project package download did not expose a temporary path')
  return { download, path, bytes: await readFile(path) }
}

async function returnAndReopen() {
  await page.getByRole('button', { name: '返回光阴砚主页', exact: true }).click()
  await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
  await page.locator('.aq-project-row-main').filter({ hasText: projectTitle }).click()
  await page.getByLabel('无限画布', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
}

async function createWorkspaceFixture(fixtures, slowSource) {
  const now = Date.now()
  const catalogResult = createWorkspaceProject(createProjectCatalog(), {
    title: projectTitle,
    initialModeId: 'balanced',
    color: 'violet',
  }, { projectId, documentId, now })
  const legacyDocument = makeCanvasFixture(fixtures, now, slowSource)
  await requestJson('/api/workspace/catalog', {
    method: 'PUT',
    body: JSON.stringify({ catalog: catalogResult.catalog, baseRevision: 0, source: 'image-effects-fe006-ui' }),
  })
  await requestJson('/api/projects/current', {
    method: 'PUT',
    body: JSON.stringify({ document: legacyDocument }),
  })
  return { catalog: catalogResult.catalog, document: legacyDocument }
}

const edgePath = await findEdgePath()
if (!edgePath) throw new Error('Microsoft Edge executable was not found in standard Windows locations')

try {
  await mkdir(artifactDirectory, { recursive: true })
  await unlink(failureScreenshotPath).catch(() => undefined)
  const fixtures = makeFixtures()
  report.fixtures = Object.fromEntries(Object.entries(fixtures).map(([name, fixture]) => [name, {
    width: fixture.width,
    height: fixture.height,
    bytes: fixture.bytes.length,
    sha256: hashBytes(fixture.bytes),
    rgbaStats: fixture.rgbaStats,
  }]))

  bridge = await startIsolatedBridge('image-effects-ui', {
    comfyPolicy: 'manual',
    ...(bridgeExecutable ? { executablePath: bridgeExecutable } : {}),
  })
  report.bridge.baseUrl = bridge.baseUrl
  slowSourceUrl = `${bridge.baseUrl}/__qa-image-effects-slow-${Date.now()}-${Math.random().toString(16).slice(2)}.png`
  const initialFixture = await createWorkspaceFixture(fixtures, slowSourceUrl)

  browser = await chromium.launch({ headless: true, executablePath: edgePath, args: ['--disable-gpu'] })
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })
  page = await context.newPage()
  await page.route(`${slowSourceUrl}**`, async (route) => {
    slowRequestCount += 1
    if (slowLatchActive) {
      slowPendingRequests += 1
      try { await slowLatchPromise } finally { slowPendingRequests -= 1 }
    }
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'image/png', 'cache-control': 'no-store' },
      body: fixtures.slow.bytes,
    }).catch(() => undefined)
  })
  const cdp = await context.newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
  observePage(page)
  await page.goto(bridge.baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
  await page.locator('.aq-project-row-main').filter({ hasText: projectTitle }).click()
  await page.getByLabel('无限画布', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
  await selectOnly('image-alpha-a')
  await waitForEffectsSection()
  assert.equal((await readWorkspaceDocument()).document.revision, 0)

  log('phase legacy migration')
  await selectOnly('image-legacy')
  const legacyBefore = await readWorkspaceDocument()
  const legacyImageBefore = legacyBefore.document.elements.find((element) => element.id === 'image-legacy')
  assert.deepEqual(legacyImageBefore.adjustments, { brightness: 118, contrast: 88, saturation: 126 })
  const legacyDomImage = page.locator('[data-canvas-element][data-element-id="image-legacy"] img')
  const legacyCssBefore = await legacyDomImage.evaluate((element) => getComputedStyle(element).filter)
  assert.match(legacyCssBefore, /brightness\((?:118%|1\.18)\)/u)
  assert.match(legacyCssBefore, /contrast\((?:88%|0\.88)\)/u)
  assert.match(legacyCssBefore, /saturate\((?:126%|1\.26)\)/u)
  const legacyDialog = await openImageLab('调整')
  assert.equal(await rangeIn(legacyDialog, '亮度').inputValue(), '118')
  assert.equal(await rangeIn(legacyDialog, '对比度').inputValue(), '88')
  assert.equal(await rangeIn(legacyDialog, '饱和度').inputValue(), '126')
  const legacyApplied = await applyImageLab(legacyDialog, 1)
  const legacyStep = legacyApplied.document.elements.find((element) => element.id === 'image-legacy').processingStack
  assert.deepEqual(legacyStep.map((step) => step.id), ['step-legacy-checkpoint', 'step-legacy-adjust'])
  assert.deepEqual(legacyStep[1].parameters, { kind: 'adjust', brightness: 118, contrast: 88, saturation: 126 })
  assert.equal(legacyStep[0].outputSrc !== undefined, true)
  const legacyUpButton = effectsSection().getByRole('button', { name: '上移效果 2', exact: true })
  assert.equal(await legacyUpButton.isDisabled(), true, 'Legacy local effect must not cross fixed checkpoint')
  const legacyCssAfter = await legacyDomImage.evaluate((element) => getComputedStyle(element).filter)
  assert.ok(legacyCssAfter === 'none' || legacyCssAfter === '', `Rasterized adjustment kept CSS filter: ${legacyCssAfter}`)
  report.phases.push({
    name: 'legacy-css-adjust-migrates-to-explicit-parameters',
    status: 'passed',
    revision: legacyApplied.document.revision,
    stepIds: legacyStep.map((step) => step.id),
    parameters: legacyStep[1].parameters,
    fixedCheckpoint: { type: legacyStep[0].type, cannotCross: true },
    cssFilterBefore: legacyCssBefore,
    cssFilterAfter: legacyCssAfter,
  })

  log('phase adjust crop mask reorder toggle undo redo')
  await selectOnly('image-alpha-a')
  const adjustDialog = await openImageLab('调整')
  await setRange(adjustDialog, '亮度', 130)
  await setRange(adjustDialog, '对比度', 120)
  await setRange(adjustDialog, '饱和度', 80)
  const adjusted = await applyImageLab(adjustDialog, 2)
  const adjustedImage = adjusted.document.elements.find((element) => element.id === 'image-alpha-a')
  assert.deepEqual(adjustedImage.processingStack[0].parameters, { kind: 'adjust', brightness: 130, contrast: 120, saturation: 80 })
  assert.equal(typeof adjustedImage.processingStack[0].outputSrc, 'string')
  assert.ok(adjustedImage.processingStack[0].outputSrc.length > 0)
  const adjustedEvidence = await imageEvidence(adjustedImage.src)

  const cropDialog = await openImageLab('裁剪')
  const cropAspect = cropDialog.locator('label.lab-select-setting').filter({ hasText: '输出画幅' }).locator('select')
  await cropAspect.selectOption('4:3')
  await cropDialog.getByRole('button', { name: '生成草稿', exact: true }).click()
  const previewImage = await waitForResultImage(cropDialog, 640, 480)
  await waitForGenerateIdle(cropDialog)
  const previewEvidence = await previewImage.evaluate((element) => ({ width: element.naturalWidth, height: element.naturalHeight }))
  assert.deepEqual(previewEvidence, { width: 640, height: 480 }, 'Legacy crop preview must stay at 640 output width')
  await setRange(cropDialog, '画面缩放', 200)
  await setRange(cropDialog, '水平焦点', 50)
  await setRange(cropDialog, '垂直焦点', 50)
  await page.waitForTimeout(180)
  await waitForResultGone()
  await cropDialog.getByRole('button', { name: '生成草稿', exact: true }).click()
  await waitForResultImage(cropDialog, 640, 480)
  await waitForGenerateIdle(cropDialog)
  const cropped = await applyImageLab(cropDialog, 3)
  const croppedImage = cropped.document.elements.find((element) => element.id === 'image-alpha-a')
  const cropStepId = croppedImage.processingStack[1].id
  assert.deepEqual(croppedImage.processingStack.map((step) => step.type), ['adjust', 'crop'])
  assert.deepEqual(croppedImage.processingStack[1].parameters, { kind: 'crop', aspect: '4:3', zoom: 2, positionX: 50, positionY: 50 })
  assert.deepEqual({ width: croppedImage.naturalWidth, height: croppedImage.naturalHeight }, { width: 8, height: 6 })
  const croppedEvidence = await imageEvidence(croppedImage.src)
  assert.ok(croppedEvidence.transparent > 0 || croppedEvidence.semiTransparent > 0, 'Full crop lost fixture Alpha')
  assert.equal(croppedEvidence.width, 8)
  assert.equal(croppedEvidence.height, 6)

  const editCropDialog = await effectsSection().getByRole('button', { name: '编辑效果 2', exact: true }).click().then(async () => {
    const dialog = page.getByRole('dialog', { name: '图像处理实验室', exact: true })
    await dialog.waitFor({ state: 'visible' })
    return dialog
  })
  assert.equal(await editCropDialog.locator('label.lab-select-setting').filter({ hasText: '输出画幅' }).locator('select').inputValue(), '4:3')
  assert.equal(await rangeIn(editCropDialog, '画面缩放').inputValue(), '200')
  await setRange(editCropDialog, '画面缩放', 150)
  await page.waitForTimeout(180)
  await waitForResultGone()
  await editCropDialog.getByRole('button', { name: '生成草稿', exact: true }).click()
  await waitForResultImage(editCropDialog, 640, 480)
  await waitForGenerateIdle(editCropDialog)
  const recropped = await applyImageLab(editCropDialog, 4)
  const recroppedImage = recropped.document.elements.find((element) => element.id === 'image-alpha-a')
  assert.equal(recroppedImage.processingStack[1].id, cropStepId)
  assert.equal(recroppedImage.processingStack[1].parameters.zoom, 1.5)
  assert.deepEqual({ width: recroppedImage.naturalWidth, height: recroppedImage.naturalHeight }, { width: 10, height: 8 })
  const recroppedEvidence = await imageEvidence(recroppedImage.src)
  assert.ok(recroppedEvidence.width < previewEvidence.width && recroppedEvidence.height < previewEvidence.height, 'Full crop should not retain 640 preview dimensions')

  const maskDialog = await openImageLab('蒙版修边')
  const maskCanvas = maskDialog.getByLabel('在图片上拖动以移除或恢复蒙版', { exact: true })
  await maskCanvas.waitFor({ state: 'visible', timeout: 20_000 })
  const maskBox = await maskCanvas.boundingBox()
  assert.ok(maskBox && maskBox.width > 0 && maskBox.height > 0)
  await page.mouse.move(maskBox.x + maskBox.width * 0.5, maskBox.y + maskBox.height * 0.25)
  await page.mouse.down()
  await page.mouse.move(maskBox.x + maskBox.width * 0.5, maskBox.y + maskBox.height * 0.75, { steps: 8 })
  await page.mouse.up()
  await maskDialog.getByText(/1 笔修正/u).waitFor({ state: 'visible', timeout: 20_000 })
  const masked = await applyImageLab(maskDialog, 5)
  const maskedImage = masked.document.elements.find((element) => element.id === 'image-alpha-a')
  assert.deepEqual(maskedImage.processingStack.map((step) => step.type), ['adjust', 'crop', 'mask-refine'])
  assert.ok(maskedImage.processingStack[2].maskRecipe.strokes.length > 0)
  const maskedEvidence = await imageEvidence(maskedImage.src)
  assert.notEqual(maskedEvidence.pixelHash, recroppedEvidence.pixelHash, 'Mask refinement did not change actual pixels')

  const orderBefore = maskedImage.processingStack.map((step) => step.type)
  const maskUp = effectsSection().getByRole('button', { name: '上移效果 3', exact: true })
  await maskUp.click()
  const reorderedUp = await waitForWorkspaceRevision(6)
  const reorderedUpImage = reorderedUp.document.elements.find((element) => element.id === 'image-alpha-a')
  assert.deepEqual(reorderedUpImage.processingStack.map((step) => step.type), ['adjust', 'mask-refine', 'crop'])
  const reorderedUpEvidence = await imageEvidence(reorderedUpImage.src)
  assert.notEqual(reorderedUpEvidence.pixelHash, maskedEvidence.pixelHash, 'Reordering mask and crop did not change actual output')
  await effectsSection().getByRole('button', { name: '下移效果 2', exact: true }).click()
  const reorderedDown = await waitForWorkspaceRevision(7)
  const reorderedDownImage = reorderedDown.document.elements.find((element) => element.id === 'image-alpha-a')
  assert.deepEqual(reorderedDownImage.processingStack.map((step) => step.type), orderBefore)
  const reorderedDownEvidence = await imageEvidence(reorderedDownImage.src)
  assert.equal(reorderedDownEvidence.pixelHash, maskedEvidence.pixelHash, 'Reordering back did not restore deterministic output')

  await effectsSection().getByRole('checkbox', { name: '停用蒙版修边', exact: true }).click()
  const toggledOff = await waitForWorkspaceRevision(8)
  const toggledOffImage = toggledOff.document.elements.find((element) => element.id === 'image-alpha-a')
  assert.equal(toggledOffImage.processingStack[2].enabled, false)
  const toggledOffEvidence = await imageEvidence(toggledOffImage.src)
  assert.equal(toggledOffEvidence.pixelHash, recroppedEvidence.pixelHash, 'Disabled mask did not restore pre-mask pixels')
  await effectsSection().getByRole('checkbox', { name: '启用蒙版修边', exact: true }).click()
  const toggledOn = await waitForWorkspaceRevision(9)
  const toggledOnImage = toggledOn.document.elements.find((element) => element.id === 'image-alpha-a')
  assert.equal(toggledOnImage.processingStack[2].enabled, true)
  assert.equal((await imageEvidence(toggledOnImage.src)).pixelHash, maskedEvidence.pixelHash)

  await effectsSection().getByRole('button', { name: '复制效果配方', exact: true }).click()
  await page.getByText(/当前配方 3 步/u).waitFor({ state: 'visible', timeout: 20_000 })
  const recipeDownloadPromise = page.waitForEvent('download', { timeout: 20_000 })
  await effectsSection().getByRole('button', { name: '导出配方', exact: true }).click()
  const recipeDownload = await recipeDownloadPromise
  const recipePath = await recipeDownload.path()
  assert.ok(recipePath, 'Image effect recipe download did not expose a temporary path')
  const recipeBytes = await readFile(recipePath)
  assert.ok(recipeBytes.length <= 1024 * 1024, 'Exported recipe exceeded 1MiB')
  const recipe = JSON.parse(recipeBytes.toString('utf8'))
  assert.deepEqual(Object.keys(recipe).sort(), ['kind', 'schemaVersion', 'steps'])
  assert.deepEqual(recipe.steps.map((step) => step.type), ['adjust', 'crop', 'mask-refine'])
  assert.equal(recipe.steps.some((step) => Object.hasOwn(step, 'id') || Object.hasOwn(step, 'outputSrc')), false)
  assert.equal(Object.hasOwn(recipe.steps[0], 'parameters'), true)

  await effectsSection().getByRole('button', { name: '清空效果', exact: true }).click()
  const cleared = await waitForWorkspaceRevision(10)
  const clearedImage = cleared.document.elements.find((element) => element.id === 'image-alpha-a')
  assert.equal(clearedImage.processingStack.length, 0)
  assert.equal(clearedImage.src, clearedImage.sourceSrc)
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  const undone = await waitForWorkspaceRevision(11)
  assert.deepEqual(undone.document.elements.find((element) => element.id === 'image-alpha-a').processingStack.map((step) => step.type), ['adjust', 'crop', 'mask-refine'])
  await page.getByRole('button', { name: '重做', exact: true }).click()
  await waitForWorkspaceRevision(12)
  const recipeInput = page.getByLabel('导入图像效果配方', { exact: true })
  await recipeInput.setInputFiles(recipePath)
  await waitForToast(/已载入 3 步效果配方/u)
  await effectsSection().getByRole('button', { name: '应用配方到所选 1 张', exact: true }).click()
  const reapplied = await waitForWorkspaceRevision(13)
  const reappliedImage = reapplied.document.elements.find((element) => element.id === 'image-alpha-a')
  assert.deepEqual(reappliedImage.processingStack.map((step) => step.type), ['adjust', 'crop', 'mask-refine'])
  assert.ok(reappliedImage.processingStack.every((step) => step.parameters || step.maskRecipe))
  report.phases.push({
    name: 'adjust-crop-mask-local-replay-order-toggle-recipe-undo-redo',
    status: 'passed',
    revisions: { adjust: 2, crop: 3, cropEdit: 4, mask: 5, reorderUp: 6, reorderDown: 7, toggleOff: 8, toggleOn: 9, clear: 10, undo: 11, redo: 12, recipeApply: 13 },
    preview: previewEvidence,
    fullCropZoom2: { output: croppedEvidence, parameters: croppedImage.processingStack[1].parameters },
    fullCropZoom15: { output: recroppedEvidence, parameters: recroppedImage.processingStack[1].parameters },
    alphaPreserved: croppedEvidence.transparent > 0 || croppedEvidence.semiTransparent > 0,
    outputHashes: {
      adjust: adjustedEvidence.pixelHash,
      cropZoom2: croppedEvidence.pixelHash,
      cropZoom15: recroppedEvidence.pixelHash,
      mask: maskedEvidence.pixelHash,
      reorderUp: reorderedUpEvidence.pixelHash,
      reorderDown: reorderedDownEvidence.pixelHash,
    },
    recipe: { bytes: recipeBytes.length, sha256: hashBytes(recipeBytes), stepTypes: recipe.steps.map((step) => step.type) },
    finalParameters: reappliedImage.processingStack.map((step) => step.parameters ?? { maskRecipe: true }),
  })

  log('phase batch atomic lock')
  await selectOnly('image-alpha-a')
  await waitForEffectsSection()
  await effectsSection().getByRole('button', { name: '清空效果', exact: true }).click()
  const batchBase = await waitForWorkspaceRevision(14)
  await selectOnly('image-alpha-a')
  await addSelection('image-alpha-b')
  await effectsSection().getByRole('button', { name: '应用配方到所选 2 张', exact: true }).click()
  const batchApplied = await waitForWorkspaceRevision(15)
  const batchA = batchApplied.document.elements.find((element) => element.id === 'image-alpha-a')
  const batchB = batchApplied.document.elements.find((element) => element.id === 'image-alpha-b')
  assert.equal(batchA.processingStack.length, 3)
  assert.equal(batchB.processingStack.length, 3)
  assert.notDeepEqual({ width: batchA.naturalWidth, height: batchA.naturalHeight }, { width: batchB.naturalWidth, height: batchB.naturalHeight })
  await selectOnly('image-alpha-a')
  await addSelection('image-alpha-b')
  await page.getByRole('tab', { name: '图层', exact: true }).click()
  await page.getByRole('button', { name: '锁定Alpha B', exact: true }).click()
  const lockedBatch = await waitForWorkspaceRevision(16)
  await page.getByRole('tab', { name: '编辑', exact: true }).click()
  await page.waitForTimeout(500)
  const atomicPersistenceBefore = persistenceRequests.length
  const atomicBefore = await readWorkspaceDocument()
  const atomicAHash = summarizeImage(atomicBefore.document, 'image-alpha-a').srcHash
  const atomicBHash = summarizeImage(atomicBefore.document, 'image-alpha-b').srcHash
  await effectsSection().getByRole('button', { name: '应用配方到所选 2 张', exact: true }).click()
  await waitForToast(/图片已移除或锁定/u)
  await delay(300)
  const atomicAfter = await readWorkspaceDocument()
  assert.equal(atomicAfter.document.revision, atomicBefore.document.revision)
  assert.equal(summarizeImage(atomicAfter.document, 'image-alpha-a').srcHash, atomicAHash)
  assert.equal(summarizeImage(atomicAfter.document, 'image-alpha-b').srcHash, atomicBHash)
  assert.equal(persistenceRequests.length, atomicPersistenceBefore, 'Locked batch must not issue a partial document commit')
  await page.getByRole('tab', { name: '图层', exact: true }).click()
  await page.getByRole('button', { name: '解锁Alpha B', exact: true }).click()
  const unlockedBatch = await waitForWorkspaceRevision(17)
  report.phases.push({
    name: 'two-size-batch-single-commit-and-locked-atomic-rejection',
    status: 'passed',
    batchRevision: batchApplied.document.revision,
    imageOutputs: {
      alphaA: { width: batchA.naturalWidth, height: batchA.naturalHeight, hash: summarizeImage(batchApplied.document, 'image-alpha-a').srcHash },
      alphaB: { width: batchB.naturalWidth, height: batchB.naturalHeight, hash: summarizeImage(batchApplied.document, 'image-alpha-b').srcHash },
    },
    singleCommit: true,
    lockRejection: { revisionUnchanged: true, partialOutput: false, lockedRevision: lockedBatch.document.revision, unlockedRevision: unlockedBatch.document.revision },
  })

  log('phase legacy crop height and batch budget preflight')
  await selectOnly('image-old-crop')
  const oldCropBefore = await readWorkspaceDocument()
  const oldCropImageBefore = oldCropBefore.document.elements.find((element) => element.id === 'image-old-crop')
  assert.equal(oldCropImageBefore.processingStack[0].parameters, undefined)
  await effectsSection().getByRole('button', { name: '清空效果', exact: true }).click()
  const oldCropCleared = await waitForWorkspaceRevision(oldCropBefore.document.revision + 1)
  const oldCropImageAfter = oldCropCleared.document.elements.find((element) => element.id === 'image-old-crop')
  assert.equal(oldCropImageAfter.processingStack.length, 0)
  assert.equal(oldCropImageAfter.src, oldCropImageAfter.sourceSrc)
  assert.equal(oldCropImageAfter.naturalWidth, fixtures.alpha.width)
  assert.equal(oldCropImageAfter.naturalHeight, fixtures.alpha.height)
  assert.equal(oldCropImageAfter.height, oldCropImageAfter.width * fixtures.alpha.height / fixtures.alpha.width)

  const budgetIds = Array.from({ length: 33 }, (_, index) => `image-budget-${String(index + 1).padStart(2, '0')}`)
  await selectOnly('image-budget-01')
  await marqueeSelectElements(budgetIds)
  const budgetIdSet = new Set(budgetIds)
  const selectedExtras = await page.locator('[data-canvas-element].is-selected').evaluateAll((elements, allowed) => elements
    .map((element) => element.getAttribute('data-element-id'))
    .filter((id) => id && !allowed.includes(id)), [...budgetIdSet])
  for (const id of selectedExtras) {
    await page.locator(`[data-canvas-element][data-element-id="${id}"]`).click({ modifiers: ['Shift'], force: true })
  }
  await page.waitForFunction((expected) => document.querySelectorAll('[data-canvas-element].is-selected').length === expected, budgetIds.length, { timeout: 5_000 })
  const budgetBefore = await readWorkspaceDocument()
  const budgetSourceHashes = Array.from({ length: 33 }, (_, index) => summarizeImage(budgetBefore.document, `image-budget-${String(index + 1).padStart(2, '0')}`).srcHash)
  const budgetPutCount = persistenceRequests.length
  await effectsSection().getByRole('button', { name: '应用配方到所选 33 张', exact: true }).click()
  await waitForToast(/批量效果超过 3200万输入像素/u)
  await delay(300)
  const budgetAfter = await readWorkspaceDocument()
  assert.equal(budgetAfter.document.revision, budgetBefore.document.revision)
  for (let index = 1; index <= 33; index += 1) {
    const summary = summarizeImage(budgetAfter.document, `image-budget-${String(index).padStart(2, '0')}`)
    assert.equal(summary.srcHash, budgetSourceHashes[index - 1])
    assert.equal(summary.steps.length, 0)
  }
  assert.equal(persistenceRequests.length, budgetPutCount, 'Budget preflight rejection must not persist a partial batch')
  report.phases.push({
    name: 'legacy-crop-clear-restores-source-ratio-and-33-image-budget-preflight',
    status: 'passed',
    oldCrop: {
      revision: oldCropCleared.document.revision,
      sourceDimensions: { width: fixtures.alpha.width, height: fixtures.alpha.height },
      restoredCanvasHeight: oldCropImageAfter.height,
    },
    budget: {
      selectedImages: 33,
      naturalDimensions: { width: fixtures.budget.width, height: fixtures.budget.height },
      inputPixels: 33 * fixtures.budget.width * fixtures.budget.height,
      rejection: '批量效果超过 3200万输入像素或1.28亿处理像素，请减少图片或效果步骤后分批应用',
      revisionUnchanged: true,
      partialCommit: false,
    },
  })

  log('phase cancellation read failure revision conflict')
  await selectOnly('image-slow')
  const cancelBefore = await readWorkspaceDocument()
  const cancelBeforeSteps = summarizeImage(cancelBefore.document, 'image-slow').steps
  armSlowLatch()
  const cancelApply = effectsSection().getByRole('button', { name: '应用配方到所选 1 张', exact: true })
  await cancelApply.click()
  const busyStatus = page.getByRole('status').filter({ hasText: '正在重放效果' }).last()
  await busyStatus.waitFor({ state: 'visible', timeout: 5_000 })
  await waitForSlowPending()
  assert.equal(await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')]
      .find((element) => element.textContent?.trim() === '取消效果处理')
    if (!button) return false
    button.click()
    return true
  }), true, 'Cancel button disappeared before the synchronous click')
  await releaseSlowLatch()
  await busyStatus.waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => undefined)
  await delay(250)
  const cancelled = await readWorkspaceDocument()
  assert.equal(cancelled.document.revision, cancelBefore.document.revision)
  assert.deepEqual(summarizeImage(cancelled.document, 'image-slow').steps, cancelBeforeSteps)

  await selectOnly('image-broken')
  const failedBefore = await readWorkspaceDocument()
  const failedDialog = await openImageLab('裁剪')
  await failedDialog.getByRole('button', { name: '生成草稿', exact: true }).click()
  await failedDialog.getByRole('alert').filter({ hasText: '无法读取当前图片' }).waitFor({ state: 'visible', timeout: 20_000 })
  const failedAfter = await readWorkspaceDocument()
  assert.equal(failedAfter.document.revision, failedBefore.document.revision)
  await closeImageLab(failedDialog)

  await selectOnly('image-slow')
  const conflictBefore = await readWorkspaceDocument()
  const conflictBeforeSteps = summarizeImage(conflictBefore.document, 'image-slow').steps
  armSlowLatch()
  await effectsSection().getByRole('button', { name: '应用配方到所选 1 张', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '正在重放效果' }).last().waitFor({ state: 'visible', timeout: 5_000 })
  await waitForSlowPending()
  await page.getByRole('tab', { name: '图层', exact: true }).click()
  assert.equal(await page.evaluate(() => {
    const button = document.querySelector('button[aria-label="锁定Alpha B"]')
    if (!button) return false
    button.click()
    return true
  }), true, 'Lock button disappeared before concurrent revision click')
  const conflictRevision = await waitForWorkspaceRevision(conflictBefore.document.revision + 1)
  await releaseSlowLatch()
  await page.getByRole('tab', { name: '编辑', exact: true }).click()
  await waitForToast(/处理期间文档已变化/u)
  await delay(200)
  const conflictAfter = await readWorkspaceDocument()
  assert.deepEqual(summarizeImage(conflictAfter.document, 'image-slow').steps, conflictBeforeSteps)
  assert.equal(conflictAfter.document.revision, conflictRevision.document.revision)
  await page.getByRole('tab', { name: '图层', exact: true }).click()
  await page.getByRole('button', { name: '解锁Alpha B', exact: true }).click()
  await waitForWorkspaceRevision(conflictAfter.document.revision + 1)
  report.phases.push({
    name: 'cancel-read-failure-and-processing-revision-conflict',
    status: 'passed',
    cancellation: { revisionUnchanged: true, imageStepCount: cancelBeforeSteps.length, cacheUnchanged: true },
    readFailure: { revisionUnchanged: true, message: '无法读取当前图片' },
    revisionConflict: { revisionAfterConcurrentLock: conflictAfter.document.revision, slowImageUnchanged: true, partialCommit: false },
  })

  log('phase package persistence and responsive')
  const exportedProject = await exportProjectPackage()
  assert.match(exportedProject.download.suggestedFilename(), /\.miaohui$/iu)
  const projectImportInput = page.locator('input[type="file"][accept*=".miaohui"]')
  await projectImportInput.setInputFiles(exportedProject.path)
  await page.getByRole('status').filter({ hasText: /兼容包|项目/u }).last().waitFor({ state: 'visible', timeout: 20_000 }).catch(() => undefined)
  const importedProject = await waitForWorkspaceDocument((document) => {
    const image = document.elements.find((element) => element.id === 'image-alpha-a')
    return Boolean(image?.processingStack?.some((step) => step.parameters?.kind === 'adjust' && step.parameters.brightness === 130))
  })
  const importedA = summarizeImage(importedProject.document, 'image-alpha-a')
  assert.ok(importedA.steps.some((step) => step.parameters?.kind === 'adjust'))
  assert.ok(importedA.steps.some((step) => step.hasMaskRecipe))
  await page.screenshot({ path: desktopScreenshotPath, fullPage: true })
  const desktopOverflow = await assertNoHorizontalOverflow()
  assert.ok(desktopOverflow.documentScrollWidth <= desktopOverflow.viewport, JSON.stringify(desktopOverflow))
  assert.ok(desktopOverflow.bodyScrollWidth <= desktopOverflow.viewport, JSON.stringify(desktopOverflow))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(300)
  const mobileOverflow = await assertNoHorizontalOverflow()
  assert.ok(mobileOverflow.documentScrollWidth <= mobileOverflow.viewport, JSON.stringify(mobileOverflow))
  assert.ok(mobileOverflow.bodyScrollWidth <= mobileOverflow.viewport, JSON.stringify(mobileOverflow))
  await page.screenshot({ path: mobileScreenshotPath, fullPage: true })
  await page.setViewportSize({ width: 1440, height: 900 })
  await returnAndReopen()
  const reopened = await waitForWorkspaceDocument((document) => {
    const image = document.elements.find((element) => element.id === 'image-alpha-a')
    return Boolean(image?.processingStack?.some((step) => step.parameters?.kind === 'adjust') && image.processingStack.some((step) => step.maskRecipe))
  })
  assert.equal(reopened.document.id, documentId)
  assert.ok(summarizeImage(reopened.document, 'image-alpha-a').steps.some((step) => step.hasMaskRecipe))
  report.responsive = { desktop: desktopOverflow, mobile: mobileOverflow }
  report.persistence = {
    workspacePutCount: persistenceRequests.length,
    failedRequests: persistenceRequests.filter((request) => request.status >= 400),
    finalRevision: reopened.document.revision,
    projectPackage: { filename: exportedProject.download.suggestedFilename(), bytes: exportedProject.bytes.length, sha256: hashBytes(exportedProject.bytes) },
    reopened: { documentId: reopened.document.id, imageParametersAndMaskRetained: true },
  }
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(consoleErrors, [])
  report.pageErrors = pageErrors
  report.consoleErrors = consoleErrors
  report.consoleWarnings = consoleWarnings
  report.requestFailures = requestFailures
  report.status = 'passed'
} catch (error) {
  report.error = { name: error?.name, message: error?.message, stack: error?.stack }
  report.persistenceRequests = persistenceRequests
  report.pageState = await page?.evaluate((id) => ({
    localStorage: Object.fromEntries(Object.entries(localStorage)
      .filter(([key]) => key.includes(id))
      .map(([key, value]) => {
        try { return [key, { revision: JSON.parse(value).revision }] } catch { return [key, { invalid: true }] }
      })),
    saveStatus: document.querySelector('.save-status')?.textContent ?? null,
  }), documentId).catch(() => null)
  try {
    if (page) await page.screenshot({ path: failureScreenshotPath, fullPage: true })
  } catch {
    // Preserve the original validation error when diagnostics cannot be captured.
  }
} finally {
  report.pageErrors = pageErrors
  report.consoleErrors = consoleErrors
  report.consoleWarnings = consoleWarnings
  report.requestFailures = requestFailures
  await browser?.close().catch(() => undefined)
  await bridge?.stop({ keepRuntime: false }).catch(() => undefined)
  await mkdir(artifactDirectory, { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await writeFile(logPath, `${logLines.join('\n')}\n`, 'utf8')
}

if (report.status !== 'passed') throw new Error(report.error?.message ?? 'Image effects UI validation failed')
console.log(`✓ Image effects UI validation passed; report ${reportPath}`)
