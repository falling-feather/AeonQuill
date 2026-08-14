import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import {
  buildRuntimeDiagnostics,
  discoverComfyInstallation,
  persistRuntimeSettings,
  safePathLabel,
  validateRuntimeSettingsPayload,
} from '../server/runtime-settings.mjs'
import { resolveDataDirectory } from '../server/runtime-paths.mjs'

async function withTempDirectory(run) {
  const root = await mkdtemp(join(tmpdir(), 'aeonquill-runtime-settings-'))
  const resolved = resolve(root)
  assert.equal(resolved.startsWith(resolve(tmpdir())), true)
  try {
    await run(root)
  } finally {
    await rm(resolved, { recursive: true, force: true })
  }
}

test('runtime settings only accept strict loopback configuration and known fields', async () => {
  await assert.rejects(() => validateRuntimeSettingsPayload({ mode: 'manual', token: 'secret' }), {
    code: 'UNKNOWN_RUNTIME_SETTING',
  })
  await assert.rejects(() => validateRuntimeSettingsPayload({
    mode: 'manual',
    comfyUrl: 'http://example.com:8188',
  }), { code: 'INVALID_COMFY_URL' })
  await assert.rejects(() => validateRuntimeSettingsPayload({
    mode: 'manual',
    comfyUrl: 'http://127.0.0.1:80',
  }), { code: 'INVALID_COMFY_URL' })

  assert.deepEqual(await validateRuntimeSettingsPayload({
    mode: 'manual',
    comfyUrl: 'http://localhost:8188',
    comfyLaunchPolicy: 'idle',
    comfyIdleSeconds: 180,
  }), {
    comfyUrl: 'http://localhost:8188',
    comfyLaunchPolicy: 'idle',
    comfyIdleSeconds: 180,
  })

  assert.equal((await validateRuntimeSettingsPayload({
    mode: 'manual',
    comfyUrl: 'http://[::1]:8188',
  })).comfyUrl, 'http://[::1]:8188')

  if (process.platform === 'win32') {
    await assert.rejects(() => validateRuntimeSettingsPayload({
      mode: 'manual',
      comfyRoot: '\\\\server\\share\\ComfyUI',
      pythonPath: '\\\\server\\share\\python.exe',
    }), { code: 'INVALID_LOCAL_PATH' })
  }
})

test('runtime discovery accepts an explicit complete ComfyUI fixture only', async () => {
  await withTempDirectory(async (root) => {
    const incomplete = join(root, 'incomplete')
    const comfyRoot = join(root, 'ComfyUI')
    const pythonPath = join(comfyRoot, '.venv', 'Scripts', 'python.exe')
    await mkdir(incomplete, { recursive: true })
    await mkdir(dirname(pythonPath), { recursive: true })
    await writeFile(join(comfyRoot, 'main.py'), '# fixture\n', 'utf8')
    await writeFile(pythonPath, 'fixture', 'utf8')

    await assert.rejects(() => validateRuntimeSettingsPayload({
      mode: 'manual',
      comfyRoot,
    }), { code: 'INCOMPLETE_COMFY_CONFIGURATION' })

    assert.deepEqual(await discoverComfyInstallation({ roots: [incomplete, comfyRoot] }), {
      comfyRoot: resolve(comfyRoot),
      pythonPath: resolve(pythonPath),
    })
  })
})

test('runtime discovery supports portable launchers with a sibling python directory', async () => {
  await withTempDirectory(async (root) => {
    const packageRoot = join(root, 'ComfyUI-aki-v2')
    const comfyRoot = join(packageRoot, 'ComfyUI')
    const pythonPath = join(packageRoot, 'python', 'python.exe')
    await mkdir(dirname(pythonPath), { recursive: true })
    await mkdir(comfyRoot, { recursive: true })
    await writeFile(join(comfyRoot, 'main.py'), '# fixture\n', 'utf8')
    await writeFile(pythonPath, 'fixture', 'utf8')
    assert.deepEqual(await discoverComfyInstallation({ roots: [comfyRoot] }), {
      comfyRoot: resolve(comfyRoot),
      pythonPath: resolve(pythonPath),
    })
  })
})

test('runtime config persists atomically while preserving unrelated local tool settings', async () => {
  await withTempDirectory(async (root) => {
    const configPath = join(root, 'config', 'local.json')
    await mkdir(dirname(configPath), { recursive: true })
    await writeFile(configPath, JSON.stringify({ imageTools: { ffmpegPath: 'ffmpeg' } }), 'utf8')
    const result = await persistRuntimeSettings({
      mode: 'manual',
      comfyUrl: 'http://127.0.0.1:8288',
      comfyLaunchPolicy: 'manual',
      comfyIdleSeconds: 240,
    }, configPath)
    const stored = JSON.parse(await readFile(configPath, 'utf8'))
    assert.deepEqual(stored.imageTools, { ffmpegPath: 'ffmpeg' })
    assert.equal(stored.schemaVersion, 1)
    assert.equal(stored.comfyUrl, 'http://127.0.0.1:8288')
    assert.equal(result.patch.comfyLaunchPolicy, 'manual')
    assert.deepEqual(await readdir(dirname(configPath)), ['local.json'])
  })
})

test('data directory keeps legacy durable state visible until an explicit migration exists', async () => {
  await withTempDirectory(async (root) => {
    const runtimeRoot = join(root, 'runtime')
    const configuredDirectory = join(root, 'data')
    await mkdir(runtimeRoot, { recursive: true })
    assert.equal(resolveDataDirectory({ configuredDirectory, runtimeRoot }), resolve(configuredDirectory))

    await writeFile(join(runtimeRoot, 'jobs.json'), '[]\n', 'utf8')
    assert.equal(resolveDataDirectory({ configuredDirectory, runtimeRoot }), resolve(runtimeRoot))

    await mkdir(configuredDirectory, { recursive: true })
    await writeFile(join(configuredDirectory, 'jobs.json'), '[]\n', 'utf8')
    assert.equal(resolveDataDirectory({ configuredDirectory, runtimeRoot }), resolve(configuredDirectory))
  })
})

test('runtime config recovery backs up invalid JSON before writing a valid replacement', async () => {
  await withTempDirectory(async (root) => {
    const configPath = join(root, 'config', 'local.json')
    await mkdir(dirname(configPath), { recursive: true })
    await writeFile(configPath, '{invalid-json', 'utf8')
    const result = await persistRuntimeSettings({
      mode: 'manual',
      comfyLaunchPolicy: 'idle',
      comfyIdleSeconds: 300,
    }, configPath)
    assert.equal(result.recoveredInvalidConfig, true)
    assert.equal(JSON.parse(await readFile(configPath, 'utf8')).comfyLaunchPolicy, 'idle')
    const entries = await readdir(dirname(configPath))
    const backup = entries.find((entry) => /^local\.invalid-\d+\.json$/u.test(entry))
    assert.ok(backup)
    assert.equal(await readFile(join(dirname(configPath), backup), 'utf8'), '{invalid-json')
  })
})

test('safe path labels identify a location without echoing the absolute private path', () => {
  const privatePath = process.platform === 'win32'
    ? 'C:\\Users\\private-person\\ComfyUI\\main.py'
    : '/home/private-person/ComfyUI/main.py'
  const label = safePathLabel(privatePath)
  assert.equal(label.includes(privatePath), false)
  assert.equal(label.includes('private-person'), false)
  assert.equal(label.endsWith(basename(privatePath)), true)
})

test('runtime diagnostics ignore untrusted stored values after configuration validation fails', async () => {
  const diagnostics = await buildRuntimeDiagnostics({
    activeConfig: {
      comfyUrl: 'http://127.0.0.1:8188',
      launchPolicy: 'idle',
      idleTimeoutMs: 300_000,
    },
    persistedConfig: {
      comfyUrl: 'http://example.com:8188',
      comfyRoot: 'C:\\Users\\private-person\\ComfyUI',
      pythonPath: 'C:\\Users\\private-person\\python.exe',
    },
    runtime: { connected: false },
    imageManifest: { operations: [] },
    semanticManifest: { workflows: [] },
    configError: { code: 'INVALID_COMFY_URL', message: 'invalid fixture' },
  })

  assert.equal(diagnostics.configuration.fileValid, false)
  assert.equal(diagnostics.configuration.comfyUrl, 'http://127.0.0.1:8188')
  assert.equal(diagnostics.configuration.rootConfigured, false)
  assert.equal(diagnostics.configuration.pythonConfigured, false)
  assert.equal(diagnostics.configuration.rootLabel, undefined)
  assert.equal(diagnostics.issues.some((issue) => issue.code === 'LOCAL_CONFIG_INVALID'), true)
})
