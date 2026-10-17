import type { ProcessingStep } from '../types'
import {
  ImageEffectContractError,
  normalizeImageEffectParameters,
  IMAGE_EFFECT_MAX_CACHED_CHARACTERS,
  IMAGE_EFFECT_MAX_EDGE,
  IMAGE_EFFECT_MAX_PIXELS,
  IMAGE_EFFECT_MAX_BATCH_PIXELS,
  IMAGE_EFFECT_MAX_BATCH_WORK_PIXELS,
  isReplayableImageStep,
} from './imageEffects.mjs'
import {
  createCropPreview,
  createImageAdjustmentRaster,
  createMaskRefinement,
} from './imageProcessing'
export type ImageEffectReplayOptions = {
  signal?: AbortSignal
}

export type ImageEffectReplayResult = {
  steps: ProcessingStep[]
  src: string
  width: number
  height: number
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  const error = new Error('图像处理已取消')
  error.name = 'AbortError'
  throw error
}

export function loadImageEffectDimensions(src: string, signal?: AbortSignal) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    if (typeof Image === 'undefined') {
      reject(new Error('当前环境无法加载浏览器图像'))
      return
    }
    const image = new Image()
    image.decoding = 'async'
    const cleanup = () => { image.onload = null; image.onerror = null; signal?.removeEventListener('abort', abort) }
    const abort = () => { cleanup(); image.src = ''; reject(new DOMException('图像读取已取消', 'AbortError')) }
    image.onload = () => { const dimensions = { width: image.naturalWidth, height: image.naturalHeight }; cleanup(); resolve(dimensions) }
    image.onerror = () => { cleanup(); reject(new Error('无法读取当前图片')) }
    if (signal?.aborted) { abort(); return }
    signal?.addEventListener('abort', abort, { once: true })
    image.src = src
  })
}

export async function preflightImageEffectBatch(requests: Array<{ source: string; steps: ProcessingStep[] }>, signal?: AbortSignal) {
  let pixels = 0, workPixels = 0
  for (const request of requests) {
    throwIfAborted(signal)
    if (request.steps.length > 64) throw new Error('每张图片最多 64 个效果步骤')
    const source = await loadImageEffectDimensions(request.source, signal)
    let peak = source.width * source.height
    for (const step of request.steps) {
      if (!step.enabled || !step.outputSrc || isReplayableImageStep(step)) continue
      const size = await loadImageEffectDimensions(step.outputSrc, signal)
      peak = Math.max(peak, size.width * size.height)
    }
    pixels += peak
    workPixels += peak * request.steps.filter((step) => step.enabled && isReplayableImageStep(step)).length
    if (pixels > IMAGE_EFFECT_MAX_BATCH_PIXELS || workPixels > IMAGE_EFFECT_MAX_BATCH_WORK_PIXELS) {
      throw new Error('批量效果超过 3200万输入像素或1.28亿处理像素，请减少图片或效果步骤后分批应用')
    }
  }
  return { pixels, workPixels }
}

function cloneSteps(steps: readonly ProcessingStep[]) {
  if (!Array.isArray(steps)) {
    throw new ImageEffectContractError('INVALID_STEPS', 'steps must be an array')
  }
  return structuredClone(steps)
}

function effectParameters(step: ProcessingStep) {
  return Object.hasOwn(step, 'parameters') ? step.parameters : undefined
}

export async function replayImageProcessingStack(
  source: string,
  steps: ProcessingStep[],
  { signal }: ImageEffectReplayOptions = {},
): Promise<ImageEffectReplayResult> {
  if (typeof source !== 'string' || !source) {
    throw new ImageEffectContractError('INVALID_SOURCE', 'source must be a non-empty string')
  }
  const replayedSteps = cloneSteps(steps)
  let currentSrc = source
  let width = 0
  let height = 0
  let cachedCharacters = 0
  const checkOutput = (src: string) => {
    if (src.startsWith('data:')) cachedCharacters += src.length
    if (cachedCharacters > IMAGE_EFFECT_MAX_CACHED_CHARACTERS) throw new Error('效果缓存超过 16Mi 字符，请减少步骤或先缩小图片')
  }

  for (const step of replayedSteps) {
    throwIfAborted(signal)
    if (!step.enabled) continue

    if (step.type === 'adjust' || step.type === 'crop') {
      const rawParameters = effectParameters(step)
      if (rawParameters !== undefined) {
        const parameters = normalizeImageEffectParameters(rawParameters)
        if (parameters.kind !== step.type) {
          throw new ImageEffectContractError(
            'PARAMETER_KIND_MISMATCH',
            `step ${step.id} type does not match parameters.kind`,
          )
        }
        const result = parameters.kind === 'adjust'
          ? await createImageAdjustmentRaster(currentSrc, parameters)
          : await createCropPreview(currentSrc, parameters, { output: 'full' })
        throwIfAborted(signal)
        step.outputSrc = result.url
        currentSrc = result.url
        checkOutput(currentSrc)
        width = result.width
        height = result.height
        continue
      }
    }

    if (step.type === 'mask-refine' && step.maskRecipe !== undefined) {
      const inputSize = width && height ? { width, height } : await loadImageEffectDimensions(currentSrc, signal)
      throwIfAborted(signal)
      if (Math.max(inputSize.width, inputSize.height) > IMAGE_EFFECT_MAX_EDGE || inputSize.width * inputSize.height > IMAGE_EFFECT_MAX_PIXELS) {
        throw new Error('本地效果蒙版超过 4096px 或 1600万像素，请先缩小或裁剪')
      }
      const result = await createMaskRefinement(currentSrc, step.maskRecipe)
      throwIfAborted(signal)
      step.outputSrc = result.previewUrl
      currentSrc = result.previewUrl
      checkOutput(currentSrc)
      width = result.width
      height = result.height
      continue
    }

    if (step.outputSrc !== undefined) {
      currentSrc = step.outputSrc
      const dimensions = await loadImageEffectDimensions(currentSrc, signal)
      throwIfAborted(signal)
      width = dimensions.width
      height = dimensions.height
    }
  }

  throwIfAborted(signal)
  if (!width || !height) {
    const dimensions = await loadImageEffectDimensions(currentSrc, signal)
    throwIfAborted(signal)
    width = dimensions.width
    height = dimensions.height
  }
  return { steps: replayedSteps, src: currentSrc, width, height }
}
