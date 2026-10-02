import assert from 'node:assert/strict'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { startIsolatedBridge } from './qa-runtime.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const artifactDirectory = join(projectRoot, '.runtime', 'qa')
const reportPath = join(artifactDirectory, 'pixel-first-round-ui.json')
const logPath = join(artifactDirectory, 'pixel-first-round-ui.log')
const desktopScreenshotPath = join(artifactDirectory, 'pixel-first-round-desktop.png')
const mobileScreenshotPath = join(artifactDirectory, 'pixel-first-round-mobile.png')
const sourcePngName = 'pixel-first-round-source.png'
const projectTitle = 'PIXEL-FIRST-ROUND UI'
const EDGE_PATHS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]
const bridgeExecutableArgument = process.argv.find((argument) => argument.startsWith('--bridge-executable='))
const bridgeExecutableRaw = bridgeExecutableArgument?.slice('--bridge-executable='.length) ?? null

if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/validate-pixel-first-round-ui.mjs [--bridge-executable=<absolute exe path>]')
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
  kind: 'aeonquill.qa.pixel-first-round-ui',
  status: 'failed',
  generatedAt: new Date().toISOString(),
  browser: 'Microsoft Edge via Playwright',
  browserPlugin: { available: false, fallbackReason: 'Browser plugin and browser skill are not listed; used existing Playwright with system Edge.' },
  bridge: { runtime: 'startIsolatedBridge', type: bridgeType, file: bridgeFile, baseUrl: null },
  project: null,
  source: null,
  phases: [],
  worker: null,
  issues: [],
  screenshots: [desktopScreenshotPath, mobileScreenshotPath],
  error: null,
}

const logLines = []
const issues = []
const persistenceRequests = []
let bridge
let browser
let context
let page

function log(message) {
  logLines.push(`${new Date().toISOString()} ${message}`)
  console.log(message)
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

function fnv1a(bytes) {
  let hash = 0x811c9dc5
  for (const byte of bytes) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function textHash(value) {
  return fnv1a(new TextEncoder().encode(value))
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
  const size = Buffer.alloc(4)
  size.writeUInt32BE(data.length, 0)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0)
  return Buffer.concat([size, typeBytes, data, checksum])
}

function createFixturePng() {
  const width = 4
  const height = 4
  const rgba = [
    [0, 0, 0, 0], [230, 70, 50, 255], [40, 180, 100, 128], [50, 100, 230, 255],
    [250, 210, 40, 255], [210, 50, 190, 100], [0, 0, 0, 0], [40, 190, 220, 255],
    [20, 30, 40, 255], [120, 60, 190, 180], [220, 120, 40, 255], [90, 200, 80, 255],
    [0, 0, 0, 0], [230, 90, 150, 140], [60, 90, 210, 255], [250, 250, 250, 255],
  ]
  const raw = Buffer.alloc(height * (width * 4 + 1))
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (width * 4 + 1)
    raw[rowOffset] = 0
    for (let x = 0; x < width; x += 1) {
      const pixel = rgba[y * width + x]
      Buffer.from(pixel).copy(raw, rowOffset + 1 + x * 4)
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  header[10] = 0
  header[11] = 0
  header[12] = 0
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
    rgbaStats: {
      pixels: rgba.length,
      transparent: rgba.filter((pixel) => pixel[3] === 0).length,
      semiTransparent: rgba.filter((pixel) => pixel[3] > 0 && pixel[3] < 255).length,
      opaque: rgba.filter((pixel) => pixel[3] === 255).length,
    },
  }
}

async function findEdgePath() {
  for (const candidate of EDGE_PATHS) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // Continue through the standard Windows Edge locations.
    }
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

async function findWorkspaceProject() {
  const payload = await requestJson('/api/workspace/catalog')
  const project = payload.catalog?.projects?.find((candidate) => candidate.title === projectTitle)
  assert.ok(project, `Created project ${projectTitle} was not persisted in the catalog`)
  const registration = project.documents?.find((candidate) => candidate.modeId === 'pixel')
  assert.ok(registration, 'Created pixel document registration was not persisted')
  return { project, registration }
}

async function readWorkspaceDocument(projectId, documentId) {
  const payload = await requestJson(`/api/workspace/documents/${encodeURIComponent(documentId)}?projectId=${encodeURIComponent(projectId)}&modeId=pixel`)
  const record = payload.document
  assert.ok(record?.value, 'Workspace response did not contain a document value')
  return { record, document: JSON.parse(record.value) }
}

async function waitForWorkspaceRevision(projectId, documentId, expectedRevision, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  let latest
  while (Date.now() < deadline) {
    latest = await readWorkspaceDocument(projectId, documentId)
    if (latest.record.revision === expectedRevision && latest.document.revision === expectedRevision) return latest
    await delay(120)
  }
  throw new Error(`Workspace document did not reach revision ${expectedRevision}; latest ${latest?.record?.revision}`)
}

function documentSummary(document) {
  const frames = document.frames.map((frame) => ({
    id: frame.id,
    celHashes: Object.fromEntries(Object.entries(frame.cels).map(([layerId, cells]) => [layerId, textHash(JSON.stringify(cells))])),
    nonEmpty: Object.values(frame.cels).reduce((total, cells) => total + cells.filter(Boolean).length, 0),
  }))
  return {
    id: document.id,
    revision: document.revision,
    width: document.width,
    height: document.height,
    paletteSize: document.palette.length,
    semiTransparentPalette: document.palette.filter((color) => !color.color.endsWith('FF')).map((color) => ({ id: color.id, alpha: color.color.slice(7) })),
    frames: frames.map(({ id, nonEmpty }) => ({ id, nonEmpty })),
    frameCount: frames.length,
    frameHash: textHash(JSON.stringify(frames)),
    terrainMaps: document.terrainMaps.map((map) => ({ id: map.id, width: map.width, height: map.height, cells: map.cells.filter(Boolean).length })),
    metadataHash: textHash(JSON.stringify({
      animationTags: document.animationTags,
      animationEvents: document.animationEvents,
      onionSkin: document.onionSkin,
      activeLayerId: document.activeLayerId,
      activeFrameId: document.activeFrameId,
    })),
  }
}

function revisionFromText(text) {
  const match = /revision\s+(\d+)/u.exec(text ?? '')
  return match ? Number(match[1]) : null
}

async function uiRevision() {
  return revisionFromText(await page.locator('.aq-pixel-document-title small').textContent())
}

async function waitForUiRevision(expectedRevision, timeout = 10_000) {
  await page.waitForFunction((expected) => {
    const value = document.querySelector('.aq-pixel-document-title small')?.textContent ?? ''
    const match = /revision\s+(\d+)/u.exec(value)
    return match ? Number(match[1]) === expected : false
  }, expectedRevision, { timeout })
}

async function waitForStatus(pattern, timeout = 10_000) {
  await page.getByRole('status').filter({ hasText: pattern }).last().waitFor({ state: 'visible', timeout })
}

async function canvasAndDimensions() {
  const canvas = page.locator('canvas[aria-label*="像素绘制区"]').first()
  await canvas.waitFor({ state: 'visible', timeout: 15_000 })
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

async function dragCanvasCells(cells) {
  const info = await canvasAndDimensions()
  const first = canvasCellPoint(info, cells[0].x, cells[0].y)
  await page.mouse.move(first.x, first.y)
  await page.mouse.down()
  for (const cell of cells.slice(1)) {
    const point = canvasCellPoint(info, cell.x, cell.y)
    await page.mouse.move(point.x, point.y, { steps: 4 })
  }
  await page.mouse.up()
}

async function canvasPixel(x, y) {
  return page.evaluate(({ x: pixelX, y: pixelY }) => {
    const canvas = document.querySelector('canvas[aria-label*="像素绘制区"]')
    const data = canvas?.getContext('2d')?.getImageData(pixelX, pixelY, 1, 1).data
    return data ? Array.from(data) : null
  }, { x, y })
}

function activeCel(document) {
  const frame = document.frames.find((candidate) => candidate.id === document.activeFrameId)
  assert.ok(frame, `Active frame ${document.activeFrameId} is missing`)
  return frame.cels[document.activeLayerId]
}

function cellColor(document, x, y) {
  return activeCel(document)[y * document.width + x]
}

async function workerTelemetry() {
  return page.evaluate(() => {
    const value = globalThis.__pixelFirstRoundWorker
    return value ? {
      created: value.created,
      terminated: value.terminated,
      posts: value.posts.slice(-20),
      responses: value.responses.slice(-20),
      delayMs: value.delayMs,
    } : null
  })
}

async function waitForWorkerRequest(operation, timeout = 10_000, afterPostCount = 0) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const telemetry = await workerTelemetry()
    const request = telemetry?.posts?.slice(afterPostCount).find((entry) => entry.operation === operation)
    if (request) return request
    await delay(50)
  }
  throw new Error(`Worker request ${operation} was not observed`)
}

async function waitForWorkerTermination(previousTerminated, timeout = 5_000) {
  const deadline = Date.now() + timeout
  let latest = await workerTelemetry()
  while (Date.now() < deadline) {
    latest = await workerTelemetry()
    if ((latest?.terminated ?? 0) > previousTerminated) return latest
    await delay(50)
  }
  throw new Error(`Active conversion Worker was not terminated after document change: ${JSON.stringify({ previousTerminated, latest })}`)
}

async function setWorkerDelay(delayMs) {
  await page.evaluate((value) => {
    if (globalThis.__pixelFirstRoundWorker) globalThis.__pixelFirstRoundWorker.delayMs = value
  }, delayMs)
}

async function createProjectThroughUi() {
  await page.locator('.aq-home-header').getByRole('button', { name: '创建新项目', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '创建新项目', exact: true })
  await dialog.waitFor({ state: 'visible' })
  await dialog.getByPlaceholder('输入项目名称').fill(projectTitle)
  const pixelOption = dialog.getByRole('button', { name: /像素模式 精细像素绘制与动画/u })
  await pixelOption.click()
  assert.equal(await pixelOption.getAttribute('aria-pressed'), 'true')
  await dialog.getByRole('button', { name: '创建并进入', exact: true }).click()
  await dialog.waitFor({ state: 'hidden', timeout: 15_000 })
  await page.getByLabel(/像素绘制区/u).waitFor({ state: 'visible', timeout: 20_000 })
}

async function assertNoHorizontalOverflow() {
  return page.evaluate(() => ({
    viewport: window.innerWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    viewportHeight: window.innerHeight,
  }))
}

function observePage(target) {
  target.on('pageerror', (error) => issues.push(`pageerror: ${error.message}`))
  target.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') issues.push(`${message.type()}: ${message.text()}`)
  })
  target.on('response', (response) => {
    if (response.request().method() === 'PUT' && response.url().includes('/api/workspace/documents/')) {
      persistenceRequests.push({ status: response.status(), url: response.url() })
    }
  })
  target.on('requestfailed', (request) => {
    if (request.url().includes('/api/workspace/documents/')) persistenceRequests.push({ status: 'failed', url: request.url(), error: request.failure()?.errorText ?? 'request failed' })
  })
}

async function setNativeColorInput(value) {
  await page.evaluate((nextValue) => {
    const input = document.querySelector('.aq-pixel-color-edit input[type="color"]')
    if (!(input instanceof HTMLInputElement)) throw new Error('Active palette color input is missing')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (!setter) throw new Error('Native color input value setter is unavailable')
    setter.call(input, nextValue)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, value)
}

const edgePath = await findEdgePath()
if (!edgePath) throw new Error('Microsoft Edge executable was not found in standard Windows locations')

try {
  await mkdir(artifactDirectory, { recursive: true })
  bridge = await startIsolatedBridge('pixel-first-round-ui', {
    comfyPolicy: 'manual',
    ...(bridgeExecutable ? { executablePath: bridgeExecutable } : {}),
  })
  report.bridge.baseUrl = bridge.baseUrl
  const fixture = createFixturePng()
  const fixturePath = join(bridge.runtimeDirectory, sourcePngName)
  await writeFile(fixturePath, fixture.bytes)
  report.source = { filename: sourcePngName, width: fixture.width, height: fixture.height, bytes: fixture.bytes.length, hash: fnv1a(fixture.bytes), rgbaStats: fixture.rgbaStats }

  browser = await chromium.launch({ headless: true, executablePath: edgePath, args: ['--disable-gpu'] })
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })
  page = await context.newPage()
  await page.addInitScript(() => {
    const NativeWorker = globalThis.Worker
    const telemetry = { created: 0, terminated: 0, posts: [], responses: [], delayMs: 0 }
    globalThis.__pixelFirstRoundWorker = telemetry
    if (typeof NativeWorker !== 'function') return
    const descriptor = Object.getOwnPropertyDescriptor(NativeWorker.prototype, 'onmessage')
    globalThis.Worker = class PixelFirstRoundWorker extends NativeWorker {
      constructor(...args) {
        super(...args)
        telemetry.created += 1
        const workerIndex = telemetry.created
        telemetry.posts.push({ type: 'created', workerIndex, url: String(args[0] ?? '') })
        this.addEventListener('message', (event) => {
          const data = event?.data
          if (!data || typeof data.operation !== 'string') return
          telemetry.responses.push({
            workerIndex,
            ok: data.ok === true,
            operation: data.operation,
            requestId: data.requestId,
            revision: data.revision,
            error: data.error?.code ?? null,
          })
        })
      }

      set onmessage(handler) {
        const wrapped = typeof handler === 'function'
          ? (event) => {
              const wait = Number(telemetry.delayMs) || 0
              if (wait > 0) setTimeout(() => handler.call(this, event), wait)
              else handler.call(this, event)
            }
          : handler
        descriptor?.set?.call(this, wrapped)
      }

      get onmessage() {
        return descriptor?.get?.call(this) ?? null
      }

      postMessage(message, transfer) {
        if (message && typeof message === 'object' && typeof message.operation === 'string') {
          telemetry.posts.push({ type: 'request', operation: message.operation, requestId: message.requestId, revision: message.revision })
        }
        return super.postMessage(message, transfer)
      }

      terminate() {
        telemetry.terminated += 1
        return super.terminate()
      }
    }
  })
  observePage(page)
  await page.goto(bridge.baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
  assert.ok((await page.title()).length > 0, 'Browser page title is empty')
  assert.equal(await page.evaluate(() => Boolean(document.querySelector('vite-error-overlay,#webpack-dev-server-client-overlay'))), false)

  await createProjectThroughUi()
  const created = await findWorkspaceProject()
  report.project = { projectId: created.project.id, documentId: created.registration.id, title: projectTitle }
  const initialState = await waitForWorkspaceRevision(created.project.id, created.registration.id, 0)
  assert.equal(initialState.document.width, 16)
  assert.equal(initialState.document.height, 16)

  const toolbar = page.locator('.aq-pixel-toolbar')
  const stageControls = page.locator('.aq-pixel-stage-controls')
  const pixelPerfectButton = stageControls.getByRole('button', { name: '像素完美笔触', exact: true })
  assert.equal(await toolbar.getByRole('button', { name: /铅笔/u }).getAttribute('class'), 'is-active')
  assert.equal(await stageControls.locator('select').first().inputValue(), '1')
  assert.equal(await pixelPerfectButton.getAttribute('aria-pressed'), 'true')
  assert.equal(await pixelPerfectButton.isDisabled(), false)

  const firstBeforeRevision = await uiRevision()
  const firstInfo = await canvasAndDimensions()
  const firstCells = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]
  const firstPoints = firstCells.map((cell) => canvasCellPoint(firstInfo, cell.x, cell.y))
  const firstHit = await page.evaluate(({ x, y }) => {
    const canvas = document.querySelector('canvas[aria-label*="像素绘制区"]')
    const hit = document.elementFromPoint(x, y)
    const sample = canvas?.getContext('2d')?.getImageData(3, 12, 1, 1).data
    return {
      point: { x, y },
      canvas: canvas ? { width: canvas.width, height: canvas.height, rect: canvas.getBoundingClientRect().toJSON() } : null,
      hit: hit ? { tag: hit.tagName, aria: hit.getAttribute('aria-label'), className: hit.className } : null,
      knownStarterPixel: sample ? Array.from(sample) : null,
    }
  }, firstPoints[0])
  await page.mouse.move(firstPoints[0].x, firstPoints[0].y)
  await page.mouse.down()
  await page.mouse.move(firstPoints[1].x, firstPoints[1].y, { steps: 5 })
  await page.mouse.move(firstPoints[2].x, firstPoints[2].y, { steps: 5 })
  await delay(80)
  assert.equal(await uiRevision(), firstBeforeRevision, 'Pointer preview must not advance document revision before mouseup')
  const previewMiddle = await canvasPixel(1, 0)
  const previewStart = await canvasPixel(0, 0)
  const previewEnd = await canvasPixel(1, 1)
  const previewCanvases = await page.evaluate(() => [...document.querySelectorAll('canvas')].map((canvas) => ({
    label: canvas.getAttribute('aria-label'),
    width: canvas.width,
    height: canvas.height,
    rect: canvas.getBoundingClientRect().toJSON(),
    pixels: Array.from(canvas.getContext('2d')?.getImageData(0, 0, Math.min(2, canvas.width), Math.min(2, canvas.height)).data ?? []),
  })))
  assert.ok(previewMiddle && previewMiddle[3] === 0, `Pixel-perfect preview retained middle pixel: ${JSON.stringify({ previewMiddle, previewStart, previewEnd })}`)
  assert.ok(previewStart && previewStart[3] > 0, `Pixel-perfect preview lost stroke start: ${JSON.stringify({ previewMiddle, previewStart, previewEnd, firstHit, previewCanvases })}`)
  assert.ok(previewEnd && previewEnd[3] > 0, `Pixel-perfect preview lost stroke end: ${JSON.stringify({ previewMiddle, previewStart, previewEnd, firstHit, previewCanvases })}`)
  await page.mouse.up()
  await waitForUiRevision(1)
  const firstApplied = await waitForWorkspaceRevision(created.project.id, created.registration.id, 1)
  assert.equal(cellColor(firstApplied.document, 0, 0) !== null, true)
  assert.equal(cellColor(firstApplied.document, 1, 0), null)
  assert.equal(cellColor(firstApplied.document, 1, 1) !== null, true)
  const firstPaintHash = documentSummary(firstApplied.document).frameHash
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await waitForUiRevision(2)
  const firstUndone = await waitForWorkspaceRevision(created.project.id, created.registration.id, 2)
  assert.equal(cellColor(firstUndone.document, 0, 0), null)
  assert.equal(cellColor(firstUndone.document, 1, 1), null)
  await page.getByRole('button', { name: '重做', exact: true }).click()
  await waitForUiRevision(3)
  const firstRedone = await waitForWorkspaceRevision(created.project.id, created.registration.id, 3)
  assert.equal(documentSummary(firstRedone.document).frameHash, firstPaintHash)
  report.phases.push({ name: 'default-pixel-perfect-stroke', status: 'passed', revisionBeforeMouseup: 0, revisionAfterCommit: 1, paintedPixelsAfterCommit: 2, undoRevision: 2, redoRevision: 3, previewMiddleAlpha: previewMiddle?.[3] ?? null })

  await page.getByRole('button', { name: '返回光阴砚主页', exact: true }).click()
  await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
  await page.locator('.aq-project-row-main').filter({ hasText: projectTitle }).click()
  await page.getByLabel(/像素绘制区/u).waitFor({ state: 'visible', timeout: 15_000 })
  await waitForUiRevision(3)
  const reopenedBefore = await waitForWorkspaceRevision(created.project.id, created.registration.id, 3)
  const secondBeforeCount = activeCel(reopenedBefore.document).filter(Boolean).length
  await dragCanvasCells([{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }])
  await waitForUiRevision(4)
  const secondAfter = await waitForWorkspaceRevision(created.project.id, created.registration.id, 4)
  assert.equal(activeCel(secondAfter.document).filter(Boolean).length, secondBeforeCount + 1)
  const mirrorToggle = stageControls.getByRole('button', { name: /水平对称/u })
  await mirrorToggle.click()
  const mirrorBefore = await waitForWorkspaceRevision(created.project.id, created.registration.id, 4)
  const mirrorBeforeCount = activeCel(mirrorBefore.document).filter(Boolean).length
  await dragCanvasCells([{ x: 3, y: 2 }, { x: 4, y: 2 }, { x: 4, y: 3 }])
  await waitForUiRevision(5)
  const mirrorAfter = await waitForWorkspaceRevision(created.project.id, created.registration.id, 5)
  assert.equal(activeCel(mirrorAfter.document).filter(Boolean).length, mirrorBeforeCount + 4)
  await mirrorToggle.click()

  const brushSize = stageControls.locator('select').first()
  await brushSize.selectOption('2')
  assert.equal(await pixelPerfectButton.isDisabled(), true)
  await toolbar.getByRole('button', { name: /橡皮/u }).click()
  assert.equal(await pixelPerfectButton.isDisabled(), true)
  await toolbar.getByRole('button', { name: /铅笔/u }).click()
  await brushSize.selectOption('1')
  assert.equal(await pixelPerfectButton.isDisabled(), false)

  const cancelRevision = await uiRevision()
  const cancelInfo = await canvasAndDimensions()
  const cancelPoint = canvasCellPoint(cancelInfo, 6, 4)
  await page.mouse.move(cancelPoint.x, cancelPoint.y)
  await page.mouse.down()
  await page.mouse.move(cancelPoint.x + cancelInfo.box.width / cancelInfo.width, cancelPoint.y, { steps: 3 })
  await page.evaluate(() => document.querySelector('canvas[aria-label*="像素绘制区"]')?.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1 })))
  await page.mouse.up()
  await waitForStatus('笔触已取消')
  await delay(100)
  assert.equal(await uiRevision(), cancelRevision)
  const pointerCaptureState = await page.evaluate(() => {
    const canvas = document.querySelector('canvas[aria-label*="像素绘制区"]')
    return { pointerId1: canvas?.hasPointerCapture(1) ?? false }
  })
  assert.equal(pointerCaptureState.pointerId1, false, `Pointer capture remained after cancellation: ${JSON.stringify(pointerCaptureState)}`)
  const cancelledDocument = await waitForWorkspaceRevision(created.project.id, created.registration.id, Number(cancelRevision))
  assert.equal(documentSummary(cancelledDocument.document).frameHash, documentSummary(mirrorAfter.document).frameHash)
  report.phases.push({ name: 'reopen-mirror-cancel-controls', status: 'passed', reopenedRevision: 3, secondLTotalPixels: secondBeforeCount + 1, mirrorAddedPoints: 4, brushPixelPerfectDisabled: true, eraserPixelPerfectDisabled: true, pointerCancelRevision: Number(cancelRevision) })

  const importCard = page.getByLabel('PNG 与 WebP 确定性像素转换', { exact: true })
  const sourceInput = importCard.locator('input[type="file"]')
  await sourceInput.setInputFiles(fixturePath)
  await page.getByText(/4 × 4 RGBA/u).waitFor({ state: 'visible', timeout: 15_000 })
  const preset = importCard.getByLabel('转换档位', { exact: true })
  const presetSettings = {
    'pixel-art': { resample: 'nearest', colorMatch: 'rgb', alphaMode: 'threshold', dither: 'none' },
    illustration: { resample: 'area', colorMatch: 'oklab', alphaMode: 'threshold', dither: 'none' },
    'soft-alpha': { resample: 'area', colorMatch: 'oklab', alphaMode: 'preserve', dither: 'none' },
  }
  const selectFor = (label) => importCard.getByLabel(label, { exact: true })
  const selectByText = (text) => importCard.locator('.aq-pixel-import-select').filter({ hasText: text }).locator('select')
  const presetChecks = []
  for (const [id, settings] of Object.entries(presetSettings)) {
    await preset.selectOption(id)
    const actual = {
      resample: await selectFor('采样方式').inputValue(),
      colorMatch: await selectFor('颜色匹配').inputValue(),
      alphaMode: await selectFor('透明处理').inputValue(),
      dither: await selectByText('抖动').inputValue(),
    }
    assert.deepEqual(actual, settings)
    presetChecks.push({ id, actual })
  }
  await preset.selectOption('soft-alpha')
  await selectFor('宽').fill('2')
  await selectFor('高').fill('2')
  await selectFor('色数').fill('8')
  await selectFor('透明阈值').fill('16')
  await selectByText('缩放').selectOption('contain')
  await selectByText('调色板').selectOption('generated')
  const conversionBefore = await waitForWorkspaceRevision(created.project.id, created.registration.id, Number(cancelRevision))
  const conversionBeforeRevision = conversionBefore.document.revision
  const conversionBeforeSummary = documentSummary(conversionBefore.document)
  const workerBeforeConversion = await workerTelemetry()
  await setWorkerDelay(700)
  await importCard.getByRole('button', { name: '生成转换预览', exact: true }).click()
  await waitForWorkerRequest('image-convert', 10_000, workerBeforeConversion?.posts?.length ?? 0)
  await page.getByRole('button', { name: '取消计算', exact: true }).click()
  await waitForStatus(/像素(?:计算|转换)已取消/u)
  await delay(850)
  assert.equal(await page.getByLabel('像素转换候选', { exact: true }).count(), 0)
  assert.equal(await uiRevision(), conversionBeforeRevision)

  const workerBeforeParameterRun = await workerTelemetry()
  await importCard.getByRole('button', { name: '生成转换预览', exact: true }).click()
  await waitForWorkerRequest('image-convert', 10_000, workerBeforeParameterRun?.posts?.length ?? 0)
  const workerBeforeParameterAbort = await workerTelemetry()
  await selectByText('缩放').selectOption('cover')
  await delay(850)
  const workerAfterParameterAbort = await workerTelemetry()
  assert.equal(await page.getByLabel('像素转换候选', { exact: true }).count(), 0)
  assert.ok(
    (workerAfterParameterAbort?.terminated ?? 0) > (workerBeforeParameterAbort?.terminated ?? 0),
    `Changing conversion parameters did not terminate the stale Worker: ${JSON.stringify({ workerBeforeParameterAbort, workerAfterParameterAbort })}`,
  )
  await selectByText('缩放').selectOption('contain')

  await setWorkerDelay(700)
  const workerBeforeStaleRun = await workerTelemetry()
  await importCard.getByRole('button', { name: '生成转换预览', exact: true }).click()
  await waitForWorkerRequest('image-convert', 10_000, workerBeforeStaleRun?.posts?.length ?? 0)
  await dragCanvasCells([{ x: 7, y: 4 }])
  await waitForUiRevision(conversionBeforeRevision + 1)
  const workerAfterStaleAbort = await waitForWorkerTermination(workerBeforeStaleRun?.terminated ?? 0)
  await delay(850)
  assert.equal(await page.getByLabel('像素转换候选', { exact: true }).count(), 0)
  const staleChanged = await waitForWorkspaceRevision(created.project.id, created.registration.id, conversionBeforeRevision + 1)
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await waitForUiRevision(conversionBeforeRevision + 2)
  await waitForWorkspaceRevision(created.project.id, created.registration.id, conversionBeforeRevision + 2)
  await setWorkerDelay(0)

  const workerBeforeFinalRun = await workerTelemetry()
  await importCard.getByRole('button', { name: '生成转换预览', exact: true }).click()
  await waitForWorkerRequest('image-convert', 10_000, workerBeforeFinalRun?.posts?.length ?? 0)
  await page.getByLabel('像素转换候选', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
  await waitForStatus(/转换候选已生成/u)
  assert.equal(await uiRevision(), conversionBeforeRevision + 2)
  const candidate = page.getByLabel('像素转换候选', { exact: true })
  await candidate.getByLabel('像素转换预览', { exact: true }).waitFor({ state: 'visible' })
  const candidateStatus = await page.locator('.aq-pixel-status').textContent()
  assert.match(candidateStatus ?? '', /转换候选已生成/u)

  await selectByText('缩放').selectOption('cover')
  await page.waitForFunction(() => !document.querySelector('[aria-label="像素转换候选"]'))
  await selectByText('缩放').selectOption('contain')
  const workerBeforeCandidateRegeneration = await workerTelemetry()
  await importCard.getByRole('button', { name: '生成转换预览', exact: true }).click()
  await waitForWorkerRequest('image-convert', 10_000, workerBeforeCandidateRegeneration?.posts?.length ?? 0)
  await page.getByLabel('像素转换候选', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
  const beforeApply = await waitForWorkspaceRevision(created.project.id, created.registration.id, conversionBeforeRevision + 2)
  await candidate.getByRole('button', { name: '应用转换预览', exact: true }).click()
  await waitForUiRevision(conversionBeforeRevision + 3)
  const applied = await waitForWorkspaceRevision(created.project.id, created.registration.id, conversionBeforeRevision + 3)
  assert.equal(applied.document.id, beforeApply.document.id)
  assert.equal(applied.document.width, 2)
  assert.equal(applied.document.height, 2)
  assert.equal(applied.document.frames.length, 1)
  const semiColor = applied.document.palette.find((color) => !color.color.endsWith('FF'))
  assert.ok(semiColor, `Converted palette did not retain any semi-transparent color: ${JSON.stringify(documentSummary(applied.document))}`)
  const semiColorIndex = applied.document.palette.findIndex((color) => color.id === semiColor.id)
  const semiAlpha = semiColor.color.slice(7)

  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await waitForUiRevision(conversionBeforeRevision + 4)
  const conversionUndone = await waitForWorkspaceRevision(created.project.id, created.registration.id, conversionBeforeRevision + 4)
  assert.equal(conversionUndone.document.width, beforeApply.document.width)
  assert.equal(conversionUndone.document.height, beforeApply.document.height)
  assert.equal(conversionUndone.document.palette.length, beforeApply.document.palette.length)
  assert.equal(documentSummary(conversionUndone.document).frameHash, conversionBeforeSummary.frameHash)
  await page.getByRole('button', { name: '重做', exact: true }).click()
  await waitForUiRevision(conversionBeforeRevision + 5)
  const conversionRedone = await waitForWorkspaceRevision(created.project.id, created.registration.id, conversionBeforeRevision + 5)
  assert.equal(conversionRedone.document.width, 2)
  assert.equal(conversionRedone.document.height, 2)
  assert.equal(documentSummary(conversionRedone.document).frameHash, documentSummary(applied.document).frameHash)

  const swatches = page.getByRole('listbox', { name: '像素调色板', exact: true }).getByRole('option')
  await swatches.nth(semiColorIndex).click()
  await setNativeColorInput('#123456')
  await waitForUiRevision(conversionBeforeRevision + 6)
  const alphaChanged = await waitForWorkspaceRevision(created.project.id, created.registration.id, conversionBeforeRevision + 6)
  const changedSemi = alphaChanged.document.palette.find((color) => color.id === semiColor.id)
  assert.ok(changedSemi)
  assert.equal(changedSemi.color.slice(0, 7), '#123456')
  assert.equal(changedSemi.color.slice(7), semiAlpha)

  await dragCanvasCells([{ x: 1, y: 1 }])
  await waitForUiRevision(conversionBeforeRevision + 7)
  const afterDraw = await waitForWorkspaceRevision(created.project.id, created.registration.id, conversionBeforeRevision + 7)
  assert.equal(afterDraw.document.id, created.registration.id)
  const persistedBeforeReopen = documentSummary(afterDraw.document)
  await page.screenshot({ path: desktopScreenshotPath, fullPage: true })
  await page.getByRole('button', { name: '返回光阴砚主页', exact: true }).click()
  await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
  await page.locator('.aq-project-row-main').filter({ hasText: projectTitle }).click()
  await page.getByLabel(/像素绘制区/u).waitFor({ state: 'visible', timeout: 15_000 })
  await waitForUiRevision(conversionBeforeRevision + 7)
  const reopened = await waitForWorkspaceRevision(created.project.id, created.registration.id, conversionBeforeRevision + 7)
  assert.equal(documentSummary(reopened.document).frameHash, persistedBeforeReopen.frameHash)
  assert.equal(reopened.document.id, created.registration.id)
  const desktopOverflow = await assertNoHorizontalOverflow()

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(300)
  const mobileOverflow = await assertNoHorizontalOverflow()
  assert.ok(mobileOverflow.documentScrollWidth <= mobileOverflow.viewport, JSON.stringify(mobileOverflow))
  assert.ok(mobileOverflow.bodyScrollWidth <= mobileOverflow.viewport, JSON.stringify(mobileOverflow))
  await page.screenshot({ path: mobileScreenshotPath, fullPage: true })
  assert.ok(desktopOverflow.documentScrollWidth <= desktopOverflow.viewport, JSON.stringify(desktopOverflow))
  assert.ok(desktopOverflow.bodyScrollWidth <= desktopOverflow.viewport, JSON.stringify(desktopOverflow))

  const telemetry = await workerTelemetry()
  const imageConvertPosts = telemetry?.posts?.filter((entry) => entry.operation === 'image-convert') ?? []
  assert.ok(imageConvertPosts.length >= 4, `Expected real image-convert worker requests, saw ${imageConvertPosts.length}`)
  assert.ok(imageConvertPosts.every((entry) => typeof entry.requestId === 'string' && Number.isSafeInteger(entry.revision)))
  assert.ok(persistenceRequests.length >= 1, 'No workspace document persistence PUT was observed')
  report.worker = {
    created: telemetry?.created ?? null,
    terminated: telemetry?.terminated ?? null,
    imageConvertPosts: imageConvertPosts.slice(-8),
    imageConvertResponses: telemetry?.responses?.filter((entry) => entry.operation === 'image-convert').slice(-8) ?? [],
    payloadPolicy: 'Only operation/requestId/revision/status/error recorded; source/document payloads were not retained.',
  }
  report.project = {
    ...report.project,
    initial: documentSummary(initialState.document),
    persistedAfterFlow: documentSummary(reopened.document),
    persistencePutCount: persistenceRequests.length,
  }
  report.phases.push({
    name: 'png-conversion-preview-apply-mixed-history-persistence',
    status: 'passed',
    source: report.source,
    presetChecks,
    previewRevisionUnchanged: conversionBeforeRevision + 2,
    cancel: { status: 'passed', delayedResponseMs: 700 },
    parameterAbort: { status: 'passed', delayedResponseMs: 700, workerTerminated: true },
    staleDocumentDiscard: {
      status: 'passed',
      revisionAfterDraw: staleChanged.document.revision,
      candidateVisible: false,
      workerTerminated: true,
      terminatedBefore: workerBeforeStaleRun?.terminated ?? null,
      terminatedAfter: workerAfterStaleAbort?.terminated ?? null,
    },
    applied: documentSummary(applied.document),
    undo: documentSummary(conversionUndone.document),
    redo: documentSummary(conversionRedone.document),
    alphaPreserved: { paletteId: semiColor.id, before: semiAlpha, after: changedSemi.color.slice(7), rgbAfter: changedSemi.color.slice(0, 7) },
    saveReopen: { status: 'passed', revision: reopened.document.revision, id: reopened.document.id },
  })
  report.phases.push({ name: 'responsive-layout', status: 'passed', desktop: desktopOverflow, mobile: mobileOverflow })
  report.status = 'passed'
  report.issues = issues
  assert.deepEqual(issues, [], `Browser page/console issues: ${issues.join('; ')}`)
  log('PASS pixel-first-round UI flow')
} catch (error) {
  report.error = { name: error?.name ?? 'Error', message: error?.message ?? String(error) }
  report.issues = issues
  report.worker = await workerTelemetry().catch(() => null)
  report.error.page = await page?.evaluate(() => ({
    revision: document.querySelector('.aq-pixel-document-title small')?.textContent ?? null,
    status: document.querySelector('.aq-pixel-status')?.textContent ?? null,
    conversionButton: (() => {
      const button = [...document.querySelectorAll('button')].find((entry) => entry.textContent?.includes('生成转换预览'))
      return button ? {
        text: button.textContent?.trim() ?? null,
        disabled: button.disabled,
        rect: button.getBoundingClientRect().toJSON(),
      } : null
    })(),
    computationStatus: document.querySelector('.aq-pixel-computation-status')?.textContent?.slice(0, 180) ?? null,
  })).catch(() => null)
  log(`FAIL ${report.error.name}: ${report.error.message}`)
  if (page) {
    await page.screenshot({ path: desktopScreenshotPath, fullPage: true }).catch(() => undefined)
    await page.setViewportSize({ width: 390, height: 844 }).catch(() => undefined)
    await page.screenshot({ path: mobileScreenshotPath, fullPage: true }).catch(() => undefined)
  }
} finally {
  report.issues = issues
  await browser?.close().catch(() => undefined)
  await bridge?.stop({ keepRuntime: false }).catch(() => undefined)
  await mkdir(artifactDirectory, { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await writeFile(logPath, `${logLines.join('\n')}\n`, 'utf8')
}

if (report.status !== 'passed') throw new Error(report.error?.message ?? 'Pixel first-round UI validation failed')
console.log(`✓ Pixel first-round UI validation passed; report ${reportPath}`)
