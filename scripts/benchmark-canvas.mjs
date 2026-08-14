import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cpus, platform, release, totalmem } from 'node:os'
import { fileURLToPath } from 'node:url'
import { startIsolatedBridge } from './qa-runtime.mjs'

let chromium
try {
  ;({ chromium } = await import('playwright'))
} catch {
  throw new Error('Canvas benchmark requires the project dev dependency @playwright/test')
}

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const labelArgument = process.argv.find((argument) => argument.startsWith('--label='))
const label = (labelArgument?.slice('--label='.length) || 'current').replace(/[^a-zA-Z0-9_-]/g, '-')
const viewportArgument = process.argv.find((argument) => argument.startsWith('--viewport='))
const viewportPreset = viewportArgument?.slice('--viewport='.length) === 'mobile'
  ? { width: 390, height: 844, name: 'mobile' }
  : { width: 1440, height: 900, name: 'desktop' }
const shouldAssert = process.argv.includes('--assert')
const distAssets = await readdir(join(projectRoot, 'dist', 'assets'))
const imageFilename = distAssets.find((filename) => /^sample-summer-character-.*\.png$/.test(filename))
if (!imageFilename) throw new Error('Benchmark asset is missing. Run npm run build first.')
const bundleFilename = distAssets.find((filename) => /^index-.*\.js$/.test(filename))
if (!bundleFilename) throw new Error('Benchmark bundle is missing. Run npm run build first.')

async function latestModifiedAt(directory) {
  let latest = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = join(directory, entry.name)
    if (entry.isDirectory()) latest = Math.max(latest, await latestModifiedAt(target))
    else latest = Math.max(latest, (await stat(target)).mtimeMs)
  }
  return latest
}

const sourceModifiedAt = await latestModifiedAt(join(projectRoot, 'src'))
const distModifiedAt = (await stat(join(projectRoot, 'dist', 'index.html'))).mtimeMs
if (sourceModifiedAt > distModifiedAt) {
  throw new Error('Benchmark refused to use stale dist output. Run npm run build first.')
}

function generate4kFixture(inputPath, outputPath) {
  return new Promise((resolvePromise, rejectPromise) => {
    const command = process.env.FFMPEG_PATH || 'ffmpeg'
    const child = spawn(command, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-i', inputPath,
      '-frames:v', '1',
      '-vf', 'scale=3840:2160:flags=lanczos',
      outputPath,
    ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_000) })
    child.once('error', rejectPromise)
    child.once('exit', (code) => {
      if (code === 0) resolvePromise()
      else rejectPromise(new Error(`Unable to generate the true 4K benchmark fixture: ${stderr}`))
    })
  })
}

function percentile(values, ratio) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))]
}

function baseElement(id, kind, index) {
  const column = index % 22
  const row = Math.floor(index / 22)
  return {
    id,
    kind,
    name: `Benchmark ${kind} ${index}`,
    x: column * 260,
    y: row * 210,
    width: 210,
    height: 156,
    rotation: 0,
    opacity: 1,
    radius: 8,
    fill: kind === 'note' ? '#d8ccff' : '#ffffff',
    stroke: '#d5d8df',
    strokeWidth: 1,
    locked: false,
    visible: true,
    zIndex: index + 1,
  }
}

function createFixture(imageUrl) {
  const elements = []
  for (let index = 0; index < 300; index += 1) {
    const kind = index % 3 === 0 ? 'note' : index % 3 === 1 ? 'shape' : 'text'
    elements.push({
      ...baseElement(`benchmark-light-${index}`, kind, index),
      ...(kind === 'note' || kind === 'text' ? { content: `Performance fixture ${index}` } : {}),
    })
  }
  for (let index = 0; index < 30; index += 1) {
    const position = index < 4 ? index * 3 : 300 + index
    elements.push({
      ...baseElement(`benchmark-image-${index}`, 'image', position),
      src: imageUrl,
      sourceSrc: imageUrl,
      naturalWidth: 3840,
      naturalHeight: 2160,
      assetId: `benchmark-asset-${index}`,
      assetVersion: 1,
      adjustments: { brightness: 100, contrast: 100, saturation: 100 },
      processingStack: [],
    })
  }
  elements.unshift({
    ...baseElement('canvas-background', 'frame', -1),
    name: 'Benchmark background',
    x: -600,
    y: -500,
    width: 7_000,
    height: 4_200,
    fill: 'transparent',
    stroke: 'transparent',
    strokeWidth: 0,
    radius: 0,
    locked: true,
    zIndex: 0,
  })
  return {
    schemaVersion: 1,
    id: 'performance-project',
    title: 'Canvas performance fixture',
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    camera: { x: 70, y: 45, zoom: 1 },
    elements,
  }
}

const bridge = await startIsolatedBridge(`canvas-benchmark-${label}`)
const benchmarkImageFilename = 'canvas-benchmark-4k.png'
await generate4kFixture(
  join(projectRoot, 'dist', 'assets', imageFilename),
  join(bridge.runtimeDirectory, 'assets', benchmarkImageFilename),
)
const browserChannel = process.env.MIAOHUI_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined)
let browser
let failed = true
try {
  browser = await chromium.launch({ headless: true, ...(browserChannel ? { channel: browserChannel } : {}) })
  const browserVersion = browser.version()
  const page = await browser.newPage({ viewport: { width: viewportPreset.width, height: viewportPreset.height } })
  const issues = []
  page.on('pageerror', (error) => issues.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (['warning', 'error'].includes(message.type())) issues.push(`${message.type()}: ${message.text()}`)
  })
  const fixture = createFixture(`/api/assets/${benchmarkImageFilename}`)
  await page.addInitScript((document) => {
    localStorage.setItem('miaohui-canvas:v8', JSON.stringify(document))
  }, fixture)
  await page.goto(bridge.baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.getByLabel('无限画布').waitFor({ state: 'visible' })
  await page.waitForFunction(() => document.querySelectorAll('[data-canvas-element]').length > 0)
  await page.waitForFunction(
    () => [...document.querySelectorAll('.canvas-element img')]
      .some((image) => image.getAttribute('src')?.includes('variant=thumbnail-v1')),
    undefined,
    { timeout: 15_000 },
  )
  await page.waitForTimeout(250)

  const readDomMetrics = () => page.evaluate(() => {
    const images = [...document.querySelectorAll('.canvas-element img')]
    return {
      totalDomNodes: document.querySelectorAll('*').length,
      canvasElements: document.querySelectorAll('[data-canvas-element]').length,
      imageElements: images.length,
      thumbnailImages: images.filter((image) => image.dataset.resourceTier === 'thumbnail').length,
      previewImages: images.filter((image) => image.dataset.resourceTier === 'preview').length,
      managedOriginalImages: images.filter((image) =>
        image.getAttribute('src')?.includes('/api/project-assets/')
        && !image.getAttribute('src')?.includes('variant='),
      ).length,
      reportedTotal: Number(document.querySelector('.canvas-world')?.getAttribute('data-total-elements') || 0),
      reportedRendered: Number(document.querySelector('.canvas-world')?.getAttribute('data-rendered-elements') || 0),
    }
  })
  const initialDom = await readDomMetrics()

  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  const beforeMetrics = await cdp.send('Performance.getMetrics')
  await page.evaluate(() => {
    const viewport = document.querySelector('.canvas-viewport')
    const world = document.querySelector('.canvas-world')
    const state = {
      frames: [],
      pointerFeedback: [],
      pendingPointerTimes: [],
      running: true,
      last: performance.now(),
    }
    window.__miaohuiBenchmark = state
    state.onPointerMove = (event) => {
      if ((event.buttons & 4) !== 0) state.pendingPointerTimes.push(performance.now())
    }
    state.observer = new MutationObserver(() => {
      const committedAt = performance.now()
      state.pointerFeedback.push(...state.pendingPointerTimes.splice(0).map((startedAt) => committedAt - startedAt))
    })
    viewport?.addEventListener('pointermove', state.onPointerMove, { capture: true })
    if (world) state.observer.observe(world, { attributes: true, attributeFilter: ['style'] })
    const tick = (now) => {
      if (!state.running) return
      state.frames.push(now - state.last)
      state.last = now
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })

  const viewport = await page.getByLabel('无限画布').boundingBox()
  assert.ok(viewport)
  const start = { x: viewport.x + viewport.width * 0.62, y: viewport.y + viewport.height * 0.55 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down({ button: 'middle' })
  const interactionStartedAt = Date.now()
  for (let step = 0; step < 90; step += 1) {
    await page.mouse.move(start.x - step * 5, start.y - step * 2)
    await page.waitForTimeout(8)
  }
  await page.mouse.up({ button: 'middle' })
  const interactionDurationMs = Date.now() - interactionStartedAt
  await page.waitForTimeout(300)
  const interactionSamples = await page.evaluate(() => {
    const state = window.__miaohuiBenchmark
    state.running = false
    document.querySelector('.canvas-viewport')?.removeEventListener('pointermove', state.onPointerMove, { capture: true })
    state.observer.disconnect()
    return { frames: state.frames, pointerFeedback: state.pointerFeedback }
  })
  const frames = interactionSamples.frames
  const pointerFeedback = interactionSamples.pointerFeedback
  const afterMetrics = await cdp.send('Performance.getMetrics')
  const metricMap = Object.fromEntries(afterMetrics.metrics.map((metric) => [metric.name, metric.value]))
  const beforeMetricMap = Object.fromEntries(beforeMetrics.metrics.map((metric) => [metric.name, metric.value]))
  const dom = await readDomMetrics()
  const report = {
    schemaVersion: 2,
    label,
    generatedAt: new Date().toISOString(),
    browser: browserChannel || 'bundled-chromium',
    environment: {
      browserVersion,
      platform: platform(),
      osRelease: release(),
      cpu: cpus()[0]?.model || 'unknown',
      logicalCpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
      deviceScaleFactor: 1,
    },
    build: { bundleFilename, distModifiedAt: new Date(distModifiedAt).toISOString() },
    viewport: viewportPreset,
    fixture: {
      lightElements: 300,
      imageElements: 30,
      actualImageDimensions: '3840x2160',
      sourceAssetCount: 1,
    },
    initialDom,
    dom,
    interaction: {
      pointerMoves: 90,
      durationMs: interactionDurationMs,
      frameSamples: frames.length,
      frameP50Ms: Number(percentile(frames, 0.5).toFixed(2)),
      frameP95Ms: Number(percentile(frames, 0.95).toFixed(2)),
      frameMaxMs: Number(Math.max(...frames).toFixed(2)),
      framesOver32Ms: frames.filter((duration) => duration > 32).length,
      pointerFeedbackSamples: pointerFeedback.length,
      pointerFeedbackP50Ms: Number(percentile(pointerFeedback, 0.5).toFixed(2)),
      pointerFeedbackP95Ms: Number(percentile(pointerFeedback, 0.95).toFixed(2)),
      pointerFeedbackMaxMs: Number(Math.max(0, ...pointerFeedback).toFixed(2)),
    },
    chromium: {
      jsHeapUsedBytes: metricMap.JSHeapUsedSize || 0,
      domNodes: metricMap.Nodes || 0,
      layoutCountDelta: (metricMap.LayoutCount || 0) - (beforeMetricMap.LayoutCount || 0),
      recalcStyleCountDelta: (metricMap.RecalcStyleCount || 0) - (beforeMetricMap.RecalcStyleCount || 0),
      taskDurationDeltaSeconds: Number(((metricMap.TaskDuration || 0) - (beforeMetricMap.TaskDuration || 0)).toFixed(4)),
      scriptDurationDeltaSeconds: Number(((metricMap.ScriptDuration || 0) - (beforeMetricMap.ScriptDuration || 0)).toFixed(4)),
    },
    issues,
  }
  const reportDirectory = join(projectRoot, '.runtime', 'qa')
  await mkdir(reportDirectory, { recursive: true })
  const reportPath = join(reportDirectory, `canvas-performance-${label}.json`)
  await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8')
  if (shouldAssert) {
    assert.equal(issues.length, 0, issues.join('\n'))
    assert.ok(dom.totalDomNodes <= 450, `Expected at most 450 total DOM nodes, received ${dom.totalDomNodes}`)
    assert.ok(dom.canvasElements <= 110, `Expected at most 110 rendered canvas elements, received ${dom.canvasElements}`)
    assert.ok(initialDom.thumbnailImages >= 1, 'Expected at least one initially visible image to use the thumbnail tier')
    assert.equal(initialDom.managedOriginalImages, 0, 'Canvas must not decode managed original images')
    assert.ok(report.interaction.frameP95Ms <= 20, `Frame P95 exceeded 20ms: ${report.interaction.frameP95Ms}`)
    assert.ok(pointerFeedback.length >= 45, `Expected at least 45 pointer feedback samples, received ${pointerFeedback.length}`)
    assert.ok(report.interaction.pointerFeedbackP95Ms <= 50, `Pointer feedback P95 exceeded 50ms: ${report.interaction.pointerFeedbackP95Ms}`)
  }
  console.log(JSON.stringify({ reportPath, ...report }, null, 2))
  failed = false
} finally {
  await browser?.close().catch(() => {})
  await bridge.stop({ keepRuntime: failed })
}
