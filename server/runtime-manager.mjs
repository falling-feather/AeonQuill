import { openSync } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { dataDirectory, logDirectory, runtimeDirectory } from './runtime-paths.mjs'
import { normalizeLoopbackComfyUrl, readLocalConfigFile } from './runtime-settings.mjs'
import { createRestrictedChildEnvironment, redactSensitiveText } from './security.mjs'
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000
const START_TIMEOUT_MS = 4 * 60 * 1000

async function fileExists(pathname) {
  if (!pathname) return false
  try {
    return (await stat(pathname)).isFile()
  } catch {
    return false
  }
}

function normalizePolicy(value) {
  return ['persistent', 'idle', 'manual'].includes(value) ? value : 'idle'
}

function normalizeIdleTimeout(value) {
  const seconds = Number(value)
  if (!Number.isFinite(seconds)) return DEFAULT_IDLE_TIMEOUT_MS
  return Math.max(30, Math.min(60 * 60, Math.round(seconds))) * 1000
}

export async function loadLocalRuntimeConfig() {
  await mkdir(runtimeDirectory, { recursive: true })
  let config = {}
  let configReadError
  try {
    config = await readLocalConfigFile()
  } catch (error) {
    configReadError = {
      code: error.code || 'INVALID_LOCAL_CONFIG',
      message: error.message || '本机配置无法读取',
    }
  }
  let comfyUrl = 'http://127.0.0.1:8188'
  try {
    comfyUrl = normalizeLoopbackComfyUrl(process.env.COMFY_URL || config.comfyUrl || comfyUrl)
  } catch (error) {
    configReadError = {
      code: error.code || 'INVALID_COMFY_URL',
      message: error.message || 'ComfyUI 地址无效',
    }
  }
  const imageTools = config.imageTools && typeof config.imageTools === 'object' ? config.imageTools : {}
  return {
    comfyUrl,
    comfyRoot: typeof (process.env.COMFY_ROOT || config.comfyRoot) === 'string'
      ? process.env.COMFY_ROOT || config.comfyRoot
      : undefined,
    pythonPath: typeof (process.env.AEONQUILL_COMFY_PYTHON || process.env.COMFY_PYTHON || config.pythonPath) === 'string'
      ? process.env.AEONQUILL_COMFY_PYTHON || process.env.COMFY_PYTHON || config.pythonPath
      : undefined,
    bridgePort: Number(process.env.AEONQUILL_PORT || process.env.MIAOHUI_PORT || config.bridgePort || 8787),
    allowedOrigins: [
      ...(Array.isArray(config.allowedOrigins) ? config.allowedOrigins : []),
      ...String(process.env.AEONQUILL_ALLOWED_ORIGINS || process.env.MIAOHUI_ALLOWED_ORIGINS || '').split(','),
    ].map((value) => String(value).trim()).filter(Boolean),
    launchPolicy: normalizePolicy(
      process.env.AEONQUILL_COMFY_POLICY || process.env.MIAOHUI_COMFY_POLICY || config.comfyLaunchPolicy,
    ),
    idleTimeoutMs: normalizeIdleTimeout(
      process.env.AEONQUILL_COMFY_IDLE_SECONDS
        || process.env.MIAOHUI_COMFY_IDLE_SECONDS
        || config.comfyIdleSeconds,
    ),
    imageTools: {
      ffmpegPath: process.env.FFMPEG_PATH || imageTools.ffmpegPath || 'ffmpeg',
      ffprobePath: process.env.FFPROBE_PATH || imageTools.ffprobePath,
      rembgPath: process.env.AEONQUILL_REMBG_PATH || process.env.MIAOHUI_REMBG_PATH || imageTools.rembgPath,
      rembgModelsPath: process.env.AEONQUILL_REMBG_MODELS
        || process.env.MIAOHUI_REMBG_MODELS
        || imageTools.rembgModelsPath
        || join(dataDirectory, 'models', 'rembg'),
      realEsrganPath: process.env.AEONQUILL_REALESRGAN_PATH
        || process.env.MIAOHUI_REALESRGAN_PATH
        || imageTools.realEsrganPath
        || join(
          dataDirectory,
          'tools',
          'realesrgan-ncnn-vulkan',
          process.platform === 'win32' ? 'realesrgan-ncnn-vulkan.exe' : 'realesrgan-ncnn-vulkan',
        ),
      realEsrganModelsPath: process.env.AEONQUILL_REALESRGAN_MODELS
        || process.env.MIAOHUI_REALESRGAN_MODELS
        || imageTools.realEsrganModelsPath
        || join(dataDirectory, 'models', 'realesrgan-ncnn-vulkan'),
    },
    comfyArgs: Array.isArray(config.comfyArgs) && config.comfyArgs.length
      ? config.comfyArgs
      : [
          'main.py',
          '--listen', '127.0.0.1',
          '--port', '8188',
          '--fast-disk',
          '--lowvram',
          '--reserve-vram', '1.5',
          '--disable-pinned-memory',
          '--cache-none',
          '--preview-method', 'none',
        ],
    configReadError,
  }
}

export class ComfyRuntimeManager {
  constructor(config) {
    this.config = config
    this.process = null
    this.owned = false
    this.state = 'stopped'
    this.startedAt = null
    this.idleShutdownAt = null
    this.lastError = null
    this.startPromise = null
    this.idleTimer = null
    this.listeners = new Set()
  }

  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit() {
    const status = this.status()
    for (const listener of this.listeners) listener(status)
  }

  status() {
    return {
      policy: this.config.launchPolicy,
      state: this.state,
      owned: this.owned,
      canAutoStop: this.owned,
      idleTimeoutMs: this.config.idleTimeoutMs,
      idleShutdownAt: this.idleShutdownAt,
      startedAt: this.startedAt,
      lastError: this.lastError,
    }
  }

  async hardwareHint() {
    const psScript = '$g=Get-CimInstance Win32_VideoController | Where-Object {$_.Name -match "NVIDIA"} | Select-Object -First 1; if($g){[pscustomobject]@{name=$g.Name;adapterRam=$g.AdapterRAM}|ConvertTo-Json -Compress}'
    return new Promise((resolve) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-Command', psScript], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: createRestrictedChildEnvironment(),
      })
      let stdout = ''
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.once('error', () => resolve(null))
      child.once('exit', () => {
        try {
          const parsed = JSON.parse(stdout.trim())
          const name = String(parsed.name || '')
          const match = /RTX\s*(\d{4})/i.exec(name)
          const knownVramGb = match && /^40(60|50)$/.test(match[1]) ? 8 : undefined
          resolve({ name, vramTotal: knownVramGb ? knownVramGb * 1024 ** 3 : Number(parsed.adapterRam || 0) })
        } catch {
          resolve(null)
        }
      })
    })
  }

  async isReady(timeoutMs = 2_000) {
    try {
      const response = await fetch(`${this.config.comfyUrl}/system_stats`, {
        signal: AbortSignal.timeout(timeoutMs),
      })
      return response.ok
    } catch {
      return false
    }
  }

  clearIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    this.idleShutdownAt = null
  }

  async refreshOwnership() {
    if (this.process && this.process.exitCode === null) {
      this.state = await this.isReady() ? 'ready' : this.state
      return
    }
    this.process = null
    this.owned = false
    this.state = await this.isReady() ? 'external' : 'stopped'
  }

  async waitUntilReady(timeoutMs = START_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.process?.exitCode !== null) {
        throw new Error(`ComfyUI exited with code ${this.process?.exitCode}`)
      }
      if (await this.isReady()) return
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
    throw new Error('ComfyUI did not become ready within four minutes')
  }

  async ensureReady({ reason = 'video-job' } = {}) {
    this.clearIdleTimer()
    if (await this.isReady()) {
      this.state = this.owned ? 'ready' : 'external'
      this.emit()
      return this.status()
    }
    if (this.config.launchPolicy === 'manual') {
      throw new Error('ComfyUI 当前处于手动模式，请先启动本机 ComfyUI')
    }
    if (this.startPromise) return this.startPromise
    this.startPromise = this.start(reason).finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  async start(reason) {
    const { pythonPath, comfyRoot, comfyArgs } = this.config
    if (!(await fileExists(pythonPath)) || !(await fileExists(join(comfyRoot || '', 'main.py')))) {
      throw new Error('ComfyUI 本机路径未配置，无法按需启动')
    }
    await mkdir(logDirectory, { recursive: true })
    const logPath = join(logDirectory, 'comfyui.log')
    const logHandle = openSync(logPath, 'a')
    this.state = 'starting'
    this.startedAt = Date.now()
    this.lastError = null
    this.emit()
    this.process = spawn(pythonPath, comfyArgs, {
      cwd: comfyRoot,
      windowsHide: true,
      stdio: ['ignore', logHandle, logHandle],
      env: createRestrictedChildEnvironment({
        U2NET_HOME: this.config.imageTools?.rembgModelsPath,
      }),
    })
    this.owned = true
    this.process.once('exit', (code) => {
      this.process = null
      this.owned = false
      this.clearIdleTimer()
      this.state = 'stopped'
      if (code && code !== 0) this.lastError = `ComfyUI exited with code ${code}`
      this.emit()
    })
    try {
      await this.waitUntilReady()
      this.state = 'ready'
      this.emit()
      return this.status()
    } catch (error) {
      this.lastError = redactSensitiveText(`${reason}: ${error.message}`)
      this.process?.kill('SIGTERM')
      this.state = 'error'
      this.emit()
      throw error
    }
  }

  async scheduleIdleStop(isIdle) {
    this.clearIdleTimer()
    if (this.config.launchPolicy !== 'idle' || !this.owned || !this.process) return false
    if (!(await isIdle())) return false
    this.idleShutdownAt = Date.now() + this.config.idleTimeoutMs
    this.idleTimer = setTimeout(async () => {
      this.idleTimer = null
      this.idleShutdownAt = null
      try {
        if (await isIdle()) await this.stop('idle')
      } catch (error) {
        this.lastError = redactSensitiveText(error.message)
        this.emit()
      }
    }, this.config.idleTimeoutMs)
    this.idleTimer.unref?.()
    this.emit()
    return true
  }

  async setPolicy(policy, idleSeconds) {
    this.config.launchPolicy = normalizePolicy(policy)
    if (idleSeconds !== undefined) this.config.idleTimeoutMs = normalizeIdleTimeout(idleSeconds)
    this.clearIdleTimer()
    this.emit()
    return this.status()
  }

  async stop(reason = 'manual') {
    this.clearIdleTimer()
    if (!this.owned || !this.process) {
      if (await this.isReady()) throw new Error('当前 ComfyUI 不是由光阴砚启动，不能自动关闭')
      this.state = 'stopped'
      this.emit()
      return false
    }
    this.state = 'stopping'
    this.emit()
    const child = this.process
    if (process.platform === 'win32') {
      await new Promise((resolvePromise) => {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T'], {
          windowsHide: true,
          stdio: 'ignore',
        })
        killer.once('error', () => {
          child.kill('SIGTERM')
          resolvePromise()
        })
        killer.once('exit', () => resolvePromise())
      })
    } else {
      child.kill('SIGTERM')
    }
    const exited = await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve(true)
      const timer = setTimeout(() => resolve(false), 8_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
    if (!exited && child.exitCode === null) {
      if (process.platform === 'win32') {
        await new Promise((resolvePromise) => {
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          })
          killer.once('error', () => {
            child.kill('SIGKILL')
            resolvePromise()
          })
          killer.once('exit', () => resolvePromise())
        })
      } else {
        child.kill('SIGKILL')
      }
    }
    this.process = null
    this.owned = false
    this.state = 'stopped'
    this.lastError = reason === 'idle' ? null : this.lastError
    this.emit()
    return true
  }

  async dispose() {
    this.clearIdleTimer()
    if (this.owned) await this.stop('bridge-shutdown')
  }
}
