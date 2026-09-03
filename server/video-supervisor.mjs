import { composeWorkspaceCreativePlan } from './agent-plan-composer.mjs'
import { assertGenerationPlan, assertStoryProject } from '../src/lib/story/storyProject.mjs'
import { migrateVideoProductionProject } from '../src/lib/story/productionPipeline.mjs'
import { evaluateVideoSupervisor } from '../src/lib/story/videoSupervisor.mjs'

const REQUEST_FIELDS = new Set(['projectId', 'documentId', 'baseRevision'])
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/u

export class VideoSupervisorError extends Error {
  constructor(code, message, status = 400, details) {
    super(message)
    this.name = 'VideoSupervisorError'
    this.code = code
    this.status = status
    if (details !== undefined) this.details = details
  }
}

function fail(code, message, status = 400, details) {
  throw new VideoSupervisorError(code, message, status, details)
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseRequest(input) {
  if (!isRecord(input)) fail('VIDEO_SUPERVISOR_INVALID_REQUEST', '制片督导请求必须是对象')
  const actual = Object.keys(input)
  const unknown = actual.filter((key) => !REQUEST_FIELDS.has(key))
  const missing = [...REQUEST_FIELDS].filter((key) => !(key in input))
  if (unknown.length || missing.length) {
    fail('VIDEO_SUPERVISOR_INVALID_REQUEST', '制片督导请求字段不符合协议', 400, { unknown, missing })
  }
  if (typeof input.projectId !== 'string' || !ID_PATTERN.test(input.projectId)) fail('VIDEO_SUPERVISOR_INVALID_REQUEST', 'projectId 无效')
  if (typeof input.documentId !== 'string' || !ID_PATTERN.test(input.documentId)) fail('VIDEO_SUPERVISOR_INVALID_REQUEST', 'documentId 无效')
  if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0) fail('VIDEO_SUPERVISOR_INVALID_REQUEST', 'baseRevision 必须是非负整数')
  return {
    projectId: input.projectId,
    documentId: input.documentId,
    baseRevision: input.baseRevision,
  }
}

function readProductionAuthority(workspaceStore, request) {
  const catalog = workspaceStore.getCatalog().catalog
  const project = catalog.projects.find((item) => item.id === request.projectId)
  if (!project) fail('WORKSPACE_PROJECT_NOT_FOUND', '当前项目不存在', 404)
  if (project.status !== 'active') fail('WORKSPACE_PROJECT_INACTIVE', '只有活动项目可以运行制片督导', 409)
  const registration = project.documents.find((item) => item.id === request.documentId)
  if (!registration) fail('WORKSPACE_DOCUMENT_NOT_FOUND', '当前项目没有登记该正文', 404)
  if (registration.modeId !== 'smart-video') fail('WORKSPACE_MODE_MISMATCH', '制片督导只能读取智能视频正文', 409)
  const stored = workspaceStore.getModeDocument(request.documentId)
  if (!stored || stored.projectId !== request.projectId || stored.modeId !== 'smart-video') {
    fail('WORKSPACE_DOCUMENT_NOT_FOUND', '当前权威智能视频正文不可用', 404)
  }
  if (registration.revision !== request.baseRevision || stored.revision !== request.baseRevision) {
    fail('REVISION_CONFLICT', `制片督导基于 r${request.baseRevision}，当前正文为 r${stored.revision}`, 409)
  }
  let body
  try { body = JSON.parse(stored.value) } catch { fail('VIDEO_SUPERVISOR_DOCUMENT_INVALID', '智能视频正文无法解析', 409) }
  if (!isRecord(body) || body.schemaVersion !== 2) fail('VIDEO_SUPERVISOR_DOCUMENT_INVALID', '智能视频正文必须是 schema v2', 409)
  const story = assertStoryProject(body.project)
  assertGenerationPlan(body.plan, story)
  const production = migrateVideoProductionProject(body.production, { story })
  if (story.id !== request.documentId) fail('WORKSPACE_DOCUMENT_ID_MISMATCH', '故事身份与工作区正文不一致', 409)
  return { body, production }
}

function supervisorInstruction(decision) {
  const node = decision.node
  return [
    `作为光阴砚制片督导，本轮只处理节点 ${node.id}（${node.title} / ${node.role}）。`,
    '请依据权威项目摘要和该节点现有目标，形成一份具体、可人工审阅的节点产物。',
    `只能返回一个 video.node.edit 步骤，input.nodeId 必须精确等于 ${node.id}。`,
    'input 必须包含非空 outputSummary；可以同时给出更明确的 instructions，但不得批准节点、启动媒体任务或声称图片、视频、音频、剪辑、质检已经真实完成。',
    '本轮结果将在只读副本预演后等待用户批准，用户随后仍可编辑、退回或批准该生产节点。',
  ].join('\n')
}

function enforceSupervisorCandidate(candidate, decision) {
  if (!Array.isArray(candidate.steps) || candidate.steps.length !== 1) {
    fail('VIDEO_SUPERVISOR_CANDIDATE_REJECTED', '制片督导每轮必须且只能返回一个节点步骤', 422)
  }
  const step = candidate.steps[0]
  if (step.toolId !== 'video.node.edit' || step.input?.nodeId !== decision.node?.id) {
    fail('VIDEO_SUPERVISOR_CANDIDATE_REJECTED', '制片督导越过了当前生产节点', 422)
  }
  if (typeof step.input.outputSummary !== 'string' || !step.input.outputSummary.trim()) {
    fail('VIDEO_SUPERVISOR_CANDIDATE_REJECTED', '制片督导必须提交非空节点产物摘要', 422)
  }
}

export async function composeWorkspaceVideoSupervisorTurn(options) {
  const request = parseRequest(options?.request)
  if (!options?.workspaceStore || !options?.agentAdapter) fail('VIDEO_SUPERVISOR_UNAVAILABLE', '制片督导服务不可用', 503)
  const authority = readProductionAuthority(options.workspaceStore, request)
  const decision = evaluateVideoSupervisor(authority.production)
  if (!decision.modelCallRequired) {
    return {
      schemaVersion: 1,
      decision,
      plan: null,
      preview: null,
      adapter: null,
      usage: null,
      elapsedMs: 0,
      contextDisclosure: null,
    }
  }

  const composed = await composeWorkspaceCreativePlan({
    request: {
      ...request,
      modeId: 'smart-video',
      instruction: supervisorInstruction(decision),
    },
    workspaceStore: options.workspaceStore,
    agentAdapter: options.agentAdapter,
    now: options.now,
    idFactory: options.idFactory,
    agentRole: 'video-supervisor',
    allowedToolIds: ['video.node.edit'],
    candidateGuard: (candidate) => enforceSupervisorCandidate(candidate, decision),
  })
  return {
    schemaVersion: 1,
    decision,
    ...composed,
  }
}
