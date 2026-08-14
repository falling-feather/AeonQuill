import { mkdir, rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { ImageProcessor, validateImageRequest } from './image-processor.mjs'
import { loadLocalRuntimeConfig } from './runtime-manager.mjs'
import { projectRoot, runtimeDirectory } from './runtime-paths.mjs'

const sourcePath = join(projectRoot, 'src', 'assets', 'sample-summer-character.png')
const validationDirectory = join(runtimeDirectory, 'image-tools-validation')
const safeRuntimeRoot = `${resolve(runtimeDirectory)}${sep}`

if (!resolve(validationDirectory).startsWith(safeRuntimeRoot)) {
  throw new Error('Validation directory must remain inside .runtime')
}

await mkdir(validationDirectory, { recursive: true })
const localConfig = await loadLocalRuntimeConfig()
const processor = new ImageProcessor({
  ffmpegPath: localConfig.imageTools?.ffmpegPath,
  ffprobePath: localConfig.imageTools?.ffprobePath,
  pythonPath: localConfig.pythonPath,
  rembgPath: localConfig.imageTools?.rembgPath,
  rembgModelsPath: localConfig.imageTools?.rembgModelsPath,
  realEsrganPath: localConfig.imageTools?.realEsrganPath,
  realEsrganModelsPath: localConfig.imageTools?.realEsrganModelsPath,
})

try {
  const capabilities = await processor.probe(true)
  const available = capabilities.operations.filter((operation) => operation.available).map((operation) => operation.id)
  console.log(`Available image tools: ${available.join(', ')}`)

  const cases = [
    ['upscale-lanczos', { scale: 1.5, sharpen: 0.2 }],
    ['pixelate', { targetSize: 32, colors: 12, outputScale: 4, dither: 'bayer', alphaThreshold: 96 }],
    ['sharpen', { radius: 5, amount: 0.65 }],
    ['alpha-cleanup', { transparentBelow: 24, opaqueAbove: 232 }],
  ]

  for (const [operation, rawParams] of cases) {
    const request = validateImageRequest({ operation, params: rawParams }, capabilities)
    const outputPath = join(validationDirectory, `${operation}.png`)
    const output = await processor.process({
      ...request,
      inputPath: sourcePath,
      outputPath,
      signal: new AbortController().signal,
    })
    console.log(`${operation}: ${output.width}x${output.height}, ${output.bytes} bytes, ${output.provider}`)
  }

  const unavailable = capabilities.operations
    .filter((operation) => !operation.available)
    .map((operation) => `${operation.id}: ${operation.unavailableReason}`)
  for (const line of unavailable) console.log(`Unavailable (expected): ${line}`)
} finally {
  await rm(validationDirectory, { recursive: true, force: true })
}
