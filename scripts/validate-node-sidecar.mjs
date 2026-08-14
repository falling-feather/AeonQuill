import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { waitForBridgeClosed, waitForBridgeReady } from '../desktop/shared/bridge-contract.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const sidecarPath = join(
  projectRoot,
  'desktop',
  'tauri',
  'src-tauri',
  'binaries',
  'miaohui-bridge-x86_64-pc-windows-msvc.exe',
)
const finalReportPath = join(projectRoot, '.runtime', 'qa', 'node-sidecar-final.json')

async function availablePort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const reservation = createServer()
    reservation.unref()
    reservation.once('error', rejectPromise)
    reservation.listen(0, '127.0.0.1', () => {
      const address = reservation.address()
      const port = typeof address === 'object' && address ? address.port : null
      reservation.close((error) => error ? rejectPromise(error) : resolvePromise(port))
    })
  })
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise('timeout'), timeoutMs)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolvePromise(code)
    })
  })
}

async function sha256(pathname) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(pathname)) hash.update(chunk)
  return hash.digest('hex')
}

const sidecarStats = await stat(sidecarPath)
assert.ok(sidecarStats.isFile() && sidecarStats.size > 20 * 1024 * 1024, 'Packaged sidecar is missing or too small')

const runtimeDirectory = await mkdtemp(join(tmpdir(), 'miaohui-sidecar-qa-'))
const bridgePort = await availablePort()
const unavailableComfyPort = await availablePort()
const baseUrl = `http://127.0.0.1:${bridgePort}`
const stdout = []
const stderr = []
const startedAt = Date.now()
let child
try {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const systemOnlyPath = [
    join(systemRoot, 'System32'),
    systemRoot,
    join(systemRoot, 'System32', 'Wbem'),
    join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
  ].join(';')
  child = spawn(sidecarPath, [], {
    cwd: runtimeDirectory,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      APPDATA: process.env.APPDATA,
      USERPROFILE: process.env.USERPROFILE,
      PATH: systemOnlyPath,
      PATHEXT: process.env.PATHEXT,
      MIAOHUI_PORT: String(bridgePort),
      MIAOHUI_HOST: '127.0.0.1',
      MIAOHUI_RUNTIME_DIR: runtimeDirectory,
      MIAOHUI_CONFIG: join(runtimeDirectory, 'no-local-config.json'),
      MIAOHUI_COMFY_POLICY: 'manual',
      MIAOHUI_PARENT_CONTROL: 'stdio',
      COMFY_URL: `http://127.0.0.1:${unavailableComfyPort}`,
    },
  })
  child.stdout.on('data', (chunk) => stdout.push(String(chunk)))
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)))
  const earlyExit = { value: false }
  child.once('exit', () => { earlyExit.value = true })

  const health = await waitForBridgeReady({
    baseUrl,
    isProcessAlive: () => !earlyExit.value,
  })
  const readyMs = Date.now() - startedAt
  assert.equal(health.ok, true)
  const htmlResponse = await fetch(baseUrl, { redirect: 'error' })
  assert.equal(htmlResponse.status, 200)
  assert.match(htmlResponse.headers.get('content-security-policy') || '', /default-src 'self'/)
  const html = await htmlResponse.text()
  assert.match(html, /<div id="root"><\/div>/)

  child.stdin.write('shutdown\n')
  child.stdin.end()
  const exitCode = await waitForExit(child, 10_000)
  assert.equal(exitCode, 0, `Sidecar exit=${exitCode}\n${stderr.join('')}`)
  assert.equal(await waitForBridgeClosed({ baseUrl, timeoutMs: 2_000 }), true)

  const report = {
    schemaVersion: 1,
    status: 'passed',
    shellRole: 'tauri-node-sidecar',
    artifact: {
      filename: sidecarPath.split(/[\\/]/).pop(),
      bytes: sidecarStats.size,
      sha256: await sha256(sidecarPath),
      systemNodeRequired: false,
      launchPathScope: 'Windows system directories only',
    },
    lifecycle: {
      readyMs,
      exitCode,
      portClosed: true,
      parentControl: 'stdio',
    },
    health,
    validatedAt: new Date().toISOString(),
  }
  await mkdir(dirname(finalReportPath), { recursive: true })
  await writeFile(finalReportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(`✓ Self-contained Node sidecar ready in ${readyMs}ms with system-only PATH`)
  console.log(`✓ Parent shutdown returned exit 0; port ${bridgePort} is closed`)
  console.log(`✓ Artifact ${(sidecarStats.size / 1024 / 1024).toFixed(1)} MiB, SHA-256 ${report.artifact.sha256.slice(0, 12)}…`)
  console.log(`✓ Report: ${finalReportPath}`)
} catch (error) {
  if (child?.exitCode === null) child.kill()
  throw new Error([
    error.message,
    stdout.join('').trim(),
    stderr.join('').trim(),
  ].filter(Boolean).join('\n'))
} finally {
  if (child?.exitCode === null) child.kill()
  await rm(runtimeDirectory, { recursive: true, force: true })
}
