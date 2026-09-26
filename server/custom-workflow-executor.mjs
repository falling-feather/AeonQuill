import { unlink } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

import { MAX_ASSET_BYTES } from './project-store.mjs'
import { redactSensitiveText, sanitizePublicPayload } from './security.mjs'
import { CUSTOM_WORKFLOW_EXECUTION_VERSION } from './workflow-center.mjs'
import { assertWorkflowWeightSetCompatible, validateWorkflowWeightSet } from '../src/lib/workflowRecipes.mjs'
import {
  WORKFLOW_CONTROL_FIELDS,
  validateWorkflowControlValue,
} from '../src/lib/workflowControls.mjs'

export const CUSTOM_WORKFLOW_JOB_KIND = 'custom-workflow'

const PROJECT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/u
const LIBRARY_ID = /^(?:library|collection)-[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/u
const SAFE_COMFY_SEGMENT = /^[A-Za-z0-9._-]+$/u
const OUTPUT_MIME_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.mp4', 'video/mp4'],
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
])
function customError(code, message, status = 400, details) {
  return Object.assign(new Error(message), { code, status, ...(details ? { details } : {}) })
}

function assertLibraryItemId(value, role) {
  if (typeof value !== 'string' || !LIBRARY_ID.test(value)) {
    throw customError('CUSTOM_WORKFLOW_INPUT_ASSET_INVALID', `${role} 必须选择项目可见的资源库图片`)
  }
  return value
}

function assertExpectedHash(expected, actual) {
  if (expected !== undefined && (typeof expected !== 'string' || !/^[a-f0-9]{64}$/u.test(expected) || expected !== actual)) {
    throw customError('CUSTOM_WORKFLOW_INPUT_CHANGED', '工作流或参考图版本已变化，请重新检查后执行', 409)
  }
}

function assertProject(projectId, workspaceStore) {
  if (typeof projectId !== 'string' || !PROJECT_ID.test(projectId)) {
    throw customError('CUSTOM_WORKFLOW_PROJECT_INVALID', '自定义工作流需要有效项目 ID')
  }
  const project = workspaceStore.getCatalog().catalog.projects.find(({ id }) => id === projectId)
  if (!project || project.status !== 'active') {
    throw customError('WORKSPACE_PROJECT_NOT_FOUND', '自定义工作流所属项目不存在或当前不可写', 404)
  }
  return project
}

export function validateCustomWorkflowJobRequest(body, { workspaceStore, workflowCenter, projectStore } = {}) {
  const allowed = new Set([
    'customWorkflowId', 'projectId', 'title', 'prompt', 'negativePrompt', 'sourceLibraryItemId',
    'lastFrameLibraryItemId', 'workflowHash', 'mappingHash', 'sourceContentHash', 'lastFrameContentHash', 'weightSet', ...Object.keys(WORKFLOW_CONTROL_FIELDS),
  ])
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw customError('CUSTOM_WORKFLOW_JOB_INVALID', '自定义工作流任务必须是对象')
  }
  const unknown = Object.keys(body).filter((key) => !allowed.has(key))
  if (unknown.length) throw customError('CUSTOM_WORKFLOW_JOB_UNKNOWN_FIELD', '自定义工作流任务含未知字段', 400, { unknown })
  const project = assertProject(body.projectId, workspaceStore)
  const summary = workflowCenter.customExecutionSummary(body.customWorkflowId)
  const weightSet = validateWorkflowWeightSet(summary.weightSet ?? null)
  if (body.weightSet !== undefined) assertWorkflowWeightSetCompatible(body.weightSet, weightSet)
  assertExpectedHash(body.workflowHash, summary.hash)
  assertExpectedHash(body.mappingHash, summary.mappingHash)
  if (!summary.enabled) throw customError('CUSTOM_WORKFLOW_NOT_ENABLED', '自定义工作流尚未启用', 409)
  const title = typeof body.title === 'string' ? body.title.trim() : ''
  if (!title || title.length > 120) throw customError('CUSTOM_WORKFLOW_TITLE_INVALID', '输出名称需要 1–120 个字符')
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  if (!prompt || prompt.length > 8_000) throw customError('CUSTOM_WORKFLOW_PROMPT_INVALID', '正向提示词需要 1–8000 个字符')
  const request = {
    customWorkflowId: summary.id,
    projectId: project.id,
    title,
    prompt,
    workflowHash: summary.hash,
    mappingHash: summary.mappingHash,
    ...(weightSet ? { weightSet } : {}),
  }
  const roleFields = {
    negativePrompt: 'negativePrompt',
    sourceImage: 'sourceLibraryItemId',
    lastFrame: 'lastFrameLibraryItemId',
    seed: 'seed',
    width: 'width',
    height: 'height',
    frames: 'frames',
    steps: 'steps',
    cfg: 'cfg',
    denoise: 'denoise',
    loraStrength: 'loraStrength',
    loraClipStrength: 'loraClipStrength',
    controlStrength: 'controlStrength',
  }
  for (const [role, field] of Object.entries(roleFields)) {
    const mapped = Boolean(summary.mappings?.[role])
    if (!mapped && body[field] !== undefined) {
      throw customError('CUSTOM_WORKFLOW_PARAMETER_NOT_MAPPED', `${role} 没有在工作流中映射`)
    }
    if (mapped && body[field] !== undefined) request[field] = body[field]
  }
  if (summary.mappings.negativePrompt && body.negativePrompt !== undefined) {
    if (typeof body.negativePrompt !== 'string' || body.negativePrompt.length > 8_000) {
      throw customError('CUSTOM_WORKFLOW_PROMPT_INVALID', '负向提示词不能超过 8000 个字符')
    }
    request.negativePrompt = body.negativePrompt
  }
  for (const role of Object.keys(WORKFLOW_CONTROL_FIELDS)) {
    if (!summary.mappings[role] || body[role] === undefined) continue
    try {
      request[role] = validateWorkflowControlValue(role, body[role])
    } catch (error) {
      const code = error?.code === 'WORKFLOW_CONTROL_VALUE_RANGE'
        ? 'CUSTOM_WORKFLOW_PARAMETER_RANGE'
        : 'CUSTOM_WORKFLOW_PARAMETER_INVALID'
      throw customError(code, error?.message || `${role} 参数无效`)
    }
  }
  if (summary.mappings.sourceImage) {
    request.sourceLibraryItemId = assertLibraryItemId(body.sourceLibraryItemId, 'sourceImage')
  }
  if (summary.mappings.lastFrame) {
    request.lastFrameLibraryItemId = assertLibraryItemId(body.lastFrameLibraryItemId, 'lastFrame')
  }
  for (const [itemId, hashField] of [[request.sourceLibraryItemId, 'sourceContentHash'], [request.lastFrameLibraryItemId, 'lastFrameContentHash']]) {
    if (!itemId) {
      if (body[hashField] !== undefined) throw customError('CUSTOM_WORKFLOW_INPUT_ASSET_INVALID', '参考图指纹需要对应的图片输入', 409)
      continue
    }
    const asset = projectStore.getLibraryAsset(itemId, { projectId: project.id, requireProjectReference: true })
    if (!asset || asset.mediaKind !== 'image') {
      throw customError('CUSTOM_WORKFLOW_INPUT_ASSET_INVALID', '映射输入必须是该项目可见的 PNG、JPEG 或 WebP 图片', 409)
    }
    assertExpectedHash(body[hashField], asset.version.assetId)
    request[hashField] = asset.version.assetId
  }
  return { request, workflow: summary }
}

function safeComfyOutput(output) {
  if (!output || typeof output !== 'object' || typeof output.filename !== 'string') return null
  const filenameParts = output.filename.replace(/\\/gu, '/').split('/')
  const subfolderParts = String(output.subfolder || '').replace(/\\/gu, '/').split('/').filter(Boolean)
  const type = output.type || 'output'
  if (
    !['output', 'temp'].includes(type)
    || filenameParts.length !== 1
    || [...filenameParts, ...subfolderParts].some((part) => !SAFE_COMFY_SEGMENT.test(part) || part === '.' || part === '..')
  ) return null
  const mimeType = OUTPUT_MIME_TYPES.get(extname(output.filename).toLocaleLowerCase('en-US'))
  return mimeType ? { filename: output.filename, subfolder: subfolderParts.join('/'), type, mimeType } : null
}

export function findMappedCustomWorkflowOutput(historyEntry, outputNodeId) {
  const nodeOutput = historyEntry?.outputs?.[outputNodeId] ?? historyEntry?.outputs?.[String(outputNodeId)]
  if (!nodeOutput || typeof nodeOutput !== 'object') return null
  for (const value of Object.values(nodeOutput)) {
    if (!Array.isArray(value)) continue
    for (const candidate of value) {
      const output = safeComfyOutput(candidate)
      if (output) return output
    }
  }
  return null
}

async function readBoundedOutput(response) {
  const declared = Number(response.headers?.get?.('content-length') || 0)
  if (declared > MAX_ASSET_BYTES) throw customError('CUSTOM_WORKFLOW_OUTPUT_TOO_LARGE', '工作流输出超过 256 MiB 资源上限', 413)
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer())
    if (!bytes.length || bytes.length > MAX_ASSET_BYTES) throw customError('CUSTOM_WORKFLOW_OUTPUT_TOO_LARGE', '工作流输出为空或超过 256 MiB 资源上限', 413)
    return bytes
  }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_ASSET_BYTES) {
      await reader.cancel().catch(() => {})
      throw customError('CUSTOM_WORKFLOW_OUTPUT_TOO_LARGE', '工作流输出超过 256 MiB 资源上限', 413)
    }
    chunks.push(Buffer.from(value))
  }
  if (!total) throw customError('CUSTOM_WORKFLOW_OUTPUT_MISSING', 'ComfyUI 返回了空输出', 409)
  return Buffer.concat(chunks, total)
}

function safeManagedInputPath(root, name) {
  const parts = String(name || '').replace(/\\/gu, '/').split('/').filter(Boolean)
  if (!parts.length || parts.some((part) => !SAFE_COMFY_SEGMENT.test(part) || part === '.' || part === '..')) {
    throw customError('CUSTOM_WORKFLOW_INPUT_ASSET_INVALID', 'ComfyUI 返回了无效的受管输入路径', 409)
  }
  const absoluteRoot = resolve(root)
  const candidate = resolve(absoluteRoot, ...parts)
  if (candidate !== absoluteRoot && !candidate.startsWith(`${absoluteRoot}${sep}`)) {
    throw customError('CUSTOM_WORKFLOW_INPUT_ASSET_INVALID', 'ComfyUI 输入路径逃逸受管目录', 409)
  }
  return candidate
}

function outputVersion(libraryAsset) {
  return {
    id: libraryAsset.version.id,
    logicalAssetId: libraryAsset.id,
    version: libraryAsset.version.version,
    assetId: libraryAsset.version.assetId,
    mimeType: libraryAsset.version.mimeType,
    bytes: libraryAsset.version.bytes,
    provenance: libraryAsset.version.provenance,
  }
}

function normalizeFailure(error) {
  const message = redactSensitiveText(error?.comfyData?.exception_message || error?.message || '自定义工作流执行失败')
  return {
    code: error?.code || (error?.payload?.node_errors ? 'CUSTOM_WORKFLOW_COMFY_REJECTED' : 'CUSTOM_WORKFLOW_EXECUTION_FAILED'),
    title: error?.code === 'CUSTOM_WORKFLOW_RECHECK_REQUIRED' ? '工作流依赖或映射已经变化' : '自定义工作流执行失败',
    message,
    suggestions: error?.code === 'CUSTOM_WORKFLOW_RECHECK_REQUIRED'
      ? ['返回工作流中心重新复检并导入', '确认模型文件与节点版本没有变化']
      : ['查看任务日志与 ComfyUI 节点错误', '确认指定输出节点确实保存了受支持文件后重试'],
    details: sanitizePublicPayload({
      nodeId: error?.comfyData?.node_id,
      nodeType: error?.comfyData?.node_type,
      findings: error?.details?.findings,
      nodeErrors: error?.payload?.node_errors,
    }),
  }
}

function assertExecutionActive(store, jobId, signal) {
  const latest = store.get(jobId)
  if (signal?.aborted || latest?.cancelRequested || latest?.status === 'cancelled') {
    throw Object.assign(new Error('Custom workflow execution cancelled'), { name: 'AbortError' })
  }
}

export class CustomWorkflowExecutor {
  constructor({
    workflowCenter,
    store,
    projectStore,
    comfy,
    runtimeManager,
    inspectRuntime,
    managedComfyInputRoot,
    deliverOutput = async () => undefined,
    scheduleRuntimeIdleStop = async () => undefined,
  } = {}) {
    Object.assign(this, {
      workflowCenter,
      store,
      projectStore,
      comfy,
      runtimeManager,
      inspectRuntime,
      managedComfyInputRoot,
      deliverOutput,
      scheduleRuntimeIdleStop,
    })
  }

  async _uploadLibraryImage(job, itemId, role, signal, uploadedPaths) {
    const libraryAsset = this.projectStore.getLibraryAsset(itemId, {
      projectId: job.request.projectId,
      requireProjectReference: true,
    })
    if (!libraryAsset || libraryAsset.mediaKind !== 'image') {
      throw customError('CUSTOM_WORKFLOW_INPUT_ASSET_INVALID', `${role} 不再是项目可见图片`, 409)
    }
    const asset = this.projectStore.getAsset(libraryAsset.version.assetId)
    if (!asset || !['image/png', 'image/jpeg', 'image/webp'].includes(asset.mimeType)) {
      throw customError('CUSTOM_WORKFLOW_INPUT_ASSET_INVALID', `${role} 的不可变内容已经缺失`, 409)
    }
    assertExpectedHash(role === 'source' ? job.request.sourceContentHash : job.request.lastFrameContentHash, asset.sha256)
    const filename = `aeonquill-${job.id}-${role}.${asset.extension}`
    const uploaded = await this.comfy.uploadAsset(this.projectStore.assetPath(asset), filename, asset.mimeType, signal)
    uploadedPaths.add(safeManagedInputPath(this.managedComfyInputRoot, uploaded))
    return uploaded
  }

  _reportProgress(jobId, message) {
    const job = this.store.get(jobId)
    if (!job || ['completed', 'failed', 'cancelled'].includes(job.status)) return
    if (message.type === 'executing' && message.data?.node) {
      void this.store.update(jobId, { phase: 'processing', progress: Math.max(job.progress || 0, 18), detail: `执行节点 ${message.data.node}` })
    } else if (message.type === 'progress') {
      const value = Math.max(0, Number(message.data?.value || 0))
      const maximum = Math.max(1, Number(message.data?.max || 1))
      void this.store.update(jobId, {
        phase: 'processing',
        progress: Math.min(88, 20 + Math.round((value / maximum) * 68)),
        sampleStep: value,
        sampleSteps: maximum,
        detail: `自定义工作流处理 ${value}/${maximum}`,
      })
    }
  }

  async run(jobId, { signal }) {
    const job = this.store.get(jobId)
    if (!job) return
    let tracker
    const uploadedPaths = new Set()
    try {
      await this.store.update(jobId, { phase: 'preparing', progress: 3, detail: '检查自定义工作流与本机运行时' })
      const summary = this.workflowCenter.customExecutionSummary(job.request.customWorkflowId)
      assertExpectedHash(job.request.workflowHash, summary.hash)
      assertExpectedHash(job.request.mappingHash, summary.mappingHash)
      assertWorkflowWeightSetCompatible(job.request.weightSet ?? null, summary.weightSet ?? null)
      await this.runtimeManager.ensureReady({ reason: `custom-workflow:${jobId}` })
      const runtime = await this.inspectRuntime(true)
      if (!runtime.connected) throw customError('CUSTOM_WORKFLOW_RUNTIME_UNAVAILABLE', runtime.message || 'ComfyUI 无法连接', 409)
      const objectInfo = await this.comfy.objectInfo()
      let verifiedWeightSet = null
      if (job.request.weightSet) {
        await this.store.update(jobId, { progress: 5, detail: '校验固定模型与加速 LoRA 的文件身份' })
        verifiedWeightSet = await this.workflowCenter.verifyWeightSet(job.request.weightSet, { signal })
        assertExecutionActive(this.store, jobId, signal)
      }
      const values = {
        prompt: job.request.prompt,
        ...(job.request.negativePrompt !== undefined ? { negativePrompt: job.request.negativePrompt } : {}),
        ...(Object.keys(WORKFLOW_CONTROL_FIELDS).reduce((result, role) => (
          job.request[role] === undefined ? result : { ...result, [role]: job.request[role] }
        ), {})),
      }
      if (job.request.sourceLibraryItemId) {
        await this.store.update(jobId, { progress: 7, detail: '上传受管首帧 / 输入图' })
        values.sourceImage = await this._uploadLibraryImage(job, job.request.sourceLibraryItemId, 'source', signal, uploadedPaths)
      }
      if (job.request.lastFrameLibraryItemId) {
        await this.store.update(jobId, { progress: 9, detail: '上传受管末帧' })
        values.lastFrame = await this._uploadLibraryImage(job, job.request.lastFrameLibraryItemId, 'last', signal, uploadedPaths)
      }
      const prepared = this.workflowCenter.prepareCustomExecution(job.request.customWorkflowId, {
        values,
        registeredNodeTypes: objectInfo,
        executionId: job.id,
      })
      if (verifiedWeightSet) {
        prepared.metadata.weightSet = verifiedWeightSet
        prepared.metadata.weightsVerified = true
      }
      await this.store.update(jobId, {
        workflowVersion: CUSTOM_WORKFLOW_EXECUTION_VERSION,
        workflowMetadata: prepared.metadata,
        progress: 11,
        detail: '提交受控自定义 ComfyUI 工作流',
      })
      await this.store.log(jobId, 'success', `节点、模型与映射复检通过 · ${prepared.metadata.workflowHash.slice(0, 12)}…`)
      const clientId = `aeonquill-custom-${job.id}`
      tracker = await this.comfy.openExecutionTracker(clientId, (message) => this._reportProgress(jobId, message))
      const queued = await this.comfy.queuePrompt(prepared.workflow, clientId, signal)
      await this.store.update(jobId, {
        comfyPromptId: queued.prompt_id,
        queueNumber: queued.number,
        phase: 'queued',
        progress: 13,
        detail: queued.number ? `已进入 ComfyUI 队列 · #${queued.number}` : '已进入 ComfyUI 队列',
      })
      const history = await tracker.waitForPrompt(queued.prompt_id, signal)
      if (this.store.get(jobId)?.cancelRequested) return
      const output = findMappedCustomWorkflowOutput(history, prepared.metadata.outputNodeId)
      if (!output) {
        throw customError('CUSTOM_WORKFLOW_OUTPUT_MISSING', '指定输出节点没有返回受支持的 PNG、JPEG、WebP、MP4、MP3 或 WAV 文件', 409)
      }
      assertExecutionActive(this.store, jobId, signal)
      await this.store.update(jobId, { phase: 'saving', progress: 92, detail: '校验输出并写入项目资源库' })
      const response = await this.comfy.fetchOutput(output, signal)
      const bytes = await readBoundedOutput(response)
      assertExecutionActive(this.store, jobId, signal)
      const libraryAsset = await this.projectStore.createLibraryAsset({
        scope: 'project',
        projectId: job.request.projectId,
        title: job.request.title,
        description: `${prepared.metadata.customWorkflowTitle} · ComfyUI 受控自定义工作流`,
        tags: ['comfyui', 'custom-workflow'],
        collectionIds: [],
        dataUrl: `data:${output.mimeType};base64,${bytes.toString('base64')}`,
      }, {
        source: 'custom-comfy-workflow',
        provenance: {
          jobId,
          customWorkflowId: prepared.metadata.customWorkflowId,
          workflowHash: prepared.metadata.workflowHash,
          mappingHash: prepared.metadata.mappingHash,
          outputNodeId: prepared.metadata.outputNodeId,
          parameterRoles: prepared.metadata.parameterRoles,
          ...(verifiedWeightSet ? { weightSet: verifiedWeightSet } : {}),
        },
      })
      const storedAsset = this.projectStore.getAsset(libraryAsset.version.assetId)
      const delivery = storedAsset
        ? await this.deliverOutput(jobId, this.projectStore.assetPath(storedAsset), `${job.id}.${storedAsset.extension}`)
        : undefined
      assertExecutionActive(this.store, jobId, signal)
      await this.store.log(jobId, 'success', `输出已回填项目资源库 · SHA ${libraryAsset.version.assetId.slice(0, 12)}…`)
      await this.store.update(jobId, {
        status: 'completed',
        phase: 'completed',
        progress: 100,
        detail: '自定义工作流完成，输出已进入项目资源库',
        outputUrl: libraryAsset.version.url,
        output: { filename: output.filename, subfolder: output.subfolder, type: output.type },
        outputVersion: outputVersion(libraryAsset),
        libraryAsset,
        delivery,
        completedAt: Date.now(),
      })
    } catch (error) {
      const latest = this.store.get(jobId)
      if (signal?.aborted || error?.name === 'AbortError' || latest?.cancelRequested || latest?.status === 'cancelled') {
        if (latest?.status !== 'cancelled') {
          await this.store.update(jobId, { status: 'cancelled', phase: 'cancelled', detail: '自定义工作流已取消' })
        }
        await this.store.log(jobId, 'warning', '自定义工作流已由用户取消')
        return
      }
      const failure = normalizeFailure(error)
      await this.store.log(jobId, 'error', `${failure.code}：${failure.title}`)
      await this.store.update(jobId, { status: 'failed', phase: 'failed', progress: Math.min(99, latest?.progress || 0), detail: failure.title, error: failure })
    } finally {
      tracker?.close()
      for (const path of uploadedPaths) await unlink(path).catch(() => {})
      await this.scheduleRuntimeIdleStop().catch(() => {})
    }
  }
}
