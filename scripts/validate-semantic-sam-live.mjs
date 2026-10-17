import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createProjectCatalog, createWorkspaceProject } from '../src/lib/project/projectCatalog.mjs'
import { ARTIFACTS } from '../server/workflow-artifacts.mjs'
import { discoverRuntimeRegistry, registeredArtifactCandidates } from '../server/runtime-registry.mjs'
import { startIsolatedBridge } from './qa-runtime.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const qaRoot = resolve(projectRoot, '.runtime', 'qa')
const sourcePath = resolve(projectRoot, 'src', 'assets', 'sample-summer-character.png')
const defaultConfigPath = resolve(projectRoot, 'config', 'local.json')

class SmokeBlockedError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'SmokeBlockedError'
    this.code = code
    this.details = details
  }
}

function option(name, fallback) {
  const prefix = `--${name}=`
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`)
}

function delay(duration) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, duration))
}

function help() {
  console.log([
    '真实 SAM 受管 smoke（只连接已运行的 external ComfyUI）',
    '',
    '用法：node scripts/validate-semantic-sam-live.mjs [选项]',
    '  --help                         显示帮助，不连接运行时',
    '  --config=<path>                配置文件，默认 config/local.json',
    '  --comfy-url=<url>              覆盖回环 ComfyUI 地址',
    '  --timeout-seconds=<n>          Job 超时，默认 900 秒，范围 60–3600',
    '  --multi-point                  使用六个正向点和一个排除点，与默认单点对照',
    '  --report=<path>                报告路径，必须位于 .runtime/qa 且以 semantic-sam-live- 开头',
    '',
    '运行前只读检查 /queue、/system_stats、/object_info；存在外部队列、缺节点、缺受管模型或 SHA 不符时停止。',
    '脚本不会启动、停止、free memory 或中断外部 ComfyUI。',
  ].join('\n'))
}

function assertSafeRunRoot(pathname) {
  const root = `${qaRoot}${sep}`.toLowerCase()
  const target = resolve(pathname).toLowerCase()
  if (!target.startsWith(root) || !basename(target).startsWith('semantic-sam-live-run-')) {
    throw new Error(`Refusing to clean unexpected SAM smoke directory: ${pathname}`)
  }
}

function assertSafeReportPath(pathname) {
  const target = resolve(pathname)
  const root = `${qaRoot}${sep}`
  if (!target.toLowerCase().startsWith(root.toLowerCase()) || !basename(target).startsWith('semantic-sam-live-')) {
    throw new Error(`Report must be a semantic-sam-live-* file under .runtime/qa: ${pathname}`)
  }
  return target
}

function parseTimeout(value) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 60 || parsed > 3_600) {
    throw new Error('--timeout-seconds must be an integer from 60 to 3600')
  }
  return parsed * 1_000
}

async function readJsonFile(pathname) {
  return JSON.parse(await readFile(pathname, 'utf8'))
}

async function hashFile(pathname) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(pathname)) hash.update(chunk)
  return hash.digest('hex')
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(15_000) })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const error = new Error(`${url} returned HTTP ${response.status}`)
    error.status = response.status
    error.body = body
    throw error
  }
  return body
}

async function externalSnapshot(comfyUrl) {
  const [stats, queue, objectInfo] = await Promise.all([
    fetchJson(`${comfyUrl}/system_stats`),
    fetchJson(`${comfyUrl}/queue`),
    fetchJson(`${comfyUrl}/object_info`),
  ])
  return { stats, queue, objectInfo }
}

function queueSummary(queue) {
  return {
    running: Array.isArray(queue?.queue_running) ? queue.queue_running.length : 0,
    pending: Array.isArray(queue?.queue_pending) ? queue.queue_pending.length : 0,
  }
}

function runtimeSummary(stats) {
  const device = stats?.devices?.[0]
  const total = Number(device?.vram_total || 0)
  const free = Number(device?.vram_free || 0)
  return {
    comfyVersion: stats?.system?.comfyui_version || 'unknown',
    pythonVersion: stats?.system?.python_version || 'unknown',
    pytorchVersion: stats?.system?.pytorch_version || 'unknown',
    device: device?.name || 'unknown',
    vramTotalBytes: total,
    vramFreeBytes: free,
    vramUsedBytes: total > 0 && free >= 0 ? Math.max(0, total - free) : null,
  }
}

async function sampleCpuPercent() {
  if (process.platform !== 'win32') return null
  return new Promise((resolvePromise) => {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-Command',
      '(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average',
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    let stdout = ''
    const timer = setTimeout(() => {
      child.kill()
      resolvePromise(null)
    }, 3_000)
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.once('error', () => {
      clearTimeout(timer)
      resolvePromise(null)
    })
    child.once('exit', () => {
      clearTimeout(timer)
      const value = Number(stdout.trim())
      resolvePromise(Number.isFinite(value) ? value : null)
    })
  })
}

async function sampleUsage(comfyUrl) {
  const [stats, cpuPercent] = await Promise.all([
    fetchJson(`${comfyUrl}/system_stats`),
    sampleCpuPercent(),
  ])
  return { at: Date.now(), cpuPercent, ...runtimeSummary(stats) }
}

async function inspectPngAlpha(pythonPath, pathname) {
  const code = [
    'from PIL import Image',
    'import json, sys',
    'image = Image.open(sys.argv[1]).convert("RGBA")',
    'alpha = [pixel[3] for pixel in image.getdata()]',
    'print(json.dumps({"width": image.width, "height": image.height, "pixels": len(alpha), "alphaMin": min(alpha), "alphaMax": max(alpha), "alphaZero": sum(value == 0 for value in alpha), "alphaOpaque": sum(value == 255 for value in alpha), "alphaPartial": sum(0 < value < 255 for value in alpha)}))',
  ].join('; ')
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(pythonPath, ['-c', code, pathname], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUTF8: '1' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', rejectPromise)
    child.once('exit', (code) => {
      if (code !== 0) return rejectPromise(new Error(`Pillow alpha inspection failed: ${stderr.trim() || code}`))
      try { resolvePromise(JSON.parse(stdout.trim())) } catch { rejectPromise(new Error('Pillow alpha inspection returned invalid JSON')) }
    })
  })
}

async function requestJson(bridge, pathname, options = {}, expected = 200) {
  const response = await bridge.request(pathname, {
    ...options,
    headers: { 'content-type': 'application/json', ...options.headers },
  })
  const body = await response.json().catch(() => null)
  assert.equal(response.status, expected, `${options.method || 'GET'} ${pathname}: ${JSON.stringify(body)}`)
  return body
}

async function waitForTerminal(bridge, jobId, comfyUrl, timeoutMs, samples) {
  const deadline = Date.now() + timeoutMs
  let lastJob
  while (Date.now() < deadline) {
    const [snapshot, usage] = await Promise.all([
      requestJson(bridge, `/api/jobs/${encodeURIComponent(jobId)}`),
      sampleUsage(comfyUrl),
    ])
    lastJob = snapshot.job
    samples.push(usage)
    if (['completed', 'failed', 'cancelled'].includes(lastJob.status) && lastJob.scheduling?.finishedAt) return lastJob
    await delay(1_000)
  }
  throw Object.assign(new Error(`SAM Job timed out: ${jobId}`), { code: 'SEMANTIC_SAM_SMOKE_TIMEOUT', lastJob })
}

async function waitForExternalQueueIdle(comfyUrl, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = queueSummary(await fetchJson(`${comfyUrl}/queue`))
    if (!last.running && !last.pending) return last
    await delay(500)
  }
  return last
}

async function main() {
  if (hasFlag('help')) {
    help()
    return
  }

  const configPath = resolve(option('config', defaultConfigPath))
  const timeoutMs = parseTimeout(option('timeout-seconds', '900'))
  const reportPath = assertSafeReportPath(resolve(option('report', join(qaRoot, `semantic-sam-live-${Date.now()}.json`))))
  await mkdir(qaRoot, { recursive: true })
  const runRoot = await mkdtemp(join(qaRoot, 'semantic-sam-live-run-'))
  assertSafeRunRoot(runRoot)
  const report = {
    schemaVersion: 1,
    task: 'AI-001 real managed SAM smoke',
    status: 'running',
    generatedAt: new Date().toISOString(),
    readOnlyRuntimePolicy: 'external ComfyUI is observed only; no start/stop/free/interrupt call is made',
    config: { file: basename(configPath) },
    input: { file: 'src/assets/sample-summer-character.png', source: 'repository fixture', qualityClaim: 'none' },
    checks: {},
    usage: { samples: 0, cpuPercentPeak: null, vramUsedBytesPeak: null },
  }
  let bridge
  let failure
  let blocked = false
  try {
    const config = await readJsonFile(configPath)
    const comfyRoot = resolve(option('comfy-root', config.comfyRoot || ''))
    const pythonPath = resolve(option('python-path', config.pythonPath || ''))
    const comfyUrl = String(option('comfy-url', config.comfyUrl || 'http://127.0.0.1:8188')).replace(/\/$/u, '')
    const comfyArgs = Array.isArray(config.comfyArgs) ? config.comfyArgs : []
    report.config.comfyUrl = comfyUrl
    report.config.comfyArgsCount = comfyArgs.length
    await Promise.all([
      stat(join(comfyRoot, 'main.py')),
      stat(pythonPath),
      stat(sourcePath),
    ])

    const initial = await externalSnapshot(comfyUrl)
    const initialQueue = queueSummary(initial.queue)
    report.checks.externalRuntime = {
      queue: initialQueue,
      runtime: runtimeSummary(initial.stats),
      objectInfo: {
        nodeCount: Object.keys(initial.objectInfo || {}).length,
        hasSAMLoader: Boolean(initial.objectInfo?.SAMLoader),
        hasSAMDetectorCombined: Boolean(initial.objectInfo?.SAMDetectorCombined),
      },
    }
    if (initialQueue.running || initialQueue.pending) {
      throw new SmokeBlockedError('SEMANTIC_SAM_SMOKE_EXTERNAL_QUEUE_BUSY', 'External ComfyUI has an active queue; smoke stopped without reuse or interruption', { queue: initialQueue })
    }
    if (!initial.objectInfo?.SAMLoader) {
      throw new SmokeBlockedError('SEMANTIC_SAM_SMOKE_NODE_MISSING', 'External ComfyUI objectInfo does not contain SAMLoader', { nodeCount: Object.keys(initial.objectInfo || {}).length })
    }

    const registry = await discoverRuntimeRegistry({ comfyRoot, comfyArgs, modelCategories: ['custom_nodes', 'sams'] })
    const sam = ARTIFACTS.samVitB
    const candidates = registeredArtifactCandidates({ relativePath: sam.relativePath }, registry)
    let samCandidate = null
    for (const candidate of candidates) {
      const entry = await stat(candidate.targetPath).catch(() => null)
      if (entry?.isFile() && entry.size === sam.bytes) {
        samCandidate = { candidate, entry }
        break
      }
    }
    if (!samCandidate) {
      throw new SmokeBlockedError('SEMANTIC_SAM_SMOKE_MODEL_MISSING', 'Registered SAM model was not found at a configured main/shared root', {
        registeredCandidates: candidates.length,
        expectedBytes: sam.bytes,
      })
    }
    const samSha256 = await hashFile(samCandidate.candidate.targetPath)
    report.checks.samModel = {
      rootId: samCandidate.candidate.root.id,
      category: samCandidate.candidate.root.category,
      shared: samCandidate.candidate.root.shared,
      source: samCandidate.candidate.root.source,
      bytes: samCandidate.entry.size,
      expectedSha256: sam.sha256,
      observedSha256: samSha256,
      sha256Matches: samSha256 === sam.sha256,
    }
    assert.equal(samSha256, sam.sha256)

    const bridgeDataRoot = join(runRoot, 'bridge-data')
    const outputDirectory = join(runRoot, 'output')
    const cacheDirectory = join(runRoot, 'cache')
    const logsDirectory = join(runRoot, 'logs')
    const bridgeConfigPath = join(runRoot, 'local.json')
    await mkdir(outputDirectory, { recursive: true })
    await writeFile(bridgeConfigPath, JSON.stringify({
      comfyUrl,
      comfyRoot,
      pythonPath,
      comfyArgs,
      comfyLaunchPolicy: 'manual',
      comfyIdleSeconds: 300,
      outputDirectory,
    }, null, 2), 'utf8')
    bridge = await startIsolatedBridge('semantic-sam-live', {
      comfyUrl,
      comfyPolicy: 'manual',
      environment: {
        AEONQUILL_CONFIG: bridgeConfigPath,
        MIAOHUI_CONFIG: bridgeConfigPath,
        AEONQUILL_RUNTIME_DIR: bridgeDataRoot,
        MIAOHUI_RUNTIME_DIR: bridgeDataRoot,
        AEONQUILL_CACHE_DIR: cacheDirectory,
        MIAOHUI_CACHE_DIR: cacheDirectory,
        AEONQUILL_LOG_DIR: logsDirectory,
        MIAOHUI_LOG_DIR: logsDirectory,
        AEONQUILL_OUTPUT_DIR: outputDirectory,
        AEONQUILL_COMFY_ROOT: comfyRoot,
        AEONQUILL_COMFY_PYTHON: pythonPath,
        AEONQUILL_COMFY_POLICY: 'manual',
        MIAOHUI_COMFY_POLICY: 'manual',
        COMFY_URL: comfyUrl,
      },
    })

    const catalog = await requestJson(bridge, '/api/semantic-workflows?refresh=1')
    const elementExtract = catalog.workflows.find(({ id }) => id === 'element-extract')
    report.checks.productCatalog = {
      status: elementExtract?.status,
      installed: elementExtract?.installed,
      available: elementExtract?.available,
      missingExtensions: elementExtract?.missingExtensions || [],
      missingArtifacts: elementExtract?.missingArtifacts || [],
      missingNodes: elementExtract?.missingNodes || [],
    }
    assert.equal(elementExtract?.available, true, JSON.stringify(report.checks.productCatalog))

    const projectId = `semantic-sam-live-${Date.now()}`
    const documentId = `${projectId}-document`
    const workspace = createWorkspaceProject(createProjectCatalog(), {
      title: 'AI-001 SAM 受管 Smoke', initialModeId: 'balanced', color: 'violet',
    }, { projectId, documentId, now: Date.now() })
    await requestJson(bridge, '/api/workspace/catalog', {
      method: 'PUT',
      body: JSON.stringify({ catalog: workspace.catalog, baseRevision: 0, source: 'semantic-sam-live' }),
    })

    const sourceBytes = await readFile(sourcePath)
    const source = await requestJson(bridge, '/api/library/assets', {
      method: 'POST',
      body: JSON.stringify({
        scope: 'project', projectId, title: 'SAM Smoke 输入图', description: 'Repository fixture; software path only',
        tags: ['qa', 'semantic', 'sam'], collectionIds: [],
        dataUrl: `data:image/png;base64,${sourceBytes.toString('base64')}`,
      }),
    }, 201)
    report.checks.inputBinding = {
      projectId,
      libraryItemId: source.asset.id,
      assetId: source.asset.version.assetId,
      bytes: source.asset.version.bytes,
    }

    const idempotencyKey = `semantic-sam-live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const queued = await requestJson(bridge, '/api/jobs/semantic-image', {
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey },
      body: JSON.stringify({
        workflowId: 'element-extract',
        projectId,
        sourceAssetId: source.asset.version.assetId,
        sourceElementId: 'sam-live-subject',
        params: {
          positivePoints: hasFlag('multi-point')
            ? [{ x: 0.56, y: 0.15 }, { x: 0.55, y: 0.3 }, { x: 0.53, y: 0.51 }, { x: 0.53, y: 0.7 }, { x: 0.47, y: 0.83 }, { x: 0.32, y: 0.43 }]
            : [{ x: 0.5, y: 0.45 }],
          negativePoints: [{ x: 0.05, y: 0.05 }],
          threshold: 0.8,
        },
      }),
    }, 202)
    const samples = []
    const startedAt = Date.now()
    const terminal = await waitForTerminal(bridge, queued.job.id, comfyUrl, timeoutMs, samples)
    report.elapsedMs = Date.now() - startedAt
    report.usage.samples = samples.length
    report.usage.cpuPercentPeak = samples.map(({ cpuPercent }) => cpuPercent).filter((value) => value !== null).reduce((max, value) => Math.max(max, value), null)
    report.usage.vramUsedBytesPeak = samples.map(({ vramUsedBytes }) => vramUsedBytes).filter((value) => value !== null).reduce((max, value) => Math.max(max, value), null)
    report.usage.vramTotalBytes = samples.find(({ vramTotalBytes }) => vramTotalBytes)?.vramTotalBytes ?? null
    report.checks.job = {
      id: terminal.id,
      kind: terminal.kind,
      status: terminal.status,
      provider: terminal.output?.provider,
      outputVersionAssetId: terminal.outputVersion?.assetId,
      workflowVersion: terminal.request?.workflowVersion,
    }
    assert.equal(terminal.status, 'completed', JSON.stringify({ error: terminal.error, detail: terminal.detail }))
    assert.equal(terminal.output?.provider, 'comfy-impact-sam')
    assert.ok(terminal.outputVersion?.assetId)

    const outputResponse = await bridge.request(terminal.outputUrl)
    assert.equal(outputResponse.status, 200)
    const outputBytes = Buffer.from(await outputResponse.arrayBuffer())
    const outputPath = join(outputDirectory, `${terminal.id}-element.png`)
    await writeFile(outputPath, outputBytes)
    const retainedOutputPath = join(qaRoot, `semantic-sam-live-output-${terminal.outputVersion.assetId}.png`)
    try { await writeFile(retainedOutputPath, outputBytes, { flag: 'wx' }) }
    catch (error) {
      if (error?.code !== 'EEXIST' || createHash('sha256').update(await readFile(retainedOutputPath)).digest('hex') !== terminal.outputVersion.assetId) throw error
    }
    const outputSha256 = createHash('sha256').update(outputBytes).digest('hex')
    const alpha = await inspectPngAlpha(pythonPath, outputPath)
    report.outputArtifact = retainedOutputPath
    report.checks.output = {
      bytes: outputBytes.length,
      sha256: outputSha256,
      alpha,
      outputVersionMatches: outputSha256 === terminal.outputVersion.assetId,
    }
    assert.equal(outputSha256, terminal.outputVersion.assetId)
    assert.ok(alpha.alphaZero > 0, 'SAM output alpha is fully opaque')
    assert.ok(alpha.alphaOpaque > 0, 'SAM output alpha is fully transparent')

    const assets = await requestJson(bridge, `/api/library/assets?scope=project&projectId=${encodeURIComponent(projectId)}`)
    const outputAsset = assets.assets.find(({ version }) => version.assetId === terminal.outputVersion.assetId)
    assert.ok(outputAsset, 'SAM output was not registered as a project library asset')
    assert.equal(outputAsset.version.assetId, terminal.outputVersion.assetId)
    assert.equal(outputAsset.versionCount, 1)
    report.checks.immutableAsset = {
      libraryItemId: outputAsset.id,
      assetId: outputAsset.version.assetId,
      version: outputAsset.version.version,
      versionCount: outputAsset.versionCount,
      relationship: outputAsset.relationship,
    }
    const maskAsset = assets.assets.find(({ id }) => id === terminal.maskLibraryAsset?.id)
    assert.ok(maskAsset, 'SAM mask was not registered as a project library asset')
    assert.equal(terminal.maskUrl, maskAsset.version.url)
    const maskResponse = await bridge.request(terminal.maskUrl)
    assert.equal(maskResponse.status, 200)
    const maskBytes = Buffer.from(await maskResponse.arrayBuffer())
    const maskSha256 = createHash('sha256').update(maskBytes).digest('hex')
    assert.equal(maskAsset.version.assetId, maskSha256)
    assert.equal(outputAsset.version.provenance.maskVersionId, maskAsset.version.id)
    assert.equal(maskAsset.version.provenance.sourceAssetId, source.asset.version.assetId)
    report.checks.immutableMask = { assetId: maskSha256, bytes: maskBytes.length,
      version: maskAsset.version.version, relationship: maskAsset.relationship, sourceAssetIdMatches: true }

    const afterQueue = await waitForExternalQueueIdle(comfyUrl)
    report.checks.externalRuntimeAfter = { queue: afterQueue, leftRunning: true }
    assert.equal(afterQueue.running, 0)
    assert.equal(afterQueue.pending, 0)
    report.status = 'passed'
    console.log(`[semantic-sam-live] passed job=${terminal.id} elapsedMs=${report.elapsedMs} report=${reportPath}`)
  } catch (error) {
    failure = error
    blocked = error instanceof SmokeBlockedError
    report.status = blocked ? 'blocked' : 'failed'
    report.error = {
      code: error?.code,
      message: error?.message,
      details: error?.details,
      status: error?.status,
    }
    if (error?.lastJob) report.lastJob = {
      id: error.lastJob.id,
      status: error.lastJob.status,
      progress: error.lastJob.progress,
      detail: error.lastJob.detail,
      errorCode: error.lastJob.error?.code,
    }
  } finally {
    report.process = {
      bridgeStopped: Boolean(bridge),
      externalRuntimeStopCalled: false,
      externalRuntimeLeftRunning: true,
    }
    await bridge?.stop({ keepRuntime: false }).catch((error) => {
      report.process.bridgeStopError = error.message
    })
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    assertSafeRunRoot(runRoot)
    await rm(runRoot, { recursive: true, force: true })
  }
  if (failure) throw failure
}

if (hasFlag('help')) {
  help()
} else {
  main().catch((error) => {
    console.error(JSON.stringify({
      status: error instanceof SmokeBlockedError ? 'blocked' : 'failed',
      code: error?.code,
      message: error?.message,
      report: option('report', 'see .runtime/qa/semantic-sam-live-*.json'),
    }))
    process.exitCode = error instanceof SmokeBlockedError ? 2 : 1
  })
}
