import { createReadStream } from 'node:fs'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { ComfyClient, findVideoOutput } from './comfy-client.mjs'
import { AssetPreviewService } from './asset-preview-service.mjs'
import { ClientStateStore } from './client-state-store.mjs'
import { IMAGE_TOOLS_VERSION, ImageProcessor, validateImageRequest } from './image-processor.mjs'
import {
  assertStorageCapacity,
  createEstimateCostEvent,
  createScheduling,
  JobScheduler,
} from './job-scheduler.mjs'
import { JobStore } from './job-store.mjs'
import { assetVersionId, MAX_PACKAGE_BYTES, ProjectStore } from './project-store.mjs'
import { WorkspaceStore } from './workspace-store.mjs'
import { buildManagedComfyLaunch, ComfyRuntimeManager, loadLocalRuntimeConfig } from './runtime-manager.mjs'
import {
  cacheDirectory,
  dataDirectory,
  logDirectory,
  projectRoot,
  runtimeDirectory,
} from './runtime-paths.mjs'
import {
  buildRuntimeDiagnostics,
  normalizeLoopbackComfyUrl,
  persistRuntimeSettings,
  readLocalConfigFile,
  safePathLabel,
} from './runtime-settings.mjs'
import { copyOutputDelivery } from './output-delivery.mjs'
import {
  probeSemanticWorkflowCatalog,
  SEMANTIC_ELEMENT_EXTRACT_OPERATION,
  SEMANTIC_WORKFLOW_CATALOG_VERSION,
  validateElementExtractRequest,
} from './semantic-workflow-registry.mjs'
import {
  createRestrictedChildEnvironment,
  LocalBridgeSecurity,
  redactSensitiveText,
  resolveSafeChildPath,
  sanitizePublicPayload,
} from './security.mjs'
import {
  buildVideoWorkflow,
  assertAllowedWorkflow,
  REQUIRED_NODE_TYPES,
  VIDEO_DIMENSIONS,
  VIDEO_DURATIONS,
  VIDEO_PRESETS,
  REQUIRED_MODEL_FILES,
  WORKFLOW_VERSION,
  validateBundledWorkflowTemplates,
  workflowCatalog,
} from './workflow-builder.mjs'
import {
  AUTOMATIC_VIDEO_MODEL_PROFILE,
  inspectVideoCapabilities,
  resolveVideoModelProfile,
  VIDEO_MODEL_PROFILES,
} from './video-workflow-registry.mjs'
import {
  assertAllowedVideoPostprocessWorkflow,
  buildSeedVr2VideoWorkflow,
} from './video-postprocess-workflow.mjs'
import { assertCanvasDocument } from '../src/lib/canvasCore.mjs'
import {
  compileH3Prompt,
  H3_SCENARIO_PRESETS,
} from '../src/lib/video/h3PromptAgent.mjs'

const distDirectory = join(projectRoot, 'dist')
const inputDirectory = join(runtimeDirectory, 'inputs')
const assetDirectory = join(dataDirectory, 'assets')
const localRuntimeConfig = await loadLocalRuntimeConfig()
const port = Number(process.env.AEONQUILL_PORT || process.env.MIAOHUI_PORT || localRuntimeConfig.bridgePort || 8787)
const host = process.env.AEONQUILL_HOST || process.env.MIAOHUI_HOST || '127.0.0.1'
const security = new LocalBridgeSecurity({ host, port, allowedOrigins: localRuntimeConfig.allowedOrigins })
const ffmpegPath = process.env.FFMPEG_PATH || localRuntimeConfig.imageTools?.ffmpegPath || 'ffmpeg'
const runtimeManager = new ComfyRuntimeManager(localRuntimeConfig)
const comfy = new ComfyClient(localRuntimeConfig.comfyUrl)
const imageProcessor = new ImageProcessor({
  ffmpegPath,
  ffprobePath: localRuntimeConfig.imageTools?.ffprobePath,
  pythonPath: localRuntimeConfig.pythonPath,
  rembgPath: localRuntimeConfig.imageTools?.rembgPath,
  rembgModelsPath: localRuntimeConfig.imageTools?.rembgModelsPath,
  realEsrganPath: localRuntimeConfig.imageTools?.realEsrganPath,
  realEsrganModelsPath: localRuntimeConfig.imageTools?.realEsrganModelsPath,
})
const store = new JobStore(join(dataDirectory, 'jobs.json'))
const projectStore = new ProjectStore(join(dataDirectory, 'projects'))
const workspaceStore = new WorkspaceStore(join(dataDirectory, 'workspaces'))
const clientStateStore = new ClientStateStore(join(dataDirectory, 'client-state'))
const assetPreviewService = new AssetPreviewService({
  rootDirectory: join(cacheDirectory, 'previews'),
  ffmpegPath,
})
let hardwareHint = null
let hardwareHintPromise = null

function scheduleHardwareHint() {
  if (!hardwareHintPromise) {
    hardwareHintPromise = runtimeManager.hardwareHint()
      .then((value) => {
        hardwareHint = value
        runtimeCache = null
        return value
      })
      .catch(() => null)
  }
  return hardwareHintPromise
}

await Promise.all([
  validateBundledWorkflowTemplates(),
  mkdir(inputDirectory, { recursive: true }),
  mkdir(assetDirectory, { recursive: true }),
  mkdir(cacheDirectory, { recursive: true }),
  mkdir(logDirectory, { recursive: true }),
  store.load(),
  projectStore.open(),
  workspaceStore.open(),
  clientStateStore.open(),
  assetPreviewService.open(),
])

try {
  const legacyCatalog = await clientStateStore.get('project-catalog')
  if (legacyCatalog?.value) workspaceStore.bootstrapCatalog(JSON.parse(legacyCatalog.value), { source: 'client-state-v1' })
} catch (error) {
  console.warn(`[WORKSPACE_BOOTSTRAP_SKIPPED] ${redactSensitiveText(error?.message || 'legacy catalog unavailable')}`)
}

const sseClients = new Set()
const requestedImageConcurrency = Number(
  process.env.AEONQUILL_IMAGE_CONCURRENCY || process.env.MIAOHUI_IMAGE_CONCURRENCY || 1,
)
const imageJobConcurrency = Number.isFinite(requestedImageConcurrency)
  ? Math.max(1, Math.min(2, Math.round(requestedImageConcurrency)))
  : 1
const gpuImageOperations = new Set([
  'remove-background',
  'upscale-realesrgan',
  SEMANTIC_ELEMENT_EXTRACT_OPERATION,
])
const scheduler = new JobScheduler({
  store,
  resourceLimits: { cpu: imageJobConcurrency, gpu: 1 },
})
let runtimeCache = null
let runtimeCacheAt = 0

function abortableDelay(duration, signal) {
  if (signal?.aborted) return Promise.reject(Object.assign(new Error('Task was cancelled'), { name: 'AbortError' }))
  return new Promise((resolvePromise, rejectPromise) => {
    let timer
    const cleanup = () => signal?.removeEventListener('abort', onAbort)
    const onAbort = () => {
      clearTimeout(timer)
      cleanup()
      rejectPromise(Object.assign(new Error('Task was cancelled'), { name: 'AbortError' }))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      cleanup()
      resolvePromise()
    }, duration)
  })
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(sanitizePublicPayload(payload))
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}

function sendError(response, statusCode, code, message, details) {
  sendJson(response, statusCode, { error: { code, message, details } })
}

function assertManagedPrivatePath(filePath, rootDirectory) {
  const target = resolve(String(filePath || ''))
  const root = resolve(rootDirectory)
  if (!target.startsWith(`${root}${sep}`)) {
    throw Object.assign(new Error('Stored task input is outside the managed runtime directory'), {
      status: 409,
      code: 'UNMANAGED_TASK_PATH',
    })
  }
  return target
}

async function deliverConfiguredOutput(jobId, sourcePath, filename) {
  const outputDirectory = localRuntimeConfig.outputDirectory
  if (!outputDirectory) return undefined
  const directoryLabel = safePathLabel(outputDirectory)
  try {
    const delivered = await copyOutputDelivery({ sourcePath, outputDirectory, filename })
    await store.log(jobId, 'success', `已复制交付副本到 ${directoryLabel}`)
    return {
      status: 'copied',
      filename: delivered.filename,
      directoryLabel,
    }
  } catch {
    await store.log(jobId, 'warning', '交付副本写入失败；内部不可变资产仍已安全保存')
    return {
      status: 'failed',
      directoryLabel,
      message: '输出目录当前不可写，请在本机设置中重新选择；内部资产未受影响。',
    }
  }
}

async function readJsonBody(request, maxBytes = 48 * 1024 * 1024) {
  const declaredLength = Number(request.headers['content-length'] || 0)
  if (declaredLength > maxBytes) throw Object.assign(new Error('Request body is too large'), { status: 413 })
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > maxBytes) throw Object.assign(new Error('Request body is too large'), { status: 413 })
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON'), { status: 400 })
  }
}

async function readBinaryBody(request, maxBytes = MAX_PACKAGE_BYTES) {
  const declaredLength = Number(request.headers['content-length'] || 0)
  if (declaredLength > maxBytes) throw Object.assign(new Error('Request body is too large'), { status: 413 })
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > maxBytes) throw Object.assign(new Error('Request body is too large'), { status: 413 })
    chunks.push(chunk)
  }
  if (!chunks.length) throw Object.assign(new Error('Project package is empty'), { status: 400 })
  return Buffer.concat(chunks)
}

function decodeImageAssetDataUrl(value) {
  const match = /^data:image\/(png|jpeg|webp);base64,([a-zA-Z0-9+/=\r\n]+)$/.exec(value || '')
  if (!match) throw Object.assign(new Error('需要有效的 PNG、JPEG 或 WebP 图片'), { status: 400 })
  const bytes = Buffer.from(match[2], 'base64')
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) {
    throw Object.assign(new Error('图片文件为空或超过 20MB'), { status: 413 })
  }
  return {
    bytes,
    extension: match[1] === 'jpeg' ? 'jpg' : match[1],
    mimeType: match[1] === 'jpeg' ? 'image/jpeg' : `image/${match[1]}`,
  }
}

function decodeImageDataUrl(value) {
  return decodeImageAssetDataUrl(value).bytes
}

function validateVideoRequest(body) {
  const mode = body.mode
  const prompt = String(body.prompt || '').trim()
  const aspectRatio = body.aspectRatio || '16:9'
  const duration = Number(body.duration || 5)
  const preset = body.preset || 'fast'
  const modelProfile = body.modelProfile || AUTOMATIC_VIDEO_MODEL_PROFILE
  const audio = body.audio !== false
  const scenario = body.scenario || 'auto'
  const seed = Number.isSafeInteger(Number(body.seed))
    ? Math.max(0, Math.min(Number(body.seed), Number.MAX_SAFE_INTEGER))
    : randomInt(1, 2_147_483_647)

  if (!['text-to-video', 'image-to-video'].includes(mode)) {
    throw Object.assign(new Error('不支持的视频生成模式'), { status: 400 })
  }
  if (prompt.length < 2 || prompt.length > 8_000) {
    throw Object.assign(new Error('提示词长度需要在 2–8000 个字符之间'), { status: 400 })
  }
  if (!VIDEO_DIMENSIONS[aspectRatio]) {
    throw Object.assign(new Error('不支持的画幅'), { status: 400 })
  }
  if (!VIDEO_DURATIONS[duration]) {
    throw Object.assign(new Error('当前仅支持 5、10 或 15 秒'), { status: 400 })
  }
  if (!VIDEO_PRESETS[preset]) {
    throw Object.assign(new Error('不支持的质量预设'), { status: 400 })
  }
  if (!VIDEO_PRESETS[preset].allowedDurations.includes(duration)) {
    throw Object.assign(new Error(`${VIDEO_PRESETS[preset].label} 仅支持 ${VIDEO_PRESETS[preset].allowedDurations.join('、')} 秒`), {
      code: 'VIDEO_PRESET_DURATION_UNSUPPORTED',
      status: 400,
    })
  }
  if (modelProfile !== AUTOMATIC_VIDEO_MODEL_PROFILE && !VIDEO_MODEL_PROFILES[modelProfile]) {
    throw Object.assign(new Error('不支持的视频模型精度路径'), { status: 400 })
  }
  if (!Object.hasOwn(H3_SCENARIO_PRESETS, scenario)) {
    throw Object.assign(new Error('不支持的 H3 场景预设'), { status: 400 })
  }

  const director = body.director && typeof body.director === 'object' ? {
    camera: String(body.director.camera || 'locked').slice(0, 32),
    motion: String(body.director.motion || 'natural').slice(0, 32),
    continuity: body.director.continuity !== false,
    soundscape: String(body.director.soundscape || '').slice(0, 800),
    music: String(body.director.music || '').slice(0, 800),
    constraints: String(body.director.constraints || '').slice(0, 800),
  } : undefined
  compileH3Prompt({
    mode,
    sourcePrompt: prompt,
    scenario,
    aspectRatio,
    duration,
    frameCount: VIDEO_DURATIONS[duration],
    audio,
    hasLastFrame: mode === 'image-to-video' && Boolean(body.lastFrameImageDataUrl),
    director,
  })

  return {
    mode,
    prompt,
    scenario,
    aspectRatio,
    duration,
    preset,
    modelProfile,
    seed,
    audio,
    sourceElementId: typeof body.sourceElementId === 'string' ? body.sourceElementId : undefined,
    director,
    hasLastFrame: mode === 'image-to-video' && Boolean(body.lastFrameImageDataUrl),
  }
}

function terminateChildProcess(child) {
  if (!child?.pid) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      env: createRestrictedChildEnvironment(),
    }).unref()
  } else {
    child.kill('SIGKILL')
  }
}

function runProcess(executable, args, timeoutMs = 10 * 60 * 1000, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted) return rejectPromise(signal.reason || Object.assign(new Error('Task was cancelled'), { name: 'AbortError' }))
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: createRestrictedChildEnvironment(),
    })
    let stderr = ''
    let settled = false
    const settle = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      callback(value)
    }
    const onAbort = () => {
      terminateChildProcess(child)
      settle(rejectPromise, signal.reason || Object.assign(new Error('Task was cancelled'), { name: 'AbortError' }))
    }
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-8_000) })
    const timer = setTimeout(() => {
      terminateChildProcess(child)
      settle(rejectPromise, new Error('FFmpeg post-processing timed out'))
    }, timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    child.once('error', (error) => {
      settle(rejectPromise, error)
    })
    child.once('exit', (code) => {
      if (code === 0) settle(resolvePromise)
      else settle(rejectPromise, new Error(`FFmpeg exited with code ${code}: ${redactSensitiveText(stderr.slice(-1_500))}`))
    })
  })
}

async function createDeliveryVideo(inputPath, outputPath, dimensions, signal) {
  await runProcess(ffmpegPath, [
    '-y', '-i', inputPath,
    '-vf', `scale=${dimensions.width}:${dimensions.height}:flags=lanczos`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-c:a', 'copy', '-movflags', '+faststart',
    outputPath,
  ], 10 * 60 * 1000, signal)
}

async function inspectRuntime(force = false) {
  if (!force && runtimeCache && Date.now() - runtimeCacheAt < 3_000) return runtimeCache
  try {
    const [status, objectInfo] = await Promise.all([comfy.runtimeStatus(), comfy.objectInfo()])
    const missingNodes = REQUIRED_NODE_TYPES.filter((type) => !objectInfo[type])
    const missingModels = REQUIRED_MODEL_FILES
      .filter(([nodeType, inputName, filename]) => {
        const options = objectInfo[nodeType]?.input?.required?.[inputName]?.[0]
        return !Array.isArray(options) || !options.includes(filename)
      })
      .map(([, , filename]) => filename)
    const videoCapabilities = inspectVideoCapabilities(objectInfo, status)
    runtimeCache = {
      ...status,
      ready: missingNodes.length === 0 && missingModels.length === 0,
      missingNodes,
      missingModels,
      videoCapabilities,
      checkedAt: Date.now(),
      lifecycle: runtimeManager.status(),
    }
  } catch (error) {
    void scheduleHardwareHint()
    runtimeCache = {
      connected: false,
      ready: false,
      message: redactSensitiveText(error.message),
      queueRunning: 0,
      queuePending: 0,
      missingNodes: [],
      missingModels: [],
      checkedAt: Date.now(),
      lifecycle: runtimeManager.status(),
      device: hardwareHint?.name,
      vramTotal: hardwareHint?.vramTotal || 0,
      vramFree: hardwareHint?.vramTotal || 0,
    }
  }
  runtimeCacheAt = Date.now()
  return runtimeCache
}

async function inspectSemanticWorkflows(force = false) {
  const runtime = await inspectRuntime(force)
  let objectInfo
  if (runtime.connected) {
    objectInfo = await comfy.objectInfo().catch(() => undefined)
  }
  return probeSemanticWorkflowCatalog({
    comfyRoot: localRuntimeConfig.comfyRoot,
    objectInfo,
    runtime,
  })
}

async function inspectRuntimeDiagnostics(force = false, persistedConfig) {
  const [runtime, imageManifest] = await Promise.all([
    inspectRuntime(force),
    imageProcessor.probe(force),
  ])
  const semanticManifest = await inspectSemanticWorkflows(force)
  const lifecycle = runtimeManager.status()
  let storedConfig = persistedConfig
  let configError = localRuntimeConfig.configReadError
  if (!storedConfig) {
    try {
      storedConfig = await readLocalConfigFile()
    } catch (error) {
      storedConfig = {}
      configError = { code: error.code || 'INVALID_LOCAL_CONFIG', message: error.message }
    }
  }
  return buildRuntimeDiagnostics({
    activeConfig: {
      ...localRuntimeConfig,
      launchPolicy: lifecycle.policy,
      idleTimeoutMs: lifecycle.idleTimeoutMs,
    },
    persistedConfig: storedConfig,
    runtime,
    imageManifest,
    semanticManifest,
    configError,
  })
}

const IDEMPOTENCY_KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function hashRequest(kind, body) {
  return createHash('sha256').update(`${kind}\0${canonicalJson(body)}`, 'utf8').digest('hex')
}

function resolveIdempotencyKey(value) {
  if (value === undefined || value === null || value === '') return `request-${randomUUID()}`
  const key = Array.isArray(value) ? value[0] : String(value)
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw Object.assign(new Error('Idempotency-Key must be 8-128 safe ASCII characters'), {
      code: 'INVALID_IDEMPOTENCY_KEY',
      status: 400,
    })
  }
  return key
}

function resolvePriority(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const priority = Number(Array.isArray(value) ? value[0] : value)
  if (!Number.isSafeInteger(priority) || priority < -100 || priority > 100) {
    throw Object.assign(new Error('X-MiaoHui-Priority must be an integer from -100 to 100'), {
      code: 'INVALID_JOB_PRIORITY',
      status: 400,
    })
  }
  return priority
}

function imageResourceClass(operation) {
  return gpuImageOperations.has(operation) ? 'gpu' : 'cpu'
}

function estimateVideoMilliseconds(request) {
  const estimate = VIDEO_PRESETS[request.preset]?.estimatedMinutes?.[request.duration]
  const upperMinutes = Number(String(estimate || '').split('–').at(-1))
  return Number.isFinite(upperMinutes)
    ? upperMinutes * 60_000
    : Math.max(60_000, request.duration * 60_000)
}

function estimateVideoStorageBytes(request) {
  return 64 * 1024 * 1024 + request.duration * 16 * 1024 * 1024
}

async function describeOutputVersion(job, filePath, mimeType) {
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk)
    bytes += chunk.length
  }
  const contentAssetId = hash.digest('hex')
  const logicalAssetId = `asset-job-${job.id}`
  const version = 1
  return {
    id: assetVersionId(logicalAssetId, version, contentAssetId),
    logicalAssetId,
    version,
    assetId: contentAssetId,
    sourceElementId: job.sourceElementId,
    mimeType,
    bytes,
    provenance: {
      source: 'local-job-output',
      jobId: job.id,
      kind: job.kind,
      tool: job.tool,
      workflowVersion: job.workflowVersion,
      ...(job.kind === 'video' ? {
        preset: job.request?.preset,
        scenario: job.workflowMetadata?.promptAgent?.resolvedScenario || job.request?.scenario,
        modelProfile: job.workflowMetadata?.modelProfile,
        modelPrecision: job.workflowMetadata?.modelPrecision,
        promptAgentVersion: job.workflowMetadata?.promptAgent?.version,
        samplingSteps: job.workflowMetadata?.steps,
      } : {}),
      createdAt: Date.now(),
    },
  }
}

function newJob(request, inputPath, lastFramePath, options = {}) {
  const id = `video-${randomUUID()}`
  const now = Date.now()
  const scheduling = createScheduling({
    resourceClass: 'gpu',
    priority: options.priority ?? 50,
    timeoutMs: 2 * 60 * 60 * 1_000,
    idempotencyKey: options.idempotencyKey,
    attempt: options.attempt || 1,
    maxAttempts: 3,
    queuedAt: now,
  })
  return {
    id,
    kind: 'video',
    tool: request.mode,
    label: request.mode === 'image-to-video' ? '图生视频' : '文生视频',
    status: 'queued',
    phase: 'queued',
    progress: 0,
    detail: '等待本地执行器',
    createdAt: now,
    updatedAt: now,
    workflowVersion: WORKFLOW_VERSION,
    requestHash: options.requestHash,
    retryOf: options.retryOf,
    scheduling,
    costEvents: [createEstimateCostEvent(id, 'gpu', estimateVideoMilliseconds(request), now)],
    request,
    sourceElementId: request.sourceElementId,
    inputPath,
    lastFramePath,
    logs: [{ at: now, level: 'info', message: '任务已创建' }],
  }
}

const imageOperationLabels = {
  'upscale-lanczos': 'Lanczos 超分',
  pixelate: '像素化与调色',
  sharpen: '细节锐化',
  'alpha-cleanup': '透明边清理',
  'masked-adjust': '蒙版区域调整',
  'remove-background': 'AI 去背景',
  'upscale-realesrgan': 'Real-ESRGAN 超分',
  [SEMANTIC_ELEMENT_EXTRACT_OPERATION]: 'SAM 元素提取',
}

function newImageJob(request, inputPath, options = {}) {
  const id = `image-${randomUUID()}`
  const now = Date.now()
  const resourceClass = imageResourceClass(request.operation)
  const scheduling = createScheduling({
    resourceClass,
    priority: options.priority ?? (resourceClass === 'gpu' ? 60 : 70),
    timeoutMs: resourceClass === 'gpu' ? 25 * 60 * 1_000 : 10 * 60 * 1_000,
    idempotencyKey: options.idempotencyKey,
    attempt: options.attempt || 1,
    maxAttempts: 3,
    queuedAt: now,
  })
  return {
    id,
    kind: 'image',
    tool: request.operation,
    label: imageOperationLabels[request.operation] || request.operation,
    status: 'queued',
    phase: 'queued',
    progress: 0,
    detail: '等待本地图像处理器',
    createdAt: now,
    updatedAt: now,
    workflowVersion: request.workflowVersion || (
      request.operation === SEMANTIC_ELEMENT_EXTRACT_OPERATION
        ? SEMANTIC_WORKFLOW_CATALOG_VERSION
        : IMAGE_TOOLS_VERSION
    ),
    requestHash: options.requestHash,
    retryOf: options.retryOf,
    scheduling,
    costEvents: [createEstimateCostEvent(id, resourceClass, resourceClass === 'gpu' ? 5 * 60_000 : 60_000, now)],
    request,
    sourceElementId: request.sourceElementId,
    inputPath,
    maskPath: options.maskPath,
    logs: [{ at: now, level: 'info', message: '图片任务已创建' }],
  }
}

function normalizeImageError(error, operation) {
  const message = String(error?.message || '未知图片处理错误')
    .replace(/[a-zA-Z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*/g, '[local file]')
  if (error?.code === 'ENOSPC' || /no space left|disk full/i.test(message)) {
    return {
      code: 'STORAGE_EXHAUSTED',
      title: '本地存储空间不足',
      message: '处理过程中可用磁盘空间不足，未提交正式输出。',
      suggestions: ['释放运行时磁盘空间', '清理已确认不再需要的终态任务后重试'],
    }
  }
  if (error?.code === 'IMAGE_OPERATION_UNAVAILABLE' || error?.status === 409) {
    return {
      code: 'IMAGE_OPERATION_UNAVAILABLE',
      title: '本地处理器尚不可用',
      message,
      suggestions: ['在能力面板检查本机依赖', '安装对应命令行工具或选择确定性本地处理'],
    }
  }
  if (error?.code === 'IMAGE_MASK_REQUIRED') {
    return {
      code: 'IMAGE_MASK_REQUIRED',
      title: '蒙版输入不可用',
      message: '区域调整需要由元素提取或蒙版修边产生的透明蒙版。',
      suggestions: ['先运行元素提取并选择派生结果', '确认蒙版资产仍可读取后重试'],
    }
  }
  if (/exceeds .* pixels|invalid dimensions|invalid data|Invalid data/i.test(message)) {
    return {
      code: 'IMAGE_INPUT_INVALID',
      title: '图片尺寸或文件无效',
      message,
      suggestions: ['改用 PNG、JPEG 或 WebP', '缩小原图后重新提交'],
    }
  }
  return {
    code: 'IMAGE_PROCESSOR_FAILED',
    title: '本地图片处理失败',
    message,
    suggestions: [
      operation === 'remove-background' ? '检查 rembg 模型与 Python 依赖' : '检查 FFmpeg 或外部适配器是否可执行',
      '查看任务日志中的底层错误',
    ],
  }
}

function normalizeSemanticImageError(error) {
  const message = redactSensitiveText(String(error?.message || '未知语义图像处理错误'))
  if (error?.code === 'SEMANTIC_WORKFLOW_UNAVAILABLE' || error?.status === 409) {
    return {
      code: 'SEMANTIC_WORKFLOW_UNAVAILABLE',
      title: '语义工作流尚不可用',
      message,
      suggestions: ['刷新 ComfyUI 语义能力状态', '检查 Impact Pack 与本地 SAM 权重'],
    }
  }
  if (/SAM did not return|semantic points|mask/i.test(message)) {
    return {
      code: 'SEMANTIC_MASK_NOT_FOUND',
      title: '没有找到稳定元素蒙版',
      message,
      suggestions: ['把正向点放在元素内部', '在背景处增加负向点', '适当降低置信阈值'],
    }
  }
  return {
    code: 'SEMANTIC_IMAGE_FAILED',
    title: '语义图像处理失败',
    message,
    suggestions: ['检查 ComfyUI 日志与节点注册', '确认显存释放后重试'],
  }
}

async function runSemanticElementExtractJob(jobId, { signal }) {
  const job = store.get(jobId)
  if (!job) return
  const normalizedInputPath = join(inputDirectory, `${job.id}-sam-source.png`)
  const maskFilename = `${job.id}-sam-mask.png`
  const maskPath = join(assetDirectory, maskFilename)
  const outputFilename = `${job.id}-element.png`
  const outputPath = join(assetDirectory, outputFilename)
  const temporaryOutputPath = join(assetDirectory, `${job.id}-element.part.png`)
  const managedUploadFilename = `aeonquill-${job.id}.png`
  const managedComfyInputRoot = buildManagedComfyLaunch({ args: localRuntimeConfig.comfyArgs }).directories.input
  const managedComfyInputPath = join(managedComfyInputRoot, managedUploadFilename)
  let completed = false
  try {
    await store.update(jobId, {
      outputPath,
      temporaryOutputPath,
      status: 'running',
      phase: 'preparing',
      progress: 4,
      detail: '按需启动 ComfyUI 语义运行时',
    })
    await store.log(jobId, 'info', '已取得共享 GPU 执行器，准备 Impact SAM')
    await runtimeManager.ensureReady({ reason: `semantic:${jobId}` })
    runtimeCache = null
    const catalog = await inspectSemanticWorkflows(true)
    const workflow = catalog.workflows.find((item) => item.id === 'element-extract')
    if (!workflow?.available) {
      const error = new Error(workflow?.message || 'Element extraction workflow is unavailable')
      error.code = 'SEMANTIC_WORKFLOW_UNAVAILABLE'
      error.status = 409
      error.details = {
        missingExtensions: workflow?.missingExtensions,
        missingArtifacts: workflow?.missingArtifacts,
        missingNodes: workflow?.missingNodes,
      }
      throw error
    }

    await store.update(jobId, { progress: 12, detail: '校验图片尺寸与点击坐标' })
    const input = await imageProcessor.dimensions(job.inputPath, signal)
    if (input.width * input.height > 40_000_000) {
      throw Object.assign(new Error('Semantic element extraction input exceeds 40 megapixels'), { status: 400 })
    }
    const toPixels = (points) => points.map(({ x, y }) => [
      Math.max(0, Math.min(input.width - 1, Math.round(x * (input.width - 1)))),
      Math.max(0, Math.min(input.height - 1, Math.round(y * (input.height - 1)))),
    ])

    await runProcess(ffmpegPath, [
      '-y', '-i', job.inputPath,
      '-frames:v', '1',
      '-vf', 'format=rgba',
      normalizedInputPath,
    ], 2 * 60_000, signal)
    await store.update(jobId, { progress: 22, detail: '上传受管图片到本机 SAM' })
    const imageReference = await comfy.uploadImage(normalizedInputPath, managedUploadFilename, signal)
    await comfy.prepareSamImage(imageReference, signal)

    await store.update(jobId, { phase: 'processing', progress: 34, detail: '加载 SAM 并计算点击提示' })
    let maskBytes
    let lastError
    for (let attempt = 0; attempt < 80 && !maskBytes; attempt += 1) {
      if (attempt > 0) await abortableDelay(750, signal)
      try {
        maskBytes = await comfy.detectSamMask({
          positivePoints: toPixels(job.request.params.positivePoints),
          negativePoints: toPixels(job.request.params.negativePoints),
          threshold: job.request.params.threshold,
        }, signal)
      } catch (error) {
        lastError = error
        if (error?.status !== 400) throw error
      }
      if (attempt === 12) {
        await store.update(jobId, { progress: 48, detail: 'SAM 首次加载仍在进行，请稍候' })
      }
    }
    if (!maskBytes?.length) {
      throw Object.assign(new Error(`SAM did not return a mask${lastError ? `: ${lastError.message}` : ''}`), {
        code: 'SEMANTIC_MASK_NOT_FOUND',
      })
    }
    await writeFile(maskPath, maskBytes, { flag: 'wx' })

    await store.update(jobId, { progress: 76, detail: '合成透明元素并保留原图' })
    await runProcess(ffmpegPath, [
      '-y', '-i', normalizedInputPath, '-i', maskPath,
      '-filter_complex', '[0:v]format=rgba[base];[1:v]format=gray[mask];[base][mask]alphamerge',
      '-frames:v', '1',
      temporaryOutputPath,
    ], 2 * 60_000, signal)
    await rename(temporaryOutputPath, outputPath)
    const output = await imageProcessor.dimensions(outputPath, signal)
    const outputInfo = await stat(outputPath)
    const latest = store.get(jobId)
    if (latest?.cancelRequested) return

    await store.update(jobId, { phase: 'saving', progress: 94, detail: '登记蒙版与透明元素版本' })
    const outputVersion = await describeOutputVersion(job, outputPath, 'image/png')
    const delivery = await deliverConfiguredOutput(jobId, outputPath, outputFilename)
    await store.log(jobId, 'success', `SAM 已提取 ${output.width}×${output.height} 透明元素`)
    await store.update(jobId, {
      status: 'completed',
      phase: 'completed',
      progress: 100,
      detail: '元素提取完成，可以回填画布并继续修边',
      outputUrl: `/api/assets/${encodeURIComponent(outputFilename)}`,
      maskUrl: `/api/assets/${encodeURIComponent(maskFilename)}`,
      output: {
        filename: outputFilename,
        maskFilename,
        width: output.width,
        height: output.height,
        mimeType: 'image/png',
        bytes: outputInfo.size,
        provider: 'comfy-impact-sam',
      },
      workflowMetadata: {
        version: job.request.workflowVersion,
        positivePoints: job.request.params.positivePoints.length,
        negativePoints: job.request.params.negativePoints.length,
        threshold: job.request.params.threshold,
      },
      outputVersion,
      delivery,
      completedAt: Date.now(),
      temporaryOutputPath: undefined,
    })
    completed = true
  } catch (error) {
    const latest = store.get(jobId)
    if (signal.reason?.code === 'JOB_TIMEOUT') throw error
    if (error.name === 'AbortError' || latest?.cancelRequested || signal.reason?.code === 'JOB_CANCELLED') {
      await store.update(jobId, {
        status: 'cancelled',
        phase: 'cancelled',
        detail: '元素提取任务已取消',
      })
      await store.log(jobId, 'warning', 'SAM 元素提取已由用户取消')
      return
    }
    const normalized = normalizeSemanticImageError(error)
    await store.log(jobId, 'error', `${normalized.code}：${normalized.message}`)
    await store.update(jobId, {
      status: 'failed',
      phase: 'failed',
      detail: normalized.title,
      error: normalized,
    })
  } finally {
    await unlink(normalizedInputPath).catch(() => {})
    await unlink(temporaryOutputPath).catch(() => {})
    await unlink(assertManagedPrivatePath(managedComfyInputPath, managedComfyInputRoot)).catch(() => {})
    if (!completed) {
      await unlink(outputPath).catch(() => {})
      await unlink(maskPath).catch(() => {})
    }
    await comfy.releaseSam()
    await scheduleRuntimeIdleStop()
  }
}

async function runImageJob(jobId, { signal }) {
  const job = store.get(jobId)
  if (!job) return
  if (job.request.operation === SEMANTIC_ELEMENT_EXTRACT_OPERATION) {
    return runSemanticElementExtractJob(jobId, { signal })
  }
  const outputFilename = `${job.id}-${job.request.operation}.png`
  const outputPath = join(assetDirectory, outputFilename)
  try {
    await store.update(jobId, {
      outputPath,
      status: 'running',
      phase: 'preparing',
      progress: 8,
      detail: '验证图片与处理参数',
    })
    await store.log(jobId, 'info', `使用 ${job.request.operation} 处理图片`)
    if (gpuImageOperations.has(job.request.operation)) {
      await store.log(jobId, 'info', '已取得共享 GPU 执行器')

      await runtimeManager.refreshOwnership()
      if (runtimeManager.status().owned) {
        let queueBusy = true
        while (queueBusy) {
          const queue = await comfy.queueState().catch(() => ({ queue_running: [], queue_pending: [] }))
          queueBusy = (queue.queue_running?.length || 0) > 0 || (queue.queue_pending?.length || 0) > 0
          if (!queueBusy) break
          await store.update(jobId, {
            phase: 'queued',
            progress: 12,
            detail: '等待 ComfyUI 队列释放显卡',
          })
          await abortableDelay(1_000, signal)
        }
        await store.update(jobId, {
          phase: 'preparing',
          progress: 16,
          detail: '关闭空闲 ComfyUI 并释放显存',
        })
        await runtimeManager.stop('gpu-image-job')
        runtimeCache = null
        await store.log(jobId, 'success', '已关闭光阴砚托管的空闲 ComfyUI，释放显存给图片模型')
      } else if (await runtimeManager.isReady()) {
        await store.log(jobId, 'warning', '检测到外部 ComfyUI；光阴砚不会关闭外部进程，请留意显存占用')
      }
    }
    await store.update(jobId, {
      phase: 'processing',
      progress: 28,
      detail: '本地处理器正在计算',
    })
    const output = await imageProcessor.process({
      operation: job.request.operation,
      params: job.request.params,
      inputPath: job.inputPath,
      maskPath: job.maskPath,
      outputPath,
      signal,
    })
    const latest = store.get(jobId)
    if (latest?.cancelRequested) return
    await store.update(jobId, {
      phase: 'saving',
      progress: 94,
      detail: '写入本地图片资产库',
    })
    await store.log(jobId, 'success', `已生成 ${output.width}×${output.height} PNG`)
    const outputVersion = await describeOutputVersion(job, outputPath, output.mimeType)
    const delivery = await deliverConfiguredOutput(jobId, outputPath, outputFilename)
    await store.update(jobId, {
      status: 'completed',
      phase: 'completed',
      progress: 100,
      detail: '处理完成，可以回填画布',
      outputUrl: `/api/assets/${encodeURIComponent(outputFilename)}`,
      output: {
        filename: outputFilename,
        width: output.width,
        height: output.height,
        mimeType: output.mimeType,
        bytes: output.bytes,
        provider: output.provider,
      },
      outputVersion,
      delivery,
      completedAt: Date.now(),
    })
  } catch (error) {
    const latest = store.get(jobId)
    if (signal.reason?.code === 'JOB_TIMEOUT') throw error
    if (error.name === 'AbortError' || latest?.cancelRequested || signal.reason?.code === 'JOB_CANCELLED') {
      await store.update(jobId, {
        status: 'cancelled',
        phase: 'cancelled',
        detail: '图片任务已取消',
      })
      await store.log(jobId, 'warning', '图片任务已由用户取消')
      return
    }
    const normalized = normalizeImageError(error, job.request.operation)
    await store.log(jobId, 'error', `${normalized.code}：${normalized.message}`)
    await store.update(jobId, {
      status: 'failed',
      phase: 'failed',
      detail: normalized.title,
      error: normalized,
    })
  } finally {
    const latest = store.get(jobId)
    if (latest?.status !== 'completed') await unlink(outputPath).catch(() => {})
    await scheduleRuntimeIdleStop()
  }
}

function stageForNode(nodeId) {
  if (['1', '2', '3', '4', '5'].includes(nodeId)) {
    return { phase: 'preparing', progress: 12, detail: '加载 H3 模型与 Turbo 加速器' }
  }
  if (nodeId === '6') return { phase: 'conditioning', progress: 19, detail: '编码提示词与首帧条件' }
  if (nodeId === '11') return { phase: 'sampling', progress: 23, detail: '开始视频采样' }
  if (nodeId === '12') return { phase: 'decoding', progress: 86, detail: '解码视频帧' }
  if (nodeId === '13') return { phase: 'decoding', progress: 90, detail: '解码原生音频' }
  if (nodeId === '14') return { phase: 'encoding', progress: 94, detail: '封装音视频流' }
  if (nodeId === '15') return { phase: 'saving', progress: 97, detail: '保存 MP4 文件' }
  return null
}

function reportComfyEvent(jobId, message) {
  const job = store.get(jobId)
  if (!job || ['completed', 'failed', 'cancelled'].includes(job.status)) return
  if (message.type === 'executing' && message.data?.node) {
    const stage = stageForNode(String(message.data.node))
    if (stage) {
      const changedStage = job.detail !== stage.detail
      void store.update(jobId, { status: 'running', ...stage })
      if (changedStage) void store.log(jobId, 'info', stage.detail)
    }
  } else if (message.type === 'progress') {
    const value = Number(message.data?.value || 0)
    const max = Math.max(1, Number(message.data?.max || 1))
    const progress = Math.min(84, 23 + Math.round((value / max) * 61))
    void store.update(jobId, {
      status: 'running',
      phase: 'sampling',
      progress,
      sampleStep: value,
      sampleSteps: max,
      detail: `视频采样 ${value}/${max}`,
    })
  }
}

function reportSeedVrEvent(jobId, message) {
  const job = store.get(jobId)
  if (!job || ['completed', 'failed', 'cancelled'].includes(job.status)) return
  if (message.type === 'executing' && message.data?.node) {
    const nodeId = String(message.data.node)
    const stage = ['101', '102', '103', '104'].includes(nodeId)
      ? { progress: 87, detail: '读取母片并建立 720P 时序修复画布' }
      : ['105', '106', '107', '108'].includes(nodeId)
        ? { progress: 90, detail: '释放 H3 后加载 SeedVR2 并切分时序块' }
        : ['109', '110', '111'].includes(nodeId)
          ? { progress: 94, detail: 'SeedVR2 正在逐块修复并交叠合并' }
          : ['112', '113'].includes(nodeId)
            ? { progress: 97, detail: '分块解码、对齐并稳定颜色' }
            : ['114', '115'].includes(nodeId)
              ? { progress: 99, detail: '回填原音频与帧率并封装母版' }
              : null
    if (stage) {
      const changedStage = job.detail !== stage.detail
      void store.update(jobId, { status: 'running', phase: 'restoring', ...stage })
      if (changedStage) void store.log(jobId, 'info', stage.detail)
    }
  } else if (message.type === 'progress') {
    void store.update(jobId, {
      status: 'running',
      phase: 'restoring',
      progress: 95,
      detail: 'SeedVR2 正在执行一步时序修复',
    })
  }
}

function normalizeExecutionError(error) {
  const message = redactSensitiveText(error?.comfyData?.exception_message || error?.message || '未知错误')
  const lower = message.toLowerCase()
  const details = sanitizePublicPayload({
    nodeId: error?.comfyData?.node_id,
    nodeType: error?.comfyData?.node_type,
    exceptionType: error?.comfyData?.exception_type,
    rawMessage: message.slice(0, 2_000),
  })
  if (['VIDEO_PRESET_UNAVAILABLE', 'VIDEO_MODEL_PROFILE_UNAVAILABLE'].includes(error?.code)) {
    return {
      code: error.code,
      title: '所选高质量流水线尚未就绪',
      message: '当前运行时缺少该档位所需的模型、节点或精度环境，任务没有静默降级。',
      suggestions: ['在设置中重新检测本机运行时', '选择“Base 20 步精修”保留高质量生成但跳过 SeedVR2', '选择“快速动作预览”先验证镜头'],
      details: sanitizePublicPayload({ ...details, ...(error.details || {}), ...(error.payload?.node_errors || {}) }),
    }
  }
  if (error?.code === 'ENOSPC' || lower.includes('no space left') || lower.includes('disk full')) {
    return {
      code: 'STORAGE_EXHAUSTED',
      title: '本地存储空间不足',
      message: '生成或封装过程中可用磁盘空间不足，未提交正式输出。',
      suggestions: ['释放运行时磁盘空间', '缩短视频或降低交付档位后重试'],
      details,
    }
  }
  if (isOutOfMemoryFailure(error)) {
    return {
      code: 'COMFY_OOM',
      title: error?.stage === 'seedvr2' ? 'SeedVR2 时序精修显存不足' : '显存不足，视频采样未完成',
      message: error?.stage === 'seedvr2'
        ? '系统已经尝试更小的时序块，但当前显存仍不足；H3 原生母片已保留。'
        : '当前分辨率、时长或采样配置超过了可用显存。',
      suggestions: error?.stage === 'seedvr2'
        ? ['直接使用已保留的 Base 母片', '关闭占用显存的其他程序后重试', '改用 5 秒母版档']
        : ['切换为“快速预览”', '先生成 5 秒版本', '关闭占用显存的其他程序后重试'],
      details,
    }
  }
  if (lower.includes('fetch failed') || lower.includes('econnrefused') || lower.includes('websocket')) {
    return {
      code: 'COMFY_OFFLINE',
      title: '无法连接本机 ComfyUI',
      message: '请确认 ComfyUI 已在 127.0.0.1:8188 启动。',
      suggestions: ['启动 ComfyUI', '检查端口是否为 8188', '返回页面重新检测连接'],
      details,
    }
  }
  if (lower.includes('[errno 22] invalid argument') && error?.comfyData?.exception_type === 'OSError') {
    return {
      code: 'COMFY_OUTPUT_STREAM_INVALID',
      title: 'ComfyUI 日志输出通道已失效',
      message: '当前 ComfyUI 进程由已关闭的终端启动，Turbo 节点写日志时被 Windows 中断。',
      suggestions: ['通过“npm run app”统一启动本地服务', '关闭旧 ComfyUI 进程后重新生成'],
      details,
    }
  }
  if (error?.payload?.node_errors || lower.includes('rejected the workflow')) {
    return {
      code: 'WORKFLOW_VALIDATION',
      title: '工作流校验失败',
      message: '本机节点或模型与当前工作流模板不匹配。',
      suggestions: ['打开任务日志查看缺失节点', '重新运行工作流契约检查'],
      details: { ...details, nodeErrors: error?.payload?.node_errors },
    }
  }
  if (error?.stage === 'seedvr2') {
    return {
      code: 'SEEDVR2_EXECUTION_ERROR',
      title: '时序精修失败，原生母片已保留',
      message,
      suggestions: ['直接使用已保留的 Base 母片', '查看 SeedVR2 节点日志', '重新检测模型后重试精修'],
      details,
    }
  }
  return {
    code: 'COMFY_EXECUTION_ERROR',
    title: '视频生成失败',
    message,
    suggestions: ['查看任务日志与节点信息', '使用快速预设重新生成'],
    details,
  }
}

function isOutOfMemoryFailure(error) {
  const message = String(error?.comfyData?.exception_message || error?.message || '').toLowerCase()
  return message.includes('out of memory') || message.includes('cuda oom') || message.includes('allocation on device')
}

async function runVideoJob(jobId, { signal }) {
  const job = store.get(jobId)
  if (!job) return
  let tracker
  const createdOutputPaths = new Set()
  const uploadedComfyInputPaths = new Set()
  const managedComfyInputRoot = buildManagedComfyLaunch({ args: localRuntimeConfig.comfyArgs }).directories.input
  const rememberComfyInput = (name) => {
    uploadedComfyInputPaths.add(assertManagedPrivatePath(join(managedComfyInputRoot, name), managedComfyInputRoot))
  }
  try {
    await store.update(jobId, {
      status: 'running',
      phase: 'queued',
      progress: 3,
      detail: '等待共享 GPU 执行器',
    })
    await store.update(jobId, {
      phase: 'preparing',
      progress: 4,
      detail: '检查本机 ComfyUI 环境',
    })
    await store.log(jobId, 'info', '已取得共享 GPU 执行器')
    await store.log(jobId, 'info', '正在检查并按策略准备 ComfyUI')
    await runtimeManager.ensureReady({ reason: `job:${jobId}` })
    runtimeCache = null
    const runtime = await inspectRuntime(true)
    if (!runtime.connected) throw new Error(runtime.message || 'ComfyUI connection failed')
    if (!runtime.ready) {
      const error = new Error(`Missing nodes: ${runtime.missingNodes.join(', ')}; missing models: ${runtime.missingModels.join(', ')}`)
      error.payload = { node_errors: { missingNodes: runtime.missingNodes, missingModels: runtime.missingModels } }
      throw error
    }
    const presetCapability = runtime.videoCapabilities?.presets?.find((candidate) => candidate.id === job.request.preset)
    if (!presetCapability?.available) {
      const error = Object.assign(new Error(`${VIDEO_PRESETS[job.request.preset].label} 所需模型或后处理器尚未就绪`), {
        code: 'VIDEO_PRESET_UNAVAILABLE',
        payload: {
          node_errors: {
            missingNodes: presetCapability?.postprocessor?.missingNodes || [],
            missingModels: presetCapability?.postprocessor?.missingModels || [],
          },
        },
      })
      throw error
    }
    const resolvedModelProfile = resolveVideoModelProfile(
      job.request.preset,
      runtime.videoCapabilities,
      job.request.modelProfile || AUTOMATIC_VIDEO_MODEL_PROFILE,
    )
    await store.log(jobId, 'success', `已连接 ComfyUI ${runtime.comfyVersion} · ${runtime.device}`)
    await store.log(jobId, 'info', `模型精度路由：${VIDEO_MODEL_PROFILES[resolvedModelProfile].label}`)

    let inputImageName
    let lastFrameImageName
    if (job.request.mode === 'image-to-video') {
      await store.update(jobId, { progress: 7, detail: '上传规范化首帧' })
      inputImageName = await comfy.uploadImage(job.inputPath, `aeonquill-${job.id}.png`, signal)
      rememberComfyInput(inputImageName)
      await store.log(jobId, 'success', `首帧已上传：${inputImageName}`)
      if (job.lastFramePath) {
        await store.update(jobId, { progress: 8, detail: '上传可选末帧约束' })
        lastFrameImageName = await comfy.uploadImage(job.lastFramePath, `aeonquill-${job.id}-last.png`, signal)
        rememberComfyInput(lastFrameImageName)
        await store.log(jobId, 'success', `末帧已上传：${lastFrameImageName}`)
      }
    }

    const { workflow, metadata } = await buildVideoWorkflow({
      ...job.request,
      modelProfile: resolvedModelProfile,
      inputImageName,
      lastFrameImageName,
      jobId,
    })
    assertAllowedWorkflow(workflow)
    await store.update(jobId, { workflowMetadata: metadata, progress: 9, detail: '提交受控 H3 工作流' })
    const clientId = `aeonquill-${randomUUID()}`
    tracker = await comfy.openExecutionTracker(clientId, (message) => reportComfyEvent(jobId, message))
    const queued = await comfy.queuePrompt(workflow, clientId, signal)
    await store.update(jobId, {
      comfyPromptId: queued.prompt_id,
      queueNumber: queued.number,
      phase: 'queued',
      progress: 10,
      detail: queued.number ? `已进入 ComfyUI 队列 · #${queued.number}` : '已进入 ComfyUI 队列',
    })
    await store.log(jobId, 'info', `ComfyUI Prompt ID：${queued.prompt_id}`)
    const history = await tracker.waitForPrompt(queued.prompt_id, signal)
    const latest = store.get(jobId)
    if (latest?.cancelRequested) return

    const needsSeedVr = metadata.delivery === '720p-seedvr2'
    await store.update(jobId, {
      phase: 'saving',
      progress: needsSeedVr ? 84 : 97,
      detail: needsSeedVr ? '保存 H3 原生母片，准备时序精修' : '复制生成结果到本地资产库',
    })
    const output = findVideoOutput(history)
    if (!output) throw new Error('ComfyUI finished without returning a video output')
    const response = await comfy.fetchOutput(output)
    const sourceAssetFilename = `${job.id}-native.mp4`
    const sourceAssetPath = join(assetDirectory, sourceAssetFilename)
    const sourceTemporaryPath = join(assetDirectory, `${job.id}.part.mp4`)
    await store.update(jobId, { outputPath: sourceAssetPath, temporaryOutputPath: sourceTemporaryPath })
    await writeFile(sourceTemporaryPath, Buffer.from(await response.arrayBuffer()), { flag: 'wx' })
    await rename(sourceTemporaryPath, sourceAssetPath)
    createdOutputPaths.add(sourceAssetPath)
    let assetFilename = sourceAssetFilename
    let finalAssetPath = sourceAssetPath
    let finalComfyOutput = output
    const intermediateOutputs = []
    if (metadata.delivery === '720p-lanczos') {
      assetFilename = `${job.id}-720p.mp4`
      finalAssetPath = join(assetDirectory, assetFilename)
      const deliveryTemporaryPath = join(assetDirectory, `${job.id}-720p.part.mp4`)
      await store.update(jobId, { phase: 'encoding', progress: 98, detail: '使用 FFmpeg 生成 720P 交付文件' })
      await store.update(jobId, { outputPath: finalAssetPath, temporaryOutputPath: deliveryTemporaryPath })
      await createDeliveryVideo(sourceAssetPath, deliveryTemporaryPath, metadata.deliveryDimensions, signal)
      await rename(deliveryTemporaryPath, finalAssetPath)
      createdOutputPaths.add(finalAssetPath)
      intermediateOutputs.push({
        role: 'native-source',
        label: 'H3 原生生成片',
        filename: sourceAssetFilename,
        outputUrl: `/api/assets/${encodeURIComponent(sourceAssetFilename)}`,
        dimensions: metadata.dimensions,
      })
      await store.log(jobId, 'success', `已生成 ${metadata.deliveryDimensions.width}×${metadata.deliveryDimensions.height} 交付文件`)
      await store.log(jobId, 'info', '已保留 H3 原生生成片，便于后续超分或重新编码')
    } else if (needsSeedVr) {
      intermediateOutputs.push({
        role: 'native-source',
        label: `H3 ${metadata.dimensions.width}×${metadata.dimensions.height} Base 母片`,
        filename: sourceAssetFilename,
        outputUrl: `/api/assets/${encodeURIComponent(sourceAssetFilename)}`,
        dimensions: metadata.dimensions,
      })
      await store.update(jobId, {
        phase: 'restoring',
        progress: 85,
        detail: '卸载 H3 模型，释放显存给 SeedVR2',
        intermediateOutputs,
      })
      await store.log(jobId, 'success', 'H3 Base 母片已保留，SeedVR2 失败也不会覆盖源片')
      tracker?.close()
      tracker = undefined
      await comfy.freeMemory(signal)
      const uploadedVideoName = await comfy.uploadVideo(sourceAssetPath, `aeonquill-${job.id}-native.mp4`, signal)
      rememberComfyInput(uploadedVideoName)
      const seedVrMemoryProfiles = [
        { framesPerChunk: 21, vaeTileSize: 384 },
        { framesPerChunk: 13, vaeTileSize: 256 },
        { framesPerChunk: 9, vaeTileSize: 192 },
        { framesPerChunk: 5, vaeTileSize: 128 },
      ]
      let postprocessOutput
      for (let attempt = 0; attempt < seedVrMemoryProfiles.length; attempt += 1) {
        const { framesPerChunk, vaeTileSize } = seedVrMemoryProfiles[attempt]
        try {
          const { workflow: postprocessWorkflow, metadata: postprocessMetadata } = buildSeedVr2VideoWorkflow({
            inputVideoName: uploadedVideoName,
            outputDimensions: metadata.deliveryDimensions,
            seed: job.request.seed,
            jobId,
            framesPerChunk,
            vaeTileSize,
          })
          assertAllowedVideoPostprocessWorkflow(postprocessWorkflow)
          await store.update(jobId, {
            workflowMetadata: { ...metadata, postprocessMetadata },
            progress: 86,
            detail: `提交 SeedVR2 时序修复 · ${framesPerChunk} 帧 / VAE ${vaeTileSize}`,
          })
          const postprocessClientId = `aeonquill-seedvr2-${randomUUID()}`
          tracker = await comfy.openExecutionTracker(postprocessClientId, (message) => reportSeedVrEvent(jobId, message))
          const queuedPostprocess = await comfy.queuePrompt(postprocessWorkflow, postprocessClientId, signal)
          await store.update(jobId, {
            comfyPromptId: queuedPostprocess.prompt_id,
            queueNumber: queuedPostprocess.number,
            phase: 'restoring',
            progress: 87,
            detail: queuedPostprocess.number ? `SeedVR2 已进入队列 · #${queuedPostprocess.number}` : 'SeedVR2 已进入执行队列',
          })
          await store.log(jobId, 'info', `SeedVR2 Prompt ID：${queuedPostprocess.prompt_id} · ${framesPerChunk} 帧 / VAE ${vaeTileSize}`)
          const postprocessHistory = await tracker.waitForPrompt(queuedPostprocess.prompt_id, signal)
          postprocessOutput = findVideoOutput(postprocessHistory)
          if (!postprocessOutput) throw new Error('SeedVR2 finished without returning a video output')
          break
        } catch (error) {
          tracker?.close()
          tracker = undefined
          const nextProfile = seedVrMemoryProfiles[attempt + 1]
          if (nextProfile && isOutOfMemoryFailure(error)) {
            await store.log(jobId, 'warning', `SeedVR2 ${framesPerChunk} 帧 / VAE ${vaeTileSize} 显存不足，自动降为 ${nextProfile.framesPerChunk} 帧 / VAE ${nextProfile.vaeTileSize}`)
            await store.update(jobId, {
              phase: 'restoring',
              progress: 88,
              detail: `释放显存并以 ${nextProfile.framesPerChunk} 帧 / VAE ${nextProfile.vaeTileSize} 重试`,
            })
            await comfy.freeMemory(signal)
            continue
          }
          error.stage = 'seedvr2'
          throw error
        }
      }
      if (!postprocessOutput) {
        throw Object.assign(new Error('SeedVR2 exhausted every bounded temporal chunk size'), { stage: 'seedvr2' })
      }
      const postprocessResponse = await comfy.fetchOutput(postprocessOutput)
      assetFilename = `${job.id}-seedvr2-720p.mp4`
      finalAssetPath = join(assetDirectory, assetFilename)
      const restoredTemporaryPath = join(assetDirectory, `${job.id}-seedvr2-720p.part.mp4`)
      await store.update(jobId, { outputPath: finalAssetPath, temporaryOutputPath: restoredTemporaryPath })
      await writeFile(restoredTemporaryPath, Buffer.from(await postprocessResponse.arrayBuffer()), { flag: 'wx' })
      await rename(restoredTemporaryPath, finalAssetPath)
      createdOutputPaths.add(finalAssetPath)
      finalComfyOutput = postprocessOutput
      await store.log(jobId, 'success', `SeedVR2 时序母版已生成：${metadata.deliveryDimensions.width}×${metadata.deliveryDimensions.height}`)
    }
    await store.log(jobId, 'success', `视频已保存：${finalComfyOutput.subfolder ? `${finalComfyOutput.subfolder}/` : ''}${finalComfyOutput.filename}`)
    const outputVersion = await describeOutputVersion(job, finalAssetPath, 'video/mp4')
    const delivery = await deliverConfiguredOutput(jobId, finalAssetPath, assetFilename)
    await store.update(jobId, {
      status: 'completed',
      phase: 'completed',
      progress: 100,
      detail: '生成完成，已回填画布',
      outputUrl: `/api/assets/${encodeURIComponent(assetFilename)}`,
      output: {
        filename: finalComfyOutput.filename,
        subfolder: finalComfyOutput.subfolder || '',
        type: finalComfyOutput.type || 'output',
      },
      outputVersion,
      intermediateOutputs,
      delivery,
      completedAt: Date.now(),
      temporaryOutputPath: undefined,
    })
  } catch (error) {
    const latest = store.get(jobId)
    if (signal.reason?.code === 'JOB_TIMEOUT') throw error
    if (error.name === 'AbortError' || latest?.cancelRequested || signal.reason?.code === 'JOB_CANCELLED') {
      if (latest?.status !== 'cancelled') {
        await store.update(jobId, {
          status: 'cancelled',
          phase: 'cancelled',
          detail: '任务已取消',
        })
      }
      await store.log(jobId, 'warning', '任务已由用户取消')
      return
    }
    const normalized = normalizeExecutionError(error)
    await store.log(jobId, 'error', `${normalized.code}：${normalized.title}`)
    await store.update(jobId, {
      status: 'failed',
      phase: 'failed',
      detail: normalized.title,
      error: normalized,
    })
  } finally {
    tracker?.close()
    const latest = store.get(jobId)
    if (latest?.status !== 'completed') {
      const retainedIntermediates = new Set((latest?.intermediateOutputs || []).map((item) => join(assetDirectory, item.filename)))
      for (const filePath of createdOutputPaths) {
        if (!retainedIntermediates.has(filePath)) await unlink(filePath).catch(() => {})
      }
      if (latest?.temporaryOutputPath) await unlink(latest.temporaryOutputPath).catch(() => {})
    }
    for (const uploadedPath of uploadedComfyInputPaths) await unlink(uploadedPath).catch(() => {})
    await scheduleRuntimeIdleStop()
  }
}

async function runtimeIsIdle() {
  const localBusy = store.list().some((job) => ['queued', 'running'].includes(job.status))
  if (localBusy) return false
  try {
    const queue = await comfy.queueState()
    return (queue.queue_running?.length || 0) === 0 && (queue.queue_pending?.length || 0) === 0
  } catch {
    return true
  }
}

async function scheduleRuntimeIdleStop() {
  const scheduled = await runtimeManager.scheduleIdleStop(runtimeIsIdle)
  if (scheduled) {
    runtimeCache = null
    broadcast({ type: 'runtime.updated', runtime: await inspectRuntime(true) })
  }
}

function existingIdempotentJob(kind, idempotencyKey, requestHashValue) {
  const existing = store.findByIdempotencyKey(idempotencyKey)
  if (!existing) return null
  if (existing.kind !== kind || existing.requestHash !== requestHashValue) {
    throw Object.assign(new Error('Idempotency key is already bound to a different request'), {
      code: 'IDEMPOTENCY_CONFLICT',
      status: 409,
    })
  }
  return existing
}

async function createVideoJob(body, retrySource, options = {}) {
  const request = retrySource ? { ...retrySource.request, preset: 'fast' } : validateVideoRequest(body)
  const attempt = retrySource ? (retrySource.scheduling?.attempt || 1) + 1 : 1
  const idempotencyKey = resolveIdempotencyKey(options.idempotencyKey)
  const requestHashValue = retrySource
    ? hashRequest('video-retry', { sourceJobId: retrySource.id, sourceRequestHash: retrySource.requestHash, attempt })
    : hashRequest('video', body)
  const existing = existingIdempotentJob('video', idempotencyKey, requestHashValue)
  if (existing) return { job: store.publicJob(existing), reused: true }
  await assertStorageCapacity(runtimeDirectory, estimateVideoStorageBytes(request))
  let inputPath = retrySource?.inputPath ? assertManagedPrivatePath(retrySource.inputPath, inputDirectory) : undefined
  let lastFramePath = retrySource?.lastFramePath
    ? assertManagedPrivatePath(retrySource.lastFramePath, inputDirectory)
    : undefined
  const job = newJob(request, inputPath, lastFramePath, {
    idempotencyKey,
    requestHash: requestHashValue,
    priority: options.priority,
    attempt,
    retryOf: retrySource?.id,
  })
  const createdInputPaths = []
  if (request.mode === 'image-to-video' && !inputPath) {
    const bytes = decodeImageDataUrl(body.sourceImageDataUrl)
    inputPath = join(inputDirectory, `${job.id}.png`)
    await writeFile(inputPath, bytes, { flag: 'wx' })
    createdInputPaths.push(inputPath)
    job.inputPath = inputPath
  }
  if (request.mode === 'image-to-video' && request.hasLastFrame && !lastFramePath) {
    const bytes = decodeImageDataUrl(body.lastFrameImageDataUrl)
    lastFramePath = join(inputDirectory, `${job.id}-last.png`)
    await writeFile(lastFramePath, bytes, { flag: 'wx' })
    createdInputPaths.push(lastFramePath)
    job.lastFramePath = lastFramePath
  }
  const added = await store.addIdempotent(job)
  if (!added.created) {
    for (const filePath of createdInputPaths) await unlink(filePath).catch(() => {})
    return { job: store.publicJob(added.job), reused: true }
  }
  await scheduler.enqueue(job.id)
  return { job: store.publicJob(store.get(job.id)), reused: false }
}

async function createImageJob(body, retrySource, options = {}) {
  const capabilities = await imageProcessor.probe()
  const request = retrySource
    ? validateImageRequest({
        operation: retrySource.request?.operation,
        params: retrySource.request?.params,
        sourceElementId: retrySource.sourceElementId,
      }, capabilities)
    : validateImageRequest(body, capabilities)
  const attempt = retrySource ? (retrySource.scheduling?.attempt || 1) + 1 : 1
  const idempotencyKey = resolveIdempotencyKey(options.idempotencyKey)
  const requestHashValue = retrySource
    ? hashRequest('image-retry', { sourceJobId: retrySource.id, sourceRequestHash: retrySource.requestHash, attempt })
    : hashRequest('image', body)
  const existing = existingIdempotentJob('image', idempotencyKey, requestHashValue)
  if (existing) return { job: store.publicJob(existing), reused: true }
  let inputPath = retrySource?.inputPath ? assertManagedPrivatePath(retrySource.inputPath, inputDirectory) : undefined
  let maskPath = retrySource?.maskPath ? assertManagedPrivatePath(retrySource.maskPath, inputDirectory) : undefined
  const decoded = inputPath ? null : decodeImageAssetDataUrl(body.sourceImageDataUrl)
  const decodedMask = request.operation === 'masked-adjust' && !maskPath
    ? decodeImageAssetDataUrl(body.maskImageDataUrl)
    : null
  await assertStorageCapacity(runtimeDirectory, Math.max(
    64 * 1024 * 1024,
    ((decoded?.bytes.length || 0) + (decodedMask?.bytes.length || 0)) * 8,
  ))
  const job = newImageJob(request, inputPath, {
    idempotencyKey,
    requestHash: requestHashValue,
    priority: options.priority,
    attempt,
    retryOf: retrySource?.id,
    maskPath,
  })
  const createdInputPaths = []
  try {
    if (!inputPath) {
      inputPath = join(inputDirectory, `${job.id}.${decoded.extension}`)
      await writeFile(inputPath, decoded.bytes, { flag: 'wx' })
      createdInputPaths.push(inputPath)
      job.inputPath = inputPath
    }
    if (!maskPath && decodedMask) {
      maskPath = join(inputDirectory, `${job.id}-mask.${decodedMask.extension}`)
      await writeFile(maskPath, decodedMask.bytes, { flag: 'wx' })
      createdInputPaths.push(maskPath)
      job.maskPath = maskPath
    }
    const added = await store.addIdempotent(job)
    if (!added.created) {
      for (const filePath of createdInputPaths) await unlink(filePath).catch(() => {})
      return { job: store.publicJob(added.job), reused: true }
    }
    await scheduler.enqueue(job.id)
    return { job: store.publicJob(store.get(job.id)), reused: false }
  } catch (error) {
    for (const filePath of createdInputPaths) await unlink(filePath).catch(() => {})
    throw error
  }
}

async function createSemanticImageJob(body, retrySource, options = {}) {
  const request = retrySource
    ? structuredClone(retrySource.request)
    : validateElementExtractRequest(body)
  if (request.operation !== SEMANTIC_ELEMENT_EXTRACT_OPERATION) {
    throw Object.assign(new Error('Stored semantic image task is not executable'), {
      status: 409,
      code: 'SEMANTIC_WORKFLOW_NOT_EXECUTABLE',
    })
  }
  const attempt = retrySource ? (retrySource.scheduling?.attempt || 1) + 1 : 1
  const idempotencyKey = resolveIdempotencyKey(options.idempotencyKey)
  const requestHashValue = retrySource
    ? hashRequest('semantic-image-retry', {
        sourceJobId: retrySource.id,
        sourceRequestHash: retrySource.requestHash,
        attempt,
      })
    : hashRequest('semantic-image', body)
  const existing = existingIdempotentJob('image', idempotencyKey, requestHashValue)
  if (existing) return { job: store.publicJob(existing), reused: true }

  let inputPath = retrySource?.inputPath
    ? assertManagedPrivatePath(retrySource.inputPath, inputDirectory)
    : undefined
  const decoded = inputPath ? null : decodeImageAssetDataUrl(body.sourceImageDataUrl)
  await assertStorageCapacity(runtimeDirectory, Math.max(128 * 1024 * 1024, (decoded?.bytes.length || 0) * 12))
  const job = newImageJob(request, inputPath, {
    idempotencyKey,
    requestHash: requestHashValue,
    priority: options.priority ?? 55,
    attempt,
    retryOf: retrySource?.id,
  })
  const createdInputPaths = []
  if (!inputPath) {
    inputPath = join(inputDirectory, `${job.id}.${decoded.extension}`)
    await writeFile(inputPath, decoded.bytes, { flag: 'wx' })
    createdInputPaths.push(inputPath)
    job.inputPath = inputPath
  }
  const added = await store.addIdempotent(job)
  if (!added.created) {
    for (const filePath of createdInputPaths) await unlink(filePath).catch(() => {})
    return { job: store.publicJob(added.job), reused: true }
  }
  await scheduler.enqueue(job.id)
  return { job: store.publicJob(store.get(job.id)), reused: false }
}

function queueContains(queue, promptId) {
  return (queue || []).some((entry) => Array.isArray(entry) && entry[1] === promptId)
}

async function cancelJob(job) {
  if (!job || ['completed', 'failed', 'cancelled'].includes(job.status)) return job
  await store.update(job.id, {
    status: 'cancelled',
    phase: 'cancelled',
    cancelRequested: true,
    detail: '正在取消任务',
  })
  scheduler.cancel(job.id)
  if (job.comfyPromptId) {
    try {
      const queue = await comfy.queueState()
      if (queueContains(queue.queue_pending, job.comfyPromptId)) {
        await comfy.removePendingPrompt(job.comfyPromptId)
      } else if (queueContains(queue.queue_running, job.comfyPromptId)) {
        await comfy.interrupt()
      }
    } catch (error) {
      await store.log(job.id, 'warning', `取消信号未完全送达 ComfyUI：${error.message}`)
    }
  }
  await store.update(job.id, { status: 'cancelled', phase: 'cancelled', detail: '任务已取消' })
  return store.get(job.id)
}

async function cleanupTerminalJobInputs(jobs) {
  for (const job of jobs) {
    for (const candidate of [job.inputPath, job.maskPath, job.lastFramePath, job.temporaryOutputPath]) {
      if (!candidate) continue
      try {
        const root = candidate === job.temporaryOutputPath ? assetDirectory : inputDirectory
        await unlink(assertManagedPrivatePath(candidate, root)).catch(() => {})
      } catch {
        // Legacy unmanaged paths are ignored and never deleted by the bridge.
      }
    }
  }
}

function broadcast(payload) {
  const data = `data: ${JSON.stringify(sanitizePublicPayload(payload))}\n\n`
  for (const response of sseClients) response.write(data)
}

store.subscribe((job) => broadcast({ type: 'job.updated', job }))
runtimeManager.subscribe(() => {
  runtimeCache = null
  void inspectRuntime(true)
    .then((runtime) => broadcast({ type: 'runtime.updated', runtime }))
    .catch(() => {})
})

async function prepareRecoveredJobs() {
  for (const job of store.list()) {
    if (job.error?.code === 'BRIDGE_RESTARTED') {
      for (const candidate of [job.outputPath, job.temporaryOutputPath]) {
        if (!candidate) continue
        try {
          await unlink(assertManagedPrivatePath(candidate, assetDirectory)).catch(() => {})
        } catch {
          // Ignore legacy unmanaged paths; they remain private and are never exposed as outputs.
        }
      }
      await store.update(job.id, { outputPath: undefined, temporaryOutputPath: undefined })
    }
    if (job.status !== 'queued' || job.scheduling?.schemaVersion === 1) continue
    const resourceClass = job.kind === 'video' || gpuImageOperations.has(job.request?.operation) ? 'gpu' : 'cpu'
    await store.update(job.id, {
      requestHash: job.requestHash || hashRequest(`legacy-${job.kind || 'job'}`, job.request || {}),
      scheduling: createScheduling({
        resourceClass,
        priority: job.kind === 'video' ? 50 : resourceClass === 'gpu' ? 60 : 70,
        timeoutMs: job.kind === 'video' ? 2 * 60 * 60 * 1_000 : resourceClass === 'gpu' ? 25 * 60_000 : 10 * 60_000,
        idempotencyKey: `legacy-${job.id}`,
        queuedAt: job.createdAt || Date.now(),
      }),
      costEvents: job.costEvents || [createEstimateCostEvent(
        job.id,
        resourceClass,
        job.kind === 'video' ? estimateVideoMilliseconds(job.request) : resourceClass === 'gpu' ? 5 * 60_000 : 60_000,
        job.createdAt || Date.now(),
      )],
    })
  }
}

scheduler.register('image', runImageJob).register('video', runVideoJob)
await prepareRecoveredJobs()
await scheduler.recover()

const heartbeat = setInterval(() => {
  for (const response of sseClients) response.write(': heartbeat\n\n')
}, 15_000)
heartbeat.unref()

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
}

async function serveVideoAsset(request, response, filename) {
  const filePath = resolveSafeChildPath(assetDirectory, filename, {
    extensions: new Set(['.png', '.jpg', '.jpeg', '.webp', '.mp4']),
  })
  let fileStats
  try {
    fileStats = await stat(filePath)
  } catch {
    return sendError(response, 404, 'ASSET_NOT_FOUND', 'Video asset was not found')
  }
  const range = request.headers.range
  const headers = {
    'content-type': mimeTypes[extname(filePath).toLowerCase()] || 'application/octet-stream',
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=3600',
  }
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (!match) return sendError(response, 416, 'INVALID_RANGE', 'Invalid range request')
    const start = match[1] ? Number(match[1]) : 0
    const end = match[2] ? Math.min(Number(match[2]), fileStats.size - 1) : fileStats.size - 1
    if (start > end || start >= fileStats.size) return sendError(response, 416, 'INVALID_RANGE', 'Range is outside the asset')
    response.writeHead(206, {
      ...headers,
      'content-range': `bytes ${start}-${end}/${fileStats.size}`,
      'content-length': end - start + 1,
    })
    createReadStream(filePath, { start, end }).pipe(response)
    return
  }
  response.writeHead(200, { ...headers, 'content-length': fileStats.size })
  createReadStream(filePath).pipe(response)
}

async function serveProjectAsset(request, response, assetId, requestedVariant) {
  const asset = projectStore.getAsset(decodeURIComponent(assetId))
  if (!asset) return sendError(response, 404, 'ASSET_NOT_FOUND', 'Project asset was not found')
  let filePath = projectStore.assetPath(asset)
  let contentType = asset.mimeType
  let cacheControl = 'private, max-age=31536000, immutable'
  let etag = `"sha256-${asset.id}"`
  let servedTier = 'original'
  if (requestedVariant) {
    try {
      const derived = await assetPreviewService.materialize({
        assetId: asset.id,
        inputPath: filePath,
        mimeType: asset.mimeType,
      }, requestedVariant)
      filePath = derived.path
      contentType = 'image/webp'
      etag = `"sha256-${asset.id}-${derived.variant}"`
      servedTier = derived.variant
    } catch (error) {
      if (!['ASSET_PREVIEW_UNAVAILABLE', 'ASSET_PREVIEW_FAILED', 'ASSET_PREVIEW_TIMEOUT', 'ASSET_PREVIEW_INVALID'].includes(error.code)) {
        throw error
      }
      cacheControl = 'private, max-age=60'
      servedTier = 'original-fallback'
      console.warn(`[${error.code}] ${redactSensitiveText(error.message)}`)
    }
  }
  let fileStats
  try {
    fileStats = await stat(filePath)
  } catch {
    return sendError(response, 404, 'ASSET_NOT_FOUND', 'Project asset file was not found')
  }
  const headers = {
    'content-type': contentType,
    'accept-ranges': 'bytes',
    'cache-control': cacheControl,
    etag,
    'x-miaohui-asset-tier': servedTier,
  }
  if (request.method === 'HEAD') {
    response.writeHead(200, { ...headers, 'content-length': fileStats.size })
    response.end()
    return
  }
  const range = request.headers.range
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (!match) return sendError(response, 416, 'INVALID_RANGE', 'Invalid range request')
    const start = match[1] ? Number(match[1]) : 0
    const end = match[2] ? Math.min(Number(match[2]), fileStats.size - 1) : fileStats.size - 1
    if (start > end || start >= fileStats.size) return sendError(response, 416, 'INVALID_RANGE', 'Range is outside the asset')
    response.writeHead(206, {
      ...headers,
      'content-range': `bytes ${start}-${end}/${fileStats.size}`,
      'content-length': end - start + 1,
    })
    createReadStream(filePath, { start, end }).pipe(response)
    return
  }
  response.writeHead(200, { ...headers, 'content-length': fileStats.size })
  createReadStream(filePath).pipe(response)
}

async function resolveProjectAssetReference(reference) {
  let root
  let filename
  if (reference.startsWith('/api/assets/')) {
    root = assetDirectory
    filename = decodeURIComponent(reference.slice('/api/assets/'.length))
  } else if (reference.startsWith('/assets/')) {
    root = join(distDirectory, 'assets')
    filename = decodeURIComponent(reference.slice('/assets/'.length))
  } else if (reference.startsWith('/src/assets/')) {
    root = join(projectRoot, 'src', 'assets')
    filename = decodeURIComponent(reference.slice('/src/assets/'.length))
  } else {
    return null
  }
  const filePath = resolveSafeChildPath(root, filename, {
    extensions: new Set(['.png', '.jpg', '.jpeg', '.webp', '.mp4', '.mp3', '.wav']),
  })
  const bytes = await readFile(filePath)
  const extension = extname(filePath).toLowerCase().replace(/^\./, '').replace('jpeg', 'jpg')
  const mimeType = mimeTypes[extname(filePath).toLowerCase()]?.split(';')[0]
  return { bytes, extension, mimeType }
}

async function serveStatic(response, pathname) {
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '')
  let filePath = resolve(distDirectory, requested)
  if (!filePath.startsWith(resolve(distDirectory) + sep) && filePath !== resolve(distDirectory, 'index.html')) {
    return sendError(response, 403, 'FORBIDDEN', 'Invalid path')
  }
  try {
    const fileStats = await stat(filePath)
    if (!fileStats.isFile()) throw new Error('Not a file')
  } catch {
    filePath = resolve(distDirectory, 'index.html')
  }
  try {
    const body = await readFile(filePath)
    response.writeHead(200, {
      'content-type': mimeTypes[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'content-length': body.length,
      'cache-control': filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
    })
    response.end(body)
  } catch {
    sendError(response, 503, 'FRONTEND_NOT_BUILT', 'Frontend build was not found. Run npm run build first.')
  }
}

const server = createServer(async (request, response) => {
  try {
    security.applyResponseHeaders(request, response)
    security.assertHost(request)
    const url = new URL(request.url || '/', `http://${request.headers.host || `${host}:${port}`}`)
    const pathname = url.pathname
    if (request.method === 'OPTIONS') {
      return security.handlePreflight(request, response)
    }
    if (request.method === 'GET' && pathname === '/api/health') {
      security.assertTrustedBrowserSource(request)
      security.issueSession(response)
      return sendJson(response, 200, { ok: true, service: 'miaohui-local-bridge', version: WORKFLOW_VERSION })
    }
    if (pathname.startsWith('/api/')) {
      security.assertTrustedBrowserSource(request)
      security.requireSession(request)
    }
    if (request.method === 'GET' && pathname === '/api/runtime/status') {
      return sendJson(response, 200, await inspectRuntime(url.searchParams.get('refresh') === '1'))
    }
    if (request.method === 'GET' && pathname === '/api/runtime/diagnostics') {
      return sendJson(response, 200, await inspectRuntimeDiagnostics(url.searchParams.get('refresh') === '1'))
    }
    if (request.method === 'POST' && pathname === '/api/runtime/config') {
      const body = await readJsonBody(request, 16 * 1024)
      const { config, patch, recoveredInvalidConfig } = await persistRuntimeSettings(body)
      if (recoveredInvalidConfig) {
        localRuntimeConfig.configReadError = undefined
      } else if (localRuntimeConfig.configReadError?.code === 'INVALID_COMFY_URL') {
        try {
          normalizeLoopbackComfyUrl(config.comfyUrl || 'http://127.0.0.1:8188')
          localRuntimeConfig.configReadError = undefined
        } catch {
          // Preserve the startup validation error until the persisted URL is repaired.
        }
      }
      if (patch.comfyLaunchPolicy !== undefined || patch.comfyIdleSeconds !== undefined) {
        await runtimeManager.setPolicy(
          patch.comfyLaunchPolicy ?? runtimeManager.status().policy,
          patch.comfyIdleSeconds,
        )
      }
      if (patch.outputDirectory !== undefined) {
        if (patch.outputDirectory === null) {
          localRuntimeConfig.outputDirectory = localRuntimeConfig.defaultOutputDirectory
          localRuntimeConfig.outputDirectorySource = 'application'
        } else {
          localRuntimeConfig.outputDirectory = patch.outputDirectory
          localRuntimeConfig.outputDirectorySource = 'custom'
        }
      }
      runtimeCache = null
      const diagnostics = await inspectRuntimeDiagnostics(true, config)
      const restartRequired = diagnostics.configuration.restartRequired
      return sendJson(response, 200, {
        saved: true,
        restartRequired,
        recoveredInvalidConfig,
        message: recoveredInvalidConfig
          ? '损坏的旧配置已备份，并已写入有效设置；建议重新打开 AEONQUILL。'
          : restartRequired
          ? '配置已安全保存；退出并重新打开 AEONQUILL 后生效。'
          : patch.outputDirectory !== undefined
          ? patch.outputDirectory === null
            ? '已恢复软件 output 默认目录；后续交付文件会继续自动写入。'
            : '输出副本目录已保存并立即生效。'
          : '运行策略已保存并立即生效。',
        diagnostics,
      })
    }
    if (request.method === 'POST' && pathname === '/api/runtime/start') {
      const gpuSchedule = scheduler.snapshot().resources.gpu
      const imageGpuBusy = [...gpuSchedule.activeJobs, ...gpuSchedule.queuedJobs]
        .some((jobId) => store.get(jobId)?.kind === 'image')
      if (imageGpuBusy) {
        return sendError(response, 409, 'GPU_RESOURCE_BUSY', '本机图片模型正在使用显卡，请等待任务结束后再启动 ComfyUI')
      }
      await runtimeManager.ensureReady({ reason: 'manual-ui' })
      runtimeCache = null
      return sendJson(response, 200, await inspectRuntime(true))
    }
    if (request.method === 'POST' && pathname === '/api/runtime/stop') {
      if (!(await runtimeIsIdle())) return sendError(response, 409, 'RUNTIME_BUSY', '仍有本地或 ComfyUI 队列任务，当前不能关闭')
      await runtimeManager.stop('manual-ui')
      runtimeCache = null
      return sendJson(response, 200, await inspectRuntime(true))
    }
    if (request.method === 'POST' && pathname === '/api/runtime/policy') {
      const body = await readJsonBody(request, 16 * 1024)
      await runtimeManager.setPolicy(body.policy, body.idleSeconds)
      await scheduleRuntimeIdleStop()
      runtimeCache = null
      return sendJson(response, 200, await inspectRuntime(true))
    }
    if (request.method === 'GET' && pathname === '/api/workspace/catalog') {
      return sendJson(response, 200, workspaceStore.getCatalog())
    }
    if (request.method === 'PUT' && pathname === '/api/workspace/catalog') {
      const body = await readJsonBody(request, 3 * 1024 * 1024)
      const allowed = new Set(['catalog', 'baseRevision', 'source'])
      if (
        !body
        || typeof body !== 'object'
        || Array.isArray(body)
        || Object.keys(body).some((key) => !allowed.has(key))
        || !('catalog' in body)
        || !('baseRevision' in body)
        || (body.source !== undefined && (typeof body.source !== 'string' || body.source.length > 80))
      ) {
        return sendError(response, 400, 'INVALID_WORKSPACE_CATALOG_REQUEST', '项目目录请求字段无效')
      }
      return sendJson(response, 200, workspaceStore.saveCatalog(body.catalog, {
        baseRevision: body.baseRevision,
        source: body.source || 'client',
      }))
    }
    const workspaceDocumentMatch = /^\/api\/workspace\/documents\/([^/]+)$/u.exec(pathname)
    if (request.method === 'GET' && workspaceDocumentMatch) {
      const document = workspaceStore.getModeDocument(decodeURIComponent(workspaceDocumentMatch[1]))
      if (document && url.searchParams.get('projectId') && document.projectId !== url.searchParams.get('projectId')) {
        return sendError(response, 409, 'WORKSPACE_DOCUMENT_OWNERSHIP_CHANGE', '项目文档不属于请求的项目')
      }
      if (document && url.searchParams.get('modeId') && document.modeId !== url.searchParams.get('modeId')) {
        return sendError(response, 409, 'WORKSPACE_MODE_MISMATCH', '项目文档模式与请求不一致')
      }
      return sendJson(response, 200, { document })
    }
    if (request.method === 'PUT' && workspaceDocumentMatch) {
      const body = await readJsonBody(request, 72 * 1024 * 1024)
      const allowed = new Set(['projectId', 'modeId', 'baseRevision', 'revision', 'value', 'reason', 'forceRecovery'])
      if (
        !body
        || typeof body !== 'object'
        || Array.isArray(body)
        || Object.keys(body).some((key) => !allowed.has(key))
        || ['projectId', 'modeId', 'baseRevision', 'revision', 'value'].some((key) => !(key in body))
        || (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > 120))
        || (body.forceRecovery !== undefined && typeof body.forceRecovery !== 'boolean')
      ) {
        return sendError(response, 400, 'INVALID_MODE_DOCUMENT_REQUEST', '模式文档请求字段无效')
      }
      const document = workspaceStore.saveModeDocument({
        ...body,
        documentId: decodeURIComponent(workspaceDocumentMatch[1]),
      }, {
        reason: body.reason,
        forceRecovery: body.forceRecovery,
      })
      return sendJson(response, 200, { document })
    }
    const workspaceRecoveriesMatch = /^\/api\/workspace\/projects\/([^/]+)\/recovery-points$/u.exec(pathname)
    if (request.method === 'GET' && workspaceRecoveriesMatch) {
      return sendJson(response, 200, {
        recoveryPoints: workspaceStore.listRecoveryPoints(decodeURIComponent(workspaceRecoveriesMatch[1])),
      })
    }
    if (request.method === 'POST' && workspaceRecoveriesMatch) {
      const body = await readJsonBody(request, 16 * 1024)
      const allowed = new Set(['documentId', 'reason'])
      if (
        !body
        || typeof body !== 'object'
        || Array.isArray(body)
        || Object.keys(body).some((key) => !allowed.has(key))
        || (body.documentId !== undefined && typeof body.documentId !== 'string')
        || (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > 120))
      ) {
        return sendError(response, 400, 'INVALID_RECOVERY_POINT_REQUEST', '恢复点请求字段无效')
      }
      return sendJson(response, 201, {
        recoveryPoint: workspaceStore.createRecoveryPoint(
          decodeURIComponent(workspaceRecoveriesMatch[1]),
          { documentId: body.documentId, reason: body.reason },
        ),
      })
    }
    const workspaceRestoreMatch = /^\/api\/workspace\/recovery-points\/([^/]+)\/restore$/u.exec(pathname)
    if (request.method === 'POST' && workspaceRestoreMatch) {
      const restored = workspaceStore.restoreRecoveryPoint(decodeURIComponent(workspaceRestoreMatch[1]))
      if (restored.document?.modeId === 'balanced') {
        await projectStore.saveProject(JSON.parse(restored.document.value), {
          source: 'workspace-recovery-restore',
          resolveAssetReference: resolveProjectAssetReference,
        })
      }
      return sendJson(response, 200, {
        restored,
      })
    }
    const libraryCollectionPath = pathname === '/api/library/collections'
    if (request.method === 'GET' && libraryCollectionPath) {
      const scope = url.searchParams.get('scope') || 'global'
      const projectId = url.searchParams.get('projectId') || undefined
      if (scope === 'project' && !workspaceStore.getCatalog().catalog.projects.some(({ id }) => id === projectId)) {
        return sendError(response, 404, 'WORKSPACE_PROJECT_NOT_FOUND', '资源库所属项目不存在')
      }
      return sendJson(response, 200, {
        collections: projectStore.listLibraryCollections({ scope, projectId }),
      })
    }
    if (request.method === 'POST' && libraryCollectionPath) {
      const body = await readJsonBody(request, 32 * 1024)
      const allowed = new Set(['scope', 'projectId', 'title'])
      if (
        !body
        || typeof body !== 'object'
        || Array.isArray(body)
        || Object.keys(body).some((key) => !allowed.has(key))
        || !('scope' in body)
        || !('title' in body)
      ) {
        return sendError(response, 400, 'INVALID_LIBRARY_COLLECTION_REQUEST', '资源集合请求字段无效')
      }
      if (body.scope === 'project' && !workspaceStore.getCatalog().catalog.projects.some(({ id }) => id === body.projectId)) {
        return sendError(response, 404, 'WORKSPACE_PROJECT_NOT_FOUND', '资源集合所属项目不存在')
      }
      return sendJson(response, 201, {
        collection: projectStore.createLibraryCollection(body, { source: 'library-api' }),
      })
    }
    if (request.method === 'GET' && pathname === '/api/library/assets') {
      const scope = url.searchParams.get('scope') || 'global'
      const projectId = url.searchParams.get('projectId') || undefined
      if (scope === 'project' && !workspaceStore.getCatalog().catalog.projects.some(({ id }) => id === projectId)) {
        return sendError(response, 404, 'WORKSPACE_PROJECT_NOT_FOUND', '资源库所属项目不存在')
      }
      const tags = url.searchParams.getAll('tag')
      return sendJson(response, 200, {
        assets: projectStore.listLibraryAssets({
          scope,
          projectId,
          query: url.searchParams.get('q') || undefined,
          tags,
          collectionId: url.searchParams.get('collectionId') || undefined,
        }),
      })
    }
    if (request.method === 'POST' && pathname === '/api/library/assets') {
      const body = await readJsonBody(request, 96 * 1024 * 1024)
      const allowed = new Set(['scope', 'projectId', 'title', 'description', 'tags', 'collectionIds', 'dataUrl'])
      if (
        !body
        || typeof body !== 'object'
        || Array.isArray(body)
        || Object.keys(body).some((key) => !allowed.has(key))
        || !('scope' in body)
        || !('title' in body)
        || !('dataUrl' in body)
      ) {
        return sendError(response, 400, 'INVALID_LIBRARY_ASSET_REQUEST', '资源导入请求字段无效')
      }
      if (body.scope === 'project' && !workspaceStore.getCatalog().catalog.projects.some(({ id }) => id === body.projectId)) {
        return sendError(response, 404, 'WORKSPACE_PROJECT_NOT_FOUND', '资源所属项目不存在')
      }
      return sendJson(response, 201, {
        asset: await projectStore.createLibraryAsset(body, { source: 'user-library-import' }),
      })
    }
    const libraryAssetMatch = /^\/api\/library\/assets\/([^/]+)$/u.exec(pathname)
    if (request.method === 'GET' && libraryAssetMatch) {
      const projectId = url.searchParams.get('projectId') || undefined
      const asset = projectStore.getLibraryAsset(decodeURIComponent(libraryAssetMatch[1]), projectId ? { projectId } : {})
      if (!asset) return sendError(response, 404, 'LIBRARY_ITEM_NOT_FOUND', '资源库素材不存在')
      return sendJson(response, 200, { asset })
    }
    if (request.method === 'PATCH' && libraryAssetMatch) {
      const body = await readJsonBody(request, 48 * 1024)
      const allowed = new Set(['projectId', 'title', 'description', 'tags', 'collectionIds'])
      if (
        !body
        || typeof body !== 'object'
        || Array.isArray(body)
        || Object.keys(body).some((key) => !allowed.has(key))
      ) {
        return sendError(response, 400, 'INVALID_LIBRARY_METADATA_REQUEST', '资源元数据请求字段无效')
      }
      return sendJson(response, 200, {
        asset: projectStore.updateLibraryAssetMetadata(decodeURIComponent(libraryAssetMatch[1]), body),
      })
    }
    const libraryLinkMatch = /^\/api\/library\/assets\/([^/]+)\/link-project$/u.exec(pathname)
    if (request.method === 'POST' && libraryLinkMatch) {
      const body = await readJsonBody(request, 16 * 1024)
      const allowed = new Set(['projectId', 'versionId'])
      if (
        !body
        || typeof body !== 'object'
        || Array.isArray(body)
        || Object.keys(body).some((key) => !allowed.has(key))
        || typeof body.projectId !== 'string'
      ) {
        return sendError(response, 400, 'INVALID_LIBRARY_LINK_REQUEST', '资源加入项目请求字段无效')
      }
      if (!workspaceStore.getCatalog().catalog.projects.some(({ id }) => id === body.projectId)) {
        return sendError(response, 404, 'WORKSPACE_PROJECT_NOT_FOUND', '目标项目不存在')
      }
      return sendJson(response, 200, {
        asset: projectStore.linkLibraryAssetToProject(
          decodeURIComponent(libraryLinkMatch[1]),
          body.projectId,
          body.versionId,
        ),
      })
    }
    const libraryDeriveMatch = /^\/api\/library\/assets\/([^/]+)\/derive$/u.exec(pathname)
    if (request.method === 'POST' && libraryDeriveMatch) {
      const body = await readJsonBody(request, 96 * 1024 * 1024)
      const allowed = new Set([
        'projectId', 'sourceVersionId', 'title', 'description', 'tags', 'collectionIds', 'dataUrl',
      ])
      if (
        !body
        || typeof body !== 'object'
        || Array.isArray(body)
        || Object.keys(body).some((key) => !allowed.has(key))
        || typeof body.projectId !== 'string'
      ) {
        return sendError(response, 400, 'INVALID_LIBRARY_DERIVE_REQUEST', '项目派生资源请求字段无效')
      }
      if (!workspaceStore.getCatalog().catalog.projects.some(({ id }) => id === body.projectId)) {
        return sendError(response, 404, 'WORKSPACE_PROJECT_NOT_FOUND', '目标项目不存在')
      }
      return sendJson(response, 201, {
        asset: await projectStore.deriveLibraryAsset(
          decodeURIComponent(libraryDeriveMatch[1]),
          body,
          { source: 'project-derived-library-asset' },
        ),
      })
    }
    const libraryVersionMatch = /^\/api\/library\/assets\/([^/]+)\/versions$/u.exec(pathname)
    if (request.method === 'POST' && libraryVersionMatch) {
      const body = await readJsonBody(request, 96 * 1024 * 1024)
      const allowed = new Set(['projectId', 'dataUrl'])
      if (
        !body
        || typeof body !== 'object'
        || Array.isArray(body)
        || Object.keys(body).some((key) => !allowed.has(key))
        || typeof body.projectId !== 'string'
        || typeof body.dataUrl !== 'string'
      ) {
        return sendError(response, 400, 'INVALID_LIBRARY_VERSION_REQUEST', '资源版本请求字段无效')
      }
      if (!workspaceStore.getCatalog().catalog.projects.some(({ id }) => id === body.projectId)) {
        return sendError(response, 404, 'WORKSPACE_PROJECT_NOT_FOUND', '目标项目不存在')
      }
      return sendJson(response, 201, {
        asset: await projectStore.addLibraryAssetVersion(
          decodeURIComponent(libraryVersionMatch[1]),
          body,
          { source: 'project-library-edit' },
        ),
      })
    }
    const clientStateMatch = /^\/api\/client-state\/([^/]+)$/u.exec(pathname)
    if (request.method === 'GET' && clientStateMatch) {
      const state = await clientStateStore.get(decodeURIComponent(clientStateMatch[1]))
      return sendJson(response, 200, { state })
    }
    if (request.method === 'PUT' && clientStateMatch) {
      const body = await readJsonBody(request, 34 * 1024 * 1024)
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => key !== 'value')) {
        return sendError(response, 400, 'INVALID_CLIENT_STATE_REQUEST', '客户端状态请求只允许 value 字段')
      }
      const state = await clientStateStore.put(decodeURIComponent(clientStateMatch[1]), body.value)
      return sendJson(response, 200, { state })
    }
    if (request.method === 'GET' && pathname === '/api/workflows') {
      const runtime = await inspectRuntime()
      return sendJson(response, 200, workflowCatalog(runtime.videoCapabilities))
    }
    if (request.method === 'POST' && pathname === '/api/video/prompt/compile') {
      const body = await readJsonBody(request, 16 * 1024)
      const normalized = validateVideoRequest({
        ...body,
        prompt: body.prompt || body.sourcePrompt,
        preset: body.preset || 'delivery720',
      })
      return sendJson(response, 200, {
        plan: compileH3Prompt({
          mode: normalized.mode,
          sourcePrompt: normalized.prompt,
          scenario: normalized.scenario,
          aspectRatio: normalized.aspectRatio,
          duration: normalized.duration,
          frameCount: VIDEO_DURATIONS[normalized.duration],
          audio: normalized.audio,
          hasLastFrame: normalized.hasLastFrame,
          director: normalized.director,
        }),
      })
    }
    if (request.method === 'GET' && pathname === '/api/image-tools') {
      return sendJson(response, 200, await imageProcessor.probe(url.searchParams.get('refresh') === '1'))
    }
    if (request.method === 'GET' && pathname === '/api/semantic-workflows') {
      return sendJson(response, 200, await inspectSemanticWorkflows(url.searchParams.get('refresh') === '1'))
    }
    if (request.method === 'GET' && pathname === '/api/scheduler') {
      return sendJson(response, 200, scheduler.snapshot())
    }
    if (request.method === 'GET' && pathname === '/api/projects/current/package') {
      const projectId = url.searchParams.get('id') || 'local-project'
      const body = await projectStore.exportProjectBundle(projectId)
      response.writeHead(200, {
        'content-type': 'application/vnd.miaohui.project',
        'content-length': body.length,
        'content-disposition': `attachment; filename="${projectId}.miaohui"`,
        'cache-control': 'no-store',
      })
      response.end(body)
      return
    }
    if (request.method === 'POST' && pathname === '/api/projects/import') {
      const projectId = url.searchParams.get('projectId') || 'local-project'
      const project = await projectStore.importProjectBundle(await readBinaryBody(request), { projectId })
      return sendJson(response, 201, { project })
    }
    if (request.method === 'PUT' && pathname === '/api/projects/current') {
      const body = await readJsonBody(request, 72 * 1024 * 1024)
      assertCanvasDocument(body.document)
      const project = await projectStore.saveProject(body.document, {
        source: 'canvas-autosave',
        resolveAssetReference: resolveProjectAssetReference,
      })
      const registration = workspaceStore.findDocumentRegistration(project.id)
      if (registration?.document.modeId === 'balanced') {
        const existingWorkspaceDocument = workspaceStore.getModeDocument(project.id)
        workspaceStore.saveModeDocument({
          projectId: registration.project.id,
          documentId: project.id,
          modeId: 'balanced',
          baseRevision: existingWorkspaceDocument?.revision ?? null,
          revision: project.revision,
          value: JSON.stringify(project.document),
        }, { reason: 'balanced-canvas-autosave' })
      }
      return sendJson(response, 200, { project })
    }
    if (request.method === 'GET' && pathname === '/api/projects/current') {
      const projectId = url.searchParams.get('id') || 'local-project'
      const project = projectStore.getProject(projectId)
      return sendJson(response, 200, { project })
    }
    if (request.method === 'POST' && pathname === '/api/projects/gc') {
      const removed = await projectStore.collectGarbage()
      await assetPreviewService.removeVariants(removed)
      return sendJson(response, 200, { removed })
    }
    if (request.method === 'GET' && pathname === '/api/jobs') {
      return sendJson(response, 200, { jobs: store.list().map((job) => store.publicJob(job)) })
    }
    if (request.method === 'DELETE' && pathname === '/api/jobs') {
      const terminalJobs = store.list().filter((job) => ['completed', 'failed', 'cancelled'].includes(job.status))
      const removed = await store.clearTerminal()
      await cleanupTerminalJobInputs(terminalJobs)
      broadcast({ type: 'jobs.cleared', ids: removed })
      return sendJson(response, 200, { removed })
    }
    if (request.method === 'GET' && pathname === '/api/jobs/events') {
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      response.write(`data: ${JSON.stringify({ type: 'jobs.snapshot', jobs: store.list().map((job) => store.publicJob(job)) })}\n\n`)
      sseClients.add(response)
      request.on('close', () => sseClients.delete(response))
      return
    }
    if (request.method === 'POST' && pathname === '/api/jobs/video') {
      const body = await readJsonBody(request)
      const result = await createVideoJob(body, undefined, {
        idempotencyKey: request.headers['idempotency-key'],
        priority: request.headers['x-miaohui-priority'] === undefined
          ? undefined
          : resolvePriority(request.headers['x-miaohui-priority'], 50),
      })
      return sendJson(response, result.reused ? 200 : 202, result)
    }
    if (request.method === 'POST' && pathname === '/api/jobs/image') {
      const body = await readJsonBody(request)
      const result = await createImageJob(body, undefined, {
        idempotencyKey: request.headers['idempotency-key'],
        priority: request.headers['x-miaohui-priority'] === undefined
          ? undefined
          : resolvePriority(request.headers['x-miaohui-priority'], 70),
      })
      return sendJson(response, result.reused ? 200 : 202, result)
    }
    if (request.method === 'POST' && pathname === '/api/jobs/semantic-image') {
      const body = await readJsonBody(request)
      const result = await createSemanticImageJob(body, undefined, {
        idempotencyKey: request.headers['idempotency-key'],
        priority: request.headers['x-miaohui-priority'] === undefined
          ? undefined
          : resolvePriority(request.headers['x-miaohui-priority'], 55),
      })
      return sendJson(response, result.reused ? 200 : 202, result)
    }
    const jobMatch = /^\/api\/jobs\/([^/]+)$/.exec(pathname)
    if (request.method === 'GET' && jobMatch) {
      const job = store.get(decodeURIComponent(jobMatch[1]))
      return job
        ? sendJson(response, 200, { job: store.publicJob(job) })
        : sendError(response, 404, 'JOB_NOT_FOUND', 'Task was not found')
    }
    const cancelMatch = /^\/api\/jobs\/([^/]+)\/cancel$/.exec(pathname)
    if (request.method === 'POST' && cancelMatch) {
      const job = store.get(decodeURIComponent(cancelMatch[1]))
      if (!job) return sendError(response, 404, 'JOB_NOT_FOUND', 'Task was not found')
      return sendJson(response, 200, { job: store.publicJob(await cancelJob(job)) })
    }
    const retryMatch = /^\/api\/jobs\/([^/]+)\/retry$/.exec(pathname)
    if (request.method === 'POST' && retryMatch) {
      const source = store.get(decodeURIComponent(retryMatch[1]))
      if (!source) return sendError(response, 404, 'JOB_NOT_FOUND', 'Task was not found')
      if (!['failed', 'cancelled'].includes(source.status)) {
        return sendError(response, 409, 'JOB_NOT_RETRYABLE', 'Only failed or cancelled tasks can be retried')
      }
      if ((source.scheduling?.attempt || 1) >= (source.scheduling?.maxAttempts || 3)) {
        return sendError(response, 409, 'JOB_MAX_ATTEMPTS', 'Task has reached its maximum retry attempts')
      }
      const options = {
        idempotencyKey: request.headers['idempotency-key'],
        priority: request.headers['x-miaohui-priority'] === undefined
          ? source.scheduling?.priority
          : resolvePriority(request.headers['x-miaohui-priority'], source.scheduling?.priority || 50),
      }
      const result = source.kind === 'image'
        ? source.request?.operation === SEMANTIC_ELEMENT_EXTRACT_OPERATION
          ? await createSemanticImageJob({}, source, options)
          : await createImageJob({}, source, options)
        : await createVideoJob({}, source, options)
      return sendJson(response, result.reused ? 200 : 202, result)
    }
    const assetMatch = /^\/api\/assets\/([^/]+)$/.exec(pathname)
    if (request.method === 'GET' && assetMatch) {
      return await serveVideoAsset(request, response, assetMatch[1])
    }
    const projectAssetMatch = /^\/api\/project-assets\/([a-f0-9]{64})$/.exec(pathname)
    if ((request.method === 'GET' || request.method === 'HEAD') && projectAssetMatch) {
      return await serveProjectAsset(request, response, projectAssetMatch[1], url.searchParams.get('variant'))
    }
    if (pathname.startsWith('/api/')) return sendError(response, 404, 'NOT_FOUND', 'API endpoint was not found')
    if (request.method === 'GET' || request.method === 'HEAD') {
      security.issueSession(response)
      return await serveStatic(response, pathname)
    }
    sendError(response, 405, 'METHOD_NOT_ALLOWED', 'Method is not allowed')
  } catch (error) {
    const safeMessage = redactSensitiveText(error.message || 'Request failed')
    console.error(`[${error.code || 'REQUEST_FAILED'}] ${safeMessage}`)
    sendError(response, error.status || 500, error.code || 'REQUEST_FAILED', safeMessage)
  }
})

server.listen(port, host, () => {
  console.log(`AEONQUILL local bridge: http://${host}:${port}`)
  console.log(`ComfyUI executor: ${comfy.baseUrl}`)
})

let shutdownStarted = false
async function shutdown() {
  if (shutdownStarted) return
  shutdownStarted = true
  clearInterval(heartbeat)
  for (const response of sseClients) response.end()
  await runtimeManager.dispose().catch(() => {})
  workspaceStore.close()
  projectStore.close()
  server.closeIdleConnections?.()
  const closeLingeringConnections = setTimeout(() => server.closeAllConnections?.(), 2_500)
  closeLingeringConnections.unref()
  const forcedExit = setTimeout(() => process.exit(1), 8_000)
  forcedExit.unref()
  server.close(() => {
    clearTimeout(closeLingeringConnections)
    clearTimeout(forcedExit)
    process.exit(0)
  })
}

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())

if ((process.env.AEONQUILL_PARENT_CONTROL || process.env.MIAOHUI_PARENT_CONTROL) === 'stdio') {
  process.stdin.setEncoding('utf8')
  let parentControlBuffer = ''
  process.stdin.on('data', (chunk) => {
    parentControlBuffer += chunk
    const lines = parentControlBuffer.split(/\r?\n/)
    parentControlBuffer = lines.pop() || ''
    if (lines.some((line) => line.trim() === 'shutdown')) void shutdown()
  })
  process.stdin.once('end', () => void shutdown())
}
