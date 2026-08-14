import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startIsolatedBridge } from './qa-runtime.mjs'

let chromium
try {
  ;({ chromium } = await import('playwright'))
} catch {
  throw new Error('Browser smoke requires the project dev dependency @playwright/test. Run npm install first.')
}

const bridge = await startIsolatedBridge('browser')
const artifactDirectory = await mkdtemp(join(tmpdir(), 'miaohui-browser-artifacts-'))
const browserChannel = process.env.MIAOHUI_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined)
let browser
let failed = true

function observePage(page, issues) {
  page.on('pageerror', (error) => issues.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      issues.push(`${message.type()}: ${message.text()}`)
    }
  })
  page.on('response', (response) => {
    if (response.status() >= 400) issues.push(`http ${response.status()}: ${response.url()}`)
  })
}

async function assertHealthyShell(page) {
  await page.goto(bridge.baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  assert.equal(await page.getByText('妙绘', { exact: true }).count(), 1)
  await page.getByLabel('无限画布').waitFor({ state: 'visible' })
  assert.equal(await page.title(), '妙绘 · 无限创作画布')
  const visibleText = await page.locator('body').innerText()
  assert.match(visibleText, /角色资产实验/)
  assert.equal(visibleText.trim().length > 60, true)
  assert.equal(await page.locator('vite-error-overlay, .vite-error-overlay').count(), 0)
}

async function readStoredDocument(page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem('miaohui-canvas:v8')
    if (!raw) throw new Error('Versioned canvas document was not persisted')
    return JSON.parse(raw)
  })
}

try {
  browser = await chromium.launch({ headless: true, ...(browserChannel ? { channel: browserChannel } : {}) })

  const desktopIssues = []
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  observePage(desktop, desktopIssues)
  await assertHealthyShell(desktop)
  await desktop.getByRole('button', { name: '角色资产实验' }).click()
  await desktop.getByRole('menuitem', { name: '下载完整项目包' }).waitFor({ state: 'visible' })
  await desktop.getByRole('menuitem', { name: '导入项目包' }).waitFor({ state: 'visible' })
  await desktop.getByRole('button', { name: '角色资产实验' }).click()
  await desktop.getByRole('tab', { name: '视频' }).click()
  await desktop.getByText('ComfyUI 当前休眠').waitFor({ state: 'visible' })
  await desktop.getByRole('tab', { name: '任务' }).click()
  await desktop.getByText('还没有处理任务').waitFor({ state: 'visible' })
  await desktop.getByRole('button', { name: '像素画（P）' }).click()
  assert.equal(await desktop.getByRole('button', { name: '像素画（P）' }).getAttribute('aria-pressed'), 'true')
  await desktop.getByRole('button', { name: '选择（V）' }).click()
  const shape = desktop.locator('[data-element-id="image-summer-character"]')
  const beforeDrag = await readStoredDocument(desktop)
  const beforeShape = beforeDrag.elements.find((element) => element.id === 'image-summer-character')
  const box = await shape.boundingBox()
  assert.ok(box)
  const dragStart = {
    x: box.x + Math.max(42, Math.min(box.width - 42, box.width * 0.35)),
    y: box.y + Math.max(42, Math.min(box.height - 42, box.height * 0.35)),
  }
  await desktop.mouse.move(dragStart.x, dragStart.y)
  await desktop.mouse.down()
  await desktop.mouse.move(dragStart.x + 48, dragStart.y + 32, { steps: 8 })
  await desktop.mouse.up()
  await desktop.waitForFunction(
    (revision) => JSON.parse(localStorage.getItem('miaohui-canvas:v8')).revision === revision + 1,
    beforeDrag.revision,
  )
  const afterDrag = await readStoredDocument(desktop)
  const afterShape = afterDrag.elements.find((element) => element.id === 'image-summer-character')
  assert.equal(afterDrag.schemaVersion, 1)
  assert.equal(afterDrag.revision, beforeDrag.revision + 1)
  assert.notEqual(afterShape.x, beforeShape.x)
  await desktop.getByRole('button', { name: '撤销' }).click()
  await desktop.waitForFunction(
    (revision) => JSON.parse(localStorage.getItem('miaohui-canvas:v8')).revision === revision + 1,
    afterDrag.revision,
  )
  const afterUndo = await readStoredDocument(desktop)
  assert.equal(afterUndo.elements.find((element) => element.id === 'image-summer-character').x, beforeShape.x)
  await desktop.getByRole('button', { name: '重做' }).click()
  await desktop.waitForFunction(
    (revision) => JSON.parse(localStorage.getItem('miaohui-canvas:v8')).revision === revision + 1,
    afterUndo.revision,
  )
  const afterRedo = await readStoredDocument(desktop)
  assert.equal(afterRedo.elements.find((element) => element.id === 'image-summer-character').x, afterShape.x)
  await desktop.getByRole('tab', { name: '编辑' }).click()
  await desktop.getByRole('button', { name: '蒙版修边', exact: true }).click()
  const imageLab = desktop.getByRole('dialog', { name: '图像处理实验室' })
  await imageLab.waitFor({ state: 'visible' })
  await desktop.getByText('浏览器蒙版笔刷', { exact: true }).waitFor({ state: 'visible' })
  await desktop.getByText('归一化笔画 · 全分辨率确定性重放', { exact: true }).waitFor({ state: 'visible' })
  const maskCanvas = desktop.getByLabel('在图片上拖动以移除或恢复蒙版')
  const maskBox = await maskCanvas.boundingBox()
  assert.ok(maskBox)
  await desktop.mouse.move(maskBox.x + maskBox.width * 0.42, maskBox.y + maskBox.height * 0.43)
  await desktop.mouse.down()
  await desktop.mouse.move(
    maskBox.x + maskBox.width * 0.58,
    maskBox.y + maskBox.height * 0.55,
    { steps: 8 },
  )
  await desktop.mouse.up()
  await desktop.getByText('1 笔修正', { exact: true }).waitFor({ state: 'visible' })
  await desktop.waitForFunction(() => (
    [...document.querySelectorAll('.mask-editor-status span')]
      .some((element) => /^Alpha 改变 (?!0(?:\.0+)?%).+$/.test(element.textContent || ''))
  ))
  const applyMask = desktop.getByRole('button', { name: '应用到画布', exact: true })
  assert.equal(await applyMask.isEnabled(), true)
  await applyMask.click()
  await imageLab.waitFor({ state: 'hidden', timeout: 30_000 })
  const maskDerivedId = await desktop.waitForFunction(() => {
    const document = JSON.parse(localStorage.getItem('miaohui-canvas:v8'))
    const derived = document.elements.find((element) =>
      element.kind === 'image'
      && element.processingStack?.some((step) =>
        step.type === 'mask-refine'
        && step.maskRecipe?.schemaVersion === 1
        && step.maskRecipe.strokes?.length === 1,
      ),
    )
    return derived?.id || false
  }).then((handle) => handle.jsonValue())
  assert.equal(typeof maskDerivedId, 'string')
  const afterMask = await readStoredDocument(desktop)
  const maskDerived = afterMask.elements.find((element) => element.id === maskDerivedId)
  const maskStep = maskDerived.processingStack.find((step) => step.type === 'mask-refine')
  assert.equal(maskStep.maskRecipe.schemaVersion, 1)
  assert.equal(maskStep.maskRecipe.strokes.length, 1)
  assert.equal(maskStep.maskRecipe.strokes[0].points.every((point) =>
    point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1
  ), true)
  assert.equal(
    afterMask.elements.find((element) => element.id === 'image-summer-character').processingStack.length,
    0,
  )
  await desktop.waitForFunction(async (elementId) => {
    const response = await fetch('/api/projects/current?id=local-project', { credentials: 'same-origin' })
    const project = (await response.json()).project
    return project?.document?.elements?.some((element) =>
      element.id === elementId
      && /^\/api\/project-assets\/[a-f0-9]{64}$/.test(element.src || '')
      && element.processingStack?.some((step) =>
        step.type === 'mask-refine' && step.maskRecipe?.strokes?.length === 1
      ),
    )
  }, maskDerivedId)
  await desktop.reload({ waitUntil: 'domcontentloaded' })
  await desktop.locator(`img[alt$="· 蒙版修边"]`).waitFor({ state: 'visible' })
  const afterMaskReload = await readStoredDocument(desktop)
  assert.equal(afterMaskReload.elements.some((element) =>
    element.id === maskDerivedId
    && element.processingStack?.some((step) =>
      step.type === 'mask-refine' && step.maskRecipe?.strokes?.length === 1
    ),
  ), true)
  const scheduledJobId = await desktop.evaluate(async () => {
    const document = JSON.parse(localStorage.getItem('miaohui-canvas:v8'))
    const sourceElement = document.elements.find((element) => element.id === 'image-summer-character')
    const sourceImageDataUrl = sourceElement.src.startsWith('data:')
      ? sourceElement.src
      : await new Promise(async (resolvePromise, rejectPromise) => {
          const response = await fetch(sourceElement.src, { credentials: 'same-origin' })
          if (!response.ok) return rejectPromise(new Error('Could not read QA source image'))
          const reader = new FileReader()
          reader.onload = () => resolvePromise(String(reader.result))
          reader.onerror = () => rejectPromise(new Error('Could not encode QA source image'))
          reader.readAsDataURL(await response.blob())
        })
    const response = await fetch('/api/jobs/image', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'browser-pixel-request-001',
        'x-miaohui-priority': '88',
      },
      body: JSON.stringify({
        operation: 'pixelate',
        sourceElementId: sourceElement.id,
        sourceImageDataUrl,
        params: { targetSize: 32, colors: 8, outputScale: 1, dither: 'none', alphaThreshold: 96 },
      }),
    })
    if (!response.ok) throw new Error(`QA image job failed to submit: ${response.status}`)
    return (await response.json()).job.id
  })
  await desktop.waitForFunction(async (jobId) => {
    const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { credentials: 'same-origin' })
    const job = (await response.json()).job
    return job.status === 'completed' && Boolean(job.scheduling?.finishedAt) && Boolean(job.outputVersion?.id)
  }, scheduledJobId, { timeout: 45_000 })
  await desktop.getByRole('tab', { name: '任务' }).click()
  await desktop.getByText('优先级 88').waitFor({ state: 'visible' })
  await desktop.getByText('不可变输出 v1').waitFor({ state: 'visible' })
  await desktop.getByText('CPU', { exact: true }).waitFor({ state: 'visible' })
  await desktop.waitForFunction((jobId) => {
    const document = JSON.parse(localStorage.getItem('miaohui-canvas:v8'))
    return document.elements.some((element) =>
      element.jobId === jobId && /^asset-version-[a-f0-9]{32}$/.test(element.assetVersionId || ''),
    )
  }, scheduledJobId)
  await desktop.waitForFunction(async (jobId) => {
    const response = await fetch('/api/projects/current?id=local-project', { credentials: 'same-origin' })
    const project = (await response.json()).project
    return project?.document?.elements?.some((element) =>
      element.jobId === jobId && /^\/api\/project-assets\/[a-f0-9]{64}$/.test(element.src || ''),
    )
  }, scheduledJobId)
  const downloadPromise = desktop.waitForEvent('download')
  await desktop.getByRole('button', { name: '导出' }).click()
  const download = await downloadPromise
  assert.match(download.suggestedFilename(), /\.miaohui$/)
  const packagePath = await download.path()
  const packageBytes = await readFile(packagePath)
  assert.deepEqual([...packageBytes.subarray(0, 2)], [0x1f, 0x8b])
  await desktop.locator('input[accept^=".miaohui"]').setInputFiles(packagePath)
  await desktop.getByText('项目包已校验并导入').waitFor({ state: 'visible' })
  const afterImport = await readStoredDocument(desktop)
  assert.ok(afterImport.revision > afterRedo.revision)
  assert.equal(afterImport.elements.find((element) => element.id === 'image-summer-character').x, afterRedo.elements.find((element) => element.id === 'image-summer-character').x)
  await desktop.screenshot({ path: join(artifactDirectory, 'desktop.png') })
  assert.deepEqual(desktopIssues, [])

  const mobileIssues = []
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } })
  observePage(mobile, mobileIssues)
  await assertHealthyShell(mobile)
  assert.equal(
    await mobile.locator('.inspector-drawer').evaluate((node) => getComputedStyle(node).visibility),
    'hidden',
  )
  assert.equal(await mobile.getByRole('complementary', { name: '属性与任务面板' }).count(), 0)
  await mobile.getByRole('button', { name: '打开属性面板' }).click()
  await mobile.getByRole('tab', { name: '视频' }).click()
  await mobile.getByText('ComfyUI 当前休眠').waitFor({ state: 'visible' })
  assert.equal(await mobile.locator('.inspector-drawer').evaluate((node) => node.classList.contains('is-open')), true)
  assert.equal(await mobile.locator('body').evaluate((body) => body.scrollWidth <= body.clientWidth), true)
  await mobile.getByRole('tab', { name: '编辑' }).click()
  await mobile.getByRole('button', { name: '蒙版修边', exact: true }).click()
  await mobile.getByRole('dialog', { name: '图像处理实验室' }).waitFor({ state: 'visible' })
  await mobile.getByText('浏览器蒙版笔刷', { exact: true }).waitFor({ state: 'visible' })
  const mobileMaskBox = await mobile.getByLabel('在图片上拖动以移除或恢复蒙版').boundingBox()
  assert.ok(mobileMaskBox)
  assert.ok(mobileMaskBox.width >= 150 && mobileMaskBox.height >= 150)
  assert.ok(mobileMaskBox.x >= 0 && mobileMaskBox.x + mobileMaskBox.width <= 390)
  assert.equal(await mobile.locator('body').evaluate((body) => body.scrollWidth <= body.clientWidth), true)
  await mobile.screenshot({ path: join(artifactDirectory, 'mobile.png') })
  assert.deepEqual(mobileIssues, [])

  console.log(`✓ Browser smoke passed on desktop 1440×900 and mobile 390×844 (${browserChannel || 'bundled Chromium'})`)
  failed = false
} finally {
  await browser?.close().catch(() => {})
  await bridge.stop({ keepRuntime: failed })
  if (failed || process.env.MIAOHUI_QA_KEEP_ARTIFACTS === '1') {
    console.error(`Browser QA artifacts: ${artifactDirectory}`)
    if (failed) console.error(`QA runtime retained for inspection: ${bridge.runtimeDirectory}`)
  } else {
    await rm(artifactDirectory, { recursive: true, force: true })
  }
}
