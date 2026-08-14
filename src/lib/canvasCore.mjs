export const CANVAS_DOCUMENT_SCHEMA_VERSION = 1
export const CANVAS_COMMAND_SCHEMA_VERSION = 1
export const CANVAS_DRAFT_SCHEMA_VERSION = 1

const MAX_ELEMENTS = 5_000
const MAX_COMMANDS_PER_TRANSACTION = 1_000
const MAX_TEXT_LENGTH = 200_000
const MAX_MEDIA_REFERENCE_LENGTH = 32 * 1024 * 1024
const MAX_COORDINATE = 10_000_000
const MAX_DIMENSION = 10_000_000
const MAX_PROCESSING_STEPS = 64
const MAX_MASK_STROKES = 512
const MAX_MASK_POINTS = 20_000
const ACTORS = new Set(['user', 'tool', 'agent', 'system'])
const ELEMENT_KINDS = new Set([
  'poster',
  'pixel',
  'note',
  'palette',
  'text',
  'shape',
  'frame',
  'image',
  'video',
  'connector',
])
const ELEMENT_KEYS = new Set([
  'id', 'kind', 'name', 'x', 'y', 'width', 'height', 'rotation', 'opacity', 'radius',
  'fill', 'stroke', 'strokeWidth', 'content', 'src', 'videoSrc', 'posterSrc', 'jobId',
  'jobStatus', 'jobPhase', 'jobProgress', 'jobDetail', 'jobError', 'sourceSrc',
  'naturalWidth', 'naturalHeight', 'assetId', 'assetVersion', 'assetVersionId', 'sourceElementId',
  'adjustments', 'crop', 'processingStack', 'pixels', 'palette', 'pixelWidth', 'pixelHeight',
  'fromId', 'toId', 'locked', 'visible', 'zIndex',
])
const PATCH_KEYS = new Set([...ELEMENT_KEYS].filter((key) => key !== 'id' && key !== 'kind'))
const AGENT_PATCH_KEYS = new Set([
  'name', 'x', 'y', 'width', 'height', 'rotation', 'opacity', 'radius', 'fill', 'stroke',
  'strokeWidth', 'content', 'visible', 'zIndex',
])
const AGENT_CREATABLE_KINDS = new Set(['frame', 'text', 'note', 'shape', 'pixel', 'connector'])
const PROCESSING_STEP_KEYS = new Set([
  'id', 'type', 'label', 'detail', 'enabled', 'createdAt', 'outputSrc', 'maskRecipe',
])
const MASK_RECIPE_KEYS = new Set(['schemaVersion', 'strokes'])
const MASK_STROKE_KEYS = new Set(['id', 'mode', 'size', 'hardness', 'points'])
const MASK_POINT_KEYS = new Set(['x', 'y'])

export class CanvasContractError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'CanvasContractError'
    this.code = code
    this.details = details
  }
}

function fail(code, message, details) {
  throw new CanvasContractError(code, message, details)
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
  if (unknown.length) fail('UNKNOWN_FIELD', `${path} contains unsupported fields`, { path, fields: unknown })
}

function assertString(value, path, options = {}) {
  if (typeof value !== 'string') fail('INVALID_STRING', `${path} must be a string`)
  if (options.nonEmpty && !value.trim()) fail('EMPTY_STRING', `${path} cannot be empty`)
  if (value.length > (options.maxLength ?? MAX_TEXT_LENGTH)) {
    fail('STRING_TOO_LONG', `${path} exceeds the allowed length`)
  }
}

function assertFiniteNumber(value, path, min = -MAX_COORDINATE, max = MAX_COORDINATE) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail('INVALID_NUMBER', `${path} must be a finite number between ${min} and ${max}`)
  }
}

function assertInteger(value, path, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('INVALID_INTEGER', `${path} must be an integer between ${min} and ${max}`)
  }
}

function assertCamera(camera, path = 'document.camera') {
  assertExactKeys(camera, new Set(['x', 'y', 'zoom']), path)
  assertFiniteNumber(camera.x, `${path}.x`)
  assertFiniteNumber(camera.y, `${path}.y`)
  assertFiniteNumber(camera.zoom, `${path}.zoom`, 0.05, 8)
}

function assertMaskRecipe(recipe, path) {
  assertExactKeys(recipe, MASK_RECIPE_KEYS, path)
  if (recipe.schemaVersion !== 1) fail('INVALID_MASK_RECIPE', `${path}.schemaVersion must be 1`)
  if (!Array.isArray(recipe.strokes) || recipe.strokes.length > MAX_MASK_STROKES) {
    fail('INVALID_MASK_RECIPE', `${path}.strokes must contain at most ${MAX_MASK_STROKES} strokes`)
  }
  let pointCount = 0
  recipe.strokes.forEach((stroke, strokeIndex) => {
    const strokePath = `${path}.strokes[${strokeIndex}]`
    assertExactKeys(stroke, MASK_STROKE_KEYS, strokePath)
    assertString(stroke.id, `${strokePath}.id`, { nonEmpty: true, maxLength: 160 })
    if (stroke.mode !== 'remove' && stroke.mode !== 'restore') {
      fail('INVALID_MASK_RECIPE', `${strokePath}.mode must be remove or restore`)
    }
    assertFiniteNumber(stroke.size, `${strokePath}.size`, 0.001, 0.75)
    assertFiniteNumber(stroke.hardness, `${strokePath}.hardness`, 0, 1)
    if (!Array.isArray(stroke.points) || !stroke.points.length) {
      fail('INVALID_MASK_RECIPE', `${strokePath}.points must be a non-empty array`)
    }
    pointCount += stroke.points.length
    if (pointCount > MAX_MASK_POINTS) {
      fail('INVALID_MASK_RECIPE', `${path} exceeds ${MAX_MASK_POINTS} total points`)
    }
    stroke.points.forEach((point, pointIndex) => {
      const pointPath = `${strokePath}.points[${pointIndex}]`
      assertExactKeys(point, MASK_POINT_KEYS, pointPath)
      assertFiniteNumber(point.x, `${pointPath}.x`, 0, 1)
      assertFiniteNumber(point.y, `${pointPath}.y`, 0, 1)
    })
  })
}

function assertProcessingStack(stack, path) {
  if (!Array.isArray(stack) || stack.length > MAX_PROCESSING_STEPS) {
    fail('INVALID_PROCESSING_STACK', `${path} must contain at most ${MAX_PROCESSING_STEPS} steps`)
  }
  stack.forEach((step, stepIndex) => {
    const stepPath = `${path}[${stepIndex}]`
    assertExactKeys(step, PROCESSING_STEP_KEYS, stepPath)
    assertString(step.id, `${stepPath}.id`, { nonEmpty: true, maxLength: 160 })
    assertString(step.type, `${stepPath}.type`, { nonEmpty: true, maxLength: 160 })
    assertString(step.label, `${stepPath}.label`, { nonEmpty: true, maxLength: 1_000 })
    assertString(step.detail, `${stepPath}.detail`, { maxLength: 8_000 })
    if (typeof step.enabled !== 'boolean') fail('INVALID_BOOLEAN', `${stepPath}.enabled must be boolean`)
    assertInteger(step.createdAt, `${stepPath}.createdAt`)
    if (step.outputSrc !== undefined) {
      assertString(step.outputSrc, `${stepPath}.outputSrc`, { maxLength: MAX_MEDIA_REFERENCE_LENGTH })
    }
    if (step.maskRecipe !== undefined) assertMaskRecipe(step.maskRecipe, `${stepPath}.maskRecipe`)
  })
}

function assertElement(element, index) {
  const path = `document.elements[${index}]`
  assertExactKeys(element, ELEMENT_KEYS, path)
  assertString(element.id, `${path}.id`, { nonEmpty: true, maxLength: 160 })
  if (!ELEMENT_KINDS.has(element.kind)) fail('INVALID_ELEMENT_KIND', `${path}.kind is unsupported`)
  assertString(element.name, `${path}.name`, { nonEmpty: true, maxLength: 1_000 })
  assertFiniteNumber(element.x, `${path}.x`)
  assertFiniteNumber(element.y, `${path}.y`)
  assertFiniteNumber(element.width, `${path}.width`, 0, MAX_DIMENSION)
  assertFiniteNumber(element.height, `${path}.height`, 0, MAX_DIMENSION)
  if (element.kind !== 'connector' && (element.width <= 0 || element.height <= 0)) {
    fail('INVALID_DIMENSION', `${path} must have positive width and height`)
  }
  assertFiniteNumber(element.rotation, `${path}.rotation`, -360_000, 360_000)
  assertFiniteNumber(element.opacity, `${path}.opacity`, 0, 1)
  assertFiniteNumber(element.radius, `${path}.radius`, 0, MAX_DIMENSION)
  assertString(element.fill, `${path}.fill`, { maxLength: 2_000 })
  assertString(element.stroke, `${path}.stroke`, { maxLength: 2_000 })
  if (element.strokeWidth !== undefined) assertFiniteNumber(element.strokeWidth, `${path}.strokeWidth`, 0, 100_000)
  if (typeof element.locked !== 'boolean') fail('INVALID_BOOLEAN', `${path}.locked must be boolean`)
  if (typeof element.visible !== 'boolean') fail('INVALID_BOOLEAN', `${path}.visible must be boolean`)
  assertInteger(element.zIndex, `${path}.zIndex`, -1_000_000, 1_000_000_000)

  for (const key of ['content', 'jobDetail']) {
    if (element[key] !== undefined) assertString(element[key], `${path}.${key}`)
  }
  for (const key of ['jobId', 'assetId', 'assetVersionId', 'sourceElementId', 'fromId', 'toId']) {
    if (element[key] !== undefined) assertString(element[key], `${path}.${key}`, { nonEmpty: true, maxLength: 240 })
  }
  for (const key of ['src', 'videoSrc', 'posterSrc', 'sourceSrc']) {
    if (element[key] !== undefined) {
      assertString(element[key], `${path}.${key}`, { maxLength: MAX_MEDIA_REFERENCE_LENGTH })
    }
  }
  for (const key of ['naturalWidth', 'naturalHeight', 'jobProgress']) {
    if (element[key] !== undefined) assertFiniteNumber(element[key], `${path}.${key}`, 0, MAX_DIMENSION)
  }
  if (element.assetVersion !== undefined) assertInteger(element.assetVersion, `${path}.assetVersion`, 1, 1_000_000)
  if (element.pixelWidth !== undefined) assertInteger(element.pixelWidth, `${path}.pixelWidth`, 1, 4_096)
  if (element.pixelHeight !== undefined) assertInteger(element.pixelHeight, `${path}.pixelHeight`, 1, 4_096)
  if (element.pixels !== undefined) {
    if (!Array.isArray(element.pixels) || element.pixels.length > 4_194_304) {
      fail('INVALID_PIXELS', `${path}.pixels must be a bounded array`)
    }
    element.pixels.forEach((pixel, pixelIndex) => assertString(pixel, `${path}.pixels[${pixelIndex}]`, { maxLength: 128 }))
  }
  if (element.palette !== undefined) {
    if (!Array.isArray(element.palette) || element.palette.length > 4_096) {
      fail('INVALID_PALETTE', `${path}.palette must be a bounded array`)
    }
    element.palette.forEach((color, colorIndex) => assertString(color, `${path}.palette[${colorIndex}]`, { maxLength: 128 }))
  }
  if (element.processingStack !== undefined) {
    assertProcessingStack(element.processingStack, `${path}.processingStack`)
  }
}

export function assertCanvasDocument(document) {
  assertExactKeys(
    document,
    new Set(['schemaVersion', 'id', 'title', 'revision', 'createdAt', 'updatedAt', 'elements', 'camera']),
    'document',
  )
  if (document.schemaVersion !== CANVAS_DOCUMENT_SCHEMA_VERSION) {
    fail('UNSUPPORTED_DOCUMENT_VERSION', `Unsupported canvas document schema: ${document.schemaVersion}`)
  }
  assertString(document.id, 'document.id', { nonEmpty: true, maxLength: 160 })
  assertString(document.title, 'document.title', { nonEmpty: true, maxLength: 1_000 })
  assertInteger(document.revision, 'document.revision')
  assertInteger(document.createdAt, 'document.createdAt')
  assertInteger(document.updatedAt, 'document.updatedAt')
  if (document.updatedAt < document.createdAt) fail('INVALID_TIMESTAMP', 'document.updatedAt cannot precede createdAt')
  assertCamera(document.camera)
  if (!Array.isArray(document.elements) || document.elements.length > MAX_ELEMENTS) {
    fail('ELEMENT_LIMIT', `document.elements must contain at most ${MAX_ELEMENTS} elements`)
  }
  document.elements.forEach(assertElement)
  const ids = new Set()
  for (const element of document.elements) {
    if (ids.has(element.id)) fail('DUPLICATE_ELEMENT_ID', `Duplicate element id: ${element.id}`)
    ids.add(element.id)
  }
  for (const element of document.elements) {
    if (element.kind !== 'connector') continue
    if (!element.fromId || !element.toId || !ids.has(element.fromId) || !ids.has(element.toId)) {
      fail('DANGLING_CONNECTOR', `Connector ${element.id} must reference existing elements`)
    }
  }
  return document
}

export function createCanvasDocument({
  id = 'local-project',
  title = '光阴砚画布',
  elements,
  camera,
  now = Date.now(),
}) {
  const document = {
    schemaVersion: CANVAS_DOCUMENT_SCHEMA_VERSION,
    id,
    title,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    elements: clone(elements),
    camera: clone(camera),
  }
  return assertCanvasDocument(document)
}

export function migrateCanvasDocument(input, options = {}) {
  if (!isRecord(input)) fail('INVALID_DOCUMENT', 'Stored project must be an object')
  const now = options.now ?? Date.now()
  if (input.schemaVersion === CANVAS_DOCUMENT_SCHEMA_VERSION) {
    const migrated = clone(input)
    return assertCanvasDocument(migrated)
  }
  if (!Array.isArray(input.elements) || !isRecord(input.camera)) {
    fail('INVALID_LEGACY_DOCUMENT', 'Legacy project must contain elements and camera')
  }
  const createdAt = Number.isSafeInteger(input.createdAt) ? input.createdAt : now
  const migrated = {
    schemaVersion: CANVAS_DOCUMENT_SCHEMA_VERSION,
    id: typeof input.id === 'string' && input.id.trim() ? input.id : (options.id ?? 'local-project'),
    title: typeof input.title === 'string' && input.title.trim() ? input.title : (options.title ?? '光阴砚画布'),
    revision: Number.isSafeInteger(input.revision) && input.revision >= 0 ? input.revision : 0,
    createdAt,
    updatedAt: Number.isSafeInteger(input.updatedAt) && input.updatedAt >= createdAt ? input.updatedAt : createdAt,
    elements: clone(input.elements),
    camera: clone(input.camera),
  }
  return assertCanvasDocument(migrated)
}

function assertPatch(patch, path) {
  if (!isRecord(patch)) fail('INVALID_PATCH', `${path} must be an object`)
  const keys = Object.keys(patch)
  if (!keys.length) fail('EMPTY_PATCH', `${path} cannot be empty`)
  const forbidden = keys.filter((key) => !PATCH_KEYS.has(key))
  if (forbidden.length) fail('UNSAFE_PATCH', `${path} contains unsupported fields`, { fields: forbidden })
}

function validateCommand(command, baseRevision) {
  assertExactKeys(
    command,
    new Set(['schemaVersion', 'id', 'actor', 'type', 'baseRevision', 'payload']),
    'command',
  )
  if (command.schemaVersion !== CANVAS_COMMAND_SCHEMA_VERSION) {
    fail('UNSUPPORTED_COMMAND_VERSION', `Unsupported command schema: ${command.schemaVersion}`)
  }
  assertString(command.id, 'command.id', { nonEmpty: true, maxLength: 200 })
  if (!ACTORS.has(command.actor)) fail('INVALID_ACTOR', `Unsupported command actor: ${command.actor}`)
  assertString(command.type, 'command.type', { nonEmpty: true, maxLength: 100 })
  assertInteger(command.baseRevision, 'command.baseRevision')
  if (command.baseRevision !== baseRevision) {
    fail('REVISION_CONFLICT', `Command expects revision ${command.baseRevision}, current revision is ${baseRevision}`)
  }
  if (!isRecord(command.payload)) fail('INVALID_PAYLOAD', 'command.payload must be an object')

  if (command.type === 'elements.add') {
    assertExactKeys(command.payload, new Set(['elements']), 'command.payload')
    if (!Array.isArray(command.payload.elements) || !command.payload.elements.length) {
      fail('EMPTY_ADD', 'elements.add requires at least one element')
    }
    if (command.actor === 'agent') {
      const forbidden = command.payload.elements.filter((element) => !AGENT_CREATABLE_KINDS.has(element?.kind))
      if (forbidden.length) fail('ACTOR_FORBIDDEN', 'Generic agent tools cannot create media elements')
    }
  } else if (command.type === 'elements.patch') {
    assertExactKeys(command.payload, new Set(['updates']), 'command.payload')
    if (!Array.isArray(command.payload.updates) || !command.payload.updates.length) {
      fail('EMPTY_UPDATE', 'elements.patch requires at least one update')
    }
    for (const [index, update] of command.payload.updates.entries()) {
      assertExactKeys(update, new Set(['id', 'patch']), `command.payload.updates[${index}]`)
      assertString(update.id, `command.payload.updates[${index}].id`, { nonEmpty: true, maxLength: 160 })
      assertPatch(update.patch, `command.payload.updates[${index}].patch`)
      if (command.actor === 'agent') {
        const forbidden = Object.keys(update.patch).filter((key) => !AGENT_PATCH_KEYS.has(key))
        if (forbidden.length) {
          fail('ACTOR_FORBIDDEN', 'Generic agent tools cannot patch privileged element fields', { fields: forbidden })
        }
      }
    }
  } else if (command.type === 'elements.remove') {
    assertExactKeys(command.payload, new Set(['ids']), 'command.payload')
    if (!Array.isArray(command.payload.ids) || !command.payload.ids.length) {
      fail('EMPTY_REMOVE', 'elements.remove requires at least one id')
    }
    command.payload.ids.forEach((id, index) => assertString(id, `command.payload.ids[${index}]`, { nonEmpty: true, maxLength: 160 }))
  } else if (command.type === 'elements.replace') {
    assertExactKeys(command.payload, new Set(['elements']), 'command.payload')
    if (!Array.isArray(command.payload.elements)) fail('INVALID_REPLACEMENT', 'elements.replace requires an array')
    if (command.actor === 'agent') fail('ACTOR_FORBIDDEN', 'Agents cannot replace an entire canvas document')
  } else if (command.type === 'camera.set') {
    assertExactKeys(command.payload, new Set(['camera']), 'command.payload')
    assertCamera(command.payload.camera, 'command.payload.camera')
    if (command.actor === 'agent') fail('ACTOR_FORBIDDEN', 'Agents cannot change the user viewport')
  } else if (command.type === 'document.reset') {
    assertExactKeys(command.payload, new Set(['elements', 'camera']), 'command.payload')
    if (!Array.isArray(command.payload.elements)) fail('INVALID_REPLACEMENT', 'document.reset requires elements')
    assertCamera(command.payload.camera, 'command.payload.camera')
    if (!['user', 'system'].includes(command.actor)) fail('ACTOR_FORBIDDEN', 'Only user or system can reset a document')
  } else {
    fail('UNKNOWN_COMMAND', `Unsupported command type: ${command.type}`)
  }
}

function applyCommandUnchecked(document, command) {
  if (command.type === 'elements.add') {
    return { ...document, elements: [...document.elements, ...clone(command.payload.elements)] }
  }
  if (command.type === 'elements.patch') {
    const updates = new Map(command.payload.updates.map((update) => [update.id, update.patch]))
    for (const id of updates.keys()) {
      const target = document.elements.find((element) => element.id === id)
      if (!target) fail('ELEMENT_NOT_FOUND', `Element not found: ${id}`)
      if (target.locked && command.actor === 'agent') fail('ELEMENT_LOCKED', `Element is locked: ${id}`)
    }
    return {
      ...document,
      elements: document.elements.map((element) => {
        const patch = updates.get(element.id)
        return patch ? { ...element, ...clone(patch) } : element
      }),
    }
  }
  if (command.type === 'elements.remove') {
    const ids = new Set(command.payload.ids)
    for (const id of ids) {
      const element = document.elements.find((candidate) => candidate.id === id)
      if (!element) fail('ELEMENT_NOT_FOUND', `Element not found: ${id}`)
      if (element.locked) fail('ELEMENT_LOCKED', `Element is locked: ${id}`)
    }
    return {
      ...document,
      elements: document.elements.filter((element) =>
        !ids.has(element.id) &&
        !(element.kind === 'connector' && (ids.has(element.fromId) || ids.has(element.toId))),
      ),
    }
  }
  if (command.type === 'elements.replace') {
    return { ...document, elements: clone(command.payload.elements) }
  }
  if (command.type === 'camera.set') {
    return { ...document, camera: clone(command.payload.camera) }
  }
  if (command.type === 'document.reset') {
    return { ...document, elements: clone(command.payload.elements), camera: clone(command.payload.camera) }
  }
  return document
}

export function applyCanvasTransaction(document, commands, options = {}) {
  assertCanvasDocument(document)
  if (!Array.isArray(commands) || !commands.length || commands.length > MAX_COMMANDS_PER_TRANSACTION) {
    fail('INVALID_TRANSACTION', `A transaction requires 1-${MAX_COMMANDS_PER_TRANSACTION} commands`)
  }
  const ids = new Set()
  let next = clone(document)
  for (const command of commands) {
    validateCommand(command, document.revision)
    if (ids.has(command.id)) fail('DUPLICATE_COMMAND_ID', `Duplicate command id: ${command.id}`)
    ids.add(command.id)
    next = applyCommandUnchecked(next, command)
  }
  const timestamp = options.now ?? Date.now()
  assertInteger(timestamp, 'transaction.now')
  next = {
    ...next,
    revision: document.revision + 1,
    updatedAt: Math.max(document.createdAt, timestamp),
  }
  return assertCanvasDocument(next)
}

export function applyCanvasCommand(document, command, options = {}) {
  return applyCanvasTransaction(document, [command], options)
}

export function createCanvasCommand(document, type, payload, options = {}) {
  return {
    schemaVersion: CANVAS_COMMAND_SCHEMA_VERSION,
    id: options.id ?? `command-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`,
    actor: options.actor ?? 'user',
    type,
    baseRevision: document.revision,
    payload: clone(payload),
  }
}

export function commitCanvasPreview(baseDocument, previewDocument, options = {}) {
  assertCanvasDocument(baseDocument)
  if (!isRecord(previewDocument) || previewDocument.revision !== baseDocument.revision) {
    fail('REVISION_CONFLICT', 'Preview no longer matches the committed document revision')
  }
  const command = createCanvasCommand(
    baseDocument,
    'elements.replace',
    { elements: previewDocument.elements },
    { id: options.id, actor: options.actor ?? 'user' },
  )
  return applyCanvasCommand(baseDocument, command, { now: options.now })
}

export function createCanvasDraft(document, commands, options = {}) {
  const preview = applyCanvasTransaction(document, commands, { now: options.now })
  return {
    schemaVersion: CANVAS_DRAFT_SCHEMA_VERSION,
    id: options.id ?? `draft-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`,
    baseRevision: document.revision,
    commands: clone(commands),
    preview,
  }
}

export function commitCanvasDraft(document, draft, options = {}) {
  assertExactKeys(draft, new Set(['schemaVersion', 'id', 'baseRevision', 'commands', 'preview']), 'draft')
  if (draft.schemaVersion !== CANVAS_DRAFT_SCHEMA_VERSION) fail('UNSUPPORTED_DRAFT_VERSION', 'Unsupported draft schema')
  if (draft.baseRevision !== document.revision) {
    fail('REVISION_CONFLICT', `Draft expects revision ${draft.baseRevision}, current revision is ${document.revision}`)
  }
  return applyCanvasTransaction(document, draft.commands, { now: options.now })
}

export function defineCanvasTool(definition) {
  assertExactKeys(definition, new Set(['id', 'title', 'allowedActors', 'validateInput', 'createPayload']), 'tool')
  assertString(definition.id, 'tool.id', { nonEmpty: true, maxLength: 160 })
  assertString(definition.title, 'tool.title', { nonEmpty: true, maxLength: 1_000 })
  if (!Array.isArray(definition.allowedActors) || !definition.allowedActors.length) fail('INVALID_TOOL', 'tool.allowedActors is required')
  definition.allowedActors.forEach((actor) => {
    if (!ACTORS.has(actor)) fail('INVALID_ACTOR', `Unsupported tool actor: ${actor}`)
  })
  if (typeof definition.validateInput !== 'function' || typeof definition.createPayload !== 'function') {
    fail('INVALID_TOOL', 'Tool definitions require validateInput and createPayload functions')
  }
  return Object.freeze({ ...definition, allowedActors: Object.freeze([...definition.allowedActors]) })
}

export function createCanvasToolRegistry(definitions) {
  const registry = new Map()
  for (const definition of definitions) {
    const tool = defineCanvasTool(definition)
    if (registry.has(tool.id)) fail('DUPLICATE_TOOL', `Duplicate canvas tool: ${tool.id}`)
    registry.set(tool.id, tool)
  }
  return Object.freeze({
    get(id) { return registry.get(id) },
    list() { return [...registry.values()] },
  })
}

function assertToolInputRecord(input) {
  if (!isRecord(input)) fail('INVALID_TOOL_INPUT', 'Tool input must be an object')
}

export const canvasToolRegistry = createCanvasToolRegistry([
  {
    id: 'canvas.elements.add',
    title: 'Add canvas elements',
    allowedActors: ['user', 'tool', 'agent', 'system'],
    validateInput(input) {
      assertToolInputRecord(input)
      assertExactKeys(input, new Set(['elements']), 'tool.input')
      if (!Array.isArray(input.elements) || !input.elements.length) fail('INVALID_TOOL_INPUT', 'elements are required')
    },
    createPayload(input) { return { type: 'elements.add', payload: { elements: input.elements } } },
  },
  {
    id: 'canvas.elements.patch',
    title: 'Patch canvas elements',
    allowedActors: ['user', 'tool', 'agent', 'system'],
    validateInput(input) {
      assertToolInputRecord(input)
      assertExactKeys(input, new Set(['updates']), 'tool.input')
      if (!Array.isArray(input.updates) || !input.updates.length) fail('INVALID_TOOL_INPUT', 'updates are required')
    },
    createPayload(input) { return { type: 'elements.patch', payload: { updates: input.updates } } },
  },
  {
    id: 'canvas.elements.remove',
    title: 'Remove canvas elements',
    allowedActors: ['user', 'tool', 'agent', 'system'],
    validateInput(input) {
      assertToolInputRecord(input)
      assertExactKeys(input, new Set(['ids']), 'tool.input')
      if (!Array.isArray(input.ids) || !input.ids.length) fail('INVALID_TOOL_INPUT', 'ids are required')
    },
    createPayload(input) { return { type: 'elements.remove', payload: { ids: input.ids } } },
  },
  {
    id: 'canvas.elements.replace',
    title: 'Replace canvas element snapshot',
    allowedActors: ['user', 'tool', 'system'],
    validateInput(input) {
      assertToolInputRecord(input)
      assertExactKeys(input, new Set(['elements']), 'tool.input')
      if (!Array.isArray(input.elements)) fail('INVALID_TOOL_INPUT', 'elements must be an array')
    },
    createPayload(input) { return { type: 'elements.replace', payload: { elements: input.elements } } },
  },
  {
    id: 'canvas.camera.set',
    title: 'Set canvas camera',
    allowedActors: ['user', 'tool', 'system'],
    validateInput(input) {
      assertToolInputRecord(input)
      assertExactKeys(input, new Set(['camera']), 'tool.input')
      assertCamera(input.camera, 'tool.input.camera')
    },
    createPayload(input) { return { type: 'camera.set', payload: { camera: input.camera } } },
  },
  {
    id: 'canvas.document.reset',
    title: 'Reset canvas document',
    allowedActors: ['user', 'system'],
    validateInput(input) {
      assertToolInputRecord(input)
      assertExactKeys(input, new Set(['elements', 'camera']), 'tool.input')
      if (!Array.isArray(input.elements)) fail('INVALID_TOOL_INPUT', 'elements must be an array')
      assertCamera(input.camera, 'tool.input.camera')
    },
    createPayload(input) { return { type: 'document.reset', payload: { elements: input.elements, camera: input.camera } } },
  },
])

export function compileCanvasToolInvocation(document, invocation, registry = canvasToolRegistry) {
  assertExactKeys(invocation, new Set(['toolId', 'callId', 'actor', 'input']), 'invocation')
  assertString(invocation.toolId, 'invocation.toolId', { nonEmpty: true, maxLength: 160 })
  assertString(invocation.callId, 'invocation.callId', { nonEmpty: true, maxLength: 200 })
  if (!ACTORS.has(invocation.actor)) fail('INVALID_ACTOR', `Unsupported invocation actor: ${invocation.actor}`)
  const tool = registry.get(invocation.toolId)
  if (!tool) fail('TOOL_NOT_FOUND', `Unknown canvas tool: ${invocation.toolId}`)
  if (!tool.allowedActors.includes(invocation.actor)) {
    fail('ACTOR_FORBIDDEN', `${invocation.actor} cannot invoke ${invocation.toolId}`)
  }
  tool.validateInput(invocation.input)
  const compiled = tool.createPayload(clone(invocation.input))
  return createCanvasCommand(document, compiled.type, compiled.payload, {
    id: invocation.callId,
    actor: invocation.actor,
  })
}

export function executeCanvasTool(document, invocation, options = {}) {
  const command = compileCanvasToolInvocation(document, invocation, options.registry ?? canvasToolRegistry)
  return applyCanvasCommand(document, command, { now: options.now })
}

export function cloneCanvasDocument(document) {
  return clone(assertCanvasDocument(document))
}
