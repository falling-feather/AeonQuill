export const VIDEO_PRODUCTION_SCHEMA_VERSION = 2
export const VIDEO_PRODUCTION_COMMAND_SCHEMA_VERSION = 1

export const VIDEO_PRODUCTION_LIMITS = Object.freeze({
  maxBriefCharacters: 4_000,
  maxInstructionCharacters: 4_000,
  maxOutputCharacters: 12_000,
  maxDurationMinutes: 30,
  maxEvents: 200,
  maxChangeCards: 80,
  maxCharacters: 16,
})

const PROJECT_KIND = 'aeonquill.video-production'
const NODE_STATUSES = new Set(['waiting', 'ready', 'running', 'paused', 'review', 'approved', 'revision', 'failed'])
const ASPECT_RATIOS = new Set(['16:9', '9:16', '1:1'])
const GENERATION_MODES = new Set(['fast', 'quality'])
const CHARACTER_MODES = new Set(['quick', 'professional'])
const CHANGE_CARD_STATUSES = new Set(['proposed', 'accepted', 'rejected', 'superseded'])
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
  'proposal.create',
  'proposal.accept',
  'proposal.reject',
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

export function recommendProductionProfiles(input = {}) {
  const value = record(input, 'input')
  knownFields(value, new Set(['durationMinutes', 'genre', 'brief']), 'input')
  const durationMinutes = integer(value.durationMinutes ?? 1, 'input.durationMinutes', 1, VIDEO_PRODUCTION_LIMITS.maxDurationMinutes)
  const genre = string(value.genre ?? '综合创作', 'input.genre', 1, 40)
  const brief = string(value.brief ?? genre, 'input.brief', 1, VIDEO_PRODUCTION_LIMITS.maxBriefCharacters)
  const qualitySignal = /广告|品牌|产品|电影|质感|展示|宣传|预告/u.test(`${genre} ${brief}`)
  const characterSignal = /人物|角色|主角|演员|武侠|剧情|短剧|故事|对话/u.test(`${genre} ${brief}`)
  const generationMode = durationMinutes <= 2 || qualitySignal ? 'quality' : 'fast'
  const characterMode = characterSignal ? 'professional' : 'quick'
  const reasons = [
    generationMode === 'quality'
      ? '时长或视觉诉求适合逐镜头质量母版；系统建议 Base/时序精修，但仍由用户最终选择。'
      : '总时长较长，系统建议先用极速链打通全片，再挑重点镜头精修。',
    characterMode === 'professional'
      ? '文本包含持续角色信号，建议三视图、身份锁和服饰状态约束。'
      : '未检测到强角色连续性需求，单立绘快速方案更节省准备时间。',
  ]
  return { generationMode, characterMode, reasons }
}

function createCharacterProfiles(characterMode, now, genre) {
  const professional = characterMode === 'professional'
  return [{
    id: 'character-lead',
    name: genre.includes('武侠') ? '沈砚' : '主角',
    role: 'lead',
    mode: characterMode,
    status: 'draft',
    identityLock: professional
      ? '脸型、发型、年龄、体态、主色与标志性道具不得跨镜头漂移。'
      : '保留正面立绘中的主体轮廓、主色和标志物。',
    views: (professional ? ['front', 'side', 'back'] : ['front']).map((view) => ({
      id: `character-lead-${view}`,
      view,
      status: 'planned',
      assetVersionId: null,
    })),
    wardrobeStates: (professional
      ? [
          { id: 'wardrobe-base', label: '基础造型', trigger: '默认场景' },
          { id: 'wardrobe-variant', label: '场景变体', trigger: '剧本声明换装/天气/受损时' },
        ]
      : [{ id: 'wardrobe-base', label: '基础造型', trigger: '全片复用' }]
    ).map((wardrobe) => ({ ...wardrobe, status: 'planned', assetVersionId: null })),
    revision: 0,
    updatedAt: now,
  }]
}

function assertRecommendation(value, path) {
  const recommendation = record(value, path)
  knownFields(recommendation, new Set(['generationMode', 'characterMode', 'reasons']), path)
  if (!GENERATION_MODES.has(recommendation.generationMode)) fail('INVALID_GENERATION_MODE', `${path}.generationMode is unsupported`)
  if (!CHARACTER_MODES.has(recommendation.characterMode)) fail('INVALID_CHARACTER_MODE', `${path}.characterMode is unsupported`)
  if (!Array.isArray(recommendation.reasons) || recommendation.reasons.length < 1 || recommendation.reasons.length > 4) fail('INVALID_RECOMMENDATION', `${path}.reasons is invalid`)
  recommendation.reasons.forEach((reason, index) => string(reason, `${path}.reasons[${index}]`, 1, 300))
}

function assertCharacterProfile(value, path) {
  const profile = record(value, path)
  knownFields(profile, new Set(['id', 'name', 'role', 'mode', 'status', 'identityLock', 'views', 'wardrobeStates', 'revision', 'updatedAt']), path)
  id(profile.id, `${path}.id`)
  string(profile.name, `${path}.name`, 1, 80)
  string(profile.role, `${path}.role`, 1, 40)
  if (!CHARACTER_MODES.has(profile.mode)) fail('INVALID_CHARACTER_MODE', `${path}.mode is unsupported`)
  if (!['draft', 'review', 'approved', 'revision'].includes(profile.status)) fail('INVALID_CHARACTER_STATUS', `${path}.status is unsupported`)
  string(profile.identityLock, `${path}.identityLock`, 1, 1_000)
  if (!Array.isArray(profile.views) || profile.views.length < 1 || profile.views.length > 8) fail('INVALID_CHARACTER_VIEWS', `${path}.views is invalid`)
  for (const [index, viewInput] of profile.views.entries()) {
    const view = record(viewInput, `${path}.views[${index}]`)
    knownFields(view, new Set(['id', 'view', 'status', 'assetVersionId']), `${path}.views[${index}]`)
    id(view.id, `${path}.views[${index}].id`)
    if (!['front', 'side', 'back', 'expression', 'action'].includes(view.view)) fail('INVALID_CHARACTER_VIEW', `${path}.views[${index}].view is unsupported`)
    if (!['planned', 'ready', 'approved'].includes(view.status)) fail('INVALID_CHARACTER_ASSET_STATUS', `${path}.views[${index}].status is unsupported`)
    if (view.assetVersionId !== null) id(view.assetVersionId, `${path}.views[${index}].assetVersionId`)
  }
  if (profile.mode === 'professional' && !['front', 'side', 'back'].every((view) => profile.views.some((item) => item.view === view))) {
    fail('CHARACTER_CONSTRAINT_INCOMPLETE', `${path} professional mode requires front, side and back views`)
  }
  if (!Array.isArray(profile.wardrobeStates) || profile.wardrobeStates.length < 1 || profile.wardrobeStates.length > 12) fail('INVALID_WARDROBE_STATES', `${path}.wardrobeStates is invalid`)
  for (const [index, wardrobeInput] of profile.wardrobeStates.entries()) {
    const wardrobe = record(wardrobeInput, `${path}.wardrobeStates[${index}]`)
    knownFields(wardrobe, new Set(['id', 'label', 'trigger', 'status', 'assetVersionId']), `${path}.wardrobeStates[${index}]`)
    id(wardrobe.id, `${path}.wardrobeStates[${index}].id`)
    string(wardrobe.label, `${path}.wardrobeStates[${index}].label`, 1, 80)
    string(wardrobe.trigger, `${path}.wardrobeStates[${index}].trigger`, 1, 200)
    if (!['planned', 'ready', 'approved'].includes(wardrobe.status)) fail('INVALID_CHARACTER_ASSET_STATUS', `${path}.wardrobeStates[${index}].status is unsupported`)
    if (wardrobe.assetVersionId !== null) id(wardrobe.assetVersionId, `${path}.wardrobeStates[${index}].assetVersionId`)
  }
  integer(profile.revision, `${path}.revision`, 0, Number.MAX_SAFE_INTEGER)
  integer(profile.updatedAt, `${path}.updatedAt`, 1, Number.MAX_SAFE_INTEGER)
}

function assertChangeCard(value, path, knownNodeIds) {
  const card = record(value, path)
  knownFields(card, new Set(['id', 'nodeId', 'baseNodeRevision', 'status', 'source', 'title', 'rationale', 'proposedInstructions', 'proposedOutputSummary', 'createdAt', 'resolvedAt']), path)
  id(card.id, `${path}.id`)
  id(card.nodeId, `${path}.nodeId`)
  if (!knownNodeIds.has(card.nodeId)) fail('UNKNOWN_NODE', `${path}.nodeId is unknown`)
  integer(card.baseNodeRevision, `${path}.baseNodeRevision`, 0, Number.MAX_SAFE_INTEGER)
  if (!CHANGE_CARD_STATUSES.has(card.status)) fail('INVALID_CHANGE_CARD_STATUS', `${path}.status is unsupported`)
  if (!['deterministic-local', 'byok-text'].includes(card.source)) fail('INVALID_CHANGE_CARD_SOURCE', `${path}.source is unsupported`)
  string(card.title, `${path}.title`, 1, 120)
  string(card.rationale, `${path}.rationale`, 1, 1_000)
  if (card.proposedInstructions !== null) string(card.proposedInstructions, `${path}.proposedInstructions`, 1, VIDEO_PRODUCTION_LIMITS.maxInstructionCharacters)
  if (card.proposedOutputSummary !== null) string(card.proposedOutputSummary, `${path}.proposedOutputSummary`, 1, VIDEO_PRODUCTION_LIMITS.maxOutputCharacters)
  if (card.proposedInstructions === null && card.proposedOutputSummary === null) fail('EMPTY_PROPOSAL', `${path} must propose instructions or output`)
  integer(card.createdAt, `${path}.createdAt`, 1, Number.MAX_SAFE_INTEGER)
  if (card.resolvedAt !== null) integer(card.resolvedAt, `${path}.resolvedAt`, card.createdAt, Number.MAX_SAFE_INTEGER)
  if (card.status === 'proposed' && card.resolvedAt !== null) fail('INVALID_CHANGE_CARD_STATUS', `${path}.resolvedAt must be null while proposed`)
  if (card.status !== 'proposed' && card.resolvedAt === null) fail('INVALID_CHANGE_CARD_STATUS', `${path}.resolvedAt is required after resolution`)
}

function defaultInstructions(blueprint, settings) {
  if (blueprint.role === 'screenwriter') {
    return `基于制片计划设计完整${settings.genre}短剧：三幕结构、约 ${settings.sceneCount} 场、人物弧光、关键冲突和中文对白；不得把概述冒充终稿。`
  }
  if (blueprint.role === 'storyboard-director') {
    return `把已审批剧本拆为约 ${settings.shotCount} 个平均 5 秒镜头，逐镜头声明景别、运动、角色、地点、连续性和首尾帧；采用${settings.generationMode === 'quality' ? '质量母版' : '极速预演'}策略。`
  }
  if (blueprint.role === 'character-designer') {
    return settings.characterMode === 'professional'
      ? '建立人物圣经、正侧背三视图、身份锁、基础服饰与按场景触发的服饰变体；每个版本必须独立审批。'
      : '快速建立单张正面角色立绘、主色和标志物约束，优先缩短首个可用镜头时间。'
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

function supersedeNodeProposals(project, nodeId, at, exceptId = null) {
  for (const card of project.changeCards) {
    if (card.nodeId === nodeId && card.id !== exceptId && card.status === 'proposed') {
      card.status = 'superseded'
      card.resolvedAt = at
    }
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
  knownFields(project, new Set(['kind', 'schemaVersion', 'id', 'title', 'brief', 'settings', 'estimates', 'nodes', 'characterProfiles', 'changeCards', 'globalPaused', 'autoAdvance', 'revision', 'createdAt', 'updatedAt', 'events']), 'project')
  if (project.kind !== PROJECT_KIND || project.schemaVersion !== VIDEO_PRODUCTION_SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA', 'Unsupported video production schema')
  id(project.id, 'project.id')
  string(project.title, 'project.title', 1, 120)
  string(project.brief, 'project.brief', 1, VIDEO_PRODUCTION_LIMITS.maxBriefCharacters)
  const settings = record(project.settings, 'project.settings')
  knownFields(settings, new Set(['durationMinutes', 'genre', 'aspectRatio', 'generationMode', 'characterMode', 'recommendation']), 'project.settings')
  integer(settings.durationMinutes, 'project.settings.durationMinutes', 1, VIDEO_PRODUCTION_LIMITS.maxDurationMinutes)
  string(settings.genre, 'project.settings.genre', 1, 40)
  if (!ASPECT_RATIOS.has(settings.aspectRatio)) fail('INVALID_ASPECT_RATIO', 'project.settings.aspectRatio is unsupported')
  if (!GENERATION_MODES.has(settings.generationMode)) fail('INVALID_GENERATION_MODE', 'project.settings.generationMode is unsupported')
  if (!CHARACTER_MODES.has(settings.characterMode)) fail('INVALID_CHARACTER_MODE', 'project.settings.characterMode is unsupported')
  assertRecommendation(settings.recommendation, 'project.settings.recommendation')
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
  if (!Array.isArray(project.characterProfiles) || project.characterProfiles.length < 1 || project.characterProfiles.length > VIDEO_PRODUCTION_LIMITS.maxCharacters) fail('INVALID_CHARACTER_PROFILES', 'project.characterProfiles is invalid')
  project.characterProfiles.forEach((profile, index) => assertCharacterProfile(profile, `project.characterProfiles[${index}]`))
  if (new Set(project.characterProfiles.map(({ id: profileId }) => profileId)).size !== project.characterProfiles.length) fail('DUPLICATE_ID', 'project.characterProfiles contains duplicate ids')
  if (project.characterProfiles.some(({ mode }) => mode !== settings.characterMode)) fail('CHARACTER_MODE_MISMATCH', 'Character profiles must match project.settings.characterMode')
  if (!Array.isArray(project.changeCards) || project.changeCards.length > VIDEO_PRODUCTION_LIMITS.maxChangeCards) fail('INVALID_CHANGE_CARDS', 'project.changeCards is invalid')
  project.changeCards.forEach((card, index) => assertChangeCard(card, `project.changeCards[${index}]`, knownIds))
  if (new Set(project.changeCards.map(({ id: cardId }) => cardId)).size !== project.changeCards.length) fail('DUPLICATE_ID', 'project.changeCards contains duplicate ids')
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
  knownFields(value, new Set(['id', 'title', 'brief', 'durationMinutes', 'genre', 'aspectRatio', 'generationMode', 'characterMode', 'now']), 'input')
  const brief = string(value.brief ?? '我想要生成一部十分钟左右的武侠剧', 'input.brief', 1, VIDEO_PRODUCTION_LIMITS.maxBriefCharacters)
  const durationMinutes = integer(value.durationMinutes ?? 10, 'input.durationMinutes', 1, VIDEO_PRODUCTION_LIMITS.maxDurationMinutes)
  const genre = string(value.genre ?? '武侠', 'input.genre', 1, 40)
  const aspectRatio = value.aspectRatio ?? '16:9'
  if (!ASPECT_RATIOS.has(aspectRatio)) fail('INVALID_ASPECT_RATIO', 'input.aspectRatio is unsupported')
  const recommendation = recommendProductionProfiles({ durationMinutes, genre, brief })
  const generationMode = value.generationMode ?? recommendation.generationMode
  const characterMode = value.characterMode ?? recommendation.characterMode
  if (!GENERATION_MODES.has(generationMode)) fail('INVALID_GENERATION_MODE', 'input.generationMode is unsupported')
  if (!CHARACTER_MODES.has(characterMode)) fail('INVALID_CHARACTER_MODE', 'input.characterMode is unsupported')
  const now = integer(value.now ?? Date.now(), 'input.now', 1, Number.MAX_SAFE_INTEGER)
  const sceneCount = Math.max(3, Math.min(80, Math.round(durationMinutes * 1.2)))
  const shotCount = Math.max(sceneCount, Math.min(320, durationMinutes * 12))
  const batchCount = Math.ceil(shotCount / 5)
  const perShotLow = generationMode === 'quality' ? 20 : 6
  const perShotHigh = generationMode === 'quality' ? 40 : 16
  const generationMinutesLow = shotCount * perShotLow
  const generationMinutesHigh = shotCount * perShotHigh
  const settings = { durationMinutes, genre, aspectRatio, sceneCount, shotCount, generationMode, characterMode }
  const project = {
    kind: PROJECT_KIND,
    schemaVersion: VIDEO_PRODUCTION_SCHEMA_VERSION,
    id: value.id ? id(value.id, 'input.id') : `production-${stableToken(`${brief}|${durationMinutes}|${genre}|${aspectRatio}`)}`,
    title: value.title ? string(value.title, 'input.title', 1, 120) : `${durationMinutes} 分钟${genre}视频项目`,
    brief,
    settings: { durationMinutes, genre, aspectRatio, generationMode, characterMode, recommendation },
    estimates: {
      sceneCount,
      shotCount,
      batchCount,
      generationMinutesLow,
      generationMinutesHigh,
    },
    nodes: NODE_BLUEPRINTS.map((blueprint, index) => ({
      ...blueprint,
      order: index + 1,
      status: blueprint.id === 'producer' ? 'approved' : blueprint.id === 'screenwriter' ? 'review' : 'waiting',
      instructions: defaultInstructions(blueprint, settings),
      outputSummary: blueprint.id === 'producer' || blueprint.id === 'screenwriter' ? draftOutput(blueprint.role, { estimates: { sceneCount, shotCount, batchCount, generationMinutesLow, generationMinutesHigh } }) : '',
      revision: blueprint.id === 'producer' || blueprint.id === 'screenwriter' ? 1 : 0,
      updatedAt: now,
      stale: false,
      error: null,
    })),
    characterProfiles: createCharacterProfiles(characterMode, now, genre),
    changeCards: [],
    globalPaused: false,
    autoAdvance: false,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    events: [
      { id: 'event-0-1', at: now, type: 'project.created', nodeId: null, message: `已建立${generationMode === 'quality' ? '质量' : '极速'}生产图与${characterMode === 'professional' ? '专业人物' : '快速人物'}方案；剧本大纲等待用户审批。` },
    ],
  }
  return assertVideoProductionProject(project)
}

export function serializeVideoProductionProject(project, options = {}) {
  assertVideoProductionProject(project)
  return JSON.stringify(project, null, options?.pretty === true ? 2 : 0)
}

function migrateVideoProductionProjectV1(value) {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.kind !== PROJECT_KIND) return value
  const recommendation = recommendProductionProfiles({
    durationMinutes: value.settings?.durationMinutes,
    genre: value.settings?.genre,
    brief: value.brief,
  })
  const characterMode = recommendation.characterMode
  return {
    ...value,
    schemaVersion: VIDEO_PRODUCTION_SCHEMA_VERSION,
    settings: {
      ...value.settings,
      generationMode: 'quality',
      characterMode,
      recommendation,
    },
    characterProfiles: createCharacterProfiles(characterMode, value.updatedAt, value.settings.genre),
    changeCards: [],
  }
}

export function deserializeVideoProductionProject(serialized) {
  if (typeof serialized !== 'string') fail('INVALID_SERIALIZED_PROJECT', 'Serialized production project must be a string')
  let parsed
  try { parsed = JSON.parse(serialized) } catch { fail('INVALID_JSON', 'Serialized production project is not valid JSON') }
  return clone(assertVideoProductionProject(migrateVideoProductionProjectV1(parsed)))
}

export function createVideoProductionProjectForStory(storyInput, options = {}) {
  const story = record(storyInput, 'story')
  const source = record(story.source, 'story.source')
  const settings = record(story.settings, 'story.settings')
  if (!Array.isArray(story.scenes)) fail('INVALID_STORY_PROJECT', 'story.scenes must be an array')
  const totalSeconds = story.scenes.reduce((total, scene) => total + (Array.isArray(scene?.shots)
    ? scene.shots.reduce((shotTotal, shot) => shotTotal + (Number.isSafeInteger(shot?.durationSeconds) ? shot.durationSeconds : 0), 0)
    : 0), 0)
  const durationMinutes = Math.max(1, Math.min(VIDEO_PRODUCTION_LIMITS.maxDurationMinutes, Math.ceil(totalSeconds / 60)))
  const brief = String(source.text ?? story.title ?? '智能视频项目').slice(0, VIDEO_PRODUCTION_LIMITS.maxBriefCharacters)
  return createVideoProductionProject({
    title: String(story.title ?? '智能视频项目').slice(0, 120),
    brief,
    durationMinutes,
    genre: options.genre ?? '综合创作',
    aspectRatio: settings.aspectRatio,
    generationMode: options.generationMode,
    characterMode: options.characterMode,
    now: options.now ?? story.createdAt ?? Date.now(),
  })
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
  if (command.type === 'proposal.create') {
    knownFields(payload, new Set(['cardId', 'nodeId', 'source', 'title', 'rationale', 'proposedInstructions', 'proposedOutputSummary']), 'command.payload')
    id(payload.cardId, 'command.payload.cardId')
    id(payload.nodeId, 'command.payload.nodeId')
    if (project && !project.nodes.some((node) => node.id === payload.nodeId)) fail('UNKNOWN_NODE', `Unknown production node ${payload.nodeId}`)
    if (!['deterministic-local', 'byok-text'].includes(payload.source)) fail('INVALID_CHANGE_CARD_SOURCE', 'command.payload.source is unsupported')
    string(payload.title, 'command.payload.title', 1, 120)
    string(payload.rationale, 'command.payload.rationale', 1, 1_000)
    if (payload.proposedInstructions !== null && payload.proposedInstructions !== undefined) string(payload.proposedInstructions, 'command.payload.proposedInstructions', 1, VIDEO_PRODUCTION_LIMITS.maxInstructionCharacters)
    if (payload.proposedOutputSummary !== null && payload.proposedOutputSummary !== undefined) string(payload.proposedOutputSummary, 'command.payload.proposedOutputSummary', 1, VIDEO_PRODUCTION_LIMITS.maxOutputCharacters)
    if (!payload.proposedInstructions && !payload.proposedOutputSummary) fail('EMPTY_PROPOSAL', 'Proposal must change instructions or output')
    return command
  }
  if (command.type === 'proposal.accept' || command.type === 'proposal.reject') {
    knownFields(payload, new Set(['cardId']), 'command.payload')
    id(payload.cardId, 'command.payload.cardId')
    if (project && !project.changeCards.some((card) => card.id === payload.cardId)) fail('UNKNOWN_CHANGE_CARD', `Unknown change card ${payload.cardId}`)
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

export function createVideoProductionProposalCommand(projectInput, nodeId, proposalInput, options = {}) {
  const project = assertVideoProductionProject(projectInput)
  const proposal = record(proposalInput, 'proposal')
  knownFields(proposal, new Set(['source', 'title', 'rationale', 'proposedInstructions', 'proposedOutputSummary']), 'proposal')
  const token = stableToken(`${project.id}|${project.revision}|${nodeId}|${proposal.title ?? ''}|${proposal.proposedOutputSummary ?? ''}`)
  return createVideoProductionCommand(project, 'proposal.create', {
    cardId: `change-${project.revision + 1}-${token}`,
    nodeId,
    source: proposal.source ?? 'deterministic-local',
    title: proposal.title,
    rationale: proposal.rationale,
    proposedInstructions: proposal.proposedInstructions ?? null,
    proposedOutputSummary: proposal.proposedOutputSummary ?? null,
  }, options)
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
      supersedeNodeProposals(next, node.id, now)
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
      supersedeNodeProposals(next, node.id, now)
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
    case 'proposal.create': {
      const proposalNode = next.nodes.find((item) => item.id === payload.nodeId)
      if (!proposalNode) fail('UNKNOWN_NODE', `Unknown production node ${payload.nodeId}`)
      if (proposalNode.status === 'waiting' || proposalNode.status === 'failed') fail('INVALID_TRANSITION', `${proposalNode.title} cannot receive a proposal from ${proposalNode.status}`)
      if (next.changeCards.some((card) => card.id === payload.cardId)) fail('DUPLICATE_ID', `Change card already exists: ${payload.cardId}`)
      supersedeNodeProposals(next, proposalNode.id, now)
      next.changeCards.push({
        id: payload.cardId,
        nodeId: proposalNode.id,
        baseNodeRevision: proposalNode.revision,
        status: 'proposed',
        source: payload.source,
        title: payload.title.trim(),
        rationale: payload.rationale.trim(),
        proposedInstructions: payload.proposedInstructions?.trim() || null,
        proposedOutputSummary: payload.proposedOutputSummary?.trim() || null,
        createdAt: now,
        resolvedAt: null,
      })
      if (next.changeCards.length > VIDEO_PRODUCTION_LIMITS.maxChangeCards) {
        const removable = next.changeCards.findIndex((card) => card.status !== 'proposed')
        if (removable >= 0) next.changeCards.splice(removable, 1)
        else fail('CHANGE_CARD_LIMIT', 'Resolve an existing proposal before creating another one')
      }
      appendEvent(next, 'proposal.created', proposalNode.id, `${proposalNode.title}收到一张待审批变更卡。`, now)
      break
    }
    case 'proposal.accept': {
      const card = next.changeCards.find((item) => item.id === payload.cardId)
      if (!card) fail('UNKNOWN_CHANGE_CARD', `Unknown change card ${payload.cardId}`)
      if (card.status !== 'proposed') fail('INVALID_CHANGE_CARD_STATUS', `${card.title} is already ${card.status}`)
      const proposalNode = next.nodes.find((item) => item.id === card.nodeId)
      if (!proposalNode) fail('UNKNOWN_NODE', `Unknown production node ${card.nodeId}`)
      if (card.baseNodeRevision !== proposalNode.revision) fail('PROPOSAL_STALE', '节点已变化；这张变更卡必须重新生成', { cardId: card.id, nodeRevision: proposalNode.revision })
      if (card.proposedInstructions !== null) proposalNode.instructions = card.proposedInstructions
      if (card.proposedOutputSummary !== null) proposalNode.outputSummary = card.proposedOutputSummary
      proposalNode.revision += 1
      proposalNode.status = 'review'
      proposalNode.error = null
      proposalNode.stale = false
      proposalNode.updatedAt = now
      card.status = 'accepted'
      card.resolvedAt = now
      supersedeNodeProposals(next, proposalNode.id, now, card.id)
      invalidateDownstream(next, proposalNode.id, now)
      appendEvent(next, 'proposal.accepted', proposalNode.id, `已接受变更卡“${card.title}”；下游产物已失效并等待重新审批。`, now)
      break
    }
    case 'proposal.reject': {
      const card = next.changeCards.find((item) => item.id === payload.cardId)
      if (!card) fail('UNKNOWN_CHANGE_CARD', `Unknown change card ${payload.cardId}`)
      if (card.status !== 'proposed') fail('INVALID_CHANGE_CARD_STATUS', `${card.title} is already ${card.status}`)
      card.status = 'rejected'
      card.resolvedAt = now
      appendEvent(next, 'proposal.rejected', card.nodeId, `已拒绝变更卡“${card.title}”；正式节点未改变。`, now)
      break
    }
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

export function createLocalAgentProposal(projectInput, nodeId) {
  const project = assertVideoProductionProject(projectInput)
  const node = project.nodes.find((item) => item.id === nodeId)
  if (!node) fail('UNKNOWN_NODE', `Unknown production node ${nodeId}`)
  const strategy = project.settings.generationMode === 'quality'
    ? '质量模式：重点镜头采用 Base 母片与时序精修，所有参考资产先审批。'
    : '极速模式：先形成可观看全链预演，再把用户指定镜头提升到质量母版。'
  const character = project.settings.characterMode === 'professional'
    ? '人物采用正侧背三视图、身份锁和按场景触发的服饰状态。'
    : '人物采用单立绘与最小身份约束，优先缩短准备时间。'
  const roleOutput = node.outputSummary || draftOutput(node.role, project)
  return {
    source: 'deterministic-local',
    title: `${node.title} · 本地受控建议`,
    rationale: '根据已选择的生产与人物策略补齐执行边界；这是待审批提案，不会直接覆盖正式节点。',
    proposedInstructions: `${node.instructions}\n\n生产策略：${strategy}\n人物策略：${character}`.slice(0, VIDEO_PRODUCTION_LIMITS.maxInstructionCharacters),
    proposedOutputSummary: roleOutput,
  }
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
