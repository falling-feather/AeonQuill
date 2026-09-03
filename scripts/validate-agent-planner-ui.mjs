import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { startIsolatedBridge } from './qa-runtime.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const reportPath = join(projectRoot, '.runtime', 'qa', 'agent-planner-ui-v0759.json')
const bridge = await startIsolatedBridge('agent-planner-ui')
const browserChannel = process.env.MIAOHUI_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined)
const upstreamCalls = []
const report = {
  schemaVersion: 1,
  status: 'failed',
  generatedAt: new Date().toISOString(),
  browser: browserChannel || 'bundled-chromium',
  modes: [],
  issues: [],
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
}

function requestHash(model, messages) {
  return createHash('sha256').update(JSON.stringify(canonicalize({ model, messages }))).digest('hex')
}

function candidateFor(modeId, requestBody) {
  if (modeId === 'balanced') {
    return {
      title: '建立品牌说明便签',
      objective: '在空白画布中加入一张受控品牌便签。',
      steps: [{
        toolId: 'canvas.elements.add',
        summary: '创建 BYOK 品牌便签',
        input: { elements: [{
          id: 'byok-note', kind: 'note', name: 'BYOK 品牌便签', x: 160, y: 140,
          width: 260, height: 140, rotation: 0, opacity: 1, radius: 10,
          fill: '#FFF4C2', stroke: '#E7CE75', content: 'Shape Light. Weave Time.',
          locked: false, visible: true, zIndex: 1,
        }] },
      }],
    }
  }
  if (modeId === 'pixel') {
    return {
      title: '调整 Ember 高光',
      objective: '用现有调色板增强高光辨识度。',
      steps: [{
        toolId: 'pixel.palette.replace',
        summary: '把 Ember 调整为明亮橙红色',
        input: { colorId: 'ember', color: '#FF7048FF', name: 'Bright Ember' },
      }],
    }
  }
  const userMessage = JSON.parse(requestBody.messages[1].content)
  return {
    title: '调整导演推进策略',
    objective: '让制片链采用与当前相反的自动推进策略以验证受控写入。',
    steps: [{
      toolId: 'video.project.patch',
      summary: '切换自动推进',
      input: { autoAdvance: !userMessage.context.production.autoAdvance },
    }],
  }
}

const upstream = createServer(async (request, response) => {
  try {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const system = body.messages?.[0]?.content ?? ''
    const modeId = ['balanced', 'pixel', 'smart-video'].find((mode) => system.includes(`当前模式是 ${mode}`))
    if (!modeId) throw new Error('Fake upstream could not identify mode')
    const hash = requestHash(body.model, body.messages)
    upstreamCalls.push({
      modeId,
      hash,
      authorization: request.headers.authorization,
      messages: structuredClone(body.messages),
    })
    const payload = {
      choices: [{ message: { content: JSON.stringify(candidateFor(modeId, body)) } }],
      usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 },
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(payload))
  } catch (error) {
    response.writeHead(500, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
  }
})

await new Promise((resolvePromise, rejectPromise) => {
  upstream.once('error', rejectPromise)
  upstream.listen(0, '127.0.0.1', resolvePromise)
})
const upstreamAddress = upstream.address()
if (!upstreamAddress || typeof upstreamAddress === 'string') throw new Error('Fake upstream did not bind a TCP port')
const upstreamBaseUrl = `http://127.0.0.1:${upstreamAddress.port}/v1`

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
    const catalogPayload = await (await fetch('/api/workspace/catalog')).json()
    const project = catalogPayload.catalog.projects.find((candidate) => candidate.title === expectedTitle)
    if (!project) throw new Error(`Missing project ${expectedTitle}`)
    const registration = project.documents.find((candidate) => candidate.modeId === expectedModeId)
    if (!registration) throw new Error(`Missing ${expectedModeId} registration`)
    const query = new URLSearchParams({ projectId: project.id, modeId: expectedModeId })
    const bodyPayload = await (await fetch(`/api/workspace/documents/${encodeURIComponent(registration.id)}?${query.toString()}`)).json()
    const receiptPayload = await (await fetch(`/api/workspace/projects/${encodeURIComponent(project.id)}/agent-plan-receipts?documentId=${encodeURIComponent(registration.id)}&limit=20`)).json()
    return {
      projectId: project.id,
      documentId: registration.id,
      registrationRevision: registration.revision,
      bodyRevision: bodyPayload.document.revision,
      value: JSON.parse(bodyPayload.document.value),
      receipts: receiptPayload.receipts,
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

async function openAndConfigure(launcherName) {
  await page.getByRole('button', { name: launcherName, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '文本智能体规划' })
  await dialog.waitFor({ state: 'visible' })
  await dialog.getByPlaceholder('https://provider.example/v1').fill(upstreamBaseUrl)
  await dialog.getByPlaceholder('model-id').fill('loopback-planner')
  await dialog.getByPlaceholder('只驻留本次运行内存').fill('key-loopback-1234')
  await dialog.getByRole('button', { name: '仅本次运行启用', exact: true }).click()
  await dialog.getByText('本次运行已启用', { exact: true }).waitFor({ state: 'visible' })
  if (process.env.AEONQUILL_QA_SCREENSHOT_PATH && !report.visualScreenshot) {
    await page.screenshot({ path: process.env.AEONQUILL_QA_SCREENSHOT_PATH, fullPage: false })
    report.visualScreenshot = process.env.AEONQUILL_QA_SCREENSHOT_PATH
  }
  return dialog
}

async function requestPlan(dialog, instruction) {
  await dialog.getByLabel('希望如何修改当前正文').fill(instruction)
  await dialog.getByRole('button', { name: '生成只读计划', exact: true }).click()
  await dialog.waitFor({ state: 'hidden', timeout: 15_000 })
  const review = page.locator('.aq-agent-plan-dialog')
  await review.waitFor({ state: 'visible', timeout: 15_000 })
  await review.getByText('BYOK 文本提案', { exact: true }).waitFor({ state: 'visible' })
  return review
}

async function clearAdapter(launcherName) {
  await page.getByRole('button', { name: launcherName, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '文本智能体规划' })
  await dialog.waitFor({ state: 'visible' })
  await dialog.getByRole('button', { name: '清除', exact: true }).click()
  await dialog.getByText('未配置', { exact: true }).waitFor({ state: 'visible' })
  await dialog.getByRole('button', { name: '关闭文本智能体规划', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
}

async function exerciseMode({ title, modeId, optionName, ready, launcherName, instruction, assertCommitted }) {
  await createProject(title, optionName, ready)
  const initial = await evidence(title, modeId)
  let dialog = await openAndConfigure(launcherName)
  let review = await requestPlan(dialog, instruction)
  await review.getByRole('button', { name: '拒绝并保留原稿', exact: true }).click()
  await review.waitFor({ state: 'hidden' })
  const rejected = await evidence(title, modeId)
  assert.equal(rejected.bodyRevision, initial.bodyRevision)
  assert.equal(rejected.registrationRevision, initial.registrationRevision)
  assert.equal(rejected.value ? JSON.stringify(rejected.value) : null, JSON.stringify(initial.value))
  assert.equal(rejected.receipts.length, 0)

  await page.getByRole('button', { name: launcherName, exact: true }).click()
  dialog = page.getByRole('dialog', { name: '文本智能体规划' })
  await dialog.waitFor({ state: 'visible' })
  await dialog.getByText('本次运行已启用', { exact: true }).waitFor({ state: 'visible' })
  review = await requestPlan(dialog, instruction)
  await review.getByRole('button', { name: '批准并执行', exact: true }).click()
  await review.waitFor({ state: 'hidden', timeout: 15_000 })
  const committed = await waitForEvidence(title, modeId, (entry) => entry.bodyRevision > initial.bodyRevision && entry.receipts.length === 1)
  assert.equal(committed.registrationRevision, committed.bodyRevision)
  assertCommitted(initial.value, committed.value)
  assert.equal(committed.receipts[0].source.kind, 'byok-text')
  assert.equal(committed.receipts[0].source.modelId, 'loopback-planner')
  const modeCalls = upstreamCalls.filter((call) => call.modeId === modeId)
  assert.equal(modeCalls.length, 2)
  assert.equal(committed.receipts[0].source.requestHash, modeCalls[1].hash)
  assert.equal(modeCalls.every((call) => call.authorization === 'Bearer key-loopback-1234'), true)
  assert.equal(modeCalls.some((call) => JSON.stringify(call.messages).includes('key-loopback-1234')), false)
  assert.equal(modeCalls.some((call) => /data:image|[A-Z]:\\|file:\/\//u.test(JSON.stringify(call.messages))), false)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await ready().waitFor({ state: 'visible', timeout: 15_000 })
  await clearAdapter(launcherName)
  report.modes.push({
    modeId,
    rejectedRevision: rejected.bodyRevision,
    committedRevision: committed.bodyRevision,
    receipt: committed.receipts[0].id,
    requestHash: committed.receipts[0].source.requestHash,
  })
  if (modeId !== 'smart-video') await returnHome()
}

try {
  browser = await chromium.launch({ headless: true, ...(browserChannel ? { channel: browserChannel } : {}) })
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  observePage(page)
  await page.goto(bridge.baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible', timeout: 15_000 })

  await exerciseMode({
    title: 'AI-004 均衡计划',
    modeId: 'balanced',
    optionName: /均衡模式 图像、文字与多模态创作/u,
    ready: () => page.getByLabel('无限画布'),
    launcherName: '文本智能体规划',
    instruction: '创建一张品牌说明便签。',
    assertCommitted: (before, after) => {
      assert.equal(before.elements.some(({ id }) => id === 'byok-note'), false)
      assert.equal(after.elements.some(({ id }) => id === 'byok-note'), true)
    },
  })

  await exerciseMode({
    title: 'AI-004 像素计划',
    modeId: 'pixel',
    optionName: /像素模式 精细像素绘制与动画/u,
    ready: () => page.getByLabel(/像素绘制区/u),
    launcherName: '文本智能体',
    instruction: '把 Ember 调整成更明亮的橙红色。',
    assertCommitted: (before, after) => {
      assert.notEqual(before.palette.find(({ id }) => id === 'ember').color, '#FF7048FF')
      assert.equal(after.palette.find(({ id }) => id === 'ember').color, '#FF7048FF')
    },
  })

  await exerciseMode({
    title: 'AI-004 视频计划',
    modeId: 'smart-video',
    optionName: /智能视频 从灵感或剧本开始制片/u,
    ready: () => page.getByRole('region', { name: '多智能体制片工作室' }),
    launcherName: '文本智能体',
    instruction: '切换自动推进策略，让导演逐节点复核。',
    assertCommitted: (before, after) => assert.equal(after.production.autoAdvance, !before.production.autoAdvance),
  })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '文本智能体', exact: true }).click()
  const mobileDialog = page.getByRole('dialog', { name: '文本智能体规划' })
  await mobileDialog.waitFor({ state: 'visible' })
  const mobileBox = await mobileDialog.boundingBox()
  assert.ok(mobileBox)
  assert.equal(mobileBox.x >= 0 && mobileBox.x + mobileBox.width <= 390, true)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  await mobileDialog.getByRole('button', { name: '关闭文本智能体规划', exact: true }).click()
  report.responsive = { viewport: '390x844', dialogWidth: Math.round(mobileBox.width), noPageOverflow: true }

  assert.equal(upstreamCalls.length, 6)
  assert.deepEqual(report.issues, [])
  report.status = 'passed'
  console.log('✓ Cross-mode BYOK planner configures in memory, previews read-only, rejects safely and commits through user approval')
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error)
  throw error
} finally {
  report.generatedAt = new Date().toISOString()
  report.upstreamCallCount = upstreamCalls.length
  await mkdir(join(projectRoot, '.runtime', 'qa'), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await page?.close().catch(() => undefined)
  await browser?.close().catch(() => undefined)
  await bridge.stop()
  await new Promise((resolvePromise) => upstream.close(() => resolvePromise()))
}
