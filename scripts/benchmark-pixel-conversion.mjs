import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { cpus, platform, release, totalmem } from 'node:os'
import { performance } from 'node:perf_hooks'
import { basename, resolve, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

import {
  PIXEL_CONVERSION_PRESETS,
  convertRgbaToPixelDocument,
} from '../src/lib/pixel/pixelConversion.mjs'
import { renderPixelFrameRgba, serializePixelDocument } from '../src/lib/pixel/pixelCore.mjs'

const OUTPUT_DIRECTORY = resolve('benchmarks', 'pixel-quality')
const REPORT_PATH = resolve(OUTPUT_DIRECTORY, 'pixel-first-round-quality.json')
const COMPARISON_HTML_PATH = resolve(OUTPUT_DIRECTORY, 'comparison.html')
const COMPARISON_SCREENSHOT_PATH = resolve('.runtime', 'qa', 'pixel-first-round-quality-comparison.png')
const QA_LOG_PATH = resolve('.runtime', 'qa', 'pixel-first-round-quality.log')
const REAL_SOURCE_PATH = resolve('src', 'assets', 'sample-summer-character.png')
const PRESET_IDS = ['pixel-art', 'illustration', 'soft-alpha']
const EDGE_PATHS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function alphaCounts(rgba) {
  let transparent = 0
  let semiTransparent = 0
  for (let index = 3; index < rgba.length; index += 4) {
    if (rgba[index] === 0) transparent += 1
    else if (rgba[index] < 255) semiTransparent += 1
  }
  return { transparent, semiTransparent }
}

function createRgba(width, height) {
  return new Uint8ClampedArray(width * height * 4)
}

function setPixel(rgba, width, x, y, red, green, blue, alpha = 255) {
  const offset = (y * width + x) * 4
  rgba[offset] = red
  rgba[offset + 1] = green
  rgba[offset + 2] = blue
  rgba[offset + 3] = alpha
}

function createHardEdgePattern() {
  const width = 16
  const height = 16
  const rgba = createRgba(width, height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        setPixel(rgba, width, x, y, 24, 28, 36)
      } else if (x < 8 && y < 8) {
        setPixel(rgba, width, x, y, 239, 84, 80)
      } else if (x >= 8 && y < 8) {
        setPixel(rgba, width, x, y, 67, 132, 255)
      } else if (x < 8) {
        setPixel(rgba, width, x, y, 71, 190, 126)
      } else {
        setPixel(rgba, width, x, y, 246, 196, 73)
      }
    }
  }
  return { id: 'hard-edge', label: 'Native 16×16 hard-edge pattern', width, height, data: rgba }
}

function createFineOutlinePattern() {
  const width = 16
  const height = 16
  const rgba = createRgba(width, height)
  const paint = (x, y, alpha = 255) => setPixel(rgba, width, x, y, 48, 70, 92, alpha)
  for (let x = 2; x <= 13; x += 1) {
    paint(x, 2)
    paint(x, 13)
  }
  for (let y = 2; y <= 13; y += 1) {
    paint(2, y)
    paint(13, y)
  }
  for (let index = 0; index < 10; index += 1) {
    paint(3 + index, 3 + index, 220)
    paint(12 - index, 3 + index, 220)
  }
  for (let x = 5; x <= 10; x += 1) paint(x, 8, 255)
  return { id: 'fine-outline', label: 'Transparent fine line and outline', width, height, data: rgba }
}

function createAlphaGradient() {
  const width = 16
  const height = 16
  const rgba = createRgba(width, height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = Math.round(((x + y) / (width + height - 2)) * 255)
      setPixel(rgba, width, x, y, 40 + x * 9, 70 + y * 7, 180 - x * 5, alpha)
    }
  }
  return { id: 'alpha-gradient', label: 'Semi-transparent gradient', width, height, data: rgba }
}

async function findEdgePath() {
  for (const candidate of EDGE_PATHS) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // Try the next standard Edge installation path.
    }
  }
  return null
}

async function decodePngWithEdge(page, pngBytes) {
  const sourceUrl = `data:image/png;base64,${Buffer.from(pngBytes).toString('base64')}`
  const decoded = await page.evaluate(async (url) => {
    const image = new Image()
    image.src = url
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('Canvas 2D context is unavailable')
    context.drawImage(image, 0, 0)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    return { width: canvas.width, height: canvas.height, data: Array.from(pixels) }
  }, sourceUrl)
  return {
    width: decoded.width,
    height: decoded.height,
    data: new Uint8ClampedArray(decoded.data),
  }
}

async function encodePngWithEdge(page, width, height, rgba) {
  const base64 = await page.evaluate(({ width: targetWidth, height: targetHeight, data }) => {
    const canvas = document.createElement('canvas')
    canvas.width = targetWidth
    canvas.height = targetHeight
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('Canvas 2D context is unavailable')
    context.putImageData(new ImageData(new Uint8ClampedArray(data), targetWidth, targetHeight), 0, 0)
    return canvas.toDataURL('image/png').split(',', 2)[1]
  }, { width, height, data: Array.from(rgba) })
  return Buffer.from(base64, 'base64')
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]
}

function conversionOptions(input, presetId, size) {
  return {
    ...PIXEL_CONVERSION_PRESETS[presetId].settings,
    targetWidth: size,
    targetHeight: size,
    colorCount: 16,
    fit: 'contain',
    dither: 'none',
    documentId: `pixel-quality-${input.id}-${presetId}`,
    documentName: `${input.label} ${presetId}`,
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function buildComparisonHtml(qualityReport) {
  const fixtureSections = qualityReport.inputs.map((input) => {
    const sourceNote = input.sourcePath
      ? `<a href="../../${escapeHtml(input.sourcePath)}">${escapeHtml(input.sourcePath)}</a>`
      : '脚本内存生成；未保存源 PNG'
    const sourcePreview = input.sourcePath
      ? `<img class="source-image" src="../../${escapeHtml(input.sourcePath)}" alt="${escapeHtml(input.label)} 原图">`
      : '<div class="source-placeholder">合成输入<br>16×16 RGBA</div>'
    const cards = input.variants.map((variant) => {
      const output = variant.output
      const filename = basename(output.path)
      const combinedMedian = Number(variant.timingsMs.combinedMedian).toFixed(2)
      const conversionMedian = Number(variant.timingsMs.conversionMedian).toFixed(2)
      const renderMedian = Number(variant.timingsMs.renderMedian).toFixed(2)
      return `<article class="preset-card">
  <h3>${escapeHtml(variant.preset)}</h3>
  <a class="image-link" href="./${escapeHtml(filename)}"><img class="output-image" src="./${escapeHtml(filename)}" alt="${escapeHtml(input.label)} ${escapeHtml(variant.preset)}"></a>
  <p class="metrics">目标 ${output.dimensions.width}×${output.dimensions.height} · 色数 ${output.paletteSize}<br>透明 ${output.transparentPixels} · 半透明 ${output.semiTransparentPixels}<br>机器中位 ${combinedMedian} ms（转换 ${conversionMedian} / 渲染 ${renderMedian}）</p>
</article>`
    }).join('\n')
    return `<section class="fixture">
  <div class="fixture-heading">
    <div><h2>${escapeHtml(input.label)}</h2><p class="source-note">来源：${sourceNote}</p></div>
    <div class="source-preview">${sourcePreview}</div>
  </div>
  <div class="preset-grid">${cards}</div>
</section>`
  }).join('\n')
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pixel conversion first-round comparison</title>
  <style>
    :root { color-scheme: light; font-family: "Segoe UI", "Microsoft YaHei", sans-serif; background: #f5f7fb; color: #18202b; }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-width: 0; overflow-x: hidden; }
    body { padding: 24px; }
    main { width: min(1120px, 100%); margin: 0 auto; }
    header { padding: 4px 0 20px; }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: clamp(22px, 4vw, 32px); letter-spacing: -0.02em; }
    h2 { font-size: 20px; }
    h3 { font-size: 15px; text-transform: lowercase; }
    .lede, .review, .source-note { color: #566275; line-height: 1.55; }
    .lede { margin-top: 8px; }
    .review { display: inline-block; margin-top: 12px; padding: 7px 10px; border: 1px solid #e0b75a; border-radius: 8px; background: #fff8df; color: #755b12; }
    .fixture { margin: 16px 0; padding: 16px; border: 1px solid #dfe5ee; border-radius: 14px; background: #fff; box-shadow: 0 6px 20px rgba(29, 45, 72, 0.05); }
    .fixture-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; margin-bottom: 14px; }
    .source-note { margin-top: 5px; font-size: 13px; overflow-wrap: anywhere; }
    .source-preview { flex: 0 0 128px; width: 128px; min-height: 90px; display: grid; place-items: center; padding: 6px; border: 1px solid #e7ebf2; border-radius: 10px; background: repeating-conic-gradient(#f0f2f6 0 25%, #fff 0 50%) 50% / 16px 16px; }
    .source-image { display: block; width: 116px; max-height: 116px; object-fit: contain; }
    .source-placeholder { width: 100%; color: #7c8797; font-size: 12px; line-height: 1.4; text-align: center; }
    .preset-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
    .preset-card { min-width: 0; padding: 12px; border: 1px solid #e7ebf2; border-radius: 10px; background: #fbfcfe; }
    .image-link { display: block; margin-top: 8px; width: 100%; aspect-ratio: 1; display: grid; place-items: center; overflow: hidden; border-radius: 7px; background: repeating-conic-gradient(#edf0f5 0 25%, #fff 0 50%) 50% / 16px 16px; }
    .output-image { display: block; width: min(256px, 100%); height: min(256px, 100%); object-fit: contain; image-rendering: pixelated; image-rendering: crisp-edges; }
    .metrics { margin-top: 9px; color: #566275; font-size: 12px; line-height: 1.55; }
    footer { padding: 12px 0 4px; color: #778296; font-size: 12px; line-height: 1.5; }
    @media (max-width: 900px) { body { padding: 16px; } .preset-grid { grid-template-columns: 1fr; } .output-image { width: min(256px, 100%); height: min(256px, 100%); } }
    @media (max-width: 480px) { body { padding: 10px; } .fixture { padding: 12px; } .fixture-heading { display: block; } .source-preview { margin-top: 10px; } }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Pixel conversion first-round comparison</h1>
      <p class="lede">四类输入 × 三个现有 preset。图片仅用于机器确定性结果的人工复核。</p>
      <p class="lede">Palette split boundary: corrected to <code>sorted.length - 1</code>.</p>
      <p class="review">manualReview: ${escapeHtml(qualityReport.manualReview)} · 不自动推荐最佳 preset</p>
    </header>
    ${fixtureSections}
    <footer>固定设置：16 色 · fit=contain · dither=none。机器中位耗时不代表视觉质量。PNG 与数据报告由同一 benchmark 脚本生成。</footer>
  </main>
</body>
</html>
`
}

async function writeComparisonHtml(qualityReport) {
  await writeFile(COMPARISON_HTML_PATH, buildComparisonHtml(qualityReport), 'utf8')
}

async function benchmarkVariant(page, input, presetId, size) {
  const options = conversionOptions(input, presetId, size)
  const source = { width: input.width, height: input.height, data: input.data }
  const sourceHashBefore = sha256(source.data)
  const first = convertRgbaToPixelDocument(source, options)
  const second = convertRgbaToPixelDocument(source, options)
  const firstPixels = renderPixelFrameRgba(first.document, 'frame-1')
  const secondPixels = renderPixelFrameRgba(second.document, 'frame-1')
  const firstDocumentHash = sha256(serializePixelDocument(first.document))
  const secondDocumentHash = sha256(serializePixelDocument(second.document))
  const deterministic = firstDocumentHash === secondDocumentHash
    && sha256(firstPixels) === sha256(secondPixels)
    && JSON.stringify(first.report) === JSON.stringify(second.report)

  // Warmup is intentionally excluded from the five reported samples.
  const warmup = convertRgbaToPixelDocument(source, options)
  renderPixelFrameRgba(warmup.document, 'frame-1')
  const conversionTimings = []
  const renderTimings = []
  const combinedTimings = []
  let measured = first
  let measuredPixels = firstPixels
  for (let index = 0; index < 5; index += 1) {
    const combinedStarted = performance.now()
    const conversionStarted = performance.now()
    measured = convertRgbaToPixelDocument(source, options)
    conversionTimings.push(performance.now() - conversionStarted)
    const renderStarted = performance.now()
    measuredPixels = renderPixelFrameRgba(measured.document, 'frame-1')
    renderTimings.push(performance.now() - renderStarted)
    combinedTimings.push(performance.now() - combinedStarted)
  }

  const outputWidth = measured.document.width
  const outputHeight = measured.document.height
  assert(outputWidth <= 128 && outputHeight <= 128, 'Benchmark output exceeds 128px')
  const encodeStarted = performance.now()
  const png = await encodePngWithEdge(page, outputWidth, outputHeight, measuredPixels)
  const pngEncodeMs = performance.now() - encodeStarted
  const outputName = `${input.id}-${presetId}-${outputWidth}x${outputHeight}.png`
  const outputPath = resolve(OUTPUT_DIRECTORY, outputName)
  await writeFile(outputPath, png)

  const sourceHashAfter = sha256(source.data)
  const outputRgbaHash = sha256(measuredPixels)
  const outputAlpha = alphaCounts(measuredPixels)
  return {
    preset: presetId,
    options: {
      targetWidth: outputWidth,
      targetHeight: outputHeight,
      colorCount: 16,
      fit: 'contain',
      dither: 'none',
    },
    deterministic,
    sourceUnchanged: sourceHashBefore === sourceHashAfter,
    output: {
      dimensions: { width: outputWidth, height: outputHeight },
      rgbaBytes: measuredPixels.byteLength,
      rgbaSha256: outputRgbaHash,
      pngBytes: png.byteLength,
      pngSha256: sha256(png),
      paletteSize: measured.document.palette.length,
      transparentPixels: outputAlpha.transparent,
      semiTransparentPixels: outputAlpha.semiTransparent,
      path: relative(process.cwd(), outputPath).replaceAll('\\', '/'),
    },
    timingsMs: {
      conversionMedian: median(conversionTimings),
      renderMedian: median(renderTimings),
      combinedMedian: median(combinedTimings),
      pngEncode: pngEncodeMs,
    },
  }
}

const pageErrors = []
const consoleErrors = []
let browser
let page
let failure = null
let report = {
  schemaVersion: 1,
  kind: 'aeonquill.qa.pixel-first-round-quality',
  status: 'failed',
  manualReview: 'pending',
  assistantVisualReview: 'awaiting-root-review',
  qualityClaim: 'Deterministic algorithm benchmark only; no human visual quality conclusion.',
  algorithm: {
    converter: 'src/lib/pixel/pixelConversion.mjs::convertRgbaToPixelDocument',
    renderer: 'src/lib/pixel/pixelCore.mjs::renderPixelFrameRgba',
    pngEncoder: 'Microsoft Edge Canvas toDataURL(image/png)',
    paletteSplitBoundary: 'corrected: sorted.length - 1',
  },
  environment: {
    node: process.version,
    platform: `${platform()}-${release()}`,
    cpu: cpus()[0]?.model ?? 'unknown',
    totalMemoryBytes: totalmem(),
  },
  inputs: [],
  page: { consoleErrors, pageErrors },
}

try {
  const edgePath = await findEdgePath()
  if (!edgePath) throw new Error('Microsoft Edge executable was not found in the standard Windows installation paths')
  report.environment.edgePath = edgePath
  await mkdir(OUTPUT_DIRECTORY, { recursive: true })
  await mkdir(resolve('.runtime', 'qa'), { recursive: true })
  browser = await chromium.launch({ headless: true, executablePath: edgePath, args: ['--disable-gpu'] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  page = await context.newPage()
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })

  const inputs = [createHardEdgePattern(), createFineOutlinePattern(), createAlphaGradient()]
  const realPng = await readFile(REAL_SOURCE_PATH)
  const realImage = await decodePngWithEdge(page, realPng)
  inputs.push({
    id: 'summer-character',
    label: 'Repository real illustration',
    sourcePath: relative(process.cwd(), REAL_SOURCE_PATH).replaceAll('\\', '/'),
    width: realImage.width,
    height: realImage.height,
    data: realImage.data,
  })

  for (const input of inputs) {
    const size = input.id === 'summer-character' ? 32 : 16
    const inputAlpha = alphaCounts(input.data)
    const sourceHash = sha256(input.data)
    const variants = []
    for (const presetId of PRESET_IDS) variants.push(await benchmarkVariant(page, input, presetId, size))
    report.inputs.push({
      id: input.id,
      label: input.label,
      ...(input.sourcePath ? { sourcePath: input.sourcePath } : { source: 'Generated in benchmark script' }),
      input: {
        dimensions: { width: input.width, height: input.height },
        rgbaBytes: input.data.byteLength,
        rgbaSha256: sourceHash,
        transparentPixels: inputAlpha.transparent,
        semiTransparentPixels: inputAlpha.semiTransparent,
      },
      variants,
    })
  }
  assert.equal(pageErrors.length, 0, `Unexpected page errors: ${pageErrors.join('; ')}`)
  assert.equal(consoleErrors.length, 0, `Unexpected console errors: ${consoleErrors.join('; ')}`)
  assert(report.inputs.every((input) => input.variants.every((variant) => variant.deterministic && variant.sourceUnchanged)))
  report.status = 'passed'
  await writeComparisonHtml(report)
  await page.goto(pathToFileURL(COMPARISON_HTML_PATH).href, { waitUntil: 'load' })
  const desktopHorizontalOverflow = await page.evaluate(() => (
    document.documentElement.scrollWidth > window.innerWidth || document.body.scrollWidth > window.innerWidth
  ))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload({ waitUntil: 'load' })
  const mobileHorizontalOverflow = await page.evaluate(() => (
    document.documentElement.scrollWidth > window.innerWidth || document.body.scrollWidth > window.innerWidth
  ))
  assert.equal(desktopHorizontalOverflow, false, 'Comparison page overflows horizontally at desktop width')
  assert.equal(mobileHorizontalOverflow, false, 'Comparison page overflows horizontally at 390px width')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.reload({ waitUntil: 'load' })
  await page.screenshot({ path: COMPARISON_SCREENSHOT_PATH, fullPage: true })
  report.comparison = {
    html: relative(process.cwd(), COMPARISON_HTML_PATH).replaceAll('\\', '/'),
    screenshot: relative(process.cwd(), COMPARISON_SCREENSHOT_PATH).replaceAll('\\', '/'),
    desktopHorizontalOverflow,
    mobileHorizontalOverflow,
  }
} catch (error) {
  failure = error
  report.status = 'failed'
  report.error = { name: error?.name, message: error?.message }
} finally {
  report.page = { consoleErrors, pageErrors }
  await browser?.close().catch(() => {})
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  const variantCount = report.inputs.reduce((count, input) => count + input.variants.length, 0)
  const logLines = [
    `status=${report.status}`,
    `manualReview=${report.manualReview}`,
    `inputs=${report.inputs.length}`,
    `variants=${variantCount}`,
    `deterministicFailures=${report.inputs.flatMap((input) => input.variants).filter((variant) => !variant.deterministic).length}`,
    `sourceMutationFailures=${report.inputs.flatMap((input) => input.variants).filter((variant) => !variant.sourceUnchanged).length}`,
    `consoleErrors=${consoleErrors.length}`,
    `pageErrors=${pageErrors.length}`,
    ...(failure ? [`error=${failure.message}`] : []),
    `report=${relative(process.cwd(), REPORT_PATH).replaceAll('\\', '/')}`,
  ]
  await writeFile(QA_LOG_PATH, `${logLines.join('\n')}\n`, 'utf8')
}

if (failure) {
  console.error(`pixel-quality failed report=${relative(process.cwd(), REPORT_PATH).replaceAll('\\', '/')}`)
  process.exitCode = 1
} else {
  console.log(`pixel-quality report=${relative(process.cwd(), REPORT_PATH).replaceAll('\\', '/')} outputs=${report.inputs.length * PRESET_IDS.length}`)
}
