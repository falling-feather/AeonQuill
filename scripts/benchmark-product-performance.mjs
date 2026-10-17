import assert from 'node:assert/strict'
import { cpus, platform, release, totalmem } from 'node:os'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

import {
  assessProductPerformance,
  finalizeSoak,
  PRODUCT_PERFORMANCE_SMOKE_LATENCY_MULTIPLIER,
  PRODUCT_PERFORMANCE_VERSION,
  summarizeSamples,
  validatePerformanceThresholds,
} from './product-performance.mjs'
import { startIsolatedBridge } from './qa-runtime.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const thresholdsPath = join(projectRoot, 'benchmarks', 'product-performance', 'thresholds.json')
const reportDirectory = join(projectRoot, '.runtime', 'qa')
const modeIds = ['balanced', 'pixel', 'smart-video']
const modeLabels = {
  balanced: '均衡模式',
  pixel: '像素模式',
  'smart-video': '智能视频',
}
const args = new Map(process.argv.slice(2).map((argument) => {
  const separator = argument.indexOf('=')
  return separator === -1 ? [argument, true] : [argument.slice(0, separator), argument.slice(separator + 1)]
}))
const profile = args.get('--profile') || 'smoke'
if (!['smoke', 'formal'].includes(profile)) throw new Error('--profile must be smoke or formal')
const shouldAssert = args.has('--assert')
const label = String(args.get('--label') || profile).replace(/[^a-z0-9_-]/giu, '-').slice(0, 48) || profile
const thresholds = validatePerformanceThresholds(JSON.parse(await readFile(thresholdsPath, 'utf8')))
const viewport = thresholds.environment.viewport
const sampleCount = profile === 'formal'
  ? {
      cold: thresholds.environment.coldSamples,
      warm: thresholds.environment.warmSamples,
      mode: thresholds.environment.modeSamples,
    }
  : { cold: 3, warm: 3, mode: 3 }
const soakDurationMs = profile === 'formal'
  ? thresholds.environment.formalSoakMinutes * 60_000
  : thresholds.environment.smokeSoakSeconds * 1_000
const reportPath = join(reportDirectory, `product-performance-${label}.json`)
const report = {
  schemaVersion: PRODUCT_PERFORMANCE_VERSION,
  profile,
  status: 'failed',
  generatedAt: new Date().toISOString(),
  environment: {},
  build: {},
  configuration: {
    viewport,
    coldSamples: sampleCount.cold,
    warmSamples: sampleCount.warm,
    modeSamples: sampleCount.mode,
    soakDurationMs,
    modeDwellMs: thresholds.environment.modeDwellMs,
    homeDwellMs: thresholds.environment.homeDwellMs,
    latencyMultiplier: profile === 'formal' ? 1 : PRODUCT_PERFORMANCE_SMOKE_LATENCY_MULTIPLIER,
  },
  home: {},
  modes: {},
  resilience: {},
  soak: null,
  thresholds,
  assessment: null,
  issues: [],
}

function now() {
  return performance.now()
}

function durationSince(startedAt) {
  return Number((now() - startedAt).toFixed(2))
}

function delay(durationMs) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, durationMs))
}

async function waitUntil(check, message, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await delay(75)
  }
  throw new Error(message)
}

function observePage(page, issues) {
  page.on('pageerror', (error) => issues.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    const text = message.text()
    if ((message.type() === 'error' || message.type() === 'warning') && !text.includes('Failed to load resource')) {
      issues.push(`${message.type()}: ${text}`)
    }
  })
}

async function settleFrames(page) {
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise((resolvePromise) => requestAnimationFrame(() => requestAnimationFrame(resolvePromise)))
  })
}

async function waitHome(page) {
  await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
  const createButton = page.locator('.aq-home-header').getByRole('button', { name: '创建新项目', exact: true })
  await createButton.waitFor({ state: 'visible', timeout: 30_000 })
  await waitUntil(() => createButton.isEnabled(), 'Project catalog did not become ready')
  await settleFrames(page)
}

function modeReadyLocator(page, modeId) {
  if (modeId === 'balanced') return page.locator('[data-product-mode="balanced"]').getByLabel('无限画布')
  if (modeId === 'pixel') return page.locator('[data-product-mode="pixel"] [aria-label="光阴砚像素模式工作台"]')
  return page.locator('[data-product-mode="smart-video"] [aria-label="智能视频工作台"]')
}

async function waitModeReady(page, modeId) {
  const ready = modeReadyLocator(page, modeId)
  const gateActionLabels = modeId === 'balanced'
    ? ['创建本机画布']
    : modeId === 'pixel'
      ? ['开始像素草稿', '忽略并开始新草稿']
      : ['开始新故事', '忽略并开始新故事']
  const deadline = Date.now() + 40_000
  while (Date.now() < deadline) {
    if (await ready.isVisible().catch(() => false)) {
      await settleFrames(page)
      return
    }
    for (const actionLabel of gateActionLabels) {
      const action = page.getByRole('button', { name: actionLabel, exact: true })
      if (await action.isVisible().catch(() => false)) {
        await action.click()
        break
      }
    }
    await delay(75)
  }
  const state = await page.evaluate(() => ({
    title: document.title,
    headings: [...document.querySelectorAll('h1, h2, h3')].map((element) => element.textContent?.trim()).filter(Boolean).slice(0, 12),
    buttons: [...document.querySelectorAll('button')].filter((element) => !element.hidden).map((element) => element.textContent?.trim()).filter(Boolean).slice(0, 20),
    text: document.body.innerText.replace(/\s+/gu, ' ').trim().slice(0, 800),
  })).catch(() => ({ unavailable: true }))
  throw new Error(`${modeLabels[modeId]} did not become ready at ${page.url()}; state=${JSON.stringify(state)}`)
}

async function returnHome(page) {
  if (await page.getByRole('heading', { name: '项目中心', exact: true }).isVisible().catch(() => false)) {
    await waitHome(page)
    return
  }
  await page.evaluate(() => {
    window.location.hash = ''
  })
  await waitHome(page)
}

async function createProjectForMode(page, modeId, suffix) {
  await waitHome(page)
  await page.locator('.aq-home-header').getByRole('button', { name: '创建新项目', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '创建新项目', exact: true })
  await dialog.waitFor({ state: 'visible', timeout: 10_000 })
  await dialog.getByPlaceholder('输入项目名称').fill(`性能基准-${modeLabels[modeId]}-${suffix}`)
  const modeOption = dialog.locator('.aq-project-mode-option').filter({ hasText: modeLabels[modeId] })
  await modeOption.click()
  await waitUntil(async () => await modeOption.getAttribute('aria-pressed') === 'true', `${modeLabels[modeId]} option was not selected`, 5_000)
  const startedAt = now()
  await dialog.getByRole('button', { name: '创建并进入', exact: true }).click()
  await waitModeReady(page, modeId)
  return {
    durationMs: durationSince(startedAt),
    hash: await page.evaluate(() => window.location.hash),
  }
}

async function useHash(page, hash, modeId) {
  await page.evaluate((nextHash) => {
    window.location.hash = nextHash
  }, hash)
  await waitModeReady(page, modeId)
}

async function measureColdHome(browser, bridge, issues) {
  const samples = []
  for (let index = 0; index < sampleCount.cold; index += 1) {
    const context = await browser.newContext({ viewport })
    const page = await context.newPage()
    observePage(page, issues)
    const session = await context.newCDPSession(page)
    await session.send('Network.enable')
    await session.send('Network.setCacheDisabled', { cacheDisabled: true })
    const startedAt = now()
    await page.goto(bridge.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await waitHome(page)
    samples.push(durationSince(startedAt))
    await context.close()
  }
  return summarizeSamples(samples)
}

async function measureWarmHome(browser, bridge, issues) {
  const context = await browser.newContext({ viewport })
  const page = await context.newPage()
  observePage(page, issues)
  await page.goto(bridge.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await waitHome(page)
  const samples = []
  for (let index = 0; index < sampleCount.warm; index += 1) {
    const startedAt = now()
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 })
    await waitHome(page)
    samples.push(durationSince(startedAt))
  }
  await context.close()
  return summarizeSamples(samples)
}

async function measureFirstModeEntry(browser, bridge, modeId, issues) {
  const samples = []
  for (let index = 0; index < sampleCount.mode; index += 1) {
    const context = await browser.newContext({ viewport })
    const page = await context.newPage()
    observePage(page, issues)
    await page.goto(bridge.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    const result = await createProjectForMode(page, modeId, `first-${index + 1}`)
    samples.push(result.durationMs)
    await context.close()
  }
  return summarizeSamples(samples)
}

async function measureCachedModeEntry(browser, bridge, modeId, issues) {
  const context = await browser.newContext({ viewport })
  const page = await context.newPage()
  observePage(page, issues)
  await page.goto(bridge.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  const created = await createProjectForMode(page, modeId, 'cached-seed')
  const samples = []
  for (let index = 0; index < sampleCount.mode; index += 1) {
    await returnHome(page)
    const startedAt = now()
    await useHash(page, created.hash, modeId)
    samples.push(durationSince(startedAt))
  }
  await context.close()
  return summarizeSamples(samples)
}

async function validateTransientProjectReadRecovery(browser, bridge, issues) {
  const context = await browser.newContext({ viewport })
  const page = await context.newPage()
  observePage(page, issues)
  await page.goto(bridge.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  const created = await createProjectForMode(page, 'balanced', 'transient-read')
  await page.locator('.save-status').filter({ hasText: /^已保存$/u }).waitFor({ state: 'visible' })
  await returnHome(page)
  let requests = 0
  await page.route((url) => url.pathname === '/api/projects/current' && url.searchParams.has('id'), async (route) => {
    requests += 1
    if (requests === 1) {
      await route.abort('connectionreset')
      return
    }
    await route.continue()
  })
  await useHash(page, created.hash, 'balanced')
  assert.ok(requests >= 2, 'A transient project GET must be retried before showing an error gate')
  await context.close()
  return { status: 'passed', interruptedRequests: 1, totalRequests: requests }
}

function metricsByName(payload) {
  return new Map(payload.metrics.map((metric) => [metric.name, metric.value]))
}

async function collectMemorySample(session, startedAt) {
  await session.send('HeapProfiler.collectGarbage')
  await delay(50)
  const metrics = metricsByName(await session.send('Performance.getMetrics'))
  const value = (name) => {
    const result = metrics.get(name)
    if (!Number.isFinite(result)) throw new Error(`Chromium did not expose ${name}`)
    return Math.round(result)
  }
  return {
    elapsedMs: Math.max(0, Date.now() - startedAt),
    jsHeapUsedBytes: value('JSHeapUsedSize'),
    domNodes: value('Nodes'),
    documents: value('Documents'),
    eventListeners: value('JSEventListeners'),
  }
}

async function openAndClose(page, openName, readyLocator, closeName) {
  const open = page.getByRole('button', { name: openName, exact: true }).first()
  if (!await open.isVisible().catch(() => false)) return
  await open.click()
  await readyLocator(page).waitFor({ state: 'visible', timeout: 20_000 })
  const close = page.getByRole('button', { name: closeName, exact: true }).first()
  await close.click()
  await readyLocator(page).waitFor({ state: 'hidden', timeout: 10_000 })
}

async function exerciseOptionalSurface(page, cycle) {
  if (cycle % 7 === 0) {
    await openAndClose(
      page,
      '打开跨模式资源库',
      (target) => target.locator('.aq-library-dialog'),
      '关闭资源库',
    )
  }
  if (cycle % 11 === 0) {
    await openAndClose(
      page,
      '打开工作流中心',
      (target) => target.locator('.aq-workflow-center'),
      '关闭工作流中心',
    )
  }
}

async function measureSoak(browser, bridge, issues) {
  const context = await browser.newContext({ viewport })
  const page = await context.newPage()
  observePage(page, issues)
  await page.goto(bridge.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await waitHome(page)

  const routes = {}
  for (const modeId of modeIds) {
    const created = await createProjectForMode(page, modeId, 'soak')
    routes[modeId] = created.hash
    await returnHome(page)
  }

  const session = await context.newCDPSession(page)
  await session.send('Performance.enable')
  await session.send('HeapProfiler.enable')
  const startedAt = Date.now()
  const samples = [await collectMemorySample(session, startedAt)]
  let nextSampleAt = startedAt + 5_000
  let nextProgressAt = startedAt + 60_000
  let cycles = 0

  while (Date.now() - startedAt < soakDurationMs) {
    const modeId = modeIds[cycles % modeIds.length]
    await useHash(page, routes[modeId], modeId)
    await delay(thresholds.environment.modeDwellMs)
    await exerciseOptionalSurface(page, cycles + 1)
    await returnHome(page)
    await delay(thresholds.environment.homeDwellMs)
    cycles += 1

    const currentTime = Date.now()
    if (currentTime >= nextSampleAt) {
      samples.push(await collectMemorySample(session, startedAt))
      nextSampleAt = currentTime + 5_000
    }
    if (currentTime >= nextProgressAt) {
      const latest = samples.at(-1)
      console.log(`  soak ${Math.floor((currentTime - startedAt) / 60_000)} min · ${cycles} cycles · heap ${(latest.jsHeapUsedBytes / 1024 / 1024).toFixed(1)} MiB · DOM ${latest.domNodes}`)
      nextProgressAt = currentTime + 60_000
    }
    await delay(125)
  }

  await returnHome(page)
  for (const closeName of ['关闭资源库', '关闭工作流中心', '关闭本机设置']) {
    const close = page.getByRole('button', { name: closeName, exact: true }).first()
    if (await close.isVisible().catch(() => false)) await close.click()
  }
  await session.send('HeapProfiler.collectGarbage')
  await delay(100)
  await session.send('HeapProfiler.collectGarbage')
  const finalSample = await collectMemorySample(session, startedAt)
  if (finalSample.elapsedMs === samples.at(-1).elapsedMs) finalSample.elapsedMs += 1
  samples.push(finalSample)
  const releaseState = await page.evaluate(() => ({
    modeHosts: document.querySelectorAll('[data-product-mode]').length,
    mediaElements: document.querySelectorAll('video, audio, .canvas-viewport, [aria-label="光阴砚像素模式工作台"], [aria-label="智能视频工作台"]').length,
  }))
  const result = finalizeSoak(samples, releaseState, Date.now() - startedAt, cycles)
  await context.close()
  return result
}

async function readBuildIdentity() {
  const manifestPath = join(projectRoot, 'dist', '.vite', 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const entry = manifest['src/main.tsx'] || Object.values(manifest).find((item) => item.isEntry)
  if (!entry?.file) throw new Error('Production manifest does not contain the application entry')
  const entryPath = join(projectRoot, 'dist', entry.file)
  const details = await stat(entryPath)
  return {
    entryFile: entry.file,
    entryBytes: details.size,
    distModifiedAt: details.mtime.toISOString(),
  }
}

async function latestModifiedAt(directory) {
  let latest = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = join(directory, entry.name)
    latest = Math.max(latest, entry.isDirectory() ? await latestModifiedAt(target) : (await stat(target)).mtimeMs)
  }
  return latest
}

await mkdir(reportDirectory, { recursive: true })
const sourceModifiedAt = await latestModifiedAt(join(projectRoot, 'src'))
const distModifiedAt = (await stat(join(projectRoot, 'dist', 'index.html')).catch(() => null))?.mtimeMs || 0
if (sourceModifiedAt > distModifiedAt) {
  throw new Error('Product performance benchmark refused to use stale dist output. Run npm run build first.')
}
const bridge = await startIsolatedBridge('product-performance')
const browserScratch = join(bridge.runtimeDirectory, 'browser')
await mkdir(browserScratch, { recursive: true })
const previousTemp = process.env.TEMP
const previousTmp = process.env.TMP
process.env.TEMP = browserScratch
process.env.TMP = browserScratch
const browserChannel = process.env.MIAOHUI_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined)
let browser

try {
  console.log(`AEONQUILL ${profile} product performance gate · headless ${browserChannel || 'Chromium'} · ${soakDurationMs / 1000}s soak`)
  browser = await chromium.launch({
    headless: true,
    ...(browserChannel ? { channel: browserChannel } : {}),
    downloadsPath: join(browserScratch, 'downloads'),
    args: [
      `--disk-cache-dir=${join(browserScratch, 'cache')}`,
      '--disable-background-networking',
    ],
  })
  report.environment = {
    browserChannel: browserChannel || 'chromium',
    browserVersion: browser.version(),
    headless: true,
    platform: platform(),
    release: release(),
    cpu: cpus()[0]?.model || 'unknown',
    logicalCpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    viewport,
    temporaryStorage: 'isolated-runtime-on-project-volume',
  }
  report.build = await readBuildIdentity()

  console.log('  measuring cold and warm home readiness')
  report.home.cold = await measureColdHome(browser, bridge, report.issues)
  report.home.warm = await measureWarmHome(browser, bridge, report.issues)
  for (const modeId of modeIds) {
    console.log(`  measuring ${modeLabels[modeId]} first and cached entry`)
    report.modes[modeId] = {
      first: await measureFirstModeEntry(browser, bridge, modeId, report.issues),
      cached: await measureCachedModeEntry(browser, bridge, modeId, report.issues),
    }
  }
  console.log('  validating transient project-read recovery')
  report.resilience.transientProjectRead = await validateTransientProjectReadRecovery(browser, bridge, report.issues)
  console.log('  exercising repeated mode and dialog lifecycle')
  report.soak = await measureSoak(browser, bridge, report.issues)
  assert.deepEqual(report.issues, [], `Browser issues: ${report.issues.join(' | ')}`)
  report.assessment = assessProductPerformance(report, thresholds, {
    requireFormalSoak: profile === 'formal',
    latencyMultiplier: profile === 'formal' ? 1 : PRODUCT_PERFORMANCE_SMOKE_LATENCY_MULTIPLIER,
  })
  report.status = report.assessment.status

  const summary = [
    `home cold/warm P95 ${report.home.cold.p95}/${report.home.warm.p95} ms`,
    ...modeIds.map((modeId) => `${modeId} first/cached P95 ${report.modes[modeId].first.p95}/${report.modes[modeId].cached.p95} ms`),
    `soak ${Math.round(report.soak.durationMs / 1000)}s/${report.soak.cycles} cycles`,
    `heap growth ${(report.soak.growth.jsHeapUsedBytes / 1024 / 1024).toFixed(2)} MiB`,
    `DOM growth ${report.soak.growth.domNodes}`,
  ].join(' · ')
  console.log(`  ${summary}`)
  if (shouldAssert && report.status !== 'passed') {
    const failed = report.assessment.checks.filter((item) => item.status === 'failed')
    throw new Error(`Product performance thresholds failed: ${failed.map((item) => `${item.id}=${item.actual}>${item.limit}`).join(', ')}`)
  }
  console.log(`✓ product performance ${profile} gate ${report.status}`)
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? error.message : String(error)
  const bridgeLogs = bridge.logs()
  report.bridgeLogs = {
    stdoutTail: bridgeLogs.stdout.slice(-16_000),
    stderrTail: bridgeLogs.stderr.slice(-16_000),
  }
  throw error
} finally {
  report.generatedAt = new Date().toISOString()
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await browser?.close().catch(() => undefined)
  await bridge.stop()
  if (previousTemp === undefined) delete process.env.TEMP
  else process.env.TEMP = previousTemp
  if (previousTmp === undefined) delete process.env.TMP
  else process.env.TMP = previousTmp
  console.log(`  report: ${reportPath}`)
}
