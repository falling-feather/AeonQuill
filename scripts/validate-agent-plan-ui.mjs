import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { startIsolatedBridge } from './qa-runtime.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const reportPath = join(projectRoot, '.runtime', 'qa', 'agent-plan-ui-v0758.json')
const bridge = await startIsolatedBridge('agent-plan-ui')
const browserChannel = process.env.MIAOHUI_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined)
const report = {
  schemaVersion: 1,
  status: 'failed',
  generatedAt: new Date().toISOString(),
  browser: browserChannel || 'bundled-chromium',
  modes: [],
  issues: [],
}
let browser
let page

function observePage(target) {
  target.on('pageerror', (error) => report.issues.push(`pageerror: ${error.message}`))
  target.on('console', (message) => {
    const value = message.text()
    if ((message.type() === 'error' || message.type() === 'warning') && !value.includes('Failed to load resource')) {
      report.issues.push(`${message.type()}: ${value}`)
    }
  })
}

async function createProject(title, optionName, ready) {
  await page.locator('.aq-home-header').getByRole('button', { name: '创建新项目', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '创建新项目' })
  await dialog.waitFor({ state: 'visible' })
  await dialog.getByPlaceholder('输入项目名称').fill(title)
  await dialog.getByRole('button', { name: optionName }).click()
  await dialog.getByRole('button', { name: '创建并进入', exact: true }).click()
  await dialog.waitFor({ state: 'hidden', timeout: 15_000 })
  await ready().waitFor({ state: 'visible', timeout: 20_000 })
}

async function returnHome() {
  await page.getByRole('button', { name: /返回.*主页/u }).first().click()
  await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
}

async function evidence(title, modeId) {
  return page.evaluate(async ({ expectedTitle, expectedModeId }) => {
    const catalogResponse = await fetch('/api/workspace/catalog')
    const catalogPayload = await catalogResponse.json()
    const project = catalogPayload.catalog.projects.find((candidate) => candidate.title === expectedTitle)
    if (!project) throw new Error(`Missing project ${expectedTitle}`)
    const registration = project.documents.find((candidate) => candidate.modeId === expectedModeId)
    if (!registration) throw new Error(`Missing ${expectedModeId} registration`)
    const bodyResponse = await fetch(`/api/workspace/documents/${encodeURIComponent(registration.id)}?projectId=${encodeURIComponent(project.id)}&modeId=${encodeURIComponent(expectedModeId)}`)
    const bodyPayload = await bodyResponse.json()
    const receiptsResponse = await fetch(`/api/workspace/projects/${encodeURIComponent(project.id)}/agent-plan-receipts?documentId=${encodeURIComponent(registration.id)}&limit=20`)
    const receiptsPayload = await receiptsResponse.json()
    return {
      projectId: project.id,
      documentId: registration.id,
      registrationRevision: registration.revision,
      bodyRevision: bodyPayload.document.revision,
      value: JSON.parse(bodyPayload.document.value),
      receipts: receiptsPayload.receipts,
    }
  }, { expectedTitle: title, expectedModeId: modeId })
}

async function waitForEvidence(title, modeId, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  let latest
  while (Date.now() < deadline) {
    latest = await evidence(title, modeId)
    if (predicate(latest)) return latest
    await page.waitForTimeout(100)
  }
  throw new Error(`Timed out waiting for ${title}/${modeId}; latest revision ${latest?.bodyRevision}`)
}

async function rejectVisiblePlan() {
  const dialog = page.locator('.aq-agent-plan-dialog')
  await dialog.waitFor({ state: 'visible' })
  await dialog.getByRole('button', { name: '拒绝并保留原稿', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
}

async function approveVisiblePlan() {
  const dialog = page.locator('.aq-agent-plan-dialog')
  await dialog.waitFor({ state: 'visible' })
  await dialog.getByRole('button', { name: '批准并执行', exact: true }).click()
  await dialog.waitFor({ state: 'hidden', timeout: 15_000 })
}

try {
  browser = await chromium.launch({ headless: true, ...(browserChannel ? { channel: browserChannel } : {}) })
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  observePage(page)
  await page.goto(bridge.baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible', timeout: 15_000 })

  const balancedTitle = 'AI-002 均衡审批'
  await createProject(balancedTitle, /均衡模式 图像、文字与多模态创作/u, () => page.getByLabel('无限画布'))
  const balancedInitial = await evidence(balancedTitle, 'balanced')
  const projectionSeedStatus = await page.evaluate(async (document) => (await fetch('/api/projects/current', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ document }),
  })).status, balancedInitial.value)
  assert.equal(projectionSeedStatus, 200, 'Seed the older canvas asset projection before workspace approval')
  const prompt = page.getByLabel('画布快捷指令')
  await prompt.fill('创建标题 受控计划验证')
  await prompt.press('Enter')
  await page.locator('.aq-agent-plan-dialog').getByText('创建文字元件', { exact: true }).waitFor({ state: 'visible' })
  await rejectVisiblePlan()
  const balancedRejected = await evidence(balancedTitle, 'balanced')
  assert.equal(balancedRejected.bodyRevision, balancedInitial.bodyRevision)
  assert.equal(balancedRejected.value.elements.length, 0)
  assert.equal(balancedRejected.receipts.length, 0)
  await prompt.fill('创建标题 受控计划验证')
  await prompt.press('Enter')
  await approveVisiblePlan()
  const balancedApproved = await waitForEvidence(
    balancedTitle,
    'balanced',
    (entry) => entry.bodyRevision === balancedInitial.bodyRevision + 1 && entry.receipts.length === 1,
  )
  assert.equal(balancedApproved.registrationRevision, balancedApproved.bodyRevision)
  assert.equal(balancedApproved.value.elements.some(({ content }) => content === '受控计划验证'), true)
  assert.equal(balancedApproved.receipts[0].modeId, 'balanced')
  const canvasRead = await page.evaluate(async (id) => {
    const response = await fetch(`/api/projects/current?id=${encodeURIComponent(id)}`)
    if (!response.ok) throw new Error(`Canvas read returned ${response.status}`)
    return (await response.json()).project
  }, balancedApproved.value.id)
  assert.equal(canvasRead.document.revision, balancedApproved.value.revision)
  assert.equal(canvasRead.document.elements.some(({ content }) => content === '受控计划验证'), true,
    'A pre-approval canvas autosave must not take precedence over the committed workspace document')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByLabel('无限画布').waitFor({ state: 'visible', timeout: 15_000 })
  await page.getByText('受控计划验证', { exact: true }).waitFor({ state: 'visible' })
  report.modes.push({ modeId: 'balanced', rejectedRevision: balancedRejected.bodyRevision, committedRevision: balancedApproved.bodyRevision, receipt: balancedApproved.receipts[0].id, reloaded: true })
  await returnHome()

  const pixelTitle = 'AI-002 像素审批'
  await createProject(pixelTitle, /像素模式 精细像素绘制与动画/u, () => page.getByLabel(/像素绘制区/u))
  const pixelCanvas = page.getByLabel(/像素绘制区/u)
  const box = await pixelCanvas.boundingBox()
  assert.ok(box)
  const paintCell = async (x, y) => {
    await pixelCanvas.click({ position: { x: ((x + 0.5) / 16) * box.width, y: ((y + 0.5) / 16) * box.height } })
  }
  await paintCell(2, 2)
  await paintCell(3, 2)
  await paintCell(2, 3)
  await paintCell(3, 3)
  await paintCell(12, 12)
  const pixelPainted = await waitForEvidence(pixelTitle, 'pixel', (entry) => entry.bodyRevision >= 5)
  const activeFrame = pixelPainted.value.frames.find(({ id }) => id === pixelPainted.value.activeFrameId)
  const beforePixels = activeFrame.cels[pixelPainted.value.activeLayerId].filter(Boolean).length
  assert.equal(beforePixels, 5)
  await page.getByRole('button', { name: '本地智能清理', exact: true }).click()
  await rejectVisiblePlan()
  const pixelRejected = await evidence(pixelTitle, 'pixel')
  assert.equal(pixelRejected.bodyRevision, pixelPainted.bodyRevision)
  assert.equal(pixelRejected.receipts.length, 0)
  await page.getByRole('button', { name: '本地智能清理', exact: true }).click()
  await approveVisiblePlan()
  const pixelApproved = await waitForEvidence(
    pixelTitle,
    'pixel',
    (entry) => entry.bodyRevision === pixelPainted.bodyRevision + 1 && entry.receipts.length === 1,
  )
  const cleanedFrame = pixelApproved.value.frames.find(({ id }) => id === pixelApproved.value.activeFrameId)
  assert.equal(cleanedFrame.cels[pixelApproved.value.activeLayerId].filter(Boolean).length, 4)
  assert.equal(pixelApproved.registrationRevision, pixelApproved.bodyRevision)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByLabel(/像素绘制区/u).waitFor({ state: 'visible', timeout: 15_000 })
  await page.getByText(/本模式最近回执/u).count().catch(() => 0)
  report.modes.push({ modeId: 'pixel', rejectedRevision: pixelRejected.bodyRevision, committedRevision: pixelApproved.bodyRevision, receipt: pixelApproved.receipts[0].id, reloaded: true })
  await returnHome()

  const videoTitle = 'AI-002 视频审批'
  await createProject(videoTitle, /智能视频 从灵感或剧本开始制片/u, () => page.getByRole('region', { name: '多智能体制片工作室' }))
  const studio = page.getByRole('region', { name: '多智能体制片工作室' })
  await studio.getByText('剧本设计', { exact: true }).first().click()
  await studio.getByRole('button', { name: '请求本地建议', exact: true }).click()
  await studio.getByText('剧本设计 · 本地受控建议', { exact: true }).waitFor({ state: 'visible' })
  const videoProposed = await waitForEvidence(
    videoTitle,
    'smart-video',
    (entry) => entry.value.production.changeCards.some(({ status }) => status === 'proposed'),
  )
  await studio.getByRole('button', { name: '接受变更', exact: true }).click()
  await rejectVisiblePlan()
  const videoRejected = await evidence(videoTitle, 'smart-video')
  assert.equal(videoRejected.bodyRevision, videoProposed.bodyRevision)
  assert.equal(videoRejected.receipts.length, 0)
  assert.equal(videoRejected.value.production.changeCards.some(({ status }) => status === 'proposed'), true)
  await studio.getByRole('button', { name: '接受变更', exact: true }).click()
  await approveVisiblePlan()
  const videoApproved = await waitForEvidence(
    videoTitle,
    'smart-video',
    (entry) => entry.bodyRevision === videoProposed.bodyRevision + 1 && entry.receipts.length === 1,
  )
  assert.equal(videoApproved.value.production.changeCards.some(({ status }) => status === 'accepted'), true)
  assert.equal(videoApproved.registrationRevision, videoApproved.bodyRevision)
  await page.reload({ waitUntil: 'domcontentloaded' })
  const restoredStudio = page.getByRole('region', { name: '多智能体制片工作室' })
  await restoredStudio.waitFor({ state: 'visible', timeout: 15_000 })
  await restoredStudio.getByText('剧本设计', { exact: true }).first().click()
  await restoredStudio.getByText(/accepted/u).waitFor({ state: 'visible' })
  report.modes.push({ modeId: 'smart-video', rejectedRevision: videoRejected.bodyRevision, committedRevision: videoApproved.bodyRevision, receipt: videoApproved.receipts[0].id, reloaded: true })

  assert.deepEqual(report.issues, [])
  report.status = 'passed'
  console.log('✓ Cross-mode Agent plans reject without mutation and approve atomically with reloadable receipts')
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error)
  throw error
} finally {
  report.generatedAt = new Date().toISOString()
  await mkdir(join(projectRoot, '.runtime', 'qa'), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await page?.close().catch(() => undefined)
  await browser?.close().catch(() => undefined)
  await bridge.stop()
}
