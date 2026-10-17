import { PIXEL_DOCUMENT_SCHEMA_VERSION } from '../src/lib/pixel/pixelCore.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { startIsolatedBridge } from './qa-runtime.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const artifactDirectory = join(projectRoot, '.runtime', 'qa')
const temporaryRoot = join(projectRoot, '.runtime', 'qa-temp', 'p7')
const reportPath = join(artifactDirectory, 'p7-integration.json')
const phases = []
const childEnvironment = {
  ...process.env,
  TEMP: temporaryRoot,
  TMP: temporaryRoot,
  MIAOHUI_QA_SKIP_BUILD: '1',
}

await mkdir(artifactDirectory, { recursive: true })
await mkdir(temporaryRoot, { recursive: true })
process.env.TEMP = temporaryRoot
process.env.TMP = temporaryRoot

function runPhase(label, script, extraEnvironment = {}) {
  const startedAt = Date.now()
  return new Promise((resolvePromise, rejectPromise) => {
    const output = []
    const child = spawn(process.execPath, [script], {
      cwd: projectRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...childEnvironment, ...extraEnvironment },
    })
    const record = (chunk) => {
      const text = String(chunk)
      output.push(text)
      process.stdout.write(text)
    }
    child.stdout.on('data', record)
    child.stderr.on('data', record)
    const timeout = setTimeout(() => {
      if (process.platform === 'win32') {
        spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      } else {
        child.kill('SIGKILL')
      }
    }, 300_000)
    child.once('error', (error) => {
      clearTimeout(timeout)
      phases.push({ label, status: 'failed', durationMs: Date.now() - startedAt, error: error.message })
      rejectPromise(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      const durationMs = Date.now() - startedAt
      if (code === 0) {
        phases.push({ label, status: 'passed', durationMs })
        resolvePromise()
        return
      }
      const tail = output.join('').slice(-4_000)
      const error = new Error(`${label} exited with ${signal || code}\n${tail}`)
      phases.push({ label, status: 'failed', durationMs, error: error.message.slice(0, 4_000) })
      rejectPromise(error)
    })
  })
}

function observePage(page, issues) {
  page.on('pageerror', (error) => issues.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') issues.push(`${message.type()}: ${message.text()}`)
  })
  page.on('response', (response) => {
    if (response.status() >= 400) issues.push(`http ${response.status()}: ${response.url()}`)
  })
}

async function waitForDownloads(downloads, count, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (downloads.length < count && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
  }
  assert.equal(downloads.length, count, `Expected ${count} pixel delivery downloads, received ${downloads.length}`)
}

async function validatePixelGameUi(baseUrl) {
  const startedAt = Date.now()
  const executablePath = process.platform === 'win32'
    ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    : undefined
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })
  const page = await context.newPage()
  const issues = []
  const downloads = []
  observePage(page, issues)
  page.on('download', (download) => downloads.push(download))
  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
    await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible' })
    const createProjectButton = page.locator('.aq-home-header').getByRole('button', { name: '创建新项目', exact: true })
    await createProjectButton.waitFor({ state: 'visible', timeout: 10_000 })
    await assert.doesNotReject(() => createProjectButton.click({ timeout: 10_000 }))
    await page.getByPlaceholder('输入项目名称').fill('P7 像素游戏交付')
    const pixelModeOption = page.getByRole('button', { name: /像素模式 精细像素绘制与动画/u })
    await pixelModeOption.click()
    assert.equal(await pixelModeOption.getAttribute('aria-pressed'), 'true')
    await page.getByRole('button', { name: '创建并进入', exact: true }).click()
    await page.getByLabel(/像素绘制区/u).waitFor({ state: 'visible', timeout: 10_000 })

    const activeLayerProperties = page.getByLabel('当前图层属性', { exact: true })
    const firstLayerName = activeLayerProperties.getByLabel('图层名称', { exact: true })
    await firstLayerName.fill('流光')
    await firstLayerName.press('Tab')
    await page.getByRole('button', { name: '添加图层', exact: true }).click()
    const secondLayerName = activeLayerProperties.getByLabel('图层名称', { exact: true })
    await secondLayerName.fill('轮廓')
    await secondLayerName.press('Tab')
    await page.locator('.aq-pixel-layer-list > div').filter({ hasText: '流光' }).first().locator('.aq-pixel-layer-main').click()

    await page.getByRole('button', { name: /本地智能清理/u }).click()
    await page.getByText('本地智能清理未发现孤立噪点或单像素针孔', { exact: true }).waitFor({ state: 'visible' })
    await page.getByRole('button', { name: /补齐八方向/u }).click()
    await page.getByText(/八方向槽已就绪/u).waitFor({ state: 'visible' })
    const frameButtons = page.locator('.aq-pixel-frame-strip > button')
    assert.equal(await frameButtons.count(), 8)
    assert.deepEqual(await frameButtons.locator('strong').allInnerTexts(), ['南', '西南', '西', '西北', '北', '东北', '东', '东南'])
    const clipboardSourceFrameIndex = await frameButtons.evaluateAll((buttons) => (
      buttons.findIndex((button) => button.getAttribute('aria-pressed') === 'true')
    ))
    assert.ok(clipboardSourceFrameIndex >= 0)
    const clipboardTargetFrameIndex = clipboardSourceFrameIndex === 0 ? 1 : 0

    const paletteCycleWorkbench = page.getByLabel('调色板循环', { exact: true })
    await paletteCycleWorkbench.getByRole('button', { name: '新建调色板循环', exact: true }).click()
    const cycleName = paletteCycleWorkbench.getByLabel('调色板循环名称', { exact: true })
    await cycleName.fill('灵光轮转')
    await cycleName.press('Tab')
    await paletteCycleWorkbench.getByRole('button', { name: '选择调色板循环 灵光轮转', exact: true }).waitFor({ state: 'visible' })
    await paletteCycleWorkbench.getByLabel('调色板循环方向', { exact: true }).selectOption('ping-pong')
    const cycleStep = paletteCycleWorkbench.getByLabel('调色板循环步长', { exact: true })
    await cycleStep.fill('80')
    await cycleStep.press('Tab')

    const groupWorkbench = page.getByLabel('图层组', { exact: true })
    await groupWorkbench.getByRole('button', { name: '添加图层组', exact: true }).click()
    const groupCard = groupWorkbench.locator('[data-group-id]').last()
    const groupId = await groupCard.getAttribute('data-group-id')
    assert.ok(groupId)
    const groupName = groupCard.locator('input')
    await groupName.fill('角色光影')
    await groupName.press('Tab')
    await page.getByLabel('所属图层组', { exact: true }).selectOption({ label: '角色光影' })
    await page.getByLabel('混合模式', { exact: true }).selectOption('screen')
    await groupWorkbench.getByRole('button', { name: '锁定图层组 角色光影', exact: true }).click()
    await groupWorkbench.getByRole('button', { name: '解锁图层组 角色光影', exact: true }).click()

    const pixelCanvas = page.getByLabel(/像素绘制区/u)
    const canvasBox = await pixelCanvas.boundingBox()
    assert.ok(canvasBox, 'Pixel canvas must have a visible bounding box')
    const canvasPoint = (x, y) => ({
      x: canvasBox.x + ((x + 0.5) / 16) * canvasBox.width,
      y: canvasBox.y + ((y + 0.5) / 16) * canvasBox.height,
    })
    const selectionStart = canvasPoint(1, 12)
    const selectionEnd = canvasPoint(2, 13)
    await page.getByRole('button', { name: /铅笔 B/u }).click()
    await page.mouse.click(selectionStart.x, selectionStart.y)
    await page.getByRole('button', { name: /选区 M/u }).click()
    await page.mouse.move(selectionStart.x, selectionStart.y)
    await page.mouse.down()
    await page.mouse.move(selectionEnd.x, selectionEnd.y)
    await page.mouse.up()
    await page.getByText(/已选择 2 × 2 区域/u).waitFor({ state: 'visible' })
    const selectedRegion = await page.locator('.aq-pixel-marquee').evaluate((element) => ({
      x: Math.round((Number.parseFloat(element.style.left) / 100) * 16),
      y: Math.round((Number.parseFloat(element.style.top) / 100) * 16),
      width: Math.round((Number.parseFloat(element.style.width) / 100) * 16),
      height: Math.round((Number.parseFloat(element.style.height) / 100) * 16),
    }))
    assert.deepEqual({ width: selectedRegion.width, height: selectedRegion.height }, { width: 2, height: 2 })
    await page.getByRole('button', { name: '剪切选区到剪贴板', exact: true }).click()
    await page.getByText(/剪切到内存剪贴板：2×2.*1 个可撤销像素操作/u).waitFor({ state: 'visible' })
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await page.getByText('已撤销上一步', { exact: true }).waitFor({ state: 'visible' })
    await page.getByRole('button', { name: '重做', exact: true }).click()
    await page.getByText('已重做上一步', { exact: true }).waitFor({ state: 'visible' })
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await page.getByText('已撤销上一步', { exact: true }).waitFor({ state: 'visible' })
    await frameButtons.nth(clipboardTargetFrameIndex).click()
    const silhouetteRow = page.locator('.aq-pixel-layer-list > div').filter({ hasText: '轮廓' }).first()
    await silhouetteRow.locator('.aq-pixel-layer-main').click()
    await silhouetteRow.getByRole('button', { name: '锁定 轮廓', exact: true }).click()
    await page.getByRole('button', { name: '粘贴跨帧剪贴板', exact: true }).click()
    await page.getByText(/^Layer .* is locked$/u).waitFor({ state: 'visible' })
    await silhouetteRow.getByRole('button', { name: '解锁 轮廓', exact: true }).click()
    await page.getByRole('button', { name: '粘贴跨帧剪贴板', exact: true }).click()
    await page.getByText(/跨帧选区已粘贴到.*透明像素覆盖/u).waitFor({ state: 'visible' })
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await page.getByText('已撤销上一步', { exact: true }).waitFor({ state: 'visible' })
    await page.getByRole('button', { name: '重做', exact: true }).click()
    await page.getByText('已重做上一步', { exact: true }).waitFor({ state: 'visible' })
    await frameButtons.nth(clipboardSourceFrameIndex).click()
    await page.locator('.aq-pixel-layer-list > div').filter({ hasText: '流光' }).first().locator('.aq-pixel-layer-main').click()

    const gameplayWorkbench = page.getByLabel('当前帧游戏元数据', { exact: true })
    await gameplayWorkbench.waitFor({ state: 'visible' })
    await gameplayWorkbench.getByLabel('锚点 X', { exact: true }).fill('6')
    await gameplayWorkbench.getByLabel('锚点 X', { exact: true }).press('Tab')
    await page.getByText('逐帧锚点已更新 · 可撤销', { exact: true }).waitFor({ state: 'visible' })
    await gameplayWorkbench.getByRole('button', { name: '添加碰撞区', exact: true }).click()
    const collisionCard = gameplayWorkbench.locator('.aq-pixel-collision-list article').first()
    await collisionCard.waitFor({ state: 'visible' })
    const collisionName = collisionCard.locator('.aq-pixel-collision-main input')
    await collisionName.fill('剑锋')
    await collisionName.press('Tab')
    await collisionCard.locator('.aq-pixel-collision-main select').selectOption('hitbox')
    await collisionCard.getByLabel('剑锋 x', { exact: true }).fill('1')
    await collisionCard.getByLabel('剑锋 x', { exact: true }).press('Tab')
    await gameplayWorkbench.getByRole('button', { name: '启用', exact: true }).click()
    const terrainId = gameplayWorkbench.getByLabel('Terrain ID', { exact: true })
    await terrainId.fill('wuxia-floor')
    await terrainId.press('Tab')
    await gameplayWorkbench.getByRole('button', { name: '北邻居', exact: true }).click()
    await gameplayWorkbench.getByRole('button', { name: '东邻居', exact: true }).click()
    await gameplayWorkbench.getByText('Mask 5', { exact: true }).waitFor({ state: 'visible' })
    const terrainComposer = gameplayWorkbench.getByLabel('Terrain 九宫格自动推断', { exact: true })
    await terrainComposer.getByRole('button', { name: '选择九宫格预设 转角', exact: true }).click()
    await terrainComposer.getByRole('button', { name: '应用本格 Mask', exact: true }).click()
    await gameplayWorkbench.getByText('Mask 7', { exact: true }).waitFor({ state: 'visible' })
    await page.getByText('已把九宫格中心期望 Mask 7 应用到活动帧 · 可一次撤销', { exact: true }).waitFor({ state: 'visible' })
    await terrainComposer.getByRole('button', { name: /导出九宫格预览/u }).click()
    await waitForDownloads(downloads, 2)
    await page.getByText(/九宫格预览包完成：1 格精确、3 格降级/u).waitFor({ state: 'visible' })
    await frameButtons.nth(clipboardTargetFrameIndex).click()
    await gameplayWorkbench.getByRole('button', { name: '启用', exact: true }).click()
    const secondTerrainId = gameplayWorkbench.getByLabel('Terrain ID', { exact: true })
    await secondTerrainId.fill('mist-water')
    await secondTerrainId.press('Tab')
    await page.getByText('地形标识已更新 · 可撤销', { exact: true }).waitFor({ state: 'visible' })
    await frameButtons.nth(clipboardSourceFrameIndex).click()
    const terrainMapEditor = gameplayWorkbench.getByLabel('持久化 Terrain Map 编辑器', { exact: true })
    await terrainMapEditor.getByRole('button', { name: '新建 Terrain Map', exact: true }).click()
    await page.getByText(/已创建 8×8 Terrain Map/u).waitFor({ state: 'visible' })
    await terrainMapEditor.getByLabel('Terrain Map 宽度', { exact: true }).fill('6')
    await terrainMapEditor.getByLabel('Terrain Map 高度', { exact: true }).fill('4')
    await terrainMapEditor.getByRole('button', { name: '应用 Terrain Map 尺寸', exact: true }).click()
    await page.getByText('Terrain Map 已按左上锚点调整为 6×4 · 可撤销', { exact: true }).waitFor({ state: 'visible' })
    const terrainMapCanvas = terrainMapEditor.getByLabel('Terrain Map 画布', { exact: true })
    await terrainMapCanvas.scrollIntoViewIfNeeded()
    const terrainMapBox = await terrainMapCanvas.boundingBox()
    assert.ok(terrainMapBox, 'Terrain Map canvas must have a visible bounding box')
    const terrainMapPoint = (column, row) => ({
      x: terrainMapBox.x + ((column + 0.5) / 6) * terrainMapBox.width,
      y: terrainMapBox.y + ((row + 0.5) / 4) * terrainMapBox.height,
    })
    const terrainStart = terrainMapPoint(0, 0)
    const terrainTurn = terrainMapPoint(5, 0)
    const terrainEnd = terrainMapPoint(5, 3)
    await page.mouse.move(terrainStart.x, terrainStart.y)
    await page.mouse.down()
    await page.mouse.move(terrainTurn.x, terrainTurn.y, { steps: 6 })
    await page.mouse.move(terrainEnd.x, terrainEnd.y, { steps: 4 })
    await page.mouse.up()
    await page.getByText('Terrain wuxia-floor 画笔完成 · 9 格 · 1 个撤销单元', { exact: true }).waitFor({ state: 'visible' })
    await terrainMapEditor.getByLabel('Terrain Map 画笔 Terrain', { exact: true }).selectOption('mist-water')
    const secondTerrainStart = terrainMapPoint(0, 1)
    const secondTerrainTurn = terrainMapPoint(4, 1)
    const secondTerrainEnd = terrainMapPoint(4, 3)
    await page.mouse.move(secondTerrainStart.x, secondTerrainStart.y)
    await page.mouse.down()
    await page.mouse.move(secondTerrainTurn.x, secondTerrainTurn.y, { steps: 5 })
    await page.mouse.move(secondTerrainEnd.x, secondTerrainEnd.y, { steps: 3 })
    await page.mouse.up()
    await page.getByText('Terrain mist-water 画笔完成 · 7 格 · 1 个撤销单元', { exact: true }).waitFor({ state: 'visible' })
    await terrainMapEditor.getByText(/6×4 · 16 个持久化格 · 2 种 Terrain/u).waitFor({ state: 'visible' })
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await terrainMapEditor.getByText(/6×4 · 9 个持久化格 · 1 种 Terrain/u).waitFor({ state: 'visible' })
    await page.getByRole('button', { name: '重做', exact: true }).click()
    await terrainMapEditor.getByText(/6×4 · 16 个持久化格 · 2 种 Terrain/u).waitFor({ state: 'visible' })
    await terrainMapEditor.getByRole('button', { name: /导出 PNG \/ JSON \/ TMJ/u }).click()
    await waitForDownloads(downloads, 6)
    await page.getByText(/Terrain Map 已导出/u).waitFor({ state: 'visible' })
    assert.equal(await page.getByRole('button', { name: '游戏辅助线', exact: true }).getAttribute('aria-pressed'), 'true')

    const animationWorkbench = page.getByLabel('动画片段', { exact: true })
    await animationWorkbench.waitFor({ state: 'visible' })
    await animationWorkbench.getByRole('button', { name: '新建动画片段', exact: true }).click()
    const animationName = animationWorkbench.getByLabel('片段名称', { exact: true })
    await animationName.fill('八方演武')
    await animationName.press('Tab')
    await animationWorkbench.getByRole('button', { name: '选择动画片段 八方演武', exact: true }).waitFor({ state: 'visible' })
    await animationWorkbench.locator('label').filter({ hasText: '播放方向' }).locator('select').selectOption('ping-pong')
    await animationWorkbench.locator('label').filter({ hasText: '片段统一时长' }).locator('input').fill('180')
    await animationWorkbench.getByRole('button', { name: '应用片段时长', exact: true }).click()
    await page.getByText(/八方演武.*8 帧统一设为 180 ms/u).waitFor({ state: 'visible' })
    assert.deepEqual(await frameButtons.locator('small').allInnerTexts(), Array(8).fill('180 ms'))

    const eventWorkbench = animationWorkbench.getByLabel('动画事件', { exact: true })
    await eventWorkbench.getByRole('button', { name: '添加动画事件', exact: true }).click()
    const eventRow = eventWorkbench.locator('.aq-pixel-event-row').first()
    await eventRow.waitFor({ state: 'visible' })
    const eventName = eventRow.locator('input').first()
    await eventName.fill('剑鸣')
    await eventName.press('Tab')
    await eventRow.locator('select').first().selectOption('sfx')
    const eventPayload = eventRow.locator('input').nth(1)
    await eventPayload.fill('sfx.sword')
    await eventPayload.press('Tab')

    await animationWorkbench.getByRole('button', { name: '覆盖复制当前图层', exact: true }).click()
    await page.getByText(/覆盖复制完成.*7 个目标帧/u).waitFor({ state: 'visible' })
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await page.getByText('已撤销上一步', { exact: true }).waitFor({ state: 'visible' })
    await page.getByRole('button', { name: '重做', exact: true }).click()
    await page.getByText('已重做上一步', { exact: true }).waitFor({ state: 'visible' })

    await page.getByRole('button', { name: '播放动画', exact: true }).click()
    await page.waitForTimeout(420)
    assert.equal(await frameButtons.evaluateAll((buttons) => buttons.some((button) => button.classList.contains('is-previewing'))), true)
    await page.getByRole('button', { name: '停止预览', exact: true }).click()
    await page.screenshot({ path: join(artifactDirectory, 'p7-pixel-animation-desktop.png'), fullPage: true })

    await animationWorkbench.getByRole('button', { name: /活动片段包/u }).click()
    await waitForDownloads(downloads, 8)
    await page.getByText(/活动片段包完成/u).waitFor({ state: 'visible' })
    await page.getByRole('button', { name: /游戏资产包/u }).click()
    await waitForDownloads(downloads, 14)
    await page.getByText(/游戏资产包完成/u).waitFor({ state: 'visible' })
    await page.getByRole('button', { name: /引擎桥接包/u }).click()
    await waitForDownloads(downloads, 20)
    await page.getByText(/引擎桥接包完成/u).waitFor({ state: 'visible' })
    const byFilename = new Map(downloads.map((download) => [download.suggestedFilename(), download]))
    const filenames = [...byFilename.keys()]
    assert.equal(filenames.some((name) => name.endsWith('.aeonpixel.json')), true)
    assert.equal(filenames.some((name) => name.endsWith('-sprite-sheet.png')), true)
    assert.equal(filenames.some((name) => name.endsWith('-game-manifest.json')), true)
    assert.equal(filenames.some((name) => name.endsWith('-tileset.tsj')), true)
    assert.equal(filenames.some((name) => name.endsWith('-tilemap.tmj')), true)
    assert.equal(filenames.some((name) => name.endsWith('-preview.html')), true)
    assert.equal(filenames.some((name) => name.endsWith('-clip.png')), true)
    assert.equal(filenames.some((name) => name.endsWith('-clip.json')), true)
    assert.equal(filenames.some((name) => name.endsWith('-terrain-preview.png')), true)
    assert.equal(filenames.some((name) => name.endsWith('-terrain-preview.json')), true)
    assert.equal(filenames.some((name) => name.endsWith('-terrain-map.png')), true)
    assert.equal(filenames.some((name) => name.endsWith('-terrain-map.json')), true)
    assert.equal(filenames.some((name) => name.endsWith('-terrain-map.tmj')), true)
    assert.equal(filenames.some((name) => name.endsWith('-terrain-map-source-sprite-sheet.png')), true)
    assert.equal(filenames.some((name) => name.endsWith('-engine-bridge.json')), true)
    assert.equal(filenames.some((name) => name.endsWith('-godot-import.gd')), true)
    assert.equal(filenames.some((name) => /^AeonQuillPixelImporter_[0-9a-f]{8}\.cs$/u.test(name)), true)
    assert.equal(filenames.some((name) => name.startsWith('$') && name.endsWith('-character.png')), true)
    assert.equal(filenames.some((name) => name.endsWith('-engine-README.md')), true)

    const readDownload = async (suffix) => {
      const entry = [...byFilename.entries()].find(([name]) => name.endsWith(suffix))
      assert.ok(entry, `Missing ${suffix}`)
      return readFile(await entry[1].path())
    }
    const sprite = await readDownload('-sprite-sheet.png')
    assert.deepEqual([...sprite.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
    const manifest = JSON.parse((await readDownload('-game-manifest.json')).toString('utf8'))
    const tileset = JSON.parse((await readDownload('-tileset.tsj')).toString('utf8'))
    const tilemap = JSON.parse((await readDownload('-tilemap.tmj')).toString('utf8'))
    const viewer = (await readDownload('-preview.html')).toString('utf8')
    const project = JSON.parse((await readDownload('.aeonpixel.json')).toString('utf8'))
    const clipManifest = JSON.parse((await readDownload('-clip.json')).toString('utf8'))
    const clipSprite = await readDownload('-clip.png')
    const terrainManifest = JSON.parse((await readDownload('-terrain-preview.json')).toString('utf8'))
    const terrainSprite = await readDownload('-terrain-preview.png')
    const terrainMapManifest = JSON.parse((await readDownload('-terrain-map.json')).toString('utf8'))
    const terrainMapTiled = JSON.parse((await readDownload('-terrain-map.tmj')).toString('utf8'))
    const terrainMapSprite = await readDownload('-terrain-map.png')
    const terrainMapAtlas = await readDownload('-terrain-map-source-sprite-sheet.png')
    const engineManifest = JSON.parse((await readDownload('-engine-bridge.json')).toString('utf8'))
    const godotImporter = (await readDownload('-godot-import.gd')).toString('utf8')
    const unityImporterEntry = [...byFilename.entries()].find(([name]) => /^AeonQuillPixelImporter_[0-9a-f]{8}\.cs$/u.test(name))
    assert.ok(unityImporterEntry, 'Missing deterministic Unity importer')
    const unityImporter = (await readFile(await unityImporterEntry[1].path())).toString('utf8')
    const rpgMakerCharacter = await readDownload('-character.png')
    const engineReadme = (await readDownload('-engine-README.md')).toString('utf8')
    assert.deepEqual([...clipSprite.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
    assert.deepEqual([...terrainSprite.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
    assert.deepEqual([...terrainMapSprite.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
    assert.deepEqual([...terrainMapAtlas.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
    assert.deepEqual([...rpgMakerCharacter.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
    assert.equal(project.schemaVersion, PIXEL_DOCUMENT_SCHEMA_VERSION)
    assert.equal(project.animationTags.some((tag) => tag.name === '八方演武'), true)
    assert.equal(project.paletteCycles.some((cycle) => cycle.name === '灵光轮转' && cycle.stepDurationMs === 80 && cycle.direction === 'ping-pong'), true)
    assert.equal(project.animationEvents.some((event) => event.name === '剑鸣' && event.type === 'sfx' && event.value === 'sfx.sword'), true)
    assert.equal(project.layerGroups.some((group) => group.id === groupId && group.name === '角色光影'), true)
    assert.equal(project.layers.find((layer) => layer.id === project.activeLayerId)?.blendMode, 'screen')
    assert.equal(project.layers.find((layer) => layer.id === project.activeLayerId)?.groupId, groupId)
    assert.equal(project.terrainMaps.length, 1)
    assert.deepEqual(
      { width: project.terrainMaps[0].width, height: project.terrainMaps[0].height },
      { width: 6, height: 4 },
    )
    assert.equal(project.terrainMaps[0].cells.filter((terrainId) => terrainId !== null).length, 16)
    assert.deepEqual([...new Set(project.terrainMaps[0].cells.filter((terrainId) => terrainId !== null))], ['wuxia-floor', 'mist-water'])
    const clipboardIndexes = [
      selectedRegion.y * 16 + selectedRegion.x,
      selectedRegion.y * 16 + selectedRegion.x + 1,
      (selectedRegion.y + 1) * 16 + selectedRegion.x,
      (selectedRegion.y + 1) * 16 + selectedRegion.x + 1,
    ]
    const outlineLayerId = project.layers.find((layer) => layer.name === '轮廓')?.id
    const lightLayerId = project.layers.find((layer) => layer.name === '流光')?.id
    assert.ok(outlineLayerId)
    assert.ok(lightLayerId)
    assert.deepEqual(
      clipboardIndexes.map((index) => project.frames[clipboardTargetFrameIndex].cels[outlineLayerId][index]),
      clipboardIndexes.map((index) => project.frames[clipboardSourceFrameIndex].cels[lightLayerId][index]),
    )
    assert.equal(manifest.schemaVersion, PIXEL_DOCUMENT_SCHEMA_VERSION)
    assert.equal(manifest.paletteCycles.some((cycle) => cycle.name === '灵光轮转'), true)
    assert.equal(manifest.animationEvents.some((event) => event.name === '剑鸣'), true)
    assert.equal(manifest.layerGroups.some((group) => group.id === groupId), true)
    assert.equal(manifest.layers.find((layer) => layer.id === project.activeLayerId)?.blendMode, 'screen')
    assert.equal(manifest.directions.length, 8)
    assert.equal(manifest.frames.length, 8)
    assert.equal(manifest.animations.length, 1)
    assert.equal(manifest.animation.name, '八方演武')
    assert.equal(manifest.animation.direction, 'ping-pong')
    assert.equal(manifest.animation.frames.length, 14)
    assert.equal(manifest.animation.frames.every((frame) => frame.durationMs === 180), true)
    const gameplayFrameIndex = manifest.frames.findIndex((frame) => frame.id === project.activeFrameId)
    const gameplayFrame = manifest.frames[gameplayFrameIndex]
    assert.ok(gameplayFrameIndex >= 0)
    assert.deepEqual(gameplayFrame.anchor, { x: 6, y: 16 })
    assert.equal(gameplayFrame.collisions[0].name, '剑锋')
    assert.equal(gameplayFrame.collisions[0].type, 'hitbox')
    assert.deepEqual(gameplayFrame.tileRule, { terrainId: 'wuxia-floor', bitmask: 7 })
    assert.equal(tileset.image, manifest.image)
    const gameplayTile = tileset.tiles.find((tile) => tile.id === gameplayFrameIndex)
    assert.equal(gameplayTile.objectgroup.objects[0].name, '剑锋')
    assert.equal(tileset.wangsets.some((wangset) => wangset.name === 'wuxia-floor'), true)
    assert.equal(tileset.wangsets.some((wangset) => wangset.name === 'mist-water'), true)
    assert.equal(tilemap.tilesets[0].source.endsWith('-tileset.tsj'), true)
    assert.equal(/https?:\/\//u.test(viewer), false)
    assert.match(viewer, /collisionColors/u)
    assert.match(viewer, /paletteCycles/u)
    assert.equal(clipManifest.schemaVersion, PIXEL_DOCUMENT_SCHEMA_VERSION)
    assert.equal(clipManifest.kind, 'aeonquill.pixel-animation-clip')
    assert.equal(clipManifest.frames.length, 8)
    assert.equal(clipManifest.animation.frameIds.length, 14)
    assert.equal(clipManifest.events.some((event) => event.name === '剑鸣'), true)
    assert.equal(clipManifest.paletteCycles.some((cycle) => cycle.name === '灵光轮转'), true)
    assert.equal(terrainManifest.schemaVersion, 1)
    assert.equal(terrainManifest.kind, 'aeonquill.pixel-terrain-preview')
    assert.equal(terrainManifest.terrainId, 'wuxia-floor')
    assert.deepEqual(terrainManifest.occupancy, [false, true, true, false, true, true, false, false, false])
    assert.equal(terrainManifest.exactCount, 1)
    assert.equal(terrainManifest.fallbackCount, 3)
    assert.equal(terrainManifest.cells[4].expectedBitmask, 7)
    assert.equal(terrainManifest.cells[4].matchedBitmask, 7)
    assert.equal(terrainManifest.cells[4].exact, true)
    assert.equal(terrainMapManifest.schemaVersion, 2)
    assert.equal(terrainMapManifest.kind, 'aeonquill.pixel-terrain-map')
    assert.deepEqual(terrainMapManifest.grid, { width: 6, height: 4 })
    assert.equal(terrainMapManifest.terrainGrid.filter((terrainId) => terrainId !== null).length, 16)
    assert.deepEqual(terrainMapManifest.terrainIds, ['wuxia-floor', 'mist-water'])
    assert.equal(terrainMapManifest.cells.length, 24)
    assert.equal(terrainMapTiled.width, 6)
    assert.equal(terrainMapTiled.height, 4)
    assert.equal(terrainMapTiled.layers[0].data.length, 24)
    assert.equal(terrainMapTiled.tilesets[0].firstgid, 1)
    assert.equal(Object.hasOwn(terrainMapTiled.tilesets[0], 'source'), false)
    assert.equal(terrainMapTiled.tilesets[0].image, terrainMapManifest.atlas)
    assert.deepEqual(
      terrainMapTiled.tilesets[0].wangsets.map((wangset) => wangset.name),
      [...new Set(manifest.frames.map((frame) => frame.tileRule?.terrainId).filter(Boolean))],
    )
    assert.equal(engineManifest.schemaVersion, 1)
    assert.equal(engineManifest.kind, 'aeonquill.pixel-engine-bridge')
    assert.equal(engineManifest.sourceDocumentId, project.id)
    assert.equal(engineManifest.sourceRevision, project.revision)
    assert.equal(engineManifest.sourceSchemaVersion, project.schemaVersion)
    assert.equal(engineManifest.files.sprite.endsWith('-sprite-sheet.png'), true)
    assert.equal(engineManifest.files.godotImporter.endsWith('-godot-import.gd'), true)
    assert.equal(/^AeonQuillPixelImporter_[0-9a-f]{8}\.cs$/u.test(engineManifest.files.unityImporter), true)
    assert.equal(engineManifest.files.rpgMakerCharacter.startsWith('$'), true)
    assert.equal(engineManifest.frames.length, 8)
    assert.equal(engineManifest.animations.some((animation) => animation.name === '八方演武'), true)
    assert.equal(engineManifest.animationEvents.some((event) => event.name === '剑鸣'), true)
    assert.equal(engineManifest.paletteCycles.some((cycle) => cycle.name === '灵光轮转'), true)
    assert.equal(engineManifest.godot.durationFps, 1000)
    assert.equal(engineManifest.unity.pixelsPerUnit, 16)
    assert.equal(engineManifest.unity.yConversion, 'atlasHeight - top - height')
    assert.deepEqual(engineManifest.unity.texture, {
      filterMode: 'Point', mipmaps: false, compression: 'Uncompressed', wrapMode: 'Clamp',
    })
    assert.deepEqual(engineManifest.rpgMakerMz.layout, {
      columns: 3, rows: 4, rowOrder: ['south', 'west', 'east', 'north'],
    })
    assert.equal(engineManifest.rpgMakerMz.cells.length, 12)
    assert.equal(engineManifest.rpgMakerMz.cells.every((cell) => cell.repeated === true), true)
    assert.match(godotImporter, /SpriteFrames\.new\(\)/u)
    assert.match(godotImporter, /set_animation_speed\(animation_name, 1000\.0\)/u)
    assert.match(godotImporter, /ResourceSaver\.save/u)
    assert.match(unityImporter, /SpriteDataProviderFactories/u)
    assert.match(unityImporter, /texture\.height - frame\.atlas\.y - frame\.atlas\.height/u)
    assert.match(unityImporter, /mipmapEnabled = false/u)
    assert.match(unityImporter, /FilterMode\.Point/u)
    assert.match(engineReadme, /docs\.godotengine\.org/u)
    assert.match(engineReadme, /docs\.unity3d\.com/u)
    assert.match(engineReadme, /rpgmakerofficial\.com/u)
    assert.match(engineReadme, /不会被脚本执行/u)

    await page.setViewportSize({ width: 390, height: 844 })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByLabel(/像素绘制区/u).waitFor({ state: 'visible', timeout: 10_000 })
    const restoredAnimationButton = page.getByRole('button', { name: '选择动画片段 八方演武', exact: true })
    await restoredAnimationButton.waitFor({ state: 'visible' })
    await restoredAnimationButton.click()
    await page.getByRole('button', { name: '选择调色板循环 灵光轮转', exact: true }).waitFor({ state: 'visible' })
    await page.getByLabel('动画事件', { exact: true }).getByLabel('事件名称 剑鸣', { exact: true }).waitFor({ state: 'visible' })
    const restoredGroupName = page.locator('.aq-pixel-group-list input').first()
    await restoredGroupName.waitFor({ state: 'visible' })
    assert.equal(await restoredGroupName.inputValue(), '角色光影')
    assert.equal(await page.getByLabel('混合模式', { exact: true }).inputValue(), 'screen')
    assert.equal(await page.getByLabel('锚点 X', { exact: true }).inputValue(), '6')
    assert.equal(await page.getByLabel('Terrain ID', { exact: true }).inputValue(), 'wuxia-floor')
    assert.equal(await page.getByText('Mask 7', { exact: true }).isVisible(), true)
    const restoredTerrainMapEditor = page.getByLabel('持久化 Terrain Map 编辑器', { exact: true })
    await restoredTerrainMapEditor.getByLabel('Terrain Map 画布', { exact: true }).waitFor({ state: 'visible' })
    assert.equal(await restoredTerrainMapEditor.getByLabel('Terrain Map 宽度', { exact: true }).inputValue(), '6')
    assert.equal(await restoredTerrainMapEditor.getByLabel('Terrain Map 高度', { exact: true }).inputValue(), '4')
    assert.equal(await restoredTerrainMapEditor.getByText(/6×4 · 16 个持久化格 · 2 种 Terrain/u).isVisible(), true)
    assert.equal(await page.locator('body').evaluate((body) => body.scrollWidth <= body.clientWidth), true)
    assert.equal(await page.locator('html').evaluate((html) => html.scrollWidth <= html.clientWidth), true)
    await page.getByLabel('当前帧游戏元数据', { exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(artifactDirectory, 'p7-pixel-game-mobile.png'), fullPage: true })
    assert.deepEqual(issues, [])
    phases.push({
      label: 'pixel cross-frame clipboard, multi-terrain painting, palette cycles, events, clip bundle and twenty-download engine delivery',
      status: 'passed',
      durationMs: Date.now() - startedAt,
      downloads: filenames.sort(),
    })
  } catch (error) {
    phases.push({ label: 'pixel cross-frame clipboard, multi-terrain painting, palette cycles, events, clip bundle and twenty-download engine delivery', status: 'failed', durationMs: Date.now() - startedAt, error: error.message })
    await page.screenshot({ path: join(artifactDirectory, 'p7-pixel-game-failure.png'), fullPage: true }).catch(() => undefined)
    throw error
  } finally {
    await browser.close().catch(() => undefined)
  }
}

let projectBridge
let failure
try {
  projectBridge = await startIsolatedBridge('p7-project-pixel')
  await runPhase('project catalog, recovery and migration UI', 'scripts/validate-project-center.mjs', {
    AEONQUILL_PROJECT_CENTER_URL: projectBridge.baseUrl,
  })
  await validatePixelGameUi(projectBridge.baseUrl)
  await projectBridge.stop({ keepRuntime: false })
  projectBridge = undefined

  await runPhase('balanced canvas, restart, package and responsive UI', 'scripts/validate-browser.mjs')
  await runPhase('one immutable resource across three modes', 'scripts/validate-asset-library-ui.mjs')
  await runPhase('workflow center dependency and safe-import UI', 'scripts/validate-workflow-center-ui.mjs')
  await runPhase('multi-agent, BYOK media, costs and recovery UI', 'scripts/validate-production-agent-ui.mjs')
} catch (error) {
  failure = error
} finally {
  await projectBridge?.stop({ keepRuntime: Boolean(failure) }).catch(() => undefined)
  await writeFile(reportPath, `${JSON.stringify({
    schemaVersion: 1,
    status: failure ? 'failed' : 'passed',
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    temporaryRoot,
    phases,
    error: failure?.message,
  }, null, 2)}\n`, 'utf8')
}

if (failure) throw failure
console.log(`✓ P7 integration passed (${phases.length} phases); report ${reportPath}`)
