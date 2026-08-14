import { spawn } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRestrictedChildEnvironment, redactSensitiveText } from './security.mjs'

const serverDirectory = fileURLToPath(new URL('./', import.meta.url))
const rembgRunnerPath = join(serverDirectory, 'rembg-runner.py')

export const IMAGE_TOOLS_VERSION = 'image-tools-v2'

const MAX_INPUT_PIXELS = 40_000_000
const MAX_OUTPUT_PIXELS = 64_000_000
const PROBE_TTL_MS = 30_000

const PIXEL_SIZES = new Set([16, 24, 32, 48, 64, 96, 128, 256])
const PIXEL_OUTPUT_SCALES = new Set([1, 2, 4, 8])
const PIXEL_DITHERS = new Set(['none', 'bayer', 'floyd_steinberg', 'sierra2_4a', 'atkinson'])
const MASKED_ADJUST_EFFECTS = new Set([
  'selection-highlight',
  'background-dim',
  'background-blur',
])
const REAL_ESRGAN_MODELS = new Set([
  'realesrgan-x4plus',
  'realesrgan-x4plus-anime',
  'realesr-animevideov3',
])
const REMBG_MODELS = new Set(['u2netp', 'u2net'])

function abortError() {
  const error = new Error('Image processing was cancelled')
  error.name = 'AbortError'
  return error
}

function boundedNumber(value, fallback, minimum, maximum, label) {
  const number = value === undefined ? fallback : Number(value)
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw Object.assign(new Error(`${label} must be between ${minimum} and ${maximum}`), { status: 400 })
  }
  return number
}

function enumValue(value, fallback, allowed, label) {
  const normalized = value === undefined ? fallback : String(value)
  if (!allowed.has(normalized)) {
    throw Object.assign(new Error(`${label} is not supported`), { status: 400 })
  }
  return normalized
}

function assertParamKeys(params, allowed) {
  const allowedKeys = new Set(allowed)
  const unknown = Object.keys(params).filter((key) => !allowedKeys.has(key))
  if (unknown.length) {
    throw Object.assign(new Error(`Unsupported image parameters: ${unknown.join(', ')}`), { status: 400 })
  }
}

async function isFile(pathname) {
  if (!pathname) return false
  try {
    return (await stat(pathname)).isFile()
  } catch {
    return false
  }
}

function runCommand(command, args, { signal, timeoutMs = 120_000, acceptNonZero = false, env } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted) return rejectPromise(abortError())
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: createRestrictedChildEnvironment(env),
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let terminating = false

    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      callback(value)
    }
    const terminate = () => new Promise((resolveTermination) => {
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        })
        killer.once('error', () => {
          child.kill('SIGKILL')
          resolveTermination()
        })
        killer.once('exit', () => resolveTermination())
      } else {
        child.kill('SIGKILL')
        resolveTermination()
      }
    })
    const onAbort = () => {
      if (settled || terminating) return
      terminating = true
      void terminate().then(() => {
        terminating = false
        finish(rejectPromise, abortError())
      })
    }
    const timer = setTimeout(() => {
      if (settled || terminating) return
      terminating = true
      void terminate().then(() => {
        terminating = false
      finish(rejectPromise, new Error(`${redactSensitiveText(command)} timed out`))
      })
    }, timeoutMs)

    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-64_000) })
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-64_000) })
    child.once('error', (error) => finish(rejectPromise, error))
    child.once('exit', (code) => {
      if (terminating) return
      const result = { code: Number(code ?? -1), stdout, stderr }
      if (code === 0 || acceptNonZero) finish(resolvePromise, result)
      else finish(rejectPromise, new Error(`${redactSensitiveText(command)} exited with code ${code}: ${redactSensitiveText(stderr.slice(-2_000))}`))
    })
  })
}

async function findOnPath(names) {
  if (process.platform !== 'win32') return names[0]
  for (const name of names) {
    try {
      const result = await runCommand('where.exe', [name], { timeoutMs: 5_000 })
      const first = result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
      if (first) return first
    } catch {
      // Continue probing other names.
    }
  }
  return null
}

async function listRealEsrganModels(modelDirectory) {
  if (!modelDirectory) return []
  try {
    const entries = await readdir(modelDirectory, { withFileTypes: true })
    const filenames = new Map(entries
      .filter((entry) => entry.isFile())
      .map((entry) => [entry.name.toLowerCase(), entry.name]))
    const hasPair = async (baseName) => {
      const paramName = `${baseName}.param`.toLowerCase()
      const binName = `${baseName}.bin`.toLowerCase()
      if (!filenames.has(paramName) || !filenames.has(binName)) return false
      const [paramStats, binStats] = await Promise.all([
        stat(join(modelDirectory, filenames.get(paramName))),
        stat(join(modelDirectory, filenames.get(binName))),
      ])
      return paramStats.size > 128 && binStats.size > 1024 * 1024
    }
    const discovered = []
    for (const model of REAL_ESRGAN_MODELS) {
      if (model !== 'realesr-animevideov3' && await hasPair(model)) discovered.push(model)
    }
    const animeScales = await Promise.all([2, 3, 4].map((scale) => hasPair(`realesr-animevideov3-x${scale}`)))
    if (animeScales.every(Boolean)) {
      discovered.push('realesr-animevideov3')
    }
    return [...new Set(discovered)]
  } catch {
    return []
  }
}

async function listRembgModels(modelDirectory) {
  try {
    const entries = await readdir(modelDirectory, { withFileTypes: true })
    const candidates = entries
      .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.onnx')
      .map((entry) => entry.name.replace(/\.onnx$/i, ''))
      .filter((name) => REMBG_MODELS.has(name))
    const validated = await Promise.all(candidates.map(async (name) => {
      const fileStats = await stat(join(modelDirectory, modelFileForRembg(name)))
      return fileStats.size > 1024 * 1024 ? name : null
    }))
    return validated
      .filter(Boolean)
      .sort((left, right) => (left === 'u2netp' ? -1 : right === 'u2netp' ? 1 : left.localeCompare(right)))
  } catch {
    return []
  }
}

function modelFileForRembg(model) {
  return model === 'u2net' ? 'u2net.onnx' : `${model}.onnx`
}

export function validateImageRequest(body, capabilities) {
  const operation = String(body.operation || '')
  const capability = capabilities.operations.find((candidate) => candidate.id === operation)
  if (!capability) {
    throw Object.assign(new Error('Unsupported image operation'), { status: 400, code: 'IMAGE_OPERATION_UNSUPPORTED' })
  }
  if (!capability.available) {
    throw Object.assign(new Error(capability.unavailableReason || `${operation} is unavailable`), {
      status: 409,
      code: 'IMAGE_OPERATION_UNAVAILABLE',
    })
  }

  const suppliedParams = body.params && typeof body.params === 'object' && !Array.isArray(body.params)
    ? body.params
    : {}
  let params
  if (operation === 'upscale-lanczos') {
    assertParamKeys(suppliedParams, ['scale', 'sharpen'])
    const scale = boundedNumber(suppliedParams.scale, 2, 1.25, 4, 'scale')
    if (![1.5, 2, 3, 4].includes(scale)) {
      throw Object.assign(new Error('scale must be one of 1.5, 2, 3, or 4'), { status: 400 })
    }
    params = {
      scale,
      sharpen: boundedNumber(suppliedParams.sharpen, 0.2, 0, 1.5, 'sharpen'),
    }
  } else if (operation === 'pixelate') {
    assertParamKeys(suppliedParams, ['targetSize', 'colors', 'outputScale', 'dither', 'alphaThreshold'])
    const targetSize = Math.round(boundedNumber(suppliedParams.targetSize, 64, 16, 256, 'targetSize'))
    if (!PIXEL_SIZES.has(targetSize)) {
      throw Object.assign(new Error('targetSize must be one of 16, 24, 32, 48, 64, 96, 128, or 256'), { status: 400 })
    }
    const colors = Math.round(boundedNumber(suppliedParams.colors, 16, 2, 64, 'colors'))
    const outputScale = Math.round(boundedNumber(suppliedParams.outputScale, 4, 1, 8, 'outputScale'))
    if (!PIXEL_OUTPUT_SCALES.has(outputScale)) {
      throw Object.assign(new Error('outputScale must be one of 1, 2, 4, or 8'), { status: 400 })
    }
    params = {
      targetSize,
      colors,
      outputScale,
      dither: enumValue(suppliedParams.dither, 'bayer', PIXEL_DITHERS, 'dither'),
      alphaThreshold: Math.round(boundedNumber(suppliedParams.alphaThreshold, 96, 0, 255, 'alphaThreshold')),
    }
  } else if (operation === 'sharpen') {
    assertParamKeys(suppliedParams, ['radius', 'amount'])
    const radius = Math.round(boundedNumber(suppliedParams.radius, 5, 3, 7, 'radius'))
    if (![3, 5, 7].includes(radius)) {
      throw Object.assign(new Error('radius must be one of 3, 5, or 7'), { status: 400 })
    }
    params = {
      radius,
      amount: boundedNumber(suppliedParams.amount, 0.65, 0.1, 2.5, 'amount'),
    }
  } else if (operation === 'alpha-cleanup') {
    assertParamKeys(suppliedParams, ['transparentBelow', 'opaqueAbove'])
    params = {
      transparentBelow: Math.round(boundedNumber(suppliedParams.transparentBelow, 24, 0, 127, 'transparentBelow')),
      opaqueAbove: Math.round(boundedNumber(suppliedParams.opaqueAbove, 232, 128, 255, 'opaqueAbove')),
    }
    if (params.transparentBelow >= params.opaqueAbove) {
      throw Object.assign(new Error('transparentBelow must be lower than opaqueAbove'), { status: 400 })
    }
  } else if (operation === 'masked-adjust') {
    assertParamKeys(suppliedParams, ['effect', 'strength', 'feather'])
    params = {
      effect: enumValue(
        suppliedParams.effect,
        'background-dim',
        MASKED_ADJUST_EFFECTS,
        'effect',
      ),
      strength: boundedNumber(suppliedParams.strength, 0.6, 0.1, 1, 'strength'),
      feather: Math.round(boundedNumber(suppliedParams.feather, 4, 0, 32, 'feather')),
    }
  } else if (operation === 'remove-background') {
    assertParamKeys(suppliedParams, [
      'model',
      'alphaMatting',
      'foregroundThreshold',
      'backgroundThreshold',
      'erodeSize',
    ])
    const availableModels = new Set(capability.models || [])
    const defaultModel = availableModels.has('u2netp') ? 'u2netp' : capability.models?.[0]
    params = {
      model: enumValue(suppliedParams.model, defaultModel, availableModels, 'model'),
      alphaMatting: suppliedParams.alphaMatting === true,
      foregroundThreshold: Math.round(boundedNumber(suppliedParams.foregroundThreshold, 240, 1, 255, 'foregroundThreshold')),
      backgroundThreshold: Math.round(boundedNumber(suppliedParams.backgroundThreshold, 10, 0, 254, 'backgroundThreshold')),
      erodeSize: Math.round(boundedNumber(suppliedParams.erodeSize, 10, 0, 40, 'erodeSize')),
    }
  } else if (operation === 'upscale-realesrgan') {
    assertParamKeys(suppliedParams, ['scale', 'model', 'tileSize'])
    const availableModels = new Set(capability.models || [])
    params = {
      scale: Math.round(boundedNumber(suppliedParams.scale, 4, 2, 4, 'scale')),
      model: enumValue(suppliedParams.model, capability.models?.[0], availableModels, 'model'),
      tileSize: Math.round(boundedNumber(suppliedParams.tileSize, 0, 0, 1024, 'tileSize')),
    }
    if (![2, 3, 4].includes(params.scale)) {
      throw Object.assign(new Error('scale must be one of 2, 3, or 4'), { status: 400 })
    }
  }

  return {
    operation,
    params,
    ...(operation === 'masked-adjust' ? { maskProvided: true } : {}),
    sourceElementId: typeof body.sourceElementId === 'string' ? body.sourceElementId.slice(0, 200) : undefined,
  }
}

export class ImageProcessor {
  constructor({
    ffmpegPath = 'ffmpeg',
    ffprobePath,
    pythonPath,
    rembgPath,
    rembgModelsPath,
    realEsrganPath,
    realEsrganModelsPath,
  } = {}) {
    this.ffmpegPath = process.env.FFMPEG_PATH || ffmpegPath
    const companionProbe = isAbsolute(this.ffmpegPath)
      ? join(dirname(this.ffmpegPath), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
      : 'ffprobe'
    this.ffprobePath = process.env.FFPROBE_PATH || ffprobePath || companionProbe
    this.pythonPath = pythonPath
    this.rembgPath = rembgPath
    this.rembgModelsPath = rembgModelsPath
    this.realEsrganPath = realEsrganPath
    this.realEsrganModelsPath = realEsrganModelsPath
    this.probeResult = null
    this.probeAt = 0
    this.rembgAdapter = null
    this.rembgProbeReason = null
    this.realEsrganAdapter = null
  }

  async probe(force = false) {
    if (!force && this.probeResult && Date.now() - this.probeAt < PROBE_TTL_MS) return this.probeResult
    let ffmpegAvailable = false
    let ffprobeAvailable = false
    try {
      await runCommand(this.ffmpegPath, ['-hide_banner', '-version'], { timeoutMs: 8_000 })
      ffmpegAvailable = true
    } catch {
      ffmpegAvailable = false
    }
    try {
      await runCommand(this.ffprobePath, ['-hide_banner', '-version'], { timeoutMs: 8_000 })
      ffprobeAvailable = true
    } catch {
      if (this.ffprobePath !== 'ffprobe') {
        try {
          await runCommand('ffprobe', ['-hide_banner', '-version'], { timeoutMs: 8_000 })
          this.ffprobePath = 'ffprobe'
          ffprobeAvailable = true
        } catch {
          ffprobeAvailable = false
        }
      }
    }

    this.rembgAdapter = await this.probeRembg()
    this.realEsrganAdapter = await this.probeRealEsrgan()
    const deterministicAvailable = ffmpegAvailable && ffprobeAvailable
    const deterministicReason = deterministicAvailable ? undefined : '未检测到 FFmpeg 或 FFprobe'
    const rembgReason = this.rembgAdapter
      ? undefined
      : this.rembgProbeReason || '未检测到 rembg；请配置本机 Python/CLI 与离线模型目录'
    const realEsrganReason = this.realEsrganAdapter
      ? undefined
      : '未检测到 Real-ESRGAN NCNN 可执行文件或兼容模型'

    this.probeResult = {
      version: IMAGE_TOOLS_VERSION,
      checkedAt: Date.now(),
      limits: {
        maxInputBytes: 20 * 1024 * 1024,
        maxInputPixels: MAX_INPUT_PIXELS,
        maxOutputPixels: MAX_OUTPUT_PIXELS,
      },
      operations: [
        {
          id: 'upscale-lanczos',
          label: 'Lanczos 超分',
          category: 'upscale',
          provider: 'ffmpeg',
          deterministic: true,
          available: deterministicAvailable,
          unavailableReason: deterministicReason,
          params: { scale: [1.5, 2, 3, 4], sharpen: [0, 1.5] },
        },
        {
          id: 'pixelate',
          label: '调色板像素化',
          category: 'pixel',
          provider: 'ffmpeg',
          deterministic: true,
          available: deterministicAvailable,
          unavailableReason: deterministicReason,
          params: {
            targetSize: [...PIXEL_SIZES],
            colors: [2, 64],
            outputScale: [...PIXEL_OUTPUT_SCALES],
            dither: [...PIXEL_DITHERS],
          },
        },
        {
          id: 'sharpen',
          label: '细节锐化',
          category: 'enhance',
          provider: 'ffmpeg',
          deterministic: true,
          available: deterministicAvailable,
          unavailableReason: deterministicReason,
          params: { radius: [3, 5, 7], amount: [0.1, 2.5] },
        },
        {
          id: 'alpha-cleanup',
          label: '透明边清理',
          category: 'cleanup',
          provider: 'ffmpeg',
          deterministic: true,
          available: deterministicAvailable,
          unavailableReason: deterministicReason,
          params: { transparentBelow: [0, 127], opaqueAbove: [128, 255] },
        },
        {
          id: 'masked-adjust',
          label: '蒙版区域调整',
          category: 'masked-edit',
          provider: 'ffmpeg',
          deterministic: true,
          available: deterministicAvailable,
          unavailableReason: deterministicReason,
          params: {
            effect: [...MASKED_ADJUST_EFFECTS],
            strength: [0.1, 1],
            feather: [0, 32],
          },
        },
        {
          id: 'remove-background',
          label: 'AI 去背景',
          category: 'segmentation',
          provider: 'rembg',
          deterministic: false,
          available: Boolean(this.rembgAdapter),
          unavailableReason: rembgReason,
          models: this.rembgAdapter?.models || [],
          params: { alphaMatting: [false, true] },
        },
        {
          id: 'upscale-realesrgan',
          label: 'Real-ESRGAN 超分',
          category: 'upscale',
          provider: 'realesrgan-ncnn-vulkan',
          deterministic: false,
          available: Boolean(this.realEsrganAdapter),
          unavailableReason: realEsrganReason,
          models: this.realEsrganAdapter?.models || [],
          params: { scale: [2, 3, 4], tileSize: [0, 1024] },
        },
      ],
    }
    this.probeAt = Date.now()
    return this.probeResult
  }

  async probeRembg() {
    this.rembgProbeReason = null
    let executableAdapter = null
    if (await isFile(this.pythonPath)) {
      try {
        await runCommand(this.pythonPath, [
          '-c',
          'from rembg import new_session, remove; print("rembg-api-ready")',
        ], { timeoutMs: 30_000 })
        executableAdapter = { command: this.pythonPath, type: 'python-api' }
      } catch {
        // Fall back to a configured standalone CLI.
      }
    }
    const explicit = process.env.AEONQUILL_REMBG_PATH || process.env.MIAOHUI_REMBG_PATH || this.rembgPath
    const command = !executableAdapter && explicit && await isFile(explicit)
      ? resolve(explicit)
      : !executableAdapter ? await findOnPath(['rembg.exe', 'rembg']) : null
    if (!executableAdapter && command) {
      try {
        await runCommand(command, ['--help'], { timeoutMs: 12_000 })
        executableAdapter = { command, type: 'cli' }
      } catch {
        // Optional adapter remains unavailable.
      }
    }
    if (!executableAdapter) return null
    const modelDirectory = process.env.AEONQUILL_REMBG_MODELS
      || process.env.MIAOHUI_REMBG_MODELS
      || this.rembgModelsPath
      || process.env.U2NET_HOME
      || join(homedir(), '.u2net')
    const models = await listRembgModels(modelDirectory)
    if (!models.length) {
      this.rembgProbeReason = '已检测到 rembg，但离线目录中没有受支持的 ONNX 模型；请在设置中选择模型目录，或配置 AEONQUILL_REMBG_MODELS'
      return null
    }
    return { ...executableAdapter, modelDirectory, models }
  }

  async probeRealEsrgan() {
    const explicit = process.env.AEONQUILL_REALESRGAN_PATH
      || process.env.MIAOHUI_REALESRGAN_PATH
      || this.realEsrganPath
    const command = explicit && await isFile(explicit)
      ? resolve(explicit)
      : await findOnPath(['realesrgan-ncnn-vulkan.exe', 'realesrgan-ncnn-vulkan'])
    if (!command) return null
    try {
      await runCommand(command, ['-h'], { timeoutMs: 12_000, acceptNonZero: true })
    } catch {
      return null
    }
    const modelDirectory = process.env.AEONQUILL_REALESRGAN_MODELS
      || process.env.MIAOHUI_REALESRGAN_MODELS
      || this.realEsrganModelsPath
      || join(dirname(command), 'models')
    const models = await listRealEsrganModels(modelDirectory)
    return models.length ? { command, modelDirectory, models } : null
  }

  async dimensions(inputPath, signal) {
    const result = await runCommand(this.ffprobePath, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,pix_fmt',
      '-of', 'json',
      inputPath,
    ], { signal, timeoutMs: 30_000 })
    const stream = JSON.parse(result.stdout).streams?.[0]
    const width = Number(stream?.width)
    const height = Number(stream?.height)
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw Object.assign(new Error('The uploaded image has invalid dimensions'), { status: 400 })
    }
    if (width * height > MAX_INPUT_PIXELS) {
      throw Object.assign(new Error(`Input image exceeds ${MAX_INPUT_PIXELS} pixels`), { status: 413 })
    }
    return { width, height, pixelFormat: stream.pix_fmt }
  }

  assertOutputSize(width, height) {
    if (width < 1 || height < 1 || width * height > MAX_OUTPUT_PIXELS) {
      throw Object.assign(new Error(`Requested output exceeds ${MAX_OUTPUT_PIXELS} pixels`), { status: 413 })
    }
  }

  async process({ operation, params, inputPath, maskPath, outputPath, signal }) {
    const capability = (await this.probe()).operations.find((candidate) => candidate.id === operation)
    if (!capability?.available) {
      throw Object.assign(new Error(capability?.unavailableReason || 'Image operation is unavailable'), {
        status: 409,
        code: 'IMAGE_OPERATION_UNAVAILABLE',
      })
    }
    const input = await this.dimensions(inputPath, signal)
    if (operation === 'remove-background') {
      const configuredModelPath = join(this.rembgAdapter.modelDirectory, modelFileForRembg(params.model))
      if (!(await isFile(configuredModelPath))) {
        throw Object.assign(new Error(`Configured rembg model ${params.model} is not available locally`), {
          status: 409,
          code: 'IMAGE_OPERATION_UNAVAILABLE',
        })
      }
      const args = this.rembgAdapter.type === 'python-api'
        ? [
            rembgRunnerPath,
            '--input', inputPath,
            '--output', outputPath,
            '--model', params.model,
            ...(params.alphaMatting ? [
              '--alpha-matting',
              '--foreground-threshold', String(params.foregroundThreshold),
              '--background-threshold', String(params.backgroundThreshold),
              '--erode-size', String(params.erodeSize),
            ] : []),
          ]
        : [
            'i',
            '-m', params.model,
            ...(params.alphaMatting ? [
              '-a',
              '-af', String(params.foregroundThreshold),
              '-ab', String(params.backgroundThreshold),
              '-ae', String(params.erodeSize),
            ] : []),
            inputPath,
            outputPath,
          ]
      await runCommand(this.rembgAdapter.command, args, {
        signal,
        timeoutMs: 10 * 60 * 1000,
        env: { U2NET_HOME: this.rembgAdapter.modelDirectory },
      })
    } else if (operation === 'upscale-realesrgan') {
      const width = Math.round(input.width * params.scale)
      const height = Math.round(input.height * params.scale)
      this.assertOutputSize(width, height)
      const args = [
        '-i', inputPath,
        '-o', outputPath,
        '-s', String(params.scale),
        '-n', params.model,
        '-m', this.realEsrganAdapter.modelDirectory,
        '-f', 'png',
      ]
      if (params.tileSize > 0) args.push('-t', String(params.tileSize))
      await runCommand(this.realEsrganAdapter.command, args, { signal, timeoutMs: 20 * 60 * 1000 })
    } else {
      await this.processWithFfmpeg(operation, params, input, inputPath, maskPath, outputPath, signal)
    }
    const output = await this.dimensions(outputPath, signal)
    this.assertOutputSize(output.width, output.height)
    const fileStats = await stat(outputPath)
    if (!fileStats.isFile() || fileStats.size < 32) throw new Error('Image processor did not produce a valid output file')
    return {
      width: output.width,
      height: output.height,
      mimeType: 'image/png',
      bytes: fileStats.size,
      provider: capability.provider,
    }
  }

  async processWithFfmpeg(operation, params, input, inputPath, maskPath, outputPath, signal) {
    const common = ['-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath]
    let args
    if (operation === 'upscale-lanczos') {
      const width = Math.round(input.width * params.scale)
      const height = Math.round(input.height * params.scale)
      this.assertOutputSize(width, height)
      const filter = `scale=${width}:${height}:flags=lanczos,unsharp=5:5:${params.sharpen}:5:5:0,format=rgba`
      args = [...common, '-frames:v', '1', '-vf', filter, '-compression_level', '6', outputPath]
    } else if (operation === 'sharpen') {
      const filter = `unsharp=${params.radius}:${params.radius}:${params.amount}:${params.radius}:${params.radius}:0,format=rgba`
      args = [...common, '-frames:v', '1', '-vf', filter, '-compression_level', '6', outputPath]
    } else if (operation === 'alpha-cleanup') {
      const expression = `if(lt(val\\,${params.transparentBelow})\\,0\\,if(gt(val\\,${params.opaqueAbove})\\,255\\,val))`
      args = [...common, '-frames:v', '1', '-vf', `format=rgba,lut=a=${expression}`, '-compression_level', '6', outputPath]
    } else if (operation === 'masked-adjust') {
      if (!maskPath || !(await isFile(maskPath))) {
        throw Object.assign(new Error('masked-adjust requires a managed local mask image'), {
          status: 400,
          code: 'IMAGE_MASK_REQUIRED',
        })
      }
      const maskBlur = params.feather > 0 ? `,gblur=sigma=${params.feather}` : ''
      const maskChain = `[1:v]scale=${input.width}:${input.height}:flags=bilinear,format=rgba,alphaextract${maskBlur}[mask]`
      let editChain
      if (params.effect === 'selection-highlight') {
        const brightness = (0.12 * params.strength).toFixed(4)
        const saturation = (1 + 0.65 * params.strength).toFixed(4)
        editChain = [
          '[0:v]format=rgba,split=2[base][edit]',
          `[edit]eq=brightness=${brightness}:saturation=${saturation}[changed]`,
          '[changed][mask]alphamerge[foreground]',
          '[base][foreground]overlay=shortest=1:format=auto,format=rgba[out]',
        ].join(';')
      } else if (params.effect === 'background-blur') {
        const sigma = (1 + 11 * params.strength).toFixed(3)
        editChain = [
          '[0:v]format=rgba,split=2[keep][background]',
          `[background]gblur=sigma=${sigma}[changed]`,
          '[keep][mask]alphamerge[foreground]',
          '[changed][foreground]overlay=shortest=1:format=auto,format=rgba[out]',
        ].join(';')
      } else {
        const brightness = (-0.24 * params.strength).toFixed(4)
        const saturation = Math.max(0, 1 - 0.78 * params.strength).toFixed(4)
        editChain = [
          '[0:v]format=rgba,split=2[keep][background]',
          `[background]eq=brightness=${brightness}:saturation=${saturation}[changed]`,
          '[keep][mask]alphamerge[foreground]',
          '[changed][foreground]overlay=shortest=1:format=auto,format=rgba[out]',
        ].join(';')
      }
      args = [
        ...common,
        '-i', maskPath,
        '-filter_complex', `${maskChain};${editChain}`,
        '-map', '[out]',
        '-frames:v', '1',
        '-compression_level', '6',
        outputPath,
      ]
    } else if (operation === 'pixelate') {
      const landscape = input.width >= input.height
      const pixelWidth = landscape
        ? params.targetSize
        : Math.max(1, Math.round(params.targetSize * input.width / input.height))
      const pixelHeight = landscape
        ? Math.max(1, Math.round(params.targetSize * input.height / input.width))
        : params.targetSize
      const width = pixelWidth * params.outputScale
      const height = pixelHeight * params.outputScale
      this.assertOutputSize(width, height)
      const dither = params.dither === 'none' ? '0' : params.dither
      const filter = [
        `[0:v]format=rgba,scale=${pixelWidth}:${pixelHeight}:flags=neighbor,split[pixels][paletteSource]`,
        `[paletteSource]palettegen=max_colors=${params.colors}:reserve_transparent=1:stats_mode=single[palette]`,
        `[pixels][palette]paletteuse=dither=${dither}:bayer_scale=2:alpha_threshold=${params.alphaThreshold},scale=${width}:${height}:flags=neighbor,format=rgba[out]`,
      ].join(';')
      args = [...common, '-filter_complex', filter, '-map', '[out]', '-frames:v', '1', '-compression_level', '6', outputPath]
    } else {
      throw Object.assign(new Error('Unsupported FFmpeg image operation'), { status: 400 })
    }
    await runCommand(this.ffmpegPath, args, { signal, timeoutMs: 10 * 60 * 1000 })
  }
}
