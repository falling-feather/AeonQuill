export const MEDIA_RUN_SCHEMA_VERSION = 1

export const MEDIA_RUN_KINDS = Object.freeze([
  'image', 'video', 'prepare-speech', 'render-mix', 'final-cut',
])

export const MEDIA_RUN_STATUSES = Object.freeze([
  'proposed', 'rejected', 'queued', 'running', 'completed', 'failed', 'cancelled',
])

export const MEDIA_RUN_NODE_KINDS = Object.freeze({
  'asset-producer': Object.freeze(['image']),
  'video-director': Object.freeze(['video']),
  'sound-director': Object.freeze(['prepare-speech', 'render-mix']),
  editor: Object.freeze(['final-cut']),
})

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const FINGERPRINT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u
const ERROR_CODE = /^[A-Z0-9][A-Z0-9._:-]{0,119}$/u
const SHA256 = /^[a-f0-9]{64}$/u
const UNSAFE_SUMMARY = /(?:api[_ -]?key|access[_ -]?token|secret|password|authorization|bearer|https?:\/\/|file:\/\/|(?:^|\s)(?:[A-Za-z]:[\\/]|[\\/]|\.\.?[\\/])|(?:^|\s)(?:cmd|powershell|bash|sh)\b)/iu

export class MediaSupervisorError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'MediaSupervisorError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

function fail(code, message, details) {
  throw new MediaSupervisorError(code, message, details)
}

function record(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('MEDIA_INVALID_OBJECT', `${path}必须是对象`)
  return value
}

function knownFields(value, fields, path) {
  for (const key of Object.keys(value)) if (!fields.has(key)) fail('MEDIA_UNKNOWN_FIELD', `${path}.${key}不是受支持字段`)
}

function safeId(value, path, max = 160) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || !ID.test(value)) {
    fail('MEDIA_INVALID_ID', `${path}不是受控标识`)
  }
  return value
}

function boundedString(value, path, max, pattern = null) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || /\p{Cc}/u.test(value)) {
    fail('MEDIA_INVALID_STRING', `${path}长度或字符无效`)
  }
  if (pattern && !pattern.test(value)) fail('MEDIA_INVALID_STRING', `${path}格式无效`)
  return value
}

function assertTargetKind(nodeId, kind) {
  if (!Object.hasOwn(MEDIA_RUN_NODE_KINDS, nodeId)) fail('MEDIA_NODE_UNSUPPORTED', `${nodeId}不能创建媒体执行提议`)
  const kinds = MEDIA_RUN_NODE_KINDS[nodeId]
  if (!kinds.includes(kind)) fail('MEDIA_KIND_NODE_MISMATCH', `${nodeId}不能创建${kind}媒体执行提议`)
}

function assertTimestamp(value, path) {
  if (!Number.isSafeInteger(value) || value < 1) fail('MEDIA_INVALID_TIMESTAMP', `${path}必须是正整数时间戳`)
  return value
}

function optionalPair(value, idField, hashField, path, result) {
  const hasId = Object.hasOwn(value, idField)
  const hasHash = Object.hasOwn(value, hashField)
  if (hasId !== hasHash) fail('MEDIA_PREPARATION_PAIR_REQUIRED', `${path}.${idField}和${hashField}必须成对出现`)
  if (!hasId) return
  result[idField] = safeId(value[idField], `${path}.${idField}`)
  if (typeof value[hashField] !== 'string' || !SHA256.test(value[hashField])) {
    fail('MEDIA_PREPARATION_INVALID_HASH', `${path}.${hashField}必须是64位小写SHA-256`)
  }
  result[hashField] = value[hashField]
}

export function normalizeMediaRunPreparation(kind, input) {
  if (input === undefined) return undefined
  const value = record(input, 'mediaRun.preparation')
  if (value.kind !== kind || !['image', 'prepare-speech'].includes(kind)) {
    fail('MEDIA_PREPARATION_KIND_MISMATCH', `媒体准备描述符kind必须与${kind}一致`)
  }
  if (kind === 'image') {
    knownFields(value, new Set([
      'kind', 'workflowId', 'sourceLibraryItemId', 'sourceContentHash',
      'lastFrameLibraryItemId', 'lastFrameContentHash',
    ]), 'mediaRun.preparation')
    const result = {
      kind: 'image',
      workflowId: safeId(value.workflowId, 'mediaRun.preparation.workflowId'),
    }
    optionalPair(value, 'sourceLibraryItemId', 'sourceContentHash', 'mediaRun.preparation', result)
    optionalPair(value, 'lastFrameLibraryItemId', 'lastFrameContentHash', 'mediaRun.preparation', result)
    return result
  }
  knownFields(value, new Set(['kind', 'speechBudgetUsd']), 'mediaRun.preparation')
  if (typeof value.speechBudgetUsd !== 'number' || !Number.isFinite(value.speechBudgetUsd)
    || value.speechBudgetUsd < 0.01 || value.speechBudgetUsd > 50) {
    fail('MEDIA_PREPARATION_INVALID_BUDGET', 'mediaRun.preparation.speechBudgetUsd必须在0.01到50之间')
  }
  return { kind: 'prepare-speech', speechBudgetUsd: value.speechBudgetUsd }
}

export function assertMediaRun(input, { nodeIds } = {}) {
  const run = record(input, 'mediaRun')
  knownFields(run, new Set([
    'id', 'nodeId', 'kind', 'targetId', 'inputFingerprint', 'requestSummary', 'status',
    'jobId', 'createdAt', 'updatedAt', 'errorCode', 'preparation',
  ]), 'mediaRun')
  safeId(run.id, 'mediaRun.id')
  safeId(run.nodeId, 'mediaRun.nodeId')
  if (nodeIds && !nodeIds.has(run.nodeId)) fail('MEDIA_NODE_UNKNOWN', `${run.nodeId}不是当前生产节点`)
  if (!MEDIA_RUN_KINDS.includes(run.kind)) fail('MEDIA_KIND_INVALID', `${run.kind}不是受支持媒体类型`)
  assertTargetKind(run.nodeId, run.kind)
  if (run.targetId !== null) safeId(run.targetId, 'mediaRun.targetId')
  boundedString(run.inputFingerprint, 'mediaRun.inputFingerprint', 512, FINGERPRINT)
  boundedString(run.requestSummary, 'mediaRun.requestSummary', 2_000)
  if (UNSAFE_SUMMARY.test(run.requestSummary)) fail('MEDIA_UNSAFE_SUMMARY', 'requestSummary不能包含密钥、路径或用户命令')
  if (!MEDIA_RUN_STATUSES.includes(run.status)) fail('MEDIA_STATUS_INVALID', `${run.status}不是受支持媒体状态`)
  if (run.jobId !== null) safeId(run.jobId, 'mediaRun.jobId')
  assertTimestamp(run.createdAt, 'mediaRun.createdAt')
  assertTimestamp(run.updatedAt, 'mediaRun.updatedAt')
  if (run.updatedAt < run.createdAt) fail('MEDIA_INVALID_TIMESTAMP', 'mediaRun.updatedAt不能早于createdAt')
  if (run.errorCode !== null) boundedString(run.errorCode, 'mediaRun.errorCode', 120, ERROR_CODE)
  if (Object.hasOwn(run, 'preparation')) normalizeMediaRunPreparation(run.kind, run.preparation)
  if (run.status === 'proposed' && run.jobId !== null) fail('MEDIA_PROPOSAL_JOB_BOUND', 'proposed媒体提议不能绑定Job')
  if (['queued', 'running', 'completed', 'failed', 'cancelled'].includes(run.status) && run.jobId === null) {
    fail('MEDIA_JOB_REQUIRED', `${run.status}媒体记录必须引用受管Job`)
  }
  return run
}

function stableToken(value) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

export function createMediaRunProposal(input, { now = Date.now(), idFactory } = {}) {
  const value = record(input, 'mediaRunProposal')
  knownFields(value, new Set(['id', 'nodeId', 'kind', 'targetId', 'inputFingerprint', 'requestSummary', 'preparation']), 'mediaRunProposal')
  const createdAt = assertTimestamp(now, 'now')
  const proposal = {
    id: value.id ?? `media-run-${stableToken(`${value.nodeId}|${value.kind}|${value.targetId ?? ''}|${value.inputFingerprint}|${createdAt}`)}`,
    nodeId: value.nodeId,
    kind: value.kind,
    targetId: value.targetId ?? null,
    inputFingerprint: value.inputFingerprint,
    requestSummary: value.requestSummary,
    status: 'proposed',
    jobId: null,
    createdAt,
    updatedAt: createdAt,
    errorCode: null,
    ...(value.preparation === undefined ? {} : { preparation: normalizeMediaRunPreparation(value.kind, value.preparation) }),
  }
  if (idFactory) proposal.id = idFactory(proposal)
  return assertMediaRun(proposal)
}

function findRun(project, runId) {
  const run = project?.mediaRuns?.find((item) => item.id === runId)
  if (!run) fail('MEDIA_RUN_NOT_FOUND', `找不到媒体提议${runId}`)
  return run
}

function requestOf(job) {
  return job?.request && typeof job.request === 'object' ? job.request : {}
}

function expectedJobKinds(kind) {
  if (kind === 'image') return new Set(['image', 'custom-workflow'])
  if (kind === 'video') return new Set(['video', 'provider-video', 'video-chain'])
  if (kind === 'prepare-speech' || kind === 'render-mix') return new Set(['sound-render'])
  return new Set(['final-cut'])
}

export function assertMediaJobForRun(runInput, job, { projectId, documentId } = {}) {
  const run = assertMediaRun(runInput)
  if (!job || typeof job !== 'object' || Array.isArray(job)) fail('MEDIA_JOB_INVALID', '媒体Job必须是对象')
  const jobId = safeId(job.id, 'job.id')
  if (run.jobId !== null && run.jobId !== jobId) fail('MEDIA_JOB_ID_MISMATCH', 'Job不是该媒体提议绑定的Job')
  if (!expectedJobKinds(run.kind).has(job.kind)) fail('MEDIA_JOB_KIND_MISMATCH', `${job.kind}不能执行${run.kind}`)
  if (!['queued', 'running', 'completed', 'failed', 'cancelled'].includes(job.status)) fail('MEDIA_JOB_STATUS_INVALID', 'Job状态无效')
  const binding = job.mediaBinding
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) fail('MEDIA_JOB_BINDING_INVALID', 'Job缺少严格媒体绑定')
  const bindingKeys = Object.keys(binding)
  if (bindingKeys.length !== 4 || bindingKeys.some((key) => !['projectId', 'documentId', 'runId', 'inputFingerprint'].includes(key))) {
    fail('MEDIA_JOB_BINDING_INVALID', 'Job媒体绑定字段不完整')
  }
  safeId(binding.projectId, 'job.mediaBinding.projectId')
  safeId(binding.documentId, 'job.mediaBinding.documentId')
  safeId(binding.runId, 'job.mediaBinding.runId')
  boundedString(binding.inputFingerprint, 'job.mediaBinding.inputFingerprint', 512, FINGERPRINT)
  if (binding.runId !== run.id) fail('MEDIA_JOB_RUN_MISMATCH', 'Job媒体绑定runId不匹配')
  if (binding.inputFingerprint !== run.inputFingerprint) fail('MEDIA_JOB_INPUT_MISMATCH', 'Job媒体绑定输入指纹不匹配')
  if (projectId !== undefined && binding.projectId !== projectId) fail('MEDIA_JOB_PROJECT_MISMATCH', 'Job媒体绑定项目不匹配')
  if (documentId !== undefined && binding.documentId !== documentId) fail('MEDIA_JOB_DOCUMENT_MISMATCH', 'Job媒体绑定文档不匹配')
  const request = requestOf(job)
  if (run.targetId !== null && request.targetId !== undefined && request.targetId !== run.targetId) fail('MEDIA_JOB_TARGET_MISMATCH', 'Job目标不匹配')
  if (request.candidateBinding && (
    request.candidateBinding.projectId !== binding.projectId || request.candidateBinding.documentId !== binding.documentId
    || (run.targetId !== null && request.candidateBinding.shotId !== run.targetId)
  )) {
    fail('MEDIA_JOB_CANDIDATE_INPUT_MISMATCH', 'H3候选目标与媒体绑定不匹配')
  }
  if (run.kind === 'prepare-speech' || run.kind === 'render-mix') {
    if (request.action !== undefined && request.action !== run.kind) fail('MEDIA_JOB_ACTION_MISMATCH', '声音Job动作不匹配')
  }
  return job
}

export function assertCanConfirmMediaRun(project, runId, { currentInputFingerprint, hasPreparedTarget = true } = {}) {
  const run = findRun(project, runId)
  if (project.globalPaused) fail('MEDIA_PROJECT_PAUSED', '项目已暂停，不能确认媒体提议')
  if (run.status !== 'proposed') fail('MEDIA_RUN_NOT_PROPOSED', '只有proposed媒体提议可以确认')
  if (!hasPreparedTarget) fail('MEDIA_TARGET_UNAVAILABLE', '当前没有可执行的严格目标或输入')
  if (currentInputFingerprint !== run.inputFingerprint) fail('MEDIA_INPUT_STALE', '媒体提议输入已经变化，必须重新提议')
  const node = project.nodes?.find((item) => item.id === run.nodeId)
  if (!node) fail('MEDIA_NODE_UNKNOWN', '媒体提议节点不存在')
  if (['waiting', 'paused', 'failed'].includes(node.status)) fail('MEDIA_NODE_NOT_READY', `${node.title}当前不能执行媒体提议`)
  for (const dependencyId of node.dependsOn ?? []) {
    const dependency = project.nodes.find((item) => item.id === dependencyId)
    if (!dependency || dependency.status !== 'approved') fail('MEDIA_DEPENDENCY_NOT_APPROVED', '媒体提议依赖尚未全部批准')
  }
  const active = (project.mediaRuns ?? []).find((item) => item.nodeId === run.nodeId && ['queued', 'running'].includes(item.status))
  if (active) fail('MEDIA_ACTIVE_RUN_EXISTS', '同一节点已经有活动媒体任务')
  return run
}

export async function confirmMediaRun(project, runId, options = {}) {
  const run = assertCanConfirmMediaRun(project, runId, options)
  if (typeof options.onRunMediaStep !== 'function') fail('MEDIA_HANDLER_UNAVAILABLE', '当前页面没有接入媒体执行回调')
  const job = await options.onRunMediaStep(run)
  return assertMediaJobForRun(run, job, options)
}

export function reconcileMediaRunJob(project, runId, job, context = {}) {
  const run = findRun(project, runId)
  assertMediaJobForRun(run, job, context)
  if (!['completed', 'failed', 'cancelled'].includes(job.status)) fail('MEDIA_JOB_NOT_TERMINAL', '只有终态Job可以回填媒体提议')
  const errorCode = job.status === 'failed' ? (job.error?.code ?? 'MEDIA_JOB_FAILED') : null
  return {
    changed: run.status !== job.status || run.errorCode !== errorCode,
    payload: { runId, jobId: run.jobId, status: job.status, errorCode },
  }
}

export function evaluateMediaSupervisor(project) {
  const runs = Array.isArray(project?.mediaRuns) ? project.mediaRuns.slice().sort((left, right) => right.updatedAt - left.updatedAt) : []
  const run = runs.find((item) => ['queued', 'running'].includes(item.status))
    ?? runs.find((item) => item.status === 'proposed')
    ?? runs.find((item) => {
      if (!['completed', 'failed', 'cancelled'].includes(item.status)) return false
      const node = project.nodes?.find(({ id }) => id === item.nodeId)
      // Approval or subsequent edits retire this result as a stopping point,
      // while retaining the immutable execution history in mediaRuns.
      return node && node.status !== 'approved' && node.updatedAt <= item.updatedAt
    })
    ?? null
  if (!run) return { schemaVersion: 1, status: 'none', action: 'none', run: null, canContinue: false, message: '当前没有媒体执行提议。' }
  if (run.status === 'proposed') return { schemaVersion: 1, status: 'media-proposed', action: 'confirm-media', run, canContinue: true, message: '媒体提议等待用户确认；确认前不会调用真实媒体执行器。' }
  if (run.status === 'queued' || run.status === 'running') return { schemaVersion: 1, status: 'media-running', action: 'wait-media', run, canContinue: false, message: '媒体任务已进入真实Job；督导等待Job终态。' }
  if (run.status === 'completed') return { schemaVersion: 1, status: 'media-review', action: 'review-media', run, canContinue: false, message: '媒体任务已完成；请复核候选或试听，系统不会自动批准或选择资产。' }
  if (run.status === 'failed') return { schemaVersion: 1, status: 'media-failed', action: 'retry-media', run, canContinue: true, message: `媒体任务失败：${run.errorCode ?? 'MEDIA_JOB_FAILED'}。` }
  return { schemaVersion: 1, status: 'media-cancelled', action: 'retry-media', run, canContinue: true, message: '媒体任务已取消；如需继续请确认新的媒体提议。' }
}
