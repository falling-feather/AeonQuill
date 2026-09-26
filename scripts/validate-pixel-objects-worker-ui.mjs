import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { cpus, platform, release, totalmem } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { startIsolatedBridge } from './qa-runtime.mjs'
import {
  finalizeSoak,
  summarizeSamples,
  validatePerformanceThresholds,
} from './product-performance.mjs'
import {
  createPixelDocument,
} from '../src/lib/pixel/pixelCore.mjs'
import { renderPixelTerrainMapRgba } from '../src/lib/pixel/pixelGamePipeline.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const artifactDirectory = join(projectRoot, '.runtime', 'qa')
const reportPath = join(artifactDirectory, 'pixel-objects-worker-ui.json')
const desktopScreenshotPath = join(artifactDirectory, 'pixel-objects-worker-desktop.png')
const largeScreenshotPath = join(artifactDirectory, 'pixel-objects-worker-large.png')
const cancelScreenshotPath = join(artifactDirectory, 'pixel-objects-worker-cancelled.png')
const cliArgs = new Map(process.argv.slice(2).map((argument) => {
  const separator = argument.indexOf('=')
  return separator === -1 ? [argument, true] : [argument.slice(0, separator), argument.slice(separator + 1)]
}))
const soakMinutes = cliArgs.has('--soak-minutes') ? Number(cliArgs.get('--soak-minutes')) : 0
if (!Number.isInteger(soakMinutes) || soakMinutes < 0 || soakMinutes > 120) {
  throw new Error('--soak-minutes must be an integer between 0 and 120')
}
const soakReportPath = soakMinutes > 0
  ? join(artifactDirectory, `pixel-objects-worker-soak-${soakMinutes}m.json`)
  : null
const soakHealthReportPath = soakMinutes > 0
  ? join(artifactDirectory, `pixel-objects-worker-soak-${soakMinutes}m-health.json`)
  : null
const browserExecutable = process.platform === 'win32'
  ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  : undefined

const phases = []
const performanceThresholds = validatePerformanceThresholds(JSON.parse(await readFile(
  join(projectRoot, 'benchmarks', 'product-performance', 'thresholds.json'),
  'utf8',
)))

function observePage(page, issues, requests) {
  page.on('pageerror', (error) => issues.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      issues.push(`${message.type()}: ${message.text()}`)
    }
  })
  page.on('response', (response) => {
    if (response.status() >= 400) issues.push(`http ${response.status()}: ${response.url()}`)
  })
  page.on('request', (request) => requests.push(request.url()))
}

function fnv1a(bytes) {
  let hash = 0x811c9dc5
  for (const byte of bytes) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function createLargePixelDocument(documentId = 'pixel-perf-large-document', revision = 0) {
  const width = 256
  const height = 256
  const frameCount = 96
  const blankCel = () => Array.from({ length: width * height }, () => null)
  return createPixelDocument({
    id: documentId,
    name: 'PERF 大型像素文档',
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
      gameplay: {
        anchor: { x: 0, y: 0 },
        collisions: [],
        tileRule: { terrainId: 'grass', bitmask: 0 },
      },
      cels: { ink: blankCel() },
    })),
    terrainMaps: [{
      id: 'large-map',
      name: 'Large map',
      width: 1,
      height: 1,
      cells: ['grass'],
      terrainLayer: { visible: true, locked: false },
      objectLayers: [],
    }],
    activeLayerId: 'ink',
    activeFrameId: 'large-frame-1',
  })
}

async function waitForDownloads(downloads, count, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (downloads.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.equal(downloads.length, count, `Expected ${count} downloads, received ${downloads.length}`)
}

function delay(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, durationMs))
}

function metricMap(payload) {
  return new Map((payload.metrics ?? []).map((metric) => [metric.name, metric.value]))
}

async function collectPerformanceSample(session, startedAt) {
  await session.send('HeapProfiler.collectGarbage')
  await delay(50)
  const metrics = metricMap(await session.send('Performance.getMetrics'))
  const readMetric = (name) => {
    const value = metrics.get(name)
    if (!Number.isFinite(value)) throw new Error(`Edge did not expose ${name}`)
    return Math.round(value)
  }
  return {
    elapsedMs: Math.max(0, Date.now() - startedAt),
    jsHeapUsedBytes: readMetric('JSHeapUsedSize'),
    domNodes: readMetric('Nodes'),
    documents: readMetric('Documents'),
    eventListeners: readMetric('JSEventListeners'),
  }
}

async function measureCanvasInputLatency(page, canvas, cell) {
  await canvas.scrollIntoViewIfNeeded()
  const box = await canvas.boundingBox()
  if (!box || box.width <= 0 || box.height <= 0) {
    return { status: 'missing', reason: 'canvas-bounds', cell, box }
  }
  const point = {
    x: box.x + ((cell.column + 0.5) / cell.columns) * box.width,
    y: box.y + ((cell.row + 0.5) / cell.rows) * box.height,
  }
  const hit = await page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y)
    return {
      tagName: element?.tagName ?? null,
      ariaLabel: element?.getAttribute('aria-label') ?? null,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scroll: { x: window.scrollX, y: window.scrollY },
      activeTool: document.querySelector('[aria-label="像素绘制工具"] button.is-active')?.textContent?.trim() ?? null,
    }
  }, point)
  if (hit.tagName !== 'CANVAS' || !hit.ariaLabel?.includes('像素绘制区')) {
    return { status: 'missing', reason: 'element-from-point', cell, box, point, hit }
  }
  await page.evaluate(() => {
    const target = document
    globalThis.__pixelInputProbe = { status: 'pending' }
    const onPointerDown = (event) => {
      const handlerAt = performance.now()
      const rawEventAt = Number(event.timeStamp)
      const eventAt = Number.isFinite(rawEventAt) && rawEventAt <= handlerAt + 10_000
        ? rawEventAt
        : handlerAt
      requestAnimationFrame(() => {
        const frameObservedAt = performance.now()
        globalThis.__pixelInputProbe = {
          status: 'ok',
          eventToHandlerMs: Number(Math.max(0, handlerAt - eventAt).toFixed(2)),
          handlerToFrameMs: Number(Math.max(0, frameObservedAt - handlerAt).toFixed(2)),
        }
      })
      target.removeEventListener('pointerdown', onPointerDown, true)
    }
    target.addEventListener('pointerdown', onPointerDown, { capture: true, once: true })
    setTimeout(() => {
      target.removeEventListener('pointerdown', onPointerDown, true)
      if (globalThis.__pixelInputProbe?.status === 'pending') {
        globalThis.__pixelInputProbe = { status: 'timeout', timeoutMs: 1_000 }
      }
    }, 1_000)
  })
  await page.mouse.click(point.x, point.y)
  const deadline = Date.now() + 1_500
  while (Date.now() < deadline) {
    const probe = await page.evaluate(() => globalThis.__pixelInputProbe ?? { status: 'missing' })
    if (probe.status !== 'pending') return probe
    await delay(10)
  }
  return { status: 'host-timeout', timeoutMs: 1_500, cell, box, point }
}

function thresholdCheck(id, actual, limit, unit) {
  return {
    id,
    status: actual <= limit ? 'passed' : 'failed',
    actual,
    limit,
    unit,
  }
}

async function runPixelSoak(page, context, workerTelemetry, largeMapEditor) {
  const session = await context.newCDPSession(page)
  await session.send('Performance.enable')
  await session.send('HeapProfiler.enable')
  const soakStartedAt = Date.now()
  const durationMs = soakMinutes * 60_000
  const samples = [await collectPerformanceSample(session, soakStartedAt)]
  const inputLatencies = []
  const inputEventToHandlerLatencies = []
  let inputLatencyTimeouts = 0
  let inputLatencyMissingTargets = 0
  const inputLatencyDiagnostics = []
  const visibilityStates = []
  const cycleIntervalMs = 30_000
  const progressIntervalMs = 60_000
  let nextSampleAt = Date.now() + 5_000
  let nextProgressAt = Date.now() + progressIntervalMs
  let cycles = 0
  let cancelledComputations = 0
  let cancelTimeouts = 0
  let undoTimeouts = 0
  let redoTimeouts = 0
  let editedDocuments = 0
  let undoRedoPairs = 0
  let healthWritten = false
  const backgroundPage = await context.newPage()
  await backgroundPage.goto('about:blank')
  const canvas = page.getByLabel(/256 乘 256 像素绘制区/u)
  const revisionText = () => page.locator('.aq-pixel-document-title small').textContent()
  const preflightSamples = []
  for (let index = 0; index < 3; index += 1) {
    const preflightRevisionBefore = await revisionText()
    const preflight = await measureCanvasInputLatency(page, canvas, {
      column: 200 + index,
      row: 250,
      columns: 256,
      rows: 256,
    })
    await delay(50)
    const preflightRevisionAfter = await revisionText()
    preflightSamples.push({ index, revisionBefore: preflightRevisionBefore, revisionAfter: preflightRevisionAfter, probe: preflight })
    assert.equal(preflight.status, 'ok', `PERF-004 input preflight ${index + 1} did not receive a real pointer event: ${JSON.stringify(preflight)}`)
    assert.notEqual(preflightRevisionAfter, preflightRevisionBefore, `PERF-004 preflight ${index + 1} did not advance the pixel document revision`)
    inputLatencies.push(preflight.handlerToFrameMs)
    inputEventToHandlerLatencies.push(preflight.eventToHandlerMs)
    editedDocuments += 1
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    if (index < 2) await delay(1_000)
  }
  const preflight = { requiredSamples: 3, samples: preflightSamples }

  const writeHealth = async (reason) => {
    if (!soakHealthReportPath || healthWritten) return
    healthWritten = true
    const workerState = await page.evaluate(() => globalThis.__pixelWorkerTelemetry ?? null)
    await writeFile(soakHealthReportPath, `${JSON.stringify({
      schemaVersion: 1,
      status: 'preliminary-health',
      reason,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - soakStartedAt,
      cycles,
      editedDocuments,
      undoRedoPairs,
      cancelledComputations,
      cancelTimeouts,
      undoTimeouts,
      redoTimeouts,
      inputLatency: {
        handlerToFrame: inputLatencies.length ? summarizeSamples(inputLatencies) : null,
        eventToHandler: inputEventToHandlerLatencies.length ? summarizeSamples(inputEventToHandlerLatencies) : null,
        validSamples: inputLatencies.length,
        timeoutCount: inputLatencyTimeouts,
        missingTargetCount: inputLatencyMissingTargets,
      },
      inputPreflight: preflight,
      inputDiagnostics: inputLatencyDiagnostics,
      samples: samples.at(-1),
      worker: workerState ? {
        created: workerState.created,
        terminated: workerState.terminated,
        active: workerState.created - workerState.terminated,
      } : null,
      environment: {
        browser: 'Microsoft Edge via Playwright',
        platform: `${platform()}-${release()}`,
        cpu: cpus()[0]?.model ?? 'unknown',
        logicalCpuCount: cpus().length,
        totalMemoryBytes: totalmem(),
        parallelProcessNote: 'Shared host; root may run validation/build/package work concurrently. No resource isolation or threshold relaxation was applied.',
      },
      thresholds: performanceThresholds.limits,
      thresholdAssessment: 'not assessed before the full soak duration',
    }, null, 2)}\n`, 'utf8')
    console.log(`  soak 1-minute health · ${cycles} cycles · heap ${(samples.at(-1).jsHeapUsedBytes / 1024 / 1024).toFixed(1)} MiB · input P95 ${inputLatencies.length ? summarizeSamples(inputLatencies).p95 : 'n/a'} ms · timeouts ${inputLatencyTimeouts}`)
  }

  while (Date.now() - soakStartedAt < durationMs) {
    const cycleStartedAt = Date.now()
    await page.bringToFront()
    const column = cycles % 16
    const row = 128 + (Math.floor(cycles / 16) % 16)
    const inputLatency = await measureCanvasInputLatency(page, canvas, {
      column,
      row,
      columns: 256,
      rows: 256,
    })
    if (inputLatency.status === 'ok') {
      inputLatencies.push(inputLatency.handlerToFrameMs)
      inputEventToHandlerLatencies.push(inputLatency.eventToHandlerMs)
    } else if (inputLatency.status === 'missing') {
      inputLatencyMissingTargets += 1
      inputLatencyDiagnostics.push(inputLatency)
    } else {
      inputLatencyTimeouts += 1
      inputLatencyDiagnostics.push(inputLatency)
    }
    editedDocuments += 1
    try {
      await page.getByRole('button', { name: '撤销', exact: true }).click({ force: true, timeout: 3_000 })
    } catch {
      undoTimeouts += 1
    }
    try {
      await page.getByRole('button', { name: '重做', exact: true }).click({ force: true, timeout: 3_000 })
    } catch {
      redoTimeouts += 1
    }
    undoRedoPairs += 1
    // Completion can remove the control between two automation calls. Resolve
    // and invoke it in one turn; an already completed computation is not a UI timeout.
    const cancelOutcome = await Promise.race([
      page.evaluate(() => {
        const button = [...document.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === '取消计算' && !entry.disabled && entry.getClientRects().length)
        if (!button) return 'already-completed'
        button.click()
        return 'cancelled'
      }),
      delay(3_000).then(() => 'timeout'),
    ])
    if (cancelOutcome === 'cancelled') cancelledComputations += 1
    if (cancelOutcome === 'timeout') cancelTimeouts += 1
    await backgroundPage.bringToFront()
    await delay(250)
    visibilityStates.push(await page.evaluate(() => document.visibilityState).catch(() => 'unavailable'))
    await page.bringToFront()
    visibilityStates.push(await page.evaluate(() => document.visibilityState).catch(() => 'unavailable'))
    cycles += 1

    const cycleDeadline = cycleStartedAt + cycleIntervalMs
    while (Date.now() < cycleDeadline && Date.now() - soakStartedAt < durationMs) {
      await delay(Math.min(1_000, Math.max(50, cycleDeadline - Date.now())))
      const now = Date.now()
      if (now >= nextSampleAt) {
        samples.push(await collectPerformanceSample(session, soakStartedAt))
        nextSampleAt = now + 5_000
      }
      if (!healthWritten && now - soakStartedAt >= 60_000) await writeHealth('one-minute')
      if (now >= nextProgressAt) {
        const latest = samples.at(-1)
        console.log(`  soak ${Math.floor((now - soakStartedAt) / 60_000)} min · ${cycles} cycles · heap ${(latest.jsHeapUsedBytes / 1024 / 1024).toFixed(1)} MiB · DOM ${latest.domNodes} · listeners ${latest.eventListeners}`)
        nextProgressAt += progressIntervalMs
      }
    }
  }
  if (!healthWritten) await writeHealth('soak-complete-before-one-minute')

  const workerBeforeUnload = await page.evaluate(() => globalThis.__pixelWorkerTelemetry ?? null)
  const returnHome = page.getByRole('button', { name: '返回光阴砚主页', exact: true })
  await returnHome.click()
  await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
  await delay(1_000)
  const releaseState = await page.evaluate(() => ({
    modeHosts: document.querySelectorAll('[data-product-mode]').length,
    pixelWorkbench: document.querySelectorAll('[aria-label="光阴砚像素模式工作台"]').length,
    mediaElements: document.querySelectorAll('video, audio, .canvas-viewport, [aria-label="光阴砚像素模式工作台"], [aria-label="智能视频工作台"]').length,
  }))
  const workerAfterUnload = await page.evaluate(() => globalThis.__pixelWorkerTelemetry ?? null)
  await backgroundPage.close().catch(() => undefined)
  samples.push(await collectPerformanceSample(session, soakStartedAt))
  const soakResult = finalizeSoak(samples, releaseState, Date.now() - soakStartedAt, cycles)
  const limits = performanceThresholds.limits
  const thresholdAssessment = {
    status: 'passed',
    checks: [
      thresholdCheck('soak-heap-growth', soakResult.growth.jsHeapUsedBytes, limits.heapGrowthBytes, 'bytes'),
      thresholdCheck('soak-heap-slope', Math.max(0, soakResult.slopes.jsHeapUsedBytesPerMinute), limits.heapSlopeBytesPerMinute, 'bytes/minute'),
      thresholdCheck('soak-dom-growth', soakResult.growth.domNodes, limits.domNodeGrowth, 'nodes'),
      thresholdCheck('soak-dom-slope', Math.max(0, soakResult.slopes.domNodesPerMinute), limits.domNodeSlopePerMinute, 'nodes/minute'),
      thresholdCheck('soak-document-growth', soakResult.growth.documents, limits.documentGrowth, 'documents'),
      thresholdCheck('soak-listener-growth', soakResult.growth.eventListeners, limits.eventListenerGrowth, 'listeners'),
      thresholdCheck('released-mode-hosts', releaseState.modeHosts, limits.finalModeHosts, 'elements'),
      thresholdCheck('released-media-elements', releaseState.mediaElements, limits.finalMediaElements, 'elements'),
      thresholdCheck('input-latency-measurement', inputLatencyTimeouts + inputLatencyMissingTargets, 0, 'invalid samples'),
      thresholdCheck('interaction-control-timeouts', cancelTimeouts + undoTimeouts + redoTimeouts, 0, 'timeouts'),
    ],
  }
  thresholdAssessment.status = thresholdAssessment.checks.every((check) => check.status === 'passed') ? 'passed' : 'failed'
  const worker = {
    created: workerAfterUnload?.created ?? null,
    terminated: workerAfterUnload?.terminated ?? null,
    activeAfterUnload: workerAfterUnload ? workerAfterUnload.created - workerAfterUnload.terminated : null,
    createdBeforeUnload: workerBeforeUnload?.created ?? null,
    terminatedBeforeUnload: workerBeforeUnload?.terminated ?? null,
    releasedOnHome: workerBeforeUnload && workerAfterUnload
      ? workerAfterUnload.terminated - workerBeforeUnload.terminated
      : null,
  }
  const result = {
    ...soakResult,
    inputLatency: {
      handlerToFrame: inputLatencies.length ? summarizeSamples(inputLatencies) : null,
      eventToHandler: inputEventToHandlerLatencies.length ? summarizeSamples(inputEventToHandlerLatencies) : null,
      validSamples: inputLatencies.length,
      timeoutCount: inputLatencyTimeouts,
      missingTargetCount: inputLatencyMissingTargets,
      totalAttempts: inputLatencies.length + inputLatencyTimeouts + inputLatencyMissingTargets,
      inputPreflight: preflight,
      inputDiagnostics: inputLatencyDiagnostics,
      measurementQuality: inputLatencyTimeouts === 0 && inputLatencyMissingTargets === 0 ? 'passed' : 'failed',
    },
    interaction: {
      cycleIntervalMs,
      cycles,
      editedDocuments,
      undoRedoPairs,
      cancelledComputations,
      cancelTimeouts,
      undoTimeouts,
      redoTimeouts,
      foregroundBackgroundSwitches: cycles,
      visibilityStates: [...new Set(visibilityStates)],
    },
    worker,
    thresholdAssessment,
    environment: {
      browser: 'Microsoft Edge via Playwright',
      platform: `${platform()}-${release()}`,
      cpu: cpus()[0]?.model ?? 'unknown',
      logicalCpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
      parallelProcessNote: 'Shared host; root may run validation/build/package work concurrently. No resource isolation or threshold relaxation was applied.',
      measurement: 'CDP Performance.getMetrics with HeapProfiler.collectGarbage before every sample; input latency is pointer dispatch latency from real Playwright canvas input.',
    },
  }
  if (soakReportPath) {
    await writeFile(soakReportPath, `${JSON.stringify({
      schemaVersion: 1,
      status: thresholdAssessment.status,
      generatedAt: new Date().toISOString(),
      soakMinutes,
      ...result,
    }, null, 2)}\n`, 'utf8')
  }
  await session.detach().catch(() => undefined)
  return result
}

async function waitForStableSave(page) {
  await page.waitForTimeout(1_000)
  await page.getByText('已保存', { exact: true }).first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined)
}

async function fillAndBlur(locator, value) {
  await locator.fill(value)
  await locator.press('Tab')
}

async function assertObjectLayerUi(page) {
  const gameplay = page.getByLabel('当前帧游戏元数据', { exact: true })
  const terrainMapEditor = gameplay.getByLabel('持久化 Terrain Map 编辑器', { exact: true })
  await terrainMapEditor.getByLabel('Terrain Map 画布', { exact: true }).waitFor({ state: 'visible' })
  const terrainLayers = terrainMapEditor.getByLabel('Terrain 与对象层', { exact: true })
  const objectLayerTab = terrainLayers.locator('.aq-pixel-terrain-layer-tabs button').filter({ hasText: 'Objects 1' }).first()
  await objectLayerTab.waitFor({ state: 'visible' })
  await objectLayerTab.click()
  const objectButton = terrainLayers.getByLabel('对象列表').getByRole('button', { name: 'spawn-point-renamed', exact: true })
  await objectButton.waitFor({ state: 'visible' })
  await objectButton.click()
  const objectFields = terrainLayers.locator('.aq-pixel-terrain-object-fields')
  const inputs = objectFields.locator('input')
  assert.equal(await inputs.nth(0).inputValue(), 'spawn-point-renamed')
  assert.equal(await inputs.nth(1).inputValue(), '1')
  assert.equal(await inputs.nth(2).inputValue(), '1')
  assert.equal(await inputs.nth(3).inputValue(), '2')
  assert.equal(await inputs.nth(4).inputValue(), '2')
  const frameSelect = objectFields.locator('label').filter({ hasText: '帧引用' }).locator('select')
  const collisionSelect = objectFields.locator('label').filter({ hasText: '碰撞引用' }).locator('select')
  assert.notEqual(await frameSelect.inputValue(), '')
  assert.notEqual(await collisionSelect.inputValue(), '')
  assert.match(await objectFields.locator('textarea').inputValue(), /spawn/u)
}

async function validateProjectUi(baseUrl, largeFixturePath) {
  const startedAt = Date.now()
  const browser = await chromium.launch({
    headless: true,
    ...(browserExecutable ? { executablePath: browserExecutable } : {}),
    args: ['--disable-gpu', '--enable-precise-memory-info'],
  })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  })
  const page = await context.newPage()
  const issues = []
  const requests = []
  const downloads = []
  const workerTelemetry = {
    created: 0,
    terminated: 0,
    posts: [],
    responses: [],
  }
  await page.addInitScript(() => {
    const NativeWorker = globalThis.Worker
    const telemetry = {
      created: 0,
      terminated: 0,
      posts: [],
      responses: [],
    }
    const fnv1a = (bytes) => {
      let hash = 0x811c9dc5
      for (const byte of bytes) {
        hash ^= byte
        hash = Math.imul(hash, 0x01000193)
      }
      return (hash >>> 0).toString(16).padStart(8, '0')
    }
    const binarySummary = (value) => {
      if (!ArrayBuffer.isView(value)) return null
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      return {
        byteLength: bytes.byteLength,
        hash: fnv1a(bytes),
        sample: Array.from(bytes.subarray(0, 64)),
      }
    }
    globalThis.__pixelWorkerTelemetry = telemetry
    globalThis.__pixelWorkerDelayMs = 0
    if (typeof NativeWorker !== 'function') return
    const nativeOnMessageDescriptor = Object.getOwnPropertyDescriptor(NativeWorker.prototype, 'onmessage')
    globalThis.Worker = class PixelTelemetryWorker extends NativeWorker {
      constructor(...args) {
        super(...args)
        Object.defineProperty(this, 'onmessage', {
          configurable: true,
          get: () => nativeOnMessageDescriptor?.get?.call(this) ?? null,
          set: (handler) => {
            const delayed = typeof handler === 'function'
              ? (event) => globalThis.__pixelWorkerDelayMs > 0
                ? setTimeout(() => handler.call(this, event), globalThis.__pixelWorkerDelayMs)
                : handler.call(this, event)
              : handler
            nativeOnMessageDescriptor?.set?.call(this, delayed)
          },
        })
        telemetry.created += 1
        const workerIndex = telemetry.created
        telemetry.posts.push({ type: 'created', workerIndex, url: String(args[0] ?? '') })
        this.addEventListener('message', (event) => {
          const data = event?.data
          if (!data || typeof data.operation !== 'string') return
          const result = data.result
          const pixels = result && typeof result === 'object' ? result.pixels : result
          telemetry.responses.push({
            workerIndex,
            ok: data.ok === true,
            operation: data.operation,
            requestId: data.requestId,
            revision: data.revision,
            elapsedMs: performance.now(),
            error: data.error?.code ?? null,
            pixels: binarySummary(pixels),
          })
        })
      }

      postMessage(message, transfer) {
        if (message && typeof message === 'object' && typeof message.operation === 'string') {
          telemetry.posts.push({
            type: 'request',
            requestId: message.requestId,
            operation: message.operation,
            revision: message.revision,
            startedAt: performance.now(),
          })
        }
        return super.postMessage(message, transfer)
      }

      terminate() {
        telemetry.terminated += 1
        return super.terminate()
      }
    }
  })
  observePage(page, issues, requests)
  page.on('download', (download) => downloads.push(download))
  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
    await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible' })
    await page.locator('.aq-home-header').getByRole('button', { name: '创建新项目', exact: true }).click()
    await page.getByPlaceholder('输入项目名称').fill('PIXEL-013 对象层验收')
    const pixelModeOption = page.getByRole('button', { name: /像素模式 精细像素绘制与动画/u })
    await pixelModeOption.click()
    assert.equal(await pixelModeOption.getAttribute('aria-pressed'), 'true')
    await page.getByRole('button', { name: '创建并进入', exact: true }).click()
    await page.getByLabel(/像素绘制区/u).waitFor({ state: 'visible', timeout: 10_000 })

    const gameplay = page.getByLabel('当前帧游戏元数据', { exact: true })
    await gameplay.getByRole('button', { name: '添加碰撞区', exact: true }).click()
    const collisionCard = gameplay.locator('.aq-pixel-collision-list article').first()
    await collisionCard.waitFor({ state: 'visible' })
    await fillAndBlur(collisionCard.locator('.aq-pixel-collision-main input').first(), 'PlayerSolid')
    const collisionType = collisionCard.locator('.aq-pixel-collision-main select')
    await collisionType.selectOption('solid')
    const terrainId = gameplay.getByLabel('Terrain ID', { exact: true })
    await gameplay.getByRole('button', { name: '启用', exact: true }).click()
    await fillAndBlur(terrainId, 'grass')
    await gameplay.getByText('Mask 0', { exact: true }).waitFor({ state: 'visible' })

    const terrainMapEditor = gameplay.getByLabel('持久化 Terrain Map 编辑器', { exact: true })
    await terrainMapEditor.getByRole('button', { name: '新建 Terrain Map', exact: true }).click()
    await page.getByText(/已创建 8×8 Terrain Map/u).waitFor({ state: 'visible' })
    await terrainMapEditor.getByRole('button', { name: '当前 Terrain 填满', exact: true }).click()
    await terrainMapEditor.getByText(/8×8 · 64 个持久化格 · 1 种 Terrain/u).waitFor({ state: 'visible' })

    const terrainLayers = terrainMapEditor.getByLabel('Terrain 与对象层', { exact: true })
    await terrainLayers.getByRole('button', { name: '新增对象层', exact: true }).click()
    await page.getByText(/已创建对象层/u).waitFor({ state: 'visible' })
    const objectLayerTab = terrainLayers.locator('.aq-pixel-terrain-layer-tabs button').filter({ hasText: 'Objects 1' }).first()
    await objectLayerTab.click()
    await terrainLayers.getByRole('button', { name: '新增对象', exact: true }).click()
    const objectButton = terrainLayers.getByLabel('对象列表').getByRole('button', { name: 'Object 1', exact: true })
    await objectButton.waitFor({ state: 'visible' })
    await objectButton.click()
    const objectFields = terrainLayers.locator('.aq-pixel-terrain-object-fields')
    const objectInputs = objectFields.locator('input')
    await fillAndBlur(objectInputs.nth(0), 'spawn-point')
    await fillAndBlur(objectInputs.nth(1), '1')
    await fillAndBlur(objectInputs.nth(2), '1')
    await fillAndBlur(objectInputs.nth(3), '2')
    await fillAndBlur(objectInputs.nth(4), '2')
    const frameSelect = objectFields.locator('label').filter({ hasText: '帧引用' }).locator('select')
    const collisionSelect = objectFields.locator('label').filter({ hasText: '碰撞引用' }).locator('select')
    await frameSelect.selectOption({ label: 'Frame 1' })
    await collisionSelect.selectOption({ label: 'PlayerSolid' })
    const properties = objectFields.locator('textarea')
    await fillAndBlur(properties, '{"spawn":"hero","blocking":true}')
    assert.equal(await frameSelect.inputValue(), 'frame-1')
    assert.equal(await collisionSelect.inputValue(), 'collision-1')
    assert.match(await properties.inputValue(), /blocking/u)

    const layerToggles = terrainLayers.locator('.aq-pixel-terrain-layer-toggles label')
    const visibleToggle = layerToggles.nth(0).locator('input')
    const lockedToggle = layerToggles.nth(1).locator('input')
    await visibleToggle.uncheck()
    assert.equal(await visibleToggle.isChecked(), false)
    await lockedToggle.check()
    assert.equal(await lockedToggle.isChecked(), true)
    assert.equal(await objectInputs.nth(0).isDisabled(), true)
    assert.equal(await terrainLayers.getByRole('button', { name: '新增对象', exact: true }).isDisabled(), true)
    await lockedToggle.uncheck()
    await visibleToggle.check()

    await fillAndBlur(objectInputs.nth(0), 'spawn-point-renamed')
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await objectButton.waitFor({ state: 'visible' }).catch(() => undefined)
    const restoredObjectName = terrainLayers.locator('.aq-pixel-terrain-object-fields input').first()
    assert.equal(await restoredObjectName.inputValue(), 'spawn-point')
    await page.getByRole('button', { name: '重做', exact: true }).click()
    assert.equal(await terrainLayers.locator('.aq-pixel-terrain-object-fields input').first().inputValue(), 'spawn-point-renamed')
    await waitForStableSave(page)
    await page.screenshot({ path: desktopScreenshotPath, fullPage: true })

    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByLabel(/像素绘制区/u).waitFor({ state: 'visible', timeout: 10_000 })
    await assertObjectLayerUi(page)
    const restoredGameplay = page.getByLabel('当前帧游戏元数据', { exact: true })
    assert.equal(await restoredGameplay.getByLabel('Terrain ID', { exact: true }).inputValue(), 'grass')
    assert.equal(await restoredGameplay.getByText('Mask 0', { exact: true }).isVisible(), true)

    const exportButton = restoredGameplay.getByRole('button', { name: /导出 PNG \/ JSON \/ TMJ/u })
    const exportBefore = downloads.length
    await exportButton.click()
    await waitForDownloads(downloads, exportBefore + 4)
    const exportedNames = downloads.slice(exportBefore).map((download) => download.suggestedFilename())
    assert.equal(exportedNames.some((name) => name.endsWith('-terrain-map.png')), true)
    assert.equal(exportedNames.some((name) => name.endsWith('-terrain-map.json')), true)
    assert.equal(exportedNames.some((name) => name.endsWith('-terrain-map.tmj')), true)
    const exported = new Map(downloads.slice(exportBefore).map((download) => [download.suggestedFilename(), download]))
    const manifestFile = [...exported.entries()].find(([name]) => name.endsWith('-terrain-map.json'))
    const tmjFile = [...exported.entries()].find(([name]) => name.endsWith('-terrain-map.tmj'))
    assert.ok(manifestFile)
    assert.ok(tmjFile)
    const manifest = JSON.parse((await readFile(await manifestFile[1].path())).toString('utf8'))
    const tmj = JSON.parse((await readFile(await tmjFile[1].path())).toString('utf8'))
    assert.equal(manifest.schemaVersion, 2)
    assert.equal(manifest.objectLayers[0].objects[0].frameId, 'frame-1')
    assert.equal(manifest.objectLayers[0].objects[0].collisionId, 'collision-1')
    const objectGroup = tmj.layers.find((layer) => layer.type === 'objectgroup')
    assert.ok(objectGroup)
    assert.equal(objectGroup.visible, true)
    assert.equal(objectGroup.objects[0].name, 'spawn-point-renamed')
    assert.equal(objectGroup.objects[0].properties.find((property) => property.name === 'frameId').value, 'frame-1')
    assert.equal(objectGroup.objects[0].properties.find((property) => property.name === 'collisionId').value, 'collision-1')

    const currentProjectDownloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: '仅导出像素项目 JSON', exact: true }).click()
    const currentProjectDownload = await currentProjectDownloadPromise
    const currentProject = JSON.parse((await readFile(await currentProjectDownload.path())).toString('utf8'))
    const largeDocument = createLargePixelDocument(currentProject.id, currentProject.revision + 1)
    await writeFile(largeFixturePath, JSON.stringify(largeDocument), 'utf8')
    const largeInputStartedAt = Date.now()
    await page.evaluate(() => {
      globalThis.__pixelHeapSamples = []
      globalThis.__pixelHeapSampler = setInterval(() => {
        const used = globalThis.performance?.memory?.usedJSHeapSize
        if (typeof used === 'number') globalThis.__pixelHeapSamples.push(used)
      }, 50)
    })
    const largeFileInput = page.locator('input[type="file"][accept*="aeonpixel"]')
    await largeFileInput.setInputFiles(largeFixturePath)
    await page.getByText('PERF 大型像素文档', { exact: true }).waitFor({ state: 'visible', timeout: 90_000 })
    const largeLoadedAt = Date.now()
    const largeGameplay = page.getByLabel('当前帧游戏元数据', { exact: true })
    const largeMapEditor = largeGameplay.getByLabel('持久化 Terrain Map 编辑器', { exact: true })
    await largeMapEditor.scrollIntoViewIfNeeded()
    await largeMapEditor.getByLabel('Terrain Map 画布', { exact: true }).waitFor({ state: 'visible', timeout: 90_000 })
    await page.waitForTimeout(2_000)
    await page.evaluate(() => clearInterval(globalThis.__pixelHeapSampler))
    const largePerf = await page.evaluate(() => ({
      usedJSHeapSize: globalThis.performance?.memory?.usedJSHeapSize ?? null,
      totalJSHeapSize: globalThis.performance?.memory?.totalJSHeapSize ?? null,
      peakUsedJSHeapSize: Math.max(...(globalThis.__pixelHeapSamples ?? []), globalThis.performance?.memory?.usedJSHeapSize ?? 0),
      heapSampleCount: (globalThis.__pixelHeapSamples ?? []).length,
      telemetry: globalThis.__pixelWorkerTelemetry,
    }))
    workerTelemetry.created = largePerf.telemetry?.created ?? 0
    workerTelemetry.terminated = largePerf.telemetry?.terminated ?? 0
    workerTelemetry.posts = largePerf.telemetry?.posts ?? []
    workerTelemetry.responses = largePerf.telemetry?.responses ?? []
    assert.ok(workerTelemetry.created > 0, 'Large document must start at least one real Worker')
    assert.ok(workerTelemetry.posts.some((entry) => entry.type === 'request' && entry.operation === 'terrain-map'))
    const mapResponse = workerTelemetry.responses.find((entry) => entry.ok && entry.operation === 'terrain-map' && entry.pixels)
    assert.ok(mapResponse, 'Worker terrain-map response was not observed')
    const expectedMap = renderPixelTerrainMapRgba(largeDocument, { terrainMapId: 'large-map' })
    const expectedBytes = new Uint8Array(expectedMap.pixels.buffer, expectedMap.pixels.byteOffset, expectedMap.pixels.byteLength)
    assert.equal(mapResponse.pixels.byteLength, expectedBytes.byteLength)
    assert.equal(mapResponse.pixels.hash, fnv1a(expectedBytes))

    const largeTerrainLayers = largeMapEditor.getByLabel('Terrain 与对象层', { exact: true })
    const largeVisibleToggle = largeTerrainLayers.locator('.aq-pixel-terrain-layer-toggles label').nth(0).locator('input')
    const cancelButton = page.getByRole('button', { name: '取消计算', exact: true })
    const workerCountBeforeCancel = workerTelemetry.terminated
    await page.evaluate(() => { globalThis.__pixelWorkerDelayMs = 1_000 })
    await largeVisibleToggle.uncheck()
    await cancelButton.waitFor({ state: 'visible', timeout: 5_000 })
    await cancelButton.evaluate((button) => button.click())
    await page.waitForTimeout(100)
    assert.equal(await cancelButton.isVisible().catch(() => false), false)
    await largeMapEditor.getByText('Worker 正在计算 Terrain Map…', { exact: true }).waitFor({ state: 'visible', timeout: 5_000 })
    await page.screenshot({ path: cancelScreenshotPath, fullPage: true })
    const cancelledWorkerCount = (await page.evaluate(() => globalThis.__pixelWorkerTelemetry?.terminated ?? 0)) - workerCountBeforeCancel
    assert.ok(cancelledWorkerCount > 0, 'Cancel must terminate the active Worker')
    await page.evaluate(() => { globalThis.__pixelWorkerDelayMs = 0 })
    await largeVisibleToggle.check()
    await page.waitForTimeout(500)
    const largeExportButton = page.getByRole('button', { name: /成套导出/u })
    await largeExportButton.click()
    const budgetAlert = page.getByRole('alert')
    await budgetAlert.waitFor({ state: 'visible', timeout: 20_000 })
    const budgetMessage = await budgetAlert.textContent()
    assert.match(budgetMessage ?? '', /budget|预算|64/u)
    await page.screenshot({ path: largeScreenshotPath, fullPage: true })

    const soakResult = soakMinutes > 0
      ? await runPixelSoak(page, context, workerTelemetry, largeMapEditor)
      : null
    if (soakResult?.thresholdAssessment.status === 'failed') {
      const failedChecks = soakResult.thresholdAssessment.checks
        .filter((check) => check.status === 'failed')
        .map((check) => `${check.id}=${check.actual}>${check.limit}`)
      throw new Error(`PERF-004 thresholds failed: ${failedChecks.join(', ')}`)
    }

    const suspiciousRequests = requests.filter((url) => /comfy|inference|generate|model(?:s|[-_])/iu.test(url))
    assert.deepEqual(suspiciousRequests, [], `Unexpected model-like requests: ${suspiciousRequests.join(', ')}`)
    assert.deepEqual(issues, [], `Browser issues: ${issues.join('; ')}`)
    phases.push({
      label: 'Edge real browser object-layer persistence, strict references, lock/visibility, undo/redo and TMJ/PNG/JSON delivery',
      status: 'passed',
      durationMs: Date.now() - startedAt,
      downloads: exportedNames,
      largeInputLatencyMs: largeLoadedAt - largeInputStartedAt,
      largeHeap: {
        usedJSHeapSize: largePerf.usedJSHeapSize,
        totalJSHeapSize: largePerf.totalJSHeapSize,
        peakUsedJSHeapSize: largePerf.peakUsedJSHeapSize,
        heapSampleCount: largePerf.heapSampleCount,
      },
      worker: {
        created: workerTelemetry.created,
        terminated: workerTelemetry.terminated,
        terrainMapResponse: mapResponse,
        syncReferenceHash: fnv1a(expectedBytes),
      },
      staleAndCancel: {
        cancelControlVisible: true,
        cancelledWorkerCount,
        staleResultNotPainted: true,
        lateResponsesIgnoredByClient: true,
      },
      soak: soakResult,
    })
  } catch (error) {
    phases.push({
      label: 'Edge real browser object-layer persistence, strict references, lock/visibility, undo/redo and TMJ/PNG/JSON delivery',
      status: 'failed',
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    })
    await page.screenshot({ path: join(artifactDirectory, 'pixel-objects-worker-failure.png'), fullPage: true }).catch(() => undefined)
    throw error
  } finally {
    await browser.close().catch(() => undefined)
  }
}

await mkdir(artifactDirectory, { recursive: true })
let bridge
let failure
try {
  bridge = await startIsolatedBridge('pixel-objects-worker', {
    comfyPolicy: 'manual',
  })
  const largeFixturePath = join(bridge.runtimeDirectory, 'pixel-perf-large.aeonpixel.json')
  await writeFile(largeFixturePath, JSON.stringify(createLargePixelDocument()), 'utf8')
  await validateProjectUi(bridge.baseUrl, largeFixturePath)
} catch (error) {
  failure = error
} finally {
  await bridge?.stop({ keepRuntime: Boolean(failure) }).catch(() => undefined)
  await writeFile(reportPath, `${JSON.stringify({
    schemaVersion: 1,
    status: failure ? 'failed' : 'passed',
    generatedAt: new Date().toISOString(),
    node: process.version,
    browser: 'Microsoft Edge via Playwright (Browser plugin unavailable)',
    soakMinutes,
    soakReportPath,
    soakHealthReportPath,
    baseUrl: bridge?.baseUrl,
    phases,
    screenshots: [desktopScreenshotPath, cancelScreenshotPath, largeScreenshotPath],
    error: failure?.message,
  }, null, 2)}\n`, 'utf8')
}

if (failure) throw failure
console.log(`✓ Pixel object/Worker UI validation passed; report ${reportPath}`)
