import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const qaTemporaryRoot = resolve(process.env.AEONQUILL_QA_TEMP_ROOT || join(projectRoot, '.runtime', 'qa-temp'))

function cookieFromResponse(response) {
  return String(response.headers.get('set-cookie') || '').split(';', 1)[0]
}

function delay(duration) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, duration))
}

async function availablePort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer()
    server.unref()
    server.once('error', rejectPromise)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : null
      server.close((error) => error ? rejectPromise(error) : resolvePromise(port))
    })
  })
}

async function terminateProcessTree(child) {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32') {
    await new Promise((resolvePromise) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
      killer.once('error', () => {
        child.kill()
        resolvePromise()
      })
      killer.once('exit', () => resolvePromise())
    })
    return
  }
  child.kill('SIGTERM')
  await Promise.race([
    new Promise((resolvePromise) => child.once('exit', resolvePromise)),
    delay(3_000),
  ])
  if (child.exitCode === null) child.kill('SIGKILL')
}

function assertSafeTemporaryDirectory(directory, prefix) {
  const tempRoot = `${qaTemporaryRoot}${process.platform === 'win32' ? '\\' : '/'}`.toLowerCase()
  const target = resolve(directory).toLowerCase()
  if (!target.startsWith(tempRoot) || !basename(directory).startsWith(prefix)) {
    throw new Error(`Refusing to clean unexpected QA directory: ${directory}`)
  }
}

export async function startIsolatedBridge(label = 'qa', options = {}) {
  const prefix = `miaohui-${label}-`
  await mkdir(qaTemporaryRoot, { recursive: true })
  const runtimeDirectory = await mkdtemp(join(qaTemporaryRoot, prefix))
  const port = await availablePort()
  const unavailableComfyPort = await availablePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const stdout = []
  const stderr = []
  const suppliedEnvironment = options.environment ?? {}
  const isolatedRuntime = suppliedEnvironment.AEONQUILL_RUNTIME_DIR ?? suppliedEnvironment.MIAOHUI_RUNTIME_DIR ?? runtimeDirectory
  const isolatedData = suppliedEnvironment.AEONQUILL_DATA_DIR ?? suppliedEnvironment.MIAOHUI_DATA_DIR ?? isolatedRuntime
  const isolatedConfig = suppliedEnvironment.AEONQUILL_CONFIG ?? suppliedEnvironment.MIAOHUI_CONFIG ?? join(runtimeDirectory, 'no-local-config.json')
  const isolatedComfyPolicy = suppliedEnvironment.AEONQUILL_COMFY_POLICY ?? suppliedEnvironment.MIAOHUI_COMFY_POLICY ?? options.comfyPolicy ?? 'manual'
  const bridgeEnvironment = {
    ...process.env,
    AEONQUILL_RUNTIME_DIR: isolatedRuntime,
    MIAOHUI_RUNTIME_DIR: isolatedRuntime,
    AEONQUILL_DATA_DIR: isolatedData,
    MIAOHUI_DATA_DIR: isolatedData,
    AEONQUILL_CACHE_DIR: join(runtimeDirectory, 'cache'),
    AEONQUILL_LOG_DIR: join(runtimeDirectory, 'logs'),
    AEONQUILL_DEFAULT_OUTPUT_DIR: join(runtimeDirectory, 'output'),
    MIAOHUI_CONFIG: isolatedConfig,
    AEONQUILL_CONFIG: isolatedConfig,
    MIAOHUI_PORT: String(port),
    MIAOHUI_HOST: '127.0.0.1',
    AEONQUILL_PORT: String(port),
    AEONQUILL_HOST: '127.0.0.1',
    AEONQUILL_COMFY_POLICY: isolatedComfyPolicy,
    MIAOHUI_COMFY_POLICY: isolatedComfyPolicy,
    COMFY_URL: options.comfyUrl || `http://127.0.0.1:${unavailableComfyPort}`,
    ...(options.environment || {}),
  }
  let child
  let sessionCookie = ''
  let stopped = false

  const spawnBridge = () => {
    child = spawn(options.executablePath || process.execPath, options.executablePath ? [] : ['server/index.mjs'], {
      cwd: projectRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: bridgeEnvironment,
    })
    child.stdout.on('data', (chunk) => stdout.push(String(chunk)))
    child.stderr.on('data', (chunk) => stderr.push(String(chunk)))
  }

  const waitUntilReady = async () => {
    const candidate = child
    const deadline = Date.now() + 20_000
    let lastError
    while (Date.now() < deadline && candidate === child && candidate?.exitCode === null) {
      try {
        const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) })
        if (response.ok) {
          const nextCookie = cookieFromResponse(response)
          if (!nextCookie) throw new Error('Isolated bridge did not issue a session cookie')
          sessionCookie = nextCookie
          return
        }
      } catch (error) {
        lastError = error
      }
      await delay(150)
    }
    throw new Error([
      `Isolated bridge did not become ready: ${lastError?.message || `exit ${candidate?.exitCode}`}`,
      stdout.join('').trim(),
      stderr.join('').trim(),
    ].filter(Boolean).join('\n'))
  }

  try {
    spawnBridge()
    await waitUntilReady()
  } catch (error) {
    await terminateProcessTree(child)
    assertSafeTemporaryDirectory(runtimeDirectory, prefix)
    await rm(runtimeDirectory, { recursive: true, force: true })
    throw error
  }

  return {
    baseUrl,
    port,
    runtimeDirectory,
    get sessionCookie() {
      return sessionCookie
    },
    request(pathname, options = {}) {
      return fetch(`${baseUrl}${pathname}`, {
        ...options,
        headers: { cookie: sessionCookie, ...options.headers },
      })
    },
    logs: () => ({ stdout: stdout.join('').trim(), stderr: stderr.join('').trim() }),
    async restart() {
      if (stopped) throw new Error('Cannot restart a stopped isolated bridge')
      await terminateProcessTree(child)
      await delay(150)
      spawnBridge()
      await waitUntilReady()
    },
    async stop({ keepRuntime = false } = {}) {
      if (stopped) return
      stopped = true
      await terminateProcessTree(child)
      if (!keepRuntime) {
        assertSafeTemporaryDirectory(runtimeDirectory, prefix)
        await rm(runtimeDirectory, { recursive: true, force: true })
      }
    },
  }
}
