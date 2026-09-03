import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { startIsolatedBridge } from './qa-runtime.mjs'

let chromium
try {
  ;({ chromium } = await import('playwright'))
} catch {
  throw new Error('Diagnostic bundle UI validation requires @playwright/test. Run npm install first.')
}

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const reportPath = join(projectRoot, '.runtime', 'qa', 'diagnostic-bundle-ui.json')
const bridge = await startIsolatedBridge('diagnostic-bundle-ui')
const report = { schemaVersion: 1, status: 'failed', generatedAt: new Date().toISOString(), checks: [] }
let browser
let failure

async function inspectTarget(target) {
  const page = await browser.newPage({ viewport: { width: target.width, height: target.height }, acceptDownloads: true })
  const issues = []
  let createRequests = 0
  page.on('pageerror', (error) => issues.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') issues.push(`console: ${message.text()}`)
  })
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/diagnostics/bundles' && request.method() === 'POST') createRequests += 1
  })
  try {
    await page.goto(bridge.baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
    await page.getByRole('button', { name: '打开设置', exact: true }).click()
    await page.getByRole('heading', { name: '本机能力与设置', exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
    const exportButton = page.getByRole('button', { name: '导出脱敏诊断包', exact: true })
    await exportButton.waitFor({ state: 'visible' })
    await exportButton.waitFor({ state: 'attached' })
    await assert.doesNotReject(async () => {
      await page.waitForFunction(() => {
        const button = document.querySelector('button[aria-label="导出脱敏诊断包"]')
        return Boolean(button && !button.disabled)
      }, undefined, { timeout: 20_000 })
    })
    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 })
    await exportButton.click()
    const download = await downloadPromise
    assert.match(download.suggestedFilename(), /^aeonquill-diagnostics-diag-.*\.zip$/u)
    const downloadPath = await download.path()
    assert.ok(downloadPath)
    const archive = await readFile(downloadPath)
    assert.equal(archive.readUInt32LE(0), 0x04034b50)
    assert.doesNotMatch(archive.toString('utf8'), /(?:api[_-]?key|private-prompt|[A-Za-z]:\\Users\\)/iu)
    await page.getByText('脱敏诊断包已生成并开始下载', { exact: false }).waitFor({ state: 'visible', timeout: 10_000 })
    assert.equal(createRequests, 1)
    assert.equal(await page.locator('body').evaluate((body) => body.scrollWidth <= body.clientWidth), true)
    assert.deepEqual(issues, [])
    report.checks.push({ id: target.id, status: 'passed', viewport: `${target.width}x${target.height}`, createRequests, bytes: archive.length })
  } finally {
    await page.close()
  }
}

try {
  const browserChannel = process.env.MIAOHUI_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined)
  const downloadsPath = join(bridge.runtimeDirectory, 'browser-downloads')
  await mkdir(downloadsPath, { recursive: true })
  browser = await chromium.launch({
    headless: true,
    downloadsPath,
    ...(browserChannel ? { channel: browserChannel } : {}),
  })
  for (const target of [
    { id: 'desktop', width: 1440, height: 900 },
    { id: 'mobile', width: 390, height: 844 },
  ]) await inspectTarget(target)
  report.status = 'passed'
} catch (error) {
  failure = error
  report.error = error.message
  process.exitCode = 1
  console.error(error.stack || error.message)
} finally {
  if (browser) await browser.close().catch(() => {})
  await mkdir(join(projectRoot, '.runtime', 'qa'), { recursive: true })
  await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8')
  const logs = bridge.logs()
  await bridge.stop({ keepRuntime: Boolean(failure) })
  if (failure) console.error(`QA runtime retained: ${bridge.runtimeDirectory}\n${logs.stdout}\n${logs.stderr}`)
}

if (!failure) console.log('✓ Diagnostic bundle export is downloadable and responsive on desktop and mobile')
