import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { createRestrictedChildEnvironment, redactSensitiveText } from './security.mjs'

export const ASSET_VARIANTS = Object.freeze({
  'thumbnail-v1': Object.freeze({ maxEdge: 512, quality: 72 }),
  'preview-v1': Object.freeze({ maxEdge: 1600, quality: 82 }),
})

const ASSET_ID_PATTERN = /^[a-f0-9]{64}$/
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

function serviceError(code, message, status = 500) {
  return Object.assign(new Error(message), { code, status })
}

function safeChild(rootDirectory, filename) {
  const root = resolve(rootDirectory)
  const target = resolve(root, filename)
  if (!target.startsWith(`${root}${sep}`)) {
    throw serviceError('UNSAFE_PREVIEW_PATH', 'Asset preview path escaped its managed directory')
  }
  return target
}

export function assertAssetVariant(value) {
  const variant = String(value || '')
  if (!Object.hasOwn(ASSET_VARIANTS, variant)) {
    throw serviceError('INVALID_ASSET_VARIANT', 'Asset preview variant is not supported', 400)
  }
  return variant
}

function renderWithFfmpeg({ ffmpegPath, inputPath, outputPath, maxEdge, quality }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(ffmpegPath, [
      '-hide_banner',
      '-loglevel', 'error',
      '-nostdin',
      '-y',
      '-i', inputPath,
      '-frames:v', '1',
      '-vf', `scale=w='min(${maxEdge},iw)':h='min(${maxEdge},ih)':force_original_aspect_ratio=decrease`,
      '-c:v', 'libwebp',
      '-quality', String(quality),
      '-compression_level', '4',
      outputPath,
    ], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: createRestrictedChildEnvironment(),
    })
    let stderr = ''
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      callback(value)
    }
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      finish(rejectPromise, serviceError('ASSET_PREVIEW_TIMEOUT', 'Asset preview generation timed out', 504))
    }, 45_000)
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_000) })
    child.once('error', (error) => finish(
      rejectPromise,
      serviceError('ASSET_PREVIEW_UNAVAILABLE', `Asset preview renderer is unavailable: ${redactSensitiveText(error.message)}`, 503),
    ))
    child.once('exit', (code) => {
      if (code === 0) finish(resolvePromise)
      else finish(
        rejectPromise,
        serviceError('ASSET_PREVIEW_FAILED', `Asset preview generation failed: ${redactSensitiveText(stderr)}`, 500),
      )
    })
  })
}

export class AssetPreviewService {
  constructor({
    rootDirectory,
    ffmpegPath = 'ffmpeg',
    concurrency = 1,
    renderer = renderWithFfmpeg,
  }) {
    this.rootDirectory = resolve(rootDirectory)
    this.ffmpegPath = ffmpegPath
    this.concurrency = Math.max(1, Math.min(2, Math.round(concurrency) || 1))
    this.renderer = renderer
    this.inFlight = new Map()
    this.queue = []
    this.active = 0
  }

  async open() {
    await mkdir(this.rootDirectory, { recursive: true })
    return this
  }

  variantPath(assetId, variant) {
    if (!ASSET_ID_PATTERN.test(String(assetId || ''))) {
      throw serviceError('INVALID_ASSET_ID', 'Asset id is invalid', 400)
    }
    assertAssetVariant(variant)
    return safeChild(this.rootDirectory, `${assetId}-${variant}.webp`)
  }

  runQueued(task) {
    return new Promise((resolvePromise, rejectPromise) => {
      this.queue.push({ task, resolvePromise, rejectPromise })
      this.drain()
    })
  }

  drain() {
    while (this.active < this.concurrency && this.queue.length) {
      const next = this.queue.shift()
      this.active += 1
      Promise.resolve()
        .then(next.task)
        .then(next.resolvePromise, next.rejectPromise)
        .finally(() => {
          this.active -= 1
          this.drain()
        })
    }
  }

  async materialize({ assetId, inputPath, mimeType }, variantValue) {
    const variant = assertAssetVariant(variantValue)
    if (!IMAGE_MIME_TYPES.has(mimeType)) {
      throw serviceError('ASSET_PREVIEW_UNSUPPORTED', 'Only image assets support preview variants', 415)
    }
    const outputPath = this.variantPath(assetId, variant)
    try {
      const existing = await stat(outputPath)
      if (existing.isFile() && existing.size > 0) return { path: outputPath, bytes: existing.size, variant }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const key = `${assetId}:${variant}`
    const pending = this.inFlight.get(key)
    if (pending) return pending
    const job = this.runQueued(async () => {
      const temporaryPath = safeChild(this.rootDirectory, `${assetId}-${variant}-${randomUUID()}.tmp.webp`)
      try {
        const config = ASSET_VARIANTS[variant]
        await this.renderer({
          ffmpegPath: this.ffmpegPath,
          inputPath,
          outputPath: temporaryPath,
          ...config,
        })
        const generated = await stat(temporaryPath)
        if (!generated.isFile() || generated.size < 1 || generated.size > 32 * 1024 * 1024) {
          throw serviceError('ASSET_PREVIEW_INVALID', 'Generated asset preview is empty or too large')
        }
        try {
          await rename(temporaryPath, outputPath)
        } catch (error) {
          if (error.code !== 'EEXIST') throw error
        }
        const committed = await stat(outputPath)
        return { path: outputPath, bytes: committed.size, variant }
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => {})
      }
    }).finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, job)
    return job
  }

  async removeVariants(assetIds) {
    const ids = [...new Set(assetIds)].filter((assetId) => ASSET_ID_PATTERN.test(String(assetId || '')))
    await Promise.all(ids.flatMap((assetId) => Object.keys(ASSET_VARIANTS).map((variant) =>
      rm(this.variantPath(assetId, variant), { force: true }).catch(() => {}),
    )))
  }
}
