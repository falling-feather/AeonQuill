import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { startIsolatedBridge } from './qa-runtime.mjs'

let chromium
try {
  ;({ chromium } = await import('playwright'))
} catch {
  throw new Error('Job archive UI validation requires @playwright/test. Run npm install first.')
}

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const reportPath = join(projectRoot, '.runtime', 'qa', 'job-archive-ui.json')
const now = Date.now()
const archivedJobs = [
  {
    id: 'ui-failed-job', kind: 'video', tool: 'text-to-video', label: '武侠镜头生成',
    status: 'failed', phase: 'failed', progress: 63, detail: '采样阶段失败', createdAt: now - 100,
    updatedAt: now - 50,
    error: { code: 'GPU_OOM', title: '显存不足', message: '失败诊断被完整保留', suggestions: ['降低并发后重试'] },
    logs: [{ at: now - 50, level: 'error', message: 'GPU_OOM · sampler' }],
    archiveMetadata: { schemaVersion: 1, archivedAt: now, reason: 'manual' },
  },
  {
    id: 'ui-completed-job', kind: 'image', tool: 'pixelate', label: '角色像素化',
    status: 'completed', phase: 'completed', progress: 100, detail: '处理完成', createdAt: now - 200,
    completedAt: now - 150,
    logs: [{ at: now - 150, level: 'success', message: '输出已写入资源库' }],
    archiveMetadata: { schemaVersion: 1, archivedAt: now - 1, reason: 'age' },
  },
]

const bridge = await startIsolatedBridge('job-archive-ui')
const report = {
  schemaVersion: 1,
  status: 'failed',
  generatedAt: new Date().toISOString(),
  checks: [],
}
let browser
let failure

async function openBalanced(page) {
  const url = new URL(bridge.baseUrl)
  url.hash = '/balanced?project=local-project'
  await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  const canvas = page.getByLabel('无限画布')
  const createCanvas = page.getByRole('button', { name: '创建本机画布', exact: true })
  await canvas.or(createCanvas).first().waitFor({ state: 'visible', timeout: 20_000 })
  if (await createCanvas.isVisible()) await createCanvas.click()
  await canvas.waitFor({ state: 'visible', timeout: 20_000 })
}

async function inspectArchive(page, mobile = false) {
  if (mobile) await page.getByRole('button', { name: '打开属性面板', exact: true }).click()
  await page.getByRole('tab', { name: '任务', exact: true }).click()
  await page.getByRole('button', { name: /^历史/u }).click()
  await page.getByText('任务归档', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  await page.getByText('2 条完整历史', { exact: false }).waitFor({ state: 'visible', timeout: 10_000 })
  await page.getByText('GPU_OOM', { exact: true }).waitFor({ state: 'visible' })
  await page.getByText('失败诊断被完整保留', { exact: true }).waitFor({ state: 'visible' })
  await page.getByText('手动整理', { exact: false }).waitFor({ state: 'visible' })
  await page.getByText('超过保留期', { exact: false }).waitFor({ state: 'visible' })
  await page.getByText('运行日志 · 1', { exact: true }).first().click()
  await page.getByText('GPU_OOM · sampler', { exact: true }).waitFor({ state: 'visible' })
  assert.equal(await page.locator('body').evaluate((body) => body.scrollWidth <= body.clientWidth), true)
}

try {
  await writeFile(join(bridge.runtimeDirectory, 'job-archive.json'), JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    updatedAt: now,
    jobs: archivedJobs,
  }, null, 2), 'utf8')
  await bridge.restart()

  const browserChannel = process.env.MIAOHUI_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined)
  browser = await chromium.launch({ headless: true, ...(browserChannel ? { channel: browserChannel } : {}) })

  for (const target of [
    { id: 'desktop', width: 1440, height: 900, mobile: false },
    { id: 'mobile', width: 390, height: 844, mobile: true },
  ]) {
    const page = await browser.newPage({ viewport: { width: target.width, height: target.height } })
    const issues = []
    let archiveRequests = 0
    page.on('pageerror', (error) => issues.push(`pageerror: ${error.message}`))
    page.on('console', (message) => {
      if (message.type() === 'error') issues.push(`console: ${message.text()}`)
    })
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/jobs/archive') archiveRequests += 1
    })
    await openBalanced(page)
    assert.equal(archiveRequests, 0, 'Archive must not load before the user opens history')
    await inspectArchive(page, target.mobile)
    assert.equal(archiveRequests, 1)
    assert.deepEqual(issues, [])
    report.checks.push({ id: target.id, status: 'passed', archiveRequests, viewport: `${target.width}x${target.height}` })
    await page.close()
  }
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

if (!failure) console.log('✓ Job archive history is lazy, readable and responsive on desktop and mobile')
