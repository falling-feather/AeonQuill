import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { startIsolatedBridge } from './qa-runtime.mjs'

const fixturePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAFAgIACQFe3gAAAABJRU5ErkJggg==', 'base64')
function fixtureMp4(index) {
  return Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom', 'ascii'), Buffer.alloc(31, 2), Buffer.from([index])])
}
function fixtureWav(durationSeconds = 0.35, sampleRate = 48_000) {
  const samples = Math.round(durationSeconds * sampleRate)
  const dataBytes = samples * 2 * 2
  const buffer = Buffer.alloc(44 + dataBytes)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVEfmt ', 8, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(2, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 4, 28)
  buffer.writeUInt16LE(4, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataBytes, 40)
  for (let index = 0; index < samples; index += 1) {
    const value = Math.round(Math.sin((index / sampleRate) * Math.PI * 2 * 440) * 2_500)
    buffer.writeInt16LE(value, 44 + index * 4)
    buffer.writeInt16LE(value, 46 + index * 4)
  }
  return buffer
}
const fixtureSpeech = fixtureWav()
let fixtureVideoSequence = 0
const fixtureVideoPolls = new Map()
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
    response.writeHead(200, { 'content-type': 'audio/wav', 'x-usage-cost-usd': '0.01' })
    return response.end(fixtureSpeech)
  }
  if (request.method === 'POST' && request.url === '/v1/videos') {
    fixtureVideoSequence += 1
    const id = `qa-video-${fixtureVideoSequence}`
    response.writeHead(200, { 'content-type': 'application/json' })
    return response.end(JSON.stringify({ id, status: 'queued' }))
  }
  const statusMatch = request.url?.match(/^\/v1\/videos\/(qa-video-(\d+))$/u)
  if (request.method === 'GET' && statusMatch) {
    const polls = (fixtureVideoPolls.get(statusMatch[1]) ?? 0) + 1
    fixtureVideoPolls.set(statusMatch[1], polls)
    response.writeHead(200, { 'content-type': 'application/json' })
    return response.end(JSON.stringify(polls < 2
      ? { id: statusMatch[1], status: 'in_progress', progress: 63 }
      : { id: statusMatch[1], status: 'completed', progress: 100, usage: { cost_usd: 0.02 } }))
  }
  const contentMatch = request.url?.match(/^\/v1\/videos\/(qa-video-(\d+))\/content$/u)
  if (request.method === 'GET' && contentMatch) {
    response.writeHead(200, { 'content-type': 'video/mp4' })
    return response.end(fixtureMp4(Number(contentMatch[2])))
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

async function bindProjectImageToContinuityCards(studio, group, requiredOnly = false) {
  const continuity = studio.getByRole('region', { name: '连续性资产槽位' })
  await continuity.getByLabel('资产组').selectOption(group)
  const allCards = continuity.locator('.aq-continuity-slot-list > article')
  const cards = requiredOnly ? allCards.filter({ hasText: '必需参考' }) : allCards
  const count = await cards.count()
  assert(count > 0, `${group} should expose at least one bindable card`)
  for (let index = 0; index < count; index += 1) {
    const card = cards.nth(index)
    await card.getByRole('button', { name: /选择资源|替换版本/u }).click()
    await page.locator('.aq-product-library-launcher').click()
    const dialog = page.getByRole('dialog', { name: '资源库' })
    await dialog.waitFor({ state: 'visible' })
    await dialog.getByRole('tab', { name: '项目资源', exact: true }).click()
    const imageTile = dialog.locator('.aq-library-grid > li').filter({ hasText: 'API 图像' }).first()
    await imageTile.waitFor({ state: 'visible', timeout: 10_000 })
    await imageTile.locator('button').click()
    await dialog.getByRole('button', { name: '用于智能视频', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await card.getByRole('button', { name: '批准', exact: true }).click()
    await card.getByText('已批准', { exact: true }).waitFor({ state: 'visible' })
  }
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
  await characterSession.getByText(/^正面/u).first().waitFor({ state: 'visible' })
  await characterSession.getByText(/^侧面/u).first().waitFor({ state: 'visible' })
  await characterSession.getByText(/^背面/u).first().waitFor({ state: 'visible' })

  await studio.getByLabel('生成方案').selectOption('fast')
  await studio.getByLabel('人物方案').selectOption('quick')
  await studio.getByRole('button', { name: '建立生产图', exact: true }).click()
  await studio.getByText('极速 / 快速人物', { exact: true }).waitFor({ state: 'visible' })

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
  assert.equal((await generationPanel.innerText()).includes('qa-image-secret-1234'), false)
  assert.equal((await generationPanel.innerText()).includes('qa-speech-secret-1234'), false)
  assert.equal((await generationPanel.innerText()).includes('qa-video-secret-1234'), false)

  const workspaceProjectId = new URLSearchParams(page.url().split('?')[1] || '').get('project')
  assert.ok(workspaceProjectId)
  const libraryAssets = await page.evaluate(async (projectId) => {
    const response = await fetch(`/api/library/assets?scope=project&projectId=${encodeURIComponent(projectId)}`, { credentials: 'same-origin' })
    return response.json()
  }, workspaceProjectId)
  assert.deepEqual(libraryAssets.assets.map((asset) => asset.mediaKind).sort(), ['audio', 'image'])
  const audioAsset = libraryAssets.assets.find((asset) => asset.mediaKind === 'audio')
  assert.ok(audioAsset)

  await studio.getByText('素材生成', { exact: true }).first().click()
  await bindProjectImageToContinuityCards(studio, '人物视图', true)
  await bindProjectImageToContinuityCards(studio, '服饰状态')
  await bindProjectImageToContinuityCards(studio, '地点基准')
  await studio.getByText('0 镜头受阻', { exact: true }).waitFor({ state: 'visible' })

  await studio.getByText('H3 镜头生成', { exact: true }).first().click()
  const candidatePool = studio.getByRole('region', { name: '当前镜头视频候选' })
  await candidatePool.getByText(/暂无候选/u).waitFor({ state: 'visible' })
  await videoAdapter.getByRole('button', { name: '生成 5 秒 720P 候选', exact: true }).click()
  await videoAdapter.getByText(/completed · 100%/u).waitFor({ state: 'visible', timeout: 12_000 })
  await candidatePool.locator('[data-video-candidate]').waitFor({ state: 'visible', timeout: 10_000 })
  assert.equal(await candidatePool.locator('[data-video-candidate]').count(), 1)
  await candidatePool.getByRole('button', { name: '设为当前', exact: true }).click()
  await studio.getByLabel('人工结论').selectOption('retry')
  await studio.getByRole('button', { name: '记录人工结论', exact: true }).click()
  await studio.getByText(/需定向重生/u).waitFor({ state: 'visible' })

  await videoAdapter.getByRole('button', { name: '生成 5 秒 720P 候选', exact: true }).click()
  await videoAdapter.getByText(/completed · 100%/u).waitFor({ state: 'visible', timeout: 12_000 })
  await page.waitForFunction(() => document.querySelectorAll('[data-video-candidate]').length === 2)
  assert.equal(await candidatePool.locator('[data-video-candidate]').count(), 2)
  await candidatePool.locator('[data-video-candidate]').nth(1).getByRole('button', { name: '设为当前', exact: true }).click()
  await studio.getByLabel('人工结论').selectOption('accept')
  await studio.getByRole('button', { name: '记录人工结论', exact: true }).click()
  await studio.getByText(/候选 #2 · 已接受/u).waitFor({ state: 'visible' })

  assert.ok(fixtureRequests.length >= 10)
  assert.ok(fixtureRequests.every(({ authorization }) => authorization === 'Bearer qa-image-secret-1234' || authorization === 'Bearer qa-speech-secret-1234' || authorization === 'Bearer qa-video-secret-1234'))

  await studio.getByText('声音字幕', { exact: true }).first().click()
  const soundTimeline = studio.getByRole('region', { name: '声音字幕时间线' })
  await soundTimeline.waitFor({ state: 'visible' })
  await soundTimeline.getByRole('button', { name: '声线', exact: true }).click()
  const voiceCards = soundTimeline.locator('.aq-sound-voice-card')
  const voiceCount = await voiceCards.count()
  assert(voiceCount > 0)
  for (let index = 0; index < voiceCount; index += 1) {
    const card = voiceCards.nth(index)
    await card.getByText('服务标签').locator('..').getByRole('textbox').fill('OpenAI-compatible')
    await card.getByText('Voice ID').locator('..').getByRole('textbox').fill(`qa-voice-${index + 1}`)
    await card.getByRole('button', { name: '保存声线', exact: true }).click()
    await card.getByRole('button', { name: '批准', exact: true }).click()
  }
  await soundTimeline.getByRole('button', { name: '音频', exact: true }).click()
  const prepareButton = soundTimeline.getByRole('button', { name: /生成 \d+ 条缺失对白/u })
  assert.equal(await prepareButton.isEnabled(), true)
  await prepareButton.click()
  await soundTimeline.getByText(/缺失对白已生成并回填/u).waitFor({ state: 'visible', timeout: 15_000 })
  await soundTimeline.getByText(/sha256:/u).first().waitFor({ state: 'visible', timeout: 10_000 })
  while (await soundTimeline.getByRole('button', { name: '批准', exact: true }).count()) {
    await soundTimeline.getByRole('button', { name: '批准', exact: true }).first().click()
  }
  await soundTimeline.getByRole('button', { name: '字幕', exact: true }).click()
  await soundTimeline.getByRole('button', { name: '批准全部字幕', exact: true }).click()
  await soundTimeline.getByRole('button', { name: '样式/混音', exact: true }).click()
  await soundTimeline.getByRole('button', { name: '批准样式', exact: true }).click()
  await soundTimeline.getByRole('button', { name: '批准混音', exact: true }).click()
  await soundTimeline.getByText('声音门已就绪', { exact: true }).waitFor({ state: 'visible' })
  await soundTimeline.getByRole('button', { name: '渲染混音与字幕', exact: true }).click()
  await soundTimeline.getByRole('link', { name: '试听 WAV', exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
  await soundTimeline.getByRole('link', { name: 'SRT', exact: true }).waitFor({ state: 'visible' })
  await soundTimeline.getByRole('link', { name: 'VTT', exact: true }).waitFor({ state: 'visible' })

  const soundJobs = await page.evaluate(async () => {
    const response = await fetch('/api/jobs', { credentials: 'same-origin' })
    const payload = await response.json()
    return payload.jobs.filter((job) => job.kind === 'sound-render')
  })
  assert.deepEqual(soundJobs.map(({ status }) => status), ['completed', 'completed'])
  assert.equal(JSON.stringify(soundJobs).includes(bridge.runtimeDirectory), false)
  assert.equal(JSON.stringify(soundJobs).includes('subtitleAssPath'), false)

  await page.waitForTimeout(700)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByText('多智能体制片工作室', { exact: true }).first().waitFor({ state: 'visible', timeout: 10_000 })
  const restoredStudio = page.getByRole('region', { name: '多智能体制片工作室' })
  await restoredStudio.getByText('极速 / 快速人物', { exact: true }).waitFor({ state: 'visible' })
  await restoredStudio.getByText('剧本设计', { exact: true }).first().click()
  await restoredStudio.getByText('剧本设计 · 本地受控建议', { exact: true }).waitFor({ state: 'visible' })
  await restoredStudio.getByText('H3 镜头生成', { exact: true }).first().click()
  const restoredCandidatePool = restoredStudio.getByRole('region', { name: '当前镜头视频候选' })
  assert.equal(await restoredCandidatePool.locator('[data-video-candidate]').count(), 2)
  await restoredStudio.getByText(/候选 #2 · 已接受/u).waitFor({ state: 'visible' })
  await restoredStudio.getByText('声音字幕', { exact: true }).first().click()
  const restoredSoundTimeline = restoredStudio.getByRole('region', { name: '声音字幕时间线' })
  await restoredSoundTimeline.getByText(/sha256:/u).first().waitFor({ state: 'visible' })
  await restoredSoundTimeline.getByText('已批准', { exact: true }).first().waitFor({ state: 'visible' })
  await restoredSoundTimeline.getByRole('link', { name: '试听 WAV', exact: true }).waitFor({ state: 'visible' })
  await page.screenshot({ path: join(artifactDirectory, 'production-agent-desktop.png'), fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(150)
  assert.equal(await page.locator('body').evaluate((body) => body.scrollWidth <= body.clientWidth), true)
  assert.equal(await page.locator('.aq-video-workbench').evaluate((body) => body.scrollWidth <= body.clientWidth), true)
  await page.screenshot({ path: join(artifactDirectory, 'production-agent-mobile.png'), fullPage: true })
  assert.deepEqual(issues, [])
  console.log('✓ Production profiles, two-version video candidate replace/accept, batch BYOK TTS, approved mix/subtitles, reload persistence, and responsive layout passed')
} catch (error) {
  await page.screenshot({ path: join(artifactDirectory, 'production-agent-failure.png'), fullPage: true }).catch(() => undefined)
  console.error(JSON.stringify({ url: page.url(), issues, body: (await page.locator('body').innerText().catch(() => '')).slice(0, 8000), artifactDirectory }, null, 2))
  throw error
} finally {
  await browser.close().catch(() => undefined)
  await bridge.stop({ keepRuntime: false })
  await new Promise((resolvePromise) => provider.close(resolvePromise))
}
