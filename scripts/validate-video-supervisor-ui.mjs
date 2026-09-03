import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { startIsolatedBridge } from './qa-runtime.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const reportPath = join(projectRoot, '.runtime', 'qa', 'video-supervisor-ui-v0760.json')
const bridge = await startIsolatedBridge('video-supervisor-ui')
const browserChannel = process.env.MIAOHUI_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined)
const upstreamCalls = []
const report = {
  schemaVersion: 1,
  status: 'failed',
  generatedAt: new Date().toISOString(),
  browser: browserChannel || 'bundled-chromium',
  turns: [],
  issues: [],
}

const outputByNode = {
  'character-designer': '主角使用青黑劲装、旧银护腕与窄刃长剑；正侧背三视图固定发冠、脸部比例和雨夜服饰状态。',
  'art-director': '山门雨夜采用冷青月光与暖橙灯笼对照；石阶、飞檐、薄雾和积水反射构成统一地点圣经。',
  'storyboard-director': '以远景建立山门、跟拍推进人物、近景停在剑柄，再用反打和雨幕空镜完成可执行分镜。',
  screenwriter: '三幕结构围绕雨夜入山、旧案揭露与山门决战展开；每场保留明确行动目标和对白转折。',
}

function candidateFromRequest(body) {
  const userMessage = JSON.parse(body.messages?.[1]?.content ?? '{}')
  const nodes = userMessage.context?.production?.nodes ?? []
  const node = nodes.find((item) => ['running', 'ready', 'revision'].includes(item.status))
  if (!node || !outputByNode[node.id]) throw new Error('Fake upstream could not find the active Supervisor text node')
  return {
    nodeId: node.id,
    candidate: {
      title: `${node.title} · 制片督导轮次`,
      objective: `为${node.title}形成可人工审阅的受控文本产物。`,
      steps: [{
        toolId: 'video.node.edit',
        summary: `提交${node.title}产物摘要`,
        input: {
          nodeId: node.id,
          instructions: `围绕当前权威需求细化${node.title}，不得声称真实媒体任务已经完成。`,
          outputSummary: outputByNode[node.id],
        },
      }],
    },
  }
}

const upstream = createServer(async (request, response) => {
  try {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const system = body.messages?.[0]?.content ?? ''
    assert.match(system, /当前模式是 smart-video/u)
    assert.match(system, /video\.node\.edit/u)
    assert.doesNotMatch(system, /video\.project\.patch/u)
    const { nodeId, candidate } = candidateFromRequest(body)
    upstreamCalls.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      nodeId,
      messages: structuredClone(body.messages),
    })
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(candidate) } }],
      usage: { prompt_tokens: 40, completion_tokens: 30, total_tokens: 70 },
    }))
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
  target.on('response', (response) => {
    if (response.status() >= 400) report.issues.push(`http ${response.status()}: ${response.url()}`)
  })
}

async function createSmartVideoProject() {
  await page.locator('.aq-home-header').getByRole('button', { name: '创建新项目', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '创建新项目' })
  await dialog.waitFor({ state: 'visible' })
  await dialog.getByPlaceholder('输入项目名称').fill('AI-005 可干预督导')
  await dialog.getByRole('button', { name: /智能视频 从灵感或剧本开始制片/u }).click()
  await dialog.getByRole('button', { name: '创建并进入', exact: true }).click()
  await dialog.waitFor({ state: 'hidden', timeout: 15_000 })
  await page.getByRole('region', { name: '多智能体制片工作室' }).waitFor({ state: 'visible', timeout: 20_000 })
}

async function evidence() {
  return page.evaluate(async () => {
    const catalogPayload = await (await fetch('/api/workspace/catalog')).json()
    const project = catalogPayload.catalog.projects.find((candidate) => candidate.title === 'AI-005 可干预督导')
    if (!project) throw new Error('Missing AI-005 project')
    const registration = project.documents.find(({ modeId }) => modeId === 'smart-video')
    if (!registration) throw new Error('Missing smart-video registration')
    const query = new URLSearchParams({ projectId: project.id, modeId: 'smart-video' })
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
  })
}

async function waitForEvidence(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  let latest
  while (Date.now() < deadline) {
    latest = await evidence()
    if (predicate(latest)) return latest
    await page.waitForTimeout(100)
  }
  throw new Error(`Timed out waiting for Supervisor evidence; latest revision ${latest?.bodyRevision}`)
}

function nodeOf(entry, nodeId) {
  return entry.value.production.nodes.find(({ id }) => id === nodeId)
}

async function configureTextAdapter(studio) {
  const adapter = studio.getByRole('region', { name: 'BYOK 文本智能体' })
  await adapter.getByLabel('HTTPS 接口基址').fill(upstreamBaseUrl)
  await adapter.getByLabel('模型').fill('loopback-supervisor')
  await adapter.getByLabel('API Key').fill('key-supervisor-1234')
  await adapter.getByRole('button', { name: '仅本次运行启用', exact: true }).click()
  await adapter.getByText('本次运行已启用', { exact: true }).waitFor({ state: 'visible' })
  assert.equal((await adapter.innerText()).includes('key-supervisor-1234'), false)
}

async function requestSupervisorPlan(studio, expectedNodeId) {
  const supervisor = studio.getByRole('region', { name: '制片督导' })
  await supervisor.getByRole('button', { name: '运行至下一审批点', exact: true }).click()
  const review = page.locator('.aq-agent-plan-dialog')
  await review.waitFor({ state: 'visible', timeout: 15_000 })
  await review.getByText('BYOK 文本提案', { exact: true }).waitFor({ state: 'visible' })
  await review.getByText('video.node.edit', { exact: true }).waitFor({ state: 'visible' })
  assert.equal(upstreamCalls.at(-1)?.nodeId, expectedNodeId)
  return review
}

try {
  browser = await chromium.launch({ headless: true, ...(browserChannel ? { channel: browserChannel } : {}) })
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  observePage(page)
  await page.goto(bridge.baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
  await createSmartVideoProject()

  const studio = page.getByRole('region', { name: '多智能体制片工作室' })
  const supervisor = studio.getByRole('region', { name: '制片督导' })
  await supervisor.getByText(/剧本设计已有待审批产物/u).waitFor({ state: 'visible' })
  assert.equal(upstreamCalls.length, 0)
  await configureTextAdapter(studio)

  await studio.getByText('剧本设计', { exact: true }).first().click()
  await studio.getByRole('button', { name: '批准并继续', exact: true }).click()
  const scriptApproved = await waitForEvidence((entry) => (
    nodeOf(entry, 'screenwriter')?.status === 'approved'
    && ['running', 'ready'].includes(nodeOf(entry, 'character-designer')?.status)
  ))
  assert.equal(scriptApproved.registrationRevision, scriptApproved.bodyRevision)

  let review = await requestSupervisorPlan(studio, 'character-designer')
  await review.getByRole('button', { name: '拒绝并保留原稿', exact: true }).click()
  await review.waitFor({ state: 'hidden' })
  const rejected = await evidence()
  assert.equal(rejected.bodyRevision, scriptApproved.bodyRevision)
  assert.equal(rejected.receipts.length, 0)
  assert.equal(nodeOf(rejected, 'character-designer').outputSummary, '')
  report.turns.push({ nodeId: 'character-designer', outcome: 'rejected', revision: rejected.bodyRevision })

  review = await requestSupervisorPlan(studio, 'character-designer')
  await review.getByRole('button', { name: '批准并执行', exact: true }).click()
  await review.waitFor({ state: 'hidden', timeout: 15_000 })
  const characterPlanned = await waitForEvidence((entry) => (
    entry.bodyRevision > rejected.bodyRevision
    && entry.receipts.length === 1
    && nodeOf(entry, 'character-designer')?.status === 'review'
  ))
  assert.equal(nodeOf(characterPlanned, 'character-designer').outputSummary, outputByNode['character-designer'])
  assert.equal(characterPlanned.receipts[0].source.agentRole, 'video-supervisor')
  assert.equal(characterPlanned.receipts[0].source.kind, 'byok-text')
  report.turns.push({ nodeId: 'character-designer', outcome: 'approved-plan', revision: characterPlanned.bodyRevision })

  await studio.getByText('人物设定', { exact: true }).first().click()
  await studio.getByRole('button', { name: '批准并继续', exact: true }).click()
  const characterApproved = await waitForEvidence((entry) => (
    nodeOf(entry, 'character-designer')?.status === 'approved'
    && ['running', 'ready'].includes(nodeOf(entry, 'art-director')?.status)
  ))

  await page.reload({ waitUntil: 'domcontentloaded' })
  await studio.waitFor({ state: 'visible', timeout: 20_000 })
  await supervisor.getByText(/场景美术生成一轮只读文本计划/u).waitFor({ state: 'visible', timeout: 15_000 })
  review = await requestSupervisorPlan(studio, 'art-director')
  await review.getByRole('button', { name: '拒绝并保留原稿', exact: true }).click()
  await review.waitFor({ state: 'hidden' })
  assert.equal((await evidence()).bodyRevision, characterApproved.bodyRevision)
  report.turns.push({ nodeId: 'art-director', outcome: 'recovered-after-refresh', revision: characterApproved.bodyRevision })

  await studio.getByRole('button', { name: '暂停全链路', exact: true }).click()
  const paused = await waitForEvidence((entry) => entry.value.production.globalPaused === true)
  await supervisor.getByText(/全链路已暂停/u).first().waitFor({ state: 'visible' })
  await expectDisabled(supervisor.getByRole('button', { name: '全链路已暂停', exact: true }))
  const callCountBeforePausedProbe = upstreamCalls.length
  const pausedProbe = await bridge.request('/api/workspace/video-supervisor/next', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: paused.projectId,
      documentId: paused.documentId,
      baseRevision: paused.bodyRevision,
    }),
  })
  assert.equal(pausedProbe.ok, true)
  const pausedResult = await pausedProbe.json()
  assert.equal(pausedResult.decision.status, 'project-paused')
  assert.equal(pausedResult.plan, null)
  assert.equal(upstreamCalls.length, callCountBeforePausedProbe)
  await studio.getByRole('button', { name: '恢复全链路', exact: true }).click()
  await waitForEvidence((entry) => entry.value.production.globalPaused === false)

  if (process.env.AEONQUILL_QA_DESKTOP_SCREENSHOT_PATH) {
    await page.screenshot({ path: process.env.AEONQUILL_QA_DESKTOP_SCREENSHOT_PATH, fullPage: false })
    report.desktopScreenshot = process.env.AEONQUILL_QA_DESKTOP_SCREENSHOT_PATH
  }

  await page.setViewportSize({ width: 390, height: 844 })
  await supervisor.scrollIntoViewIfNeeded()
  const supervisorBox = await supervisor.boundingBox()
  assert.ok(supervisorBox)
  assert.equal(supervisorBox.x >= 0 && supervisorBox.x + supervisorBox.width <= 390, true)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  const mobileButton = supervisor.getByRole('button', { name: '运行至下一审批点', exact: true })
  await mobileButton.waitFor({ state: 'visible' })
  if (process.env.AEONQUILL_QA_SCREENSHOT_PATH) {
    await page.screenshot({ path: process.env.AEONQUILL_QA_SCREENSHOT_PATH, fullPage: false })
    report.visualScreenshot = process.env.AEONQUILL_QA_SCREENSHOT_PATH
  }
  report.responsive = {
    viewport: '390x844',
    supervisorWidth: Math.round(supervisorBox.width),
    noPageOverflow: true,
  }

  assert.equal(upstreamCalls.length, 3)
  assert.deepEqual(upstreamCalls.map(({ nodeId }) => nodeId), ['character-designer', 'character-designer', 'art-director'])
  assert.equal(upstreamCalls.every(({ authorization }) => authorization === 'Bearer key-supervisor-1234'), true)
  assert.equal(upstreamCalls.some(({ messages }) => JSON.stringify(messages).includes('key-supervisor-1234')), false)
  assert.deepEqual(report.issues, [])
  report.status = 'passed'
  console.log('✓ Video Supervisor stops at human gates, rejects without writes, resumes across refresh and never models paused work')
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

async function expectDisabled(locator) {
  assert.equal(await locator.isDisabled(), true)
}
