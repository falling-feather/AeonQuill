import { randomUUID } from 'node:crypto'

import { assertCanvasDocument } from '../src/lib/canvasCore.mjs'
import {
  CreativePlanError,
  createCreativePlan,
  previewCreativePlan,
} from '../src/lib/agent/creativePlan.mjs'
import { assertPixelDocument } from '../src/lib/pixel/pixelCore.mjs'
import {
  assertGenerationPlan,
  assertStoryProject,
} from '../src/lib/story/storyProject.mjs'
import { migrateVideoProductionProject } from '../src/lib/story/productionPipeline.mjs'

const MODES = new Set(['balanced', 'pixel', 'smart-video'])
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/u
const MAX_INSTRUCTION_CHARACTERS = 4_000
const MAX_BALANCED_ELEMENTS = 160
const MAX_PIXEL_POINTS = 1_024
const BALANCED_CREATABLE_KINDS = new Set(['text', 'note', 'shape', 'pixel'])
const UNSAFE_INPUT_KEYS = /^(?:apiKey|authorization|credential|filePath|path|src|token|url|videoSrc|workflowJson)$/iu
const UNSAFE_INPUT_TEXT = /(?:data:[^\s,]{1,160},|file:\/\/|https?:\/\/|(?:^|[\s"'])\/?api\/(?:assets|project-assets)\/|(?:^|[\s"'])[a-z]:[\\/]|\\\\[^\\\s]+\\)/iu

const TOOL_GUIDES = Object.freeze({
  balanced: Object.freeze([
    'canvas.elements.add — input 只能是 {"elements":[完整且合法的非媒体 CanvasElement]}；使用 context 中不存在的新 id，只新增 text、note、shape 或 pixel，禁止 image/video/connector、src、jobId、asset 字段。',
    'canvas.elements.patch — input 只能是 {"updates":[{"id":"现有元素 id","patch":{...}}]}；只修改未锁定元素的 x、y、width、height、rotation、opacity、fill、stroke、content、fontSize、fontWeight、textAlign、radius 等视觉字段。',
    'canvas.elements.remove — input 只能是 {"ids":["现有且未锁定元素 id"]}；只有用户指令明确要求删除时才能使用。',
  ]),
  pixel: Object.freeze([
    'pixel.pixels.paint — input 恰为 {"frameId":"现有帧","layerId":"现有未锁定图层","pixels":[{"x":整数,"y":整数,"colorId":"现有调色板 id"}]}。',
    'pixel.pixels.erase — input 恰为 {"frameId":"现有帧","layerId":"现有未锁定图层","pixels":[{"x":整数,"y":整数}]}。',
    'pixel.pixels.patch — input 恰为 {"frameId":"现有帧","layerId":"现有未锁定图层","pixels":[{"x":整数,"y":整数,"value":"现有调色板 id 或 null"}]}。',
    'pixel.palette.replace — input 恰为 {"colorId":"现有调色板 id","color":"#RRGGBBAA","name":"可选名称"}。',
    'pixel.frames.duration.set — input 恰为 {"frames":[{"frameId":"现有帧","durationMs":20 到 60000 的整数}]}。',
    'pixel.cels.copy — input 恰为 {"sourceFrameId":"现有帧","targetFrameIds":["其他帧"],"layerIds":["现有未锁定图层"],"mode":"replace 或 non-transparent"}。',
  ]),
  'smart-video': Object.freeze([
    'video.project.patch — input 只能含 autoAdvance 布尔值和/或非空 brief；只在用户明确要求时修改。',
    'video.node.edit — input 恰为 {"nodeId":"当前可编辑节点 id","instructions":"可选非空指令","outputSummary":"可选摘要"}，且至少修改一项；不要替用户批准节点或变更卡。',
  ]),
})

export class AgentPlanComposerError extends Error {
  constructor(code, message, status = 400, details) {
    super(message)
    this.name = 'AgentPlanComposerError'
    this.code = code
    this.status = status
    if (details !== undefined) this.details = details
  }
}

function fail(code, message, status = 400, details) {
  throw new AgentPlanComposerError(code, message, status, details)
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function exactFields(value, fields, label) {
  if (!isRecord(value)) fail('AGENT_PLAN_COMPOSE_INVALID', `${label} 必须是对象`)
  const actual = Object.keys(value)
  const unknown = actual.filter((field) => !fields.has(field))
  const missing = [...fields].filter((field) => !(field in value))
  if (unknown.length || missing.length) fail('AGENT_PLAN_COMPOSE_INVALID', `${label} 字段不符合协议`, 400, { unknown, missing })
  return value
}

function id(value, label) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) fail('AGENT_PLAN_COMPOSE_INVALID', `${label} 无效`)
  return value
}

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail('AGENT_PLAN_COMPOSE_INVALID', `${label} 必须是非负整数`)
  return value
}

function instructionText(value) {
  if (typeof value !== 'string') fail('AGENT_PLAN_COMPOSE_INVALID', 'instruction 必须是字符串')
  const normalized = value.trim()
  if (!normalized || normalized.length > MAX_INSTRUCTION_CHARACTERS) {
    fail('AGENT_PLAN_COMPOSE_INVALID', `instruction 必须包含 1–${MAX_INSTRUCTION_CHARACTERS} 个字符`)
  }
  return normalized
}

function redactContextText(value) {
  return value
    .replace(/data:[^\s,]{1,160},[^\s"']*/giu, '[媒体数据已省略]')
    .replace(/file:\/\/[^\s"']+/giu, '[本机路径已省略]')
    .replace(/https?:\/\/[^\s"']+/giu, '[外部链接已省略]')
    .replace(/(?:^|[\s"'])[a-z]:[\\/][^\s"']*/gimu, (match) => `${match[0] === ' ' ? ' ' : ''}[本机路径已省略]`)
    .replace(/\\\\[^\\\s]+\\[^\s"']*/gu, '[本机路径已省略]')
    .replace(/\bsk-[a-z0-9_-]{8,}\b/giu, '[凭据已省略]')
}

function shortText(value, maximum = 500) {
  return typeof value === 'string' ? redactContextText(value.slice(0, maximum)) : null
}

function assertSafeModelInput(value, path = 'steps.input') {
  if (typeof value === 'string') {
    if (UNSAFE_INPUT_TEXT.test(value)) fail('AGENT_PLAN_UNSAFE_REFERENCE', `${path} 不得包含路径、媒体数据或外部 URL`)
    return
  }
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeModelInput(item, `${path}[${index}]`))
    return
  }
  for (const [key, child] of Object.entries(value)) {
    if (UNSAFE_INPUT_KEYS.test(key)) fail('AGENT_PLAN_UNSAFE_REFERENCE', `${path}.${key} 不是文本智能体可写字段`)
    assertSafeModelInput(child, `${path}.${key}`)
  }
}

function enforceModelToolBoundary(modeId, instruction, step) {
  assertSafeModelInput(step.input)
  if (modeId !== 'balanced') return
  if (step.toolId === 'canvas.elements.add') {
    if (!Array.isArray(step.input.elements) || step.input.elements.some((element) => (
      !isRecord(element) || !BALANCED_CREATABLE_KINDS.has(element.kind)
    ))) {
      fail('AGENT_PLAN_TOOL_INPUT_FORBIDDEN', '文本智能体只能创建 text、note、shape 或 pixel 元件')
    }
  }
  if (step.toolId === 'canvas.elements.remove' && !/(?:删除|移除|清除|删掉|delete|remove)/iu.test(instruction)) {
    fail('AGENT_PLAN_DELETE_NOT_REQUESTED', '用户未明确要求删除，文本智能体不能生成删除步骤')
  }
}

function summarizeBalanced(value) {
  const document = assertCanvasDocument(value)
  const elements = document.elements.slice(0, MAX_BALANCED_ELEMENTS).map((element) => ({
    id: element.id,
    kind: element.kind,
    name: shortText(element.name, 120),
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
    rotation: element.rotation,
    opacity: element.opacity,
    locked: element.locked,
    visible: element.visible,
    zIndex: element.zIndex,
    content: ['text', 'note'].includes(element.kind) ? shortText(element.content, 1_000) : null,
    fill: shortText(element.fill, 32),
    stroke: shortText(element.stroke, 32),
  }))
  return {
    document: {
      id: document.id,
      title: shortText(document.title, 120),
      revision: document.revision,
      camera: document.camera,
      elements,
      omittedElementCount: Math.max(0, document.elements.length - elements.length),
    },
  }
}

function summarizePixel(value) {
  const document = assertPixelDocument(value)
  const activeFrame = document.frames.find((frame) => frame.id === document.activeFrameId)
  const activeCel = activeFrame?.cels?.[document.activeLayerId] ?? []
  const activePixels = []
  let nonTransparentCount = 0
  for (let index = 0; index < activeCel.length; index += 1) {
    const colorId = activeCel[index]
    if (colorId === null) continue
    nonTransparentCount += 1
    if (activePixels.length < MAX_PIXEL_POINTS) {
      activePixels.push({ x: index % document.width, y: Math.floor(index / document.width), colorId })
    }
  }
  return {
    document: {
      id: document.id,
      name: shortText(document.name, 120),
      revision: document.revision,
      width: document.width,
      height: document.height,
      activeFrameId: document.activeFrameId,
      activeLayerId: document.activeLayerId,
      palette: document.palette.map(({ id: colorId, name, color }) => ({ id: colorId, name, color })),
      layers: document.layers.map(({ id: layerId, name, visible, locked, opacity, groupId, blendMode }) => ({
        id: layerId, name, visible, locked, opacity, groupId, blendMode,
      })),
      frames: document.frames.map(({ id: frameId, name, durationMs }) => ({ id: frameId, name, durationMs })),
      activePixels,
      omittedActivePixelCount: Math.max(0, nonTransparentCount - activePixels.length),
    },
  }
}

function summarizeSmartVideo(value) {
  if (!isRecord(value) || value.schemaVersion !== 2) fail('AGENT_PLAN_DOCUMENT_INVALID', '智能视频正文必须是 schema v2', 409)
  const story = assertStoryProject(value.project)
  assertGenerationPlan(value.plan, story)
  const production = migrateVideoProductionProject(value.production, { story })
  const durationSeconds = story.scenes.reduce((sceneTotal, scene) => (
    sceneTotal + scene.shots.reduce((shotTotal, shot) => shotTotal + shot.durationSeconds, 0)
  ), 0)
  return {
    story: {
      id: story.id,
      title: shortText(story.title, 160),
      revision: story.revision,
      durationSeconds,
      sceneCount: story.scenes.length,
      shotCount: story.scenes.reduce((total, scene) => total + scene.shots.length, 0),
    },
    production: {
      id: production.id,
      title: shortText(production.title, 160),
      revision: production.revision,
      brief: shortText(production.brief, 2_000),
      autoAdvance: production.autoAdvance,
      nodes: production.nodes.map((node) => ({
        id: node.id,
        title: shortText(node.title, 120),
        purpose: shortText(node.purpose, 500),
        status: node.status,
        revision: node.revision,
        stale: node.stale,
        instructions: shortText(node.instructions, 2_000),
        outputSummary: shortText(node.outputSummary, 2_000),
      })),
      proposedChangeCards: production.changeCards
        .filter((card) => card.status === 'proposed')
        .map((card) => ({ id: card.id, nodeId: card.nodeId, title: shortText(card.title, 120) })),
    },
  }
}

export function buildCreativePlanContext(modeId, value) {
  if (!MODES.has(modeId)) fail('AGENT_PLAN_COMPOSE_INVALID', 'modeId 不受支持')
  return modeId === 'balanced'
    ? summarizeBalanced(value)
    : modeId === 'pixel'
      ? summarizePixel(value)
      : summarizeSmartVideo(value)
}

function findRegistration(catalog, projectId, documentId) {
  const project = catalog.projects.find((item) => item.id === projectId)
  if (!project) fail('WORKSPACE_PROJECT_NOT_FOUND', '当前项目不存在', 404)
  if (project.status !== 'active') fail('WORKSPACE_PROJECT_INACTIVE', '只有活动项目可以请求文本智能体计划', 409)
  const registration = project.documents.find((item) => item.id === documentId)
  if (!registration) fail('WORKSPACE_DOCUMENT_NOT_FOUND', '当前项目没有登记该正文', 404)
  return { project, registration }
}

function readAuthority(workspaceStore, request) {
  const catalog = workspaceStore.getCatalog().catalog
  const { registration } = findRegistration(catalog, request.projectId, request.documentId)
  if (registration.modeId !== request.modeId) fail('WORKSPACE_MODE_MISMATCH', '正文模式与计划请求不一致', 409)
  const stored = workspaceStore.getModeDocument(request.documentId)
  if (!stored || stored.projectId !== request.projectId || stored.modeId !== request.modeId) {
    fail('WORKSPACE_DOCUMENT_NOT_FOUND', '当前权威正文不可用', 404)
  }
  if (stored.revision !== request.baseRevision || registration.revision !== request.baseRevision) {
    fail('REVISION_CONFLICT', `文本计划请求基于 r${request.baseRevision}，当前正文为 r${stored.revision}`, 409)
  }
  let value
  try { value = JSON.parse(stored.value) } catch { fail('AGENT_PLAN_DOCUMENT_INVALID', '当前权威正文无法解析', 409) }
  return { catalog, registration, stored, value }
}

export async function composeWorkspaceCreativePlan(options) {
  const request = exactFields(options?.request, new Set([
    'projectId', 'documentId', 'modeId', 'baseRevision', 'instruction',
  ]), '计划编译请求')
  id(request.projectId, 'projectId')
  id(request.documentId, 'documentId')
  if (!MODES.has(request.modeId)) fail('AGENT_PLAN_COMPOSE_INVALID', 'modeId 不受支持')
  integer(request.baseRevision, 'baseRevision')
  const instruction = instructionText(request.instruction)
  if (!options.workspaceStore || !options.agentAdapter) fail('AGENT_PLAN_COMPOSER_UNAVAILABLE', '计划编译服务不可用', 503)
  const modeToolGuides = TOOL_GUIDES[request.modeId]
  const exposedToolIds = options.allowedToolIds === undefined
    ? modeToolGuides.map((entry) => entry.split(' — ', 1)[0])
    : options.allowedToolIds
  if (
    !Array.isArray(exposedToolIds)
    || exposedToolIds.length < 1
    || new Set(exposedToolIds).size !== exposedToolIds.length
  ) {
    fail('AGENT_PLAN_COMPOSER_INVALID_POLICY', '文本计划内部工具策略无效', 500)
  }
  const availableToolIds = new Set(modeToolGuides.map((entry) => entry.split(' — ', 1)[0]))
  if (exposedToolIds.some((toolId) => typeof toolId !== 'string' || !availableToolIds.has(toolId))) {
    fail('AGENT_PLAN_COMPOSER_INVALID_POLICY', '文本计划内部工具策略包含未登记能力', 500)
  }
  const toolGuide = modeToolGuides.filter((entry) => exposedToolIds.includes(entry.split(' — ', 1)[0]))
  const agentRole = options.agentRole ?? 'cross-mode-planner'
  id(agentRole, 'agentRole')

  const before = readAuthority(options.workspaceStore, request)
  const context = buildCreativePlanContext(request.modeId, before.value)
  const composed = await options.agentAdapter.composeCreativePlan({
    modeId: request.modeId,
    instruction,
    context,
    toolGuide,
  })

  const after = readAuthority(options.workspaceStore, request)
  if (after.stored.value !== before.stored.value) {
    fail('REVISION_CONFLICT', '模型返回期间权威正文发生变化，请重新请求', 409)
  }
  const allowedTools = new Set(exposedToolIds)
  for (const step of composed.candidate.steps) {
    if (!allowedTools.has(step.toolId)) fail('AGENT_PLAN_TOOL_NOT_EXPOSED', `文本智能体不能使用工具 ${step.toolId}`, 400)
    enforceModelToolBoundary(request.modeId, instruction, step)
  }
  options.candidateGuard?.(composed.candidate, {
    request: structuredClone(request),
    context: structuredClone(context),
  })

  const now = options.now?.() ?? Date.now()
  const idFactory = options.idFactory ?? randomUUID
  let plan
  let preview
  try {
    plan = createCreativePlan({
      id: `plan-${idFactory()}`,
      projectId: request.projectId,
      documentId: request.documentId,
      modeId: request.modeId,
      baseRevision: request.baseRevision,
      title: composed.candidate.title,
      objective: composed.candidate.objective,
      source: {
        kind: 'byok-text',
        agentRole,
        modelId: composed.adapter.model,
        requestHash: composed.requestHash,
      },
      steps: composed.candidate.steps.map((step, index) => ({
        id: `step-${index + 1}-${idFactory()}`,
        toolId: step.toolId,
        summary: step.summary,
        input: step.input,
        sourceAssets: [],
      })),
      createdAt: now,
    })
    preview = previewCreativePlan(after.value, plan, {
      workspaceRevision: request.baseRevision,
      now,
    })
  } catch (error) {
    if (error instanceof AgentPlanComposerError) throw error
    fail('AGENT_PLAN_CANDIDATE_REJECTED', '模型计划未通过本地安全工具校验', 422, {
      causeCode: error instanceof CreativePlanError ? error.code : (error?.code ?? 'UNKNOWN_VALIDATION_ERROR'),
    })
  }
  return {
    plan,
    preview: {
      schemaVersion: preview.schemaVersion,
      planId: preview.planId,
      modeId: preview.modeId,
      baseRevision: preview.baseRevision,
      resultRevision: preview.resultRevision,
      summaries: preview.summaries,
    },
    adapter: composed.adapter,
    usage: composed.usage,
    elapsedMs: composed.elapsedMs,
    contextDisclosure: {
      schemaVersion: 1,
      contextBytes: composed.contextBytes,
      includes: ['用户指令', '当前正文的有界结构摘要', '安全工具说明'],
      excludes: ['API 密钥', '本机路径', '媒体 URL 与媒体字节', '任务私有路径'],
    },
  }
}

export function creativePlanToolGuides() {
  return structuredClone(TOOL_GUIDES)
}
