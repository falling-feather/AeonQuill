import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startIsolatedBridge } from './qa-runtime.mjs'

let chromium
try {
  ;({ chromium } = await import('playwright'))
} catch {
  throw new Error('Mode-loading validation requires @playwright/test. Run npm install first.')
}

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(await readFile(join(projectRoot, 'dist', '.vite', 'manifest.json'), 'utf8'))
const balancedChunk = manifest['src/App.tsx']?.file
const libraryChunk = manifest['src/components/Library/AssetLibraryDialog.tsx']?.file
const workflowChunk = manifest['src/components/WorkflowCenter/WorkflowCenterDialog.tsx']?.file
const settingsChunk = manifest['src/components/Home/RuntimeSettingsDialog.tsx']?.file
assert.ok(balancedChunk && libraryChunk && workflowChunk && settingsChunk, 'Expected lazy surface files in Vite manifest')

const delay = (durationMs) => new Promise((resolvePromise) => setTimeout(resolvePromise, durationMs))
const bridge = await startIsolatedBridge('mode-loading')
const browserChannel = process.env.MIAOHUI_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined)
const report = {
  schemaVersion: 1,
  status: 'failed',
  generatedAt: new Date().toISOString(),
  checks: [],
}

let browser
let page

async function delayChunk(relativeFile, durationMs) {
  let requests = 0
  await page.route((url) => url.pathname.endsWith(`/${relativeFile}`), async (route) => {
    requests += 1
    await delay(durationMs)
    await route.continue()
  })
  return () => requests
}

async function waitForBalancedEntry(targetPage = page) {
  const canvas = targetPage.getByLabel('无限画布')
  const createCanvas = targetPage.getByRole('button', { name: '创建本机画布', exact: true })
  await canvas.or(createCanvas).first().waitFor({ state: 'visible', timeout: 20_000 })
  if (await createCanvas.isVisible()) await createCanvas.click()
  return canvas
}

try {
  browser = await chromium.launch({ headless: true, ...(browserChannel ? { channel: browserChannel } : {}) })
  const homePage = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await homePage.goto(bridge.baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await homePage.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible' })
  await delay(250)
  const eagerSurfaceRequests = await homePage.evaluate((surfaceFiles) => (
    performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((url) => surfaceFiles.some((file) => url.endsWith(`/${file}`)))
  ), [balancedChunk, libraryChunk, workflowChunk, settingsChunk])
  assert.deepEqual(eagerSurfaceRequests, [])
  report.checks.push({ id: 'home-no-eager-surfaces', status: 'passed', requests: 0 })
  await homePage.close()

  page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const unexpectedIssues = []
  let collectIssues = false
  page.on('pageerror', (error) => {
    if (collectIssues) unexpectedIssues.push(`pageerror: ${error.message}`)
  })
  page.on('console', (message) => {
    if (collectIssues && (message.type() === 'error' || message.type() === 'warning')) {
      unexpectedIssues.push(`${message.type()}: ${message.text()}`)
    }
  })

  let balancedRequests = 0
  await page.route((url) => url.pathname.endsWith(`/${balancedChunk}`), async (route) => {
    balancedRequests += 1
    if (balancedRequests === 1) {
      await route.abort('failed')
      return
    }
    await delay(2_500)
    await route.continue()
  })

  const balancedUrl = new URL(bridge.baseUrl)
  balancedUrl.hash = '/balanced?project=local-project'
  await page.goto(balancedUrl.href, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  const firstCanvas = await waitForBalancedEntry()
  const failureHeading = page.getByRole('heading', { name: '均衡模式未能完成初始化', exact: true })
  await failureHeading.waitFor({ state: 'visible', timeout: 15_000 })
  await page.getByText('当前项目内容仍保存在本机。', { exact: false }).waitFor({ state: 'visible' })
  const reloadButton = page.getByRole('button', { name: '重新载入应用', exact: true })
  assert.equal(await reloadButton.isVisible(), true)
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20_000 }),
    reloadButton.click(),
  ])

  const recoveredCanvas = await waitForBalancedEntry()
  await page.locator('[data-mode-module-loading="balanced"]').waitFor({ state: 'visible', timeout: 10_000 })
  await recoveredCanvas.waitFor({ state: 'visible', timeout: 20_000 })
  assert.ok(balancedRequests >= 2, 'Balanced chunk must be requested again after explicit reload recovery')
  report.checks.push({ id: 'mode-load-recovery', status: 'passed', requests: balancedRequests })

  collectIssues = true
  const libraryRequests = await delayChunk(libraryChunk, 900)
  await page.getByRole('button', { name: '打开跨模式资源库', exact: true }).click()
  await page.getByRole('dialog', { name: '正在载入资源库', exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  await page.locator('.aq-library-dialog').waitFor({ state: 'visible', timeout: 20_000 })
  assert.equal(libraryRequests(), 1)
  await page.getByRole('button', { name: '关闭资源库', exact: true }).click()
  report.checks.push({ id: 'library-loading-state', status: 'passed', requests: libraryRequests() })

  const workflowRequests = await delayChunk(workflowChunk, 900)
  await page.getByRole('button', { name: '打开工作流中心', exact: true }).click()
  await page.getByRole('dialog', { name: '正在载入工作流中心', exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  await page.locator('.aq-workflow-center').waitFor({ state: 'visible', timeout: 20_000 })
  assert.equal(workflowRequests(), 1)
  await page.getByRole('button', { name: '关闭工作流中心', exact: true }).click()
  report.checks.push({ id: 'workflow-loading-state', status: 'passed', requests: workflowRequests() })

  await page.goto(bridge.baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible' })
  const settingsRequests = await delayChunk(settingsChunk, 900)
  await page.locator('.aq-home-header').getByRole('button', { name: '打开设置', exact: true }).click()
  await page.getByRole('dialog', { name: '正在载入设置', exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  await page.getByRole('dialog', { name: '本机能力与设置', exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
  assert.equal(settingsRequests(), 1)
  assert.equal(await page.locator('body').evaluate((body) => body.scrollWidth <= body.clientWidth), true)
  await page.getByRole('button', { name: '关闭本机设置', exact: true }).click()
  report.checks.push({ id: 'settings-loading-state', status: 'passed', requests: settingsRequests() })

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } })
  let mobileBalancedRequests = 0
  let releaseMobileChunk
  const mobileChunkGate = new Promise((resolvePromise) => { releaseMobileChunk = resolvePromise })
  await mobile.route((url) => url.pathname.endsWith(`/${balancedChunk}`), async (route) => {
    mobileBalancedRequests += 1
    await mobileChunkGate
    await route.continue()
  })
  await mobile.goto(balancedUrl.href, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  const mobileCanvas = mobile.getByLabel('无限画布')
  const mobileCreateCanvas = mobile.getByRole('button', { name: '创建本机画布', exact: true })
  const mobileLoading = mobile.locator('[data-mode-module-loading="balanced"]')
  await mobileLoading.or(mobileCreateCanvas).or(mobileCanvas).first().waitFor({ state: 'visible', timeout: 20_000 })
  if (await mobileCreateCanvas.isVisible()) await mobileCreateCanvas.click()
  await mobileLoading.waitFor({ state: 'visible', timeout: 10_000 })
  releaseMobileChunk()
  await mobileCanvas.waitFor({ state: 'visible', timeout: 20_000 })
  assert.equal(mobileBalancedRequests, 1)
  assert.equal(await mobile.locator('body').evaluate((body) => body.scrollWidth <= body.clientWidth), true)
  await mobile.close()
  report.checks.push({ id: 'mobile-mode-loading-state', status: 'passed', requests: mobileBalancedRequests })

  assert.deepEqual(unexpectedIssues, [])
  report.status = 'passed'
  console.log('✓ recoverable mode loading and deferred dialog states passed in headless desktop/mobile UI')
} finally {
  report.generatedAt = new Date().toISOString()
  await mkdir(join(projectRoot, '.runtime', 'qa'), { recursive: true })
  await writeFile(join(projectRoot, '.runtime', 'qa', 'mode-loading-ui.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await page?.close().catch(() => undefined)
  await browser?.close().catch(() => undefined)
  await bridge.stop()
}
