import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadLocalRuntimeConfig } from './runtime-manager.mjs'
import { createRestrictedChildEnvironment } from './security.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const config = await loadLocalRuntimeConfig()
const comfyUrl = config.comfyUrl
const bridgePort = String(config.bridgePort)
let bridgeProcess = null

bridgeProcess = spawn(process.execPath, ['server/index.mjs'], {
  cwd: projectRoot,
  windowsHide: true,
  stdio: 'inherit',
  env: createRestrictedChildEnvironment({
    COMFY_URL: comfyUrl,
    AEONQUILL_COMFY_ROOT: process.env.AEONQUILL_COMFY_ROOT,
    AEONQUILL_COMFY_PYTHON: process.env.AEONQUILL_COMFY_PYTHON,
    COMFY_ROOT: process.env.COMFY_ROOT,
    COMFY_PYTHON: process.env.COMFY_PYTHON,
    FFMPEG_PATH: process.env.FFMPEG_PATH,
    FFPROBE_PATH: process.env.FFPROBE_PATH,
    AEONQUILL_PORT: bridgePort,
    AEONQUILL_RUNTIME_DIR: process.env.AEONQUILL_RUNTIME_DIR || process.env.MIAOHUI_RUNTIME_DIR,
    AEONQUILL_DATA_DIR: process.env.AEONQUILL_DATA_DIR || process.env.MIAOHUI_DATA_DIR,
    AEONQUILL_CACHE_DIR: process.env.AEONQUILL_CACHE_DIR || process.env.MIAOHUI_CACHE_DIR,
    AEONQUILL_LOG_DIR: process.env.AEONQUILL_LOG_DIR || process.env.MIAOHUI_LOG_DIR,
    AEONQUILL_CONFIG: process.env.AEONQUILL_CONFIG || process.env.MIAOHUI_CONFIG,
    AEONQUILL_HOST: process.env.AEONQUILL_HOST || process.env.MIAOHUI_HOST,
    AEONQUILL_ALLOWED_ORIGINS: process.env.AEONQUILL_ALLOWED_ORIGINS || process.env.MIAOHUI_ALLOWED_ORIGINS,
    AEONQUILL_COMFY_POLICY: process.env.AEONQUILL_COMFY_POLICY || process.env.MIAOHUI_COMFY_POLICY,
    AEONQUILL_COMFY_IDLE_SECONDS:
      process.env.AEONQUILL_COMFY_IDLE_SECONDS || process.env.MIAOHUI_COMFY_IDLE_SECONDS,
    AEONQUILL_IMAGE_CONCURRENCY:
      process.env.AEONQUILL_IMAGE_CONCURRENCY || process.env.MIAOHUI_IMAGE_CONCURRENCY,
    AEONQUILL_REMBG_PATH: process.env.AEONQUILL_REMBG_PATH || process.env.MIAOHUI_REMBG_PATH,
    AEONQUILL_REMBG_MODELS: process.env.AEONQUILL_REMBG_MODELS || process.env.MIAOHUI_REMBG_MODELS,
    AEONQUILL_REALESRGAN_PATH:
      process.env.AEONQUILL_REALESRGAN_PATH || process.env.MIAOHUI_REALESRGAN_PATH,
    AEONQUILL_REALESRGAN_MODELS:
      process.env.AEONQUILL_REALESRGAN_MODELS || process.env.MIAOHUI_REALESRGAN_MODELS,
    MIAOHUI_PORT: bridgePort,
    MIAOHUI_RUNTIME_DIR: process.env.AEONQUILL_RUNTIME_DIR || process.env.MIAOHUI_RUNTIME_DIR,
    MIAOHUI_DATA_DIR: process.env.AEONQUILL_DATA_DIR || process.env.MIAOHUI_DATA_DIR,
    MIAOHUI_CACHE_DIR: process.env.AEONQUILL_CACHE_DIR || process.env.MIAOHUI_CACHE_DIR,
    MIAOHUI_LOG_DIR: process.env.AEONQUILL_LOG_DIR || process.env.MIAOHUI_LOG_DIR,
    MIAOHUI_CONFIG: process.env.AEONQUILL_CONFIG || process.env.MIAOHUI_CONFIG,
    MIAOHUI_HOST: process.env.AEONQUILL_HOST || process.env.MIAOHUI_HOST,
    MIAOHUI_ALLOWED_ORIGINS: process.env.AEONQUILL_ALLOWED_ORIGINS || process.env.MIAOHUI_ALLOWED_ORIGINS,
    MIAOHUI_COMFY_POLICY: process.env.AEONQUILL_COMFY_POLICY || process.env.MIAOHUI_COMFY_POLICY,
    MIAOHUI_COMFY_IDLE_SECONDS:
      process.env.AEONQUILL_COMFY_IDLE_SECONDS || process.env.MIAOHUI_COMFY_IDLE_SECONDS,
    MIAOHUI_IMAGE_CONCURRENCY:
      process.env.AEONQUILL_IMAGE_CONCURRENCY || process.env.MIAOHUI_IMAGE_CONCURRENCY,
    MIAOHUI_REMBG_PATH: process.env.AEONQUILL_REMBG_PATH || process.env.MIAOHUI_REMBG_PATH,
    MIAOHUI_REMBG_MODELS: process.env.AEONQUILL_REMBG_MODELS || process.env.MIAOHUI_REMBG_MODELS,
    MIAOHUI_REALESRGAN_PATH:
      process.env.AEONQUILL_REALESRGAN_PATH || process.env.MIAOHUI_REALESRGAN_PATH,
    MIAOHUI_REALESRGAN_MODELS:
      process.env.AEONQUILL_REALESRGAN_MODELS || process.env.MIAOHUI_REALESRGAN_MODELS,
  }),
})

console.log(`AEONQUILL app: http://127.0.0.1:${bridgePort}`)
console.log(`ComfyUI policy: ${config.launchPolicy}`)

let shuttingDown = false
function shutdown(signal = 'SIGTERM') {
  if (shuttingDown) return
  shuttingDown = true
  bridgeProcess?.kill(signal)
  setTimeout(() => process.exit(0), 2_000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
bridgeProcess.on('exit', (code) => {
  if (!shuttingDown) {
    process.exitCode = code ?? 1
  }
})
