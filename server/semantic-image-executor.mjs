import { createHash } from 'node:crypto'
import { extname, join, resolve, sep } from 'node:path'
import { readFile, unlink, writeFile } from 'node:fs/promises'

import { MAX_ASSET_BYTES } from './project-store.mjs'
import { redactSensitiveText, sanitizePublicPayload } from './security.mjs'
import {
  buildSemanticImageWorkflow,
  QWEN_SEMANTIC_WORKFLOW_VERSION,
} from './semantic-image-workflow.mjs'

const SAFE_COMFY_SEGMENT = /^[A-Za-z0-9._-]+$/u
const IMAGE_MIME_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
])

function semanticError(code, message, status = 400, details) {
  return Object.assign(new Error(message), { code, status, ...(details ? { details } : {}) })
}

function safeManagedInputPath(root, name) {
  const parts = String(name || '').replace(/\\/gu, '/').split('/').filter(Boolean)
  if (!parts.length || parts.some((part) => !SAFE_COMFY_SEGMENT.test(part) || part === '.' || part === '..')) {
    throw semanticError('INVALID_SEMANTIC_COMFY_REFERENCE', 'ComfyUI returned an invalid managed input path', 409)
  }
  const absoluteRoot = resolve(root)
  const candidate = resolve(absoluteRoot, ...parts)
  if (candidate !== absoluteRoot && !candidate.startsWith(`${absoluteRoot}${sep}`)) {
    throw semanticError('INVALID_SEMANTIC_COMFY_REFERENCE', 'ComfyUI input path escaped the managed root', 409)
  }
  return candidate
}

function safeComfyImageOutput(output) {
  if (!output || typeof output !== 'object' || typeof output.filename !== 'string') return null
  const filenameParts = output.filename.replace(/\\/gu, '/').split('/')
  const subfolderParts = String(output.subfolder || '').replace(/\\/gu, '/').split('/').filter(Boolean)
  const type = output.type || 'output'
  if (
    !['output', 'temp'].includes(type)
    || filenameParts.length !== 1
    || [...filenameParts, ...subfolderParts].some((part) => !SAFE_COMFY_SEGMENT.test(part) || part === '.' || part === '..')
  ) return null
  const mimeType = IMAGE_MIME_TYPES.get(extname(output.filename).toLocaleLowerCase('en-US'))
  return mimeType ? { filename: output.filename, subfolder: subfolderParts.join('/'), type, mimeType } : null
}

export function findSemanticImageOutput(historyEntry, outputNodeId = '118') {
  const nodeOutput = historyEntry?.outputs?.[outputNodeId] ?? historyEntry?.outputs?.[String(outputNodeId)]
  if (!nodeOutput || typeof nodeOutput !== 'object') return null
  for (const value of Object.values(nodeOutput)) {
    if (!Array.isArray(value)) continue
    for (const candidate of value) {
      const output = safeComfyImageOutput(candidate)
      if (output) return output
    }
  }
  return null
}

async function readBoundedOutput(response) {
  const declared = Number(response.headers?.get?.('content-length') || 0)
  if (declared > MAX_ASSET_BYTES) {
    throw semanticError('SEMANTIC_OUTPUT_TOO_LARGE', 'Semantic image output exceeds the 256 MiB asset limit', 413)
  }
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer())
    if (!bytes.length || bytes.length > MAX_ASSET_BYTES) {
      throw semanticError('SEMANTIC_OUTPUT_TOO_LARGE', 'Semantic image output is empty or exceeds the asset limit', 413)
    }
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
      throw semanticError('SEMANTIC_OUTPUT_TOO_LARGE', 'Semantic image output exceeds the asset limit', 413)
    }
    chunks.push(Buffer.from(value))
  }
  if (!total) throw semanticError('SEMANTIC_OUTPUT_MISSING', 'ComfyUI returned an empty semantic image', 409)
  return Buffer.concat(chunks, total)
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

function hashInstruction(instruction) {
  return createHash('sha256').update(String(instruction || ''), 'utf8').digest('hex')
}

function normalizeFailure(error, workflowId) {
  const message = redactSensitiveText(error?.comfyData?.exception_message || error?.message || '语义图像工作流执行失败')
  const unavailable = error?.code === 'SEMANTIC_WORKFLOW_UNAVAILABLE'
  const invalidMask = ['SEMANTIC_MASK_NOT_FOUND', 'SEMANTIC_MASK_DIMENSIONS'].includes(error?.code)
  return {
    code: error?.code || (error?.payload?.node_errors ? 'SEMANTIC_COMFY_REJECTED' : 'SEMANTIC_IMAGE_FAILED'),
    title: unavailable ? '语义工作流尚未就绪' : invalidMask ? '语义蒙版不可用' : '语义图像处理失败',
    message,
    suggestions: unavailable
      ? ['在工作流中心安装 Qwen 2511 语义编辑包', '刷新本机运行时与节点状态后重试']
      : invalidMask
        ? ['确认蒙版尺寸与原图一致', workflowId === 'point-edit' ? '在主体内部添加正向点并在背景处添加排除点' : '确认 Alpha 或灰度蒙版含有有效白色区域']
        : ['查看任务日志与 ComfyUI 节点错误', '确认显存已释放并使用质量模式重试'],
    details: sanitizePublicPayload({
      workflowId,
      nodeId: error?.comfyData?.node_id,
      nodeType: error?.comfyData?.node_type,
      missingArtifacts: error?.details?.missingArtifacts,
      missingNodes: error?.details?.missingNodes,
    }),
  }
}

function assertExecutionActive(store, jobId, signal) {
  const latest = store.get(jobId)
  if (signal?.aborted || latest?.cancelRequested || latest?.status === 'cancelled') {
    throw Object.assign(new Error('Semantic image execution cancelled'), { name: 'AbortError' })
  }
}

function toPixelPoints(points, dimensions) {
  return points.map(({ x, y }) => [
    Math.max(0, Math.min(dimensions.width - 1, Math.round(x * (dimensions.width - 1)))),
    Math.max(0, Math.min(dimensions.height - 1, Math.round(y * (dimensions.height - 1)))),
  ])
}

export class SemanticImageExecutor {
  constructor({
    store,
    projectStore,
    comfy,
    runtimeManager,
    inspectSemanticWorkflows,
    imageProcessor,
    runProcess,
    ffmpegPath,
    inputDirectory,
    managedComfyInputRoot,
    deliverOutput = async () => undefined,
    scheduleRuntimeIdleStop = async () => undefined,
    delay = (duration, signal) => new Promise((resolvePromise, rejectPromise) => {
      if (signal?.aborted) return rejectPromise(Object.assign(new Error('cancelled'), { name: 'AbortError' }))
      const onAbort = () => {
        clearTimeout(timer)
        rejectPromise(Object.assign(new Error('cancelled'), { name: 'AbortError' }))
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolvePromise()
      }, duration)
      signal?.addEventListener('abort', onAbort, { once: true })
    }),
  } = {}) {
    Object.assign(this, {
      store,
      projectStore,
      comfy,
      runtimeManager,
      inspectSemanticWorkflows,
      imageProcessor,
      runProcess,
      ffmpegPath,
      inputDirectory,
      managedComfyInputRoot,
      deliverOutput,
      scheduleRuntimeIdleStop,
      delay,
    })
  }

  _reportProgress(jobId, message) {
    const job = this.store.get(jobId)
    if (!job || ['completed', 'failed', 'cancelled'].includes(job.status)) return
    if (message.type === 'progress') {
      const value = Math.max(0, Number(message.data?.value || 0))
      const maximum = Math.max(1, Number(message.data?.max || 1))
      void this.store.update(jobId, {
        phase: 'processing',
        progress: Math.min(89, 24 + Math.round((value / maximum) * 65)),
        sampleStep: value,
        sampleSteps: maximum,
        detail: `Qwen 2511 质量采样 ${value}/${maximum}`,
      })
    } else if (message.type === 'executing' && message.data?.node) {
      void this.store.update(jobId, {
        phase: 'processing',
        progress: Math.max(job.progress || 0, 20),
        detail: `执行语义节点 ${message.data.node}`,
      })
    }
  }

  async _normalizeSource(job, temporaryPaths, signal) {
    const sourcePath = join(this.inputDirectory, `${job.id}-qwen-source.png`)
    await this.runProcess(this.ffmpegPath, [
      '-y', '-i', job.inputPath, '-frames:v', '1', '-vf', 'format=rgb24', sourcePath,
    ], 2 * 60_000, signal)
    temporaryPaths.add(sourcePath)
    return sourcePath
  }

  async _normalizeRegionMask(job, sourceDimensions, temporaryPaths, signal) {
    if (!job.maskPath) throw semanticError('SEMANTIC_MASK_NOT_FOUND', 'Region edit requires a managed mask input', 409)
    const maskDimensions = await this.imageProcessor.dimensions(job.maskPath, signal)
    if (maskDimensions.width !== sourceDimensions.width || maskDimensions.height !== sourceDimensions.height) {
      throw semanticError(
        'SEMANTIC_MASK_DIMENSIONS',
        `Mask dimensions ${maskDimensions.width}x${maskDimensions.height} do not match source ${sourceDimensions.width}x${sourceDimensions.height}`,
        409,
      )
    }
    const maskPath = join(this.inputDirectory, `${job.id}-qwen-mask.png`)
    const filter = job.request.params.maskChannel === 'luma' ? 'format=gray' : 'format=rgba,alphaextract'
    await this.runProcess(this.ffmpegPath, [
      '-y', '-i', job.maskPath, '-frames:v', '1', '-vf', filter, maskPath,
    ], 2 * 60_000, signal)
    temporaryPaths.add(maskPath)
    return maskPath
  }

  async _generatePointMask(job, sourceReference, sourceDimensions, temporaryPaths, signal) {
    await this.store.update(job.id, { phase: 'processing', progress: 12, detail: 'SAM 正在把点击提示编译为蒙版' })
    await this.comfy.prepareSamImage(sourceReference, signal)
    let bytes
    let lastError
    for (let attempt = 0; attempt < 80 && !bytes; attempt += 1) {
      if (attempt) await this.delay(750, signal)
      try {
        bytes = await this.comfy.detectSamMask({
          positivePoints: toPixelPoints(job.request.params.positivePoints, sourceDimensions),
          negativePoints: toPixelPoints(job.request.params.negativePoints, sourceDimensions),
          threshold: job.request.params.threshold,
        }, signal)
      } catch (error) {
        lastError = error
        if (error?.status !== 400) throw error
      }
    }
    if (!bytes?.length) {
      throw semanticError('SEMANTIC_MASK_NOT_FOUND', `SAM did not return a stable point mask${lastError ? `: ${lastError.message}` : ''}`, 409)
    }
    const maskPath = join(this.inputDirectory, `${job.id}-qwen-mask.png`)
    await writeFile(maskPath, bytes, { flag: 'wx' })
    temporaryPaths.add(maskPath)
    await this.comfy.releaseSam()
    return maskPath
  }

  async _persistMask(job, maskPath) {
    if (job.request.workflowId !== 'point-edit') return undefined
    const bytes = await readFile(maskPath)
    return this.projectStore.createLibraryAsset({
      scope: 'project',
      projectId: job.request.projectId,
      title: `${job.request.title || '定点修改'} · 蒙版`,
      description: '由点击提示和本机 SAM 生成的不可变灰度蒙版',
      tags: ['semantic-mask', 'sam', 'point-edit'],
      collectionIds: [],
      dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
    }, {
      source: 'semantic-point-mask',
      provenance: {
        jobId: job.id,
        workflowId: job.request.workflowId,
        workflowVersion: job.request.workflowVersion,
        sourceElementId: job.sourceElementId,
        sourceAssetId: job.request.sourceAssetId,
        positivePoints: job.request.params.positivePoints,
        negativePoints: job.request.params.negativePoints,
        threshold: job.request.params.threshold,
      },
    })
  }

  async run(jobId, { signal }) {
    const job = this.store.get(jobId)
    if (!job) return
    let tracker
    const uploadedPaths = new Set()
    const temporaryPaths = new Set()
    let samPrepared = false
    try {
      await this.store.update(jobId, { status: 'running', phase: 'preparing', progress: 3, detail: '按需启动 Qwen 语义编辑运行时' })
      await this.runtimeManager.ensureReady({ reason: `semantic-qwen:${jobId}` })
      const catalog = await this.inspectSemanticWorkflows(true)
      const capability = catalog.workflows.find((item) => item.id === job.request.workflowId)
      if (!capability?.available) {
        throw semanticError('SEMANTIC_WORKFLOW_UNAVAILABLE', capability?.message || 'Qwen semantic workflow is unavailable', 409, {
          missingArtifacts: capability?.missingArtifacts,
          missingNodes: capability?.missingNodes,
        })
      }
      assertExecutionActive(this.store, jobId, signal)
      const sourceDimensions = await this.imageProcessor.dimensions(job.inputPath, signal)
      if (sourceDimensions.width * sourceDimensions.height > 40_000_000) {
        throw semanticError('SEMANTIC_INPUT_TOO_LARGE', 'Semantic edit input exceeds 40 megapixels', 413)
      }
      const sourcePath = await this._normalizeSource(job, temporaryPaths, signal)
      await this.store.update(jobId, { progress: 7, detail: '上传受管原图到本机 ComfyUI' })
      const sourceName = await this.comfy.uploadAsset(sourcePath, `aeonquill-${job.id}-source.png`, 'image/png', signal)
      uploadedPaths.add(safeManagedInputPath(this.managedComfyInputRoot, sourceName))

      let maskPath
      if (job.request.workflowId === 'region-edit') {
        maskPath = await this._normalizeRegionMask(job, sourceDimensions, temporaryPaths, signal)
      } else if (job.request.workflowId === 'point-edit') {
        samPrepared = true
        maskPath = await this._generatePointMask(job, sourceName, sourceDimensions, temporaryPaths, signal)
        samPrepared = false
      }
      let maskName
      if (maskPath) {
        const maskDimensions = await this.imageProcessor.dimensions(maskPath, signal)
        if (maskDimensions.width !== sourceDimensions.width || maskDimensions.height !== sourceDimensions.height) {
          throw semanticError('SEMANTIC_MASK_DIMENSIONS', 'Generated mask dimensions do not match the source image', 409)
        }
        await this.store.update(jobId, { progress: 16, detail: '上传灰度蒙版并准备固定合成模板' })
        maskName = await this.comfy.uploadAsset(maskPath, `aeonquill-${job.id}-mask.png`, 'image/png', signal)
        uploadedPaths.add(safeManagedInputPath(this.managedComfyInputRoot, maskName))
      }
      const built = buildSemanticImageWorkflow({
        workflowId: job.request.workflowId,
        sourceImageName: sourceName,
        maskImageName: maskName,
        instruction: job.request.params.instruction,
        identityStrength: job.request.params.identityStrength,
        seed: job.request.params.seed,
        jobId,
      })
      await this.store.update(jobId, {
        workflowVersion: QWEN_SEMANTIC_WORKFLOW_VERSION,
        workflowMetadata: {
          ...built.metadata,
          instruction: undefined,
          instructionHash: hashInstruction(built.metadata.instruction),
        },
        phase: 'queued',
        progress: 18,
        detail: '提交 Qwen 2511 质量模式固定工作流',
      })
      await this.store.log(jobId, 'success', '依赖、输入、蒙版与固定节点模板复检通过')
      const clientId = `aeonquill-semantic-${job.id}`
      tracker = await this.comfy.openExecutionTracker(clientId, (message) => this._reportProgress(jobId, message))
      const queued = await this.comfy.queuePrompt(built.workflow, clientId, signal)
      await this.store.update(jobId, {
        comfyPromptId: queued.prompt_id,
        queueNumber: queued.number,
        phase: 'queued',
        progress: 19,
        detail: queued.number ? `已进入 ComfyUI 队列 · #${queued.number}` : '已进入 ComfyUI 队列',
      })
      const history = await tracker.waitForPrompt(queued.prompt_id, signal)
      assertExecutionActive(this.store, jobId, signal)
      const output = findSemanticImageOutput(history, built.metadata.outputNodeId)
      if (!output) throw semanticError('SEMANTIC_OUTPUT_MISSING', 'Fixed Qwen output node returned no supported image', 409)
      await this.store.update(jobId, { phase: 'saving', progress: 92, detail: '校验输出并写入项目资源库' })
      const response = await this.comfy.fetchOutput(output, signal)
      const bytes = await readBoundedOutput(response)
      assertExecutionActive(this.store, jobId, signal)
      const instructionHash = hashInstruction(job.request.params.instruction)
      const libraryAsset = await this.projectStore.createLibraryAsset({
        scope: 'project',
        projectId: job.request.projectId,
        title: job.request.title || capability.label,
        description: `${capability.label} · Qwen Image Edit 2511 INT8 · 质量模式`,
        tags: ['semantic-edit', job.request.workflowId, 'qwen-2511'],
        collectionIds: [],
        dataUrl: `data:${output.mimeType};base64,${bytes.toString('base64')}`,
      }, {
        source: 'semantic-qwen-image-edit',
        provenance: {
          jobId,
          workflowId: job.request.workflowId,
          workflowVersion: QWEN_SEMANTIC_WORKFLOW_VERSION,
          promptVersion: built.metadata.promptVersion,
          instructionHash,
          sourceElementId: job.sourceElementId,
          sourceAssetId: job.request.sourceAssetId,
          sourceContentHash: job.request.sourceContentHash,
          maskAssetId: job.request.maskAssetId,
          maskContentHash: job.request.maskContentHash,
          seed: built.metadata.seed,
          steps: built.metadata.steps,
          cfg: built.metadata.cfg,
          sampler: built.metadata.sampler,
          identityStrength: built.metadata.identityStrength,
        },
      })
      const storedAsset = this.projectStore.getAsset(libraryAsset.version.assetId)
      if (!storedAsset) throw semanticError('SEMANTIC_OUTPUT_MISSING', 'Persisted semantic output asset is unavailable', 409)
      const dimensions = await this.imageProcessor.dimensions(this.projectStore.assetPath(storedAsset), signal)
      const maskLibraryAsset = maskPath ? await this._persistMask(job, maskPath) : undefined
      const delivery = await this.deliverOutput(jobId, this.projectStore.assetPath(storedAsset), `${job.id}.${storedAsset.extension}`)
      assertExecutionActive(this.store, jobId, signal)
      await this.store.log(jobId, 'success', `语义结果已写入项目资源库 · SHA ${storedAsset.id.slice(0, 12)}…`)
      await this.store.update(jobId, {
        status: 'completed',
        phase: 'completed',
        progress: 100,
        detail: `${capability.label}完成，结果已回填画布与项目资源库`,
        outputUrl: libraryAsset.version.url,
        maskUrl: maskLibraryAsset?.version.url,
        output: {
          filename: output.filename,
          width: dimensions.width,
          height: dimensions.height,
          mimeType: output.mimeType,
          bytes: storedAsset.bytes,
          provider: 'comfy-qwen-image-edit-2511-int8',
        },
        outputVersion: outputVersion(libraryAsset),
        libraryAsset,
        maskLibraryAsset,
        delivery,
        completedAt: Date.now(),
      })
    } catch (error) {
      const latest = this.store.get(jobId)
      if (signal?.reason?.code === 'JOB_TIMEOUT') throw error
      if (signal?.aborted || error?.name === 'AbortError' || latest?.cancelRequested || latest?.status === 'cancelled') {
        if (latest?.status !== 'cancelled') {
          await this.store.update(jobId, { status: 'cancelled', phase: 'cancelled', detail: '语义图像工作流已取消' })
        }
        await this.store.log(jobId, 'warning', 'Qwen 语义图像工作流已由用户取消')
        return
      }
      const failure = normalizeFailure(error, job.request.workflowId)
      await this.store.log(jobId, 'error', `${failure.code}：${failure.title}`)
      await this.store.update(jobId, {
        status: 'failed',
        phase: 'failed',
        progress: Math.min(99, latest?.progress || 0),
        detail: failure.title,
        error: failure,
      })
    } finally {
      tracker?.close()
      if (samPrepared) await this.comfy.releaseSam().catch(() => {})
      for (const path of uploadedPaths) await unlink(path).catch(() => {})
      for (const path of temporaryPaths) await unlink(path).catch(() => {})
      await this.scheduleRuntimeIdleStop().catch(() => {})
    }
  }
}
