import assert from 'node:assert/strict'
import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { startIsolatedBridge } from './qa-runtime.mjs'
import { createPixelDocument, renderPixelFrameRgba } from '../src/lib/pixel/pixelCore.mjs'
import { decodeAseprite, encodeAseprite, AsepriteFormatError } from '../src/lib/pixel/pixelAseprite.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const artifactDirectory = join(projectRoot, '.runtime', 'qa')
const reportPath = join(artifactDirectory, 'pixel-round-two-ui.json')
const logPath = join(artifactDirectory, 'pixel-round-two-ui.log')
const desktopScreenshotPath = join(artifactDirectory, 'pixel-round-two-desktop.png')
const mobileScreenshotPath = join(artifactDirectory, 'pixel-round-two-mobile.png')
const failureScreenshotPath = join(artifactDirectory, 'pixel-round-two-failure.png')
const projectTitle = 'PIXEL-ROUND-TWO UI'
const EDGE_PATHS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]
const bridgeExecutableArgument = process.argv.find((argument) => argument.startsWith('--bridge-executable='))
const bridgeExecutableRaw = bridgeExecutableArgument?.slice('--bridge-executable='.length) ?? null

if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/validate-pixel-round-two-ui.mjs [--bridge-executable=<absolute exe path>]')
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
  kind: 'aeonquill.qa.pixel-round-two-ui',
  status: 'failed',
  generatedAt: new Date().toISOString(),
  browser: 'Microsoft Edge via Playwright',
  browserPlugin: { available: false, fallbackReason: 'Used the installed system Microsoft Edge executable through Playwright.' },
  bridge: { runtime: 'startIsolatedBridge', type: bridgeType, file: bridgeFile, baseUrl: null },
  officialSpec: 'https://github.com/aseprite/aseprite/blob/main/docs/ase-file-specs.md',
  project: null,
  fixtures: null,
  phases: [],
  persistence: null,
  responsive: null,
  pageErrors: [],
  consoleErrors: [],
  expectedConsoleErrors: [],
  consoleWarnings: [],
  screenshots: [desktopScreenshotPath, mobileScreenshotPath, failureScreenshotPath],
  error: null,
}

const logLines = []
const pageErrors = []
const consoleErrors = []
const consoleWarnings = []
const expectedConsoleErrors = []
const persistenceRequests = []
const moduleRequests = []
const moduleGate = {
  active: false,
  outcome: 'continue',
  pending: 0,
  promise: null,
  release: null,
}
let bridge
let browser
let context
let page
let linkedStage = 'not-started'
let expectedModuleAbortConsoleError = false

function log(message) {
  logLines.push(`${new Date().toISOString()} ${message}`)
  console.log(message)
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

function armTransformModuleGate(outcome = 'abort') {
  moduleGate.active = true
  moduleGate.outcome = outcome
  moduleGate.promise = new Promise((resolvePromise) => { moduleGate.release = resolvePromise })
}

async function releaseTransformModuleGate(outcome = 'abort') {
  moduleGate.outcome = outcome
  moduleGate.active = false
  moduleGate.release?.()
  moduleGate.release = null
  moduleGate.promise = null
  await delay(120)
}

async function waitForTransformModulePending(timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (moduleGate.pending > 0) return
    await delay(25)
  }
  throw new Error(`选区变换模块未进入延迟请求；requests=${moduleRequests.length}`)
}

function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function textHash(value) {
  return hashBytes(Buffer.from(value, 'utf8')).slice(0, 16)
}

function concatBuffers(...parts) {
  return Buffer.concat(parts.map((part) => Buffer.from(part)))
}

class FixtureWriter {
  constructor() {
    this.parts = []
    this.length = 0
  }

  add(value) {
    const bytes = Buffer.from(value)
    this.parts.push(bytes)
    this.length += bytes.length
  }

  u8(value) {
    const bytes = Buffer.alloc(1)
    bytes.writeUInt8(value & 0xFF, 0)
    this.add(bytes)
  }

  u16(value) {
    const bytes = Buffer.alloc(2)
    bytes.writeUInt16LE(value, 0)
    this.add(bytes)
  }

  i16(value) {
    const bytes = Buffer.alloc(2)
    bytes.writeInt16LE(value, 0)
    this.add(bytes)
  }

  u32(value) {
    const bytes = Buffer.alloc(4)
    bytes.writeUInt32LE(value >>> 0, 0)
    this.add(bytes)
  }

  string(value) {
    const bytes = Buffer.from(value, 'utf8')
    this.u16(bytes.length)
    this.add(bytes)
  }

  zeros(count) {
    this.add(Buffer.alloc(count))
  }

  build() {
    return concatBuffers(...this.parts)
  }
}

function makeChunk(type, payload) {
  const writer = new FixtureWriter()
  writer.u32(payload.length + 6)
  writer.u16(type)
  writer.add(payload)
  return writer.build()
}

function makeLayerChunk(blendMode = 0) {
  const writer = new FixtureWriter()
  writer.u16(3) // visible + editable
  writer.u16(0) // normal layer
  writer.u16(0) // child level
  writer.u16(0)
  writer.u16(0)
  writer.u16(blendMode)
  writer.u8(255)
  writer.zeros(3)
  writer.string('手工 ASE 层')
  return makeChunk(0x2004, writer.build())
}

function makeCelChunk({ type, pixels = null, framePosition = 0 }) {
  const writer = new FixtureWriter()
  writer.u16(0) // layer index
  writer.i16(0)
  writer.i16(0)
  writer.u8(255)
  writer.u16(type)
  writer.i16(0)
  writer.zeros(5)
  if (type === 2) {
    writer.u16(3)
    writer.u16(2)
    writer.add(pixels)
  } else if (type === 1) {
    writer.u16(framePosition)
  }
  return makeChunk(0x2005, writer.build())
}

function makeFrame(chunks, duration) {
  const body = concatBuffers(...chunks)
  const writer = new FixtureWriter()
  writer.u32(body.length + 16)
  writer.u16(0xF1FA)
  writer.u16(chunks.length)
  writer.u16(duration)
  writer.zeros(2)
  writer.u32(chunks.length)
  writer.add(body)
  return writer.build()
}

function makeAsepriteFixture({ blendMode = 0 } = {}) {
  const rgba = Buffer.from([
    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
    255, 255, 0, 255, 255, 0, 255, 128, 0, 255, 255, 255,
  ])
  const compressed = deflateSync(rgba)
  const firstFrame = makeFrame([
    makeLayerChunk(blendMode),
    makeChunk(0x7FFF, Buffer.from([0x52, 0x32, 0x00])),
    makeCelChunk({ type: 2, pixels: compressed }),
  ], 80)
  const secondFrame = makeFrame([
    makeCelChunk({ type: 1, framePosition: 0 }),
  ], 120)
  const frames = concatBuffers(firstFrame, secondFrame)
  const header = Buffer.alloc(128)
  header.writeUInt32LE(128 + frames.length, 0)
  header.writeUInt16LE(0xA5E0, 4)
  header.writeUInt16LE(2, 6)
  header.writeUInt16LE(3, 8)
  header.writeUInt16LE(2, 10)
  header.writeUInt16LE(32, 12)
  header.writeUInt32LE(3, 14) // layer opacity + group blend/opacity flags
  header.writeUInt16LE(100, 18)
  header.writeUInt8(0, 28)
  header.writeUInt16LE(0, 32)
  header.writeUInt8(1, 34)
  header.writeUInt8(1, 35)
  return concatBuffers(header, frames)
}

function referenceDocument() {
  const palette = [
    { id: 'red', name: 'Red', color: '#FF0000FF' },
    { id: 'green', name: 'Green', color: '#00FF00FF' },
    { id: 'blue', name: 'Blue', color: '#0000FFFF' },
    { id: 'yellow', name: 'Yellow', color: '#FFFF00FF' },
    { id: 'pink', name: 'Pink', color: '#FF00FF80' },
    { id: 'cyan', name: 'Cyan', color: '#00FFFFFF' },
  ]
  return createPixelDocument({
    id: 'round-two-reference',
    name: 'Round Two Reference',
    width: 3,
    height: 2,
    palette,
    layers: [{ id: 'layer-1', name: '手工 ASE 层', visible: true, locked: false, opacity: 1, groupId: null, blendMode: 'normal' }],
    frames: [
      { id: 'frame-1', name: 'Frame 1', durationMs: 80, cels: { 'layer-1': ['red', 'green', 'blue', 'yellow', 'pink', 'cyan'] } },
      { id: 'frame-2', name: 'Frame 2', durationMs: 120, cels: { 'layer-1': ['red', 'green', 'blue', 'yellow', 'pink', 'cyan'] } },
    ],
  })
}

function comparableSummary(summary) {
  const { id: _id, revision: _revision, ...rest } = summary
  return rest
}

function documentSummary(document) {
  const frames = document.frames.map((frame) => ({
    id: frame.id,
    durationMs: frame.durationMs,
    celHashes: Object.fromEntries(Object.entries(frame.cels).map(([layerId, cells]) => [layerId, textHash(JSON.stringify(cells))])),
    nonEmpty: Object.values(frame.cels).reduce((total, cells) => total + cells.filter(Boolean).length, 0),
    renderHash: hashBytes(renderPixelFrameRgba(document, frame.id)),
  }))
  return {
    id: document.id,
    revision: document.revision,
    width: document.width,
    height: document.height,
    paletteSize: document.palette.length,
    paletteHash: textHash(JSON.stringify(document.palette.map(({ color }) => color))),
    layerHash: textHash(JSON.stringify(document.layers.map(({ name, visible, locked, opacity, groupId, blendMode }) => ({ name, visible, locked, opacity, groupId, blendMode })))),
    frameCount: frames.length,
    durations: frames.map((frame) => frame.durationMs),
    frames: frames.map(({ id, durationMs, nonEmpty, renderHash }) => ({ id, durationMs, nonEmpty, renderHash })),
    frameHash: textHash(JSON.stringify(frames)),
    metadataHash: textHash(JSON.stringify({
      animationTags: document.animationTags,
      animationEvents: document.animationEvents,
      terrainMaps: document.terrainMaps,
      paletteCycles: document.paletteCycles,
    })),
  }
}

function findMutablePoint(document, layerId, frameId, colorId) {
  const frame = document.frames.find((candidate) => candidate.id === frameId)
  assert.ok(frame, `Frame ${frameId} is missing`)
  const cel = frame.cels[layerId]
  const index = cel.findIndex((value) => value !== colorId)
  assert.ok(index >= 0, `No mutable pixel found in ${frameId}/${layerId}`)
  return { x: index % document.width, y: Math.floor(index / document.width), index, before: cel[index] }
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

async function waitForWorkspaceRevision(projectId, documentId, expectedRevision, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let latest
  while (Date.now() < deadline) {
    latest = await readWorkspaceDocument(projectId, documentId)
    if (latest.record.revision === expectedRevision && latest.document.revision === expectedRevision) return latest
    await delay(120)
  }
  throw new Error(`Workspace document did not reach revision ${expectedRevision}; latest ${latest?.record?.revision}`)
}

function revisionFromText(text) {
  const match = /revision\s+(\d+)/u.exec(text ?? '')
  return match ? Number(match[1]) : null
}

async function uiRevision() {
  return revisionFromText(await page.locator('.aq-pixel-document-title small').textContent())
}

async function waitForUiRevision(expectedRevision, timeout = 15_000) {
  await page.waitForFunction((expected) => {
    const value = document.querySelector('.aq-pixel-document-title small')?.textContent ?? ''
    const match = /revision\s+(\d+)/u.exec(value)
    return match ? Number(match[1]) === expected : false
  }, expectedRevision, { timeout })
}

async function waitForStatus(pattern, timeout = 15_000) {
  await page.getByRole('status').filter({ hasText: pattern }).last().waitFor({ state: 'visible', timeout })
}

async function canvasInfo() {
  const canvas = page.locator('canvas[aria-label*="像素绘制区"]').first()
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

async function dragCanvasCells(cells) {
  const info = await canvasInfo()
  const first = canvasCellPoint(info, cells[0].x, cells[0].y)
  await page.mouse.move(first.x, first.y)
  await page.mouse.down()
  for (const cell of cells.slice(1)) {
    const point = canvasCellPoint(info, cell.x, cell.y)
    await page.mouse.move(point.x, point.y, { steps: 4 })
  }
  await page.mouse.up()
}

async function clickCanvasCells(cells) {
  const info = await canvasInfo()
  for (const cell of cells) {
    const point = canvasCellPoint(info, cell.x, cell.y)
    await page.mouse.move(point.x, point.y)
    await page.mouse.down()
    await page.mouse.up()
    await delay(40)
  }
}

async function dragSelection(x1, y1, x2, y2) {
  const info = await canvasInfo()
  const start = canvasCellPoint(info, x1, y1)
  const end = canvasCellPoint(info, x2, y2)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(end.x, end.y, { steps: 8 })
  await page.mouse.up()
}

async function assertNoHorizontalOverflow() {
  return page.evaluate(() => ({
    viewport: window.innerWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }))
}

function observePage(target) {
  target.on('pageerror', (error) => pageErrors.push(error.message))
  target.on('console', (message) => {
    if (message.type() === 'error') {
      if (expectedModuleAbortConsoleError && moduleRequests.includes(message.location().url) && message.text() === 'Failed to load resource: net::ERR_FAILED') expectedConsoleErrors.push(message.text())
      else consoleErrors.push(message.text())
    }
    else if (message.type() === 'warning') consoleWarnings.push(message.text())
  })
  target.on('response', (response) => {
    if (response.request().method() === 'PUT' && response.url().includes('/api/workspace/documents/')) {
      persistenceRequests.push({ status: response.status() })
    }
  })
  target.on('requestfailed', (request) => {
    if (request.url().includes('/api/workspace/documents/')) {
      persistenceRequests.push({ status: 'failed', error: request.failure()?.errorText ?? 'request failed' })
    }
  })
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
  await dialog.waitFor({ state: 'hidden', timeout: 20_000 })
  await page.getByLabel(/像素绘制区/u).waitFor({ state: 'visible', timeout: 20_000 })
}

async function openTransformDialog() {
  const actions = page.locator('.aq-pixel-selection-actions')
  await actions.getByRole('button', { name: '旋转与缩放选区', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '选区旋转与缩放', exact: true })
  await dialog.waitFor({ state: 'visible' })
  await dialog.getByLabel('选区变换预览', { exact: true }).waitFor({ state: 'visible' })
  return dialog
}

async function closeDialog(dialog, buttonName = '取消') {
  await dialog.getByRole('button', { name: buttonName, exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
}

async function setTransformCandidate(dialog, { width, height, angle }) {
  await dialog.getByLabel('变换目标宽', { exact: true }).fill(String(width))
  await dialog.getByLabel('变换目标高', { exact: true }).fill(String(height))
  await dialog.getByLabel('变换旋转角度', { exact: true }).fill(String(angle))
  await dialog.getByLabel('变换旋转角度', { exact: true }).press('Tab')
  await page.waitForTimeout(120)
  await dialog.getByLabel('选区变换预览', { exact: true }).waitFor({ state: 'visible' })
}

async function uploadFixture(path) {
  const input = page.locator('input[type="file"][accept*=".ase"]')
  await input.setInputFiles(path)
}

async function returnAndReopen(projectTitleValue) {
  await page.getByRole('button', { name: '返回光阴砚主页', exact: true }).click()
  await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
  await page.locator('.aq-project-row-main').filter({ hasText: projectTitleValue }).click()
  await page.getByLabel(/像素绘制区/u).waitFor({ state: 'visible', timeout: 20_000 })
}

const edgePath = await findEdgePath()
if (!edgePath) throw new Error('Microsoft Edge executable was not found in standard Windows locations')

try {
  await mkdir(artifactDirectory, { recursive: true })
  await unlink(failureScreenshotPath).catch(() => undefined)
  bridge = await startIsolatedBridge('pixel-round-two-ui', {
    comfyPolicy: 'manual',
    ...(bridgeExecutable ? { executablePath: bridgeExecutable } : {}),
  })
  report.bridge.baseUrl = bridge.baseUrl

  const manualFixture = makeAsepriteFixture()
  const unsupportedFixture = makeAsepriteFixture({ blendMode: 3 })
  const manualFixturePath = join(bridge.runtimeDirectory, 'pixel-round-two-manual.aseprite')
  const unsupportedFixturePath = join(bridge.runtimeDirectory, 'pixel-round-two-unsupported.aseprite')
  await writeFile(manualFixturePath, manualFixture)
  await writeFile(unsupportedFixturePath, unsupportedFixture)
  const manualDecoded = await decodeAseprite(manualFixture, { documentId: 'manual-fixture', documentName: 'manual-fixture' })
  const reference = referenceDocument()
  const referenceEncoded = await encodeAseprite(reference)
  const referenceDecoded = await decodeAseprite(referenceEncoded.bytes, { documentId: 'reference-decoded', documentName: 'reference-decoded' })
  const referenceSummary = documentSummary(reference)
  const referenceDecodedSummary = documentSummary(referenceDecoded.document)
  assert.deepEqual(
    {
      width: referenceDecodedSummary.width,
      height: referenceDecodedSummary.height,
      paletteSize: referenceDecodedSummary.paletteSize,
      durations: referenceDecodedSummary.durations,
      renderHashes: referenceDecodedSummary.frames.map((frame) => frame.renderHash),
    },
    {
      width: referenceSummary.width,
      height: referenceSummary.height,
      paletteSize: referenceSummary.paletteSize,
      durations: referenceSummary.durations,
      renderHashes: referenceSummary.frames.map((frame) => frame.renderHash),
    },
  )
  await assert.rejects(
    decodeAseprite(unsupportedFixture),
    (error) => error instanceof AsepriteFormatError && error.code === 'UNSUPPORTED_BLEND_MODE',
  )
  report.fixtures = {
    manual: {
      filename: basename(manualFixturePath),
      bytes: manualFixture.length,
      sha256: hashBytes(manualFixture),
      unknownChunkWarningCount: manualDecoded.warnings.length,
      decoded: {
        width: manualDecoded.document.width,
        height: manualDecoded.document.height,
        frameCount: manualDecoded.document.frames.length,
        durations: manualDecoded.document.frames.map((frame) => frame.durationMs),
        frameHash: documentSummary(manualDecoded.document).frameHash,
        renderHashes: documentSummary(manualDecoded.document).frames.map((frame) => frame.renderHash),
      },
    },
    unsupported: { filename: basename(unsupportedFixturePath), bytes: unsupportedFixture.length, sha256: hashBytes(unsupportedFixture), expectedCode: 'UNSUPPORTED_BLEND_MODE' },
    referenceEncoded: {
      bytes: referenceEncoded.bytes.length,
      sha256: hashBytes(referenceEncoded.bytes),
      decodedFrameHash: documentSummary(referenceDecoded.document).frameHash,
      decodedRenderHashes: documentSummary(referenceDecoded.document).frames.map((frame) => frame.renderHash),
    },
  }

  browser = await chromium.launch({ headless: true, executablePath: edgePath, args: ['--disable-gpu'] })
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })
  page = await context.newPage()
  await page.route('**/*', async (route) => {
    const request = route.request()
    if (moduleGate.active && request.resourceType() === 'script' && /\/assets\/PixelSelectionTransformPanel-[^/]+\.js(?:\?|$)/u.test(request.url())) {
      moduleRequests.push(request.url())
      if (moduleGate.promise) {
        moduleGate.pending += 1
        try { await moduleGate.promise } finally { moduleGate.pending -= 1 }
      }
      if (moduleGate.outcome === 'abort') {
        await route.abort().catch(() => undefined)
        return
      }
    }
    await route.continue()
  })
  observePage(page)
  await page.goto(bridge.baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
  assert.equal(await page.evaluate(() => Boolean(document.querySelector('vite-error-overlay,#webpack-dev-server-client-overlay'))), false)

  await createProjectThroughUi()
  const created = await findWorkspaceProject()
  report.project = { projectId: created.project.id, documentId: created.registration.id, title: projectTitle }
  const initial = await waitForWorkspaceRevision(created.project.id, created.registration.id, 0)
  assert.equal(initial.document.id, created.registration.id)
  assert.ok((await page.locator('input[type="file"][accept*=".ase"]').getAttribute('accept'))?.includes('.aseprite'))

  const drawBefore = await uiRevision()
  await page.locator('.aq-pixel-toolbar').getByRole('button', { name: /铅笔/u }).click()
  await clickCanvasCells([
    { x: 2, y: 2 }, { x: 3, y: 2 }, { x: 4, y: 2 },
    { x: 4, y: 3 }, { x: 3, y: 3 }, { x: 2, y: 3 },
  ])
  await waitForUiRevision(drawBefore + 6)
  const afterDraw = await waitForWorkspaceRevision(created.project.id, created.registration.id, drawBefore + 6)

  await page.locator('.aq-pixel-toolbar').getByRole('button', { name: /选区/u }).click()
  await dragSelection(2, 2, 4, 3)
  const selectionActions = page.locator('.aq-pixel-selection-actions')
  await selectionActions.getByRole('button', { name: '旋转与缩放选区', exact: true }).waitFor({ state: 'visible' })
  assert.match((await selectionActions.textContent()) ?? '', /3×2/u)

  const lazyLoadBeforeRevision = await uiRevision()
  assert.equal(moduleRequests.length, 0, 'Selection transform chunk must not load before its entry is clicked')
  armTransformModuleGate('abort')
  await selectionActions.getByRole('button', { name: '旋转与缩放选区', exact: true }).click()
  const loadingTransformDialog = page.getByRole('dialog', { name: '正在载入选区变换', exact: true })
  await loadingTransformDialog.waitFor({ state: 'visible', timeout: 10_000 })
  await waitForTransformModulePending()
  await loadingTransformDialog.getByRole('button', { name: '取消载入', exact: true }).click()
  expectedModuleAbortConsoleError = true
  await releaseTransformModuleGate('abort')
  await loadingTransformDialog.waitFor({ state: 'hidden', timeout: 10_000 })
  await delay(200)
  expectedModuleAbortConsoleError = false
  assert.equal(await uiRevision(), lazyLoadBeforeRevision, 'Canceled transform module load changed the document revision')
  await page.getByLabel(/像素绘制区/u).waitFor({ state: 'visible', timeout: 20_000 })
  const lazyAbortRequestCount = moduleRequests.length

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.getByLabel(/像素绘制区/u).waitFor({ state: 'visible', timeout: 20_000 })
  await page.locator('.aq-pixel-toolbar').getByRole('button', { name: /选区/u }).click()
  await dragSelection(2, 2, 4, 3)
  const reloadedSelectionActions = page.locator('.aq-pixel-selection-actions')
  await reloadedSelectionActions.getByRole('button', { name: '旋转与缩放选区', exact: true }).waitFor({ state: 'visible' })
  armTransformModuleGate('continue')
  moduleGate.promise = null
  moduleGate.release = null
  const moduleRequestsBeforeRecovery = moduleRequests.length
  const recoveredDialog = await openTransformDialog()
  moduleGate.active = false
  assert.ok(moduleRequests.length > moduleRequestsBeforeRecovery, 'Reload recovery did not request the transform module')
  await recoveredDialog.getByRole('button', { name: '取消', exact: true }).click()
  await recoveredDialog.waitFor({ state: 'hidden' })

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.getByLabel(/像素绘制区/u).waitFor({ state: 'visible', timeout: 20_000 })
  await page.locator('.aq-pixel-toolbar').getByRole('button', { name: /选区/u }).click()
  await dragSelection(2, 2, 4, 3)
  const uncanceledSelectionActions = page.locator('.aq-pixel-selection-actions')
  await uncanceledSelectionActions.getByRole('button', { name: '旋转与缩放选区', exact: true }).waitFor({ state: 'visible' })
  const uncanceledFailureRevision = await uiRevision()
  const moduleRequestsBeforeFailure = moduleRequests.length
  armTransformModuleGate('abort')
  await uncanceledSelectionActions.getByRole('button', { name: '旋转与缩放选区', exact: true }).click()
  const failedLoadDialog = page.getByRole('dialog', { name: '正在载入选区变换', exact: true })
  await failedLoadDialog.waitFor({ state: 'visible', timeout: 10_000 })
  await waitForTransformModulePending()
  expectedModuleAbortConsoleError = true
  await releaseTransformModuleGate('abort')
  await failedLoadDialog.waitFor({ state: 'hidden', timeout: 10_000 })
  await waitForStatus(/选区变换未能载入，当前编辑保留；请先保存或导出，再重新载入应用/u)
  await delay(200)
  expectedModuleAbortConsoleError = false
  assert.equal(await uiRevision(), uncanceledFailureRevision, 'Uncanceled module failure changed the document revision')
  await page.getByLabel(/像素绘制区/u).waitFor({ state: 'visible', timeout: 20_000 })
  assert.equal(await page.locator('.aq-pixel-toolbar').getByRole('button', { name: /铅笔/u }).isEnabled(), true)

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.getByLabel(/像素绘制区/u).waitFor({ state: 'visible', timeout: 20_000 })
  await page.locator('.aq-pixel-toolbar').getByRole('button', { name: /选区/u }).click()
  await dragSelection(2, 2, 4, 3)
  const recoveredAfterFailureActions = page.locator('.aq-pixel-selection-actions')
  await recoveredAfterFailureActions.getByRole('button', { name: '旋转与缩放选区', exact: true }).waitFor({ state: 'visible' })
  armTransformModuleGate('continue')
  moduleGate.promise = null
  moduleGate.release = null
  const moduleRequestsBeforeFailureRecovery = moduleRequests.length
  const recoveredAfterFailureDialog = await openTransformDialog()
  moduleGate.active = false
  assert.ok(moduleRequests.length > moduleRequestsBeforeFailureRecovery, 'Reload after uncanceled module failure did not recover the transform module')
  await recoveredAfterFailureDialog.getByRole('button', { name: '取消', exact: true }).click()
  await recoveredAfterFailureDialog.waitFor({ state: 'hidden' })
  report.phases.push({
    name: 'lazy-selection-transform-load-cancel-abort-failure-reload-recovery',
    status: 'passed',
    beforeClickModuleRequests: 0,
    firstAttempt: { requestCount: lazyAbortRequestCount, delayed: true, canceled: true, aborted: true, revisionUnchanged: true, workbenchUsable: true },
    reloadRecovery: { requestedAfterReload: moduleRequests.length > moduleRequestsBeforeRecovery, recoveredDialogOpened: true, sameTabRetryClaimed: false },
    uncanceledFailure: { requestCount: moduleRequests.length - moduleRequestsBeforeFailure, statusVisible: true, dialogClosed: true, revisionUnchanged: true, workbenchUsable: true },
    failureReloadRecovery: { requestedAfterReload: moduleRequests.length > moduleRequestsBeforeFailureRecovery, recoveredDialogOpened: true },
  })

  await page.locator('.aq-pixel-toolbar').getByRole('button', { name: /选区/u }).click().catch(() => undefined)
  await dragSelection(2, 2, 4, 3)
  const selectionActionsAfterRecovery = page.locator('.aq-pixel-selection-actions')
  await selectionActionsAfterRecovery.getByRole('button', { name: '旋转与缩放选区', exact: true }).waitFor({ state: 'visible' })
  const transformBeforeRevision = await uiRevision()
  const transformCandidates = []
  const firstDialog = await openTransformDialog()
  for (const candidate of [{ width: 4, height: 3, angle: 90 }, { width: 3, height: 2, angle: 180 }, { width: 4, height: 3, angle: 37 }]) {
    await setTransformCandidate(firstDialog, candidate)
    assert.equal(await uiRevision(), transformBeforeRevision)
    transformCandidates.push({ ...candidate, revisionUnchanged: true })
  }
  await closeDialog(firstDialog)
  assert.equal(await uiRevision(), transformBeforeRevision)
  const cancelState = await readWorkspaceDocument(created.project.id, created.registration.id)
  assert.equal(comparableSummary(documentSummary(cancelState.document)).frameHash, comparableSummary(documentSummary(afterDraw.document)).frameHash)

  const applyDialog = await openTransformDialog()
  await setTransformCandidate(applyDialog, { width: 3, height: 2, angle: 90 })
  await applyDialog.getByRole('button', { name: '应用变换', exact: true }).click()
  await waitForUiRevision(transformBeforeRevision + 1)
  const transformed = await waitForWorkspaceRevision(created.project.id, created.registration.id, transformBeforeRevision + 1)
  assert.notEqual(documentSummary(transformed.document).frameHash, documentSummary(afterDraw.document).frameHash)
  assert.match((await selectionActions.textContent()) ?? '', /2×3/u)
  const transformAppliedRevision = transformed.document.revision

  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await waitForUiRevision(transformAppliedRevision + 1)
  const transformedUndo = await waitForWorkspaceRevision(created.project.id, created.registration.id, transformAppliedRevision + 1)
  assert.equal(comparableSummary(documentSummary(transformedUndo.document)).frameHash, comparableSummary(documentSummary(afterDraw.document)).frameHash)
  await page.getByRole('button', { name: '重做', exact: true }).click()
  await waitForUiRevision(transformAppliedRevision + 2)
  const transformedRedo = await waitForWorkspaceRevision(created.project.id, created.registration.id, transformAppliedRevision + 2)
  assert.equal(comparableSummary(documentSummary(transformedRedo.document)).frameHash, comparableSummary(documentSummary(transformed.document)).frameHash)

  const activeLayer = transformedRedo.document.layers.find((layer) => layer.id === transformedRedo.document.activeLayerId) ?? transformedRedo.document.layers[0]
  await page.getByRole('button', { name: `锁定 ${activeLayer.name}`, exact: true }).click()
  await waitForUiRevision(transformedRedo.document.revision + 1)
  const locked = await waitForWorkspaceRevision(created.project.id, created.registration.id, transformedRedo.document.revision + 1)
  const lockedDialog = await openTransformDialog()
  await setTransformCandidate(lockedDialog, { width: 4, height: 3, angle: 37 })
  await lockedDialog.getByLabel('变换原区域处理', { exact: true }).selectOption('copy')
  await page.waitForTimeout(120)
  await lockedDialog.getByRole('button', { name: '应用变换', exact: true }).click()
  await page.waitForTimeout(180)
  assert.equal(await uiRevision(), locked.document.revision)
  await waitForStatus(/锁定|不能应用/u)
  await closeDialog(lockedDialog)
  await page.getByRole('button', { name: `解锁 ${activeLayer.name}`, exact: true }).click()
  await waitForUiRevision(locked.document.revision + 1)
  const unlocked = await waitForWorkspaceRevision(created.project.id, created.registration.id, locked.document.revision + 1)

  report.phases.push({
    name: 'mouse-draw-selection-transform-undo-redo-lock',
    status: 'passed',
    draw: { revisionBefore: drawBefore, revisionAfter: afterDraw.document.revision, pathPixels: 6, mouseGestures: 6 },
    selection: { width: 3, height: 2 },
    candidates: transformCandidates,
    cancelRevision: transformBeforeRevision,
    applied: { revision: transformed.document.revision, selection: '2×3', frameHash: documentSummary(transformed.document).frameHash },
    undo: transformedUndo.document.revision,
    redo: transformedRedo.document.revision,
    lockRejected: { revision: locked.document.revision, statusObserved: true },
    unlockedRevision: unlocked.document.revision,
  })

  const beforeUnsupported = await readWorkspaceDocument(created.project.id, created.registration.id)
  await uploadFixture(unsupportedFixturePath)
  await waitForStatus(/不支持|无法|失败/u)
  assert.equal(await page.getByRole('dialog', { name: 'Aseprite 导入预览', exact: true }).count(), 0)
  const unsupportedAfter = await waitForWorkspaceRevision(created.project.id, created.registration.id, beforeUnsupported.document.revision)
  assert.equal(comparableSummary(documentSummary(unsupportedAfter.document)).frameHash, comparableSummary(documentSummary(beforeUnsupported.document)).frameHash)

  await uploadFixture(manualFixturePath)
  const importDialog = page.getByRole('dialog', { name: 'Aseprite 导入预览', exact: true })
  await importDialog.waitFor({ state: 'visible', timeout: 20_000 })
  await importDialog.getByText(/跳过未支持的 Aseprite chunk/u).waitFor({ state: 'visible' })
  const importCancelRevision = await uiRevision()
  await importDialog.getByRole('button', { name: '取消', exact: true }).click()
  await importDialog.waitFor({ state: 'hidden' })
  assert.equal(await uiRevision(), importCancelRevision)
  const importCancelled = await waitForWorkspaceRevision(created.project.id, created.registration.id, importCancelRevision)
  assert.equal(comparableSummary(documentSummary(importCancelled.document)).frameHash, comparableSummary(documentSummary(beforeUnsupported.document)).frameHash)

  await uploadFixture(manualFixturePath)
  const importApplyDialog = page.getByRole('dialog', { name: 'Aseprite 导入预览', exact: true })
  await importApplyDialog.waitFor({ state: 'visible', timeout: 20_000 })
  const importBaseRevision = await uiRevision()
  await importApplyDialog.getByRole('button', { name: '应用 Aseprite 导入', exact: true }).click()
  await waitForUiRevision(importBaseRevision + 1)
  const imported = await waitForWorkspaceRevision(created.project.id, created.registration.id, importBaseRevision + 1)
  assert.equal(imported.document.id, created.registration.id)
  assert.equal(imported.document.width, manualDecoded.document.width)
  assert.equal(imported.document.height, manualDecoded.document.height)
  assert.deepEqual(imported.document.frames.map((frame) => frame.durationMs), manualDecoded.document.frames.map((frame) => frame.durationMs))
  assert.equal(documentSummary(imported.document).frameHash, documentSummary(manualDecoded.document).frameHash)

  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await waitForUiRevision(imported.document.revision + 1)
  const importUndo = await waitForWorkspaceRevision(created.project.id, created.registration.id, imported.document.revision + 1)
  assert.equal(comparableSummary(documentSummary(importUndo.document)).frameHash, comparableSummary(documentSummary(beforeUnsupported.document)).frameHash)
  await page.getByRole('button', { name: '重做', exact: true }).click()
  await waitForUiRevision(imported.document.revision + 2)
  const importRedo = await waitForWorkspaceRevision(created.project.id, created.registration.id, imported.document.revision + 2)
  assert.equal(documentSummary(importRedo.document).frameHash, documentSummary(imported.document).frameHash)

  await page.getByRole('button', { name: '新建调色板循环', exact: true }).click()
  await waitForUiRevision(importRedo.document.revision + 1)
  const exportSource = await waitForWorkspaceRevision(created.project.id, created.registration.id, importRedo.document.revision + 1)
  assert.equal(exportSource.document.paletteCycles.length, 1)

  await page.getByRole('button', { name: '导出 Aseprite 文件', exact: true }).click()
  const exportDialog = page.getByRole('dialog', { name: 'Aseprite 导出提示', exact: true })
  await exportDialog.waitFor({ state: 'visible', timeout: 20_000 })
  await exportDialog.getByText(/paletteCycles|项目原件/u).waitFor({ state: 'visible' })
  const downloadPromise = page.waitForEvent('download', { timeout: 20_000 })
  await exportDialog.getByRole('button', { name: '下载 .aseprite', exact: true }).click()
  const download = await downloadPromise
  const downloadedPath = await download.path()
  assert.ok(downloadedPath, 'Aseprite download did not expose a temporary path')
  const downloadedBytes = await readFile(downloadedPath)
  assert.match(download.suggestedFilename(), /\.aseprite$/iu)
  const downloadedDecoded = await decodeAseprite(downloadedBytes, { documentId: 'downloaded', documentName: 'downloaded' })
  assert.equal(downloadedDecoded.document.width, exportSource.document.width)
  assert.equal(downloadedDecoded.document.height, exportSource.document.height)
  assert.deepEqual(downloadedDecoded.document.frames.map((frame) => frame.durationMs), exportSource.document.frames.map((frame) => frame.durationMs))
  assert.deepEqual(
    documentSummary(downloadedDecoded.document).frames.map((frame) => frame.renderHash),
    documentSummary(exportSource.document).frames.map((frame) => frame.renderHash),
  )
  assert.equal(downloadedBytes.readUInt16LE(4), 0xA5E0)

  const persistedBeforeReopen = await readWorkspaceDocument(created.project.id, created.registration.id)
  const persistedSummary = documentSummary(persistedBeforeReopen.document)
  await page.screenshot({ path: desktopScreenshotPath, fullPage: true })
  await returnAndReopen(projectTitle)
  await waitForUiRevision(persistedBeforeReopen.document.revision)
  const reopened = await waitForWorkspaceRevision(created.project.id, created.registration.id, persistedBeforeReopen.document.revision)
  assert.equal(documentSummary(reopened.document).frameHash, persistedSummary.frameHash)
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
  await page.waitForTimeout(300)
  const linkedBefore = await readWorkspaceDocument(created.project.id, created.registration.id)
  assert.equal(linkedBefore.document.schemaVersion, 9)
  const linkedLayerId = linkedBefore.document.activeLayerId
  const sourceFrameId = linkedBefore.document.activeFrameId
  const targetFrameId = linkedBefore.document.frames.find((frame) => frame.id !== sourceFrameId)?.id
  assert.ok(targetFrameId, 'Linked Cel phase requires a second frame')
  const linkedSection = page.getByLabel('跨帧 Cel 关联', { exact: true })
  await linkedSection.waitFor({ state: 'visible' })
  const linkedTargetSelect = linkedSection.getByLabel('Cel 关联目标帧', { exact: true })
  await linkedTargetSelect.selectOption(targetFrameId)
  assert.equal(await linkedTargetSelect.inputValue(), targetFrameId)
  const linkButton = linkedSection.getByRole('button', { name: '关联当前图层 Cel', exact: true })
  const unlinkButton = linkedSection.getByRole('button', { name: '解除当前 Cel 关联', exact: true })
  assert.equal(await linkButton.isDisabled(), false)
  await linkButton.click()
  await waitForUiRevision(linkedBefore.document.revision + 1)
  const linked = await waitForWorkspaceRevision(created.project.id, created.registration.id, linkedBefore.document.revision + 1)
  linkedStage = 'link-created'
  assert.equal(linked.document.schemaVersion, 9)
  assert.equal(linked.document.celLinks.length, 1)
  const firstLink = linked.document.celLinks[0]
  assert.equal(firstLink.layerId, linkedLayerId)
  assert.deepEqual(new Set(firstLink.frameIds), new Set([sourceFrameId, targetFrameId]))
  assert.deepEqual(linked.document.frames.find((frame) => frame.id === sourceFrameId).cels[linkedLayerId], linked.document.frames.find((frame) => frame.id === targetFrameId).cels[linkedLayerId])
  await linkedSection.getByText(/当前图层关联 2 帧/u).waitFor({ state: 'visible' })
  const linkedFrameBadges = await page.locator('.aq-pixel-frame-strip button small').allTextContents()
  assert.ok(linkedFrameBadges.filter((text) => text.includes('关联')).length >= 2, linkedFrameBadges.join(' | '))

  const desiredLinkedColorId = linked.document.palette[0].id
  const desiredLinkedColorIndex = linked.document.palette.findIndex((color) => color.id === desiredLinkedColorId)
  const linkedColorListbox = page.getByRole('listbox', { name: '像素调色板', exact: true })
  const linkedColorOption = linkedColorListbox.getByRole('option').nth(desiredLinkedColorIndex)
  await linkedColorOption.click()
  assert.equal(await linkedColorOption.getAttribute('aria-selected'), 'true')
  await page.waitForTimeout(120)
  const selectedLinkedColorName = await linkedColorListbox.locator('[role="option"][aria-selected="true"] i').textContent()
  const selectedLinkedColor = linked.document.palette.find((color) => color.name === selectedLinkedColorName)
  assert.ok(selectedLinkedColor, `Selected UI swatch ${selectedLinkedColorName} is missing from the persisted palette`)
  const linkedColorId = selectedLinkedColor.id
  const linkedPoint = findMutablePoint(linked.document, linkedLayerId, sourceFrameId, linkedColorId)
  linkedStage = 'paint-fanout'
  await page.locator('.aq-pixel-toolbar').getByRole('button', { name: /铅笔/u }).click()
  await clickCanvasCells([{ x: linkedPoint.x, y: linkedPoint.y }])
  await waitForUiRevision(linked.document.revision + 1)
  const linkedPaint = await waitForWorkspaceRevision(created.project.id, created.registration.id, linked.document.revision + 1)
  linkedStage = 'paint-fanout-assert'
  const linkedPaintSource = linkedPaint.document.frames.find((frame) => frame.id === sourceFrameId).cels[linkedLayerId]
  const linkedPaintTarget = linkedPaint.document.frames.find((frame) => frame.id === targetFrameId).cels[linkedLayerId]
  assert.equal(linkedPaintSource[linkedPoint.index], linkedColorId)
  assert.equal(linkedPaintTarget[linkedPoint.index], linkedColorId)
  assert.notEqual(linkedPoint.before, linkedColorId)
  assert.equal(linkedPaint.document.celLinks.length, 1)

  await page.getByRole('button', { name: '撤销', exact: true }).click()
  linkedStage = 'undo'
  await waitForUiRevision(linkedPaint.document.revision + 1)
  const linkedUndo = await waitForWorkspaceRevision(created.project.id, created.registration.id, linkedPaint.document.revision + 1)
  assert.equal(linkedUndo.document.celLinks.length, 1)
  assert.equal(linkedUndo.document.frames.find((frame) => frame.id === sourceFrameId).cels[linkedLayerId][linkedPoint.index], linkedPoint.before)
  assert.equal(linkedUndo.document.frames.find((frame) => frame.id === targetFrameId).cels[linkedLayerId][linkedPoint.index], linkedPoint.before)
  await page.getByRole('button', { name: '重做', exact: true }).click()
  linkedStage = 'redo'
  await waitForUiRevision(linkedPaint.document.revision + 2)
  const linkedRedo = await waitForWorkspaceRevision(created.project.id, created.registration.id, linkedPaint.document.revision + 2)
  assert.equal(linkedRedo.document.celLinks.length, 1)
  assert.equal(linkedRedo.document.frames.find((frame) => frame.id === sourceFrameId).cels[linkedLayerId][linkedPoint.index], linkedColorId)
  assert.equal(linkedRedo.document.frames.find((frame) => frame.id === targetFrameId).cels[linkedLayerId][linkedPoint.index], linkedColorId)

  const jsonDownloadPromise = page.waitForEvent('download', { timeout: 20_000 })
  linkedStage = 'json-download'
  await page.getByRole('button', { name: '仅导出像素项目 JSON', exact: true }).click()
  const jsonDownload = await jsonDownloadPromise
  const jsonDownloadPath = await jsonDownload.path()
  assert.ok(jsonDownloadPath, 'Pixel project JSON download did not expose a temporary path')
  const jsonBytes = await readFile(jsonDownloadPath)
  const jsonProject = JSON.parse(jsonBytes.toString('utf8'))
  assert.match(jsonDownload.suggestedFilename(), /\.json$/iu)
  assert.equal(jsonProject.schemaVersion, 9)
  assert.ok(Array.isArray(jsonProject.celLinks) && jsonProject.celLinks.length === 1)
  assert.deepEqual(new Set(jsonProject.celLinks[0].frameIds), new Set([sourceFrameId, targetFrameId]))

  const linkedBeforeReopen = await readWorkspaceDocument(created.project.id, created.registration.id)
  await returnAndReopen(projectTitle)
  await waitForUiRevision(linkedBeforeReopen.document.revision)
  const linkedReopened = await waitForWorkspaceRevision(created.project.id, created.registration.id, linkedBeforeReopen.document.revision)
  linkedStage = 'linked-reopen'
  assert.equal(linkedReopened.document.id, created.registration.id)
  assert.equal(linkedReopened.document.schemaVersion, 9)
  assert.equal(linkedReopened.document.celLinks.length, 1)
  assert.deepEqual(new Set(linkedReopened.document.celLinks[0].frameIds), new Set([sourceFrameId, targetFrameId]))
  assert.equal(linkedReopened.document.frames.find((frame) => frame.id === sourceFrameId).cels[linkedLayerId][linkedPoint.index], linkedColorId)
  assert.equal(linkedReopened.document.frames.find((frame) => frame.id === targetFrameId).cels[linkedLayerId][linkedPoint.index], linkedColorId)

  const reopenedLinkedSection = page.getByLabel('跨帧 Cel 关联', { exact: true })
  await reopenedLinkedSection.getByText(/当前图层关联 2 帧/u).waitFor({ state: 'visible' })
  const reopenedUnlinkButton = reopenedLinkedSection.getByRole('button', { name: '解除当前 Cel 关联', exact: true })
  assert.equal(await reopenedUnlinkButton.isDisabled(), false)
  await reopenedUnlinkButton.click()
  await waitForUiRevision(linkedReopened.document.revision + 1)
  const unlinked = await waitForWorkspaceRevision(created.project.id, created.registration.id, linkedReopened.document.revision + 1)
  linkedStage = 'unlink'
  assert.equal(unlinked.document.celLinks.length, 0)
  assert.equal(unlinked.document.frames.find((frame) => frame.id === sourceFrameId).cels[linkedLayerId][linkedPoint.index], linkedColorId)
  assert.equal(unlinked.document.frames.find((frame) => frame.id === targetFrameId).cels[linkedLayerId][linkedPoint.index], linkedColorId)

  const independentColor = unlinked.document.palette.find((color) => color.id !== linkedColorId)?.id
  assert.ok(independentColor, 'Linked Cel phase requires a second palette color')
  const independentColorIndex = unlinked.document.palette.findIndex((color) => color.id === independentColor)
  await page.getByRole('listbox', { name: '像素调色板', exact: true }).getByRole('option').nth(independentColorIndex).click()
  await clickCanvasCells([{ x: linkedPoint.x, y: linkedPoint.y }])
  await waitForUiRevision(unlinked.document.revision + 1)
  const independent = await waitForWorkspaceRevision(created.project.id, created.registration.id, unlinked.document.revision + 1)
  linkedStage = 'independent-paint'
  assert.equal(independent.document.celLinks.length, 0)
  assert.equal(independent.document.frames.find((frame) => frame.id === sourceFrameId).cels[linkedLayerId][linkedPoint.index], independentColor)
  assert.equal(independent.document.frames.find((frame) => frame.id === targetFrameId).cels[linkedLayerId][linkedPoint.index], linkedColorId)

  const relinkButton = reopenedLinkedSection.getByRole('button', { name: '关联当前图层 Cel', exact: true })
  await reopenedLinkedSection.getByLabel('Cel 关联目标帧', { exact: true }).selectOption(targetFrameId)
  await relinkButton.click()
  await waitForUiRevision(independent.document.revision + 1)
  const relinked = await waitForWorkspaceRevision(created.project.id, created.registration.id, independent.document.revision + 1)
  linkedStage = 'lock-rejection'
  assert.equal(relinked.document.celLinks.length, 1)
  const activeLayerName = relinked.document.layers.find((layer) => layer.id === linkedLayerId)?.name
  assert.ok(activeLayerName)
  await page.getByRole('button', { name: `锁定 ${activeLayerName}`, exact: true }).click()
  await waitForUiRevision(relinked.document.revision + 1)
  const lockedLinked = await waitForWorkspaceRevision(created.project.id, created.registration.id, relinked.document.revision + 1)
  const lockedLinkedSection = page.getByLabel('跨帧 Cel 关联', { exact: true })
  assert.equal(await lockedLinkedSection.getByRole('button', { name: '关联当前图层 Cel', exact: true }).isDisabled(), true)
  assert.equal(await lockedLinkedSection.getByRole('button', { name: '解除当前 Cel 关联', exact: true }).isDisabled(), true)
  await page.getByRole('button', { name: `解锁 ${activeLayerName}`, exact: true }).click()
  await waitForUiRevision(lockedLinked.document.revision + 1)
  const unlockedLinked = await waitForWorkspaceRevision(created.project.id, created.registration.id, lockedLinked.document.revision + 1)
  const cleanupLinkedSection = page.getByLabel('跨帧 Cel 关联', { exact: true })
  await cleanupLinkedSection.getByRole('button', { name: '解除当前 Cel 关联', exact: true }).click()
  await waitForUiRevision(unlockedLinked.document.revision + 1)
  const linkedFinal = await waitForWorkspaceRevision(created.project.id, created.registration.id, unlockedLinked.document.revision + 1)
  linkedStage = 'cleanup'
  assert.equal(linkedFinal.document.celLinks.length, 0)
  assert.equal(linkedFinal.document.frames.find((frame) => frame.id === sourceFrameId).cels[linkedLayerId][linkedPoint.index], independentColor)
  assert.equal(linkedFinal.document.frames.find((frame) => frame.id === targetFrameId).cels[linkedLayerId][linkedPoint.index], independentColor)
  await returnAndReopen(projectTitle)
  await waitForUiRevision(linkedFinal.document.revision)
  const linkedFinalReopened = await waitForWorkspaceRevision(created.project.id, created.registration.id, linkedFinal.document.revision)
  linkedStage = 'final-reopen'
  assert.equal(linkedFinalReopened.document.id, created.registration.id)
  assert.equal(linkedFinalReopened.document.schemaVersion, 9)
  assert.equal(linkedFinalReopened.document.celLinks.length, 0)
  assert.equal(linkedFinalReopened.document.frames.find((frame) => frame.id === sourceFrameId).cels[linkedLayerId][linkedPoint.index], independentColor)
  assert.equal(linkedFinalReopened.document.frames.find((frame) => frame.id === targetFrameId).cels[linkedLayerId][linkedPoint.index], independentColor)

  report.linkedCel = {
    schemaVersion: linkedFinalReopened.document.schemaVersion,
    layerId: linkedLayerId,
    sourceFrameId,
    targetFrameId,
    linkedGroupId: firstLink.id,
    jsonDownload: {
      filename: jsonDownload.suggestedFilename(),
      bytes: jsonBytes.length,
      sha256: hashBytes(jsonBytes),
      celLinkCount: jsonProject.celLinks.length,
      frameIds: jsonProject.celLinks[0].frameIds,
    },
    paint: { point: { x: linkedPoint.x, y: linkedPoint.y }, before: linkedPoint.before, linkedColorId, independentColor },
    revisions: {
      linked: linked.document.revision,
      linkedPaint: linkedPaint.document.revision,
      undo: linkedUndo.document.revision,
      redo: linkedRedo.document.revision,
      unlink: unlinked.document.revision,
      independent: independent.document.revision,
      lockRejectedAt: lockedLinked.document.revision,
      final: linkedFinalReopened.document.revision,
    },
    lockButtonsDisabled: true,
    linkedReopenFrameHash: documentSummary(linkedReopened.document).frameHash,
    finalReopenFrameHash: documentSummary(linkedFinalReopened.document).frameHash,
  }
  report.phases.push({
    name: 'linked-cel-fanout-json-reopen-unlink-lock',
    status: 'passed',
    relationCreated: { layerId: linkedLayerId, frameIds: firstLink.frameIds, celLinkCount: linked.document.celLinks.length },
    mousePaintFanout: { point: { x: linkedPoint.x, y: linkedPoint.y }, linkedColorId, sourceAndTargetEqual: true },
    undoRedo: { undoRevision: linkedUndo.document.revision, redoRevision: linkedRedo.document.revision, relationRetained: true, pixelsRetained: true },
    jsonDownload: { filename: jsonDownload.suggestedFilename(), bytes: jsonBytes.length, celLinkCount: jsonProject.celLinks.length },
    linkedReopen: { revision: linkedReopened.document.revision, relationRetained: true, documentIdPreserved: linkedReopened.document.id === created.registration.id },
    unlink: { revision: unlinked.document.revision, currentFrameIndependent: true, pixelPreserved: true },
    independentPaint: { revision: independent.document.revision, sourceColor: independentColor, targetStayed: linkedColorId },
    lockRejection: { revision: lockedLinked.document.revision, linkDisabled: true, unlinkDisabled: true },
    finalReopen: { revision: linkedFinalReopened.document.revision, relationCount: linkedFinalReopened.document.celLinks.length, documentIdPreserved: linkedFinalReopened.document.id === created.registration.id },
  })

  report.project = {
    ...report.project,
    initial: documentSummary(initial.document),
    afterDraw: documentSummary(afterDraw.document),
    imported: documentSummary(imported.document),
    persistedAfterReopen: documentSummary(reopened.document),
    linkedFinalAfterReopen: documentSummary(linkedFinalReopened.document),
  }
  report.persistence = {
    workspacePutCount: persistenceRequests.length,
    finalRevision: linkedFinalReopened.document.revision,
    catalogDocumentId: created.registration.id,
    idPreservedAcrossImport: imported.document.id === created.registration.id,
    revisionAfterImport: imported.document.revision,
    revisionAfterExportSource: exportSource.document.revision,
    revisionAfterLinkedCel: linkedFinalReopened.document.revision,
  }
  report.responsive = { desktop: desktopOverflow, mobile: mobileOverflow }
  report.phases.push({
    name: 'aseprite-import-warning-unsupported-cancel-apply-undo-redo',
    status: 'passed',
    unsupportedRejectedWithoutMutation: true,
    unknownChunkWarningVisible: true,
    cancelRevision: importCancelRevision,
    applied: {
      revision: imported.document.revision,
      frameCount: imported.document.frames.length,
      durations: imported.document.frames.map((frame) => frame.durationMs),
      frameHash: documentSummary(imported.document).frameHash,
      renderHashes: documentSummary(imported.document).frames.map((frame) => frame.renderHash),
    },
    undoRevision: importUndo.document.revision,
    redoRevision: importRedo.document.revision,
  })
  report.phases.push({
    name: 'aseprite-export-download-decode-persistence-reopen',
    status: 'passed',
    warningVisible: true,
    filename: download.suggestedFilename(),
    bytes: downloadedBytes.length,
    sha256: hashBytes(downloadedBytes),
    decoded: {
      frameCount: downloadedDecoded.document.frames.length,
      durations: downloadedDecoded.document.frames.map((frame) => frame.durationMs),
      frameHash: documentSummary(downloadedDecoded.document).frameHash,
      renderHashes: documentSummary(downloadedDecoded.document).frames.map((frame) => frame.renderHash),
    },
    saveReopen: { status: 'passed', revision: reopened.document.revision, id: reopened.document.id },
  })
  report.phases.push({ name: 'responsive-layout', status: 'passed', desktop: desktopOverflow, mobile: mobileOverflow })
  report.pageErrors = pageErrors
  report.consoleErrors = consoleErrors
  report.expectedConsoleErrors = expectedConsoleErrors
  report.consoleWarnings = consoleWarnings.slice(-20)
  assert.deepEqual(pageErrors, [], `Browser page errors: ${pageErrors.join('; ')}`)
  assert.deepEqual(consoleErrors, [], `Browser console errors: ${consoleErrors.join('; ')}`)
  report.screenshots = [desktopScreenshotPath, mobileScreenshotPath]
  report.status = 'passed'
  log('PASS pixel-round-two UI flow')
} catch (error) {
  report.error = { name: error?.name ?? 'Error', message: error?.message ?? String(error), linkedStage }
  report.pageErrors = pageErrors
  report.consoleErrors = consoleErrors
  report.expectedConsoleErrors = expectedConsoleErrors
  report.consoleWarnings = consoleWarnings.slice(-20)
  log(`FAIL ${report.error.name}: ${report.error.message}`)
  if (page) {
    await page.screenshot({ path: failureScreenshotPath, fullPage: true }).catch(() => undefined)
  }
} finally {
  report.pageErrors = pageErrors
  report.consoleErrors = consoleErrors
  report.expectedConsoleErrors = expectedConsoleErrors
  report.consoleWarnings = consoleWarnings.slice(-20)
  await browser?.close().catch(() => undefined)
  await bridge?.stop({ keepRuntime: false }).catch(() => undefined)
  await mkdir(artifactDirectory, { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await writeFile(logPath, `${logLines.join('\n')}\n`, 'utf8')
}

if (report.status !== 'passed') throw new Error(report.error?.message ?? 'Pixel round-two UI validation failed')
console.log(`✓ Pixel round-two UI validation passed; report ${reportPath}`)
