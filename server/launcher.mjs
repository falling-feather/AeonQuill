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
    MIAOHUI_PORT: bridgePort,
    MIAOHUI_RUNTIME_DIR: process.env.MIAOHUI_RUNTIME_DIR,
    MIAOHUI_CONFIG: process.env.MIAOHUI_CONFIG,
    MIAOHUI_HOST: process.env.MIAOHUI_HOST,
    MIAOHUI_ALLOWED_ORIGINS: process.env.MIAOHUI_ALLOWED_ORIGINS,
    MIAOHUI_COMFY_POLICY: process.env.MIAOHUI_COMFY_POLICY,
    MIAOHUI_COMFY_IDLE_SECONDS: process.env.MIAOHUI_COMFY_IDLE_SECONDS,
  }),
})

console.log(`MiaoHui app: http://127.0.0.1:${bridgePort}`)
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
