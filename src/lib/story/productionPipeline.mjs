export const VIDEO_PRODUCTION_SCHEMA_VERSION = 1
export const VIDEO_PRODUCTION_COMMAND_SCHEMA_VERSION = 1

export const VIDEO_PRODUCTION_LIMITS = Object.freeze({
  maxBriefCharacters: 4_000,
  maxInstructionCharacters: 4_000,
  maxOutputCharacters: 12_000,
  maxDurationMinutes: 30,
  maxEvents: 200,
})

const PROJECT_KIND = 'aeonquill.video-production'
const NODE_STATUSES = new Set(['waiting', 'ready', 'running', 'paused', 'review', 'approved', 'revision', 'failed'])
const ASPECT_RATIOS = new Set(['16:9', '9:16', '1:1'])
const COMMAND_TYPES = new Set([
  'project.patch',
  'project.pause',
  'project.resume',
  'node.start',
  'node.pause',
  'node.resume',
  'node.edit',
  'node.submit-review',
  'node.approve',
  'node.request-revision',
  'node.fail',
  'node.reset',
])

const NODE_BLUEPRINTS = Object.freeze([
  {
    id: 'producer',
    role: 'producer',
    title: '制片统筹',
    purpose: '确定体量、资源预算、交付边界与生产顺序',
    adapter: 'deterministic-local',
    dependsOn: [],
    artifact: 'plan_overview.md',
  },
  {
    id: 'screenwriter',
    role: 'screenwriter',
    title: '剧本设计',
    purpose: '形成三幕结构、场景节拍、人物弧光与对白密度',
    adapter: 'text-model-optional',
    dependsOn: ['producer'],
    artifact: 'script_outline.md',
  },
  {
    id: 'character-designer',
    role: 'character-designer',
    title: '人物设定',
    purpose: '建立角色圣经、服装道具、多角度与身份约束',
    adapter: 'text-model-optional',
    dependsOn: ['screenwriter'],
    artifact: 'characters.md',
  },
  {
    id: 'art-director',
    role: 'art-director',
    title: '场景美术',
    purpose: '建立地点圣经、色彩脚本、光照和时代细节',
    adapter: 'text-model-optional',
    dependsOn: ['character-designer'],
    artifact: 'locations.md',
  },
  {
    id: 'storyboard-director',
    role: 'storyboard-director',
    title: '分镜导演',
    purpose: '把场景拆成可执行镜头，固定景别、运动和首尾帧策略',
    adapter: 'deterministic-local',
    dependsOn: ['art-director'],
    artifact: 'storyboard.md',
  },
  {
    id: 'asset-producer',
    role: 'asset-producer',
    title: '素材生成',
    purpose: '生成并审核角色、地点、道具、首帧和末帧资产',
    adapter: 'comfyui-image',
    dependsOn: ['storyboard-director'],
    artifact: 'assets_index.json',
  },
  {
    id: 'video-director',
    role: 'video-director',
    title: 'H3 镜头生成',
    purpose: '仅把已审批镜头送入固定 H3 清单，保留批次和失败断点',
    adapter: 'comfyui-h3',
    dependsOn: ['asset-producer'],
    artifact: 'h3_batches.json',
  },
  {
    id: 'editor',
    role: 'editor',
    title: '自动剪辑',
    purpose: '按镜头表拼接、节奏调整、转场和可回退粗剪',
    adapter: 'ffmpeg-local',
    dependsOn: ['video-director'],
    artifact: 'rough_cut.json',
  },
  {
    id: 'sound-director',
    role: 'sound-director',
    title: '声音字幕',
    purpose: '组织对白、旁白、字幕、环境声、音乐与响度',
    adapter: 'audio-adapter-optional',
    dependsOn: ['editor'],
    artifact: 'audio_subtitle.json',
  },
  {
    id: 'quality-controller',
    role: 'quality-controller',
    title: '成片质检',
    purpose: '检查身份、连续性、黑帧、字幕、声画同步与交付规格',
    adapter: 'deterministic-local',
    dependsOn: ['sound-director'],
    artifact: 'qa_report.md',
  },
])

export class VideoProductionError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'VideoProductionError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

function fail(code, message, details) {
  throw new VideoProductionError(code, message, details)
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function record(value, path) {
  if (!isRecord(value)) fail('INVALID_OBJECT', `${path} must be an object`)
  return value
}

function knownFields(value, fields, path) {
  for (const key of Object.keys(value)) if (!fields.has(key)) fail('UNKNOWN_FIELD', `${path}.${key} is not allowed`)
}

function string(value, path, min, max) {
  if (typeof value !== 'string') fail('INVALID_STRING', `${path} must be a string`)
  const normalized = value.trim()
  if (normalized.length < min || normalized.length > max) fail('INVALID_STRING', `${path} must contain ${min}-${max} characters`)
  return normalized
}

function integer(value, path, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('INVALID_INTEGER', `${path} must be an integer between ${min} and ${max}`)
  return value
}

function boolean(value, path) {
  if (typeof value !== 'boolean') fail('INVALID_BOOLEAN', `${path} must be a boolean`)
  return value
}

function id(value, path) {
  const normalized = string(value, path, 1, 80)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(normalized)) fail('INVALID_ID', `${path} is not a safe id`)
  return normalized
}

function stableToken(value) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function defaultInstructions(blueprint, settings) {
  if (blueprint.role === 'screenwriter') {
    return `基于制片计划设计完整${settings.genre}短剧：三幕结构、约 ${settings.sceneCount} 场、人物弧光、关键冲突和中文对白；不得把概述冒充终稿。`
  }
  if (blueprint.role === 'storyboard-director') {
    return `把已审批剧本拆为约 ${settings.shotCount} 个平均 5 秒镜头，逐镜头声明景别、运动、角色、地点、连续性和首尾帧。`
  }
  if (blueprint.role === 'video-director') {
    return `把已审批且资产就绪的镜头按每批最多 5 个编入固定 MiniMax H3 清单；单卡顺序执行，不提交任意 ComfyUI JSON。`
  }
  return blueprint.purpose
}

function draftOutput(role, project) {
  const { sceneCount, shotCount, batchCount, generationMinutesLow, generationMinutesHigh } = project.estimates
  if (role === 'producer') {
    return `${sceneCount} 场 / ${shotCount} 镜头 / ${batchCount} 批；RTX 4060 以 720P 母版逐镜头顺序生成约 ${Math.round(generationMinutesLow / 60)}–${Math.round(generationMinutesHigh / 60)} 小时，未计人工返修。`
  }
  if (role === 'screenwriter') {
    return `三幕 ${sceneCount} 场：第一幕立誓与入局，第二幕追查与背叛，第三幕决战与余波。主角在门派旧案、同盟信任和个人执念之间完成选择；当前是可编辑大纲，不是完整对白终稿。`
  }
  if (role === 'character-designer') return '主角、对手、盟友与关键配角的角色圣经；包含正侧背三视图需求、服装层级、武器、禁改特征和表情范围。'
  if (role === 'art-director') return `${sceneCount} 个场景的地点圣经、色彩脚本、昼夜/天气、时代道具和构图禁区。`
  if (role === 'storyboard-director') return `${sceneCount} 场、约 ${shotCount} 镜头的镜头表；每镜头平均 5 秒，并声明角色/地点绑定、首尾帧和运动方向。`
  if (role === 'asset-producer') return '等待真实图片资产与用户审核；未生成的角色、地点和关键帧不会被标记为完成。'
  if (role === 'video-director') return `等待 ${batchCount} 个受控 H3 批次的真实 Job 与资产回填；当前没有生成视频。`
  if (role === 'editor') return '等待真实镜头资产后生成可回退粗剪 EDL、转场与节奏标记。'
  if (role === 'sound-director') return '等待粗剪后生成对白/字幕/音乐/环境声清单；外部语音服务尚未接入。'
  return '等待真实粗剪、音频和字幕资产后执行确定性质检并形成问题单。'
}

function appendEvent(project, type, nodeId, message, at) {
  project.events.push({
    id: `event-${project.revision + 1}-${project.events.length + 1}`,
    at,
    type,
    nodeId,
    message,
  })
  if (project.events.length > VIDEO_PRODUCTION_LIMITS.maxEvents) {
    project.events.splice(0, project.events.length - VIDEO_PRODUCTION_LIMITS.maxEvents)
  }
}

function dependencyMap(nodes) {
  return new Map(nodes.map((node) => [node.id, node]))
}

function dependenciesApproved(node, byId) {
  return node.dependsOn.every((dependencyId) => byId.get(dependencyId)?.status === 'approved')
}

function refreshReadiness(project) {
  const byId = dependencyMap(project.nodes)
  for (const node of project.nodes) {
    const ready = dependenciesApproved(node, byId)
    if (node.status === 'waiting' && ready) node.status = 'ready'
    if (node.status === 'ready' && !ready) node.status = 'waiting'
  }
}

function descendantIds(project, nodeId) {
  const descendants = new Set()
  let changed = true
  while (changed) {
    changed = false
    for (const node of project.nodes) {
      if (!descendants.has(node.id) && node.dependsOn.some((dependencyId) => dependencyId === nodeId || descendants.has(dependencyId))) {
        descendants.add(node.id)
        changed = true
      }
    }
  }
  return descendants
}

function invalidateDownstream(project, nodeId, at) {
  const descendants = descendantIds(project, nodeId)
  for (const node of project.nodes) {
    if (!descendants.has(node.id)) continue
    node.status = 'waiting'
    node.stale = Boolean(node.outputSummary)
    node.updatedAt = at
  }
}

function assertNode(input, path, knownIds) {
  const node = record(input, path)
  knownFields(node, new Set(['id', 'order', 'role', 'title', 'purpose', 'adapter', 'status', 'dependsOn', 'instructions', 'outputSummary', 'artifact', 'revision', 'updatedAt', 'stale', 'error']), path)
  id(node.id, `${path}.id`)
  integer(node.order, `${path}.order`, 1, NODE_BLUEPRINTS.length)
  string(node.role, `${path}.role`, 1, 80)
  string(node.title, `${path}.title`, 1, 80)
  string(node.purpose, `${path}.purpose`, 1, 240)
  string(node.adapter, `${path}.adapter`, 1, 80)
  if (!NODE_STATUSES.has(node.status)) fail('INVALID_STATUS', `${path}.status is unsupported`)
  if (!Array.isArray(node.dependsOn) || node.dependsOn.some((dependencyId) => !knownIds.has(dependencyId))) fail('INVALID_DEPENDENCY', `${path}.dependsOn contains an unknown node`)
  if (new Set(node.dependsOn).size !== node.dependsOn.length || node.dependsOn.includes(node.id)) fail('INVALID_DEPENDENCY', `${path}.dependsOn must be unique and acyclic`)
  string(node.instructions, `${path}.instructions`, 1, VIDEO_PRODUCTION_LIMITS.maxInstructionCharacters)
  if (typeof node.outputSummary !== 'string' || node.outputSummary.length > VIDEO_PRODUCTION_LIMITS.maxOutputCharacters) fail('INVALID_OUTPUT', `${path}.outputSummary is invalid`)
  string(node.artifact, `${path}.artifact`, 1, 120)
  integer(node.revision, `${path}.revision`, 0, Number.MAX_SAFE_INTEGER)
  integer(node.updatedAt, `${path}.updatedAt`, 1, Number.MAX_SAFE_INTEGER)
  boolean(node.stale, `${path}.stale`)
  if (node.error !== null && (typeof node.error !== 'string' || node.error.length > 1_000)) fail('INVALID_ERROR', `${path}.error is invalid`)
}

export function assertVideoProductionProject(input) {
  const project = record(input, 'project')
  knownFields(project, new Set(['kind', 'schemaVersion', 'id', 'title', 'brief', 'settings', 'estimates', 'nodes', 'globalPaused', 'autoAdvance', 'revision', 'createdAt', 'updatedAt', 'events']), 'project')
  if (project.kind !== PROJECT_KIND || project.schemaVersion !== VIDEO_PRODUCTION_SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA', 'Unsupported video production schema')
  id(project.id, 'project.id')
  string(project.title, 'project.title', 1, 120)
  string(project.brief, 'project.brief', 1, VIDEO_PRODUCTION_LIMITS.maxBriefCharacters)
  const settings = record(project.settings, 'project.settings')
  knownFields(settings, new Set(['durationMinutes', 'genre', 'aspectRatio']), 'project.settings')
  integer(settings.durationMinutes, 'project.settings.durationMinutes', 1, VIDEO_PRODUCTION_LIMITS.maxDurationMinutes)
  string(settings.genre, 'project.settings.genre', 1, 40)
  if (!ASPECT_RATIOS.has(settings.aspectRatio)) fail('INVALID_ASPECT_RATIO', 'project.settings.aspectRatio is unsupported')
  const estimates = record(project.estimates, 'project.estimates')
  knownFields(estimates, new Set(['sceneCount', 'shotCount', 'batchCount', 'generationMinutesLow', 'generationMinutesHigh']), 'project.estimates')
  integer(estimates.sceneCount, 'project.estimates.sceneCount', 1, 80)
  integer(estimates.shotCount, 'project.estimates.shotCount', 1, 320)
  integer(estimates.batchCount, 'project.estimates.batchCount', 1, 320)
  integer(estimates.generationMinutesLow, 'project.estimates.generationMinutesLow', 1, 100_000)
  integer(estimates.generationMinutesHigh, 'project.estimates.generationMinutesHigh', estimates.generationMinutesLow, 200_000)
  if (!Array.isArray(project.nodes) || project.nodes.length !== NODE_BLUEPRINTS.length) fail('INVALID_NODES', `project.nodes must contain ${NODE_BLUEPRINTS.length} nodes`)
  const knownIds = new Set(project.nodes.map((node) => node?.id))
  if (knownIds.size !== project.nodes.length) fail('DUPLICATE_ID', 'project.nodes contains duplicate ids')
  project.nodes.forEach((node, index) => assertNode(node, `project.nodes[${index}]`, knownIds))
  const orderById = new Map(project.nodes.map((node) => [node.id, node.order]))
  for (const [index, node] of project.nodes.entries()) {
    if (node.dependsOn.some((dependencyId) => orderById.get(dependencyId) >= node.order)) {
      fail('INVALID_DEPENDENCY', `project.nodes[${index}].dependsOn must only reference earlier production nodes`)
    }
  }
  boolean(project.globalPaused, 'project.globalPaused')
  boolean(project.autoAdvance, 'project.autoAdvance')
  integer(project.revision, 'project.revision', 0, Number.MAX_SAFE_INTEGER)
  integer(project.createdAt, 'project.createdAt', 1, Number.MAX_SAFE_INTEGER)
  integer(project.updatedAt, 'project.updatedAt', project.createdAt, Number.MAX_SAFE_INTEGER)
  if (!Array.isArray(project.events) || project.events.length > VIDEO_PRODUCTION_LIMITS.maxEvents) fail('INVALID_EVENTS', 'project.events is invalid')
  for (const [index, eventInput] of project.events.entries()) {
    const event = record(eventInput, `project.events[${index}]`)
    knownFields(event, new Set(['id', 'at', 'type', 'nodeId', 'message']), `project.events[${index}]`)
    id(event.id, `project.events[${index}].id`)
    integer(event.at, `project.events[${index}].at`, project.createdAt, Number.MAX_SAFE_INTEGER)
    string(event.type, `project.events[${index}].type`, 1, 80)
    if (event.nodeId !== null && !knownIds.has(event.nodeId)) fail('INVALID_EVENT', `project.events[${index}].nodeId is unknown`)
    string(event.message, `project.events[${index}].message`, 1, 500)
  }
  return project
}

export function createVideoProductionProject(input = {}) {
  const value = record(input, 'input')
  knownFields(value, new Set(['id', 'title', 'brief', 'durationMinutes', 'genre', 'aspectRatio', 'now']), 'input')
  const brief = string(value.brief ?? '我想要生成一部十分钟左右的武侠剧', 'input.brief', 1, VIDEO_PRODUCTION_LIMITS.maxBriefCharacters)
  const durationMinutes = integer(value.durationMinutes ?? 10, 'input.durationMinutes', 1, VIDEO_PRODUCTION_LIMITS.maxDurationMinutes)
  const genre = string(value.genre ?? '武侠', 'input.genre', 1, 40)
  const aspectRatio = value.aspectRatio ?? '16:9'
  if (!ASPECT_RATIOS.has(aspectRatio)) fail('INVALID_ASPECT_RATIO', 'input.aspectRatio is unsupported')
  const now = integer(value.now ?? Date.now(), 'input.now', 1, Number.MAX_SAFE_INTEGER)
  const sceneCount = Math.max(3, Math.min(80, Math.round(durationMinutes * 1.2)))
  const shotCount = Math.max(sceneCount, Math.min(320, durationMinutes * 12))
  const batchCount = Math.ceil(shotCount / 5)
  const settings = { durationMinutes, genre, aspectRatio, sceneCount, shotCount }
  const project = {
    kind: PROJECT_KIND,
    schemaVersion: VIDEO_PRODUCTION_SCHEMA_VERSION,
    id: value.id ? id(value.id, 'input.id') : `production-${stableToken(`${brief}|${durationMinutes}|${genre}|${aspectRatio}`)}`,
    title: value.title ? string(value.title, 'input.title', 1, 120) : `${durationMinutes} 分钟${genre}短剧`,
    brief,
    settings: { durationMinutes, genre, aspectRatio },
    estimates: {
      sceneCount,
      shotCount,
      batchCount,
      generationMinutesLow: shotCount * 20,
      generationMinutesHigh: shotCount * 40,
    },
    nodes: NODE_BLUEPRINTS.map((blueprint, index) => ({
      ...blueprint,
      order: index + 1,
      status: blueprint.id === 'producer' ? 'approved' : blueprint.id === 'screenwriter' ? 'review' : 'waiting',
      instructions: defaultInstructions(blueprint, settings),
      outputSummary: blueprint.id === 'producer' || blueprint.id === 'screenwriter' ? draftOutput(blueprint.role, { estimates: { sceneCount, shotCount, batchCount, generationMinutesLow: shotCount * 20, generationMinutesHigh: shotCount * 40 } }) : '',
      revision: blueprint.id === 'producer' || blueprint.id === 'screenwriter' ? 1 : 0,
      updatedAt: now,
      stale: false,
      error: null,
    })),
    globalPaused: false,
    autoAdvance: false,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    events: [
      { id: 'event-0-1', at: now, type: 'project.created', nodeId: null, message: '已建立本地确定性生产图；剧本大纲等待用户审批。' },
    ],
  }
  return assertVideoProductionProject(project)
}

export function serializeVideoProductionProject(project, options = {}) {
  assertVideoProductionProject(project)
  return JSON.stringify(project, null, options?.pretty === true ? 2 : 0)
}

export function deserializeVideoProductionProject(serialized) {
  if (typeof serialized !== 'string') fail('INVALID_SERIALIZED_PROJECT', 'Serialized production project must be a string')
  let parsed
  try { parsed = JSON.parse(serialized) } catch { fail('INVALID_JSON', 'Serialized production project is not valid JSON') }
  return clone(assertVideoProductionProject(parsed))
}

export function createVideoProductionCommand(projectInput, type, payload = {}, options = {}) {
  const project = assertVideoProductionProject(projectInput)
  if (!COMMAND_TYPES.has(type)) fail('UNKNOWN_COMMAND', `Unsupported production command ${String(type)}`)
  const command = {
    schemaVersion: VIDEO_PRODUCTION_COMMAND_SCHEMA_VERSION,
    id: options.id ?? `production-command-${project.revision + 1}`,
    actor: options.actor ?? 'user',
    baseRevision: project.revision,
    type,
    payload,
  }
  assertVideoProductionCommand(command, project)
  return clone(command)
}

export function assertVideoProductionCommand(input, projectInput) {
  const command = record(input, 'command')
  knownFields(command, new Set(['schemaVersion', 'id', 'actor', 'baseRevision', 'type', 'payload']), 'command')
  if (command.schemaVersion !== VIDEO_PRODUCTION_COMMAND_SCHEMA_VERSION) fail('UNSUPPORTED_COMMAND_SCHEMA', 'Unsupported production command schema')
  id(command.id, 'command.id')
  if (!['user', 'orchestrator'].includes(command.actor)) fail('INVALID_ACTOR', 'command.actor is unsupported')
  integer(command.baseRevision, 'command.baseRevision', 0, Number.MAX_SAFE_INTEGER)
  if (!COMMAND_TYPES.has(command.type)) fail('UNKNOWN_COMMAND', `Unsupported production command ${String(command.type)}`)
  const payload = record(command.payload, 'command.payload')
  const project = projectInput ? assertVideoProductionProject(projectInput) : null
  if (command.type === 'project.patch') {
    knownFields(payload, new Set(['autoAdvance', 'brief']), 'command.payload')
    if (!Object.keys(payload).length) fail('EMPTY_PATCH', 'Project patch must change a field')
    if (payload.autoAdvance !== undefined) boolean(payload.autoAdvance, 'command.payload.autoAdvance')
    if (payload.brief !== undefined) string(payload.brief, 'command.payload.brief', 1, VIDEO_PRODUCTION_LIMITS.maxBriefCharacters)
    return command
  }
  if (command.type === 'project.pause' || command.type === 'project.resume') {
    knownFields(payload, new Set(), 'command.payload')
    return command
  }
  knownFields(payload, new Set(command.type === 'node.edit'
    ? ['nodeId', 'instructions', 'outputSummary']
    : command.type === 'node.submit-review'
      ? ['nodeId', 'outputSummary']
      : command.type === 'node.fail'
        ? ['nodeId', 'message']
        : ['nodeId']), 'command.payload')
  id(payload.nodeId, 'command.payload.nodeId')
  if (project && !project.nodes.some((node) => node.id === payload.nodeId)) fail('UNKNOWN_NODE', `Unknown production node ${payload.nodeId}`)
  if (command.type === 'node.edit') {
    if (payload.instructions === undefined && payload.outputSummary === undefined) fail('EMPTY_PATCH', 'Node edit must change instructions or output')
    if (payload.instructions !== undefined) string(payload.instructions, 'command.payload.instructions', 1, VIDEO_PRODUCTION_LIMITS.maxInstructionCharacters)
    if (payload.outputSummary !== undefined && (typeof payload.outputSummary !== 'string' || payload.outputSummary.length > VIDEO_PRODUCTION_LIMITS.maxOutputCharacters)) fail('INVALID_OUTPUT', 'command.payload.outputSummary is invalid')
  }
  if (command.type === 'node.submit-review') string(payload.outputSummary, 'command.payload.outputSummary', 1, VIDEO_PRODUCTION_LIMITS.maxOutputCharacters)
  if (command.type === 'node.fail') string(payload.message, 'command.payload.message', 1, 1_000)
  return command
}

function requireStatus(node, statuses, action) {
  if (!statuses.includes(node.status)) fail('INVALID_TRANSITION', `${node.title} cannot ${action} from ${node.status}`, { nodeId: node.id, status: node.status })
}

export function applyVideoProductionCommand(projectInput, commandInput, options = {}) {
  const project = assertVideoProductionProject(projectInput)
  const command = assertVideoProductionCommand(commandInput, project)
  if (command.baseRevision !== project.revision) fail('REVISION_CONFLICT', `Command revision ${command.baseRevision} does not match project revision ${project.revision}`)
  const now = integer(options.now ?? Date.now(), 'options.now', project.updatedAt, Number.MAX_SAFE_INTEGER)
  const next = clone(project)
  const payload = command.payload
  const node = payload.nodeId ? next.nodes.find((item) => item.id === payload.nodeId) : null

  switch (command.type) {
    case 'project.patch':
      if (payload.autoAdvance !== undefined) next.autoAdvance = payload.autoAdvance
      if (payload.brief !== undefined) next.brief = payload.brief.trim()
      appendEvent(next, 'project.edited', null, '制片设置已更新。', now)
      break
    case 'project.pause':
      if (next.globalPaused) fail('INVALID_TRANSITION', 'Production pipeline is already paused')
      next.globalPaused = true
      for (const item of next.nodes) if (item.status === 'running') item.status = 'paused'
      appendEvent(next, 'project.paused', null, '全链路已暂停；运行中节点已安全停在当前阶段。', now)
      break
    case 'project.resume':
      if (!next.globalPaused) fail('INVALID_TRANSITION', 'Production pipeline is not paused')
      next.globalPaused = false
      for (const item of next.nodes) if (item.status === 'paused') item.status = 'running'
      appendEvent(next, 'project.resumed', null, '全链路已恢复。', now)
      break
    case 'node.start':
      if (next.globalPaused) fail('PROJECT_PAUSED', 'Resume the production pipeline before starting a node')
      requireStatus(node, ['ready', 'revision'], 'start')
      if (!dependenciesApproved(node, dependencyMap(next.nodes))) fail('DEPENDENCY_BLOCKED', `${node.title} has unapproved dependencies`)
      node.status = 'running'
      node.error = null
      node.stale = false
      appendEvent(next, 'node.started', node.id, `${node.title}开始执行。`, now)
      break
    case 'node.pause':
      requireStatus(node, ['running'], 'pause')
      node.status = 'paused'
      appendEvent(next, 'node.paused', node.id, `${node.title}已由用户暂停。`, now)
      break
    case 'node.resume':
      if (next.globalPaused) fail('PROJECT_PAUSED', 'Resume the production pipeline before resuming a node')
      requireStatus(node, ['paused'], 'resume')
      node.status = 'running'
      appendEvent(next, 'node.resumed', node.id, `${node.title}已继续。`, now)
      break
    case 'node.edit': {
      requireStatus(node, ['ready', 'running', 'paused', 'review', 'approved', 'revision'], 'edit')
      const wasApproved = node.status === 'approved'
      if (payload.instructions !== undefined) node.instructions = payload.instructions.trim()
      if (payload.outputSummary !== undefined) node.outputSummary = payload.outputSummary
      node.revision += 1
      node.status = payload.outputSummary !== undefined || wasApproved ? 'review' : node.status
      node.error = null
      node.stale = false
      invalidateDownstream(next, node.id, now)
      appendEvent(next, 'node.edited', node.id, `${node.title}已被用户编辑；下游产物已标记过期。`, now)
      break
    }
    case 'node.submit-review':
      requireStatus(node, ['running', 'paused', 'revision'], 'submit for review')
      node.outputSummary = payload.outputSummary.trim()
      node.status = 'review'
      node.revision += 1
      node.error = null
      node.stale = false
      appendEvent(next, 'node.review', node.id, `${node.title}已提交用户审批。`, now)
      break
    case 'node.approve':
      requireStatus(node, ['review'], 'approve')
      if (!node.outputSummary.trim()) fail('EMPTY_OUTPUT', `${node.title} has no output to approve`)
      node.status = 'approved'
      node.stale = false
      appendEvent(next, 'node.approved', node.id, `${node.title}已由用户批准。`, now)
      refreshReadiness(next)
      if (next.autoAdvance && !next.globalPaused) {
        const ready = next.nodes.find((item) => item.status === 'ready')
        if (ready) {
          ready.status = 'running'
          appendEvent(next, 'node.started', ready.id, `${ready.title}已按自动推进设置开始执行。`, now)
        }
      }
      break
    case 'node.request-revision':
      requireStatus(node, ['review', 'approved'], 'request revision')
      node.status = 'revision'
      node.stale = false
      invalidateDownstream(next, node.id, now)
      appendEvent(next, 'node.revision-requested', node.id, `${node.title}已退回返工；下游不得继续。`, now)
      break
    case 'node.fail':
      requireStatus(node, ['running', 'paused'], 'fail')
      node.status = 'failed'
      node.error = payload.message.trim()
      invalidateDownstream(next, node.id, now)
      appendEvent(next, 'node.failed', node.id, `${node.title}失败：${node.error}`, now)
      break
    case 'node.reset':
      requireStatus(node, ['failed'], 'reset')
      node.status = dependenciesApproved(node, dependencyMap(next.nodes)) ? 'ready' : 'waiting'
      node.error = null
      appendEvent(next, 'node.reset', node.id, `${node.title}已重置。`, now)
      break
    default:
      fail('UNKNOWN_COMMAND', `Unsupported production command ${command.type}`)
  }

  if (node) node.updatedAt = now
  next.revision += 1
  next.updatedAt = now
  refreshReadiness(next)
  return assertVideoProductionProject(next)
}

export function advanceVideoProduction(projectInput, options = {}) {
  const project = assertVideoProductionProject(projectInput)
  if (project.globalPaused) fail('PROJECT_PAUSED', 'Resume the production pipeline before advancing')
  const running = project.nodes.find((node) => node.status === 'running')
  if (running) {
    return applyVideoProductionCommand(project, createVideoProductionCommand(project, 'node.submit-review', {
      nodeId: running.id,
      outputSummary: running.outputSummary || draftOutput(running.role, project),
    }, { actor: 'orchestrator' }), options)
  }
  const review = project.nodes.find((node) => node.status === 'review')
  if (review) fail('REVIEW_REQUIRED', `${review.title}正在等待用户审批`)
  const ready = project.nodes.find((node) => node.status === 'ready' || node.status === 'revision')
  if (!ready) fail('NO_READY_NODE', 'There is no production node ready to run')
  return applyVideoProductionCommand(project, createVideoProductionCommand(project, 'node.start', { nodeId: ready.id }, { actor: 'orchestrator' }), options)
}

export function productionProgress(projectInput) {
  const project = assertVideoProductionProject(projectInput)
  const approved = project.nodes.filter((node) => node.status === 'approved').length
  const current = project.nodes.find((node) => ['running', 'paused', 'review', 'revision', 'failed'].includes(node.status))
    ?? project.nodes.find((node) => node.status === 'ready')
    ?? project.nodes.at(-1)
  return {
    approved,
    total: project.nodes.length,
    percent: Math.round((approved / project.nodes.length) * 100),
    currentNodeId: current?.id ?? null,
    blocker: current?.status === 'review'
      ? `${current.title}待用户审批`
      : current?.status === 'failed'
        ? `${current.title}执行失败`
        : project.globalPaused
          ? '全链路已暂停'
          : null,
  }
}

export function canBridgeProductionToStory(projectInput) {
  const project = assertVideoProductionProject(projectInput)
  return project.nodes.find((node) => node.id === 'storyboard-director')?.status === 'approved'
}

const WUXIA_SCENES = [
  '暮雨·临安城门', '夜渡·雁回渡口', '暗巷·旧镖局', '晨雾·竹海',
  '正午·无名客栈', '落日·断碑谷', '雪夜·藏剑山庄', '黎明·悬崖古道',
  '灯会·长安东市', '风暴·天机阁', '月下·问剑台', '破晓·江畔',
]

export function createApprovedStorySource(projectInput) {
  const project = assertVideoProductionProject(projectInput)
  if (!canBridgeProductionToStory(project)) fail('STORYBOARD_NOT_APPROVED', '分镜导演节点尚未批准，不能进入严格 H3 执行链')
  const lines = []
  const { sceneCount, shotCount } = project.estimates
  let remaining = shotCount
  for (let sceneIndex = 0; sceneIndex < sceneCount; sceneIndex += 1) {
    const scenesLeft = sceneCount - sceneIndex
    const sceneShots = Math.ceil(remaining / scenesLeft)
    remaining -= sceneShots
    const heading = WUXIA_SCENES[sceneIndex % WUXIA_SCENES.length]
    lines.push(`场景 ${sceneIndex + 1}：${heading}`)
    for (let shotIndex = 0; shotIndex < sceneShots; shotIndex += 1) {
      const ordinal = shotIndex + 1
      const action = ordinal % 4 === 1
        ? '全景建立环境，风雨掠过屋脊，沈砚沿画面纵深进入。'
        : ordinal % 4 === 2
          ? '中景跟拍，沈砚观察线索并保持运动方向连续。'
          : ordinal % 4 === 3
            ? '近景交锋，人物身份特征、兵器和服装保持一致。'
            : '特写收束节拍，以动作或视线为下一镜头建立接点。'
      lines.push(`镜头 ${ordinal}：${action}`)
      if (ordinal === 3) lines.push(`沈砚：此局未终，我还不能停。`)
    }
    lines.push('')
  }
  return {
    title: project.title,
    kind: 'script',
    text: lines.join('\n').trim(),
    aspectRatio: project.settings.aspectRatio,
    frameStrategy: 'start-end',
    defaultShotSeconds: 5,
  }
}
