import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { startIsolatedBridge } from './qa-runtime.mjs'

const fixturePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAFAgIACQFe3gAAAABJRU5ErkJggg==', 'base64')
const fixtureMp3 = Buffer.concat([Buffer.from('ID3', 'ascii'), Buffer.alloc(32, 1)])
const fixtureMp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom', 'ascii'), Buffer.alloc(32, 2)])
let fixtureVideoPolls = 0
const fixtureRequests = []
const provider = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = Buffer.concat(chunks).toString('utf8')
  fixtureRequests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body })
  if (request.method === 'POST' && request.url === '/v1/images/generations') {
    response.writeHead(200, { 'content-type': 'application/json' })
    return response.end(JSON.stringify({ id: 'qa-image', data: [{ b64_json: fixturePng.toString('base64'), mime_type: 'image/png' }], usage: { cost_usd: 0.01 } }))
  }
  if (request.method === 'POST' && request.url === '/v1/audio/speech') {
    response.writeHead(200, { 'content-type': 'audio/mpeg', 'x-usage-cost-usd': '0.01' })
    return response.end(fixtureMp3)
  }
  if (request.method === 'POST' && request.url === '/v1/videos') {
    response.writeHead(200, { 'content-type': 'application/json' })
    return response.end(JSON.stringify({ id: 'qa-video', status: 'queued' }))
  }
  if (request.method === 'GET' && request.url === '/v1/videos/qa-video') {
    fixtureVideoPolls += 1
    response.writeHead(200, { 'content-type': 'application/json' })
    return response.end(JSON.stringify(fixtureVideoPolls < 2
      ? { id: 'qa-video', status: 'in_progress', progress: 63 }
      : { id: 'qa-video', status: 'completed', progress: 100, usage: { cost_usd: 0.02 } }))
  }
  if (request.method === 'GET' && request.url === '/v1/videos/qa-video/content') {
    response.writeHead(200, { 'content-type': 'video/mp4' })
    return response.end(fixtureMp4)
  }
  response.writeHead(404, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ error: 'fixture route missing' }))
})
await new Promise((resolvePromise, rejectPromise) => {
  provider.once('error', rejectPromise)
  provider.listen(0, '127.0.0.1', resolvePromise)
})
const providerAddress = provider.address()
const providerBaseUrl = `http://127.0.0.1:${providerAddress.port}/v1`

const bridge = await startIsolatedBridge('production-agent-ui')
const artifactDirectory = fileURLToPath(new URL('../.runtime/qa', import.meta.url))
await mkdir(artifactDirectory, { recursive: true })
const executablePath = process.platform === 'win32'
  ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  : undefined
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const issues = []

page.on('pageerror', (error) => issues.push(`pageerror: ${error.message}`))
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') issues.push(`${message.type()}: ${message.text()}`)
})
page.on('response', (response) => {
  if (response.status() >= 400) issues.push(`http ${response.status()}: ${response.url()}`)
})

async function createSmartVideoProject() {
  await page.locator('.aq-home-header').getByRole('button', { name: '创建新项目', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '创建新项目' })
  await dialog.getByPlaceholder('输入项目名称').fill('P3 旗舰广告')
  await dialog.getByRole('button', { name: /智能视频 从灵感或剧本开始制片/u }).click()
  await dialog.getByRole('button', { name: '创建并进入', exact: true }).click()
}

try {
  await page.goto(bridge.baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible' })
  await createSmartVideoProject()
  const studio = page.getByRole('region', { name: '多智能体制片工作室' })
  await studio.waitFor({ state: 'visible', timeout: 10_000 })

  await studio.getByLabel('生成方案').selectOption('quality')
  await studio.getByLabel('人物方案').selectOption('professional')
  await studio.getByRole('button', { name: '建立生产图', exact: true }).click()
  await studio.getByText('质量 / 专业人物', { exact: true }).waitFor({ state: 'visible' })

  await studio.getByText('人物设定', { exact: true }).first().click()
  const characterSession = studio.getByRole('region', { name: '人物一致性会话' })
  await characterSession.getByText(/^正面/u).waitFor({ state: 'visible' })
  await characterSession.getByText(/^侧面/u).waitFor({ state: 'visible' })
  await characterSession.getByText(/^背面/u).waitFor({ state: 'visible' })

  await studio.getByText('剧本设计', { exact: true }).first().click()
  await studio.getByRole('button', { name: '请求本地建议', exact: true }).click()
  await studio.getByText('剧本设计 · 本地受控建议', { exact: true }).waitFor({ state: 'visible' })
  await studio.getByRole('button', { name: '接受变更', exact: true }).click()
  await studio.getByText(/accepted/u).waitFor({ state: 'visible' })

  const adapter = studio.getByRole('region', { name: 'BYOK 文本智能体' })
  await adapter.getByLabel('HTTPS 接口基址').fill('http://127.0.0.1:65534/v1')
  await adapter.getByLabel('模型').fill('qa-model')
  await adapter.getByLabel('API Key').fill('qa-secret-12345678')
  await adapter.getByRole('button', { name: '仅本次运行启用', exact: true }).click()
  await adapter.getByText('本次运行已启用', { exact: true }).waitFor({ state: 'visible' })
  assert.equal((await adapter.innerText()).includes('qa-secret-12345678'), false)
  await adapter.getByRole('button', { name: '清除会话密钥', exact: true }).click()
  await adapter.getByText('未配置', { exact: true }).waitFor({ state: 'visible' })

  const generationPanel = studio.getByRole('region', { name: '图像视频语音 BYOK 适配器' })
  const imageAdapter = generationPanel.locator('details').filter({ hasText: '图像 API' })
  await imageAdapter.locator('summary').click()
  await imageAdapter.getByLabel('HTTPS / 回环基址').fill(providerBaseUrl)
  await imageAdapter.getByLabel('模型').fill('qa-image-model')
  await imageAdapter.getByLabel('API Key').fill('qa-image-secret-1234')
  await imageAdapter.getByLabel('$ / 张').fill('0.01')
  await imageAdapter.getByRole('button', { name: '本次运行启用', exact: true }).click()
  await imageAdapter.getByRole('button', { name: '生成并入库', exact: true }).click()
  await generationPanel.getByText(/图像已进入项目资源库/u).waitFor({ state: 'visible', timeout: 10_000 })

  const speechAdapter = generationPanel.locator('details').filter({ hasText: 'TTS API' })
  await speechAdapter.locator('summary').click()
  await speechAdapter.getByLabel('HTTPS / 回环基址').fill(providerBaseUrl)
  await speechAdapter.getByLabel('模型').fill('qa-speech-model')
  await speechAdapter.getByLabel('API Key').fill('qa-speech-secret-1234')
  await speechAdapter.getByLabel('$ / 千字').fill('0.01')
  await speechAdapter.getByRole('button', { name: '本次运行启用', exact: true }).click()
  await speechAdapter.getByRole('button', { name: '合成并入库', exact: true }).click()
  await generationPanel.getByText(/配音已进入项目资源库/u).waitFor({ state: 'visible', timeout: 10_000 })

  const videoAdapter = generationPanel.locator('details').filter({ hasText: '视频 API' })
  await videoAdapter.locator('summary').click()
  await videoAdapter.getByLabel('HTTPS / 回环基址').fill(providerBaseUrl)
  await videoAdapter.getByLabel('模型').fill('qa-video-model')
  await videoAdapter.getByLabel('API Key').fill('qa-video-secret-1234')
  await videoAdapter.getByLabel('$ / 秒').fill('0.01')
  await videoAdapter.getByRole('button', { name: '本次运行启用', exact: true }).click()
  await videoAdapter.getByRole('button', { name: '创建 5 秒 720P 任务', exact: true }).click()
  await videoAdapter.getByText(/completed · 100%/u).waitFor({ state: 'visible', timeout: 12_000 })
  assert.equal((await generationPanel.innerText()).includes('qa-image-secret-1234'), false)
  assert.equal((await generationPanel.innerText()).includes('qa-speech-secret-1234'), false)
  assert.equal((await generationPanel.innerText()).includes('qa-video-secret-1234'), false)
  assert.ok(fixtureRequests.length >= 6)
  assert.ok(fixtureRequests.every(({ authorization }) => authorization === 'Bearer qa-image-secret-1234' || authorization === 'Bearer qa-speech-secret-1234' || authorization === 'Bearer qa-video-secret-1234'))

  const workspaceProjectId = new URLSearchParams(page.url().split('?')[1] || '').get('project')
  assert.ok(workspaceProjectId)
  const libraryAssets = await page.evaluate(async (projectId) => {
    const response = await fetch(`/api/library/assets?scope=project&projectId=${encodeURIComponent(projectId)}`, { credentials: 'same-origin' })
    return response.json()
  }, workspaceProjectId)
  assert.deepEqual(libraryAssets.assets.map((asset) => asset.mediaKind).sort(), ['audio', 'image', 'video'])

  await page.waitForTimeout(700)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByText('多智能体制片工作室', { exact: true }).first().waitFor({ state: 'visible', timeout: 10_000 })
  const restoredStudio = page.getByRole('region', { name: '多智能体制片工作室' })
  await restoredStudio.getByText('质量 / 专业人物', { exact: true }).waitFor({ state: 'visible' })
  await restoredStudio.getByText('剧本设计', { exact: true }).first().click()
  await restoredStudio.getByText('剧本设计 · 本地受控建议', { exact: true }).waitFor({ state: 'visible' })
  await page.screenshot({ path: join(artifactDirectory, 'production-agent-desktop.png'), fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(150)
  assert.equal(await page.locator('body').evaluate((body) => body.scrollWidth <= body.clientWidth), true)
  assert.equal(await page.locator('.aq-video-workbench').evaluate((body) => body.scrollWidth <= body.clientWidth), true)
  await page.screenshot({ path: join(artifactDirectory, 'production-agent-mobile.png'), fullPage: true })
  assert.deepEqual(issues, [])
  console.log('✓ Production profiles, review-only agents, memory-only text/image/video/TTS BYOK, managed outputs, reload persistence, and responsive layout passed')
} catch (error) {
  await page.screenshot({ path: join(artifactDirectory, 'production-agent-failure.png'), fullPage: true }).catch(() => undefined)
  console.error(JSON.stringify({ url: page.url(), issues, body: (await page.locator('body').innerText().catch(() => '')).slice(0, 8000), artifactDirectory }, null, 2))
  throw error
} finally {
  await browser.close().catch(() => undefined)
  await bridge.stop({ keepRuntime: false })
  await new Promise((resolvePromise) => provider.close(resolvePromise))
}
