import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { chromium, expect } from '@playwright/test'
import { startIsolatedBridge } from './qa-runtime.mjs'
import { DEFAULT_RUNTIME_REQUIREMENTS, VIDEO_MODEL_PROFILES } from '../server/video-workflow-registry.mjs'

const directory = resolve('.runtime/qa')
await mkdir(directory, { recursive: true })
const upstreamArgument = process.argv.find(value => value.startsWith('--comfy-url='))?.slice('--comfy-url='.length)
if (upstreamArgument && !/^http:\/\/127\.0\.0\.1:\d+$/u.test(upstreamArgument)) throw new Error('Use an explicit local ComfyUI URL')
const kind = upstreamArgument ? 'live-read-only' : 'fixture-read-only'
let omitMemoryNodes = false
const blockedMutations = []
const issues = []
const checks = []
const profiles = Object.values(VIDEO_MODEL_PROFILES)
const info = Object.fromEntries([...DEFAULT_RUNTIME_REQUIREMENTS.requiredNodes, 'KSamplerSelect', 'MiniMaxLowVRAMAttention', 'MiniMaxChunkFeedForward', 'MiniMaxReuseQKVAttention'].map(name => [name, {}]))
info.UNETLoader = { input: { required: { unet_name: [profiles.map(profile => profile.unetName)] } } }
info.CLIPLoader = { input: { required: { clip_name: [profiles.map(profile => profile.clipName)] } } }
info.VAELoader = { input: { required: { vae_name: [profiles.flatMap(profile => [profile.videoVaeName, profile.audioVaeName])] } } }
info.MiniMaxH3TurboLoRA = { input: { required: { lora_name: [profiles.map(profile => profile.loraName)] } } }
const stats = { system: { comfyui_version: '0.31.0', pytorch_version: '2.12.1+cu130', ram_total: 32 * 1024 ** 3, ram_free: 10 * 1024 ** 3 }, devices: [{ name: 'RTX 4060 Laptop GPU (UI fixture)', type: 'cuda', index: 0, vram_total: 8 * 1024 ** 3, vram_free: 7 * 1024 ** 3 }] }
const proxy = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname
    if (request.method !== 'GET') {
      blockedMutations.push({ method: request.method, path: pathname })
      response.writeHead(405, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'UI validation proxy is read-only' }))
      return
    }
    let value
    if (upstreamArgument) {
      if (!['/system_stats', '/queue', '/object_info', '/features'].some(prefix => pathname === prefix || pathname.startsWith(prefix + '/'))) throw new Error('Unexpected read-only proxy route: ' + pathname)
      const fetched = await fetch(upstreamArgument + request.url, { signal: AbortSignal.timeout(20_000) })
      assert.equal(fetched.status, 200, pathname)
      value = await fetched.json()
    } else if (pathname === '/system_stats') value = stats
    else if (pathname === '/queue') value = { queue_running: [], queue_pending: [] }
    else if (pathname === '/object_info') value = structuredClone(info)
    else throw new Error('Unexpected fixture route: ' + pathname)
    if (pathname.startsWith('/object_info') && omitMemoryNodes) {
      delete value.MiniMaxLowVRAMAttention
      delete value.MiniMaxChunkFeedForward
      delete value.MiniMaxReuseQKVAttention
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value))
  } catch (error) {
    issues.push(error.message)
    response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: error.message }))
  }
})
await new Promise(resolvePromise => proxy.listen(0, '127.0.0.1', resolvePromise))
const port = proxy.address().port
const bridge = await startIsolatedBridge('native-quality-ui', { comfyUrl: `http://127.0.0.1:${port}`, comfyPolicy: 'manual' })
let browser, page, error
const jobRequests = []

async function createProject(title, mode) {
  await page.getByRole('button', { name: '创建新项目', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: '创建新项目' })
  await dialog.getByLabel(/项目名称/u).fill(title)
  if (mode === 'smart-video') await dialog.getByText('智能视频', { exact: true }).click()
  await dialog.getByRole('button', { name: '创建并进入', exact: true }).click()
}

try {
  for (const [duration, frames] of [[8, 192], [12, 294]]) {
    const response = await bridge.request('/api/video/prompt/compile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'text-to-video', prompt: 'A single continuous view of a rainy bookshop.', aspectRatio: '16:9', preset: 'nativeBase', duration, seed: 20261024, audio: true }) })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).plan.effectiveDurationSeconds, (frames - 1) / 24)
  }
  const unsupported = await bridge.request('/api/video/prompt/compile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'text-to-video', prompt: 'A rainy bookshop.', preset: 'nativeHigh', duration: 8 }) })
  assert.equal(unsupported.status, 400)
  checks.push('real bridge prompt API uses canonical 8s/12s frame timing and rejects long clips on the old native Turbo preset')
  browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true, args: ['--disable-gpu'] })
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  page = await context.newPage()
  page.setDefaultTimeout(15_000)
  page.setDefaultNavigationTimeout(20_000)
  page.on('pageerror', caught => issues.push(caught.message))
  page.on('request', request => { if (request.method() === 'POST' && /\/api\/(?:jobs|video\/jobs)(?:\?|$)/u.test(request.url())) jobRequests.push(request.url()) })
  await page.goto(bridge.baseUrl, { waitUntil: 'domcontentloaded' })
  await createProject('Native quality UI · balanced', 'balanced')
  await page.getByLabel('无限画布', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
  await page.getByRole('tab', { name: '视频', exact: true }).click()
  const card = page.locator('.pipeline-options button').filter({ hasText: '原生 768P Base20（实验）' })
  await expect(card).toHaveAttribute('aria-disabled', 'false', { timeout: 25_000 })
  await card.click()
  await expect(card).toHaveAttribute('aria-pressed', 'true')
  await expect(card.locator('dd').nth(0)).toHaveText('1344×768')
  await expect(card.locator('dd').nth(1)).toHaveText('1344×768')
  await expect(page.getByRole('button', { name: '10s', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '15s', exact: true })).toBeDisabled()
  for (const [seconds, frames, actual] of [[8, 192, '8.00'], [12, 294, '12.25']]) {
    const durationButton = page.getByRole('button', { name: `${seconds}s`, exact: true })
    await expect(durationButton).toBeEnabled()
    await durationButton.click()
    await expect(durationButton).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByText(`原生母片 ${frames} 帧，约 ${actual} 秒。`, { exact: true })).toBeVisible()
  }
  checks.push('balanced VideoStudio selects 8s/12s native Base20 with 192/294 frames and explicit 12.25s mother-clip timing; 10s/15s remain disabled')
  await card.scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(directory, `native-quality-${kind}-balanced.png`), fullPage: false })

  omitMemoryNodes = true
  await bridge.request('/api/runtime/status?refresh=1')
  await expect(card).toHaveAttribute('aria-disabled', 'true', { timeout: 35_000 })
  await expect(page.getByText(/缺少低显存扩展节点/u)).toBeVisible()
  await expect(page.getByRole('button', { name: '高质量依赖尚未就绪', exact: true })).toBeDisabled()
  checks.push('removing only memory-node availability blocks generation and gives an actionable dependency message')
  await page.screenshot({ path: join(directory, `native-quality-${kind}-blocked.png`), fullPage: false })

  omitMemoryNodes = false
  await bridge.request('/api/runtime/status?refresh=1')
  await page.getByRole('button', { name: '返回光阴砚主页', exact: true }).click()
  await createProject('Native quality UI · smart video', 'smart-video')
  await page.getByRole('button', { name: '执行', exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
  await page.getByRole('button', { name: '执行', exact: true }).click()
  const selector = page.getByRole('combobox', { name: '质量 / 显存', exact: true })
  await expect(selector.locator('option[value="nativeBase"]')).toBeEnabled({ timeout: 25_000 })
  await selector.selectOption('nativeBase')
  await expect(page.locator('.aq-video-quality-brief')).toContainText('1344×768')
  await expect(page.locator('.aq-video-quality-brief')).toContainText('支持 5 / 8 / 12 秒')
  checks.push('smart-video execution exposes the same native Base20 preset and dimensional contract')
  await page.screenshot({ path: join(directory, `native-quality-${kind}-smart.png`), fullPage: false })
  assert.deepEqual(jobRequests, [])
  assert.deepEqual(blockedMutations, [])
  assert.deepEqual(issues, [])
} catch (caught) {
  error = caught
  if (page) await page.screenshot({ path: join(directory, `native-quality-${kind}-failure.png`), fullPage: false }).catch(() => {})
} finally {
  await browser?.close()
  await bridge.stop()
  proxy.closeAllConnections()
  await new Promise(resolvePromise => proxy.close(resolvePromise))
  const report = { status: error ? 'failed' : 'passed', kind, scope: 'UI and capability gates only; no media or training generation', generatedAt: new Date().toISOString(), checks, jobRequests: jobRequests.length, blockedMutations, issues, error: error?.message ?? null }
  await writeFile(join(directory, `native-quality-${kind}.json`), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
}
if (error) throw new Error(error.message)
