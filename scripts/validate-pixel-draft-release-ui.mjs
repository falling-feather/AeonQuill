import assert from 'node:assert/strict'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { cpus, platform, release, totalmem } from 'node:os'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

import { createPixelDocument, serializePixelDocument } from '../src/lib/pixel/pixelCore.mjs'
import { createProjectCatalog, createWorkspaceProject } from '../src/lib/project/projectCatalog.mjs'
import { startIsolatedBridge } from './qa-runtime.mjs'

const PROJECT_ID = 'pixel-draft-release-project'
const DOCUMENT_ID = 'pixel-draft-release-document'
const REPORT_PATH = resolve('.runtime', 'qa', 'pixel-draft-release.json')
const EDGE_PATHS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]

function createLargePixelDocument(revision = 0) {
  const width = 256
  const height = 256
  const frameCount = 96
  const blankCel = () => Array.from({ length: width * height }, () => null)
  return createPixelDocument({
    id: DOCUMENT_ID,
    name: 'PIXEL-DRAFT RELEASE 大型文档',
    revision,
    width,
    height,
    palette: [
      { id: 'ink', name: 'Ink', color: '#20252FFF' },
      { id: 'grass', name: 'Grass', color: '#54B77AFF' },
    ],
    layers: [{ id: 'ink', name: 'Ink', visible: true, locked: false, opacity: 1 }],
    frames: Array.from({ length: frameCount }, (_, index) => ({
      id: `large-frame-${index + 1}`,
      name: `Large frame ${index + 1}`,
      durationMs: 100,
      gameplay: { anchor: { x: 0, y: 0 }, collisions: [], tileRule: { terrainId: 'grass', bitmask: 0 } },
      cels: { ink: blankCel() },
    })),
    terrainMaps: [{
      id: 'large-map', name: 'Large map', width: 1, height: 1, cells: ['grass'],
      terrainLayer: { visible: true, locked: false }, objectLayers: [],
    }],
    activeLayerId: 'ink',
    activeFrameId: 'large-frame-1',
  })
}

async function requestJson(bridge, pathname, options = {}, expectedStatus = 200) {
  const response = await bridge.request(pathname, {
    ...options,
    headers: options.body ? { 'content-type': 'application/json', ...options.headers } : options.headers,
  })
  const payload = await response.json().catch(() => ({}))
  assert.equal(response.status, expectedStatus, `${options.method || 'GET'} ${pathname}: ${JSON.stringify(payload).slice(0, 500)}`)
  return payload
}

async function findEdgePath() {
  for (const candidate of EDGE_PATHS) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // Try the next standard Edge installation path.
    }
  }
  return null
}

function metricMap(payload) {
  return new Map((payload.metrics ?? []).map((metric) => [metric.name, metric.value]))
}

async function collectMemory(session) {
  await session.send('HeapProfiler.collectGarbage')
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 80))
  const metrics = metricMap(await session.send('Performance.getMetrics'))
  const readMetric = (name) => Math.round(Number(metrics.get(name) ?? NaN))
  return {
    jsHeapUsedBytes: readMetric('JSHeapUsedSize'),
    domNodes: readMetric('Nodes'),
    documents: readMetric('Documents'),
    eventListeners: readMetric('JSEventListeners'),
  }
}

async function waitForWorkspaceRevision(bridge, expectedRevision, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    const payload = await requestJson(bridge, `/api/workspace/documents/${encodeURIComponent(DOCUMENT_ID)}?projectId=${encodeURIComponent(PROJECT_ID)}&modeId=pixel`)
    last = payload.document
    const document = JSON.parse(last.value)
    if (last.revision === expectedRevision && document.revision === expectedRevision) return last
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150))
  }
  throw new Error(`Workspace pixel document did not reach revision ${expectedRevision}: ${JSON.stringify(last).slice(0, 500)}`)
}

const edgePath = await findEdgePath()
let bridge
let browser
let diagnosticPage
const documentRequests = []
let failure = null
let report = {
  schemaVersion: 1,
  kind: 'aeonquill.qa.pixel-draft-release',
  projectId: PROJECT_ID,
  documentId: DOCUMENT_ID,
  fixture: { width: 256, height: 256, frames: 96 },
  browser: 'Microsoft Edge via Playwright',
  environment: { node: process.version, platform: `${platform()}-${release()}`, cpu: cpus()[0]?.model ?? 'unknown', totalMemoryBytes: totalmem(), edgePath },
}

try {
  if (!edgePath) throw new Error('Microsoft Edge executable was not found in the standard Windows installation paths')
  await mkdir(resolve('.runtime', 'qa'), { recursive: true })
  bridge = await startIsolatedBridge('pixel-draft-release', { comfyPolicy: 'manual' })

  const created = createWorkspaceProject(createProjectCatalog(), {
    title: 'PIXEL-DRAFT RELEASE 性能释放', initialModeId: 'pixel', color: 'violet',
  }, { projectId: PROJECT_ID, documentId: DOCUMENT_ID, now: Date.now() - 60_000 })
  const other = createWorkspaceProject(created.catalog, {
    title: 'PIXEL-DRAFT RELEASE 另一个项目', initialModeId: 'pixel', color: 'violet',
  }, { projectId: 'pixel-draft-other-project', documentId: 'pixel-draft-other-document', now: Date.now() - 50_000 })
  const document = createLargePixelDocument(0)
  await requestJson(bridge, '/api/workspace/catalog', {
    method: 'PUT',
    body: JSON.stringify({ catalog: other.catalog, baseRevision: 0, source: 'pixel-draft-release-qa' }),
  })
  await requestJson(bridge, '/api/workspace/documents/pixel-draft-other-document', {
    method: 'PUT',
    body: JSON.stringify({
      projectId: 'pixel-draft-other-project', modeId: 'pixel', baseRevision: null, revision: 0,
      value: serializePixelDocument(createPixelDocument({ id: 'pixel-draft-other-document', name: '另一个项目' })),
      reason: 'pixel-draft-release-qa', forceRecovery: true,
    }),
  })
  await requestJson(bridge, `/api/workspace/documents/${encodeURIComponent(DOCUMENT_ID)}`, {
    method: 'PUT',
    body: JSON.stringify({
      projectId: PROJECT_ID,
      modeId: 'pixel',
      baseRevision: null,
      revision: 0,
      value: serializePixelDocument(document),
      reason: 'pixel-draft-release-qa',
      forceRecovery: true,
    }),
  })

  browser = await chromium.launch({ headless: true, executablePath: edgePath, args: ['--disable-gpu', '--enable-precise-memory-info'] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  diagnosticPage = page
  page.on('response', (response) => {
    if (response.request().method() === 'PUT' && response.url().includes('/api/workspace/documents/')) {
      documentRequests.push({ at: Date.now(), status: response.status(), url: response.url() })
    }
  })
  page.on('requestfailed', (request) => {
    if (request.url().includes('/api/workspace/documents/')) documentRequests.push({ at: Date.now(), error: request.failure()?.errorText })
  })
  await page.addInitScript(() => {
    const NativeWorker = globalThis.Worker
    const telemetry = { created: 0, terminated: 0 }
    globalThis.__pixelDraftReleaseWorkerTelemetry = telemetry
    if (typeof NativeWorker !== 'function') return
    globalThis.Worker = class PixelDraftReleaseWorker extends NativeWorker {
      constructor(...args) { super(...args); telemetry.created += 1 }
      terminate() { telemetry.terminated += 1; return super.terminate() }
    }
  })
  const session = await context.newCDPSession(page)
  await session.send('Performance.enable')
  await session.send('HeapProfiler.enable')
  const pageErrors = []
  let intentionalSaveFailure = false
  let intentionalConflict = false
  page.on('pageerror', (error) => pageErrors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (intentionalSaveFailure && message.type() === 'error' && /503|QA_SAVE_BLOCKED/u.test(message.text())) return
    if (intentionalConflict && message.type() === 'error' && /409/u.test(message.text())) return
    if (message.type() === 'error' || message.type() === 'warning') pageErrors.push(`${message.type()}: ${message.text()}`)
  })

  await page.goto(bridge.baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
  await page.locator('.aq-project-row-main').filter({ hasText: 'PIXEL-DRAFT RELEASE 性能释放' }).click()
  const canvas = page.getByLabel(/256 乘 256 像素绘制区/u)
  await canvas.waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(2_000)
  const beforeHome = await collectMemory(session)
  const workersBeforeHome = await page.evaluate(() => ({ ...globalThis.__pixelDraftReleaseWorkerTelemetry }))
  await page.getByRole('button', { name: '返回光阴砚主页', exact: true }).click()
  await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
  await page.waitForTimeout(1_000)
  const afterHome = await collectMemory(session)
  const releaseState = await page.evaluate(() => ({
    pixelWorkbench: document.querySelectorAll('[aria-label="光阴砚像素模式工作台"]').length,
    modeHosts: document.querySelectorAll('[data-product-mode]').length,
    workers: { ...globalThis.__pixelDraftReleaseWorkerTelemetry },
  }))
  assert.equal(releaseState.pixelWorkbench, 0)
  assert.equal(releaseState.workers.created - releaseState.workers.terminated, 0)
  assert(afterHome.jsHeapUsedBytes <= beforeHome.jsHeapUsedBytes + 8 * 1024 * 1024)

  await page.locator('.aq-project-row-main').filter({ hasText: 'PIXEL-DRAFT RELEASE 性能释放' }).click()
  await page.getByLabel(/256 乘 256 像素绘制区/u).waitFor({ state: 'visible', timeout: 30_000 })
  await page.locator('.aq-pixel-document-title small').waitFor({ state: 'visible' })
  assert.match(await page.locator('.aq-pixel-document-title small').textContent(), /revision 0/u)
  const reentryCanvas = page.getByLabel(/256 乘 256 像素绘制区/u)
  const box = await reentryCanvas.boundingBox()
  assert.ok(box)
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5)
  await page.locator('.aq-pixel-document-title small').waitFor({ state: 'visible' })
  await page.waitForFunction(() => document.querySelector('.aq-pixel-document-title small')?.textContent?.includes('revision 1'))
  await waitForWorkspaceRevision(bridge, 1)
  const afterReentry = await collectMemory(session)

  intentionalSaveFailure = true
  await page.route('**/api/workspace/documents/**', async (route) => {
    if (route.request().method() === 'PUT' && route.request().url().endsWith(`/${DOCUMENT_ID}`)) {
      await route.fulfill({ status: 503, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: { code: 'QA_SAVE_BLOCKED', message: 'intentional QA save failure' } }) })
      return
    }
    await route.continue()
  })
  const failureBox = await reentryCanvas.boundingBox()
  assert.ok(failureBox)
  await page.mouse.click(failureBox.x + failureBox.width * 0.6, failureBox.y + failureBox.height * 0.6)
  await page.waitForFunction(() => document.querySelector('.aq-pixel-document-title small')?.textContent?.includes('revision 2'))
  await page.getByText('intentional QA save failure', { exact: false }).first().waitFor({ state: 'visible' })
  const fallbackSerialized = await page.evaluate((documentId) => window.localStorage.getItem(`aeonquill:pixel-document:v1:${documentId}`), DOCUMENT_ID)
  assert.equal(fallbackSerialized, null, 'Fixture must exercise failed persistence without a localStorage copy')
  await page.getByRole('button', { name: '返回光阴砚主页', exact: true }).click()
  await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
  await page.locator('.aq-project-row-main').filter({ hasText: 'PIXEL-DRAFT RELEASE 另一个项目' }).click()
  await page.getByLabel(/16 乘 16 像素绘制区/u).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '返回光阴砚主页', exact: true }).click()
  await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible' })
  await page.locator('.aq-project-row-main').filter({ hasText: 'PIXEL-DRAFT RELEASE 性能释放' }).click()
  await page.getByLabel(/256 乘 256 像素绘制区/u).waitFor({ state: 'visible', timeout: 30_000 })
  assert.match(await page.locator('.aq-pixel-document-title small').textContent(), /revision 2\b/u,
    'Reopening must preserve the unsaved in-memory revision even when browser storage is full')
  const failedSavePreserved = { status: 'passed', storage: 'in-memory', browserStorage: 'quota-exceeded', revisionAfterOtherProject: 2 }
  await page.unroute('**/api/workspace/documents/**')
  const retryBox = await page.getByLabel(/256 乘 256 像素绘制区/u).boundingBox()
  await page.mouse.click(retryBox.x + retryBox.width * 0.7, retryBox.y + retryBox.height * 0.7)
  await waitForWorkspaceRevision(bridge, 3)

  // A failed draft must retain its original base revision; a later workspace read
  // must not silently authorize overwriting another page's concurrent changes.
  await page.route('**/api/workspace/documents/**', async (route) => {
    if (route.request().method() === 'PUT' && route.request().url().endsWith(`/${DOCUMENT_ID}`)) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'QA_SAVE_BLOCKED', message: 'intentional QA save failure' } }) })
    } else await route.continue()
  })
  await page.mouse.click(retryBox.x + retryBox.width * 0.8, retryBox.y + retryBox.height * 0.8)
  await page.waitForFunction(() => document.querySelector('.aq-pixel-document-title small')?.textContent?.includes('revision 4'))
  await page.getByText('intentional QA save failure', { exact: false }).first().waitFor({ state: 'visible' })
  const external = JSON.parse((await waitForWorkspaceRevision(bridge, 3)).value)
  external.revision = 4
  external.name = '另一个页面的修改'
  await requestJson(bridge, `/api/workspace/documents/${DOCUMENT_ID}`, {
    method: 'PUT', body: JSON.stringify({ projectId: PROJECT_ID, modeId: 'pixel', baseRevision: 3, revision: 4, value: serializePixelDocument(external), reason: 'concurrent-page' }),
  })
  await page.getByRole('button', { name: '返回光阴砚主页', exact: true }).click()
  await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible' })
  await page.unroute('**/api/workspace/documents/**')
  intentionalConflict = true
  const rejectedRetry = page.waitForResponse((response) => response.url().endsWith(`/${DOCUMENT_ID}`) && response.request().method() === 'PUT' && response.status() === 409)
  await page.locator('.aq-project-row-main').filter({ hasText: 'PIXEL-DRAFT RELEASE 性能释放' }).click()
  await page.getByLabel(/256 乘 256 像素绘制区/u).waitFor({ state: 'visible', timeout: 30_000 })
  await rejectedRetry
  assert.match(await page.locator('.aq-pixel-document-title small').textContent(), /revision 4\b/u)
  assert.equal(JSON.parse((await waitForWorkspaceRevision(bridge, 4)).value).name, external.name)
  await page.screenshot({ path: resolve('.runtime/qa/pixel-draft-conflict.png') })
  assert.deepEqual(pageErrors, [])

  report = {
    ...report,
    status: 'passed',
    machine: {
      beforeHome,
      afterHome,
      afterReentry,
      releaseState,
      workersBeforeHome,
      pageErrors,
      savedRevisionAfterReentry: 1,
      failedSavePreserved,
      retrySavedRevision: 3,
      concurrentWrite: { status: 'passed', retryStatus: 409, authoritativeRevision: 4 },
      heapDeltaAfterHomeBytes: afterHome.jsHeapUsedBytes - beforeHome.jsHeapUsedBytes,
    },
    manual: { status: 'not-applicable', checks: [] },
  }
} catch (error) {
  failure = error
  const pageState = await diagnosticPage?.evaluate(() => ({
    revision: document.querySelector('.aq-pixel-document-title small')?.textContent,
    status: document.querySelector('.aq-pixel-status')?.textContent,
    notices: [...document.querySelectorAll('[role="alert"], [role="status"]')].map((node) => node.textContent?.slice(0, 250)),
  })).catch(() => null)
  report = { ...report, status: 'failed', pageState, documentRequests, error: { name: error?.name, message: error?.message, stack: error?.stack } }
} finally {
  await browser?.close().catch(() => {})
  await bridge?.stop({ keepRuntime: false }).catch(() => {})
  await mkdir(resolve('.runtime', 'qa'), { recursive: true })
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

if (failure) throw failure
console.log(`✓ Pixel draft release validation passed; report ${REPORT_PATH}`)
