export const STORY_PROJECT_SCHEMA_VERSION = 1
export const GENERATION_PLAN_SCHEMA_VERSION = 1

export const STORY_LIMITS = Object.freeze({
  maxSourceCharacters: 60_000,
  maxTitleCharacters: 120,
  maxCharacters: 32,
  maxLocations: 80,
  maxScenes: 80,
  maxShotsPerScene: 16,
  maxShots: 320,
  maxDialogueLinesPerShot: 24,
  maxTotalDurationSeconds: 3_600,
  maxTasks: 1_200,
})

export const CONTROLLED_WORKFLOW_IDS = Object.freeze({
  characterReference: 'aeonquill.character-reference.v1',
  locationReference: 'aeonquill.location-reference.v1',
  shotFrame: 'aeonquill.shot-frame.v1',
  shotVideo: 'aeonquill.video.minimax-h3-i2v.v1',
})

const SOURCE_KINDS = new Set(['idea', 'script'])
const ASPECT_RATIOS = new Set(['16:9', '9:16', '1:1'])
const FRAME_STRATEGIES = new Set(['keyframe', 'start-end'])
const CONSISTENCY_STATUSES = new Set(['needs-reference', 'reference-planned', 'ready'])
const CAMERA_FRAMINGS = new Set(['wide', 'medium', 'close-up'])
const CAMERA_MOVEMENTS = new Set(['locked', 'push-in', 'pan', 'orbit', 'follow'])
const FRAME_ROLES = new Set(['key', 'start', 'end'])
const TASK_STAGES = new Set(['references', 'frames', 'videos'])
const TASK_KINDS = new Set(['character-reference', 'location-reference', 'shot-frame', 'shot-video'])
const TASK_STATUSES = new Set(['planned', 'blocked', 'ready'])
const TASK_WORKFLOW_BY_KIND = Object.freeze({
  'character-reference': CONTROLLED_WORKFLOW_IDS.characterReference,
  'location-reference': CONTROLLED_WORKFLOW_IDS.locationReference,
  'shot-frame': CONTROLLED_WORKFLOW_IDS.shotFrame,
  'shot-video': CONTROLLED_WORKFLOW_IDS.shotVideo,
})
const PROJECT_KEYS = new Set([
  'schemaVersion', 'id', 'title', 'revision', 'createdAt', 'updatedAt', 'source', 'settings',
  'characters', 'locations', 'scenes',
])
const SOURCE_KEYS = new Set(['kind', 'text', 'language'])
const SETTINGS_KEYS = new Set(['aspectRatio', 'frameStrategy', 'defaultShotSeconds', 'seed'])
const CHARACTER_KEYS = new Set([
  'id', 'name', 'aliases', 'description', 'visualPrompt', 'consistencyStatus',
])
const LOCATION_KEYS = new Set(['id', 'name', 'description', 'visualPrompt', 'consistencyStatus'])
const SCENE_KEYS = new Set([
  'id', 'ordinal', 'heading', 'summary', 'locationId', 'characterIds', 'shots',
])
const SHOT_KEYS = new Set([
  'id', 'ordinal', 'title', 'action', 'dialogue', 'characterIds', 'durationSeconds', 'camera',
  'continuityNotes', 'frameRoles',
])
const DIALOGUE_KEYS = new Set(['speaker', 'text'])
const CAMERA_KEYS = new Set(['framing', 'movement'])
const PLAN_KEYS = new Set([
  'schemaVersion', 'id', 'projectId', 'projectRevision', 'createdAt', 'stages', 'tasks',
])
const STAGE_KEYS = new Set(['id', 'label', 'order'])
const TASK_KEYS = new Set([
  'id', 'stage', 'kind', 'workflowId', 'status', 'dependsOn', 'inputs', 'outputs',
])
const TASK_INPUT_KEYS = new Set([
  'aspectRatio', 'prompt', 'negativePrompt', 'characterIds', 'locationId', 'sceneId', 'shotId',
  'frameRole', 'durationSeconds', 'seed',
])
const TASK_OUTPUT_KEYS = new Set(['role', 'logicalAssetKey', 'mimeType'])
const LEGACY_PROJECT_KEYS = new Set([
  'schemaVersion', 'id', 'title', 'sourceText', 'sourceKind', 'aspectRatio', 'frameStrategy',
  'defaultShotSeconds', 'seed', 'createdAt', 'updatedAt',
])
const EXCLUDED_SPEAKERS = new Set([
  '场景', '镜头', '旁白', '画外音', '字幕', '音效', '转场', 'scene', 'shot', 'narrator', 'sfx',
])

export class StoryContractError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'StoryContractError'
    this.code = code
    this.details = details
  }
}

function fail(code, message, details) {
  throw new StoryContractError(code, message, details)
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function clone(value) {
  return globalThis.structuredClone(value)
}

function assertExactKeys(value, allowed, path) {
  if (!isRecord(value)) fail('INVALID_OBJECT', `${path} must be an object`)
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length) {
    fail('UNKNOWN_FIELD', `${path} contains unsupported fields`, { path, fields: unknown })
  }
}

function assertString(value, path, { nonEmpty = false, maxLength = STORY_LIMITS.maxSourceCharacters } = {}) {
  if (typeof value !== 'string') fail('INVALID_STRING', `${path} must be a string`)
  if (nonEmpty && !value.trim()) fail('EMPTY_STRING', `${path} cannot be empty`)
  if (value.length > maxLength) {
    fail('STRING_TOO_LONG', `${path} exceeds ${maxLength} characters`, { path, maxLength })
  }
  if (/[^\P{Cc}\n\t]/u.test(value)) {
    fail('CONTROL_CHARACTER', `${path} contains unsupported control characters`, { path })
  }
}

function assertInteger(value, path, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('INVALID_INTEGER', `${path} must be an integer between ${min} and ${max}`)
  }
}

function assertNullableString(value, path, maxLength = 160) {
  if (value === null) return
  assertString(value, path, { nonEmpty: true, maxLength })
}

function assertStringArray(value, path, maxItems, maxLength = 160) {
  if (!Array.isArray(value) || value.length > maxItems) {
    fail('INVALID_ARRAY', `${path} must contain at most ${maxItems} items`)
  }
  value.forEach((item, index) => assertString(item, `${path}[${index}]`, { nonEmpty: true, maxLength }))
  if (new Set(value).size !== value.length) fail('DUPLICATE_REFERENCE', `${path} contains duplicate values`)
}

export function normalizeStoryText(value) {
  if (typeof value !== 'string') fail('INVALID_STRING', 'source text must be a string')
  const normalized = value
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line
      .replace(/[\t ]+/g, ' ')
      .replace(/\s*([:：])\s*/gu, '$1')
      .trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  assertString(normalized, 'source.text', {
    nonEmpty: true,
    maxLength: STORY_LIMITS.maxSourceCharacters,
  })
  return normalized
}

function normalizeIdentityText(value) {
  return normalizeStoryText(String(value)).toLocaleLowerCase('zh-CN')
}

function identityKey(value) {
  return String(value).normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('zh-CN')
}

function hashString(value) {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36).padStart(7, '0')
}

function stableId(prefix, ...parts) {
  return `${prefix}_${hashString(parts.map((part) => normalizeIdentityText(part)).join('\u241f'))}`
}

function stableSeed(baseSeed, value) {
  const mixed = Number.parseInt(hashString(`${baseSeed}:${value}`), 36) >>> 0
  return mixed % 2_147_483_647
}

function compact(value, maxLength) {
  const normalized = String(value).replace(/\s+/g, ' ').trim()
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`
}

function detectLanguage(text) {
  return /[\u3400-\u9fff]/u.test(text) ? 'zh-CN' : 'und'
}

function deriveTitle(text) {
  const firstLine = text.split('\n').find(Boolean) ?? '未命名故事'
  return compact(firstLine.replace(/^(?:场景|镜头|scene|shot)\s*\d*\s*[:：.\-]?\s*/i, ''), 32) || '未命名故事'
}

function isSceneHeader(line) {
  return /^(?:场景\s*(?:\d+|[一二三四五六七八九十]+)?|scene\s*\d*|(?:int|ext|内景|外景)[.\s])/iu.test(line)
}

function isShotHeader(line) {
  return /^(?:镜头|shot)\s*(?:\d+|[一二三四五六七八九十]+)?\s*[:：.\-]?/iu.test(line)
}

function stripScenePrefix(line) {
  const stripped = line
    .replace(/^(?:场景\s*(?:\d+|[一二三四五六七八九十]+)?|scene\s*\d*)\s*[:：.\-]?\s*/iu, '')
    .replace(/^(?:int|ext|内景|外景)[.\s-]*/iu, '')
    .trim()
  return stripped || line.trim()
}

function stripShotPrefix(line) {
  return line.replace(/^(?:镜头|shot)\s*(?:\d+|[一二三四五六七八九十]+)?\s*[:：.\-]?\s*/iu, '').trim()
}

function splitSceneBlocks(text, kind) {
  const lines = text.split('\n')
  const hasSceneHeaders = lines.some(isSceneHeader)
  if (!hasSceneHeaders) {
    const paragraphs = text.split(/\n\s*\n/u).map((part) => part.trim()).filter(Boolean)
    return (paragraphs.length ? paragraphs : [text]).map((body, index) => ({
      heading: kind === 'idea' && index === 0 ? '概念场景' : `场景 ${index + 1}`,
      body,
    }))
  }

  const blocks = []
  let current = null
  for (const line of lines) {
    if (isSceneHeader(line)) {
      if (current) blocks.push(current)
      current = { heading: stripScenePrefix(line), bodyLines: [] }
      continue
    }
    if (!current) current = { heading: `场景 ${blocks.length + 1}`, bodyLines: [] }
    if (line) current.bodyLines.push(line)
  }
  if (current) blocks.push(current)
  return blocks.map(({ heading, bodyLines }) => ({ heading, body: bodyLines.join('\n').trim() }))
}

function splitImplicitBeats(body) {
  const paragraphs = body.split(/\n\s*\n/u).map((part) => part.trim()).filter(Boolean)
  const beats = []
  for (const paragraph of paragraphs.length ? paragraphs : [body]) {
    const lines = paragraph.split('\n').map((line) => line.trim()).filter(Boolean)
    for (const line of lines) {
      if (/^[^：:\n]{1,24}[：:]/u.test(line)) {
        beats.push(line)
        continue
      }
      const sentences = line.split(/(?<=[。！？!?；;])\s*/u).map((part) => part.trim()).filter(Boolean)
      beats.push(...(sentences.length ? sentences : [line]))
    }
  }
  return beats.filter(Boolean)
}

function splitShotBlocks(body) {
  const lines = body.split('\n')
  if (!lines.some(isShotHeader)) return splitImplicitBeats(body).map((text) => ({ title: '', body: text }))

  const blocks = []
  let current = null
  for (const line of lines) {
    if (isShotHeader(line)) {
      if (current) blocks.push(current)
      current = { title: stripShotPrefix(line), bodyLines: [] }
      continue
    }
    if (!current) current = { title: '', bodyLines: [] }
    if (line) current.bodyLines.push(line)
  }
  if (current) blocks.push(current)
  return blocks.map(({ title, bodyLines }) => ({
    title,
    body: bodyLines.join('\n').trim() || title,
  }))
}

function parseDialogue(text) {
  const dialogue = []
  for (const line of text.split('\n').map((item) => item.trim()).filter(Boolean)) {
    if (isSceneHeader(line) || isShotHeader(line)) continue
    const match = line.match(/^([^：:\n]{1,24})[：:]\s*(.+)$/u)
    if (!match) continue
    const speaker = match[1].trim()
    if (EXCLUDED_SPEAKERS.has(speaker.toLocaleLowerCase('zh-CN'))) continue
    dialogue.push({ speaker, text: compact(match[2], 2_000) })
  }
  return dialogue
}

function inferCamera(text) {
  const lower = text.toLocaleLowerCase('zh-CN')
  const framing = /特写|close[- ]?up/u.test(lower)
    ? 'close-up'
    : /全景|远景|wide/u.test(lower) ? 'wide' : 'medium'
  const movement = /推进|推镜|push[- ]?in|dolly\s*in/u.test(lower)
    ? 'push-in'
    : /平移|横摇|pan/u.test(lower)
      ? 'pan'
      : /环绕|orbit/u.test(lower)
        ? 'orbit'
        : /跟拍|跟随|follow/u.test(lower) ? 'follow' : 'locked'
  return { framing, movement }
}

function inferDuration(text, defaultShotSeconds) {
  const dialogueLength = parseDialogue(text).reduce((total, line) => total + line.text.length, 0)
  const dialogueSeconds = Math.ceil(dialogueLength / 5)
  return Math.min(15, Math.max(2, defaultShotSeconds, dialogueSeconds))
}

function extractCharacterNames(blocks) {
  const names = []
  const identities = new Set()
  for (const block of blocks) {
    for (const { speaker } of parseDialogue(block.body)) {
      const identity = identityKey(speaker)
      if (!identities.has(identity)) {
        names.push(speaker)
        identities.add(identity)
      }
    }
  }
  if (names.length > STORY_LIMITS.maxCharacters) {
    fail('CHARACTER_LIMIT', `source produces more than ${STORY_LIMITS.maxCharacters} characters`)
  }
  return names
}

function createCharacter(name) {
  const id = stableId('char', name)
  return {
    id,
    name,
    aliases: [],
    description: `${name}的外观与身份设定待确认。`,
    visualPrompt: `${name}, consistent character identity, neutral reference pose, clean reference lighting`,
    consistencyStatus: 'reference-planned',
  }
}

function createLocation(name) {
  const id = stableId('loc', name)
  return {
    id,
    name,
    description: `${name}的空间、时间与光线连续性待确认。`,
    visualPrompt: `${name}, consistent environment reference, clear spatial layout, neutral reference lighting`,
    consistencyStatus: 'reference-planned',
  }
}

function assertSource(source) {
  assertExactKeys(source, SOURCE_KEYS, 'project.source')
  if (!SOURCE_KINDS.has(source.kind)) fail('INVALID_SOURCE_KIND', 'project.source.kind is unsupported')
  assertString(source.text, 'project.source.text', {
    nonEmpty: true,
    maxLength: STORY_LIMITS.maxSourceCharacters,
  })
  assertString(source.language, 'project.source.language', { nonEmpty: true, maxLength: 32 })
  if (normalizeStoryText(source.text) !== source.text) {
    fail('NON_CANONICAL_SOURCE', 'project.source.text must be normalized before storage')
  }
}

function assertSettings(settings) {
  assertExactKeys(settings, SETTINGS_KEYS, 'project.settings')
  if (!ASPECT_RATIOS.has(settings.aspectRatio)) fail('INVALID_ASPECT_RATIO', 'Unsupported aspect ratio')
  if (!FRAME_STRATEGIES.has(settings.frameStrategy)) fail('INVALID_FRAME_STRATEGY', 'Unsupported frame strategy')
  assertInteger(settings.defaultShotSeconds, 'project.settings.defaultShotSeconds', 2, 15)
  assertInteger(settings.seed, 'project.settings.seed', 0, 2_147_483_646)
}

function assertCharacter(character, index) {
  const path = `project.characters[${index}]`
  assertExactKeys(character, CHARACTER_KEYS, path)
  assertString(character.id, `${path}.id`, { nonEmpty: true, maxLength: 160 })
  assertString(character.name, `${path}.name`, { nonEmpty: true, maxLength: 80 })
  assertStringArray(character.aliases, `${path}.aliases`, 16, 80)
  assertString(character.description, `${path}.description`, { maxLength: 2_000 })
  assertString(character.visualPrompt, `${path}.visualPrompt`, { nonEmpty: true, maxLength: 4_000 })
  if (!CONSISTENCY_STATUSES.has(character.consistencyStatus)) {
    fail('INVALID_CONSISTENCY_STATUS', `${path}.consistencyStatus is unsupported`)
  }
}

function assertLocation(location, index) {
  const path = `project.locations[${index}]`
  assertExactKeys(location, LOCATION_KEYS, path)
  assertString(location.id, `${path}.id`, { nonEmpty: true, maxLength: 160 })
  assertString(location.name, `${path}.name`, { nonEmpty: true, maxLength: 120 })
  assertString(location.description, `${path}.description`, { maxLength: 2_000 })
  assertString(location.visualPrompt, `${path}.visualPrompt`, { nonEmpty: true, maxLength: 4_000 })
  if (!CONSISTENCY_STATUSES.has(location.consistencyStatus)) {
    fail('INVALID_CONSISTENCY_STATUS', `${path}.consistencyStatus is unsupported`)
  }
}

function assertShot(shot, path, context) {
  assertExactKeys(shot, SHOT_KEYS, path)
  assertString(shot.id, `${path}.id`, { nonEmpty: true, maxLength: 160 })
  assertInteger(shot.ordinal, `${path}.ordinal`, 1, STORY_LIMITS.maxShotsPerScene)
  assertString(shot.title, `${path}.title`, { nonEmpty: true, maxLength: 160 })
  assertString(shot.action, `${path}.action`, { nonEmpty: true, maxLength: 4_000 })
  if (!Array.isArray(shot.dialogue) || shot.dialogue.length > STORY_LIMITS.maxDialogueLinesPerShot) {
    fail('DIALOGUE_LIMIT', `${path}.dialogue exceeds the allowed limit`)
  }
  shot.dialogue.forEach((line, lineIndex) => {
    const linePath = `${path}.dialogue[${lineIndex}]`
    assertExactKeys(line, DIALOGUE_KEYS, linePath)
    assertString(line.speaker, `${linePath}.speaker`, { nonEmpty: true, maxLength: 80 })
    assertString(line.text, `${linePath}.text`, { nonEmpty: true, maxLength: 2_000 })
  })
  assertStringArray(shot.characterIds, `${path}.characterIds`, STORY_LIMITS.maxCharacters)
  shot.characterIds.forEach((id) => {
    if (!context.characterIds.has(id)) fail('DANGLING_CHARACTER', `${path} references unknown character ${id}`)
  })
  assertInteger(shot.durationSeconds, `${path}.durationSeconds`, 2, 15)
  assertExactKeys(shot.camera, CAMERA_KEYS, `${path}.camera`)
  if (!CAMERA_FRAMINGS.has(shot.camera.framing)) fail('INVALID_CAMERA', `${path}.camera.framing is unsupported`)
  if (!CAMERA_MOVEMENTS.has(shot.camera.movement)) fail('INVALID_CAMERA', `${path}.camera.movement is unsupported`)
  assertString(shot.continuityNotes, `${path}.continuityNotes`, { maxLength: 2_000 })
  assertStringArray(shot.frameRoles, `${path}.frameRoles`, 2, 16)
  shot.frameRoles.forEach((role) => {
    if (!FRAME_ROLES.has(role)) fail('INVALID_FRAME_ROLE', `${path}.frameRoles contains unsupported role ${role}`)
  })
  const expectedRoles = context.frameStrategy === 'start-end' ? ['start', 'end'] : ['key']
  if (shot.frameRoles.join('|') !== expectedRoles.join('|')) {
    fail('FRAME_STRATEGY_MISMATCH', `${path}.frameRoles does not match project.settings.frameStrategy`)
  }
}

export function assertStoryProject(project) {
  assertExactKeys(project, PROJECT_KEYS, 'project')
  if (project.schemaVersion !== STORY_PROJECT_SCHEMA_VERSION) {
    fail('UNSUPPORTED_PROJECT_VERSION', `Unsupported story project schema: ${project.schemaVersion}`)
  }
  assertString(project.id, 'project.id', { nonEmpty: true, maxLength: 160 })
  assertString(project.title, 'project.title', {
    nonEmpty: true,
    maxLength: STORY_LIMITS.maxTitleCharacters,
  })
  assertInteger(project.revision, 'project.revision', 0)
  assertInteger(project.createdAt, 'project.createdAt', 0)
  assertInteger(project.updatedAt, 'project.updatedAt', project.createdAt)
  assertSource(project.source)
  assertSettings(project.settings)

  if (!Array.isArray(project.characters) || project.characters.length > STORY_LIMITS.maxCharacters) {
    fail('CHARACTER_LIMIT', `project.characters must contain at most ${STORY_LIMITS.maxCharacters} items`)
  }
  if (!Array.isArray(project.locations) || project.locations.length > STORY_LIMITS.maxLocations) {
    fail('LOCATION_LIMIT', `project.locations must contain at most ${STORY_LIMITS.maxLocations} items`)
  }
  if (!Array.isArray(project.scenes) || !project.scenes.length || project.scenes.length > STORY_LIMITS.maxScenes) {
    fail('SCENE_LIMIT', `project.scenes must contain 1-${STORY_LIMITS.maxScenes} items`)
  }

  project.characters.forEach(assertCharacter)
  project.locations.forEach(assertLocation)
  const characterIds = new Set(project.characters.map(({ id }) => id))
  const locationIds = new Set(project.locations.map(({ id }) => id))
  if (characterIds.size !== project.characters.length) fail('DUPLICATE_ID', 'project.characters contains duplicate ids')
  if (locationIds.size !== project.locations.length) fail('DUPLICATE_ID', 'project.locations contains duplicate ids')

  const sceneIds = new Set()
  const shotIds = new Set()
  let totalShots = 0
  let totalDurationSeconds = 0
  project.scenes.forEach((scene, sceneIndex) => {
    const path = `project.scenes[${sceneIndex}]`
    assertExactKeys(scene, SCENE_KEYS, path)
    assertString(scene.id, `${path}.id`, { nonEmpty: true, maxLength: 160 })
    assertInteger(scene.ordinal, `${path}.ordinal`, 1, STORY_LIMITS.maxScenes)
    if (scene.ordinal !== sceneIndex + 1) fail('INVALID_ORDINAL', `${path}.ordinal must match its position`)
    assertString(scene.heading, `${path}.heading`, { nonEmpty: true, maxLength: 240 })
    assertString(scene.summary, `${path}.summary`, { nonEmpty: true, maxLength: 2_000 })
    assertString(scene.locationId, `${path}.locationId`, { nonEmpty: true, maxLength: 160 })
    if (!locationIds.has(scene.locationId)) fail('DANGLING_LOCATION', `${path} references unknown location`)
    assertStringArray(scene.characterIds, `${path}.characterIds`, STORY_LIMITS.maxCharacters)
    scene.characterIds.forEach((id) => {
      if (!characterIds.has(id)) fail('DANGLING_CHARACTER', `${path} references unknown character ${id}`)
    })
    if (!Array.isArray(scene.shots) || !scene.shots.length || scene.shots.length > STORY_LIMITS.maxShotsPerScene) {
      fail('SHOT_LIMIT', `${path}.shots must contain 1-${STORY_LIMITS.maxShotsPerScene} items`)
    }
    scene.shots.forEach((shot, shotIndex) => {
      if (shot.ordinal !== shotIndex + 1) fail('INVALID_ORDINAL', `${path}.shots[${shotIndex}].ordinal must match its position`)
      assertShot(shot, `${path}.shots[${shotIndex}]`, {
        characterIds,
        frameStrategy: project.settings.frameStrategy,
      })
      if (shotIds.has(shot.id)) fail('DUPLICATE_ID', `Duplicate shot id: ${shot.id}`)
      shotIds.add(shot.id)
      totalShots += 1
      totalDurationSeconds += shot.durationSeconds
    })
    if (sceneIds.has(scene.id)) fail('DUPLICATE_ID', `Duplicate scene id: ${scene.id}`)
    sceneIds.add(scene.id)
  })
  if (totalShots > STORY_LIMITS.maxShots) fail('SHOT_LIMIT', `project exceeds ${STORY_LIMITS.maxShots} shots`)
  if (totalDurationSeconds > STORY_LIMITS.maxTotalDurationSeconds) {
    fail('DURATION_LIMIT', `project exceeds ${STORY_LIMITS.maxTotalDurationSeconds} seconds`)
  }
  return project
}

function normalizeCompileInput(input) {
  const allowed = new Set([
    'projectId', 'title', 'kind', 'text', 'aspectRatio', 'frameStrategy', 'defaultShotSeconds',
    'seed', 'now',
  ])
  assertExactKeys(input, allowed, 'compileInput')
  if (!SOURCE_KINDS.has(input.kind)) fail('INVALID_SOURCE_KIND', 'compileInput.kind is unsupported')
  const text = normalizeStoryText(input.text)
  if (input.title !== undefined) {
    assertString(input.title, 'compileInput.title', {
      nonEmpty: true,
      maxLength: STORY_LIMITS.maxTitleCharacters,
    })
  }
  const title = input.title === undefined ? deriveTitle(text) : compact(input.title, STORY_LIMITS.maxTitleCharacters)
  assertString(title, 'compileInput.title', { nonEmpty: true, maxLength: STORY_LIMITS.maxTitleCharacters })
  const aspectRatio = input.aspectRatio ?? '16:9'
  if (!ASPECT_RATIOS.has(aspectRatio)) fail('INVALID_ASPECT_RATIO', 'compileInput.aspectRatio is unsupported')
  const frameStrategy = input.frameStrategy ?? 'start-end'
  if (!FRAME_STRATEGIES.has(frameStrategy)) fail('INVALID_FRAME_STRATEGY', 'compileInput.frameStrategy is unsupported')
  const defaultShotSeconds = input.defaultShotSeconds ?? 5
  assertInteger(defaultShotSeconds, 'compileInput.defaultShotSeconds', 2, 15)
  const seed = input.seed ?? stableSeed(0, text)
  assertInteger(seed, 'compileInput.seed', 0, 2_147_483_646)
  const now = input.now ?? Date.now()
  assertInteger(now, 'compileInput.now', 0)
  const projectId = input.projectId ?? stableId('story', title, text)
  assertString(projectId, 'compileInput.projectId', { nonEmpty: true, maxLength: 160 })
  return { projectId, title, kind: input.kind, text, aspectRatio, frameStrategy, defaultShotSeconds, seed, now }
}

export function compileStoryProject(input) {
  const normalized = normalizeCompileInput(input)
  const sceneBlocks = splitSceneBlocks(normalized.text, normalized.kind)
  if (!sceneBlocks.length || sceneBlocks.length > STORY_LIMITS.maxScenes) {
    fail('SCENE_LIMIT', `source produces more than ${STORY_LIMITS.maxScenes} scenes`)
  }

  const characterNames = extractCharacterNames(sceneBlocks)
  const characters = characterNames.map(createCharacter)
  const characterIdByName = new Map(characters.map((character) => [identityKey(character.name), character.id]))
  const locationNames = []
  const locationIdentities = new Set()
  for (const block of sceneBlocks) {
    const name = compact(stripScenePrefix(block.heading), 120) || '未命名场景'
    const identity = identityKey(name)
    if (!locationIdentities.has(identity)) {
      locationNames.push(name)
      locationIdentities.add(identity)
    }
  }
  if (locationNames.length > STORY_LIMITS.maxLocations) fail('LOCATION_LIMIT', 'source produces too many locations')
  const locations = locationNames.map(createLocation)
  const locationIdByName = new Map(locations.map((location) => [identityKey(location.name), location.id]))

  let totalShots = 0
  const scenes = sceneBlocks.map((block, sceneIndex) => {
    const heading = compact(block.heading, 240) || `场景 ${sceneIndex + 1}`
    const locationName = compact(stripScenePrefix(heading), 120) || '未命名场景'
    const sceneId = stableId('scene', normalized.projectId, sceneIndex + 1, heading)
    const rawShots = splitShotBlocks(block.body || heading)
    if (!rawShots.length || rawShots.length > STORY_LIMITS.maxShotsPerScene) {
      fail('SHOT_LIMIT', `scene ${sceneIndex + 1} produces more than ${STORY_LIMITS.maxShotsPerScene} shots`)
    }
    totalShots += rawShots.length
    if (totalShots > STORY_LIMITS.maxShots) fail('SHOT_LIMIT', `source produces more than ${STORY_LIMITS.maxShots} shots`)

    const shots = rawShots.map((rawShot, shotIndex) => {
      const action = compact(rawShot.body || rawShot.title || heading, 4_000)
      const dialogue = parseDialogue(rawShot.body || '')
      if (dialogue.length > STORY_LIMITS.maxDialogueLinesPerShot) {
        fail('DIALOGUE_LIMIT', `shot ${sceneIndex + 1}.${shotIndex + 1} has too many dialogue lines`)
      }
      const characterIds = [...new Set(dialogue
        .map(({ speaker }) => characterIdByName.get(identityKey(speaker)))
        .filter(Boolean))]
      return {
        id: stableId('shot', normalized.projectId, sceneIndex + 1, shotIndex + 1, action),
        ordinal: shotIndex + 1,
        title: compact(rawShot.title || action, 80) || `镜头 ${shotIndex + 1}`,
        action,
        dialogue,
        characterIds,
        durationSeconds: inferDuration(rawShot.body || rawShot.title, normalized.defaultShotSeconds),
        camera: inferCamera(`${rawShot.title}\n${rawShot.body}`),
        continuityNotes: '保持角色身份、服装、空间关系、光线方向与前一镜头一致。',
        frameRoles: normalized.frameStrategy === 'start-end' ? ['start', 'end'] : ['key'],
      }
    })
    const sceneCharacterIds = [...new Set(shots.flatMap(({ characterIds }) => characterIds))]
    return {
      id: sceneId,
      ordinal: sceneIndex + 1,
      heading,
      summary: compact(block.body || heading, 240),
      locationId: locationIdByName.get(identityKey(locationName)),
      characterIds: sceneCharacterIds,
      shots,
    }
  })

  const project = {
    schemaVersion: STORY_PROJECT_SCHEMA_VERSION,
    id: normalized.projectId,
    title: normalized.title,
    revision: 0,
    createdAt: normalized.now,
    updatedAt: normalized.now,
    source: {
      kind: normalized.kind,
      text: normalized.text,
      language: detectLanguage(normalized.text),
    },
    settings: {
      aspectRatio: normalized.aspectRatio,
      frameStrategy: normalized.frameStrategy,
      defaultShotSeconds: normalized.defaultShotSeconds,
      seed: normalized.seed,
    },
    characters,
    locations,
    scenes,
  }
  return assertStoryProject(project)
}

export function migrateStoryProject(input, options = {}) {
  if (!isRecord(input)) fail('INVALID_PROJECT', 'Stored story project must be an object')
  if (input.schemaVersion === STORY_PROJECT_SCHEMA_VERSION) {
    return assertStoryProject(clone(input))
  }
  assertExactKeys(input, LEGACY_PROJECT_KEYS, 'legacyProject')
  if (input.schemaVersion !== undefined && input.schemaVersion !== 0) {
    fail('UNSUPPORTED_PROJECT_VERSION', `Unsupported story project schema: ${input.schemaVersion}`)
  }
  assertString(input.sourceText, 'legacyProject.sourceText', {
    nonEmpty: true,
    maxLength: STORY_LIMITS.maxSourceCharacters,
  })
  const now = options.now ?? input.updatedAt ?? input.createdAt ?? Date.now()
  const migrated = compileStoryProject({
    projectId: input.id,
    title: input.title,
    kind: input.sourceKind ?? 'script',
    text: input.sourceText,
    aspectRatio: input.aspectRatio,
    frameStrategy: input.frameStrategy,
    defaultShotSeconds: input.defaultShotSeconds,
    seed: input.seed,
    now: input.createdAt ?? now,
  })
  migrated.updatedAt = now
  return assertStoryProject(migrated)
}

export function parseStoryProjectCandidate(candidate) {
  let value = candidate
  if (typeof candidate === 'string') {
    if (candidate.length > 1_000_000) fail('CANDIDATE_TOO_LARGE', 'LLM candidate exceeds 1 MB')
    try {
      value = JSON.parse(candidate)
    } catch (error) {
      fail('INVALID_JSON', 'LLM candidate is not valid JSON', { message: String(error?.message ?? error) })
    }
  }
  return assertStoryProject(clone(value))
}

function taskInputs({ project, prompt, characterIds = [], locationId = null, sceneId = null, shotId = null, frameRole = null, durationSeconds = null, taskId }) {
  return {
    aspectRatio: project.settings.aspectRatio,
    prompt,
    negativePrompt: 'watermark, subtitles, duplicate subject, identity drift, malformed anatomy, abrupt style change',
    characterIds,
    locationId,
    sceneId,
    shotId,
    frameRole,
    durationSeconds,
    seed: stableSeed(project.settings.seed, taskId),
  }
}

function createTask({ project, stage, kind, subjectKey, prompt, dependsOn = [], inputs, outputRole, logicalAssetKey, mimeType }) {
  const id = stableId('task', project.id, project.revision, kind, subjectKey)
  return {
    id,
    stage,
    kind,
    workflowId: TASK_WORKFLOW_BY_KIND[kind],
    status: dependsOn.length ? 'blocked' : 'ready',
    dependsOn: [...dependsOn],
    inputs: taskInputs({ project, prompt, taskId: id, ...inputs }),
    outputs: [{ role: outputRole, logicalAssetKey, mimeType }],
  }
}

export function createGenerationPlan(project, options = {}) {
  assertStoryProject(project)
  assertExactKeys(options, new Set(['now']), 'planOptions')
  const now = options.now ?? project.updatedAt
  assertInteger(now, 'planOptions.now', 0)
  const tasks = []
  const characterTaskIds = new Map()
  const locationTaskIds = new Map()

  for (const character of project.characters) {
    const task = createTask({
      project,
      stage: 'references',
      kind: 'character-reference',
      subjectKey: character.id,
      prompt: `${character.visualPrompt}. ${character.description}`,
      inputs: { characterIds: [character.id] },
      outputRole: 'character-reference',
      logicalAssetKey: `character/${character.id}/reference`,
      mimeType: 'image/png',
    })
    characterTaskIds.set(character.id, task.id)
    tasks.push(task)
  }

  for (const location of project.locations) {
    const task = createTask({
      project,
      stage: 'references',
      kind: 'location-reference',
      subjectKey: location.id,
      prompt: `${location.visualPrompt}. ${location.description}`,
      inputs: { locationId: location.id },
      outputRole: 'location-reference',
      logicalAssetKey: `location/${location.id}/reference`,
      mimeType: 'image/png',
    })
    locationTaskIds.set(location.id, task.id)
    tasks.push(task)
  }

  for (const scene of project.scenes) {
    for (const shot of scene.shots) {
      const referenceDependencies = [
        locationTaskIds.get(scene.locationId),
        ...shot.characterIds.map((id) => characterTaskIds.get(id)),
      ].filter(Boolean)
      const frameTaskIds = []
      for (const frameRole of shot.frameRoles) {
        const task = createTask({
          project,
          stage: 'frames',
          kind: 'shot-frame',
          subjectKey: `${shot.id}:${frameRole}`,
          prompt: `${scene.heading}. ${shot.action} ${shot.continuityNotes}`,
          dependsOn: referenceDependencies,
          inputs: {
            characterIds: shot.characterIds,
            locationId: scene.locationId,
            sceneId: scene.id,
            shotId: shot.id,
            frameRole,
          },
          outputRole: `${frameRole}-frame`,
          logicalAssetKey: `shot/${shot.id}/frame/${frameRole}`,
          mimeType: 'image/png',
        })
        frameTaskIds.push(task.id)
        tasks.push(task)
      }

      tasks.push(createTask({
        project,
        stage: 'videos',
        kind: 'shot-video',
        subjectKey: shot.id,
        prompt: `${scene.heading}. ${shot.action} Camera: ${shot.camera.framing}, ${shot.camera.movement}. ${shot.continuityNotes}`,
        dependsOn: frameTaskIds,
        inputs: {
          characterIds: shot.characterIds,
          locationId: scene.locationId,
          sceneId: scene.id,
          shotId: shot.id,
          durationSeconds: shot.durationSeconds,
        },
        outputRole: 'shot-video',
        logicalAssetKey: `shot/${shot.id}/video`,
        mimeType: 'video/mp4',
      }))
    }
  }

  if (tasks.length > STORY_LIMITS.maxTasks) fail('TASK_LIMIT', `plan exceeds ${STORY_LIMITS.maxTasks} tasks`)
  const plan = {
    schemaVersion: GENERATION_PLAN_SCHEMA_VERSION,
    id: stableId('plan', project.id, project.revision, project.settings.frameStrategy),
    projectId: project.id,
    projectRevision: project.revision,
    createdAt: now,
    stages: [
      { id: 'references', label: '角色与场景基准', order: 1 },
      { id: 'frames', label: '首尾帧 / 关键帧', order: 2 },
      { id: 'videos', label: '受控视频生成', order: 3 },
    ],
    tasks,
  }
  return assertGenerationPlan(plan, project)
}

function assertTaskInputs(inputs, path, projectContext) {
  assertExactKeys(inputs, TASK_INPUT_KEYS, path)
  if (!ASPECT_RATIOS.has(inputs.aspectRatio)) fail('INVALID_ASPECT_RATIO', `${path}.aspectRatio is unsupported`)
  assertString(inputs.prompt, `${path}.prompt`, { nonEmpty: true, maxLength: 8_000 })
  assertString(inputs.negativePrompt, `${path}.negativePrompt`, { maxLength: 4_000 })
  assertStringArray(inputs.characterIds, `${path}.characterIds`, STORY_LIMITS.maxCharacters)
  assertNullableString(inputs.locationId, `${path}.locationId`)
  assertNullableString(inputs.sceneId, `${path}.sceneId`)
  assertNullableString(inputs.shotId, `${path}.shotId`)
  if (inputs.frameRole !== null && !FRAME_ROLES.has(inputs.frameRole)) {
    fail('INVALID_FRAME_ROLE', `${path}.frameRole is unsupported`)
  }
  if (inputs.durationSeconds !== null) assertInteger(inputs.durationSeconds, `${path}.durationSeconds`, 2, 15)
  assertInteger(inputs.seed, `${path}.seed`, 0, 2_147_483_646)
  if (projectContext) {
    inputs.characterIds.forEach((id) => {
      if (!projectContext.characterIds.has(id)) fail('DANGLING_CHARACTER', `${path} references unknown character ${id}`)
    })
    if (inputs.locationId && !projectContext.locationIds.has(inputs.locationId)) fail('DANGLING_LOCATION', `${path} references unknown location`)
    if (inputs.sceneId && !projectContext.sceneIds.has(inputs.sceneId)) fail('DANGLING_SCENE', `${path} references unknown scene`)
    if (inputs.shotId && !projectContext.shotIds.has(inputs.shotId)) fail('DANGLING_SHOT', `${path} references unknown shot`)
  }
}

export function assertGenerationPlan(plan, project = undefined) {
  assertExactKeys(plan, PLAN_KEYS, 'plan')
  if (plan.schemaVersion !== GENERATION_PLAN_SCHEMA_VERSION) {
    fail('UNSUPPORTED_PLAN_VERSION', `Unsupported generation plan schema: ${plan.schemaVersion}`)
  }
  assertString(plan.id, 'plan.id', { nonEmpty: true, maxLength: 160 })
  assertString(plan.projectId, 'plan.projectId', { nonEmpty: true, maxLength: 160 })
  assertInteger(plan.projectRevision, 'plan.projectRevision', 0)
  assertInteger(plan.createdAt, 'plan.createdAt', 0)
  if (!Array.isArray(plan.stages) || plan.stages.length !== 3) fail('INVALID_STAGES', 'plan.stages must contain three stages')
  plan.stages.forEach((stage, index) => {
    const path = `plan.stages[${index}]`
    assertExactKeys(stage, STAGE_KEYS, path)
    if (!TASK_STAGES.has(stage.id)) fail('INVALID_STAGE', `${path}.id is unsupported`)
    assertString(stage.label, `${path}.label`, { nonEmpty: true, maxLength: 120 })
    assertInteger(stage.order, `${path}.order`, 1, 3)
    if (stage.order !== index + 1) fail('INVALID_ORDINAL', `${path}.order must match its position`)
  })
  if (!Array.isArray(plan.tasks) || plan.tasks.length > STORY_LIMITS.maxTasks) {
    fail('TASK_LIMIT', `plan.tasks must contain at most ${STORY_LIMITS.maxTasks} items`)
  }
  let projectContext
  if (project) {
    assertStoryProject(project)
    if (plan.projectId !== project.id || plan.projectRevision !== project.revision) {
      fail('PROJECT_PLAN_MISMATCH', 'plan does not target the supplied project revision')
    }
    projectContext = {
      characterIds: new Set(project.characters.map(({ id }) => id)),
      locationIds: new Set(project.locations.map(({ id }) => id)),
      sceneIds: new Set(project.scenes.map(({ id }) => id)),
      shotIds: new Set(project.scenes.flatMap(({ shots }) => shots.map(({ id }) => id))),
    }
  }

  const ids = new Set()
  const stageOrder = { references: 1, frames: 2, videos: 3 }
  plan.tasks.forEach((task, index) => {
    const path = `plan.tasks[${index}]`
    assertExactKeys(task, TASK_KEYS, path)
    assertString(task.id, `${path}.id`, { nonEmpty: true, maxLength: 160 })
    if (ids.has(task.id)) fail('DUPLICATE_ID', `Duplicate task id: ${task.id}`)
    ids.add(task.id)
    if (!TASK_STAGES.has(task.stage)) fail('INVALID_STAGE', `${path}.stage is unsupported`)
    if (!TASK_KINDS.has(task.kind)) fail('INVALID_TASK_KIND', `${path}.kind is unsupported`)
    if (task.workflowId !== TASK_WORKFLOW_BY_KIND[task.kind]) {
      fail('UNCONTROLLED_WORKFLOW', `${path}.workflowId is not allowed for ${task.kind}`)
    }
    if (!TASK_STATUSES.has(task.status)) fail('INVALID_TASK_STATUS', `${path}.status is unsupported`)
    assertStringArray(task.dependsOn, `${path}.dependsOn`, STORY_LIMITS.maxTasks)
    assertTaskInputs(task.inputs, `${path}.inputs`, projectContext)
    if (!Array.isArray(task.outputs) || task.outputs.length !== 1) {
      fail('INVALID_OUTPUTS', `${path}.outputs must contain exactly one declared artifact`)
    }
    task.outputs.forEach((output, outputIndex) => {
      const outputPath = `${path}.outputs[${outputIndex}]`
      assertExactKeys(output, TASK_OUTPUT_KEYS, outputPath)
      assertString(output.role, `${outputPath}.role`, { nonEmpty: true, maxLength: 80 })
      assertString(output.logicalAssetKey, `${outputPath}.logicalAssetKey`, { nonEmpty: true, maxLength: 240 })
      assertString(output.mimeType, `${outputPath}.mimeType`, { nonEmpty: true, maxLength: 120 })
    })
    if (task.kind === 'shot-frame' && task.inputs.frameRole === null) fail('MISSING_FRAME_ROLE', `${path} requires frameRole`)
    if (task.kind !== 'shot-frame' && task.inputs.frameRole !== null) fail('UNEXPECTED_FRAME_ROLE', `${path} cannot declare frameRole`)
    if (task.kind === 'shot-video' && task.inputs.durationSeconds === null) fail('MISSING_DURATION', `${path} requires durationSeconds`)
    if (task.kind !== 'shot-video' && task.inputs.durationSeconds !== null) fail('UNEXPECTED_DURATION', `${path} cannot declare durationSeconds`)
  })

  const taskById = new Map(plan.tasks.map((task) => [task.id, task]))
  for (const task of plan.tasks) {
    for (const dependencyId of task.dependsOn) {
      const dependency = taskById.get(dependencyId)
      if (!dependency) fail('DANGLING_DEPENDENCY', `Task ${task.id} depends on unknown task ${dependencyId}`)
      if (dependencyId === task.id) fail('CYCLIC_DEPENDENCY', `Task ${task.id} depends on itself`)
      if (stageOrder[dependency.stage] >= stageOrder[task.stage]) {
        fail('INVALID_DEPENDENCY_ORDER', `Task ${task.id} has a non-prior-stage dependency`)
      }
    }
    const expectedStatus = task.dependsOn.length ? 'blocked' : 'ready'
    if (task.status !== expectedStatus && task.status !== 'planned') {
      fail('INVALID_TASK_STATUS', `Task ${task.id} status does not match its dependencies`)
    }
  }
  return plan
}
